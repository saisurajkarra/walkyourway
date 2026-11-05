# WalkYourWay

Walk real places in 3D at your treadmill speed, and **choose your own way** at every real street corner and trail fork.

**Live app:** https://saisurajkarra.github.io/walkyourway/. On iPhone, open it in Safari, then Share → **Add to Home Screen**.

## How it works

```
your speed (km/h or mph) ──► walk engine ──► camera pose ──► 3D view
                              │  moves you along REAL OpenStreetMap streets/trails
                              │  at every junction: ← ↑ → with street names
                              │  ⭐ = the way along the suggested route (autopilot)
                              ▼
              Photoreal 3D (Google Photorealistic 3D Tiles via CesiumJS)  or
              Satellite 3D (Esri imagery on real terrain + 3D buildings, no key)
```

- **Steer:** tap ⬅/➡ to queue the next left or right, tap a junction card to pick a street, use U-turn, or switch on 🧭 Free roam and hold ⬅/➡ to steer anywhere. Keyboard and Bluetooth remotes work too: ←/→ (or PageUp/PageDown) to turn, ↓ to U-turn, space to pause.
- **Look around:** drag the screen. Your walking direction stays the same, and the view eases back when you let go.
- **Camera:** 🚶 Walker (1.8 m), 🏙️ Street (8 m), 🚁 Drone (30 m), 🦅 Sky (120 m).
- **Real data along the way:** Wikipedia landmarks pop up as you pass them ("on your left"). A heading-up mini map shows the real streets around you.
- **Stats:** time, distance, pace, calories (ACSM formula using your weight) and steps (from your height). Your walk history is saved on the device.
- **Walk anywhere:** search any place and start exploring its streets.

## Routes (25)

**🏙️ Cities:** Times Square to Central Park (NYC), Louvre to the Eiffel Tower (Paris), Westminster to Tower Bridge (London), Shibuya to Omotesando (Tokyo), Ferry Building to Fisherman's Wharf (San Francisco)

**🥾 Hikes:** First to Bachalpsee, Eiger Trail, Lauterbrunnen to Mürren (Switzerland), Tre Cime di Lavaredo Loop (Dolomites), Preikestolen (Norway), Skyline Trail (Mount Rainier), Lake Agnes Tea House (Banff), Kalalau Trail Cliffs (Na Pali, Hawaii), Laguna Capri (Fitz Roy, Patagonia), Corniglia to Vernazza (Cinque Terre)

**🌅 Scenic:** Crissy Field to Golden Gate Bridge, Cliffs of Moher, Stanley Park Seawall (Vancouver), Diamond Head Summit (Honolulu), Bondi to Coogee (Sydney), Hallstatt Lakeside, Lake Bled Loop, Fira to Oia (Santorini), Arashiyama Bamboo to Togetsukyo (Kyoto), Seven Sisters Cliffs

Every route is snapped to real walkable paths by the OSM foot router (`npm run routes`, see `scripts/build-routes.mjs`). To add one, add waypoints to `scripts/route-specs/*.json` and run `npm run routes`.

## Turn on photoreal 3D

Without a key the app uses Satellite 3D. Photoreal 3D needs **one** of these:

- **Cesium ion token** (free account, no card): https://ion.cesium.com/tokens. In the token's *Allowed URLs*, restrict it to your Pages URL.
- **Google Maps Platform key** with **Map Tiles API** enabled: https://console.cloud.google.com/google/maps-apis. Restrict it by HTTP referrer to `https://saisurajkarra.github.io/*` and set a budget alert.

You can enable it in two places:

- **For every visitor:** in the repo, go to Settings → Secrets and variables → Actions and add `CESIUM_ION_TOKEN` or `GOOGLE_MAPS_API_KEY`. Then re-run the deploy workflow.
- **For one device only:** paste the key in the app under ⚙️ Settings.

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

Code map: `src/walker.ts` (movement + junction decisions), `src/graph.ts` (OSM street/trail network via Overpass), `src/engines/` (photoreal + satellite renderers), `src/main.ts` (UI).

## Data sources

| Data | Source | Key needed |
|---|---|---|
| Photoreal 3D cities and landscapes | Google Photorealistic 3D Tiles (directly or via Cesium ion) | yes (free tier) |
| Satellite imagery | Esri World Imagery | no |
| Elevation | AWS Terrain Tiles (Mapzen) | no |
| 3D buildings (satellite mode) | OpenFreeMap / OpenMapTiles | no |
| Streets, trails, junctions, names | OpenStreetMap via Overpass API | no |
| Route snapping | FOSSGIS OSRM foot router (build time) | no |
| Landmarks | Wikipedia GeoSearch | no |
| Place search | Nominatim (OpenStreetMap) | no |

## Roadmap

- **Treadmill / heart rate over Bluetooth (FTMS):** works in Chrome on Android and desktop. iOS Safari has no Web Bluetooth.
- **Native iOS/Android app (Capacitor wrapper of this code):** adds HealthKit and Health Connect, plus an **Apple Watch** companion that streams live pace and heart rate.
- **Walk with friends:** live "ghost" walkers on the same streets, plus challenges and long multi-day journeys.
