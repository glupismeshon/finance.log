(function (root) {
  "use strict";
  const MAX_AMOUNT = 999999999999;
  function parseAmount(value, signed = false) {
    const clean = String(value).trim().replace(/[\s  ]/g, "").replace(",", ".");
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
  const api = {parseAmount, validDate, MAX_AMOUNT};
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else (root.MoneyCore = root.MoneyCore || {}).money = api;
})(globalThis);
