import { angDiff, bearing, destination, dist, lerp, Line, type LngLat } from './geo';
import { WalkGraph } from './graph';

export interface Option { edge: number; angle: number; label: string; isAuto: boolean }
export interface Junction { node: number; incoming: number; distance: number; options: Option[] }
export type Mode = 'graph' | 'line' | 'free';

/**
 * Moves the walker through the real path network at the user's speed and makes (or takes from the
 * user) the left/right/straight decision at every real junction.
 *  - graph: on OSM streets/trails, with junction choices (normal mode)
 *  - line:  following the curated route polyline while street data is still loading/unavailable
 *  - free:  free roam, the walker steers by heading
 */
export class Walker {
  mode: Mode;
  pos: LngLat;
  heading = 0; // direction of travel
  autopilot: 'route' | 'explore';
  queued: 'left' | 'right' | null = null;
  picked: { node: number; edge: number } | null = null;
  progress = 0; // meters completed along the suggested route
  onRoute = true;
  offRouteBy = 0;
  completed = false;
  steer = 0; // -1..1 in free roam
  onEvent: (type: 'complete' | 'deadend' | 'turn' | 'offroute' | 'graph', msg: string) => void = () => {};

  private edge = -1; private from = -1; private to = -1; private s = 0;
  private lineS = 0; private lineDir = 1;
  private recent = new Map<number, number>();
  private jCache: { key: string; j: Junction } | null = null;
  private lastGlobal = 0; private lastLoadTry = -1e9;

  constructor(readonly graph: WalkGraph, readonly route: Line | null, start: LngLat, readonly loadRadius: number) {
    this.pos = start;
    this.mode = route ? 'line' : 'free';
    this.autopilot = route ? 'route' : 'explore';
    if (route) this.heading = bearing(route.coords[0], route.pointAt(25));
  }

  // ---------- graph helpers ----------
  private E(id: number) { return this.graph.edges[id]; }
  /** Point `m` meters along `edge` starting at node `n`, continuing through non-junction nodes. */
  private chain(n: number, edge: number, m: number): LngLat {
    const G = this.graph;
    for (let guard = 0; guard < 500; guard++) {
      const e = this.E(edge), o = G.other(e, n);
      if (e.len >= m) return lerp(G.pos(n), G.pos(o), m / e.len);
      m -= e.len;
      const next = G.nodes.get(o)!.edges.filter((x) => x !== edge);
      if (next.length !== 1) return G.pos(o);
      n = o; edge = next[0];
    }
    return G.pos(n);
  }

  attach(p: LngLat, preferBearing: number): boolean {
    const hit = this.graph.nearestEdge(p, 70);
    if (!hit) return false;
    const { e, t } = hit, G = this.graph;
    const fwd = Math.abs(angDiff(preferBearing, bearing(G.pos(e.a), G.pos(e.b)))) <= 90;
    this.edge = e.id; this.from = fwd ? e.a : e.b; this.to = fwd ? e.b : e.a; this.s = (fwd ? t : 1 - t) * e.len;
    this.mode = 'graph';
    this.jCache = null;
    return true;
  }

  private options(node: number, incoming: number): Option[] {
    const G = this.graph, np = G.pos(node);
    const inB = bearing(this.chain(node, incoming, 15), np);
    const auto = this.autoChoice(node, incoming);
    return G.nodes.get(node)!.edges.filter((x) => x !== incoming).map((x) => ({
      edge: x,
      angle: angDiff(inB, bearing(np, this.chain(node, x, 20))),
      label: this.E(x).name,
      isAuto: x === auto,
    })).sort((a, b) => a.angle - b.angle);
  }

  private routeGoal(): LngLat | null {
    if (!this.route || this.completed || this.autopilot !== 'route') return null;
    return this.route.pointAt(this.progress + 120);
  }

