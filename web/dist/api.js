import { readSSE } from "./sse.js";
export class ApiError extends Error {
    status;
    code;
    retryAfterS;
    requestId;
    constructor(message, status, code, retryAfterS, requestId) {
        super(message);
        this.status = status;
        this.code = code;
        this.retryAfterS = retryAfterS;
        this.requestId = requestId;
        this.name = "ApiError";
    }
    get retryable() {
        return this.status === 429 || this.status === 502 || this.status === 503 || this.status === 504;
    }
}
export class NetworkError extends Error {
    partial;
    constructor(message, partial) {
        super(message);
        this.partial = partial;
        this.name = "NetworkError";
    }
}
export class AbortedError extends Error {
    constructor() {
        super("generation stopped");
        this.name = "AbortedError";
    }
}
const sleep = (ms, signal) => new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); reject(new AbortedError()); }, { once: true });
});
export class ChatClient {
    baseUrl;
    apiKey;
    maxRetries;
    fetchImpl;
    extraHeaders;
    constructor(opts = {}) {
        this.baseUrl = (opts.baseUrl ?? "").replace(/\/+$/, "");
        this.apiKey = opts.apiKey ?? "";
        this.maxRetries = opts.maxRetries ?? 3;
        this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
        this.extraHeaders = opts.extraHeaders ?? (() => ({}));
    }
    configure(opts) {
        if (opts.baseUrl !== undefined)
            this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
        if (opts.apiKey !== undefined)
            this.apiKey = opts.apiKey;
        if (opts.maxRetries !== undefined)
            this.maxRetries = opts.maxRetries;
    }
    headers(accept, hasBody) {
        const h = { ...this.extraHeaders(), Accept: accept === "json" ? "application/json" : "text/event-stream" };
        if (hasBody)
            h["Content-Type"] = "application/json";
        if (this.apiKey)
            h["Authorization"] = `Bearer ${this.apiKey}`;
        return h;
    }
    static async toError(res) {
        let message = `HTTP ${res.status}`;
        let code = null;
        try {
            const body = await res.json();
            if (body && body.error) {
                message = String(body.error.message ?? message);
                code = body.error.code ?? null;
            }
        }
        catch {
            message = res.statusText || message;
        }
        const ra = res.headers.get("Retry-After");
        const retryAfter = ra !== null && /^\d+$/.test(ra) ? Number(ra) : null;
        return new ApiError(message, res.status, code, retryAfter, res.headers.get("X-Request-Id"));
    }
    async send(path, init, signal) {
        let attempt = 0;
        while (true) {
            let res;
            try {
                res = await this.fetchImpl(this.baseUrl + path, { ...init, signal });
            }
            catch (err) {
                if (signal?.aborted)
                    throw new AbortedError();
                if (attempt >= this.maxRetries)
                    throw new NetworkError("could not reach the server", false);
                await sleep(Math.min(8000, 500 * 2 ** attempt), signal);
                attempt++;
                continue;
            }
            if (res.ok)
                return res;
            const error = await ChatClient.toError(res);
            if (!error.retryable || attempt >= this.maxRetries)
                throw error;
            const wait = error.retryAfterS !== null ? error.retryAfterS * 1000 : Math.min(8000, 500 * 2 ** attempt);
            await sleep(wait, signal);
            attempt++;
        }
    }
    async listModels(signal) {
        const res = await this.send("/v1/models", { method: "GET", headers: this.headers("json", false) }, signal);
        const body = await res.json();
        return Array.isArray(body?.data) ? body.data : [];
    }
    async streamChat(req, cb = {}, signal) {
        const started = performance.now();
        const payload = { ...req, stream: true, stream_options: { include_usage: true } };
        const res = await this.send("/v1/chat/completions", { method: "POST", headers: this.headers("stream", true), body: JSON.stringify(payload) }, signal);
        if (!res.body)
            throw new NetworkError("response has no body", false);
        cb.onOpen?.();
        const requestId = res.headers.get("X-Request-Id");
        let text = "";
        let finishReason = null;
        let usage = null;
        let firstTokenMs = null;
        let sawDone = false;
        try {
            for await (const msg of readSSE(res.body, signal)) {
                if (msg.data === "[DONE]") {
                    sawDone = true;
                    break;
                }
                let chunk;
                try {
                    chunk = JSON.parse(msg.data);
                }
                catch {
                    continue;
                }
                if (chunk.error) {
                    throw new ApiError(String(chunk.error.message ?? "generation failed"), 500, chunk.error.code ?? null, null, requestId);
                }
                if (chunk.usage)
                    usage = chunk.usage;
                const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
                if (!choice)
                    continue;
                const delta = choice.delta?.content;
                if (delta) {
                    if (firstTokenMs === null)
                        firstTokenMs = performance.now() - started;
                    text += delta;
                    cb.onDelta?.(delta);
                }
                if (choice.finish_reason)
                    finishReason = choice.finish_reason;
            }
        }
        catch (err) {
            if (signal?.aborted)
                throw new AbortedError();
            if (err instanceof ApiError)
                throw err;
            throw new NetworkError("connection lost during generation", text.length > 0);
        }
        if (signal?.aborted)
            throw new AbortedError();
        if (!sawDone)
            throw new NetworkError("stream ended unexpectedly", text.length > 0);
        return { text, finishReason, usage, requestId, firstTokenMs, durationMs: performance.now() - started };
    }
}
