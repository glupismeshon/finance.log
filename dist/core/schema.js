(function (root) {
  "use strict";
  const node = typeof module !== "undefined" && module.exports;
  const {validDate, MAX_AMOUNT} = node ? require("./money.js") : root.MoneyCore.money;
  const OP_TYPES = ["income", "expense"];
  const KINDS = ["debit", "cash", "savings", "credit_card", "loan", "person"];
  const FORMAT = "Не удалось прочитать копию money.log. Проверьте формат файла.";
  const BAD_OPS = "В копии есть некорректные или повторяющиеся записи.";
  const BAD_ACCOUNTS = "В копии есть некорректные или повторяющиеся счета.";
  const LIMIT = "Общая сумма превышает поддерживаемый предел.";
  const ID = /^[\w-]{1,100}$/;
  const plain = v => !!v && typeof v === "object" && !Array.isArray(v);
  const isoOk = v => typeof v === "string" && Number.isFinite(Date.parse(v));
  const cents = v => Number.isSafeInteger(v) && Math.abs(v) <= MAX_AMOUNT;
  const empty = today => ({version: 2, accounts: [{id: "main", name: "Основной", kind: "debit", openingCents: 0, openingDate: today, archived: false}], categories: [], operations: [], schedules: [], reserves: [], budgets: [], loans: []});
  function normOp(o, accountIds, nested) {
    const bad = () => { throw new Error(BAD_OPS); };
    if (!plain(o) || typeof o.id !== "string" || !ID.test(o.id) || !OP_TYPES.includes(o.type) || !validDate(o.date) ||
      typeof o.note !== "string" || o.note.length > 160 || !isoOk(o.createdAt) || !isoOk(o.updatedAt) || typeof o.deleted !== "boolean" ||
      !Array.isArray(o.legs) || !Array.isArray(o.allocations) || !plain(o.links) || (!nested && (!Array.isArray(o.revisions) || o.revisions.length > 20))) bad();
    const legs = o.legs.map(l => {
      if (!plain(l) || typeof l.accountId !== "string" || !accountIds.has(l.accountId) || !cents(l.amountCents)) bad();
      return {accountId: l.accountId, amountCents: l.amountCents};
    });
    if (legs.length !== 1 || (o.type === "income" ? legs[0].amountCents <= 0 : legs[0].amountCents >= 0)) bad();
    const allocations = o.allocations.map(a => {
      if (!plain(a) || !(a.categoryId === null || typeof a.categoryId === "string") || !cents(a.amountCents) || a.amountCents <= 0) bad();
      return {categoryId: a.categoryId, amountCents: a.amountCents};
    });
    if (o.type === "income" ? allocations.length : allocations.length && allocations.reduce((s, a) => s + a.amountCents, 0) !== -legs[0].amountCents) bad();
    const op = {id: o.id, type: o.type, date: o.date, note: o.note, createdAt: o.createdAt, updatedAt: o.updatedAt, deleted: o.deleted, legs, allocations, links: {...o.links}};
    if (!nested) op.revisions = o.revisions.map(r => {
      if (!plain(r) || !isoOk(r.at)) bad();
      return {at: r.at, before: normOp(r.before, accountIds, true)};
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
        !KINDS.includes(a.kind) || !cents(a.openingCents) || !validDate(a.openingDate) || typeof a.archived !== "boolean") throw new Error(BAD_ACCOUNTS);
      accountIds.add(a.id);
      return {id: a.id, name: a.name, kind: a.kind, openingCents: a.openingCents, openingDate: a.openingDate, archived: a.archived};
    });
    const ids = new Set();
    const operations = data.operations.map(o => {
      const op = normOp(o, accountIds, false);
      if (ids.has(op.id)) throw new Error(BAD_OPS);
      ids.add(op.id);
      return op;
    });
    const sums = new Map(accounts.map(a => [a.id, a.openingCents]));
    let income = 0, expense = 0;
    for (const op of operations) {
      if (op.deleted) continue;
      const leg = op.legs[0], next = sums.get(leg.accountId) + leg.amountCents;
      if (op.type === "income") income += leg.amountCents; else expense -= leg.amountCents;
      if (!Number.isSafeInteger(next) || !Number.isSafeInteger(income) || !Number.isSafeInteger(expense)) throw new Error(LIMIT);
      sums.set(leg.accountId, next);
    }
    let total = 0;
    for (const a of accounts) if (a.kind !== "loan" && a.kind !== "person") total += sums.get(a.id);
    if (!Number.isSafeInteger(total)) throw new Error(LIMIT);
    const rest = {};
    for (const k of ["categories", "schedules", "reserves", "budgets", "loans"]) rest[k] = data[k].slice();
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
    if (plain(data) && data.version === 2) return validate(data);
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
  const api = {OP_TYPES, KINDS, empty, validate, migrate};
  if (node) module.exports = api;
  else (root.MoneyCore = root.MoneyCore || {}).schema = api;
})(globalThis);
