// Zyven analytics dashboard. Plain DOM; all data is inserted with textContent.

const $ = (id) => document.getElementById(id);
const tz = -new Date().getTimezoneOffset();
const state = { days: Number(localStorage.getItem("zyven-dash:days") || 7), tab: "overview", oldestEvent: null, oldestConv: null };
const SVG = "http://www.w3.org/2000/svg";

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = String(v);
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids) if (kid != null && kid !== false) el.append(kid);
  return el;
}
function s(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, String(v));
  for (const kid of kids) if (kid != null) el.append(kid);
  return el;
}

const nf = new Intl.NumberFormat();
const num = (n) => (n == null ? "–" : nf.format(n));
function dur(ms) {
  if (ms == null) return "–";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(sec < 10 ? 1 : 0)} s`;
  const m = Math.floor(sec / 60), r = Math.round(sec % 60);
  if (m < 60) return `${m}m ${r}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const dateTimeFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
function when(ts) {
  const d = new Date(ts);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return d >= today ? timeFmt.format(d) : dateTimeFmt.format(d);
}
function ago(ts) {
  const s_ = Math.round((Date.now() - ts) / 1000);
  if (s_ < 60) return "just now";
  if (s_ < 3600) return `${Math.floor(s_ / 60)} min ago`;
  if (s_ < 86400) return `${Math.floor(s_ / 3600)} h ago`;
  return dateTimeFmt.format(new Date(ts));
}
function visitorTag(v) {
  if (!v) return h("span", { class: "muted", text: "–" });
  let hash = 0;
  for (const c of v) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  const el = h("span", { class: "vtag", text: v.slice(0, 6), title: v });
  el.style.setProperty("--h", String(hash % 360));
  return el;
}
function parseProps(p) { try { return p ? JSON.parse(p) : {}; } catch { return {}; } }

const EVENT_NAMES = {
  page_view: "Opened the site", click: "Clicked", message_sent: "Sent a message", reply_done: "Got a reply",
  reply_error: "Reply failed", api_chat: "Model request", chat_new: "Started a new chat", chat_deleted: "Deleted a chat",
  chat_renamed: "Renamed a chat", message_edited: "Edited a message", regenerate: "Regenerated a reply", stop: "Stopped a reply",
  copy: "Copied text", search: "Searched chats", settings_open: "Opened settings", settings_saved: "Saved settings",
  theme_changed: "Changed theme", about_open: "Opened About", link_out: "Followed a link", sidebar_toggle: "Toggled sidebar",
  tab_hidden: "Left the tab", tab_visible: "Came back to the tab", heartbeat: "Still active", connected: "Connected to model",
  connection_failed: "Couldn't connect", js_error: "Page error", analytics_opt_out: "Turned off analytics",
};
const label = (n) => EVENT_NAMES[n] || n.replace(/_/g, " ");

async function api(path) {
  const res = await fetch(`/analytics/api/${path}`, { headers: { Accept: "application/json" }, cache: "no-store" });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

function toast(text) {
  const t = $("toast");
  t.textContent = text; t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 2500);
}

// ---------------------------------------------------------------- overview

const KPI_DEFS = [
  ["visitors", "Visitors", (k) => `${num(k.new_visitors)} new`],
  ["sessions", "Sessions", (k) => `${num(k.pageviews)} page views`],
  ["messages", "Messages sent", (k) => `${k.msgs_per_session} per session`],
  ["replies", "Replies delivered", (k) => `${num(k.tokens)} tokens, ${num(k.stopped)} stopped`],
  ["avg_session_s", "Avg. session length", null, (v) => dur(v * 1000)],
  ["clicks", "Clicks", null],
  ["errors", "Failed replies", (k) => (k.replies + k.errors ? `${((k.errors / (k.replies + k.errors)) * 100).toFixed(1)}% of requests` : "No requests"), null, true],
];

