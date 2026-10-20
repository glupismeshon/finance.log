(function (root) {
  "use strict";
  const node = typeof module !== "undefined" && module.exports;
  const {validate, migrate} = node ? require("./schema.js") : root.MoneyCore.schema;
  const MAX_REVISIONS = 20;
  const canon = v => JSON.stringify(v, (k, x) => x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : x);
  const content = o => canon({type: o.type, date: o.date, note: o.note, deleted: o.deleted, legs: o.legs, allocations: o.allocations, links: o.links});
  function upsertOperation(state, op, nowISO) {
    const index = state.operations.findIndex(o => o.id === op.id);
    const put = o => ({...state, operations: index < 0 ? [...state.operations, o] : state.operations.map((x, i) => i === index ? o : x)});
    if (index < 0) return validate(put({links: {}, revisions: [], ...op, createdAt: op.createdAt || nowISO, updatedAt: op.updatedAt || op.createdAt || nowISO}));
    const old = state.operations[index];
    const next = validate(put({...op, links: op.links || {}, createdAt: old.createdAt, updatedAt: old.updatedAt, revisions: old.revisions})).operations[index];
    if (content(next) === content(old)) return state;
    const {revisions, ...before} = old;
    return validate(put({...next, updatedAt: nowISO, revisions: [...revisions, {at: nowISO, before}].slice(-MAX_REVISIONS)}));
  }
  function setDeleted(state, id, deleted) {
    if (!state.operations.some(o => o.id === id)) throw new Error("Запись не найдена.");
    return validate({...state, operations: state.operations.map(o => o.id === id ? {...o, deleted} : o)});
  }
  function merge(state, imported, todayISO) {
    const incoming = migrate(imported, todayISO);
    const ids = new Set(state.operations.map(o => o.id));
    const added = incoming.operations.filter(o => !ids.has(o.id));
    const accountIds = new Set(state.accounts.map(a => a.id));
    const newAccounts = incoming.accounts.filter(a => !accountIds.has(a.id));
    const mine = state.accounts.find(a => a.id === "main"), theirs = incoming.accounts.find(a => a.id === "main");
    const takeOpening = mine && theirs && state.operations.length === 0 && mine.openingCents === 0;
    const accounts = state.accounts.map(a => a === mine && takeOpening ? {...a, openingCents: theirs.openingCents, openingDate: theirs.openingDate} : a);
    return {state: validate({...state, accounts: [...accounts, ...newAccounts], operations: [...state.operations, ...added]}), added: added.length};
  }
  function setOpening(state, accountId, cents) {
    if (!state.accounts.some(a => a.id === accountId)) throw new Error("Счёт не найден.");
    return validate({...state, accounts: state.accounts.map(a => a.id === accountId ? {...a, openingCents: cents} : a)});
  }
  const api = {upsertOperation, setDeleted, merge, setOpening};
  if (node) module.exports = api;
  else (root.MoneyCore = root.MoneyCore || {}).journal = api;
})(globalThis);
