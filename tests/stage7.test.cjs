const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const S = require("../dist/core/schema.js");
const J = require("../dist/core/journal.js");
const V = require("../dist/core/views.js");
const AN = require("../dist/core/analytics.js");
const A = require("../dist/core/accounts.js");
const SC = require("../dist/core/schedules.js");
const M = require("../dist/core/meters.js");
const L = require("../dist/core/loans.js");
const F = require("../dist/core/forecast.js");
const Y = require("../dist/core/sync.js");
const TODAY = "2026-10-20", NOW = "2026-10-20T09:00:00.000Z";
const P = 60000000; // 600 000 ₽

const st = () => S.empty(TODAY);
const sched = o => ({id: "s1", type: "expense", name: "квартира", amountCents: 0, accountId: "main", categoryId: null, template: "bill", amountMode: "variable",
  rule: {freq: "monthly", interval: 1, day: 24}, startDate: "2026-01-01", endDate: null, subscription: false, paused: false, archived: false, skips: [], ...o});
const conf = (s, id, due, amount, opId, date) => J.upsertOperation(s, SC.confirmOp(s.schedules.find(x => x.id === id), due, {amountCents: amount, id: opId, date, now: NOW}), NOW);
const loanState = (o = {}) => {
  let s = st();
  s = A.addAccount(s, {id: "card", name: "Карта", kind: "debit", openingCents: 100000000, openingDate: "2026-01-01"}, NOW);
  return L.addLoan(s, {account: {id: "ln", name: "Кредит"}, loan: {principalCents: P, rateBp: 1990, termMonths: 60, method: "annuity", startDate: "2026-10-25", paymentDay: 25, payFromAccountId: "card", ...o}}, NOW);
};
const debt = (s, id = "ln") => 0 - V.balances(s).byAccount[id];

// ---------- кредиты ----------
test("loans.calc: 600 000 ₽, 19,9 %, 60 мес — платёж по формуле, график сходится в 0", () => {
  const i = 0.199 / 12;
  const formula = Math.round(P * i / (1 - Math.pow(1 + i, -60)));
  assert.equal(L.annuityPayment(P, 1990, 60), formula);
  assert.ok(Math.abs(formula - 1586296) <= 1 && Math.abs(formula - 1586300) < 10); // ≈ 15 863 ₽
  const c = L.calc({principalCents: P, rateBp: 1990, termMonths: 60, method: "annuity", startDate: "2026-10-25", paymentDay: 25});
  assert.equal(c.payment, formula);
  assert.equal(c.rows.length, 60);
  assert.equal(c.rows[59].balance, 0);
  assert.equal(c.rows.reduce((s, r) => s + r.principal, 0), P);
  assert.equal(c.totalPaid, c.rows.reduce((s, r) => s + r.payment, 0));
  assert.equal(c.overpayment, c.totalPaid - P);
  assert.equal(c.rows[0].date, "2026-11-25");
  assert.equal(c.rows[0].interest, Math.round(P * 0.199 * 31 / 365)); // 31 день, год 365
  assert.equal(c.rows[0].payment, formula);
  assert.equal(c.rows[1].interest, Math.round((P - c.rows[0].principal) * 0.199 * 30 / 365));
  for (const r of c.rows) assert.equal(r.payment, r.interest + r.principal);
  for (let k = 1; k < 60; k++) assert.ok(c.rows[k].balance < c.rows[k - 1].balance && c.rows[k].n === k + 1);
  // последний платёж добивает остаток; отличие от формулы — из-за дней в месяце (не больше нескольких тысяч ₽)
  assert.ok(Math.abs(c.rows[59].payment - formula) < 600000);
  assert.ok(Math.abs(c.overpayment - (formula * 60 - P)) < 600000);
  assert.deepEqual(L.calc({principalCents: 120000, rateBp: 0, termMonths: 12, method: "annuity", startDate: "2026-01-01", paymentDay: 5}).rows.map(r => r.payment), Array(12).fill(10000));
});

test("loans.calc: дифференцированный — платёж убывает, основной долг равный", () => {
  const c = L.calc({principalCents: P, rateBp: 1990, termMonths: 60, method: "diff", startDate: "2026-10-25", paymentDay: 25});
  assert.equal(c.rows.length, 60);
  assert.equal(c.rows[59].balance, 0);
  assert.equal(c.rows.reduce((s, r) => s + r.principal, 0), P);
  assert.equal(c.rows[0].principal, 1000000);
  // разное число дней в месяцах даёт шум до одного дня процентов; по году платёж стабильно убывает
  for (let k = 12; k < 60; k++) assert.ok(c.rows[k].payment < c.rows[k - 12].payment);
  assert.ok(c.rows[59].payment < c.rows[0].payment / 1.5);
  assert.equal(c.payment, c.rows[0].payment);
  const ann = L.calc({principalCents: P, rateBp: 1990, termMonths: 60, method: "annuity", startDate: "2026-10-25", paymentDay: 25});
  assert.ok(c.overpayment < ann.overpayment);
  for (const bad of [{principalCents: 0}, {rateBp: -1}, {termMonths: 0}, {method: "x"}, {startDate: "2026-02-31"}, {paymentDay: 32}])
    assert.throws(() => L.calc({principalCents: P, rateBp: 1990, termMonths: 60, method: "annuity", startDate: "2026-10-25", paymentDay: 25, ...bad}));
});

