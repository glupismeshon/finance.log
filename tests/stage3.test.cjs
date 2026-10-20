const {test} = require("node:test");
const assert = require("node:assert/strict");
const S = require("../dist/core/schema.js");
const J = require("../dist/core/journal.js");
const G = require("../dist/core/suggest.js");
const V = require("../dist/core/views.js");
const N = require("../dist/core/analytics.js");
const TODAY = "2026-10-20", NOW = "2026-10-21T09:00:00.000Z";
const add = (s, op) => J.upsertOperation(s, op, NOW);
const it = (id, name, qtyMilli, unit, amountCents, categoryId = null, kind = "item") => ({id, kind, name, qtyMilli, unit, amountCents, categoryId});
const disc = (id, a) => it(id, "", 1000, "pcs", a, null, "discount");
const fee = (id, a) => it(id, "", 1000, "pcs", a, null, "fee");
const receipt = (id, items, o = {}) => {
  const fb = o.fb === undefined ? "c-groceries" : o.fb;
  const total = items.reduce((t, i) => t + (i.kind === "discount" ? -i.amountCents : i.amountCents), 0);
  return {id, type: "expense", date: o.date || TODAY, note: "", createdAt: o.createdAt || NOW, updatedAt: NOW, deleted: false,
    legs: [{accountId: "main", amountCents: -total}], allocations: J.allocationsFromItems(items, fb), links: {}, revisions: [], items, ...(o.merchant ? {merchant: o.merchant} : {})};
};
const plain = (id, amount, o = {}) => ({id, type: o.type || "expense", date: o.date || TODAY, note: "", createdAt: NOW, updatedAt: NOW, deleted: !!o.deleted,
  legs: [{accountId: "main", amountCents: (o.type === "income" ? 1 : -1) * amount}], allocations: o.cat ? [{categoryId: o.cat, amountCents: amount}] : [], links: {}, revisions: [], ...(o.merchant ? {merchant: o.merchant} : {})});
const tz = {version: 2};
const TZ = [it("a", "Молоко", 2000, "pcs", 24000, "c-groceries_dairy"), it("b", "Курица", 1000, "kg", 42000, "c-groceries_meat"),
  it("c", "Макароны", 2000, "pack", 18000), it("d", "Шампиньоны", 400000, "g", 16000, "c-groceries_produce")];
const amt = (allocs, c) => (allocs.find(a => a.categoryId === c) || {}).amountCents;

test("чек из ТЗ: одна проводка, баланс один раз, allocations из позиций", () => {
  let s = S.empty(TODAY);
  s = add(s, receipt("r1", TZ));
  assert.equal(V.balances(s).total, -100000);
  const a = s.operations[0].allocations;
  assert.equal(a.length, 4);
  assert.equal(amt(a, "c-groceries_dairy"), 24000);
  assert.equal(amt(a, "c-groceries_meat"), 42000);
  assert.equal(amt(a, "c-groceries"), 18000);
  assert.equal(amt(a, "c-groceries_produce"), 16000);
  assert.equal(a[a.length - 1].categoryId, "c-groceries_produce");
  assert.equal(s.operations[0].items.length, 4);
});

test("скидка пропорционально, сумма сходится; fee в fallback", () => {
  const two = [it("a", "Мясо", 1000, "kg", 60000, "c-groceries_meat"), it("b", "Молоко", 1000, "l", 40000, "c-groceries_dairy")];
  const a = J.allocationsFromItems([...two, disc("d", 10000)], "c-groceries");
  assert.equal(amt(a, "c-groceries_meat"), 54000);
  assert.equal(amt(a, "c-groceries_dairy"), 36000);
  const three = ["c-groceries_meat", "c-groceries_dairy", "c-groceries_produce"].map((c, i) => it("i" + i, "т" + i, 1000, "pcs", 100, c));
  const b = J.allocationsFromItems([...three, disc("d", 1)], null);
  assert.equal(b.reduce((t, x) => t + x.amountCents, 0), 299);
  assert.deepEqual(b.map(x => x.amountCents).sort((x, y) => x - y), [99, 100, 100]);
  const c = J.allocationsFromItems([...two, fee("f", 15000)], "c-groceries");
  assert.equal(amt(c, "c-groceries"), 15000);
  assert.equal(c.reduce((t, x) => t + x.amountCents, 0), 115000);
  const d = J.allocationsFromItems([...two, fee("f", 500)], null);
  assert.equal(d[d.length - 1].categoryId, null);
  assert.equal(S.allocationsFromItems, J.allocationsFromItems);
  // чек со скидкой и fee проходит валидатор
  let s = add(S.empty(TODAY), receipt("r", [...two, disc("d", 10000), fee("f", 2000)]));
  assert.equal(V.balances(s).total, -92000);
});

