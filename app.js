'use strict';
/* Surveyor's Little Helper, iteration 1.
   GPS -> section -> surveys nearby. No libraries; all geometry runs on the phone. */

const MI = 1609.344;          // meters per mile
const FT = 3.28084;           // feet per meter
const CENTER = { lat: 42.6, lon: -97.65 };   // middle of Cedar/Knox, used before a location exists
const PAGE = 100;
const NS = 'http://www.w3.org/2000/svg';
const $ = id => document.getElementById(id);

const state = {
  loc: null,            // {lat, lon, acc, source}
  mode: 'gps',          // 'gps' | 'manual'
  radiusIdx: 0,         // 0 = current section only, then 1/4-mile steps
  tab: 'map',
  filters: { ls: '', from: '', to: '', sec: null },
  sort: 'near',
  pickMode: false,
  shown: PAGE,
  selected: null,       // section key tapped on the map
  gpsMsg: '',
  ready: false,
  gps: null,            // latest real GPS fix, kept even when searching from the map center
  center: false,        // search from map center instead of GPS
  basemap: store('slhBase') === 'sat' ? 'sat' : 'map',
  ngs: store('slhNgs') === '1',
  selMark: null,
};
const D = { sections: [], byKey: new Map(), surveys: [], bySec: new Map(), roster: {}, meta: {}, townships: [], marks: null };
let V = null;           // last computed view
let watchId = null;

/* ---------- small helpers ---------- */
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const keyOf = (twp, rge, dir, sec) => `${+twp}-${+rge}-${dir}-${+sec}`;
const secLabel = s => `S${s.sec}-T${s.twp}N-R${s.rge}${s.dir}`;
const trLabel = (twp, rge, dir) => `T${+twp}N R${+rge}${dir}`;
function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } }

// Slider stops, equal spacing on the slider: current section, then 1/4 mi steps to 2 mi,
// 1/2 mi steps to 6 mi, and 1 mi steps to 10 mi.
const RADII = [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 7, 8, 9, 10];
function radiusMeters(idx) { return RADII[idx] * MI; }
function radiusText(idx) {
  if (idx === 0) return 'Current section only';
  const mi = RADII[idx], whole = Math.floor(mi), frac = mi - whole;
  const sym = { 0: '', 0.25: '¼', 0.5: '½', 0.75: '¾' }[frac];
  const num = (whole ? whole : '') + sym;
  return `${num} ${mi <= 1 ? 'mile' : 'miles'}`;
}
function fmtDate(iso) {
  if (!iso) return 'No date';
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}
function lsLabel(ls) {
  if (ls === 'BLM') return 'BLM';
  const n = D.roster[ls];
  return n ? `${ls} · ${n}` : `${ls}`;
}
function fmtDist(m) {
  const mi = m / MI;
  return mi < 0.1 ? 'under 0.1 mi' : `${mi.toFixed(1)} mi`;
}

