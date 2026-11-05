# Adding routes (filmed walk + real path)

Every route in WalkYourWay has two parts that must describe **the same walk**:

1. **A real filmed walk**: a first-person walking video on YouTube that plays at the user's treadmill speed.
2. **A real path**: waypoints snapped to OpenStreetMap walkways by the OSM foot router. These drive the live map and the 🧭 Explore mode.

Work **video first**. Find a film that walks from A to B, then place the waypoints along that same A→B path.

## 1. Find and verify a film

```bash
python3 scripts/find-videos.py search "Chicago Magnificent Mile walking tour 4K"
python3 scripts/find-videos.py verify <youtubeId>     # must print "ok": true (retry once if flaky)
```

A good film has these properties:

- **First-person walking, filmed continuously.** It is not drone footage, a hyperlapse or timelapse, a talking-to-camera vlog, a compilation, or a drive or ride.
- **12–120 minutes long, ideally in 4K.** "walking tour", "walk", "POV", "4K", "60fps" and "binaural" in the title are good signs.
- **A title that names the start and end, or the street or area.** You need this to draw the path.
- **No invented IDs.** Every ID must pass `verify`.

## 2. Write the route spec

Use `scripts/route-specs/<group>.json`, which is a JSON array of objects like this:

```json
{ "id": "chicago-magnificent-mile", "name": "Magnificent Mile", "category": "city", "region": "USA",
  "place": "Chicago, USA", "blurb": "One vivid sentence about what you see.",
  "waypoints": [[-87.6244, 41.8885], [-87.6240, 41.8950], [-87.6237, 41.9006]] }
```

- Coordinates are **[longitude, latitude]**, in GeoJSON order.
- Use 3–8 waypoints on the actual streets the film walks: start, the landmarks in order, then the end. Get coordinates from Nominatim (no more than 1 request per second): `curl -s -A walkyourway-dev "https://nominatim.openstreetmap.org/search?q=Water+Tower+Chicago&format=json&limit=1"`
- `region` is one of: `USA`, `Europe`, `Asia`, `Americas`, `Oceania`, `Africa & Middle East`. India goes in `Asia`.
- City routes must be 1.5–12 km long. Aim for roughly the distance the film covers: about 4.5 km per hour of film.

Build and validate the routes with this command (it rate-limits itself; never run raw loops against the router):

```bash
node scripts/build-routes.mjs scripts/route-specs/<group>.json
```

Fix every `FAIL`, then re-run until the command exits 0:

- **A waypoint is too far from any path:** move it onto the street. The error message shows where it snapped.
- **The route is flagged as a detour:** add an intermediate waypoint.

If a city truly won't route, drop it from **both** files.

## 3. Write the video entry

Use `src/data/videos/<group>.json`, which is a JSON array with one entry per route:

```json
{ "routeId": "chicago-magnificent-mile", "youtubeId": "…", "title": "<from verify>", "channel": "<from verify>",
  "durationSec": 1234, "startSec": 0, "paceKmh": 4.5 }
```

`paceKmh` is 4.5 for city walks unless the title gives the distance and duration.

Every route id must appear in both files, and every id must be unique across all of `src/data/routes/*.json`.
