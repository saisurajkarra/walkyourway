import './styles.css';
import { angDiff, Line, smooth, type LngLat } from './geo';
import { WalkGraph } from './graph';
import { Walker, type Junction } from './walker';
import { Landmarks, drawMinimap } from './extras';
import type { ViewEngine } from './engines/types';
import {
  ROUTES, VIEWS, settings, saveSettings, history, saveWalk, keys, photorealAvailable, thumb,
  fmtSpeed, speedUnit, fmtDist, fmtTime, fmtPace, paceUnit, kcalPerSec, strideM, type Route,
} from './store';

const app = document.getElementById('app')!;
const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const CAT = { city: { icon: '🏙️', name: 'Cities' }, hike: { icon: '🥾', name: 'Hikes' }, scenic: { icon: '🌅', name: 'Scenic' } } as const;
const clampSpeed = (v: number) => Math.round(Math.max(0.5, Math.min(20, v)) * 10) / 10;
const stepSpeed = (dir: number) => { settings.speedKmh = clampSpeed(settings.speedKmh + dir * (settings.units === 'metric' ? 0.1 : 0.1609344)); saveSettings(); };

// ======================= HOME =======================
let filter: 'all' | Route['category'] = 'all';

function home() {
  const totalKm = history.reduce((a, h) => a + h.km, 0);
  app.innerHTML = `
  <main class="home">
    <header class="top">
      <div><h1>Walk<span>Your</span>Way</h1><p class="tag">Real places · your speed · your way</p></div>
      <button class="icon-btn" id="b-set" aria-label="Settings">⚙️</button>
    </header>
    <section class="speed-card">
      <div class="lbl">Your walking speed</div>
      <div class="speed-row">
        <button class="round" id="h-minus" aria-label="Slower">−</button>
        <div class="speed-val"><b id="h-speed">${fmtSpeed(settings.speedKmh)}</b> <small>${speedUnit()}</small><div class="pace">${fmtPace(settings.speedKmh)}</div></div>
        <button class="round" id="h-plus" aria-label="Faster">+</button>
      </div>
      <div class="mode-note">${photorealAvailable() ? '✨ Photoreal 3D is on' : '🛰️ Satellite 3D mode. <a href="#" id="b-pr">Turn on photoreal 3D</a>'}</div>
    </section>
    <form class="search" id="f-search">
      <input id="q" placeholder="Walk anywhere: search a place…" autocomplete="off" enterkeyhint="search" />
      <button>Go</button>
    </form>
    <div id="results"></div>
    <nav class="chips">
      ${(['all', 'city', 'hike', 'scenic'] as const).map((c) => `<button data-f="${c}" class="${filter === c ? 'on' : ''}">${c === 'all' ? '🌍 All' : `${CAT[c].icon} ${CAT[c].name}`}</button>`).join('')}
    </nav>
    <section class="cards">
      ${ROUTES.filter((r) => filter === 'all' || r.category === filter).map((r) => `
        <button class="card" data-id="${r.id}" style="background-image:linear-gradient(180deg,rgba(0,0,0,.05),rgba(0,0,0,.78)),url('${thumb(r.coords[Math.floor(r.coords.length / 2)])}')">
          <span class="badge">${CAT[r.category].icon} ${fmtDist(r.distanceKm * 1000)} · ~${Math.round((r.distanceKm / settings.speedKmh) * 60)} min</span>
          <span class="name">${esc(r.name)}</span>
          <span class="place">${esc(r.place)}</span>
          <span class="blurb">${esc(r.blurb)}</span>
        </button>`).join('')}
    </section>
    ${history.length ? `<section class="hist"><h2>Your walks · ${fmtDist(totalKm * 1000)} total</h2>${history.slice(0, 8).map((h) => `<div class="row"><span>${esc(h.name)}</span><span>${fmtDist(h.km * 1000)} · ${fmtTime(h.sec)}</span></div>`).join('')}</section>` : ''}
    <footer>Tip: on iPhone tap Share → <b>Add to Home Screen</b> for full-screen walking.</footer>
  </main>`;
  $('#h-minus').onclick = () => { stepSpeed(-1); home(); };
  $('#h-plus').onclick = () => { stepSpeed(1); home(); };
  $('#b-set').onclick = openSettings;
  $('#b-pr')?.addEventListener('click', (e) => { e.preventDefault(); openSettings(); });
  app.querySelectorAll<HTMLButtonElement>('.chips button').forEach((b) => (b.onclick = () => { filter = b.dataset.f as typeof filter; home(); }));
  app.querySelectorAll<HTMLButtonElement>('.card').forEach((b) => (b.onclick = () => { const r = ROUTES.find((x) => x.id === b.dataset.id)!; startWalk(r.name, r.coords[0], r); }));
  $<HTMLFormElement>('#f-search').onsubmit = async (e) => {
    e.preventDefault();
    const q = $<HTMLInputElement>('#q').value.trim(), out = $('#results');
    if (!q) return;
    out.innerHTML = '<div class="muted">Searching…</div>';
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=6&q=${encodeURIComponent(q)}`);
      const list: { display_name: string; lat: string; lon: string }[] = await r.json();
      out.innerHTML = list.length ? list.map((p, i) => `<button class="result" data-i="${i}">📍 ${esc(p.display_name)}</button>`).join('') : '<div class="muted">No places found.</div>';
      out.querySelectorAll<HTMLButtonElement>('.result').forEach((b) => (b.onclick = () => { const p = list[+b.dataset.i!]; startWalk(p.display_name.split(',')[0], [+p.lon, +p.lat], null); }));
    } catch { out.innerHTML = '<div class="muted">Search is unavailable right now.</div>'; }
  };
}

function openSettings() {
  const d = document.createElement('dialog');
  d.className = 'sheet';
  d.innerHTML = `
  <form method="dialog">
    <h2>Settings</h2>
    <label>Units <select name="units"><option value="metric">km, km/h</option><option value="imperial">miles, mph</option></select></label>
    <label>Weight (kg) <input name="weightKg" type="number" min="25" max="250" inputmode="decimal"></label>
    <label>Height (cm) <input name="heightCm" type="number" min="100" max="230" inputmode="decimal"></label>
    <label>3D view <select name="engine"><option value="auto">Auto (best available)</option><option value="photoreal">Photoreal 3D (Google tiles)</option><option value="terrain">Satellite 3D (no key)</option></select></label>
    <h3>Photoreal 3D</h3>
    <p class="muted">Real 3D scans of thousands of cities and landscapes (Google Photorealistic 3D Tiles). Paste <b>one</b> of these, it stays on this device:</p>
    <label>Google Maps API key <small>(enable “Map Tiles API”)</small><input name="googleKey" autocomplete="off" spellcheck="false" placeholder="AIza…"></label>
    <label>or Cesium ion token <small>(free at cesium.com/ion)</small><input name="ionToken" autocomplete="off" spellcheck="false" placeholder="eyJ…"></label>
    <div class="row-btns"><button value="cancel" class="ghost">Cancel</button><button value="ok">Save</button></div>
  </form>`;
  document.body.appendChild(d);
  const f = d.querySelector('form')!;
  for (const [k, v] of Object.entries(settings)) { const el = f.elements.namedItem(k) as HTMLInputElement | null; if (el) el.value = String(v); }
  d.addEventListener('close', () => {
    if (d.returnValue === 'ok') {
      const val = (k: string) => (f.elements.namedItem(k) as HTMLInputElement).value;
      settings.units = val('units') as typeof settings.units;
      settings.engine = val('engine') as typeof settings.engine;
      settings.weightKg = +val('weightKg') || 70;
      settings.heightCm = +val('heightCm') || 170;
      settings.googleKey = val('googleKey').trim();
      settings.ionToken = val('ionToken').trim();
      saveSettings();
    }
    d.remove(); home();
  });
  d.showModal();
}

// ======================= WALK =======================
async function makeEngine(el: HTMLElement, start: LngLat, toast: (m: string) => void): Promise<ViewEngine> {
  const k = keys();
  if (settings.engine !== 'terrain' && (k.google || k.ion)) {
    try {
      const { PhotorealEngine } = await import('./engines/photoreal');
      const e = new PhotorealEngine(k.google, k.ion);
      await e.init(el, start);
      return e;
    } catch (err) {
      console.error(err);
      el.innerHTML = '';
      toast('Photoreal 3D unavailable (check your key). Using satellite 3D.');
    }
  }
  const { TerrainEngine } = await import('./engines/terrain');
  const e = new TerrainEngine();
  await e.init(el, start);
  return e;
}

const ARROWS: [number, string][] = [[-150, '↩'], [-60, '←'], [-20, '↖'], [20, '↑'], [60, '↗'], [150, '→'], [181, '↪']];
const arrow = (a: number) => ARROWS.find(([max]) => a < max)![1];

async function startWalk(title: string, start: LngLat, route: Route | null) {
  app.innerHTML = `
  <main class="walk">
    <div id="view"></div>
    <div id="touch"></div>
    <div class="veil" id="veil"><div class="spinner"></div><div id="veil-msg">Loading the real world…</div></div>
    <header class="hud-top">
      <button class="icon-btn" id="b-exit" aria-label="End walk">✕</button>
      <div class="title"><b>${esc(title)}</b><div id="status">Getting ready…</div></div>
      <canvas id="mini" aria-label="Mini map"></canvas>
    </header>
    <div id="toast" class="toast"></div>
    <footer class="hud-bottom">
      <div id="junction" class="junction"></div>
      <div class="stats">
        <div><b id="s-time">0:00</b><small>time</small></div>
        <div><b id="s-dist">0 m</b><small>distance</small></div>
        <div><b id="s-pace">–</b><small>pace ${paceUnit()}</small></div>
        <div><b id="s-kcal">0</b><small>kcal</small></div>
        <div><b id="s-steps">0</b><small>steps</small></div>
      </div>
      <div class="controls">
        <button id="b-left" class="turn" aria-label="Turn left at next junction">⬅<small>Left</small></button>
        <button id="b-minus" class="round" aria-label="Slower">−</button>
        <button id="b-play" class="play" aria-label="Start or pause">▶</button>
        <button id="b-plus" class="round" aria-label="Faster">+</button>
        <button id="b-right" class="turn" aria-label="Turn right at next junction">➡<small>Right</small></button>
      </div>
      <div class="controls2">
        <span class="spd"><b id="w-speed"></b> ${speedUnit()}</span>
        <button id="b-uturn">↶ U-turn</button>
        <button id="b-cam"></button>
        <button id="b-free">🧭 Free roam</button>
        <button id="b-guide" hidden>⭐ Guide me</button>
      </div>
    </footer>
  </main>`;

  let alive = true;
  let toastT = 0;
  const toast = (msg: string, url?: string) => {
    if (!msg) return;
    const t = $('#toast');
    t.innerHTML = url ? `<a href="${url}" target="_blank" rel="noopener">${esc(msg)} ›</a>` : esc(msg);
    t.classList.add('show');
    clearTimeout(toastT); toastT = window.setTimeout(() => t.classList.remove('show'), url ? 6000 : 3500);
  };

  const line = route ? new Line(route.coords) : null;
  const graph = new WalkGraph();
  const walker = new Walker(graph, line, start, route?.category === 'city' ? 600 : 1300);
  const marks = new Landmarks();
  const engine = await makeEngine($('#view'), start, toast);
  if (!alive) return engine.destroy();
  if (route) engine.setRoute(route.coords);

  let viewIdx = engine.label === 'Photoreal 3D' ? 1 : 2;
  let playing = false, started = false, elapsed = 0, meters = 0, kcal = 0, steps = 0;
  let camHeading = walker.heading, lookYaw = 0, lookPitch = 0, dragging = false, lastDrag = 0;
  let wake: { release(): Promise<void> } | null = null;

  const setCamBtn = () => { const v = VIEWS[viewIdx]; $('#b-cam').textContent = `${v.icon} ${v.name}`; };
  setCamBtn();
  const setPlay = (p: boolean) => {
    playing = p; started ||= p;
    $('#b-play').textContent = p ? '❚❚' : '▶';
    if (p) $('#veil').classList.add('gone');
    if (p) (navigator as Navigator & { wakeLock?: { request(t: string): Promise<{ release(): Promise<void> }> } }).wakeLock?.request('screen').then((w) => (wake = w)).catch(() => {});
  };
  const syncSpeed = () => { $('#w-speed').textContent = fmtSpeed(settings.speedKmh); };
  syncSpeed();

  walker.onEvent = (type, msg) => {
    if (type === 'complete') {
      toast(`🎉 ${msg} ${fmtDist(meters)} in ${fmtTime(elapsed)}. Keep exploring or tap ✕ to finish.`);
    } else toast(msg);
  };

  // ---- controls ----
  const end = () => {
    alive = false;
    if (meters > 50) saveWalk({ date: Date.now(), name: title, km: meters / 1000, sec: elapsed, kcal });
    wake?.release().catch(() => {});
    engine.destroy();
    removeEventListener('keydown', onKey);
    home();
  };
  $('#b-exit').onclick = () => { if (meters < 200 || confirm(`End walk? ${fmtDist(meters)} in ${fmtTime(elapsed)}`)) end(); };
  $('#b-play').onclick = () => setPlay(!playing);
  $('#b-minus').onclick = () => { stepSpeed(-1); syncSpeed(); };
  $('#b-plus').onclick = () => { stepSpeed(1); syncSpeed(); };
  $('#w-speed').onclick = () => {
    const v = prompt(`Speed in ${speedUnit()}`, fmtSpeed(settings.speedKmh));
    if (v && +v > 0) { settings.speedKmh = clampSpeed(settings.units === 'metric' ? +v : +v * 1.609344); saveSettings(); syncSpeed(); }
  };
  $('#b-uturn').onclick = () => walker.uTurn();
  $('#b-cam').onclick = () => { viewIdx = (viewIdx + 1) % VIEWS.length; setCamBtn(); };
  $('#b-guide').onclick = () => { walker.guideBack(); toast('⭐ Guiding you back to the route'); };
  $('#b-free').onclick = () => {
    if (walker.mode === 'free') { if (!walker.setFree(false)) toast('No path within 70 m. Keep roaming toward a street or trail.'); }
    else { walker.setFree(true); toast('🧭 Free roam: hold ⬅ / ➡ to steer'); }
  };
  const turnBtn = (side: 'left' | 'right') => {
    const b = $(`#b-${side}`);
    b.onpointerdown = (e) => {
      e.preventDefault();
      if (walker.mode === 'free') { walker.steer = side === 'left' ? -1 : 1; return; }
      if (walker.mode === 'line') { toast('Loading real streets… turns are available in a moment'); return; }
      walker.queued = walker.queued === side ? null : side;
      walker.picked = null;
      if (walker.queued) toast(`Next ${side} queued`);
    };
    b.onpointerup = b.onpointerleave = b.onpointercancel = () => { if (walker.mode === 'free') walker.steer = 0; };
  };
  turnBtn('left'); turnBtn('right');
  const onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    const k = e.key;
    if (k === 'ArrowLeft' || k === 'PageUp') { if (walker.mode === 'free') walker.heading -= 15; else walker.queued = 'left'; }
    else if (k === 'ArrowRight' || k === 'PageDown') { if (walker.mode === 'free') walker.heading += 15; else walker.queued = 'right'; }
    else if (k === 'ArrowDown' || k === 'u') walker.uTurn();
    else if (k === ' ' || k === 'Enter') setPlay(!playing);
    else if (k === '+' || k === '=' || k === 'ArrowUp') { stepSpeed(1); syncSpeed(); }
    else if (k === '-') { stepSpeed(-1); syncSpeed(); }
    else if (k === 'v') $('#b-cam').click();
    else return;
    e.preventDefault();
  };
  addEventListener('keydown', onKey);
  // Look around by dragging (doesn't change walking direction), eases back after release.
  const touch = $('#touch');
  let px = 0, py = 0;
  touch.onpointerdown = (e) => { dragging = true; px = e.clientX; py = e.clientY; touch.setPointerCapture(e.pointerId); };
  touch.onpointermove = (e) => {
    if (!dragging) return;
    lookYaw += (e.clientX - px) * -0.25; lookPitch = Math.max(-50, Math.min(25, lookPitch + (e.clientY - py) * 0.15));
    px = e.clientX; py = e.clientY; lastDrag = performance.now();
  };
  touch.onpointerup = touch.onpointercancel = () => { dragging = false; lastDrag = performance.now(); };

  // ---- HUD ----
  let lastHud = 0, lastJ = '';
  const renderJunction = (j: Junction | null) => {
    const el = $('#junction');
    const key = j ? `${j.node}|${j.options.map((o) => o.edge + (o.isAuto ? '*' : '')).join()}|${walker.picked?.edge}|${walker.queued}` : '';
    if (j) el.querySelector('.dist')?.replaceChildren(`in ${fmtDist(j.distance)}`);
    if (key === lastJ) return;
    lastJ = key;
    if (!j) { el.classList.remove('show'); return; }
    const picked = walker.picked?.node === j.node ? walker.picked.edge : null;
    const auto = walker.autopilot === 'route' ? '⭐' : '';
    el.innerHTML = `<div class="jhead">Junction <span class="dist">in ${fmtDist(j.distance)}</span></div>
      <div class="opts">${j.options.map((o) => `<button data-e="${o.edge}" class="${picked === o.edge ? 'picked' : picked == null && o.isAuto ? 'auto' : ''}"><span class="arr">${arrow(o.angle)}</span><span>${esc(o.label)}</span>${o.isAuto && auto ? `<i>${auto}</i>` : ''}</button>`).join('')}</div>`;
    el.classList.add('show');
    el.querySelectorAll<HTMLButtonElement>('button').forEach((b) => (b.onclick = () => { walker.pick(j.node, +b.dataset.e!); walker.queued = null; lastJ = ''; }));
  };
  const hud = () => {
    $('#s-time').textContent = fmtTime(elapsed);
    $('#s-dist').textContent = fmtDist(meters);
    $('#s-pace').textContent = playing ? fmtPace(settings.speedKmh, false) : '–';
    $('#s-kcal').textContent = String(Math.round(kcal));
    $('#s-steps').textContent = String(Math.round(steps));
    $('#b-left').classList.toggle('on', walker.queued === 'left');
    $('#b-right').classList.toggle('on', walker.queued === 'right');
    $('#b-free').classList.toggle('on', walker.mode === 'free');
    $('#b-guide').hidden = !(line && walker.autopilot === 'explore' && !walker.completed && walker.mode === 'graph');
    let st: string;
    if (walker.mode === 'free') st = '🧭 Free roam';
    else if (!line) st = walker.mode === 'graph' ? '🗺️ Exploring real streets' : 'Loading streets…';
    else if (walker.completed) st = '🎉 Route complete, exploring';
    else if (walker.onRoute) st = `On route · ${fmtDist(walker.progress)} / ${fmtDist(line.length)}`;
    else st = `Exploring · route ${fmtDist(walker.offRouteBy)} away`;
    if (walker.mode === 'line' && line) st += ' · loading junctions…';
    $('#status').textContent = st;
    renderJunction(walker.upcoming(60));
    drawMinimap($<HTMLCanvasElement>('#mini'), graph, line, walker.pos, camHeading, walker.progress);
    const lm = playing ? marks.tick(walker.pos, walker.heading) : null;
    if (lm) toast(`📍 ${lm.title}, ${lm.where}`, lm.url);
  };

  // ---- main loop ----
  let last = performance.now(), veilDone = false;
  const veilStart = performance.now();
  const frame = (t: number) => {
    if (!alive) return;
    const dt = Math.min(0.5, (t - last) / 1000); last = t;
    if (playing) {
      const v = settings.speedKmh / 3.6;
      walker.update(dt, v);
      elapsed += dt; meters += v * dt; kcal += kcalPerSec(settings.speedKmh) * dt; steps += (v * dt) / strideM(settings.speedKmh);
    } else walker.update(0, 0);
    camHeading = (camHeading + angDiff(camHeading, walker.heading) * smooth(dt, 0.8) + 360) % 360;
    if (!dragging && t - lastDrag > 1500) { lookYaw *= 1 - smooth(dt, 0.8); lookPitch *= 1 - smooth(dt, 0.8); }
    const v = VIEWS[viewIdx];
    engine.render({ lng: walker.pos[0], lat: walker.pos[1], heading: camHeading + lookYaw, pitch: v.pitch + lookPitch, agl: v.agl, back: v.back }, dt);
    if (!veilDone && (engine.ready() || t - veilStart > 12000)) {
      veilDone = true;
      $('#veil').classList.add('ready');
      $('#veil-msg').innerHTML = `<button class="go" id="b-go">▶ Start walking</button><div class="muted">Match your treadmill: ${fmtSpeed(settings.speedKmh)} ${speedUnit()}</div>`;
      $('#b-go').onclick = () => setPlay(true);
    }
    if (t - lastHud > 250) { lastHud = t; hud(); }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

home();
if ('serviceWorker' in navigator && import.meta.env.PROD) navigator.serviceWorker.register('./sw.js').catch(() => {});