test("loans.split: проценты по дням — 30/31 день, високосный год, стык лет", () => {
  const mk = (rateStart, principal) => loanState({principalCents: principal, rateBp: 1200, startDate: rateStart, termMonths: 12});
  // 365 000 ₽ под 12 % в невисокосном 2027: ровно 120 ₽ в день
  const s = mk("2027-01-01", 36500000);
  assert.deepEqual(L.split(s, "ln", 5000000, "2027-01-31"), {interest: 30 * 12000, principal: 5000000 - 360000});
  assert.deepEqual(L.split(s, "ln", 5000000, "2027-02-01"), {interest: 31 * 12000, principal: 5000000 - 372000});
  // високосный 2028: 366 000 ₽ — 120 ₽ в день
  const leap = mk("2028-01-01", 36600000);
  assert.equal(L.split(leap, "ln", 5000000, "2028-02-01").interest, 31 * 12000);
  assert.equal(L.split(leap, "ln", 5000000, "2028-03-01").interest, 60 * 12000);
  // стык лет: 11 дней по /365 и 10 дней по /366
  const x = mk("2027-12-21", 36500000);
  assert.equal(L.split(x, "ln", 5000000, "2028-01-11").interest, Math.round(36500000 * 0.12 * 11 / 365 + 36500000 * 0.12 * 10 / 366));
  // платёж меньше процентов: всё — проценты
  assert.deepEqual(L.split(s, "ln", 100, "2027-01-31"), {interest: 100, principal: 0});
  // дата выдачи: процентов ещё нет
  assert.deepEqual(L.split(s, "ln", 100000, "2027-01-01"), {interest: 0, principal: 100000});
});

test("addLoan: счёт loan, запись loans, правило template loan; платёж и totals", () => {
  let s = loanState();
  const acc = s.accounts.find(a => a.id === "ln");
  assert.deepEqual([acc.kind, acc.openingCents, acc.openingDate], ["loan", -P, "2026-10-25"]);
  assert.equal(s.loans.length, 1);
  assert.equal(s.loans[0].accountId, "ln");
  assert.equal(s.loans[0].id, "ln");
  const sc = s.schedules[0];
  assert.deepEqual([sc.template, sc.type, sc.accountId, sc.toAccountId, sc.startDate, sc.endDate, sc.amountCents], ["loan", "transfer", "card", "ln", "2026-11-25", "2031-10-25", 1586296]);
  assert.throws(() => SC.confirmOp(sc, "2026-11-25", {id: "x", now: NOW}), /loans\.paymentOp/);
  // подтверждение первого платежа
  const op = L.paymentOp(s, sc.id, "2026-11-25", {id: "p1", now: NOW});
  assert.equal(op.type, "loan_payment");
  assert.equal(-op.legs[0].amountCents, 1586296);
  const interest = Math.round(P * 0.199 * 31 / 365);
  assert.equal(op.legs[1].amountCents, 1586296 - interest);
  assert.deepEqual(op.allocations, [{categoryId: "c-loan_interest", amountCents: interest}]);
  assert.deepEqual(op.links, {loanAccountId: "ln", scheduleId: sc.id, dueDate: "2026-11-25"});
  s = J.upsertOperation(s, op, NOW);
  assert.equal(SC.occurrences(s, {from: "2026-11-01", to: "2026-11-30", today: "2026-11-25"})[0].status, "confirmed");
  // расход = только проценты; долг уменьшился на основной долг; со счёта ушёл весь платёж
  assert.equal(V.totals(s).expense, interest);
  assert.equal(debt(s), P - (1586296 - interest));
  assert.equal(V.balances(s).byAccount.card, 100000000 - 1586296);
  assert.equal(AN.summary(s, {from: "2026-11-01", to: "2026-11-30"}).expense, interest);
  assert.deepEqual(V.spending(s, {from: "2026-11-01", to: "2026-11-30"}), [{id: "c-loan_interest", cents: interest}]);
  assert.deepEqual(AN.daily(s, {from: "2026-11-01", to: "2026-11-30"}), {"2026-11-25": interest});
  assert.equal(AN.byCategory(s, {from: "2026-11-01", to: "2026-11-30"})[0].id, "c-loan_interest");
  // график перестроен: 59 строк, следующая дата 25.12, нумерация продолжается
  const g = L.schedule(s, "ln", "2026-11-25");
  assert.equal(g.rows.length, 59);
  assert.deepEqual([g.rows[0].date, g.rows[0].n, g.paid, g.rows[58].balance], ["2026-12-25", 2, 1, 0]);
  assert.equal(g.rows.reduce((t, r) => t + r.principal, 0), debt(s));
  // платёж с цифрами из банка: проценты вписаны вручную
  const manual = L.paymentOp(s, sc.id, "2026-12-25", {id: "p2", now: NOW, amountCents: 1586296, interestCents: 1000000});
  assert.equal(manual.legs[1].amountCents, 586296);
  assert.throws(() => L.paymentOp(s, sc.id, "2026-12-25", {id: "p2", now: NOW, amountCents: 100, interestCents: 200}));
  // дубли и некорректные кредиты
  assert.throws(() => L.addLoan(s, {account: {id: "ln2", name: "Кредит"}, loan: {principalCents: P, rateBp: 1990, termMonths: 60, method: "annuity", startDate: "2026-10-25", paymentDay: 25, payFromAccountId: "card"}}, NOW));
  assert.throws(() => L.addLoan(s, {account: {id: "ln3", name: "Другой"}, loan: {principalCents: P, rateBp: 1990, termMonths: 60, method: "annuity", startDate: "2026-10-25", paymentDay: 25, payFromAccountId: "nope"}}, NOW));
});

