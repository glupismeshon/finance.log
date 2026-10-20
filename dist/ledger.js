(function (root) {
  "use strict";
  const MAX_AMOUNT = 999999999999;
  const empty = () => ({version: 1, openingCents: 0, entries: []});
  function parseAmount(value, signed = false) {
    const clean = String(value).trim().replace(/[\s\u00a0\u202f]/g, "").replace(",", ".");
    const pattern = signed ? /^-?\d+(?:\.\d{1,2})?$/ : /^\d+(?:\.\d{1,2})?$/;
    if (!pattern.test(clean)) throw new Error("Введите сумму цифрами, максимум два знака после запятой.");
    const negative = clean.startsWith("-");
    const [rubles, decimals = ""] = clean.replace("-", "").split(".");
    const cents = Number(rubles) * 100 + Number(decimals.padEnd(2, "0"));
    if (!Number.isSafeInteger(cents) || cents > MAX_AMOUNT) throw new Error("Слишком большая сумма. Максимум — 9 999 999 999,99 ₽.");
    if (!signed && cents === 0) throw new Error("Сумма должна быть больше нуля.");
    return (negative ? -1 : 1) * cents;
  }
  function validDate(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.slice(0,4) < "1900") return false;
    const date = new Date(value + "T12:00:00Z");
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0,10) === value;
  }
  function totals(state) {
    let income = 0, expense = 0;
    for (const entry of state.entries) {
      if (entry.deleted) continue;
      if (entry.type === "income") income += entry.amountCents;
      else expense += entry.amountCents;
      if (!Number.isSafeInteger(income) || !Number.isSafeInteger(expense)) throw new Error("Общая сумма превышает поддерживаемый предел.");
    }
    const balance = state.openingCents + income - expense;
    if (!Number.isSafeInteger(balance)) throw new Error("Общая сумма превышает поддерживаемый предел.");
    return {income, expense, balance};
  }
  function validate(data) {
    if (!data || data.version !== 1 || !Number.isSafeInteger(data.openingCents) || Math.abs(data.openingCents) > MAX_AMOUNT || !Array.isArray(data.entries) || data.entries.length > 100000) throw new Error("Не удалось прочитать копию money.log. Проверьте формат файла.");
    const ids = new Set();
    const entries = data.entries.map(e => {
      if (!e || typeof e.id !== "string" || !/^[\w-]{1,100}$/.test(e.id) || ids.has(e.id) ||
        !["income","expense"].includes(e.type) || !Number.isSafeInteger(e.amountCents) || e.amountCents <= 0 || e.amountCents > MAX_AMOUNT ||
        !validDate(e.date) || typeof e.note !== "string" || e.note.length > 160 ||
        typeof e.createdAt !== "string" || !Number.isFinite(Date.parse(e.createdAt)) || typeof e.deleted !== "boolean") throw new Error("В копии есть некорректные или повторяющиеся записи.");
      ids.add(e.id);
      return {id:e.id, type:e.type, amountCents:e.amountCents, date:e.date, note:e.note, createdAt:e.createdAt, deleted:e.deleted};
    });
    const state = {version:1, openingCents:data.openingCents, entries};
    totals(state);
    return state;
  }
  function upsert(state, entry) {
    const existing = state.entries.some(e => e.id === entry.id);
    return validate({...state, entries:existing ? state.entries.map(e => e.id === entry.id ? entry : e) : [...state.entries, entry]});
  }
  function setDeleted(state, id, deleted) {
    if (!state.entries.some(e=>e.id===id)) throw new Error("Запись не найдена.");
    return validate({...state, entries:state.entries.map(e=>e.id===id ? {...e,deleted} : e)});
  }
  function merge(state, imported) {
    const incoming = validate(imported);
    const ids = new Set(state.entries.map(e=>e.id));
    const added = incoming.entries.filter(e=>!ids.has(e.id));
    const openingCents = state.entries.length === 0 && state.openingCents === 0 ? incoming.openingCents : state.openingCents;
    return {state:validate({...state, openingCents, entries:[...state.entries,...added]}), added:added.length};
  }
  const api = {empty, parseAmount, validDate, totals, validate, upsert, setDeleted, merge};
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Ledger = api;
})(globalThis);
