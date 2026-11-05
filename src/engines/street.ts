import * as THREE from 'three';
import { angDiff, toENU, type LngLat } from '../geo';
import type { CameraPose, ViewEngine } from './types';

/**
 * REAL VIEW: eye-level walking through real 360° street photography, rendered by our own WebGL engine.
 * Sources: Google Street View imagery (official Map Tiles API, needs a key) or, with no key at all,
 * the free photo commons: Mapillary (worldwide, 360° and regular photos, free client token) and Panoramax
 * (open, 6K 360° photos). Every photo carries GPS + compass + capture time, like a Kinomap telemetry track.
 *
 * How the motion stays smooth like a video instead of jumping between photos:
 * each pixel's view ray is cast against a simple "street canyon" proxy (ground plane + building walls
 * at a typical street half-width) around each nearby photo, and the photo is sampled where the ray
 * hits. Moving the camera between photo positions therefore produces real parallax on the road and
 * facades, and the 2–3 nearest photos are blended by distance, so you glide continuously.
 */
const API = 'https://tile.googleapis.com/v1';
const PMX = 'https://api.panoramax.xyz/api';
const MLY = 'https://graph.mapillary.com/images';
const MLY_FIELDS = 'id,computed_geometry,geometry,computed_compass_angle,compass_angle,is_pano,camera_type,camera_parameters,width,height,thumb_2048_url,thumb_original_url,captured_at,sequence,creator';

interface Pano {
  id: string; p: LngLat; xy: [number, number]; heading: number;
  w: number; h: number; tw: number; th: number; copyright: string; date: string;
  tex: THREE.CanvasTexture | null; zoom: number; loading: boolean; lastUsed: number;
  src?: { sd: string; hd: string }; // Panoramax: whole 360° images instead of tiles
  flat?: { tanH: number; aspect: number }; // regular (non-360°) photo with its camera's field of view
  seq?: string; // capture sequence (one person's walk): staying on it keeps time & light consistent
}

