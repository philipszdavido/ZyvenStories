#!/usr/bin/env python3
"""Zyven gateway.

Sits in front of the PyTensorForge server in the same container:
  * passes every request through to the model server (streaming included),
  * records analytics events sent by the chat page,
  * logs each chat request server-side (status, speed, tokens, errors),
  * serves a password-protected dashboard at /analytics.

Environment:
  PORT                       public port (Render sets this)
  BACKEND_PORT               internal port for the model server (default 8001)
  ANALYTICS_DB               SQLite file (default /data/analytics.db)
  ANALYTICS_PASSWORD         password for /analytics (dashboard is off when unset)
  ANALYTICS_USER             username for /analytics (default "admin")
  ANALYTICS_LOG_PROMPTS      "1" to store prompts and replies (default off)
  ANALYTICS_RETENTION_DAYS   delete data older than this (default 180)
  GATEWAY_NO_BACKEND         "1" to skip starting the model server (for testing)
"""
import asyncio
import base64
import csv
import hmac
import io
import json
import os
import signal
import sys
import time

from aiohttp import ClientSession, ClientTimeout, ClientConnectionError, web

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from store import Store, clean_id, clip, is_bot, parse_ua, ref_host  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
APP_DIR = os.path.dirname(HERE)
PORT = int(os.environ.get("PORT", "8000"))
BACKEND_PORT = int(os.environ.get("BACKEND_PORT", "8001"))
BACKEND = f"http://127.0.0.1:{BACKEND_PORT}"
DB_PATH = os.environ.get("ANALYTICS_DB", "/data/analytics.db")
PASSWORD = os.environ.get("ANALYTICS_PASSWORD", "")
USER = os.environ.get("ANALYTICS_USER", "admin")
LOG_PROMPTS = os.environ.get("ANALYTICS_LOG_PROMPTS", "") == "1"
RETENTION_DAYS = int(os.environ.get("ANALYTICS_RETENTION_DAYS", "180"))
NO_BACKEND = os.environ.get("GATEWAY_NO_BACKEND", "") == "1"
EXIT = {"code": 0}

HOP = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailers",
       "transfer-encoding", "upgrade", "content-length", "host"}
EVENT_NAMES_MAX = 64
DASH_CSP = ("default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
            "font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")

store = Store(DB_PATH)


def log(msg):
    print(f"[gateway] {msg}", flush=True)


def now_ms():
    return int(time.time() * 1000)


def client_meta(request):
    ua = request.headers.get("User-Agent", "")
    device, browser, os_ = parse_ua(ua)
    country = (request.headers.get("CF-IPCountry") or request.headers.get("X-Country") or "").upper()[:2] or None
    return ua, device, browser, os_, country


# ---------------------------------------------------------------- collection

_rate = {}


def allow(ip, cost=1, per_min=120):
    t = time.monotonic()
    tokens, last = _rate.get(ip, (per_min, t))
    tokens = min(per_min, tokens + (t - last) * per_min / 60)
    if tokens < cost:
        _rate[ip] = (tokens, t)
        return False
    _rate[ip] = (tokens - cost, t)
    if len(_rate) > 20000:
        _rate.clear()
    return True


def remote_ip(request):
    fwd = request.headers.get("X-Forwarded-For")
    return fwd.split(",")[0].strip() if fwd else (request.remote or "")


async def collect(request):
    if request.content_length and request.content_length > 64_000:
        return web.Response(status=413)
    ua, device, browser, os_, country = client_meta(request)
    if is_bot(ua):
        return web.Response(status=204)
    if not allow(remote_ip(request)):
        return web.Response(status=429)
    try:
        raw = await request.read()
        if len(raw) > 64_000:
            return web.Response(status=413)
        body = json.loads(raw or b"{}")
    except ValueError:
        return web.Response(status=400)

    visitor, session = clean_id(body.get("v")), clean_id(body.get("s"))
    events = body.get("e") if isinstance(body.get("e"), list) else []
    own_host = request.host.split(":")[0]
    rows, t = [], now_ms()
    for ev in events[:60]:
        if not isinstance(ev, dict) or not isinstance(ev.get("n"), str):
            continue
        name = ev["n"][:EVENT_NAMES_MAX]
        props = ev.get("p") if isinstance(ev.get("p"), dict) else {}
        props = {str(k)[:40]: (v if isinstance(v, (int, float, bool)) or v is None else clip(v, 300)) for k, v in list(props.items())[:25]}
        if name == "page_view" and props.get("ref"):
            props["ref"] = ref_host(props["ref"], own_host)
        # client clocks drift: keep relative order but anchor to server time
        ago = ev.get("ago")
        ts = t - int(ago) if isinstance(ago, (int, float)) and 0 <= ago < 3_600_000 else t
        rows.append({
            "ts": ts, "source": "client", "name": name, "visitor": visitor, "session": session,
            "path": clip(ev.get("path"), 200), "label": clip(ev.get("l"), 120), "area": clip(ev.get("a"), 40),
            "props": json.dumps(props, separators=(",", ":")) if props else None,
            "device": device, "browser": browser, "os": os_, "country": country,
        })
    if rows:
        await asyncio.to_thread(store.insert_events, rows)
    return web.Response(status=204)


