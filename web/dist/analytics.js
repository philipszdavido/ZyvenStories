const VISITOR_KEY = "zyven:analytics:visitor";
const SESSION_KEY = "zyven:analytics:session";
const OPT_OUT_KEY = "zyven:analytics:opt-out";
const SESSION_IDLE_MS = 30 * 60_000;
const ENDPOINT = "/api/analytics/collect";
function rid() {
    const b = new Uint8Array(12);
    crypto.getRandomValues(b);
    return Array.from(b, (x) => x.toString(36).padStart(2, "0")).join("").slice(0, 20);
}
function readLocal(key) {
    try {
        return localStorage.getItem(key);
    }
    catch {
        return null;
    }
}
export class Analytics {
    baseUrl;
    queue = [];
    enabled = false;
    ready = false;
    visitor = "";
    session = "";
    timer = 0;
    heartbeat = 0;
    logPrompts = false;
    constructor(baseUrl = "") {
        this.baseUrl = baseUrl;
    }
    static optedOut() {
        const gpc = navigator.globalPrivacyControl === true;
        return gpc || readLocal(OPT_OUT_KEY) === "1";
    }
    static setOptOut(out) {
        try {
            if (out)
                localStorage.setItem(OPT_OUT_KEY, "1");
            else
                localStorage.removeItem(OPT_OUT_KEY);
        }
        catch { }
    }
    async init() {
        try {
            const res = await fetch(`${this.baseUrl}/api/analytics/config`, { headers: { Accept: "application/json" } });
            if (!res.ok)
                throw new Error(String(res.status));
            const cfg = await res.json();
            this.logPrompts = !!cfg.logPrompts;
            this.enabled = !!cfg.enabled && !Analytics.optedOut();
        }
        catch {
            this.enabled = false;
        }
        this.ready = true;
        if (!this.enabled) {
            this.queue = [];
            return;
        }
        this.visitor = readLocal(VISITOR_KEY) || rid();
        try {
            localStorage.setItem(VISITOR_KEY, this.visitor);
        }
        catch { }
        this.touchSession();
        this.timer = window.setInterval(() => this.flush(), 5000);
        this.heartbeat = window.setInterval(() => {
            if (document.visibilityState === "visible" && document.hasFocus())
                this.track("heartbeat");
        }, 30_000);
        document.addEventListener("visibilitychange", () => {
            this.track(document.visibilityState === "visible" ? "tab_visible" : "tab_hidden");
            if (document.visibilityState === "hidden")
                this.flush(true);
        });
        window.addEventListener("pagehide", () => this.flush(true));
        document.addEventListener("click", (e) => this.onClick(e), { capture: true });
        window.addEventListener("error", (e) => this.track("js_error", { message: String(e.message).slice(0, 200), src: (e.filename || "").split("/").pop() }));
        this.flush();
    }
    stop() {
        this.enabled = false;
        this.queue = [];
        clearInterval(this.timer);
        clearInterval(this.heartbeat);
    }
    headers() {
        if (!this.enabled)
            return {};
        this.touchSession();
        return { "X-Analytics-Visitor": this.visitor, "X-Analytics-Session": this.session };
    }
    track(name, props, label, area) {
        if (this.ready && !this.enabled)
            return;
        if (this.queue.length > 500)
            this.queue.shift();
        const clean = {};
        if (props)
            for (const [k, v] of Object.entries(props))
                if (v !== undefined)
                    clean[k] = v;
        this.queue.push({ n: name, l: label, a: area, p: Object.keys(clean).length ? clean : undefined, path: location.pathname + location.hash, at: Date.now() });
        if (this.enabled && name !== "heartbeat")
            this.touchSession();
        if (this.enabled && this.queue.length >= 25)
            this.flush();
    }
    pageView() {
        const params = new URLSearchParams(location.search);
        this.track("page_view", {
            ref: document.referrer || undefined,
            utm_source: params.get("utm_source") || undefined,
            utm_campaign: params.get("utm_campaign") || undefined,
            lang: navigator.language,
            tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
            sw: screen.width,
            sh: screen.height,
            vw: innerWidth,
            dpr: devicePixelRatio,
            theme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
            touch: matchMedia("(pointer: coarse)").matches,
            standalone: matchMedia("(display-mode: standalone)").matches,
        });
    }
    touchSession() {
        let stored = null;
        try {
            stored = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
        }
        catch { }
        const now = Date.now();
        if (!stored || now - stored.at > SESSION_IDLE_MS)
            stored = { id: rid(), at: now };
        stored.at = now;
        this.session = stored.id;
        try {
            sessionStorage.setItem(SESSION_KEY, JSON.stringify(stored));
        }
        catch { }
    }
    onClick(e) {
        const el = e.target?.closest("button, a, [role='menuitem'], [role='radio'], label.check, .segmented label, summary");
        if (!el || el.dataset.track === "off")
            return;
        const area = el.closest("[data-area]")?.dataset.area;
        let label = el.dataset.track || el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || "";
        label = label.replace(/\s+/g, " ").trim().slice(0, 80) || el.tagName.toLowerCase();
        const props = {};
        if (el instanceof HTMLAnchorElement && el.href) {
            try {
                const u = new URL(el.href);
                props.href = u.protocol === "mailto:" ? "mailto" : u.host + u.pathname;
                if (u.host !== location.host || u.protocol === "mailto:")
                    this.track("link_out", { href: props.href }, label, area);
            }
            catch { }
        }
        this.track("click", props, label, area);
    }
    flush(beacon = false) {
        if (!this.enabled || !this.queue.length)
            return;
        const now = Date.now();
        const batch = this.queue.splice(0, 50);
        const body = JSON.stringify({
            v: this.visitor, s: this.session,
            e: batch.map((q) => ({ n: q.n, l: q.l, a: q.a, p: q.p, path: q.path, ago: now - q.at })),
        });
        const url = this.baseUrl + ENDPOINT;
        if (beacon && navigator.sendBeacon) {
            navigator.sendBeacon(url, new Blob([body], { type: "text/plain" }));
            return;
        }
        fetch(url, { method: "POST", body, keepalive: body.length < 60_000, headers: { "Content-Type": "text/plain" } })
            .catch(() => { this.queue.unshift(...batch); });
        if (this.queue.length)
            this.flush(beacon);
    }
}
