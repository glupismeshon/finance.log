(function (root) {
  "use strict";
  const node = typeof module !== "undefined" && module.exports;
  const {breakdown} = node ? require("./views.js") : root.MoneyCore.views;
  const {occurrences} = node ? require("./schedules.js") : root.MoneyCore.schedules;
  const DAY = 86400000;
  const toDay = s => Math.floor(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / DAY);
  const fromDay = n => new Date(n * DAY).toISOString().slice(0, 10);
  // виды счетов, входящих в итог
  const VIEW_KINDS = {
    all: ["debit", "cash", "savings", "credit_card", "loan"],
    noLoans: ["debit", "cash", "savings", "credit_card"],
    noCards: ["debit", "cash", "savings", "loan"],
    ownOnly: ["debit", "cash", "savings"]
  };

  function project(state, {today, days = 60, view = "noLoans"} = {}) {
    const kinds = VIEW_KINDS[view];
    if (!kinds) throw new Error("Неизвестный вид итога.");
    const inView = new Set(state.accounts.filter(a => kinds.includes(a.kind)).map(a => a.id));
    const start = breakdown(state).views[view];
    const end = fromDay(toDay(today) + days);
    const sched = new Map(state.schedules.map(s => [s.id, s]));
    const events = [];
    for (const o of occurrences(state, {from: fromDay(toDay(today) - 60), to: end, today})) {
      if (o.status !== "overdue" && o.status !== "due" && o.status !== "upcoming") continue;
      const sc = sched.get(o.scheduleId);
      let delta = 0;
      if (o.type === "expense") delta = inView.has(sc.accountId) ? -o.amountCents : 0;
      else if (o.type === "income") delta = inView.has(sc.accountId) ? o.amountCents : 0;
      else delta = (inView.has(sc.accountId) ? -o.amountCents : 0) + (inView.has(sc.toAccountId) ? o.amountCents : 0);
      events.push({date: o.dueDate < today ? today : o.dueDate, delta, o, sc});
    }
    const byDate = new Map();
    for (const e of events) { if (!byDate.has(e.date)) byDate.set(e.date, []); byDate.get(e.date).push(e); }
    const points = [];
    let bal = start, minBalance = null, minDate = null, deficitDate = null;
    for (let i = 0; i <= days; i++) {
      const date = fromDay(toDay(today) + i);
      for (const e of byDate.get(date) || []) bal += e.delta;
      points.push({date, balance: bal});
      if (minBalance === null || bal < minBalance) { minBalance = bal; minDate = date; }
      if (deficitDate === null && bal < 0) deficitDate = date;
    }
    const inc = events.filter(e => e.o.type === "income" && e.delta > 0)
      .sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0)[0] || null;
    let nextIncome = null, untilIncome = null;
    if (inc) {
      nextIncome = {date: inc.date, name: inc.sc.name, amountCents: inc.o.amountCents};
      let plannedOut = 0, plannedIn = 0;
      for (const e of events) {
        if (e === inc || e.date > inc.date) continue;
        if (e.delta < 0) plannedOut -= e.delta; else plannedIn += e.delta;
      }
      untilIncome = {date: inc.date, plannedOut, plannedIn, endBalance: start - plannedOut + plannedIn};
    }
    return {points, nextIncome, untilIncome, minBalance, minDate, deficitDate};
  }

  const api = {project};
  if (node) module.exports = api;
  else (root.MoneyCore = root.MoneyCore || {}).forecast = api;
})(globalThis);
