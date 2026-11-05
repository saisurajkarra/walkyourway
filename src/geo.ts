export type LngLat = [number, number];

const R = 6371008.8;
const RAD = Math.PI / 180;

/** Fast local distance in meters (equirectangular; accurate at walking scales). */
export function dist(a: LngLat, b: LngLat): number {
  const dx = (b[0] - a[0]) * RAD * Math.cos(((a[1] + b[1]) / 2) * RAD);
  const dy = (b[1] - a[1]) * RAD;
  return Math.hypot(dx, dy) * R;
}

/** Compass bearing a→b in degrees (0 = north, clockwise). */
export function bearing(a: LngLat, b: LngLat): number {
  const dx = (b[0] - a[0]) * Math.cos(((a[1] + b[1]) / 2) * RAD);
  const dy = b[1] - a[1];
  return (Math.atan2(dx, dy) / RAD + 360) % 360;
}

export function destination(p: LngLat, brgDeg: number, meters: number): LngLat {
  const d = meters / R, b = brgDeg * RAD;
  return [p[0] + (Math.sin(b) * d) / RAD / Math.cos(p[1] * RAD), p[1] + (Math.cos(b) * d) / RAD];
}

export const lerp = (a: LngLat, b: LngLat, t: number): LngLat => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

/** Signed smallest angle from a to b in degrees, in (-180, 180]. Positive = clockwise (right). */
export function angDiff(a: number, b: number): number {
  let d = (((b - a) % 360) + 540) % 360 - 180;
  if (d === -180) d = 180;
  return d;
}

/** Projects p onto segment ab; returns fraction t in [0,1] and distance in meters. */
export function projectOnSegment(p: LngLat, a: LngLat, b: LngLat): { t: number; d: number } {
  const k = Math.cos(p[1] * RAD);
  const ax = (a[0] - p[0]) * k, ay = a[1] - p[1], bx = (b[0] - p[0]) * k, by = b[1] - p[1];
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L)) : 0;
  return { t, d: Math.hypot(ax + t * dx, ay + t * dy) * RAD * R };
}

/** A polyline with cumulative distances, for "point at distance s" lookups. */
export class Line {
  readonly cum: number[] = [0];
  readonly length: number;
  constructor(readonly coords: LngLat[]) {
    for (let i = 1; i < coords.length; i++) this.cum.push(this.cum[i - 1] + dist(coords[i - 1], coords[i]));
    this.length = this.cum[this.cum.length - 1];
  }
  private seg(s: number): number {
    let lo = 0, hi = this.cum.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (this.cum[m] <= s) lo = m; else hi = m; }
    return lo;
  }
  pointAt(s: number): LngLat {
    s = Math.max(0, Math.min(this.length, s));
    const i = this.seg(s), L = this.cum[i + 1] - this.cum[i] || 1;
    return lerp(this.coords[i], this.coords[i + 1] ?? this.coords[i], (s - this.cum[i]) / L);
  }
  /** Closest point on the line between distances sMin..sMax. */
  project(p: LngLat, sMin = 0, sMax = Infinity): { s: number; d: number } {
    let best = { s: 0, d: Infinity };
    const i0 = this.seg(Math.max(0, sMin)), i1 = Math.min(this.coords.length - 2, this.seg(Math.min(this.length, sMax)));
    for (let i = i0; i <= i1; i++) {
      const { t, d } = projectOnSegment(p, this.coords[i], this.coords[i + 1]);
      if (d < best.d) best = { s: this.cum[i] + t * (this.cum[i + 1] - this.cum[i]), d };
    }
    return best;
  }
}

/** Frame-rate independent exponential smoothing factor. */
export const smooth = (dt: number, tau: number) => 1 - Math.exp(-dt / tau);