test("валидатор отвергает неверные чеки", () => {
  const s = S.empty(TODAY);
  const ok = receipt("r", TZ);
  assert.doesNotThrow(() => S.validate({...s, operations: [ok]}));
  const bad = op => assert.throws(() => S.validate({...s, operations: [op]}));
  bad({...ok, legs: [{accountId: "main", amountCents: -99999}]});
  bad({...ok, type: "income", legs: [{accountId: "main", amountCents: 100000}], allocations: []});
  const withItem = patch => ({...ok, items: ok.items.map((x, i) => i === 0 ? {...x, ...patch} : x)});
  bad(withItem({qtyMilli: 0}));
  bad(withItem({amountCents: 0}));
  bad(withItem({amountCents: -5}));
  bad(withItem({unit: "oz"}));
  bad(withItem({name: " "}));
  bad(withItem({categoryId: "c-salary"}));
  bad({...ok, items: [...ok.items, {...ok.items[0]}]});
  bad({...ok, allocations: [{categoryId: null, amountCents: 100000}]});
  bad({...ok, allocations: ok.allocations.map((a, i) => i === 0 ? {...a, amountCents: a.amountCents + 1} : i === 1 ? {...a, amountCents: a.amountCents - 1} : a)});
  bad({...ok, items: []});
  bad({...ok, items: [...TZ, disc("x", 100)].map(x => x)});
  // чужие поля discount/fee
  bad({...receipt("q", [TZ[0], fee("f", 100)]), items: [TZ[0], {...fee("f", 100), qtyMilli: 2000}]});
});

test("suggest.items: префикс, цена за единицу, товары магазина выше", () => {
  let s = S.empty(TODAY);
  s = add(s, receipt("r1", [it("a", "Молоко", 1000, "pcs", 9000, "c-groceries_dairy"), it("b", "Хлеб", 1000, "pcs", 5000)], {merchant: "Пятёрочка", date: "2026-10-10"}));
  s = add(s, receipt("r2", [it("a", "молоко", 2000, "pcs", 20000, "c-groceries_dairy")], {merchant: "Пятёрочка", date: "2026-10-18"}));
  s = add(s, receipt("r3", [it("a", "Молоко козье", 1000, "pcs", 30000), it("b", "Молоко", 1000, "pcs", 1000)], {merchant: "Рынок", date: "2026-10-19"}));
  const r = G.items(s, "пятёрочка", "мол");
  assert.equal(r[0].name, "Молоко");
  assert.equal(r[0].count, 3);
  assert.equal(r[0].lastUnitPriceCents, 1000); // последняя покупка — у «Рынка», 19 окт
  assert.equal(r[0].lastQtyMilli, 1000);
  assert.equal(G.items(s, "Пятёрочка", "мол", 1)[0].lastAmountCents, 1000);
  assert.equal(r[1].categoryId, null);
  assert.equal(G.items(s, null, "хл")[0].lastUnitPriceCents, 5000);
  assert.equal(r.length, 2);
  assert.equal(r[1].name, "Молоко козье");
  assert.equal(G.items(s, "Пятёрочка", "").map(x => x.name)[2], "Молоко козье");
  assert.equal(G.items(s, null, "коз").length, 1);
  assert.equal(G.items(s, null, "хл")[0].name, "Хлеб");
  assert.equal(G.items(s, null, "").length, 3);
  assert.equal(G.itemKey("  Ёлка  Зелёная "), "елка зеленая");
  assert.equal(G.items(s, null, "", 1).length, 1);
  // г -> цена за кг
  assert.equal(G.unitPriceCents(it("d", "x", 400000, "g", 16000)), 40000);
});

