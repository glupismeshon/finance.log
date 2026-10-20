"use strict";
(() => {
  const {money: M, schema, journal, views, accounts: acct} = globalThis.MoneyCore;
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
  const mobileQuery = window.matchMedia("(max-width: 599px)");
  const isMobile = () => mobileQuery.matches;
  function todayISO() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  }
  const today = todayISO;
  const accById = id => state.accounts.find(a => a.id === id);
  const accName = id => accById(id)?.name || "?";
  const firstActive = () => (acct.activeAccounts(state)[0] || state.accounts[0]).id;
  const amountOf = op => Math.abs(op.legs[0].amountCents);
  const money = cents => (cents < 0 ? "−" : "") + new Intl.NumberFormat("ru-RU", {minimumFractionDigits:2,maximumFractionDigits:2}).format(Math.abs(cents) / 100) + " ₽";
  const signed = cents => (cents > 0 ? "+" : "") + money(cents);
  const amountInput = cents => (cents / 100).toFixed(2).replace(".",",");
  const dateLabel = value => new Intl.DateTimeFormat("ru-RU", {day:"numeric",month:"long",year:"numeric"}).format(new Date(value+"T12:00:00"));
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
    storageError("Не удалось прочитать сохранённый журнал. Исходные данные не изменены. Запись отключена; кнопка «Скачать копию» сохранит исходные данные для восстановления.");
  }
  function commit(next) {
    if (locked) throw new Error("Сначала нужно восстановить доступ к сохранённому журналу.");
    const checked = schema.validate(next);
    try { localStorage.setItem(KEY, JSON.stringify(checked)); }
    catch { throw new Error("Не удалось сохранить. Проверьте свободное место и разрешение браузера на хранение данных. Запись не добавлена."); }
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
    select.replaceChildren(...list.map(a => { const o = document.createElement("option"); o.value = a.id; o.textContent = a.archived ? `${a.name} (архив)` : a.name; return o; }));
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
    $("account-select-label").textContent = type === "income" ? "куда" : "откуда";
    const word = {income: "доход", expense: "расход", transfer: "перевод"}[type];
    $("save-button").firstElementChild.textContent = isMobile() ? "записать" : editing ? "Сохранить изменения" : `Записать ${word}`;
    $("form-title").textContent = editing ? (isMobile() ? "изменить" : "изменить запись") : isMobile() ? ({income: "пришло", expense: "ушло", transfer: "перевод"}[type]) : "новая запись";
    $("note").placeholder = type === "income" ? "Например, зарплата" : type === "transfer" ? "Например, на накопления" : "Например, кофе по дороге";
  }
  function resetForm(focus = false) {
    editing = null;
    $("entry-form").reset();
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
    $("date-summary").textContent = !value || value === today() ? "сегодня" : M.validDate(value) ? dateLabel(value) : value;
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
      toast("Запись перемещена в удалённые.",entry.id);
    } catch(e){toast(e.message);}
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
  function renderEntries() {
    const query = $("search").value.trim().toLocaleLowerCase("ru");
    const accFilter = effectiveAccount(), onAcc = accFilter !== "all";
    const entries = state.operations.filter(e => e.deleted === trash && (filter === "all" || e.type === filter) && (!onAcc || e.legs.some(l => l.accountId === accFilter)) &&
      (!query || `${e.note} ${amountInput(amountOf(e))} ${e.legs.map(l => accName(l.accountId)).join(" ")}`.toLocaleLowerCase("ru").includes(query)))
      .sort((a,b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    $("entry-count").textContent = `${entries.length} ${countWord(entries.length)}`;
    const container = $("entries"); container.replaceChildren();
    if (!entries.length) {
      const empty = node("div","empty-state");
      const filtered = query || filter !== "all";
      const line = (tag, cls, text) => { const p = node("div"); p.append(node("span",`tag ${cls}`,tag),document.createTextNode(text)); return p; };
      empty.append(node("div","prompt","money.log"));
      if (filtered) {
        empty.append(line("[--]","warn","ничего не найдено"),node("div","muted","// попробуйте другой поиск или выберите [ все ]"));
      } else if (trash) {
        empty.append(line("[ok]","ok","удалённых записей нет"),node("div","muted","// удалённые операции остаются здесь, их можно вернуть"));
      } else if (onAcc) {
        empty.append(line("[ok]","ok","по этому счёту записей нет"));
      } else {
        empty.append(line("[ok]","ok","журнал загружен"),line("[ok]","ok","записей пока нет"));
        const button = node("button","btn primary","+ первая запись"); button.type = "button";
        button.addEventListener("click",()=>startNew()); empty.append(button);
      }
      container.append(empty); return;
    }
    let lastDate = "";
    for (const entry of entries) {
      if (entry.date !== lastDate) {
        if (lastDate !== "") container.append(node("div","ovdiv"));
        lastDate = entry.date;
        container.append(node("div","shead",entry.date === today() ? `сегодня · ${dateLabel(entry.date)}` : dateLabel(entry.date)));
      }
      const row = node("article","todo"); row.dataset.id = entry.id;
      const route = entry.type === "transfer" ? `${accName(opFrom(entry))} → ${accName(opTo(entry))}` : "";
      const label = {income: "доход", expense: "расход", transfer: "перевод", adjustment: "сверка"}[entry.type];
      const accText = entry.type === "transfer" ? (entry.note ? route : "") : accName(entry.legs[0].accountId);
      const sign = entry.legs[0].amountCents > 0 ? "+" : "−";
      row.append(node("span",`mark ${entry.type}`,{income: "[+]", expense: "[-]", transfer: "[⇄]", adjustment: "[~]"}[entry.type]));
      row.append(node("span","ttitle",entry.type === "transfer" ? entry.note || route : entry.note || label));
      const viewLeg = onAcc && entry.type === "transfer" ? entry.legs.find(l => l.accountId === accFilter) : null;
      const transferText = viewLeg ? `${viewLeg.amountCents > 0 ? "+" : "−"}${money(amountOf(entry))}` : money(amountOf(entry));
      row.append(node("span",`tamount ${entry.type}`,entry.type === "transfer" ? transferText : `${sign}${money(amountOf(entry))}`));
      const meta = node("div","tmeta");
      meta.append(node("span","tmeta-text",[label,accText,trash ? "удалено" : ""].filter(Boolean).join(" · ")));
      const actions = node("span","row-actions");
      if (trash) {
        const restore = node("button","bracket","[вернуть]");
        restore.setAttribute("aria-label",`Восстановить: ${entry.note || label}`);
        restore.addEventListener("click",()=>{try{commit(journal.setDeleted(state,entry.id,false));toast("Запись возвращена в журнал.");}catch(e){toast(e.message);}});
        actions.append(restore);
      } else {
        const canEdit = entry.type !== "adjustment";
        if (canEdit) {
          const change = node("button","bracket","[изменить]");
          change.setAttribute("aria-label",`Изменить: ${entry.note || label}`);
          change.addEventListener("click",()=>edit(entry));
          actions.append(change);
          row.addEventListener("click",()=>{ if (isMobile()) edit(entry); });
        } else row.classList.add("no-edit");
        const remove = node("button","bracket","[удалить]");
        remove.setAttribute("aria-label",`Удалить: ${entry.note || label}`);
        remove.addEventListener("click",()=>softDelete(entry));
        actions.append(remove);
      }
      meta.append(actions); row.append(meta); container.append(row);
    }
  }
  function countWord(n) {
    const last = n % 10, lastTwo = n % 100;
    return last === 1 && lastTwo !== 11 ? "запись" : last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14) ? "записи" : "записей";
  }
  function bigMoney(el, cents) {
    const [integer,fraction] = money(cents).split(",");
    el.replaceChildren(document.createTextNode(integer),node("span","balance-decimals",","+fraction));
  }
  function accountRow(r, archived) {
    const row = node("button",`acc-row${archived ? " archived" : ""}`); row.type = "button"; row.dataset.id = r.account.id;
    const name = node("span","acc-name",r.account.name);
    name.append(node("span","acc-kind",` · ${acct.KIND_LABELS[r.account.kind]}`));
    row.append(node("span","acc-mark","[▪]"),name,node("span","acc-bal",money(r.balanceCents)));
    row.addEventListener("click",()=>openAccount(r.account.id));
    return row;
  }
  function renderAccounts() {
    const rows = views.accountTotals(state), archived = rows.archived;
    $("accounts-list").replaceChildren(...rows.map(r => accountRow(r, false)));
    $("accounts-total").textContent = `// итого ${money(views.balances(state).total)}`;
    $("archived-line").hidden = !archived.length;
    $("archived-count").textContent = archived.length;
    $("archived-toggle").textContent = showArchived ? "[скрыть]" : "[показать]";
    $("archived-toggle").setAttribute("aria-expanded", String(showArchived));
    $("archived-list").hidden = !archived.length || !showArchived;
    $("archived-list").replaceChildren(...archived.map(r => accountRow(r, true)));
    $("accounts-count").textContent = rows.length;
    $("nav-accounts-count").textContent = rows.length;
    $("nav-accounts").replaceChildren(...rows.map(r => {
      const b = node("button","qv"); b.type = "button"; b.dataset.id = r.account.id;
      b.append(node("span","qv-name",r.account.name),node("span","qv-count",money(r.balanceCents).replace(" ₽","")));
      b.addEventListener("click",()=>openAccount(r.account.id));
      return b;
    }));
    const a = currentAccount && accById(currentAccount);
    if (a) {
      $("account-label").textContent = a.name;
      bigMoney($("account-balance"), views.balances(state).byAccount[a.id]);
      $("account-meta").textContent = `// ${acct.KIND_LABELS[a.kind]}${a.archived ? " · в архиве" : ""} · начальный остаток ${money(a.openingCents)} на ${dateLabel(a.openingDate)}`;
      $("account-reconcile").hidden = a.archived;
      $("account-archive").textContent = a.archived ? "[вернуть из архива]" : "[в архив]";
    }
  }
  function fillAccountFilter() {
    const select = $("account-filter"), value = select.value;
    select.replaceChildren(...[["all","все счета"],...state.accounts.map(a => [a.id, a.archived ? `${a.name} (архив)` : a.name])].map(([v,t]) => { const o = document.createElement("option"); o.value = v; o.textContent = t; return o; }));
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
    setNav($("accounts-nav"), tab === "accounts" && !currentAccount);
    document.querySelectorAll("#nav-accounts .qv").forEach(el => setNav(el, tab === "accounts" && el.dataset.id === currentAccount));
    $("journal-title").textContent = trash ? "удалённые" : "журнал";
    $("page-label").textContent = trash ? "удалённые" : tab === "accounts" ? (currentAccount ? accName(currentAccount) : "счета") : {journal: "журнал", plans: "планы", more: "ещё"}[tab];
    const active = trash ? "more" : tab;
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
    renderAccounts();
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

  // ---------- счета: форма и сверка ----------
  function openAccountForm(id) {
    accountEditing = id;
    const a = id && accById(id);
    $("account-title").textContent = a ? "изменить счёт" : "новый счёт";
    $("account-name").value = a ? a.name : "";
    const kinds = ["debit","cash","savings","credit_card"];
    if (a && !kinds.includes(a.kind)) kinds.push(a.kind);
    $("account-kind").replaceChildren(...kinds.map(k => { const o = document.createElement("option"); o.value = k; o.textContent = acct.KIND_LABELS[k]; return o; }));
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
      if (!M.validDate(openingDate)) throw new Error("Укажите корректную дату.");
      const data = {name: $("account-name").value, kind: $("account-kind").value, openingCents, openingDate};
      if (accountEditing) commit(acct.updateAccount(state,accountEditing,data));
      else { const id = newId(); commit(acct.addAccount(state,{id,...data})); }
      closeSheet(); toast(accountEditing ? "Счёт сохранён." : "Счёт добавлен.");
    } catch(e) { $("account-error").textContent = e.message; }
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
    $("recon-calc").textContent = calc === null ? "" : `// по журналу на эту дату: ${money(calc)}`;
    $("recon-diff").textContent = `// разница: ${diff === null ? "—" : signed(diff)}`;
    $("recon-diff").className = `recon-diff${diff === 0 ? " ok" : diff ? " warn" : ""}`;
    $("recon-save").firstElementChild.textContent = diff === 0 ? "всё сходится" : "записать корректировку";
  }
  function openRecon(id) {
    reconAccount = id;
    $("recon-title").textContent = `сверка · ${accName(id)}`;
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
      if (!M.validDate(date)) throw new Error("Укажите корректную дату.");
      if (date > today()) throw new Error("Сверка возможна на сегодня или раньше.");
      const res = journal.reconcile(state,reconAccount,bank,date,$("recon-note").value,newId(),new Date().toISOString());
      if (res.diff === 0) { closeSheet(); toast("Всё сходится, корректировка не нужна."); return; }
      commit(res.state); closeSheet(); toast(`Корректировка записана: ${signed(res.diff)}.`);
    } catch(e) { $("recon-error").textContent = e.message; }
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
    try { commit(acct.archiveAccount(state,a.id,!a.archived)); toast(a.archived ? "Счёт возвращён из архива." : "Счёт перенесён в архив."); }
    catch(e) { toast(e.message); }
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
      if (!M.validDate(date)) throw new Error("Укажите корректную дату.");
      if (date > today()) throw new Error("Запишите операцию, когда она произойдёт. Будущие даты пока не поддерживаются.");
      const previous = editing ? state.operations.find(e=>e.id===editing) : null;
      if (editing && (!previous || previous.deleted)) throw new Error("Запись была удалена. Начните новую запись.");
      const now = new Date().toISOString(), note = $("note").value.trim();
      const accountId = $("account").value, toId = $("account-to").value;
      if (!accountId) throw new Error("Выберите счёт.");
      let next, done;
      if (mode === "transfer") {
        if (!toId || accountId === toId) throw new Error("Выберите два разных счёта: «откуда» и «куда».");
        const legs = [{accountId,amountCents:-amountCents},{accountId:toId,amountCents}];
        if (previous) next = journal.upsertOperation(state,{...previous,type:"transfer",date,note,deleted:false,legs,allocations:[]},now);
        else {
          const transfer = journal.makeTransfer({id:newId(),fromId:accountId,toId,amountCents,date,note,now});
          next = journal.upsertOperation(state,transfer,now);
          const feeRaw = $("fee").value.trim();
          if (feeRaw) next = journal.upsertOperation(next,journal.makeFee({id:newId(),transferId:transfer.id,accountId,amountCents:M.parseAmount(feeRaw),date,now}),now);
        }
        done = previous ? "Изменения сохранены." : "Перевод записан.";
      } else {
        const entry = {...previous,id:previous?.id || newId(),type:mode,date,note,createdAt:previous?.createdAt || now,deleted:false,
          legs:[{accountId,amountCents:mode === "income" ? amountCents : -amountCents}],
          allocations:mode === "income" ? [] : [{categoryId:null,amountCents}]};
        next = journal.upsertOperation(state,entry,now);
        done = previous ? "Изменения сохранены." : mode === "income" ? "Доход записан." : "Расход записан.";
      }
      commit(next);
      toast(done);
      resetForm(!isMobile()); closeSheet();
      if (trash) { trash = false; render(); }
    } catch(e) { $("form-error").textContent = e.message; }
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
    try {commit(journal.setDeleted(state,undoId,false));toast("Запись возвращена.");} catch(e){toast(e.message);}
  });
  function download(text, filename) {
    const url=URL.createObjectURL(new Blob([text],{type:"application/json;charset=utf-8"}));
    const a=document.createElement("a");a.href=url;a.download=filename;document.body.append(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  function doExport() {
    try {
      const raw = locked ? (localStorage.getItem(KEY) ?? localStorage.getItem(KEY_V1)) : JSON.stringify({...state,exportedAt:new Date().toISOString()},null,2);
      if(raw===null) throw new Error("Нет доступных данных для копии.");
      download(raw,`money-log-${today()}${locked ? "-recovery" : ""}.json`);
      toast("Копия подготовлена для скачивания.");
    } catch(e){toast(e.message);}
  }
  const doImport = ()=>{$("import-file").value="";$("import-file").click();};
  $("export-button").addEventListener("click",doExport);
  $("more-export").addEventListener("click",doExport);
  $("import-button").addEventListener("click",doImport);
  $("more-import").addEventListener("click",doImport);
  $("import-file").addEventListener("change",async()=>{
    const file=$("import-file").files[0];if(!file)return;
    try {
      if(file.size>25*1024*1024) throw new Error("Копия слишком большая. Максимум — 25 МБ.");
      pendingImport=schema.migrate(JSON.parse(await file.text()),today());
      const merged=journal.merge(state,pendingImport,today());
      $("import-description").textContent=`В файле ${pendingImport.operations.length} ${countWord(pendingImport.operations.length)}. Будет добавлено: ${merged.added}. Удалённые записи также сохранятся.`;
      $("import-error").textContent="";
      $("import-dialog").showModal();
    } catch(e){toast(e instanceof SyntaxError ? "Это не JSON-копия money.log." : e.message);}
  });
  $("confirm-import").addEventListener("click",()=>{
    try {
      const merged=journal.merge(state,pendingImport,today());
      commit(merged.state);pendingImport=null;$("import-dialog").close();resetForm();
      toast(`Копия восстановлена. Добавлено записей: ${merged.added}.`);
    } catch(e){$("import-error").textContent=e.message;}
  });
  function theme(value) {
    document.documentElement.dataset.theme=value;
    $("theme-button").textContent=value==="terminal"?"[светлая]":"[тёмная]";
    $("theme-button").setAttribute("aria-label",value==="terminal"?"Включить светлую тему":"Включить тёмную тему");
    document.querySelector('meta[name="theme-color"]').content=value==="terminal"?"#0D1117":"#FAFAFA";
  }
  try{theme(localStorage.getItem("money.log.theme")==="paper"?"paper":"terminal");}catch{theme("terminal");}
  $("theme-button").addEventListener("click",()=>{
    const value=document.documentElement.dataset.theme==="terminal"?"paper":"terminal";theme(value);
    try{localStorage.setItem("money.log.theme",value);}catch{toast("Тема применена, но браузер не разрешил её сохранить.");}
  });
  window.addEventListener("storage",event=>{
    if(event.key!==KEY)return;
    try {
      state=event.newValue===null ? schema.empty(today()) : schema.migrate(JSON.parse(event.newValue),today());
      locked=false;$("storage-error").hidden=true;render();
      toast("Журнал обновлён в другой вкладке.");
    } catch {locked=true;storageError("В другой вкладке появились некорректные данные. Запись временно отключена, исходный журнал сохранён.");}
  });
  document.addEventListener("keydown",event=>{
    if(event.ctrlKey||event.metaKey||event.altKey||document.querySelector("dialog[open]"))return;
    if(event.key==="Escape"){dismissAny();$("amount").blur();return;}
    if(activeSheet)return;
    if(["INPUT","TEXTAREA","SELECT"].includes(event.target.tagName)||event.target.isContentEditable)return;
    if(event.key.toLowerCase()==="n"||event.key.toLowerCase()==="т"){event.preventDefault();startNew();}
  });
  $("today-label").textContent=new Intl.DateTimeFormat("ru-RU",{day:"2-digit",month:"short",year:"numeric"}).format(new Date());
  resetForm();render();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(()=>{});
})();
