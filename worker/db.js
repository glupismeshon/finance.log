import {hashSession, SESSION_TTL, suggestHandle, handleVariant, validHandle} from "./util.js";

const now = () => Math.floor(Date.now() / 1000);

export async function sessionUser(env, token) {
  if (!token) return null;
  const idHash = await hashSession(token);
  const row = await env.DB.prepare(
    "SELECT s.id_hash, s.user_id, s.last_seen, u.name, u.avatar, u.handle, u.handle_confirmed FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ? AND s.expires_at > ?"
  ).bind(idHash, now()).first();
  if (!row) return null;
  if (now() - row.last_seen >= 3600) {
    await env.DB.prepare("UPDATE sessions SET last_seen = ? WHERE id_hash = ?").bind(now(), idHash).run();
  }
  return {idHash, userId: row.user_id, name: row.name, avatar: row.avatar, handle: row.handle, handleConfirmed: !!row.handle_confirmed};
}

export async function createSession(env, userId, token, userAgent) {
  const t = now();
  await env.DB.prepare(
    "INSERT INTO sessions (id_hash, user_id, created_at, last_seen, expires_at, user_agent) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(await hashSession(token), userId, t, t, t + SESSION_TTL, String(userAgent || "").slice(0, 200)).run();
  // заодно чистим просроченные сессии этого пользователя
  await env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND expires_at <= ?").bind(userId, t).run();
}

export const deleteSession = (env, idHash) => env.DB.prepare("DELETE FROM sessions WHERE id_hash = ?").bind(idHash).run();
export const deleteUserSessions = (env, userId) => env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId).run();

export const findIdentity = (env, provider, providerId) =>
  env.DB.prepare("SELECT user_id FROM identities WHERE provider = ? AND provider_id = ?").bind(provider, providerId).first();

const isUnique = e => /UNIQUE|constraint/i.test(String(e && (e.message || e)));
const handleTaken = async (env, h) => !!(await env.DB.prepare("SELECT 1 AS x FROM users WHERE handle = ?").bind(h).first());

// Свободный ник: base, base-2, base-3 …; окончательно защищает уникальный индекс (гонка → следующий вариант).
async function freeHandle(env, base, from = 1) {
  for (let n = from; n < from + 200; n++) {
    const h = handleVariant(base, n);
    if (validHandle(h) && !(await handleTaken(env, h))) return {h, n};
  }
  return {h: "user-" + crypto.randomUUID().slice(0, 6), n: from + 200};
}

export async function createUserWithIdentity(env, {provider, providerId, email, name, avatar, username}) {
  const id = crypto.randomUUID(), t = now();
  const base = suggestHandle({username, email: provider === "google" ? email : null, id});
  let from = 1;
  for (let attempt = 0; ; attempt++) {
    const {h, n} = await freeHandle(env, base, from);
    try {
      await env.DB.batch([
        env.DB.prepare("INSERT INTO users (id, name, avatar, created_at, handle) VALUES (?, ?, ?, ?, ?)").bind(id, name || null, avatar || null, t, h),
        env.DB.prepare("INSERT INTO identities (provider, provider_id, user_id, email, name, created_at) VALUES (?, ?, ?, ?, ?, ?)")
          .bind(provider, providerId, id, email || null, name || null, t)
      ]);
      return id;
    } catch (e) {
      if (!isUnique(e) || attempt >= 5) throw e;
      from = n + 1;
    }
  }
}

// Старому пользователю без ника назначаем автоматический (по Telegram username / email / id).
export async function ensureHandle(env, userId) {
  const row = await env.DB.prepare("SELECT handle FROM users WHERE id = ?").bind(userId).first();
  if (!row) return null;
  if (row.handle) return row.handle;
  const ids = (await env.DB.prepare("SELECT provider, email FROM identities WHERE user_id = ? ORDER BY created_at").bind(userId).all()).results || [];
  const tg = ids.find(i => i.provider === "telegram"), g = ids.find(i => i.provider === "google");
  const base = suggestHandle({username: tg && tg.email, email: g && g.email, id: userId});
  let from = 1;
  for (let attempt = 0; attempt < 6; attempt++) {
    const {h, n} = await freeHandle(env, base, from);
    try {
      const r = await env.DB.prepare("UPDATE users SET handle = ? WHERE id = ? AND handle IS NULL").bind(h, userId).run();
      if (r.meta && r.meta.changes) return h;
      return (await env.DB.prepare("SELECT handle FROM users WHERE id = ?").bind(userId).first()).handle;
    } catch (e) { if (!isUnique(e)) throw e; from = n + 1; }
  }
  return null;
}

// 'ok' | 'taken'
export async function setHandle(env, userId, handle) {
  try {
    await env.DB.prepare("UPDATE users SET handle = ?, handle_confirmed = 1 WHERE id = ?").bind(handle, userId).run();
    return "ok";
  } catch (e) { if (isUnique(e)) return "taken"; throw e; }
}

export const confirmHandle = (env, userId) => env.DB.prepare("UPDATE users SET handle_confirmed = 1 WHERE id = ?").bind(userId).run();

// Занят ли ник другим пользователем (не userId).
export async function handleTakenByOther(env, handle, userId) {
  return !!(await env.DB.prepare("SELECT 1 AS x FROM users WHERE handle = ? AND id <> ?").bind(handle, userId).first());
}

export async function attachIdentity(env, userId, {provider, providerId, email, name, avatar}) {
  const t = now();
  // у пользователя не больше одной identity на провайдера
  await env.DB.prepare("DELETE FROM identities WHERE user_id = ? AND provider = ?").bind(userId, provider).run();
  await env.DB.prepare("INSERT INTO identities (provider, provider_id, user_id, email, name, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(provider, providerId, userId, email || null, name || null, t).run();
  await env.DB.prepare("UPDATE users SET avatar = COALESCE(avatar, ?), name = COALESCE(name, ?) WHERE id = ?")
    .bind(avatar || null, name || null, userId).run();
}

export async function refreshIdentity(env, provider, providerId, {email, name, avatar}) {
  await env.DB.prepare("UPDATE identities SET email = ?, name = ? WHERE provider = ? AND provider_id = ?")
    .bind(email || null, name || null, provider, providerId).run();
  const row = await findIdentity(env, provider, providerId);
  if (row) await env.DB.prepare("UPDATE users SET avatar = COALESCE(avatar, ?), name = COALESCE(name, ?) WHERE id = ?")
    .bind(avatar || null, name || null, row.user_id).run();
}

export async function meData(env, userId) {
  const ids = await env.DB.prepare("SELECT provider, email, name FROM identities WHERE user_id = ? ORDER BY created_at").bind(userId).all();
  const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND expires_at > ?").bind(userId, now()).first();
  return {identities: ids.results || [], sessions: n ? n.n : 0};
}

export async function unlinkIdentity(env, userId, provider) {
  const c = await env.DB.prepare("SELECT COUNT(*) AS n FROM identities WHERE user_id = ?").bind(userId).first();
  if (!c || c.n <= 1) return "last_identity";
  const r = await env.DB.prepare("DELETE FROM identities WHERE user_id = ? AND provider = ?").bind(userId, provider).run();
  return r.meta && r.meta.changes ? "ok" : "not_found";
}
