# WalkYourWay

Walk real places at your treadmill speed:

- **🎞️ Filmed walks (Kinomap-style).** All 25 routes have a real 4K first-person walking film that plays exactly at your speed, with a live map and stats. No key is needed.
- **🧭 Explore.** Leave the film anywhere and walk on freely, **choosing your own way** at every real street corner and trail fork. This uses 📷 Real View (eye-level street photos) or 🌐 3D World.

**Live app:** https://saisurajkarra.github.io/walkyourway/. On iPhone, open it in Safari, then Share → **Add to Home Screen**.

## How filmed walks stay in sync

Your treadmill distance decides where in the film you should be: distance ÷ the pace the filmer walked. Every 0.3 s the playback rate is steered to stay there, so 6 km/h on a film walked at 4.5 km/h plays at 1.33×, and stopping the treadmill stops the film. The rate is capped at 2× (YouTube's maximum). If a film feels too fast or slow, tap the 🎞️ rate chip and calibrate the filmer's pace; the app remembers it for that film. Films are official YouTube embeds and credit their creators. To add or swap films, use `python3 scripts/find-videos.py search|verify` and edit `src/data/videos/*.json`.

## How exploring works

```
your speed ──► walk engine (real OpenStreetMap streets & trails, ← ↑ → choices at every junction)
                 │  predicts the next 24 m, including which way you'll go at the next junction
                 ▼
             game-style camera: aims along that predicted path, corners rounded, damped spring
             (turns start before the corner and feel the same at any speed, no jerks)
                 │
                 ▼
  📷 Real View   eye-level 360° real photos (Street View imagery via Google Map Tiles API),
                 rendered by our own WebGL engine: each pixel's ray is cast onto a street "canyon"
                 (ground + facades) around the nearest photos and blended by distance, so you
                 glide with real parallax like a walking video, while still free to turn anywhere
  🌐 3D World    Google Photorealistic 3D Tiles (real photogrammetry) via CesiumJS, any height
  🛰️ Satellite   no-key preview: real satellite imagery on real terrain
```

Real View falls back to 3D World automatically where no street photos exist, for example deep on a trail.

- **Steer:** tap ⬅/➡ to queue the next left or right, tap a junction card to pick a street, use U-turn, or switch on 🧭 Free roam and hold ⬅/➡ to steer anywhere. Keyboard and Bluetooth remotes work too: ←/→ (or PageUp/PageDown) to turn, ↓ to U-turn, space to pause.
- **Look around 360°:** drag the screen. The view has inertia and eases back to your walking direction.
- **Immersive:** after a few seconds of walking the controls fade away. Tap anywhere to bring them back.
- **Any phone:** rendering quality adapts to the frame rate each device actually reaches, and the layout adapts from small phones up to tablets in portrait or landscape.
- **Real data along the way:** Wikipedia landmarks pop up as you pass them ("on your left"). A heading-up mini map shows the real streets around you.
- **Stats:** time, distance, pace, calories (ACSM formula using your weight) and steps (from your height). Your walk history is saved on the device.
- **Walk anywhere:** search any place and start exploring its streets.

## Routes (25)

**🏙️ Cities:** Times Square to Central Park (NYC), Louvre to the Eiffel Tower (Paris), Westminster to Tower Bridge (London), Shibuya to Omotesando (Tokyo), Ferry Building to Fisherman's Wharf (San Francisco)

**🥾 Hikes:** First to Bachalpsee, Eiger Trail, Lauterbrunnen to Mürren (Switzerland), Tre Cime di Lavaredo Loop (Dolomites), Preikestolen (Norway), Skyline Trail (Mount Rainier), Lake Agnes Tea House (Banff), Kalalau Trail Cliffs (Na Pali, Hawaii), Laguna Capri (Fitz Roy, Patagonia), Corniglia to Vernazza (Cinque Terre)

**🌅 Scenic:** Crissy Field to Golden Gate Bridge, Cliffs of Moher, Stanley Park Seawall (Vancouver), Diamond Head Summit (Honolulu), Bondi to Coogee (Sydney), Hallstatt Lakeside, Lake Bled Loop, Fira to Oia (Santorini), Arashiyama Bamboo to Togetsukyo (Kyoto), Seven Sisters Cliffs

Every route is snapped to real walkable paths by the OSM foot router (`npm run routes`, see `scripts/build-routes.mjs`). To add one, add waypoints to `scripts/route-specs/*.json` and run `npm run routes`.

## Turn on the real imagery

| Key | Unlocks |
|---|---|
| **Google Maps Platform key** with **Map Tiles API** enabled ([console](https://console.cloud.google.com/google/maps-apis)) | 📷 Real View + 🌐 3D World |
| **Cesium ion token** (free account, no card, [ion.cesium.com/tokens](https://ion.cesium.com/tokens)) | 🌐 3D World only |

You can enable it in two places:

- **For every visitor:** in the repo, go to Settings → Secrets and variables → Actions and add `GOOGLE_MAPS_API_KEY` (and/or `CESIUM_ION_TOKEN`). Then re-run the deploy workflow.
- **For one device only:** paste the key in the app under ⚙️ Settings.

Protect a public key:

- Restrict it by HTTP referrer to `https://saisurajkarra.github.io/*`.
- Limit it to the Map Tiles API.
- Set **daily quota caps** and a budget alert. Real View loads about 16 image tiles per street photo (roughly one photo every 10 m walked).

Google's attribution ("Google" + imagery copyright) is shown on screen as required.

## Publish on GitHub Pages (one time)

1. In the repo, go to Settings → General → Danger Zone → **Change visibility → Public**. Pages on a private repo needs a paid plan.
2. Settings → Pages → Build and deployment → **Deploy from a branch** → `gh-pages` / `(root)`.

Every push to `main` (or the development branch) builds the app and publishes it to `gh-pages`. This is done by `.github/workflows/deploy.yml`.

## Develop

```bash
npm install
npm run dev        # http://localhost:5173 (and your LAN IP for a phone on the same Wi-Fi)
npm run build      # type-check + production build into dist/
```

Code map: `src/walker.ts` (movement, junction decisions, 24 m path prediction), `src/graph.ts` (OSM street/trail network via Overpass), `src/engines/street.ts` (Real View renderer), `src/engines/photoreal.ts` (3D World), `src/engines/terrain.ts` (satellite preview), `src/main.ts` (UI + game camera).

## Data sources

| Data | Source | Key needed |
|---|---|---|
| Eye-level 360° street photos | Google Street View imagery (Map Tiles API) | yes |
| Photoreal 3D cities and landscapes | Google Photorealistic 3D Tiles (directly or via Cesium ion) | yes (free tier) |
| Satellite imagery | Esri World Imagery | no |
| Elevation | AWS Terrain Tiles (Mapzen) | no |
| Streets, trails, junctions, names | OpenStreetMap via Overpass API | no |
| Route snapping | FOSSGIS OSRM foot router (build time) | no |
| Landmarks | Wikipedia GeoSearch | no |
| Place search | Nominatim (OpenStreetMap) | no |

## Roadmap

- **Treadmill / heart rate over Bluetooth (FTMS):** works in Chrome on Android and desktop. iOS Safari has no Web Bluetooth.
- **Native iOS/Android app (Capacitor wrapper of this code):** adds HealthKit and Health Connect, plus an **Apple Watch** companion that streams live pace and heart rate.
- **Walk with friends:** live "ghost" walkers on the same streets, plus challenges and long multi-day journeys.
