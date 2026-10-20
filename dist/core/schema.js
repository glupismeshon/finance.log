(function (root) {
  "use strict";
  const node = typeof module !== "undefined" && module.exports;
  const {validDate, MAX_AMOUNT} = node ? require("./money.js") : root.MoneyCore.money;
  const OP_TYPES = ["income", "expense", "transfer", "adjustment", "loan_payment"];
  const KINDS = ["debit", "cash", "savings", "credit_card", "loan", "person"];
  const FORMAT = "Не удалось прочитать копию finance.log. Проверьте формат файла.";
  const BAD_OPS = "В копии есть некорректные или повторяющиеся записи.";
  const BAD_ACCOUNTS = "В копии есть некорректные или повторяющиеся счета.";
  const LIMIT = "Общая сумма превышает поддерживаемый предел.";
  const ID = /^[\w-]{1,100}$/;
  const plain = v => !!v && typeof v === "object" && !Array.isArray(v);
  const isoOk = v => typeof v === "string" && Number.isFinite(Date.parse(v));
  const cents = v => Number.isSafeInteger(v) && Math.abs(v) <= MAX_AMOUNT;
  const CAT_KEYS = {
    expense: [["groceries", ["groceries_meat", "groceries_dairy", "groceries_produce", "groceries_other"]], ["transport"], ["housing"], ["subscriptions"], ["health"], ["clothing"], ["fun"], ["household"], ["loan_interest"], ["other_expense"]],
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
  const empty = today => ({version: 2, accounts: [{id: "main", name: "Основной", kind: "debit", openingCents: 0, openingDate: today, archived: false}], categories: defaultCategories(), operations: [], schedules: [], reserves: [], budgets: [], loans: [], readings: []});
  const BAD_CATS = "В копии есть некорректные или повторяющиеся категории.";
  const nonEmpty = v => typeof v === "string" && v.trim().length > 0;
  function normCategories(list) {
    const bad = () => { throw new Error(BAD_CATS); };
    const byId = new Map();
    const cats = list.map(c => {
      if (!plain(c) || typeof c.id !== "string" || !ID.test(c.id) || byId.has(c.id) || !["expense", "income"].includes(c.kind) ||
        !(c.parentId === null || typeof c.parentId === "string") || typeof c.archived !== "boolean" || !Number.isSafeInteger(c.order) ||
        (c.key == null && c.name == null) || (c.key != null && (!nonEmpty(c.key) || c.key.length > 100)) ||
        (c.name != null && (!nonEmpty(c.name) || c.name.length > 100)) || (c.updatedAt !== undefined && !isoOk(c.updatedAt))) bad();
      const cat = {id: c.id, key: c.key == null ? null : c.key, name: c.name == null ? null : c.name, parentId: c.parentId, kind: c.kind, archived: c.archived, order: c.order};
      if (c.updatedAt !== undefined) cat.updatedAt = c.updatedAt;
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
    } else if (o.type === "loan_payment") {
      // legs[0]: платёж со счёта (<0), legs[1]: основной долг на счёт кредита (>=0, не больше платежа)
      if (legs.length !== 2 || legs[0].accountId === legs[1].accountId || legs[0].amountCents >= 0 || legs[1].amountCents < 0 || legs[1].amountCents > -legs[0].amountCents) bad();
    } else if (legs.length !== 1) bad();
    else if (o.type === "income" ? legs[0].amountCents <= 0 : o.type === "expense" ? legs[0].amountCents >= 0 : legs[0].amountCents === 0) bad();
    if (o.type === "adjustment" && !o.note.trim()) bad();
    const allocations = o.allocations.map(a => {
      if (!plain(a) || !(a.categoryId === null || typeof a.categoryId === "string") || !cents(a.amountCents) || a.amountCents <= 0) bad();
      if (a.categoryId !== null) {
        const c = catById.get(a.categoryId);
        if (!c || c.kind !== (o.type === "loan_payment" ? "expense" : o.type)) bad();
      }
      return {categoryId: a.categoryId, amountCents: a.amountCents};
    });
    if (o.type === "expense") { if (allocations.length && allocations.reduce((s, a) => s + a.amountCents, 0) !== -legs[0].amountCents) bad(); }
    else if (o.type === "income") { if (allocations.length && allocations.reduce((s, a) => s + a.amountCents, 0) !== legs[0].amountCents) bad(); }
    else if (o.type === "loan_payment") { if (allocations.reduce((s, a) => s + a.amountCents, 0) !== -legs[0].amountCents - legs[1].amountCents) bad(); }
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
    const links = {};
    if (o.type === "expense" && typeof o.links.feeOf === "string" && ID.test(o.links.feeOf)) links.feeOf = o.links.feeOf;
    if (o.type !== "adjustment" && o.links.scheduleId !== undefined) {
      if (typeof o.links.scheduleId !== "string" || !ID.test(o.links.scheduleId) || !validDate(o.links.dueDate)) bad();
      links.scheduleId = o.links.scheduleId;
      links.dueDate = o.links.dueDate;
    }
    if (o.type === "loan_payment") {
      if (typeof o.links.loanAccountId !== "string" || o.links.loanAccountId !== legs[1].accountId) bad();
      links.loanAccountId = o.links.loanAccountId;
      if (o.links.early !== undefined) { if (o.links.early !== "term" && o.links.early !== "payment") bad(); links.early = o.links.early; }
    }
    const op = {id: o.id, type: o.type, date: o.date, note: o.note, createdAt: o.createdAt, updatedAt: o.updatedAt, deleted: o.deleted, legs, allocations, links};
    if (merchant) op.merchant = merchant;
    if (items) op.items = items;
    if (!nested) op.revisions = o.revisions.map(r => {
      if (!plain(r) || !isoOk(r.at)) bad();
      return {at: r.at, before: normOp(r.before, accountIds, true, catById)};
    });
    return op;
  }
  const BAD_LOANS = "В копии есть некорректные кредиты.";
  const BAD_READINGS = "В копии есть некорректные показания счётчиков.";
  const BAD_SCHEDULES = "В копии есть некорректные или повторяющиеся регулярные платежи.";
  const TEMPLATES = ["subscription", "fixed", "bill", "income", "loan"];
  const AMOUNT_MODES = ["fixed", "variable"];
  const METER_UNITS = ["kWh", "m3", "gcal", "unit"];
  const FREQS = ["monthly", "weekly", "yearly", "days"];
  const intIn = (v, a, b) => Number.isSafeInteger(v) && v >= a && v <= b;
  function normSchedule(s, accountIds, catById) {
    const bad = () => { throw new Error(BAD_SCHEDULES); };
    if (!plain(s) || typeof s.id !== "string" || !ID.test(s.id) || !["expense", "income", "transfer"].includes(s.type) ||
      typeof s.name !== "string" || !s.name.trim() || s.name.length > 80 || !cents(s.amountCents) || s.amountCents < 0 ||
      typeof s.accountId !== "string" || !accountIds.has(s.accountId) || !plain(s.rule) || !validDate(s.startDate) ||
      !(s.endDate === null || (validDate(s.endDate) && s.endDate >= s.startDate)) || typeof s.subscription !== "boolean" ||
      typeof s.paused !== "boolean" || typeof s.archived !== "boolean" || !Array.isArray(s.skips) || s.skips.length > 1000 || !isoOk(s.updatedAt)) bad();
    // вид регулярного платежа; старые правила без template: подписка / доход / фикс. платёж
    const template = s.template === undefined ? (s.type === "income" ? "income" : s.subscription ? "subscription" : "fixed") : s.template;
    if (!TEMPLATES.includes(template)) bad();
    const amountMode = s.amountMode === undefined ? (template === "bill" ? "variable" : "fixed") : s.amountMode;
    if (!AMOUNT_MODES.includes(amountMode) || (template === "bill" && amountMode !== "variable") || (template !== "bill" && template !== "income" && amountMode !== "fixed")) bad();
    if (amountMode === "fixed" && s.amountCents <= 0) bad();
    if ((template === "income") !== (s.type === "income") || ((template === "subscription" || template === "bill") && s.type !== "expense") || (template === "loan" && s.type !== "transfer")) bad();
    let meters;
    if (s.meters !== undefined && !(Array.isArray(s.meters) && !s.meters.length)) {
      if (template !== "bill" || !Array.isArray(s.meters) || s.meters.length > 20) bad();
      const mids = new Set();
      meters = s.meters.map(m => {
        if (!plain(m) || typeof m.id !== "string" || !ID.test(m.id) || mids.has(m.id) || typeof m.name !== "string" || !m.name.trim() || m.name.length > 60 ||
          !METER_UNITS.includes(m.unit) || typeof m.archived !== "boolean" || !(m.tariffCents === undefined || m.tariffCents === null || (Number.isSafeInteger(m.tariffCents) && m.tariffCents >= 0 && m.tariffCents <= MAX_AMOUNT))) bad();
        mids.add(m.id);
        const out = {id: m.id, name: m.name.trim(), unit: m.unit, archived: m.archived};
        if (m.tariffCents !== undefined && m.tariffCents !== null) out.tariffCents = m.tariffCents;
        return out;
      });
    }
    if (s.readingsDay !== undefined && s.readingsDay !== null && (template !== "bill" || !intIn(s.readingsDay, 1, 31))) bad();
    const r = s.rule;
    if (!FREQS.includes(r.freq) || !intIn(r.interval, 1, 365)) bad();
    const rule = {freq: r.freq, interval: r.interval};
    if (r.freq === "monthly") { if (!intIn(r.day, 1, 31)) bad(); rule.day = r.day; }
    else if (r.freq === "weekly") { if (!intIn(r.weekday, 1, 7)) bad(); rule.weekday = r.weekday; }
    else if (r.freq === "yearly") { if (!intIn(r.month, 1, 12) || !intIn(r.day, 1, 31)) bad(); rule.month = r.month; rule.day = r.day; }
    if (s.skips.some(d => !validDate(d))) bad();
    const out = {id: s.id, type: s.type, name: s.name, amountCents: s.amountCents, accountId: s.accountId};
    if (s.type === "transfer") {
      if (typeof s.toAccountId !== "string" || !accountIds.has(s.toAccountId) || s.toAccountId === s.accountId || s.categoryId != null || s.merchant !== undefined) bad();
      out.toAccountId = s.toAccountId;
    } else if (s.toAccountId !== undefined) bad();
    out.categoryId = null;
    if (s.categoryId != null) {
      const c = typeof s.categoryId === "string" ? catById.get(s.categoryId) : null;
      if (!c || c.kind !== s.type) bad();
      out.categoryId = s.categoryId;
    }
    if (s.merchant !== undefined) {
      if (typeof s.merchant !== "string" || s.merchant.trim().length > 80) bad();
      if (s.merchant.trim()) out.merchant = s.merchant.trim();
    }
    const extra = {};
    if (meters) extra.meters = meters;
    if (s.readingsDay != null) extra.readingsDay = s.readingsDay;
    return {...out, ...extra, template, amountMode, rule, startDate: s.startDate, endDate: s.endDate, subscription: template === "subscription", paused: s.paused, archived: s.archived,
      skips: [...new Set(s.skips)].sort(), updatedAt: s.updatedAt};
  }
  function validate(data) {
    if (!plain(data) || data.version !== 2 || !Array.isArray(data.accounts) || data.accounts.length < 1 || data.accounts.length > 1000 ||
      !Array.isArray(data.operations) || data.operations.length > 100000 ||
      !["categories", "schedules", "reserves", "budgets", "loans"].every(k => Array.isArray(data[k]))) throw new Error(FORMAT);
    const accountIds = new Set();
    const accounts = data.accounts.map(a => {
      if (!plain(a) || typeof a.id !== "string" || !ID.test(a.id) || accountIds.has(a.id) || typeof a.name !== "string" || !a.name.trim() || a.name.length > 100 ||
        !KINDS.includes(a.kind) || !cents(a.openingCents) || !validDate(a.openingDate) || typeof a.archived !== "boolean" ||
        (a.order !== undefined && !Number.isSafeInteger(a.order)) || (a.updatedAt !== undefined && !isoOk(a.updatedAt))) throw new Error(BAD_ACCOUNTS);
      accountIds.add(a.id);
      if (a.limitCents != null && (a.kind !== "credit_card" || !cents(a.limitCents) || a.limitCents < 0)) throw new Error(BAD_ACCOUNTS);
      const acc = {id: a.id, name: a.name, kind: a.kind, openingCents: a.openingCents, openingDate: a.openingDate, archived: a.archived};
      if (a.limitCents != null) acc.limitCents = a.limitCents;
      if (a.order !== undefined) acc.order = a.order;
      if (a.updatedAt !== undefined) acc.updatedAt = a.updatedAt;
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
    for (const k of ["reserves", "budgets"]) rest[k] = data[k].slice();
    const kindOf = new Map(accounts.map(a => [a.id, a.kind]));
    const loanIds = new Set();
    rest.loans = data.loans.map(l => {
      const bad = () => { throw new Error(BAD_LOANS); };
      if (!plain(l) || typeof l.accountId !== "string" || kindOf.get(l.accountId) !== "loan" || loanIds.has(l.accountId) || !cents(l.principalCents) || l.principalCents <= 0 ||
        !intIn(l.rateBp, 0, 100000) || !intIn(l.termMonths, 1, 600) || !validDate(l.startDate) || !intIn(l.paymentDay, 1, 31) || !["annuity", "diff"].includes(l.method) ||
        typeof l.scheduleId !== "string" || !ID.test(l.scheduleId) || !isoOk(l.updatedAt)) bad();
      loanIds.add(l.accountId);
      return {id: l.accountId, accountId: l.accountId, principalCents: l.principalCents, rateBp: l.rateBp, termMonths: l.termMonths, startDate: l.startDate,
        paymentDay: l.paymentDay, method: l.method, scheduleId: l.scheduleId, updatedAt: l.updatedAt};
    });
    if (data.readings !== undefined && !Array.isArray(data.readings)) throw new Error(FORMAT);
    const readIds = new Set();
    rest.readings = (data.readings || []).map(r => {
      const bad = () => { throw new Error(BAD_READINGS); };
      if (!plain(r) || typeof r.id !== "string" || !ID.test(r.id) || readIds.has(r.id) || typeof r.scheduleId !== "string" || !ID.test(r.scheduleId) ||
        typeof r.meterId !== "string" || !ID.test(r.meterId) || !validDate(r.date) || !Number.isSafeInteger(r.valueMilli) || r.valueMilli < 0 ||
        !isoOk(r.updatedAt) || typeof r.deleted !== "boolean") bad();
      readIds.add(r.id);
      return {id: r.id, scheduleId: r.scheduleId, meterId: r.meterId, date: r.date, valueMilli: r.valueMilli, updatedAt: r.updatedAt, deleted: r.deleted};
    });
    if (data.schedules.length > 1000) throw new Error(BAD_SCHEDULES);
    const schedIds = new Set();
    const schedules = data.schedules.map(x => {
      const sc = normSchedule(x, accountIds, catById);
      if (schedIds.has(sc.id)) throw new Error(BAD_SCHEDULES);
      schedIds.add(sc.id);
      return sc;
    });
    return {version: 2, accounts, categories: rest.categories, operations, schedules, reserves: rest.reserves, budgets: rest.budgets, loans: rest.loans, readings: rest.readings};
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
  // добавляет недостающие стандартные категории по id (старые копии без новых стандартных категорий)
  function withDefaultCategories(data) {
    if (!Array.isArray(data.categories)) return data;
    const have = new Set(data.categories.filter(c => plain(c)).map(c => c.id));
    // полностью пользовательский список (ни одной стандартной категории) не трогаем
    if (data.categories.length && !DEFAULT_CATEGORIES.some(c => have.has(c.id))) return data;
    const missing = defaultCategories().filter(c => !have.has(c.id));
    if (!missing.length) return data;
    let order = data.categories.reduce((m, c) => plain(c) && Number.isSafeInteger(c.order) ? Math.max(m, c.order) : m, -1) + 1;
    return {...data, categories: [...data.categories, ...missing.map(c => ({...c, order: order++}))]};
  }
  function migrate(data, today) {
    if (plain(data) && data.version === 2) return validate(withDefaultCategories(data));
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