test("loan_payment: инварианты валидации", () => {
  const s = loanState();
  const base = {id: "o", type: "loan_payment", date: "2026-11-25", note: "", createdAt: NOW, updatedAt: NOW, deleted: false, revisions: [],
    legs: [{accountId: "card", amountCents: -100000}, {accountId: "ln", amountCents: 70000}], allocations: [{categoryId: "c-loan_interest", amountCents: 30000}], links: {loanAccountId: "ln"}};
  const ok = o => S.validate({...s, operations: [{...base, ...o}]});
  const bad = o => assert.throws(() => ok(o));
  ok({});
  ok({allocations: [{categoryId: null, amountCents: 30000}]});
  ok({legs: [{accountId: "card", amountCents: -100000}, {accountId: "ln", amountCents: 100000}], allocations: []});
  ok({legs: [{accountId: "card", amountCents: -100000}, {accountId: "ln", amountCents: 0}], allocations: [{categoryId: null, amountCents: 100000}]});
  bad({allocations: []});                                                                                    // Σ allocations ≠ платёж − долг
  bad({allocations: [{categoryId: "c-loan_interest", amountCents: 29999}]});
  bad({legs: [{accountId: "card", amountCents: -100000}, {accountId: "ln", amountCents: -1}], allocations: [{categoryId: null, amountCents: 100001}]}); // долг < 0
  bad({legs: [{accountId: "card", amountCents: -100000}, {accountId: "ln", amountCents: 100001}], allocations: []});                     // долг > платежа
  bad({legs: [{accountId: "card", amountCents: 100000}, {accountId: "ln", amountCents: 70000}]});
  bad({legs: [{accountId: "card", amountCents: -100000}]});
  bad({legs: [{accountId: "card", amountCents: -100000}, {accountId: "card", amountCents: 70000}]});
  bad({allocations: [{categoryId: "c-salary", amountCents: 30000}]});                                       // не расходная категория
  bad({links: {}});
  bad({links: {loanAccountId: "card"}});
  bad({links: {loanAccountId: "ln", early: "x"}});
  assert.deepEqual(ok({links: {loanAccountId: "ln", early: "term"}}).operations[0].links, {loanAccountId: "ln", early: "term"});
  // удалённая операция не влияет на totals
  assert.equal(V.totals(ok({deleted: true})).expense, 0);
  assert.equal(V.totals(ok({})).expense, 30000);
});

