(function (root) {
  "use strict";
  const node = typeof module !== "undefined" && module.exports;
  const {validate} = node ? require("./schema.js") : root.MoneyCore.schema;
  const {validDate, MAX_AMOUNT} = node ? require("./money.js") : root.MoneyCore.money;
  const {addAccount} = node ? require("./accounts.js") : root.MoneyCore.accounts;
  const {addSchedule, updateSchedule} = node ? require("./schedules.js") : root.MoneyCore.schedules;
  const {upsertOperation} = node ? require("./journal.js") : root.MoneyCore.journal;
  const DAY = 86400000;
  const MAX_ROWS = 1200;
  const INTEREST_CATEGORY = "c-loan_interest";
  const toDay = s => Math.floor(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / DAY);
  const pad = n => String(n).padStart(2, "0");
  const lastDom = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
  const mk = (y, m, d) => y + "-" + pad(m) + "-" + pad(Math.min(d, lastDom(y, m)));
  const monthIdx = s => +s.slice(0, 4) * 12 + +s.slice(5, 7) - 1;
  const payDate = (paymentDay, idx) => mk(Math.floor(idx / 12), (idx % 12) + 1, paymentDay);
  const isLeap = y => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const intIn = (v, a, b) => Number.isSafeInteger(v) && v >= a && v <= b;

  // проценты по-банковски: остаток × ставка × дней / дней_в_году (365/366), период (from, to], на стыке лет — по частям
  function accrue(balance, rateBp, from, to) {
    if (balance <= 0 || rateBp <= 0 || to <= from) return 0;
    let sum = 0, cur = from;
    while (cur < to) {
      const y = +cur.slice(0, 4), yearEnd = (y + 1) + "-01-01", end = to < yearEnd ? to : yearEnd;
      sum += balance * rateBp / 10000 * (toDay(end) - toDay(cur)) / (isLeap(y) ? 366 : 365);
      cur = end;
    }
    return Math.round(sum);
  }
  // плановый аннуитетный платёж: A = P·i/(1−(1+i)^−n), i = ставка/12
  function annuityPayment(principal, rateBp, months) {
    const i = rateBp / 10000 / 12;
    if (i === 0) return Math.round(principal / months);
    return Math.round(principal * i / (1 - Math.pow(1 + i, -months)));
  }
  // за сколько платежей погасится balance при платеже amt (аннуитет) / основном долге amt (diff)
  function termFor(balance, amt, rateBp, method) {
    if (balance <= 0) return 1;
    const i = rateBp / 10000 / 12;
    if (method === "diff" || i === 0) return Math.min(MAX_ROWS, Math.max(1, Math.ceil(balance / amt)));
    if (amt <= balance * i) return MAX_ROWS;
    return Math.min(MAX_ROWS, Math.max(1, Math.ceil(-Math.log(1 - balance * i / amt) / Math.log(1 + i) - 1e-9)));
  }
  function build({balance, from, firstSlot, paymentDay, rateBp, method, amt, nRem, n0 = 0}) {
    const rows = [];
    let bal = balance, prev = from;
    for (let j = 0; j < nRem && bal > 0 && j < MAX_ROWS; j++) {
      const date = payDate(paymentDay, firstSlot + j);
      const interest = accrue(bal, rateBp, prev, date);
      let principal;
      if (j === nRem - 1) principal = bal;
      else if (method === "diff") principal = Math.min(bal, amt);
      else principal = Math.min(bal, Math.max(0, amt - interest));
      bal -= principal;
      rows.push({n: n0 + j + 1, date, payment: principal + interest, interest, principal, balance: bal});
      prev = date;
    }
    return rows;
  }
  const sum = (rows, k) => rows.reduce((t, r) => t + r[k], 0);
  function summarize(rows, balance) {
    const totalPaid = sum(rows, "payment");
    return {rows, balance, totalPaid, overpayment: sum(rows, "interest"), payment: rows.length ? rows[0].payment : 0, termLeft: rows.length, endDate: rows.length ? rows[rows.length - 1].date : null};
  }
  function checkParams(p) {
    if (!intIn(p.principalCents, 1, MAX_AMOUNT)) throw new Error("Сумма кредита должна быть больше нуля.");
    if (!intIn(p.rateBp, 0, 100000)) throw new Error("Ставка — от 0 до 1000 %.");
    if (!intIn(p.termMonths, 1, 600)) throw new Error("Срок — от 1 до 600 месяцев.");
    if (!["annuity", "diff"].includes(p.method)) throw new Error("Тип платежа — аннуитет или дифференцированный.");
    if (!validDate(p.startDate)) throw new Error("Некорректная дата выдачи.");
    if (!intIn(p.paymentDay, 1, 31)) throw new Error("День платежа — от 1 до 31.");
  }
  function initial(p) {
    return p.method === "diff" ? Math.round(p.principalCents / p.termMonths) : annuityPayment(p.principalCents, p.rateBp, p.termMonths);
  }

  // калькулятор до оформления; первый платёж — в день платежа месяца, следующего за месяцем выдачи
  function calc(p) {
    checkParams(p);
    const amt = initial(p);
    const rows = build({balance: p.principalCents, from: p.startDate, firstSlot: monthIdx(p.startDate) + 1, paymentDay: p.paymentDay, rateBp: p.rateBp, method: p.method, amt, nRem: p.termMonths});
    const totalPaid = sum(rows, "payment");
    return {payment: p.method === "annuity" ? amt : rows[0].payment, totalPaid, overpayment: totalPaid - p.principalCents, rows};
  }

  const loanOf = (state, accountId) => {
    const l = (state.loans || []).find(x => x.accountId === accountId);
    if (!l) throw new Error("Кредит не найден.");
    return l;
  };
  const loanOps = (state, accountId, upto) => state.operations.filter(o => !o.deleted && o.date <= upto && o.legs.some(l => l.accountId === accountId))
    .sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1);
  function nearestSlot(paymentDay, date) {
    const m0 = monthIdx(date);
    let best = m0, bd = Infinity;
    for (const m of [m0 - 1, m0, m0 + 1]) {
      const d = Math.abs(toDay(payDate(paymentDay, m)) - toDay(date));
      if (d <= bd) { bd = d; best = m; }
    }
    return best;
  }

  // состояние кредита на дату: переигрываем операции (досрочки меняют платёж или остаток платежей)
  function replay(state, accountId, upto) {
    const loan = loanOf(state, accountId);
    const acc = state.accounts.find(a => a.id === accountId);
    let balance = -acc.openingCents, amt = initial(loan), nRem = loan.termMonths, slot = monthIdx(loan.startDate), paid = 0, lastDate = loan.startDate;
    for (const op of loanOps(state, accountId, upto)) {
      balance -= op.legs.find(l => l.accountId === accountId).amountCents;
      if (op.type !== "loan_payment") continue;
      if (op.date > lastDate) lastDate = op.date;
      if (op.links.early) {
        if (balance <= 0) continue;
        if (op.links.early === "payment") amt = loan.method === "diff" ? Math.round(balance / nRem) : annuityPayment(balance, loan.rateBp, nRem);
        else nRem = termFor(balance, amt, loan.rateBp, loan.method);
      } else {
        const due = op.links.dueDate ? monthIdx(op.links.dueDate) : nearestSlot(loan.paymentDay, op.date);
        const next = Math.max(slot + 1, due);
        nRem = Math.max(1, nRem - (next - slot));
        slot = next;
        paid++;
      }
    }
    return {loan, balance, amt, nRem, slot, paid, lastDate};
  }

  // график от текущего фактического остатка и даты последнего платежа; today — граница учитываемых операций
  function schedule(state, accountId, today) {
    const r = replay(state, accountId, today);
    const rows = r.balance > 0 ? build({balance: r.balance, from: r.lastDate, firstSlot: r.slot + 1, paymentDay: r.loan.paymentDay, rateBp: r.loan.rateBp, method: r.loan.method, amt: r.amt, nRem: r.nRem, n0: r.paid}) : [];
    return {...summarize(rows, r.balance), lastDate: r.lastDate, paid: r.paid};
  }

  // разбивка платежа в дату: проценты за дни с прошлого платежа и основной долг
  function split(state, accountId, amountCents, date) {
    if (!intIn(amountCents, 1, MAX_AMOUNT)) throw new Error("Сумма должна быть больше нуля.");
    const r = replay(state, accountId, date);
    const interest = Math.min(amountCents, accrue(r.balance, r.loan.rateBp, r.lastDate, date));
    return {interest, principal: Math.max(0, Math.min(amountCents - interest, r.balance))};
  }

  function makeOp(state, {id, fromId, loanId, interest, principal, date, note, now, links}) {
    const hasCat = (state.categories || []).some(c => c.id === INTEREST_CATEGORY);
    const total = interest + principal;
    return {id, type: "loan_payment", date, note: note || "Платёж по кредиту", createdAt: now, updatedAt: now, deleted: false,
      legs: [{accountId: fromId, amountCents: -total}, {accountId: loanId, amountCents: principal}],
      allocations: interest > 0 ? [{categoryId: hasCat ? INTEREST_CATEGORY : null, amountCents: interest}] : [],
      links: {loanAccountId: loanId, ...links}, revisions: []};
  }

  // операция платежа по правилу template:"loan" (подтверждение из «ближайших»); interestCents можно задать из банка
  function paymentOp(state, scheduleId, dueDate, {amountCents, interestCents, date, id, now} = {}) {
    const sc = state.schedules.find(s => s.id === scheduleId);
    const loan = (state.loans || []).find(l => l.scheduleId === scheduleId);
    if (!sc || !loan) throw new Error("Кредит не найден.");
    const when = date || dueDate;
    const rows = schedule(state, loan.accountId, when).rows;
    const amt = amountCents === undefined ? (rows.length ? rows[0].payment : sc.amountCents) : amountCents;
    if (!intIn(amt, 1, MAX_AMOUNT)) throw new Error("Сумма должна быть больше нуля.");
    const sp = interestCents === undefined ? split(state, loan.accountId, amt, when) : null;
    const interest = sp ? sp.interest : interestCents;
    if (!intIn(interest, 0, amt)) throw new Error("Проценты не могут быть больше платежа.");
    const principal = amt - interest;
    if (principal > replay(state, loan.accountId, when).balance) throw new Error("Платёж больше остатка долга.");
    return makeOp(state, {id, fromId: sc.accountId, loanId: loan.accountId, interest, principal, date: when, note: sc.name, now, links: {scheduleId, dueDate}});
  }

  // подтянуть правило платежей к актуальному графику (сумма ближайшего платежа, дата окончания)
  function refresh(state, accountId, today, now) {
    const loan = loanOf(state, accountId);
    const sc = state.schedules.find(s => s.id === loan.scheduleId);
    if (!sc) return state;
    const g = schedule(state, accountId, today);
    if (!g.rows.length) return sc.archived ? state : updateSchedule(state, sc.id, {archived: true}, now);
    const last = g.rows[g.rows.length - 1].date;
    return updateSchedule(state, sc.id, {amountCents: g.payment, endDate: last < sc.startDate ? sc.startDate : last, archived: false}, now);
  }

  // досрочное погашение: весь платёж, кроме начисленных процентов, идёт в основной долг; возвращает операцию, новое состояние и «было/стало»
  function early(state, accountId, amountCents, date, mode, {id, now, fromAccountId} = {}) {
    if (mode !== "term" && mode !== "payment") throw new Error("Режим — сократить срок или уменьшить платёж.");
    if (!validDate(date)) throw new Error("Некорректная дата.");
    const loan = loanOf(state, accountId);
    const sc = state.schedules.find(s => s.id === loan.scheduleId);
    const fromId = fromAccountId || (sc && sc.accountId);
    if (!fromId) throw new Error("Укажите счёт списания.");
    const before = schedule(state, accountId, date);
    const {interest} = split(state, accountId, amountCents, date);
    if (amountCents <= interest) throw new Error("Сумма меньше начисленных процентов.");
    const principal = amountCents - interest;
    if (principal > before.balance) throw new Error("Сумма больше остатка долга.");
    const op = makeOp(state, {id, fromId, loanId: accountId, interest, principal, date, note: "Досрочное погашение", now, links: {early: mode}});
    let next = upsertOperation(state, op, now);
    const after = schedule(next, accountId, date);
    if (sc) next = refresh(next, accountId, date, now);
    const view = (g, extra = 0) => ({payment: g.payment, termLeft: g.termLeft, endDate: g.endDate, balance: g.balance, overpayment: g.overpayment + extra});
    const b = view(before), a = view(after, interest);
    return {op, state: next, before: b, after: a, savings: b.overpayment - a.overpayment, schedule: after};
  }

  // счёт loan + запись loans + правило template:"loan"
  function addLoan(state, {account, loan}, now) {
    checkParams(loan);
    const scheduleId = loan.scheduleId || "sch-" + account.id;
    const g = calc(loan);
    let s = addAccount(state, {id: account.id, name: account.name, kind: "loan", openingCents: -loan.principalCents, openingDate: loan.startDate}, now);
    s = validate({...s, loans: [...s.loans, {id: account.id, accountId: account.id, principalCents: loan.principalCents, rateBp: loan.rateBp, termMonths: loan.termMonths,
      startDate: loan.startDate, paymentDay: loan.paymentDay, method: loan.method, scheduleId, updatedAt: now}]});
    return addSchedule(s, {id: scheduleId, type: "transfer", name: account.name.trim(), amountCents: g.rows[0].payment, accountId: loan.payFromAccountId, toAccountId: account.id,
      categoryId: null, rule: {freq: "monthly", interval: 1, day: loan.paymentDay}, startDate: g.rows[0].date, endDate: g.rows[g.rows.length - 1].date,
      template: "loan", amountMode: "fixed"}, now);
  }

  const api = {annuityPayment, calc, schedule, split, early, paymentOp, refresh, addLoan};
  if (node) module.exports = api;
  else (root.MoneyCore = root.MoneyCore || {}).loans = api;
})(globalThis);
