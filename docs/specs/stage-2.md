# Этап 2 — категории, магазины, подсказки

## Логика (dist/core/*)

### Категории
- Категория: `{id, key|null, name|null, parentId|null, kind: "expense"|"income", archived:false, order}`.
  Стандартные категории имеют `key` (имя берёт UI из словаря `cat.<key>`), пользовательские — `name`. Ровно одно из key/name непустое.
  Глубина — максимум 2 уровня (у родителя parentId = null). parentId должен ссылаться на категорию того же kind.
- Стандартный набор (`DEFAULT_CATEGORIES` в новом модуле `dist/core/categories.js`), id = "c-" + key:
  expense: groceries (дети: groceries_meat, groceries_dairy, groceries_produce, groceries_other), transport, housing, subscriptions,
  health, clothing, fun, household, other_expense;
  income: salary, advance, family_help, refund_in, other_income.
- `schema.empty()` и `migrate()` (v1 и v2 без категорий) добавляют стандартный набор, если `categories` пустой. Существующие категории не трогать.
- Валидатор: категории (уникальные id, ссылки parentId, kind), allocation.categoryId — null или существующая категория нужного kind
  (expense-операция → expense-категории, income → income).
- income теперь может иметь allocations: 0 или 1+ с суммой = leg (источник дохода).
- `categories.js`: `addCategory(state,{id,name,parentId,kind})`, `updateCategory(state,id,patch)` (name, parentId, order;
  переименование стандартной ставит name и оставляет key), `archiveCategory(state,id,archived)`, `tree(state, kind)` →
  `[{cat, children:[cat…]}]` без архивных, по order.

### Магазин / источник
- Операция income/expense получает необязательное поле `merchant` (строка 1–80 после trim, иначе поле отсутствует).
- `merchantKey(s)` = trim + lower + схлопнуть пробелы + `ё→е`.

### Подсказки (`dist/core/suggest.js`, `MoneyCore.suggest`)
- `merchants(state, type, prefix, limit=8)` → известные магазины/источники для type (expense|income), отсортированные по частоте
  (неудалённые операции), фильтр по началу любого слова (без учёта регистра/ё); возвращает исходное написание из последней операции.
- `forMerchant(state, type, merchant)` → `{categoryId, accountId, lastAmountCents, lastDate}` по последней операции с этим merchantKey
  (categoryId — первой allocation; accountId — самый частый счёт для этого магазина). null, если не было.
- `recentCategories(state, type, limit=6)` → id категорий, отсортированные по частоте за последние 90 дней.

### Представления (views.js)
- `spending(state, {from, to, type="expense", by="category"|"parent"|"merchant", accountId?})` → массив `{id|merchant, cents}` по убыванию;
  by "parent" сворачивает подкатегории в родителя; null-категория → id `null`.

### Тесты (tests/stage2.test.cjs)
1. empty() содержит стандартные категории; migrate v1 → категории добавлены, старые расходы с categoryId null валидны.
2. Валидатор отвергает: income-операцию с expense-категорией, 3-й уровень вложенности, parentId другого kind, категорию без key и name.
3. Подсказки: после «Пятёрочка»/«пятерочка»/«ПЯТЁРОЧКА» — один merchant, forMerchant даёт последнюю категорию и самый частый счёт;
   merchants(prefix "пят") находит; префикс по второму слову («ВкусВилл Экспресс», prefix "экс») находит.
4. spending by parent: 1000 в groceries_meat + 500 в groceries → groceries 1500.
5. archiveCategory скрывает из tree, но операции с ней валидны.
6. Все старые тесты зелёные.

## Интерфейс

Все строки — через i18n (dist/i18n.js, ключи в ru и en). Названия стандартных категорий — словарь `cat.<key>` (ru/en),
пользовательские — `name`; если у стандартной есть `name` — показывать `name`.

### Форма записи (расход / доход)
- Новое поле **«где» / «откуда деньги»** (merchant) — текстовое, с подсказками: под полем строка «чипов» из `suggest.merchants(state, type, prefix)`
  (при пустом поле — самые частые). Тап по чипу подставляет имя и применяет `suggest.forMerchant`: категорию и счёт
  (только если пользователь их ещё не трогал в этой форме). Подсказка последней суммы — серым текстом под суммой
  `// в прошлый раз 1 850,00 ₽` (не подставлять в поле).
- **Категория**: строка чипов «недавние» (`suggest.recentCategories`, до 6) + кнопка `[все категории]`, открывающая список-дерево
  (`categories.tree`) внутри шторки: родитель жирным, дети с отступом `└`. Выбор родителя допустим. Выбранная категория — чип с цветом --accent.
  Категория необязательна (тогда allocation `{categoryId:null}` как сейчас).
- Для дохода дерево income-категорий («зарплата», «аванс»…). Для перевода категории и merchant скрыты.
- Порядок полей в шторке: сумма → где/откуда → категория → счёт (если счетов > 1) → заметка → дата → записать.
- Сохранение: `merchant` в операцию, allocation с выбранной categoryId на всю сумму.

### Журнал
- Заголовок строки: merchant, если есть, иначе заметка, иначе название категории, иначе «расход/доход».
- Мета: `// продукты · Сбер` (категория · счёт; если merchant и заметка есть — заметка отдельной мета-строкой).
- Фильтр по категории: на десктопе select рядом с фильтром по счёту; на мобильном — тап по названию категории в мета-строке фильтрует журнал по ней (с плашкой `// фильтр: продукты [×]`).

### Экран «категории»
- Мобильный: пункт в «ещё»; десктоп: пункт в левом меню. Box `$ категории` с переключателем `[расходы] [доходы]`, дерево с суммой за текущий месяц справа
  (`views.spending` by category, родитель — сумма с детьми), внизу `// итого за <месяц>`.
- `[+ категория]` и тап по категории → шторка: название, родитель (select из корневых того же вида или «— нет»), `[в архив]`.
- Архивные — свёрнуто `// в архиве: N [показать]`.

### Проверка
- `npm test`, `node --check`, сверка id, наборы ключей ru/en совпадают, sw.js CACHE = "money-log-v11".
