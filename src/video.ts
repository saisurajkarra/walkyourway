import { bearing, Line, type LngLat } from './geo';
import { WalkGraph } from './graph';
import { drawMinimap } from './extras';
import { settings, saveSettings, saveWalk, fmtSpeed, speedUnit, fmtDist, fmtTime, fmtPace, paceUnit, kcalPerSec, strideM, type Route } from './store';

/** A real filmed first-person walk of a route (YouTube embed), played at the walker's speed. */
export interface VideoWalk { routeId: string; youtubeId: string; title: string; channel: string; durationSec: number; startSec?: number; paceKmh: number }

const mods = import.meta.glob('./data/videos/*.json', { eager: true, import: 'default' }) as Record<string, VideoWalk[]>;
export const VIDEOS = new Map(Object.values(mods).flat().map((v) => [v.routeId, v]));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
declare global { interface Window { YT?: Any; onYouTubeIframeAPIReady?: () => void } }
function loadYT(): Promise<Any> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  return new Promise((res, rej) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { prev?.(); res(window.YT); };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => rej(new Error('YouTube unavailable'));
    document.head.appendChild(s);
    setTimeout(() => rej(new Error('YouTube timed out')), 20000);
  });
}

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const calibKey = (v: VideoWalk) => `wyw-pace-${v.youtubeId}`;

/**
 * Kinomap-style walk: your treadmill distance decides where in the film you should be
 * (distance ÷ filmed pace), and the playback rate is steered continuously to stay there,
 * so the film always moves exactly at your speed and stops when you stop.
 */
