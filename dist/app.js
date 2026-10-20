"use strict";
(() => {
  const {money: M, schema, journal, views} = globalThis.MoneyCore;
  const newId = () => {
    if (crypto.randomUUID) return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16)); b[6] = b[6] & 15 | 64; b[8] = b[8] & 63 | 128;
    const h = [...b].map(x => x.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
  };
  const KEY = "money.log.ledger.v2", KEY_V1 = "money.log.ledger.v1";
  const $ = id => document.getElementById(id);
  let state = schema.empty(todayISO()), mode = "expense", filter = "all", trash = false, editing = null, pendingImport = null, locked = false;
  let undoId = null, tab = "journal";
  const mobileQuery = window.matchMedia("(max-width: 599px)");
  const isMobile = () => mobileQuery.matches;
  function todayISO() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  }
  const today = todayISO;
  const primary = () => state.accounts.find(a => a.id === "main") || state.accounts[0];
  const amountOf = op => Math.abs(op.legs[0].amountCents);
  const money = cents => new Intl.NumberFormat("ru-RU", {minimumFractionDigits:2,maximumFractionDigits:2}).format(cents / 100) + " ₽";
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
  function setMode(type) {
    mode = type;
    document.querySelectorAll("[data-type]").forEach(b => {
      b.classList.toggle("selected", b.dataset.type === type);
      b.setAttribute("aria-pressed", String(b.dataset.type === type));
    });
    $("save-button").firstElementChild.textContent = isMobile() ? "записать" : editing ? "Сохранить изменения" : type === "income" ? "Записать доход" : "Записать расход";
    $("form-title").textContent = editing ? (isMobile() ? "изменить" : "изменить запись") : isMobile() ? (type === "income" ? "пришло" : "ушло") : "новая запись";
    $("note").placeholder = type === "income" ? "Например, зарплата" : "Например, кофе по дороге";
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
    setMode(mode);
    if (focus) $("amount").focus();
  }
  function edit(entry) {
    editing = entry.id;
    $("amount").value = amountInput(amountOf(entry));
    $("date").value = entry.date;
    $("note").value = entry.note;
    $("cancel-edit").hidden = false;
    $("delete-entry").hidden = false;
    $("form-error").textContent = "";
    $("entry-form").classList.remove("date-open");
    updateDateSummary();
    setMode(entry.type);
    openSheet();
    $("amount").focus();
    if (!isMobile()) $("entry-form").scrollIntoView({block:"nearest",behavior:"smooth"});
  }
  function updateDateSummary() {
    const value = $("date").value;
    $("date-summary").textContent = !value || value === today() ? "сегодня" : M.validDate(value) ? dateLabel(value) : value;
  }
  function openSheet() {
    if (!isMobile()) return;
    $("entry-box").classList.add("open");
    $("sheet-backdrop").hidden = false;
    document.body.classList.add("sheet-open");
  }
  function closeSheet() {
    $("entry-box").classList.remove("open");
    $("sheet-backdrop").hidden = true;
    document.body.classList.remove("sheet-open");
  }
  function dismissSheet() { resetForm(); closeSheet(); }
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
  function renderEntries() {
    const query = $("search").value.trim().toLocaleLowerCase("ru");
    const entries = state.operations.filter(e => e.deleted === trash && (filter === "all" || e.type === filter) && (!query || `${e.note} ${amountInput(amountOf(e))}`.toLocaleLowerCase("ru").includes(query)))
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
      const label = entry.type === "income" ? "доход" : "расход";
      row.append(node("span",`mark ${entry.type}`,entry.type === "income" ? "[+]" : "[-]"));
      row.append(node("span","ttitle",entry.note || label));
      row.append(node("span",`tamount ${entry.type === "income" ? "income" : ""}`,`${entry.type === "income" ? "+" : "−"}${money(amountOf(entry))}`));
      const meta = node("div","tmeta");
      meta.append(node("span","tmeta-text",trash ? `${label} · удалено` : label));
      const actions = node("span","row-actions");
      if (trash) {
        const restore = node("button","bracket","[вернуть]");
        restore.setAttribute("aria-label",`Восстановить: ${entry.note || label}`);
        restore.addEventListener("click",()=>{try{commit(journal.setDeleted(state,entry.id,false));toast("Запись возвращена в журнал.");}catch(e){toast(e.message);}});
        actions.append(restore);
      } else {
        const change = node("button","bracket","[изменить]");
        change.setAttribute("aria-label",`Изменить: ${entry.note || label}`);
        change.addEventListener("click",()=>edit(entry));
        const remove = node("button","bracket","[удалить]");
        remove.setAttribute("aria-label",`Удалить: ${entry.note || label}`);
        remove.addEventListener("click",()=>softDelete(entry));
        actions.append(change,remove);
        row.addEventListener("click",()=>{ if (isMobile()) edit(entry); });
      }
      meta.append(actions); row.append(meta); container.append(row);
    }
  }
  function countWord(n) {
    const last = n % 10, lastTwo = n % 100;
    return last === 1 && lastTwo !== 11 ? "запись" : last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14) ? "записи" : "записей";
  }
  function render() {
    const sums = views.totals(state);
    const formatted = money(sums.balance);
    const [integer,fraction] = formatted.split(",");
    $("balance").replaceChildren(document.createTextNode(integer),node("span","balance-decimals",","+fraction));
    $("income-total").textContent = "+"+money(sums.income);
    $("expense-total").textContent = "−"+money(sums.expense);
    $("opening-value").textContent = money(primary().openingCents);
    $("nav-count").textContent = state.operations.filter(e=>!e.deleted).length;
    $("trash-count").textContent = state.operations.filter(e=>e.deleted).length;
    $("more-trash-count").textContent = $("trash-count").textContent;
    renderEntries();
  }
  function setView(isTrash) {
    trash = isTrash;
    $("journal-nav").classList.toggle("active",!trash);
    $("trash-nav").classList.toggle("active",trash);
    $("journal-nav").setAttribute("aria-current",trash ? "false" : "page");
    $("trash-nav").setAttribute("aria-current",trash ? "page" : "false");
    $("journal-title").textContent = trash ? "удалённые" : "журнал";
    $("page-label").textContent = trash ? "удалённые" : "журнал";
    document.body.toggleAttribute("data-trash",trash);
    updateTabbar();
    renderEntries();
  }
  function updateTabbar() {
    const active = trash ? "more" : tab;
    document.querySelectorAll(".tab").forEach(b=>{
      const on = b.dataset.tab === active;
      b.classList.toggle("active",on);
      b.setAttribute("aria-current",on ? "page" : "false");
    });
  }
  function setTab(name) {
    if (!$("sheet-backdrop").hidden) dismissSheet();
    tab = name;
    document.body.dataset.tab = name;
    setView(false);
    window.scrollTo(0,0);
  }
  function openTrash() {
    setTab("journal");
    setView(true);
  }
  $("entry-form").addEventListener("submit",event=>{
    event.preventDefault(); $("form-error").textContent = "";
    try {
      const amountCents = M.parseAmount($("amount").value);
      const date = $("date").value;
      if (!M.validDate(date)) throw new Error("Укажите корректную дату.");
      if (date > today()) throw new Error("Запишите операцию, когда она произойдёт. Будущие даты пока не поддерживаются.");
      const previous = editing ? state.operations.find(e=>e.id===editing) : null;
      if (editing && (!previous || previous.deleted)) throw new Error("Запись была удалена. Начните новую запись.");
      const now = new Date().toISOString();
      const entry = {...previous,id:previous?.id || newId(),type:mode,date,note:$("note").value.trim(),createdAt:previous?.createdAt || now,deleted:false,
        legs:[{accountId:previous?.legs[0].accountId || primary().id,amountCents:mode === "income" ? amountCents : -amountCents}],
        allocations:mode === "income" ? [] : [{categoryId:null,amountCents}]};
      commit(journal.upsertOperation(state,entry,now));
      toast(previous ? "Изменения сохранены." : mode === "income" ? "Доход записан." : "Расход записан.");
      resetForm(!isMobile()); closeSheet(); setView(false);
    } catch(e) { $("form-error").textContent = e.message; }
  });
  document.querySelectorAll("[data-type]").forEach(b=>b.addEventListener("click",()=>setMode(b.dataset.type)));
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
  $("sheet-backdrop").addEventListener("click",dismissSheet);
  document.querySelectorAll("[data-new]").forEach(b=>b.addEventListener("click",()=>startNew(b.dataset.new)));
  $("date-toggle").addEventListener("click",()=>{
    $("entry-form").classList.add("date-open");
    $("date").focus();
  });
  $("date").addEventListener("change",updateDateSummary);
  document.querySelectorAll(".tab").forEach(b=>b.addEventListener("click",()=>setTab(b.dataset.tab)));
  $("trash-back").addEventListener("click",()=>setTab("more"));
  $("more-trash").addEventListener("click",openTrash);
  mobileQuery.addEventListener("change",()=>{ if(!isMobile()) closeSheet(); setMode(mode); });
  $("journal-nav").addEventListener("click",()=>setView(false));
  $("trash-nav").addEventListener("click",()=>setView(true));
  $("opening-button").addEventListener("click",()=>{
    $("opening-input").value = amountInput(primary().openingCents); $("opening-error").textContent = "";
    $("opening-dialog").showModal();
  });
  $("opening-form").addEventListener("submit",event=>{
    event.preventDefault();
    try {
      commit(journal.setOpening(state,primary().id,M.parseAmount($("opening-input").value,true)));
      $("opening-dialog").close(); toast("Начальный остаток сохранён.");
    } catch(e) {$("opening-error").textContent=e.message;}
  });
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
    if(event.key==="Escape"){dismissSheet();$("amount").blur();return;}
    if(["INPUT","TEXTAREA","SELECT"].includes(event.target.tagName)||event.target.isContentEditable)return;
    if(event.key.toLowerCase()==="n"||event.key.toLowerCase()==="т"){event.preventDefault();startNew();}
  });
  $("today-label").textContent=new Intl.DateTimeFormat("ru-RU",{day:"2-digit",month:"short",year:"numeric"}).format(new Date());
  resetForm();render();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(()=>{});
})();