async def config(request):
    return web.json_response({"enabled": True, "logPrompts": LOG_PROMPTS}, headers={"Cache-Control": "no-store"})


# ---------------------------------------------------------------- proxy

def forward_headers(request):
    h = {k: v for k, v in request.headers.items() if k.lower() not in HOP and not k.lower().startswith("x-analytics-")}
    fwd = request.headers.get("X-Forwarded-For")
    h["X-Forwarded-For"] = fwd if fwd else (request.remote or "")
    h["X-Forwarded-Proto"] = request.headers.get("X-Forwarded-Proto", request.scheme)
    return h


def response_headers(upstream):
    return {k: v for k, v in upstream.headers.items() if k.lower() not in HOP}


def last_user_message(body):
    try:
        msgs = body.get("messages") or []
        for m in reversed(msgs):
            if m.get("role") == "user":
                return str(m.get("content", ""))
    except AttributeError:
        pass
    return ""


async def proxy(request):
    app = request.app
    path_qs = request.raw_path
    is_chat = request.method == "POST" and request.path == "/v1/chat/completions"
    data = await request.read() if request.can_read_body else None

    started = time.monotonic()
    try:
        upstream = await app["http"].request(request.method, BACKEND + path_qs, headers=forward_headers(request),
                                             data=data, allow_redirects=False)
    except (ClientConnectionError, asyncio.TimeoutError):
        if is_chat:
            await log_chat(request, data, 502, started, None, None, None, None, "", "model_server_unavailable")
        return web.json_response({"error": {"message": "The model server is starting. Try again in a moment.",
                                            "code": "model_server_unavailable"}}, status=502, headers={"Retry-After": "5"})

    resp = web.StreamResponse(status=upstream.status, reason=upstream.reason, headers=response_headers(upstream))
    streaming = "text/event-stream" in upstream.headers.get("Content-Type", "")
    if streaming:
        resp.headers["X-Accel-Buffering"] = "no"
        resp.headers["Cache-Control"] = "no-cache"
    else:
        cl = upstream.headers.get("Content-Length")
        if cl:
            resp.content_length = int(cl)

    ttft = tokens = finish = None
    err_code = None
    reply_parts, buf = [], b""
    disconnected = False
    error_body = b""
    try:
        await resp.prepare(request)
        async for chunk in upstream.content.iter_any():
            if is_chat:
                if (upstream.status != 200 or not streaming) and len(error_body) < 200_000:
                    error_body += chunk
                if streaming:
                    buf += chunk
                    while b"\n\n" in buf:
                        block, buf = buf.split(b"\n\n", 1)
                        for line in block.split(b"\n"):
                            if not line.startswith(b"data:"):
                                continue
                            payload = line[5:].strip()
                            if payload == b"[DONE]":
                                continue
                            try:
                                obj = json.loads(payload)
                            except ValueError:
                                continue
                            if obj.get("error"):
                                err_code = str(obj["error"].get("code") or "generation_failed")
                            if obj.get("usage"):
                                tokens = obj["usage"].get("completion_tokens")
                            for ch in obj.get("choices") or []:
                                delta = (ch.get("delta") or {}).get("content")
                                if delta:
                                    if ttft is None:
                                        ttft = int((time.monotonic() - started) * 1000)
                                    if LOG_PROMPTS and sum(map(len, reply_parts)) < 16000:
                                        reply_parts.append(delta)
                                if ch.get("finish_reason"):
                                    finish = ch["finish_reason"]
            try:
                await resp.write(chunk)
            except (ConnectionResetError, ClientConnectionError, RuntimeError):
                disconnected = True
                break
        if not disconnected:
            await resp.write_eof()
    except (ConnectionResetError, asyncio.CancelledError):
        disconnected = True
        raise
    finally:
        if disconnected:
            upstream.close()  # closing the upstream connection stops generation on the model server
        else:
            upstream.release()
        if is_chat:
            if upstream.status == 200 and not streaming and error_body:
                try:
                    obj = json.loads(error_body)
                    tokens = (obj.get("usage") or {}).get("completion_tokens")
                    choice = (obj.get("choices") or [{}])[0]
                    finish = choice.get("finish_reason")
                    if LOG_PROMPTS:
                        reply_parts = [str((choice.get("message") or {}).get("content") or "")[:16000]]
                except (ValueError, AttributeError, IndexError):
                    pass
            if upstream.status != 200 and not err_code:
                try:
                    err_code = json.loads(error_body).get("error", {}).get("code")
                except (ValueError, AttributeError):
                    err_code = None
                err_code = err_code or f"http_{upstream.status}"
            if disconnected and not err_code:
                err_code = "client_stopped"
            asyncio.ensure_future(log_chat(request, data, upstream.status, started, ttft, tokens, finish,
                                           upstream.headers.get("X-Request-Id"), "".join(reply_parts), err_code))
    return resp


