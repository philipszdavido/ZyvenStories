import { Analytics } from "./analytics.js";
import { AbortedError, ApiError, ChatClient, NetworkError } from "./api.js";
import { hydrateIcons, icon } from "./icons.js";
import { renderMarkdown } from "./markdown.js";
import { ConversationStore, loadApiKey, loadSettings, saveApiKey, saveSettings, uid, } from "./store.js";
const BRAND = "Zyven";
const SUGGESTIONS = [
    "Tell me a short story about a brave little fox",
    "Write a bedtime story set on the moon",
    "Tell a story about two friends who find a map",
    "Make up a story about a robot learning to paint",
];
function $(id) {
    const node = document.getElementById(id);
    if (!node)
        throw new Error(`missing element #${id}`);
    return node;
}
function h(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
        if (v === undefined || v === false)
            continue;
        if (k === "class")
            node.className = String(v);
        else if (k === "text")
            node.textContent = String(v);
        else
            node.setAttribute(k, v === true ? "" : String(v));
    }
    for (const ch of children)
        if (ch != null)
            node.append(ch);
    return node;
}
function iconButton(name, label, onClick, cls = "icon-btn icon-btn-sm") {
    const b = h("button", { type: "button", class: cls, "aria-label": label, title: label }, icon(name));
    b.addEventListener("click", onClick);
    return b;
}
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const coarse = matchMedia("(pointer: coarse)");
const narrow = matchMedia("(max-width: 860px)");
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const darkScheme = matchMedia("(prefers-color-scheme: dark)");
function dayGroup(ts) {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const day = 86_400_000;
    if (ts >= start.getTime())
        return "Today";
    if (ts >= start.getTime() - day)
        return "Yesterday";
    if (ts >= start.getTime() - 7 * day)
        return "Previous 7 days";
    if (ts >= start.getTime() - 30 * day)
        return "Previous 30 days";
    return new Date(ts).toLocaleDateString(undefined, { month: "long", year: "numeric" });
}
function greeting() {
    const hr = new Date().getHours();
    if (hr < 5)
        return "Up late? Let's write something";
    if (hr < 12)
        return "Good morning";
    if (hr < 18)
        return "Good afternoon";
    return "Good evening";
}
class ChatApp {
    store = new ConversationStore();
    settings = loadSettings();
    analytics = new Analytics();
    client = new ChatClient({ baseUrl: this.settings.baseUrl, apiKey: loadApiKey(), extraHeaders: () => this.analytics.headers() });
    searchTimer = 0;
    models = [];
    current = null;
    controller = null;
    state = "idle";
    renderQueued = false;
    streamingNode = null;
    streamingMsg = null;
    stickToBottom = true;
    editingId = null;
    renamingId = null;
    query = "";
    toastTimer = 0;
    connected = "pending";
    els = {
        app: $("app"),
        sidebar: $("sidebar"),
        scrim: $("scrim"),
        history: $("history"),
        search: $("search"),
        title: $("chat-title"),
        thread: $("thread"),
        messages: $("messages"),
        welcome: $("welcome"),
        welcomeTitle: $("welcome-title"),
        suggestions: $("suggestions"),
        input: $("input"),
        send: $("send"),
        stop: $("stop"),
        model: $("model"),
        connDot: $("conn-dot"),
        hint: $("composer-hint"),
        banner: $("banner"),
        bannerText: $("banner-text"),
        bannerAction: $("banner-action"),
        jump: $("jump"),
        menu: $("menu"),
        toast: $("toast"),
        settings: $("settings"),
        confirm: $("confirm"),
        about: $("about"),
    };
    start() {
        hydrateIcons();
        this.applyTheme();
        this.applySidebar();
        this.bind();
        const first = this.store.list().find((c) => c.messages.length);
        this.select(first ? first.id : this.store.create(this.settings.model).id);
        this.renderSuggestions();
        this.analytics.pageView();
        this.analytics.init().then(() => this.applyPrivacyNotice());
        if (location.hash === "#about")
            this.openAbout("link");
        this.refreshModels();
        this.setState("idle");
        if (!coarse.matches)
            this.els.input.focus();
    }
    bind() {
        const e = this.els;
        $("new-chat").addEventListener("click", () => this.newConversation());
        $("new-chat-top").addEventListener("click", () => this.newConversation());
        $("collapse-btn").addEventListener("click", () => this.toggleSidebar(false));
        $("open-sidebar").addEventListener("click", () => this.toggleSidebar(true));
        $("settings-btn").addEventListener("click", () => this.openSettings());
        $("about-btn").addEventListener("click", () => this.openAbout("sidebar"));
        $("about-link").addEventListener("click", () => this.openAbout("footnote"));
        $("about-close").addEventListener("click", () => e.about.close());
        e.about.addEventListener("close", () => {
            if (location.hash === "#about")
                history.replaceState(null, "", location.pathname + location.search);
        });
        window.addEventListener("hashchange", () => {
            if (location.hash === "#about")
                this.openAbout("link");
            else if (e.about.open)
                e.about.close();
        });
        $("chat-menu-btn").addEventListener("click", (ev) => {
            ev.stopPropagation();
            if (this.current)
                this.openConvMenu(this.current, ev.currentTarget);
        });
        e.scrim.addEventListener("click", () => this.toggleSidebar(false));
        e.send.addEventListener("click", () => this.send());
        e.stop.addEventListener("click", () => this.stopGeneration());
        e.input.addEventListener("keydown", (ev) => {
            if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing && !coarse.matches) {
                ev.preventDefault();
                this.send();
            }
        });
        e.input.addEventListener("input", () => { this.autosize(); this.updateComposer(); });
        e.model.addEventListener("change", () => {
            this.settings.model = e.model.value;
            saveSettings(this.settings);
            if (this.current) {
                this.current.model = e.model.value;
                this.store.save();
            }
        });
        e.search.addEventListener("input", () => {
            this.query = e.search.value.trim().toLowerCase();
            this.renderList();
            clearTimeout(this.searchTimer);
            this.searchTimer = window.setTimeout(() => {
                if (this.query)
                    this.analytics.track("search", { chars: this.query.length, results: this.els.history.querySelectorAll(".history-item").length });
            }, 800);
        });
        e.search.addEventListener("keydown", (ev) => {
            if (ev.key === "Escape") {
                ev.stopPropagation();
                e.search.value = "";
                this.query = "";
                this.renderList();
                e.input.focus();
            }
        });
        e.thread.addEventListener("scroll", () => {
            const gap = e.thread.scrollHeight - e.thread.scrollTop - e.thread.clientHeight;
            this.stickToBottom = gap < 80;
            e.jump.hidden = gap < 240;
        }, { passive: true });
        e.jump.addEventListener("click", () => this.scrollToEnd(true, true));
        document.addEventListener("keydown", (ev) => this.onShortcut(ev));
        document.addEventListener("pointerdown", (ev) => {
            const t = ev.target;
            if (!e.menu.hidden && !e.menu.contains(t) && !t.closest?.("[aria-haspopup]"))
                this.closeMenu();
        });
        window.addEventListener("resize", () => this.closeMenu());
        window.addEventListener("online", () => { this.showBanner(null); this.refreshModels(); });
        window.addEventListener("offline", () => this.showBanner("You're offline. Messages will send once you reconnect."));
        window.addEventListener("beforeunload", () => this.store.save(true));
        narrow.addEventListener("change", () => this.applySidebar());
        darkScheme.addEventListener("change", () => this.applyTheme());
        $("settings-close").addEventListener("click", () => e.settings.close());
        $("settings-cancel").addEventListener("click", () => e.settings.close());
        $("settings-save").addEventListener("click", () => this.saveSettingsFromDialog());
        $("set-temperature").addEventListener("input", () => this.syncOutputs());
        $("set-max-tokens").addEventListener("input", () => this.syncOutputs());
        $("clear-all").addEventListener("click", async () => {
            e.settings.close();
            const ok = await this.confirm("Delete all chats?", "Every chat saved in this browser will be removed. This can't be undone.", "Delete all");
            if (!ok)
                return;
            this.stopGeneration();
            this.store.clear();
            this.current = null;
            this.select(this.store.create(this.settings.model).id);
            this.toast("All chats deleted");
        });
        for (const d of [e.settings, e.confirm, e.about]) {
            d.addEventListener("click", (ev) => { if (ev.target === d)
                d.close(); });
        }
    }
    onShortcut(ev) {
        const mod = isMac ? ev.metaKey : ev.ctrlKey;
        const key = ev.key.toLowerCase();
        if (mod && ev.shiftKey && key === "o") {
            ev.preventDefault();
            this.newConversation();
            return;
        }
        if (mod && !ev.shiftKey && key === "k") {
            ev.preventDefault();
            this.toggleSidebar(true);
            this.els.search.focus();
            this.els.search.select();
            return;
        }
        if (mod && !ev.shiftKey && key === "b") {
            ev.preventDefault();
            this.toggleSidebar();
            return;
        }
        if (ev.key === "Escape") {
            if (this.els.settings.open || this.els.confirm.open || this.els.about.open)
                return;
            if (!this.els.menu.hidden) {
                this.closeMenu();
                return;
            }
            if (this.isSidebarOverlayOpen()) {
                this.toggleSidebar(false);
                return;
            }
            if (this.state !== "idle")
                this.stopGeneration();
        }
    }
    isSidebarOverlayOpen() {
        return narrow.matches && this.els.app.classList.contains("sidebar-open");
    }
    applySidebar() {
        const app = this.els.app;
        app.classList.remove("sidebar-open");
        this.els.scrim.hidden = true;
        if (narrow.matches) {
            app.classList.remove("sidebar-collapsed");
            this.els.sidebar.inert = true;
        }
        else {
            app.classList.toggle("sidebar-collapsed", this.settings.sidebarCollapsed);
            this.els.sidebar.inert = this.settings.sidebarCollapsed;
        }
    }
    toggleSidebar(open) {
        const app = this.els.app;
        const wasOpen = narrow.matches ? app.classList.contains("sidebar-open") : !this.settings.sidebarCollapsed;
        if (narrow.matches) {
            const next = open ?? !app.classList.contains("sidebar-open");
            app.classList.toggle("sidebar-open", next);
            this.els.scrim.hidden = !next;
            this.els.sidebar.inert = !next;
        }
        else {
            this.settings.sidebarCollapsed = open === undefined ? !this.settings.sidebarCollapsed : !open;
            saveSettings(this.settings);
            this.applySidebar();
        }
        const isOpen = narrow.matches ? app.classList.contains("sidebar-open") : !this.settings.sidebarCollapsed;
        if (isOpen !== wasOpen)
            this.analytics.track("sidebar_toggle", { open: isOpen, mobile: narrow.matches });
    }
    applyTheme() {
        const t = this.settings.theme;
        if (t === "system")
            delete document.documentElement.dataset.theme;
        else
            document.documentElement.dataset.theme = t;
        const dark = t === "dark" || (t === "system" && darkScheme.matches);
        for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
            meta.content = dark ? "#17191C" : "#F7F8F8";
            meta.removeAttribute("media");
        }
    }
    async refreshModels() {
        this.setConn("pending");
        this.renderModels();
        try {
            const t0 = performance.now();
            this.models = await this.client.listModels();
            this.setConn(this.models.length ? "ok" : "bad");
            this.analytics.track("connected", { ms: Math.round(performance.now() - t0), models: this.models.length });
            if (!this.models.length)
                this.showBanner("The server has no models loaded yet.", "Retry", () => this.refreshModels());
            else
                this.showBanner(null);
        }
        catch (err) {
            this.models = [];
            this.setConn("bad");
            this.analytics.track("connection_failed", { status: err instanceof ApiError ? err.status : 0, online: navigator.onLine });
            if (err instanceof ApiError && err.status === 401) {
                this.showBanner("This server needs an API key.", "Add key", () => this.openSettings("set-api-key"));
            }
            else {
                this.showBanner("Can't reach the server. If it was asleep, it can take up to a minute to wake.", "Retry", () => this.refreshModels());
            }
        }
        this.renderModels();
        this.updateComposer();
    }
    setConn(state) {
        this.connected = state;
        this.els.connDot.dataset.state = state;
        this.els.connDot.title = state === "ok" ? "Connected" : state === "bad" ? "Not connected" : "Connecting";
    }
    renderModels() {
        const sel = this.els.model;
        sel.replaceChildren();
        for (const m of this.models)
            sel.appendChild(h("option", { value: m.id, text: m.id }));
        if (!this.models.length)
            sel.appendChild(h("option", { value: "", text: this.connected === "pending" ? "Connecting…" : "Offline" }));
        const wanted = this.current?.model || this.settings.model;
        if (wanted && this.models.some((m) => m.id === wanted))
            sel.value = wanted;
        else if (this.models[0])
            sel.value = this.models[0].id;
        sel.disabled = this.models.length <= 1;
        sel.closest(".model-picker")?.classList.toggle("single", this.models.length <= 1);
    }
    modelLimit() {
        const m = this.models.find((x) => x.id === this.els.model.value);
        return typeof m?.max_generation_tokens === "number" ? m.max_generation_tokens : undefined;
    }
    newConversation() {
        if (this.state !== "idle")
            this.stopGeneration();
        const cur = this.current;
        const conv = cur && cur.messages.length === 0 ? cur : this.store.create(this.els.model.value || this.settings.model);
        this.analytics.track("chat_new", { from_empty: conv === cur });
        this.select(conv.id);
        this.els.input.focus();
    }
    select(id) {
        if (this.current?.id !== id && this.state !== "idle")
            this.stopGeneration();
        const prev = this.current;
        if (prev && prev.id !== id && prev.messages.length === 0)
            this.store.remove(prev.id);
        this.current = this.store.get(id) ?? null;
        this.editingId = null;
        if (this.current?.model && this.models.some((m) => m.id === this.current.model))
            this.els.model.value = this.current.model;
        this.renderList();
        this.renderMessages(true);
        this.updateTitle();
        if (narrow.matches)
            this.toggleSidebar(false);
    }
    updateTitle() {
        const conv = this.current;
        const started = !!conv && conv.messages.length > 0;
        const t = started ? conv.title : "New chat";
        this.els.title.textContent = t;
        document.title = started ? `${t} – ${BRAND}` : BRAND;
        $("chat-menu-btn").hidden = !started;
    }
    renderList() {
        const nav = this.els.history;
        nav.replaceChildren();
        const q = this.query;
        const convs = this.store.list().filter((c) => c.messages.length > 0).filter((c) => !q || c.title.toLowerCase().includes(q) || c.messages.some((m) => m.content.toLowerCase().includes(q)));
        if (!convs.length) {
            nav.appendChild(h("p", { class: "history-empty", text: q ? "No chats match your search." : "Your chats will appear here." }));
            return;
        }
        let group = "";
        let list = null;
        for (const conv of convs) {
            const g = dayGroup(conv.updatedAt);
            if (g !== group || !list) {
                group = g;
                list = h("ul", { class: "history-list" });
                nav.append(h("h2", { class: "history-group", text: g }), list);
            }
            list.appendChild(this.historyItem(conv));
        }
    }
    historyItem(conv) {
        const active = conv.id === this.current?.id;
        const li = h("li", { class: active ? "history-item active" : "history-item" });
        if (this.renamingId === conv.id) {
            const input = h("input", { class: "rename-input", type: "text", value: conv.title, "aria-label": "Chat name", maxlength: "80" });
            const done = (save) => {
                if (this.renamingId !== conv.id)
                    return;
                this.renamingId = null;
                if (save && input.value.trim() && input.value.trim() !== conv.title) {
                    this.store.rename(conv.id, input.value);
                    this.updateTitle();
                    this.analytics.track("chat_renamed");
                }
                this.renderList();
            };
            input.addEventListener("keydown", (ev) => {
                if (ev.key === "Enter") {
                    ev.preventDefault();
                    done(true);
                }
                if (ev.key === "Escape") {
                    ev.preventDefault();
                    ev.stopPropagation();
                    done(false);
                }
            });
            input.addEventListener("blur", () => done(true));
            li.appendChild(input);
            requestAnimationFrame(() => { input.focus(); input.select(); });
            return li;
        }
        const link = h("button", { type: "button", class: "history-link", "data-track": "Open chat", "aria-current": active ? "page" : undefined }, h("span", { class: "history-title", text: conv.title }));
        if (this.state !== "idle" && active)
            link.appendChild(h("span", { class: "history-live", title: "Generating" }));
        link.addEventListener("click", () => this.select(conv.id));
        const more = iconButton("more", `Options for ${conv.title}`, (ev) => {
            ev.stopPropagation();
            this.openConvMenu(conv, ev.currentTarget);
        }, "icon-btn icon-btn-sm history-more");
        more.setAttribute("aria-haspopup", "menu");
        more.dataset.track = "Chat options";
        more.id = `more-${conv.id}`;
        li.append(link, more);
        return li;
    }
    openConvMenu(conv, anchor) {
        this.openMenu(anchor, [
            { label: "Rename", icon: "edit", run: () => this.startRename(conv) },
            { label: "Delete", icon: "trash", danger: true, run: () => this.deleteConversation(conv) },
        ]);
    }
    startRename(conv) {
        if (narrow.matches ? !this.isSidebarOverlayOpen() : this.settings.sidebarCollapsed)
            this.toggleSidebar(true);
        this.renamingId = conv.id;
        this.renderList();
    }
    async deleteConversation(conv) {
        const ok = await this.confirm("Delete chat?", `"${conv.title}" will be permanently deleted.`, "Delete");
        if (!ok)
            return;
        const wasCurrent = conv.id === this.current?.id;
        if (wasCurrent && this.state !== "idle")
            this.stopGeneration();
        this.analytics.track("chat_deleted", { messages: conv.messages.length });
        this.store.remove(conv.id);
        if (wasCurrent) {
            this.current = null;
            const next = this.store.list().find((c) => c.messages.length);
            this.select(next ? next.id : this.store.create(this.settings.model).id);
        }
        else {
            this.renderList();
        }
        this.toast("Chat deleted");
    }
    openMenu(anchor, items) {
        const menu = this.els.menu;
        if (!menu.hidden && menu.dataset.anchor === anchor.id) {
            this.closeMenu();
            return;
        }
        menu.replaceChildren();
        for (const it of items) {
            const b = h("button", { type: "button", role: "menuitem", class: it.danger ? "menu-item danger" : "menu-item" }, icon(it.icon), h("span", { text: it.label }));
            b.addEventListener("click", () => { this.closeMenu(); it.run(); });
            menu.appendChild(b);
        }
        menu.hidden = false;
        menu.dataset.anchor = anchor.id;
        const r = anchor.getBoundingClientRect();
        const mw = menu.offsetWidth, mh = menu.offsetHeight;
        let left = r.right - mw;
        if (left < 8)
            left = r.left;
        left = Math.min(left, window.innerWidth - mw - 8);
        let top = r.bottom + 6;
        if (top + mh > window.innerHeight - 8)
            top = r.top - mh - 6;
        menu.style.left = `${Math.max(8, left)}px`;
        menu.style.top = `${Math.max(8, top)}px`;
        menu.firstElementChild?.focus();
        menu.onkeydown = (ev) => {
            const btns = [...menu.querySelectorAll("button")];
            const i = btns.indexOf(document.activeElement);
            if (ev.key === "ArrowDown") {
                ev.preventDefault();
                btns[(i + 1) % btns.length].focus();
            }
            if (ev.key === "ArrowUp") {
                ev.preventDefault();
                btns[(i - 1 + btns.length) % btns.length].focus();
            }
            if (ev.key === "Escape") {
                ev.preventDefault();
                this.closeMenu();
                anchor.focus();
            }
            if (ev.key === "Tab")
                this.closeMenu();
        };
    }
    closeMenu() {
        this.els.menu.hidden = true;
        delete this.els.menu.dataset.anchor;
    }
    confirm(title, text, okLabel) {
        const d = this.els.confirm;
        $("confirm-title").textContent = title;
        $("confirm-text").textContent = text;
        const ok = $("confirm-ok");
        ok.textContent = okLabel;
        return new Promise((resolve) => {
            let result = false;
            ok.onclick = () => { result = true; d.close(); };
            $("confirm-cancel").onclick = () => d.close();
            d.addEventListener("close", () => resolve(result), { once: true });
            d.showModal();
            $("confirm-cancel").focus();
        });
    }
    toast(text) {
        const t = this.els.toast;
        t.textContent = text;
        t.hidden = false;
        t.classList.remove("show");
        void t.offsetWidth;
        t.classList.add("show");
        clearTimeout(this.toastTimer);
        this.toastTimer = window.setTimeout(() => { t.classList.remove("show"); t.hidden = true; }, 2000);
    }
    showBanner(text, action, run) {
        const e = this.els;
        e.bannerText.textContent = text ?? "";
        e.banner.hidden = !text;
        e.bannerAction.hidden = !action;
        e.bannerAction.textContent = action ?? "";
        e.bannerAction.onclick = run ? () => run() : null;
    }
    renderSuggestions() {
        const box = this.els.suggestions;
        box.replaceChildren();
        for (const s of SUGGESTIONS) {
            const b = h("button", { type: "button", class: "chip", text: s });
            b.addEventListener("click", () => {
                this.els.input.value = s;
                this.autosize();
                this.updateComposer();
                if (this.connected === "ok")
                    this.send(s);
                else
                    this.els.input.focus();
            });
            box.appendChild(b);
        }
    }
    renderMessages(forceBottom = false) {
        const box = this.els.messages;
        box.replaceChildren();
        this.streamingNode = null;
        const msgs = this.current?.messages ?? [];
        const empty = msgs.length === 0;
        this.els.app.classList.toggle("is-empty", empty);
        this.els.welcome.hidden = !empty;
        this.els.suggestions.hidden = !empty;
        if (empty) {
            this.els.welcomeTitle.textContent = greeting();
            this.els.jump.hidden = true;
            return;
        }
        const lastIndex = msgs.length - 1;
        msgs.forEach((m, i) => {
            const node = m.role === "user" ? this.userNode(m, i) : this.assistantNode(m, i === lastIndex);
            if (m === this.streamingMsg)
                this.streamingNode = node;
            box.appendChild(node);
        });
        this.scrollToEnd(forceBottom);
    }
    userNode(msg, index) {
        const wrap = h("article", { class: "turn turn-user", "data-id": msg.id, "aria-label": "You said" });
        if (this.editingId === msg.id) {
            const ta = h("textarea", { class: "edit-input", rows: "1", "aria-label": "Edit message" });
            ta.value = msg.content;
            const cancel = h("button", { type: "button", class: "btn", text: "Cancel" });
            const save = h("button", { type: "button", class: "btn btn-primary", text: "Send" });
            const close = () => { this.editingId = null; this.renderMessages(); };
            cancel.addEventListener("click", close);
            save.addEventListener("click", () => this.submitEdit(index, ta.value));
            ta.addEventListener("keydown", (ev) => {
                if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing && !coarse.matches) {
                    ev.preventDefault();
                    this.submitEdit(index, ta.value);
                }
                if (ev.key === "Escape") {
                    ev.stopPropagation();
                    close();
                }
            });
            const fit = () => { ta.style.height = "auto"; ta.style.height = `${Math.min(ta.scrollHeight, 320)}px`; };
            ta.addEventListener("input", fit);
            wrap.classList.add("is-editing");
            wrap.append(h("div", { class: "edit-box" }, ta, h("div", { class: "edit-actions" }, cancel, save)));
            requestAnimationFrame(() => { fit(); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); });
            return wrap;
        }
        const actions = h("div", { class: "turn-actions" }, iconButton("copy", "Copy", () => this.copy(msg.content, "prompt")), this.state === "idle" ? iconButton("edit", "Edit", () => { this.editingId = msg.id; this.renderMessages(); }) : null);
        wrap.append(h("div", { class: "bubble", text: msg.content }), actions);
        return wrap;
    }
    assistantNode(msg, isLast) {
        const wrap = h("article", { class: `turn turn-assistant is-${msg.status}`, "data-id": msg.id, "aria-label": `${BRAND} said` });
        const body = h("div", { class: "prose" });
        if (msg.content)
            body.appendChild(renderMarkdown(msg.content));
        if (msg.status === "streaming") {
            if (msg.content)
                appendCaret(body);
            else
                body.appendChild(this.thinking());
        }
        const col = h("div", { class: "turn-body" }, body);
        wrap.append(h("div", { class: "avatar" }, icon("mark")), col);
        if (msg.status === "error") {
            const card = h("div", { class: "error-card", role: "alert" }, icon("alert"), h("span", { class: "error-text", text: msg.error || "The reply couldn't be generated." }));
            if (isLast) {
                const retry = h("button", { type: "button", class: "btn btn-sm" }, icon("retry"), h("span", { text: "Try again" }));
                retry.addEventListener("click", () => this.regenerate());
                card.appendChild(retry);
            }
            col.appendChild(card);
        }
        else if (msg.status !== "streaming") {
            const actions = h("div", { class: "turn-actions" }, iconButton("copy", "Copy", () => this.copy(msg.content, "reply")), isLast ? iconButton("retry", "Regenerate", () => this.regenerate()) : null);
            const stats = this.stats(msg);
            if (stats)
                actions.appendChild(iconButton("info", stats, () => this.toast(stats)));
            const notes = [];
            if (msg.status === "stopped")
                notes.push("Stopped");
            if (msg.finishReason === "length")
                notes.push("Reached the length limit");
            if (notes.length)
                actions.appendChild(h("span", { class: "turn-note", text: notes.join(". ") }));
            col.appendChild(actions);
        }
        return wrap;
    }
    thinking() {
        return h("span", { class: "thinking", role: "status", "aria-label": "Generating" }, h("i"), h("i"), h("i"));
    }
    stats(msg) {
        const parts = [];
        if (msg.usage)
            parts.push(`${msg.usage.completion_tokens} tokens`);
        if (msg.usage && msg.durationMs && msg.ttftMs != null && msg.usage.completion_tokens > 1) {
            const rate = (msg.usage.completion_tokens - 1) / Math.max(0.001, (msg.durationMs - msg.ttftMs) / 1000);
            parts.push(`${rate.toFixed(1)} tokens/s`);
        }
        if (msg.ttftMs != null)
            parts.push(`first token in ${(msg.ttftMs / 1000).toFixed(2)} s`);
        return parts.join(", ");
    }
    copy(text, what = "message") {
        this.analytics.track("copy", { what, chars: text.length });
        const ok = () => this.toast("Copied to clipboard");
        const fail = () => this.toast("Couldn't copy");
        if (navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(text).then(ok, fail);
            return;
        }
        const ta = h("textarea", { class: "sr-only" });
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        try {
            if (document.execCommand("copy"))
                ok();
            else
                fail();
        }
        catch {
            fail();
        }
        ta.remove();
    }
    scrollToEnd(force = false, smooth = false) {
        const t = this.els.thread;
        if (!force && !this.stickToBottom)
            return;
        t.scrollTo({ top: t.scrollHeight, behavior: smooth && !reducedMotion.matches ? "smooth" : "auto" });
        this.stickToBottom = true;
    }
    queueStreamRender() {
        if (this.renderQueued)
            return;
        this.renderQueued = true;
        requestAnimationFrame(() => {
            this.renderQueued = false;
            const msg = this.streamingMsg, node = this.streamingNode;
            if (!msg || !node)
                return;
            const body = node.querySelector(".prose");
            if (body) {
                body.replaceChildren(renderMarkdown(msg.content));
                appendCaret(body);
            }
            this.scrollToEnd();
        });
    }
    setState(state) {
        this.state = state;
        const busy = state !== "idle";
        this.els.send.hidden = busy;
        this.els.stop.hidden = !busy;
        this.els.app.classList.toggle("is-busy", busy);
        this.updateComposer();
    }
    updateComposer() {
        const hasText = this.els.input.value.trim().length > 0;
        this.els.send.disabled = !hasText || this.connected !== "ok";
        this.els.hint.textContent = this.state === "connecting" ? "Waiting for the model…" : this.state === "streaming" ? "Writing…" : "";
    }
    autosize() {
        const t = this.els.input;
        t.style.height = "auto";
        t.style.height = `${Math.min(t.scrollHeight, narrow.matches ? 168 : 280)}px`;
    }
    history(conv, upTo) {
        const out = [];
        if (this.settings.systemPrompt.trim())
            out.push({ role: "system", content: this.settings.systemPrompt });
        for (const m of conv.messages.slice(0, upTo)) {
            if (m.role === "assistant" && (m.status === "error" || !m.content))
                continue;
            out.push({ role: m.role, content: m.content });
        }
        return out;
    }
    send(suggestion) {
        const text = this.els.input.value.trim();
        if (!text || !this.current || this.state !== "idle")
            return;
        if (!this.els.model.value) {
            this.showBanner("No model is available yet.", "Retry", () => this.refreshModels());
            return;
        }
        this.els.input.value = "";
        this.autosize();
        this.current.messages.push({ id: uid(), role: "user", content: text, status: "done", createdAt: Date.now() });
        this.analytics.track("message_sent", {
            chars: text.length, words: text.split(/\s+/).length, turn: this.current.messages.filter((m) => m.role === "user").length,
            suggestion: suggestion && suggestion === text ? suggestion : undefined, model: this.els.model.value,
        });
        this.store.touch(this.current);
        this.updateTitle();
        this.generate();
    }
    submitEdit(index, value) {
        const conv = this.current;
        const text = value.trim();
        if (!conv || !text || this.state !== "idle")
            return;
        conv.messages = conv.messages.slice(0, index + 1);
        conv.messages[index] = { ...conv.messages[index], content: text, createdAt: Date.now() };
        this.editingId = null;
        this.analytics.track("message_edited", { chars: text.length, dropped: conv.messages.length - index - 1 });
        this.store.touch(conv);
        this.generate();
    }
    regenerate() {
        const conv = this.current;
        if (!conv || this.state !== "idle")
            return;
        const last = conv.messages[conv.messages.length - 1];
        if (last?.role === "assistant")
            conv.messages.pop();
        if (!conv.messages.length || conv.messages[conv.messages.length - 1].role !== "user")
            return;
        this.analytics.track("regenerate", { after: last?.status });
        this.generate();
    }
    stopGeneration() {
        if (this.controller && !this.controller.signal.aborted)
            this.analytics.track("stop", { chars_so_far: this.streamingMsg?.content.length ?? 0 });
        this.controller?.abort();
    }
    async generate() {
        const conv = this.current;
        const model = this.els.model.value;
        const messages = this.history(conv, conv.messages.length);
        const limit = this.modelLimit();
        const maxTokens = limit ? Math.min(this.settings.maxTokens, limit) : this.settings.maxTokens;
        const msg = { id: uid(), role: "assistant", content: "", status: "streaming", createdAt: Date.now(), model };
        conv.messages.push(msg);
        this.streamingMsg = msg;
        this.controller = new AbortController();
        this.setState("connecting");
        this.renderMessages(true);
        this.renderList();
        try {
            const result = await this.client.streamChat({ model, messages, temperature: this.settings.temperature, max_tokens: maxTokens }, {
                onOpen: () => this.setState("streaming"),
                onDelta: (delta) => { msg.content += delta; this.queueStreamRender(); },
            }, this.controller.signal);
            msg.content = result.text;
            msg.status = "done";
            msg.usage = result.usage;
            msg.finishReason = result.finishReason;
            msg.ttftMs = result.firstTokenMs;
            msg.durationMs = result.durationMs;
            this.analytics.track("reply_done", {
                tokens: result.usage?.completion_tokens, chars: result.text.length, finish: result.finishReason,
                ttft_ms: result.firstTokenMs != null ? Math.round(result.firstTokenMs) : undefined, duration_ms: Math.round(result.durationMs),
            });
        }
        catch (err) {
            if (err instanceof AbortedError) {
                msg.status = msg.content ? "stopped" : "error";
                if (!msg.content)
                    msg.error = "Stopped before the model replied.";
            }
            else {
                msg.status = "error";
                msg.error = describeError(err);
                this.analytics.track("reply_error", {
                    status: err instanceof ApiError ? err.status : 0, code: err instanceof ApiError ? err.code ?? undefined : err instanceof NetworkError ? "network" : "unknown",
                    partial: msg.content.length > 0,
                });
                if (err instanceof ApiError && err.status === 401) {
                    this.showBanner("This server needs an API key.", "Add key", () => this.openSettings("set-api-key"));
                }
            }
        }
        finally {
            this.controller = null;
            this.streamingMsg = null;
            this.store.touch(conv);
            this.setState("idle");
            if (conv === this.current)
                this.renderMessages();
            this.renderList();
            this.updateTitle();
        }
    }
    openSettings(focusId) {
        const f = (id) => $(id);
        f("set-base-url").value = this.settings.baseUrl;
        f("set-api-key").value = loadApiKey();
        f("set-remember").checked = this.settings.rememberKey;
        f("set-temperature").value = String(this.settings.temperature);
        const tokens = f("set-max-tokens");
        const limit = this.modelLimit() ?? 1024;
        tokens.max = String(limit);
        tokens.value = String(Math.min(this.settings.maxTokens, limit));
        $("set-system").value = this.settings.systemPrompt;
        for (const r of document.querySelectorAll('input[name="theme"]'))
            r.checked = r.value === this.settings.theme;
        f("set-analytics").checked = !Analytics.optedOut();
        this.syncOutputs();
        this.analytics.track("settings_open");
        if (this.isSidebarOverlayOpen())
            this.toggleSidebar(false);
        this.els.settings.showModal();
        if (focusId)
            f(focusId).focus();
    }
    openAbout(via) {
        const d = this.els.about;
        if (d.open)
            return;
        this.analytics.track("about_open", { via });
        if (this.isSidebarOverlayOpen())
            this.toggleSidebar(false);
        if (location.hash !== "#about")
            history.replaceState(null, "", "#about");
        d.showModal();
        d.querySelector(".dialog-scroll")?.scrollTo(0, 0);
        $("about-close").focus();
    }
    applyPrivacyNotice() {
        const note = this.analytics.logPrompts ? "Conversations are saved to help improve Zyven." : "";
        $("privacy-note").textContent = note;
        $("privacy-note").hidden = !note;
        $("prompts-note").hidden = !this.analytics.logPrompts;
    }
    syncOutputs() {
        $("temp-out").textContent = Number($("set-temperature").value).toFixed(1);
        $("tokens-out").textContent = $("set-max-tokens").value;
    }
    saveSettingsFromDialog() {
        const f = (id) => $(id);
        const temperature = Number(f("set-temperature").value);
        const maxTokens = Math.floor(Number(f("set-max-tokens").value));
        const theme = (document.querySelector('input[name="theme"]:checked')?.value ?? "system");
        const oldBase = this.settings.baseUrl;
        const oldTheme = this.settings.theme;
        const oldKey = loadApiKey();
        this.settings = {
            ...this.settings,
            baseUrl: f("set-base-url").value.trim(),
            rememberKey: f("set-remember").checked,
            temperature: Number.isFinite(temperature) ? Math.min(2, Math.max(0, temperature)) : this.settings.temperature,
            maxTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : this.settings.maxTokens,
            systemPrompt: $("set-system").value,
            theme,
        };
        saveSettings(this.settings);
        const key = f("set-api-key").value.trim();
        saveApiKey(key, this.settings.rememberKey);
        this.client.configure({ baseUrl: this.settings.baseUrl, apiKey: key });
        const share = f("set-analytics").checked;
        if (share === Analytics.optedOut()) {
            if (!share)
                this.analytics.track("analytics_opt_out");
            this.analytics.flush();
            Analytics.setOptOut(!share);
            if (!share)
                this.analytics.stop();
            else {
                this.analytics = new Analytics();
                this.analytics.init().then(() => this.applyPrivacyNotice());
            }
        }
        if (theme !== oldTheme)
            this.analytics.track("theme_changed", { from: oldTheme, to: theme });
        this.analytics.track("settings_saved", {
            theme, temperature: this.settings.temperature, max_tokens: this.settings.maxTokens,
            instructions: this.settings.systemPrompt.trim().length > 0, api_key: key.length > 0, custom_server: this.settings.baseUrl.length > 0,
        });
        this.applyTheme();
        this.els.settings.close();
        if (oldBase !== this.settings.baseUrl || oldKey !== key || this.connected !== "ok")
            this.refreshModels();
        this.toast("Settings saved");
    }
}
const CARET_HOSTS = new Set(["P", "UL", "OL", "LI", "BLOCKQUOTE", "H1", "H2", "H3", "H4", "H5", "H6"]);
function appendCaret(root) {
    let target = root;
    while (target.lastElementChild && CARET_HOSTS.has(target.lastElementChild.tagName))
        target = target.lastElementChild;
    target.appendChild(h("span", { class: "caret", "aria-hidden": "true" }));
}
function describeError(err) {
    if (err instanceof ApiError) {
        if (err.status === 429)
            return "You're sending messages too quickly. Wait a moment, then try again.";
        if (err.status === 503)
            return "The server is busy right now. Try again in a few seconds.";
        if (err.code === "context_length_exceeded")
            return "This chat is too long for the model. Start a new chat to continue.";
        if (err.status === 401)
            return "The server rejected the API key. Check it in Settings.";
        return err.requestId ? `${err.message} (request ${err.requestId})` : err.message;
    }
    if (err instanceof NetworkError) {
        return err.partial ? "The connection dropped mid-reply. Try again to regenerate it." : "Can't reach the server. Check your connection and try again.";
    }
    return "Something went wrong while generating the reply.";
}
new ChatApp().start();
