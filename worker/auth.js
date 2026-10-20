import {
  json, err, cookie, parseCookies, randomToken, pkceChallenge, signValue, verifyValue,
  csrfOk, verifyTelegram, parseIdToken, safeAvatar, SESSION_TTL, validHandle
} from "./util.js";
import * as db from "./db.js";

const SESSION_COOKIE = "fl_session", OAUTH_COOKIE = "fl_oauth";
const sessionToken = request => parseCookies(request.headers.get("cookie"))[SESSION_COOKIE] || null;
const signingSecret = env => {
  const s = env.COOKIE_SECRET || env.GOOGLE_CLIENT_SECRET || env.TELEGRAM_BOT_TOKEN;
  if (!s) throw new Error("no signing secret configured");
  return s;
};
const redirect = (location, cookies = []) => {
  const h = new Headers({location, "cache-control": "no-store"});
  for (const c of cookies) h.append("set-cookie", c);
  return new Response(null, {status: 302, headers: h});
};
const clearOauth = () => cookie(OAUTH_COOKIE, "", {maxAge: 0, path: "/api/auth"});
const googleOk = env => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
const telegramOk = env => !!(env.TELEGRAM_BOT_TOKEN && /^\d+:/.test(env.TELEGRAM_BOT_TOKEN));

export const currentUser = (env, request) => db.sessionUser(env, sessionToken(request));

async function startSession(env, request, userId, previous) {
  if (previous) await db.deleteSession(env, previous.idHash);
  const token = randomToken(32);
  await db.createSession(env, userId, token, request.headers.get("user-agent"));
  return cookie(SESSION_COOKIE, token, {maxAge: SESSION_TTL});
}

// Общая логика: вход или привязка. Возвращает {cookie} или {error}.
async function signInOrLink(env, request, ident, link) {
  const current = await currentUser(env, request);
  const existing = await db.findIdentity(env, ident.provider, ident.providerId);
  if (link && current) {
    if (existing && existing.user_id !== current.userId) return {error: "identity_in_use"};
    if (existing) await db.refreshIdentity(env, ident.provider, ident.providerId, ident);
    else await db.attachIdentity(env, current.userId, ident);
    return {cookies: []};
  }
  let userId;
  if (existing) { userId = existing.user_id; await db.refreshIdentity(env, ident.provider, ident.providerId, ident); }
  else userId = await db.createUserWithIdentity(env, ident);
  if (current && current.userId === userId) return {cookies: []};
  return {cookies: [await startSession(env, request, userId, current)]};
}

export function config(env) {
  return json({google: googleOk(env), telegram: telegramOk(env), telegramBot: env.TELEGRAM_BOT_NAME || ""});
}

export async function me(env, request) {
  const u = await currentUser(env, request);
  if (!u) return err("unauthorized", 401);
  const extra = await db.meData(env, u.userId);
  const handle = u.handle || await db.ensureHandle(env, u.userId);
  return json({user: {id: u.userId, name: u.name, avatar: u.avatar, handle}, identities: extra.identities, sessions: extra.sessions});
}

export async function patchMe(env, request) {
  const u = await currentUser(env, request);
  if (!u) return err("unauthorized", 401);
  let body;
  try { body = await request.json(); } catch { return err("bad_request", 400); }
  const handle = body && typeof body === "object" ? body.handle : null;
  if (!validHandle(handle)) return err("bad_handle", 400);
  if (handle === u.handle) return json({ok: true, handle});
  if (await db.setHandle(env, u.userId, handle) === "taken") return err("handle_taken", 409);
  return json({ok: true, handle});
}

export async function logout(env, request, all) {
  const u = await currentUser(env, request);
  const clear = cookie(SESSION_COOKIE, "", {maxAge: 0});
  if (u) { if (all) await db.deleteUserSessions(env, u.userId); else await db.deleteSession(env, u.idHash); }
  return json({ok: true}, 200, {"set-cookie": clear});
}

export async function unlink(env, request, provider) {
  const u = await currentUser(env, request);
  if (!u) return err("unauthorized", 401);
  if (provider !== "google" && provider !== "telegram") return err("bad_request", 400);
  const r = await db.unlinkIdentity(env, u.userId, provider);
  if (r === "last_identity") return err("last_identity", 400);
  if (r === "not_found") return err("not_found", 404);
  return json({ok: true});
}

// ---------- Google ----------
export async function googleStart(env, request, url) {
  if (!googleOk(env)) return err("google_not_configured", 503);
  const state = randomToken(24), verifier = randomToken(48);
  const link = url.searchParams.get("link") === "1" ? 1 : 0;
  const signed = await signValue(signingSecret(env), {state, verifier, link, exp: Date.now() + 600000});
  const q = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: env.APP_ORIGIN + "/api/auth/google/callback",
    response_type: "code",
    scope: "openid email profile",
    state,
    code_challenge: await pkceChallenge(verifier),
    code_challenge_method: "S256",
    prompt: "select_account"
  });
  return redirect("https://accounts.google.com/o/oauth2/v2/auth?" + q, [cookie(OAUTH_COOKIE, signed, {maxAge: 600, path: "/api/auth"})]);
}