async def log_chat(request, data, status, started, ttft, tokens, finish, request_id, reply, err_code):
    duration = int((time.monotonic() - started) * 1000)
    try:
        body = json.loads(data or b"{}")
    except ValueError:
        body = {}
    visitor = clean_id(request.headers.get("X-Analytics-Visitor"))
    session = clean_id(request.headers.get("X-Analytics-Session"))
    ua, device, browser, os_, country = client_meta(request)
    tps = None
    if tokens and ttft is not None and tokens > 1 and duration > ttft:
        tps = round((tokens - 1) / ((duration - ttft) / 1000), 2)
    props = {
        "status": status, "duration_ms": duration, "ttft_ms": ttft, "tokens": tokens, "tokens_per_s": tps,
        "finish": finish, "model": clip(body.get("model"), 60), "max_tokens": body.get("max_tokens"),
        "temperature": body.get("temperature"), "turns": len(body.get("messages") or []),
        "prompt_chars": len(last_user_message(body)), "error": err_code, "request_id": request_id,
    }
    if err_code == "client_stopped":
        props["error"] = None
        props["stopped"] = True
    row = {"ts": now_ms(), "source": "server", "name": "api_chat", "visitor": visitor, "session": session,
           "path": "/v1/chat/completions", "label": None, "area": None,
           "props": json.dumps({k: v for k, v in props.items() if v is not None}, separators=(",", ":")),
           "device": device, "browser": browser, "os": os_, "country": country}
    try:
        await asyncio.to_thread(store.insert_events, [row])
        if LOG_PROMPTS and body:
            await asyncio.to_thread(store.insert_conversation, {
                "ts": row["ts"], "visitor": visitor, "session": session, "model": props["model"],
                "prompt": clip(last_user_message(body), 8000), "reply": clip(reply, 16000),
                "status": status, "tokens": tokens, "duration": duration})
    except Exception as exc:  # analytics must never break chat
        log(f"failed to record chat: {exc}")


# ---------------------------------------------------------------- dashboard

def authorized(request):
    if not PASSWORD:
        return False
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Basic "):
        return False
    try:
        user, _, pw = base64.b64decode(auth[6:]).decode("utf-8").partition(":")
    except (ValueError, UnicodeDecodeError):
        return False
    return hmac.compare_digest(user, USER) and hmac.compare_digest(pw, PASSWORD)


@web.middleware
async def dashboard_guard(request, handler):
    if request.path == "/analytics" or request.path.startswith("/analytics/"):
        if not PASSWORD:
            return web.Response(status=503, text="Analytics dashboard is off. Set ANALYTICS_PASSWORD on the server to turn it on.")
        if not authorized(request):
            if not allow("auth:" + remote_ip(request), per_min=20):
                return web.Response(status=429, text="Too many attempts. Wait a minute.")
            return web.Response(status=401, headers={"WWW-Authenticate": 'Basic realm="Zyven analytics", charset="UTF-8"'})
        resp = await handler(request)
        resp.headers["Cache-Control"] = "no-store"
        resp.headers["Content-Security-Policy"] = DASH_CSP
        resp.headers["X-Frame-Options"] = "DENY"
        resp.headers["Referrer-Policy"] = "no-referrer"
        resp.headers["X-Robots-Tag"] = "noindex"
        return resp
    return await handler(request)


def int_q(request, name, default, lo, hi):
    try:
        return max(lo, min(hi, int(request.query.get(name, default))))
    except ValueError:
        return default


async def dash_page(request):
    return web.FileResponse(os.path.join(HERE, "dashboard", "index.html"))


async def dash_summary(request):
    days = int_q(request, "days", 7, 1, 365)
    tz = int_q(request, "tz", 0, -840, 840)
    return web.json_response(await asyncio.to_thread(store.summary, days, tz))


async def dash_sessions(request):
    return web.json_response(await asyncio.to_thread(store.sessions, int_q(request, "days", 7, 1, 365), int_q(request, "limit", 100, 1, 500)))


