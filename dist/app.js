"use strict";
(() => {
  const {money: M, schema, journal, views} = globalThis.MoneyCore;
  const KEY = "money.log.ledger.v2", KEY_V1 = "money.log.ledger.v1";
  const $ = id => document.getElementById(id);
  let state = schema.empty(todayISO()), mode = "expense", filter = "all", trash = false, editing = null, pendingImport = null, locked = false;
  let undoId = null;
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
  }
  function setMode(type) {
    mode = type;
    document.querySelectorAll("[data-type]").forEach(b => {
      b.classList.toggle("selected", b.dataset.type === type);
      b.setAttribute("aria-pressed", String(b.dataset.type === type));
    });
    $("save-button").firstElementChild.textContent = editing ? "Сохранить изменения" : type === "income" ? "Записать доход" : "Записать расход";
    $("note").placeholder = type === "income" ? "Например, зарплата" : "Например, кофе по дороге";
  }
  function resetForm(focus = false) {
    editing = null;
    $("entry-form").reset();
    $("date").value = today();
    $("date").max = today();
    $("form-error").textContent = "";
    $("form-title").textContent = "Новая запись";
    $("cancel-edit").hidden = true;
    setMode(mode);
    if (focus) $("amount").focus();
  }
  function edit(entry) {
    editing = entry.id;
    $("amount").value = amountInput(amountOf(entry));
    $("date").value = entry.date;
    $("note").value = entry.note;
    $("form-title").textContent = "Изменить запись";
    $("cancel-edit").hidden = false;
    $("form-error").textContent = "";
    setMode(entry.type);
    $("amount").focus();
    $("entry-form").scrollIntoView({block:"nearest",behavior:"smooth"});
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
      empty.append(node("div","empty-symbol", trash ? "↶" : "[ ]"));
      empty.append(node("h3","", query || filter !== "all" ? "Таких записей пока нет" : trash ? "Здесь пока пусто" : "Первая запись — начало"));
      empty.append(node("p","", query || filter !== "all" ? "Попробуйте другой поиск или выберите «Все»." : trash ? "Удалённые операции остаются здесь. Их можно вернуть в журнал." : "Добавьте доход или расход. Ваш журнал будет расти вместе с вами."));
      if (!trash && !query && filter === "all") {
        const button = node("button","","+ Добавить первую запись");
        button.addEventListener("click",()=>resetForm(true)); empty.append(button);
      }
      container.append(empty); return;
    }
    let lastDate = "";
    for (const entry of entries) {
      if (entry.date !== lastDate) {
        lastDate = entry.date;
        const group = node("div","day-heading");
        group.append(node("span","",entry.date === today() ? "СЕГОДНЯ" : dateLabel(entry.date).toLocaleUpperCase("ru")));
        if (entry.date === today()) group.append(node("span","",dateLabel(entry.date)));
        container.append(group);
      }
      const row = node("article","entry-row"); row.dataset.id = entry.id;
      const label = entry.type === "income" ? "Доход" : "Расход";
      row.append(node("div",`entry-icon ${entry.type}`,entry.type === "income" ? "↙" : "↗"));
      const description = node("div","entry-description");
      description.append(node("div","entry-note",entry.note || label),node("div","entry-type",trash ? `${label} · удалено` : label));
      row.append(description);
      const right = node("div","entry-right");
      right.append(node("div",`entry-money ${entry.type === "income" ? "income" : ""}`,`${entry.type === "income" ? "+" : "−"}${money(amountOf(entry))}`));
      const actions = node("div","row-actions");
      if (trash) {
        const restore = node("button","","Вернуть");
        restore.setAttribute("aria-label",`Восстановить: ${entry.note || label}`);
        restore.addEventListener("click",()=>{try{commit(journal.setDeleted(state,entry.id,false));toast("Запись возвращена в журнал.");}catch(e){toast(e.message);}});
        actions.append(restore);
      } else {
        const change = node("button","","Изменить");
        change.setAttribute("aria-label",`Изменить: ${entry.note || label}`);
        change.addEventListener("click",()=>edit(entry));
        const remove = node("button","","Удалить");
        remove.setAttribute("aria-label",`Удалить: ${entry.note || label}`);
        remove.addEventListener("click",()=>{
          try {
            commit(journal.setDeleted(state,entry.id,true));
            if(editing === entry.id) resetForm();
            toast("Запись перемещена в удалённые.",entry.id);
          } catch(e){toast(e.message);}
        });
        actions.append(change,remove);
      }
      right.append(actions); row.append(right); container.append(row);
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
    renderEntries();
  }
  function setView(isTrash) {
    trash = isTrash;
    $("journal-nav").classList.toggle("active",!trash);
    $("trash-nav").classList.toggle("active",trash);
    $("journal-nav").setAttribute("aria-current",trash ? "false" : "page");
    $("trash-nav").setAttribute("aria-current",trash ? "page" : "false");
    $("journal-title").textContent = trash ? "Удалённые операции" : "История операций";
    $("page-label").textContent = trash ? "удалённые" : "журнал";
    renderEntries();
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
      const entry = {...previous,id:previous?.id || crypto.randomUUID(),type:mode,date,note:$("note").value.trim(),createdAt:previous?.createdAt || now,deleted:false,
        legs:[{accountId:previous?.legs[0].accountId || primary().id,amountCents:mode === "income" ? amountCents : -amountCents}],
        allocations:mode === "income" ? [] : [{categoryId:null,amountCents}]};
      commit(journal.upsertOperation(state,entry,now));
      toast(previous ? "Изменения сохранены." : mode === "income" ? "Доход записан." : "Расход записан.");
      resetForm(true); setView(false);
    } catch(e) { $("form-error").textContent = e.message; }
  });
  document.querySelectorAll("[data-type]").forEach(b=>b.addEventListener("click",()=>setMode(b.dataset.type)));
  document.querySelectorAll("[data-filter]").forEach(b=>b.addEventListener("click",()=>{
    filter = b.dataset.filter;
    document.querySelectorAll("[data-filter]").forEach(item=>{item.classList.toggle("active",item===b);item.setAttribute("aria-pressed",String(item===b));});
    renderEntries();
  }));
  $("search").addEventListener("input",renderEntries);
  $("cancel-edit").addEventListener("click",()=>resetForm());
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
  $("export-button").addEventListener("click",()=>{
    try {
      const raw = locked ? (localStorage.getItem(KEY) ?? localStorage.getItem(KEY_V1)) : JSON.stringify({...state,exportedAt:new Date().toISOString()},null,2);
      if(raw===null) throw new Error("Нет доступных данных для копии.");
      download(raw,`money-log-${today()}${locked ? "-recovery" : ""}.json`);
      toast("Копия подготовлена для скачивания.");
    } catch(e){toast(e.message);}
  });
  $("import-button").addEventListener("click",()=>{$("import-file").value="";$("import-file").click();});
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
    $("theme-button").setAttribute("aria-label",value==="terminal"?"Включить светлую тему":"Включить тёмную тему");
    document.querySelector('meta[name="theme-color"]').content=value==="terminal"?"#121510":"#f4f3ed";
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
    if(event.key==="Escape"){resetForm();$("amount").blur();return;}
    if(["INPUT","TEXTAREA","SELECT"].includes(event.target.tagName)||event.target.isContentEditable)return;
    if(event.key.toLowerCase()==="n"||event.key.toLowerCase()==="т"){event.preventDefault();resetForm(true);}
  });
  $("today-label").textContent=new Intl.DateTimeFormat("ru-RU",{day:"2-digit",month:"short",year:"numeric"}).format(new Date());
  resetForm();render();
})();
