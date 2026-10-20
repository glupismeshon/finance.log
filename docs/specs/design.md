# Дизайн: стиль init.Tasks (inittasks.com)

Цель — визуально повторить интерфейс init.Tasks (блок preview на их главной): терминальная эстетика,
моноширинный шрифт, тонкие рамки, ASCII-элементы. Название, логотип и иконки остаются нашими
(money.log). Иконки SF Symbols с их сайта НЕ копировать — использовать инлайн-SVG в стиле Lucide
(stroke 1.75, 14×14, `stroke="currentColor"`), либо текстовые символы.

## Токены (CSS-переменные, взяты с сайта)

Тёмная тема (по умолчанию, `:root`):
--bg #0D1117; --text #E6EDF3; --muted #747D88; --accent #34C48A; --accent-dim #1f6e51; --on-accent #0D1117;
--headers #58A6FF; --warn #D29922; --cyan #56D4DD; --border #21262D; --border-dim #181C22; --panel #161A21;
--panel-2 #1E232B; --purple #BC8CFF; --orange #F0883E; --over #FF7B72; --tree #4a5563;
--mono 'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace

Светлая (`:root[data-theme="paper"]` — ключ темы в app.js уже "terminal"/"paper", оставить):
--bg #FAFAFA; --text #5C6166; --muted #6D747D; --accent #F2AE49; --accent-dim #F4C57E; --on-accent #0b0d10;
--headers #399EE6; --warn #F2AE49; --cyan #4CBF99; --border #E7E8E9; --border-dim #ECEDED; --panel #F2F2F3;
--panel-2 #EDEEEE; --purple #8250DF; --orange #BC4C00; --over #FF7B72; --tree #AAAEB3

Шрифт: JetBrains Mono 400/500/600/700 через Google Fonts (`<link>` с preconnect), фолбэк — системный моно.
Мета theme-color в app.js: тёмная #0D1117, светлая #FAFAFA. В manifest.webmanifest background/theme_color → #0D1117.

## Типографика и базовые элементы
- body: 13px/1.6, color --text, bg --bg. Всё в нижнем регистре там, где это подписи интерфейса
  (как у них: «today», «inbox») — у нас по-русски строчными: «журнал», «удалённые», «новая запись».
- Ссылки/бренд: --headers, 700, 14px.
- Вторичный текст: --muted, 12.5px.
- Кнопки: `.btn` inline-flex, gap 8px, padding 8px 16px, 12.5px, 600, radius 4px, без рамки;
  primary — фон `color-mix(in srgb, var(--accent) 15%, transparent)`, цвет --accent, hover 24%;
  ghost — прозрачный, 1px solid --border, hover border --accent-dim. Мелкие текстовые кнопки — в квадратных скобках: `[изменить]` `[удалить]` `[+]`, цвет --muted, hover --accent.
- Поля ввода: bg --bg, 1px solid --border, radius 6px, padding 8px 11px, 13px; focus — border --accent-dim.

## Компоненты
- **Топбар**: fixed, высота 40px, bg --bg, нижняя граница 1px --border. Слева бренд:
  квадратная иконка 20px (radius 22.5%, рамка 1px --border) + `money.log` (--headers, 700) + мигающий
  блок-курсор `▊` цвета --accent. Справа `[светлая]`/`[тёмная]` — переключатель темы (--muted), дата.
- **Box** (главный контейнер-панель): `position:relative; border:1px solid --border; radius 6px`,
  тело padding 24px 22px 20px. Подпись `.box-label` вставлена в верхнюю рамку: absolute top -9px left 12px,
  фон --bg, padding 0 7px, цвет --accent, 12.5px 600, `::before{content:"$ "}`.
  Использовать для: «$ остаток», «$ новая запись», «$ журнал».
- **Боковое меню** (как .pv-nav): ширина 172–220px, справа граница `1px dashed --border-dim`.
  Пункт `.qv`: flex, gap 7px, padding 2px 7px 2px 4px, radius 4px, иконка --muted, счётчик справа --muted;
  активный — фон --panel, текст/иконка/счётчик --accent. Разделитель секций — `border-top:1px dashed --border-dim`.
  Заголовок секции `.nsec`: --muted, справа `[+]` цвета --accent (на будущее — «счета [+]»).
- **Заголовок списка** `.ihead`: иконка --muted + текст 600 + счётчик цвета --warn.
- **Строка операции** (как .todo): grid `24px 1fr auto`, padding 2.5px 6px 2.5px 0, radius 4px, hover фон --panel.
  Слева маркер в моноширинном стиле: `[+]` для дохода (--accent), `[-]` для расхода (--muted).
  Название — заметка или «доход»/«расход». Сумма справа: доход --accent, расход --text.
  Под строкой мета `.tmeta`: margin-left 28px, --muted, `::before{content:"// "}` — время/тип/«удалено».
- **Подзаголовок дня** `.shead`: --muted, `::before{content:"// "}`, например `// сегодня · 20 октября`.
- **Разделитель** `.ovdiv`: `border-top:1px dashed --border-dim; margin:8px 0 3px`.
- **Остаток**: внутри box «$ остаток» — крупная сумма (28–32px, 500, --text), копейки --muted;
  ниже строки в стиле лога: `[ok] доходы  +2 000,00 ₽` (метка `[ok]` --accent), `[--] расходы −320,50 ₽`
  (метка --warn), `// начальный остаток 10 000,00 ₽ [изменить]`.
- **Пустое состояние**: `$ money.log` + `[ok] журнал загружен` + `[ok] записей пока нет` + кнопка primary «+ первая запись».
- **Тост**: box-стиль внизу, текст + `[вернуть]` `[×]`.
- **Диалоги** (<dialog>): box-стиль с подписью-label, фон --bg, backdrop rgba(0,0,0,.6).
- Переключатель расход/доход в форме: две кнопки `[ расход ]` `[ доход ]`, выбранная — фон --panel, цвет --accent.

## Раскладка
- Десктоп (≥ 900px): топбар; ниже grid `220px 1fr 340px`: меню | box «$ журнал» | box «$ остаток» над box «$ новая запись» (sticky).
- Планшет 600–900: меню скрыто в верхнюю строку вкладок `[журнал 3] [удалённые 1]`; две колонки.
- Телефон < 600: одна колонка, порядок: остаток → новая запись → журнал. Отступы по бокам 16px,
  без горизонтальной прокрутки, `env(safe-area-inset-*)` для топбара (viewport-fit=cover уже стоит).
  Поле суммы 16px+ (чтобы iOS не зумил), `inputmode="decimal"`.

## Ограничения
- Не менять dist/core/* и бизнес-логику. Менять index.html, style.css, app.js (только рендер/разметку), manifest.
- Все id, на которые опирается app.js, сохранить или аккуратно переименовать везде.
- `prefers-reduced-motion` — выключать мигание курсора.
- Кнопка N/Т для новой записи, Escape, доступность (aria-label, aria-pressed, aria-current) — сохранить.
