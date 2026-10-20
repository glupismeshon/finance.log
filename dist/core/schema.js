(function (root) {
  "use strict";
  const node = typeof module !== "undefined" && module.exports;
  const {validDate, MAX_AMOUNT} = node ? require("./money.js") : root.MoneyCore.money;
  const OP_TYPES = ["income", "expense", "transfer", "adjustment"];
  const KINDS = ["debit", "cash", "savings", "credit_card", "loan", "person"];
  const FORMAT = "Не удалось прочитать копию money.log. Проверьте формат файла.";
  const BAD_OPS = "В копии есть некорректные или повторяющиеся записи.";
  const BAD_ACCOUNTS = "В копии есть некорректные или повторяющиеся счета.";
  const LIMIT = "Общая сумма превышает поддерживаемый предел.";
  const ID = /^[\w-]{1,100}$/;
  const plain = v => !!v && typeof v === "object" && !Array.isArray(v);
  const isoOk = v => typeof v === "string" && Number.isFinite(Date.parse(v));
  const cents = v => Number.isSafeInteger(v) && Math.abs(v) <= MAX_AMOUNT;
  const CAT_KEYS = {
    expense: [["groceries", ["groceries_meat", "groceries_dairy", "groceries_produce", "groceries_other"]], ["transport"], ["housing"], ["subscriptions"], ["health"], ["clothing"], ["fun"], ["household"], ["other_expense"]],
    income: [["salary"], ["advance"], ["family_help"], ["refund_in"], ["other_income"]]
  };
  const DEFAULT_CATEGORIES = (() => {
    const list = [];
    let order = 0;
    for (const kind of ["expense", "income"]) for (const [key, kids] of CAT_KEYS[kind]) {
      list.push({id: "c-" + key, key, name: null, parentId: null, kind, archived: false, order: order++});
      for (const k of kids || []) list.push({id: "c-" + k, key: k, name: null, parentId: "c-" + key, kind, archived: false, order: order++});
    }
    return list;
  })();
  const defaultCategories = () => DEFAULT_CATEGORIES.map(c => ({...c}));
  const empty = today => ({version: 2, accounts: [{id: "main", name: "Основной", kind: "debit", openingCents: 0, openingDate: today, archived: false}], categories: defaultCategories(), operations: [], schedules: [], reserves: [], budgets: [], loans: []});
  const BAD_CATS = "В копии есть некорректные или повторяющиеся категории.";
  const nonEmpty = v => typeof v === "string" && v.trim().length > 0;
  function normCategories(list) {
    const bad = () => { throw new Error(BAD_CATS); };
    const byId = new Map();
    const cats = list.map(c => {
      if (!plain(c) || typeof c.id !== "string" || !ID.test(c.id) || byId.has(c.id) || !["expense", "income"].includes(c.kind) ||
        !(c.parentId === null || typeof c.parentId === "string") || typeof c.archived !== "boolean" || !Number.isSafeInteger(c.order) ||
        (c.key == null && c.name == null) || (c.key != null && (!nonEmpty(c.key) || c.key.length > 100)) ||
        (c.name != null && (!nonEmpty(c.name) || c.name.length > 100))) bad();
      const cat = {id: c.id, key: c.key == null ? null : c.key, name: c.name == null ? null : c.name, parentId: c.parentId, kind: c.kind, archived: c.archived, order: c.order};
      byId.set(cat.id, cat);
      return cat;
    });
    for (const c of cats) if (c.parentId !== null) {
      const p = byId.get(c.parentId);
      if (!p || p.parentId !== null || p.kind !== c.kind) bad();
    }
    return {cats, byId};
  }
  const UNITS = ["pcs", "kg", "g", "l", "ml", "pack"];
  const ITEM_KINDS = ["item", "discount", "fee"];
  const MAX_ITEMS = 200;
  const byCat = (a, b) => a.categoryId === b.categoryId ? 0 : a.categoryId === null ? 1 : b.categoryId === null ? -1 : a.categoryId < b.categoryId ? -1 : 1;
  // allocations из позиций чека: группы по категории, скидка пропорционально (наибольший остаток), fee — в fallback
  function allocationsFromItems(items, fallbackCategoryId = null) {
    const fb = fallbackCategoryId === undefined ? null : fallbackCategoryId;
    const groups = new Map();
    let discount = 0, fee = 0;
    for (const it of items) {
      if (it.kind === "discount") discount += it.amountCents;
      else if (it.kind === "fee") fee += it.amountCents;
      else { const k = it.categoryId == null ? fb : it.categoryId; groups.set(k, (groups.get(k) || 0) + it.amountCents); }
    }
    const list = [...groups].map(([categoryId, amountCents], i) => ({categoryId, amountCents, i}));
    const total = list.reduce((s, g) => s + g.amountCents, 0);
    if (discount > total) throw new Error(BAD_OPS);
    if (discount > 0) {
      const D = BigInt(discount), T = BigInt(total);
      let left = discount;
      for (const g of list) { const n = BigInt(g.amountCents) * D; g.share = Number(n / T); g.rem = n % T; left -= g.share; }
      [...list].sort((a, b) => a.rem === b.rem ? a.i - b.i : a.rem > b.rem ? -1 : 1).slice(0, left).forEach(g => g.share++);
      for (const g of list) g.amountCents -= g.share;
    }
    if (fee > 0) { const g = list.find(x => x.categoryId === fb); if (g) g.amountCents += fee; else list.push({categoryId: fb, amountCents: fee, i: list.length}); }
    return list.filter(g => g.amountCents > 0).map(g => ({categoryId: g.categoryId, amountCents: g.amountCents})).sort(byCat);
  }
  function normItems(items, catById, bad) {
    if (!Array.isArray(items) || !items.length || items.length > MAX_ITEMS) bad();
    const ids = new Set();
    return items.map(it => {
      if (!plain(it) || typeof it.id !== "string" || !it.id || it.id.length > 100 || ids.has(it.id) || !ITEM_KINDS.includes(it.kind) ||
        typeof it.name !== "string" || it.name.length > 80 || !Number.isSafeInteger(it.qtyMilli) || it.qtyMilli <= 0 || !UNITS.includes(it.unit) ||
        !cents(it.amountCents) || it.amountCents <= 0 || !(it.categoryId == null || typeof it.categoryId === "string")) bad();
      ids.add(it.id);
      const item = it.kind === "item";
      if (item && !it.name.trim()) bad();
      if (!item && (it.qtyMilli !== 1000 || it.unit !== "pcs")) bad();
      if (item && it.categoryId != null) { const c = catById.get(it.categoryId); if (!c || c.kind !== "expense") bad(); }
      return {id: it.id, kind: it.kind, name: it.name, qtyMilli: it.qtyMilli, unit: it.unit, amountCents: it.amountCents, categoryId: item && it.categoryId != null ? it.categoryId : null};
    });
  }
  function normOp(o, accountIds, nested, catById) {
    const bad = () => { throw new Error(BAD_OPS); };
    if (!plain(o) || typeof o.id !== "string" || !ID.test(o.id) || !OP_TYPES.includes(o.type) || !validDate(o.date) ||
      typeof o.note !== "string" || o.note.length > 160 || !isoOk(o.createdAt) || !isoOk(o.updatedAt) || typeof o.deleted !== "boolean" ||
      !Array.isArray(o.legs) || !Array.isArray(o.allocations) || !plain(o.links) || (!nested && (!Array.isArray(o.revisions) || o.revisions.length > 20))) bad();
    const legs = o.legs.map(l => {
      if (!plain(l) || typeof l.accountId !== "string" || !accountIds.has(l.accountId) || !cents(l.amountCents)) bad();
      return {accountId: l.accountId, amountCents: l.amountCents};
    });
    if (o.type === "transfer") {
      if (legs.length !== 2 || legs[0].accountId === legs[1].accountId || legs[0].amountCents + legs[1].amountCents !== 0 || legs[0].amountCents === 0) bad();
    } else if (legs.length !== 1) bad();
    else if (o.type === "income" ? legs[0].amountCents <= 0 : o.type === "expense" ? legs[0].amountCents >= 0 : legs[0].amountCents === 0) bad();
    if (o.type === "adjustment" && !o.note.trim()) bad();
    const allocations = o.allocations.map(a => {
      if (!plain(a) || !(a.categoryId === null || typeof a.categoryId === "string") || !cents(a.amountCents) || a.amountCents <= 0) bad();
      if (a.categoryId !== null) {
        const c = catById.get(a.categoryId);
        if (!c || c.kind !== o.type) bad();
      }
      return {categoryId: a.categoryId, amountCents: a.amountCents};
    });
    if (o.type === "expense") { if (allocations.length && allocations.reduce((s, a) => s + a.amountCents, 0) !== -legs[0].amountCents) bad(); }
    else if (o.type === "income") { if (allocations.length && allocations.reduce((s, a) => s + a.amountCents, 0) !== legs[0].amountCents) bad(); }
    else if (allocations.length) bad();
    let items;
    if (o.items !== undefined) {
      if (o.type !== "expense") bad();
      items = normItems(o.items, catById, bad);
      const sum = items.reduce((t, i) => t + (i.kind === "discount" ? -i.amountCents : i.amountCents), 0);
      if (sum !== -legs[0].amountCents) bad();
      // fallback-категория покупки в операции не хранится: это null или одна из категорий allocations
      const same = (x, y) => x.length === y.length && x.every((a, i) => a.categoryId === y[i].categoryId && a.amountCents === y[i].amountCents);
      const sorted = [...allocations].sort(byCat);
      let ok = false;
      for (const fb of new Set([null, ...allocations.map(a => a.categoryId)])) {
        try { if (same(allocationsFromItems(items, fb), sorted)) { ok = true; break; } } catch (e) { bad(); }
      }
      if (!ok) bad();
    }
    let merchant;
    if (o.merchant !== undefined) {
      if (o.type !== "income" && o.type !== "expense") bad();
      if (typeof o.merchant !== "string") bad();
      const m = o.merchant.trim();
      if (m.length > 80) bad();
      if (m) merchant = m;
    }
    const op = {id: o.id, type: o.type, date: o.date, note: o.note, createdAt: o.createdAt, updatedAt: o.updatedAt, deleted: o.deleted, legs, allocations, links: o.type === "expense" && typeof o.links.feeOf === "string" && ID.test(o.links.feeOf) ? {feeOf: o.links.feeOf} : {}};
    if (merchant) op.merchant = merchant;
    if (items) op.items = items;
    if (!nested) op.revisions = o.revisions.map(r => {
      if (!plain(r) || !isoOk(r.at)) bad();
      return {at: r.at, before: normOp(r.before, accountIds, true, catById)};
    });
    return op;
  }
  function validate(data) {
    if (!plain(data) || data.version !== 2 || !Array.isArray(data.accounts) || data.accounts.length < 1 || data.accounts.length > 1000 ||
      !Array.isArray(data.operations) || data.operations.length > 100000 ||
      !["categories", "schedules", "reserves", "budgets", "loans"].every(k => Array.isArray(data[k]))) throw new Error(FORMAT);
    const accountIds = new Set();
    const accounts = data.accounts.map(a => {
      if (!plain(a) || typeof a.id !== "string" || !ID.test(a.id) || accountIds.has(a.id) || typeof a.name !== "string" || !a.name.trim() || a.name.length > 100 ||
        !KINDS.includes(a.kind) || !cents(a.openingCents) || !validDate(a.openingDate) || typeof a.archived !== "boolean" ||
        (a.order !== undefined && !Number.isSafeInteger(a.order))) throw new Error(BAD_ACCOUNTS);
      accountIds.add(a.id);
      const acc = {id: a.id, name: a.name, kind: a.kind, openingCents: a.openingCents, openingDate: a.openingDate, archived: a.archived};
      if (a.order !== undefined) acc.order = a.order;
      return acc;
    });
    const {cats, byId: catById} = normCategories(data.categories);
    const ids = new Set();
    const operations = data.operations.map(o => {
      const op = normOp(o, accountIds, false, catById);
      if (ids.has(op.id)) throw new Error(BAD_OPS);
      ids.add(op.id);
      return op;
    });
    const sums = new Map(accounts.map(a => [a.id, a.openingCents]));
    let income = 0, expense = 0;
    for (const op of operations) {
      if (op.deleted) continue;
      for (const leg of op.legs) {
        const next = sums.get(leg.accountId) + leg.amountCents;
        if (op.type === "income") income += leg.amountCents; else if (op.type === "expense") expense -= leg.amountCents;
        if (!Number.isSafeInteger(next) || !Number.isSafeInteger(income) || !Number.isSafeInteger(expense)) throw new Error(LIMIT);
        sums.set(leg.accountId, next);
      }
    }
    let total = 0;
    for (const a of accounts) if (a.kind !== "loan" && a.kind !== "person") total += sums.get(a.id);
    if (!Number.isSafeInteger(total)) throw new Error(LIMIT);
    const rest = {categories: cats};
    for (const k of ["schedules", "reserves", "budgets", "loans"]) rest[k] = data[k].slice();
    return {version: 2, accounts, categories: rest.categories, operations, schedules: rest.schedules, reserves: rest.reserves, budgets: rest.budgets, loans: rest.loans};
  }
  function validateV1(data) {
    if (!data || data.version !== 1 || !Number.isSafeInteger(data.openingCents) || Math.abs(data.openingCents) > MAX_AMOUNT || !Array.isArray(data.entries) || data.entries.length > 100000) throw new Error(FORMAT);
    const ids = new Set();
    const entries = data.entries.map(e => {
      if (!e || typeof e.id !== "string" || !ID.test(e.id) || ids.has(e.id) ||
        !["income","expense"].includes(e.type) || !Number.isSafeInteger(e.amountCents) || e.amountCents <= 0 || e.amountCents > MAX_AMOUNT ||
        !validDate(e.date) || typeof e.note !== "string" || e.note.length > 160 ||
        typeof e.createdAt !== "string" || !Number.isFinite(Date.parse(e.createdAt)) || typeof e.deleted !== "boolean") throw new Error(BAD_OPS);
      ids.add(e.id);
      return {id: e.id, type: e.type, amountCents: e.amountCents, date: e.date, note: e.note, createdAt: e.createdAt, deleted: e.deleted};
    });
    let income = 0, expense = 0;
    for (const e of entries) {
      if (e.deleted) continue;
      if (e.type === "income") income += e.amountCents; else expense += e.amountCents;
      if (!Number.isSafeInteger(income) || !Number.isSafeInteger(expense)) throw new Error(LIMIT);
    }
    if (!Number.isSafeInteger(data.openingCents + income - expense)) throw new Error(LIMIT);
    return {version: 1, openingCents: data.openingCents, entries};
  }
  function migrate(data, today) {
    if (plain(data) && data.version === 2) return validate(Array.isArray(data.categories) && !data.categories.length ? {...data, categories: defaultCategories()} : data);
    if (plain(data) && data.version === 1) {
      const v1 = validateV1(data);
      const openingDate = v1.entries.length ? v1.entries.reduce((m, e) => e.date < m ? e.date : m, v1.entries[0].date) : today;
      const state = empty(today);
      state.accounts[0].openingCents = v1.openingCents;
      state.accounts[0].openingDate = openingDate;
      state.operations = v1.entries.map(e => ({
        id: e.id, type: e.type, date: e.date, note: e.note, createdAt: e.createdAt, updatedAt: e.createdAt, deleted: e.deleted,
        legs: [{accountId: "main", amountCents: e.type === "income" ? e.amountCents : -e.amountCents}],
        allocations: e.type === "income" ? [] : [{categoryId: null, amountCents: e.amountCents}],
        links: {}, revisions: []
      }));
      return validate(state);
    }
    throw new Error(FORMAT);
  }
  const api = {OP_TYPES, KINDS, UNITS, ITEM_KINDS, allocationsFromItems, DEFAULT_CATEGORIES, defaultCategories, empty, validate, migrate};
  if (node) module.exports = api;
  else (root.MoneyCore = root.MoneyCore || {}).schema = api;
})(globalThis);
