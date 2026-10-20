const {test} = require("node:test");
const assert = require("node:assert/strict");
const S = require("../dist/core/schema.js");
const J = require("../dist/core/journal.js");
const A = require("../dist/core/accounts.js");
const C = require("../dist/core/categories.js");
const Y = require("../dist/core/sync.js");
const TODAY = "2026-10-20";
const T1 = "2026-10-21T09:00:00.000Z", T2 = "2026-10-21T10:00:00.000Z", T3 = "2026-10-21T11:00:00.000Z";
const op = (id, amount, o = {}) => ({id, type: "expense", date: TODAY, note: o.note || "", createdAt: T1, updatedAt: o.at || T1, deleted: !!o.deleted,
  legs: [{accountId: o.acc || "main", amountCents: -amount}], allocations: [], links: {}, revisions: []});
const withOps = (s, ...ops) => ({...s, operations: [...s.operations, ...ops]});
const base = () => S.empty(TODAY);
const find = (s, id) => s.operations.find(o => o.id === id);

test("toRecords/recordKey: kind и id, updatedAt по умолчанию — эпоха", () => {
  const s = withOps(base(), op("o1", 100));
  const r = Y.toRecords(s);
  const o = r.find(x => x.kind === "op");
  assert.equal(Y.recordKey(o), "op:o1");
  assert.equal(o.updatedAt, T1);
  assert.equal(r.find(x => x.kind === "account").updatedAt, "1970-01-01T00:00:00.000Z");
  assert.ok(r.some(x => x.kind === "category"));
});

test("diff: новая, изменённая, удалённая операция, переименование счёта", () => {
  const a = withOps(base(), op("o1", 100));
  assert.deepEqual(Y.diff(a, a), []);
  const added = withOps(a, op("o2", 5));
  assert.deepEqual(Y.diff(a, added).map(Y.recordKey), ["op:o2"]);
  const changed = {...a, operations: [op("o1", 200, {at: T2})]};
  assert.deepEqual(Y.diff(a, changed).map(Y.recordKey), ["op:o1"]);
  const deleted = {...a, operations: [op("o1", 100, {deleted: true, at: T2})]};
  const d = Y.diff(a, deleted);
  assert.equal(d.length, 1);
  assert.equal(d[0].deleted, true);
  const renamed = A.updateAccount(a, "main", {name: "Карта"}, T2);
  const r = Y.diff(a, renamed);
  assert.deepEqual(r.map(Y.recordKey), ["account:main"]);
  assert.equal(r[0].updatedAt, T2);
});

test("accounts/categories проставляют updatedAt; старые данные без него валидны", () => {
  let s = A.addAccount(base(), {id: "a2", name: "Нал", kind: "cash", openingDate: TODAY}, T1);
  assert.equal(s.accounts[1].updatedAt, T1);
  s = A.archiveAccount(s, "a2", true, T2);
  assert.equal(s.accounts[1].updatedAt, T2);
  s = C.addCategory(s, {id: "k1", name: "Кофе", kind: "expense"}, T1);
  s = C.updateCategory(s, "k1", {name: "Кофейни"}, T2);
  s = C.archiveCategory(s, "k1", true, T3);
  assert.equal(s.categories.find(c => c.id === "k1").updatedAt, T3);
  assert.equal(S.validate(base()).accounts[0].updatedAt, undefined);
  assert.throws(() => S.validate({...base(), accounts: [{...base().accounts[0], updatedAt: "nope"}]}));
});

test("applyRemote: вставка новой записи", () => {
  const rec = Y.toRecords(withOps(base(), op("o1", 100))).filter(r => r.kind === "op");
  const {state, skipped} = Y.applyRemote(base(), rec);
  assert.equal(state.operations.length, 1);
  assert.deepEqual(skipped, []);
});

test("applyRemote: LWW в обе стороны", () => {
  const local = withOps(base(), op("o1", 100, {at: T2}));
  const newer = {kind: "op", id: "o1", updatedAt: T3, deleted: false, data: op("o1", 300, {at: T3})};
  const older = {kind: "op", id: "o1", updatedAt: T1, deleted: false, data: op("o1", 999, {at: T1})};
  assert.equal(find(Y.applyRemote(local, [newer]).state, "o1").legs[0].amountCents, -300);
  assert.equal(find(Y.applyRemote(local, [older]).state, "o1").legs[0].amountCents, -100);
  const same = {...older, updatedAt: T2, data: op("o1", 777, {at: T2})};
  assert.equal(find(Y.applyRemote(local, [same]).state, "o1").legs[0].amountCents, -100);
  const del = {kind: "op", id: "o1", updatedAt: T3, deleted: true, data: op("o1", 100, {at: T3, deleted: true})};
  assert.equal(find(Y.applyRemote(local, [del]).state, "o1").deleted, true);
});

test("applyRemote: счёт без updatedAt заменяется удалённым", () => {
  const rec = {kind: "account", id: "main", updatedAt: T1, deleted: false, data: {...base().accounts[0], name: "Облако", updatedAt: T1}};
  assert.equal(Y.applyRemote(base(), [rec]).state.accounts[0].name, "Облако");
});

test("applyRemote: ломающая запись пропускается; со счётом в той же пачке — применяется", () => {
  const acc = {id: "a2", name: "Нал", kind: "cash", openingCents: 0, openingDate: TODAY, archived: false, updatedAt: T1};
  const rOp = {kind: "op", id: "o9", updatedAt: T1, deleted: false, data: op("o9", 50, {acc: "a2"})};
  const rAcc = {kind: "account", id: "a2", updatedAt: T1, deleted: false, data: acc};
  const rOk = {kind: "op", id: "o1", updatedAt: T1, deleted: false, data: op("o1", 10)};
  const first = Y.applyRemote(base(), [rOk, rOp]);
  assert.deepEqual(first.skipped, [{kind: "op", id: "o9"}]);
  assert.deepEqual(first.state.operations.map(o => o.id), ["o1"]);
  const both = Y.applyRemote(base(), [rOp, rAcc, rOk]);
  assert.deepEqual(both.skipped, []);
  assert.deepEqual(both.state.operations.map(o => o.id).sort(), ["o1", "o9"]);
  assert.ok(both.state.accounts.some(a => a.id === "a2"));
});

test("mergeFirst: два устройства с разными операциями объединяются", () => {
  const a = withOps(base(), op("oa", 100));
  const b = withOps(base(), op("ob", 200));
  const {state} = Y.mergeFirst(b, Y.toRecords(a));
  assert.deepEqual(state.operations.map(o => o.id).sort(), ["oa", "ob"]);
});

test("mergeFirst: пустой main берётся серверный, непустой — по LWW", () => {
  const remoteMain = {...base().accounts[0], name: "Сервер", openingCents: 5000, updatedAt: "2020-01-01T00:00:00.000Z"};
  const rec = [{kind: "account", id: "main", updatedAt: remoteMain.updatedAt, deleted: false, data: remoteMain}];
  const empty = Y.mergeFirst(base(), rec).state;
  assert.equal(empty.accounts[0].name, "Сервер");
  assert.equal(empty.accounts[0].openingCents, 5000);
  const used = A.updateAccount(withOps(base(), op("o1", 1)), "main", {name: "Моя"}, T1);
  assert.equal(Y.mergeFirst(used, rec).state.accounts[0].name, "Моя");
  const poor = A.updateAccount(base(), "main", {name: "Моя"}, T1);
  assert.equal(Y.mergeFirst(poor, rec).state.accounts[0].name, "Сервер");
});
