(function (root) {
  "use strict";
  const node = typeof module !== "undefined" && module.exports;
  const {validate} = node ? require("./schema.js") : root.MoneyCore.schema;
  const EPOCH = "1970-01-01T00:00:00.000Z";
  // state-массив → kind записи
  const LISTS = [["accounts", "account"], ["categories", "category"], ["schedules", "schedule"], ["reserves", "reserve"], ["budgets", "budget"], ["loans", "loan"], ["operations", "op"]];
  const stateKey = Object.fromEntries(LISTS.map(([k, kind]) => [kind, k]));
  const recordKey = r => r.kind + ":" + r.id;
  const time = v => { const t = Date.parse(v); return Number.isFinite(t) ? t : -Infinity; };
  const stamp = v => typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : EPOCH;

  function toRecords(state) {
    const out = [];
    for (const [list, kind] of LISTS) for (const x of state[list] || []) {
      if (!x || typeof x.id !== "string") continue;
      out.push({kind, id: x.id, updatedAt: stamp(x.updatedAt), deleted: kind === "op" ? !!x.deleted : false, data: x});
    }
    return out;
  }

  function diff(prevState, nextState) {
    const prev = new Map(toRecords(prevState).map(r => [recordKey(r), r]));
    const out = [];
    for (const r of toRecords(nextState)) {
      const p = prev.get(recordKey(r));
      if (!p || p.deleted !== r.deleted || JSON.stringify(p.data) !== JSON.stringify(r.data)) out.push(r);
    }
    return out;
  }

  function putRecord(state, r) {
    const list = stateKey[r.kind];
    if (!list || !r.data || typeof r.data !== "object") return state;
    const arr = state[list] || [];
    const i = arr.findIndex(x => x.id === r.id);
    const data = r.kind === "op" ? {...r.data, deleted: !!r.deleted} : r.data;
    return {...state, [list]: i < 0 ? [...arr, data] : arr.map((x, j) => j === i ? data : x)};
  }
  // true — удалённая запись выигрывает у локальной (или локальной нет)
  function remoteWins(state, r, force) {
    const list = stateKey[r.kind];
    if (!list) return false;
    const local = (state[list] || []).find(x => x.id === r.id);
    if (!local) return true;
    if (force && force.has(recordKey(r))) return true;
    if (typeof local.updatedAt !== "string" || !Number.isFinite(Date.parse(local.updatedAt))) return true;
    return time(r.updatedAt) > time(local.updatedAt);
  }

  function applyRemote(state, records, force) {
    let next = state;
    const winners = [];
    for (const r of records || []) {
      if (!r || !stateKey[r.kind] || typeof r.id !== "string") continue;
      if (remoteWins(next, r, force)) { winners.push(r); next = putRecord(next, r); }
    }
    if (!winners.length) return {state, skipped: []};
    try { return {state: validate(next), skipped: []}; } catch (e) { /* ниже по одной */ }
    // порядок: счета и категории раньше остального, операции в конце
    const rank = k => k === "account" ? 0 : k === "category" ? 1 : k === "op" ? 3 : 2;
    const order = winners.map((r, i) => ({r, i})).sort((a, b) => rank(a.r.kind) - rank(b.r.kind) || a.i - b.i).map(x => x.r);
    let cur = state;
    const skipped = [];
    for (const r of order) {
      try { cur = validate(putRecord(cur, r)); } catch (e) { skipped.push({kind: r.kind, id: r.id}); }
    }
    return {state: cur, skipped};
  }

  // Первое подключение: объединение; пустой счёт main без операций заменяется серверным.
  function mergeFirst(local, remoteRecords) {
    const force = new Set();
    const main = (local.accounts || []).find(a => a.id === "main");
    const used = (local.operations || []).some(o => (o.legs || []).some(l => l.accountId === "main"));
    if (main && main.openingCents === 0 && !used && (remoteRecords || []).some(r => r.kind === "account" && r.id === "main")) force.add("account:main");
    return applyRemote(local, remoteRecords, force);
  }

  const api = {toRecords, recordKey, diff, applyRemote, mergeFirst};
  if (node) module.exports = api;
  else (root.MoneyCore = root.MoneyCore || {}).sync = api;
})(globalThis);