test("правка чека: ревизия, allocations пересчитаны, баланс на разницу", () => {
  let s = add(S.empty(TODAY), receipt("r1", TZ));
  const items2 = TZ.map(x => x.id === "a" ? {...x, qtyMilli: 3000, amountCents: 36000} : x);
  s = add(s, {...receipt("r1", items2), createdAt: NOW});
  assert.equal(V.balances(s).total, -112000);
  assert.equal(s.operations[0].revisions.length, 1);
  assert.equal(s.operations[0].revisions[0].before.items[0].qtyMilli, 2000);
  assert.equal(amt(s.operations[0].allocations, "c-groceries_dairy"), 36000);
  // правка только количества без суммы тоже меняет содержимое
  const items3 = items2.map(x => x.id === "a" ? {...x, qtyMilli: 4000} : x);
  const s3 = add(s, receipt("r1", items3));
  assert.equal(s3.operations[0].revisions.length, 2);
  // повтор без изменений — без ревизии
  assert.equal(add(s, receipt("r1", items2)), s);
  // JSON-круг сохраняет items
  assert.deepEqual(S.migrate(JSON.parse(JSON.stringify(s)), TODAY).operations[0].items, s.operations[0].items);
});

// ---------- аналитика ----------
function fixture() {
  let s = S.empty("2026-01-01");
  s = add(s, plain("e1", 10000, {date: "2026-10-05", cat: "c-groceries_meat", merchant: "Пятёрочка"}));
  s = add(s, plain("e2", 30000, {date: "2026-10-06", cat: "c-transport"}));
  s = add(s, plain("e3", 5000, {date: "2026-10-12", cat: "c-groceries_dairy", merchant: "пятёрочка"}));
  s = add(s, plain("e4", 99999, {date: "2026-10-07", deleted: true}));
  s = add(s, plain("i1", 100000, {type: "income", date: "2026-10-05", cat: "c-salary"}));
  s = add(s, plain("p1", 20000, {date: "2026-09-10", cat: "c-transport"}));
  s = add(s, plain("p2", 10000, {date: "2026-09-20", cat: "c-groceries_meat"}));
  s = add(s, receipt("r1", [it("a", "Молоко", 1000, "pcs", 12000, "c-groceries_dairy"), it("b", "Хлеб", 1000, "pcs", 4000)], {date: "2026-10-01", merchant: "Лента"}));
  s = add(s, receipt("r2", [it("a", "молоко", 1000, "pcs", 15000, "c-groceries_dairy")], {date: "2026-10-15", merchant: "Лента"}));
  const t = J.makeTransfer({id: "t1", fromId: "main", toId: "main2", amountCents: 7777, date: "2026-10-08", now: NOW});
  s = {...s, accounts: [...s.accounts, {id: "main2", name: "B", kind: "cash", openingCents: 0, openingDate: "2026-01-01", archived: false}]};
  s = add(s, t);
  s = J.reconcile(s, "main", 12345, "2026-10-09", "", "adj1", NOW).state;
  return s;
}
const R = {from: "2026-10-01", to: "2026-10-31"};

test("daily: только живые доходы/расходы, фильтры", () => {
  const s = fixture();
  const d = N.daily(s, {...R, type: "expense"});
  assert.deepEqual(d, {"2026-10-01": 16000, "2026-10-05": 10000, "2026-10-06": 30000, "2026-10-12": 5000, "2026-10-15": 15000});
  assert.deepEqual(N.daily(s, {...R, type: "income"}), {"2026-10-05": 100000});
  const net = N.daily(s, {...R, type: "net"});
  assert.equal(net["2026-10-05"], 90000);
  assert.equal(net["2026-10-06"], -30000);
  assert.deepEqual(N.daily(s, {...R, accountId: "main2"}), {});
  assert.deepEqual(N.daily(s, {from: "2026-09-01", to: "2026-09-30"}), {"2026-09-10": 20000, "2026-09-20": 10000});
});

test("heatLevels: квантили ненулевых, большая покупка не гасит остальные", () => {
  assert.deepEqual(N.heatLevels([]), [0, 0, 0]);
  const t = N.heatLevels([0, 0, 100, 200, 300, 400, 500, 600, 700, 1000000]);
  assert.deepEqual(t, [200, 400, 600]);
  assert.equal(N.levelOf(0, t), 0);
  assert.equal(N.levelOf(200, t), 1);
  assert.equal(N.levelOf(300, t), 2);
  assert.equal(N.levelOf(600, t), 3);
  assert.equal(N.levelOf(1000000, t), 4);
  assert.deepEqual(N.heatLevels({a: 5, b: 0, c: 10}), [5, 5, 10]);
});

