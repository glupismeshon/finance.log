# Этап 0 — каркас v2 (спецификация)

Цель: перевести хранение на схему v2 (счета + проводки), не меняя поведение UI для пользователя.
После этапа приложение выглядит и работает как раньше (доход/расход, один счёт), но данные уже в v2.

## Файлы

Новые модули в `dist/core/` — по образцу текущего `ledger.js` (IIFE/UMD):
в node — `module.exports`, в браузере — свойства общего объекта `globalThis.MoneyCore`
(`MoneyCore.money`, `MoneyCore.schema`, `MoneyCore.journal`, `MoneyCore.views`).
Зависимости в node подключаются `require("./money.js")`, в браузере — из `globalThis.MoneyCore`.
Подключить в `index.html` по порядку: money, schema, journal, views, затем app.js. `ledger.js` удалить.

- `core/money.js`: `parseAmount(value, signed=false)`, `validDate(value)`, `MAX_AMOUNT` — перенести из ledger.js без изменений.
- `core/schema.js`: `empty(todayISO)`, `validate(data)`, `migrate(data, todayISO)`.
- `core/journal.js`: `upsertOperation(state, op, nowISO)`, `setDeleted(state, id, deleted)`, `merge(state, imported, todayISO)`, `setOpening(state, accountId, cents)`.
- `core/views.js`: `balances(state)`, `totals(state)`.

## Схема v2

```js
{
  version: 2,
  accounts:   [{id, name, kind, openingCents, openingDate, archived:false}],
  categories: [],            // заполняется на этапе 2
  operations: [{
    id, type, date, note, createdAt, updatedAt, deleted,
    legs: [{accountId, amountCents}],          // знаковые копейки; влияют на остатки
    allocations: [{categoryId, amountCents}],  // «на что»; НЕ влияют на остатки
    links: {},
    revisions: [{at, before}]                  // before = снимок операции без поля revisions
  }],
  schedules: [], reserves: [], budgets: [], loans: []
}
```

- `kind` ∈ `debit | cash | savings | credit_card | loan | person`.
- `empty(today)` создаёт один счёт `{id:"main", name:"Основной", kind:"debit", openingCents:0, openingDate:today}`.
- Этап 0 разрешает `type` только `income | expense` (список держать в константе `OP_TYPES`, чтобы расширять).
  - income: ровно 1 leg с `amountCents > 0`; allocations пустые.
  - expense: ровно 1 leg с `amountCents < 0`; allocations — 0 или больше, и если есть, их сумма = |leg|.
  - `categoryId` — строка или `null`.
- Ограничения как в v1: id `/^[\w-]{1,100}$/` уникальны, note ≤ 160 символов, даты через `validDate`,
  суммы — safe integer, |сумма| ≤ MAX_AMOUNT, accountId должен существовать, ≤ 100000 операций,
  `createdAt`/`updatedAt` — парсящиеся ISO-строки, `deleted` — boolean, `revisions` — массив (≤ 20, лишние старые отбрасываются при upsert).
- `validate` возвращает нормализованную копию (только известные поля), бросает Error с русским текстом.
  Неизвестная версия → «Не удалось прочитать копию money.log. Проверьте формат файла.»

## Миграция v1 → v2 (`migrate(data, today)`)

- `version:2` → `validate(data)`.
- `version:1` → валидируется старым правилом (перенести v1-валидатор в schema.js как внутренний), затем:
  - счёт `main`, `openingCents` = v1.openingCents, `openingDate` = минимальная дата записей, либо `today`, если записей нет;
  - income: `legs:[{accountId:"main", amountCents:+a}]`, `allocations:[]`;
  - expense: `legs:[{accountId:"main", amountCents:-a}]`, `allocations:[{categoryId:null, amountCents:a}]`;
  - `updatedAt = createdAt`, `links:{}`, `revisions:[]`, `id/date/note/deleted` — как были.
- Иначе — ошибка формата.

## Журнал

- `upsertOperation(state, op, now)`: если id существует и содержимое изменилось — в `revisions` нового
  варианта добавить `{at: now, before: <старая операция без revisions>}`, `updatedAt = now`, `createdAt` сохранить.
  Если не изменилось — вернуть state как есть. Результат прогнать через `validate`.
- `setDeleted` — как в v1 (не пишет ревизию). Неизвестный id → «Запись не найдена.»
- `merge(state, imported, today)`: `imported` сначала через `migrate`. Добавляются операции с новыми id
  (существующие не перезаписываются). Начальный остаток счёта `main` берётся из импорта, только если
  в текущем журнале нет операций и `openingCents === 0`. Счета из импорта с новыми id добавляются.
  Возвращает `{state, added}`.
- `setOpening(state, accountId, cents)`.

## Представления

- `balances(state)` → `{byAccount: {[id]: cents}, total}`: opening + сумма legs неудалённых операций;
  `total` — сумма по счетам кроме `loan` и `person`.
- `totals(state)` → `{income, expense, balance}` с той же семантикой, что в v1:
  income = сумма legs income-операций, expense = |сумма legs| expense-операций, balance = `balances().total`.
  Проверять safe integer, как в v1.

## UI (`dist/app.js`)

- Новый ключ `money.log.ledger.v2`. При старте: если v2 есть — читать его; иначе если есть v1
  (`money.log.ledger.v1`) — `migrate`, записать в v2, **v1 не трогать** (остаётся резервом); иначе `empty`.
- Внешнее поведение не меняется: форма доход/расход пишет операцию на счёт `main`
  (expense — с allocation `{categoryId:null}`), редактирование через `upsertOperation`,
  список, фильтры, поиск, удаление/восстановление, начальный остаток (`setOpening` для `main`),
  экспорт v2, импорт v1 или v2, синхронизация между вкладками (событие storage по ключу v2).
- Отображение суммы операции: |сумма leg|.

## Тесты

`tests/ledger.test.cjs` переписать на новые модули (`tests/core.test.cjs`), сохранив смысл всех текущих проверок, плюс:
1. Миграция: v1 {opening 10 000 ₽, доход 2 000, расход 320,50} → v2, `totals` = {200000, 32050, 1167950}; удалённые записи переносятся с deleted.
2. Повторная миграция v2 → без изменений.
3. Правка суммы создаёт ровно одну ревизию с прежней суммой; сохранение без изменений ревизию не создаёт; ревизий не больше 20.
4. Валидация отвергает: expense с положительным leg, income с отрицательным, неизвестный accountId, allocations с суммой ≠ |leg|, type "transfer", версию 3.
5. merge v1-копии в пустой v2-журнал даёт тот же результат, что migrate.

`npm test` должен проходить: обновить скрипт на `node --test tests/*.test.cjs`, если нужно.
