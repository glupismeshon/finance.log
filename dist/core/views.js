(function (root) {
  "use strict";
  const LIMIT = "Общая сумма превышает поддерживаемый предел.";
  const check = n => { if (!Number.isSafeInteger(n)) throw new Error(LIMIT); return n; };
  function balances(state, uptoDate) {
    const byAccount = {};
    for (const a of state.accounts) byAccount[a.id] = a.openingCents;
    for (const op of state.operations) {
      if (op.deleted || (uptoDate && op.date > uptoDate)) continue;
      for (const leg of op.legs) byAccount[leg.accountId] = check(byAccount[leg.accountId] + leg.amountCents);
    }
    let total = 0;
    for (const a of state.accounts) if (a.kind !== "loan" && a.kind !== "person") total = check(total + byAccount[a.id]);
    return {byAccount, total};
  }
  function totals(state) {
    let income = 0, expense = 0;
    for (const op of state.operations) {
      if (op.deleted) continue;
      const sum = op.legs.reduce((s, l) => s + l.amountCents, 0);
      if (op.type === "income") income = check(income + sum);
      else if (op.type === "expense") expense = check(expense + Math.abs(sum));
    }
    return {income, expense, balance: balances(state).total};
  }
  function accountTotals(state) {
    const {byAccount} = balances(state);
    const rows = list => list.map(account => ({account, balanceCents: byAccount[account.id]}));
    const sorted = state.accounts.map((a, i) => ({a, i})).sort((x, y) => (x.a.order ?? x.i) - (y.a.order ?? y.i) || x.a.name.localeCompare(y.a.name)).map(x => x.a);
    const result = rows(sorted.filter(a => !a.archived));
    result.archived = rows(sorted.filter(a => a.archived));
    return result;
  }
  function breakdown(state) {
    const {byAccount} = balances(state);
    const sums = {debit: 0, cash: 0, savings: 0, credit_card: 0, loan: 0, person: 0};
    const has = {credit_card: false, loan: false};
    for (const a of state.accounts) {
      if (a.kind in sums) sums[a.kind] = check(sums[a.kind] + byAccount[a.id]);
      if (a.kind in has) has[a.kind] = true;
    }
    const own = check(sums.debit + sums.cash), savings = sums.savings, creditCards = sums.credit_card, loans = sums.loan;
    return {
      own, savings, creditCards, loans, other: sums.person, hasCards: has.credit_card, hasLoans: has.loan,
      views: {
        all: check(own + savings + creditCards + loans),
        noLoans: check(own + savings + creditCards),
        noCards: check(own + savings + loans),
        ownOnly: check(own + savings)
      }
    };
  }
  function spending(state, {from, to, type = "expense", by = "category", accountId} = {}) {
    const parent = new Map((state.categories || []).map(c => [c.id, c.parentId]));
    const sums = new Map();
    for (const op of state.operations) {
      if (op.deleted || op.type !== type || (from && op.date < from) || (to && op.date > to)) continue;
      const leg = op.legs[0];
      if (accountId && leg.accountId !== accountId) continue;
      const parts = op.allocations.length ? op.allocations : [{categoryId: null, amountCents: Math.abs(leg.amountCents)}];
      for (const a of parts) {
        let id;
        if (by === "merchant") id = op.merchant || null;
        else id = a.categoryId === null ? null : by === "parent" ? (parent.get(a.categoryId) ?? a.categoryId) : a.categoryId;
        sums.set(id, check((sums.get(id) || 0) + a.amountCents));
      }
    }
    return [...sums].map(([id, cents]) => by === "merchant" ? {merchant: id, cents} : {id, cents}).sort((a, b) => b.cents - a.cents);
  }
  const api = {balances, totals, accountTotals, breakdown, spending};
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else (root.MoneyCore = root.MoneyCore || {}).views = api;
})(globalThis);
