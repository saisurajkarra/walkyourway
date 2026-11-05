import { dist, projectOnSegment, type LngLat } from './geo';

/** Real walkable network (streets, footpaths, trails) from OpenStreetMap, loaded in chunks as you walk. */
export interface GNode { id: number; p: LngLat; edges: number[] }
export interface GEdge { id: number; a: number; b: number; len: number; name: string }

const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
// Streets + paths you can walk. Separately-mapped sidewalks/crossings are skipped so a city street is one
// clean line (otherwise every crosswalk becomes a decision); tunnels are skipped because the camera
// would end up inside the 3D ground.
const HW = 'footway|path|pedestrian|living_street|residential|unclassified|tertiary|tertiary_link|secondary|secondary_link|primary|primary_link|steps|track|cycleway|bridleway';
const KIND: Record<string, string> = { footway: 'Footpath', path: 'Trail', track: 'Track', steps: 'Steps', pedestrian: 'Plaza', cycleway: 'Shared path', bridleway: 'Bridleway' };

export class WalkGraph {
  nodes = new Map<number, GNode>();
  edges: GEdge[] = [];
  chunks: { c: LngLat; r: number }[] = [];
  private seen = new Set<string>();
  loading = false;

  degree(n: number) { return this.nodes.get(n)?.edges.length ?? 0; }
  other(e: GEdge, n: number) { return e.a === n ? e.b : e.a; }
  pos(n: number) { return this.nodes.get(n)!.p; }

  /** True when p is comfortably inside loaded data. */
  covers(p: LngLat, margin = 0) { return this.chunks.some((c) => dist(c.c, p) < c.r - margin); }

  async load(center: LngLat, radius: number): Promise<boolean> {
    if (this.loading) return false;
    this.loading = true;
    const q = `[out:json][timeout:25];way(around:${radius},${center[1].toFixed(6)},${center[0].toFixed(6)})[highway~"^(${HW})$"][access!~"^(private|no)$"][foot!~"^(no|private)$"][footway!~"^(sidewalk|crossing|traffic_island|access_aisle)$"][tunnel!~"^(yes|building_passage)$"][indoor!=yes][area!=yes];out body geom qt;`;
    try {
      for (const url of MIRRORS) {
        try {
          const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 30000);
          const r = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(q), signal: ctl.signal, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
          clearTimeout(t);
          if (!r.ok) continue;
          const json = await r.json();
          this.add(json.elements || []);
          this.chunks.push({ c: center, r: radius });
          return true;
        } catch { /* try next mirror */ }
      }
      return false;
    } finally { this.loading = false; }
  }

  private add(ways: { type: string; nodes?: number[]; geometry?: { lat: number; lon: number }[]; tags?: Record<string, string> }[]) {
    for (const w of ways) {
      if (w.type !== 'way' || !w.nodes || !w.geometry || w.nodes.length !== w.geometry.length) continue;
      const tags = w.tags || {};
      const name = tags.name || tags.ref || KIND[tags.highway] || 'Street';
      for (let i = 0; i < w.nodes.length; i++) {
        const id = w.nodes[i], g = w.geometry[i];
        if (!this.nodes.has(id)) this.nodes.set(id, { id, p: [g.lon, g.lat], edges: [] });
        if (i === 0) continue;
        const a = w.nodes[i - 1], key = a < id ? `${a}_${id}` : `${id}_${a}`;
        if (a === id || this.seen.has(key)) continue;
        this.seen.add(key);
        const e: GEdge = { id: this.edges.length, a, b: id, len: Math.max(0.01, dist(this.pos(a), this.pos(id))), name };
        this.edges.push(e);
        this.nodes.get(a)!.edges.push(e.id);
        this.nodes.get(id)!.edges.push(e.id);
      }
    }
  }

  nearestEdge(p: LngLat, maxD = 60): { e: GEdge; t: number; d: number } | null {
    let best: { e: GEdge; t: number; d: number } | null = null;
    for (const e of this.edges) {
      const a = this.pos(e.a);
      if (Math.abs(a[1] - p[1]) > 0.01 || Math.abs(a[0] - p[0]) > 0.015) continue;
      const r = projectOnSegment(p, a, this.pos(e.b));
      if (r.d < maxD && (!best || r.d < best.d)) best = { e, t: r.t, d: r.d };
    }
    return best;
  }

  nearestNode(p: LngLat): number | null {
    let best = -1, bd = Infinity;
    for (const n of this.nodes.values()) {
      if (Math.abs(n.p[1] - p[1]) > 0.01 || !n.edges.length) continue;
      const d = dist(n.p, p);
      if (d < bd) { bd = d; best = n.id; }
    }
    return best < 0 ? null : best;
  }

  /** A* shortest path; returns the first edge to take from `start` (arriving via `banEdge` is not allowed back). */
  firstStepTo(start: number, goal: number, banEdge: number, maxExpand = 4000): number | null {
    if (start === goal) return null;
    const gp = this.pos(goal);
    const g = new Map<number, number>([[start, 0]]);
    const first = new Map<number, number>();
    const open: [number, number][] = [[dist(this.pos(start), gp), start]];
    const closed = new Set<number>();
    while (open.length && closed.size < maxExpand) {
      let bi = 0; for (let i = 1; i < open.length; i++) if (open[i][0] < open[bi][0]) bi = i;
      const [, n] = open[bi]; open[bi] = open[open.length - 1]; open.pop();
      if (closed.has(n)) continue;
      if (n === goal) return first.get(n) ?? null;
      closed.add(n);
      for (const eid of this.nodes.get(n)!.edges) {
        if (n === start && eid === banEdge) continue;
        const e = this.edges[eid], m = this.other(e, n), ng = g.get(n)! + e.len;
        if (ng < (g.get(m) ?? Infinity)) {
          g.set(m, ng);
          first.set(m, n === start ? eid : first.get(n)!);
          open.push([ng + dist(this.pos(m), gp), m]);
        }
      }
    }
    return null;
  }
}
