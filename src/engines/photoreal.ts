import { destination, smooth, type LngLat } from '../geo';
import type { CameraPose, ViewEngine } from './types';

// CesiumJS is large, so it's loaded from the CDN only when the photoreal view is used.
const BASE = 'https://cdn.jsdelivr.net/npm/cesium@1.147.0/Build/Cesium/';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
declare global { interface Window { Cesium?: Any; CESIUM_BASE_URL?: string } }

function loadCesium(): Promise<Any> {
  if (window.Cesium) return Promise.resolve(window.Cesium);
  window.CESIUM_BASE_URL = BASE;
  const css = document.createElement('link');
  css.rel = 'stylesheet'; css.href = BASE + 'Widgets/widgets.css';
  document.head.appendChild(css);
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = BASE + 'Cesium.js';
    s.onload = () => res(window.Cesium);
    s.onerror = () => rej(new Error('Could not load the 3D engine (CesiumJS)'));
    document.head.appendChild(s);
  });
}

/**
 * Google Photorealistic 3D Tiles (real photogrammetry of thousands of cities, plus textured terrain
 * worldwide) rendered with CesiumJS. Needs a Google Maps key (Map Tiles API) or a Cesium ion token.
 */
export class PhotorealEngine implements ViewEngine {
  readonly label = 'Photoreal 3D';
  private C: Any; private viewer: Any; private tileset: Any;
  private ground = NaN; private groundTarget = NaN; private sampling = false; private lastSample = 0;
  private entity: Any;

  constructor(private googleKey: string, private ionToken: string) {}

  async init(el: HTMLElement, start: LngLat) {
    const C = (this.C = await loadCesium());
    if (this.ionToken) C.Ion.defaultAccessToken = this.ionToken;
    const viewer = (this.viewer = new C.Viewer(el, {
      baseLayer: false, baseLayerPicker: false, geocoder: false, homeButton: false, sceneModePicker: false,
      navigationHelpButton: false, animation: false, timeline: false, fullscreenButton: false, infoBox: false,
      selectionIndicator: false, scene3DOnly: true, msaaSamples: 4, useBrowserRecommendedResolution: false,
      contextOptions: { webgl: { powerPreference: 'high-performance' } },
    }));
    const dpr = window.devicePixelRatio || 1;
    viewer.resolutionScale = Math.min(dpr, 2) / dpr; // crisp retina without melting older phones
    const scene = viewer.scene;
    scene.globe.show = false; // Google tiles include the ground
    scene.screenSpaceCameraController.enableInputs = false;
    scene.fog.enabled = true; scene.fog.density = 1.2e-4;
    scene.skyAtmosphere.show = true;
    scene.highDynamicRange = false;
    // Daylight at the destination: local solar noon - 1.5h today.
    const d = new Date(); d.setUTCHours(0, 0, 0, 0);
    viewer.clock.currentTime = C.JulianDate.fromDate(new Date(d.getTime() + (10.5 - start[0] / 15) * 3600e3));
    viewer.clock.shouldAnimate = false;

    this.tileset = await C.createGooglePhotorealistic3DTileset(
      this.googleKey ? { key: this.googleKey, onlyUsingWithGoogleGeocoder: true } : { onlyUsingWithGoogleGeocoder: true },
      { maximumScreenSpaceError: 10, skipLevelOfDetail: true, preloadFlightDestinations: true, cacheBytes: 384 * 1024 * 1024, maximumCacheOverflowBytes: 256 * 1024 * 1024 },
    );
    scene.primitives.add(this.tileset);
    viewer.camera.setView({ destination: C.Cartesian3.fromDegrees(start[0], start[1], 600), orientation: { heading: 0, pitch: C.Math.toRadians(-60), roll: 0 } });
  }

  render(p: CameraPose, dt: number) {
    const C = this.C;
    if (!this.viewer) return;
    const here: LngLat = [p.lng, p.lat];
    const cam = p.back > 0 ? destination(here, p.heading + 180, p.back) : here;
    const now = performance.now();
    if (!this.sampling && now - this.lastSample > 400) {
      this.sampling = true; this.lastSample = now;
      this.viewer.scene.sampleHeightMostDetailed([C.Cartographic.fromDegrees(cam[0], cam[1]), C.Cartographic.fromDegrees(here[0], here[1])])
        .then((r: Any[]) => {
          const hs = r.filter((c) => c && Number.isFinite(c.height)).map((c) => c.height);
          if (hs.length) this.groundTarget = Math.max(...hs);
        }).catch(() => {}).finally(() => { this.sampling = false; });
    }
    if (!Number.isNaN(this.groundTarget)) this.ground = Number.isNaN(this.ground) ? this.groundTarget : this.ground + (this.groundTarget - this.ground) * smooth(dt, 0.6);
    // Until the ground height is known, hover high above and drop in once it arrives.
    const alt = Number.isNaN(this.ground) ? 400 : this.ground + p.agl;
    this.viewer.camera.setView({
      destination: C.Cartesian3.fromDegrees(cam[0], cam[1], alt),
      orientation: { heading: C.Math.toRadians(p.heading), pitch: C.Math.toRadians(Number.isNaN(this.ground) ? -45 : p.pitch), roll: 0 },
    });
  }

  setRoute(coords: LngLat[]) {
    const C = this.C;
    if (this.entity) this.viewer.entities.remove(this.entity);
    this.entity = this.viewer.entities.add({
      polyline: {
        positions: C.Cartesian3.fromDegreesArray(coords.flat()), clampToGround: true, width: 6,
        material: C.Color.fromCssColorString('#38bdf8').withAlpha(0.65), classificationType: C.ClassificationType.CESIUM_3D_TILE,
      },
    });
  }

  setQuality(level: number) {
    if (!this.tileset) return;
    this.tileset.maximumScreenSpaceError = [24, 16, 10, 6][level] ?? 10;
    const dpr = window.devicePixelRatio || 1;
    this.viewer.resolutionScale = Math.min(dpr, [1, 1.25, 1.75, 2][level] ?? 1.5) / dpr;
  }

  ready() { return !!this.tileset && !Number.isNaN(this.ground) && this.tileset.tilesLoaded; }
  destroy() { try { this.viewer?.destroy(); } catch { /* ignore */ } }
}
