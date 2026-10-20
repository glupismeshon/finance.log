const {test} = require("node:test");
const assert = require("node:assert/strict");
const S = require("../dist/core/schema.js");
const C = require("../dist/core/categories.js");
const J = require("../dist/core/journal.js");
const A = require("../dist/core/accounts.js");
const G = require("../dist/core/suggest.js");
const V = require("../dist/core/views.js");
const TODAY = "2026-10-20", NOW = "2026-10-21T09:00:00.000Z";
const mkOp = (id, amount, o = {}) => ({id, type: "expense", date: TODAY, note: "", createdAt: NOW, updatedAt: NOW, deleted: false,
  legs: [{accountId: o.acc || "main", amountCents: -amount}], allocations: [{categoryId: o.cat ?? null, amountCents: amount}], links: {}, revisions: [], ...(o.merchant ? {merchant: o.merchant} : {}), ...(o.date ? {date: o.date} : {}), ...(o.createdAt ? {createdAt: o.createdAt} : {})});
const add = (s, op) => J.upsertOperation(s, op, NOW);
const withCats = (s, categories) => ({...s, categories});

test("empty() и migrate содержат стандартные категории; старые расходы без категории валидны", () => {
  const s = S.empty(TODAY);
  assert.ok(s.categories.find(c => c.id === "c-groceries_meat" && c.parentId === "c-groceries" && c.key === "groceries_meat" && c.name === null));
  assert.equal(s.categories.length, S.DEFAULT_CATEGORIES.length);
  assert.equal(s.categories.filter(c => c.kind === "income").length, 5);
  const v1 = {version: 1, openingCents: 0, entries: [{id: "e1", type: "expense", amountCents: 100, date: TODAY, note: "", createdAt: NOW, deleted: false}]};
  const m = S.migrate(v1, TODAY);
  assert.equal(m.categories.length, S.DEFAULT_CATEGORIES.length);
  assert.equal(m.operations[0].allocations[0].categoryId, null);
  const v2 = S.migrate({...S.empty(TODAY), categories: []}, TODAY);
  assert.equal(v2.categories.length, S.DEFAULT_CATEGORIES.length);
  const custom = [{id: "x", key: null, name: "Моя", parentId: null, kind: "expense", archived: false, order: 0}];
  assert.deepEqual(S.migrate(withCats(S.empty(TODAY), custom), TODAY).categories, custom);
});

test("Валидатор отвергает неверные категории", () => {
  const s = S.empty(TODAY);
  const inc = {...mkOp("i1", 100, {cat: "c-groceries"}), type: "income", legs: [{accountId: "main", amountCents: 100}]};
  assert.throws(() => S.validate({...s, operations: [inc]}));
  assert.doesNotThrow(() => S.validate({...s, operations: [{...inc, allocations: [{categoryId: "c-salary", amountCents: 100}]}]}));
  assert.doesNotThrow(() => S.validate({...s, operations: [{...inc, allocations: []}]}));
  assert.throws(() => S.validate({...s, operations: [mkOp("e1", 100, {cat: "c-salary"})]}));
  assert.throws(() => S.validate({...s, operations: [mkOp("e1", 100, {cat: "nope"})]}));
  const base = {id: "n", key: null, name: "N", archived: false, order: 99};
  assert.throws(() => S.validate(withCats(s, [...s.categories, {...base, parentId: "c-groceries_meat", kind: "expense"}])), /категор/);
  assert.throws(() => S.validate(withCats(s, [...s.categories, {...base, parentId: "c-salary", kind: "expense"}])));
  assert.throws(() => S.validate(withCats(s, [...s.categories, {...base, name: null, key: null, parentId: null, kind: "expense"}])));
  assert.throws(() => S.validate(withCats(s, [...s.categories, {...s.categories[0]}])));
  assert.throws(() => C.addCategory(s, {id: "z", name: "Z", parentId: "c-groceries_meat", kind: "expense"}));
  assert.throws(() => C.addCategory(s, {id: "z", name: "Z", parentId: "c-salary", kind: "expense"}));
  assert.doesNotThrow(() => C.addCategory(s, {id: "z", name: " Z ", parentId: "c-groceries", kind: "expense"}));
});

test("merchant: нормализуется, лимит 80, пустой убирается", () => {
  const s = S.empty(TODAY);
  const ok = S.validate({...s, operations: [{...mkOp("a", 5), merchant: "  Пятёрочка  "}, {...mkOp("b", 5), merchant: "   "}]});
  assert.equal(ok.operations[0].merchant, "Пятёрочка");
  assert.equal("merchant" in ok.operations[1], false);
  assert.throws(() => S.validate({...s, operations: [{...mkOp("a", 5), merchant: "x".repeat(81)}]}));
  assert.equal(G.merchantKey("  ПЯТЁРОЧКА   Экспресс "), "пятерочка экспресс");
});

