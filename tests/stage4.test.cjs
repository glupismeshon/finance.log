const {test} = require("node:test");
const assert = require("node:assert/strict");
const S = require("../dist/core/schema.js");
const J = require("../dist/core/journal.js");
const V = require("../dist/core/views.js");
const SC = require("../dist/core/schedules.js");
const F = require("../dist/core/forecast.js");
const Y = require("../dist/core/sync.js");
const TODAY = "2026-10-20", NOW = "2026-10-20T09:00:00.000Z";
const base = o => ({id: "s1", type: "expense", name: "Интернет", amountCents: 120000, accountId: "main", categoryId: null,
  rule: {freq: "monthly", interval: 1, day: 5}, startDate: "2026-01-01", endDate: null, subscription: false, paused: false, archived: false, skips: [], ...o});
const withS = (list, s = S.empty(TODAY)) => list.reduce((st, x) => SC.addSchedule(st, x, NOW), s);
const due = (s, id, from, to, today = TODAY) => SC.occurrences(s, {from, to, today}).filter(o => o.scheduleId === id).map(o => o.dueDate);
const op = (id, amount, date, o = {}) => ({id, type: "expense", date, note: "", createdAt: NOW, updatedAt: NOW, deleted: false,
  legs: [{accountId: "main", amountCents: -amount}], allocations: [], links: {}, revisions: [], ...(o.merchant ? {merchant: o.merchant} : {})});

test("правила: monthly 31 в феврале, weekly, yearly, days, start/end, paused/archived", () => {
  let s = withS([base({id: "m", rule: {freq: "monthly", interval: 1, day: 31}, startDate: "2027-01-01"}),
    base({id: "w", rule: {freq: "weekly", interval: 1, weekday: 1}, startDate: "2026-10-01"}),
    base({id: "y", rule: {freq: "yearly", interval: 1, month: 2, day: 29}, startDate: "2027-01-01"}),
    base({id: "d", rule: {freq: "days", interval: 14}, startDate: "2026-10-01", endDate: "2026-11-15"})]);
  assert.deepEqual(due(s, "m", "2027-01-01", "2027-03-31", "2027-01-01"), ["2027-01-31", "2027-02-28", "2027-03-31"]);
  assert.deepEqual(due(s, "m", "2028-02-01", "2028-02-29", "2027-01-01"), ["2028-02-29"]);
  assert.deepEqual(due(s, "y", "2027-01-01", "2029-12-31", "2027-01-01"), ["2027-02-28", "2028-02-29", "2029-02-28"]);
  assert.deepEqual(due(s, "w", "2026-10-01", "2026-10-31"), ["2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26"]);
  assert.deepEqual(due(s, "d", "2026-09-01", "2026-12-31"), ["2026-10-01", "2026-10-15", "2026-10-29", "2026-11-12"]);
  s = SC.setPaused(s, "w", true, NOW);
  s = SC.archiveSchedule(s, "d", NOW);
  assert.deepEqual(due(s, "w", "2026-10-01", "2026-10-31"), []);
  assert.deepEqual(due(s, "d", "2026-10-01", "2026-10-31"), []);
  assert.equal(s.schedules.find(x => x.id === "d").archived, true);
  assert.equal(SC.occurrences(s, {from: "2026-10-01", to: "2026-10-31", today: TODAY}).some(o => o.scheduleId === "w"), false);
});

test("статусы, подтверждение с другой суммой и deviation", () => {
  let s = withS([base({id: "kv", name: "квартира", amountCents: 2500000, rule: {freq: "monthly", interval: 1, day: 24}, startDate: "2026-08-01"})]);
  s = SC.skipOccurrence(s, "kv", "2026-09-24", NOW);
  const st = d => SC.occurrences(s, {from: "2026-08-01", to: "2026-11-30", today: TODAY}).find(o => o.dueDate === d);
  assert.equal(st("2026-08-24").status, "overdue");
  assert.equal(st("2026-09-24").status, "skipped");
  assert.equal(st("2026-10-24").status, "upcoming");
  assert.equal(SC.occurrences(s, {from: "2026-01-01", to: "2026-07-31", today: TODAY}).length, 0);
  const sc = s.schedules[0];
  const o = SC.confirmOp(sc, "2026-10-24", {amountCents: 2515000, id: "o1", now: NOW});
  s = J.upsertOperation(s, o, NOW);
  assert.equal(st("2026-10-24").status, "confirmed");
  assert.equal(st("2026-10-24").opId, "o1");
  assert.equal(SC.deviation(s, "o1"), 15000);
  assert.deepEqual(s.operations[0].links, {scheduleId: "kv", dueDate: "2026-10-24"});
  s = S.validate({...s, operations: s.operations.map(x => ({...x, deleted: true}))});
  assert.equal(st("2026-10-24").status, "upcoming");
  const old = SC.occurrences(withS([base({id: "x", rule: {freq: "days", interval: 1}, startDate: "2026-01-01"})]), {from: "2026-01-01", to: TODAY, today: TODAY});
  assert.equal(old.length, 61);
});