export async function startVideoWalk(app: HTMLElement, route: Route, v: VideoWalk, onExit: () => void, onExplore: (pos: LngLat) => void) {
  app.innerHTML = `
  <main class="walk vwalk" id="walk">
    <div class="vstage"><div class="vbox"><div id="yt"></div></div></div>
    <div class="veil" id="veil"><div class="spinner"></div><div id="veil-msg">Loading the real walk…</div></div>
    <header class="hud-top">
      <button class="icon-btn" id="b-exit" aria-label="End walk">✕</button>
      <div class="title"><b>${esc(route.name)}</b><div id="status">Filmed walk · ${esc(route.place)}</div></div>
      <canvas id="mini" aria-label="Mini map"></canvas>
    </header>
    <div id="toast" class="toast"></div>
    <footer class="hud-bottom">
      <div class="stats">
        <div><b id="s-time">0:00</b><small>time</small></div>
        <div><b id="s-dist">0 m</b><small>distance</small></div>
        <div><b id="s-pace">–</b><small>pace ${paceUnit()}</small></div>
        <div><b id="s-kcal">0</b><small>kcal</small></div>
        <div class="opt"><b id="s-steps">0</b><small>steps</small></div>
      </div>
      <div class="controls">
        <button id="b-sound" class="turn" aria-label="Sound">🔇<small>Sound</small></button>
        <button id="b-minus" class="round" aria-label="Slower">−</button>
        <button id="b-play" class="play" aria-label="Start or pause">▶</button>
        <button id="b-plus" class="round" aria-label="Faster">+</button>
        <button id="b-explore" class="turn" aria-label="Explore here in 3D">🧭<small>Explore</small></button>
      </div>
      <div class="controls2">
        <span class="spd"><b id="w-speed"></b> ${speedUnit()}</span>
        <button id="b-sync" title="Video moving too fast or slow? Tap to calibrate"></button>
      </div>
    </footer>
  </main>`;

  let alive = true, playing = false, ended = false, elapsed = 0, meters = 0, kcal = 0, steps = 0;
  let calib = +(localStorage.getItem(calibKey(v)) || 1) || 1;
  let toastT = 0;
  const toast = (msg: string) => { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = window.setTimeout(() => t.classList.remove('show'), 3800); };
  const start = v.startSec ?? 0;
  const pace = () => v.paceKmh * calib; // km/h the filmer walked (user-calibrated)
  const line = new Line(route.coords);
  const emptyGraph = new WalkGraph();
  const walkEl = $('#walk');
  let lastTouch = performance.now();
  walkEl.addEventListener('pointerdown', () => { lastTouch = performance.now(); walkEl.classList.remove('immersive'); }, true);

  let player: Any = null, rate = 1, continuous: boolean | null = null, wake: { release(): Promise<void> } | null = null;
  let started = false, syncing = false, readyDone = false;
  const end = () => {
    alive = false;
    if (meters > 50) saveWalk({ date: Date.now(), name: route.name, km: meters / 1000, sec: elapsed, kcal });
    wake?.release().catch(() => {});
    try { player?.destroy(); } catch { /* ignore */ }
    removeEventListener('keydown', onKey);
  };
  const exploreHere = () => { const p = videoPos(); end(); onExplore(p); };

  try {
    const YT = await loadYT();
    await new Promise<void>((res, rej) => {
      player = new YT.Player('yt', {
        videoId: v.youtubeId, width: '100%', height: '100%',
        playerVars: { playsinline: 1, controls: 0, disablekb: 1, rel: 0, iv_load_policy: 3, fs: 0, start: Math.floor(start), mute: 1 },
        events: {
          onReady: () => { readyDone = true; res(); },
          onError: (e: { data: number }) => {
            if (!readyDone) return rej(new Error('video error ' + e.data));
            // can't play on this device/network (removed, region-blocked, embed refused): don't leave a dead screen
            toast('This film can’t play here. Switching to the 3D walk…');
            setTimeout(() => { if (alive) exploreHere(); }, 1800);
          },
          onStateChange: (e: { data: number }) => {
            if (e.data === 0) { ended = true; setPlay(false); toast(`🎉 You finished the filmed walk: ${fmtDist(meters)} in ${fmtTime(elapsed)}. Tap 🧭 to keep exploring.`); }
            // tapping the film itself pauses/plays it; keep the walk in step with it
            if (e.data === 2 && playing && !syncing) setPlay(false, true);
            if (e.data === 1 && !playing && alive && started) setPlay(true, true);
          },
        },
      });
    });
  } catch (err) {
    console.warn(err);
    end();
    toast('This filmed walk is unavailable right now. Opening the 3D walk instead.');
    setTimeout(() => onExplore(route.coords[0]), 1200);
    return;
  }
  if (!alive) return;

  function setPlay(p: boolean, fromVideo = false) {
    if (ended && p) return;
    playing = p; started ||= p;
    $('#b-play').textContent = p ? '❚❚' : '▶';
    if (p) $('#veil').classList.add('gone');
    if (!fromVideo) { syncing = true; p ? player.playVideo() : player.pauseVideo(); setTimeout(() => (syncing = false), 600); }
    if (p) (navigator as Navigator & { wakeLock?: { request(t: string): Promise<{ release(): Promise<void> }> } }).wakeLock?.request('screen').then((w) => (wake = w)).catch(() => {});
  }
  const syncSpeed = () => { $('#w-speed').textContent = fmtSpeed(settings.speedKmh); };
  const step = (d: number) => { settings.speedKmh = Math.round(Math.max(0.5, Math.min(20, settings.speedKmh + d * (settings.units === 'metric' ? 0.1 : 0.1609344))) * 10) / 10; saveSettings(); syncSpeed(); };
  syncSpeed();

  $('#veil').classList.add('ready');
  $('#veil-msg').innerHTML = `<button class="go" id="b-go">▶ Start walking</button><div class="muted">Real filmed walk by ${esc(v.channel)} · plays at your speed (${fmtSpeed(settings.speedKmh)} ${speedUnit()})</div>`;
  $('#b-go').onclick = () => setPlay(true);
  $('#b-exit').onclick = () => { if (meters < 200 || confirm(`End walk? ${fmtDist(meters)} in ${fmtTime(elapsed)}`)) { end(); onExit(); } };
  $('#b-play').onclick = () => setPlay(!playing);
  $('#b-minus').onclick = () => step(-1);
  $('#b-plus').onclick = () => step(1);
  $('#b-explore').onclick = exploreHere;
  $('#w-speed').onclick = () => {
    const x = prompt(`Speed in ${speedUnit()}`, fmtSpeed(settings.speedKmh));
    if (x && +x > 0) { settings.speedKmh = Math.max(0.5, Math.min(20, settings.units === 'metric' ? +x : +x * 1.609344)); saveSettings(); syncSpeed(); }
  };
  $('#b-sound').onclick = () => {
    if (player.isMuted()) { player.unMute(); player.setVolume(80); } else player.mute();
    setTimeout(() => {
      const muted = player.isMuted();
      $('#b-sound').firstChild!.textContent = muted ? '🔇' : '🔊';
      if (muted && playing) toast('Tap the video once to allow sound');
    }, 400);
  };
  $('#b-sync').onclick = () => {
    const x = prompt('Does the film move faster or slower than you?\nEnter the pace the filmer walked (km/h). Higher = film plays slower.', (pace()).toFixed(1));
    if (x && +x > 0.5) { calib = +x / v.paceKmh; try { localStorage.setItem(calibKey(v), String(calib)); } catch { /* ignore */ } }
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === ' ' || e.key === 'Enter') setPlay(!playing);
    else if (e.key === '+' || e.key === '=' || e.key === 'ArrowUp') step(1);
    else if (e.key === '-' || e.key === 'ArrowDown') step(-1);
    else return;
    e.preventDefault();
  };
  addEventListener('keydown', onKey);

  function videoPos(): LngLat {
    const dur = (player?.getDuration?.() || v.durationSec) - start;
    const f = Math.max(0, Math.min(1, ((player?.getCurrentTime?.() || start) - start) / Math.max(1, dur)));
    return line.pointAt(f * line.length);
  }

  // ---- speed sync: keep the film where your walked distance says it should be ----
  const syncTick = () => {
    if (!alive || !player?.getCurrentTime) return;
    const ct = player.getCurrentTime();
    const paceMps = pace() / 3.6;
    let want = 0;
    if (playing && !ended) {
      const target = start + meters / paceMps;
      const err = target - ct; // > 0: film is behind you
      if (Math.abs(err) > 25) player.seekTo(target, true);
      want = Math.max(0.25, Math.min(2, settings.speedKmh / pace() + err * 0.08));
      const avail: number[] = player.getAvailablePlaybackRates?.() || [];
      if (continuous === false && avail.length) want = avail.reduce((b, r) => (Math.abs(r - want) < Math.abs(b - want) ? r : b), 1);
      else want = Math.round(want * 20) / 20;
      if (Math.abs(want - rate) > 0.01) {
        player.setPlaybackRate(want);
        const asked = want;
        setTimeout(() => { if (continuous === null && asked % 0.25 !== 0) continuous = Math.abs(player.getPlaybackRate() - asked) < 0.01; }, 700);
        rate = want;
      }
    }
    const tooFast = settings.speedKmh > pace() * 2;
    $('#b-sync').textContent = `🎞️ ${(playing ? player.getPlaybackRate() : 0).toFixed(2)}× · filmed at ${fmtSpeed(pace())} ${speedUnit()}${tooFast ? ' · max 2×' : ''}`;
  };

  // ---- loop ----
  let lastT = performance.now(), lastHud = 0, lastSync = 0;
  const frame = (t: number) => {
    if (!alive) return;
    const dt = Math.min(0.5, (t - lastT) / 1000); lastT = t;
    // count distance only while the film is actually rolling (not while it buffers)
    const rolling = playing && player.getPlayerState?.() === 1;
    if (rolling) {
      const vms = settings.speedKmh / 3.6;
      elapsed += dt; meters += vms * dt; kcal += kcalPerSec(settings.speedKmh) * dt; steps += (vms * dt) / strideM(settings.speedKmh);
    }
    if (t - lastSync > 300) { lastSync = t; syncTick(); }
    if (t - lastHud > 300) {
      lastHud = t;
      $('#s-time').textContent = fmtTime(elapsed);
      $('#s-dist').textContent = fmtDist(meters);
      $('#s-pace').textContent = playing ? fmtPace(settings.speedKmh, false) : '–';
      $('#s-kcal').textContent = String(Math.round(kcal));
      $('#s-steps').textContent = String(Math.round(steps));
      const p = videoPos(), s = line.project(p).s;
      drawMinimap($<HTMLCanvasElement>('#mini'), emptyGraph, line, p, bearing(p, line.pointAt(s + 20)), s);
      $('#status').textContent = playing && player.getPlayerState?.() === 3 ? 'Loading video…' : `Filmed walk · ${route.place}`;
    }
    if (playing && t - lastTouch > 6000) walkEl.classList.add('immersive');
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
