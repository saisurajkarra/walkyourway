#!/usr/bin/env node
// Snaps hand-written waypoints onto real OpenStreetMap walking paths (FOSSGIS OSRM foot router),
// validates them, simplifies the geometry and writes src/data/routes/<name>.json.
// Usage: node scripts/build-routes.mjs scripts/route-specs/hikes.json [more spec files...]
// Spec entry: { id, name, category: "city"|"hike"|"scenic", region, place, blurb, waypoints: [[lng,lat], ...] }
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';

const MAX_SNAP_M = 80; // a waypoint further than this from a walkable path is probably a wrong coordinate
const LIMITS = { city: [1.5, 12], hike: [2, 25], scenic: [1.5, 20] }; // km

const R = 6371008.8, rad = Math.PI / 180;
function dist([x1, y1], [x2, y2]) {
  const dx = (x2 - x1) * rad * Math.cos(((y1 + y2) / 2) * rad), dy = (y2 - y1) * rad;
  return Math.hypot(dx, dy) * R;
}
function segDist(p, a, b) {
  const k = Math.cos(a[1] * rad) * R * rad, toXY = (q) => [q[0] * k, q[1] * R * rad];
  const [px, py] = toXY(p), [ax, ay] = toXY(a), [bx, by] = toXY(b);
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L)) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}
function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop(); let best = -1, idx = -1;
    for (let k = i + 1; k < j; k++) { const d = segDist(pts[k], pts[i], pts[j]); if (d > best) { best = d; idx = k; } }
    if (best > tol) { keep[idx] = 1; stack.push([i, idx], [idx, j]); }
  }
  return pts.filter((_, i) => keep[i]);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// FOSSGIS fair use is 1 request/second for everyone on this machine: serialize across processes.
import { mkdirSync as mk, rmdirSync, statSync, utimesSync, writeFileSync as wf } from 'node:fs';
import { tmpdir } from 'node:os';
const LOCK = tmpdir() + '/wyw-osrm.lock', STAMP = tmpdir() + '/wyw-osrm.last';
async function throttle() {
  for (;;) {
    try { mk(LOCK); break; } catch { try { if (Date.now() - statSync(LOCK).mtimeMs > 30000) rmdirSync(LOCK); } catch { /* raced */ } await sleep(150); }
  }
  let last = 0; try { last = statSync(STAMP).mtimeMs; } catch { wf(STAMP, ''); }
  const wait = last + 1100 - Date.now();
  if (wait > 0) await sleep(wait);
  const now = new Date(); utimesSync(STAMP, now, now);
  rmdirSync(LOCK);
}

let failed = 0;
for (const file of process.argv.slice(2)) {
  const specs = JSON.parse(readFileSync(file, 'utf8'));
  const out = [];
  for (const s of specs) {
    const errs = [];
    if (!/^[a-z0-9-]+$/.test(s.id || '')) errs.push('bad id');
    if (!LIMITS[s.category]) errs.push('bad category');
    if (!Array.isArray(s.waypoints) || s.waypoints.length < 2) errs.push('need >=2 waypoints');
    let res;
    if (!errs.length) {
      const coords = s.waypoints.map(([lng, lat]) => `${lng.toFixed(6)},${lat.toFixed(6)}`).join(';');
      const url = `https://routing.openstreetmap.de/routed-foot/route/v1/foot/${coords}?overview=full&geometries=geojson&continue_straight=true`;
      await throttle();
      try {
        res = JSON.parse(execFileSync('curl', ['-s', '-m', '60', '-A', 'walkyourway-route-builder', url], { encoding: 'utf8' }));
      } catch (e) { errs.push('router request failed: ' + e.message.slice(0, 80)); }
    }
    if (res && res.code !== 'Ok') errs.push('router: ' + res.code + ' ' + (res.message || ''));
    if (res && res.code === 'Ok') {
      res.waypoints.forEach((w, i) => { if (w.distance > MAX_SNAP_M) errs.push(`waypoint ${i} is ${Math.round(w.distance)} m from any path (snapped to ${w.location.map((v) => v.toFixed(5))})`); });
      const km = res.routes[0].distance / 1000, [lo, hi] = LIMITS[s.category] || [0, 1e9];
      if (km < lo || km > hi) errs.push(`length ${km.toFixed(1)} km outside ${lo}-${hi} km`);
      // Detect pointless back-and-forth: route much longer than the sum of waypoint gaps means a detour.
      const direct = s.waypoints.slice(1).reduce((a, p, i) => a + dist(s.waypoints[i], p), 0);
      if (km * 1000 > direct * 2.6 && km > 3) errs.push(`route ${km.toFixed(1)} km is ${(km * 1000 / direct).toFixed(1)}x the waypoint distance - likely a detour around a missing path`);
      if (!errs.length) {
        const geom = simplify(res.routes[0].geometry.coordinates, 2.5).map(([x, y]) => [+x.toFixed(6), +y.toFixed(6)]);
        out.push({ id: s.id, name: s.name, category: s.category, region: s.region, place: s.place, blurb: s.blurb, distanceKm: +km.toFixed(2), coords: geom });
      }
    }
    if (errs.length) failed++;
    console.log(`${errs.length ? 'FAIL' : 'ok  '} ${s.id}  ${res?.routes ? (res.routes[0].distance / 1000).toFixed(2) + ' km' : ''}${errs.length ? '\n      - ' + errs.join('\n      - ') : ''}`);
  }
  mkdirSync('src/data/routes', { recursive: true });
  const target = `src/data/routes/${basename(file)}`;
  writeFileSync(target, JSON.stringify(out));
  console.log(`wrote ${out.length}/${specs.length} routes -> ${target}`);
}
process.exit(failed ? 1 : 0);
