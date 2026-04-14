# 📚 Розклад Студента — Архітектура системи

> [!info] Проект
> **mpmek.site** — веб-додаток + Telegram-бот для перегляду розкладу коледжу МПМЕК.
> Два репозиторії, єдине джерело даних — `schedule.json`.

---

## 🏗 Загальна архітектура

```mermaid
graph TB
    subgraph Users ["👥 Користувачі"]
        Student["📱 Студент"]
        Admin["👨‍💻 Адмін"]
    end

    subgraph Web ["🌐 Сайт — mpmek.site"]
        PWA["app/<br/>index.html + app.js<br/><i>PWA, Service Worker</i>"]
        AdminPanel["app/admin/<br/><i>PIN-авторизація</i>"]
        Widget["widget.html<br/><i>Міні-віджет</i>"]
    end

    subgraph API ["⚡ Vercel Serverless API"]
        ImgAPI["schedule-image.js<br/><i>PNG генерація</i>"]
        HwAPI["homework.js<br/><i>CRUD домашки</i>"]
        PidvAPI["pidveska.js<br/><i>Підвіски → GitHub</i>"]
        TgNotify["telegram-notify.js<br/><i>TG сповіщення</i>"]
        PushNotify["notify-subs.js<br/><i>Web Push</i>"]
        TgSub["tg-subscribe.js<br/><i>Підписка на групу</i>"]
    end

    subgraph Bot ["🤖 Telegram Bot — @MPMEK_BOT"]
        BotPy["bot.py<br/><i>Python, remote server</i>"]
        DataJSON["data.json<br/><i>users only</i>"]
    end

    subgraph External ["☁️ Зовнішні сервіси"]
        Redis[("🔴 Redis<br/>Upstash")]
        GitHub[("🐙 GitHub API<br/>schedule.json")]
        TgAPI["💬 Telegram Bot API"]
    end

    Schedule[("📄 schedule.json<br/><b>Єдине джерело</b>")]

    Student --> PWA
    Student --> BotPy
    Admin --> AdminPanel
    Admin --> BotPy

    PWA --> Schedule
    PWA --> HwAPI
    BotPy -->|fetch кеш 5хв| Schedule
    BotPy --> PidvAPI
    BotPy --> TgSub
    BotPy --> TgAPI

    AdminPanel -->|GitHub API PUT| GitHub
    AdminPanel --> TgNotify
    AdminPanel --> PushNotify
    PidvAPI --> GitHub
    GitHub -->|auto-deploy| Schedule

    ImgAPI --> Schedule
    ImgAPI --> Redis
    HwAPI --> Redis
    TgNotify --> TgAPI
    TgSub --> Redis
    PushNotify --> Redis

    BotPy --> DataJSON
```

---

## 📁 Файлова структура

> [!abstract] Веб-додаток — `nazarn1xyy/mpmek`

| Файл | Опис |
|------|------|
| `app/index.html` | Головна сторінка PWA |
| `app/app.js` | SPA логіка: розклад, ДЗ, сповіщення, навігація |
| `app/style.css` | Стилі додатку |
| `app/sw.js` | Service Worker — кеш, push-нотифікації |
| `app/schedule.json` | 📌 **Єдине джерело розкладу для всіх** |
| `app/manifest.json` | PWA маніфест |
| `app/widget.html` | Міні-віджет розкладу |
| `app/admin/index.html` | Адмін-панель (PIN-авторизація) |
| `app/admin/admin.js` | Редагування розкладу, публікація через GitHub API |
| `api/_lib/redis.js` | Обгортка Upstash Redis REST API |
| `api/schedule-image.js` | Генерація PNG розкладу (`@napi-rs/canvas`) |
| `api/homework.js` | CRUD домашніх завдань (Redis) |
| `api/pidveska.js` | Додавання/видалення підвісок через GitHub API |
| `api/telegram.js` | Webhook бота (inline-режим на Vercel) |
| `api/telegram-notify.js` | TG-сповіщення про заміни |
| `api/tg-subscribe.js` | Підписка TG-юзерів на групу |
| `api/subscribe.js` | Web Push підписка |
| `api/unsubscribe.js` | Web Push відписка |
| `api/notify-subs.js` | Надсилання Web Push |
| `api/admin-config.js` | GitHub-налаштування (Redis) |
| `api/cron/daily-notify.js` | Щоденне cron-сповіщення |

> [!abstract] Telegram-бот — окремий сервер

| Файл | Опис |
|------|------|
| `bot.py` | Монолітний скрипт бота (~2100 рядків) |
| `data.json` | Дані користувачів (групи, час сповіщень) |
| `OOBJECT.py` | Словник груп → список предметів |

---

## 📄 Формат schedule.json

```json
{
  "КСМ-2024-1": {
    "ОСНОВНИЙ РОЗКЛАД": {
      "Понеділок": [
        { "number": 1, "subject": "Математика", "teacher": "Шмундяк О.В.", "room": "42" }
      ]
    },
    "ЧИСЕЛЬНИК": { "Понеділок": [ ... ] },
    "ЗНАМЕННИК": { "Вівторок": [ ... ] },
    "ПІДВІСКА": [
      { "date": "14.04", "number": 2, "subject": "Фізика", "teacher": "Фельчин Б.М." }
    ]
  }
}
```

