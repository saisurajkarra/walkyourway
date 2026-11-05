import { Map as MLMap, LngLat as MLngLat, setWorkerUrl, type GeoJSONSource, type StyleSpecification } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import 'maplibre-gl/dist/maplibre-gl.css';
import { destination, smooth, type LngLat } from '../geo';
import type { CameraPose, ViewEngine } from './types';

// The bundled MapLibre can't find its worker next to itself, so point it at the copied asset.
setWorkerUrl(new URL(workerUrl, location.href).href);

/**
 * No-key engine: real satellite imagery (Esri World Imagery) draped over real elevation (AWS Terrain
 * Tiles) with OpenStreetMap 3D buildings, sky and atmospheric fog. Best for hikes and scenic walks.
 */
export class TerrainEngine implements ViewEngine {
  readonly label = 'Satellite 3D';
  private map!: MLMap;
  private ground = NaN;
  private loaded = false;

  async init(el: HTMLElement, start: LngLat) {
    const style: StyleSpecification = {
      version: 8,
      sources: {
        sat: {
          type: 'raster', tileSize: 256, maxzoom: 19,
          tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
          attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
        },
        dem: {
          type: 'raster-dem', tileSize: 256, maxzoom: 15, encoding: 'terrarium',
          tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
          attribution: 'Terrain © Mapzen, AWS Terrain Tiles',
        },
        omt: { type: 'vector', url: 'https://tiles.openfreemap.org/planet', attribution: '© OpenFreeMap © OpenMapTiles © OpenStreetMap contributors' },
        route: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
      },
      layers: [
        { id: 'sat', type: 'raster', source: 'sat', paint: { 'raster-contrast': 0.06, 'raster-saturation': 0.12, 'raster-fade-duration': 150 } },
        {
          id: 'bld', type: 'fill-extrusion', source: 'omt', 'source-layer': 'building', minzoom: 13,
          paint: {
            'fill-extrusion-color': '#d8d0c2',
            'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 8],
            'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
            'fill-extrusion-opacity': 0.9,
            'fill-extrusion-vertical-gradient': true,
          },
        },
        { id: 'route', type: 'line', source: 'route', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#38bdf8', 'line-width': 5, 'line-opacity': 0.7, 'line-blur': 1.5 } },
      ],
      terrain: { source: 'dem', exaggeration: 1 },
      sky: {
        'sky-color': '#6fa7e0', 'horizon-color': '#dceaf7', 'fog-color': '#e6eef6',
        'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.7, 'fog-ground-blend': 0.85, 'atmosphere-blend': 0.6,
      },
    };
    this.map = new MLMap({
      container: el, style, center: start, zoom: 16, pitch: 70, maxPitch: 89,
      interactive: false, attributionControl: { compact: true }, centerClampedToGround: false,
      pixelRatio: Math.min(window.devicePixelRatio || 1, 2), fadeDuration: 0,
    });
    // Wider vertical field of view on portrait phones so the horizon and sky stay in the picture.
    const fov = () => this.map.setVerticalFieldOfView(el.clientHeight > el.clientWidth ? 62 : 42);
    fov(); this.map.on('resize', fov);
    await new Promise<void>((res) => this.map.once('load', () => res()));
    el.querySelector('.maplibregl-compact-show')?.classList.remove('maplibregl-compact-show');
    this.loaded = true;
  }

  render(p: CameraPose, dt: number) {
    if (!this.loaded) return;
    const here: LngLat = [p.lng, p.lat];
    const cam = p.back > 0 ? destination(here, p.heading + 180, p.back) : here;
    const g = this.map.queryTerrainElevation(cam) ?? 0;
    this.ground = Number.isNaN(this.ground) ? g : this.ground + (g - this.ground) * smooth(dt, 0.5);
    // Aim at the point where the view ray meets the ground (kept close so MapLibre loads sharp tiles).
    const tan = Math.tan(Math.max(2, -p.pitch) * Math.PI / 180);
    const look = Math.max(30, Math.min(400, p.agl / tan));
    const target = destination(cam, p.heading, look);
    const camAlt = this.ground + p.agl;
    const opts = this.map.calculateCameraOptionsFromTo(new MLngLat(cam[0], cam[1]), camAlt, new MLngLat(target[0], target[1]), camAlt - look * tan);
    this.map.jumpTo(opts);
  }

  setRoute(coords: LngLat[]) {
    const src = this.map.getSource('route') as GeoJSONSource | undefined;
    src?.setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } });
  }

  ready() { return this.loaded && this.map.areTilesLoaded(); }
  destroy() { this.map?.remove(); }
}
