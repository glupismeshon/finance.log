(function (root) {
  "use strict";
  // Фирменный календарь вместо input[type=date].
  // Хост: <div class="dp" data-label="id подписи"><input id="…" type="hidden"></div>.
  // Значение остаётся в скрытом поле (YYYY-MM-DD); при записи в .value подпись обновляется сама.
  const pad = n => String(n).padStart(2, "0");
  const iso = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`; // m: 0..11
  function parse(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
    if (!m) return null;
    const y = +m[1], mo = +m[2] - 1, d = +m[3], dt = new Date(Date.UTC(y, mo, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo && dt.getUTCDate() === d ? {y, m: mo, d} : null;
  }
  const daysIn = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  function addDays(s, n) {
    const p = parse(s), dt = new Date(Date.UTC(p.y, p.m, p.d + n));
    return iso(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate());
  }
  function addMonths(s, n) {
    const p = parse(s), total = p.y * 12 + p.m + n, y = Math.floor(total / 12), m = total - y * 12;
    return iso(y, m, Math.min(p.d, daysIn(y, m)));
  }
  function todayISO() { const d = new Date(); return iso(d.getFullYear(), d.getMonth(), d.getDate()); }
  const mc = () => root.MoneyCore;
  const I = () => mc().i18n;
  const t = (k, p) => I().t(k, p);
  const fmt = (opts, y, m, d) => new Intl.DateTimeFormat(I().locale(), {timeZone: "UTC", ...opts}).format(new Date(Date.UTC(y, m, d)));
  const monthName = (y, m) => fmt({month: "long"}, y, m, 1).toLowerCase();
  const monthShort = m => fmt({month: "short"}, 2024, m, 1).replace(/\./g, "").toLowerCase().slice(0, 3);
  const weekdayShort = i => fmt({weekday: "short"}, 2024, 0, 1 + i).replace(/\./g, "").toLowerCase(); // 2024-01-01 — понедельник
  const longLabel = s => { const p = parse(s); return fmt({weekday: "long", day: "numeric", month: "long", year: "numeric"}, p.y, p.m, p.d); };

  const instances = [];
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const btn = (cls, text, act, label) => {
    const b = el("button", cls, text); b.type = "button"; b.dataset.act = act;
    if (label) b.setAttribute("aria-label", label);
    return b;
  };

  function create(host, opts = {}) {
    const input = host.querySelector("input");
    const heat = opts.heat || (() => null);
    const trigger = el("button", "dp-trigger"); trigger.type = "button";
    trigger.setAttribute("aria-haspopup", "dialog"); trigger.setAttribute("aria-expanded", "false");
    if (host.dataset.label) trigger.setAttribute("aria-labelledby", host.dataset.label);
    const triggerText = el("span", "dp-trigger-text"), caret = el("span", "dp-caret", "▾");
    caret.setAttribute("aria-hidden", "true");
    trigger.append(triggerText, caret);
    const panel = el("div", "dp-panel"); panel.hidden = true;
    panel.setAttribute("role", "dialog"); panel.setAttribute("aria-label", t("dp.aria"));
    host.append(trigger, panel);

    let open = false, mode = "days", view = {y: 0, m: 0}, focus = null, yearView = 0;

    const max = () => { const v = input.getAttribute("max"); return parse(v) ? v : null; };
    const value = () => (parse(input.value) ? input.value : null);

    function sync() {
      const v = value();
      triggerText.textContent = v ? I().fmtDate(v) : "—";
    }
    // запись в .value (программная) обновляет подпись без вызова sync() снаружи
    const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    Object.defineProperty(input, "value", {
      configurable: true,
      get() { return desc.get.call(this); },
      set(v) { desc.set.call(this, v); sync(); if (open) { setView(value() || todayISO()); render(); } }
    });

    function setView(s) { const p = parse(s); view = {y: p.y, m: p.m}; yearView = p.y; }

    function pick(date) {
      const limit = max();
      if (!parse(date) || (limit && date > limit)) return;
      desc.set.call(input, date); sync();
      input.dispatchEvent(new Event("input", {bubbles: true}));
      input.dispatchEvent(new Event("change", {bubbles: true}));
      close(true);
    }

    function head(prevAct, prevLabel, titleNode, nextAct, nextLabel, prevOff, nextOff, prevText = "[←]", nextText = "[→]") {
      const h = el("div", "dp-head");
      const p = btn("dp-nav", prevText, prevAct, prevLabel), n = btn("dp-nav", nextText, nextAct, nextLabel);
      p.disabled = !!prevOff; n.disabled = !!nextOff;
      h.append(p, titleNode, n);
      return h;
    }

    function renderDays() {
      const limit = max(), lp = limit && parse(limit), td = todayISO(), sel = value();
      const heatData = heat(), vals = (heatData && heatData.vals) || {}, th = (heatData && heatData.th) || [0, 0, 0];
      const levelOf = mc().analytics.levelOf;
      const title = btn("dp-title", `${monthName(view.y, view.m)} ${view.y}`, "months");
      title.setAttribute("aria-expanded", "false"); title.setAttribute("aria-label", t("dp.pickMonth"));
      panel.append(head("prev", t("dp.prevMonth"), title, "next", t("dp.nextMonth"), false, !!(lp && (view.y > lp.y || (view.y === lp.y && view.m >= lp.m)))));
      const grid = el("div", "dp-grid"); grid.setAttribute("role", "grid"); grid.setAttribute("aria-label", `${monthName(view.y, view.m)} ${view.y}`);
      const hr = el("div", "dp-row dp-wd"); hr.setAttribute("role", "row");
      for (let i = 0; i < 7; i++) { const c = el("div", `dp-wd-c${i > 4 ? " dp-we" : ""}`, weekdayShort(i)); c.setAttribute("role", "columnheader"); hr.append(c); }
      grid.append(hr);
      const offset = (new Date(Date.UTC(view.y, view.m, 1)).getUTCDay() + 6) % 7, total = daysIn(view.y, view.m);
      const weeks = Math.ceil((offset + total) / 7);
      const tabTarget = focus && parse(focus) && parse(focus).y === view.y && parse(focus).m === view.m ? focus : null;
      for (let w = 0; w < weeks; w++) {
        const row = el("div", "dp-row"); row.setAttribute("role", "row");
        for (let c = 0; c < 7; c++) {
          const day = w * 7 + c - offset + 1;
          if (day < 1 || day > total) { const e = el("span", "dp-empty"); e.setAttribute("role", "gridcell"); e.setAttribute("aria-hidden", "true"); row.append(e); continue; }
          const date = iso(view.y, view.m, day), cell = el("button", "dp-day");
          cell.type = "button"; cell.dataset.act = "day"; cell.dataset.date = date;
          cell.setAttribute("role", "gridcell"); cell.setAttribute("aria-label", longLabel(date));
          cell.setAttribute("aria-selected", String(date === sel));
          cell.tabIndex = (tabTarget ? date === tabTarget : day === 1) ? 0 : -1;
          if (c > 4) cell.classList.add("dp-we");
          if (date === td) cell.classList.add("dp-today");
          if (date === sel) cell.classList.add("dp-sel");
          if (limit && date > limit) { cell.disabled = true; cell.classList.add("dp-off"); }
          cell.append(el("span", "dp-num", String(day)));
          const lv = levelOf(vals[date] || 0, th);
          const dot = el("span", `dp-dot${lv ? ` dp-l${lv}` : ""}`); dot.setAttribute("aria-hidden", "true");
          cell.append(dot);
          row.append(cell);
        }
        grid.append(row);
      }
      panel.append(grid);
    }

    function renderMonths() {
      const limit = max(), lp = limit && parse(limit);
      const title = el("span", "dp-title dp-year", String(yearView)); title.setAttribute("aria-live", "polite");
      panel.append(head("yprev", t("dp.prevYear"), title, "ynext", t("dp.nextYear"), false, !!(lp && yearView >= lp.y), `[← ${yearView - 1}]`, `[${yearView + 1} →]`));
      const grid = el("div", "dp-months");
      for (let m = 0; m < 12; m++) {
        const b = btn("dp-month", monthShort(m), "month", `${monthName(yearView, m)} ${yearView}`);
        b.dataset.m = String(m);
        if (yearView === view.y && m === view.m) b.classList.add("dp-sel");
        if (lp && (yearView > lp.y || (yearView === lp.y && m > lp.m))) { b.disabled = true; b.classList.add("dp-off"); }
        grid.append(b);
      }
      panel.append(grid);
    }

    function render() {
      panel.replaceChildren();
      panel.setAttribute("aria-label", t("dp.aria"));
      if (mode === "days") renderDays(); else renderMonths();
      const limit = max(), td = todayISO(), yd = addDays(td, -1);
      const foot = el("div", "dp-foot");
      const bt = btn("bracket dp-quick", t("dp.today"), "today"), by = btn("bracket dp-quick", t("dp.yesterday"), "yesterday");
      if (limit && td > limit) bt.disabled = true;
      if (limit && yd > limit) by.disabled = true;
      const bx = btn("bracket dp-quick dp-x", "[×]", "close", t("common.close"));
      foot.append(bt, by, bx);
      panel.append(foot);
    }

    function focusCell() {
      const c = panel.querySelector(`.dp-day[data-date="${focus}"]`) || panel.querySelector(".dp-day:not(:disabled)");
      if (c) c.focus({preventScroll: true});
    }

    function openPanel(grabFocus = false) {
      instances.forEach(i => { if (i !== api) i.close(); });
      const limit = max();
      let f = value() || todayISO();
      if (limit && f > limit) f = limit;
      focus = f; mode = "days"; setView(value() || f);
      open = true; panel.hidden = false; host.classList.add("dp-open");
      trigger.setAttribute("aria-expanded", "true");
      render();
      if (grabFocus) focusCell();
      if (panel.scrollIntoView) panel.scrollIntoView({block: "nearest"});
    }
    function close(refocus = false) {
      if (!open) return;
      open = false; panel.hidden = true; host.classList.remove("dp-open");
      trigger.setAttribute("aria-expanded", "false");
      if (refocus && trigger.offsetParent) trigger.focus({preventScroll: true});
      if (opts.onClose) opts.onClose();
    }

    function shiftMonth(n) {
      const s = addMonths(iso(view.y, view.m, 1), n);
      setView(s);
      if (focus) { focus = addMonths(focus, n); const limit = max(); if (limit && focus > limit) focus = limit; }
      render();
    }

    panel.addEventListener("click", ev => {
      const b = ev.target.closest("[data-act]");
      if (!b || b.disabled) return;
      switch (b.dataset.act) {
        case "day": pick(b.dataset.date); break;
        case "today": pick(todayISO()); break;
        case "yesterday": pick(addDays(todayISO(), -1)); break;
        case "close": close(true); break;
        case "prev": shiftMonth(-1); break;
        case "next": shiftMonth(1); break;
        case "months": mode = "months"; yearView = view.y; render(); break;
        case "yprev": yearView--; render(); break;
        case "ynext": yearView++; render(); break;
        case "month": {
          view = {y: yearView, m: +b.dataset.m}; mode = "days";
          const limit = max(), f = iso(view.y, view.m, Math.min(focus ? parse(focus).d : 1, daysIn(view.y, view.m)));
          focus = limit && f > limit ? limit : f;
          render(); break;
        }
      }
    });

    panel.addEventListener("keydown", ev => {
      if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); if (mode === "months") { mode = "days"; render(); } else close(true); return; }
      if (mode !== "days" || !ev.target.classList.contains("dp-day")) return;
      const map = {ArrowLeft: d => addDays(d, -1), ArrowRight: d => addDays(d, 1), ArrowUp: d => addDays(d, -7), ArrowDown: d => addDays(d, 7),
        PageUp: d => addMonths(d, -1), PageDown: d => addMonths(d, 1)};
      const fn = map[ev.key];
      if (!fn) return;
      ev.preventDefault();
      let next = fn(ev.target.dataset.date);
      const limit = max();
      if (limit && next > limit) next = limit;
      focus = next; setView(next); render(); focusCell();
    });

    // свайп по сетке листает месяцы
    let sx = 0, sy = 0, swiping = false;
    panel.addEventListener("touchstart", ev => {
      swiping = mode === "days" && ev.touches.length === 1 && !!ev.target.closest(".dp-grid");
      if (swiping) { sx = ev.touches[0].clientX; sy = ev.touches[0].clientY; }
    }, {passive: true});
    panel.addEventListener("touchend", ev => {
      if (!swiping) return;
      swiping = false;
      const tch = ev.changedTouches[0], dx = tch.clientX - sx, dy = tch.clientY - sy;
      if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.5) shiftMonth(dx < 0 ? 1 : -1);
    }, {passive: true});

    trigger.addEventListener("click", () => { if (open) close(); else openPanel(false); });
    trigger.addEventListener("keydown", ev => {
      if (ev.key === "ArrowDown" && !open) { ev.preventDefault(); openPanel(true); }
    });
    document.addEventListener("pointerdown", ev => {
      if (!open || host.contains(ev.target)) return;
      if (getComputedStyle(panel).position === "absolute") close();
    });

    const api = {input, sync, open: openPanel, close, refresh() { sync(); panel.setAttribute("aria-label", t("dp.aria")); if (open) render(); }};
    instances.push(api);
    sync();
    return api;
  }

  const api = {create, refreshAll: () => instances.forEach(i => i.refresh()), closeAll: () => instances.forEach(i => i.close()), parse, addDays, addMonths};
  (root.MoneyCore = root.MoneyCore || {}).datepicker = api;
})(globalThis);