/* ---------- geometry (everything in meters around a reference point) ---------- */
function makeProj(lat0, lon0) {
  const ky = Math.PI / 180 * 6371008.8;
  const kx = ky * Math.cos(lat0 * Math.PI / 180);
  return { kx, ky, lat0, lon0, fwd: (lon, lat) => [(lon - lon0) * kx, (lat - lat0) * ky] };
}
function pip(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy;
  let t = l ? ((px - ax) * dx + (py - ay) * dy) / l : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
function inPolys(x, y, pp) {
  for (const poly of pp) {
    if (!pip(x, y, poly[0])) continue;
    let hole = false;
    for (let h = 1; h < poly.length; h++) if (pip(x, y, poly[h])) { hole = true; break; }
    if (!hole) return true;
  }
  return false;
}
function distToPolys(x, y, pp) {
  let d = Infinity;
  for (const poly of pp) for (const ring of poly)
    for (let i = 0; i < ring.length - 1; i++) {
      const v = segDist(x, y, ring[i][0], ring[i][1], ring[i + 1][0], ring[i + 1][1]);
      if (v < d) d = v;
    }
  return d;
}

/* ---------- data ---------- */
async function loadData() {
  const get = u => fetch(u, { cache: 'no-cache' }).then(r => { if (!r.ok) throw new Error(u + ' ' + r.status); return r.json(); });
  const [sec, sur, ros, twp] = await Promise.all([
    get('data/sections_all.json'), get('data/surveys_all.json'),
    get('data/surveyors.json').catch(() => ({})),
    get('data/townships.json').catch(() => null),
  ]);
  D.roster = ros || {};
  for (const f of (twp && twp.features) || []) {
    const polys = f.type === 'Polygon' ? [f.coords] : f.coords;
    let a = 1e9, b = 1e9, c = -1e9, d = -1e9;
    for (const poly of polys) for (const p of poly[0]) {
      if (p[0] < a) a = p[0]; if (p[0] > c) c = p[0]; if (p[1] < b) b = p[1]; if (p[1] > d) d = p[1];
    }
    D.townships.push({ name: f.name.replace(/^(.+) city$/i, 'City of $1'), county: f.county, polys, bbox: [a, b, c, d] });
  }
  for (const s of sec.sections) {
    const polys = s.type === 'Polygon' ? [s.coords] : s.coords;
    let a = 1e9, b = 1e9, c = -1e9, d = -1e9;
    for (const poly of polys) for (const p of poly[0]) {
      if (p[0] < a) a = p[0]; if (p[0] > c) c = p[0]; if (p[1] < b) b = p[1]; if (p[1] > d) d = p[1];
    }
    const o = { key: keyOf(s.twp, s.rge, s.dir, s.sec), twp: +s.twp, rge: +s.rge, dir: s.dir, sec: +s.sec, polys, bbox: [a, b, c, d] };
    D.sections.push(o); D.byKey.set(o.key, o);
  }
  const missing = new Set();
  for (const sv of sur.surveys) {
    const keys = new Set();
    for (const loc of sv.locations) for (const n of loc.sections) keys.add(keyOf(loc.twp, loc.rge, loc.dir, n));
    sv.keys = [...keys];
    D.surveys.push(sv);
    for (const k of sv.keys) {
      if (!D.byKey.has(k)) { missing.add(k); continue; }
      if (!D.bySec.has(k)) D.bySec.set(k, []);
      D.bySec.get(k).push(sv);
    }
  }
  D.meta = { collected: sur.generatedAt, nSections: D.sections.length, nSurveys: D.surveys.length, unmapped: missing.size };
}

function townshipAt(lon, lat) {
  for (const t of D.townships)
    if (lon >= t.bbox[0] && lon <= t.bbox[2] && lat >= t.bbox[1] && lat <= t.bbox[3] && inPolys(lon, lat, t.polys)) return t.name;
  return null;
}
async function loadNgs() {
  if (D.marks !== null) return;
  D.marks = [];
  try {
    const r = await fetch('data/ngs.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error('missing');
    const j = await r.json();
    D.marks = j.marks || [];
    D.ngsFile = true;
  } catch (e) { D.ngsFile = false; }
  refresh();
}

/* ---------- compute what is near, what is in range, which surveys qualify ---------- */
function passes(sv, f, skipLs) {
  return (skipLs || !f.ls || sv.ls === f.ls) && (!f.from || sv.date >= f.from) && (!f.to || sv.date <= f.to);
}
function compute() {
  const ref = state.loc || CENTER;
  const proj = makeProj(ref.lat, ref.lon);
  const hasLoc = !!state.loc;
  const R = hasLoc ? radiusMeters(state.radiusIdx) : -1;
  const drawR = hasLoc ? Math.max(R, 0.75 * MI) + 1.5 * MI : Infinity;
  const latPad = drawR / 111000, lonPad = latPad / Math.cos(ref.lat * Math.PI / 180);
  const near = [];
  for (const s of D.sections) {
    if (isFinite(drawR) && (s.bbox[0] > ref.lon + lonPad || s.bbox[2] < ref.lon - lonPad ||
        s.bbox[1] > ref.lat + latPad || s.bbox[3] < ref.lat - latPad)) continue;
    const pp = s.polys.map(poly => poly.map(ring => ring.map(p => proj.fwd(p[0], p[1]))));
    const info = { s, pp, inside: false, dist: Infinity, in: false };
    if (hasLoc) { info.inside = inPolys(0, 0, pp); info.dist = info.inside ? 0 : distToPolys(0, 0, pp); }
    // center for labels (middle of the biggest piece)
    let best = null, ba = -1;
    for (const poly of pp) {
      let a = 1e12, b = 1e12, c = -1e12, d = -1e12;
      for (const p of poly[0]) { if (p[0] < a) a = p[0]; if (p[0] > c) c = p[0]; if (p[1] < b) b = p[1]; if (p[1] > d) d = p[1]; }
      const area = (c - a) * (d - b);
      if (area > ba) { ba = area; best = [(a + c) / 2, -(b + d) / 2]; }
    }
    info.c = best || [0, 0];
    near.push(info);
  }
  const current = near.find(i => i.inside) || null;
  const infoByKey = new Map(near.map(i => [i.s.key, i]));
  const included = [];
  if (hasLoc) {
    if (state.radiusIdx === 0) { if (current) included.push(current); }
    else for (const i of near) if (i.dist <= R) included.push(i);
  }
  for (const i of included) i.in = true;

  // candidate surveys from included sections, with distance
  const f = state.filters;
  const cand = new Map();
  for (const i of included) for (const sv of D.bySec.get(i.s.key) || []) {
    const d = cand.get(sv);
    if (d === undefined || i.dist < d) cand.set(sv, i.dist);
  }
  // surveyor choices (ignore the surveyor filter itself, respect dates)
  const lsCount = new Map();
  for (const sv of cand.keys()) if (passes(sv, f, true)) lsCount.set(sv.ls, (lsCount.get(sv.ls) || 0) + 1);

  let results = [];
  const curKey = current ? current.s.key : null;
  if (f.sec) {
    const si = infoByKey.get(f.sec);
    for (const sv of D.bySec.get(f.sec) || []) if (passes(sv, f))
      results.push({ sv, dist: cand.has(sv) ? cand.get(sv) : (si ? si.dist : Infinity) });
  } else {
    for (const [sv, d] of cand) if (passes(sv, f)) results.push({ sv, dist: d });
  }
  for (const r of results) r.here = !!curKey && r.sv.keys.includes(curKey);
  const byDate = (a, b) => (b.sv.date || '').localeCompare(a.sv.date || '') || (b.sv.id || '').localeCompare(a.sv.id || '');
  results.sort(state.sort === 'new' ? byDate : (a, b) => (a.dist - b.dist) || byDate(a, b));

  const counts = new Map();
  for (const i of near) counts.set(i.s.key, (D.bySec.get(i.s.key) || []).filter(sv => passes(sv, f)).length);

  V = { ref, proj, R, near, current, included, results, lsCount, counts, infoByKey, hasLoc };
  return V;
}

/* ---------- GPS ---------- */
function startGPS() {
  stopGPS();
  state.mode = 'gps';
  startWatch();
}
function startWatch() {
  if (watchId !== null) return;
  if (!('geolocation' in navigator)) { state.gpsMsg = 'This browser has no location support.'; refresh(); return; }
  if (!state.loc) state.gpsMsg = 'Finding you…';
  watchId = navigator.geolocation.watchPosition(onPos, onPosErr,
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
}
function stopGPS() { if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; } }
function stopWatchOnly() { stopGPS(); }
function onPos(p) {
  const n = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, source: 'gps' };
  state.gps = n;
  if (state.mode === 'center') { state.gpsMsg = ''; if (state.ready) renderMap(); return; }
  if (state.mode !== 'gps') return;
  const o = state.loc;
  let move = true;
  if (o && o.source === 'gps') {
    const dy = (n.lat - o.lat) * 111195, dx = (n.lon - o.lon) * 111195 * Math.cos(n.lat * Math.PI / 180);
    move = Math.hypot(dx, dy) > 15 || n.acc < o.acc * 0.6;
  }
  state.gpsMsg = '';
  if (move) { state.loc = n; state.needFit = true; refresh(); }
}
function onPosErr(e) {
  if (state.loc || state.mode === 'center') return;
  state.gpsMsg = e.code === 1
    ? 'Location is blocked. Allow it for this site, or choose a spot on the map (menu).'
    : 'Could not get your location yet. You can choose a spot on the map (menu).';
  refresh();
}
function setManual(lat, lon) {
  stopGPS();
  state.center = false;
  state.mode = 'manual';
  state.loc = { lat, lon, acc: 0, source: 'manual' };
  state.pickMode = false;
  state.needFit = true;
  refresh();
}

/* search from map center */
function setCenterMode(on) {
  state.center = on;
  state.pickMode = false;
  if (on) {
    state.mode = 'center';
    const o = state.loc || state.gps || { lat: CENTER.lat, lon: CENTER.lon };
    state.loc = { lat: o.lat, lon: o.lon, acc: 0, source: 'center' };
    startWatch();
  } else {
    if (state.gps) { state.mode = 'gps'; state.loc = Object.assign({}, state.gps); }
    else { state.mode = 'manual'; state.loc = Object.assign({}, state.loc, { source: 'manual' }); startGPS(); state.mode = 'manual'; }
  }
  state.selected = null; state.selMark = null; state.shown = PAGE; state.needFit = true;
  refresh();
}
let commitTimer = 0;
function scheduleCommit() {
  if (!state.center) return;
  clearTimeout(commitTimer);
  commitTimer = setTimeout(() => { if (pts.size) scheduleCommit(); else commitCenter(); }, 220);
}
function commitCenter() {
  if (!state.center || !V || !mapRef) return;
  const x = view.cx, n = -view.cy;
  if (Math.hypot(x, n) < 3) return;
  state.loc = { lat: mapRef.lat0 + n / mapRef.ky, lon: mapRef.lon0 + x / mapRef.kx, acc: 0, source: 'center' };
  state.shown = PAGE; state.selected = null; state.selMark = null; state.rebase = true;
  refresh();
}

/* ---------- rendering: header, list, map ---------- */
function refresh() {
  if (!state.ready) return;
  compute();
  renderHeader(); renderFilters(); renderList(); renderMap(); renderMenu();
}
function renderHeader() {
  const L = $('secLabel'), S = $('subLabel');
  const A = $('areaLabel');
  if (!state.loc) { A.textContent = ''; L.textContent = 'No location yet'; S.textContent = state.gpsMsg; return; }
  if (V.current) {
    L.textContent = secLabel(V.current.s);
  } else {
    let near = null;
    for (const i of V.near) if (!near || i.dist < near.dist) near = i;
    if (near && near.dist < 1000) L.textContent = 'Between sections';
    else L.textContent = 'Outside the data area';
  }
  if (V.current) {
    const cedar = V.current.s.dir === 'E' || V.current.s.rge === 1;
    const tw = townshipAt(state.loc.lon, state.loc.lat);
    A.textContent = (cedar ? 'Cedar County' : 'Knox County') + (tw ? ' · ' + tw : '');
  } else A.textContent = '';
  if (state.loc.source === 'gps') S.textContent = `GPS ±${Math.round(state.loc.acc * FT)} ft`;
  else if (state.loc.source === 'center') S.textContent = 'Map center (not your location)';
  else S.textContent = 'Spot you picked (not GPS)';
  if (!V.current) {
    let near = null;
    for (const i of V.near) if (!near || i.dist < near.dist) near = i;
    S.textContent += near && near.dist < 8 * MI ? ` · nearest ${secLabel(near.s)}, ${fmtDist(near.dist)}` : ' · Cedar and Knox counties only for now';
  }
}
function renderFilters() {
  const sel = $('fLs'), cur = state.filters.ls;
  const entries = [...V.lsCount.entries()];
  if (cur && !V.lsCount.has(cur)) entries.push([cur, 0]);
  entries.sort((a, b) => (a[0] === 'BLM' ? -1 : b[0] === 'BLM' ? 1 : (+a[0] - +b[0]) || String(a[0]).localeCompare(b[0])));
  const sig = JSON.stringify(entries) + cur;
  if (sel.dataset.sig !== sig) {
    sel.innerHTML = `<option value="">All surveyors (${[...V.lsCount.values()].reduce((a, b) => a + b, 0)})</option>` +
      entries.map(([ls, n]) => `<option value="${esc(ls)}"${ls === cur ? ' selected' : ''}>${esc(lsLabel(ls))} (${n})</option>`).join('');
    sel.dataset.sig = sig;
  }
  $('fFrom').value = state.filters.from; $('fTo').value = state.filters.to;
  const chips = [];
  if (state.filters.sec) {
    const s = D.byKey.get(state.filters.sec);
    chips.push(`<button class="chip" data-chip="sec">Section ${s.sec}, ${trLabel(s.twp, s.rge, s.dir)} ✕</button>`);
  }
  $('chips').innerHTML = chips.join('');
  const any = state.filters.ls || state.filters.from || state.filters.to || state.filters.sec;
  $('clearBtn').classList.toggle('hidden', !any);
  $('sortBtn').textContent = 'Sort: ' + (state.sort === 'near' ? 'Nearest' : 'Newest');
}
function sectionsText(sv) {
  const parts = sv.locations.map(l => {
    const list = l.sections;
    const shown = list.slice(0, 6).join(', ') + (list.length > 6 ? ` +${list.length - 6}` : '');
    return `Sec ${shown} · ${trLabel(l.twp, l.rge, l.dir)}`;
  });
  return parts.join(' ; ');
}
function cardInner(r) {
  const sv = r.sv, n = sv.sheets.length;
  const th = sv.sheets[0].thumb
    ? `<img class="thumb" loading="lazy" referrerpolicy="no-referrer" alt="" src="${esc(sv.sheets[0].thumb)}" onerror="this.style.visibility='hidden'">`
    : '<div class="thumb"></div>';
  const where = r.here ? '<span class="badge">Your section</span>'
    : (isFinite(r.dist) ? `<span>${fmtDist(r.dist)} away</span>` : '');
  return `${th}<div class="cbody">
    <div class="crow"><span class="cdate">${fmtDate(sv.date)}</span><span class="cls">LS ${esc(lsLabel(sv.ls))}</span></div>
    <div class="csec">${esc(sectionsText(sv))}</div>
    <div class="cmeta">${where}<span>${n} sheet${n > 1 ? 's' : ''}</span></div></div>`;
}
function renderList() {
  const total = V.results.length;
  $('listCount').textContent = state.loc ? `(${total})` : '';
  const ul = $('results');
  if (!state.loc) {
    $('summary').textContent = '';
    ul.innerHTML = `<li class="empty">${esc(state.gpsMsg || 'Finding you…')}</li>`;
    $('moreBtn').classList.add('hidden'); return;
  }
  const inHere = V.results.filter(r => r.here).length;
  $('summary').textContent = `${total} survey${total === 1 ? '' : 's'} · ${radiusText(state.radiusIdx).toLowerCase()}` +
    (state.radiusIdx > 0 && inHere ? ` · ${inHere} in your section` : '');
  if (!total) {
    let why = 'No surveys match.';
    if (state.radiusIdx === 0 && !V.current) why = 'You are not inside a mapped section. Slide the distance up to look around you.';
    else if (state.filters.ls || state.filters.from || state.filters.to || state.filters.sec) why = 'No surveys match these filters. Try clearing them or sliding the distance up.';
    else if (state.radiusIdx === 0) why = 'No surveys on file for this section. Slide the distance up to look at nearby sections.';
    ul.innerHTML = `<li class="empty">${why}</li>`; $('moreBtn').classList.add('hidden'); return;
  }
  const shown = V.results.slice(0, state.shown);
  ul.innerHTML = shown.map((r, i) => {
    const sv = r.sv;
    if (sv.sheets.length === 1)
      return `<li><a class="card" href="${esc(sv.sheets[0].pdf)}" target="_blank" rel="noopener noreferrer">${cardInner(r)}</a></li>`;
    return `<li><button class="card" data-multi="${i}">${cardInner(r)}</button>
      <div class="sheets hidden" id="sh${i}">${sv.sheets.map(s =>
        `<a href="${esc(s.pdf)}" target="_blank" rel="noopener noreferrer">Sheet ${esc(s.page || '?')}</a>`).join('')}</div></li>`;
  }).join('');
  $('moreBtn').classList.toggle('hidden', total <= shown.length);
  $('moreBtn').textContent = `Show more (${total - shown.length} left)`;
}
function renderMenu() {
  $('mGps').classList.toggle('hidden', state.mode === 'gps' || state.center);
  $('mPick').classList.toggle('hidden', state.center);
  $('optCenter').checked = state.center;
  $('lyNgs').checked = state.ngs;
  for (const r of document.querySelectorAll('input[name=bm]')) r.checked = r.value === state.basemap;
  const nn = $('ngsNote');
  nn.classList.toggle('hidden', !(state.ngs && D.marks !== null && !D.ngsFile));
  nn.textContent = 'The monument file is not installed yet (data/ngs.json).';
  const m = D.meta;
  $('dataInfo').innerHTML = `SLH-v0.6. Survey list collected ${esc((m.collected || '').slice(0, 10))}: ${m.nSurveys.toLocaleString()} surveys, ${m.nSections.toLocaleString()} section outlines.` +
    (m.unmapped ? ` ${m.unmapped} section${m.unmapped > 1 ? 's' : ''} named in surveys could not be placed on the map.` : '');
}

/* ----- map ----- */
const svg = $('map');
const gTiles = document.createElementNS(NS, 'g');
const gWorld = document.createElementNS(NS, 'g');
const gLabels = document.createElementNS(NS, 'g');
svg.append(gTiles, gWorld, gLabels);
const view = { cx: 0, cy: 0, s: 0.05, W: 300, H: 300 };
let mapRef = null, labelRaf = 0, markPts = [];

function sizeMap() {
  const r = svg.getBoundingClientRect();
  view.W = r.width || 300; view.H = r.height || 300;
}
function applyView() {
  const t = `translate(${view.W / 2 - view.cx * view.s} ${view.H / 2 - view.cy * view.s}) scale(${view.s})`;
  gWorld.setAttribute('transform', t);
  let off = '';
  if (tileRef && mapRef) off = ` translate(${-(mapRef.lon0 - tileRef.lon0) * tileRef.kx} ${(mapRef.lat0 - tileRef.lat0) * tileRef.ky})`;
  gTiles.setAttribute('transform', t + off);
  if (!labelRaf) labelRaf = requestAnimationFrame(() => { labelRaf = 0; drawLabels(); updateTiles(); });
}

/* satellite tiles (USGS imagery, public domain), placed on the same local meter grid */
const TILE_URL = (z, x, y) => `https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/${z}/${y}/${x}`;
let tileRef = null, tileZ = 0, tileCleanup = 0;
const tileEls = new Map();
const tx2lon = (x, z) => x / 2 ** z * 360 - 180;
const ty2lat = (y, z) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / 2 ** z))) * 180 / Math.PI;
const lon2tx = (lon, z) => Math.floor((lon + 180) / 360 * 2 ** z);
const lat2ty = (lat, z) => { const r = lat * Math.PI / 180; return Math.floor((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2 * 2 ** z); };
function clearTiles() { gTiles.textContent = ''; tileEls.clear(); tileRef = null; }
function updateTiles() {
  if (state.basemap !== 'sat' || !mapRef) { if (gTiles.firstChild) clearTiles(); return; }
  if (tileRef && (Math.abs(mapRef.lat0 - tileRef.lat0) > 0.07 || Math.abs(mapRef.lon0 - tileRef.lon0) > 0.1)) clearTiles();
  if (!tileRef) tileRef = { lat0: mapRef.lat0, lon0: mapRef.lon0, kx: mapRef.kx, ky: mapRef.ky };
  const { W, H, s, cx, cy } = view;
  const lonA = mapRef.lon0 + (cx - W / 2 / s) / mapRef.kx, lonB = mapRef.lon0 + (cx + W / 2 / s) / mapRef.kx;
  const latA = mapRef.lat0 - (cy + H / 2 / s) / mapRef.ky, latB = mapRef.lat0 - (cy - H / 2 / s) / mapRef.ky;   // south, north
  let z = Math.min(16, Math.max(8, Math.ceil(Math.log2(156543.03 * Math.cos(mapRef.lat0 * Math.PI / 180) * s))));
  let x0, x1, y0, y1;
  for (;; z--) {
    x0 = lon2tx(lonA, z); x1 = lon2tx(lonB, z); y0 = lat2ty(latB, z); y1 = lat2ty(latA, z);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) <= 70 || z <= 6) break;
  }
  tileZ = z;
  const want = new Set();
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
    const k = `${z}/${x}/${y}`; want.add(k);
    if (tileEls.has(k)) continue;
    const w = tx2lon(x, z), e = tx2lon(x + 1, z), n = ty2lat(y, z), so = ty2lat(y + 1, z);
    const im = document.createElementNS(NS, 'image');
    const px = (w - tileRef.lon0) * tileRef.kx, px2 = (e - tileRef.lon0) * tileRef.kx;
    const py = -(n - tileRef.lat0) * tileRef.ky, py2 = -(so - tileRef.lat0) * tileRef.ky;
    im.setAttribute('x', px); im.setAttribute('y', py);
    im.setAttribute('width', px2 - px + 0.8); im.setAttribute('height', py2 - py + 0.8);
    im.setAttribute('preserveAspectRatio', 'none');
    im.setAttribute('href', TILE_URL(z, x, y));
    im.addEventListener('error', () => { im.remove(); tileEls.delete(k); });
    gTiles.appendChild(im); tileEls.set(k, im);
    im.dataset.z = z;
  }
  for (const [k, im] of tileEls) if (+im.dataset.z === z && !want.has(k)) { im.remove(); tileEls.delete(k); }
  clearTimeout(tileCleanup);
  tileCleanup = setTimeout(() => { for (const [k, im] of tileEls) if (+im.dataset.z !== tileZ) { im.remove(); tileEls.delete(k); } }, 900);
}
function applyBasemap() {
  svg.classList.toggle('sat', state.basemap === 'sat');
  $('attrib').classList.toggle('hidden', state.basemap !== 'sat');
  if (state.basemap !== 'sat') clearTiles();
  applyView();
}
function fitView() {
  sizeMap();
  if (!V) return;
  if (V.hasLoc) {
    const r = Math.max(V.R, 0.5 * MI) * 1.2;
    view.s = 0.5 * Math.min(view.W, view.H) / r; view.cx = 0; view.cy = 0;
  } else {
    let a = 1e12, b = 1e12, c = -1e12, d = -1e12;
    for (const i of V.near) for (const p of i.pp[0][0]) { a = Math.min(a, p[0]); c = Math.max(c, p[0]); b = Math.min(b, p[1]); d = Math.max(d, p[1]); }
    view.s = Math.min(view.W / (c - a), view.H / (d - b)) * 0.92;
    view.cx = (a + c) / 2; view.cy = -(b + d) / 2;
  }
  applyView();
}
function pathD(pp) {
  let d = '';
  for (const poly of pp) for (const ring of poly) {
    d += ring.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + (-p[1]).toFixed(1)).join('') + 'Z';
  }
  return d;
}
function lvl(n) { return n >= 6 ? 3 : n >= 3 ? 2 : n >= 1 ? 1 : 0; }
function renderMap() {
  mapRef = V.proj;
  gWorld.textContent = '';
  const order = V.near.slice().sort((a, b) => (a.inside - b.inside) || (a.in - b.in));
  for (const i of order) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', pathD(i.pp));
    p.setAttribute('class', 'sec' + (i.inside ? ' cur' : i.in ? ' in' : '') + (i.in || i.inside ? ' c' + lvl(V.counts.get(i.s.key) || 0) : '') +
      (state.selected === i.s.key ? ' sel' : ''));
    gWorld.appendChild(p);
  }
  if (V.hasLoc) {
    if (V.R > 0 && !state.center) {
      const c = document.createElementNS(NS, 'circle');
      c.setAttribute('id', 'ring'); c.setAttribute('r', V.R); gWorld.appendChild(c);
    }
    if (state.loc.source === 'gps' && state.loc.acc > 4 && !state.center) {
      const a = document.createElementNS(NS, 'circle');
      a.setAttribute('id', 'accCircle'); a.setAttribute('r', Math.min(state.loc.acc, 400)); gWorld.appendChild(a);
    }
  }
  $('pickBanner').classList.toggle('hidden', !state.pickMode);
  markPts = [];
  if (state.ngs && D.marks) for (const m of D.marks) { const p = mapRef.fwd(m.lon, m.lat); markPts.push({ m, x: p[0], y: -p[1] }); }
  if (state.rebase) { state.rebase = false; view.cx = 0; view.cy = 0; }
  if (state.needFit) { state.needFit = false; fitView(); } else { sizeMap(); applyView(); }
  updateMapInfo();
}
function drawLabels() {
  gLabels.textContent = '';
  if (!V) return;
  const { W, H, s, cx, cy } = view;
  const px = MI * s;                      // pixels per mile
  const sx = x => W / 2 + (x - cx) * s, sy = y => H / 2 + (y - cy) * s;
  if (px >= 32) {
    for (const i of V.near) {
      const x = sx(i.c[0]), y = sy(i.c[1]);
      if (x < -20 || y < -20 || x > W + 20 || y > H + 20) continue;
      const n = V.counts.get(i.s.key) || 0;
      const t = document.createElementNS(NS, 'text');
      t.setAttribute('class', 'secNum'); t.setAttribute('x', x); t.setAttribute('y', y - (n && (i.in || i.inside) ? 13 : 0));
      t.textContent = i.s.sec; gLabels.appendChild(t);
      if (n && (i.in || i.inside)) {
        const g = document.createElementNS(NS, 'g');
        const w = 12 + String(n).length * 8;
        g.innerHTML = `<rect class="pillBg" x="${x - w / 2}" y="${y - 3}" width="${w}" height="20" rx="10"/>` +
          `<text class="pillTx" x="${x}" y="${y + 7.5}">${n}</text>`;
        gLabels.appendChild(g);
      }
    }
  } else if (px >= 14) {
    for (const i of V.near) {
      const n = V.counts.get(i.s.key) || 0;
      if (!n || !(i.in || i.inside)) continue;
      const x = sx(i.c[0]), y = sy(i.c[1]);
      if (x < -20 || y < -20 || x > W + 20 || y > H + 20) continue;
      const t = document.createElementNS(NS, 'text');
      t.setAttribute('class', 'secNum'); t.setAttribute('x', x); t.setAttribute('y', y); t.textContent = n;
      t.style.fontWeight = '700'; t.style.fill = '#143325'; gLabels.appendChild(t);
    }
  }
  if (state.ngs && px >= 12) {
    let n = 0;
    for (const q of markPts) {
      const x = sx(q.x), y = sy(q.y);
      if (x < -12 || y < -12 || x > W + 12 || y > H + 12) continue;
      if (++n > 600) break;
      const t = document.createElementNS(NS, 'polygon');
      t.setAttribute('points', `${x},${y - 9} ${x - 8},${y + 6} ${x + 8},${y + 6}`);
      t.setAttribute('class', 'mk' + (state.selMark === q.m.pid ? ' sel' : ''));
      gLabels.appendChild(t);
    }
  }
  if (V.hasLoc && state.center) {
    if (V.R > 0) {
      const c = document.createElementNS(NS, 'circle');
      c.setAttribute('class', 'ring2'); c.setAttribute('cx', W / 2); c.setAttribute('cy', H / 2); c.setAttribute('r', V.R * s);
      gLabels.appendChild(c);
    }
    if (state.gps) {                                   // your real position, as a normal blue dot
      const p = mapRef.fwd(state.gps.lon, state.gps.lat);
      const g = document.createElementNS(NS, 'circle');
      g.setAttribute('class', 'you'); g.setAttribute('cx', sx(p[0])); g.setAttribute('cy', sy(-p[1])); g.setAttribute('r', 8);
      gLabels.appendChild(g);
    }
    const cx0 = W / 2, cy0 = H / 2, a = 8, b = 20;
    const d = `M${cx0 - b} ${cy0}H${cx0 - a}M${cx0 + a} ${cy0}H${cx0 + b}M${cx0} ${cy0 - b}V${cy0 - a}M${cx0} ${cy0 + a}V${cy0 + b}`;
    for (const cls of ['xhd', 'xh']) { const pth = document.createElementNS(NS, 'path'); pth.setAttribute('d', d); pth.setAttribute('class', cls); gLabels.appendChild(pth); }
  } else if (V.hasLoc) {
    const d = document.createElementNS(NS, 'circle');
    d.setAttribute('class', 'you'); d.setAttribute('cx', sx(0)); d.setAttribute('cy', sy(0)); d.setAttribute('r', 8);
    gLabels.appendChild(d);
  }
}
const CARD = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
function updateMapInfo() {
  const box = $('mapInfo');
  const mk = state.selMark && markPts.find(q => q.m.pid === state.selMark);
  $('miList').classList.toggle('hidden', !!mk);
  if (!mk) $('miExtra').classList.add('hidden');
  $('miSheet').classList.toggle('hidden', !mk); $('miNav').classList.toggle('hidden', !mk);
  if (mk) {
    const m = mk.m, dx = mk.x, dn = -mk.y, d = Math.hypot(dx, dn);
    const dir = CARD[Math.round(((Math.atan2(dx, dn) * 180 / Math.PI + 360) % 360) / 45) % 8];
    const far = d < 0.1 * MI ? `${Math.round(d * FT)} ft` : `${(d / MI).toFixed(1)} mi`;
    $('miTitle').textContent = `NGS mark: ${m.name || m.pid}`;
    $('miCount').textContent = `${m.pid} · ${far} ${dir} of ${state.center ? 'the map center' : 'you'}`;
    const bits = [];
    const tp = (m.monumentType || '').replace(/^[A-Z0-9]+\s*=\s*/, '');
    if (tp) bits.push(tp.charAt(0) + tp.slice(1).toLowerCase());
    if (m.condition) {
      const c = m.condition.charAt(0) + m.condition.slice(1).toLowerCase();
      const when = m.lastRecovered ? (/^\d{8}$/.test(m.lastRecovered) ? m.lastRecovered.slice(0, 4) : m.lastRecovered) : '';
      bits.push(when ? `Last recovery ${when}: ${c.toLowerCase()}${m.recoveredBy ? ' (' + m.recoveredBy + ')' : ''}` : 'Condition: ' + c.toLowerCase());
    } else if (m.lastRecovered && /^\d{4}/.test(m.lastRecovered)) bits.push('Last recovered ' + m.lastRecovered.slice(0, 4));
    $('miExtra').textContent = bits.join(' · ');
    $('miExtra').classList.toggle('hidden', !bits.length);
    $('miSheet').href = `https://www.ngs.noaa.gov/cgi-bin/ds_mark.prl?PidBox=${encodeURIComponent(m.pid)}`;
    $('miNav').href = `https://www.google.com/maps/dir/?api=1&destination=${m.lat},${m.lon}`;
    box.classList.remove('hidden'); return;
  }
  const s = state.selected && D.byKey.get(state.selected);
  if (!s) { box.classList.add('hidden'); return; }
  const n = V.counts.get(s.key) !== undefined ? V.counts.get(s.key) : (D.bySec.get(s.key) || []).filter(sv => passes(sv, state.filters)).length;
  $('miTitle').textContent = `Section ${s.sec} · ${trLabel(s.twp, s.rge, s.dir)}`;
  $('miCount').textContent = `${n} survey${n === 1 ? '' : 's'} list this section`;
  box.classList.remove('hidden');
}

