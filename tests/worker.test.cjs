const {test} = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const load = () => import("../worker/util.js");

const TOKEN = "123456:dev-dummy";
function tgPayload(fields, token = TOKEN) {
  const check = Object.keys(fields).sort().map(k => `${k}=${fields[k]}`).join("\n");
  const key = crypto.createHash("sha256").update(token).digest();
  return {...fields, hash: crypto.createHmac("sha256", key).update(check).digest("hex")};
}
const NOW = 1_800_000_000;

test("telegram: корректная подпись принимается", async () => {
  const U = await load();
  const d = tgPayload({id: 42, first_name: "Ann", username: "ann", auth_date: NOW - 10});
  assert.deepEqual(await U.verifyTelegram(d, TOKEN, NOW), {ok: true});
});
test("telegram: подделка, чужой токен, устаревший auth_date отклоняются", async () => {
  const U = await load();
  const d = tgPayload({id: 42, first_name: "Ann", auth_date: NOW - 10});
  assert.equal((await U.verifyTelegram({...d, id: 43}, TOKEN, NOW)).error, "bad_signature");
  assert.equal((await U.verifyTelegram(d, "123456:other", NOW)).error, "bad_signature");
  assert.equal((await U.verifyTelegram({...d, hash: "zz"}, TOKEN, NOW)).error, "bad_signature");
  const old = tgPayload({id: 42, auth_date: NOW - 86401});
  assert.equal((await U.verifyTelegram(old, TOKEN, NOW)).error, "expired");
  assert.equal((await U.verifyTelegram(d, "", NOW)).ok, false);
});
test("хеш сессии: детерминирован, sha256 hex, не равен токену", async () => {
  const U = await load();
  const h = await U.hashSession("abc");
  assert.equal(h, crypto.createHash("sha256").update("abc").digest("hex"));
  assert.notEqual(h, "abc");
  assert.match(U.randomToken(32), /^[A-Za-z0-9_-]{43}$/);
});
test("PKCE: challenge = base64url(sha256(verifier))", async () => {
  const U = await load();
  const v = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  assert.equal(await U.pkceChallenge(v), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
});
const idt = p => "h." + Buffer.from(JSON.stringify(p)).toString("base64url") + ".s";
test("id_token: aud / iss / exp", async () => {
  const U = await load();
  const ok = {aud: "cid", iss: "https://accounts.google.com", exp: NOW + 100, sub: "1", email: "a@b.c", name: "A"};
  assert.equal(U.parseIdToken(idt(ok), {aud: "cid", nowSec: NOW}).sub, "1");
  assert.equal(U.parseIdToken(idt({...ok, aud: "x"}), {aud: "cid", nowSec: NOW}), null);
  assert.equal(U.parseIdToken(idt({...ok, iss: "https://evil.com"}), {aud: "cid", nowSec: NOW}), null);
  assert.equal(U.parseIdToken(idt({...ok, exp: NOW - 1}), {aud: "cid", nowSec: NOW}), null);
  assert.equal(U.parseIdToken("garbage", {aud: "cid", nowSec: NOW}), null);
});
test("CSRF: Origin и X-Requested-With", async () => {
  const U = await load();
  const O = "https://x.example";
  const mk = (method, h) => new Request(O + "/api/x", {method, headers: h});
  assert.equal(U.csrfOk(mk("GET", {}), O), true);
  assert.equal(U.csrfOk(mk("POST", {}), O), false);
  assert.equal(U.csrfOk(mk("POST", {"x-requested-with": "finance.log"}), O), false);
  assert.equal(U.csrfOk(mk("POST", {"x-requested-with": "finance.log", origin: "https://evil.com"}), O), false);
  assert.equal(U.csrfOk(mk("POST", {"x-requested-with": "finance.log", origin: O}), O), true);
  assert.equal(U.csrfOk(mk("DELETE", {origin: O}), O), false);
});
test("подписанная cookie: подпись, срок, подмена", async () => {
  const U = await load();
  const v = await U.signValue("sec", {state: "s", exp: Date.now() + 1000});
  assert.equal((await U.verifyValue("sec", v)).state, "s");
  assert.equal(await U.verifyValue("other", v), null);
  assert.equal(await U.verifyValue("sec", v.replace(/^./, c => c === "a" ? "b" : "a")), null);
  const old = await U.signValue("sec", {state: "s", exp: Date.now() - 1});
  assert.equal(await U.verifyValue("sec", old), null);
});
test("cookie: флаги и разбор", async () => {
  const U = await load();
  const c = U.cookie("fl_session", "v", {maxAge: 5});
  for (const f of ["HttpOnly", "Secure", "SameSite=Lax", "Max-Age=5"]) assert.ok(c.includes(f));
  assert.equal(U.parseCookies("a=1; fl_session=xyz; b=2").fl_session, "xyz");
});
