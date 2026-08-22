/* ------------------------------------------------------------------
 * Austria Family Trip — app logic
 * Vanilla JS, no build step. Reads window.TRIP_DATA from data.js and
 * window.I18N (Hebrew UI strings + tag/duration dictionaries) from i18n.js.
 * ------------------------------------------------------------------ */
(() => {
  'use strict';

  const D = window.TRIP_DATA;
  const T = window.I18N.ui;
  const TAGS = window.I18N.tags;
  const DURATIONS = window.I18N.durations;
  const $ = (sel) => document.querySelector(sel);
  const STORE_KEY = 'austria26.state.v1';
  // Shown in the footer so you can tell at a glance which build a device is
  // actually running. Bump together with CACHE in sw.js on every deploy.
  const APP_VERSION = '8';

  /** Fill {token} placeholders in a UI string, e.g. fmt('nights', {n: 3}). */
  const fmt = (key, vals = {}) =>
    T[key].replace(/\{(\w+)\}/g, (_, k) => vals[k]);

  const trTag = (tag) => TAGS[tag] || tag;
  const trDuration = (d) => DURATIONS[d] || d;

  /* ---------------- state ---------------- */
  const state = {
    tab: 'itinerary',
    query: '',
    categories: new Set(), // empty = all
    weather: 'all',        // all | sun | rain
    region: 'all',         // all | <region id>
    statuses: new Set(),   // subset of fav | planned | todo | done; empty = all.
                           // ANDed, so ⭐+○ means "favorites I haven't done yet".
    minRank: 1,
    position: null,        // { lat, lng, at } — last known GPS fix
    locating: false,
    favorites: new Set(),  // attraction ids marked ⭐

    // ---- the timeline: one dated list behind both the planner and the journey.
    // An entry is either 'planned' (intent) or 'visited' (it happened); checking
    // one off flips it in place, so nothing is ever duplicated between views.
    // Array order is the route order within a day — see moveEntry / sortDayByTime.
    entries: [],
    entrySeq: 0,           // monotonic id counter; survives deletions
    planDay: null,         // 'YYYY-MM-DD' currently shown in the planner
    routeFromHotel: true,  // day-route preview bookends with that night's hotel
    tripRouteHotels: false, // whole-trip overview includes the hotels (opt-in)

    // Derived from `entries` by reindex(), never persisted.
    visitedRefs: new Set(),
    plannedRefs: new Set(),
  };

  /** Rebuild the fast lookups the attraction bank paints from. Cheaper than
   *  scanning `entries` per card, and keeps the status filter O(1). */
  const reindex = () => {
    state.visitedRefs = new Set();
    state.plannedRefs = new Set();
    for (const e of state.entries) {
      if (!e.ref) continue;
      (e.status === 'visited' ? state.visitedRefs : state.plannedRefs).add(e.ref);
    }
  };

  // Filters survive a page reload; the GPS fix does too, so reopening the app
  // mid-trip still shows sensible distances before the new fix lands.
  const persist = () => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        tab: state.tab,
        query: state.query,
        categories: [...state.categories],
        weather: state.weather,
        region: state.region,
        statuses: [...state.statuses],
        minRank: state.minRank,
        position: state.position,
        favorites: [...state.favorites],
        entries: state.entries,
        entrySeq: state.entrySeq,
        planDay: state.planDay,
        routeFromHotel: state.routeFromHotel,
        tripRouteHotels: state.tripRouteHotels,
      }));
    } catch (_) { /* private browsing — filters just won't persist */ }
  };

  const restore = () => {
    try {
      const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
      if (raw.tab) state.tab = raw.tab;
      if (typeof raw.query === 'string') state.query = raw.query;
      if (Array.isArray(raw.categories)) state.categories = new Set(raw.categories);
      if (raw.weather) state.weather = raw.weather;
      if (raw.region) state.region = raw.region;
      if (Array.isArray(raw.statuses)) {
        state.statuses = new Set(raw.statuses);
      } else if (raw.status && raw.status !== 'all') {
        // Migrate the pre-multiselect single `status` string. Never bump
        // STORE_KEY for a shape change — that would wipe favorites too.
        state.statuses = new Set([raw.status]);
      }
      if (raw.minRank) state.minRank = Number(raw.minRank);
      // Stale fixes are worse than none — a day-old position gives wrong distances.
      if (raw.position && Date.now() - raw.position.at < 6 * 60 * 60 * 1000) {
        state.position = raw.position;
      }
      if (Array.isArray(raw.favorites)) state.favorites = new Set(raw.favorites);

      if (Array.isArray(raw.entries)) {
        // Drop anything that no longer points at a real attraction (an id could
        // have been retired from data.js) but keep every manual entry.
        state.entries = raw.entries.filter((e) => e && (e.custom || ATTR.has(e.ref)));
      } else if (Array.isArray(raw.done)) {
        // Migrate the pre-journey `done` Set. Those markers carry no time, so
        // they land with an empty date and the journey groups them under
        // "תאריך לא ידוע" with a prompt to fill it in.
        state.entries = raw.done.filter((id) => ATTR.has(id)).map((id, i) => ({
          id: `e${i + 1}`, ref: id, custom: null,
          date: '', time: '', status: 'visited', note: '',
        }));
      }
      state.entrySeq = Number(raw.entrySeq) || state.entries.length;
      if (raw.planDay) state.planDay = raw.planDay;
      if (typeof raw.routeFromHotel === 'boolean') state.routeFromHotel = raw.routeFromHotel;
      if (typeof raw.tripRouteHotels === 'boolean') state.tripRouteHotels = raw.tripRouteHotels;
    } catch (_) { /* ignore corrupt state */ }
    reindex();
  };

  /* ---------------- lookups ---------------- */
  const CAT = new Map(D.categories.map((c) => [c.id, c]));
  const REGION = new Map(D.regions.map((r) => [r.id, r]));
  const PRIO = new Map(D.priorities.map((p) => [p.id, p]));
  const ATTR = new Map(D.attractions.map((a) => [a.id, a]));

  const rankOf = (item) => PRIO.get(item.priority)?.rank ?? 0;

  /* ---------------- helpers ---------------- */
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /** Name-based destination string for every map / search link.
   *  A name beats a pin: Maps resolves it to the real POI, so you land on the
   *  place page (hours, reviews, entrance) and routing goes to the car park
   *  rather than to a point in a field. Coordinates are the last resort only.
   *  Order: navQuery (hand-tuned) -> nameLatin -> name -> address -> coords. */
  const destStr = (t) => {
    if (t.navQuery) return t.navQuery;
    // Latin names sometimes carry a gloss — "Stift Melk (Melk Abbey)" — which
    // only confuses a search box.
    const base = (t.nameLatin || '').replace(/\s*\([^)]*\)/g, '').trim()
      || t.name || t.address || '';
    if (!base) return t.coords ? `${t.coords.lat},${t.coords.lng}` : '';
    // nameLatin usually names the town but not the country; adding one keeps
    // Maps from matching a same-named place on another continent.
    return /austria|österreich|israel|, at$/i.test(base) ? base : `${base}, Austria`;
  };

  // All four open the place — the user taps "navigate" inside the app they chose.
  const gmapsUrl = (t) =>
    `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(destStr(t))}`;
  const appleUrl = (t) =>
    `https://maps.apple.com/?q=${encodeURIComponent(destStr(t))}`;
  const wazeUrl = (t) =>
    `https://waze.com/ul?q=${encodeURIComponent(destStr(t))}`;
  const googleSearchUrl = (t) =>
    `https://www.google.com/search?q=${encodeURIComponent(destStr(t))}`;

  /** Great-circle distance in km. */
  const haversine = (a, b) => {
    const R = 6371;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  };

  const fmtDist = (km) =>
    km == null ? '' : km < 1 ? fmt('distM', { n: Math.round(km * 1000) })
      : km < 10 ? fmt('distKm', { n: km.toFixed(1) })
        : fmt('distKm', { n: Math.round(km) });

  const DAY_MS = 86400000;
  const parseDate = (iso) => {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d); // local midnight, so "today" comparisons behave
  };
  const today = () => {
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), n.getDate());
  };
  const fmtDate = (iso) =>
    parseDate(iso).toLocaleDateString('he-IL', { weekday: 'short', day: 'numeric', month: 'short' });
  const daysBetween = (a, b) => Math.round((b - a) / DAY_MS);
  const isoOf = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  /** Now, rounded to the nearest half hour — times are picked and stored at
   *  30-minute granularity (see step=1800 on #sheet-time), so a prefilled or
   *  auto-stamped value has to sit on the same grid or the picker can't show it.
   *  Late evening floors instead of rolling into tomorrow and moving the date. */
  const hhmmNow = () => {
    const n = new Date();
    let h = n.getHours();
    let m = n.getMinutes() < 15 ? 0 : n.getMinutes() < 45 ? 30 : 60;
    if (m === 60) { m = 0; h += 1; }
    if (h > 23) { h = 23; m = 30; }
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  };
  /** Short label for a day chip: "ג׳ 19/8". */
  const fmtDayShort = (iso) => {
    const d = parseDate(iso);
    return `${d.toLocaleDateString('he-IL', { weekday: 'narrow' })} ${d.getDate()}/${d.getMonth() + 1}`;
  };

  /* ---------------- trip calendar ---------------- */
  /** Every date of the trip as an ISO string, inclusive of both ends. */
  const tripDays = () => {
    const out = [];
    const start = parseDate(D.trip.startDate);
    const n = daysBetween(start, parseDate(D.trip.endDate));
    for (let i = 0; i <= n; i++) out.push(isoOf(new Date(start.getTime() + i * DAY_MS)));
    return out;
  };

  /** The accommodation you sleep at on `date` — checkIn <= date < checkOut, the
   *  same window renderItinerary() uses for its "staying now" badge. */
  const hotelOn = (iso) => {
    if (!iso) return null;
    const d = parseDate(iso);
    return D.accommodations.find((h) => d >= parseDate(h.checkIn) && d < parseDate(h.checkOut)) || null;
  };

  /** The hotel you wake up in on `iso` — whichever one you slept at the night
   *  before. Differs from hotelOn() on a transfer day, which is the whole point:
   *  on 18/8 you leave Moxy in the morning and arrive at Barbarahof at night. */
  const wakeHotelOn = (iso) =>
    (iso ? hotelOn(isoOf(new Date(parseDate(iso).getTime() - DAY_MS))) : null);

  /** The two ends of a day's driving, filled in from the booked accommodation:
   *  where the morning starts and where the evening finishes. On a normal day
   *  both are the same hotel, so the route is a there-and-back. Day one has no
   *  start (you fly in) and departure day has no end (you fly out). */
  const dayBookends = (iso) => (state.routeFromHotel
    ? { start: wakeHotelOn(iso), end: hotelOn(iso) }
    : { start: null, end: null });

  /* ---------------- pasted Google Maps links ---------------- */
  /** Pull whatever we can out of what the user pasted, offline.
   *  Returns { name?, coords?, url? } — all optional, any combination.
   *
   *  Google hands out a lot of shapes and people paste them in a lot of states:
   *  with the scheme stripped, wrapped in share-sheet text, from the desktop
   *  address bar, from the mobile app. All of those are worth catching.
   *
   *  The one shape that genuinely can't be resolved is a short maps.app.goo.gl /
   *  goo.gl link: the location lives behind an HTTP redirect, and this app has to
   *  work offline in an alpine valley. Those come back as { url } with no coords,
   *  and the UI says so rather than pretending. */
  const parseMapsLink = (raw) => {
    const s = String(raw || '').trim();
    if (!s) return {};

    // Coordinates on their own — typed, or copied from a place's detail sheet.
    const NUM = String.raw`-?\d{1,3}(?:\.\d+)?`;
    const bare = s.match(new RegExp(`^(${NUM})\\s*,\\s*(${NUM})$`));
    if (bare) return { coords: { lat: Number(bare[1]), lng: Number(bare[2]) } };

    // Find the URL *inside* the text: a share sheet often produces
    // "Café Central https://maps.app.goo.gl/x", and a retyped link often loses
    // its scheme. Anchoring on ^https?:// missed both.
    const found = s.match(
      /(https?:\/\/\S+|(?:www\.)?google\.[a-z.]+\/maps\S*|maps\.app\.goo\.gl\/\S+|goo\.gl\/maps\/\S+)/i,
    );
    if (!found) return { name: s };

    const url = /^https?:\/\//i.test(found[1]) ? found[1] : `https://${found[1]}`;
    const lead = s.slice(0, found.index).trim(); // text the share sheet put in front
    const out = { url };

    const dec = (v) => {
      try { return decodeURIComponent(v.replace(/\+/g, ' ')).trim(); } catch (_) { return v.trim(); }
    };
    const coordFrom = (re) => {
      const m = url.match(re);
      return m ? { lat: Number(m[1]), lng: Number(m[2]) } : null;
    };

    // Most precise first: the pin recorded in data=, then an explicit ll/center,
    // then the viewport centre, then a q=/daddr= pair, then coordinates sitting
    // in the path.
    out.coords =
      coordFrom(new RegExp(`!3d(${NUM})!4d(${NUM})`))
      || coordFrom(new RegExp(`[?&](?:ll|sll|center)=(${NUM}),(${NUM})`, 'i'))
      || coordFrom(new RegExp(`@(${NUM}),(${NUM})`))
      || coordFrom(new RegExp(`[?&](?:q|query|destination|daddr)=(${NUM}),(${NUM})`, 'i'))
      || coordFrom(new RegExp(`/maps/(?:place/|dir/|search/)?/*(${NUM}),(${NUM})`))
      || null;
    if (!out.coords) delete out.coords;

    // Name: /maps/place/<name> is the good one; ?q=/?query= is the fallback.
    let name = '';
    const place = url.match(/\/maps\/place\/([^/@?#]+)/);
    if (place) name = dec(place[1]);
    if (!name) {
      const q = url.match(/[?&](?:q|query)=([^&]+)/);
      if (q) name = dec(q[1]);
    }
    // A coordinate pair or a place_id blob is not a name a human wants to read.
    if (new RegExp(`^${NUM}\\s*,\\s*${NUM}$`).test(name) || /^(?:place_id:|ftid=)/i.test(name)) name = '';
    if (!name && lead) name = lead;
    if (name) out.name = name;

    return out;
  };

  /** Build the { name, navQuery, url, coords } shape the rest of the app treats
   *  like a data.js place — so destStr() and every nav link work unchanged.
   *
   *  `name` and `navQuery` are deliberately allowed to differ: you might label a
   *  place "הגשר" while the link carries "Marko-Feingold-Steg, 5020 Salzburg,
   *  Austria". The label is for reading, the address is for Maps — so the link's
   *  text wins for navigation even when you typed your own name. */
  const makeCustom = (name, link) => {
    const parsed = parseMapsLink(link);
    const pin = parsed.coords ? `${parsed.coords.lat},${parsed.coords.lng}` : '';
    const typed = (name || '').trim();
    return {
      name: typed || parsed.name || pin,
      navQuery: parsed.name || typed || pin,
      // The pasted URL is the most precise thing we hold; keep it for the direct
      // "open the link I pasted" button on the row.
      url: parsed.url || '',
      coords: parsed.coords || null,
    };
  };

  /* ---------------- multi-stop day route ---------------- */
  // Google's Maps URLs API takes at most 9 waypoints between origin and
  // destination. More than that and we keep the first 9 and say so.
  const MAX_WAYPOINTS = 9;

  /** One point in a multi-stop route.
   *  A place from data.js routes by its verified name — that lands you on the POI,
   *  its entrance and its car park, rather than on a coordinate that might sit in
   *  the wrong field.
   *  A place *you* added routes by the location you gave it: the coordinates you
   *  typed, or the ones carried inside the Google Maps link you pasted. Its name
   *  is only a last resort, because a name you chose ("הקפה שלנו") may not resolve
   *  to anything — that happens with a short maps.app.goo.gl link, which can't be
   *  decoded without a network round trip. */
  const routePoint = (t) => (t?.manual && t.coords
    ? `${t.coords.lat},${t.coords.lng}`
    : destStr(t));

  /** A driving route through `stops` (each a place-shaped object destStr() knows
   *  how to read), from `start` and finishing at `end` when those are known.
   *  Returns { url, dropped } — dropped > 0 means the day didn't fit. */
  const routeUrl = (stops, start = null, end = null) => {
    const places = [...(start ? [start] : []), ...stops, ...(end ? [end] : [])];
    if (places.length < 2) return { url: '', dropped: 0 };
    // A day with no stops is only a route if it actually goes somewhere — i.e.
    // it's a transfer between two different hotels, not a loop back to the same one.
    if (!stops.length && routePoint(places[0]) === routePoint(places[places.length - 1])) {
      return { url: '', dropped: 0 };
    }

    const origin = places[0];
    const destination = places[places.length - 1];
    const middle = places.slice(1, -1);
    const dropped = Math.max(0, middle.length - MAX_WAYPOINTS);
    const kept = middle.slice(0, MAX_WAYPOINTS);

    const q = (t) => encodeURIComponent(routePoint(t));
    const params = [
      'api=1',
      'travelmode=driving',
      `origin=${q(origin)}`,
      `destination=${q(destination)}`,
    ];
    if (kept.length) params.push(`waypoints=${kept.map(q).join('|')}`);
    return { url: `https://www.google.com/maps/dir/?${params.join('&')}`, dropped };
  };

  /* ---------------- whole-trip overview route ---------------- */
  // One link holds an origin, a destination and 9 waypoints — 11 stops. A whole
  // trip is usually more than that, so the overview is split into consecutive
  // legs instead of being truncated.
  const SEGMENT_STOPS = MAX_WAYPOINTS + 2;

  /** Every visited place in the order it actually happened, across all days.
   *  With `withHotels`, each accommodation is inserted once — at the point you
   *  first slept there — rather than after every single night: repeating
   *  Barbarahof for all seven alpine nights would burn the stop budget without
   *  putting anything new on the map. */
  const tripStops = (withHotels) => {
    const visited = state.entries.filter((e) => e.status === 'visited' && e.date);
    const days = [...new Set(visited.map((e) => e.date))].sort();
    const out = [];
    const seen = new Set();
    const addHotel = (h) => {
      if (h && !seen.has(h.id)) { seen.add(h.id); out.push(h); }
    };
    for (const iso of days) {
      if (withHotels) addHotel(wakeHotelOn(iso));       // where the day started
      out.push(...byTime(visited.filter((e) => e.date === iso)).map(entryPlace));
      if (withHotels) addHotel(hotelOn(iso));           // where it ended
    }
    return out;
  };

  /** Split a long chain of stops into legs that each fit one Maps link. Legs
   *  overlap by one stop, so leg 2 starts exactly where leg 1 finished and the
   *  whole trip is covered with no gap between the links. */
  const chunkRoute = (stops) => {
    if (stops.length < 2) return [];
    const legs = [];
    for (let i = 0; i < stops.length - 1; i += SEGMENT_STOPS - 1) {
      legs.push(stops.slice(i, i + SEGMENT_STOPS));
    }
    return legs;
  };

  /* ---------------- the timeline ---------------- */
  /** What a pasted link actually gave us. Recomputed from the stored url at render
   *  time rather than saved, so entries written by any version report correctly.
   *    'coords'  — a precise pin; day routes aim straight at it
   *    'address' — no pin, but a place/address string Maps resolves well
   *    'nothing' — the link is opaque (maps.app.goo.gl); only the name is left
   *    null      — no link given at all, which is a perfectly fine choice */
  const linkQuality = (custom) => {
    if (!custom || !custom.url) return null;
    if (custom.coords) return 'coords';
    return parseMapsLink(custom.url).name ? 'address' : 'nothing';
  };

  /** The place an entry points at, in the shape destStr()/navBlock() expect —
   *  either the attraction from data.js or the user's own { name, navQuery }.
   *  `manual` is stamped here rather than stored, so entries saved by earlier
   *  versions get it too: it tells routePoint() to prefer the coordinates the
   *  user supplied over a name they invented. */
  const entryPlace = (e) =>
    (e.ref ? ATTR.get(e.ref) : (e.custom && { ...e.custom, manual: true })) || { name: '' };
  const entryName = (e) => entryPlace(e).name || '';

  /** Entries on a day, in route order. Array order is deliberate: setting a time
   *  does not silently reshuffle rows under the user's thumb — sortDayByTime()
   *  does that on request. */
  const dayEntries = (iso, status = null) =>
    state.entries.filter((e) => e.date === iso && (!status || e.status === status));

  const findEntry = (id) => state.entries.find((e) => e.id === id);

  const addEntry = ({ ref = null, custom = null, date, time = '', status = 'planned', note = '' }) => {
    const e = { id: `e${++state.entrySeq}`, ref, custom, date, time, status, note };
    state.entries.push(e);
    reindex();
    return e;
  };

  const removeEntry = (id) => {
    const i = state.entries.findIndex((e) => e.id === id);
    if (i >= 0) state.entries.splice(i, 1);
    reindex();
  };

  /** Nudge an entry one slot within its own day; the array holds every day at
   *  once, so swap against the previous/next entry *of the same date*. */
  const moveEntry = (id, dir) => {
    const e = findEntry(id);
    if (!e) return;
    const sameDay = state.entries.filter((x) => x.date === e.date);
    const at = sameDay.indexOf(e);
    const swapWith = sameDay[at + dir];
    if (!swapWith) return;
    const i = state.entries.indexOf(e);
    const j = state.entries.indexOf(swapWith);
    state.entries[i] = swapWith;
    state.entries[j] = e;
  };

  /** Order a day by clock time. Untimed rows keep their relative order and sink
   *  to the bottom — you can't route through a stop with no time slot anyway. */
  const sortDayByTime = (iso) => {
    const day = dayEntries(iso);
    const sorted = [...day].sort((a, b) => {
      if (!a.time && !b.time) return day.indexOf(a) - day.indexOf(b);
      if (!a.time) return 1;
      if (!b.time) return -1;
      return a.time.localeCompare(b.time);
    });
    // Write back into the same slots the day occupied, leaving other days alone.
    const slots = state.entries.reduce((acc, e, i) => (e.date === iso ? [...acc, i] : acc), []);
    slots.forEach((slot, k) => { state.entries[slot] = sorted[k]; });
  };

  const WEATHER_ICON = { sun: '☀️', rain: '🌧️', any: '🌤️' };  const WEATHER_TEXT = { sun: T.weatherTextSun, rain: T.weatherTextRain, any: T.weatherTextAny };

  const PRIO_STYLE = {
    must: 'bg-rose-100 text-rose-700 ring-rose-200',
    high: 'bg-amber-100 text-amber-800 ring-amber-200',
    optional: 'bg-slate-100 text-slate-600 ring-slate-200',
  };

  let toastTimer;
  const toast = (msg) => {
    $('#toast-msg').textContent = msg;
    const el = $('#toast');
    el.classList.remove('opacity-0');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('opacity-0'), 3200);
  };

  /* ---------------- shared card bits ---------------- */
  // A single navigation control: a "נווט" button that expands to the four ways
  // of opening the place — Google Maps, Apple Maps, Waze, plain Google search.
  // Used on every place across the app.
  const navOpt = (href, label) =>
    `<a href="${href}" target="_blank" rel="noopener"
        class="flex items-center justify-center gap-1 rounded-lg bg-slate-100 px-2 py-2 text-slate-700 active:scale-95 transition">${label}</a>`;

  const navBlock = (t, label = T.navigate, size = 'full') => `
    <details class="nav-menu ${size === 'full' ? 'block' : 'inline-block'}">
      <summary class="flex ${size === 'full' ? 'w-full' : ''} items-center justify-center gap-1.5 rounded-xl bg-ink px-3 py-2.5 text-sm font-semibold text-white shadow-sm active:scale-[0.98] transition">
        <span>🧭</span><span>${esc(label)}</span>
      </summary>
      <div class="mt-2 grid grid-cols-2 gap-1.5 text-[12px] font-semibold">
        ${navOpt(gmapsUrl(t), `🗺️ ${esc(T.showInGoogleMaps)}`)}
        ${navOpt(appleUrl(t), `🍎 ${esc(T.showInAppleMaps)}`)}
        ${navOpt(wazeUrl(t), `🚗 ${esc(T.showInWaze)}`)}
        ${navOpt(googleSearchUrl(t), `🔎 ${esc(T.showInGoogleSearch)}`)}
      </div>
    </details>`;

  // Favorite / Done toggle buttons. Kept as builders so a tap can repaint one
  // card in place (see paintCardState) without re-rendering the whole list.
  const favBtnHtml = (id) => {
    const on = state.favorites.has(id);
    return `<button data-fav="${id}" type="button" aria-pressed="${on}"
      class="flex-1 rounded-xl px-3 py-2 text-sm font-semibold ring-1 transition ${
        on ? 'bg-amber-100 text-amber-800 ring-amber-200' : 'bg-white text-slate-500 ring-slate-200'}">${
        on ? `⭐ ${esc(T.favOn)}` : `☆ ${esc(T.favAdd)}`}</button>`;
  };
  const doneBtnHtml = (id) => {
    const on = state.visitedRefs.has(id);
    return `<button data-done="${id}" type="button" aria-pressed="${on}"
      class="flex-1 rounded-xl px-3 py-2 text-sm font-semibold ring-1 transition ${
        on ? 'bg-emerald-100 text-emerald-700 ring-emerald-200' : 'bg-white text-slate-500 ring-slate-200'}">${
        on ? `✅ ${esc(T.doneOn)}` : `○ ${esc(T.doneAdd)}`}</button>`;
  };

  const chip = (text, cls = 'bg-slate-100 text-slate-600 ring-slate-200') =>
    `<span class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ${cls}">${text}</span>`;

  /** Website link for a place. Uses the verified `website` when present;
   *  otherwise falls back to a Google search for the place, so the button is
   *  never a dead 404 — the user still lands on hours / menu / reviews. */
  const siteLink = (t) => {
    const href = t.website || googleSearchUrl(t);
    const label = t.website ? `🌐 ${esc(T.website)}` : `🔎 ${esc(T.websiteSearch)}`;
    return `<a href="${esc(href)}" target="_blank" rel="noopener" dir="ltr"
         class="inline-flex items-center gap-1 text-xs font-semibold text-sky-700 active:opacity-70">${label} ↗</a>`;
  };

  /** Small gray subtitle showing the original Latin place name under a
   *  Hebrew heading — helps matching against road signs and Maps results. */
  const latinSub = (latin) => latin ? `<p class="text-xs text-slate-400" dir="ltr">${esc(latin)}</p>` : '';

  /* ================================================================
   *  ADD / EDIT SHEET
   *  One sheet, four jobs: plan a place, log a visit, add a manual place,
   *  edit an existing entry. Everything writes through saveSheet().
   * ================================================================ */
  // What the sheet is currently working on. `entryId` set = editing.
  let sheetCtx = null;

  const sheetEl = () => $('#sheet');

  /** @param ctx { entryId? , ref?, custom?: true, mode?: 'planned'|'visited', date?, time? } */
  function openSheet(ctx) {
    const editing = !!ctx.entryId;
    const e = editing ? findEntry(ctx.entryId) : null;
    if (editing && !e) return;

    const manual = editing ? !!e.custom : !!ctx.custom;
    sheetCtx = {
      entryId: ctx.entryId || null,
      ref: editing ? e.ref : (ctx.ref || null),
      manual,
      mode: editing ? e.status : (ctx.mode || 'planned'),
    };

    const place = editing ? entryPlace(e) : (sheetCtx.ref ? ATTR.get(sheetCtx.ref) : null);
    $('#sheet-title').textContent = editing ? T.sheetEdit
      : sheetCtx.mode === 'visited' ? T.sheetAddToJourney : T.sheetAddToPlan;
    $('#sheet-place').textContent = place ? (place.nameLatin || place.name || '') : '';
    $('#sheet-place').hidden = !place;

    // Manual fields
    $('#sheet-manual').hidden = !manual;
    $('#sheet-name').value = manual && place ? place.name || '' : '';
    $('#sheet-link').value = manual && place ? place.url || '' : '';
    $('#sheet-link-help').textContent = T.sheetLinkHelp;

    // Date: today if it falls inside the trip, otherwise day one.
    const days = tripDays();
    const nowIso = isoOf(new Date());
    const fallback = days.includes(nowIso) ? nowIso : (state.planDay || days[0]);
    $('#sheet-date').value = editing ? e.date : (ctx.date || fallback);
    $('#sheet-date').min = days[0];
    $('#sheet-date').max = days[days.length - 1];
    $('#sheet-time').value = editing ? e.time
      : (ctx.time ?? (sheetCtx.mode === 'visited' ? hhmmNow() : ''));
    $('#sheet-note').value = editing ? e.note || '' : '';

    $('#sheet-delete').hidden = !editing;
    paintSheet();

    $('#sheet-backdrop').hidden = false;
    sheetEl().hidden = false;
    document.body.style.overflow = 'hidden'; // don't scroll the page under the sheet
    if (manual) $('#sheet-name').focus();
  }

  function closeSheet() {
    sheetCtx = null;
    sheetEl().hidden = true;
    $('#sheet-backdrop').hidden = true;
    document.body.style.overflow = '';
  }

  /** Repaint the two bits of the sheet that depend on live choices: the
   *  planned/visited toggle and the day quick-pick. */
  function paintSheet() {
    if (!sheetCtx) return;
    const chosen = $('#sheet-date').value;

    $('#sheet-mode').innerHTML = [
      { id: 'planned', label: T.sheetModePlanned },
      { id: 'visited', label: T.sheetModeVisited },
    ].map((m) => `
      <button data-sheet-mode="${m.id}" type="button" aria-pressed="${m.id === sheetCtx.mode}"
        class="seg-btn flex-1 rounded-md px-2.5 py-1.5 font-medium transition ${
          m.id === sheetCtx.mode ? 'bg-white text-ink shadow-sm' : 'text-slate-500'}">${m.label}</button>`).join('');

    $('#sheet-days').innerHTML = tripDays().map((iso) => {
      const n = dayEntries(iso).length;
      const on = iso === chosen;
      return `<button data-sheet-day="${iso}" type="button"
        class="shrink-0 rounded-full border px-2.5 py-1.5 text-[11px] font-medium whitespace-nowrap transition ${
          on ? 'border-ink bg-ink text-white shadow-sm' : 'border-slate-300 bg-white text-slate-600'}">${
        esc(fmtDayShort(iso))}${n ? ` · ${n}` : ''}</button>`;
    }).join('');
  }

  function saveSheet() {
    if (!sheetCtx) return;
    const date = $('#sheet-date').value;
    const time = $('#sheet-time').value;
    const note = $('#sheet-note').value.trim();
    const status = sheetCtx.mode;

    if (!date) { toast(T.sheetNeedsDate); return; }

    let custom = null;
    if (sheetCtx.manual) {
      const name = $('#sheet-name').value.trim();
      const link = $('#sheet-link').value.trim();
      if (!name) { toast(T.sheetNeedsName); return; }
      custom = makeCustom(name, link);
    }

    const existing = sheetCtx.entryId ? findEntry(sheetCtx.entryId) : null;
    if (existing) {
      Object.assign(existing, { date, time, note, status });
      if (custom) existing.custom = custom;
      reindex();
      toast(T.entrySaved);
    } else {
      addEntry({ ref: sheetCtx.ref, custom, date, time, status, note });
      toast(fmt(status === 'visited' ? 'addedToJourney' : 'addedToPlan', { date: fmtDayShort(date) }));
    }

    // Land the user on the day they just filed something under.
    state.planDay = date;
    persist();
    closeSheet();
    renderPlanner();
    renderJourney();
    renderAttractions();
  }

  function deleteFromSheet() {
    if (!sheetCtx?.entryId) return;
    removeEntry(sheetCtx.entryId);
    persist();
    closeSheet();
    toast(T.entryRemoved);
    renderPlanner();
    renderJourney();
    renderAttractions();
  }

  /* ================================================================
   *  TAB 1 — ITINERARY & ACCOMMODATIONS
   * ================================================================ */
  function renderItinerary() {
    const t = today();

    /* --- flights --- */
    const flights = D.flights.map((f) => `
      <article class="rounded-2xl bg-white p-4 shadow-sm">
        <div class="flex items-start justify-between gap-3">
          <div>
            <p class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">${esc(f.label)} · ${esc(fmtDate(f.date))}</p>
            <div class="mt-1 flex items-center gap-2 text-lg font-bold" dir="ltr">
              <span>${esc(f.from.code)}</span>
              <span class="text-slate-300">✈</span>
              <span>${esc(f.to.code)}</span>
            </div>
            <p class="text-xs text-slate-500">${esc(f.from.city)} ← ${esc(f.to.city)}</p>
          </div>
          <div class="shrink-0 text-right">
            <p class="text-sm font-semibold tabular-nums" dir="ltr">${esc(f.departTime)} → ${esc(f.arriveTime)}</p>
            <p class="text-[11px] text-slate-500">${esc(f.flightNo)}</p>
            <p class="text-[11px] text-slate-400">${esc(f.terminal)}</p>
          </div>
        </div>
        ${f.notes ? `<p class="mt-3 rounded-xl bg-slate-50 p-2.5 text-xs leading-relaxed text-slate-600">${esc(f.notes)}</p>` : ''}
        <div class="mt-3">${navBlock(f, T.navigateAirport)}</div>
      </article>`).join('');

    /* --- car rental --- */
    const car = D.carRental;
    const carLeg = (leg, icon) => `
      <div class="rounded-2xl bg-white p-4 shadow-sm">
        <p class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">${icon} ${esc(leg.label)}</p>
        <p class="mt-1 font-semibold leading-tight">${esc(leg.place)}</p>
        <p class="text-sm text-slate-500">${esc(fmtDate(leg.date))} · <span class="font-medium tabular-nums" dir="ltr">${esc(leg.time)}</span></p>
        <p class="mt-1 text-xs text-slate-500" dir="ltr">${esc(leg.address)}</p>
        ${leg.notes ? `<p class="mt-2 rounded-xl bg-slate-50 p-2.5 text-xs leading-relaxed text-slate-600">${esc(leg.notes)}</p>` : ''}
        <div class="mt-3">${navBlock(leg, T.navigateHere)}</div>
      </div>`;

    /* --- accommodation --- */
    const hotels = D.accommodations.map((h) => {
      const inD = parseDate(h.checkIn), outD = parseDate(h.checkOut);
      const isNow = t >= inD && t < outD;
      const isPast = t >= outD;
      const n = daysBetween(t, inD);
      const badge = isNow
        ? chip(T.stayingNow, 'bg-emerald-100 text-emerald-700 ring-emerald-200')
        : isPast
          ? chip(T.checkedOut, 'bg-slate-100 text-slate-500 ring-slate-200')
          : chip(n === 1 ? T.inDaysShortOne : fmt('inDaysShort', { n }), 'bg-sky-100 text-sky-700 ring-sky-200');

      return `
        <article class="rounded-2xl bg-white p-4 shadow-sm ring-1 ${isNow ? 'ring-emerald-300' : 'ring-transparent'} ${isPast ? 'opacity-60' : ''}">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <h3 class="font-bold leading-tight">${esc(h.name)}</h3>
              <p class="text-xs text-slate-500">${esc(h.city)}</p>
            </div>
            ${badge}
          </div>
          <dl class="mt-3 grid grid-cols-2 gap-2 text-xs">
            <div class="rounded-xl bg-slate-50 p-2.5">
              <dt class="text-[10px] uppercase tracking-wide text-slate-400">${T.checkIn}</dt>
              <dd class="font-semibold">${esc(fmtDate(h.checkIn))}</dd>
              <dd class="text-slate-500 tabular-nums">${T.fromTime} ${esc(h.checkInTime)}</dd>
            </div>
            <div class="rounded-xl bg-slate-50 p-2.5">
              <dt class="text-[10px] uppercase tracking-wide text-slate-400">${T.checkOut}</dt>
              <dd class="font-semibold">${esc(fmtDate(h.checkOut))}</dd>
              <dd class="text-slate-500 tabular-nums">${T.byTime} ${esc(h.checkOutTime)}</dd>
            </div>
          </dl>
          <p class="mt-2 text-xs text-slate-500" dir="ltr">📍 ${esc(h.address)}</p>
          <p class="text-xs text-slate-500">🌙 ${h.nights === 1 ? T.nightsOne : fmt('nights', { n: h.nights })}</p>
          ${h.notes ? `<p class="mt-2 rounded-xl bg-amber-50 p-2.5 text-xs leading-relaxed text-amber-900">${esc(h.notes)}</p>` : ''}
          <div class="mt-3 space-y-2">
            <div>${siteLink(h)}</div>
            ${navBlock(h, T.navigateHere)}
            ${h.phone ? `<a href="tel:${esc(h.phone)}" class="flex w-full items-center justify-center gap-1.5 rounded-xl bg-slate-100 px-3 py-2.5 text-sm font-semibold">📞 ${esc(h.phone)}</a>` : ''}
          </div>
        </article>`;
    }).join('');

    /* --- drive segments + stopovers --- */
    const drives = D.drives.map((d) => {
      const isToday = daysBetween(t, parseDate(d.date)) === 0;
      const stops = d.stopovers.map((s) => `
        <li class="rounded-xl border border-slate-200 p-3">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <p class="font-semibold text-sm leading-tight">${esc(s.name)}</p>
              ${latinSub(s.nameLatin)}
            </div>
            <span class="shrink-0 text-[11px] text-slate-500">${esc(trDuration(s.duration))}</span>
          </div>
          <p class="mt-0.5 text-[11px] font-medium text-emerald-700">↩ ${esc(s.detour)}</p>
          <p class="mt-1.5 text-xs leading-relaxed text-slate-600">${esc(s.why)}</p>
          <div class="mt-2">${navBlock(s, T.navigate, 'inline')}</div>
        </li>`).join('');

      return `
        <article class="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ${isToday ? 'ring-emerald-300' : 'ring-transparent'}">
          <details ${isToday || d.stopovers.length > 3 ? 'open' : ''}>
            <summary class="flex items-start gap-3 p-4">
              <div class="min-w-0 flex-1">
                <p class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                  ${esc(fmtDate(d.date))}${isToday ? ` · ${T.today}` : ''}
                </p>
                <h3 class="font-bold leading-tight">${esc(d.title)}</h3>
                ${latinSub(d.titleLatin)}
                <p class="mt-0.5 text-xs text-slate-500">🚗 ${d.distanceKm} ק״מ · ${esc(d.durationText)}</p>
              </div>
              <span class="chev shrink-0 pt-1 text-slate-400 transition-transform">▾</span>
            </summary>
            <div class="px-4 pb-4">
              <p class="rounded-xl bg-slate-50 p-2.5 text-xs leading-relaxed text-slate-600">${esc(d.summary)}</p>
              ${d.stopovers.length ? `
                <p class="mt-3 mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                  ${fmt('stopoverIdeas', { n: d.stopovers.length })}
                </p>
                <ul class="space-y-2">${stops}</ul>` : ''}
            </div>
          </details>
        </article>`;
    }).join('');

    $('#view-itinerary').innerHTML = `
      ${section(T.secFlights, flights)}
      ${section(T.secCar,
        `<div class="space-y-3">
           <p class="px-1 text-xs text-slate-500">${esc(car.company)} · ${T.carRef} ${esc(car.confirmation)} — ${esc(car.vehicleNote)}</p>
           ${carLeg(car.pickup, '🔑')}
           ${carLeg(car.dropoff, '🏁')}
         </div>`)}
      ${section(T.secStay, `<div class="space-y-3">${hotels}</div>`)}
      ${section(T.secDrives, `<div class="space-y-3">${drives}</div>`)}
    `;
  }

  const section = (title, body) => `
    <div class="fade-in">
      <h2 class="mb-2 px-1 text-sm font-bold text-slate-500">${title}</h2>
      ${body}
    </div>`;

  /* ================================================================
   *  TAB 2 — MY PLAN (per day) + the ready-made suggestion for that day
   * ================================================================ */

  /** The day the planner opens on: whatever was last used, else today if we're
   *  mid-trip, else day one. */
  function activeDay() {
    const days = tripDays();
    if (state.planDay && days.includes(state.planDay)) return state.planDay;
    const nowIso = isoOf(new Date());
    return days.includes(nowIso) ? nowIso : days[0];
  }

  /** One row of the timeline, used by both the planner and the journey. */
  function entryRow(e, { showMove }) {
    const place = entryPlace(e);
    const visited = e.status === 'visited';
    const iconBtn = (attr, label, glyph, cls = 'bg-slate-100 text-slate-500') =>
      `<button ${attr}="${e.id}" type="button" aria-label="${esc(label)}"
         class="shrink-0 rounded-lg ${cls} px-2 py-1.5 text-xs leading-none active:scale-90 transition">${glyph}</button>`;

    return `
      <li data-entry="${e.id}" class="rounded-xl border border-slate-200 bg-white p-2.5">
        <div class="flex items-start gap-2">
          <span class="shrink-0 pt-0.5 text-[11px] font-semibold tabular-nums ${
            e.time ? 'text-slate-500' : 'text-slate-300'}" dir="ltr">${esc(e.time || '--:--')}</span>
          <div class="min-w-0 flex-1">
            <p class="text-sm font-semibold leading-tight">${visited ? '📖 ' : ''}${esc(place.name || '')}</p>
            ${latinSub(place.nameLatin)}
            ${e.custom ? `<p class="text-[10px] text-slate-400">${esc(T.entryManual)}</p>` : ''}
            ${e.custom ? (() => {
              // Show what navigation will actually aim at whenever it differs from
              // the label — that's the question a pasted link raises, and seeing
              // the answer beats guessing. Warn only if the link gave us nothing.
              const q = linkQuality(e.custom);
              const target = routePoint(entryPlace(e));
              const shown = target && target !== e.custom.name
                ? `<p class="mt-1 text-[10px] text-slate-400" dir="auto">🧭 ${esc(target)}</p>` : '';
              return q === 'nothing'
                ? `<p class="mt-1 text-[10px] leading-relaxed text-amber-700">${esc(T.entryLinkNoCoords)}</p>`
                : shown;
            })() : ''}
            ${e.note ? `<p class="mt-1 rounded-lg bg-slate-50 p-2 text-xs leading-relaxed text-slate-600">${esc(e.note)}</p>` : ''}
          </div>
          <div class="flex shrink-0 items-center gap-1">
            ${showMove ? iconBtn('data-entry-up', T.entryUp, '▲') + iconBtn('data-entry-down', T.entryDown, '▼') : ''}
            ${visited
              ? iconBtn('data-entry-unvisit', T.entryUnvisit, '↩')
              : iconBtn('data-entry-visit', T.entryMarkVisited, '✓', 'bg-emerald-100 text-emerald-700')}
            ${iconBtn('data-entry-edit', T.entryEdit, '✎')}
          </div>
        </div>
        <div class="mt-2 flex flex-wrap items-center gap-1.5">
          ${place.url ? `<a href="${esc(place.url)}" target="_blank" rel="noopener"
            class="rounded-lg bg-slate-100 px-2 py-2 text-[12px] font-semibold text-slate-700 active:scale-95 transition">🔗 ${esc(T.entryOpenLink)}</a>` : ''}
          <div class="min-w-0 flex-1">${navBlock(place, place.name || T.navigate, 'inline')}</div>
        </div>
      </li>`;
  }

  /** The "see the whole day in Google Maps" control. The morning and evening
   *  hotels are filled in from the booked accommodation, so a transfer day routes
   *  Moxy → stops → Barbarahof rather than looping back to where it started. */
  function routeBlock(iso, stops) {
    const { start, end } = dayBookends(iso);
    const { url, dropped } = routeUrl(stops.map(entryPlace), start, end);
    const toggle = `
      <button data-route-hotel type="button" aria-pressed="${state.routeFromHotel}"
        class="shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium ring-1 transition ${
          state.routeFromHotel
            ? 'bg-ink text-white ring-ink'
            : 'bg-white text-slate-500 ring-slate-300'}">🏨 ${esc(T.dayRouteHotels)}</button>`;

    const ends = state.routeFromHotel && (start || end) ? `
      <div class="space-y-0.5 text-[11px] text-slate-400">
        ${start ? `<p class="truncate">${esc(fmt('dayRouteStart', { name: start.name }))}</p>` : ''}
        ${end ? `<p class="truncate">${esc(fmt('dayRouteEnd', { name: end.name }))}</p>` : ''}
      </div>` : '';

    if (!url) {
      return `
        <div class="mt-2 space-y-1.5">
          <p class="text-[11px] text-slate-400">${esc(T.dayRouteNeedsTwo)}</p>
          <div>${toggle}</div>
        </div>`;
    }
    return `
      <div class="mt-2 space-y-1.5">
        <a href="${esc(url)}" target="_blank" rel="noopener"
           class="flex w-full items-center justify-center gap-1.5 rounded-xl bg-sky-600 px-3 py-2.5 text-sm font-semibold text-white shadow-sm active:scale-[0.98] transition">
          ${esc(T.dayRoute)}
        </a>
        <div class="flex items-start gap-2">
          ${toggle}
          ${ends}
        </div>
        ${dropped ? `<p class="text-[11px] leading-relaxed text-amber-700">${esc(fmt('dayRouteCapped', { n: dropped }))}</p>` : ''}
      </div>`;
  }

  function renderPlanner() {
    const iso = activeDay();
    state.planDay = iso;
    const t = today();

    /* --- day rail --- */
    const rail = tripDays().map((d) => {
      const n = dayEntries(d).length;
      const on = d === iso;
      const isToday = daysBetween(t, parseDate(d)) === 0;
      return `<button data-plan-day="${d}" type="button"
        class="shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium whitespace-nowrap transition ${
          on ? 'border-ink bg-ink text-white shadow-sm'
            : isToday ? 'border-emerald-400 bg-white text-emerald-700'
              : 'border-slate-300 bg-white text-slate-600'}">${
        esc(fmtDayShort(d))}${n ? ` · ${n}` : ''}</button>`;
    }).join('');

    /* --- the user's own plan for the day --- */
    const planned = dayEntries(iso, 'planned');
    const visited = dayEntries(iso, 'visited');
    const hotel = hotelOn(iso);

    const rows = [...planned, ...visited];
    const body = rows.length
      ? `<ul class="space-y-2">${rows.map((e) => entryRow(e, { showMove: rows.length > 1 })).join('')}</ul>`
      : `<p class="rounded-xl bg-slate-50 p-4 text-center text-xs leading-relaxed text-slate-500">
           ${esc(T.planEmptyDay)}<br>${esc(T.goToBank)}
         </p>`;

    const myPlan = `
      <article class="rounded-2xl bg-white p-4 shadow-sm ring-1 ${
        daysBetween(t, parseDate(iso)) === 0 ? 'ring-emerald-300' : 'ring-transparent'}">
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <p class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">${esc(fmtDate(iso))}</p>
            <h3 class="font-bold leading-tight">${esc(T.myPlanTitle)}</h3>
            <p class="text-xs text-slate-500">${
              hotel ? esc(fmt('hotelForNight', { name: hotel.name })) : esc(T.noHotelForNight)}</p>
          </div>
          ${rows.length ? chip(fmt('planDayCount', { n: rows.length }), 'bg-indigo-50 text-indigo-700 ring-indigo-200') : ''}
        </div>

        ${routeBlock(iso, rows)}

        <div class="mt-3">${body}</div>

        <div class="mt-3 flex flex-wrap gap-1.5 text-xs font-semibold">
          <button data-goto-bank type="button"
            class="rounded-xl bg-slate-100 px-3 py-2 text-slate-700 active:scale-95 transition">${esc(T.addFromBank)}</button>
          <button data-add-manual="${iso}" type="button"
            class="rounded-xl bg-slate-100 px-3 py-2 text-slate-700 active:scale-95 transition">${esc(T.addManual)}</button>
          ${rows.length > 1 ? `<button data-sort-day="${iso}" type="button"
            class="rounded-xl bg-slate-100 px-3 py-2 text-slate-700 active:scale-95 transition">${esc(T.sortByTime)}</button>` : ''}
        </div>
      </article>`;

    /* --- the hand-written suggestion for the same date, collapsed underneath --- */
    const P = D.plans;
    const suggested = P?.days?.find((d) => d.date === iso);
    const suggestion = suggested ? `
      <article class="overflow-hidden rounded-2xl bg-white shadow-sm">
        <details>
          <summary class="flex items-start gap-3 p-4">
            <div class="min-w-0 flex-1">
              <p class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">${esc(T.suggestedDayTitle)}</p>
              <h3 class="font-bold leading-tight">${esc(suggested.title)}</h3>
              <p class="text-xs text-slate-500">${esc(suggested.base)}</p>
            </div>
            <span class="chev shrink-0 pt-1 text-slate-400 transition-transform">▾</span>
          </summary>
          <div class="px-4 pb-4">
            <ul class="space-y-2">
              ${suggested.steps.map((s) => {
                const linked = s.ref ? ATTR.get(s.ref) : null;
                const navTarget = linked || s.nav || null;
                const navName = linked ? linked.name : (s.nav ? s.nav.name : T.navigate);
                return `
                  <li class="flex gap-2">
                    <span class="shrink-0 w-14 pt-0.5 text-[11px] font-semibold text-slate-400 tabular-nums">${esc(s.when || '')}</span>
                    <div class="min-w-0 flex-1">
                      <p class="text-sm leading-relaxed text-slate-700">${esc(s.text)}</p>
                      ${navTarget ? `<div class="mt-1">${navBlock(navTarget, navName, 'inline')}</div>` : ''}
                    </div>
                  </li>`;
              }).join('')}
            </ul>
            ${suggested.note ? `<p class="mt-3 rounded-xl bg-amber-50 p-2.5 text-xs leading-relaxed text-amber-900">${esc(suggested.note)}</p>` : ''}
            <button data-copy-day="${iso}" type="button"
              class="mt-3 w-full rounded-xl bg-slate-100 px-3 py-2.5 text-xs font-semibold text-slate-700 active:scale-95 transition">
              ${esc(T.copySuggestion)}
            </button>
          </div>
        </details>
      </article>` : '';

    /* --- weather guidance, unchanged content, now at the bottom --- */
    const legend = P ? `
      <article class="space-y-2 rounded-2xl bg-white p-4 shadow-sm">
        <p class="text-xs font-bold text-slate-500">${esc(T.planWeatherTitle)}</p>
        <p class="text-xs leading-relaxed text-slate-600">${esc(P.intro)}</p>
        ${P.weatherLegend.map((w) => `
          <div class="flex items-start gap-2 text-xs">
            <span class="text-base leading-none">${w.icon}</span>
            <div><span class="font-semibold">${esc(w.when)}</span> — <span class="text-slate-600">${esc(w.ideas)}</span></div>
          </div>`).join('')}
      </article>` : '';

    $('#view-plans').innerHTML = `
      <div class="stick-below-hdr z-20 -mx-3 bg-slate-100/95 px-3 pt-1 pb-2 backdrop-blur">
        <div id="plan-rail" class="rail no-scrollbar flex gap-2 overflow-x-auto pb-0.5">${rail}</div>
      </div>
      <div class="fade-in space-y-3">
        ${myPlan}
        ${suggestion}
        ${legend}
      </div>`;
  }

  /* ================================================================
   *  TAB 3 — JOURNEY LOG
   * ================================================================ */
  /** Order a day chronologically for display: timed rows ascending, untimed last
   *  keeping their relative order. Display-only — it never touches the array
   *  order the planner routes by, which the user controls with ▲▼. */
  const byTime = (list) => [...list].sort((a, b) => {
    if (!a.time && !b.time) return 0;
    if (!a.time) return 1;
    if (!b.time) return -1;
    return a.time.localeCompare(b.time);
  });

  /** "See the whole trip at once" — every visited place across every day, in the
   *  order it happened. Almost always needs splitting into legs. */
  function tripRouteBlock() {
    const stops = tripStops(state.tripRouteHotels);
    const legs = chunkRoute(stops);
    const toggle = `
      <button data-trip-hotels type="button" aria-pressed="${state.tripRouteHotels}"
        class="shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium ring-1 transition ${
          state.tripRouteHotels
            ? 'bg-ink text-white ring-ink'
            : 'bg-white text-slate-500 ring-slate-300'}">🏨 ${esc(T.tripRouteHotels)}</button>`;

    const body = !legs.length
      ? `<p class="text-[11px] text-slate-400">${esc(T.tripRouteNeedsTwo)}</p>`
      : `
        <p class="text-[11px] text-slate-500">${esc(fmt('tripRouteCount', { n: stops.length }))}</p>
        ${legs.length > 1
          ? `<p class="text-[11px] leading-relaxed text-slate-400">${esc(T.tripRouteSplit)}</p>` : ''}
        <div class="space-y-1.5">
          ${legs.map((leg, i) => {
            const { url } = routeUrl(leg, null, null);
            const label = legs.length === 1
              ? T.tripRouteOne
              : fmt('tripRouteLeg', { i: i + 1, n: legs.length, count: leg.length });
            return `<a href="${esc(url)}" target="_blank" rel="noopener"
              class="flex w-full items-center justify-center gap-1.5 rounded-xl bg-violet-600 px-3 py-2.5 text-sm font-semibold text-white shadow-sm active:scale-[0.98] transition">
              ${esc(label)}</a>`;
          }).join('')}
        </div>`;

    return `
      <article class="rounded-2xl bg-white p-4 shadow-sm">
        <div class="flex items-start justify-between gap-2">
          <p class="text-xs font-bold text-slate-500">${esc(T.tripRouteTitle)}</p>
          ${toggle}
        </div>
        <div class="mt-2 space-y-1.5">${body}</div>
      </article>`;
  }

  function renderJourney() {
    const visited = state.entries.filter((e) => e.status === 'visited');
    const dated = visited.filter((e) => e.date);
    const undated = visited.filter((e) => !e.date);

    // Newest day first — the journey reads as a log you scroll back through —
    // but within a day it runs forwards, in the order the day happened.
    const byDate = [...new Set(dated.map((e) => e.date))].sort().reverse();

    const group = (title, list, iso, hint = '') => `
      <article class="rounded-2xl bg-white p-4 shadow-sm">
        <p class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">${esc(title)}</p>
        ${hint ? `<p class="mt-1 text-[11px] leading-relaxed text-amber-700">${esc(hint)}</p>` : ''}
        ${iso ? routeBlock(iso, list) : ''}
        <ul class="mt-3 space-y-2">${list.map((e) => entryRow(e, { showMove: false })).join('')}</ul>
      </article>`;

    const groups = byDate
      .map((iso) => group(fmtDate(iso), byTime(dated.filter((e) => e.date === iso)), iso))
      .join('');

    const summary = visited.length
      ? `<p class="px-1 text-xs text-slate-500">${esc(fmt('journeySummary', {
          places: visited.length, days: byDate.length + (undated.length ? 1 : 0),
        }))}</p>`
      : '';

    $('#view-journey').innerHTML = `
      <div class="fade-in space-y-3">
        <div class="flex items-center justify-between gap-2 px-1">
          <h2 class="text-sm font-bold text-slate-500">${esc(T.journeyTitle)}</h2>
          <button data-add-manual="" data-journey-add type="button"
            class="rounded-xl bg-ink px-3 py-2 text-xs font-semibold text-white shadow-sm active:scale-95 transition">
            ${esc(T.journeyAdd)}
          </button>
        </div>
        ${summary}
        ${visited.length ? tripRouteBlock() : ''}
        ${visited.length ? '' : `<p class="rounded-2xl bg-white p-8 text-center text-sm leading-relaxed text-slate-500 shadow-sm">${esc(T.journeyEmpty)}</p>`}
        ${groups}
        ${undated.length ? group(T.journeyNoDate, undated, null, T.journeyNoDateHint) : ''}
      </div>`;
  }

  /* ================================================================
   *  TAB 4 — ATTRACTION BANK
   * ================================================================ */
  function buildFilterRails() {
    // categories
    $('#cat-rail').innerHTML = D.categories.map((c) => `
      <button data-cat="${c.id}" type="button"
        class="cat-chip shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium whitespace-nowrap transition">
        ${c.icon} ${esc(c.label)}
      </button>`).join('');

    // weather segmented control
    $('#weather-rail').innerHTML = [
      { id: 'all', label: T.weatherAll },
      { id: 'sun', label: T.weatherSun },
      { id: 'rain', label: T.weatherRain },
    ].map((w) => `
      <button data-weather="${w.id}" type="button"
        class="seg-btn rounded-md px-2.5 py-1 font-medium transition">${w.label}</button>`).join('');

    // region segmented control
    $('#region-rail').innerHTML = [{ id: 'all', label: T.allAreas }, ...D.regions]
      .map((r) => `
        <button data-region="${r.id}" type="button"
          class="seg-btn rounded-md px-2.5 py-1 font-medium transition">${esc(r.label)}</button>`).join('');

    // favorite / planned / done status segmented control
    $('#status-rail').innerHTML = [
      { id: 'all', label: T.statusAll },
      { id: 'fav', label: T.statusFav },
      { id: 'planned', label: T.statusPlanned },
      { id: 'todo', label: T.statusTodo },
      { id: 'done', label: T.statusDone },
    ].map((s) => `
      <button data-status="${s.id}" type="button"
        class="seg-btn rounded-md px-2.5 py-1 font-medium transition">${s.label}</button>`).join('');
  }

  /** iOS Safari draws no clear button inside type="search", so we supply one. */
  const syncClearSearch = () => {
    $('#btn-clear-search').hidden = state.query === '';
  };

  function paintFilterState() {
    document.querySelectorAll('.cat-chip').forEach((b) => {
      const on = state.categories.has(b.dataset.cat);
      b.className = `cat-chip shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium whitespace-nowrap transition ${
        on ? 'border-ink bg-ink text-white shadow-sm' : 'border-slate-300 bg-white text-slate-600'}`;
    });
    const seg = (sel, key) => document.querySelectorAll(sel).forEach((b) => {
      const on = b.dataset[key] === state[key];
      b.className = `seg-btn rounded-md px-2.5 py-1 font-medium transition ${
        on ? 'bg-white text-ink shadow-sm' : 'text-slate-500'}`;
    });
    seg('[data-weather]', 'weather');
    seg('[data-region]', 'region');
    // Status is multi-select, so it can't use seg(): "הכול" lights up only when
    // nothing is chosen, and several pills can be lit at once.
    document.querySelectorAll('[data-status]').forEach((b) => {
      const id = b.dataset.status;
      const on = id === 'all' ? state.statuses.size === 0 : state.statuses.has(id);
      b.className = `seg-btn rounded-md px-2.5 py-1 font-medium transition ${
        on ? 'bg-white text-ink shadow-sm' : 'text-slate-500'}`;
      b.setAttribute('aria-pressed', String(on));
    });
    $('#priority').value = String(state.minRank);
    $('#search').value = state.query;
    syncClearSearch();

    // Pinned clear-categories button: visible only when a category is active,
    // so a selection scrolled off the (RTL) rail's edge is always clearable.
    const n = state.categories.size;
    const clearBtn = $('#btn-clear-cat');
    clearBtn.hidden = n === 0;
    clearBtn.textContent = n > 1 ? `${T.clearCats} (${n})` : T.clearCats;
  }

  /** Apply filters, attach distances, sort. Returns the visible list. */
  function computeList() {
    const q = state.query.trim().toLowerCase();
    const terms = q ? q.split(/\s+/) : [];

    let list = D.attractions.filter((a) => {
      if (state.categories.size && !state.categories.has(a.category)) return false;
      // 'any'-weather items always pass a sun/rain filter — they work either way.
      if (state.weather !== 'all' && a.weather !== state.weather && a.weather !== 'any') return false;
      if (state.region !== 'all' && a.region !== state.region) return false;
      // Status filters are ANDed: ⭐ + ○ means "favorites I haven't done yet".
      if (state.statuses.has('fav') && !state.favorites.has(a.id)) return false;
      if (state.statuses.has('planned') && !state.plannedRefs.has(a.id)) return false;
      if (state.statuses.has('todo') && state.visitedRefs.has(a.id)) return false;
      if (state.statuses.has('done') && !state.visitedRefs.has(a.id)) return false;
      if (rankOf(a) < state.minRank) return false;
      if (terms.length) {
        const hay = [
          a.name, a.nameLatin, a.description, a.travelNote,
          (a.tags || []).map(trTag).join(' '), (a.tags || []).join(' '),
          trDuration(a.duration),
          CAT.get(a.category)?.label, REGION.get(a.region)?.label, PRIO.get(a.priority)?.label,
        ].join(' ').toLowerCase();
        if (!terms.every((t) => hay.includes(t))) return false;
      }
      return true;
    });

    // Decorate with live distance when we have a fix.
    list = list.map((a) => ({
      item: a,
      distKm: state.position && a.coords ? haversine(state.position, a.coords) : null,
    }));

    if (state.position) {
      // Proximity sort; anything lacking coords sinks to the bottom.
      list.sort((x, y) => (x.distKm ?? Infinity) - (y.distKm ?? Infinity));
    } else {
      // Graceful fallback: region, then priority, then name.
      const regionOrder = new Map(D.regions.map((r, i) => [r.id, i]));
      list.sort((x, y) =>
        (regionOrder.get(x.item.region) ?? 99) - (regionOrder.get(y.item.region) ?? 99) ||
        rankOf(y.item) - rankOf(x.item) ||
        x.item.name.localeCompare(y.item.name));
    }
    return list;
  }

  function attractionCard({ item: a, distKm }) {
    const cat = CAT.get(a.category);
    const prio = PRIO.get(a.priority);
    const isFav = state.favorites.has(a.id);
    const isDone = state.visitedRefs.has(a.id);
    const tags = (a.tags || []).slice(0, 4)
      .map((t) => `<span class="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">${esc(trTag(t))}</span>`)
      .join('');

    return `
      <article data-id="${a.id}" class="fade-in rounded-2xl bg-white p-4 shadow-sm ring-1 ${isFav ? 'ring-amber-300' : 'ring-transparent'} ${isDone ? 'opacity-60' : ''}">
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <h3 class="font-bold leading-tight">${isFav ? '⭐ ' : ''}${esc(a.name)}</h3>
            ${latinSub(a.nameLatin)}
          </div>
          ${distKm != null
            ? `<span class="shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-bold text-emerald-800 tabular-nums">${fmtDist(distKm)}</span>`
            : ''}
        </div>

        <div class="mt-2 flex flex-wrap items-center gap-1.5">
          ${chip(`${cat?.icon ?? ''} ${esc(cat?.label ?? a.category)}`, 'bg-indigo-50 text-indigo-700 ring-indigo-200')}
          ${chip(esc(prio?.label ?? a.priority), PRIO_STYLE[a.priority] || PRIO_STYLE.optional)}
          ${chip(`${WEATHER_ICON[a.weather]} ${WEATHER_TEXT[a.weather]}`, 'bg-sky-50 text-sky-700 ring-sky-200')}
          ${chip(`⏱ ${esc(trDuration(a.duration))}`)}
          ${timelineChips(a.id)}
        </div>

        <p class="mt-2.5 text-sm leading-relaxed text-slate-600">${esc(a.description)}</p>
        ${a.travelNote ? `<p class="mt-1.5 text-xs font-medium text-slate-500">🚗 ${esc(a.travelNote)}</p>` : ''}
        ${tags ? `<div class="mt-2 flex flex-wrap gap-1">${tags}</div>` : ''}
        <div class="mt-3 space-y-2">
          <div>${siteLink(a)}</div>
          ${navBlock(a)}
          <div class="flex gap-1.5">
            ${favBtnHtml(a.id)}
            ${doneBtnHtml(a.id)}
          </div>
          <button data-plan="${a.id}" type="button"
            class="w-full rounded-xl bg-slate-100 px-3 py-2 text-sm font-semibold text-slate-700 active:scale-95 transition">
            ➕ ${esc(T.planAdd)}
          </button>
        </div>
      </article>`;
  }

  /** Chips telling you this place is already on the timeline, so you don't plan
   *  the same coaster twice. Dates come straight off the entries. */
  function timelineChips(id) {
    const mine = state.entries.filter((e) => e.ref === id);
    if (!mine.length) return '';
    const visited = mine.filter((e) => e.status === 'visited');
    const planned = mine.filter((e) => e.status === 'planned');
    const label = (e) => (e.date ? fmtDayShort(e.date) : T.journeyNoDate) + (e.time ? ` ${e.time}` : '');
    return [
      ...visited.map((e) => chip(esc(fmt('cardVisited', { date: label(e) })),
        'bg-emerald-50 text-emerald-700 ring-emerald-200')),
      ...planned.map((e) => chip(esc(fmt('cardPlanned', { date: label(e) })),
        'bg-sky-50 text-sky-700 ring-sky-200')),
    ].join('');
  }

  /** Repaint a single card's favorite state in place, so a tap doesn't
   *  re-render (and collapse) the whole list. */
  function paintCardState(id) {
    const art = document.querySelector(`#attraction-list [data-id="${id}"]`);
    if (!art) return;
    const isFav = state.favorites.has(id);
    const isDone = state.visitedRefs.has(id);
    const favBtn = art.querySelector('[data-fav]');
    const doneBtn = art.querySelector('[data-done]');
    if (favBtn) favBtn.outerHTML = favBtnHtml(id);
    if (doneBtn) doneBtn.outerHTML = doneBtnHtml(id);
    const h3 = art.querySelector('h3');
    if (h3) h3.innerHTML = `${isFav ? '⭐ ' : ''}${esc(ATTR.get(id)?.name ?? '')}`;
    art.classList.toggle('opacity-60', isDone);
    art.classList.toggle('ring-amber-300', isFav);
    art.classList.toggle('ring-transparent', !isFav);
  }

  function renderAttractions() {
    const list = computeList();
    $('#attraction-list').innerHTML = list.map(attractionCard).join('');
    $('#empty-state').hidden = list.length > 0;

    const total = D.attractions.length;
    const sortNote = state.position
      ? T.sortedByDistance + (state.position.approx ? T.sortedApprox : '')
      : T.sortedByRegion;
    $('#results-status').innerHTML = `${fmt('resultsCount', { n: list.length, total })} · ${sortNote}`;
  }

  /* ---------------- geolocation ---------------- */
  function findNearby() {
    if (!('geolocation' in navigator)) {
      toast(T.geoNoSupport);
      return;
    }
    if (state.locating) return;

    state.locating = true;
    $('#nearby-label').textContent = T.nearbyLocating;

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        state.locating = false;
        state.position = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          at: Date.now(),
          approx: (pos.coords.accuracy ?? 0) > 1000,
        };
        $('#nearby-label').textContent = T.nearbyDone;
        persist();
        renderAttractions();
        toast(T.geoOk);
      },
      (err) => {
        state.locating = false;
        $('#nearby-label').textContent = T.nearby;
        // Fallback is already the default sort, so we only need to explain.
        const msg = {
          1: T.geoDenied,
          2: T.geoUnavailable,
          3: T.geoTimeout,
        }[err.code] || T.geoFailed;
        toast(msg);
        renderAttractions();
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 120000 }
    );
  }

  /* ================================================================
   *  SHELL
   * ================================================================ */
  function renderHeader() {
    const t = today();
    const start = parseDate(D.trip.startDate);
    const end = parseDate(D.trip.endDate);
    const totalDays = daysBetween(start, end) + 1;

    $('#trip-title').textContent = D.trip.title;
    $('#trip-dates').textContent =
      `${D.trip.subtitle} · ${fmtDate(D.trip.startDate)} – ${fmtDate(D.trip.endDate)}`;

    let status;
    if (t < start) {
      const n = daysBetween(t, start);
      status = n === 1 ? T.tripTomorrow : fmt('tripInDays', { n });
    } else if (t <= end) {
      status = fmt('tripDay', { n: daysBetween(start, t) + 1, total: totalDays });
    } else {
      status = T.tripComplete;
    }
    $('#trip-status').innerHTML = `<span class="font-semibold text-white">${esc(status)}</span>`;
    $('#data-note').textContent = D.trip.dataNote || '';
    $('#app-version').textContent = fmt('appVersion', { v: APP_VERSION });
  }

  function setTab(tab) {
    state.tab = tab;
    $('#view-itinerary').hidden = tab !== 'itinerary';
    $('#view-plans').hidden = tab !== 'plans';
    $('#view-journey').hidden = tab !== 'journey';
    $('#view-attractions').hidden = tab !== 'attractions';
    document.querySelectorAll('.tab-btn').forEach((b) => {
      const on = b.dataset.tab === tab;
      b.classList.toggle('text-ink', on);
      b.classList.toggle('text-slate-400', !on);
      b.setAttribute('aria-current', on ? 'page' : 'false');
    });
    window.scrollTo({ top: 0, behavior: 'instant' });
    persist();
  }

  function wireEvents() {
    document.querySelectorAll('.tab-btn').forEach((b) =>
      b.addEventListener('click', () => setTab(b.dataset.tab)));

    // Debounced so typing on a phone doesn't re-render 50 cards per keystroke.
    let searchTimer;
    $('#search').addEventListener('input', (e) => {
      state.query = e.target.value;
      syncClearSearch();
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { renderAttractions(); persist(); }, 120);
    });

    $('#btn-clear-search').addEventListener('click', () => {
      state.query = '';
      paintFilterState();
      $('#search').focus(); // keep the keyboard up — usually you're retyping
      renderAttractions(); persist();
    });

    $('#cat-rail').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-cat]');
      if (!btn) return;
      const id = btn.dataset.cat;
      state.categories.has(id) ? state.categories.delete(id) : state.categories.add(id);
      paintFilterState(); renderAttractions(); persist();
    });

    $('#btn-clear-cat').addEventListener('click', () => {
      state.categories.clear();
      paintFilterState(); renderAttractions(); persist();
    });

    $('#weather-rail').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-weather]');
      if (!btn) return;
      state.weather = btn.dataset.weather;
      paintFilterState(); renderAttractions(); persist();
    });

    $('#region-rail').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-region]');
      if (!btn) return;
      state.region = btn.dataset.region;
      paintFilterState(); renderAttractions(); persist();
    });

    $('#status-rail').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-status]');
      if (!btn) return;
      const id = btn.dataset.status;
      if (id === 'all') {
        state.statuses.clear();
      } else {
        state.statuses.has(id) ? state.statuses.delete(id) : state.statuses.add(id);
        // "טרם בוצע" and "בוצע" contradict each other — picking one drops the other.
        if (id === 'todo') state.statuses.delete('done');
        if (id === 'done') state.statuses.delete('todo');
      }
      paintFilterState(); renderAttractions(); persist();
    });

    $('#priority').addEventListener('change', (e) => {
      state.minRank = Number(e.target.value);
      renderAttractions(); persist();
    });

    // Favorite / visit / plan (delegated). Favorites repaint just the tapped card
    // so open navigation menus on other cards aren't disturbed; the other two open
    // the sheet, which re-renders everything on save anyway.
    $('#attraction-list').addEventListener('click', (e) => {
      const favBtn = e.target.closest('[data-fav]');
      const doneBtn = e.target.closest('[data-done]');
      const planBtn = e.target.closest('[data-plan]');
      if (favBtn) {
        const id = favBtn.dataset.fav;
        state.favorites.has(id) ? state.favorites.delete(id) : state.favorites.add(id);
        persist();
        // Under an active status filter the card may need to leave the list.
        state.statuses.size === 0 ? paintCardState(id) : renderAttractions();
      } else if (doneBtn) {
        const id = doneBtn.dataset.done;
        // Already logged? Open that entry for editing rather than silently
        // destroying a note with a stray tap.
        const logged = state.entries.find((x) => x.ref === id && x.status === 'visited');
        openSheet(logged ? { entryId: logged.id } : { ref: id, mode: 'visited' });
      } else if (planBtn) {
        openSheet({ ref: planBtn.dataset.plan, mode: 'planned', date: activeDay() });
      }
    });

    /* ---- planner + journey (delegated on the two view containers) ---- */
    const timelineClicks = (e) => {
      const hit = (attr) => e.target.closest(`[${attr}]`);

      const day = hit('data-plan-day');
      if (day) {
        state.planDay = day.dataset.planDay;
        persist(); renderPlanner();
        return;
      }

      const edit = hit('data-entry-edit');
      if (edit) { openSheet({ entryId: edit.dataset.entryEdit }); return; }

      const visit = hit('data-entry-visit');
      if (visit) {
        const entry = findEntry(visit.dataset.entryVisit);
        if (entry) {
          entry.status = 'visited';
          if (!entry.time) entry.time = hhmmNow(); // stamp when it actually happened
          reindex(); persist();
          toast(T.markedVisited);
          renderPlanner(); renderJourney(); renderAttractions();
        }
        return;
      }

      const unvisit = hit('data-entry-unvisit');
      if (unvisit) {
        const entry = findEntry(unvisit.dataset.entryUnvisit);
        if (entry) {
          entry.status = 'planned';
          reindex(); persist();
          toast(T.backToPlan);
          renderPlanner(); renderJourney(); renderAttractions();
        }
        return;
      }

      const up = hit('data-entry-up');
      const down = hit('data-entry-down');
      if (up || down) {
        moveEntry((up || down).dataset[up ? 'entryUp' : 'entryDown'], up ? -1 : 1);
        persist(); renderPlanner(); renderJourney();
        return;
      }

      const sort = hit('data-sort-day');
      if (sort) {
        sortDayByTime(sort.dataset.sortDay);
        persist(); renderPlanner();
        toast(T.sortedByTime);
        return;
      }

      const manual = hit('data-add-manual');
      if (manual) {
        openSheet({
          custom: true,
          date: manual.dataset.addManual || activeDay(),
          // The journey's own add button logs a visit; the planner's plans one.
          mode: manual.hasAttribute('data-journey-add') ? 'visited' : 'planned',
        });
        return;
      }

      if (hit('data-route-hotel')) {
        state.routeFromHotel = !state.routeFromHotel;
        persist(); renderPlanner(); renderJourney();
        return;
      }

      if (hit('data-trip-hotels')) {
        state.tripRouteHotels = !state.tripRouteHotels;
        persist(); renderJourney();
        return;
      }

      if (hit('data-goto-bank')) { setTab('attractions'); return; }

      const copy = hit('data-copy-day');
      if (copy) {
        const iso = copy.dataset.copyDay;
        const suggested = D.plans?.days?.find((d) => d.date === iso);
        // Only steps that point at a real attraction can become entries; the
        // free-text ones ("drive west, coffee on the way") have nowhere to go.
        const refs = (suggested?.steps || [])
          .filter((s) => s.ref && ATTR.has(s.ref))
          .filter((s) => !state.entries.some((x) => x.ref === s.ref && x.date === iso));
        if (!refs.length) { toast(T.copiedNothing); return; }
        refs.forEach((s) => addEntry({ ref: s.ref, date: iso, status: 'planned' }));
        persist();
        toast(fmt('copiedSuggestion', { n: refs.length }));
        renderPlanner(); renderAttractions();
      }
    };
    $('#view-plans').addEventListener('click', timelineClicks);
    $('#view-journey').addEventListener('click', timelineClicks);

    /* ---- sheet ---- */
    $('#sheet-close').addEventListener('click', closeSheet);
    $('#sheet-backdrop').addEventListener('click', closeSheet);
    $('#sheet-save').addEventListener('click', saveSheet);
    $('#sheet-delete').addEventListener('click', deleteFromSheet);
    $('#sheet-date').addEventListener('change', paintSheet);
    $('#sheet').addEventListener('click', (e) => {
      const mode = e.target.closest('[data-sheet-mode]');
      if (mode) {
        sheetCtx.mode = mode.dataset.sheetMode;
        // Logging a visit wants a clock time; planning usually doesn't.
        if (sheetCtx.mode === 'visited' && !$('#sheet-time').value) $('#sheet-time').value = hhmmNow();
        paintSheet();
        return;
      }
      const day = e.target.closest('[data-sheet-day]');
      if (day) { $('#sheet-date').value = day.dataset.sheetDay; paintSheet(); }
    });
    // Pasting a link is the moment to tell the user whether we got a location out
    // of it — that's what decides whether the day route can aim at a pin.
    // React on `input`, not just `change`: `change` only fires on blur, so pasting
    // and going straight for Save left the default help text on screen — which
    // reads like a failure even when the link parsed fine.
    const syncLinkHelp = () => {
      const parsed = parseMapsLink($('#sheet-link').value);
      const help = $('#sheet-link-help');
      if (parsed.name && !$('#sheet-name').value.trim()) $('#sheet-name').value = parsed.name;
      if (parsed.coords) help.textContent = T.sheetLinkParsedCoords;
      else if (parsed.name) help.textContent = fmt('sheetLinkParsedName', { name: parsed.name });
      else if (parsed.url) help.textContent = T.sheetLinkShort;
      else help.textContent = T.sheetLinkHelp;
    };
    $('#sheet-link').addEventListener('input', syncLinkHelp);
    $('#sheet-link').addEventListener('change', syncLinkHelp);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !sheetEl().hidden) closeSheet();
    });

    $('#btn-nearby').addEventListener('click', findNearby);

    $('#btn-reset').addEventListener('click', () => {
      state.query = '';
      state.categories.clear();
      state.weather = 'all';
      state.region = 'all';
      state.statuses.clear();
      state.minRank = 1;
      paintFilterState(); renderAttractions(); persist();
    });
  }

  /* ---------------- boot ---------------- */
  restore();
  renderHeader();
  renderItinerary();
  renderPlanner();
  renderJourney();
  buildFilterRails();
  paintFilterState();
  renderAttractions();
  wireEvents();
  setTab(state.tab);
  if (state.position) $('#nearby-label').textContent = T.nearbyDone;

  // The filter bar sticks directly under the header, whose height depends on
  // the device safe-area inset — so measure it rather than hard-coding.
  const syncHeaderOffset = () => {
    const h = document.querySelector('header')?.offsetHeight || 60;
    document.documentElement.style.setProperty('--hdr', `${h}px`);
  };
  syncHeaderOffset();
  window.addEventListener('resize', syncHeaderOffset);
  window.addEventListener('orientationchange', () => setTimeout(syncHeaderOffset, 250));

  // Handy for debugging from a phone console; not used by the app itself.
  window.__TRIP = {
    state, computeList, haversine, renderAttractions, destStr, gmapsUrl,
    tripDays, hotelOn, parseMapsLink, routeUrl, dayEntries, renderPlanner, renderJourney,
  };

  // Offline support. Needs https (GitLab Pages is fine); silently skipped
  // on file:// so local previews still work.
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    // Reload once when a new worker takes over, so a deploy lands without the
    // user having to know what a service worker is. `reloading` resets on the
    // reload itself, so this can't loop.
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading) return;
      reloading = true;
      location.reload();
    });

    window.addEventListener('load', () => {
      // updateViaCache: 'none' is the important part: without it the browser may
      // serve sw.js itself out of its own HTTP cache for up to 24h, so a new
      // worker never installs and the app looks stuck on the old build.
      navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
        .then((reg) => {
          reg.update();
          // Coming back to an installed PWA doesn't reload the page, so this is
          // often the only moment a deploy gets noticed.
          document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') reg.update();
          });
        })
        .catch(() => { /* not fatal */ });
    });
  }
})();
