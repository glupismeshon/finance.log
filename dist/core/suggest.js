(function (root) {
  "use strict";
  const DAY = 86400000;
  const merchantKey = s => String(s ?? "").trim().toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ");
  const live = (state, type) => state.operations.filter(o => !o.deleted && o.type === type && o.merchant && merchantKey(o.merchant));
  // последняя операция: по дате, затем createdAt, затем позиция в журнале
  const newer = (a, b) => a.o.date !== b.o.date ? a.o.date > b.o.date : a.o.createdAt !== b.o.createdAt ? a.o.createdAt > b.o.createdAt : a.i > b.i;
  function groups(state, type) {
    const map = new Map();
    state.operations.forEach((o, i) => {
      if (o.deleted || o.type !== type || !o.merchant) return;
      const k = merchantKey(o.merchant);
      if (!k) return;
      let g = map.get(k);
      if (!g) map.set(k, g = {key: k, count: 0, last: null});
      g.count++;
      const e = {o, i};
      if (!g.last || newer(e, g.last)) g.last = e;
    });
    return map;
  }
  function merchants(state, type, prefix, limit = 8) {
    const p = merchantKey(prefix);
    return [...groups(state, type).values()]
      .filter(g => !p || g.key.split(" ").some(w => w.startsWith(p)) || g.key.startsWith(p))
      .sort((a, b) => b.count - a.count || (a.last.o.date < b.last.o.date ? 1 : a.last.o.date > b.last.o.date ? -1 : 0) || (a.key < b.key ? -1 : 1))
      .slice(0, limit).map(g => g.last.o.merchant);
  }
  function forMerchant(state, type, merchant) {
    const g = groups(state, type).get(merchantKey(merchant));
    if (!g) return null;
    const k = g.key;
    const ops = live(state, type).filter(o => merchantKey(o.merchant) === k);
    const freq = new Map();
    for (const o of ops) { const a = o.legs[0].accountId; freq.set(a, (freq.get(a) || 0) + 1); }
    const last = g.last.o;
    let accountId = last.legs[0].accountId, best = freq.get(accountId);
    for (const [a, n] of freq) if (n > best) { accountId = a; best = n; }
    return {categoryId: last.allocations.length ? last.allocations[0].categoryId : null, accountId, lastAmountCents: Math.abs(last.legs[0].amountCents), lastDate: last.date};
  }
  function recentCategories(state, type, limit = 6, todayISO) {
    const ref = todayISO ? Date.parse(todayISO + "T00:00:00Z") : Date.now();
    const from = new Date(ref - 90 * DAY).toISOString().slice(0, 10);
    const to = new Date(ref).toISOString().slice(0, 10);
    const cnt = new Map();
    for (const o of state.operations) {
      if (o.deleted || o.type !== type || o.date < from || (todayISO && o.date > to)) continue;
      for (const a of o.allocations) if (a.categoryId) cnt.set(a.categoryId, (cnt.get(a.categoryId) || 0) + 1);
    }
    return [...cnt].sort((a, b) => b[1] - a[1]).slice(0, limit).map(x => x[0]);
  }
  const itemKey = merchantKey;
  // цена за единицу: за 1 шт/уп/кг/л; для г и мл — пересчёт на кг/л
  const unitPriceCents = it => Math.round(it.amountCents * (it.unit === "g" || it.unit === "ml" ? 1e6 : 1000) / it.qtyMilli);
  function items(state, merchant, prefix, limit = 8) {
    const mk = merchant == null ? null : merchantKey(merchant);
    const p = itemKey(prefix);
    const map = new Map();
    state.operations.forEach((o, i) => {
      if (o.deleted || o.type !== "expense" || !o.items) return;
      const own = mk !== null && merchantKey(o.merchant) === mk;
      for (const it of o.items) {
        if (it.kind !== "item") continue;
        const k = itemKey(it.name);
        if (!k) continue;
        let g = map.get(k);
        if (!g) map.set(k, g = {key: k, count: 0, ownCount: 0, last: null});
        g.count++;
        if (own) g.ownCount++;
        const e = {o, i, it};
        if (!g.last || newer(e, g.last)) g.last = e;
      }
    });
    return [...map.values()]
      .filter(g => !p || g.key.split(" ").some(w => w.startsWith(p)) || g.key.startsWith(p))
      .sort((a, b) => (b.ownCount > 0) - (a.ownCount > 0) || (b.ownCount - a.ownCount) || b.count - a.count || (a.last.o.date < b.last.o.date ? 1 : a.last.o.date > b.last.o.date ? -1 : 0) || (a.key < b.key ? -1 : 1))
      .slice(0, limit).map(g => { const it = g.last.it; return {name: it.name, unit: it.unit, lastAmountCents: it.amountCents, lastQtyMilli: it.qtyMilli, lastUnitPriceCents: unitPriceCents(it), categoryId: it.categoryId, count: g.count}; });
  }
  const api = {merchantKey, itemKey, unitPriceCents, items, merchants, forMerchant, recentCategories};
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else (root.MoneyCore = root.MoneyCore || {}).suggest = api;
})(globalThis);
