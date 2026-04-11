# Розклад Студента — Контекст проєкту

## Що це
PWA веб-додаток + Telegram бот для перегляду розкладу пар коледжу МПМЕК (mpmek.site). Два окремих репозиторія/папки:

---

## 1. Веб-додаток (`/Какая то идея` → GitHub: `nazarn1xyy/mpmek`)

**Стек:** Vanilla JS, CSS, HTML, хостинг Vercel, PWA з Service Worker, Redis (Upstash)

### Структура файлів

**`app/` — фронтенд (SPA):**
- `index.html` — основна сторінка з вкладками: Розклад, Завдання, Налаштування
- `app.js` (~60KB) — вся клієнтська логіка: вибір групи, відображення розкладу по днях, навігація `weekOffset`, підвіски/заміни, домашка, push-сповіщення, шерінг картинок (canvas)
- `style.css` — стилі (мінімалістична чорно-біла тема, dark/light)
- `schedule.json` (~65KB) — розклад всіх груп. Структура:
  ```json
  {
    "КСМ-24-1": {
      "ОСНОВНИЙ РОЗКЛАД": { "Понеділок": [{ "number": 1, "subject": "...", "teacher": "..." }] },
      "ЧИСЕЛЬНИК": { ... },
      "ЗНАМЕННИК": { ... },
      "ПІДВІСКА": [{ "date": "DD.MM", "number": 1, "subject": "...", "teacher": "..." }]
    }
  }
  ```
- `sw.js` — Service Worker (network-first для JSON, stale-while-revalidate для статики). Версія кешу бампається при кожній публікації з адмінки
- `manifest.json` — PWA маніфест з шорткатом на віджет
- `widget.html` — standalone міні-віджет: поточна/наступна пара з прогрес-баром, повний список пар, автооновлення кожні 60с

**`app/admin/` — адмін-панель:**
- `index.html` (~1260 рядків, inline JS) — повна адмін-панель: PIN-авторизація, редагування розкладу, управління підвісками, публікація через GitHub API (PUT `schedule.json`), бамп SW кешу, push+Telegram сповіщення про нові заміни
- `admin.js` — старіша версія (не використовується, без сповіщень)
- `admin.css` — стилі адмінки

**`api/` — Vercel serverless функції:**
- `schedule-image.js` — генерація PNG зображень розкладу через `@napi-rs/canvas`. Параметри: `group`, `day`, `theme` (light/dark), `weekOffset`. Читає домашку з Redis
- `homework.js` — CRUD API для домашки (Redis hash `hw:{group}`, поле `{dayName}:{number}`). GET/POST/DELETE
- `pidveska.js` — API для додавання/видалення підвісок у `schedule.json` через GitHub API. Авторизація через `bot_token`. POST (додати) / DELETE (видалити)
- `telegram-notify.js` — відправка Telegram сповіщень підписникам групи про нові заміни. Читає `chat_id` з Redis SET `tg_subs:{group}`
- `tg-subscribe.js` — реєстрація Telegram `chat_id` для групи в Redis (SADD/SREM). Авторизація через `bot_token`
- `notify-subs.js` — Web Push сповіщення (VAPID) про нові заміни
- `subscribe.js` / `unsubscribe.js` — підписка/відписка web push
- `telegram.js` — обробка Telegram webhook для inline-запитів (Vercel-версія)
- `telegram-setup.js` — встановлення webhook URL
- `test-push.js` — тестова відправка push
- `cron/daily-notify.js` — щоденна відправка розкладу (Vercel Cron, 5:00 UTC Пн-Пт)
- `_lib/redis.js` — утиліта для Upstash Redis через HTTP API
- `_fonts/` — шрифти SF Pro для canvas

**Конфіги:**
- `vercel.json` — serverless налаштування, cron, кешування headers
- `package.json` — залежності: `@napi-rs/canvas`, `web-push`

### Ключові механіки
- **Домашка** зберігається в Redis, синхронізується між веб-додатком (localStorage ↔ Redis) і картинками
- **Підвіски/заміни** — адмінка пушить в `schedule.json` через GitHub API → Vercel деплоїть за ~30с
- **Сповіщення** — при публікації замін адмінка паралельно відправляє Web Push і Telegram повідомлення
- **Шерінг** — клієнтський canvas рендеринг розкладу у PNG з домашкою

---

## 2. Telegram бот (`/Розклад copy/bot.py`)

**Стек:** Python 3, python-telegram-bot, apscheduler, aiohttp, pytz

### Файли
- `bot.py` (~2235 рядків) — весь бот
- `data.json` — дані користувачів (група, час сповіщень, active) + розклад МЕД-SECRET
- `OOBJECT.py` — об'єкт `ALL_GROUPS` зі списком всіх груп та їх розкладами
- `parse_all.py` — парсер текстових розкладів
- `requirements.txt` — залежності

### Архітектура бота