test("Подсказки: один merchant, forMerchant, префиксы", () => {
  let s = S.empty(TODAY);
  s = A.addAccount(s, {id: "tb", name: "Т-Банк", kind: "debit", openingCents: 0, openingDate: "2026-01-01"});
  s = add(s, mkOp("1", 100, {merchant: "Пятёрочка", cat: "c-groceries", acc: "tb", date: "2026-10-01"}));
  s = add(s, mkOp("2", 200, {merchant: "пятерочка", cat: "c-groceries_meat", acc: "tb", date: "2026-10-05"}));
  s = add(s, mkOp("3", 300, {merchant: "ПЯТЁРОЧКА", cat: "c-groceries_dairy", acc: "main", date: "2026-10-10"}));
  s = add(s, mkOp("4", 50, {merchant: "ВкусВилл Экспресс", cat: "c-groceries", date: "2026-10-11"}));
  assert.deepEqual(G.merchants(s, "expense", ""), ["ПЯТЁРОЧКА", "ВкусВилл Экспресс"]);
  assert.deepEqual(G.merchants(s, "expense", "пят"), ["ПЯТЁРОЧКА"]);
  assert.deepEqual(G.merchants(s, "expense", "экс"), ["ВкусВилл Экспресс"]);
  assert.deepEqual(G.merchants(s, "income", ""), []);
  assert.deepEqual(G.forMerchant(s, "expense", "пятерочка"), {categoryId: "c-groceries_dairy", accountId: "tb", lastAmountCents: 300, lastDate: "2026-10-10"});
  assert.equal(G.forMerchant(s, "expense", "Магнит"), null);
  s = J.setDeleted(s, "3", true);
  assert.equal(G.forMerchant(s, "expense", "Пятёрочка").categoryId, "c-groceries_meat");
  assert.deepEqual(G.recentCategories(s, "expense", 6, TODAY).sort(), ["c-groceries", "c-groceries_meat"]);
  assert.equal(G.recentCategories(s, "expense", 1, TODAY).length, 1);
  assert.deepEqual(G.recentCategories(s, "expense", 6, "2027-06-01"), []);
});

test("spending: by parent сворачивает подкатегории; category, merchant, фильтры", () => {
  let s = S.empty(TODAY);
  s = add(s, mkOp("1", 1000, {cat: "c-groceries_meat", merchant: "A"}));
  s = add(s, mkOp("2", 500, {cat: "c-groceries", merchant: "A"}));
  s = add(s, mkOp("3", 700));
  s = add(s, mkOp("4", 100, {cat: "c-transport", date: "2026-09-01"}));
  assert.deepEqual(V.spending(s, {by: "parent"}), [{id: "c-groceries", cents: 1500}, {id: null, cents: 700}, {id: "c-transport", cents: 100}]);
  assert.deepEqual(V.spending(s, {by: "category", from: "2026-10-01", to: "2026-10-31"}), [{id: "c-groceries_meat", cents: 1000}, {id: null, cents: 700}, {id: "c-groceries", cents: 500}]);
  assert.deepEqual(V.spending(s, {by: "merchant", from: "2026-10-01"}), [{merchant: "A", cents: 1500}, {merchant: null, cents: 700}]);
  assert.deepEqual(V.spending(s, {by: "parent", accountId: "nope"}), []);
});

test("archiveCategory скрывает из tree, операции остаются валидными", () => {
  let s = S.empty(TODAY);
  s = add(s, mkOp("1", 100, {cat: "c-transport"}));
  s = C.archiveCategory(s, "c-transport");
  assert.ok(!C.tree(s, "expense").some(n => n.cat.id === "c-transport"));
  assert.doesNotThrow(() => S.validate(s));
  s = C.archiveCategory(s, "c-groceries_meat");
  assert.equal(C.tree(s, "expense")[0].children.length, 3);
  assert.equal(C.tree(s, "income").length, 5);
  s = C.archiveCategory(s, "c-transport", false);
  assert.ok(C.tree(s, "expense").some(n => n.cat.id === "c-transport"));
});

test("Переименование стандартной ставит name и оставляет key; изменение merchant даёт ревизию", () => {
  let s = C.updateCategory(S.empty(TODAY), "c-fun", {name: " Досуг "});
  const c = s.categories.find(x => x.id === "c-fun");
  assert.equal(c.name, "Досуг");
  assert.equal(c.key, "fun");
  s = add(s, mkOp("1", 100, {merchant: "A"}));
  s = add(s, {...s.operations[0], merchant: "B"});
  assert.equal(s.operations[0].revisions.length, 1);
});
test("Импорт копии переносит пользовательские категории", () => {
  const S = require("../dist/core/schema.js"), J = require("../dist/core/journal.js"), C = require("../dist/core/categories.js");
  const d = "2026-10-20", now = "2026-10-20T10:00:00.000Z";
  let src = S.empty(d);
  src = C.addCategory(src, {id: "my-cat", name: "Кошка", parentId: null, kind: "expense"});
  src = J.upsertOperation(src, {id: "op1", type: "expense", date: d, note: "", deleted: false, legs: [{accountId: "main", amountCents: -500}], allocations: [{categoryId: "my-cat", amountCents: 500}]}, now);
  const {state, added} = J.merge(S.empty(d), JSON.parse(JSON.stringify(src)), d);
  assert.equal(added, 1);
  assert.ok(state.categories.some(c => c.id === "my-cat"));
});
