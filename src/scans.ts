import SCANS from './data/scans.json';
import { toENU, type LngLat } from './geo';

/** A real street rebuilt in 3D (see scripts/scan/build_scan.py). Kept free of three.js so the home page stays light. */
export interface ScanMeta { id: string; title: string; place: string; region: string; blurb: string; count: number; ref: [number, number]; origin: [number, number, number]; step: number; path: [number, number, number][]; license: string }
export const SCAN_META = SCANS as unknown as ScanMeta[];

/** Scan whose walked path passes within `maxD` metres of `p` (null if none). */
export function scanAt(p: LngLat, maxD = 25): ScanMeta | null {
  let best: ScanMeta | null = null, bd = maxD;
  for (const s of SCAN_META) for (const q of s.path) {
    const [x, y] = toENU([q[0], q[1]], p), d = Math.hypot(x, y);
    if (d < bd) { bd = d; best = s; }
  }
  return best;
}
export const hasScans = () => SCAN_META.length > 0;