const VERT = /* glsl */ `
in vec3 position;
out vec2 vNdc;
void main() { vNdc = position.xy; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const FRAG = /* glsl */ `
precision highp float;
uniform sampler2D t0, t1, t2;
uniform vec2 p0, p1, p2;
uniform vec3 hd, w;
uniform vec3 pj, th, ar; // projection (0 = 360°, 1 = flat photo), tan(half horizontal FOV), aspect w/h
uniform vec3 cam, fwd, right, up;
uniform vec2 tanH;
uniform float gnd, rad;
in vec2 vNdc;
out vec4 frag;
const float PI = 3.14159265359;
vec4 samplePano(sampler2D t, vec2 pp, float heading, float proj, float tanh, float asp, vec3 dir) {
  vec3 o = vec3(cam.xy - pp, cam.z);
  float tG = dir.z < -1e-3 ? (-gnd - o.z) / dir.z : 1e6;
  float R = max(rad, length(o.xy) + 4.0); // the camera must always be inside the proxy
  float a = dot(dir.xy, dir.xy), b = dot(o.xy, dir.xy), c = dot(o.xy, o.xy) - R * R;
  float tC = a > 1e-6 ? (-b + sqrt(max(b * b - a * c, 0.0))) / a : 1e6;
  float tt = min(tG, tC);
  vec3 hit = o + dir * tt;
  // tall facades / sky: fade to "far away" so rooftops and sky don't stretch
  vec3 d = normalize(mix(normalize(hit), dir, tt == tC ? smoothstep(10.0, 26.0, hit.z) : 0.0));
  float az = atan(d.x, d.y) - heading;
  if (proj < 0.5) {
    float u = fract(0.5 + az / (2.0 * PI));
    float v = 0.5 - asin(clamp(d.z, -1.0, 1.0)) / PI;
    return vec4(texture(t, vec2(u, v)).rgb, 1.0);
  }
  // flat photo: shown undistorted through its own pinhole camera (no street-proxy reprojection, which
  // smears a narrow photo taken metres away); forward motion comes from a gentle zoom instead.
  float faz = atan(dir.x, dir.y) - heading;
  float fx = max(cos(faz) * length(dir.xy), 0.02), rx = sin(faz) * length(dir.xy);
  vec2 uv = vec2(0.5 + rx / fx / (2.0 * tanh), 0.5 - dir.z / fx / (2.0 * tanh / asp));
  float edge = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
  float alpha = mix(0.12, 1.0, smoothstep(-0.02, 0.03, edge));
  return vec4(texture(t, clamp(uv, 0.0, 1.0)).rgb * mix(0.45, 1.0, alpha), alpha);
}
void main() {
  vec3 dir = normalize(fwd + vNdc.x * tanH.x * right + vNdc.y * tanH.y * up);
  vec3 col = vec3(0.0);
  float ws = 0.0;
  if (w.x > 0.001) { vec4 c = samplePano(t0, p0, hd.x, pj.x, th.x, ar.x, dir); col += w.x * c.a * c.rgb; ws += w.x * c.a; }
  if (w.y > 0.001) { vec4 c = samplePano(t1, p1, hd.y, pj.y, th.y, ar.y, dir); col += w.y * c.a * c.rgb; ws += w.y * c.a; }
  if (w.z > 0.001) { vec4 c = samplePano(t2, p2, hd.z, pj.z, th.z, ar.z, dir); col += w.z * c.a * c.rgb; ws += w.z * c.a; }
  frag = vec4(ws > 0.0 ? col / ws : vec3(0.05, 0.07, 0.1), 1.0);
}`;

export class StreetEngine implements ViewEngine {
  readonly label = 'Real View';
  readonly eyeLevelOnly = true;
  private session = '';
  private origin: LngLat = [0, 0];
  private renderer!: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.Camera();
  private mat!: THREE.RawShaderMaterial;
  private blank = new THREE.DataTexture(new Uint8Array([10, 14, 22, 255]), 1, 1);
  private panos = new Map<string, Pano>();
  private cells = new Map<string, number>(); // looked-up grid cells -> time
  private lookups = 0;
  private maxZoom = 3;
  private pixelCap = 2;
  private covered = true;
  private credit!: HTMLElement;
  private el!: HTMLElement;
  private ro?: ResizeObserver;
  private lastPrefetch = 0;
  private walkHeading = 0;
  private cur: Pano | null = null;
  private prev: Pano | null = null;
  private fade = 1;
  private viewOff = 0;
  private viewTan = 0;

  private source: 'google' | 'panoramax';
  constructor(private key: string, private mly: string, private wallRadius: number) { this.source = key ? 'google' : 'panoramax'; }

  private q(extra = '') { return `session=${this.session}&key=${this.key}${extra}`; }

  async init(el: HTMLElement, start: LngLat) {
    this.el = el; this.origin = start;
    if (this.source === 'google') {
      const r = await fetch(`${API}/createSession?key=${this.key}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mapType: 'streetview', language: navigator.language || 'en-US', region: 'US' }),
      });
      if (!r.ok) throw new Error(`Street imagery unavailable (${r.status})`);
      this.session = (await r.json()).session;
    } else this.session = 'panoramax';
    const first = await this.lookup([start], 200);
    if (!first.length) throw new Error('No street-level imagery at this spot');

    const renderer = (this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' }));
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.pixelCap));
    el.appendChild(renderer.domElement);
    Object.assign(renderer.domElement.style, { width: '100%', height: '100%', display: 'block' });
    const resize = () => renderer.setSize(el.clientWidth, el.clientHeight, false);
    resize();
    this.ro = new ResizeObserver(resize); this.ro.observe(el);
    if (renderer.capabilities.maxTextureSize < 4096) this.maxZoom = 2;

    this.blank.needsUpdate = true;
    this.mat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: FRAG, depthTest: false, depthWrite: false,
      uniforms: {
        t0: { value: this.blank }, t1: { value: this.blank }, t2: { value: this.blank },
        p0: { value: new THREE.Vector2() }, p1: { value: new THREE.Vector2() }, p2: { value: new THREE.Vector2() },
        hd: { value: new THREE.Vector3() }, w: { value: new THREE.Vector3() },
        pj: { value: new THREE.Vector3() }, th: { value: new THREE.Vector3(1, 1, 1) }, ar: { value: new THREE.Vector3(1, 1, 1) },
        cam: { value: new THREE.Vector3() }, fwd: { value: new THREE.Vector3() }, right: { value: new THREE.Vector3() }, up: { value: new THREE.Vector3() },
        tanH: { value: new THREE.Vector2() }, gnd: { value: this.source === 'google' ? 2.5 : 2.2 }, rad: { value: this.wallRadius },
      },
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat);
    quad.frustumCulled = false;
    this.scene.add(quad);

    this.credit = document.createElement('div');
    this.credit.className = 'sv-credit';
    el.appendChild(this.credit);

    renderer.render(this.scene, this.camera);
    const bad = renderer.info.programs?.find((x) => (x as unknown as { diagnostics?: { runnable: boolean } }).diagnostics?.runnable === false);
    if (bad) throw new Error('Real View shader failed to compile on this device');

    const p = this.panos.get(first[0])!;
    await this.loadTex(p, 2);
    void this.loadTex(p, this.maxZoom);
  }

  /** Finds photos near points (and their metadata). Returns IDs nearest-first. */
  private async lookup(points: LngLat[], radius = 20): Promise<string[]> {
    if (this.source === 'google') return this.lookupGoogle(points, radius);
    const [a, b] = await Promise.all([this.mly ? this.lookupMapillary(points, radius) : [], this.lookupPanoramax(points, radius)]);
    const ids = [...new Set([...a, ...b])];
    const d = (id: string) => Math.min(...points.map((q) => Math.hypot(...toENU(this.panos.get(id)!.p, q))));
    return ids.sort((x, y) => d(x) - d(y));
  }

  private bbox(points: LngLat[], radius: number) {
    const dLat = radius / 110540, dLng = radius / (111320 * Math.cos((points[0][1] * Math.PI) / 180));
    const lngs = points.map((p) => p[0]), lats = points.map((p) => p[1]);
    return [Math.min(...lngs) - dLng, Math.min(...lats) - dLat, Math.max(...lngs) + dLng, Math.max(...lats) + dLat].map((v) => v.toFixed(6)).join(',');
  }

  private async lookupMapillary(points: LngLat[], radius: number): Promise<string[]> {
    this.lookups++;
    try {
      const r = await fetch(`${MLY}?access_token=${encodeURIComponent(this.mly)}&fields=${MLY_FIELDS}&bbox=${this.bbox(points, radius)}&limit=200`);
      if (!r.ok) return [];
      const ids: string[] = [];
      for (const f of (await r.json()).data || []) {
        if (f.camera_type === 'fisheye' || !f.thumb_2048_url) continue;
        const id = 'mly:' + f.id;
        if (!this.panos.has(id)) {
          const p: LngLat = (f.computed_geometry || f.geometry).coordinates;
          const pano = !!f.is_pano || f.camera_type === 'spherical' || f.camera_type === 'equirectangular';
          const w = f.width || 4, h = f.height || 3, focal = (f.camera_parameters || [])[0] || 0.85;
          this.panos.set(id, {
            id, p, xy: toENU(p, this.origin), heading: (((f.computed_compass_angle ?? f.compass_angle) || 0) * Math.PI) / 180,
            w, h, tw: 0, th: 0, copyright: `Mapillary · ${f.creator?.username || 'contributor'} · CC BY-SA`,
            date: f.captured_at ? new Date(f.captured_at).toISOString().slice(0, 7) : '', tex: null, zoom: -1, loading: false, lastUsed: 0,
            src: { sd: f.thumb_2048_url, hd: (pano && f.thumb_original_url) || f.thumb_2048_url }, seq: f.sequence,
            flat: pano ? undefined : { tanH: w >= h ? 0.5 / focal : (0.5 / focal) * (w / h), aspect: w / h },
          });
        }
        ids.push(id);
      }
      return ids;
    } catch { return []; } finally { this.lookups--; }
  }

  private async lookupPanoramax(points: LngLat[], radius: number): Promise<string[]> {
    this.lookups++;
    try {
      const dLat = radius / 110540, dLng = radius / (111320 * Math.cos((points[0][1] * Math.PI) / 180));
      const lngs = points.map((p) => p[0]), lats = points.map((p) => p[1]);
      const bbox = [Math.min(...lngs) - dLng, Math.min(...lats) - dLat, Math.max(...lngs) + dLng, Math.max(...lats) + dLat].map((v) => v.toFixed(6)).join(',');
      const r = await fetch(`${PMX}/search?bbox=${bbox}&limit=100`);
      if (!r.ok) return [];
      const found: { id: string; d: number }[] = [];
      for (const f of (await r.json()).features || []) {
        const pr = f.properties || {};
        if ((pr['pers:interior_orientation'] || {}).field_of_view !== 360 || !f.assets?.sd?.href) continue;
        const p: LngLat = f.geometry.coordinates;
        if (!this.panos.has(f.id)) {
          const dims = (pr['pers:interior_orientation'] || {}).sensor_array_dimensions || [6000, 3000];
          const who = (f.providers || []).map((x: { name: string }) => x.name).filter(Boolean)[0] || 'Panoramax contributors';
          this.panos.set(f.id, {
            id: f.id, p, xy: toENU(p, this.origin), heading: ((pr['view:azimuth'] ?? 0) * Math.PI) / 180,
            w: dims[0], h: dims[1], tw: 0, th: 0, copyright: `Panoramax · ${who} · ${pr.license || 'open licence'}`,
            date: (pr.datetime || '').slice(0, 7), tex: null, zoom: -1, loading: false, lastUsed: 0,
            src: { sd: f.assets.sd.href, hd: (f.assets.hd || f.assets.sd).href }, seq: f.collection,
          });
        }
        found.push({ id: f.id, d: Math.min(...points.map((q) => Math.hypot(...toENU(p, q)))) });
      }
      return found.sort((a, b) => a.d - b.d).map((x) => x.id);
    } catch { return []; } finally { this.lookups--; }
  }

  private async lookupGoogle(points: LngLat[], radius: number): Promise<string[]> {
    this.lookups++;
    try {
      const r = await fetch(`${API}/streetview/panoIds?${this.q()}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locations: points.map(([lng, lat]) => ({ lat, lng })), radius }),
      });
      if (!r.ok) return [];
      const ids: string[] = [...new Set(((await r.json()).panoIds || []) as string[])].filter(Boolean);
      await Promise.all(ids.filter((id) => !this.panos.has(id)).map((id) => this.meta(id)));
      return ids.filter((id) => this.panos.has(id));
    } catch { return []; } finally { this.lookups--; }
  }

  private async meta(id: string) {
    const r = await fetch(`${API}/streetview/metadata?${this.q(`&panoId=${encodeURIComponent(id)}`)}`);
    if (!r.ok) return;
    const m = await r.json();
    if (!Number.isFinite(m.lat) || !m.imageWidth) return;
    const p: LngLat = [m.lng, m.lat];
    this.panos.set(id, {
      id, p, xy: toENU(p, this.origin), heading: ((m.heading ?? 0) * Math.PI) / 180,
      w: m.imageWidth, h: m.imageHeight, tw: m.tileWidth || 512, th: m.tileHeight || 512,
      copyright: m.copyright || '© Google', date: m.date || '', tex: null, zoom: -1, loading: false, lastUsed: 0,
    });
  }

  /** Builds the equirectangular texture: whole sphere at `z`, sharpened forward band at max zoom. */
  private async loadTex(p: Pano, z: number) {
    if (p.src) return this.loadWhole(p, z >= 3 ? 3 : 2);
    const zmax = Math.max(0, Math.ceil(Math.log2(p.w / p.tw)));
    const zz = Math.min(z, zmax), scale = 2 ** (zmax - zz);
    if (p.loading || p.zoom >= zz) return;
    p.loading = true;
    try {
      const W = Math.ceil(p.w / scale), H = Math.ceil(p.h / scale);
      const nx = Math.ceil(W / p.tw), ny = Math.ceil(H / p.th);
      const cv = document.createElement('canvas');
      cv.width = W; cv.height = H;
      const c = cv.getContext('2d')!;
      if (p.tex?.image) c.drawImage(p.tex.image as CanvasImageSource, 0, 0, W, H); // keep lower-res as base
      const tiles: [number, number][] = [];
      const band = zz >= 3; // at 4K only fetch the forward-facing horizon band (cost + speed)
      for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
        if (band) {
          if (y === 0 || y === ny - 1) continue;
          const az = (((x + 0.5) / nx - 0.5) * 360) + (p.heading * 180) / Math.PI;
          if (Math.abs(angDiff(this.walkHeading, az)) > 110) continue;
        }
        tiles.push([x, y]);
      }
      await Promise.all(tiles.map(async ([x, y]) => {
        try {
          const r = await fetch(`${API}/streetview/tiles/${zz}/${x}/${y}?${this.q(`&panoId=${encodeURIComponent(p.id)}`)}`);
          if (!r.ok) return;
          const bmp = await createImageBitmap(await r.blob());
          c.drawImage(bmp, x * p.tw, y * p.th);
          bmp.close?.();
        } catch { /* tile missing: base layer stays */ }
      }));
      const tex = new THREE.CanvasTexture(cv);
      tex.colorSpace = THREE.NoColorSpace;
      tex.flipY = false; // browsers apply the upload flip inconsistently for large canvases; v=0 is the top row
      tex.generateMipmaps = false;
      tex.minFilter = THREE.LinearFilter;
      tex.wrapS = THREE.RepeatWrapping;
      const old = p.tex;
      p.tex = tex; p.zoom = zz;
      old?.dispose();
    } finally { p.loading = false; }
  }

  /** Panoramax: one 360° JPEG per photo; sd (2048 px) first, then the 6K original scaled to 4K. */
  private async loadWhole(p: Pano, z: number) {
    if (p.loading || p.zoom >= z) return;
    p.loading = true;
    try {
      const r = await fetch(z >= 3 ? p.src!.hd : p.src!.sd);
      if (!r.ok) return;
      const bmp = await createImageBitmap(await r.blob());
      const W = Math.min(z >= 3 ? 4096 : 2048, bmp.width), H = Math.round((W * bmp.height) / bmp.width);
      const cv = document.createElement('canvas');
      cv.width = W; cv.height = H;
      cv.getContext('2d')!.drawImage(bmp, 0, 0, W, H);
      bmp.close?.();
      const tex = new THREE.CanvasTexture(cv);
      tex.colorSpace = THREE.NoColorSpace; tex.flipY = false; tex.generateMipmaps = false;
      tex.minFilter = THREE.LinearFilter; tex.wrapS = THREE.RepeatWrapping;
      const old = p.tex;
      p.tex = tex; p.zoom = z;
      old?.dispose();
    } catch { /* keep the previous image */ } finally { p.loading = false; }
  }

  /** Called with the walker's next ~24 m so photos are fetched before you arrive. */
  prefetch(path: LngLat[]) {
    const now = performance.now();
    if (now - this.lastPrefetch < 350 || this.lookups > 1 || !this.session) return;
    this.lastPrefetch = now;
    const pts: LngLat[] = [];
    for (const p of path) {
      const [x, y] = toENU(p, this.origin), key = `${Math.round(x / 7)},${Math.round(y / 7)}`;
      if (this.cells.has(key)) continue;
      this.cells.set(key, now);
      pts.push(p);
    }
    if (pts.length) void this.lookup(pts.slice(0, 20), 18);
  }

  render(pose: CameraPose, dt: number) {
    if (!this.mat) return;
    this.walkHeading = pose.heading;
    const cam: LngLat = [pose.lng, pose.lat];
    const [cx, cy] = toENU(cam, this.origin);
    const now = performance.now();
    // nearest photos, load/upgrade them
    const near = [...this.panos.values()].map((p) => ({ p, d: Math.hypot(p.xy[0] - cx, p.xy[1] - cy) })).sort((a, b) => a.d - b.d);
    near.slice(0, 5).forEach(({ p, d }, i) => {
      if (d > 60) return;
      p.lastUsed = now;
      if (p.zoom < 0) void this.loadTex(p, 2);
      else if (i < 2 && d < 20 && p.zoom < this.maxZoom) void this.loadTex(p, this.maxZoom);
    });
    // One photo at a time (no multi-photo ghosting): stay on the current capture sequence, step to
    // the next photo when it's clearly closer, and crossfade quickly over the step.
    let loaded = near.filter((n) => n.p.tex && n.d < 80);
    if (!loaded.length) loaded = near.filter((n) => n.p.tex).slice(0, 1); // before the first photo: show the nearest, never black
    if (loaded.length) {
      const cur = this.cur, curD = cur ? Math.hypot(cur.xy[0] - cx, cur.xy[1] - cy) : Infinity;
      const score = (n: { p: Pano; d: number }) => n.d + (cur?.seq && n.p.seq && n.p.seq !== cur.seq ? 6 : 0)
        + (n.p.flat ? 6 + Math.max(0, Math.abs(angDiff(pose.heading, (n.p.heading * 180) / Math.PI)) - 20) / 3 : 0);
      const best = loaded.reduce((b, n) => (score(n) < score(b) ? n : b));
      if (!cur || !cur.tex || (best.p !== cur && score(best) < curD - 1)) { this.prev = cur?.tex ? cur : null; this.cur = best.p; this.fade = this.prev ? 0 : 1; }
    }
    this.fade = Math.min(1, this.fade + dt / 0.45);
    const slots = [this.cur, this.fade < 1 ? this.prev : null].filter((p): p is Pano => !!p?.tex);
    // "No coverage" only when no photo EXISTS nearby and lookups for this spot are done -
    // a photo that is still downloading keeps Real View on (the previous one stays on screen).
    const [kx, ky] = [Math.round(cx / 7), Math.round(cy / 7)];
    const looked = this.cells.has(`${kx},${ky}`) && this.lookups === 0;
    this.covered = (near[0]?.d ?? Infinity) < 30 || !looked;
    const U = this.mat.uniforms;
    const wv = [0, 0, 0];
    slots.forEach((p, i) => {
      U[`t${i}`].value = p.tex;
      (U[`p${i}`].value as THREE.Vector2).set(p.xy[0], p.xy[1]);
      (U.hd.value as THREE.Vector3).setComponent(i, p.heading);
      (U.pj.value as THREE.Vector3).setComponent(i, p.flat ? 1 : 0);
      (U.th.value as THREE.Vector3).setComponent(i, p.flat?.tanH ?? 1);
      (U.ar.value as THREE.Vector3).setComponent(i, p.flat?.aspect ?? 1);
      wv[i] = i === 0 ? this.fade : 1 - this.fade;
    });
    const sum = wv[0] + wv[1] + wv[2] || 1;
    (U.w.value as THREE.Vector3).set(wv[0] / sum, wv[1] / sum, wv[2] / sum);
    if (slots[0]) this.credit.textContent = `${this.source === 'google' ? 'Google · ' : ''}${slots[0].copyright}${slots[0].date ? ' · ' + slots[0].date : ''}`;

    // A regular (flat) photo only shows what its camera faced: aim and zoom the view to fit it (smoothed).
    const aspect = this.el.clientWidth / Math.max(1, this.el.clientHeight);
    const baseTan = Math.tan(((aspect < 1 ? 80 : 58) * Math.PI) / 360);
    let wantOff = 0, wantTan = baseTan;
    const f = this.cur?.flat;
    if (f && this.cur) {
      const diff = angDiff(pose.heading, (this.cur.heading * 180) / Math.PI);
      wantOff = diff; // always look through the photo: a real image on screen, never stretched edges
      // walking forward past where the photo was taken = slowly zoom into it (hyperlapse feel)
      const ph = this.cur.heading, along = (cx - this.cur.xy[0]) * Math.sin(ph) + (cy - this.cur.xy[1]) * Math.cos(ph);
      const zoom = Math.max(0.9, Math.min(1.35, 1 + along / 40));
      wantTan = Math.min(baseTan, (f.tanH / f.aspect) * 0.94, (f.tanH * 0.94) / Math.max(aspect, 1e-3)) / zoom;
    }
    const k = 1 - Math.exp(-dt / 0.5);
    this.viewOff += angDiff(this.viewOff, wantOff) * k;
    this.viewTan += (wantTan - this.viewTan) * k;
    const h = ((pose.heading + this.viewOff) * Math.PI) / 180, pt = (pose.pitch * Math.PI) / 180;
    const fwd = new THREE.Vector3(Math.sin(h) * Math.cos(pt), Math.cos(h) * Math.cos(pt), Math.sin(pt));
    const right = new THREE.Vector3(Math.cos(h), -Math.sin(h), 0);
    const up = new THREE.Vector3().crossVectors(right, fwd);
    (U.cam.value as THREE.Vector3).set(cx, cy, -0.6); // eye ~1.9 m, photos are shot at ~2.5 m
    (U.fwd.value as THREE.Vector3).copy(fwd);
    (U.right.value as THREE.Vector3).copy(right);
    (U.up.value as THREE.Vector3).copy(up);
    const tanY = this.viewTan || baseTan;
    (U.tanH.value as THREE.Vector2).set(tanY * aspect, tanY);
    this.renderer.render(this.scene, this.camera);

    // free GPU memory of photos far behind
    if (this.panos.size > 40) for (const p of this.panos.values()) if (p.tex && now - p.lastUsed > 15000) { p.tex.dispose(); p.tex = null; p.zoom = -1; }
  }

  coverage() { return this.covered; }
  /** How far you may look around: 360° photos allow everything, a regular photo only its own frame. */
  lookRange() { return this.cur?.flat ? 30 : 180; }

  /** Cheap check used while on a fallback view: are real 360° photos close to `p`? */
  static async available(p: LngLat, key: string, mly: string, radius = 40): Promise<boolean> {
    if (key) return false; // Google: handled by the engine itself (needs a session)
    try {
      if (mly) {
        const dLat0 = radius / 110540, dLng0 = radius / (111320 * Math.cos((p[1] * Math.PI) / 180));
        const m = await fetch(`${MLY}?access_token=${encodeURIComponent(mly)}&fields=id,camera_type&bbox=${[p[0] - dLng0, p[1] - dLat0, p[0] + dLng0, p[1] + dLat0].map((v) => v.toFixed(6)).join(',')}&limit=5`);
        if (m.ok && ((await m.json()).data || []).some((f: { camera_type?: string }) => f.camera_type !== 'fisheye')) return true;
      }
      const dLat = radius / 110540, dLng = radius / (111320 * Math.cos((p[1] * Math.PI) / 180));
      const r = await fetch(`${PMX}/search?bbox=${[p[0] - dLng, p[1] - dLat, p[0] + dLng, p[1] + dLat].map((v) => v.toFixed(6)).join(',')}&limit=40`);
      const j = await r.json();
      return (j.features || []).some((f: { properties?: Record<string, { field_of_view?: number }> }) => f.properties?.['pers:interior_orientation']?.field_of_view === 360);
    } catch { return false; }
  }
  setQuality(level: number) {
    this.maxZoom = level >= 2 && this.renderer.capabilities.maxTextureSize >= 4096 ? 3 : 2;
    this.pixelCap = level >= 3 ? 2 : level === 2 ? 1.5 : 1;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.pixelCap));
  }
  setRoute() { /* the route is shown on the mini map; photos stay clean */ }
  ready() { return [...this.panos.values()].some((p) => p.tex); }
  destroy() {
    this.ro?.disconnect();
    for (const p of this.panos.values()) p.tex?.dispose();
    this.renderer?.dispose();
    this.renderer?.forceContextLoss();
    this.el.innerHTML = '';
  }
}

