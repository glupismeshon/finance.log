(function (root) {
  "use strict";
  const LIMIT = "Общая сумма превышает поддерживаемый предел.";
  const check = n => { if (!Number.isSafeInteger(n)) throw new Error(LIMIT); return n; };
  function balances(state) {
    const byAccount = {};
    for (const a of state.accounts) byAccount[a.id] = a.openingCents;
    for (const op of state.operations) {
      if (op.deleted) continue;
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
  const api = {balances, totals};
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else (root.MoneyCore = root.MoneyCore || {}).views = api;
})(globalThis);
