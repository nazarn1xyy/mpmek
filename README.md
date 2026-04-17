# 📅 Розклад Студента МПМЕК — PWA

Мінімалістичний PWA-додаток для перегляду розкладу пар. Чорно-біла тема, формат щоденника, офлайн-підтримка. Живий сайт: **[mpmek.site](https://mpmek.site)**.

## ✨ Можливості

- 📱 Встановлюється на телефон як нативний додаток
- 🌙 Темна та світла тема
- 📝 Домашні завдання синхронізуються між пристроями (через акаунт)
- 🔄 Автоматичне визначення чисельника/знаменника за ISO-тижнем
- ⚡ Заміни/підвіски підсвічуються окремо
- 🔔 Web Push + Telegram нотифікації про заміни
- 🗓 Два режими: список та тижнева сітка (Google Calendar)
- 📴 Працює офлайн завдяки Service Worker
- 🖼 Поділитися розкладом як зображенням (`@napi-rs/canvas`, Node runtime — не Edge)
- 🤖 Telegram-бот `@mpmek_bot` з inline-пошуком груп

## 🛠 Стек

- **Frontend:** Vanilla HTML / CSS / JS (без фреймворків)
- **Backend:** Vercel Serverless Functions (Node.js)
- **Сховище:** Upstash Redis (сесії, ДЗ, підписки)
- **PWA:** Service Worker + Web App Manifest
- **Деплой:** Vercel з автоматичним білдом на push до `main`

## 📂 Структура

```
├── api/                      # Serverless functions (12 штук — ліміт Hobby)
│   ├── _lib/redis.js         # Redis wrapper + rate limiter
│   ├── auth.js               # Реєстрація/логін/сесія
│   ├── admin-config.js       # Адмін-публікація (PIN + сесія)
│   ├── homework.js           # Синхронізація домашки
│   ├── pidveska.js           # Підвіски/заміни (для бота)
│   ├── push.js               # Web Push subscribe/unsubscribe
│   ├── notify-subs.js        # Надсилання push про заміни
│   ├── telegram.js           # Telegram webhook (inline queries)
│   ├── telegram-notify.js    # Надсилання TG про заміни
│   ├── telegram-setup.js     # One-time webhook setup
│   ├── tg-subscribe.js       # Підписка TG чату на групу
│   ├── schedule-image.js     # Генерація PNG розкладу
│   └── cron/daily-notify.js  # Щоденний cron push
├── app/                      # PWA (output для Vercel)
│   ├── index.html            # SPA shell
│   ├── app.js                # Весь клієнтський JS
│   ├── style.css             # Стилі
│   ├── sw.js                 # Service Worker
│   ├── manifest.json         # PWA manifest
│   ├── widget.html           # Компактний віджет
│   ├── admin/index.html      # Адмін-панель (PIN + адмін-сесія)
│   └── schedule.json         # Дані розкладу (оновлюється через адмінку)
└── vercel.json               # Headers, CSP, crons, routing
```

## 🔐 Env vars (Vercel)

```
ADMIN_PIN=XXXX             # 4-значний PIN для адмінки
ADMIN_PASSWORD=...         # Пароль адмін-логіну
ADMIN_USERNAMES=nazar      # Comma-separated логіни з адмін-роллю
GITHUB_TOKEN=ghp_...       # PAT з scope=repo для публікації
KV_REST_API_URL=...        # Upstash Redis
KV_REST_API_TOKEN=...      # Upstash Redis
VAPID_PUBLIC_KEY=...       # Web Push
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:...
CRON_SECRET=...            # Для захисту notify-subs від cron
TELEGRAM_BOT_TOKEN=...     # Для @mpmek_bot
TELEGRAM_WEBHOOK_SECRET=...# Перевірка Telegram webhook
PUSH_ENCRYPTION_KEY=...    # Опц. AES-256 (64 hex) для шифрування push-підписок у Redis
                           # Згенерувати: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## 🔄 Оновлення розкладу

**Через адмін-панель** (`/admin/`): ввести PIN + авторизуватись адмін-акаунтом → редагувати → "Опублікувати". Сервер сам пушить у GitHub через env-токен, Vercel автоматично деплоїть (~30с).

**Через бота:** бот шле `POST /api/pidveska` з `bot_token` — додає/видаляє підвіски.

## 🔍 Технічний аудит (v42)

Зміни після повного аудиту безпеки, продуктивності, SEO, доступності:

- **CSP:** Прибрано `'unsafe-inline'` з `script-src`; інлайн-скрипт винесено в `inline-boot.js`
- **Хедери:** Додано `worker-src 'self'`, `Cross-Origin-Opener-Policy: same-origin`
- **a11y:** `focus-visible` індикатор, `prefers-reduced-motion`, прибрано `user-scalable=no` з widget, контрастні кольори (WCAG AA), `aria-label` на кнопках, `<noscript>` fallback
- **SEO:** JSON-LD structured data, Twitter meta, `<lastmod>` в sitemap
- **Продуктивність:** `schedule.json` мініфіковано (240→150KB), прибрано зайвий preload, CSS `immutable` виправлено, `skipWaiting` тільки після підтвердження
- **Функціонал:** Кастомна `404.html`, кнопка "Спробувати знову" при помилці, `setInterval` зупиняється коли вкладка неактивна
- **Код:** Глобальний error handler, `DEPLOY_VERSION` синхронізовано з SW
