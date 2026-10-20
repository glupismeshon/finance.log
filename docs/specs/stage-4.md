# Этап 4 — регулярные платежи, подписки, прогноз

Принцип из ТЗ: **план ≠ факт.** Регулярный платёж — правило; будущие платежи (occurrences) вычисляются из правила
и НЕ хранятся; на баланс влияет только подтверждённая операция.

## 1. Модель (dist/core)

### `state.schedules[]` (массив уже есть в схеме — описать и валидировать)
```
{ id, type: "expense"|"income"|"transfer", name (1–80),
  amountCents (>0), accountId, toAccountId? (только transfer), categoryId? (null|категория нужного kind), merchant?,
  rule: { freq: "monthly"|"weekly"|"yearly"|"days", interval: 1..365,
          day?: 1..31 (monthly; 31 → последний день месяца), weekday?: 1..7 (weekly, пн=1), month?: 1..12 (yearly), },
  startDate, endDate|null, subscription: bool, paused: bool, archived: bool,
  skips: ["YYYY-MM-DD"...], updatedAt }
```
- Операция, подтверждающая платёж: `links: {scheduleId, dueDate}` (разрешить в schema для income/expense/transfer вместе с существующим feeOf).
- Синхронизация: `core/sync.js` должен включать schedules как kind `schedule` (проверить toRecords/applyRemote — если нет, добавить).

### `dist/core/schedules.js` (`MoneyCore.schedules`)
- `addSchedule / updateSchedule / archiveSchedule / setPaused / skipOccurrence(state, id, dueDate)` (всё с nowISO, ставят updatedAt).
- `occurrences(state, {from, to, today})` → `[{scheduleId, dueDate, amountCents, type, status: "confirmed"|"skipped"|"overdue"|"due"|"upcoming", opId?}]`
  по всем активным (не archived, не paused) правилам; confirmed — если есть неудалённая операция с этим scheduleId+dueDate;
  overdue — dueDate < today и не подтверждено/не пропущено (смотреть назад не дальше 60 дней и не раньше startDate).
- `confirmOp(schedule, dueDate, {amountCents?, date?, id, now})` → готовая операция (expense/income/transfer по правилу, allocation по categoryId,
  merchant, note = name, links) — сумма может отличаться от плановой.
- `deviation(state, opId)` → разница факт − план.
- `monthlyEquivalent(schedule)` (weekly ×52/12, yearly /12, days ×30.44/interval; округление до копеек) и
  `subscriptions(state)` → `{items:[{schedule, monthlyCents}], perMonth, perYear}`.
- `detectRecurring(state, today)` → предложения: merchant с ≥3 расходами за 120 дней, интервалы 25–35 дней (или 6–8 — недельные),
  суммы в пределах ±15% от медианы, нет активного правила с таким merchant → `[{merchant, amountCents (медиана), freq, day, categoryId, accountId, count}]`.

### Прогноз (`dist/core/forecast.js`, `MoneyCore.forecast`)
- `project(state, {today, days = 60, view = "noLoans"})` → стартовый остаток = `views.breakdown(state).views[view]` на сегодня;
  применяет по дням все occurrences со статусом overdue (в день today), due, upcoming (expense −, income +, transfer — только если
  переводит в/из счёта, не входящего в view, например в кредит). Возвращает
  `{points:[{date, balance}], nextIncome: {date, name, amountCents}|null, untilIncome: {date, plannedOut, plannedIn, endBalance},
    minBalance, minDate, deficitDate|null}`.

### Тесты (`tests/stage4.test.cjs`)
1. monthly day 31 в феврале → 28/29; weekly; yearly; days interval 14; startDate/endDate; paused/archived не дают occurrences.
2. Статусы: confirmed по links, skipped, overdue, upcoming; подтверждение с другой суммой → deviation +150.
3. Интернет 1 200 ₽ 5-го: confirmOp создаёт expense с категорией; баланс меняется только после подтверждения.
4. Прогноз: остаток 50 000, квартира 25 000 24-го, интернет 1 200 5-го, зарплата 80 000 5-го → nextIncome, endBalance, deficitDate при нехватке.
5. subscriptions: 799/мес + 2 990/год → perMonth 1 048,17; perYear.
6. detectRecurring: Netflix 799 ×4 раз с интервалом ~30 дней → предложение; разовые покупки — нет.
7. schema: валидные/невалидные правила; links.scheduleId на несуществующее правило — допустимо (правило могли удалить), но dueDate валидна.

## 2. Интерфейс — вкладка «планы» (мобильная вкладка; на десктопе — пункт меню и экран в средней колонке)
1. **`$ ближайшие`**: просроченные (цвет --warn, `[!]`) и платежи на 14 дней:
   `24 окт · квартира            −25 000,00 ₽   [✓] [пропустить]`.
   `[✓]` открывает шторку записи, предзаполненную (сумма, счёт, категория, магазин, дата = dueDate, но можно поменять) с пометкой
   `-- по плану: квартира, 24 окт`; после сохранения строка становится `[✓] списано · −25 150 ₽ (+150 к плану)`.
2. **`$ прогноз`**: строка `-- до зарплаты 5 нояб: расходы по плану −26 200 ₽ · останется 23 800 ₽`;
   SVG-график остатка на 60 дней (линия --accent, нулевая линия, точки платежей; дефицит — участок ниже нуля цветом --over),
   `[!] 3 нояб не хватит 1 200 ₽` если deficitDate. Вид итога — как выбран в box «остаток» (balanceView).
3. **`$ подписки`**: `-- в месяц 1 048 ₽ · в год 12 578 ₽`, список подписок с месячным эквивалентом.
4. **`$ регулярные`**: все правила, группы доходы/расходы/переводы; `[+ регулярный]` → шторка:
   название, тип [расход][доход][перевод], сумма, счёт (и «куда» для перевода), категория (как в форме записи), где,
   периодичность: `[каждый месяц] [каждую неделю] [каждый год] [каждые N дней]` + день (число / день недели / дата), дата начала (datepicker),
   окончание (необязательно), `[✓] подписка`, у существующего — `[пауза]` `[в архив]`.
5. **`$ похоже на регулярные`** (если detectRecurring что-то нашёл): `Netflix · ~799 ₽ каждый месяц [сделать регулярным] [не надо]`
   («не надо» — список скрытых merchant в настройках устройства).
- **Главный экран:** если есть платежи на сегодня или просроченные — плашка над журналом
  `[!] сегодня: квартира −25 000 ₽ [✓] · ещё 2 просрочено [планы]`.
- В журнале операция по плану: мета `-- по плану · квартира`.
- Скрытие сумм, i18n ru/en, темы — как везде. sw.js: новые файлы в кэш, CACHE поднять.
