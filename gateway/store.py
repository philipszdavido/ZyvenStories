"""SQLite storage and reporting queries for Zyven analytics."""
import json
import os
import re
import sqlite3
import threading
import time
from collections import Counter, defaultdict
from statistics import median
from urllib.parse import urlparse

SCHEMA = """
CREATE TABLE IF NOT EXISTS events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts       INTEGER NOT NULL,           -- unix ms (server clock)
  source   TEXT    NOT NULL,           -- 'client' or 'server'
  name     TEXT    NOT NULL,
  visitor  TEXT,
  session  TEXT,
  path     TEXT,
  label    TEXT,
  area     TEXT,
  props    TEXT,                        -- JSON object
  device   TEXT,
  browser  TEXT,
  os       TEXT,
  country  TEXT
);
CREATE INDEX IF NOT EXISTS ev_ts ON events(ts);
CREATE INDEX IF NOT EXISTS ev_name_ts ON events(name, ts);
CREATE INDEX IF NOT EXISTS ev_session ON events(session, ts);
CREATE INDEX IF NOT EXISTS ev_visitor ON events(visitor, ts);

CREATE TABLE IF NOT EXISTS visitors (
  visitor    TEXT PRIMARY KEY,
  first_seen INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        INTEGER NOT NULL,
  visitor   TEXT,
  session   TEXT,
  model     TEXT,
  prompt    TEXT,
  reply     TEXT,
  status    INTEGER,
  tokens    INTEGER,
  duration  INTEGER
);
CREATE INDEX IF NOT EXISTS conv_ts ON conversations(ts);
"""

BOT_RE = re.compile(r"bot|crawl|spider|slurp|facebookexternalhit|preview|monitor|uptime|curl|wget|python-requests|go-http", re.I)
ID_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")


def parse_ua(ua):
    ua = ua or ""
    if re.search(r"iPad|Tablet|Nexus 7|SM-T", ua):
        device = "Tablet"
    elif re.search(r"Mobi|iPhone|Android", ua):
        device = "Mobile"
    else:
        device = "Desktop"

    if re.search(r"Edg/", ua):
        browser = "Edge"
    elif re.search(r"OPR/|Opera", ua):
        browser = "Opera"
    elif re.search(r"SamsungBrowser", ua):
        browser = "Samsung Internet"
    elif re.search(r"Firefox/|FxiOS", ua):
        browser = "Firefox"
    elif re.search(r"CriOS|Chrome/", ua):
        browser = "Chrome"
    elif re.search(r"Safari/", ua):
        browser = "Safari"
    else:
        browser = "Other"

    if re.search(r"iPhone|iPad|iPod", ua):
        os_ = "iOS"
    elif "Android" in ua:
        os_ = "Android"
    elif "Windows" in ua:
        os_ = "Windows"
    elif "Mac OS X" in ua or "Macintosh" in ua:
        os_ = "macOS"
    elif "CrOS" in ua:
        os_ = "ChromeOS"
    elif "Linux" in ua:
        os_ = "Linux"
    else:
        os_ = "Other"
    return device, browser, os_


def is_bot(ua):
    return not ua or bool(BOT_RE.search(ua))


def clean_id(v):
    v = str(v or "")
    return v if ID_RE.match(v) else None


def clip(v, n):
    if v is None:
        return None
    s = str(v)
    return s[:n]


def pct(values, q):
    if not values:
        return None
    s = sorted(values)
    k = min(len(s) - 1, max(0, int(round(q * (len(s) - 1)))))
    return s[k]