test("loans.early: term сохраняет платёж и сокращает срок, payment уменьшает платёж; переплата падает", () => {
  let s = loanState();
  const sc = s.schedules[0];
  s = J.upsertOperation(s, L.paymentOp(s, sc.id, "2026-11-25", {id: "p1", now: NOW}), NOW);
  const before = L.schedule(s, "ln", "2026-12-01");
  const t = L.early(s, "ln", 10000000, "2026-12-01", "term", {id: "e1", now: NOW});
  assert.equal(t.op.type, "loan_payment");
  assert.deepEqual(t.op.links, {loanAccountId: "ln", early: "term"});
  assert.equal(t.op.legs[0].amountCents, -10000000);
  const accrued = Math.round(debt(s) * 0.199 * 6 / 365);
  assert.equal(t.op.allocations[0].amountCents, accrued);
  assert.equal(t.op.legs[1].amountCents, 10000000 - accrued);
  assert.equal(t.after.payment, before.payment);                // тот же платёж
  assert.ok(t.after.termLeft < before.termLeft);                // меньше месяцев
  assert.ok(t.savings > 0 && t.after.overpayment < t.before.overpayment);
  assert.equal(t.after.balance, debt(s) - (10000000 - accrued));
  assert.equal(t.schedule.rows[t.schedule.rows.length - 1].balance, 0);
  assert.equal(t.state.schedules[0].endDate, t.after.endDate);  // правило обновлено
  assert.equal(t.state.schedules[0].amountCents, t.after.payment);
  // регулярные платежи после досрочки не сдвигают даты: следующий — 25.12, проценты за дни с досрочки
  assert.equal(t.schedule.rows[0].date, "2026-12-25");
  assert.equal(t.schedule.rows[0].interest, Math.round(t.after.balance * 0.199 * 24 / 365));

  const p = L.early(s, "ln", 10000000, "2026-12-01", "payment", {id: "e2", now: NOW});
  assert.ok(p.after.payment < before.payment);                  // меньше платёж
  assert.equal(p.after.termLeft, before.termLeft);              // тот же срок
  assert.ok(p.savings > 0);
  assert.equal(p.schedule.rows[p.schedule.rows.length - 1].balance, 0);
  assert.ok(p.after.payment > 0 && p.savings < t.savings);       // сокращение срока выгоднее по переплате
  assert.throws(() => L.early(s, "ln", 10000000, "2026-12-01", "x", {id: "e", now: NOW}));
  assert.throws(() => L.early(s, "ln", 100, "2026-12-01", "term", {id: "e", now: NOW}), /процент/);
  assert.throws(() => L.early(s, "ln", P * 2, "2026-12-01", "term", {id: "e", now: NOW}), /остатка/);
  // полное погашение: график пуст, правило архивируется
  const full = L.early(s, "ln", debt(s) + Math.round(debt(s) * 0.199 * 6 / 365), "2026-12-01", "term", {id: "e3", now: NOW});
  assert.equal(debt(full.state), 0);
  assert.equal(L.schedule(full.state, "ln", "2026-12-01").rows.length, 0);
  assert.equal(full.state.schedules[0].archived, true);
  // досрочка у дифференцированного
  const d = loanState({method: "diff"});
  const de = L.early(d, "ln", 10000000, "2026-12-01", "term", {id: "e", now: NOW});
  assert.ok(de.after.termLeft < de.before.termLeft && de.savings > 0);
});

test("reconcile по кредиту: корректировка и перестроение графика", () => {
  let s = loanState();
  s = J.upsertOperation(s, L.paymentOp(s, s.schedules[0].id, "2026-11-25", {id: "p1", now: NOW}), NOW);
  const r = J.reconcile(s, "ln", -50000000, "2026-11-26", "Сверка с банком", "adj1", NOW);
  assert.equal(r.state.operations.some(o => o.type === "adjustment"), true);
  assert.equal(debt(r.state), 50000000);
  const g = L.schedule(r.state, "ln", "2026-11-26");
  assert.equal(g.balance, 50000000);
  assert.equal(g.rows.reduce((t, x) => t + x.principal, 0), 50000000);
  assert.equal(g.rows[g.rows.length - 1].balance, 0);
  assert.equal(g.rows[0].date, "2026-12-25");
});

test("кредитная карта: лимит и доступно; кредит в прогнозе", () => {
  let s = A.addAccount(st(), {id: "cc", name: "Карта", kind: "credit_card", openingCents: -3000000, openingDate: "2026-01-01", limitCents: 10000000}, NOW);
  assert.equal(s.accounts.find(a => a.id === "cc").limitCents, 10000000);
  assert.equal(V.available(s, "cc"), 7000000);
  assert.equal(V.available(s, "main"), null);
  s = A.updateAccount(s, "cc", {limitCents: null}, NOW);
  assert.equal(V.available(s, "cc"), null);
  assert.equal("limitCents" in s.accounts.find(a => a.id === "cc"), false);
  s = A.updateAccount(s, "cc", {limitCents: 5000000}, NOW);
  assert.throws(() => A.updateAccount(s, "main", {limitCents: 100}, NOW));
  assert.throws(() => A.updateAccount(s, "cc", {limitCents: -1}, NOW));
  s = A.updateAccount(s, "cc", {kind: "debit"}, NOW);
  assert.equal("limitCents" in s.accounts.find(a => a.id === "cc"), false);
});

