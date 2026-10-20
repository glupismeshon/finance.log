# Регистрация — этап A: вход через Google и Telegram

Основание: docs/specs/auth-sync.md (раздел «Решения»). Синхронизации данных на этом этапе НЕТ — только аккаунт.

## Инфраструктура (уже готово)
- Worker `finance-log`, статика из `dist/` (assets), D1 база `finance-log` с binding `DB` (в wrangler.jsonc).
- Секрет `GOOGLE_CLIENT_SECRET` загружен. `TELEGRAM_BOT_TOKEN` пользователь добавит позже — код должен работать и без него
  (кнопка Telegram скрыта, `/api/auth/telegram/*` → 503 `{error:"telegram_not_configured"}`).
- Не-секретные значения — в `wrangler.jsonc` → `vars`:
  `GOOGLE_CLIENT_ID = "839074567407-ik3741jit4g7oh7edl4c7nbbpngvpj42.apps.googleusercontent.com"`,
  `APP_ORIGIN = "https://finance-log.money-log.workers.dev"`, `TELEGRAM_BOT_NAME = ""`.

## Worker
- `wrangler.jsonc`: `"main": "worker/index.js"`, assets с `"binding": "ASSETS"` и `"run_worker_first": ["/api/*"]` —
  всё остальное отдаётся статикой как сейчас.
- Без фреймворков и npm-зависимостей (чистый Workers API + WebCrypto). Модули: `worker/index.js` (роутер),
  `worker/auth.js`, `worker/db.js`, `worker/util.js`.
- Миграции D1: `migrations/0001_auth.sql`:
  ```sql
  users(id TEXT PK, name TEXT, avatar TEXT, created_at INTEGER)
  identities(provider TEXT, provider_id TEXT, user_id TEXT, email TEXT, name TEXT, created_at INTEGER, PRIMARY KEY(provider, provider_id))
  sessions(id_hash TEXT PK, user_id TEXT, created_at INTEGER, last_seen INTEGER, expires_at INTEGER, user_agent TEXT)
  ```
  Применять: `npx wrangler d1 migrations apply finance-log --remote` (и `--local` для dev).

### Эндпоинты
- `GET /api/auth/google/start?link=0|1` → 302 на Google (scope `openid email profile`, `state` + PKCE `code_verifier`
  в короткоживущей подписанной HttpOnly cookie `fl_oauth`, 10 мин, SameSite=Lax).
- `GET /api/auth/google/callback` → проверка state, обмен code (token endpoint с client_secret и code_verifier),
  данные пользователя из `id_token` (проверить `aud`, `iss`, `exp`; подпись можно не проверять, т.к. токен получен напрямую
  с token endpoint по TLS) → upsert identity → сессия → 302 на `/#settings`.
- `GET /api/auth/telegram/start` → 302 на `https://oauth.telegram.org/auth?bot_id=<число из токена до ':'>&origin=<APP_ORIGIN>&request_access=write&return_to=<APP_ORIGIN>/api/auth/telegram/callback`.
- `GET /api/auth/telegram/callback` — Telegram возвращает данные в `#tgAuthResult=<base64 json>` (во фрагменте!) — поэтому
  callback отдаёт маленькую HTML-страницу, которая читает hash и делает `POST /api/auth/telegram` с JSON.
- `POST /api/auth/telegram` → проверка подписи по документации Telegram Login (HMAC-SHA256, ключ = SHA256(bot_token),
  data_check_string из отсортированных полей кроме hash), `auth_date` не старше 1 суток → upsert → сессия → `{ok:true}`.
- **Привязка**: если запрос пришёл с действующей сессией и `link=1`, новая identity привязывается к текущему user_id
  (если она уже принадлежит другому пользователю — ошибка `identity_in_use`).
- `GET /api/me` → `{user:{id,name,avatar}, identities:[{provider, email, name}], sessions:N}` или 401.
- `POST /api/auth/logout` → удалить текущую сессию; `POST /api/auth/logout-all`.
- `DELETE /api/me/identities/:provider` — отвязать (нельзя отвязать последнюю).
- Сессия: случайные 32 байта → cookie `fl_session` (`HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=30 дней`),
  в БД хранится только SHA-256. Продление `last_seen` не чаще раза в час.
- CSRF: все POST/DELETE требуют заголовок `X-Requested-With: finance.log` и Origin = APP_ORIGIN.
- Ответы JSON, ошибки `{error:"код"}`; никаких секретов в логах.

## Клиент (dist/)
- В «настройках» новый первый box `$ аккаунт` (`$ account`):
  - не вошёл: строка `-- не выполнен вход. данные хранятся только на этом устройстве.` и кнопки
    `[войти через Google]` `[войти через Telegram]` (вторая скрыта, если `/api/me` вернул `telegram:false` в `GET /api/config`);
  - вошёл: имя/аватар (аватар 24px, скругление 4px), `-- google: mail@… · telegram: @name`, кнопки
    `[привязать Telegram]`/`[привязать Google]` (если нет), `[выйти]`, `[выйти на всех устройствах]`.
- `GET /api/config` → `{google:true, telegram:<есть ли токен>, telegramBot:<имя>}`.
- Вход — обычный переход по ссылке (не fetch), после возврата приложение открывает экран настроек (`#settings`).
- Офлайн или ошибка сети — box показывает `-- нет связи с сервером` и не мешает работе приложения.
- Service worker НЕ должен кэшировать `/api/*` (проверить sw.js: пропускать запросы с путём `/api/`).
- i18n ru/en для всех строк. sw.js CACHE поднять.

## Тесты
- `tests/worker.test.cjs` (node:test, без сети): проверка подписи Telegram на известном примере (сгенерировать в тесте
  HMAC самим), хеширование сессии, парсинг/проверка id_token (aud/iss/exp), CSRF-проверка. Вынести чистые функции в
  `worker/util.js`, чтобы их можно было импортировать в тестах (ESM: использовать `import()` из .cjs или сделать тест `.mjs` и
  добавить в `npm test`).
- Локальная проверка: `npx wrangler dev` (порт 8787) + `npx wrangler d1 migrations apply finance-log --local`.

## Деплой (делает Opus после проверки)
1. `npx wrangler d1 migrations apply finance-log --remote`
2. `npm run deploy`
3. Пользователь в Google Console добавляет origin и redirect URI (см. инструкцию в чате).
