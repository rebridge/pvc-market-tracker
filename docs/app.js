/* Resin Watch — reads docs/data/*.json (written by scripts/fetch-data.mjs) and draws the dashboard. No dependencies. */
(() => {
  "use strict";
  const $ = (sel, root = document) => root.querySelector(sel);
  const DATA_DIR = "data/";
  const RANGE_YEARS = { "1y": 1, "3y": 3, "5y": 5, "10y": 10, all: Infinity };
  const STORE_KEY = "resin-watch-knobs-v1";
  const MONTH_MS = 30.44 * 86400000;

  // ---------- state ----------
  const defaults = { range: "5y", view: "overlay", off: [], lag: 0, table: false };
  let state = { ...defaults, ...(safeLoad() || {}) };
  let series = [];          // [{...meta, obs:[[date, value]], color, monthly:[[date,value]]}]
  let manifest = null;

  function safeLoad() { try { return JSON.parse(localStorage.getItem(STORE_KEY)); } catch { return null; } }
  function save() { try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* fine */ } }

  // ---------- formatting ----------
  const toDate = (s) => new Date(s + "T00:00:00Z");
  const iso = (d) => d.toISOString().slice(0, 10);
  const fmtMonth = (s) => toDate(s).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
  const fmtDay = (s) => toDate(s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  const fmtStamp = (isoStr) => new Date(isoStr).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
  const isMoney = (s) => /^\$/.test(s.units || "");
  function fmtVal(v, s) {
    if (v == null || !Number.isFinite(v)) return "—";
    if (isMoney(s)) return "$" + v.toFixed(2);
    return v >= 100 ? v.toFixed(1) : v.toFixed(2);
  }
  const fmtIdx = (v) => (v == null ? "—" : v.toFixed(1));
  function fmtPct(p) {
    if (p == null || !Number.isFinite(p)) return "—";
    const sign = p > 0 ? "+" : p < 0 ? "−" : "";
    return `${sign}${Math.abs(p).toFixed(1)}%`;
  }
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ---------- data shaping ----------
  function toMonthly(obs) {
    const m = new Map();
    for (const [d, v] of obs) {
      const k = d.slice(0, 7);
      const e = m.get(k) || { s: 0, n: 0 };
      e.s += v; e.n++; m.set(k, e);
    }
    return [...m.entries()].map(([k, e]) => [k + "-01", e.s / e.n]);
  }
  function shiftMonths(obs, n) {
    if (!n) return obs;
    return obs.map(([d, v]) => { const dt = toDate(d); dt.setUTCMonth(dt.getUTCMonth() + n); return [iso(dt), v]; });
  }
  function valueOnOrBefore(obs, dateStr) {
    // obs sorted ascending; binary search for last obs with date <= dateStr
    let lo = 0, hi = obs.length - 1, ans = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (obs[mid][0] <= dateStr) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return ans >= 0 ? obs[ans] : null;
  }
  function pctChange(a, b) { return a && b && b[1] ? ((a[1] - b[1]) / b[1]) * 100 : null; }
  function niceTicks(min, max, count = 5) {
    if (min === max) { min -= 1; max += 1; }
    const span = max - min;
    const step0 = span / count;
    const p = Math.pow(10, Math.floor(Math.log10(step0)));
    const r = step0 / p;
    const step = (r < 1.5 ? 1 : r < 3 ? 2 : r < 7 ? 5 : 10) * p;
    const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
    const ticks = [];
    for (let v = lo; v <= hi + step / 2; v += step) ticks.push(+v.toFixed(10));
    return { lo, hi, ticks };
  }
  function xTicks(startMs, endMs) {
    const years = (endMs - startMs) / (365.25 * 86400000);
    const stepMonths = years <= 1.5 ? 2 : years <= 2.5 ? 3 : years <= 3.5 ? 6 : years <= 12 ? 12 : years <= 25 ? 60 : 120;
    const d = new Date(startMs); d.setUTCDate(1); d.setUTCHours(0, 0, 0, 0);
    if (stepMonths >= 12) { d.setUTCMonth(0); if (d.getTime() < startMs) d.setUTCFullYear(d.getUTCFullYear() + 1); }
    else if (d.getTime() < startMs) d.setUTCMonth(d.getUTCMonth() + 1);
    if (stepMonths >= 60) { const y = d.getUTCFullYear(); d.setUTCFullYear(Math.ceil(y / (stepMonths / 12)) * (stepMonths / 12)); }
    const out = [];
    while (d.getTime() <= endMs) {
      out.push({ ms: d.getTime(), label: stepMonths >= 12 ? String(d.getUTCFullYear()) : d.toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" }).replace(" ", " ’") });
      d.setUTCMonth(d.getUTCMonth() + stepMonths);
    }
    return out;
  }

  // ---------- loading ----------
  async function load() {
    const res = await fetch(DATA_DIR + "manifest.json", { cache: "no-cache" });
    if (!res.ok) throw new Error(`manifest ${res.status}`);
    manifest = await res.json();
    const loaded = await Promise.all(manifest.series.map(async (m, i) => {
      if (!m.ok) return { ...m, obs: [], color: `var(--s${i + 1})` };
      try {
        const r = await fetch(`${DATA_DIR}${m.id}.json`, { cache: "no-cache" });
        if (!r.ok) throw new Error(r.status);
        const j = await r.json();
        return { ...m, obs: j.obs, color: `var(--s${i + 1})` };
      } catch (e) {
        return { ...m, ok: false, error: `could not load ${m.id}.json`, obs: [], color: `var(--s${i + 1})` };
      }
    }));
    series = loaded.map((s) => ({ ...s, monthly: toMonthly(s.obs) }));
  }

  // ---------- header + notices ----------
  function renderHeader() {
    const good = series.filter((s) => s.ok && s.obs.length);
    const resin = good.find((s) => s.key === "resin") || good[0];
    $("#asofData").textContent = resin ? (resin.freq === "monthly" ? fmtMonth(resin.obs.at(-1)[0]) : fmtDay(resin.obs.at(-1)[0])) : "—";
    $("#asofRefresh").textContent = manifest?.generated ? fmtStamp(manifest.generated) : "—";
    const problems = series.filter((s) => s.error);
    const notice = $("#notice");
    if (problems.length) {
      notice.hidden = false;
      notice.classList.toggle("error", problems.some((s) => !s.ok));
      notice.textContent = problems.map((s) => `${s.short}: ${s.error}`).join(" · ");
    } else notice.hidden = true;
  }

  // ---------- knobs ----------
  function renderKnobs() {
    for (const b of $("#rangeSeg").children) b.setAttribute("aria-pressed", String(b.dataset.range === state.range));
    for (const b of $("#viewSeg").children) b.setAttribute("aria-pressed", String(b.dataset.view === state.view));
    const chips = $("#chips");
    chips.innerHTML = series.map((s) => `
      <button type="button" class="chip" data-key="${esc(s.key)}" style="--c:${s.color}" aria-pressed="${!state.off.includes(s.key)}" ${s.ok ? "" : "disabled"}>
        <span class="dot"></span>${esc(s.short)}
      </button>`).join("");
    const lag = $("#lag");
    lag.value = state.lag;
    lag.disabled = state.view !== "overlay";
    $("#lagOut").textContent = `${state.lag} month${state.lag === 1 ? "" : "s"}`;
    $("#tableBtn").setAttribute("aria-pressed", String(state.table));
    $("#tableBtn").textContent = state.table ? "Hide table" : "Show table";
  }
  function wireKnobs() {
    $("#rangeSeg").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; state.range = b.dataset.range; update(); });
    $("#viewSeg").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; state.view = b.dataset.view; update(); });
    $("#chips").addEventListener("click", (e) => {
      const b = e.target.closest(".chip"); if (!b) return;
      const key = b.dataset.key;
      const on = series.filter((s) => s.ok && !state.off.includes(s.key)).map((s) => s.key);
      if (state.off.includes(key)) state.off = state.off.filter((k) => k !== key);
      else if (on.length > 1) state.off = [...state.off, key];   // keep at least one line
      update();
    });
    $("#lag").addEventListener("input", (e) => { state.lag = +e.target.value; update(); });
    $("#tableBtn").addEventListener("click", () => { state.table = !state.table; update(); });
    let t; window.addEventListener("resize", () => { clearTimeout(t); t = setTimeout(() => { renderSimple(); renderChart(); }, 120); });
  }

  // ---------- stat tiles ----------
  function renderTiles() {
    $("#tiles").innerHTML = series.map((s) => {
      if (!s.ok || !s.obs.length) return `<article class="tile" style="--c:${s.color}"><div class="tile-name"><span class="dot"></span>${esc(s.short)}</div><div class="tile-value">—</div><div class="tile-units">${esc(s.units)}</div><div class="deltas"></div><div class="tile-foot">${esc(s.error || "no data yet")}</div></article>`;
      const last = s.obs.at(-1);
      const lastD = toDate(last[0]);
      const m1 = valueOnOrBefore(s.obs, iso(new Date(lastD.getTime() - MONTH_MS)));
      const y1 = valueOnOrBefore(s.obs, iso(new Date(Date.UTC(lastD.getUTCFullYear() - 1, lastD.getUTCMonth(), lastD.getUTCDate()))));
      const spark = s.monthly.slice(-24);
      return `<article class="tile" style="--c:${s.color}">
        <div class="tile-name"><span class="dot"></span>${esc(s.short)}</div>
        <div class="tile-value">${fmtVal(last[1], s)}</div>
        <div class="tile-units">${esc(s.units)}</div>
        <div class="deltas">
          <span><span class="lbl">1 mo</span> <b>${fmtPct(pctChange(last, m1))}</b></span>
          <span><span class="lbl">12 mo</span> <b>${fmtPct(pctChange(last, y1))}</b></span>
        </div>
        ${sparkline(spark, s.color)}
        <div class="tile-foot">${s.freq === "monthly" ? fmtMonth(last[0]) : fmtDay(last[0])} · ${s.freq} · <span title="${esc(s.role)}">${esc(s.role)}</span></div>
      </article>`;
    }).join("");
  }
  function sparkline(pts, color) {
    if (pts.length < 2) return `<svg class="spark" viewBox="0 0 200 44" aria-hidden="true"></svg>`;
    const W = 200, H = 44, pad = 4;
    const vs = pts.map((p) => p[1]);
    const min = Math.min(...vs), max = Math.max(...vs), span = max - min || 1;
    const x = (i) => pad + (i / (pts.length - 1)) * (W - pad * 2);
    const y = (v) => H - pad - ((v - min) / span) * (H - pad * 2);
    const d = pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p[1]).toFixed(1)}`).join("");
    const last = pts.length - 1;
    return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
      <path d="${d}L${x(last).toFixed(1)},${H}L${x(0).toFixed(1)},${H}Z" fill="${color}" opacity=".08"/>
      <path d="${d}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
      <circle cx="${x(last).toFixed(1)}" cy="${y(pts[last][1]).toFixed(1)}" r="3" fill="${color}" stroke="var(--surface)" stroke-width="1.5" vector-effect="non-scaling-stroke"/>
    </svg>`;
  }

  // ---------- main chart ----------
  function activeSeries() { return series.filter((s) => s.ok && s.obs.length && !state.off.includes(s.key)); }
  function windowBounds(list) {
    const endMs = Math.max(...list.map((s) => toDate(s.obs.at(-1)[0]).getTime()));
    const years = RANGE_YEARS[state.range];
    let startMs = years === Infinity ? Math.min(...list.map((s) => toDate(s.obs[0][0]).getTime())) : (() => { const d = new Date(endMs); d.setUTCFullYear(d.getUTCFullYear() - years); return d.getTime(); })();
    return { startMs, endMs };
  }

  function renderChart() {
    const list = activeSeries();
    const chart = $("#chart"), legend = $("#legend"), table = $("#table");
    legend.innerHTML = list.length > 1 ? list.map((s) => `<li style="--c:${s.color}"><span class="swatch"></span>${esc(s.label)}</li>`).join("") : "";
    if (!list.length) { chart.innerHTML = `<div class="empty">Pick at least one line above.</div>`; table.hidden = true; return; }
    const { startMs, endMs } = windowBounds(list);
    const rangeWord = state.range === "all" ? "all available history" : `the last ${RANGE_YEARS[state.range]} year${RANGE_YEARS[state.range] > 1 ? "s" : ""}`;

    if (state.view === "overlay") {
      // Everything monthly, feedstocks shifted, indexed to 100 at the common start.
      const prepared = list.map((s) => {
        const shifted = s.freq === "daily" ? shiftMonths(s.monthly, state.lag) : s.monthly;
        return { s, pts: shifted.filter((p) => { const t = toDate(p[0]).getTime(); return t >= startMs && t <= endMs; }) };
      }).filter((p) => p.pts.length > 1);
      const commonStart = Math.max(...prepared.map((p) => toDate(p.pts[0][0]).getTime()));
      const indexed = prepared.map(({ s, pts }) => {
        const cut = pts.filter((p) => toDate(p[0]).getTime() >= commonStart);
        const base = cut[0][1];
        return { s, raw: cut, pts: cut.map(([d, v]) => [d, (v / base) * 100]) };
      });
      const lagNote = state.lag ? ` Oil and gas are shifted forward ${state.lag} month${state.lag > 1 ? "s" : ""}, so a peak in gas is drawn where resin would feel it later.` : "";
      $("#chartTitle").textContent = `Everything rebased to 100 at ${fmtMonth(iso(new Date(commonStart)))}`;
      $("#chartSub").textContent = `Percent moves over ${rangeWord}, on one scale. Daily oil and gas are averaged by month to match the monthly indexes.${lagNote}`;
      chart.innerHTML = lineChart(indexed, { startMs: commonStart, endMs, indexed: true });
      wireHover(chart, indexed, { indexed: true });
      renderTable(indexed, true);
    } else {
      $("#chartTitle").textContent = `Actual prices over ${rangeWord}`;
      $("#chartSub").textContent = "Each line on its own scale, in its own units. Daily series stay daily here.";
      const cards = list.map((s) => {
        const pts = s.obs.filter((p) => { const t = toDate(p[0]).getTime(); return t >= startMs && t <= endMs; });
        return { s, pts, raw: pts };
      }).filter((p) => p.pts.length > 1);
      // Two passes: lay the cards out first, then size each chart to its own column.
      chart.innerHTML = `<div class="multiples">${cards.map((c) => `
        <div class="multiple" style="--c:${c.s.color}" data-key="${esc(c.s.key)}">
          <h3><span class="dot"></span>${esc(c.s.label)}</h3>
          <p class="units">${esc(c.s.units)}</p>
          <div class="plot"></div>
        </div>`).join("")}</div>`;
      for (const el of chart.querySelectorAll(".multiple")) {
        const c = cards.find((x) => x.s.key === el.dataset.key);
        const plot = el.querySelector(".plot");
        plot.innerHTML = lineChart([c], { startMs, endMs, indexed: false, height: 220, width: el.clientWidth });
        wireHover(el, [c], { indexed: false });
      }
      renderTable(cards.map((c) => ({ s: c.s, pts: toMonthly(c.pts), raw: toMonthly(c.pts) })), false);
    }
    table.hidden = !state.table;
  }

  function lineChart(items, { startMs, endMs, indexed, height, width, markers, endLabel }) {
    const W = Math.max(280, width || $("#chart").clientWidth || 800);
    const H = height || Math.min(420, Math.max(260, Math.round(W * 0.42)));
    const M = { t: 16, r: indexed ? (W < 640 ? 92 : 118) : endLabel ? 64 : 16, b: 30, l: 52 };
    const iw = W - M.l - M.r, ih = H - M.t - M.b;
    const all = items.flatMap((it) => it.pts.map((p) => p[1]));
    let { lo, hi, ticks } = niceTicks(Math.min(...all), Math.max(...all), 5);
    if (indexed) { lo = Math.min(lo, Math.floor(Math.min(...all, 100) / 10) * 10); }
    const x = (ms) => M.l + ((ms - startMs) / Math.max(1, endMs - startMs)) * iw;
    const y = (v) => M.t + ih - ((v - lo) / (hi - lo || 1)) * ih;
    const grid = ticks.map((t) => `<line x1="${M.l}" x2="${W - M.r}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"/>`).join("");
    const yLabels = ticks.map((t) => `<text x="${M.l - 8}" y="${(y(t) + 4).toFixed(1)}" text-anchor="end">${indexed ? t : fmtAxis(t)}</text>`).join("");
    // Thin the month labels until they have ~60px each, so narrow screens never overlap.
    const allTicks = xTicks(startMs, endMs);
    const every = Math.max(1, Math.ceil((allTicks.length * 60) / iw));
    const xt = allTicks.filter((_, i) => i % every === 0).map((t) => `<text x="${x(t.ms).toFixed(1)}" y="${H - 8}" text-anchor="middle">${t.label}</text>`).join("");
    const hundred = indexed && 100 >= lo && 100 <= hi ? `<line class="hundred" x1="${M.l}" x2="${W - M.r}" y1="${y(100).toFixed(1)}" y2="${y(100).toFixed(1)}"/>` : "";
    const paths = items.map(({ s, pts }) => {
      const d = pts.map((p, i) => `${i ? "L" : "M"}${x(toDate(p[0]).getTime()).toFixed(1)},${y(p[1]).toFixed(1)}`).join("");
      const last = pts.at(-1);
      const dots = markers ? pts.slice(0, -1).map((p) => `<circle class="pt" cx="${x(toDate(p[0]).getTime()).toFixed(1)}" cy="${y(p[1]).toFixed(1)}" r="3" fill="${s.color}"/>`).join("") : "";
      return `<g class="series" data-key="${esc(s.key)}"><path d="${d}" stroke="${s.color}"/>${dots}<circle class="end" cx="${x(toDate(last[0]).getTime()).toFixed(1)}" cy="${y(last[1]).toFixed(1)}" r="4" fill="${s.color}"/></g>`;
    }).join("");
    // Direct end labels, nudged apart so they never overlap.
    let labels = "";
    if (indexed) {
      const ends = items.map(({ s, pts }) => ({ s, v: pts.at(-1)[1], y: y(pts.at(-1)[1]) })).sort((a, b) => a.y - b.y);
      for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 15) ends[i].y = ends[i - 1].y + 15;
      for (let i = ends.length - 1; i >= 0; i--) { const maxY = M.t + ih; if (ends[i].y > maxY) ends[i].y = maxY; if (i < ends.length - 1 && ends[i + 1].y - ends[i].y < 15) ends[i].y = ends[i + 1].y - 15; }
      labels = ends.map((e) => `<text class="endlabel" x="${W - M.r + 10}" y="${(e.y + 4).toFixed(1)}">${esc(e.s.short)} <tspan fill="var(--ink-3)" font-weight="400">${fmtIdx(e.v)}</tspan></text>`).join("");
    } else if (endLabel) {
      labels = items.map(({ s, pts }) => { const last = pts.at(-1); return `<text class="endlabel" x="${(x(toDate(last[0]).getTime()) + 10).toFixed(1)}" y="${(y(last[1]) + 4).toFixed(1)}">${fmtVal(last[1], s)}</text>`; }).join("");
    }
    return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${indexed ? "Indexed comparison chart" : "Price chart"}" data-l="${M.l}" data-r="${M.r}" data-w="${W}" data-h="${H}" data-t="${M.t}" data-ih="${ih}" data-start="${startMs}" data-end="${endMs}" data-lo="${lo}" data-hi="${hi}">
      <g class="grid">${grid}</g>
      <g class="axis">${yLabels}${xt}<line class="baseline" x1="${M.l}" x2="${W - M.r}" y1="${(M.t + ih).toFixed(1)}" y2="${(M.t + ih).toFixed(1)}"/>${hundred}</g>
      ${paths}
      ${labels}
      <g class="crosshair is-hidden"><line y1="${M.t}" y2="${M.t + ih}" x1="0" x2="0"/>${items.map((it) => `<circle r="4.5" stroke="${it.s.color}" data-key="${esc(it.s.key)}"/>`).join("")}</g>
      <rect class="hit" x="${M.l}" y="${M.t}" width="${iw}" height="${ih}"/>
    </svg>`;
  }
  function fmtAxis(t) { return Math.abs(t) >= 1000 ? (t / 1000).toFixed(1) + "k" : Number.isInteger(t) ? String(t) : t.toFixed(t < 10 ? 2 : 1); }

  function wireHover(host, items, { indexed }) {
    const svg = host.querySelector("svg");
    if (!svg) return;
    const hit = svg.querySelector(".hit"), cross = svg.querySelector(".crosshair"), line = cross.querySelector("line");
    const tip = document.createElement("div"); tip.className = "tip"; tip.hidden = true; host.appendChild(tip);
    const d = svg.dataset, L = +d.l, W = +d.w, R = +d.r, T = +d.t, IH = +d.ih, S = +d.start, E = +d.end, LO = +d.lo, HI = +d.hi;
    const iw = W - L - R;
    const xOf = (ms) => L + ((ms - S) / Math.max(1, E - S)) * iw;
    const yOf = (v) => T + IH - ((v - LO) / (HI - LO || 1)) * IH;
    const times = items.map((it) => it.pts.map((p) => toDate(p[0]).getTime()));
    function nearest(arr, ms) { let lo = 0, hi = arr.length - 1; while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < ms) lo = mid + 1; else hi = mid; } if (lo > 0 && Math.abs(arr[lo - 1] - ms) < Math.abs(arr[lo] - ms)) lo--; return lo; }
    function move(ev) {
      const rect = svg.getBoundingClientRect();
      const px = ((ev.clientX - rect.left) / rect.width) * W;
      const ms = S + ((px - L) / iw) * (E - S);
      // Anchor on the first series' nearest point; look others up at the same time.
      const i0 = nearest(times[0], ms);
      const anchorMs = times[0][i0];
      const cx = xOf(anchorMs);
      line.setAttribute("x1", cx); line.setAttribute("x2", cx);
      const rows = items.map((it, k) => {
        const idx = nearest(times[k], anchorMs);
        const pt = it.pts[idx], raw = it.raw ? it.raw[idx] : pt;
        const far = Math.abs(times[k][idx] - anchorMs) > 20 * 86400000;
        const c = cross.querySelector(`circle[data-key="${it.s.key}"]`);
        if (c) { c.classList.toggle("is-hidden", far); c.setAttribute("cx", xOf(times[k][idx])); c.setAttribute("cy", yOf(pt[1])); }
        if (far) return "";
        const main = indexed ? fmtIdx(pt[1]) : fmtVal(pt[1], it.s);
        const sub = indexed ? `<span class="u">${fmtVal(raw[1], it.s)} ${esc(it.s.units.replace(/^PPI, .*$/, "PPI").replace(/^\$ ?/, ""))}</span>` : "";
        return `<div class="row" style="--c:${it.s.color}"><span class="dot"></span><span>${esc(it.s.short)} ${sub}</span><span class="v">${main}</span></div>`;
      }).join("");
      const dateStr = items[0].pts[i0][0];
      tip.innerHTML = `<div class="tip-date">${items[0].s.freq === "daily" && !indexed ? fmtDay(dateStr) : fmtMonth(dateStr)}</div>${rows}`;
      tip.hidden = false; cross.classList.remove("is-hidden");
      const hostRect = host.getBoundingClientRect();
      const tipW = tip.offsetWidth || 200;
      let left = ((cx / W) * rect.width) + (rect.left - hostRect.left) + 14;
      if (left + tipW > hostRect.width - 4) left = ((cx / W) * rect.width) + (rect.left - hostRect.left) - tipW - 14;
      tip.style.left = `${Math.max(0, left)}px`;
      tip.style.top = `${(rect.top - hostRect.top) + (T / W) * rect.width + 8}px`;
    }
    function leave() { tip.hidden = true; cross.classList.add("is-hidden"); }
    hit.addEventListener("pointermove", move);
    hit.addEventListener("pointerdown", move);
    hit.addEventListener("pointerleave", leave);
  }

  function renderTable(items, indexed) {
    const el = $("#table");
    if (!items.length) { el.innerHTML = ""; return; }
    const months = [...new Set(items.flatMap((it) => it.pts.map((p) => p[0].slice(0, 7))))].sort().reverse();
    const lookup = items.map((it) => new Map(it.pts.map((p, i) => [p[0].slice(0, 7), { v: p[1], raw: it.raw ? it.raw[i][1] : p[1] }])));
    const head = items.map((it) => `<th>${esc(it.s.short)}${indexed ? "<br><small>index · actual</small>" : `<br><small>${esc(it.s.units)}</small>`}</th>`).join("");
    const rows = months.map((m) => `<tr><td>${fmtMonth(m + "-01")}</td>${items.map((it, k) => { const e = lookup[k].get(m); if (!e) return "<td>—</td>"; return indexed ? `<td>${fmtIdx(e.v)} <small style="color:var(--ink-3)">· ${fmtVal(e.raw, it.s)}</small></td>` : `<td>${fmtVal(e.v, it.s)}</td>`; }).join("")}</tr>`).join("");
    el.innerHTML = `<table><thead><tr><th>Month</th>${head}</tr></thead><tbody>${rows}</tbody></table>`;
  }

  // ---------- the simple view: resin index, last 24 months, one point per month ----------
  function renderSimple() {
    const sec = $("#simple");
    const s = series.find((x) => x.key === "resin" && x.ok && x.obs.length) || series.find((x) => x.ok && x.freq === "monthly");
    if (!s) { sec.hidden = true; return; }
    sec.hidden = false;
    const pts = s.monthly.slice(-24);
    const last = pts.at(-1), prev = pts.at(-2), yearAgo = pts.length >= 13 ? pts.at(-13) : null;
    const word = (p) => (p == null ? "unchanged" : p > 0.05 ? `up ${Math.abs(p).toFixed(1)}%` : p < -0.05 ? `down ${Math.abs(p).toFixed(1)}%` : "flat");
    $("#simpleTitle").textContent = `Resin prices are ${word(pctChange(last, yearAgo))} from a year ago and ${word(pctChange(last, prev))} from the month before.`;
    $("#simpleSub").textContent = `${fmtMonth(last[0])}: ${fmtVal(last[1], s)} on the ${s.label.toLowerCase()} index (${s.units}). Showing ${fmtMonth(pts[0][0])} to ${fmtMonth(last[0])}, one point per month.`;
    $("#simpleFoot").textContent = `Producer Price Index for thermoplastic resins, U.S. Bureau of Labor Statistics. A new month is added automatically around the middle of each month, when the previous month's number is published.`;
    const host = $("#simpleChart");
    const item = { s, pts, raw: pts };
    host.innerHTML = lineChart([item], { startMs: toDate(pts[0][0]).getTime(), endMs: toDate(last[0]).getTime(), indexed: false, height: 300, width: host.clientWidth, markers: true, endLabel: true });
    wireHover(host, [item], { indexed: false });
  }

  // ---------- learn panel ----------
  function renderAbout() {
    $("#about").innerHTML = series.map((s) => `
      <div style="--c:${s.color}">
        <dt><span class="dot"></span>${esc(s.label)} <small>· ${esc(s.units)}, ${esc(s.freq)}</small></dt>
        <dd>${esc(s.note)} <a href="${esc(s.url)}" rel="noopener">${esc(s.id)} on FRED</a></dd>
      </div>`).join("");
  }

  // ---------- update loop ----------
  function update() { save(); renderKnobs(); renderChart(); }

  async function main() {
    wireKnobs();
    try {
      await load();
    } catch (err) {
      $("#chartTitle").textContent = "No data yet";
      $("#chartSub").textContent = "";
      $("#chart").innerHTML = `<div class="empty"><p>The first data pull has not run. In the repository, open <strong>Actions → Update data and publish → Run workflow</strong>, or run <code>node scripts/fetch-data.mjs</code> locally and commit the <code>docs/data</code> folder.</p><p style="color:var(--ink-3)">(${esc(err.message)})</p></div>`;
      $("#asofData").textContent = "—"; $("#asofRefresh").textContent = "—";
      $("#simple").hidden = true;
      return;
    }
    // drop knobs that no longer match the series list
    state.off = state.off.filter((k) => series.some((s) => s.key === k));
    if (!RANGE_YEARS[state.range]) state.range = defaults.range;
    renderHeader(); renderSimple(); renderTiles(); renderAbout(); renderKnobs(); renderChart();
  }
  main();
})();