/* map gestures */
const pts = new Map();
let gest = null;
svg.addEventListener('pointerdown', e => {
  svg.setPointerCapture(e.pointerId);
  pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  gest = { moved: 0, t: Date.now(), x: e.clientX, y: e.clientY, multi: pts.size > 1 || (gest && gest.multi && pts.size > 0) };
  if (pts.size > 1) gest.multi = true;
});
svg.addEventListener('pointermove', e => {
  const p = pts.get(e.pointerId); if (!p) return;
  const r = svg.getBoundingClientRect();
  if (pts.size === 1) {
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    view.cx -= dx / view.s; view.cy -= dy / view.s;
    gest.moved += Math.abs(dx) + Math.abs(dy);
  } else if (pts.size === 2) {
    const [a, b] = [...pts.values()];
    const other = a === p ? b : a;
    const d0 = Math.hypot(a.x - b.x, a.y - b.y);
    const m0 = { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top };
    const na = a === p ? { x: e.clientX, y: e.clientY } : a, nb = b === p ? { x: e.clientX, y: e.clientY } : b;
    const d1 = Math.hypot(na.x - nb.x, na.y - nb.y);
    const m1 = { x: (na.x + nb.x) / 2 - r.left, y: (na.y + nb.y) / 2 - r.top };
    const ns = Math.max(0.004, Math.min(1.5, view.s * (d0 ? d1 / d0 : 1)));
    const wx = view.cx + (m0.x - view.W / 2) / view.s, wy = view.cy + (m0.y - view.H / 2) / view.s;
    view.s = ns; view.cx = wx - (m1.x - view.W / 2) / ns; view.cy = wy - (m1.y - view.H / 2) / ns;
    gest.moved += 20; void other;
  }
  p.x = e.clientX; p.y = e.clientY;
  applyView();
  scheduleCommit();
});
function endPointer(e) {
  if (!pts.has(e.pointerId)) return;
  pts.delete(e.pointerId);
  if (pts.size === 0 && gest && !gest.multi && gest.moved < 8 && Date.now() - gest.t < 700 && e.type === 'pointerup') mapTap(e.clientX, e.clientY);
  if (pts.size === 0) { gest = null; scheduleCommit(); }
}
svg.addEventListener('pointerup', endPointer);
svg.addEventListener('pointercancel', endPointer);
svg.addEventListener('wheel', e => {
  e.preventDefault();
  const r = svg.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
  const ns = Math.max(0.004, Math.min(1.5, view.s * Math.exp(-e.deltaY * 0.0015)));
  const wx = view.cx + (mx - view.W / 2) / view.s, wy = view.cy + (my - view.H / 2) / view.s;
  view.s = ns; view.cx = wx - (mx - view.W / 2) / ns; view.cy = wy - (my - view.H / 2) / ns;
  applyView();
  scheduleCommit();
}, { passive: false });

