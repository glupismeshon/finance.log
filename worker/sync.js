import {json, err, decide, validateChange, SYNC_LIMITS} from "./util.js";
import {currentUser} from "./auth.js";

const now = () => Math.floor(Date.now() / 1000);
const keyOf = (k, id) => k + ":" + id;
const toChange = r => {
  const enc = r.enc ? 1 : 0;
  return {kind: r.kind, id: r.id, updatedAt: r.updated_at, deleted: !!r.deleted, ...(enc ? {enc: 1} : {}), data: enc ? r.data : JSON.parse(r.data), seq: r.seq};
};

async function loadStored(env, userId, changes) {
  const out = new Map();
  for (let i = 0; i < changes.length; i += 40) {
    const part = changes.slice(i, i + 40);
    const marks = part.map(() => "?").join(",");
    const res = await env.DB.prepare(
      `SELECT kind, id, seq, updated_at, deleted, enc, data FROM records WHERE user_id = ? AND (kind || ':' || id) IN (${marks})`
    ).bind(userId, ...part.map(c => keyOf(c.kind, c.id))).all();
    for (const r of res.results || []) out.set(keyOf(r.kind, r.id), r);
  }
  return out;
}

export async function sync(env, request) {
  const u = await currentUser(env, request);
  if (!u) return err("unauthorized", 401);
  const len = Number(request.headers.get("content-length"));
  if (len > SYNC_LIMITS.bodyBytes) return err("too_large", 413);
  const text = await request.text();
  if (text.length > SYNC_LIMITS.bodyBytes || new TextEncoder().encode(text).length > SYNC_LIMITS.bodyBytes) return err("too_large", 413);
  let body;
  try { body = JSON.parse(text); } catch { return err("bad_request", 400); }
  if (!body || typeof body !== "object" || !Number.isSafeInteger(body.cursor) || body.cursor < 0 ||
    typeof body.device !== "string" || !/^[\w-]{1,64}$/.test(body.device) || !Array.isArray(body.changes)) return err("bad_request", 400);
  if (body.changes.length > SYNC_LIMITS.changes) return err("too_many_changes", 413);
  const changes = [];
  const seen = new Set();
  for (const c of body.changes) {
    const v = validateChange(c);
    if (!v.ok) return err(v.error || "bad_request", v.error === "too_large" ? 413 : 400);
    const k = keyOf(v.change.kind, v.change.id);
    if (seen.has(k)) return err("bad_request", 400);
    seen.add(k);
    changes.push(v.change);
  }

  const stored = await loadStored(env, u.userId, changes);
  const accepted = [], stale = [];
  for (const c of changes) {
    const s = stored.get(keyOf(c.kind, c.id));
    if (decide(s, c) === "accept") accepted.push(c); else stale.push(s);
  }
  if (accepted.some(c => !stored.has(keyOf(c.kind, c.id)))) {
    const total = await env.DB.prepare("SELECT COUNT(*) AS n FROM records WHERE user_id = ?").bind(u.userId).first();
    const fresh = accepted.filter(c => !stored.has(keyOf(c.kind, c.id))).length;
    if ((total ? total.n : 0) + fresh > SYNC_LIMITS.records) return err("records_limit", 413);
  }

  const n = accepted.length, t = now();
  // Один batch = одна транзакция: user_seq += n, затем записи получают seq = новый seq - n + i + 1.
  const stmts = [env.DB.prepare(
    "INSERT INTO user_seq (user_id, seq, last_sync) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET seq = seq + excluded.seq, last_sync = excluded.last_sync"
  ).bind(u.userId, n, t)];
  accepted.forEach((c, i) => stmts.push(env.DB.prepare(
    `INSERT INTO records (user_id, kind, id, seq, updated_at, deleted, enc, data, device)
     VALUES (?1, ?2, ?3, (SELECT seq FROM user_seq WHERE user_id = ?1) - ?4 + ?5, ?6, ?7, ?8, ?9, ?10)
     ON CONFLICT(user_id, kind, id) DO UPDATE SET seq = excluded.seq, updated_at = excluded.updated_at, deleted = excluded.deleted,
       enc = excluded.enc, data = excluded.data, device = excluded.device
     WHERE excluded.updated_at >= records.updated_at`
  ).bind(u.userId, c.kind, c.id, n, i + 1, c.updatedAt, c.deleted ? 1 : 0, c.enc, c.json, body.device)));
  await env.DB.batch(stmts);

  const mine = await loadStored(env, u.userId, accepted);
  const acceptedOut = accepted.map(c => ({kind: c.kind, id: c.id, seq: mine.get(keyOf(c.kind, c.id)).seq}));
  const skip = new Set(acceptedOut.map(a => keyOf(a.kind, a.id)));

  const res = await env.DB.prepare(
    "SELECT kind, id, seq, updated_at, deleted, enc, data FROM records WHERE user_id = ? AND seq > ? ORDER BY seq LIMIT ?"
  ).bind(u.userId, body.cursor, SYNC_LIMITS.pull + 1).all();
  let rows = res.results || [];
  const more = rows.length > SYNC_LIMITS.pull;
  if (more) rows = rows.slice(0, SYNC_LIMITS.pull);
  let cursor = rows.length ? rows[rows.length - 1].seq : body.cursor;
  if (!more) cursor = Math.max(cursor, ...acceptedOut.map(a => a.seq));
  const out = rows.filter(r => !skip.has(keyOf(r.kind, r.id))).map(toChange);
  const have = new Set(out.map(c => keyOf(c.kind, c.id)));
  for (const s of stale) if (!have.has(keyOf(s.kind, s.id))) out.push(toChange(s));
  return json({accepted: acceptedOut, stale: stale.map(s => ({kind: s.kind, id: s.id})), changes: out, cursor, more});
}

export async function stats(env, request) {
  const u = await currentUser(env, request);
  if (!u) return err("unauthorized", 401);
  const c = await env.DB.prepare("SELECT COUNT(*) AS n FROM records WHERE user_id = ?").bind(u.userId).first();
  const s = await env.DB.prepare("SELECT last_sync FROM user_seq WHERE user_id = ?").bind(u.userId).first();
  return json({records: c ? c.n : 0, lastSync: s && s.last_sync ? new Date(s.last_sync * 1000).toISOString() : null});
}

// seq в user_seq сохраняется: курсоры других устройств остаются корректными.
export async function deleteData(env, request) {
  const u = await currentUser(env, request);
  if (!u) return err("unauthorized", 401);
  const r = await env.DB.prepare("DELETE FROM records WHERE user_id = ?").bind(u.userId).run();
  await env.DB.prepare("UPDATE user_seq SET last_sync = NULL WHERE user_id = ?").bind(u.userId).run();
  return json({ok: true, deleted: r.meta && r.meta.changes || 0});
}
