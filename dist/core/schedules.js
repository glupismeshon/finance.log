(function (root) {
  "use strict";
  const node = typeof module !== "undefined" && module.exports;
  const {validate} = node ? require("./schema.js") : root.MoneyCore.schema;
  const {validDate} = node ? require("./money.js") : root.MoneyCore.money;
  const LOOKBACK = 60;
  const DAY = 86400000;
  // даты — только строки YYYY-MM-DD; арифметика через UTC-номер дня
  const toDay = s => Math.floor(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / DAY);
  const fromDay = n => new Date(n * DAY).toISOString().slice(0, 10);
  const addDays = (s, n) => fromDay(toDay(s) + n);
  const pad = n => String(n).padStart(2, "0");
  const lastDom = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
  const mk = (y, m, d) => y + "-" + pad(m) + "-" + pad(Math.min(d, lastDom(y, m)));
  const weekday = s => ((toDay(s) + 3) % 7) + 1; // 1970-01-01 — четверг (4); пн=1

  // даты правила в [from, to] с учётом startDate/endDate
  function dueDates(sc, from, to) {
    const r = sc.rule;
    const lo = from > sc.startDate ? from : sc.startDate;
    const hi = sc.endDate && sc.endDate < to ? sc.endDate : to;
    const out = [];
    if (lo > hi) return out;
    if (r.freq === "days" || r.freq === "weekly") {
      let first = sc.startDate, step = r.interval;
      if (r.freq === "weekly") { first = addDays(sc.startDate, (r.weekday - weekday(sc.startDate) + 7) % 7); step = 7 * r.interval; }
      const f = toDay(first), a = toDay(lo), b = toDay(hi);
      let n = a <= f ? f : f + Math.ceil((a - f) / step) * step;
      for (; n <= b; n += step) out.push(fromDay(n));
    } else {
      const sy = +sc.startDate.slice(0, 4), sm = +sc.startDate.slice(5, 7);
      if (r.freq === "monthly") {
        const base = sy * 12 + sm - 1;
        for (let k = +lo.slice(0, 4) * 12 + +lo.slice(5, 7) - 1; k <= +hi.slice(0, 4) * 12 + +hi.slice(5, 7) - 1; k++) {
          if (k < base || (k - base) % r.interval) continue;
          const d = mk(Math.floor(k / 12), (k % 12) + 1, r.day);
          if (d >= lo && d <= hi) out.push(d);
        }
      } else {
        for (let y = +lo.slice(0, 4); y <= +hi.slice(0, 4); y++) {
          if (y < sy || (y - sy) % r.interval) continue;
          const d = mk(y, r.month, r.day);
          if (d >= lo && d <= hi) out.push(d);
        }
      }
    }
    return out;
  }

  const findIdx = (state, id) => {
    const i = state.schedules.findIndex(s => s.id === id);
    if (i < 0) throw new Error("Регулярный платёж не найден.");
    return i;
  };
  const put = (state, i, sc) => validate({...state, schedules: state.schedules.map((x, j) => j === i ? sc : x)});

  function addSchedule(state, schedule, nowISO) {
    const sc = {subscription: false, paused: false, archived: false, skips: [], endDate: null, categoryId: null, ...schedule, updatedAt: nowISO};
    if (state.schedules.some(s => s.id === sc.id)) throw new Error("Регулярный платёж уже существует.");
    return validate({...state, schedules: [...state.schedules, sc]});
  }
  function updateSchedule(state, id, patch, nowISO) {
    const i = findIdx(state, id);
    const {id: _i, ...rest} = patch || {};
    const next = {...state.schedules[i], ...rest, updatedAt: nowISO};
    // старый флаг subscription без template: переключаем вид подписка <-> фикс. платёж
    if (rest.subscription !== undefined && rest.template === undefined) {
      if (rest.subscription && next.template === "fixed") next.template = "subscription";
      else if (!rest.subscription && next.template === "subscription") next.template = "fixed";
    }
    if (next.type !== "transfer") delete next.toAccountId;
    return put(state, i, next);
  }
  const archiveSchedule = (state, id, nowISO, archived = true) => updateSchedule(state, id, {archived: !!archived}, nowISO);
  const setPaused = (state, id, paused, nowISO) => updateSchedule(state, id, {paused: !!paused}, nowISO);
  function skipOccurrence(state, id, dueDate, nowISO) {
    const i = findIdx(state, id);
    if (!validDate(dueDate)) throw new Error("Некорректная дата.");
    const sc = state.schedules[i];
    return put(state, i, {...sc, skips: [...new Set([...sc.skips, dueDate])].sort(), updatedAt: nowISO});
  }

  function confirmedMap(state) {
    const m = new Map();
    for (const op of state.operations) if (!op.deleted && op.links && op.links.scheduleId && op.links.dueDate) m.set(op.links.scheduleId + "|" + op.links.dueDate, op.id);
    return m;
  }
  function median(list) {
    const s = [...list].sort((a, b) => a - b), n = s.length;
    return n % 2 ? s[(n - 1) / 2] : Math.round((s[n / 2 - 1] + s[n / 2]) / 2);
  }
  // оценка суммы для variable: медиана последних 3 подтверждённых, иначе примерная amountCents, иначе 0
  function estimate(state, scheduleId) {
    const sc = state.schedules.find(s => s.id === scheduleId);
    if (!sc) throw new Error("Регулярный платёж не найден.");
    const ops = state.operations.filter(o => !o.deleted && o.links && o.links.scheduleId === scheduleId && o.links.dueDate)
      .sort((a, b) => a.links.dueDate < b.links.dueDate ? 1 : a.links.dueDate > b.links.dueDate ? -1 : a.date < b.date ? 1 : a.date > b.date ? -1 : 0)
      .slice(0, 3).map(o => Math.abs(o.legs[0].amountCents));
    return ops.length ? median(ops) : sc.amountCents;
  }
  // статусы: confirmed | skipped | overdue | due | upcoming; у variable вместо overdue/due — awaiting («ждёт суммы»),
  // без 60-дневного окна: висит, пока сумму не внесут или дату не пропустят
  function occurrences(state, {from, to, today}) {
    const conf = confirmedMap(state);
    const opById = new Map(state.operations.map(o => [o.id, o]));
    const oldest = addDays(today, -LOOKBACK);
    const out = [];
    for (const sc of state.schedules) {
      if (sc.archived || sc.paused) continue;
      const variable = sc.amountMode === "variable";
      const est = variable ? estimate(state, sc.id) : 0;
      for (const dueDate of dueDates(sc, from, to)) {
        const opId = conf.get(sc.id + "|" + dueDate);
        let status;
        if (opId) status = "confirmed";
        else if (sc.skips.includes(dueDate)) status = "skipped";
        else if (variable) status = dueDate <= today ? "awaiting" : "upcoming";
        else if (dueDate < oldest) continue;
        else status = dueDate < today ? "overdue" : dueDate === today ? "due" : "upcoming";
        const o = {scheduleId: sc.id, dueDate, amountCents: sc.amountCents, type: sc.type, status};
        if (variable && !opId) { o.amountCents = est; o.estimated = true; if (est === 0) o.noEstimate = true; }
        else if (variable && opId) o.amountCents = Math.abs(opById.get(opId).legs[0].amountCents);
        if (opId) o.opId = opId;
        out.push(o);
      }
    }
    return out.sort((a, b) => a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : a.scheduleId < b.scheduleId ? -1 : a.scheduleId > b.scheduleId ? 1 : 0);
  }

  function confirmOp(schedule, dueDate, {amountCents, date, id, now} = {}) {
    if (schedule.template === "loan") throw new Error("Платёж по кредиту подтверждается через MoneyCore.loans.paymentOp.");
    const amt = amountCents === undefined ? schedule.amountCents : amountCents;
    if (!Number.isSafeInteger(amt) || amt <= 0) throw new Error("Сумма должна быть больше нуля.");
    const cat = schedule.categoryId == null ? null : schedule.categoryId;
    let legs, allocations;
    if (schedule.type === "transfer") {
      legs = [{accountId: schedule.accountId, amountCents: -amt}, {accountId: schedule.toAccountId, amountCents: amt}];
      allocations = [];
    } else if (schedule.type === "income") {
      legs = [{accountId: schedule.accountId, amountCents: amt}];
      allocations = cat === null ? [] : [{categoryId: cat, amountCents: amt}];
    } else {
      legs = [{accountId: schedule.accountId, amountCents: -amt}];
      allocations = [{categoryId: cat, amountCents: amt}];
    }
    const op = {id, type: schedule.type, date: date || dueDate, note: schedule.name, createdAt: now, updatedAt: now, deleted: false, legs, allocations,
      links: {scheduleId: schedule.id, dueDate}, revisions: []};
    if (schedule.merchant && schedule.type !== "transfer") op.merchant = schedule.merchant;
    return op;
  }

  // факт − план (копейки); null, если записи или правила нет
  function deviation(state, opId) {
    const op = state.operations.find(o => o.id === opId);
    if (!op || !op.links || !op.links.scheduleId) return null;
    const sc = state.schedules.find(s => s.id === op.links.scheduleId);
    if (!sc) return null;
    return Math.abs(op.legs[0].amountCents) - sc.amountCents;
  }

  function monthlyEquivalent(sc) {
    const a = sc.amountCents, r = sc.rule;
    if (r.freq === "monthly") return Math.round(a / r.interval);
    if (r.freq === "weekly") return Math.round(a * 52 / 12 / r.interval);
    if (r.freq === "yearly") return Math.round(a / 12 / r.interval);
    return Math.round(a * 30.44 / r.interval);
  }
  function yearlyEquivalent(sc) {
    const a = sc.amountCents, r = sc.rule;
    if (r.freq === "monthly") return Math.round(a * 12 / r.interval);
    if (r.freq === "weekly") return Math.round(a * 52 / r.interval);
    if (r.freq === "yearly") return Math.round(a / r.interval);
    return Math.round(a * 365.25 / r.interval);
  }
  function subscriptions(state) {
    const items = state.schedules.filter(s => s.subscription && !s.archived && !s.paused && s.type === "expense")
      .map(schedule => ({schedule, monthlyCents: monthlyEquivalent(schedule)}))
      .sort((a, b) => b.monthlyCents - a.monthlyCents || (a.schedule.id < b.schedule.id ? -1 : 1));
    return {items, perMonth: items.reduce((t, x) => t + x.monthlyCents, 0), perYear: items.reduce((t, x) => t + yearlyEquivalent(x.schedule), 0)};
  }

  function detectRecurring(state, today) {
    const since = addDays(today, -120);
    const taken = new Set(state.schedules.filter(s => !s.archived && s.merchant).map(s => s.merchant.trim().toLowerCase()));
    const groups = new Map();
    for (const op of state.operations) {
      if (op.deleted || op.type !== "expense" || !op.merchant || (op.links && op.links.scheduleId) || op.date < since || op.date > today) continue;
      const key = op.merchant.trim().toLowerCase();
      if (taken.has(key)) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(op);
    }
    const out = [];
    for (const list of groups.values()) {
      if (list.length < 3) continue;
      list.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
      const gaps = [];
      for (let i = 1; i < list.length; i++) gaps.push(toDay(list[i].date) - toDay(list[i - 1].date));
      const freq = gaps.every(g => g >= 25 && g <= 35) ? "monthly" : gaps.every(g => g >= 6 && g <= 8) ? "weekly" : null;
      if (!freq) continue;
      const amounts = list.map(o => Math.abs(o.legs[0].amountCents));
      const med = median(amounts);
      if (amounts.some(a => Math.abs(a - med) > med * 0.15)) continue;
      const last = list[list.length - 1];
      const alloc = last.allocations.find(a => a.categoryId !== null);
      out.push({merchant: last.merchant, amountCents: med, freq, day: freq === "monthly" ? +last.date.slice(8, 10) : weekday(last.date),
        categoryId: alloc ? alloc.categoryId : null, accountId: last.legs[0].accountId, count: list.length});
    }
    return out.sort((a, b) => b.count - a.count || (a.merchant < b.merchant ? -1 : 1));
  }

  const api = {addSchedule, updateSchedule, archiveSchedule, setPaused, skipOccurrence, occurrences, estimate, confirmOp, deviation, monthlyEquivalent, subscriptions, detectRecurring};
  if (node) module.exports = api;
  else (root.MoneyCore = root.MoneyCore || {}).schedules = api;
})(globalThis);