function mapTap(clientX, clientY) {
  if (!V) return;
  const r = svg.getBoundingClientRect();
  const x = view.cx + (clientX - r.left - view.W / 2) / view.s;
  const y = -(view.cy + (clientY - r.top - view.H / 2) / view.s);     // meters, north up
  if (state.pickMode) {
    setManual(mapRef.lat0 + y / mapRef.ky, mapRef.lon0 + x / mapRef.kx);
    return;
  }
  if (state.ngs && markPts.length) {
    const lx = clientX - r.left, ly = clientY - r.top;
    let best = null, bd = 26;
    for (const q of markPts) {
      const d = Math.hypot(view.W / 2 + (q.x - view.cx) * view.s - lx, view.H / 2 + (q.y - view.cy) * view.s - 3 - ly);
      if (d < bd) { bd = d; best = q; }
    }
    if (best) { state.selMark = best.m.pid; state.selected = null; drawLabels(); updateMapInfo(); return; }
  }
  let hit = null;
  for (const i of V.near) if (inPolys(x, y, i.pp)) { hit = i; break; }
  state.selected = hit ? hit.s.key : null; state.selMark = null;
  renderMap();
}

/* ---------- UI wiring ---------- */
function setTab(t) {
  state.tab = t;
  $('tab-map').classList.toggle('hidden', t !== 'map');
  $('tab-list').classList.toggle('hidden', t !== 'list');
  $('tabMapBtn').classList.toggle('on', t === 'map');
  $('tabListBtn').classList.toggle('on', t === 'list');
  if (t === 'map') { sizeMap(); applyView(); }
}
function showDisclaimer(first) {
  $('dOk').textContent = first ? 'I understand' : 'Close';
  $('disclaimer').classList.remove('hidden');
}
function wire() {
  $('tabMapBtn').onclick = () => setTab('map');
  $('tabListBtn').onclick = () => setTab('list');
  $('menuBtn').onclick = () => $('menu').classList.toggle('hidden');
  $('menu').onclick = e => { if (e.target === $('menu')) $('menu').classList.add('hidden'); };
  $('mAbout').onclick = () => { $('menu').classList.add('hidden'); showDisclaimer(false); };
  $('mPick').onclick = () => { $('menu').classList.add('hidden'); setTab('map'); state.pickMode = true; renderMap(); };
  $('mGps').onclick = () => { $('menu').classList.add('hidden'); state.loc = null; startGPS(); refresh(); };
  $('pickCancel').onclick = () => { state.pickMode = false; renderMap(); };
  $('dOk').onclick = () => { store('slhAccepted', '1'); $('disclaimer').classList.add('hidden'); };

  let rafPending = false;
  $('radius').oninput = e => {
    state.radiusIdx = +e.target.value; state.shown = PAGE; state.selected = null;
    $('radiusText').textContent = radiusText(state.radiusIdx);
    $('pinBtn').classList.toggle('on', state.radiusIdx === 0);
    if (!rafPending) { rafPending = true; requestAnimationFrame(() => { rafPending = false; state.needFit = true; refresh(); }); }
  };
  $('pinBtn').onclick = () => { $('radius').value = 0; $('radius').oninput({ target: $('radius') }); };
  $('pinBtn').classList.add('on');

  $('fLs').onchange = e => { state.filters.ls = e.target.value; state.shown = PAGE; refresh(); };
  $('fFrom').onchange = e => { state.filters.from = e.target.value; state.shown = PAGE; refresh(); };
  $('fTo').onchange = e => { state.filters.to = e.target.value; state.shown = PAGE; refresh(); };
  $('clearBtn').onclick = () => { state.filters = { ls: '', from: '', to: '', sec: null }; state.shown = PAGE; refresh(); };
  $('sortBtn').onclick = () => { state.sort = state.sort === 'near' ? 'new' : 'near'; refresh(); };
  $('chips').onclick = e => { if (e.target.dataset.chip === 'sec') { state.filters.sec = null; refresh(); } };
  $('moreBtn').onclick = () => { state.shown += PAGE; renderList(); };
  $('results').onclick = e => {
    const b = e.target.closest('[data-multi]'); if (!b) return;
    $('sh' + b.dataset.multi).classList.toggle('hidden');
  };
  $('recenter').onclick = () => {
    if (state.center && state.gps) {
      state.loc = { lat: state.gps.lat, lon: state.gps.lon, acc: 0, source: 'center' };
      state.selected = null; state.selMark = null; state.needFit = true; refresh();
    } else fitView();
  };
  for (const r of document.querySelectorAll('input[name=bm]')) r.onchange = () => {
    state.basemap = r.value; store('slhBase', r.value); $('menu').classList.add('hidden'); applyBasemap();
  };
  $('lyNgs').onchange = e => {
    state.ngs = e.target.checked; store('slhNgs', state.ngs ? '1' : '0'); $('menu').classList.add('hidden');
    state.selMark = null; if (state.ngs) loadNgs(); refresh();
  };
  $('optCenter').onchange = e => { $('menu').classList.add('hidden'); setCenterMode(e.target.checked); };
  $('miClose').onclick = () => { state.selected = null; renderMap(); };
  $('miList').onclick = () => { state.filters.sec = state.selected; state.shown = PAGE; refresh(); setTab('list'); };
  new ResizeObserver(() => { sizeMap(); applyView(); }).observe($('mapWrap'));
}

