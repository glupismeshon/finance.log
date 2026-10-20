(function (root) {
  "use strict";
  const node = typeof module !== "undefined" && module.exports;
  const {validate, DEFAULT_CATEGORIES} = node ? require("./schema.js") : root.MoneyCore.schema;
  const find = (state, id) => {
    const c = state.categories.find(x => x.id === id);
    if (!c) throw new Error("Категория не найдена.");
    return c;
  };
  const put = (state, categories) => validate({...state, categories});
  function addCategory(state, {id, name, parentId = null, kind}) {
    if (typeof name !== "string" || !name.trim() || name.length > 100) throw new Error("Название категории — от 1 до 100 символов.");
    const order = state.categories.reduce((m, c) => Math.max(m, c.order), -1) + 1;
    return put(state, [...state.categories, {id, key: null, name: name.trim(), parentId: parentId ?? null, kind, archived: false, order}]);
  }
  function updateCategory(state, id, patch) {
    const old = find(state, id);
    const next = {...old};
    if (patch.name !== undefined) {
      if (typeof patch.name !== "string" || !patch.name.trim() || patch.name.length > 100) throw new Error("Название категории — от 1 до 100 символов.");
      next.name = patch.name.trim();
    }
    if (patch.parentId !== undefined) next.parentId = patch.parentId;
    if (patch.order !== undefined) next.order = patch.order;
    return put(state, state.categories.map(c => c.id === id ? next : c));
  }
  function archiveCategory(state, id, archived = true) {
    find(state, id);
    return put(state, state.categories.map(c => c.id === id ? {...c, archived: !!archived} : c));
  }
  function tree(state, kind) {
    const live = state.categories.filter(c => c.kind === kind && !c.archived).map((c, i) => ({c, i}))
      .sort((a, b) => a.c.order - b.c.order || a.i - b.i).map(x => x.c);
    return live.filter(c => c.parentId === null).map(cat => ({cat, children: live.filter(k => k.parentId === cat.id)}));
  }
  const api = {DEFAULT_CATEGORIES, addCategory, updateCategory, archiveCategory, tree};
  if (node) module.exports = api;
  else (root.MoneyCore = root.MoneyCore || {}).categories = api;
})(globalThis);
