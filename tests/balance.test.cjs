const {test} = require("node:test");
const assert = require("node:assert/strict");
const S = require("../dist/core/schema.js");
const A = require("../dist/core/accounts.js");
const J = require("../dist/core/journal.js");
const V = require("../dist/core/views.js");
const TODAY = "2026-10-20", NOW = "2026-10-21T09:00:00.000Z";
const mk = () => {
  let s = S.empty(TODAY);
  s = A.updateAccount(s, "main", {name: "Дебет", openingCents: 5000000, openingDate: "2026-01-01"});
  const add = (id, kind, openingCents) => { s = A.addAccount(s, {id, name: id, kind, openingCents, openingDate: "2026-01-01"}); };
  add("cash", "cash", 300000); add("pig", "savings", 2000000); add("cc", "credit_card", -1200000); add("loan", "loan", -30000000);
  return s;
};

test("breakdown: сценарий из спецификации", () => {
  const b = V.breakdown(mk());
  assert.equal(b.own, 5300000);
  assert.equal(b.savings, 2000000);
  assert.equal(b.creditCards, -1200000);
  assert.equal(b.loans, -30000000);
  assert.equal(b.other, 0);
  assert.deepEqual(b.views, {all: 5300000 + 2000000 - 1200000 - 30000000, noLoans: 6100000, noCards: 5300000 + 2000000 - 30000000, ownOnly: 7300000, loansOnly: -31200000});
  assert.equal(b.views.noLoans, V.balances(mk()).total);
});
test("breakdown: person не входит в варианты; архивные учитываются; пустое состояние", () => {
  let s = A.addAccount(mk(), {id: "p", name: "Вася", kind: "person", openingCents: 100000, openingDate: "2026-01-01"});
  s = A.updateAccount(s, "pig", {archived: true});
  const b = V.breakdown(s);
  assert.equal(b.other, 100000);
  assert.equal(b.savings, 2000000);
  assert.equal(b.views.ownOnly, 7300000);
  const e = V.breakdown(S.empty(TODAY));
  assert.deepEqual(e.views, {all: 0, noLoans: 0, noCards: 0, ownOnly: 0, loansOnly: 0});
  assert.equal(e.hasCards || e.hasLoans, false);
});
test("breakdown: операции двигают остатки групп", () => {
  const s = J.upsertOperation(mk(), {id: "e1", type: "expense", date: TODAY, note: "x", createdAt: NOW, updatedAt: NOW, deleted: false, legs: [{accountId: "cc", amountCents: -100000}], allocations: [{categoryId: null, amountCents: 100000}], links: {}, revisions: []}, NOW);
  assert.equal(V.breakdown(s).creditCards, -1300000);
  assert.equal(V.breakdown(s).views.loansOnly, -31300000);
});

test("forecast: loansOnly учитывает погашение кредитки, но не расход со своего счёта", () => {
  const SC = require("../dist/core/schedules.js");
  const F = require("../dist/core/forecast.js");
  let s = mk();
  const base = {amountCents: 100000, accountId: "main", categoryId: null,
    rule: {freq: "monthly", interval: 1, day: 20}, startDate: TODAY};
  s = SC.addSchedule(s, {...base, id: "repay", name: "Погашение", type: "transfer", toAccountId: "cc"}, NOW);
  s = SC.addSchedule(s, {...base, id: "expense", name: "Покупка", type: "expense"}, NOW);
  const fc = F.project(s, {today: TODAY, days: 1, view: "loansOnly"});
  assert.deepEqual(fc.points.map(p => p.balance), [-31100000, -31100000]);
  assert.equal(F.project(S.empty(TODAY), {today: TODAY, days: 0, view: "loansOnly"}).points[0].balance, 0);
});
