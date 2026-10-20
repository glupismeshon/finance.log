// Чистые функции без обращения к сети и БД (импортируются и в тестах).
const enc = new TextEncoder();

export const CSRF_HEADER = "finance.log";
export const SESSION_TTL = 30 * 86400;
export const TG_MAX_AGE = 86400;

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {"content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers}
  });
}
export const err = (code, status = 400, headers) => json({error: code}, status, headers);

export function b64url(bytes) {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function unb64url(str) {
  const s = String(str).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "=".repeat((4 - s.length % 4) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export const hex = bytes => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, "0")).join("");

export function randomToken(n = 32) {
  return b64url(crypto.getRandomValues(new Uint8Array(n)));
}
export async function sha256(text) {
  return crypto.subtle.digest("SHA-256", typeof text === "string" ? enc.encode(text) : text);
}
export async function hashSession(token) { return hex(await sha256(token)); }
export async function pkceChallenge(verifier) { return b64url(await sha256(verifier)); }

export async function hmac(keyBytes, text) {
  const key = await crypto.subtle.importKey("raw", keyBytes, {name: "HMAC", hash: "SHA-256"}, false, ["sign"]);
  return crypto.subtle.sign("HMAC", key, enc.encode(text));
}
export function safeEqual(a, b) {
  a = String(a); b = String(b);
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}

// Подписанное значение для короткоживущей cookie: base64url(json).подпись
export async function signValue(secret, obj) {
  const body = b64url(enc.encode(JSON.stringify(obj)));
  return body + "." + b64url(await hmac(enc.encode("fl_oauth:" + secret), body));
}
export async function verifyValue(secret, value, now = Date.now()) {
  if (!secret || typeof value !== "string") return null;
  const i = value.indexOf(".");
  if (i < 1) return null;
  const body = value.slice(0, i);
  const sig = b64url(await hmac(enc.encode("fl_oauth:" + secret), body));
  if (!safeEqual(sig, value.slice(i + 1))) return null;
  try {
    const obj = JSON.parse(new TextDecoder().decode(unb64url(body)));
    if (!obj || typeof obj.exp !== "number" || obj.exp < now) return null;
    return obj;
  } catch { return null; }
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 1) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
export function cookie(name, value, {maxAge, path = "/"} = {}) {
  return `${name}=${value}; Path=${path}; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

// CSRF: для POST/DELETE нужны X-Requested-With и Origin = APP_ORIGIN.
export function csrfOk(request, appOrigin) {
  if (request.method !== "POST" && request.method !== "DELETE" && request.method !== "PATCH") return true;
  if (request.headers.get("x-requested-with") !== CSRF_HEADER) return false;
  const origin = request.headers.get("origin");
  return !!origin && !!appOrigin && origin === appOrigin;
}

// Telegram Login: HMAC-SHA256, ключ = SHA256(bot_token).
export async function telegramCheckString(data) {
  return Object.keys(data).filter(k => k !== "hash" && data[k] !== undefined && data[k] !== null)
    .sort().map(k => `${k}=${data[k]}`).join("\n");
}
export async function telegramSign(data, botToken) {
  return hex(await hmac(await sha256(botToken), await telegramCheckString(data)));
}
export async function verifyTelegram(data, botToken, nowSec = Math.floor(Date.now() / 1000)) {
  if (!data || typeof data !== "object" || !botToken) return {ok: false, error: "bad_request"};
  if (typeof data.hash !== "string" || !/^[0-9a-f]{64}$/.test(data.hash)) return {ok: false, error: "bad_signature"};
  const clean = {};
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === "object" && v !== null) return {ok: false, error: "bad_request"};
    clean[k] = v;
  }
  if (!safeEqual(await telegramSign(clean, botToken), data.hash)) return {ok: false, error: "bad_signature"};
  const auth = Number(data.auth_date);
  if (!Number.isFinite(auth) || nowSec - auth > TG_MAX_AGE || auth - nowSec > 300) return {ok: false, error: "expired"};
  if (!/^\d{1,20}$/.test(String(data.id))) return {ok: false, error: "bad_request"};
  return {ok: true};
}

// Разбор id_token (подпись не проверяем: токен получен напрямую с token endpoint по TLS).
export function parseIdToken(idToken, {aud, nowSec = Math.floor(Date.now() / 1000)}) {
  try {
    const parts = String(idToken).split(".");
    if (parts.length !== 3) return null;
    const p = JSON.parse(new TextDecoder().decode(unb64url(parts[1])));
    if (p.aud !== aud) return null;
    if (p.iss !== "https://accounts.google.com" && p.iss !== "accounts.google.com") return null;
    if (typeof p.exp !== "number" || p.exp < nowSec) return null;
    if (!p.sub) return null;
    return {sub: String(p.sub), email: p.email || null, name: p.name || null, picture: p.picture || null};
  } catch { return null; }
}

export function safeAvatar(url) {
  try { const u = new URL(url); return u.protocol === "https:" ? u.href.slice(0, 500) : null; } catch { return null; }
}

// ---- Синхронизация ----
export const SYNC_KINDS = ["op", "account", "category", "schedule", "reserve", "budget", "loan"];
export const SYNC_LIMITS = {changes: 500, dataBytes: 65536, records: 100000, bodyBytes: 2 * 1024 * 1024, pull: 500};
const SYNC_ID = /^[\w-]{1,100}$/;
const SYNC_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?Z$/;

// ISO-время в единый формат (миллисекунды, Z), чтобы строки сравнивались лексикографически; невалидное → null.
export function normTime(v) {
  if (typeof v !== "string" || !SYNC_TIME.test(v)) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

// Правило принятия: записи нет или updatedAt >= сохранённого (равенство — идемпотентно). stored: {updated_at|updatedAt} | null.
export function decide(stored, incoming) {
  if (!stored) return "accept";
  const s = Date.parse(stored.updated_at ?? stored.updatedAt), i = Date.parse(incoming && incoming.updatedAt);
  if (!Number.isFinite(i)) return "stale";
  if (!Number.isFinite(s)) return "accept";
  return i >= s ? "accept" : "stale";
}

// Проверка одной change; возвращает {ok, change:{kind,id,updatedAt,deleted,enc,json}} или {ok:false}.
export function validateChange(c) {
  if (!c || typeof c !== "object" || Array.isArray(c)) return {ok: false};
  const updatedAt = normTime(c.updatedAt);
  const enc = c.enc ? 1 : 0;
  if (!SYNC_KINDS.includes(c.kind) || typeof c.id !== "string" || !SYNC_ID.test(c.id) || !updatedAt || typeof c.deleted !== "boolean") return {ok: false};
  if (enc ? typeof c.data !== "string" : (!c.data || typeof c.data !== "object" || Array.isArray(c.data))) return {ok: false};
  const json = JSON.stringify(c.data);
  if (new TextEncoder().encode(json).length > SYNC_LIMITS.dataBytes) return {ok: false, error: "too_large"};
  return {ok: true, change: {kind: c.kind, id: c.id, updatedAt, deleted: c.deleted, enc, json}};
}

// ---- Ник (handle) ----
export const HANDLE_RE = /^[a-z0-9_-]{3,24}$/;
export const HANDLE_RESERVED = ["admin", "root", "api", "support", "finance", "financelog", "system"];
export const validHandle = h => typeof h === "string" && HANDLE_RE.test(h) && !HANDLE_RESERVED.includes(h);

// Нормализация произвольной строки: нижний регистр, недопустимое → «-», не длиннее 24. Результат может быть коротким/пустым.
export function normalizeHandle(s) {
  return String(s ?? "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24).replace(/-+$/, "");
}
// Предлагаемый ник: Telegram username → часть email до @ → user-<6 символов id>. Всегда подходит под формат (без учёта занятости).
export function suggestHandle({username, email, id} = {}) {
  const cands = [username, email && String(email).replace(/^@/, "").split("@")[0]];
  for (const c of cands) { const h = normalizeHandle(c); if (validHandle(h)) return h; }
  const tail = String(id ?? "").replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 6);
  return "user-" + (tail.length === 6 ? tail : (tail + Math.random().toString(36).slice(2, 8)).slice(0, 6));
}
// n-й вариант ника при занятости: base, base-2, base-3 … (база укорачивается, чтобы влезть в 24).
export function handleVariant(base, n) {
  if (n <= 1) return base;
  const suf = "-" + n;
  return base.slice(0, 24 - suf.length).replace(/-+$/, "") + suf;
}
