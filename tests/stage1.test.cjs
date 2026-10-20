const {test} = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const S = require("../dist/core/schema.js");
const A = require("../dist/core/accounts.js");
const J = require("../dist/core/journal.js");
const V = require("../dist/core/views.js");
const TODAY = "2026-10-20", NOW = "2026-10-21T09:00:00.000Z";
const mk = () => {
  let s = S.empty(TODAY);
  s = A.updateAccount(s, "main", {name: "Сбер", openingCents: 5000000, openingDate: "2026-01-01"});
  return A.addAccount(s, {id: "tb", name: "Т-Банк", kind: "debit", openingCents: 0, openingDate: "2026-01-01"});
};
const tr = (extra = {}) => J.makeTransfer({id: "t1", fromId: "main", toId: "tb", amountCents: 1000000, date: TODAY, note: "", now: NOW, ...extra});
const exp = (id, amount, date = TODAY) => ({id, type: "expense", date, note: "x", createdAt: NOW, updatedAt: NOW, deleted: false, legs: [{accountId: "main", amountCents: -amount}], allocations: [{categoryId: null, amountCents: amount}], links: {}, revisions: []});

test("Перевод меняет остатки счетов, но не total и не доходы/расходы", () => {
  const s0 = mk(), t0 = V.totals(s0);
  const s = J.upsertOperation(s0, tr(), NOW);
  const b = V.balances(s);
  assert.equal(b.byAccount.main, 4000000);
  assert.equal(b.byAccount.tb, 1000000);
  assert.equal(b.total, V.balances(s0).total);
  assert.deepEqual(V.totals(s), t0);
});
test("Комиссия уменьшает total; удаление/восстановление перевода затрагивает обе операции", () => {
  let s = J.upsertOperation(mk(), tr(), NOW);
  const before = V.totals(s);
  s = J.upsertOperation(s, J.makeFee({id: "f1", transferId: "t1", accountId: "main", amountCents: 5000, date: TODAY, now: NOW}), NOW);
  const t = V.totals(s);
  assert.equal(t.balance, before.balance - 5000);
  assert.equal(t.expense, before.expense + 5000);
  s = J.setDeleted(s, "t1", true);
  assert.ok(s.operations.every(o => o.deleted));
  assert.equal(V.totals(s).balance, before.balance + 0);
  s = J.setDeleted(s, "t1", false);
  assert.ok(s.operations.every(o => !o.deleted));
  assert.equal(V.totals(s).balance, before.balance - 5000);
});
test("Сверка с банком создаёт корректировку; повтор не добавляет операций; учитываются только операции до даты", () => {
  let s = mk();
  s = A.updateAccount(s, "main", {openingCents: 1600000});
  s = J.upsertOperation(s, exp("e1", 100000, "2026-10-10"), NOW);
  s = J.upsertOperation(s, exp("e2", 999, "2026-10-25"), NOW);
  assert.equal(V.balances(s, "2026-10-20").byAccount.main, 1500000);
  s = J.upsertOperation(s, {...exp("e3", 0 + 20000, "2026-10-12"), deleted: false}, NOW);
  let r = J.reconcile(s, "main", 1479800, "2026-10-20", "", "adj1", NOW);
  assert.equal(r.diff, -200);
  const adj = r.state.operations.find(o => o.id === "adj1");
  assert.equal(adj.type, "adjustment");
  assert.equal(adj.note, "Сверка с банком");
  assert.equal(adj.legs[0].amountCents, -200);
  const n = r.state.operations.length;
  const r2 = J.reconcile(r.state, "main", 1479800, "2026-10-20", "", "adj2", NOW);
  assert.equal(r2.diff, 0);
  assert.equal(r2.state.operations.length, n);
  assert.equal(r2.state, r.state);
});
test("Валидация transfer/adjustment", () => {
  const s = mk();
  const bad = o => assert.throws(() => S.validate({...s, operations: [o]}));
  const t = tr();
  bad({...t, legs: [{accountId: "main", amountCents: -100}, {accountId: "main", amountCents: 100}]});
  bad({...t, legs: [{accountId: "main", amountCents: -100}, {accountId: "tb", amountCents: 99}]});
  bad({...t, legs: [...t.legs, {accountId: "main", amountCents: 0}]});
  bad({...t, allocations: [{categoryId: null, amountCents: 1}]});
  const adj = {...t, id: "a", type: "adjustment", note: "ок", legs: [{accountId: "main", amountCents: 5}]};
  assert.doesNotThrow(() => S.validate({...s, operations: [adj]}));
  assert.doesNotThrow(() => S.validate({...s, operations: [{...adj, legs: [{accountId: "main", amountCents: -5}]}]}));
  bad({...adj, note: ""});
  bad({...adj, note: "  "});
  bad({...adj, legs: [{accountId: "main", amountCents: 0}]});
  const fee = J.makeFee({id: "f", transferId: "t1", accountId: "main", amountCents: 1, date: TODAY, now: NOW});
  assert.deepEqual(S.validate({...s, operations: [{...fee, links: {feeOf: "t1", junk: 1}}]}).operations[0].links, {feeOf: "t1"});
});
test("Архив счетов", () => {
  let s = mk();
  s = J.upsertOperation(s, exp("e1", 100), NOW);
  s = A.archiveAccount(s, "main");
  assert.throws(() => A.archiveAccount(s, "tb"), /Нужен хотя бы один счёт/);
  assert.throws(() => J.upsertOperation(s, exp("e2", 5), NOW), /Счёт в архиве/);
  assert.equal(V.balances(s).total, 5000000 - 100);
  assert.deepEqual(A.activeAccounts(s).map(a => a.id), ["tb"]);
  const at = V.accountTotals(s);
  assert.equal(at.length, 1);
  assert.equal(at.archived[0].balanceCents, 4999900);
  s = A.archiveAccount(s, "main", false);
  assert.equal(A.activeAccounts(s).length, 2);
});
test("Дубль имени счёта без учёта регистра — ошибка", () => {
  const s = mk();
  assert.throws(() => A.addAccount(s, {id: "x", name: "сбЕР", kind: "cash", openingCents: 0, openingDate: TODAY}), /Счёт с таким названием уже есть\./);
  assert.throws(() => A.updateAccount(s, "tb", {name: "СБЕР"}), /уже есть/);
});
test("Миграция v1 и данные этапа 0 проходят validate без изменений", () => {
  const v1 = {version: 1, openingCents: 100, entries: [{id: "a", type: "expense", amountCents: 10, date: TODAY, note: "", createdAt: NOW, deleted: false}]};
  const st = S.migrate(v1, TODAY);
  assert.deepEqual(S.validate(st), st);
  assert.equal(st.accounts[0].order, undefined);
});
test("Модули грузятся в vm без module в порядке money, schema, accounts, categories, journal, suggest, views", () => {
  const ctx = vm.createContext({});
  for (const f of ["money", "schema", "accounts", "categories", "journal", "suggest", "views"]) vm.runInContext(fs.readFileSync(`${__dirname}/../dist/core/${f}.js`, "utf8"), ctx);
  assert.deepEqual(Object.keys(ctx.MoneyCore).sort(), ["accounts", "categories", "journal", "money", "schema", "suggest", "views"]);
});