test("интернет: баланс меняется только после подтверждения; категория", () => {
  let s = withS([base({merchant: "Ростелеком", categoryId: "c-housing"})]);
  assert.equal(V.balances(s).total, 0);
  const o = SC.confirmOp(s.schedules[0], "2026-11-05", {id: "i1", now: NOW});
  assert.equal(o.type, "expense");
  assert.equal(o.note, "Интернет");
  assert.equal(o.merchant, "Ростелеком");
  assert.deepEqual(o.allocations, [{categoryId: "c-housing", amountCents: 120000}]);
  assert.equal(o.date, "2026-11-05");
  s = J.upsertOperation(s, o, NOW);
  assert.equal(V.balances(s).total, -120000);
  const sal = SC.confirmOp(base({id: "z", type: "income", categoryId: "c-salary", amountCents: 8000000}), "2026-11-05", {date: "2026-11-06", id: "i2", now: NOW});
  assert.equal(sal.date, "2026-11-06");
  const tr = SC.confirmOp(base({id: "t", type: "transfer", toAccountId: "cr", amountCents: 500}), "2026-11-05", {id: "i3", now: NOW});
  assert.deepEqual(tr.legs, [{accountId: "main", amountCents: -500}, {accountId: "cr", amountCents: 500}]);
});

function fx(extra = {}) {
  let s = S.empty(TODAY);
  s = {...s, accounts: [{...s.accounts[0], openingCents: 5000000}, {id: "loan", name: "Кредит", kind: "loan", openingCents: 0, openingDate: "2026-01-01", archived: false}]};
  return withS([
    base({id: "kv", name: "квартира", amountCents: 2500000, rule: {freq: "monthly", interval: 1, day: 24}, startDate: "2026-10-01"}),
    base({id: "net", name: "интернет", startDate: "2026-10-06"}),
    base({id: "zp", name: "зарплата", type: "income", amountCents: 8000000, categoryId: "c-salary", rule: {freq: "monthly", interval: 1, day: 5}, startDate: "2026-11-01"}),
    ...(extra.more || [])], s);
}

test("прогноз: nextIncome, untilIncome, точки", () => {
  const s = fx();
  const p = F.project(s, {today: TODAY, days: 60});
  assert.equal(p.points.length, 61);
  assert.equal(p.points[0].balance, 5000000);
  assert.deepEqual(p.nextIncome, {date: "2026-11-05", name: "зарплата", amountCents: 8000000});
  assert.deepEqual(p.untilIncome, {date: "2026-11-05", plannedOut: 2620000, plannedIn: 0, endBalance: 2380000});
  assert.equal(p.deficitDate, null);
  assert.equal(p.minBalance, 2500000);
  assert.equal(p.minDate, "2026-10-24");
  assert.equal(p.points.find(x => x.date === "2026-11-05").balance, 5000000 - 2620000 + 8000000);
});

test("прогноз: дефицит, перевод в кредит, вид итога", () => {
  let s = fx();
  s = SC.updateSchedule(s, "kv", {amountCents: 5100000}, NOW);
  const p = F.project(s, {today: TODAY});
  assert.equal(p.deficitDate, "2026-10-24");
  assert.equal(p.minBalance, 5000000 - 5100000);
  assert.equal(p.minDate, "2026-10-24");
  const t = withS([base({id: "tl", type: "transfer", name: "платёж по кредиту", amountCents: 1000000, toAccountId: "loan", rule: {freq: "monthly", interval: 1, day: 22}, startDate: "2026-10-01"})], {...S.empty(TODAY), accounts: fx().accounts});
  const s2 = t;
  const a = F.project(s2, {today: TODAY, days: 5});
  assert.equal(a.points[5].balance, 5000000 - 1000000);
  const b = F.project(s2, {today: TODAY, days: 5, view: "all"});
  assert.equal(b.points[5].balance, 5000000);
  assert.equal(F.project(s2, {today: TODAY, days: 5}).nextIncome, null);
  const ov = F.project(withS([base({id: "o", amountCents: 100, rule: {freq: "days", interval: 1}, startDate: "2026-10-19"})], fx()), {today: TODAY, days: 1});
  assert.equal(ov.points[0].balance, 5000000 - 200);
});