test("forecast: платёж по кредиту — со счёта платёж, на кредит основной долг", () => {
  const s = loanState();
  const row = L.schedule(s, "ln", TODAY).rows[0];
  const a = F.project(s, {today: TODAY, days: 40});
  assert.equal(a.points[0].balance, 100000000);
  assert.equal(a.points[40].balance, 100000000 - row.payment);          // вид noLoans: кредит не в итоге
  const all = F.project(s, {today: TODAY, days: 40, view: "all"});
  assert.equal(all.points[0].balance, 100000000 - P);
  assert.equal(all.points[40].balance, 100000000 - P - row.interest);    // платёж − основной долг = проценты
  assert.equal(a.points.find(p => p.date === "2026-11-24").balance, 100000000);
  assert.equal(a.points.find(p => p.date === "2026-11-25").balance, 100000000 - row.payment);
  // после подтверждённого платежа второй платёж берётся из перестроенного графика
  const s2 = J.upsertOperation(s, L.paymentOp(s, s.schedules[0].id, "2026-11-25", {id: "p1", now: NOW}), NOW);
  const g2 = L.schedule(s2, "ln", "2026-11-26");
  const b = F.project(s2, {today: "2026-11-26", days: 40});
  assert.equal(b.points.find(p => p.date === "2026-12-25").balance - b.points[0].balance, -g2.rows[0].payment);
});

test("migrate: недостающие стандартные категории по id; пользовательский список не трогаем", () => {
  const old = {...st(), categories: st().categories.filter(c => c.id !== "c-loan_interest")};
  assert.equal(old.categories.some(c => c.id === "c-loan_interest"), false);
  const m = S.migrate(old, TODAY);
  const c = m.categories.find(x => x.id === "c-loan_interest");
  assert.deepEqual([c.key, c.kind, c.parentId, c.archived], ["loan_interest", "expense", null, false]);
  assert.equal(m.categories.length, S.DEFAULT_CATEGORIES.length);
  assert.equal(new Set(m.categories.map(x => x.order)).size, m.categories.length);
  assert.deepEqual(m.readings, []);
  const custom = [{id: "x", key: null, name: "Моя", parentId: null, kind: "expense", archived: false, order: 0}];
  assert.deepEqual(S.migrate({...st(), categories: custom}, TODAY).categories, custom);
  // состояние без readings валидно (старые копии)
  const {readings, ...noReadings} = st();
  assert.deepEqual(S.validate(noReadings).readings, []);
});

// ---------- виды регулярных платежей, счётчики ----------
test("template/amountMode: умолчания для старых правил и ограничения", () => {
  const old = {id: "o", type: "expense", name: "x", amountCents: 100, accountId: "main", categoryId: null, rule: {freq: "monthly", interval: 1, day: 5},
    startDate: "2026-01-01", endDate: null, subscription: false, paused: false, archived: false, skips: []};
  const get = (o) => SC.addSchedule(st(), {...old, ...o}, NOW).schedules[0];
  assert.deepEqual([get({}).template, get({}).amountMode], ["fixed", "fixed"]);
  assert.equal(get({subscription: true}).template, "subscription");
  assert.equal(get({subscription: true}).subscription, true);
  assert.equal(get({type: "income"}).template, "income");
  assert.equal(get({template: "subscription"}).subscription, true);
  assert.deepEqual([get({template: "bill", amountCents: 0}).amountMode, get({template: "bill"}).template], ["variable", "bill"]);
  assert.equal(get({template: "income", type: "income", amountMode: "variable", amountCents: 0}).amountMode, "variable");
  assert.throws(() => get({template: "bill", amountMode: "fixed"}));
  assert.throws(() => get({template: "fixed", amountMode: "variable"}));
  assert.throws(() => get({amountCents: 0}));                         // фикс. без суммы
  assert.throws(() => get({template: "x"}));
  assert.throws(() => get({template: "income"}));                      // income только для type income
  assert.throws(() => get({template: "loan"}));                        // loan только transfer
  assert.throws(() => get({meters: [{id: "m", name: "свет", unit: "kWh", archived: false}]}));  // счётчики только у bill
  assert.throws(() => get({template: "bill", readingsDay: 32}));
  const m = get({template: "bill", amountCents: 0, readingsDay: 25, meters: [{id: "m1", name: " свет день ", unit: "kWh", tariffCents: 643, archived: false}, {id: "m2", name: "вода", unit: "m3", archived: false}]});
  assert.deepEqual(m.meters, [{id: "m1", name: "свет день", unit: "kWh", archived: false, tariffCents: 643}, {id: "m2", name: "вода", unit: "m3", archived: false}]);
  assert.equal(m.readingsDay, 25);
  assert.throws(() => get({template: "bill", meters: [{id: "m1", name: "a", unit: "kWh", archived: false}, {id: "m1", name: "b", unit: "kWh", archived: false}]}));
  assert.throws(() => get({template: "bill", meters: [{id: "m1", name: "a", unit: "L", archived: false}]}));
  // переключение флага subscription старым способом
  let s = SC.addSchedule(st(), old, NOW);
  s = SC.updateSchedule(s, "o", {subscription: true}, NOW);
  assert.equal(s.schedules[0].template, "subscription");
  s = SC.updateSchedule(s, "o", {subscription: false}, NOW);
  assert.equal(s.schedules[0].template, "fixed");
});

