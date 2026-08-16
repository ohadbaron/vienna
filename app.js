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
    minRank: 1,
    position: null,        // { lat, lng, at } — last known GPS fix
    locating: false,
    favorites: new Set(),  // attraction ids marked ⭐
    done: new Set(),       // attraction ids marked ✅
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
        minRank: state.minRank,
        position: state.position,
        favorites: [...state.favorites],
        done: [...state.done],
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
      if (raw.minRank) state.minRank = Number(raw.minRank);
      // Stale fixes are worse than none — a day-old position gives wrong distances.
      if (raw.position && Date.now() - raw.position.at < 6 * 60 * 60 * 1000) {
        state.position = raw.position;
      }
      if (Array.isArray(raw.favorites)) state.favorites = new Set(raw.favorites);
      if (Array.isArray(raw.done)) state.done = new Set(raw.done);
    } catch (_) { /* ignore corrupt state */ }
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

  /** Destination string for map links. Prefers navQuery (a name search beats a
   *  pin for restaurants/hotels), falls back to coordinates, then name/address. */
  const destStr = (t) =>
    t.navQuery || (t.coords ? `${t.coords.lat},${t.coords.lng}` : (t.name || t.address || ''));

  // Google Maps driving directions.
  const navUrl = (t) =>
    `https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=${encodeURIComponent(destStr(t))}`;
  // Google Maps — show the place (view/search, no directions).
  const mapUrl = (t) =>
    `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(destStr(t))}`;
  // Waze — coordinates are most reliable; fall back to a text query.
  const wazeUrl = (t) =>
    t.coords ? `https://waze.com/ul?ll=${t.coords.lat},${t.coords.lng}&navigate=yes`
      : `https://waze.com/ul?q=${encodeURIComponent(destStr(t))}&navigate=yes`;
  // Apple Maps driving directions.
  const appleUrl = (t) =>
    `https://maps.apple.com/?daddr=${encodeURIComponent(destStr(t))}&dirflg=d`;

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

  const WEATHER_ICON = { sun: '☀️', rain: '🌧️', any: '🌤️' };
  const WEATHER_TEXT = { sun: T.weatherTextSun, rain: T.weatherTextRain, any: T.weatherTextAny };

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
  // A single navigation control: a "נווט" button that expands to Waze / Google /
  // Apple directions plus "show on map". Used on every place across the app.
  const navOpt = (href, label) =>
    `<a href="${href}" target="_blank" rel="noopener"
        class="flex items-center justify-center gap-1 rounded-lg bg-slate-100 px-2 py-2 text-slate-700 active:scale-95 transition">${label}</a>`;

  const navBlock = (t, label = T.navigate, size = 'full') => `
    <details class="nav-menu ${size === 'full' ? 'block' : 'inline-block'}">
      <summary class="flex ${size === 'full' ? 'w-full' : ''} items-center justify-center gap-1.5 rounded-xl bg-ink px-3 py-2.5 text-sm font-semibold text-white shadow-sm active:scale-[0.98] transition">
        <span>🧭</span><span>${esc(label)}</span>
      </summary>
      <div class="mt-2 grid grid-cols-2 gap-1.5 text-[12px] font-semibold">
        ${navOpt(wazeUrl(t), '🚗 Waze')}
        ${navOpt(navUrl(t), '🗺️ Google')}
        ${navOpt(appleUrl(t), '🍎 Apple')}
        ${navOpt(mapUrl(t), `📍 ${esc(T.showOnMap)}`)}
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
    const on = state.done.has(id);
    return `<button data-done="${id}" type="button" aria-pressed="${on}"
      class="flex-1 rounded-xl px-3 py-2 text-sm font-semibold ring-1 transition ${
        on ? 'bg-emerald-100 text-emerald-700 ring-emerald-200' : 'bg-white text-slate-500 ring-slate-200'}">${
        on ? `✅ ${esc(T.doneOn)}` : `○ ${esc(T.doneAdd)}`}</button>`;
  };

  const chip = (text, cls = 'bg-slate-100 text-slate-600 ring-slate-200') =>
    `<span class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ${cls}">${text}</span>`;

  /** Small gray subtitle showing the original Latin place name under a
   *  Hebrew heading — helps matching against road signs and Maps results. */
  const latinSub = (latin) => latin ? `<p class="text-xs text-slate-400" dir="ltr">${esc(latin)}</p>` : '';

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
   *  TAB 2 — READY-MADE DAY PLANS
   * ================================================================ */
  function renderPlans() {
    const P = D.plans;
    if (!P) { $('#view-plans').innerHTML = ''; return; }
    const t = today();

    const legend = P.weatherLegend.map((w) => `
      <div class="flex items-start gap-2 text-xs">
        <span class="text-base leading-none">${w.icon}</span>
        <div><span class="font-semibold">${esc(w.when)}</span> — <span class="text-slate-600">${esc(w.ideas)}</span></div>
      </div>`).join('');

    const days = P.days.map((d) => {
      const isToday = daysBetween(t, parseDate(d.date)) === 0;
      const steps = d.steps.map((s) => {
        // A step links either to an attraction (by id) or a free nav target.
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
      }).join('');

      return `
        <article class="rounded-2xl bg-white p-4 shadow-sm ring-1 ${isToday ? 'ring-emerald-300' : 'ring-transparent'}">
          <p class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            ${esc(fmtDate(d.date))}${isToday ? ` · ${T.today}` : ''} · ${esc(d.base)}
          </p>
          <h3 class="font-bold leading-tight">${esc(d.title)}</h3>
          <ul class="mt-3 space-y-2">${steps}</ul>
          ${d.note ? `<p class="mt-3 rounded-xl bg-amber-50 p-2.5 text-xs leading-relaxed text-amber-900">${esc(d.note)}</p>` : ''}
        </article>`;
    }).join('');

    $('#view-plans').innerHTML = `
      ${section(T.planWeatherTitle,
        `<div class="space-y-2 rounded-2xl bg-white p-4 shadow-sm">
           <p class="text-xs leading-relaxed text-slate-600">${esc(P.intro)}</p>
           ${legend}
         </div>`)}
      ${section(T.planDaysTitle, `<div class="space-y-3">${days}</div>`)}
    `;
  }

  /* ================================================================
   *  TAB 3 — ATTRACTION BANK
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
  }

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
    $('#priority').value = String(state.minRank);
    $('#search').value = state.query;
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
    const isDone = state.done.has(a.id);
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
        </div>

        <p class="mt-2.5 text-sm leading-relaxed text-slate-600">${esc(a.description)}</p>
        ${a.travelNote ? `<p class="mt-1.5 text-xs font-medium text-slate-500">🚗 ${esc(a.travelNote)}</p>` : ''}
        ${tags ? `<div class="mt-2 flex flex-wrap gap-1">${tags}</div>` : ''}
        <div class="mt-3 space-y-2">
          ${navBlock(a)}
          <div class="flex gap-1.5">
            ${favBtnHtml(a.id)}
            ${doneBtnHtml(a.id)}
          </div>
        </div>
      </article>`;
  }

  /** Repaint a single card's favorite/done state in place, so a tap doesn't
   *  re-render (and collapse) the whole list. */
  function paintCardState(id) {
    const art = document.querySelector(`#attraction-list [data-id="${id}"]`);
    if (!art) return;
    const isFav = state.favorites.has(id);
    const isDone = state.done.has(id);
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
  }

  function setTab(tab) {
    state.tab = tab;
    $('#view-itinerary').hidden = tab !== 'itinerary';
    $('#view-plans').hidden = tab !== 'plans';
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
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { renderAttractions(); persist(); }, 120);
    });

    $('#cat-rail').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-cat]');
      if (!btn) return;
      const id = btn.dataset.cat;
      state.categories.has(id) ? state.categories.delete(id) : state.categories.add(id);
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

    $('#priority').addEventListener('change', (e) => {
      state.minRank = Number(e.target.value);
      renderAttractions(); persist();
    });

    // Favorite / Done toggles (delegated). Repaint just the tapped card so open
    // navigation menus on other cards aren't disturbed.
    $('#attraction-list').addEventListener('click', (e) => {
      const favBtn = e.target.closest('[data-fav]');
      const doneBtn = e.target.closest('[data-done]');
      if (favBtn) {
        const id = favBtn.dataset.fav;
        state.favorites.has(id) ? state.favorites.delete(id) : state.favorites.add(id);
        paintCardState(id); persist();
      } else if (doneBtn) {
        const id = doneBtn.dataset.done;
        state.done.has(id) ? state.done.delete(id) : state.done.add(id);
        paintCardState(id); persist();
      }
    });

    $('#btn-nearby').addEventListener('click', findNearby);

    $('#btn-reset').addEventListener('click', () => {
      state.query = '';
      state.categories.clear();
      state.weather = 'all';
      state.region = 'all';
      state.minRank = 1;
      paintFilterState(); renderAttractions(); persist();
    });
  }

  /* ---------------- boot ---------------- */
  restore();
  renderHeader();
  renderItinerary();
  renderPlans();
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
  window.__TRIP = { state, computeList, haversine, renderAttractions, navUrl };

  // Offline support. Needs https (GitLab Pages is fine); silently skipped
  // on file:// so local previews still work.
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => { /* not fatal */ });
    });
  }
})();
