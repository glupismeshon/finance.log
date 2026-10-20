"use strict";
(() => {
  const {money: M, schema, journal, views, accounts: acct, categories: cats, suggest, i18n: I, boot} = globalThis.MoneyCore;
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
  const opCat = op => { const id = op.allocations[0] && op.allocations[0].categoryId; return id ? catById(id) : null; };
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
    state = checked;
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
    renderFormSuggest();
  }
  // ---------- подсказки в форме: где / категория ----------
  function renderFormSuggest() {
    const type = mode;
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
  function resetForm(focus = false) {
    editing = null;
    $("entry-form").reset();
    selCat = null; catTouched = false; accTouched = false;
    toggleCategoryTree(false);
    $("date").value = today();
    $("date").max = today();
    $("form-error").textContent = "";
    $("cancel-edit").hidden = true;
    $("delete-entry").hidden = true;
    $("entry-form").classList.remove("date-open");
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
    toggleCategoryTree(false);
    $("cancel-edit").hidden = false;
    $("delete-entry").hidden = false;
    $("form-error").textContent = "";
    $("entry-form").classList.remove("date-open");
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
    const c = opCat(entry);
    return !!c && (c.id === catFilter || c.parentId === catFilter);
  }
  function renderEntries() {
    const query = $("search").value.trim().toLocaleLowerCase(I.locale());
    const accFilter = effectiveAccount(), onAcc = accFilter !== "all";
    const entries = state.operations.filter(e => e.deleted === trash && (filter === "all" || e.type === filter) && (!onAcc || e.legs.some(l => l.accountId === accFilter)) && catMatch(e) &&
      (!query || `${I.stored(e.note)} ${e.merchant || ""} ${opCat(e) ? catPath(opCat(e)) : ""} ${amountInput(amountOf(e))} ${e.legs.map(l => accName(l.accountId)).join(" ")}`.toLocaleLowerCase(I.locale()).includes(query)))
      .sort((a,b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    $("entry-count").textContent = tp("journal.count", entries.length);
    const container = $("entries"); container.replaceChildren();
    if (!entries.length) {
      const empty = node("div","empty-state");
      const filtered = query || filter !== "all" || catFilter !== "all";
      const line = (tag, cls, text) => { const p = node("div"); p.append(node("span",`tag ${cls}`,tag),document.createTextNode(text)); return p; };
      empty.append(node("div","prompt","money.log"));
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
      if (cat) {
        const link = node("button","bracket cat-link",catPath(cat)); link.type = "button";
        link.setAttribute("aria-label",t("filter.catTap",{name: catPath(cat)}));
        link.addEventListener("click",ev=>{ ev.stopPropagation(); setCatFilter(cat.id); });
        metaText.append(link,document.createTextNode([accText,trash ? t("row.deleted") : ""].filter(Boolean).map(x=>" · "+x).join("")));
      } else metaText.textContent = [label,accText,trash ? t("row.deleted") : ""].filter(Boolean).join(" · ");
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
    setNav($("accounts-nav"), tab === "accounts" && !currentAccount);
    document.querySelectorAll("#nav-accounts .qv").forEach(el => setNav(el, tab === "accounts" && el.dataset.id === currentAccount));
    $("journal-title").textContent = t(trash ? "nav.trash" : "nav.journal");
    $("page-label").textContent = trash ? t("nav.trash") : tab === "accounts" ? (currentAccount ? accName(currentAccount) : t("page.accounts")) : t({journal: "nav.journal", plans: "page.plans", more: "page.more", settings: "nav.settings", categories: "nav.categories"}[tab]);
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
    renderEntries();
  }
  function showScreen(name, accountId = null, isTrash = false) {
    if (activeSheet) dismissAny();
    tab = name; currentAccount = accountId; trash = isTrash;
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
    $("recon-date").value = today(); $("recon-date").max = today();
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
      const amountCents = M.parseAmount($("amount").value);
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
        if (previous) next = journal.upsertOperation(state,{...previous,type:"transfer",date,note,deleted:false,legs,allocations:[]},now);
        else {
          const transfer = journal.makeTransfer({id:newId(),fromId:accountId,toId,amountCents,date,note,now});
          next = journal.upsertOperation(state,transfer,now);
          const feeRaw = $("fee").value.trim();
          if (feeRaw) next = journal.upsertOperation(next,journal.makeFee({id:newId(),transferId:transfer.id,accountId,amountCents:M.parseAmount(feeRaw),date,now}),now);
        }
        done = t(previous ? "msg.changesSaved" : "msg.transferDone");
      } else {
        const entry = {...previous,id:previous?.id || newId(),type:mode,date,note,createdAt:previous?.createdAt || now,deleted:false,
          legs:[{accountId,amountCents:mode === "income" ? amountCents : -amountCents}],
          allocations:mode === "income" ? (selCat ? [{categoryId:selCat,amountCents}] : []) : [{categoryId:selCat,amountCents}]};
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
    $("date").focus();
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
      download(raw,`money-log-${today()}${locked ? "-recovery" : ""}.json`);
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
      $(`themes-${group}`).replaceChildren(...boot.themes().filter(x => x.dark === (group === "dark")).map(x => themeRow(x,group)));
    }
  }
  function applyLanguage() {
    I.setLang(I.resolve(settings.lang));
    I.applyI18n();
    $("today-label").textContent = I.fmtDate(new Date(),"short");
    updateThemeButton();
    renderSettings();
    render();
    if (!$("entry-form").classList.contains("date-open")) updateDateSummary();
    updateRecon();
  }
  boot.onChange(()=>{ updateThemeButton(); renderSettings(); });
  document.querySelectorAll("[data-set-lang]").forEach(b=>b.addEventListener("click",()=>{
    persistNotice(boot.set({lang: b.dataset.setLang}));
    settings = boot.get(); applyLanguage();
  }));
  document.querySelectorAll("[data-set-mode]").forEach(b=>b.addEventListener("click",()=>persistNotice(boot.set({themeMode: b.dataset.setMode}))));
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
    if(event.key!==boot.KEY)return;
    settings=boot.get();
    if(I.resolve(settings.lang)!==I.getLang())applyLanguage();else renderSettings();
  });
  applyLanguage();
  resetForm();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(()=>{});
})();
