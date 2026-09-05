const CACHE_NAME = 'rozklad-v62';
const NOTIF_CACHE = 'notif-config';
const STATIC_ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icon.png',
  './icon-192.png'
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

// Fetch strategy
self.addEventListener('fetch', event => {
  // Skip caching for admin panel
  if (event.request.url.includes('/admin')) {
    return;
  }

  const url = new URL(event.request.url);

  // Network-first for API calls (schedule data)
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(event.request).then(networkResponse => {
        if (networkResponse && networkResponse.status === 200) {
          const clone = networkResponse.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return networkResponse;
      }).catch(() => caches.match(event.request))
    );
    return;
  }

  // Fast Stale-While-Revalidate for schedule.json
  if (url.pathname.endsWith('schedule.json')) {
    event.respondWith(
      caches.open(CACHE_NAME).then(cache => {
        return cache.match(event.request).then(cachedResponse => {
          const fetchPromise = fetch(event.request).then(networkResponse => {
            if (networkResponse && networkResponse.status === 200) {
              cache.put(event.request, networkResponse.clone());
            }
            return networkResponse;
          }).catch(() => cachedResponse);

          return cachedResponse || fetchPromise;
        });
      })
    );
    return;
  }

  // Cache-First for versioned static assets (CSS, JS, images with ?v=)
  if (url.searchParams.has('v') || url.pathname.endsWith('.png') || url.pathname.endsWith('.svg') || url.pathname.endsWith('.ico')) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(networkResponse => {
          if (networkResponse && networkResponse.status === 200) {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return networkResponse;
        });
      })
    );
    return;
  }

  // Network-first for HTML pages with fast offline fallback
  event.respondWith(
    fetch(event.request).then(networkResponse => {
      if (networkResponse && networkResponse.status === 200) {
        const clone = networkResponse.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
      }
      return networkResponse;
    }).catch(() => {
      return caches.match(event.request).then(cached => {
        if (cached) return cached;
        if (event.request.mode === 'navigate') {
          return caches.match('./') || caches.match('./index.html');
        }
        return null;
      });
    })
  );
});

// ===== Notification click — open/focus the app and show today =====
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const notifUrl = (event.notification.data && event.notification.data.url) || '?view=today';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if (client.url.includes(self.registration.scope) || client.url.includes('/index.html')) {
          return client.focus().then(c => {
            c.postMessage({ type: 'SHOW_DAY', url: notifUrl });
            return c;
          });
        }
      }
      return clients.openWindow(self.registration.scope + notifUrl);
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
    data: { url: data.url || '?view=today' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// ===== Build and show notification from cached schedule data =====
async function showCachedScheduleNotification() {
  try {
    const UK_DAYS = ['Неділя', 'Понеділок', 'Вівторок', 'Середа', 'Четвер', "П'ятниця", 'Субота'];
    const TIMES = { 1: '08:30', 2: '10:00', 3: '11:50', 4: '13:20', 5: '14:50', 6: '16:20' };

    // Read stored group
    const ncache = await caches.open(NOTIF_CACHE);
    const cfgResp = await ncache.match('/config');
    if (!cfgResp) return;
    const { group, lessonTimes } = await cfgResp.json();
    if (!group) return;

    const times = lessonTimes || TIMES;

    // Read schedule data from cache
    let scheduleData;
    const schedUrl = new URL('/schedule.json', self.registration.scope).href;
    const schedResp = await caches.match(new Request(schedUrl));
    if (schedResp) {
      scheduleData = await schedResp.clone().json();
    } else {
      try {
        const r = await fetch(schedUrl);
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

    function getWeekType(date) {
      const d = new Date(date);
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() + 3 - (d.getDay() + 6) % 7);
      const week1 = new Date(d.getFullYear(), 0, 4);
      const weekNum = 1 + Math.round(((d - week1) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);
      return weekNum % 2 === 0 ? 'ЗНАМЕННИК' : 'ЧИСЕЛЬНИК';
    }

    const currentWeekType = getWeekType(today);
    let weekData = groupData['ОСНОВНИЙ РОЗКЛАД'] || groupData[currentWeekType];
    if (!weekData || typeof weekData !== 'object' || Array.isArray(weekData)) {
      const types = Object.keys(groupData).filter(t => t !== 'ПІДВІСКА');
      if (types.length === 0) return;
      weekData = groupData[types.includes(currentWeekType) ? currentWeekType : types[0]];
    }

    if (!weekData || !weekData[dayName] || weekData[dayName].length === 0) return;

    // Check substitutions
    const currentDayOfWeek = today.getDay() || 7;
    const targetDayOfWeek = dayIdx || 7;
    let offset = targetDayOfWeek - currentDayOfWeek;
    if (offset < 0) offset += 7;
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
      const sub = p.isSubstitution ? ' (заміна)' : '';
      return `${p.number}. ${p.subject}${t ? ' — ' + t : ''}${sub}`;
    });

    await self.registration.showNotification(`${prefix} — ${dayName}`, {
      body: lines.join('\n'),
      icon: './icon.png',
      badge: './icon.png',
      tag: 'daily-schedule',
      data: { url: `?view=day&date=${dateStr}` },
      renotify: true
    });
  } catch (e) {
    // Silently fail
  }
}