test("subscriptions: 799/мес + 2990/год", () => {
  const s = withS([base({id: "a", name: "Netflix", amountCents: 79900, subscription: true}),
    base({id: "b", name: "Облако", amountCents: 299000, subscription: true, rule: {freq: "yearly", interval: 1, month: 3, day: 1}}),
    base({id: "c", name: "не подписка", amountCents: 100})]);
  const r = SC.subscriptions(s);
  assert.equal(r.items.length, 2);
  assert.equal(r.perMonth, 104817);
  assert.equal(r.perYear, 1257800);
  assert.equal(SC.monthlyEquivalent(base({amountCents: 1000, rule: {freq: "weekly", interval: 1, weekday: 1}})), 4333);
  assert.equal(SC.monthlyEquivalent(base({amountCents: 1000, rule: {freq: "days", interval: 10}})), 3044);
});

test("detectRecurring: Netflix найден, разовые нет", () => {
  let s = S.empty(TODAY);
  const add = o => { s = J.upsertOperation(s, o, NOW); };
  for (const [i, d] of ["2026-07-22", "2026-08-21", "2026-09-20", "2026-10-20"].entries()) add({...op("n" + i, 79900 + (i === 2 ? 1000 : 0), d, {merchant: "Netflix"}), allocations: [{categoryId: "c-subscriptions", amountCents: 79900 + (i === 2 ? 1000 : 0)}]});
  add(op("r1", 50000, "2026-09-01", {merchant: "Пятёрочка"}));
  add(op("r2", 30000, "2026-09-15", {merchant: "Пятёрочка"}));
  add(op("r3", 90000, "2026-10-10", {merchant: "Пятёрочка"}));
  add(op("one", 79900, "2026-10-01", {merchant: "Чужой"}));
  const r = SC.detectRecurring(s, TODAY);
  assert.equal(r.length, 1);
  assert.deepEqual(r[0], {merchant: "Netflix", amountCents: 79900, freq: "monthly", day: 20, categoryId: "c-subscriptions", accountId: "main", count: 4});
  assert.equal(SC.detectRecurring(withS([base({id: "q", merchant: "netflix"})], s), TODAY).length, 0);
});

test("schema: правила и links", () => {
  const bad = o => assert.throws(() => withS([base(o)]));
  withS([base(), base({id: "u"})]);
  bad({rule: {freq: "monthly", interval: 1}});
  bad({rule: {freq: "weekly", interval: 1, weekday: 8}});
  bad({rule: {freq: "days", interval: 0}});
  bad({rule: {freq: "daily", interval: 1}});
  bad({amountCents: 0});
  bad({name: ""});
  bad({accountId: "nope"});
  bad({type: "transfer"});
  bad({categoryId: "c-salary"});
  bad({endDate: "2025-01-01"});
  bad({skips: ["2026-13-01"]});
  assert.throws(() => withS([base(), base()]));
  const s = S.empty(TODAY);
  const lk = links => () => J.upsertOperation(s, {...op("o", 100, TODAY), links}, NOW);
  assert.deepEqual(lk({scheduleId: "gone", dueDate: "2026-10-05"})().operations[0].links, {scheduleId: "gone", dueDate: "2026-10-05"});
  assert.throws(lk({scheduleId: "gone", dueDate: "2026-02-31"}));
  assert.throws(lk({scheduleId: "gone"}));
  assert.deepEqual(lk({})().operations[0].links, {});
  assert.deepEqual(S.validate(S.empty(TODAY)).schedules, []);
});

test("sync: schedules как kind schedule", () => {
  const s = fx();
  const recs = Y.toRecords(s).filter(r => r.kind === "schedule");
  assert.equal(recs.length, 3);
  const r = Y.applyRemote(S.empty(TODAY), Y.toRecords(s));
  assert.equal(r.skipped.length, 0);
  assert.equal(r.state.schedules.length, 3);
  const s2 = SC.setPaused(s, "net", true, "2026-10-21T09:00:00.000Z");
  assert.equal(Y.diff(s, s2).length, 1);
});
