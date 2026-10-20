(function (root) {
  "use strict";
  const node = typeof module !== "undefined" && module.exports;
  const {merchantKey, itemKey, unitPriceCents} = node ? require("./suggest.js") : root.MoneyCore.suggest;
  const DAY = 86400000;
  const ms = iso => Date.parse(iso + "T00:00:00Z");
  const iso = t => new Date(t).toISOString().slice(0, 10);
  const addDays = (d, n) => iso(ms(d) + n * DAY);
  const daysIn = (from, to) => Math.round((ms(to) - ms(from)) / DAY) + 1;
  const pct = (cur, prev) => prev === 0 ? null : Math.round((cur - prev) / Math.abs(prev) * 1000) / 10;
  const inRange = (o, from, to) => (!from || o.date >= from) && (!to || o.date <= to);
  // неудалённые доходы/расходы; сумма всегда положительная
  function* cash(state, type, from, to) {
    for (const o of state.operations) {
      if (o.deleted || o.type !== type || !inRange(o, from, to)) continue;
      yield {o, cents: Math.abs(o.legs[0].amountCents)};
    }
  }
  function daily(state, {from, to, type = "expense", accountId} = {}) {
    const out = {};
    const put = (t, sign) => { for (const {o, cents} of cash(state, t, from, to)) { if (accountId && o.legs[0].accountId !== accountId) continue; out[o.date] = (out[o.date] || 0) + sign * cents; } };
    if (type === "expense" || type === "net") put("expense", type === "net" ? -1 : 1);
    if (type === "income" || type === "net") put("income", 1);
    for (const d of Object.keys(out)) if (out[d] === 0) delete out[d];
    return out;
  }
  function heatLevels(values) {
    const v = (Array.isArray(values) ? values : Object.values(values || {})).filter(x => x > 0).sort((a, b) => a - b);
    if (!v.length) return [0, 0, 0];
    return [0.25, 0.5, 0.75].map(p => v[Math.max(0, Math.ceil(p * v.length) - 1)]);
  }
  const levelOf = (value, thresholds) => value <= 0 ? 0 : value <= thresholds[0] ? 1 : value <= thresholds[1] ? 2 : value <= thresholds[2] ? 3 : 4;
  function period(state, from, to) {
    let expense = 0, income = 0, ops = 0;
    for (const {cents} of cash(state, "expense", from, to)) { expense += cents; ops++; }
    for (const {cents} of cash(state, "income", from, to)) income += cents;
    const days = daysIn(from, to);
    return {expense, income, net: income - expense, days, avgPerDay: Math.round(expense / days), ops, avgCheck: ops ? Math.round(expense / ops) : 0};
  }
  const prevRange = (from, to) => { const n = daysIn(from, to); return {from: addDays(from, -n), to: addDays(from, -1)}; };
  function summary(state, {from, to}) {
    const cur = period(state, from, to);
    const pr = prevRange(from, to);
    const prev = period(state, pr.from, pr.to);
    const delta = {};
    for (const k of ["expense", "income", "net", "avgPerDay", "ops", "avgCheck"]) delta[k] = pct(cur[k], prev[k]);
    return {...cur, prev: {...prev, from: pr.from, to: pr.to}, delta};
  }
  function catSums(state, from, to, parent) {
    const par = new Map((state.categories || []).map(c => [c.id, c.parentId]));
    const sums = new Map();
    let total = 0;
    for (const {o, cents} of cash(state, "expense", from, to)) {
      const parts = o.allocations.length ? o.allocations : [{categoryId: null, amountCents: cents}];
      for (const a of parts) {
        const id = a.categoryId === null ? null : parent ? (par.get(a.categoryId) ?? a.categoryId) : a.categoryId;
        sums.set(id, (sums.get(id) || 0) + a.amountCents);
        total += a.amountCents;
      }
    }
    return {sums, total};
  }
  function byCategory(state, {from, to, parent = true}) {
    const pr = prevRange(from, to);
    const cur = catSums(state, from, to, parent), prev = catSums(state, pr.from, pr.to, parent);
    const row = (id, cents, prevCents, total) => ({id, cents, share: total ? cents / total : 0, prevCents, delta: pct(cents, prevCents)});
    const rows = [...cur.sums].map(([id, cents]) => row(id, cents, prev.sums.get(id) || 0, cur.total));
    if (parent) {
      const leaf = catSums(state, from, to, false), leafPrev = catSums(state, pr.from, pr.to, false);
      const par = new Map((state.categories || []).map(c => [c.id, c.parentId]));
      for (const r of rows) r.children = [...leaf.sums].filter(([id]) => id !== null && par.get(id) === r.id)
        .map(([id, cents]) => row(id, cents, leafPrev.sums.get(id) || 0, cur.total)).sort((a, b) => b.cents - a.cents);
    }
    return rows.sort((a, b) => b.cents - a.cents);
  }
  function byMerchant(state, {from, to, limit = 10} = {}) {
    const map = new Map();
    for (const {o, cents} of cash(state, "expense", from, to)) {
      const k = o.merchant ? merchantKey(o.merchant) : "";
      if (!k) continue;
      let g = map.get(k);
      if (!g) map.set(k, g = {merchant: o.merchant, cents: 0, count: 0, lastDate: o.date});
      g.cents += cents; g.count++;
      if (o.date >= g.lastDate) { g.lastDate = o.date; g.merchant = o.merchant; }
    }
    return [...map.values()].map(g => ({merchant: g.merchant, cents: g.cents, count: g.count, avgCheck: Math.round(g.cents / g.count), lastDate: g.lastDate}))
      .sort((a, b) => b.cents - a.cents || (a.merchant < b.merchant ? -1 : 1)).slice(0, limit);
  }
  function byItem(state, {from, to, limit = 10, sort = "cents"} = {}) {
    const map = new Map();
    for (const {o} of cash(state, "expense", from, to)) for (const it of o.items || []) {
      if (it.kind !== "item") continue;
      const k = itemKey(it.name) + "|" + it.unit;
      let g = map.get(k);
      if (!g) map.set(k, g = {name: it.name, unit: it.unit, cents: 0, count: 0, qtyMilli: 0, prices: []});
      g.cents += it.amountCents; g.count++; g.qtyMilli += it.qtyMilli;
      g.prices.push({date: o.date, createdAt: o.createdAt, p: unitPriceCents(it), name: it.name});
    }
    const rows = [...map.values()].map(g => {
      g.prices.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0);
      const first = g.prices[0].p, last = g.prices[g.prices.length - 1];
      return {name: last.name, cents: g.cents, count: g.count, qtyMilli: g.qtyMilli, unit: g.unit, firstUnitPrice: first, lastUnitPrice: last.p, priceDelta: g.prices.length > 1 ? pct(last.p, first) : null};
    });
    return rows.sort((a, b) => (sort === "count" ? b.count - a.count : 0) || b.cents - a.cents || (a.name < b.name ? -1 : 1)).slice(0, limit);
  }
  function monthly(state, {months = 12, to}) {
    const [y, m] = to.slice(0, 7).split("-").map(Number);
    const list = [];
    for (let i = months - 1; i >= 0; i--) { const t = new Date(Date.UTC(y, m - 1 - i, 1)); list.push({month: t.toISOString().slice(0, 7), expense: 0, income: 0}); }
    const idx = new Map(list.map((r, i) => [r.month, i]));
    const from = list[0].month + "-01";
    for (const [type, key] of [["expense", "expense"], ["income", "income"]]) for (const {o, cents} of cash(state, type, from, to)) {
      const i = idx.get(o.date.slice(0, 7));
      if (i !== undefined) list[i][key] += cents;
    }
    return list;
  }
  // средний расход по дням недели, пн (0) … вс (6): сумма / число таких дней в периоде
  function weekday(state, {from, to}) {
    const total = Array(7).fill(0), days = Array(7).fill(0);
    const wd = d => (new Date(ms(d)).getUTCDay() + 6) % 7;
    for (let d = from; d <= to; d = addDays(d, 1)) days[wd(d)]++;
    for (const {o, cents} of cash(state, "expense", from, to)) total[wd(o.date)] += cents;
    return total.map((t, i) => ({weekday: i, totalCents: t, days: days[i], avgCents: days[i] ? Math.round(t / days[i]) : 0}));
  }
  const api = {daily, heatLevels, levelOf, summary, byCategory, byMerchant, byItem, monthly, weekday};
  if (node) module.exports = api;
  else (root.MoneyCore = root.MoneyCore || {}).analytics = api;
})(globalThis);