**Налаштування:**
- `BOT_TOKEN`, `DATA_FILE`, `TZ` (Europe/Kiev)
- `HOMEWORK_API_URL` / `HOMEWORK_API_TOKEN` — зовнішній API домашки (ngrok, старий)
- `WEB_SCHEDULE_URL` = `https://mpmek.site/schedule.json`
- `TG_SUBSCRIBE_URL` = `https://mpmek.site/api/tg-subscribe`
- `PIDVESKA_API_URL` = `https://mpmek.site/api/pidveska`
- `ADMIN_IDS`, `SECRET_MED_ID`, `MED_GROUP`

**Синхронізація розкладу:**
- `_fetch_web_schedule()` — завантажує `schedule.json` з кешем 5 хв (TTL)
- `_convert_web_group()` — конвертує формат сайту → формат бота (ОСНОВНИЙ РОЗКЛАД → regular, ЧИСЕЛЬНИК → regular_chiselnyk, ЗНАМЕННИК → regular_znamennyk, ПІДВІСКА → pidveska)
- `get_schedule_data(group)` — повертає дані з web schedule для звичайних груп, з `data.json` для МЕД-SECRET
- Всі команди читання (`/today`, `/tomorrow`, `/week`, `/now`, `/free`, `/teacher`, `/subjects`, `/stats`, `/pidveska`) використовують `get_schedule_data()`

**Синхронізація підписників:**
- `_sync_tg_subscription(chat_id, group, old_group)` — при виборі групи реєструє user в Redis через `/api/tg-subscribe`
- Bulk-sync всіх юзерів при старті бота (`post_init`)

**Підвіски через бот → сайт:**
- Парсинг тексту підвіски → `POST /api/pidveska` (додає в `schedule.json` через GitHub API)
- `/delpidveska` → `DELETE /api/pidveska`
- Після зміни скидає кеш web schedule

**Команди:**
- `/start` — привітання, вибір групи
- `/today`, `/tomorrow`, `/week` — розклад (текст)
- `/now` — що зараз (поточна пара, наступна, вікно)
- `/setgroup` — змінити групу
- `/settime HH:MM` — час щоденного сповіщення
- `/free` — вільні вікна сьогодні
- `/teacher Прізвище` — пари викладача на тижні
- `/subjects` — всі предмети та викладачі
- `/stats` — статистика тижня
- `/feedback` — зворотний зв'язок
- `/pidveska [ГРУПА]` — перегляд підвісок
- `/delpidveska ГРУПА ДАТА ПАРА` — видалення підвіски
- `/broadcast` — розсилка всім
- `/reload` — скидання кешу (data.json + web schedule)
- `/switchmed` — перемикання парності для МЕД

**Inline режим:**
- `@bot` або `@bot dark` / `@bot white` — вибір теми картинок
- Результати: Сьогодні, Завтра, Тиждень, Пн-Пт (з правильним `weekOffset`)
- На вихідних замість "Сьогодні"/"Завтра" показує назви днів (Понеділок/Вівторок)
- Картинки генеруються через `mpmek.site/api/schedule-image`

**Щоденна розсилка:**
- `send_daily()` — кожну хвилину перевіряє час сповіщень юзерів, відправляє розклад
- `cleanup_old_pidveska()` — очищення старих підвісок (cron 3:00)

---

## Vercel Environment Variables (потрібні)
- `KV_REST_API_URL` / `KV_REST_API_TOKEN` — Upstash Redis
- `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` — Web Push
- `TELEGRAM_BOT_TOKEN` — токен Telegram бота
- `GITHUB_TOKEN` — GitHub Personal Access Token (для `api/pidveska.js`)
- `GITHUB_OWNER` (опціонально, default: `nazarn1xyy`)
- `GITHUB_REPO` (опціонально, default: `mpmek`)

---

## Що вже зроблено (хронологія)
1. ✅ Фікс підвіска/заміна — розрізнення в рендерингу (заміна замінює існуючу пару, підвіска додає нову)
2. ✅ Фікс weekOffset — правильні дати в шерінг-картинках
3. ✅ Домашка в картинках — server-side (schedule-image.js) та client-side (app.js canvas)
4. ✅ Redis-backed homework API — `api/homework.js`, синхронізація localStorage ↔ Redis
5. ✅ Синхронізація розкладу бот → сайт — бот читає `schedule.json` замість `data.json`
6. ✅ Telegram сповіщення про заміни — `api/telegram-notify.js` + `api/tg-subscribe.js`, адмінка відправляє при публікації
7. ✅ Підвіска з бота → `schedule.json` — `api/pidveska.js` (GitHub API), бот пушить заміни на сайт
8. ✅ PWA віджет — `widget.html` (поточна пара, прогрес-бар, автооновлення)
9. ✅ Inline dark/light тема — `@bot dark` для темних картинок
10. ✅ Розумні лейбли на вихідних — замість "Сьогодні" показує "Понеділок" в inline
