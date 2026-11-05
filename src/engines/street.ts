import * as THREE from 'three';
import { angDiff, toENU, type LngLat } from '../geo';
import type { CameraPose, ViewEngine } from './types';

/**
 * REAL VIEW: eye-level walking through real 360° street photography (Google Street View imagery via
 * the official Map Tiles API), rendered by our own WebGL engine.
 *
 * How the motion stays smooth like a video instead of jumping between photos:
 * each pixel's view ray is cast against a simple "street canyon" proxy (ground plane + building walls
 * at a typical street half-width) around each nearby photo, and the photo is sampled where the ray
 * hits. Moving the camera between photo positions therefore produces real parallax on the road and
 * facades, and the 2–3 nearest photos are blended by distance, so you glide continuously.
 */
const API = 'https://tile.googleapis.com/v1';
const MAX_SLOTS = 3;

interface Pano {
  id: string; p: LngLat; xy: [number, number]; heading: number;
  w: number; h: number; tw: number; th: number; copyright: string; date: string;
  tex: THREE.CanvasTexture | null; zoom: number; loading: boolean; lastUsed: number;
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
uniform vec3 cam, fwd, right, up;
uniform vec2 tanH;
uniform float gnd, rad;
in vec2 vNdc;
out vec4 frag;
const float PI = 3.14159265359;
vec3 samplePano(sampler2D t, vec2 pp, float heading, vec3 dir) {
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
  float u = fract(0.5 + az / (2.0 * PI));
  float v = 0.5 - asin(clamp(d.z, -1.0, 1.0)) / PI;
  return texture(t, vec2(u, v)).rgb;
}
void main() {
  vec3 dir = normalize(fwd + vNdc.x * tanH.x * right + vNdc.y * tanH.y * up);
  vec3 col = vec3(0.0);
  float ws = 0.0;
  if (w.x > 0.001) { col += w.x * samplePano(t0, p0, hd.x, dir); ws += w.x; }
  if (w.y > 0.001) { col += w.y * samplePano(t1, p1, hd.y, dir); ws += w.y; }
  if (w.z > 0.001) { col += w.z * samplePano(t2, p2, hd.z, dir); ws += w.z; }
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

  constructor(private key: string, private wallRadius: number) {}

  private q(extra = '') { return `session=${this.session}&key=${this.key}${extra}`; }

  async init(el: HTMLElement, start: LngLat) {
    this.el = el; this.origin = start;
    const r = await fetch(`${API}/createSession?key=${this.key}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mapType: 'streetview', language: navigator.language || 'en-US', region: 'US' }),
    });
    if (!r.ok) throw new Error(`Street imagery unavailable (${r.status})`);
    this.session = (await r.json()).session;
    const first = await this.lookup([start], 60);
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
        cam: { value: new THREE.Vector3() }, fwd: { value: new THREE.Vector3() }, right: { value: new THREE.Vector3() }, up: { value: new THREE.Vector3() },
        tanH: { value: new THREE.Vector2() }, gnd: { value: 2.5 }, rad: { value: this.wallRadius },
      },
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat);
    quad.frustumCulled = false;
    this.scene.add(quad);

    this.credit = document.createElement('div');
    this.credit.className = 'sv-credit';
    el.appendChild(this.credit);

    const p = this.panos.get(first[0])!;
    await this.loadTex(p, 2);
    void this.loadTex(p, this.maxZoom);
  }

  /** Finds photo IDs near points; fetches metadata for new ones. */
  private async lookup(points: LngLat[], radius = 20): Promise<string[]> {
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

  render(pose: CameraPose) {
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
    const slots = near.filter((n) => n.p.tex && n.d < 80).slice(0, MAX_SLOTS);
    // "No coverage" only when no photo EXISTS nearby and lookups for this spot are done -
    // a photo that is still downloading keeps Real View on (the previous one stays on screen).
    const [kx, ky] = [Math.round(cx / 7), Math.round(cy / 7)];
    const looked = this.cells.has(`${kx},${ky}`) && this.lookups === 0;
    this.covered = (near[0]?.d ?? Infinity) < 30 || !looked;
    const U = this.mat.uniforms;
    const wv = [0, 0, 0];
    slots.forEach(({ p, d }, i) => {
      U[`t${i}`].value = p.tex;
      (U[`p${i}`].value as THREE.Vector2).set(p.xy[0], p.xy[1]);
      (U.hd.value as THREE.Vector3).setComponent(i, p.heading);
      wv[i] = 1 / (d * d * d + 0.05);
    });
    const sum = wv[0] + wv[1] + wv[2] || 1;
    (U.w.value as THREE.Vector3).set(wv[0] / sum, wv[1] / sum, wv[2] / sum);
    if (slots[0]) this.credit.textContent = `Google · ${slots[0].p.copyright}${slots[0].p.date ? ' · ' + slots[0].p.date : ''}`;

    const h = (pose.heading * Math.PI) / 180, pt = (pose.pitch * Math.PI) / 180;
    const fwd = new THREE.Vector3(Math.sin(h) * Math.cos(pt), Math.cos(h) * Math.cos(pt), Math.sin(pt));
    const right = new THREE.Vector3(Math.cos(h), -Math.sin(h), 0);
    const up = new THREE.Vector3().crossVectors(right, fwd);
    (U.cam.value as THREE.Vector3).set(cx, cy, -0.6); // eye ~1.9 m, photos are shot at ~2.5 m
    (U.fwd.value as THREE.Vector3).copy(fwd);
    (U.right.value as THREE.Vector3).copy(right);
    (U.up.value as THREE.Vector3).copy(up);
    const aspect = this.el.clientWidth / Math.max(1, this.el.clientHeight);
    const tanY = Math.tan(((aspect < 1 ? 80 : 58) * Math.PI) / 360);
    (U.tanH.value as THREE.Vector2).set(tanY * aspect, tanY);
    this.renderer.render(this.scene, this.camera);

    // free GPU memory of photos far behind
    if (this.panos.size > 40) for (const p of this.panos.values()) if (p.tex && now - p.lastUsed > 15000) { p.tex.dispose(); p.tex = null; p.zoom = -1; }
  }

  coverage() { return this.covered; }
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