class Store:
    def __init__(self, path):
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        self.db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.lock = threading.Lock()
        with self.lock:
            self.db.execute("PRAGMA journal_mode=WAL")
            self.db.execute("PRAGMA synchronous=NORMAL")
            self.db.executescript(SCHEMA)

    # ---------- writes ----------

    def insert_events(self, rows):
        """rows: list of dicts with keys matching the events table."""
        if not rows:
            return
        cols = ("ts", "source", "name", "visitor", "session", "path", "label", "area", "props", "device", "browser", "os", "country")
        values = [tuple(r.get(c) for c in cols) for r in rows]
        seen = {}
        for r in rows:
            v = r.get("visitor")
            if v and r.get("source") == "client":
                lo, hi = seen.get(v, (r["ts"], r["ts"]))
                seen[v] = (min(lo, r["ts"]), max(hi, r["ts"]))
        with self.lock:
            self.db.execute("BEGIN")
            self.db.executemany(f"INSERT INTO events ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})", values)
            for v, (lo, hi) in seen.items():
                self.db.execute(
                    "INSERT INTO visitors(visitor, first_seen, last_seen) VALUES (?,?,?) "
                    "ON CONFLICT(visitor) DO UPDATE SET last_seen=max(last_seen, excluded.last_seen), "
                    "first_seen=min(first_seen, excluded.first_seen)", (v, lo, hi))
            self.db.execute("COMMIT")

    def insert_conversation(self, row):
        with self.lock:
            self.db.execute(
                "INSERT INTO conversations(ts, visitor, session, model, prompt, reply, status, tokens, duration) VALUES (?,?,?,?,?,?,?,?,?)",
                (row["ts"], row.get("visitor"), row.get("session"), row.get("model"), row.get("prompt"),
                 row.get("reply"), row.get("status"), row.get("tokens"), row.get("duration")))

    def prune(self, days):
        cutoff = int(time.time() * 1000) - days * 86_400_000
        with self.lock:
            self.db.execute("DELETE FROM events WHERE ts < ?", (cutoff,))
            self.db.execute("DELETE FROM conversations WHERE ts < ?", (cutoff,))
            self.db.execute("DELETE FROM visitors WHERE last_seen < ?", (cutoff,))

    def _q(self, sql, args=()):
        with self.lock:
            return self.db.execute(sql, args).fetchall()

    # ---------- reports ----------

    def summary(self, days, tz_offset_min):
        now = int(time.time() * 1000)
        span = days * 86_400_000
        start, prev_start = now - span, now - 2 * span
        rows = self._q("SELECT ts, source, name, visitor, session, path, label, area, props, device, browser, os, country "
                       "FROM events WHERE ts >= ? ORDER BY ts", (prev_start,))
        cur = [r for r in rows if r["ts"] >= start]
        prev = [r for r in rows if r["ts"] < start]

        def props(r):
            try:
                return json.loads(r["props"]) if r["props"] else {}
            except ValueError:
                return {}

        def kpis(evs):
            client = [e for e in evs if e["source"] == "client"]
            visitors = {e["visitor"] for e in client if e["visitor"]}
            sessions = defaultdict(list)
            for e in client:
                if e["session"]:
                    sessions[e["session"]].append(e["ts"])
            durations = [max(t) - min(t) for t in sessions.values()]
            msgs = [e for e in evs if e["name"] == "message_sent"]
            chats = [e for e in evs if e["name"] == "api_chat"]
            ok = [e for e in chats if props(e).get("status") == 200 and not props(e).get("error") and not props(e).get("stopped")]
            errs = [e for e in chats if props(e).get("status") != 200 or props(e).get("error")]
            return {
                "visitors": len(visitors),
                "sessions": len(sessions),
                "pageviews": sum(1 for e in evs if e["name"] == "page_view"),
                "messages": len(msgs),
                "replies": len(ok),
                "errors": len(errs),
                "stopped": sum(1 for e in chats if props(e).get("stopped")),
                "clicks": sum(1 for e in evs if e["name"] == "click"),
                "avg_session_s": round(sum(durations) / len(durations) / 1000) if durations else 0,
                "msgs_per_session": round(len(msgs) / len(sessions), 2) if sessions else 0,
                "tokens": sum(int(props(e).get("tokens") or 0) for e in ok),
            }

        k_cur, k_prev = kpis(cur), kpis(prev)
        first_seen = dict(self._q("SELECT visitor, first_seen FROM visitors WHERE last_seen >= ?", (start,)))
        k_cur["new_visitors"] = sum(1 for v, f in first_seen.items() if f >= start)

        # time series
        hourly = days <= 2
        bucket_ms = 3_600_000 if hourly else 86_400_000
        off = tz_offset_min * 60_000

        def bucket(ts):
            return ((ts + off) // bucket_ms) * bucket_ms - off

        first_bucket = bucket(start)
        n = int((bucket(now) - first_bucket) // bucket_ms) + 1
        series = {first_bucket + i * bucket_ms: {"visitors": set(), "messages": 0, "errors": 0, "pageviews": 0} for i in range(n)}
        for e in cur:
            b = series.get(bucket(e["ts"]))
            if b is None:
                continue
            if e["source"] == "client" and e["visitor"]:
                b["visitors"].add(e["visitor"])
            if e["name"] == "message_sent":
                b["messages"] += 1
            if e["name"] == "page_view":
                b["pageviews"] += 1
            if e["name"] == "api_chat" and (props(e).get("status") != 200 or props(e).get("error")):
                b["errors"] += 1
        timeseries = [{"t": t, "visitors": len(v["visitors"]), "messages": v["messages"], "errors": v["errors"], "pageviews": v["pageviews"]}
                      for t, v in sorted(series.items())]

        # breakdowns (unique visitors per dimension, from first event of each visitor)
        first_of_visitor = {}
        for e in cur:
            if e["source"] == "client" and e["visitor"] and e["visitor"] not in first_of_visitor:
                first_of_visitor[e["visitor"]] = e
        pv = [e for e in cur if e["name"] == "page_view"]

        def top(counter, limit=10):
            return [{"key": k or "Unknown", "count": c} for k, c in counter.most_common(limit)]

        devices = Counter(e["device"] for e in first_of_visitor.values())
        browsers = Counter(e["browser"] for e in first_of_visitor.values())
        oses = Counter(e["os"] for e in first_of_visitor.values())
        countries = Counter(e["country"] for e in first_of_visitor.values() if e["country"])
        langs, tzs, screens, refs, landings = Counter(), Counter(), Counter(), Counter(), Counter()
        seen_v = set()
        for e in pv:
            p = props(e)
            refs[p.get("ref") or "Direct"] += 1
            landings[e["path"] or "/"] += 1
            if e["visitor"] in seen_v:
                continue
            seen_v.add(e["visitor"])
            langs[p.get("lang")] += 1
            tzs[p.get("tz")] += 1
            w = int(p.get("sw") or 0)
            screens["Phone (< 600px)" if w < 600 else "Tablet (600–1024px)" if w < 1025 else "Laptop (1025–1440px)" if w < 1441 else "Large (> 1440px)"] += 1

        clicks = Counter()
        click_visitors = defaultdict(set)
        for e in cur:
            if e["name"] == "click":
                key = (e["label"] or "Unlabelled", e["area"] or "")
                clicks[key] += 1
                click_visitors[key].add(e["visitor"])
        top_clicks = [{"label": k[0], "area": k[1], "count": c, "visitors": len(click_visitors[k])} for k, c in clicks.most_common(25)]

        event_counts = Counter(e["name"] for e in cur if e["name"] not in ("click", "heartbeat"))
        suggestions = Counter(props(e).get("suggestion") for e in cur if e["name"] == "message_sent" and props(e).get("suggestion"))
        features = Counter()
        for e in cur:
            if e["name"] in ("chat_new", "chat_renamed", "chat_deleted", "message_edited", "regenerate", "copy", "stop",
                             "search", "settings_saved", "theme_changed", "about_open", "link_out", "sidebar_toggle", "code_copied"):
                features[e["name"]] += 1

        # errors and performance from server-side request log
        chats = [props(e) for e in cur if e["name"] == "api_chat"]
        done = [p for p in chats if p.get("status") == 200 and not p.get("error") and not p.get("stopped")]
        err_codes = Counter((p.get("error") or f"HTTP {p.get('status')}") for p in chats if p.get("status") != 200 or p.get("error"))
        ttft = [p["ttft_ms"] for p in done if p.get("ttft_ms") is not None]
        dur = [p["duration_ms"] for p in done if p.get("duration_ms") is not None]
        tps = [p["tokens_per_s"] for p in done if p.get("tokens_per_s")]
        toks = [p["tokens"] for p in done if p.get("tokens")]
        finish = Counter(p.get("finish") or "unknown" for p in done)
        finish_stopped = sum(1 for p in chats if p.get("stopped"))
        if finish_stopped:
            finish["stopped by visitor"] = finish_stopped
        perf = {
            "ttft_p50": pct(ttft, .5), "ttft_p95": pct(ttft, .95),
            "duration_p50": pct(dur, .5), "duration_p95": pct(dur, .95),
            "tps_p50": round(median(tps), 1) if tps else None,
            "tokens_avg": round(sum(toks) / len(toks)) if toks else None,
            "finish": top(finish),
        }

        # activity heatmap: weekday x hour (local), messages sent
        heat = [[0] * 24 for _ in range(7)]
        for e in cur:
            if e["name"] == "message_sent":
                t = time.gmtime((e["ts"] + off) / 1000)
                heat[t.tm_wday][t.tm_hour] += 1

        live = self._q("SELECT COUNT(DISTINCT visitor) FROM events WHERE source='client' AND ts >= ?", (now - 5 * 60_000,))[0][0]

        return {
            "range_days": days, "hourly": hourly, "generated_at": now,
            "kpis": k_cur, "prev": k_prev, "live": live,
            "timeseries": timeseries,
            "devices": top(devices), "browsers": top(browsers), "os": top(oses), "countries": top(countries),
            "languages": top(langs), "timezones": top(tzs), "screens": top(screens),
            "referrers": top(refs), "landing": top(landings),
            "clicks": top_clicks, "events": top(event_counts, 30), "features": top(features, 20),
            "suggestions": top(suggestions), "errors": top(err_codes), "perf": perf, "heatmap": heat,
        }

    def sessions(self, days, limit=100):
        start = int(time.time() * 1000) - days * 86_400_000
        rows = self._q(
            "SELECT session, visitor, MIN(ts) AS start, MAX(ts) AS end, COUNT(*) AS events, "
            "SUM(name='message_sent') AS messages, SUM(name='click') AS clicks, SUM(name='page_view') AS pageviews, "
            "MAX(device) AS device, MAX(browser) AS browser, MAX(os) AS os, MAX(country) AS country "
            "FROM events WHERE source='client' AND session IS NOT NULL AND ts >= ? "
            "GROUP BY session ORDER BY end DESC LIMIT ?", (start, limit))
        out = []
        for r in rows:
            d = dict(r)
            tz = self._q("SELECT props FROM events WHERE session=? AND name='page_view' ORDER BY ts LIMIT 1", (r["session"],))
            try:
                p = json.loads(tz[0]["props"]) if tz and tz[0]["props"] else {}
            except ValueError:
                p = {}
            d["tz"] = p.get("tz")
            d["ref"] = p.get("ref")
            out.append(d)
        return out

    def session_events(self, session):
        rows = self._q("SELECT id, ts, source, name, path, label, area, props FROM events WHERE session=? ORDER BY ts, id LIMIT 2000", (session,))
        return [dict(r) for r in rows]

    def recent(self, limit=200, before=None, include_heartbeats=False):
        sql = "SELECT id, ts, source, name, visitor, session, path, label, area, props, device, browser, os FROM events"
        cond, args = [], []
        if before:
            cond.append("id < ?"); args.append(int(before))
        if not include_heartbeats:
            cond.append("name != 'heartbeat'")
        if cond:
            sql += " WHERE " + " AND ".join(cond)
        sql += " ORDER BY id DESC LIMIT ?"
        args.append(min(500, limit))
        return [dict(r) for r in self._q(sql, args)]

    def conversations(self, limit=100, before=None):
        sql = "SELECT * FROM conversations"
        args = []
        if before:
            sql += " WHERE id < ?"; args.append(int(before))
        sql += " ORDER BY id DESC LIMIT ?"; args.append(min(300, limit))
        return [dict(r) for r in self._q(sql, args)]

    def export_rows(self, days):
        start = int(time.time() * 1000) - days * 86_400_000
        with self.lock:
            cur = self.db.execute("SELECT id, ts, source, name, visitor, session, path, label, area, props, device, browser, os, country "
                                  "FROM events WHERE ts >= ? ORDER BY ts", (start,))
            while True:
                chunk = cur.fetchmany(2000)
                if not chunk:
                    break
                yield chunk


def ref_host(ref, own_host):
    try:
        h = urlparse(ref).hostname or ""
    except ValueError:
        return None
    if not h or (own_host and h == own_host):
        return None
    return h[4:] if h.startswith("www.") else h