test("variable: awaiting (в том числе старше 60 дней), estimate = медиана последних 3", () => {
  let s = SC.addSchedule(st(), sched({amountCents: 2500000, startDate: "2026-04-01"}), NOW);
  const occ = () => SC.occurrences(s, {from: "2026-04-01", to: "2026-11-30", today: TODAY});
  const byDue = d => occ().find(o => o.dueDate === d);
  assert.equal(byDue("2026-04-24").status, "awaiting");               // старше 60 дней — всё равно ждёт
  assert.equal(byDue("2026-10-24").status, "upcoming");
  assert.equal(byDue("2026-10-24").estimated, true);
  assert.equal(byDue("2026-10-24").amountCents, 2500000);           // нет подтверждённых — примерная сумма
  assert.equal(occ().filter(o => o.status === "awaiting").length, 6);
  assert.equal(SC.estimate(s, "s1"), 2500000);
  // 4 подтверждения: берутся последние 3 по сроку, медиана
  s = conf(s, "s1", "2026-04-24", 100, "a1");
  s = conf(s, "s1", "2026-05-24", 3000000, "a2");
  s = conf(s, "s1", "2026-06-24", 2600000, "a3");
  s = conf(s, "s1", "2026-07-24", 2800000, "a4");
  assert.equal(SC.estimate(s, "s1"), 2800000);                        // медиана 3000000, 2600000, 2800000
  assert.equal(byDue("2026-07-24").status, "confirmed");
  assert.equal(byDue("2026-07-24").amountCents, 2800000);            // у подтверждённого — фактическая сумма
  assert.equal(byDue("2026-09-24").amountCents, 2800000);
  s = SC.skipOccurrence(s, "s1", "2026-08-24", NOW);
  assert.equal(byDue("2026-08-24").status, "skipped");
  assert.equal(byDue("2026-09-24").status, "awaiting");
  // без суммы вообще: оценка 0 и пометка noEstimate
  const z = SC.addSchedule(st(), sched({id: "z", amountCents: 0}), NOW);
  assert.equal(SC.estimate(z, "z"), 0);
  const zo = SC.occurrences(z, {from: "2026-10-01", to: "2026-10-31", today: TODAY})[0];
  assert.deepEqual([zo.status, zo.amountCents, zo.noEstimate, zo.estimated], ["upcoming", 0, true, true]);
  // подтверждение variable: сумма обязательна
  assert.throws(() => SC.confirmOp(z.schedules[0], "2026-10-24", {id: "x", now: NOW}));
  assert.equal(SC.confirmOp(z.schedules[0], "2026-10-24", {id: "x", now: NOW, amountCents: 2400000}).legs[0].amountCents, -2400000);
  // удалённое подтверждение возвращает awaiting
  const del = J.setDeleted(s, "a4", true);
  assert.equal(SC.occurrences(del, {from: "2026-07-01", to: "2026-07-31", today: TODAY})[0].status, "awaiting");
  // фикс. платёж по-прежнему overdue и пропадает через 60 дней
  const f = SC.addSchedule(st(), {...sched({id: "f"}), template: "fixed", amountMode: "fixed", amountCents: 100, startDate: "2026-04-01"}, NOW);
  assert.equal(SC.occurrences(f, {from: "2026-04-01", to: "2026-10-31", today: TODAY}).filter(o => o.status === "overdue").length, 2);
});

