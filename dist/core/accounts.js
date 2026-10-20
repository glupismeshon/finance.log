(function (root) {
  "use strict";
  const node = typeof module !== "undefined" && module.exports;
  const {validate} = node ? require("./schema.js") : root.MoneyCore.schema;
  const KIND_LABELS = {debit: "дебетовая", cash: "наличные", savings: "накопительный", credit_card: "кредитная карта", loan: "кредит", person: "долг человека"};
  const DUP = "Счёт с таким названием уже есть.";
  const find = (state, id) => {
    const a = state.accounts.find(x => x.id === id);
    if (!a) throw new Error("Счёт не найден.");
    return a;
  };
  function checkName(state, name, exceptId, archived) {
    if (typeof name !== "string" || !name.trim() || name.length > 100) throw new Error("Название счёта — от 1 до 100 символов.");
    if (archived) return;
    const key = name.trim().toLowerCase();
    if (state.accounts.some(a => !a.archived && a.id !== exceptId && a.name.trim().toLowerCase() === key)) throw new Error(DUP);
  }
  function addAccount(state, {id, name, kind, openingCents, openingDate, limitCents}, nowISO = new Date().toISOString()) {
    checkName(state, name);
    const order = state.accounts.reduce((m, a) => Math.max(m, a.order ?? 0), -1) + 1;
    const acc = {id, name: name.trim(), kind, openingCents: openingCents || 0, openingDate, archived: false, order, updatedAt: nowISO};
    if (limitCents != null) acc.limitCents = limitCents;
    return validate({...state, accounts: [...state.accounts, acc]});
  }
  function updateAccount(state, id, patch, nowISO = new Date().toISOString()) {
    const old = find(state, id);
    const next = {...old, updatedAt: nowISO};
    for (const k of ["name", "kind", "openingCents", "openingDate", "order"]) if (patch[k] !== undefined) next[k] = patch[k];
    if (patch.limitCents !== undefined) { if (patch.limitCents === null) delete next.limitCents; else next.limitCents = patch.limitCents; }
    if (patch.kind !== undefined && next.kind !== "credit_card") delete next.limitCents;
    checkName(state, next.name, id, old.archived);
    next.name = next.name.trim();
    return validate({...state, accounts: state.accounts.map(a => a.id === id ? next : a)});
  }
  function archiveAccount(state, id, archived = true, nowISO = new Date().toISOString()) {
    const acc = find(state, id);
    if (archived && !acc.archived && state.accounts.filter(a => !a.archived).length <= 1) throw new Error("Нужен хотя бы один счёт.");
    if (!archived && acc.archived) checkName(state, acc.name, id, false);
    return validate({...state, accounts: state.accounts.map(a => a.id === id ? {...a, archived: !!archived, updatedAt: nowISO} : a)});
  }
  function activeAccounts(state) {
    return state.accounts.map((a, i) => ({a, i})).filter(x => !x.a.archived)
      .sort((x, y) => (x.a.order ?? x.i) - (y.a.order ?? y.i) || x.a.name.localeCompare(y.a.name)).map(x => x.a);
  }
  const api = {KIND_LABELS, addAccount, updateAccount, archiveAccount, activeAccounts};
  if (node) module.exports = api;
  else (root.MoneyCore = root.MoneyCore || {}).accounts = api;
})(globalThis);
