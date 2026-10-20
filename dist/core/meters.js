(function (root) {
  "use strict";
  const node = typeof module !== "undefined" && module.exports;
  const {validate} = node ? require("./schema.js") : root.MoneyCore.schema;
  const {validDate} = node ? require("./money.js") : root.MoneyCore.money;
  const LESS = "Показание меньше прошлого — проверьте.";
  const MORE = "Показание больше следующего — проверьте.";
  const DAY = 86400000;
  const toDay = s => Math.floor(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / DAY);
  const fromDay = n => new Date(n * DAY).toISOString().slice(0, 10);
  const pad = n => String(n).padStart(2, "0");
  const lastDom = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
  const mk = (y, m, d) => y + "-" + pad(m) + "-" + pad(Math.min(d, lastDom(y, m)));
  const cmp = (a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

  const live = (state, scheduleId, meterId) => (state.readings || []).filter(r => !r.deleted && r.scheduleId === scheduleId && r.meterId === meterId).sort(cmp);
  function meterOf(state, scheduleId, meterId) {
    const sc = state.schedules.find(s => s.id === scheduleId);
    if (!sc) throw new Error("Регулярный платёж не найден.");
    const m = (sc.meters || []).find(x => x.id === meterId);
    if (!m) throw new Error("Счётчик не найден.");
    return m;
  }
  // показание не меньше предыдущего и не больше следующего по дате (id — исключить правимое)
  function check(state, {scheduleId, meterId, date, valueMilli, id}) {
    if (!validDate(date)) throw new Error("Некорректная дата.");
    if (!Number.isSafeInteger(valueMilli) || valueMilli < 0) throw new Error("Показание должно быть числом не меньше нуля.");
    const list = live(state, scheduleId, meterId).filter(r => r.id !== id);
    const prev = list.filter(r => r.date <= date).pop();
    const next = list.find(r => r.date > date);
    if (prev && valueMilli < prev.valueMilli) throw new Error(LESS);
    if (next && valueMilli > next.valueMilli) throw new Error(MORE);
  }
  const put = (state, readings) => validate({...state, readings});

  function addReading(state, {id, scheduleId, meterId, date, valueMilli}, nowISO) {
    meterOf(state, scheduleId, meterId);
    if ((state.readings || []).some(r => r.id === id)) throw new Error("Показание уже существует.");
    check(state, {scheduleId, meterId, date, valueMilli});
    return put(state, [...(state.readings || []), {id, scheduleId, meterId, date, valueMilli, updatedAt: nowISO, deleted: false}]);
  }
  // исправить прошлое показание (дата / значение) с той же проверкой соседей
  function updateReading(state, id, patch, nowISO) {
    const r = (state.readings || []).find(x => x.id === id);
    if (!r) throw new Error("Показание не найдено.");
    const next = {...r, ...(patch.date !== undefined ? {date: patch.date} : {}), ...(patch.valueMilli !== undefined ? {valueMilli: patch.valueMilli} : {}), updatedAt: nowISO};
    if (!r.deleted) check(state, {...next, id});
    return put(state, state.readings.map(x => x.id === id ? next : x));
  }
  function deleteReading(state, id, nowISO) {
    if (!(state.readings || []).some(r => r.id === id)) throw new Error("Показание не найдено.");
    return put(state, state.readings.map(r => r.id === id ? {...r, deleted: true, updatedAt: nowISO} : r));
  }
  // история [{id, date, valueMilli, deltaMilli}]; у первого показания deltaMilli = null
  function consumption(state, scheduleId, meterId) {
    let prev = null;
    return live(state, scheduleId, meterId).map(r => {
      const row = {id: r.id, date: r.date, valueMilli: r.valueMilli, deltaMilli: prev === null ? null : r.valueMilli - prev};
      prev = r.valueMilli;
      return row;
    });
  }
  // deltas: {meterId: deltaMilli} или [{meterId, deltaMilli}]; Σ round(deltaMilli × tariffCents / 1000) по счётчикам с тарифом
  function costFor(schedule, deltas) {
    const list = Array.isArray(deltas) ? deltas : Object.entries(deltas || {}).map(([meterId, deltaMilli]) => ({meterId, deltaMilli}));
    let total = 0;
    for (const {meterId, deltaMilli} of list) {
      const m = (schedule.meters || []).find(x => x.id === meterId);
      if (!m || m.tariffCents == null || !Number.isFinite(deltaMilli) || deltaMilli <= 0) continue;
      total += Math.round(deltaMilli * m.tariffCents / 1000);
    }
    return total;
  }
  // расход по каждому активному счётчику на дату: показание на date минус предыдущее (только если оно есть на эту дату)
  function deltasAt(state, scheduleId, date) {
    const sc = state.schedules.find(s => s.id === scheduleId);
    const out = {};
    for (const m of (sc && sc.meters) || []) {
      if (m.archived) continue;
      const row = consumption(state, scheduleId, m.id).filter(r => r.date === date).pop();
      if (row && row.deltaMilli !== null) out[m.id] = row.deltaMilli;
    }
    return out;
  }
  // напоминания: окно [readingsDay − 5, readingsDay]; снимается, когда у каждого активного счётчика есть показание в окне
  function reminders(state, today) {
    const out = [];
    const y = +today.slice(0, 4), m = +today.slice(5, 7);
    for (const sc of state.schedules) {
      if (sc.archived || sc.paused || sc.template !== "bill" || sc.readingsDay == null) continue;
      const active = (sc.meters || []).filter(x => !x.archived);
      if (!active.length) continue;
      for (const [yy, mm] of [[y, m], [m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1]]) {
        const deadline = mk(yy, mm, sc.readingsDay);
        const start = fromDay(toDay(deadline) - 5);
        if (today < start || today > deadline) continue;
        const done = active.every(mt => live(state, sc.id, mt.id).some(r => r.date >= start && r.date <= deadline));
        if (!done) out.push({scheduleId: sc.id, deadline, daysLeft: toDay(deadline) - toDay(today)});
      }
    }
    return out.sort((a, b) => a.deadline < b.deadline ? -1 : a.deadline > b.deadline ? 1 : a.scheduleId < b.scheduleId ? -1 : 1);
  }

  const api = {addReading, updateReading, deleteReading, consumption, costFor, deltasAt, reminders};
  if (node) module.exports = api;
  else (root.MoneyCore = root.MoneyCore || {}).meters = api;
})(globalThis);