test("meters: показания, дельты, стоимость по тарифам, проверка убывания", () => {
  let s = SC.addSchedule(st(), sched({amountCents: 0, readingsDay: 25, meters: [{id: "e", name: "свет день", unit: "kWh", tariffCents: 643, archived: false},
    {id: "w", name: "хол. вода", unit: "m3", tariffCents: 4550, archived: false}, {id: "g", name: "газ", unit: "m3", archived: false}]}), NOW);
  const add = (id, meterId, date, valueMilli) => { s = M.addReading(s, {id, scheduleId: "s1", meterId, date, valueMilli}, NOW); };
  add("r1", "e", "2026-08-25", 1200000);
  add("r2", "e", "2026-09-25", 1350000);
  add("r3", "e", "2026-10-25", 1500500);
  assert.deepEqual(M.consumption(s, "s1", "e"), [{id: "r1", date: "2026-08-25", valueMilli: 1200000, deltaMilli: null},
    {id: "r2", date: "2026-09-25", valueMilli: 1350000, deltaMilli: 150000}, {id: "r3", date: "2026-10-25", valueMilli: 1500500, deltaMilli: 150500}]);
  add("w1", "w", "2026-09-25", 123456);
  add("w2", "w", "2026-10-25", 127656);
  const d = M.deltasAt(s, "s1", "2026-10-25");
  assert.deepEqual(d, {e: 150500, w: 4200});
  const sc = s.schedules[0];
  // 150,5 кВт·ч × 6,43 = 967,715 -> 96772 коп.; 4,2 м³ × 45,50 = 191,10 -> 19110 коп.
  assert.equal(M.costFor(sc, d), Math.round(150500 * 643 / 1000) + Math.round(4200 * 4550 / 1000));
  assert.equal(M.costFor(sc, d), 96772 + 19110);
  assert.equal(M.costFor(sc, [{meterId: "e", deltaMilli: 150000}]), 96450);
  assert.equal(M.costFor(sc, {g: 5000}), 0);                          // нет тарифа
  assert.equal(M.costFor(sc, {}), 0);
  // ошибки: меньше прошлого, больше следующего, неизвестный счётчик, дубль id
  assert.throws(() => add("bad", "e", "2026-11-25", 1500499), /меньше прошлого/);
  assert.throws(() => add("bad", "e", "2026-09-30", 1499999999), /больше следующего/);
  assert.throws(() => add("bad", "e", "2026-09-30", 1100000), /меньше прошлого/);
  assert.throws(() => add("bad", "zz", "2026-11-25", 1), /Счётчик/);
  assert.throws(() => add("r1", "e", "2026-11-25", 1600000));
  assert.throws(() => add("bad", "e", "2026-11-25", -1));
  assert.throws(() => add("bad", "e", "2026-11-31", 1));
  add("ok", "e", "2026-11-25", 1500500);                              // равное допустимо
  // исправление прошлого с той же проверкой
  s = M.updateReading(s, "r2", {valueMilli: 1360000}, "2026-10-21T00:00:00.000Z");
  assert.equal(M.consumption(s, "s1", "e")[1].deltaMilli, 160000);
  assert.throws(() => M.updateReading(s, "r2", {valueMilli: 1199999}, NOW), /меньше прошлого/);
  assert.throws(() => M.updateReading(s, "r2", {valueMilli: 1600000}, NOW), /больше следующего/);
  // удалённое показание исчезает из истории, дельта пересчитывается
  s = M.deleteReading(s, "r2", NOW);
  assert.deepEqual(M.consumption(s, "s1", "e").map(r => r.deltaMilli), [null, 300500, 0]);
  assert.equal(s.readings.find(r => r.id === "r2").deleted, true);
  // напоминания: окно [readingsDay − 5, readingsDay]
  const rem = d => M.reminders(s, d).map(r => [r.scheduleId, r.deadline, r.daysLeft]);
  assert.deepEqual(rem("2026-12-19"), []);
  assert.deepEqual(rem("2026-12-20"), [["s1", "2026-12-25", 5]]);
  assert.deepEqual(rem("2026-12-25"), [["s1", "2026-12-25", 0]]);
  assert.deepEqual(rem("2026-12-26"), []);
  assert.equal(M.reminders(s, "2026-11-22").length, 1); // 25.11 передано только по "e", не по "w" и "g"
  for (const [id, m] of [["x1", "e"], ["x2", "w"], ["x3", "g"]]) s = M.addReading(s, {id, scheduleId: "s1", meterId: m, date: "2026-12-22", valueMilli: 9000000}, NOW);
  assert.deepEqual(rem("2026-12-24"), []);
  // у месяца с 30 днями readingsDay 31 прижимается к концу месяца
  const t = SC.updateSchedule(s, "s1", {readingsDay: 31}, NOW);
  assert.equal(M.reminders(t, "2026-11-28")[0].deadline, "2026-11-30");
});

