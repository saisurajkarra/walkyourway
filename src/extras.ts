import { angDiff, bearing, dist, type LngLat } from './geo';
import type { WalkGraph } from './graph';
import type { Line } from './geo';

/** Real landmarks you pass (Wikipedia geosearch), announced with which side they're on. */
export class Landmarks {
  private items: { title: string; p: LngLat }[] = [];
  private seen = new Set<string>();
  private lastFetch: LngLat | null = null;
  private busy = false;

  tick(pos: LngLat, heading: number): { title: string; where: string; url: string } | null {
    if (!this.busy && (!this.lastFetch || dist(this.lastFetch, pos) > 250)) {
      this.busy = true; this.lastFetch = pos;
      fetch(`https://en.wikipedia.org/w/api.php?action=query&list=geosearch&gscoord=${pos[1]}|${pos[0]}&gsradius=600&gslimit=30&format=json&origin=*`)
        .then((r) => r.json())
        .then((j) => { for (const g of j?.query?.geosearch ?? []) if (!this.items.some((i) => i.title === g.title)) this.items.push({ title: g.title, p: [g.lon, g.lat] }); })
        .catch(() => {}).finally(() => { this.busy = false; });
    }
    for (const it of this.items) {
      if (this.seen.has(it.title)) continue;
      const d = dist(pos, it.p);
      if (d > 140) continue;
      this.seen.add(it.title);
      const a = angDiff(heading, bearing(pos, it.p));
      const where = d < 30 ? 'right here' : Math.abs(a) < 35 ? 'ahead' : Math.abs(a) > 135 ? 'behind you' : a < 0 ? 'on your left' : 'on your right';
      return { title: it.title, where, url: `https://en.wikipedia.org/wiki/${encodeURIComponent(it.title.replace(/ /g, '_'))}` };
    }
    return null;
  }
}

/** Heading-up mini map: real streets/trails (grey), suggested route (blue), you (arrow). */
export function drawMinimap(cv: HTMLCanvasElement, g: WalkGraph, route: Line | null, pos: LngLat, heading: number, progress: number) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2), W = cv.clientWidth, H = cv.clientHeight;
  if (cv.width !== W * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
  const c = cv.getContext('2d')!;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, W, H);
  const range = 260, k = W / 2 / range * 0.95;
  const cos = Math.cos((pos[1] * Math.PI) / 180), rot = (-heading * Math.PI) / 180;
  const toXY = (p: LngLat): [number, number] => {
    const x = (p[0] - pos[0]) * 111320 * cos, y = (p[1] - pos[1]) * 110540;
    const rx = x * Math.cos(rot) - y * Math.sin(rot), ry = x * Math.sin(rot) + y * Math.cos(rot);
    return [W / 2 + rx * k, H / 2 - ry * k];
  };
  c.lineCap = 'round';
  c.strokeStyle = 'rgba(255,255,255,0.55)'; c.lineWidth = 2;
  c.beginPath();
  const dLat = range / 110540, dLng = range / (111320 * cos);
  for (const e of g.edges) {
    const a = g.pos(e.a), b = g.pos(e.b);
    if (Math.abs(a[1] - pos[1]) > dLat && Math.abs(b[1] - pos[1]) > dLat) continue;
    if (Math.abs(a[0] - pos[0]) > dLng && Math.abs(b[0] - pos[0]) > dLng) continue;
    const A = toXY(a), B = toXY(b); c.moveTo(A[0], A[1]); c.lineTo(B[0], B[1]);
  }
  c.stroke();
  if (route) {
    c.lineWidth = 3.5;
    const pts = route.coords;
    for (const [color, from, to] of [['rgba(148,163,184,0.8)', 0, progress], ['#38bdf8', progress, Infinity]] as const) {
      c.strokeStyle = color; c.beginPath();
      let first = true;
      for (let i = 0; i < pts.length; i++) {
        if (route.cum[i] < from - 20 || route.cum[i] > to + 20) { first = true; continue; }
        const [x, y] = toXY(pts[i]);
        if (first) c.moveTo(x, y); else c.lineTo(x, y);
        first = false;
      }
      c.stroke();
    }
  }
  c.fillStyle = '#facc15'; c.strokeStyle = '#000'; c.lineWidth = 1.5;
  c.beginPath(); c.moveTo(W / 2, H / 2 - 9); c.lineTo(W / 2 + 6.5, H / 2 + 7); c.lineTo(W / 2, H / 2 + 3.5); c.lineTo(W / 2 - 6.5, H / 2 + 7); c.closePath();
  c.fill(); c.stroke();
  // north tick
  const n = toXY([pos[0], pos[1] + range / 110540 * 0.85]);
  c.fillStyle = '#f87171'; c.font = 'bold 10px system-ui'; c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText('N', Math.max(8, Math.min(W - 8, n[0])), Math.max(8, Math.min(H - 8, n[1])));
}
