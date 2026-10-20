"use strict";
(() => {
  const {money: M, schema, journal, views, accounts: acct, categories: cats, suggest, analytics: A, i18n: I, boot} = globalThis.MoneyCore;
  const t = I.t, tp = I.tp;
  const newId = () => {
    if (crypto.randomUUID) return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16)); b[6] = b[6] & 15 | 64; b[8] = b[8] & 63 | 128;
    const h = [...b].map(x => x.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
  };
  const KEY = "money.log.ledger.v2", KEY_V1 = "money.log.ledger.v1";
  const $ = id => document.getElementById(id);
  let state = schema.empty(todayISO()), mode = "expense", filter = "all", trash = false, editing = null, pendingImport = null, locked = false;
  let undoId = null, tab = "journal", currentAccount = null, showArchived = false, accountEditing = null, reconAccount = null, activeSheet = null;
  let selCat = null, catTouched = false, accTouched = false, catFilter = "all", catKind = "expense", showCatArchived = false, categoryEditing = null;
  let receipt = {open: false, manual: false, rows: []};
  let dayFilter = null, anFresh = true;
  let settings = boot.get();
  I.setLang(I.resolve(settings.lang));
  const mobileQuery = window.matchMedia("(max-width: 599px)");
  const isMobile = () => mobileQuery.matches;
  function todayISO() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  }
  const today = todayISO;
  const accById = id => state.accounts.find(a => a.id === id);
  const accName = id => { const a = accById(id); return a ? I.stored(a.name) : "?"; };
  const accLabel = a => a.archived ? t("acc.withArchive", {name: I.stored(a.name)}) : I.stored(a.name);
  const firstActive = () => (acct.activeAccounts(state)[0] || state.accounts[0]).id;
  const amountOf = op => Math.abs(op.legs[0].amountCents);
  const catById = id => state.categories.find(c => c.id === id);
  const catName = c => c.name || t("cat." + c.key);
  const catPath = c => { const p = c.parentId && catById(c.parentId); return p ? `${catName(p)}/${catName(c)}` : catName(c); };
  // категория операции: у чека с несколькими категориями — самая крупная
  const opCat = op => {
    let best = null;
    for (const a of op.allocations) if (!best || a.amountCents > best.amountCents) best = a;
    return best && best.categoryId ? catById(best.categoryId) : null;
  };
  const money = cents => I.fmtMoney(cents);
  const signed = cents => (cents > 0 ? "+" : "") + money(cents);
  const amountInput = cents => { const v = (cents / 100).toFixed(2); return I.getLang() === "ru" ? v.replace(".", ",") : v; };
  const dateLabel = value => I.fmtDate(value);
  function storageError(message) { $("storage-error").textContent = message; $("storage-error").hidden = false; }
  try {
    const raw = localStorage.getItem(KEY), legacy = raw === null ? localStorage.getItem(KEY_V1) : null;
    if (raw !== null) state = schema.migrate(JSON.parse(raw), today());
    else if (legacy !== null) {
      state = schema.migrate(JSON.parse(legacy), today());
      try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {}
    }
  } catch {
    locked = true;
    storageError(t("err.read"));
  }
  function commit(next) {
    if (locked) throw new Error(t("err.locked"));
    const checked = schema.validate(next);
    try { localStorage.setItem(KEY, JSON.stringify(checked)); }
    catch { throw new Error(t("err.saveFail")); }
    const prev = state;
    state = checked;
    if (sync.userId) {
      const changed = SY.diff(prev, checked);
      if (changed.length) { notePending(changed); saveSync(); scheduleSync(); renderIndicator(); }
    }
    render();
  }
  function toast(text, id = null) {
    $("toast-message").textContent = text;
    $("toast").hidden = false;
    undoId = id;
    $("undo-button").hidden = !id;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { $("toast").hidden = true; undoId = null; }, id ? 6000 : 2500);
  }
  let toastTimer = null;
  const opFrom = op => (op.legs.find(l => l.amountCents < 0) || op.legs[0]).accountId;
  const opTo = op => (op.legs.find(l => l.amountCents > 0) || op.legs[1] || op.legs[0]).accountId;
  const editingOp = () => editing ? state.operations.find(o => o.id === editing) : null;
  function lastAccounts(type) {
    const active = new Set(acct.activeAccounts(state).map(a => a.id));
    const op = state.operations.filter(o => !o.deleted && o.type === type)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).find(o => o.legs.every(l => active.has(l.accountId)));
    if (!op) return {};
    return type === "transfer" ? {from: opFrom(op), to: opTo(op)} : {from: op.legs[0].accountId};
  }
  function fillSelect(select, list, value) {
    select.replaceChildren(...list.map(a => { const o = document.createElement("option"); o.value = a.id; o.textContent = accLabel(a); return o; }));
    if (value && list.some(a => a.id === value)) select.value = value;
  }
  function fillAccountSelects(from, to) {
    const list = acct.activeAccounts(state).slice();
    for (const id of [from, to, ...(editingOp()?.legs.map(l => l.accountId) || [])]) {
      const a = id && accById(id);
      if (a && !list.includes(a)) list.push(a);
    }
    fillSelect($("account"), list, from);
    fillSelect($("account-to"), list, to);
    ensureDistinct(false);
    return list;
  }
  function ensureDistinct(changedFrom) {
    if (mode !== "transfer" || $("account").value !== $("account-to").value) return;
    const select = changedFrom ? $("account-to") : $("account");
    const other = [...select.options].find(o => o.value !== (changedFrom ? $("account").value : $("account-to").value));
    if (other) select.value = other.value;
  }
  // pick: "default" — счета по умолчанию, "keep" — оставить выбранные, {from,to} — явно
  function setMode(type, pick = "keep") {
    const active = acct.activeAccounts(state);
    const canTransfer = active.length >= 2 || editingOp()?.type === "transfer";
    if (type === "transfer" && !canTransfer) type = "expense";
    mode = type;
    $("transfer-switch").hidden = !canTransfer;
    $("add-transfer").hidden = !canTransfer;
    document.querySelectorAll("[data-type]").forEach(b => {
      b.classList.toggle("selected", b.dataset.type === type);
      b.setAttribute("aria-pressed", String(b.dataset.type === type));
    });
    let from, to;
    if (pick === "keep") { from = $("account").value; to = $("account-to").value; }
    else if (pick === "default") {
      const last = lastAccounts(type);
      from = last.from && active.some(a => a.id === last.from) ? last.from : active[0]?.id;
      to = last.to && last.to !== from && active.some(a => a.id === last.to) ? last.to : active.find(a => a.id !== from)?.id;
    } else ({from, to} = pick);
    const list = fillAccountSelects(from, to);
    $("account-field").hidden = type !== "transfer" && list.length <= 1;
    $("to-field").hidden = type !== "transfer";
    $("fee-field").hidden = type !== "transfer" || !!editing;
    $("account-select-label").textContent = t(type === "income" ? "form.to" : "form.from");
    $("save-button").firstElementChild.textContent = isMobile() ? t("form.submitShort") : editing ? t("form.saveChanges") : t(`form.submit.${type}`);
    $("form-title").textContent = editing ? t(isMobile() ? "form.editShort" : "form.edit") : isMobile() ? t(`form.mobile.${type}`) : t("form.new");
    $("note").placeholder = t(`form.notePh.${type}`);
    const plain = type !== "transfer";
    $("merchant-field").hidden = !plain; $("category-field").hidden = !plain;
    if (plain) {
      $("merchant-label").textContent = t(`form.merchant.${type}`);
      $("merchant").placeholder = t(`form.merchantPh.${type}`);
    }
    const sc = selCat && catById(selCat);
    if (!plain || (sc && sc.kind !== type)) selCat = null;
    syncReceipt();
    renderFormSuggest();
  }
  // ---------- подсказки в форме: где / категория ----------
  function renderFormSuggest() {
    const type = mode;
    refreshRowCats();
    if (type === "transfer") { $("amount-hint").hidden = true; return; }
    // чипы магазинов
    const text = $("merchant").value, key = suggest.merchantKey(text);
    const names = suggest.merchants(state, type, text, 6).filter(n => suggest.merchantKey(n) !== key);
    $("merchant-chips").replaceChildren(...names.map(n => chip(n, false, () => { $("merchant").value = n; applyMerchantHint(true); renderFormSuggest(); })));
    // чипы категорий
    const ids = suggest.recentCategories(state, type, 6, today()).filter(id => { const c = catById(id); return c && c.kind === type; });
    if (selCat && !ids.includes(selCat)) ids.unshift(selCat);
    $("category-chips").replaceChildren(...ids.map(id => chip(catPath(catById(id)), id === selCat, () => { selCat = selCat === id ? null : id; catTouched = true; renderFormSuggest(); })));
    if (!$("category-tree").hidden) renderCategoryTree();
    // подсказка суммы
    const hint = text.trim() ? suggest.forMerchant(state, type, text) : null;
    $("amount-hint").hidden = !hint;
    if (hint) $("amount-hint").textContent = t("form.lastAmount", {sum: money(hint.lastAmountCents)});
  }
  function chip(text, selected, onClick) {
    const b = node("button", `chip${selected ? " selected" : ""}`, text); b.type = "button";
    b.setAttribute("aria-pressed", String(selected));
    b.addEventListener("click", onClick);
    return b;
  }
  function renderCategoryTree() {
    const box = $("category-tree"), rows = [];
    const item = (c, child) => {
      const b = node("button", `tree-item${child ? " child" : ""}${c.id === selCat ? " selected" : ""}`, (child ? "└ " : "") + catName(c)); b.type = "button";
      b.addEventListener("click", () => { selCat = c.id; catTouched = true; toggleCategoryTree(false); renderFormSuggest(); });
      return b;
    };
    const none = node("button", `tree-item${selCat === null ? " selected" : ""}`, t("form.categoryNone")); none.type = "button";
    none.addEventListener("click", () => { selCat = null; catTouched = true; toggleCategoryTree(false); renderFormSuggest(); });
    rows.push(none);
    for (const {cat, children} of cats.tree(state, mode)) { rows.push(item(cat, false)); children.forEach(k => rows.push(item(k, true))); }
    const cur = selCat && catById(selCat);
    if (cur && cur.archived) rows.push(item(cur, !!cur.parentId));
    box.replaceChildren(...rows);
  }
  function toggleCategoryTree(open) {
    $("category-tree").hidden = !open;
    $("category-all").setAttribute("aria-expanded", String(open));
    if (open) renderCategoryTree();
  }
  // подставить категорию и счёт по магазину (если пользователь их ещё не трогал)
  function applyMerchantHint(force) {
    const type = mode, text = $("merchant").value;
    const h = text.trim() ? suggest.forMerchant(state, type, text) : null;
    if (!h) return;
    if (!catTouched) {
      const c = h.categoryId && catById(h.categoryId);
      if (c && c.kind === type) selCat = c.id;
    }
    if (!accTouched && acct.activeAccounts(state).some(a => a.id === h.accountId)) $("account").value = h.accountId;
  }
  // ---------- календарь ----------
  const DP = globalThis.MoneyCore.datepicker;
  const heatForCalendar = () => { const vals = A.daily(state, {type: "expense"}); return {vals, th: A.heatLevels(vals)}; };
  const dps = {};
  document.querySelectorAll(".dp").forEach(host => {
    const id = host.querySelector("input").id;
    dps[id === "account-date" ? "account" : id === "recon-date" ? "recon" : "date"] = DP.create(host, {
      heat: heatForCalendar,
      // на телефоне после выбора возвращаем строку «// дата: …» вместо открытого поля
      onClose: () => { if (id === "date" && isMobile()) $("entry-form").classList.remove("date-open"); }
    });
  });
  function resetForm(focus = false) {
    editing = null;
    $("entry-form").reset();
    resetReceipt();
    selCat = null; catTouched = false; accTouched = false;
    toggleCategoryTree(false);
    $("date").value = today();
    $("date").max = today();
    $("form-error").textContent = "";
    $("cancel-edit").hidden = true;
    $("delete-entry").hidden = true;
    $("entry-form").classList.remove("date-open");
    DP.closeAll();
    updateDateSummary();
    setMode(mode, "default");
    if (focus) $("amount").focus();
  }
  function edit(entry) {
    editing = entry.id;
    $("amount").value = amountInput(amountOf(entry));
    $("date").value = entry.date;
    $("note").value = entry.note;
    $("fee").value = "";
    $("merchant").value = entry.merchant || "";
    const ec = opCat(entry);
    selCat = ec ? ec.id : null; catTouched = true; accTouched = true;
    if (entry.items) { selCat = receiptFallback(entry); loadReceipt(entry); } else resetReceipt();
    toggleCategoryTree(false);
    $("cancel-edit").hidden = false;
    $("delete-entry").hidden = false;
    $("form-error").textContent = "";
    $("entry-form").classList.remove("date-open");
    DP.closeAll();
    updateDateSummary();
    setMode(entry.type, entry.type === "transfer" ? {from: opFrom(entry), to: opTo(entry)} : {from: entry.legs[0].accountId});
    openSheet();
    $("amount").focus();
    if (!isMobile()) $("entry-form").scrollIntoView({block:"nearest",behavior:"smooth"});
  }
  function updateDateSummary() {
    const value = $("date").value;
    $("date-summary").textContent = !value || value === today() ? t("form.today") : M.validDate(value) ? dateLabel(value) : value;
  }
  function openSheet(box = $("entry-box")) {
    if (box.id === "entry-box" && !isMobile()) return;
    activeSheet = box;
    box.classList.add("open");
    $("sheet-backdrop").hidden = false;
    document.body.classList.add("sheet-open");
  }
  function closeSheet() {
    DP.closeAll();
    document.querySelectorAll("#entry-box, .sheet-form").forEach(b => b.classList.remove("open"));
    activeSheet = null;
    $("sheet-backdrop").hidden = true;
    document.body.classList.remove("sheet-open");
  }
  function dismissSheet() { resetForm(); closeSheet(); }
  function dismissAny() { if (!activeSheet || activeSheet.id === "entry-box") dismissSheet(); else closeSheet(); }
  function softDelete(entry) {
    try {
      commit(journal.setDeleted(state,entry.id,true));
      if(editing === entry.id) dismissSheet();
      toast(t("msg.deleted"),entry.id);
    } catch(e){toast(I.err(e));}
  }
  function startNew(type) {
    if (type) mode = type;
    resetForm();
    openSheet();
    $("amount").focus();
  }
  const node = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  function effectiveAccount() {
    if (tab === "accounts" && currentAccount) return currentAccount;
    if (isMobile()) return "all";
    return $("account-filter").value;
  }
  function catMatch(entry) {
    if (catFilter === "all") return true;
    return entry.allocations.some(a => { const c = a.categoryId && catById(a.categoryId); return !!c && (c.id === catFilter || c.parentId === catFilter); });
  }
  function renderEntries() {
    const query = $("search").value.trim().toLocaleLowerCase(I.locale());
    const accFilter = effectiveAccount(), onAcc = accFilter !== "all";
    const entries = state.operations.filter(e => e.deleted === trash && (filter === "all" || e.type === filter) && (!onAcc || e.legs.some(l => l.accountId === accFilter)) && catMatch(e) && (!dayFilter || e.date === dayFilter) &&
      (!query || `${I.stored(e.note)} ${e.merchant || ""} ${opCat(e) ? catPath(opCat(e)) : ""} ${amountInput(amountOf(e))} ${(e.items || []).map(i => i.name).join(" ")} ${e.legs.map(l => accName(l.accountId)).join(" ")}`.toLocaleLowerCase(I.locale()).includes(query)))
      .sort((a,b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    $("entry-count").textContent = tp("journal.count", entries.length);
    const container = $("entries"); container.replaceChildren();
    if (!entries.length) {
      const empty = node("div","empty-state");
      const filtered = query || filter !== "all" || catFilter !== "all" || dayFilter;
      const line = (tag, cls, text) => { const p = node("div"); p.append(node("span",`tag ${cls}`,tag),document.createTextNode(text)); return p; };
      empty.append(node("div","prompt","finance.log"));
      if (filtered) {
        empty.append(line("[--]","warn",t("empty.notFound")),node("div","muted",t("empty.notFoundHint")));
      } else if (trash) {
        empty.append(line("[ok]","ok",t("empty.trash")),node("div","muted",t("empty.trashHint")));
      } else if (onAcc) {
        empty.append(line("[ok]","ok",t("empty.acc")));
      } else {
        empty.append(line("[ok]","ok",t("empty.loaded")),line("[ok]","ok",t("empty.none")));
        const button = node("button","btn primary",t("empty.first")); button.type = "button";
        button.addEventListener("click",()=>startNew()); empty.append(button);
      }
      container.append(empty); return;
    }
    let lastDate = "";
    for (const entry of entries) {
      if (entry.date !== lastDate) {
        if (lastDate !== "") container.append(node("div","ovdiv"));
        lastDate = entry.date;
        container.append(node("div","shead",entry.date === today() ? `${t("date.today")} · ${dateLabel(entry.date)}` : dateLabel(entry.date)));
      }
      const row = node("article","todo"); row.dataset.id = entry.id;
      const route = entry.type === "transfer" ? `${accName(opFrom(entry))} → ${accName(opTo(entry))}` : "";
      const label = t(`type.${entry.type}`), noteText = I.stored(entry.note);
      const accText = entry.type === "transfer" ? (noteText ? route : "") : accName(entry.legs[0].accountId);
      const cat = opCat(entry), merchantText = entry.merchant || "";
      const title = entry.type === "transfer" ? noteText || route : merchantText || noteText || (cat ? catPath(cat) : label);
      const sign = entry.legs[0].amountCents > 0 ? "+" : "−";
      row.append(node("span",`mark ${entry.type}`,{income: "[+]", expense: "[-]", transfer: "[⇄]", adjustment: "[~]"}[entry.type]));
      row.append(node("span","ttitle",title));
      const viewLeg = onAcc && entry.type === "transfer" ? entry.legs.find(l => l.accountId === accFilter) : null;
      const transferText = viewLeg ? `${viewLeg.amountCents > 0 ? "+" : "−"}${money(amountOf(entry))}` : money(amountOf(entry));
      row.append(node("span",`tamount ${entry.type}`,entry.type === "transfer" ? transferText : `${sign}${money(amountOf(entry))}`));
      if (merchantText && noteText) row.append(node("div","tnote",noteText));
      const meta = node("div","tmeta");
      const metaText = node("span","tmeta-text");
      const itemsN = entry.items ? entry.items.filter(i => i.kind === "item").length : 0;
      const posText = itemsN ? tp("receipt.positions", itemsN) : "";
      if (cat) {
        if (posText) metaText.append(document.createTextNode(posText + " · "));
        const link = node("button","bracket cat-link",catPath(cat)); link.type = "button";
        link.setAttribute("aria-label",t("filter.catTap",{name: catPath(cat)}));
        link.addEventListener("click",ev=>{ ev.stopPropagation(); setCatFilter(cat.id); });
        metaText.append(link,document.createTextNode([accText,trash ? t("row.deleted") : ""].filter(Boolean).map(x=>" · "+x).join("")));
      } else metaText.textContent = [posText,label,accText,trash ? t("row.deleted") : ""].filter(Boolean).join(" · ");
      meta.append(metaText);
      const actions = node("span","row-actions");
      if (trash) {
        const restore = node("button","bracket",t("row.restore"));
        restore.setAttribute("aria-label",t("row.restoreAria",{name: noteText || label}));
        restore.addEventListener("click",()=>{try{commit(journal.setDeleted(state,entry.id,false));toast(t("msg.restored"));}catch(e){toast(I.err(e));}});
        actions.append(restore);
      } else {
        const canEdit = entry.type !== "adjustment";
        if (canEdit) {
          const change = node("button","bracket",t("common.edit"));
          change.setAttribute("aria-label",t("row.editAria",{name: noteText || label}));
          change.addEventListener("click",()=>edit(entry));
          actions.append(change);
          row.addEventListener("click",()=>{ if (isMobile()) edit(entry); });
        } else row.classList.add("no-edit");
        const remove = node("button","bracket",t("row.remove"));
        remove.setAttribute("aria-label",t("row.removeAria",{name: noteText || label}));
        remove.addEventListener("click",()=>softDelete(entry));
        actions.append(remove);
      }
      meta.append(actions); row.append(meta); container.append(row);
    }
  }
  function setCatFilter(value) {
    catFilter = value;
    $("category-filter").value = value;
    renderEntries();
    renderCatBar();
  }
  function renderCatBar() {
    const c = catFilter !== "all" && catById(catFilter);
    if (catFilter !== "all" && !c) catFilter = "all";
    $("cat-bar").hidden = !c;
    if (c) $("cat-bar-text").textContent = t("filter.catBar",{name: catPath(c)});
  }
  function fillCategoryFilter() {
    const select = $("category-filter");
    const opts = [["all",t("filter.catAll")]];
    for (const kind of ["expense","income"]) for (const {cat, children} of cats.tree(state,kind)) {
      opts.push([cat.id,catName(cat)]);
      children.forEach(k => opts.push([k.id,"\u00A0\u00A0└ "+catName(k)]));
    }
    const cur = catFilter !== "all" && catById(catFilter);
    if (cur && !opts.some(o => o[0] === cur.id)) opts.push([cur.id,catPath(cur)]);
    select.replaceChildren(...opts.map(([v,label]) => { const o = document.createElement("option"); o.value = v; o.textContent = label; return o; }));
    select.value = opts.some(o => o[0] === catFilter) ? catFilter : "all";
    renderCatBar();
  }
  function bigMoney(el, cents) {
    const p = I.moneyParts(cents);
    el.replaceChildren(document.createTextNode(p.sign + p.integer),node("span","balance-decimals",p.fraction + "\u00A0₽"));
  }
  function accountRow(r, archived) {
    const row = node("button",`acc-row${archived ? " archived" : ""}`); row.type = "button"; row.dataset.id = r.account.id;
    const name = node("span","acc-name",I.stored(r.account.name));
    name.append(node("span","acc-kind",` · ${I.kindLabel(r.account.kind)}`));
    row.append(node("span","acc-mark","[▪]"),name,node("span","acc-bal",money(r.balanceCents)));
    row.addEventListener("click",()=>openAccount(r.account.id));
    return row;
  }
  function renderAccounts() {
    const rows = views.accountTotals(state), archived = rows.archived;
    $("accounts-list").replaceChildren(...rows.map(r => accountRow(r, false)));
    $("accounts-total").textContent = t("acc.total",{sum: money(views.balances(state).total)});
    $("archived-line").hidden = !archived.length;
    $("archived-count").textContent = archived.length;
    $("archived-toggle").textContent = t(showArchived ? "acc.hide" : "acc.show");
    $("archived-toggle").setAttribute("aria-expanded", String(showArchived));
    $("archived-list").hidden = !archived.length || !showArchived;
    $("archived-list").replaceChildren(...archived.map(r => accountRow(r, true)));
    $("accounts-count").textContent = rows.length;
    $("nav-accounts-count").textContent = rows.length;
    $("nav-accounts").replaceChildren(...rows.map(r => {
      const b = node("button","qv"); b.type = "button"; b.dataset.id = r.account.id;
      b.append(node("span","qv-name",I.stored(r.account.name)),node("span","qv-count",I.fmtMoney(r.balanceCents,false)));
      b.addEventListener("click",()=>openAccount(r.account.id));
      return b;
    }));
    const a = currentAccount && accById(currentAccount);
    if (a) {
      $("account-label").textContent = I.stored(a.name);
      bigMoney($("account-balance"), views.balances(state).byAccount[a.id]);
      $("account-meta").textContent = t("acc.meta",{kind: I.kindLabel(a.kind), archived: a.archived ? t("acc.metaArchived") : "", opening: money(a.openingCents), date: dateLabel(a.openingDate)});
      $("account-reconcile").hidden = a.archived;
      $("account-archive").textContent = t(a.archived ? "acc.unarchive" : "acc.archive");
    }
  }
  function fillAccountFilter() {
    const select = $("account-filter"), value = select.value;
    select.replaceChildren(...[["all",t("nav.allAccounts")],...state.accounts.map(a => [a.id, accLabel(a)])].map(([v,t]) => { const o = document.createElement("option"); o.value = v; o.textContent = t; return o; }));
    select.value = [...select.options].some(o => o.value === value) ? value : "all";
    select.hidden = state.accounts.length <= 1;
  }
  const setNav = (el, on) => { el.classList.toggle("active",on); el.setAttribute("aria-current",on ? "page" : "false"); };
  function syncChrome() {
    if (currentAccount && !accById(currentAccount)) currentAccount = null;
    document.body.dataset.tab = tab;
    document.body.toggleAttribute("data-trash",trash);
    document.body.toggleAttribute("data-account",!!currentAccount);
    setNav($("journal-nav"), tab === "journal" && !trash);
    setNav($("trash-nav"), tab === "journal" && trash);
    setNav($("settings-nav"), tab === "settings");
    setNav($("categories-nav"), tab === "categories");
    setNav($("analytics-nav"), tab === "analytics");
    setNav($("accounts-nav"), tab === "accounts" && !currentAccount);
    document.querySelectorAll("#nav-accounts .qv").forEach(el => setNav(el, tab === "accounts" && el.dataset.id === currentAccount));
    $("journal-title").textContent = t(trash ? "nav.trash" : "nav.journal");
    $("page-label").textContent = trash ? t("nav.trash") : tab === "accounts" ? (currentAccount ? accName(currentAccount) : t("page.accounts")) : t({journal: "nav.journal", analytics: "page.analytics", plans: "page.plans", more: "page.more", settings: "nav.settings", categories: "nav.categories"}[tab]);
    const active = trash || tab === "settings" || tab === "categories" ? "more" : tab;
    document.querySelectorAll(".tab").forEach(b=>{
      const on = b.dataset.tab === active;
      b.classList.toggle("active",on);
      b.setAttribute("aria-current",on ? "page" : "false");
    });
  }
  function render() {
    const sums = views.totals(state);
    bigMoney($("balance"), sums.balance);
    $("income-total").textContent = "+"+money(sums.income);
    $("expense-total").textContent = "−"+money(sums.expense);
    $("nav-count").textContent = state.operations.filter(e=>!e.deleted).length;
    $("trash-count").textContent = state.operations.filter(e=>e.deleted).length;
    $("more-trash-count").textContent = $("trash-count").textContent;
    fillAccountFilter();
    fillCategoryFilter();
    renderAccounts();
    renderCategories();
    setMode(mode, "keep");
    syncChrome();
    renderDayBar();
    renderEntries();
    if (tab === "analytics") renderAnalytics();
  }
  function showScreen(name, accountId = null, isTrash = false) {
    if (activeSheet) dismissAny();
    tab = name; currentAccount = accountId; trash = isTrash;
    if (name === "analytics") anFresh = true;
    render();
    window.scrollTo(0,0);
  }
  const setTab = name => showScreen(name);
  const openTrash = () => showScreen("journal", null, true);
  const openAccount = id => showScreen("accounts", id);

  // ---------- экран категорий ----------
  function monthRange() {
    const ym = today().slice(0, 7);
    return {from: `${ym}-01`, to: `${ym}-31`};
  }
  function monthLabel() {
    const text = new Intl.DateTimeFormat(I.locale(), {month: "long", year: "numeric"}).format(new Date(today() + "T12:00:00"));
    return I18nLower(text);
  }
  const I18nLower = text => I.getLang() === "en" ? text.toLowerCase() : text;
  function catRow(c, child, cents, archived) {
    const row = node("button", `acc-row cat-row${child ? " child" : ""}${archived ? " archived" : ""}`); row.type = "button"; row.dataset.id = c.id;
    row.append(node("span", "acc-mark", child ? "└" : "[▪]"), node("span", "acc-name", catName(c)), node("span", "acc-bal", cents === null ? "" : money(cents)));
    row.addEventListener("click", () => openCategoryForm(c.id));
    return row;
  }
  function renderCategories() {
    document.querySelectorAll("[data-cat-kind]").forEach(b => { const on = b.dataset.catKind === catKind; b.classList.toggle("active", on); b.setAttribute("aria-pressed", String(on)); });
    const sums = new Map(views.spending(state, {...monthRange(), type: catKind, by: "category"}).map(r => [r.id, r.cents]));
    const rows = [];
    for (const {cat, children} of cats.tree(state, catKind)) {
      const own = sums.get(cat.id) || 0, kids = children.reduce((n, k) => n + (sums.get(k.id) || 0), 0);
      rows.push(catRow(cat, false, own + kids));
      children.forEach(k => rows.push(catRow(k, true, sums.get(k.id) || 0)));
    }
    if (sums.get(null)) {
      const row = node("div", "acc-row cat-row archived");
      row.append(node("span", "acc-mark", "[ ]"), node("span", "acc-name", t("cat.none")), node("span", "acc-bal", money(sums.get(null))));
      rows.push(row);
    }
    $("cat-list").replaceChildren(...rows);
    let total = 0; for (const v of sums.values()) total += v;
    $("cat-total").textContent = t("cat.total", {month: monthLabel()}) + " " + money(total);
    const archived = state.categories.filter(c => c.kind === catKind && c.archived);
    $("cat-archived-line").hidden = !archived.length;
    $("cat-archived-count").textContent = archived.length;
    $("cat-archived-toggle").textContent = t(showCatArchived ? "cat.hide" : "cat.show");
    $("cat-archived-toggle").setAttribute("aria-expanded", String(showCatArchived));
    $("cat-archived-list").hidden = !archived.length || !showCatArchived;
    $("cat-archived-list").replaceChildren(...archived.map(c => catRow(c, false, null, true)));
  }
  function openCategoryForm(id) {
    categoryEditing = id;
    const c = id && catById(id);
    const hasKids = !!c && state.categories.some(k => k.parentId === c.id);
    $("category-title").textContent = t(c ? "cat.edit" : "cat.new");
    $("category-name").value = c ? catName(c) : "";
    const roots = state.categories.filter(x => x.kind === (c ? c.kind : catKind) && x.parentId === null && (!c || x.id !== c.id) && (!x.archived || (c && c.parentId === x.id)));
    const opts = [[ "", t("cat.parentNone")], ...roots.map(x => [x.id, catName(x)])];
    $("category-parent").replaceChildren(...opts.map(([v, label]) => { const o = document.createElement("option"); o.value = v; o.textContent = label; return o; }));
    $("category-parent").value = c && c.parentId ? c.parentId : "";
    $("category-parent").disabled = hasKids;
    $("category-error").textContent = "";
    $("category-archive").hidden = !c;
    if (c) $("category-archive").textContent = t(c.archived ? "cat.unarchive" : "cat.archive");
    openSheet($("category-box"));
    $("category-name").focus();
  }
  $("category-form").addEventListener("submit", event => {
    event.preventDefault(); $("category-error").textContent = "";
    try {
      const name = $("category-name").value, parentId = $("category-parent").value || null;
      if (categoryEditing) {
        const c = catById(categoryEditing), patch = {parentId};
        if (name.trim() !== catName(c)) patch.name = name;
        commit(cats.updateCategory(state, categoryEditing, patch));
      } else commit(cats.addCategory(state, {id: newId(), name, parentId, kind: catKind}));
      closeSheet(); toast(t(categoryEditing ? "msg.catSaved" : "msg.catAdded"));
    } catch (e) { $("category-error").textContent = I.err(e); }
  });
  $("category-archive").addEventListener("click", () => {
    const c = catById(categoryEditing); if (!c) return;
    try {
      let next = state;
      if (c.archived) {
        if (c.parentId && catById(c.parentId).archived) next = cats.archiveCategory(next, c.parentId, false);
        next = cats.archiveCategory(next, c.id, false);
      } else {
        next = cats.archiveCategory(next, c.id, true);
        for (const k of state.categories.filter(x => x.parentId === c.id)) next = cats.archiveCategory(next, k.id, true);
      }
      commit(next); closeSheet(); toast(t(c.archived ? "msg.catUnarchived" : "msg.catArchived"));
    } catch (e) { $("category-error").textContent = I.err(e); }
  });
  $("category-close").addEventListener("click", closeSheet);
  $("cat-add").addEventListener("click", () => openCategoryForm(null));
  $("cat-archived-toggle").addEventListener("click", () => { showCatArchived = !showCatArchived; renderCategories(); });
  document.querySelectorAll("[data-cat-kind]").forEach(b => b.addEventListener("click", () => { catKind = b.dataset.catKind; renderCategories(); }));
  $("categories-nav").addEventListener("click", () => setTab("categories"));
  $("more-categories").addEventListener("click", () => setTab("categories"));
  $("categories-back").addEventListener("click", () => setTab("more"));
  $("category-filter").addEventListener("change", () => setCatFilter($("category-filter").value));
  $("cat-bar-clear").addEventListener("click", () => setCatFilter("all"));
  $("merchant").addEventListener("input", () => { applyMerchantHint(false); renderFormSuggest(); });
  $("category-all").addEventListener("click", () => toggleCategoryTree($("category-tree").hidden));
  $("account").addEventListener("change", () => { accTouched = true; });
  $("amount").addEventListener("input", syncReceipt);


  // ---------- чек в форме расхода ----------
  const withoutItems = op => { if (!op) return op; const {items, ...rest} = op; return rest; };
  const moneyShort = cents => money(cents).replace(/[,.]00(?= ₽)/, "");
  const unitLabel = u => t("unit." + u);
  const priceUnit = u => u === "g" ? "kg" : u === "ml" ? "l" : u;
  const receiptActive = () => mode === "expense" && receipt.open;
  function formatQty(milli) {
    const v = (milli / 1000).toFixed(3).replace(/\.?0+$/, "");
    return I.getLang() === "ru" ? v.replace(".", ",") : v;
  }
  function parseQty(value) {
    const clean = String(value).trim().replace(/[\s  ]/g, "").replace(",", ".");
    if (!/^\d+(?:\.\d{1,3})?$/.test(clean)) throw new Error(t("err.qty"));
    const [whole, frac = ""] = clean.split(".");
    const milli = Number(whole) * 1000 + Number(frac.padEnd(3, "0"));
    if (!Number.isSafeInteger(milli) || milli <= 0 || milli > 1e9) throw new Error(t("err.qty"));
    return milli;
  }
  const rowCents = r => { try { return M.parseAmount(r.amount); } catch { return 0; } };
  const receiptSum = () => receipt.rows.reduce((s, r) => s + (r.kind === "discount" ? -rowCents(r) : rowCents(r)), 0);
  const receiptCount = () => receipt.rows.filter(r => r.kind === "item" && (r.name.trim() || r.amount.trim())).length;
  const receiptTotal = items => items.reduce((s, i) => s + (i.kind === "discount" ? -i.amountCents : i.amountCents), 0);
  const blankRow = r => !r.name.trim() && !r.amount.trim();
  const newRow = kind => ({id: newId(), kind, name: "", qty: "1", unit: "pcs", amount: "", catId: null});
  function resetReceipt() {
    receipt = {open: false, manual: false, rows: []};
    $("receipt-rows").replaceChildren();
  }
  function loadReceipt(entry) {
    receipt = {open: true, manual: false, rows: entry.items.map(i => ({id: i.id, kind: i.kind, name: i.name, qty: formatQty(i.qtyMilli), unit: i.unit, amount: amountInput(i.amountCents), catId: i.categoryId || null}))};
    $("receipt-rows").replaceChildren(...receipt.rows.map(buildRow));
  }
  // fallback-категория покупки в операции не хранится: подбираем ту, что воспроизводит allocations
  function receiptFallback(entry) {
    const want = new Map(entry.allocations.map(a => [a.categoryId, a.amountCents]));
    const cands = [...entry.allocations].sort((a, b) => b.amountCents - a.amountCents).map(a => a.categoryId).filter(x => x !== null);
    for (const fb of [...cands, null]) {
      try {
        const got = journal.allocationsFromItems(entry.items, fb);
        if (got.length === want.size && got.every(a => want.get(a.categoryId) === a.amountCents)) return fb;
      } catch {}
    }
    return null;
  }
  function collectReceipt() {
    const items = [];
    receipt.rows.forEach((r, i) => {
      if (blankRow(r)) return;
      const n = i + 1, fail = why => { throw new Error(t("err.receiptRow", {n, why})); };
      let amountCents;
      try { amountCents = M.parseAmount(r.amount); } catch (e) { fail(I.err(e)); }
      if (r.kind === "item") {
        if (!r.name.trim()) fail(t("err.receiptName"));
        let qtyMilli;
        try { qtyMilli = parseQty(r.qty); } catch (e) { fail(e.message); }
        items.push({id: r.id, kind: "item", name: r.name.trim(), qtyMilli, unit: r.unit, amountCents, categoryId: r.catId || null});
      } else items.push({id: r.id, kind: r.kind, name: r.name.trim(), qtyMilli: 1000, unit: "pcs", amountCents, categoryId: null});
    });
    if (!items.length) return null;
    const goods = items.filter(i => i.kind === "item").reduce((s, i) => s + i.amountCents, 0);
    if (!goods) throw new Error(t("err.receiptNoItems"));
    if (items.filter(i => i.kind === "discount").reduce((s, i) => s + i.amountCents, 0) >= goods) throw new Error(t("err.discountBig"));
    return items;
  }
  function syncReceipt() {
    const expense = mode === "expense", on = expense && receipt.open;
    $("receipt-bar").hidden = !expense;
    $("receipt-toggle").textContent = t(receipt.open ? "receipt.remove" : "receipt.add");
    $("receipt-toggle").setAttribute("aria-expanded", String(receipt.open));
    $("receipt").hidden = !on;
    $("amount-note").hidden = $("amount-mode").hidden = !on;
    $("amount").readOnly = on && !receipt.manual;
    let diff = null;
    if (on) {
      const sum = receiptSum();
      if (!receipt.manual) $("amount").value = sum > 0 ? amountInput(sum) : "";
      else { try { diff = M.parseAmount($("amount").value) - sum; } catch {} }
      $("amount-note").textContent = t(receipt.manual ? "receipt.manualTotal" : "receipt.fromReceipt");
      $("amount-note").classList.toggle("hint", !receipt.manual);
      $("amount-mode").textContent = t(receipt.manual ? "receipt.modeAuto" : "receipt.modeManual");
      $("receipt-sum").textContent = t("receipt.sum", {n: receiptCount(), sum: money(sum)});
      const bad = diff !== null && diff !== 0;
      $("receipt-diff").hidden = !bad;
      if (bad) {
        $("receipt-diff-text").textContent = t("receipt.diff", {diff: signed(diff)});
        $("diff-discount").hidden = diff > 0;
        $("diff-fee").hidden = diff < 0;
        $("diff-discount").textContent = t("receipt.asDiscount", {sum: "−" + money(Math.abs(diff))});
        $("diff-fee").textContent = t("receipt.asFee", {sum: "+" + money(Math.abs(diff))});
        $("diff-fix").hidden = sum <= 0;
        $("diff-fix").textContent = t("receipt.fix", {sum: money(sum)});
      }
    } else $("receipt-diff").hidden = true;
    $("save-button").disabled = on && diff !== null && diff !== 0;
  }
  function defaultCatLabel() { const c = selCat && catById(selCat); return c ? catName(c) : t("form.categoryNone"); }
  function refreshRowCats() {
    document.querySelectorAll("#receipt-rows .ri-cat option[value='']").forEach(o => { o.textContent = defaultCatLabel(); });
  }
  function fillRowCat(select, r) {
    const opts = [["", defaultCatLabel()]];
    for (const {cat, children} of cats.tree(state, "expense")) {
      opts.push([cat.id, catName(cat)]);
      children.forEach(k => opts.push([k.id, catName(k)]));
    }
    const cur = r.catId && catById(r.catId);
    if (cur && !opts.some(o => o[0] === cur.id)) opts.push([cur.id, catName(cur)]);
    select.replaceChildren(...opts.map(([v, label]) => { const o = document.createElement("option"); o.value = v; o.textContent = label; return o; }));
    select.value = cur ? cur.id : "";
  }
  function lastItemInfo(name) {
    const key = suggest.itemKey(name);
    if (!key) return null;
    return suggest.items(state, $("merchant").value.trim() || null, name, 50).find(x => suggest.itemKey(x.name) === key) || null;
  }
  const priceText = x => `${moneyShort(x.lastUnitPriceCents)}/${unitLabel(priceUnit(x.unit))}`;
  function buildRow(r) {
    const el = node("div", `ritem ${r.kind}`); el.dataset.id = r.id;
    const field = (cls, value, aria, ph) => {
      const input = node("input", cls); input.type = "text"; input.autocomplete = "off"; input.value = value;
      input.setAttribute("aria-label", t(aria)); if (ph) input.placeholder = ph;
      return input;
    };
    const name = field("ri-name", r.name, "receipt.nameAria", t(r.kind === "item" ? "receipt.namePh" : r.kind === "discount" ? "receipt.discountPh" : "receipt.feePh"));
    name.maxLength = 80; name.enterKeyHint = "next";
    if (r.kind === "item") name.autocapitalize = "sentences";
    const amt = field("ri-amt", r.amount, "receipt.amountAria", t("amount.ph"));
    amt.inputMode = "decimal"; amt.maxLength = 20;
    const rm = node("button", "bracket ri-x", "[×]"); rm.type = "button"; rm.setAttribute("aria-label", t("receipt.removeRow"));
    rm.addEventListener("click", () => { receipt.rows = receipt.rows.filter(x => x !== r); el.remove(); syncReceipt(); });
    amt.addEventListener("input", () => { r.amount = amt.value; syncReceipt(); });
    if (r.kind !== "item") {
      const sign = node("span", "ri-sign", r.kind === "discount" ? "−" : "+"); sign.setAttribute("aria-hidden", "true");
      const top = node("div", "ri-top"); top.append(sign, name, amt, rm);
      name.addEventListener("input", () => { r.name = name.value; });
      el.append(top);
      return el;
    }
    const cat = node("select", "ri-cat"); cat.setAttribute("aria-label", t("receipt.catAria")); fillRowCat(cat, r);
    cat.addEventListener("change", () => { r.catId = cat.value || null; });
    const top = node("div", "ri-top"); top.append(name, cat, rm);
    const sug = node("div", "ri-sug chips"); sug.setAttribute("role", "group"); sug.setAttribute("aria-label", t("receipt.sugAria"));
    const qty = field("ri-qty", r.qty, "receipt.qtyAria", "1"); qty.inputMode = "decimal"; qty.maxLength = 10;
    const unit = node("select", "ri-unit"); unit.setAttribute("aria-label", t("receipt.unitAria"));
    unit.replaceChildren(...schema.UNITS.map(u => { const o = document.createElement("option"); o.value = u; o.textContent = unitLabel(u); return o; }));
    unit.value = r.unit;
    const bot = node("div", "ri-bot"); bot.append(qty, unit, amt);
    const hint = node("div", "ri-hint muted hint"); hint.hidden = true;
    const showHint = () => {
      const found = lastItemInfo(r.name);
      hint.hidden = !found;
      if (found) hint.textContent = t("receipt.last", {qty: `${formatQty(found.lastQtyMilli)} ${unitLabel(found.unit)}`, sum: moneyShort(found.lastAmountCents), price: priceText(found)});
    };
    const showSug = () => {
      const q = r.name.trim(), key = suggest.itemKey(q);
      const list = q ? suggest.items(state, $("merchant").value.trim() || null, q, 5).filter(x => suggest.itemKey(x.name) !== key) : [];
      sug.replaceChildren(...list.map(x => {
        const b = chip(`${x.name} · ${priceText(x)}`, false, () => {
          r.name = x.name; name.value = x.name;
          r.qty = formatQty(x.lastQtyMilli); qty.value = r.qty;
          r.unit = x.unit; unit.value = x.unit;
          const c = x.categoryId && catById(x.categoryId);
          if (c && c.kind === "expense" && !c.archived) { r.catId = c.id; fillRowCat(cat, r); }
          sug.replaceChildren(); showHint(); syncReceipt(); amt.focus();
        });
        b.addEventListener("mousedown", ev => ev.preventDefault());
        return b;
      }));
    };
    name.addEventListener("input", () => { r.name = name.value; showSug(); showHint(); syncReceipt(); });
    name.addEventListener("focus", showSug);
    name.addEventListener("blur", () => setTimeout(() => sug.replaceChildren(), 300));
    qty.addEventListener("input", () => { r.qty = qty.value; });
    unit.addEventListener("change", () => { r.unit = unit.value; });
    el.append(top, sug, bot, hint);
    showHint();
    return el;
  }
  function addRow(kind, focus = true) {
    const r = newRow(kind); receipt.rows.push(r);
    const el = buildRow(r); $("receipt-rows").append(el);
    syncReceipt();
    if (focus) el.querySelector(kind === "item" ? ".ri-name" : ".ri-amt").focus();
    return r;
  }
  function toggleReceipt() {
    receipt.open = !receipt.open;
    if (receipt.open && !receipt.rows.length) {
      receipt.manual = $("amount").value.trim() !== "";
      addRow("item", false);
    }
    syncReceipt();
    if (receipt.open && receipt.rows.length === 1 && blankRow(receipt.rows[0])) document.querySelector("#receipt-rows .ri-name").focus();
  }
  $("receipt-toggle").addEventListener("click", toggleReceipt);
  $("receipt-add-item").addEventListener("click", () => addRow("item"));
  $("receipt-add-discount").addEventListener("click", () => addRow("discount"));
  $("receipt-add-fee").addEventListener("click", () => addRow("fee"));
  $("amount-mode").addEventListener("click", () => {
    receipt.manual = !receipt.manual;
    syncReceipt();
    if (receipt.manual) { $("amount").focus(); $("amount").select(); }
  });
  function addDiffRow(kind, cents) {
    const r = addRow(kind, false); r.amount = amountInput(cents);
    document.querySelector(`#receipt-rows [data-id="${r.id}"] .ri-amt`).value = r.amount;
    syncReceipt();
  }
  $("diff-discount").addEventListener("click", () => { const d = receiptDiff(); if (d < 0) addDiffRow("discount", -d); });
  $("diff-fee").addEventListener("click", () => { const d = receiptDiff(); if (d > 0) addDiffRow("fee", d); });
  $("diff-fix").addEventListener("click", () => { receipt.manual = false; syncReceipt(); });
  function receiptDiff() { try { return M.parseAmount($("amount").value) - receiptSum(); } catch { return 0; } }
  $("receipt").addEventListener("keydown", ev => {
    if (ev.key !== "Enter" || ev.target.tagName !== "INPUT") return;
    ev.preventDefault();
    const all = [...$("receipt").querySelectorAll("input")], i = all.indexOf(ev.target);
    if (all[i + 1]) all[i + 1].focus(); else ev.target.blur();
  });

  // ---------- счета: форма и сверка ----------
  function openAccountForm(id) {
    accountEditing = id;
    const a = id && accById(id);
    $("account-title").textContent = t(a ? "acform.edit" : "acform.new");
    $("account-name").value = a ? I.stored(a.name) : "";
    const kinds = ["debit","cash","savings","credit_card"];
    if (a && !kinds.includes(a.kind)) kinds.push(a.kind);
    $("account-kind").replaceChildren(...kinds.map(k => { const o = document.createElement("option"); o.value = k; o.textContent = I.kindLabel(k); return o; }));
    $("account-kind").value = a ? a.kind : "debit";
    $("account-opening").value = a ? amountInput(a.openingCents) : "";
    $("account-date").value = a ? a.openingDate : today();
    $("account-error").textContent = "";
    openSheet($("account-box"));
    $("account-name").focus();
  }
  $("account-form").addEventListener("submit",event=>{
    event.preventDefault(); $("account-error").textContent = "";
    try {
      const raw = $("account-opening").value.trim();
      const openingCents = raw ? M.parseAmount(raw,true) : 0;
      const openingDate = $("account-date").value;
      if (!M.validDate(openingDate)) throw new Error(t("err.date"));
      const data = {name: $("account-name").value, kind: $("account-kind").value, openingCents, openingDate};
      if (accountEditing) commit(acct.updateAccount(state,accountEditing,data));
      else { const id = newId(); commit(acct.addAccount(state,{id,...data})); }
      closeSheet(); toast(t(accountEditing ? "msg.accSaved" : "msg.accAdded"));
    } catch(e) { $("account-error").textContent = I.err(e); }
  });
  function reconInfo() {
    const bankRaw = $("recon-bank").value.trim(), date = $("recon-date").value;
    const calc = M.validDate(date) && accById(reconAccount) ? views.balances(state,date).byAccount[reconAccount] : null;
    let bank = null;
    try { bank = M.parseAmount(bankRaw,true); } catch {}
    return {bank, date, calc, diff: bank !== null && calc !== null ? bank - calc : null};
  }
  function updateRecon() {
    const {calc, diff} = reconInfo();
    $("recon-calc").textContent = calc === null ? "" : t("recon.calc",{sum: money(calc)});
    $("recon-diff").textContent = t("recon.diff",{diff: diff === null ? "—" : signed(diff)});
    $("recon-diff").className = `recon-diff${diff === 0 ? " ok" : diff ? " warn" : ""}`;
    $("recon-save").firstElementChild.textContent = t(diff === 0 ? "recon.match" : "recon.save");
  }
  function openRecon(id) {
    reconAccount = id;
    $("recon-title").textContent = t("recon.titleFor",{name: accName(id)});
    $("recon-bank").value = ""; $("recon-note").value = ""; $("recon-error").textContent = "";
    $("recon-date").value = today();
    updateRecon();
    openSheet($("recon-box"));
    $("recon-bank").focus();
  }
  $("recon-form").addEventListener("submit",event=>{
    event.preventDefault(); $("recon-error").textContent = "";
    try {
      const bank = M.parseAmount($("recon-bank").value,true), date = $("recon-date").value;
      if (!M.validDate(date)) throw new Error(t("err.date"));
      if (date > today()) throw new Error(t("err.reconFuture"));
      const res = journal.reconcile(state,reconAccount,bank,date,$("recon-note").value,newId(),new Date().toISOString());
      if (res.diff === 0) { closeSheet(); toast(t("msg.reconMatch")); return; }
      commit(res.state); closeSheet(); toast(t("msg.reconDone",{diff: signed(res.diff)}));
    } catch(e) { $("recon-error").textContent = I.err(e); }
  });
  ["recon-bank","recon-date"].forEach(id => $(id).addEventListener("input",updateRecon));
  document.querySelectorAll("[data-sign]").forEach(b=>b.addEventListener("click",()=>{
    const input = $(b.dataset.sign), v = input.value.trim();
    input.value = v.startsWith("-") ? v.slice(1) : "-" + v;
    input.dispatchEvent(new Event("input"));
    input.focus();
  }));
  $("add-account").addEventListener("click",()=>openAccountForm(null));
  $("nav-add-account").addEventListener("click",()=>openAccountForm(null));
  $("account-edit").addEventListener("click",()=>openAccountForm(currentAccount));
  $("account-reconcile").addEventListener("click",()=>openRecon(currentAccount));
  $("account-archive").addEventListener("click",()=>{
    const a = accById(currentAccount); if (!a) return;
    try { commit(acct.archiveAccount(state,a.id,!a.archived)); toast(t(a.archived ? "msg.accUnarchived" : "msg.accArchived")); }
    catch(e) { toast(I.err(e)); }
  });
  $("account-back").addEventListener("click",()=>showScreen("accounts"));
  $("account-close").addEventListener("click",closeSheet);
  $("recon-close").addEventListener("click",closeSheet);
  $("archived-toggle").addEventListener("click",()=>{ showArchived = !showArchived; renderAccounts(); });
  $("accounts-link").addEventListener("click",()=>showScreen("accounts"));
  $("accounts-nav").addEventListener("click",()=>showScreen("accounts"));
  $("account-filter").addEventListener("change",renderEntries);
  $("account").addEventListener("change",()=>ensureDistinct(true));
  $("account-to").addEventListener("change",()=>ensureDistinct(false));

  $("entry-form").addEventListener("submit",event=>{
    event.preventDefault(); $("form-error").textContent = "";
    try {
      let receiptItems = null, amountCents = 0;
      if (mode === "expense" && receipt.open) {
        receiptItems = collectReceipt();
        if (receiptItems) {
          amountCents = receiptTotal(receiptItems);
          if (receipt.manual && M.parseAmount($("amount").value) !== amountCents) throw new Error(t("err.receiptDiff"));
        }
      }
      if (!receiptItems) amountCents = M.parseAmount($("amount").value);
      const date = $("date").value;
      if (!M.validDate(date)) throw new Error(t("err.date"));
      if (date > today()) throw new Error(t("err.future"));
      const previous = editing ? state.operations.find(e=>e.id===editing) : null;
      if (editing && (!previous || previous.deleted)) throw new Error(t("err.entryDeleted"));
      const now = new Date().toISOString(), note = $("note").value.trim();
      const accountId = $("account").value, toId = $("account-to").value;
      if (!accountId) throw new Error(t("err.pickAccount"));
      let next, done;
      if (mode === "transfer") {
        if (!toId || accountId === toId) throw new Error(t("err.twoAccounts"));
        const legs = [{accountId,amountCents:-amountCents},{accountId:toId,amountCents}];
        if (previous) next = journal.upsertOperation(state,{...withoutItems(previous),type:"transfer",date,note,deleted:false,legs,allocations:[]},now);
        else {
          const transfer = journal.makeTransfer({id:newId(),fromId:accountId,toId,amountCents,date,note,now});
          next = journal.upsertOperation(state,transfer,now);
          const feeRaw = $("fee").value.trim();
          if (feeRaw) next = journal.upsertOperation(next,journal.makeFee({id:newId(),transferId:transfer.id,accountId,amountCents:M.parseAmount(feeRaw),date,now}),now);
        }
        done = t(previous ? "msg.changesSaved" : "msg.transferDone");
      } else {
        const entry = {...withoutItems(previous),id:previous?.id || newId(),type:mode,date,note,createdAt:previous?.createdAt || now,deleted:false,
          legs:[{accountId,amountCents:mode === "income" ? amountCents : -amountCents}],
          allocations:mode === "income" ? (selCat ? [{categoryId:selCat,amountCents}] : []) : [{categoryId:selCat,amountCents}]};
        if (receiptItems) {
          entry.items = receiptItems;
          entry.allocations = journal.allocationsFromItems(receiptItems, selCat);
        }
        const merchant = $("merchant").value.trim();
        if (merchant) entry.merchant = merchant; else delete entry.merchant;
        next = journal.upsertOperation(state,entry,now);
        done = t(previous ? "msg.changesSaved" : mode === "income" ? "msg.incomeDone" : "msg.expenseDone");
      }
      commit(next);
      toast(done);
      resetForm(!isMobile()); closeSheet();
      if (trash) { trash = false; render(); }
    } catch(e) { $("form-error").textContent = I.err(e); }
  });
  document.querySelectorAll("[data-type]").forEach(b=>b.addEventListener("click",()=>setMode(b.dataset.type,editing ? "keep" : "default")));
  document.querySelectorAll("[data-filter]").forEach(b=>b.addEventListener("click",()=>{
    filter = b.dataset.filter;
    document.querySelectorAll("[data-filter]").forEach(item=>{item.classList.toggle("active",item===b);item.setAttribute("aria-pressed",String(item===b));});
    renderEntries();
  }));
  $("search").addEventListener("input",renderEntries);
  $("search-toggle").addEventListener("click",()=>{
    const open = $("search-toggle").getAttribute("aria-expanded") !== "true";
    $("search-toggle").setAttribute("aria-expanded",String(open));
    document.querySelector(".journal-tools").classList.toggle("search-open",open);
    if (open) $("search").focus();
  });
  $("cancel-edit").addEventListener("click",()=>resetForm());
  $("delete-entry").addEventListener("click",()=>{
    const entry = editing ? state.operations.find(e=>e.id===editing) : null;
    if (entry && !entry.deleted) softDelete(entry);
  });
  $("sheet-close").addEventListener("click",dismissSheet);
  $("sheet-backdrop").addEventListener("click",dismissAny);
  document.querySelectorAll("[data-new]").forEach(b=>b.addEventListener("click",()=>startNew(b.dataset.new)));
  $("date-toggle").addEventListener("click",()=>{
    $("entry-form").classList.add("date-open");
    dps.date.open();
  });
  $("date").addEventListener("change",updateDateSummary);
  document.querySelectorAll(".tab").forEach(b=>b.addEventListener("click",()=>setTab(b.dataset.tab)));
  $("trash-back").addEventListener("click",()=>setTab("more"));
  $("more-trash").addEventListener("click",openTrash);
  mobileQuery.addEventListener("change",()=>{ if(!isMobile() && activeSheet?.id === "entry-box") closeSheet(); setMode(mode); renderEntries(); });
  $("journal-nav").addEventListener("click",()=>setTab("journal"));
  $("trash-nav").addEventListener("click",openTrash);
  document.querySelectorAll("[data-close]").forEach(b=>b.addEventListener("click",()=>$(b.dataset.close).close()));
  $("toast-close").addEventListener("click",()=>{$("toast").hidden=true;undoId=null;});
  $("undo-button").addEventListener("click",()=>{
    if (!undoId) return;
    try {commit(journal.setDeleted(state,undoId,false));toast(t("msg.restoredShort"));} catch(e){toast(I.err(e));}
  });
  function download(text, filename) {
    const url=URL.createObjectURL(new Blob([text],{type:"application/json;charset=utf-8"}));
    const a=document.createElement("a");a.href=url;a.download=filename;document.body.append(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  function doExport() {
    try {
      const raw = locked ? (localStorage.getItem(KEY) ?? localStorage.getItem(KEY_V1)) : JSON.stringify({...state,exportedAt:new Date().toISOString()},null,2);
      if(raw===null) throw new Error(t("err.noData"));
      download(raw,`finance-log-${today()}${locked ? "-recovery" : ""}.json`);
      toast(t("msg.exported"));
    } catch(e){toast(I.err(e));}
  }
  const doImport = ()=>{$("import-file").value="";$("import-file").click();};
  $("export-button").addEventListener("click",doExport);
  $("more-export").addEventListener("click",doExport);
  $("import-button").addEventListener("click",doImport);
  $("more-import").addEventListener("click",doImport);
  $("import-file").addEventListener("change",async()=>{
    const file=$("import-file").files[0];if(!file)return;
    try {
      if(file.size>25*1024*1024) throw new Error(t("err.tooBig"));
      pendingImport=schema.migrate(JSON.parse(await file.text()),today());
      const merged=journal.merge(state,pendingImport,today());
      $("import-description").textContent=t("import.desc",{count: tp("journal.count",pendingImport.operations.length), added: merged.added});
      $("import-error").textContent="";
      $("import-dialog").showModal();
    } catch(e){toast(e instanceof SyntaxError ? t("err.notJson") : I.err(e));}
  });
  $("confirm-import").addEventListener("click",()=>{
    try {
      const merged=journal.merge(state,pendingImport,today());
      commit(merged.state);pendingImport=null;$("import-dialog").close();resetForm();
      toast(t("msg.imported",{added: merged.added}));
    } catch(e){$("import-error").textContent=I.err(e);}
  });
  // ---------- настройки: язык и тема ----------
  function updateThemeButton() {
    const dark = boot.resolve().dark;
    $("theme-button").textContent = t(dark ? "theme.toLight" : "theme.toDark");
    $("theme-button").setAttribute("aria-label", t(dark ? "theme.toLightAria" : "theme.toDarkAria"));
  }
  // ---------- приватность ----------
  function applyPrivacy() {
    I.setPrivacy(!!settings.privacy);
    const on = I.isPrivacy(), b = $("privacy-button");
    b.setAttribute("aria-pressed", String(on));
    b.setAttribute("aria-label", t(on ? "privacy.show" : "privacy.hide"));
    b.title = b.getAttribute("aria-label");
    b.querySelector(".pv-show").toggleAttribute("hidden", on);
    b.querySelector(".pv-hide").toggleAttribute("hidden", !on);
    const os = $("privacy-on-start");
    os.setAttribute("aria-checked", String(!!settings.privacyOnStart));
    os.classList.toggle("selected", !!settings.privacyOnStart);
  }
  function syncPrivacy() {
    const changed = !!settings.privacy !== I.isPrivacy();
    applyPrivacy();
    if (changed) render();
  }
  function applyHints() {
    const h = $("hints-toggle");
    h.setAttribute("aria-checked", String(!!settings.hints));
    h.classList.toggle("selected", !!settings.hints);
  }
  function toggleHints() {
    persistNotice(boot.set({hints: !settings.hints}));
    settings = boot.get(); applyHints();
  }
  function togglePrivacy() {
    persistNotice(boot.set({privacy: !settings.privacy}));
    settings = boot.get(); syncPrivacy();
  }
  function persistNotice(saved) { if (!saved) toast(t("settings.saveFail")); }
  function themeRow(theme, group) {
    const selected = settings[group === "dark" ? "darkTheme" : "lightTheme"] === theme.id;
    const row = node("button",`theme-row${selected ? " selected" : ""}`); row.type = "button";
    row.setAttribute("aria-pressed",String(selected));
    const swatches = node("span","swatches");
    for (const key of ["bg","accent","headers","warn"]) {
      const sw = node("span","sw"); sw.style.background = theme.c[key]; sw.style.borderColor = theme.c.separator; swatches.append(sw);
    }
    row.append(node("span","theme-check","[✓]"),swatches,node("span","theme-name",theme.name));
    row.addEventListener("click",()=>{
      const patch = group === "dark" ? {darkTheme: theme.id} : {lightTheme: theme.id};
      if (settings.themeMode !== "auto") patch.themeMode = group;
      persistNotice(boot.set(patch));
    });
    return row;
  }
  function renderSettings() {
    settings = boot.get();
    document.querySelectorAll("[data-set-lang]").forEach(b => { const on = b.dataset.setLang === settings.lang; b.classList.toggle("active",on); b.setAttribute("aria-pressed",String(on)); });
    document.querySelectorAll("[data-set-mode]").forEach(b => { const on = b.dataset.setMode === settings.themeMode; b.classList.toggle("active",on); b.setAttribute("aria-pressed",String(on)); });
    for (const group of ["dark","light"]) {
      const list = boot.themes().filter(x => x.dark === (group === "dark"));
      const rows = list.filter(x => !x.group).map(x => themeRow(x,group));
      const bm = list.filter(x => x.group === "blackmetal");
      if (bm.length) rows.push(node("div","theme-subhead",t("settings.blackMetal")), ...bm.map(x => themeRow(x,group)));
      $(`themes-${group}`).replaceChildren(...rows);
    }
  }

  // ---------- аккаунт и синхронизация ----------
  const auth = {state: "loading", me: null, config: null, error: null};
  const AUTH_HEADERS = {"X-Requested-With": "finance.log"};
  const SY = globalThis.MoneyCore.sync;
  const SYNC_KEY = "money.log.sync", PARK_DAYS = 7;
  const syncDefault = () => ({userId: null, cursor: 0, device: newId(), pending: {}, parked: {}, declined: null, lastSync: null, lastError: null});
  let sync;
  try {
    const o = JSON.parse(localStorage.getItem(SYNC_KEY) || "null");
    sync = {...syncDefault(), ...(o && typeof o === "object" ? o : {})};
    if (!/^[\w-]{1,64}$/.test(sync.device)) sync.device = newId();
    if (!sync.pending || typeof sync.pending !== "object") sync.pending = {};
    if (!sync.parked || typeof sync.parked !== "object") sync.parked = {};
  } catch { sync = syncDefault(); }
  const saveSync = () => { try { localStorage.setItem(SYNC_KEY, JSON.stringify(sync)); } catch {} };
  let syncing = false, syncAgain = false, syncHold = false, syncTimer = null, pendSeq = 0, deleteArmed = false;
  const syncInfo = {records: null};
  const nowISO = () => new Date().toISOString();

  function notePending(records) {
    for (const r of records) { pendSeq = Math.max(pendSeq + 1, Date.now()); sync.pending[SY.recordKey(r)] = pendSeq; }
  }
  function scheduleSync() { clearTimeout(syncTimer); syncTimer = setTimeout(runSync, 1500); }
  // запись состояния, пришедшего с сервера: без попадания в pending
  function applySilently(next) {
    const checked = schema.validate(next);
    try { localStorage.setItem(KEY, JSON.stringify(checked)); } catch { throw new Error(t("err.saveFail")); }
    state = checked;
    render();
  }
  const parkedList = () => Object.values(sync.parked);
  const parkedOld = () => parkedList().filter(p => Date.now() - Date.parse(p.since) > PARK_DAYS * 864e5);
  const syncReady = () => auth.state === "in" && !!sync.userId && sync.userId === auth.me.user.id && !syncHold && !locked;

  function syncStatus() {
    if (sync.userId) {
      if (auth.state === "out") return "err";
      if (auth.state === "loading") return "busy";
      if (syncing || syncHold) return "busy";
      if (sync.lastError || parkedOld().length) return "err";
      if (!navigator.onLine || auth.state === "offline") return "offline";
      return Object.keys(sync.pending).length ? "busy" : "ok";
    }
    if (auth.state === "in" && sync.declined === auth.me.user.id) return "off";
    return null;
  }
  const SHORT = {ok: "✓", busy: "…", offline: "○", err: "!", off: "–"};
  function renderIndicator() {
    const el = $("sync-indicator"), st = syncStatus();
    el.hidden = !st;
    if (!st) return;
    el.dataset.state = st;
    el.querySelector(".sync-full").textContent = t("sync.ind." + st);
    el.querySelector(".sync-short").textContent = SHORT[st];
    el.setAttribute("aria-label", t("sync.aria." + st));
    el.title = t("sync.aria." + st);
  }
  function renderNotes() {
    const on = auth.state === "in";
    $("nav-note").setAttribute("data-i18n-html", on ? "nav.noteSync" : "nav.note");
    $("nav-note").innerHTML = t(on ? "nav.noteSync" : "nav.note");
    $("more-note").setAttribute("data-i18n", on ? "more.localSync" : "more.local");
    $("more-note").textContent = t(on ? "more.localSync" : "more.local");
  }
  const syncUi = () => renderAccount();

  function errText(code) {
    if (code === "unauthorized") return t("sync.err.unauthorized");
    if (code === "network") return t("sync.err.network");
    return t("sync.err.other", {code});
  }
  function failure(e) {
    if (e && e.status === 401) return "unauthorized";
    if (e && e.status) return e.code || "http_" + e.status;
    return "network";
  }
  async function syncPost(changes, cursor) {
    const r = await authFetch("/api/sync", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({cursor, device: sync.device, changes})});
    if (!r.ok || !r.body) throw {status: r.status, code: r.body && r.body.error};
    return r.body;
  }
  const keyOf = r => r.kind + ":" + r.id;
  async function refreshStats() {
    try {
      const r = await authFetch("/api/sync/stats");
      if (r.ok && r.body) { syncInfo.records = r.body.records; renderAccount(); }
    } catch {}
  }

  async function runSync() {
    clearTimeout(syncTimer);
    if (syncing) { syncAgain = true; return; }
    if (!syncReady()) { renderIndicator(); return; }
    if (!navigator.onLine) { renderIndicator(); return; }
    syncing = true; syncAgain = false;
    syncUi();
    try {
      for (let guard = 0; guard < 400; guard++) {
        const recMap = new Map(SY.toRecords(state).map(r => [keyOf(r), r]));
        const batch = [], sent = {};
        for (const k of Object.keys(sync.pending)) {
          const r = recMap.get(k);
          if (!r) { delete sync.pending[k]; continue; }
          if (batch.length < 500) { batch.push(r); sent[k] = sync.pending[k]; }
        }
        const b = await syncPost(batch, sync.cursor);
        for (const a of b.accepted || []) { const k = keyOf(a); if (k in sent && sync.pending[k] === sent[k]) delete sync.pending[k]; }
        for (const s of b.stale || []) { const k = keyOf(s); if (k in sent && sync.pending[k] === sent[k]) delete sync.pending[k]; }
        // входящие + ранее отложенные; без записей, которые уже совпадают с локальными
        const local = new Map(SY.toRecords(state).map(r => [keyOf(r), r]));
        const incoming = new Map();
        for (const p of parkedList()) incoming.set(keyOf(p.rec), p.rec);
        for (const r of b.changes || []) {
          const l = local.get(keyOf(r));
          if (l && l.deleted === !!r.deleted && JSON.stringify(l.data) === JSON.stringify(r.data)) { incoming.delete(keyOf(r)); continue; }
          incoming.set(keyOf(r), r);
        }
        if (incoming.size) {
          const res = SY.applyRemote(state, [...incoming.values()]);
          if (res.state !== state) applySilently(res.state);
          const parked = {};
          for (const s of res.skipped) { const k = keyOf(s); parked[k] = {rec: incoming.get(k), since: (sync.parked[k] && sync.parked[k].since) || nowISO()}; }
          sync.parked = parked;
        }
        sync.cursor = b.cursor; sync.lastSync = nowISO(); sync.lastError = null; saveSync();
        if (!b.more && !Object.keys(sync.pending).some(k => recMap.has(k))) break;
      }
    } catch (e) {
      sync.lastError = navigator.onLine === false ? null : failure(e);
      saveSync();
      if (sync.lastError === "unauthorized") loadAccount();
    } finally {
      syncing = false;
      syncUi();
      if (!sync.lastError) refreshStats();
      if (syncAgain) setTimeout(runSync, 0);
    }
  }
  const syncNow = () => { sync.lastError = null; saveSync(); runSync(); };

  // ---- первое подключение устройства ----
  const isLocalEmpty = () => state.operations.length === 0 && state.accounts.length <= 1 && state.accounts.every(a => a.openingCents === 0) && state.categories.every(c => c.key);
  async function downloadAll() {
    const map = new Map();
    let cursor = 0;
    for (let i = 0; i < 400; i++) {
      const b = await syncPost([], cursor);
      for (const r of b.changes || []) map.set(keyOf(r), r);
      cursor = b.cursor;
      if (!b.more) break;
    }
    return {records: [...map.values()], cursor};
  }
  function askSync(count, other) {
    return new Promise(resolve => {
      const dlg = $("sync-dialog"), merge = $("sync-merge"), replace = $("sync-replace"), cancel = $("sync-cancel");
      let done = false, armed = false;
      $("sync-dlg-text").textContent = t(other ? "sync.dlg.textOther" : "sync.dlg.textBoth", {records: tp("sync.records", count)});
      $("sync-dlg-note").textContent = t("sync.dlg.note");
      $("sync-dlg-error").textContent = "";
      replace.textContent = t("sync.dlg.replace");
      const fin = v => { if (done) return; done = true; if (dlg.open) dlg.close(); resolve(v); };
      merge.onclick = () => fin("merge");
      replace.onclick = () => { if (!armed) { armed = true; replace.textContent = t("sync.dlg.replaceConfirm"); return; } fin("replace"); };
      cancel.onclick = () => fin("cancel");
      dlg.oncancel = e => { e.preventDefault(); fin("cancel"); };
      dlg.showModal();
    });
  }
  let onboarding = false;
  async function startOnboarding() {
    if (onboarding || auth.state !== "in") return;
    onboarding = true; syncHold = true; syncUi();
    try {
      const me = auth.me.user.id, other = !!sync.userId && sync.userId !== me;
      const remote = await downloadAll();
      let choice = "merge";
      if (!isLocalEmpty() && remote.records.length) choice = await askSync(remote.records.length, other);
      if (!isLocalEmpty() && !remote.records.length && other) choice = await askSync(0, true);
      if (choice === "cancel") {
        sync = {...syncDefault(), device: sync.device, declined: me};
        saveSync();
        return;
      }
      let parked = {};
      if (remote.records.length) {
        const res = SY.mergeFirst(choice === "replace" ? schema.empty(today()) : state, remote.records);
        applySilently(res.state);
        const byKey = new Map(remote.records.map(r => [keyOf(r), r]));
        for (const s of res.skipped) parked[keyOf(s)] = {rec: byKey.get(keyOf(s)), since: nowISO()};
      }
      const remoteMap = new Map(remote.records.map(r => [keyOf(r), r]));
      const pending = {};
      for (const r of SY.toRecords(state)) {
        const x = remoteMap.get(keyOf(r));
        if (!x || x.updatedAt !== r.updatedAt || x.deleted !== r.deleted || JSON.stringify(x.data) !== JSON.stringify(r.data)) { pendSeq = Math.max(pendSeq + 1, Date.now()); pending[keyOf(r)] = pendSeq; }
      }
      sync = {...syncDefault(), device: sync.device, userId: me, cursor: remote.cursor, pending, parked, lastError: null};
      saveSync();
      if (remote.records.length) toast(t("sync.on"));
    } catch (e) {
      sync.lastError = failure(e); saveSync();
    } finally {
      onboarding = false; syncHold = false; syncUi();
      runSync();
    }
  }
  function syncReset() {
    clearTimeout(syncTimer);
    sync = {...syncDefault(), device: sync.device};
    syncInfo.records = null;
    saveSync();
  }
  async function deleteCloud() {
    if (!deleteArmed) { deleteArmed = true; syncUi(); setTimeout(() => { deleteArmed = false; syncUi(); }, 5000); return; }
    deleteArmed = false;
    try {
      const r = await authFetch("/api/me/data", {method: "DELETE"});
      if (!r.ok) throw {status: r.status, code: r.body && r.body.error};
      const me = auth.me.user.id;
      sync = {...syncDefault(), device: sync.device, declined: me};
      syncInfo.records = null;
      saveSync();
      toast(t("sync.deleted"));
    } catch (e) { sync.lastError = failure(e); saveSync(); }
    syncUi();
  }
  function onSignedIn() {
    if (sync.userId === auth.me.user.id) { runSync(); refreshStats(); }
    else if (sync.declined !== auth.me.user.id) startOnboarding();
  }

  async function authFetch(path, opts = {}) {
    const r = await fetch(path, {credentials: "same-origin", ...opts, headers: {...AUTH_HEADERS, ...(opts.headers || {})}});
    let body = null;
    try { body = await r.json(); } catch {}
    return {ok: r.ok, status: r.status, body};
  }
  async function loadAccount() {
    try {
      const [c, m] = await Promise.all([authFetch("/api/config"), authFetch("/api/me")]);
      if (!c.ok || !c.body || (m.status !== 200 && m.status !== 401)) throw new Error("api");
      auth.config = c.body;
      auth.me = m.status === 200 ? m.body : null;
      auth.state = auth.me ? "in" : "out";
    } catch { auth.state = "offline"; auth.me = null; }
    renderAccount();
    if (auth.state === "in") onSignedIn();
  }
  function authLink(textKey, href) {
    const a = node("a", "bracket", t(textKey)); a.href = href; return a;
  }
  function authButton(textKey, handler) {
    const b = node("button", "bracket", t(textKey)); b.type = "button"; b.addEventListener("click", handler); return b;
  }
  async function authPost(path, method = "POST") {
    try { await authFetch(path, {method}); } catch {}
    return loadAccount();
  }
  function avatarEl(name, url) {
    const letter = node("span", "auth-avatar auth-avatar-letter", ([...String(name || "")][0] || "?").toUpperCase());
    letter.setAttribute("aria-hidden", "true");
    if (!url) return letter;
    const img = node("img", "auth-avatar"); img.src = url; img.alt = t("auth.avatarAlt");
    img.referrerPolicy = "no-referrer";
    img.addEventListener("error", () => img.replaceWith(letter));
    return img;
  }
  function ago(iso) {
    const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
    if (!(s >= 45)) return t("sync.justNow");
    const rtf = new Intl.RelativeTimeFormat(I.locale(), {numeric: "auto", style: "short"});
    if (s < 3600) return rtf.format(-Math.round(s / 60), "minute");
    if (s < 86400) return rtf.format(-Math.round(s / 3600), "hour");
    return rtf.format(-Math.round(s / 86400), "day");
  }
  function syncBox(rows, me) {
    if (sync.userId === me.user.id) {
      const rec = syncInfo.records === null ? "…" : tp("sync.records", syncInfo.records);
      rows.push(node("p", "muted auth-line", sync.lastSync ? t("sync.cloud", {records: rec, when: ago(sync.lastSync)}) : t("sync.cloudNever", {records: rec})));
      if (sync.lastError) rows.push(node("p", "auth-line warn", t("sync.error", {msg: errText(sync.lastError)})));
      const old = parkedOld();
      if (old.length) rows.push(node("p", "auth-line warn", t("sync.parkedOld", {records: tp("sync.records", old.length)})));
      const actions = node("div", "auth-actions");
      actions.append(authButton("sync.now", syncNow), authButton(deleteArmed ? "sync.deleteConfirm" : "sync.deleteCloud", deleteCloud));
      rows.push(actions);
    } else if (sync.declined === me.user.id) {
      rows.push(node("p", "muted auth-line", t("sync.declined")));
      const actions = node("div", "auth-actions");
      actions.append(authButton("sync.enable", () => { sync.declined = null; saveSync(); startOnboarding(); }));
      rows.push(actions);
    }
  }
  // ---- ник в аккаунте ----
  let handleEditing = false, handleDraft = "", handleError = "", handleBusy = false, handleEl = null;
  const HANDLE_OK = /^[a-z0-9_-]{3,24}$/, HANDLE_BAD = ["admin", "root", "api", "support", "finance", "financelog", "system"];
  async function saveHandle() {
    const h = handleDraft.trim().toLowerCase();
    if (!HANDLE_OK.test(h) || HANDLE_BAD.includes(h)) { handleError = t("auth.handleErr.bad"); renderAccount(); return; }
    if (h === auth.me.user.handle) { handleEditing = false; handleError = ""; renderAccount(); return; }
    handleBusy = true;
    try {
      const r = await authFetch("/api/me", {method: "PATCH", headers: {"Content-Type": "application/json"}, body: JSON.stringify({handle: h})});
      if (r.ok) { auth.me.user.handle = h; handleEditing = false; handleError = ""; }
      else handleError = t(r.status === 409 ? "auth.handleErr.taken" : r.status === 400 ? "auth.handleErr.bad" : "auth.handleErr.other");
    } catch { handleError = t("auth.handleErr.other"); }
    handleBusy = false;
    renderAccount();
  }
  function handleRow(me) {
    const key = [me.user.handle, handleEditing, handleError, handleBusy, I.getLang()].join("|");
    if (handleEl && handleEl.dataset.key === key) return handleEl;
    const wrap = node("div", "auth-handle"); wrap.dataset.key = key;
    if (!handleEditing) {
      wrap.append(node("span", "muted", t("auth.handle", {handle: me.user.handle || "…"})));
      wrap.append(authButton("auth.handleEdit", () => { handleEditing = true; handleDraft = me.user.handle || ""; handleError = ""; renderAccount(); }));
    } else {
      wrap.append(node("span", "muted", "-- " + t("auth.handleLabel") + ": @"));
      const inp = node("input"); inp.type = "text"; inp.maxLength = 24; inp.value = handleDraft; inp.autocomplete = "off"; inp.spellcheck = false;
      inp.setAttribute("autocapitalize", "off"); inp.setAttribute("aria-label", t("auth.handleLabel")); inp.disabled = handleBusy;
      inp.addEventListener("input", () => { handleDraft = inp.value.toLowerCase(); });
      inp.addEventListener("keydown", e => {
        if (e.key === "Enter") { e.preventDefault(); saveHandle(); }
        else if (e.key === "Escape") { handleEditing = false; handleError = ""; renderAccount(); }
      });
      wrap.append(inp);
      const save = authButton("auth.handleSave", saveHandle); save.disabled = handleBusy;
      wrap.append(save, authButton("auth.handleCancel", () => { handleEditing = false; handleError = ""; renderAccount(); }));
      if (handleError) { const e = node("div", "auth-line warn", handleError); e.style.flexBasis = "100%"; e.setAttribute("role", "alert"); wrap.append(e); }
      setTimeout(() => { if (wrap.isConnected && !handleBusy) { inp.focus(); const n = inp.value.length; try { inp.setSelectionRange(n, n); } catch {} } }, 0);
    }
    handleEl = wrap;
    return wrap;
  }
  // ---- анимация заголовка (nvim) ----
  let animRun = 0, animating = false, animStarted = false;
  const bEl = {name: $("brand-name"), handle: $("brand-handle"), dd: $("brand-dd"), cursor: $("brand-cursor"), text: $("brand-text")};
  const reduceMotion = () => { try { return matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; } };
  const animOn = () => settings.titleAnim !== false;
  const brandHandle = () => (auth.state === "in" && auth.me && auth.me.user.handle) || "";
  function brandFinal() {
    const h = brandHandle();
    bEl.dd.textContent = ""; bEl.cursor.classList.remove("solid");
    bEl.name.textContent = "finance.log"; bEl.handle.textContent = h ? "@" + h : "";
    // на узком экране finance.log@ник → fl@ник, если не помещается
    if (h && bEl.text.scrollWidth > bEl.text.clientWidth + 1) bEl.name.textContent = "fl";
  }
  const wait = ms => new Promise(r => setTimeout(r, ms));
  async function playBrand() {
    const id = ++animRun, alive = () => id === animRun;
    animStarted = true;
    if (reduceMotion() || !animOn()) { animating = false; brandFinal(); return; }
    animating = true;
    const solid = on => bEl.cursor.classList.toggle("solid", on);
    const dd = async () => {
      bEl.dd.textContent = "dd"; await wait(350); if (!alive()) return;
      bEl.name.textContent = ""; bEl.handle.textContent = ""; bEl.dd.textContent = "";
    };
    const type = async (str, el, tail) => {
      solid(true);
      for (const ch of Array.from(str)) {
        if (!alive()) return;
        el.textContent += ch;
        await wait(55 + Math.random() * 20);
      }
      if (tail !== false) solid(false);
    };
    bEl.name.textContent = "finance.log"; bEl.handle.textContent = ""; bEl.dd.textContent = ""; solid(false);
    await wait(2200); if (!alive()) return;          // два мигания курсора
    for (const [key, pause] of [["brand.p1", 1200], ["brand.p2", 1000]]) {
      await dd(); if (!alive()) return;
      await type(t(key), bEl.name); if (!alive()) return;
      await wait(pause); if (!alive()) return;
    }
    await dd(); if (!alive()) return;
    for (let w = 0; auth.state === "loading" && w < 3000; w += 100) { await wait(100); if (!alive()) return; }
    await type("finance.log", bEl.name, false); if (!alive()) return;
    const h = brandHandle();
    if (h) await type("@" + h, bEl.handle, false);
    if (!alive()) return;
    animating = false; brandFinal();
  }
  function applyAnim() {
    const a = $("anim-toggle");
    a.setAttribute("aria-checked", String(animOn()));
    a.classList.toggle("selected", animOn());
  }
  $("anim-toggle").addEventListener("click", () => {
    persistNotice(boot.set({titleAnim: !animOn()}));
    settings = boot.get(); applyAnim();
    if (animOn()) playBrand(); else { animRun++; animating = false; brandFinal(); }
  });
  $("brand-text").closest("a").addEventListener("click", e => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
    if (!animOn() || reduceMotion()) return;
    e.preventDefault(); playBrand();
  });
  window.addEventListener("resize", () => { if (!animating) brandFinal(); });
  function renderAccount() {
    if (!animating && animStarted) brandFinal();
    renderIndicator();
    renderNotes();
    const box = $("auth-box");
    if (!box) return;
    const rows = [];
    if (auth.error) rows.push(node("p", "auth-line warn", ["identity_in_use", "access_denied", "last_identity"].includes(auth.error) ? t("auth.err." + auth.error) : t("auth.err.other", {code: auth.error})));
    if (auth.state === "loading") rows.push(node("p", "muted auth-line", t("auth.loading")));
    else if (auth.state === "offline") rows.push(node("p", "muted auth-line", t("auth.offline")));
    else if (auth.state === "out") {
      rows.push(node("p", "muted auth-line", t("auth.loggedOut")));
      const actions = node("div", "auth-actions");
      if (auth.config.google) actions.append(authLink("auth.google", "/api/auth/google/start"));
      if (auth.config.telegram) actions.append(authLink("auth.telegram", "/api/auth/telegram/start"));
      rows.push(actions);
    } else {
      const me = auth.me, byProvider = {};
      for (const i of me.identities) byProvider[i.provider] = i;
      const head = node("div", "auth-user");
      const display = me.user.name || (byProvider.google && byProvider.google.email) || (byProvider.telegram && byProvider.telegram.email) || "—";
      head.append(avatarEl(display, me.user.avatar), node("span", "", display));
      rows.push(head);
      rows.push(handleRow(me));
      const g = byProvider.google, tg = byProvider.telegram, none = t("auth.none");
      rows.push(node("p", "muted auth-line", t("auth.providers", {google: g ? (g.email || g.name || "✓") : none, telegram: tg ? (tg.email || tg.name || "✓") : none})));
      syncBox(rows, me);
      const actions = node("div", "auth-actions");
      if (!g && auth.config.google) actions.append(authLink("auth.linkGoogle", "/api/auth/google/start?link=1"));
      if (!tg && auth.config.telegram) actions.append(authLink("auth.linkTelegram", "/api/auth/telegram/start?link=1"));
      actions.append(authButton("auth.logout", () => { syncReset(); authPost("/api/auth/logout"); }));
      actions.append(authButton("auth.logoutAll", () => { syncReset(); authPost("/api/auth/logout-all"); }));
      rows.push(actions);
    }
    const hadFocus = handleEl && handleEl.contains(document.activeElement) ? handleEl.querySelector("input") : null;
    box.replaceChildren(...rows);
    if (hadFocus) hadFocus.focus();
  }
  $("sync-indicator").addEventListener("click", () => {
    const st = syncStatus();
    if (st === "err" && auth.state === "in") syncNow();
    else if (st === "err" && auth.state !== "in") loadAccount().then(() => { if (auth.state === "out") setTab("settings"); });
    else setTab("settings");
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    if (sync.userId && auth.state !== "in") loadAccount(); else runSync();
  });
  window.addEventListener("online", () => { if (sync.userId && auth.state !== "in") loadAccount(); else runSync(); });
  window.addEventListener("offline", syncUi);
  setInterval(() => {
    if (document.hidden || !sync.userId) return;
    if (auth.state !== "in") loadAccount(); else { runSync(); renderAccount(); }
  }, 60000);
  function handleAuthReturn() {
    const q = new URLSearchParams(location.search), code = q.get("auth_error");
    if (!code) return;
    auth.error = code.replace(/[^a-z_]/g, "");
    history.replaceState(null, "", location.pathname + location.hash);
  }

  // ---------- фильтр журнала по дню ----------
  function renderDayBar() {
    $("day-bar").hidden = !dayFilter;
    if (dayFilter) $("day-bar-text").textContent = t("filter.dayBar", {day: anDay(dayFilter)});
  }
  function showDay(day, type) {
    dayFilter = day; catFilter = "all"; $("search").value = ""; $("account-filter").value = "all";
    const f = document.querySelector(`.filter[data-filter="${type}"]`); if (f) f.click();
    showScreen("journal");
  }
  $("day-bar-clear").addEventListener("click", () => { dayFilter = null; renderDayBar(); renderEntries(); });

  // ---------- вкладка «анализ» ----------
  const an = {span: "month", offset: 0, heat: "expense", items: "cents", open: new Set(), day: null};
  const SPAN_N = {month: 1, "3m": 3, year: 12};
  const iso8 = d => d.toISOString().slice(0, 10);
  const utcDate = d => new Date(d + "T00:00:00Z");
  const addDays = (d, n) => iso8(new Date(utcDate(d).getTime() + n * 864e5));
  const lowerEn = text => I.getLang() === "en" ? text.toLowerCase() : text;
  const dtf = (opts, d) => new Intl.DateTimeFormat(I.locale(), {timeZone: "UTC", ...opts}).format(utcDate(d));
  const monthShort = d => lowerEn(dtf({month: "short"}, d)).replace(/\./g, "");
  // «20 окт» (с годом, если он не текущий)
  function anDay(d) {
    const base = `${utcDate(d).getUTCDate()} ${monthShort(d)}`;
    return d.slice(0, 4) === today().slice(0, 4) ? base : `${base} ${d.slice(0, 4)}`;
  }
  const monthYear = d => lowerEn(dtf({month: "long", year: "numeric"}, d)).replace(/\s?г\.$/, "");
  const numPlain = c => money(c).replace(/\s₽$/, "").replace(/[,.]00$/, "");
  function anRange() {
    const [y, m] = today().slice(0, 7).split("-").map(Number), n = SPAN_N[an.span];
    const last = m - 1 + an.offset * n;
    const from = iso8(new Date(Date.UTC(y, last - n + 1, 1))), end = iso8(new Date(Date.UTC(y, last + 1, 0)));
    return {from, end, to: end > today() ? today() : end};
  }
  function deltaEl(d, goodUp) {
    const el = node("span", "an-delta");
    if (d === null || d === undefined) return el;
    const up = d > 0, good = d === 0 ? null : up === goodUp;
    el.textContent = `${d === 0 ? "=" : up ? "▲" : "▼"} ${Math.abs(d).toLocaleString(I.locale(), {maximumFractionDigits: 1})}%`;
    if (good !== null) el.classList.add(good ? "good" : "bad");
    return el;
  }
  function renderAnSummary(sum) {
    const defs = [["expense", false, money], ["income", true, money], ["net", true, signed], ["avgPerDay", false, money], ["avgCheck", false, money]];
    $("an-summary").replaceChildren(...defs.map(([k, goodUp, fmt]) => {
      const el = node("div", "an-stat");
      el.append(node("span", "an-stat-l", t("an.sum." + k)), node("strong", "an-stat-v", fmt(sum[k])), deltaEl(sum.delta[k], goodUp));
      return el;
    }));
  }
  // ----- тепловая карта -----
  const HM = {c: 11, g: 3, top: 16, weeks: 53};
  function heatData() {
    const end = today(), dow = (utcDate(end).getUTCDay() + 6) % 7;
    const start = addDays(end, -dow - (HM.weeks - 1) * 7);
    const vals = A.daily(state, {from: start, to: end, type: an.heat});
    const counts = {};
    for (const o of state.operations) if (!o.deleted && o.type === an.heat && o.date >= start && o.date <= end) counts[o.date] = (counts[o.date] || 0) + 1;
    return {start, end, vals, counts};
  }
  function renderAnHeat() {
    const {start, end, vals} = heatData(), th = A.heatLevels(vals), P = HM.c + HM.g;
    const w = HM.weeks * P - HM.g, h = HM.top + 7 * P - HM.g;
    let out = `<svg class="hm-svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${t("an.heatAria")}">`, lastLabel = -9;
    for (let c = 0; c < HM.weeks; c++) {
      const mon = addDays(start, c * 7);
      let label = null;
      for (let i = 0; i < 7; i++) { const d = addDays(mon, i); if (d.endsWith("-01")) label = d; }
      if (!label && c === 0 && Number(mon.slice(8)) <= 20) label = mon;
      if (label && c - lastLabel >= 3) { out += `<text class="hm-m" x="${c * P}" y="10">${monthShort(label)}</text>`; lastLabel = c; }
      for (let i = 0; i < 7; i++) {
        const d = addDays(mon, i); if (d > end) break;
        out += `<rect class="hm-c hm-l${A.levelOf(vals[d] || 0, th)}${d === an.day ? " sel" : ""}" data-d="${d}" x="${c * P}" y="${HM.top + i * P}" width="${HM.c}" height="${HM.c}" rx="2"/>`;
      }
    }
    $("an-heat").innerHTML = out + "</svg>";
    const names = [];
    for (let i = 0; i < 7; i++) names.push(`<div>${i % 2 === 0 && i < 5 ? lowerEn(dtf({weekday: "short"}, addDays("2024-01-01", i))).replace(/\./g, "") : ""}</div>`);
    $("an-heat-days").innerHTML = names.join("");
    // подпись под картой
    const first = state.operations.filter(o => !o.deleted && o.type === an.heat).reduce((m, o) => o.date < m ? o.date : m, end);
    const from = first > start ? first : start;
    let none = 0, best = null;
    for (let d = from; d <= end; d = addDays(d, 1)) if (!vals[d]) none++;
    for (const [d, v] of Object.entries(vals)) if (!best || v > best[1] || (v === best[1] && d > best[0])) best = [d, v];
    $("an-heat-stats").textContent = t("an.heatStats", {noneLabel: t("an.none." + an.heat), n: none, maxLabel: t("an.max." + an.heat)}) + (best ? ` ${anDay(best[0])}, ${money(best[1])}` : " —");
    renderAnTip();
    if (anFresh) { const sc = $("an-heat-scroll"); sc.scrollLeft = sc.scrollWidth; }
  }
  function renderAnTip() {
    const d = an.day, tip = $("an-tip-text"), btn = $("an-tip-show");
    tip.classList.toggle("hint", !d);
    if (!d) { tip.textContent = t("an.tipHint"); btn.hidden = true; return; }
    const {vals, counts} = heatData(), n = counts[d] || 0;
    tip.textContent = t("an.tip", {day: anDay(d), sum: money(vals[d] || 0), ops: n ? tp("journal.count", n) : t("an.noOps")});
    btn.hidden = !n;
  }
  $("an-heat").addEventListener("click", ev => {
    const r = ev.target.closest("rect[data-d]"); if (!r) return;
    an.day = r.dataset.d;
    document.querySelectorAll("#an-heat rect.sel").forEach(x => x.classList.remove("sel"));
    r.classList.add("sel");
    renderAnTip();
  });
  $("an-tip-show").addEventListener("click", () => { if (an.day) showDay(an.day, an.heat); });
  // ----- полосы -----
  const barSvg = (pct, cls = "") => `<svg class="an-bar ${cls}" width="100%" height="6" aria-hidden="true"><rect class="an-track" width="100%" height="6" rx="3"/><rect class="an-fill" width="${Math.max(0, Math.min(100, pct)).toFixed(2)}%" height="6" rx="3"/></svg>`;
  const pctText = share => Math.round(share * 100) + "%";
  function catRowEl(r, child, expandable) {
    const c = r.id ? catById(r.id) : null;
    const el = node(expandable ? "button" : "div", `an-row an-cat${child ? " child" : ""}`);
    if (expandable) { el.type = "button"; el.setAttribute("aria-expanded", String(an.open.has(r.id))); el.dataset.id = r.id; }
    const name = node("span", "an-name", (child ? "└ " : expandable ? (an.open.has(r.id) ? "▾ " : "▸ ") : "") + (c ? catName(c) : t("cat.none")));
    const share = node("span", "an-share", pctText(r.share));
    el.append(name, node("span", "an-val", money(r.cents)), share, r.prevCents || r.cents ? deltaEl(r.delta, false) : node("span", "an-delta"));
    el.insertAdjacentHTML("beforeend", barSvg(r.share * 100));
    return el;
  }
  function renderAnCats(range) {
    const rows = A.byCategory(state, {from: range.from, to: range.to, parent: true}), els = [];
    for (const r of rows) {
      const kids = r.children || [];
      els.push(catRowEl(r, false, kids.length > 0));
      if (kids.length && an.open.has(r.id)) kids.forEach(k => els.push(catRowEl(k, true, false)));
    }
    $("an-cats").replaceChildren(...els);
    $("an-cats-sec").hidden = !rows.length;
  }
  $("an-cats").addEventListener("click", ev => {
    const b = ev.target.closest("button.an-row"); if (!b) return;
    an.open.has(b.dataset.id) ? an.open.delete(b.dataset.id) : an.open.add(b.dataset.id);
    renderAnCats(anRange());
  });
  function renderAnMerchants(range) {
    const rows = A.byMerchant(state, {from: range.from, to: range.to, limit: 10});
    $("an-merchants").replaceChildren(...rows.map(r => {
      const el = node("div", "an-line");
      el.append(node("span", "an-name", r.merchant), node("span", "an-val", money(r.cents)),
        node("span", "an-sub", t("an.merchantSub", {n: r.count, avg: money(r.avgCheck), last: anDay(r.lastDate)})));
      return el;
    }));
    $("an-merchants-sec").hidden = !rows.length;
  }
  function renderAnItems(range) {
    const rows = A.byItem(state, {from: range.from, to: range.to, limit: 10, sort: an.items});
    $("an-items-sec").hidden = !rows.length;
    document.querySelectorAll("[data-an-items]").forEach(b => { const on = b.dataset.anItems === an.items; b.classList.toggle("active", on); b.setAttribute("aria-pressed", String(on)); });
    $("an-items").replaceChildren(...rows.map(r => {
      const u = unitLabel(priceUnit(r.unit)), same = r.firstUnitPrice === r.lastUnitPrice || r.priceDelta === null;
      const el = node("div", "an-line"), sub = node("span", "an-sub");
      sub.append(document.createTextNode(`${r.count}× · ${same ? numPlain(r.lastUnitPrice) : numPlain(r.firstUnitPrice) + "→" + numPlain(r.lastUnitPrice)} ₽/${u}`));
      if (!same) { sub.append(document.createTextNode(" ")); sub.append(deltaEl(r.priceDelta, false)); }
      el.append(node("span", "an-name", r.name), node("span", "an-val", money(r.cents)), sub);
      return el;
    }));
  }
  // ----- по месяцам -----
  function niceMax(v) {
    if (v <= 0) return 100;
    const p = Math.pow(10, Math.floor(Math.log10(v))), f = v / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
  }
  const compact = cents => I.isPrivacy() ? I.MASK : new Intl.NumberFormat(I.locale(), {notation: "compact", maximumFractionDigits: 1}).format(cents / 100);
  function renderAnMonths(range) {
    const list = A.monthly(state, {months: 12, to: range.to});
    const W = Math.max(280, Math.floor($("an-months").clientWidth || 320)), H = 156, top = 14, bot = 20, ph = H - top - bot;
    const max = niceMax(Math.max(...list.map(r => Math.max(r.expense, r.income)))), col = W / 12, bw = Math.min(18, col * 0.5);
    const y = v => top + ph - v / max * ph;
    const from = range.from.slice(0, 7), to = range.to.slice(0, 7), dim = list.some(r => r.month < from || r.month > to);
    let out = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="group" aria-label="${t("an.monthsAria")}">`;
    for (const g of [1, 0.5]) out += `<line class="ch-grid" x1="0" x2="${W}" y1="${y(max * g)}" y2="${y(max * g)}"/><text class="ch-t" x="0" y="${y(max * g) - 3}">${compact(max * g)}</text>`;
    out += `<line class="ch-base" x1="0" x2="${W}" y1="${top + ph}" y2="${top + ph}"/>`;
    const pts = [];
    list.forEach((r, i) => {
      const cx = col * i + col / 2, on = !dim || (r.month >= from && r.month <= to), d = r.month + "-01";
      const label = `${monthYear(d)}: ${t("an.sum.expense")} ${money(r.expense)}, ${t("an.sum.income")} ${money(r.income)}`;
      out += `<g class="ch-col${on ? "" : " dim"}" data-m="${r.month}" role="button" tabindex="0" aria-label="${label}"><title>${label}</title><rect class="ch-hit" x="${col * i}" y="0" width="${col}" height="${H}"/>`;
      if (r.expense > 0) {
        const bh = Math.max(2, r.expense / max * ph), by = top + ph - bh, rr = Math.min(4, bw / 2, bh);
        out += `<path class="ch-bar" d="M${cx - bw / 2},${top + ph}V${by + rr}Q${cx - bw / 2},${by} ${cx - bw / 2 + rr},${by}H${cx + bw / 2 - rr}Q${cx + bw / 2},${by} ${cx + bw / 2},${by + rr}V${top + ph}Z"/>`;
      }
      out += `<text class="ch-t ch-m" x="${cx}" y="${H - 5}" text-anchor="middle">${monthShort(d).slice(0, 3)}</text></g>`;
      pts.push([cx, y(r.income), r.income, on]);
    });
    out += `<polyline class="ch-line" points="${pts.map(p => p[0] + "," + p[1]).join(" ")}"/>`;
    for (const p of pts) if (p[2] > 0) out += `<circle class="ch-dot${p[3] ? "" : " dim"}" cx="${p[0]}" cy="${p[1]}" r="3.5"/>`;
    $("an-months").innerHTML = out + "</svg>";
    const top1 = list.reduce((b, r) => r.expense > b.expense ? r : b, list[0]);
    $("an-months-note").textContent = top1.expense ? t("an.monthsMax", {month: monthYear(top1.month + "-01"), sum: money(top1.expense)}) : "";
  }
  function pickMonth(ym) {
    const [y, m] = today().slice(0, 7).split("-").map(Number), [y2, m2] = ym.split("-").map(Number);
    an.span = "month"; an.offset = (y2 - y) * 12 + (m2 - m); an.day = null;
    renderAnalytics();
  }
  $("an-months").addEventListener("click", ev => { const g = ev.target.closest("[data-m]"); if (g) pickMonth(g.dataset.m); });
  $("an-months").addEventListener("keydown", ev => { const g = ev.target.closest && ev.target.closest("[data-m]"); if (g && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); pickMonth(g.dataset.m); } });
  // ----- дни недели -----
  function renderAnWeekday(range) {
    const rows = A.weekday(state, {from: range.from, to: range.to}), max = Math.max(...rows.map(r => r.avgCents), 1);
    $("an-weekdays").replaceChildren(...rows.map(r => {
      const el = node("div", "an-row an-wd");
      el.append(node("span", "an-name", lowerEn(dtf({weekday: "short"}, addDays("2024-01-01", r.weekday))).replace(/\./g, "")), node("span", "an-val", money(r.avgCents)));
      el.insertAdjacentHTML("beforeend", barSvg(r.avgCents / max * 100));
      return el;
    }));
  }
  function renderAnalytics() {
    const range = anRange(), sum = A.summary(state, {from: range.from, to: range.to});
    document.querySelectorAll("[data-an-span]").forEach(b => { const on = b.dataset.anSpan === an.span; b.classList.toggle("active", on); b.setAttribute("aria-pressed", String(on)); });
    $("an-next").disabled = an.offset >= 0;
    $("an-prev").disabled = an.offset <= -120;
    document.querySelectorAll("[data-an-heat]").forEach(b => { const on = b.dataset.anHeat === an.heat; b.classList.toggle("active", on); b.setAttribute("aria-pressed", String(on)); });
    const span = (f, e) => `${anDay(f)}–${anDay(e)}`;
    $("an-vs").textContent = t("an.vs", {cur: span(range.from, range.to), prev: span(sum.prev.from, sum.prev.to)});
    renderAnSummary(sum);
    const empty = !sum.ops && !sum.income;
    $("an-empty").hidden = !empty;
    renderAnHeat();
    renderAnCats(range); renderAnMerchants(range); renderAnItems(range); renderAnWeekday(range);
    $("an-weekdays-sec").hidden = empty;
    renderAnMonths(range);
    anFresh = false;
  }
  document.querySelectorAll("[data-an-span]").forEach(b => b.addEventListener("click", () => { an.span = b.dataset.anSpan; an.offset = 0; renderAnalytics(); }));
  $("an-prev").addEventListener("click", () => { an.offset--; renderAnalytics(); });
  $("an-next").addEventListener("click", () => { if (an.offset < 0) { an.offset++; renderAnalytics(); } });
  document.querySelectorAll("[data-an-heat]").forEach(b => b.addEventListener("click", () => { an.heat = b.dataset.anHeat; renderAnalytics(); }));
  document.querySelectorAll("[data-an-items]").forEach(b => b.addEventListener("click", () => { an.items = b.dataset.anItems; renderAnItems(anRange()); }));
  $("analytics-nav").addEventListener("click", () => setTab("analytics"));
  let anResize = null;
  window.addEventListener("resize", () => { if (tab !== "analytics") return; clearTimeout(anResize); anResize = setTimeout(() => renderAnMonths(anRange()), 120); });

  function applyLanguage() {
    I.setLang(I.resolve(settings.lang));
    I.applyI18n();
    $("today-label").textContent = I.fmtDate(new Date(),"short");
    updateThemeButton();
    renderSettings();
    renderAccount();
    applyPrivacy();
    applyHints();
    render();
    DP.refreshAll();
    if (!$("entry-form").classList.contains("date-open")) updateDateSummary();
    updateRecon();
  }
  boot.onChange(()=>{ updateThemeButton(); renderSettings(); });
  document.querySelectorAll("[data-set-lang]").forEach(b=>b.addEventListener("click",()=>{
    persistNotice(boot.set({lang: b.dataset.setLang}));
    settings = boot.get(); applyLanguage();
  }));
  document.querySelectorAll("[data-set-mode]").forEach(b=>b.addEventListener("click",()=>persistNotice(boot.set({themeMode: b.dataset.setMode}))));
  $("privacy-button").addEventListener("click",togglePrivacy);
  $("hints-toggle").addEventListener("click",toggleHints);
  $("privacy-on-start").addEventListener("click",()=>{ persistNotice(boot.set({privacyOnStart: !settings.privacyOnStart})); settings = boot.get(); applyPrivacy(); });
  // двойной тап (клик) по большой сумме остатка переключает режим
  [$("balance"), $("account-balance")].forEach(el => {
    let last = 0;
    el.addEventListener("click", () => { const now = Date.now(); if (now - last < 400) { last = 0; togglePrivacy(); } else last = now; });
  });
  $("theme-button").addEventListener("click",()=>persistNotice(boot.set({themeMode: boot.resolve().dark ? "light" : "dark"})));
  $("settings-nav").addEventListener("click",()=>setTab("settings"));
  $("more-settings").addEventListener("click",()=>setTab("settings"));
  $("settings-back").addEventListener("click",()=>setTab("more"));
  window.addEventListener("storage",event=>{
    if(event.key!==KEY)return;
    try {
      state=event.newValue===null ? schema.empty(today()) : schema.migrate(JSON.parse(event.newValue),today());
      locked=false;$("storage-error").hidden=true;render();
      toast(t("msg.otherTab"));
    } catch {locked=true;storageError(t("err.otherTab"));}
  });
  document.addEventListener("keydown",event=>{
    if(event.ctrlKey||event.metaKey||event.altKey||document.querySelector("dialog[open]"))return;
    if(event.key==="Escape"){dismissAny();$("amount").blur();return;}
    if(activeSheet)return;
    if(["INPUT","TEXTAREA","SELECT"].includes(event.target.tagName)||event.target.isContentEditable)return;
    if(event.code==="KeyN"){event.preventDefault();startNew();}
  });
  window.addEventListener("storage",event=>{
    if(event.key!==SYNC_KEY||syncing||event.newValue===null)return;
    try { sync={...syncDefault(),...JSON.parse(event.newValue)}; renderAccount(); } catch {}
  });
  window.addEventListener("storage",event=>{
    if(event.key!==boot.KEY)return;
    settings=boot.get();
    if(I.resolve(settings.lang)!==I.getLang())applyLanguage();else { renderSettings(); syncPrivacy(); applyHints(); applyAnim(); }
  });
  handleAuthReturn();
  applyLanguage();
  applyAnim();
  playBrand();
  loadAccount();
  if (location.hash === "#settings") setTab("settings");
  resetForm();
  if ("serviceWorker" in navigator) {
    // новая версия: sw делает skipWaiting + clients.claim → controllerchange → один раз перезагрузить страницу
    const hadController = !!navigator.serviceWorker.controller;
    let reloading = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!hadController || reloading) return;
      reloading = true; location.reload();
    });
    navigator.serviceWorker.register("sw.js", {updateViaCache: "none"}).then(reg => {
      const check = () => reg.update().catch(()=>{});
      document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") check(); });
      setInterval(check, 30 * 60 * 1000);
    }).catch(()=>{});
  }
})();
