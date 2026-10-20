# Настройки: язык (ru/en) и 23 темы

## Язык
- Новый файл `dist/i18n.js` (UMD, `MoneyCore.i18n`): словари `ru` и `en`, `t(key, params)` с подстановкой `{name}`,
  `plural(n, forms)` (ru: one/few/many по правилам 1/2–4/5+ и 11–14; en: one/other), `setLang`, `getLang`,
  `fmtMoney(cents)` (всегда рубли ₽; разделители по локали: ru-RU «1 234,56 ₽», en-US «₽1,234.56» — или «1,234.56 ₽», главное единообразно),
  `fmtDate(iso, style)` по локали.
- Язык по умолчанию: `navigator.language` начинается с `ru` → ru, иначе en. Переопределяется в настройках.
- ВСЕ строки интерфейса (index.html и app.js: подписи, кнопки, плейсхолдеры, aria-label, тосты, пустые состояния, диалоги, ошибки форм)
  переходят в словари. Статическая разметка — атрибуты `data-i18n="key"`, `data-i18n-placeholder`, `data-i18n-aria-label`;
  `applyI18n()` проходит по DOM; динамическое — через `t()`. Смена языка применяется сразу без перезагрузки (applyI18n + render).
  `<html lang>` обновляется.
- Ошибки, которые бросает dist/core (русские строки), переводятся при показе: словарь `errors` в en с ключом = точный русский текст;
  если перевода нет — показать как есть.
- Стиль английских строк — как у init.Tasks: строчные, коротко («journal», «accounts», «+ money in», «− money out», «⇄ transfer», «$ balance»).
- Названия стандартных категорий (появятся на этапе 2) тоже в словаре: ключи `cat.<key>` (сделай пустой раздел, его заполнят позже).

## Темы
- `dist/themes.js` уже есть (`MoneyCore.themes.THEMES`, 23 темы: id, name, dark, c{bg,accent,headers,text,comment,separator,warn,cyan}). Не менять.
- Применение темы: JS ставит CSS-переменные на `document.documentElement.style`:
  --bg, --text, --accent, --headers, --warn, --cyan; --muted = comment; --border = separator;
  производные смешиванием hex в JS (не color-mix): --border-dim = mix(separator, bg, 0.5); --panel = mix(text, bg, 0.05);
  --panel-2 = mix(text, bg, 0.08); --accent-dim = mix(accent, bg, 0.45); --on-accent = bg; --tree = mix(comment, bg, 0.6);
  --over = dark ? #FF7B72 : #CF222E; --purple = dark ? #BC8CFF : #8250DF; --orange = dark ? #F0883E : #BC4C00;
  --backdrop = rgba(0,0,0,.6). `meta[name=theme-color]` = bg. `document.documentElement.dataset.dark = "1"|"0"` и `color-scheme`.
- Убрать из style.css блок `[data-theme="paper"]`; значения по умолчанию в `:root` = github dark.
- Без мигания при загрузке: в `<head>` синхронно подключить themes.js и маленький `boot.js`, который читает настройки и применяет тему до отрисовки.
- Режим «авто» (по умолчанию): следует `prefers-color-scheme` и переключается на лету; тёмная = выбранная пользователем тёмная тема (по умолчанию githubDark), светлая = выбранная светлая (по умолчанию ayuLight).
- Кнопка в топбаре `[светлая]/[тёмная]` остаётся: переключает между выбранной тёмной и выбранной светлой и выключает «авто».

## Настройки
- Хранение: `localStorage["money.log.settings"] = {lang: "auto"|"ru"|"en", themeMode: "auto"|"dark"|"light", darkTheme, lightTheme}` (try/catch).
- Экран «настройки»: на мобильном — пункт в «ещё» (box `$ settings`/`$ настройки` вверху экрана «ещё»), на десктопе — пункт `настройки` в левом меню, экран в средней колонке (тот же механизм showScreen, что у экрана счёта).
  - box `$ язык`: `[авто] [русский] [english]`.
  - box `$ тема`: `[авто] [тёмная] [светлая]`, ниже два списка «// тёмные» и «// светлые»: строка = 4 квадратика 12px с цветами bg/accent/headers/warn (рамка separator) + название; выбранная помечена `[✓]` и цветом accent. Тап выбирает тему в своей группе и применяет сразу.
- sw.js: добавить i18n.js, themes.js, boot.js в кэш; CACHE = "money-log-v10".

## Проверка
- `npm test`, `node --check` для всех изменённых js, сверка id app.js ↔ index.html.
- Скрипт: в index.html/app.js не осталось кириллицы вне i18n.js (кроме комментариев) — выведи найденные строки.