async def dash_session(request):
    sid = clean_id(request.query.get("id"))
    if not sid:
        return web.json_response([], status=400)
    return web.json_response(await asyncio.to_thread(store.session_events, sid))


async def dash_events(request):
    before = request.query.get("before")
    rows = await asyncio.to_thread(store.recent, int_q(request, "limit", 200, 1, 500),
                                   int(before) if before and before.isdigit() else None,
                                   request.query.get("heartbeats") == "1")
    return web.json_response(rows)


async def dash_conversations(request):
    if not LOG_PROMPTS:
        return web.json_response({"enabled": False, "items": []})
    before = request.query.get("before")
    rows = await asyncio.to_thread(store.conversations, 100, int(before) if before and before.isdigit() else None)
    return web.json_response({"enabled": True, "items": rows})


async def dash_export(request):
    days = int_q(request, "days", 30, 1, 365)

    def build():
        out = io.StringIO()
        w = csv.writer(out)
        w.writerow(["id", "time_utc", "source", "event", "visitor", "session", "path", "label", "area", "props", "device", "browser", "os", "country"])
        for chunk in store.export_rows(days):
            for r in chunk:
                r = list(r)
                r[1] = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(r[1] / 1000))
                w.writerow(r)
        return out.getvalue()

    text = await asyncio.to_thread(build)
    return web.Response(text=text, content_type="text/csv",
                        headers={"Content-Disposition": f'attachment; filename="zyven-analytics-{days}d.csv"'})


# ---------------------------------------------------------------- lifecycle

async def start_backend(app):
    app["http"] = ClientSession(timeout=ClientTimeout(total=None, connect=5, sock_read=360), auto_decompress=False)
    if NO_BACKEND:
        return
    cmd = [sys.executable, "cli.py", "serve", "--config", os.environ.get("SERVE_CONFIG", "serve.yaml"),
           "--host", "127.0.0.1", "--port", str(BACKEND_PORT)]
    log("starting model server: " + " ".join(cmd))
    proc = await asyncio.create_subprocess_exec(*cmd, cwd=APP_DIR)
    app["backend"] = proc

    async def watch():
        code = await proc.wait()
        EXIT["code"] = code or 1
        log(f"model server exited with code {code}; stopping gateway")
        os.kill(os.getpid(), signal.SIGTERM)

    app["watch"] = asyncio.ensure_future(watch())


async def housekeeping(app):
    async def loop():
        while True:
            try:
                await asyncio.to_thread(store.prune, RETENTION_DAYS)
            except Exception as exc:
                log(f"prune failed: {exc}")
            await asyncio.sleep(6 * 3600)
    app["housekeeping"] = asyncio.ensure_future(loop())


async def stop_backend(app):
    for key in ("watch", "housekeeping"):
        if key in app:
            app[key].cancel()
    proc = app.get("backend")
    if proc and proc.returncode is None:
        proc.send_signal(signal.SIGTERM)
        try:
            await asyncio.wait_for(proc.wait(), 35)
        except asyncio.TimeoutError:
            proc.kill()
    await app["http"].close()


def make_app():
    app = web.Application(middlewares=[dashboard_guard], client_max_size=1_100_000)
    app.router.add_post("/api/analytics/collect", collect)
    app.router.add_get("/api/analytics/config", config)
    app.router.add_get("/analytics", dash_page)
    app.router.add_get("/analytics/", dash_page)
    app.router.add_get("/analytics/api/summary", dash_summary)
    app.router.add_get("/analytics/api/sessions", dash_sessions)
    app.router.add_get("/analytics/api/session", dash_session)
    app.router.add_get("/analytics/api/events", dash_events)
    app.router.add_get("/analytics/api/conversations", dash_conversations)
    app.router.add_get("/analytics/api/export.csv", dash_export)
    app.router.add_static("/analytics/assets/", os.path.join(HERE, "dashboard"), show_index=False)
    app.router.add_route("*", "/{tail:.*}", proxy)
    app.on_startup.append(start_backend)
    app.on_startup.append(housekeeping)
    app.on_cleanup.append(stop_backend)
    return app


if __name__ == "__main__":
    log(f"listening on :{PORT}, model server on 127.0.0.1:{BACKEND_PORT}, db {DB_PATH}, "
        f"dashboard {'on' if PASSWORD else 'off (set ANALYTICS_PASSWORD)'}, prompt logging {'on' if LOG_PROMPTS else 'off'}")
    web.run_app(make_app(), host="0.0.0.0", port=PORT, access_log=None, shutdown_timeout=35, print=None)
    sys.exit(EXIT["code"])