  private autoChoice(node: number, incoming: number): number {
    const G = this.graph, np = G.pos(node), now = performance.now();
    const outs = G.nodes.get(node)!.edges.filter((x) => x !== incoming);
    if (outs.length === 1) return outs[0];
    const penalty = (x: number) => (now - (this.recent.get(x) ?? -1e9) < 120000 ? 400 : 0);
    const goal = this.routeGoal();
    if (goal) {
      const gn = G.nearestNode(goal);
      const step = gn != null ? G.firstStepTo(node, gn, incoming) : null;
      if (step != null && outs.includes(step)) return step;
      return outs.reduce((b, x) => (dist(this.chain(node, x, 25), goal) + penalty(x) < dist(this.chain(node, b, 25), goal) + penalty(b) ? x : b));
    }
    const inB = bearing(this.chain(node, incoming, 15), np);
    const score = (x: number) => Math.abs(angDiff(inB, bearing(np, this.chain(node, x, 20)))) + penalty(x) / 4;
    return outs.reduce((b, x) => (score(x) < score(b) ? x : b));
  }

  /** The next real junction ahead (for the UI), within `maxDist` meters. */
  upcoming(maxDist = 70): Junction | null {
    if (this.mode !== 'graph') return null;
    const G = this.graph;
    let n = this.to, e = this.edge, d = this.E(e).len - this.s;
    for (let guard = 0; guard < 200 && d <= maxDist; guard++) {
      const deg = G.degree(n);
      if (deg >= 3) {
        const key = `${n}:${e}:${this.autopilot}:${Math.round(this.progress / 40)}`;
        if (this.jCache?.key !== key) this.jCache = { key, j: { node: n, incoming: e, distance: d, options: this.options(n, e) } };
        this.jCache.j.distance = d;
        return this.jCache.j;
      }
      if (deg < 2) return null;
      e = G.nodes.get(n)!.edges.find((x) => x !== e)!;
      n = G.other(this.E(e), n);
      d += this.E(e).len;
    }
    return null;
  }

  pick(node: number, edge: number) { this.picked = { node, edge }; }

  uTurn() {
    if (this.mode === 'graph') { [this.from, this.to] = [this.to, this.from]; this.s = this.E(this.edge).len - this.s; }
    else if (this.mode === 'line') this.lineDir *= -1;
    else this.heading = (this.heading + 180) % 360;
    if (this.autopilot === 'route' && this.mode !== 'line') this.autopilot = 'explore';
    this.queued = null; this.picked = null; this.jCache = null;
    this.onEvent('turn', 'Turned around');
  }

  guideBack() { if (this.route && !this.completed) { this.autopilot = 'route'; this.jCache = null; } }

  setFree(on: boolean) {
    if (on) { this.mode = 'free'; this.autopilot = 'explore'; return true; }
    return this.attach(this.pos, this.heading);
  }

  private arrive() {
    const G = this.graph, node = this.to, incoming = this.edge;
    const outs = G.nodes.get(node)!.edges.filter((x) => x !== incoming);
    let next: number;
    if (!outs.length) {
      next = incoming;
      this.onEvent('deadend', G.covers(G.pos(node), 40) ? 'Dead end, turning around' : 'Edge of loaded map, turning around');
      if (this.autopilot === 'route') this.recent.set(incoming, performance.now());
    } else if (outs.length === 1) next = outs[0];
    else {
      const auto = this.autoChoice(node, incoming);
      next = auto;
      let manual: number | null = null;
      if (this.picked?.node === node && outs.includes(this.picked.edge)) manual = this.picked.edge;
      else if (this.queued) {
        const opts = this.options(node, incoming).filter((o) => (this.queued === 'left' ? o.angle < -30 : o.angle > 30));
        const want = this.queued === 'left' ? -90 : 90;
        if (opts.length) manual = opts.reduce((b, o) => (Math.abs(o.angle - want) < Math.abs(b.angle - want) ? o : b)).edge;
      }
      if (manual != null) {
        next = manual;
        this.queued = null;
        if (manual !== auto && this.autopilot === 'route') { this.autopilot = 'explore'; this.onEvent('offroute', 'Exploring your own way'); }
        this.onEvent('turn', 'Onto ' + this.E(manual).name);
      }
      this.picked = null;
    }
    this.recent.set(incoming, performance.now());
    this.edge = next; this.from = node; this.to = G.other(this.E(next), node); this.s = 0;
    this.jCache = null;
  }