function renderKpis(d) {
  const box = $("kpis");
  box.replaceChildren();
  for (const [key, name, sub, fmt, lowerIsBetter] of KPI_DEFS) {
    const cur = d.kpis[key] ?? 0, prev = d.prev[key] ?? 0;
    let delta = null;
    if (prev > 0) delta = ((cur - prev) / prev) * 100;
    else if (cur > 0) delta = Infinity;
    const good = delta == null ? null : lowerIsBetter ? delta <= 0 : delta >= 0;
    box.append(h("div", { class: "kpi" },
      h("span", { class: "kpi-name", text: name }),
      h("span", { class: "kpi-value", text: fmt ? fmt(cur) : num(cur) }),
      h("span", { class: "kpi-foot" },
        delta == null || delta === 0 ? h("span", { class: "delta", text: "No change" })
          : h("span", { class: `delta ${good ? "up" : "down"}`, text: delta === Infinity ? "New" : `${delta > 0 ? "+" : ""}${delta.toFixed(0)}%` }),
        sub ? h("span", { class: "kpi-sub", text: sub(d.kpis) }) : null),
    ));
  }
}

const SERIES = [
  { key: "visitors", name: "Visitors", cls: "s1" },
  { key: "messages", name: "Messages", cls: "s2" },
  { key: "errors", name: "Errors", cls: "s3" },
];