> [!tip] Тип тижня
> **ЧИСЕЛЬНИК** — непарний тиждень, **ЗНАМЕННИК** — парний. **ОСНОВНИЙ РОЗКЛАД** — пари які є завжди.
> **ПІДВІСКА** — одноразові заміни на конкретну дату.

---

## 🔄 Потоки даних

### 1️⃣ Студент відкриває сайт

```mermaid
sequenceDiagram
    participant B as 📱 Браузер
    participant SW as Service Worker
    participant S as schedule.json
    participant API as /api/homework

    B->>SW: GET mpmek.site
    SW->>S: fetch schedule.json
    S-->>SW: JSON розклад
    SW-->>B: Рендер розкладу
    B->>API: GET ?group=КСМ-2024-1
    API-->>B: Домашні завдання
```

### 2️⃣ Студент пише боту `/today`

```mermaid
sequenceDiagram
    participant U as 💬 Юзер
    participant Bot as 🤖 bot.py
    participant Web as mpmek.site
    
    U->>Bot: /today
    Bot->>Web: GET schedule.json (кеш 5 хв)
    Web-->>Bot: JSON
    Bot->>Bot: build_schedule_message()
    Bot-->>U: Текстове повідомлення з розкладом
```

### 3️⃣ Інлайн-режим `@MPMEK_BOT`

```mermaid
sequenceDiagram
    participant U as 💬 Юзер
    participant Bot as 🤖 bot.py
    participant V as ⚡ Vercel
    participant TG as Telegram

    U->>Bot: @MPMEK_BOT [dark]
    Bot->>Bot: Формує URL /api/schedule-image
    Bot-->>TG: InlineQueryResultArticle + невидиме посилання
    TG->>V: GET /api/schedule-image?group=...&day=1
    V-->>TG: PNG картинка
    TG-->>U: Повідомлення з preview картинкою
```

### 4️⃣ Адмін додає підвіску (бот)

```mermaid
sequenceDiagram
    participant A as 👨‍💻 Адмін
    participant Bot as 🤖 bot.py
    participant API as ⚡ pidveska.js
    participant GH as 🐙 GitHub

    A->>Bot: /pidveska КСМ-2024-1 ...
    Bot->>API: POST /api/pidveska (auth: bot_token)
    API->>GH: GET schedule.json (SHA)
    API->>API: Додає підвіску
    API->>GH: PUT schedule.json (commit)
    GH-->>API: OK
    API-->>Bot: { ok: true }
    Note over GH: Vercel auto-deploy 30-60 сек
    Bot->>Bot: Скинути кеш _SCHEDULE
    Bot-->>A: ✅ Підвіска додана
```

### 5️⃣ Адмін публікує з веб-панелі

```mermaid
sequenceDiagram
    participant A as 👨‍💻 Адмін
    participant Panel as 🖥 admin.js
    participant GH as 🐙 GitHub
    participant TG as TG notify
    participant Push as Web Push

    A->>Panel: PIN → Редагування → Publish
    Panel->>GH: PUT schedule.json
    Panel->>GH: PUT sw.js (bump cache ver)
    Panel->>TG: POST /api/telegram-notify
    Panel->>Push: POST /api/notify-subs
    Note over GH: Vercel auto-deploy
    TG-->>TG: Сповіщення в Telegram
    Push-->>Push: Web Push сповіщення
```

---

## 🛠 Стек технологій

| Компонент | Технологія |
|:----------|:-----------|
| 🌐 **Сайт** | Vanilla JS, CSS, HTML (PWA) |
| ☁️ **Хостинг** | Vercel (serverless functions) |
| 🤖 **Бот** | Python, python-telegram-bot v20+, apscheduler |
| 🔴 **БД** | Upstash Redis (REST API) |
| 🖼 **Картинки** | @napi-rs/canvas (Node.js) |
| 🔔 **Push** | web-push (VAPID) |
| 📄 **Розклад** | GitHub repo → schedule.json |
| 🚀 **CI/CD** | Vercel auto-deploy on git push |

---

## 🔑 Env-змінні (Vercel)

> [!warning] Не коммітити в репо!

| Змінна | Опис |
|:-------|:-----|
| `TELEGRAM_BOT_TOKEN` | Токен Telegram-бота |
| `GITHUB_TOKEN` | GitHub PAT (repo scope) |
| `GITHUB_OWNER` | Власник репо |
| `GITHUB_REPO` | Назва репо |
| `KV_REST_API_URL` | Upstash Redis REST URL |
| `KV_REST_API_TOKEN` | Upstash Redis REST Token |
| `VAPID_PUBLIC_KEY` | Web Push public key |
| `VAPID_PRIVATE_KEY` | Web Push private key |
| `VAPID_SUBJECT` | mailto: контакт |
| `ADMIN_PIN` | 4-значний PIN адмін-панелі |

---

## 🔴 Redis-ключі

| Ключ | Тип | Опис |
|:-----|:----|:-----|
| `hw:{group}` | HASH | Домашні завдання. Поле: `{день}:{номер}` → текст |
| `push-subs` | HASH | Web Push підписки. Поле: `sha256(endpoint)` → JSON |
| `tg_subs:{group}` | SET | Telegram `chat_id` підписників групи |
| `admin-config` | STRING | JSON з GitHub налаштуваннями |

---

> [!quote] Автор
> Розробив **Назар Шикір** — МПМЕК, 2024-2026