  update(dt: number, speed: number) {
    let dm = speed * dt;
    if (this.mode === 'graph') {
      for (let guard = 0; dm > 0 && guard < 100; guard++) {
        const rem = this.E(this.edge).len - this.s;
        if (dm < rem) { this.s += dm; dm = 0; } else { dm -= rem; this.arrive(); }
      }
      const G = this.graph, a = G.pos(this.from), b = G.pos(this.to), L = this.E(this.edge).len;
      this.pos = lerp(a, b, this.s / L);
      this.heading = bearing(this.pos, this.ahead(12));
    } else if (this.mode === 'line' && this.route) {
      this.lineS = Math.max(0, Math.min(this.route.length, this.lineS + dm * this.lineDir));
      this.pos = this.route.pointAt(this.lineS);
      this.heading = bearing(this.pos, this.route.pointAt(this.lineS + 12 * this.lineDir));
      if (this.lineS >= this.route.length && this.lineDir > 0) this.lineDir = -1;
    } else {
      this.heading = (this.heading + this.steer * 50 * dt + 360) % 360;
      this.pos = destination(this.pos, this.heading, dm);
    }
    this.trackRoute();
    this.maybeLoad();
  }

  /** Point `m` meters ahead along the path the walker will take. */
  private ahead(m: number): LngLat {
    const G = this.graph, e = this.E(this.edge), rem = e.len - this.s;
    if (rem >= m) return lerp(G.pos(this.from), G.pos(this.to), (this.s + m) / e.len);
    if (rem < 3) return destination(this.pos, bearing(G.pos(this.from), G.pos(this.to)), m);
    return G.pos(this.to);
  }

  private trackRoute() {
    const r = this.route;
    if (!r) return;
    const near = r.project(this.pos, this.progress - 30, this.progress + 250);
    this.offRouteBy = near.d;
    if (near.d < 35) this.progress = Math.max(this.progress, near.s);
    else if (performance.now() - this.lastGlobal > 2000) {
      this.lastGlobal = performance.now();
      const g = r.project(this.pos, this.progress, Infinity);
      if (g.d < 35) this.progress = g.s;
    }
    const was = this.onRoute;
    this.onRoute = near.d < 35;
    if (was && !this.onRoute && this.autopilot !== 'route') this.onEvent('offroute', 'Off the suggested route');
    if (!this.completed && this.progress >= r.length - 30) {
      this.completed = true;
      this.autopilot = 'explore';
      this.onEvent('complete', 'Route complete!');
    }
  }

  private maybeLoad() {
    const G = this.graph, now = performance.now();
    if (G.loading || now - this.lastLoadTry < 15000) return;
    const want = this.mode === 'line' && this.route ? this.route.pointAt(this.lineS) : destination(this.pos, this.heading, this.loadRadius * 0.5);
    if (G.chunks.length && G.covers(want, 150) && G.covers(this.pos, 150)) return;
    this.lastLoadTry = now;
    const center = G.chunks.length ? destination(this.pos, this.heading, this.loadRadius * 0.6) : this.pos;
    G.load(center, this.loadRadius).then((ok) => {
      if (!ok) { this.onEvent('graph', 'Street data unavailable, following route'); return; }
      this.jCache = null;
      if (this.mode === 'line') {
        if (this.attach(this.pos, this.heading)) this.onEvent('graph', 'Real streets loaded: choose your way at junctions');
      } else this.onEvent('graph', '');
    });
  }
}