function renderChart(d) {
  const box = $("chart");
  box.replaceChildren();
  $("legend").replaceChildren(...SERIES.map((x) => h("span", { class: `lg ${x.cls}` }, h("i"), x.name)));
  const pts = d.timeseries;
  const W = Math.max(320, box.clientWidth || 800), H = 260, padL = 36, padR = 12, padT = 12, padB = 28;
  const max = Math.max(4, ...pts.flatMap((p) => SERIES.map((x) => p[x.key])));
  const niceMax = Math.ceil(max / 4) * 4;
  const x = (i) => padL + (pts.length <= 1 ? 0 : (i * (W - padL - padR)) / (pts.length - 1));
  const y = (v) => padT + (H - padT - padB) * (1 - v / niceMax);
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart-svg", role: "img", "aria-label": "Visitors, messages and errors over time" });

  for (let i = 0; i <= 4; i++) {
    const v = (niceMax / 4) * i;
    svg.append(s("line", { x1: padL, x2: W - padR, y1: y(v), y2: y(v), class: "grid-line" }));
    svg.append(s("text", { x: padL - 8, y: y(v) + 4, class: "axis", "text-anchor": "end" }, document.createTextNode(num(v))));
  }
  const fmt = d.hourly ? new Intl.DateTimeFormat(undefined, { hour: "numeric" }) : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
  const every = Math.max(1, Math.ceil(pts.length / Math.floor((W - padL) / 70)));
  pts.forEach((p, i) => {
    if (i % every === 0) svg.append(s("text", { x: x(i), y: H - 8, class: "axis", "text-anchor": "middle" }, document.createTextNode(fmt.format(new Date(p.t)))));
  });
  for (const ser of SERIES) {
    const line = pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p[ser.key]).toFixed(1)}`).join("");
    if (ser.key === "visitors" && pts.length > 1) {
      svg.append(s("path", { d: `${line}L${x(pts.length - 1)},${y(0)}L${x(0)},${y(0)}Z`, class: `area ${ser.cls}` }));
    }
    svg.append(s("path", { d: line, class: `line ${ser.cls}` }));
  }
  const cursor = s("line", { y1: padT, y2: H - padB, class: "cursor", visibility: "hidden" });
  const dots = SERIES.map((ser) => { const c = s("circle", { r: 4, class: `dot ${ser.cls}`, visibility: "hidden" }); svg.append(c); return c; });
  svg.append(cursor);
  const tip = h("div", { class: "tip", hidden: true });
  svg.addEventListener("pointermove", (e) => {
    const r = svg.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(pts.length - 1, Math.round(((px - padL) / (W - padL - padR)) * (pts.length - 1))));
    const p = pts[i];
    cursor.setAttribute("x1", x(i)); cursor.setAttribute("x2", x(i)); cursor.setAttribute("visibility", "visible");
    SERIES.forEach((ser, k) => { dots[k].setAttribute("cx", x(i)); dots[k].setAttribute("cy", y(p[ser.key])); dots[k].setAttribute("visibility", "visible"); });
    tip.replaceChildren(h("strong", { text: (d.hourly ? new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "numeric" }) : new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" })).format(new Date(p.t)) }),
      ...SERIES.map((ser) => h("span", { class: `lg ${ser.cls}` }, h("i"), `${ser.name}: ${num(p[ser.key])}`)),
      h("span", { class: "muted", text: `Page views: ${num(p.pageviews)}` }));
    tip.hidden = false;
    const left = (x(i) / W) * r.width;
    tip.style.left = `${Math.min(r.width - 170, Math.max(0, left + 12))}px`;
  });
  svg.addEventListener("pointerleave", () => { tip.hidden = true; cursor.setAttribute("visibility", "hidden"); dots.forEach((c) => c.setAttribute("visibility", "hidden")); });
  box.append(svg, tip);
  if (!pts.some((p) => p.visitors || p.messages)) box.append(h("p", { class: "empty-over", text: "No visits in this period yet." }));
}

function bars(id, rows, opts = {}) {
  const box = $(id);
  box.replaceChildren();
  if (!rows || !rows.length) { box.append(h("p", { class: "empty", text: opts.empty || "Nothing recorded yet." })); return; }
  const max = Math.max(...rows.map((r) => r.count));
  const total = rows.reduce((a, r) => a + r.count, 0);
  const list = h("ul", { class: "bars" });
  for (const r of rows) {
    const bar = h("span", { class: "bar-fill" });
    bar.style.width = `${(r.count / max) * 100}%`;
    list.append(h("li", { class: "bar-row", title: `${r.key}: ${num(r.count)}` },
      bar,
      h("span", { class: "bar-key", text: opts.map ? opts.map(r.key) : r.key }),
      h("span", { class: "bar-val", text: opts.pct ? `${Math.round((r.count / total) * 100)}%` : num(r.count) })));
  }
  box.append(list);
}

function renderClicks(rows) {
  const box = $("clicks");
  box.replaceChildren();
  if (!rows.length) { box.append(h("p", { class: "empty", text: "No clicks recorded yet." })); return; }
  const max = Math.max(...rows.map((r) => r.count));
  const tbody = h("tbody");
  for (const r of rows) {
    const bar = h("span", { class: "bar-fill" });
    bar.style.width = `${(r.count / max) * 100}%`;
    tbody.append(h("tr", {},
      h("td", { class: "bar-cell" }, bar, h("span", { class: "bar-key", text: r.label })),
      h("td", {}, r.area ? h("span", { class: "chip", text: r.area }) : ""),
      h("td", { class: "num", text: num(r.count) }),
      h("td", { class: "num muted", text: num(r.visitors) })));
  }
  box.append(h("div", { class: "table-wrap" }, h("table", { class: "table compact" },
    h("thead", {}, h("tr", {}, h("th", { text: "Button or link" }), h("th", { text: "Area" }), h("th", { class: "num", text: "Clicks" }), h("th", { class: "num", text: "People" }))), tbody)));
}

function renderPerf(p) {
  const rows = [
    ["Time to first word (median)", dur(p.ttft_p50)],
    ["Time to first word (slowest 5%)", dur(p.ttft_p95)],
    ["Full reply time (median)", dur(p.duration_p50)],
    ["Full reply time (slowest 5%)", dur(p.duration_p95)],
    ["Generation speed (median)", p.tps_p50 != null ? `${p.tps_p50} tokens/s` : "–"],
    ["Average reply length", p.tokens_avg != null ? `${p.tokens_avg} tokens` : "–"],
  ];
  const finish = (p.finish || []).map((f) => `${f.key === "length" ? "Hit length limit" : f.key === "stop" ? "Finished naturally" : f.key}: ${num(f.count)}`).join(", ");
  $("perf").replaceChildren(h("dl", { class: "stats" }, ...rows.map(([k, v]) => h("div", {}, h("dt", { text: k }), h("dd", { text: v })))),
    finish ? h("p", { class: "muted small", text: `How replies ended: ${finish}` }) : "");
}

function renderHeatmap(m) {
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const max = Math.max(1, ...m.flat());
  const grid = h("div", { class: "heat" });
  grid.append(h("span"));
  for (let hr = 0; hr < 24; hr++) grid.append(h("span", { class: "heat-h", text: hr % 3 === 0 ? String(hr).padStart(2, "0") : "" }));
  m.forEach((row, d) => {
    grid.append(h("span", { class: "heat-d", text: days[d] }));
    row.forEach((v, hr) => {
      const cell = h("span", { class: "heat-c", title: `${days[d]} ${String(hr).padStart(2, "0")}:00, ${v} messages` });
      cell.style.setProperty("--a", v ? String(0.15 + 0.85 * (v / max)) : "0");
      grid.append(cell);
    });
  });
  $("heatmap").replaceChildren(h("div", { class: "heat-wrap" }, grid));
}

async function loadOverview() {
  const d = await api(`summary?days=${state.days}&tz=${tz}`);
  $("live-text").textContent = `${d.live} online now`;
  $("live").classList.toggle("on", d.live > 0);
  renderKpis(d);
  renderChart(d);
  renderClicks(d.clicks);
  bars("features", d.features, { map: label, empty: "No feature use yet." });
  bars("suggestions", d.suggestions, { empty: "No suggestions picked yet." });
  renderPerf(d.perf);
  bars("errors", d.errors, { empty: "No failed replies. Nice." });
  renderHeatmap(d.heatmap);
  bars("referrers", d.referrers, { pct: true });
  bars("timezones", d.timezones, { map: (k) => k.replace(/_/g, " ") });
  bars("devices", d.devices, { pct: true });
  bars("browsers", d.browsers, { pct: true });
  bars("os", d.os, { pct: true });
  bars("screens", d.screens, { pct: true });
  bars("languages", d.languages, { pct: true });
  bars("events", d.events, { map: label });
  state.summary = d;
}

// ---------------------------------------------------------------- activity

function detailFor(e) {
  const p = parseProps(e.props);
  switch (e.name) {
    case "click": return e.label || "";
    case "page_view": return [p.ref ? `from ${p.ref}` : "direct visit", p.tz, p.lang].filter(Boolean).join(", ");
    case "message_sent": return `${num(p.chars)} characters${p.suggestion ? `, suggestion: ${p.suggestion}` : ""}`;
    case "reply_done": return `${num(p.tokens)} tokens in ${dur(p.duration_ms)}${p.finish === "length" ? ", hit length limit" : ""}`;
    case "reply_error": return `${p.code || "error"}${p.status ? ` (HTTP ${p.status})` : ""}`;
    case "api_chat": return p.error ? `failed: ${p.error}` : p.stopped ? "stopped by visitor" : `${num(p.tokens)} tokens, first word in ${dur(p.ttft_ms)}, ${p.tokens_per_s ?? "–"} tokens/s`;
    case "search": return `${p.chars} characters, ${p.results} results`;
    case "theme_changed": return `${p.from} to ${p.to}`;
    case "link_out": return p.href || "";
    case "about_open": return `via ${p.via}`;
    case "copy": return p.what || "";
    case "js_error": return p.message || "";
    case "connected": return `${p.ms} ms`;
    default: return e.label || "";
  }
}

function feedRow(e) {
  return h("tr", { class: e.source === "server" ? "server" : "" },
    h("td", { class: "nowrap muted", text: when(e.ts), title: new Date(e.ts).toString() }),
    h("td", { class: "nowrap" }, h("span", { class: `ev ev-${e.name}`, text: label(e.name) })),
    h("td", { class: "detail", text: detailFor(e) }),
    h("td", {}, e.area ? h("span", { class: "chip", text: e.area }) : ""),
    h("td", {}, e.session ? h("button", { class: "linkish", type: "button", onclick: () => openSession(e.session) }, visitorTag(e.visitor)) : visitorTag(e.visitor)),
    h("td", { class: "nowrap muted", text: [e.device, e.os, e.browser].filter(Boolean).join(", ") }));
}

async function loadFeed(older = false) {
  const hb = $("show-heartbeats").checked ? "&heartbeats=1" : "";
  const rows = await api(`events?limit=150${older && state.oldestEvent ? `&before=${state.oldestEvent}` : ""}${hb}`);
  const body = $("feed").tBodies[0];
  if (!older) body.replaceChildren();
  if (!rows.length && !older) body.append(h("tr", {}, h("td", { colspan: 6, class: "empty", text: "No activity recorded yet." })));
  for (const e of rows) body.append(feedRow(e));
  if (rows.length) state.oldestEvent = rows[rows.length - 1].id;
  $("feed-more").hidden = rows.length < 150;
}

// ---------------------------------------------------------------- sessions

async function loadSessions() {
  const rows = await api(`sessions?days=${state.days}&limit=200`);
  const body = $("sessions").tBodies[0];
  body.replaceChildren();
  if (!rows.length) { body.append(h("tr", {}, h("td", { colspan: 8, class: "empty", text: "No sessions in this period." }))); return; }
  for (const r of rows) {
    const tr = h("tr", { tabindex: "0", onclick: () => openSession(r.session), onkeydown: (e) => { if (e.key === "Enter") openSession(r.session); } },
      h("td", { class: "nowrap", text: when(r.start) }),
      h("td", { class: "nowrap", text: dur(r.end - r.start) }),
      h("td", {}, visitorTag(r.visitor)),
      h("td", { class: "nowrap muted", text: [r.device, r.os, r.browser].filter(Boolean).join(", ") }),
      h("td", { class: "muted", text: (r.tz || "").replace(/_/g, " ") || "–" }),
      h("td", { class: "muted", text: r.ref || "Direct" }),
      h("td", { class: "num", text: num(r.messages) }),
      h("td", { class: "num", text: num(r.clicks) }));
    body.append(tr);
  }
}

async function openSession(id) {
  const events = await api(`session?id=${encodeURIComponent(id)}`);
  const list = $("timeline");
  list.replaceChildren();
  if (events.length) {
    const first = events[0].ts, last = events[events.length - 1].ts;
    const msgs = events.filter((e) => e.name === "message_sent").length;
    $("drawer-sub").textContent = `${new Date(first).toLocaleString()}. ${dur(last - first)}, ${msgs} messages, ${events.length} events.`;
    let prev = first;
    for (const e of events) {
      if (e.name === "heartbeat") { prev = e.ts; continue; }
      const gap = e.ts - prev;
      prev = e.ts;
      list.append(h("li", { class: `tl tl-${e.source}` },
        h("span", { class: "tl-time", text: `+${dur(e.ts - first)}` }),
        h("div", { class: "tl-body" },
          h("span", { class: `ev ev-${e.name}`, text: label(e.name) }),
          e.area ? h("span", { class: "chip", text: e.area }) : "",
          h("p", { class: "tl-detail", text: detailFor(e) }),
          gap > 120000 ? h("p", { class: "tl-gap", text: `${dur(gap)} later` }) : "")));
    }
  }
  $("drawer-title").textContent = `Session ${id.slice(0, 6)}`;
  $("drawer").hidden = false; $("scrim").hidden = false;
  $("drawer-close").focus();
}
function closeDrawer() { $("drawer").hidden = true; $("scrim").hidden = true; }

// ---------------------------------------------------------------- conversations

async function loadConversations(older = false) {
  const data = await api(`conversations${older && state.oldestConv ? `?before=${state.oldestConv}` : ""}`);
  const box = $("conversations");
  if (!older) box.replaceChildren();
  if (!data.enabled) {
    box.append(h("article", { class: "card notice" },
      h("h2", { text: "Conversation recording is off" }),
      h("p", { text: "Only anonymous usage is recorded right now: message lengths, speeds and errors, but not what people type. To read prompts and replies here, set ANALYTICS_LOG_PROMPTS=1 on the server. The chat page then tells visitors that conversations are saved." })));
    $("conv-more").hidden = true;
    return;
  }
  if (!data.items.length && !older) box.append(h("p", { class: "empty", text: "No conversations recorded yet." }));
  for (const c of data.items) {
    box.append(h("article", { class: "card convo" },
      h("div", { class: "convo-meta" }, visitorTag(c.visitor), h("span", { class: "muted", text: `${ago(c.ts)}. ${num(c.tokens)} tokens in ${dur(c.duration)}${c.status !== 200 ? `, HTTP ${c.status}` : ""}` }),
        c.session ? h("button", { class: "linkish small", type: "button", text: "View session", onclick: () => openSession(c.session) }) : ""),
      h("p", { class: "convo-q", text: c.prompt || "" }),
      h("p", { class: "convo-a", text: c.reply || "(no reply)" })));
  }
  if (data.items.length) state.oldestConv = data.items[data.items.length - 1].id;
  $("conv-more").hidden = data.items.length < 100;
}

// ---------------------------------------------------------------- shell

async function refresh() {
  state.lastRefresh = Date.now();
  try {
    if (state.tab === "overview") await loadOverview();
    else {
      if (state.tab === "activity") await loadFeed();
      else if (state.tab === "sessions") await loadSessions();
      else if (state.tab === "conversations") await loadConversations();
      const d = await api(`summary?days=1&tz=${tz}`);
      $("live-text").textContent = `${d.live} online now`;
      $("live").classList.toggle("on", d.live > 0);
    }
  } catch (err) {
    toast(`Couldn't load data (${err.message}). Retrying shortly.`);
  }
}