test("readings: синхронизация kind reading (toRecords/applyRemote/diff) и белый список worker", async () => {
  let s = SC.addSchedule(st(), sched({amountCents: 0, meters: [{id: "e", name: "свет", unit: "kWh", archived: false}]}), NOW);
  s = M.addReading(s, {id: "r1", scheduleId: "s1", meterId: "e", date: "2026-10-25", valueMilli: 1000}, "2026-10-21T09:00:00.000Z");
  const recs = Y.toRecords(s).filter(r => r.kind === "reading");
  assert.equal(recs.length, 1);
  assert.deepEqual([recs[0].id, recs[0].deleted, recs[0].updatedAt], ["r1", false, "2026-10-21T09:00:00.000Z"]);
  const r = Y.applyRemote(st(), Y.toRecords(s));
  assert.equal(r.skipped.length, 0);
  assert.equal(r.state.readings.length, 1);
  assert.equal(r.state.schedules.length, 1);
  // удаление приходит записью deleted
  const s2 = M.deleteReading(s, "r1", "2026-10-22T09:00:00.000Z");
  const d = Y.diff(s, s2);
  assert.deepEqual(d.map(Y.recordKey), ["reading:r1"]);
  assert.equal(d[0].deleted, true);
  const r2 = Y.applyRemote(r.state, d);
  assert.equal(r2.state.readings[0].deleted, true);
  // старая запись не перезаписывает новую
  assert.equal(Y.applyRemote(s2, recs).state.readings[0].deleted, true);
  // кредит синхронизируется как kind loan с id = accountId
  const ls = loanState();
  const lr = Y.toRecords(ls).filter(x => x.kind === "loan");
  assert.deepEqual(lr.map(x => x.id), ["ln"]);
  const back = Y.applyRemote(st(), Y.toRecords(ls));
  assert.equal(back.skipped.length, 0);
  assert.equal(back.state.loans.length, 1);
  const {SYNC_KINDS} = await import("../worker/util.js");
  assert.ok(SYNC_KINDS.includes("reading") && SYNC_KINDS.includes("loan"));
});

test("forecast: variable по оценке — точка и строка помечены estimated", () => {
  let s = SC.addSchedule(st(), sched({amountCents: 2500000, startDate: "2026-10-01"}), NOW);
  s = SC.addSchedule(s, {...sched({id: "zp"}), template: "income", type: "income", amountMode: "fixed", name: "зарплата", amountCents: 8000000, categoryId: "c-salary",
    rule: {freq: "monthly", interval: 1, day: 5}, startDate: "2026-11-01"}, NOW);
  s = SC.addSchedule(s, {...sched({id: "net"}), template: "fixed", amountMode: "fixed", name: "интернет", amountCents: 100000, rule: {freq: "monthly", interval: 1, day: 22}, startDate: "2026-10-01"}, NOW);
  const p = F.project(s, {today: TODAY, days: 30});
  const at = d => p.points.find(x => x.date === d);
  assert.equal(at("2026-10-24").estimated, true);
  assert.equal(at("2026-10-22").estimated, undefined);
  assert.equal(at("2026-10-24").balance, -100000 - 2500000);
  assert.equal(p.untilIncome.estimated, true);
  assert.equal(p.untilIncome.plannedOut, 2600000);
  assert.equal(p.nextIncome.estimated, undefined);
  // ждёт суммы с прошлого срока: идёт в сегодняшний день по оценке
  const q = F.project(s, {today: "2026-10-26", days: 10});
  assert.equal(q.points[0].estimated, true);
  assert.equal(q.points[0].balance, -2500000 - 100000);  // 24.10 ждёт суммы (оценка) + просроченный интернет
  // подтверждённая — фактом, без оценки
  const c = conf(s, "s1", "2026-10-24", 2700000, "c1");
  const p2 = F.project(c, {today: TODAY, days: 40});
  assert.equal(p2.points.find(x => x.date === "2026-10-24").balance, -2700000 - 100000);   // подтверждённая (уже в остатке) повторно не вычитается
  assert.equal(p2.points.some(x => x.estimated), true);               // следующая — 24 ноя
  assert.equal(p2.points.find(x => x.date === "2026-10-24").estimated, undefined);
});

test("все core-скрипты грузятся в vm без module в нужном порядке", () => {
  const order = ["money", "schema", "accounts", "categories", "journal", "suggest", "views", "analytics", "sync", "meters", "schedules", "loans", "forecast"];
  const ctx = vm.createContext({});
  ctx.globalThis = ctx;
  for (const f of order) vm.runInContext(fs.readFileSync(path.join(__dirname, "../dist/core", f + ".js"), "utf8"), ctx, {filename: f + ".js"});
  const C = ctx.MoneyCore;
  for (const k of ["money", "schema", "accounts", "categories", "journal", "suggest", "views", "analytics", "sync", "meters", "schedules", "loans", "forecast"]) assert.ok(C[k], k);
  assert.equal(C.loans.annuityPayment(P, 1990, 60), L.annuityPayment(P, 1990, 60));
  assert.equal(typeof C.meters.addReading, "function");
  assert.equal(typeof C.schedules.estimate, "function");
});
