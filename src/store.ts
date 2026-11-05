import type { LngLat } from './geo';

export interface Route { id: string; name: string; category: 'city' | 'hike' | 'scenic'; region: string; place: string; blurb: string; distanceKm: number; coords: LngLat[] }

const mods = import.meta.glob('./data/routes/*.json', { eager: true, import: 'default' }) as Record<string, Route[]>;
const ORDER = ['cities', 'usa', 'europe', 'asia', 'world', 'scenic', 'hikes'];
const fileKey = (k: string) => k.replace(/^.*\/(.*)\.json$/, '$1');
// every route file in src/data/routes is picked up; known groups first, then any new ones
export const ROUTES: Route[] = Object.keys(mods)
  .sort((a, b) => ((ORDER.indexOf(fileKey(a)) + 1 || 99) - (ORDER.indexOf(fileKey(b)) + 1 || 99)))
  .flatMap((k) => mods[k])
  .filter((r, i, all) => all.findIndex((x) => x.id === r.id) === i);
export const REGIONS: [string, string][] = [['USA', '🇺🇸 USA'], ['Europe', '🇪🇺 Europe'], ['Asia', '🌏 Asia'], ['Americas', '🌎 Americas'], ['Oceania', '🌊 Oceania'], ['Africa & Middle East', '🌍 Africa & ME']];

export const VIEWS = [
  { name: 'Walker', icon: '🚶', agl: 1.8, pitch: -2, back: 0 },
  { name: 'Street', icon: '🏙️', agl: 8, pitch: -6, back: 0 },
  { name: 'Drone', icon: '🚁', agl: 30, pitch: -12, back: 30 },
  { name: 'Sky', icon: '🦅', agl: 120, pitch: -22, back: 120 },
];

export interface Settings {
  units: 'metric' | 'imperial';
  speedKmh: number;
  weightKg: number;
  heightCm: number;
  engine: 'auto' | 'street' | 'photoreal' | 'terrain';
  googleKey: string;
  ionToken: string;
  mapillaryToken: string;
}
export interface WalkRecord { date: number; name: string; km: number; sec: number; kcal: number }

const DEFAULTS: Settings = { units: 'metric', speedKmh: 5, weightKg: 70, heightCm: 170, engine: 'auto', googleKey: '', ionToken: '', mapillaryToken: '' };

function read<T>(k: string, d: T): T {
  try { const v = localStorage.getItem(k); return v ? { ...d, ...JSON.parse(v) } : d; } catch { return d; }
}
function write(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } }

export const settings: Settings = read('wyw-settings', DEFAULTS);
export const saveSettings = () => write('wyw-settings', settings);

export const history: WalkRecord[] = (() => { try { return JSON.parse(localStorage.getItem('wyw-history') || '[]'); } catch { return []; } })();
export const saveWalk = (r: WalkRecord) => { history.unshift(r); history.length = Math.min(history.length, 100); write('wyw-history', history); };

export const keys = () => ({
  google: settings.googleKey.trim() || (import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined) || '',
  ion: settings.ionToken.trim() || (import.meta.env.VITE_CESIUM_ION_TOKEN as string | undefined) || '',
  // Mapillary *client* token (public by design). Set the MAPILLARY_TOKEN repo secret; never use the client secret.
  mapillary: (settings.mapillaryToken || '').trim() || (import.meta.env.VITE_MAPILLARY_TOKEN as string | undefined) || '',
});
export type EngineKind = 'street' | 'photoreal' | 'terrain';
/** Engines usable with the configured keys, best first. */
export const availableEngines = (): EngineKind[] => {
  const k = keys();
  // Real View always: Google Street View with a key, otherwise free Panoramax photos (falls back if none nearby)
  return ['street', ...(k.google || k.ion ? ['photoreal' as const] : []), 'terrain'];
};
export const ENGINE_LABEL: Record<EngineKind, string> = { street: '📷 Real View', photoreal: '🌐 3D World', terrain: '🛰️ Satellite' };

// ---------- formatting ----------
const MI = 1.609344;
export const fmtSpeed = (kmh: number) => (settings.units === 'metric' ? `${kmh.toFixed(1)}` : `${(kmh / MI).toFixed(1)}`);
export const speedUnit = () => (settings.units === 'metric' ? 'km/h' : 'mph');
export const fmtDist = (m: number) => (settings.units === 'metric' ? (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2)} km`) : (m < 1609 ? `${Math.round(m * 3.28084)} ft` : `${(m / 1609.344).toFixed(2)} mi`));
export const fmtTime = (s: number) => { s = Math.floor(s); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(x).padStart(2, '0')}`; };
export const paceUnit = () => (settings.units === 'metric' ? '/km' : '/mi');
export const fmtPace = (kmh: number, unit = true) => { if (kmh < 0.5) return '–'; const per = (settings.units === 'metric' ? 60 / kmh : (60 * MI) / kmh) * 60; return fmtTime(per) + (unit ? ` ${paceUnit()}` : ''); };

/** Real satellite thumbnail (Esri World Imagery tile) for a coordinate. */
export function thumb([lng, lat]: LngLat, z = 15) {
  const n = 2 ** z, x = Math.floor(((lng + 180) / 360) * n);
  const y = Math.floor(((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * n);
  return `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
}

/** ACSM walking/running energy cost, kcal per second. */
export function kcalPerSec(kmh: number) {
  const v = (kmh * 1000) / 60;
  const vo2 = 3.5 + (kmh < 8 ? 0.1 : 0.2) * v;
  return (vo2 * settings.weightKg) / 1000 * 5 / 60;
}
export const strideM = (kmh: number) => (settings.heightCm / 100) * (kmh < 8 ? 0.415 : 0.65);