test("summary: период и предыдущий период, дельты", () => {
  const s = fixture();
  const m = N.summary(s, R);
  assert.equal(m.expense, 76000);
  assert.equal(m.income, 100000);
  assert.equal(m.net, 24000);
  assert.equal(m.days, 31);
  assert.equal(m.avgPerDay, Math.round(76000 / 31));
  assert.equal(m.ops, 5);
  assert.equal(m.avgCheck, 15200);
  assert.equal(m.prev.from, "2026-08-31");
  assert.equal(m.prev.to, "2026-09-30");
  assert.equal(m.prev.days, 31);
  assert.equal(m.prev.expense, 30000);
  const sep = N.summary(s, {from: "2026-09-01", to: "2026-09-30"});
  assert.equal(sep.expense, 30000);
  assert.equal(sep.prev.expense, 0);
  assert.equal(sep.delta.expense, null);
  const oct = N.summary(s, {from: "2026-10-01", to: "2026-10-30"});
  assert.equal(oct.prev.from, "2026-09-01");
  assert.equal(oct.prev.expense, 30000);
  assert.equal(oct.delta.expense, 153.3);
  assert.equal(oct.prev.days, 30);
});

test("byCategory: родители, доли, предыдущий период, дети", () => {
  const s = fixture();
  const r = N.byCategory(s, {from: "2026-10-01", to: "2026-10-30"});
  assert.deepEqual(r.map(x => x.id), ["c-groceries", "c-transport"]);
  const g = r.find(x => x.id === "c-groceries"), tr = r.find(x => x.id === "c-transport");
  assert.equal(g.cents, 46000);
  assert.equal(g.prevCents, 10000);
  assert.equal(g.delta, 360);
  assert.equal(tr.cents, 30000);
  assert.equal(tr.prevCents, 20000);
  assert.ok(Math.abs(r.reduce((t, x) => t + x.share, 0) - 1) < 1e-9);
  assert.ok(r[0].cents >= r[1].cents);
  assert.deepEqual(g.children.map(c => [c.id, c.cents]), [["c-groceries_dairy", 32000], ["c-groceries_meat", 10000]]);
  const leaf = N.byCategory(s, {...R, parent: false});
  assert.ok(leaf.find(x => x.id === "c-groceries_dairy"));
  assert.equal(leaf.find(x => x.id === "c-groceries").cents, 4000);
  assert.equal(leaf.find(x => x.id === "c-groceries_dairy").cents, 32000);
});

test("byMerchant / byItem / monthly / weekday", () => {
  const s = fixture();
  const mr = N.byMerchant(s, R);
  assert.deepEqual(mr.map(x => [x.merchant, x.cents, x.count, x.avgCheck, x.lastDate]), [["Лента", 31000, 2, 15500, "2026-10-15"], ["пятёрочка", 15000, 2, 7500, "2026-10-12"]]);
  assert.equal(N.byMerchant(s, {...R, limit: 1}).length, 1);
  const bi = N.byItem(s, R);
  assert.deepEqual(bi.map(x => x.name), ["молоко", "Хлеб"]);
  assert.equal(bi[0].cents, 27000);
  assert.equal(bi[0].count, 2);
  assert.equal(bi[0].qtyMilli, 2000);
  assert.equal(bi[0].firstUnitPrice, 12000);
  assert.equal(bi[0].lastUnitPrice, 15000);
  assert.equal(bi[0].priceDelta, 25);
  assert.equal(bi[1].priceDelta, null);
  assert.equal(N.byItem(s, {...R, sort: "count"})[0].name, "молоко");
  const mo = N.monthly(s, {months: 3, to: "2026-10-20"});
  assert.deepEqual(mo, [{month: "2026-08", expense: 0, income: 0}, {month: "2026-09", expense: 30000, income: 0}, {month: "2026-10", expense: 76000, income: 100000}]);
  assert.equal(N.monthly(s, {months: 12, to: "2026-02-10"})[0].month, "2025-03");
  const wd = N.weekday(s, R);
  assert.equal(wd.length, 7);
  // 2026-10-05 пн (10000), 10-12 пн (5000): пн в октябре 4 раза (5,12,19,26)
  assert.equal(wd[0].days, 4);
  assert.equal(wd[0].totalCents, 15000);
  assert.equal(wd[0].avgCents, 3750);
  assert.equal(wd[1].totalCents, 30000);
  assert.equal(wd[3].totalCents, 31000); // чт: 10-01 (16000) и 10-15 (15000)
});
