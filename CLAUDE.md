# Vienna / Austria trip app

Static site, no build step. `index.html` loads `data.js`, `i18n.js`, `app.js` in that order.
Four tabs: itinerary, planner (`#view-plans`), journey (`#view-journey`), attraction bank.

## Don't break saved user state

Favorites, the plan and the journey live only in the browser's `localStorage` — nothing is
stored server-side, so there is no way to recover them if they're orphaned. Two rules:

- **Never change or remove an existing `id:` in `data.js`'s `attractions`.** Favorites and
  timeline entries reference those id strings, so a rename silently drops the user's star or
  journey entry. Editing any other field (name, price, text, coords, tags) is safe. New
  attractions get new ids.
- **Never bump `STORE_KEY` in `app.js`.** It is `austria26.state.v1`; changing it wipes every
  favorite, planned place and journey entry. If a stored field's shape ever has to change,
  migrate it inside `restore()` instead — there are already two such migrations to copy from
  (`status` → `statuses`, and `done` → `entries`).

Bumping `CACHE` in `sw.js` on deploy is unrelated and expected — it evicts the asset cache,
not `localStorage`.

## The timeline (`state.entries`)

One dated array is the source of truth behind both the planner and the journey. An entry is
`status: 'planned'` or `'visited'`; checking one off flips it in place, so a place is never
duplicated across the two views and editing a journey row edits the row that was planned.

- `ref` points at a `data.js` attraction; `custom` is a user-added place shaped
  `{ name, navQuery, url, coords }` **specifically so `destStr()` and every nav link treat it
  like a data.js place with no special-casing**. Exactly one of the two is set.
- **Array order is the route order** within a day. Setting a time does not resort — that
  would move rows under the user's thumb mid-tap. `sortDayByTime()` does it on request.
- `state.visitedRefs` / `state.plannedRefs` are **derived** by `reindex()` and never
  persisted. Call `reindex()` after any mutation of `entries`, then `persist()`.
- `state.done` no longer exists. Old clients' `done` arrays are read once by the migration in
  `restore()` and then never written again.

## Gotchas

- **`hidden` + a Tailwind display utility don't mix.** Preflight's `[hidden]{display:none}`
  lives in the base layer, so `class="grid"`/`flex`/`block` in the utilities layer wins and
  the element stays visible. Elements toggled via the `hidden` property carry no display
  utility. This has already caused two bugs in `index.html`.
- Google's Maps URLs API takes at most **9 waypoints** (`MAX_WAYPOINTS`), i.e. 11 stops per
  link. Per day, `routeUrl()` returns `{ url, dropped }` — surface `dropped`, never truncate a
  day silently. For the whole-trip overview in the journey, `chunkRoute()` splits the trip
  into consecutive legs that **overlap by one stop**, so the legs join end to end and nothing
  is lost; each leg is then a normal `routeUrl()` call with `dropped === 0`.
- **Two navigation rules, by origin of the place.** Places from `data.js` navigate by their
  verified `nameLatin`/`navQuery` — the name lands you on the POI, its entrance and its car
  park, rather than on a coordinate that may sit in the wrong field. Places the *user* added
  navigate by the location the user supplied: coordinates they typed, or the coordinates
  carried inside the Google Maps link they pasted. `routePoint()` decides via the `manual`
  flag, which `entryPlace()` stamps at read time rather than storing — so entries saved by
  older versions get the behaviour with no migration.
- A short `maps.app.goo.gl` link contains no coordinates and can't be expanded without a
  network round trip, so those manual places fall back to their name. That's visible, not
  silent: the sheet warns on paste and the row shows `T.entryLinkNoCoords`.
- A short `maps.app.goo.gl` link cannot be resolved without following a redirect, which the
  app can't do offline. `parseMapsLink()` returns just `{ url }` for those, which is why the
  manual-place name field is required.

## Tests

`node tests/logic-test.js` — no dependencies, no browser. It slices the real functions out of
`app.js` and runs them against the real `data.js`, so renaming a function breaks it loudly
with "anchor not found" rather than silently passing. Covers link parsing, the route URL and
its cap, the trip calendar, timeline mutations, the `restore()` migrations and the attraction
filter. Anything touching the DOM still has to be checked in a browser.

## Deploying

`.gitlab-ci.yml` copies an explicit file list into `public/` and then asserts every local
`<script src>` in `index.html` made it. When adding a file that `index.html` or `sw.js`
references, add it to that `cp` line too. `tests/` is deliberately not shipped.
