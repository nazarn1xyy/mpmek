const CACHE_NAME = 'rozklad-v25';
const NOTIF_CACHE = 'notif-config';
const STATIC_ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './schedule.json',
  './manifest.json',
  './icon.png'
];

// Pre-cache on install
self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
});

// Purge old caches on activate
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME && k !== NOTIF_CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Stale-while-revalidate: serve from cache instantly, update in background
self.addEventListener('fetch', event => {
  // Skip caching for admin panel — always fetch fresh
  if (event.request.url.includes('/admin')) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then(cached => {
      const fetchPromise = fetch(event.request).then(networkResponse => {
        if (networkResponse && networkResponse.status === 200) {
          const clone = networkResponse.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return networkResponse;
      }).catch(() => cached);

      return cached || fetchPromise;
    })
  );
});

// ===== Notification click — open/focus the app and show today =====
self.addEventListener('notificationclick', event => {
  event.notification.close();

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if (client.url.includes(self.registration.scope) || client.url.includes('/index.html')) {
          return client.focus().then(c => {
            c.postMessage({ type: 'SHOW_TODAY' });
            return c;
          });
        }
      }
      return clients.openWindow(self.registration.scope + '?view=today');
    })
  );
});

// ===== Periodic Background Sync (best-effort, Android Chrome installed PWA) =====
self.addEventListener('periodicsync', event => {
  if (event.tag === 'daily-schedule') {
    event.waitUntil(showCachedScheduleNotification());
  }
});

// ===== Push handler (for future server-side push) =====
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { /* ignore */ }
  const title = data.title || 'Розклад Студента';
  const options = {
    body: data.body || 'Перевірте розклад на сьогодні',
    icon: './icon.png',
    badge: './icon.png',
    tag: 'daily-schedule',
    data: { url: '?view=today' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// ===== Build and show notification from cached schedule data =====
async function showCachedScheduleNotification() {
  try {
    const UK_DAYS = ['Неділя', 'Понеділок', 'Вівторок', 'Середа', 'Четвер', "П'ятниця", 'Субота'];
    const TIMES = { 1: '08:30', 2: '10:00', 3: '11:50', 4: '13:20', 5: '16:00', 6: '17:40' };

    // Read stored group
    const ncache = await caches.open(NOTIF_CACHE);
    const cfgResp = await ncache.match('/config');
    if (!cfgResp) return;
    const { group, lessonTimes } = await cfgResp.json();
    if (!group) return;

    const times = lessonTimes || TIMES;

    // Read schedule.json from any cache
    let scheduleData;
    const schedResp = await caches.match(new Request(new URL('./schedule.json', self.registration.scope).href));
    if (schedResp) {
      scheduleData = await schedResp.clone().json();
    } else {
      try {
        const r = await fetch(new URL('./schedule.json', self.registration.scope).href);
        scheduleData = await r.json();
      } catch { return; }
    }

    if (scheduleData._settings) delete scheduleData._settings;

    const groupData = scheduleData[group];
    if (!groupData) return;

    const today = new Date();
    let dayIdx = today.getDay();
    let prefix = 'Сьогодні';

    if (dayIdx === 0 || dayIdx === 6) {
      prefix = dayIdx === 6 ? 'У понеділок' : 'Завтра';
      dayIdx = 1;
    }

    const dayName = UK_DAYS[dayIdx];

    let weekData = groupData['ОСНОВНИЙ РОЗКЛАД'];
    if (!weekData || typeof weekData !== 'object' || Array.isArray(weekData)) {
      const types = Object.keys(groupData).filter(t => t !== 'ПІДВІСКА');
      if (types.length === 0) return;
      weekData = groupData[types[0]];
    }

    if (!weekData || !weekData[dayName] || weekData[dayName].length === 0) return;

    // Check substitutions
    const currentDayOfWeek = today.getDay() || 7;
    const targetDayOfWeek = dayIdx || 7;
    const offset = targetDayOfWeek - currentDayOfWeek;
    const targetDate = new Date(today);
    targetDate.setDate(today.getDate() + offset);
    const dateStr = String(targetDate.getDate()).padStart(2, '0') + '.' + String(targetDate.getMonth() + 1).padStart(2, '0');

    let pairs = [...weekData[dayName]];
    const subs = groupData['ПІДВІСКА'] || [];
    const subsForDate = subs.filter(s => s.date === dateStr);
    subsForDate.forEach(sub => {
      pairs = pairs.filter(p => parseInt(p.number) !== parseInt(sub.number));
      pairs.push({ ...sub, isSubstitution: true });
    });

    if (pairs.length === 0) return;
    pairs.sort((a, b) => parseInt(a.number) - parseInt(b.number));

    const lines = pairs.map(p => {
      const t = times[p.number] ? times[p.number].split(' - ')[0] || times[p.number] : '';
      const sub = p.isSubstitution ? ' ⚡' : '';
      return `${p.number}. ${p.subject}${t ? ' — ' + t : ''}${sub}`;
    });

    await self.registration.showNotification(`📚 ${prefix} — ${dayName}`, {
      body: lines.join('\n'),
      icon: './icon.png',
      badge: './icon.png',
      tag: 'daily-schedule',
      data: { url: '?view=today' },
      renotify: true
    });
  } catch (e) {
    // Silently fail
  }
}