export async function googleCallback(env, request, url) {
  const fail = code => redirect(`/?auth_error=${code}#settings`, [clearOauth()]);
  if (!googleOk(env)) return fail("google_not_configured");
  const saved = await verifyValue(signingSecret(env), parseCookies(request.headers.get("cookie"))[OAUTH_COOKIE]);
  const state = url.searchParams.get("state"), code = url.searchParams.get("code");
  if (url.searchParams.get("error")) return fail("access_denied");
  if (!saved || !state || state !== saved.state || !code) return fail("bad_state");
  let token;
  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {"content-type": "application/x-www-form-urlencoded"},
      body: new URLSearchParams({
        code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: env.APP_ORIGIN + "/api/auth/google/callback",
        grant_type: "authorization_code", code_verifier: saved.verifier
      })
    });
    if (!res.ok) return fail("google_exchange_failed");
    token = await res.json();
  } catch { return fail("google_unreachable"); }
  const p = parseIdToken(token.id_token, {aud: env.GOOGLE_CLIENT_ID});
  if (!p) return fail("bad_id_token");
  const r = await signInOrLink(env, request, {
    provider: "google", providerId: p.sub, email: p.email, name: p.name, avatar: safeAvatar(p.picture)
  }, saved.link === 1);
  if (r.error) return fail(r.error);
  return redirect("/#settings", [clearOauth(), ...r.cookies]);
}

// ---------- Telegram ----------
export async function telegramStart(env, request, url) {
  if (!telegramOk(env)) return err("telegram_not_configured", 503);
  const botId = env.TELEGRAM_BOT_TOKEN.split(":")[0];
  const link = url.searchParams.get("link") === "1" ? 1 : 0;
  const q = new URLSearchParams({
    bot_id: botId, origin: env.APP_ORIGIN, request_access: "write",
    return_to: env.APP_ORIGIN + "/api/auth/telegram/callback" + (link ? "?link=1" : "")
  });
  return redirect("https://oauth.telegram.org/auth?" + q);
}

export function telegramCallback(env, url) {
  if (!telegramOk(env)) return err("telegram_not_configured", 503);
  const link = url.searchParams.get("link") === "1" ? "true" : "false";
  const html = `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>finance.log</title>
<body style="font:13px monospace;background:#0D1117;color:#E6EDF3;padding:24px">-- ...
<script>
(async () => {
  let ok = false, code = "bad_request";
  try {
    const m = /tgAuthResult=([^&]+)/.exec(location.hash);
    if (m) {
      const raw = decodeURIComponent(m[1]).replace(/-/g, "+").replace(/_/g, "/");
      const bin = atob(raw + "=".repeat((4 - raw.length % 4) % 4));
      const data = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))));
      data.link = ${link};
      const r = await fetch("/api/auth/telegram", {method: "POST", credentials: "same-origin",
        headers: {"content-type": "application/json", "x-requested-with": "finance.log"}, body: JSON.stringify(data)});
      ok = r.ok;
      if (!ok) { try { code = (await r.json()).error || code; } catch {} }
    }
  } catch {}
  location.replace(ok ? "/#settings" : "/?auth_error=" + code + "#settings");
})();
</script>`;
  return new Response(html, {headers: {"content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer"}});
}

export async function telegramLogin(env, request) {
  if (!telegramOk(env)) return err("telegram_not_configured", 503);
  let body;
  try { body = await request.json(); } catch { return err("bad_request", 400); }
  if (!body || typeof body !== "object") return err("bad_request", 400);
  const link = body.link === true;
  const data = {...body};
  delete data.link;
  const v = await verifyTelegram(data, env.TELEGRAM_BOT_TOKEN);
  if (!v.ok) return err(v.error, v.error === "bad_request" ? 400 : 401);
  const name = [data.first_name, data.last_name].filter(Boolean).join(" ") || data.username || null;
  const r = await signInOrLink(env, request, {
    provider: "telegram", providerId: String(data.id), email: data.username ? "@" + data.username : null,
    name, avatar: safeAvatar(data.photo_url), username: data.username
  }, link);
  if (r.error) return err(r.error, 409);
  const headers = new Headers({"content-type": "application/json; charset=utf-8", "cache-control": "no-store"});
  for (const c of r.cookies) headers.append("set-cookie", c);
  return new Response(JSON.stringify({ok: true}), {headers});
}

export {csrfOk};
