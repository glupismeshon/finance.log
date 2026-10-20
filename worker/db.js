import {hashSession, SESSION_TTL} from "./util.js";

const now = () => Math.floor(Date.now() / 1000);

export async function sessionUser(env, token) {
  if (!token) return null;
  const idHash = await hashSession(token);
  const row = await env.DB.prepare(
    "SELECT s.id_hash, s.user_id, s.last_seen, u.name, u.avatar FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ? AND s.expires_at > ?"
  ).bind(idHash, now()).first();
  if (!row) return null;
  if (now() - row.last_seen >= 3600) {
    await env.DB.prepare("UPDATE sessions SET last_seen = ? WHERE id_hash = ?").bind(now(), idHash).run();
  }
  return {idHash, userId: row.user_id, name: row.name, avatar: row.avatar};
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

export async function createUserWithIdentity(env, {provider, providerId, email, name, avatar}) {
  const id = crypto.randomUUID(), t = now();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users (id, name, avatar, created_at) VALUES (?, ?, ?, ?)").bind(id, name || null, avatar || null, t),
    env.DB.prepare("INSERT INTO identities (provider, provider_id, user_id, email, name, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(provider, providerId, id, email || null, name || null, t)
  ]);
  return id;
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
