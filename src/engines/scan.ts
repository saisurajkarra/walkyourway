import * as THREE from 'three';
import { toENU, type LngLat } from '../geo';
import { scanAt, type ScanMeta } from '../scans';
import type { CameraPose, ViewEngine } from './types';

/**
 * 3D SCAN: a real street rebuilt as a dense, coloured 3D model from open photos (see scripts/scan/build_scan.py).
 * Unlike photos or video there is no fixed viewpoint: the camera can stand anywhere inside the scanned corridor and
 * look in any direction, with true parallax. Rendered by our own WebGL engine as depth-sized round splats.
 */
const VERT = /* glsl */ `
uniform float uStep, uSize, uScale;
varying vec3 vCol;
void main() {
  vec4 mv = modelViewMatrix * vec4(position * uStep, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(uSize * uScale / max(-mv.z, 0.3), 1.6, 11.0);
  vCol = color;
}`;
const FRAG = /* glsl */ `
varying vec3 vCol;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0; float r2 = dot(c, c);
  if (r2 > 1.0) discard;
  gl_FragColor = vec4(vCol * (1.0 - 0.12 * r2), 1.0);
}`;

export class ScanEngine implements ViewEngine {
  readonly label = '3D Scan';
  readonly eyeLevelOnly = true;
  private renderer!: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(70, 1, 0.1, 200);
  private mat!: THREE.ShaderMaterial;
  private geo!: THREE.BufferGeometry;
  private meta!: ScanMeta;
  private el!: HTMLElement;
  private ro?: ResizeObserver;
  private credit!: HTMLElement;
  private total = 0;
  private frac = 1;
  private pixelCap = 2;
  private height = NaN;
  private covered = true;
  private loaded = false;

  async init(el: HTMLElement, start: LngLat) {
    const meta = scanAt(start, 120);
    if (!meta) throw new Error('No 3D scan here');
    this.meta = meta; this.el = el;
    const base = `${import.meta.env.BASE_URL}scans/${meta.id}/scan.bin`;
    const r = await fetch(base);
    if (!r.ok) throw new Error('3D scan download failed');
    const buf = await r.arrayBuffer();
    const n = meta.count;
    const pos = new Int16Array(buf, 0, n * 3);
    const col = new Uint8Array(buf, n * 6, n * 3);

    const renderer = (this.renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, powerPreference: 'high-performance' }));
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.pixelCap));
    renderer.setClearColor(0x000000, 0);
    el.appendChild(renderer.domElement);
    Object.assign(renderer.domElement.style, { width: '100%', height: '100%', display: 'block' });
    el.style.background = 'linear-gradient(180deg, #5f96d0 0%, #a9c8e6 38%, #dbe7f1 50%, #7d8792 50.2%, #4d5560 100%)';
    const resize = () => { renderer.setSize(el.clientWidth, el.clientHeight, false); this.camera.aspect = el.clientWidth / Math.max(1, el.clientHeight); this.camera.fov = this.camera.aspect < 1 ? 78 : 62; this.camera.updateProjectionMatrix(); this.updateScale(); };
    this.ro = new ResizeObserver(resize); this.ro.observe(el);

    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(pos, 3, false));
    this.geo.setAttribute('color', new THREE.BufferAttribute(col, 3, true));
    this.total = n; this.geo.setDrawRange(0, n);
    this.mat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, vertexColors: true, uniforms: { uStep: { value: meta.step }, uSize: { value: 0.06 }, uScale: { value: 500 } } });
    const pts = new THREE.Points(this.geo, this.mat);
    pts.frustumCulled = false; pts.matrixAutoUpdate = false;
    pts.matrix.set(1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1); // scan frame (east, north, up) -> three.js (x, y up, -z north)
    this.scene.add(pts);
    resize();

    this.credit = document.createElement('div');
    this.credit.className = 'sv-credit';
    this.credit.textContent = `3D scan of ${meta.title} · built from Mapillary contributors' photos · ${meta.license}`;
    el.appendChild(this.credit);
    this.loaded = true;
  }

  private updateScale() {
    if (!this.mat) return;
    const h = this.renderer.domElement.height;
    this.mat.uniforms.uScale.value = h / (2 * Math.tan((this.camera.fov * Math.PI) / 360)) * (this.renderer.getPixelRatio() ? 1 : 1);
    this.mat.uniforms.uSize.value = 0.06 / Math.sqrt(this.frac);
  }

  render(pose: CameraPose, dt: number) {
    if (!this.loaded) return;
    const m = this.meta;
    const kx = Math.cos((m.ref[1] * Math.PI) / 180);
    // camera in the scan's local frame (metres east / north of its origin)
    const e = (pose.lng - m.ref[0]) * 111320 * kx - m.origin[0], n = (pose.lat - m.ref[1]) * 110540 - m.origin[1];
    // eye height from the real walked path: the nearest photo's camera height (a phone held at eye level)
    let bd = Infinity, z = 0;
    for (const q of m.path) { const [x, y] = toENU([q[0], q[1]], [pose.lng, pose.lat]); const d = x * x + y * y; if (d < bd) { bd = d; z = q[2]; } }
    this.covered = Math.sqrt(bd) < 28;
    this.height = Number.isNaN(this.height) ? z : this.height + (z - this.height) * (1 - Math.exp(-dt / 0.35));
    const h = (pose.heading * Math.PI) / 180, p = (pose.pitch * Math.PI) / 180;
    this.camera.position.set(e, this.height, -n);
    this.camera.lookAt(e + Math.sin(h) * Math.cos(p), this.height + Math.sin(p), -n - Math.cos(h) * Math.cos(p));
    this.renderer.render(this.scene, this.camera);
  }

  coverage() { return this.covered; }
  lookRange() { return 180; }
  setRoute() { /* the route is on the mini map */ }
  ready() { return this.loaded; }
  setQuality(level: number) {
    this.frac = [0.3, 0.55, 0.8, 1][level] ?? 0.8;
    this.pixelCap = level >= 3 ? 2 : level === 2 ? 1.5 : 1;
    this.geo?.setDrawRange(0, Math.floor(this.total * this.frac));
    this.renderer?.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.pixelCap));
    this.updateScale();
  }
  destroy() {
    this.ro?.disconnect();
    this.geo?.dispose(); this.mat?.dispose();
    this.renderer?.dispose(); this.renderer?.forceContextLoss();
    this.el.innerHTML = ''; this.el.style.background = '';
  }
}
