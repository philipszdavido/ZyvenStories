const CONV_KEY = "ptf-chat:conversations:v1";
const SETTINGS_KEY = "ptf-chat:settings:v1";
const API_KEY = "ptf-chat:api-key";
const MAX_CONVERSATIONS = 200;
export const DEFAULT_SETTINGS = {
    baseUrl: "",
    model: "",
    temperature: 0.8,
    maxTokens: 512,
    systemPrompt: "",
    rememberKey: false,
    theme: "system",
    sidebarCollapsed: false,
};
export function uid() {
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
function readJSON(storage, key, fallback) {
    try {
        const raw = storage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
    }
    catch {
        return fallback;
    }
}
export class ConversationStore {
    storage;
    conversations;
    saveTimer = null;
    constructor(storage = localStorage) {
        this.storage = storage;
        const loaded = readJSON(storage, CONV_KEY, []);
        this.conversations = Array.isArray(loaded) ? loaded.filter((c) => c && Array.isArray(c.messages)) : [];
        for (const c of this.conversations) {
            for (const m of c.messages) {
                if (m.status === "streaming") {
                    m.status = m.content ? "stopped" : "error";
                    if (!m.content)
                        m.error = "interrupted";
                }
            }
        }
    }
    list() {
        return [...this.conversations].sort((a, b) => b.updatedAt - a.updatedAt);
    }
    get(id) {
        return this.conversations.find((c) => c.id === id);
    }
    create(model) {
        const now = Date.now();
        const conv = { id: uid(), title: "New chat", createdAt: now, updatedAt: now, model, messages: [] };
        this.conversations.push(conv);
        this.enforceLimit();
        this.save();
        return conv;
    }
    remove(id) {
        this.conversations = this.conversations.filter((c) => c.id !== id);
        this.save(true);
    }
    rename(id, title) {
        const conv = this.get(id);
        if (!conv)
            return;
        conv.title = title.trim().slice(0, 80) || conv.title;
        conv.renamed = true;
        this.save();
    }
    clear() {
        this.conversations = [];
        this.save(true);
    }
    touch(conv) {
        conv.updatedAt = Date.now();
        if (conv.title === "New chat" && !conv.renamed) {
            const first = conv.messages.find((m) => m.role === "user");
            if (first)
                conv.title = first.content.trim().replace(/\s+/g, " ").slice(0, 60) || "New chat";
        }
        this.save();
    }
    enforceLimit() {
        if (this.conversations.length <= MAX_CONVERSATIONS)
            return;
        this.conversations = this.list().slice(0, MAX_CONVERSATIONS);
    }
    save(immediate = false) {
        if (this.saveTimer !== null) {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }
        const write = () => {
            this.saveTimer = null;
            for (let attempt = 0; attempt < 5; attempt++) {
                try {
                    this.storage.setItem(CONV_KEY, JSON.stringify(this.conversations));
                    return;
                }
                catch {
                    const ordered = this.list();
                    if (ordered.length <= 1)
                        return;
                    const victim = ordered[ordered.length - 1];
                    this.conversations = this.conversations.filter((c) => c.id !== victim.id);
                }
            }
        };
        if (immediate)
            write();
        else
            this.saveTimer = window.setTimeout(write, 250);
    }
}
export function loadSettings() {
    return { ...DEFAULT_SETTINGS, ...readJSON(localStorage, SETTINGS_KEY, {}) };
}
export function saveSettings(s) {
    try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
    }
    catch { }
}
export function loadApiKey() {
    return sessionStorage.getItem(API_KEY) ?? localStorage.getItem(API_KEY) ?? "";
}
export function saveApiKey(key, remember) {
    try {
        sessionStorage.setItem(API_KEY, key);
        if (remember)
            localStorage.setItem(API_KEY, key);
        else
            localStorage.removeItem(API_KEY);
    }
    catch { }
}