function setTab(tab) {
  state.tab = tab;
  for (const b of $("tabs").querySelectorAll("button")) {
    if (b.dataset.tab === tab) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
  }
  for (const sec of document.querySelectorAll(".tab")) sec.hidden = sec.id !== `tab-${tab}`;
  history.replaceState(null, "", `#${tab}`);
  refresh();
}

function setRange(days) {
  state.days = days;
  localStorage.setItem("zyven-dash:days", String(days));
  for (const b of $("range").querySelectorAll("button")) b.setAttribute("aria-checked", String(Number(b.dataset.days) === days));
  $("export").href = `/analytics/api/export.csv?days=${days}`;
  refresh();
}

document.addEventListener("DOMContentLoaded", () => {
  $("tabs").addEventListener("click", (e) => { const b = e.target.closest("button[data-tab]"); if (b) setTab(b.dataset.tab); });
  $("range").addEventListener("click", (e) => { const b = e.target.closest("button[data-days]"); if (b) setRange(Number(b.dataset.days)); });
  $("feed-more").addEventListener("click", () => loadFeed(true));
  $("conv-more").addEventListener("click", () => loadConversations(true));
  $("show-heartbeats").addEventListener("change", () => loadFeed());
  $("drawer-close").addEventListener("click", closeDrawer);
  $("scrim").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });
  let rt;
  window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => state.summary && state.tab === "overview" && renderChart(state.summary), 150); });

  const initial = location.hash.slice(1);
  state.tab = ["overview", "activity", "sessions", "conversations"].includes(initial) ? initial : "overview";
  for (const b of $("range").querySelectorAll("button")) b.setAttribute("aria-checked", String(Number(b.dataset.days) === state.days));
  $("export").href = `/analytics/api/export.csv?days=${state.days}`;
  setTab(state.tab);
  setInterval(() => {
    const every = state.tab === "activity" ? 10000 : 30000;
    if (document.visibilityState === "visible" && $("drawer").hidden && Date.now() - (state.lastRefresh || 0) >= every) refresh();
  }, 5000);
});