/* ---------- start ---------- */
(async function init() {
  wire();
  if ('serviceWorker' in navigator) { try { navigator.serviceWorker.register('sw.js'); } catch (e) { /* ignore */ } }
  if (!store('slhAccepted')) showDisclaimer(true);
  $('secLabel').textContent = 'Loading data…';
  try { await loadData(); }
  catch (err) {
    $('secLabel').textContent = 'Could not load data';
    $('subLabel').textContent = 'Check your connection and reload. ' + err.message;
    return;
  }
  state.ready = true;
  applyBasemap();
  if (state.ngs) loadNgs();
  const q = new URLSearchParams(location.search);
  const lat = parseFloat(q.get('lat')), lon = parseFloat(q.get('lon'));
  if (isFinite(lat) && isFinite(lon)) { state.mode = 'manual'; state.loc = { lat, lon, acc: 0, source: 'manual' }; state.needFit = true; }
  else { state.needFit = true; startGPS(); }
  const r = parseFloat(q.get('r'));
  if (isFinite(r)) { state.radiusIdx = RADII.reduce((best, v, i) => Math.abs(v - r) < Math.abs(RADII[best] - r) ? i : best, 0); $('radius').value = state.radiusIdx; $('radiusText').textContent = radiusText(state.radiusIdx); $('pinBtn').classList.toggle('on', state.radiusIdx === 0); }
  refresh();
})();
