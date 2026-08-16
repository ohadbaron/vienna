# Austria 2026 — Family Trip Assistant

A mobile-first, fully client-side trip assistant: itinerary and accommodation on one tab,
a searchable, GPS-aware attraction bank on the other. No backend, no build step,
no dependencies to install.

```
index.html            markup + Tailwind (CDN) + styles
app.js                all logic: rendering, filters, Haversine proximity, geolocation
data.js               ALL trip content (window.TRIP_DATA) — this is the file you edit
sw.js                 service worker, so the app works with no signal
manifest.webmanifest  makes it installable to the home screen
.gitlab-ci.yml        GitLab Pages deploy
```

## Run it locally

Just open `index.html` in a browser — that works, because the data is a plain
`<script>` (`window.TRIP_DATA`) rather than a `fetch()`ed `data.json`, so there
are no CORS errors on `file://`.

Two features need a real origin, so use a server if you want to test them:

```bash
python3 -m http.server 8000     # then open http://localhost:8000
```

- **Geolocation** requires `https://` or `localhost`.
- **Service worker / offline** requires `http(s)://` (silently skipped on `file://`).

## Deploy to GitLab Pages

1. Push these files to the repo root of a GitLab project.
2. The included `.gitlab-ci.yml` copies them into `public/` on the default branch —
   that's all GitLab Pages needs.
3. Site appears at `https://<user-or-group>.gitlab.io/<project>/`
   (or under **Deploy → Pages** in the project sidebar).

Paths are all relative, so it works fine in a project subpath. Pages is served over
HTTPS, which is what geolocation and the service worker need.

## Editing the trip

Everything lives in `data.js`, grouped in the order it appears in the app:
`trip`, `flights`, `carRental`, `accommodations`, `drives` (with `stopovers`),
then the filter vocabulary (`categories`, `regions`, `priorities`) and the
`attractions` bank.

An attraction looks like this:

```js
{
  id: "na-liechtensteinklamm",          // unique
  name: "Liechtensteinklamm, St. Johann im Pongau",
  category: "nature",                   // must match a categories[].id
  region: "salzburgerland",             // must match a regions[].id
  coords: { lat: 47.3164, lng: 13.2011 },
  priority: "must",                     // must | high | optional
  duration: "1.5–2 h",
  weather: "any",                       // sun | rain | any
  travelNote: "~20 min from Altenmarkt",
  description: "…",
  tags: ["gorge", "easy hike", "photo"],
}
```

Two things worth knowing:

- **Navigation links.** Every place gets a
  `https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=…` link.
  It uses `coords` by default; add an optional `navQuery: "Name, Town, Austria"` to
  navigate by search instead — better for restaurants and apartments, where a name
  search beats a dropped pin. `coords` are still used for distance either way.
- **Weather filter.** Items marked `weather: "any"` always survive a Sun *or* Rain
  filter, since they work in both. Only `sun`-only and `rain`-only items get filtered out.

Adding a new category is just a new entry in `categories` — the filter rail,
badges and search index all pick it up automatically.

## How the two tabs behave

**Itinerary & Accommodations** — flight, car-rental and hotel cards, each with a
*Navigate here* button. Hotel cards self-update against today's date: the current
stay is outlined green and labelled "Staying here now", future stays show a
countdown, past ones dim. The Drives section holds the four segments (including
Vienna → Altenmarkt on 18.08 and Altenmarkt → Vienna on 25.08) with curated
stopovers — each with detour cost, how long to spend, why it's worth it, and its
own navigation link. Today's drive is expanded and highlighted automatically.

**Attraction Bank** — 66 places across the six categories. Free-text search matches
name, description, travel note and tags (multi-word = AND). Filters for category
(multi-select), weather, region and minimum priority, all persisted to
`localStorage` along with your last GPS fix, so reopening the app mid-trip picks up
where you left off.

**📍 Nearby** asks for your location and re-sorts everything by straight-line
Haversine distance, with a distance badge on each card. If permission is denied,
unavailable or times out, a toast explains what happened and the list falls back to
its default order — region, then priority, then name. Nothing breaks and nothing
is hidden. A cached fix older than 6 hours is discarded rather than shown as if it
were current.

## Caveats

- **The data is a sample set.** Coordinates, opening hours, prices and restaurant
  details are best-effort and should be verified before you rely on them —
  especially the Altenmarkt-area restaurants and anything with a `verify` or
  `check hours` tag. The banner at the bottom of the app says so too; delete
  `trip.dataNote` in `data.js` once you've checked it.
- Flight numbers, times, and car-rental company/reference are `TBD` placeholders.
- Distances are straight-line, not driving distance. In the Alps, a 20 km
  straight-line hop can easily be a 50-minute drive around a mountain — that's why
  each item also carries a human-written `travelNote` with real drive times.
- Tailwind comes from the Play CDN, which prints a "not for production" console
  warning. It's the right trade-off here (zero build step); the service worker
  caches it so the app still renders styled when offline. If you'd rather remove
  the warning, run the Tailwind CLI and ship a static stylesheet.
- Verified programmatically: syntax, data integrity (all category/region/priority
  refs valid, no duplicate ids, all 66 coordinate pairs inside Austria's bounding
  box), URL generation, and 20 logic assertions on the filters, proximity sort and
  fallback order. The layout itself has not been eyeballed in a real browser — open
  it on a phone before you fly.
