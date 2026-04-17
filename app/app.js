// Global error handlers — surface unhandled errors to user
window.addEventListener('unhandledrejection', function(e) {
    console.error('Unhandled promise rejection:', e.reason);
});
window.onerror = function(msg, src, line, col, err) {
    console.error('Global error:', msg, src, line, col, err);
};

// ===== Offline/Online indicator =====
(function() {
    const bar = document.createElement('div');
    bar.id = 'offlineBar';
    bar.textContent = 'Немає з\'єднання — дані можуть бути застарілими';
    bar.style.cssText = 'display:none;position:fixed;top:0;left:0;right:0;z-index:9999;padding:6px 16px;text-align:center;font-size:13px;font-weight:600;background:#ff3b30;color:#fff;font-family:-apple-system,sans-serif';
    document.body.prepend(bar);
    function update() { bar.style.display = navigator.onLine ? 'none' : 'block'; }
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    update();
})();

document.addEventListener('DOMContentLoaded', async () => {
    // Legacy localStorage cleanup (adminDeviceId was used pre-Bearer-auth)
    localStorage.removeItem('adminDeviceId');

    // ===== State =====
    let scheduleData = null;
    let selectedGroup = localStorage.getItem('selectedGroup');
    let currentWeekType = 'ОСНОВНИЙ РОЗКЛАД';
    let isDarkTheme = localStorage.getItem('theme') === 'dark';
    let _hwCache = null; // cached homework object
    let notificationsEnabled = localStorage.getItem('notifications') !== 'false';
    let weekOffset = 0; // 0 = current week, 1 = next week, -1 = previous week
    let VAPID_PUBLIC_KEY = 'BMOzNTERkpWZfX4i5P5E1wcd1zXOUlv-fbT1fw-cjWjZPG3xBeattWCIFUfWfHCN-7EGzqGWLnwEGgCEFW8tPpc';
    // Fetch fresh VAPID key from server (allows rotation without client rebuild)
    fetch('/api/vapid-key').then(r => r.json()).then(d => { if (d.publicKey) VAPID_PUBLIC_KEY = d.publicKey; }).catch(() => {});

    let LESSON_TIMES = {
        1: "08:30 - 09:50",
        2: "10:00 - 11:20",
        3: "11:50 - 13:10",
        4: "13:20 - 14:40",
        5: "14:50 - 16:10",
        6: "16:20 - 17:40"
    };

    const SVG_EMPTY_SCHEDULE = `<svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="empty-state-icon"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line><path d="M8 14h.01"></path><path d="M12 14h.01"></path><path d="M16 14h.01"></path><path d="M8 18h.01"></path><path d="M12 18h.01"></path><path d="M16 18h.01"></path></svg>`;
    const SVG_EMPTY_HOMEWORK = `<svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="empty-state-icon"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path><line x1="9" y1="14" x2="15" y2="14"></line></svg>`;

    const ukDays = ['Неділя', 'Понеділок', 'Вівторок', 'Середа', 'Четвер', 'П\'ятниця', 'Субота'];

    // Escape HTML to prevent XSS
    function escHtml(s) {
        const d = document.createElement('div');
        d.textContent = s;
        return d.innerHTML;
    }

    // Non-blocking toast (replaces alert) — announces to screen readers
    let _toastTimer = null;
    function showToast(msg, type) {
        let t = document.getElementById('_appToast');
        if (!t) {
            t = document.createElement('div');
            t.id = '_appToast';
            t.setAttribute('role', 'status');
            t.setAttribute('aria-live', 'polite');
            t.style.cssText = 'position:fixed;bottom:calc(80px + env(safe-area-inset-bottom,0px));left:50%;transform:translateX(-50%);background:#111;color:#fff;padding:12px 18px;border-radius:14px;box-shadow:0 10px 25px rgba(0,0,0,.3);z-index:99998;font-size:14px;font-weight:500;max-width:92vw;text-align:center;opacity:0;transition:opacity .2s';
            document.body.appendChild(t);
        }
        t.textContent = msg;
        t.style.background = type === 'error' ? '#c0392b' : '#111';
        t.style.opacity = '1';
        clearTimeout(_toastTimer);
        _toastTimer = setTimeout(() => { t.style.opacity = '0'; }, 3000);
    }

    // Get current time in Kyiv timezone (cached 1s to avoid repeated toLocaleString calls)
    let _kyivCache = null;
    let _kyivCacheTs = 0;
    function getKyivNow() {
        const now = Date.now();
        if (_kyivCache && now - _kyivCacheTs < 1000) return _kyivCache;
        const str = new Date().toLocaleString('en-GB', { timeZone: 'Europe/Kiev', hour12: false });
        // str = "DD/MM/YYYY, HH:MM:SS"
        const [datePart, timePart] = str.split(', ');
        const [dd, mm, yyyy] = datePart.split('/').map(Number);
        const [hh, mi, ss] = timePart.split(':').map(Number);
        _kyivCache = {
            year: yyyy, month: mm, day: dd, hours: hh, minutes: mi, seconds: ss,
            dayOfWeek: new Date(yyyy, mm - 1, dd).getDay(),
            totalMinutes: hh * 60 + mi
        };
        _kyivCacheTs = now;
        return _kyivCache;
    }

    // Get ISO week number for auto week type detection
    function getISOWeek(offset) {
        const now = new Date();
        const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
        d.setUTCDate(d.getUTCDate() + (offset || 0) * 7);
        d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
        const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
        return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
    }

    // Homework storage with in-memory cache
    function getHomework() {
        if (_hwCache) return _hwCache;
        try {
            _hwCache = JSON.parse(localStorage.getItem('homework') || '{}');
        } catch { _hwCache = {}; }
        return _hwCache;
    }
    function setHomework(data) {
        _hwCache = data;
        localStorage.setItem('homework', JSON.stringify(data));
    }
    function hwKey(group, day, number) {
        return `${group}|${day}|${number}`;
    }

    // Homework server sync
    async function syncHomeworkToServer(group, day, number, text) {
        try {
            const headers = { 'Content-Type': 'application/json' };
            if (authToken) headers['Authorization'] = 'Bearer ' + authToken;
            await fetch('/api/homework', {
                method: 'POST',
                headers,
                body: JSON.stringify({ group, day, number, text: text || '' })
            });
        } catch (e) { console.warn('HW sync push failed:', e); }
    }

    async function syncHomeworkFromServer() {
        if (!selectedGroup) return;
        try {
            const resp = await fetch(`/api/homework?group=${encodeURIComponent(selectedGroup)}`);
            if (!resp.ok) return;
            const serverHw = await resp.json();
            const localHw = getHomework();
            let merged = { ...localHw };
            let changed = false;
            // Server wins for existing server keys (skip empty values)
            for (const [key, value] of Object.entries(serverHw)) {
                if (!value) { if (merged[key]) { delete merged[key]; changed = true; } continue; }
                if (merged[key] !== value) { merged[key] = value; changed = true; }
            }
            // Push local-only keys to server
            const prefix = selectedGroup + '|';
            for (const key of Object.keys(localHw)) {
                if (key.startsWith(prefix) && !serverHw[key]) {
                    const parts = key.split('|');
                    syncHomeworkToServer(parts[0], parts[1], parts[2], localHw[key]);
                }
            }
            if (changed) {
                setHomework(merged);
                renderSchedule();
            }
        } catch (e) { console.warn('HW sync fetch failed:', e); }
    }

    // ===== DOM Elements (cached once) =====
    const screens = {
        onboarding: document.getElementById('onboarding'),
        schedule: document.getElementById('schedule'),
        homework: document.getElementById('homework'),
        settings: document.getElementById('settings')
    };
    const bottomNav = document.getElementById('bottomNav');
    const groupListContainer = document.getElementById('groupList');
    const groupSearch = document.getElementById('groupSearch');
    const diaryContainer = document.getElementById('diaryContainer');
    const homeworkContainer = document.getElementById('homeworkContainer');
    const currentGroupTitle = document.getElementById('currentGroupTitle');
    const weekTypeToggle = document.getElementById('weekTypeToggle');
    const shareScheduleBtn = document.getElementById('shareScheduleBtn');
    const navItems = document.querySelectorAll('.nav-item');
    const themeToggle = document.getElementById('themeToggle');
    const changeGroupBtn = document.getElementById('changeGroupBtn');
    const notifToggle = document.getElementById('notifToggle');
    const notifPrompt = document.getElementById('notifPrompt');
    const notifPromptBtn = document.getElementById('notifPromptBtn');
    const notifPromptClose = document.getElementById('notifPromptClose');
    const notifTimeSelect = document.getElementById('notifTimeSelect');
    const notifTimeRow = document.getElementById('notifTimeRow');
    const installRow = document.getElementById('installRow');
    const installBtn = document.getElementById('installBtn');
    const installOverlay = document.getElementById('installOverlay');
    const installClose = document.getElementById('installClose');
    const hwModal = document.getElementById('hwModal');
    const hwModalTitle = document.getElementById('hwModalTitle');
    const hwModalSubject = document.getElementById('hwModalSubject');
    const hwModalInput = document.getElementById('hwModalInput');
    const hwModalCancel = document.getElementById('hwModalCancel');
    const hwModalSave = document.getElementById('hwModalSave');

    const obIntro = document.getElementById('onboardingIntro');
    const obAuth = document.getElementById('onboardingAuth');
    const obGroups = document.getElementById('onboardingGroups');
    const obSlider = document.getElementById('obSlider');
    const obDots = document.querySelectorAll('.ob-dot');
    const obNext = document.getElementById('obNext');
    const obSkip = document.getElementById('obSkip');

    // Auth DOM
    const authTitle = document.getElementById('authTitle');
    const authSubtitle = document.getElementById('authSubtitle');
    const authRegisterFields = document.getElementById('authRegisterFields');
    const authDisplayName = document.getElementById('authDisplayName');
    const authUsername = document.getElementById('authUsername');
    const authPassword = document.getElementById('authPassword');
    const authError = document.getElementById('authError');
    const authSubmit = document.getElementById('authSubmit');
    const authToggleText = document.getElementById('authToggleText');
    const authToggleBtn = document.getElementById('authToggleBtn');
    const userInfoCard = document.getElementById('userInfoCard');
    const userAvatar = document.getElementById('userAvatar');
    const userDisplayNameEl = document.getElementById('userDisplayName');
    const userUsernameEl = document.getElementById('userUsername');
    const logoutRow = document.getElementById('logoutRow');
    const logoutBtn = document.getElementById('logoutBtn');

    const viewToggleBtn = document.getElementById('viewToggleBtn');
    const viewToggleIcon = document.getElementById('viewToggleIcon');
    let gridView = localStorage.getItem('gridView') === '1';

    let modalCurrentKey = null;
    let authToken = localStorage.getItem('authToken') || null;
    let currentUser = null; // { username, displayName, group }
    let isLoginMode = false;

    // ===== Auth helpers =====
    async function authFetch(action, method, body) {
        const opts = { method, headers: {} };
        if (authToken) opts.headers['Authorization'] = 'Bearer ' + authToken;
        if (body) {
            opts.headers['Content-Type'] = 'application/json';
            opts.body = JSON.stringify(body);
        }
        const resp = await fetch('/api/auth?action=' + action, opts);
        const data = await resp.json();
        if (resp.status === 429) throw new Error(data.error || 'Забагато спроб. Зачекайте');
        if (!resp.ok) throw new Error(data.error || 'Помилка сервера');
        return data;
    }

    function showAuthError(msg) {
        authError.textContent = msg;
        authError.classList.remove('hidden');
    }
    function hideAuthError() {
        authError.classList.add('hidden');
    }

    function setAuthMode(login) {
        isLoginMode = login;
        authTitle.textContent = login ? 'Увійти' : 'Створити акаунт';
        authSubtitle.textContent = login ? 'Раді бачити знову' : 'Щоб зберегти свій розклад';
        authRegisterFields.style.display = login ? 'none' : '';
        authSubmit.textContent = login ? 'Увійти' : 'Зареєструватися';
        authToggleText.textContent = login ? 'Немає акаунту?' : 'Вже є акаунт?';
        authToggleBtn.textContent = login ? 'Зареєструватися' : 'Увійти';
        authPassword.autocomplete = login ? 'current-password' : 'new-password';
        hideAuthError();
    }

    function showAuthScreen() {
        obAuth.classList.remove('hidden', 'ob-exiting');
        obGroups.classList.add('hidden');
        obIntro.classList.add('hidden');
        document.body.classList.add('ob-lock');
        setAuthMode(false);
    }

    function applyUserInfo(user) {
        currentUser = user;
        if (user) {
            userInfoCard.classList.remove('hidden');
            userDisplayNameEl.textContent = user.displayName;
            userUsernameEl.textContent = '@' + user.username;
            userAvatar.textContent = (user.displayName || 'U').charAt(0).toUpperCase();
            logoutRow.style.display = '';
        } else {
            userInfoCard.classList.add('hidden');
            logoutRow.style.display = 'none';
        }
    }

    function transitionAuthToGroups() {
        document.body.classList.remove('ob-lock');
        obGroups.classList.add('ob-groups-entering');
        obGroups.classList.remove('hidden');
        obAuth.classList.add('ob-exiting');
        let done = false;
        function cleanup() {
            if (done) return; done = true;
            obAuth.classList.add('hidden');
            obAuth.classList.remove('ob-exiting');
            requestAnimationFrame(() => obGroups.classList.remove('ob-groups-entering'));
        }
        obAuth.addEventListener('animationend', cleanup, { once: true });
        setTimeout(cleanup, 600);
        renderGroupList();
    }

    async function handleAuthSubmit() {
        hideAuthError();
        const username = authUsername.value.trim();
        const password = authPassword.value;

        if (!username || !password) { showAuthError('Заповніть всі поля'); return; }

        authSubmit.disabled = true;
        try {
            let data;
            if (isLoginMode) {
                data = await authFetch('login', 'POST', { username, password });
            } else {
                const displayName = authDisplayName.value.trim();
                if (!displayName) { showAuthError('Введіть ім\'я та прізвище'); authSubmit.disabled = false; return; }
                data = await authFetch('register', 'POST', { username, password, displayName });
            }
            authToken = data.token;
            localStorage.setItem('authToken', authToken);
            applyUserInfo(data.user);

            if (data.user.group) {
                // User already has a group — go to schedule
                selectedGroup = data.user.group;
                localStorage.setItem('selectedGroup', selectedGroup);
                obAuth.classList.add('hidden');
                document.body.classList.remove('ob-lock');
                navItems[0].classList.add('active');
                showScreen('schedule');
            } else {
                transitionAuthToGroups();
            }
        } catch (e) {
            showAuthError(e.message);
        }
        authSubmit.disabled = false;
    }

    authSubmit.addEventListener('click', handleAuthSubmit);
    authToggleBtn.addEventListener('click', () => setAuthMode(!isLoginMode));

    // Enter key submits
    [authUsername, authPassword, authDisplayName].forEach(el => {
        el.addEventListener('keydown', e => { if (e.key === 'Enter') handleAuthSubmit(); });
    });

    // Logout
    logoutBtn.addEventListener('click', async () => {
        try { await authFetch('logout', 'POST'); } catch (e) { console.warn('Logout request failed:', e); }
        authToken = null;
        currentUser = null;
        localStorage.removeItem('authToken');
        localStorage.removeItem('selectedGroup');
        selectedGroup = null;
        applyUserInfo(null);
        showScreen('onboarding');
        showAuthScreen();
    });

    // ===== Onboarding Intro Slider =====
    function initOnboardingIntro() {
        const SLIDES = 6;
        let cur = 0;
        obIntro.classList.remove('hidden');
        obGroups.classList.add('hidden');
        document.body.classList.add('ob-lock');

        function update() {
            obSlider.style.transform = `translateX(-${cur * (100 / SLIDES)}%)`;
            obDots.forEach((d, i) => d.classList.toggle('active', i === cur));
            obNext.textContent = cur === SLIDES - 1 ? 'Почати' : 'Далі';
            obSkip.style.opacity = cur === SLIDES - 1 ? '0' : '1';
            obSkip.style.pointerEvents = cur === SLIDES - 1 ? 'none' : 'auto';
        }

        function finishIntro() {
            localStorage.setItem('onboardingIntroDone', '1');
            // Transition to auth screen
            obAuth.classList.remove('hidden', 'ob-exiting');
            obIntro.classList.add('ob-exiting');
            let cleaned = false;
            function cleanupIntro() {
                if (cleaned) return;
                cleaned = true;
                obIntro.classList.add('hidden');
                obIntro.classList.remove('ob-exiting');
            }
            obIntro.addEventListener('animationend', cleanupIntro, { once: true });
            setTimeout(cleanupIntro, 600);
            setAuthMode(false);
        }

        obNext.addEventListener('click', () => {
            if (cur < SLIDES - 1) { cur++; update(); } else { finishIntro(); }
        });
        obSkip.addEventListener('click', finishIntro);

        // Touch swipe
        let tx = 0;
        obSlider.addEventListener('touchstart', e => { tx = e.touches[0].clientX; }, { passive: true });
        obSlider.addEventListener('touchend', e => {
            const dx = e.changedTouches[0].clientX - tx;
            if (dx < -50 && cur < SLIDES - 1) { cur++; update(); }
            if (dx > 50 && cur > 0) { cur--; update(); }
        }, { passive: true });
    }

    // ===== Theme (sync, no reflow) =====
    if (isDarkTheme) {
        document.body.setAttribute('data-theme', 'dark');
        themeToggle.checked = true;
    }

    function updateThemeColor(dark) {
        const color = dark ? '#000000' : '#ffffff';
        const meta = document.getElementById('metaThemeColor');
        if (meta) meta.setAttribute('content', color);
        document.documentElement.style.backgroundColor = dark ? '#000' : '#fff';
    }

    // Set initial theme color
    updateThemeColor(document.body.getAttribute('data-theme') === 'dark');

    themeToggle.addEventListener('change', (e) => {
        const dark = e.target.checked;
        document.body.classList.add('theme-transitioning');
        document.body.setAttribute('data-theme', dark ? 'dark' : '');
        if (!dark) document.body.removeAttribute('data-theme');
        localStorage.setItem('theme', dark ? 'dark' : 'light');
        updateThemeColor(dark);
        setTimeout(() => document.body.classList.remove('theme-transitioning'), 350);
    });

    // ===== Install Overlay =====
    // Always show in browser, hide only if we are absolutely sure it's standalone
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    if (isStandalone && installRow) {
        installRow.style.display = 'none';
    }


    // ===== Notifications =====
    notifToggle.checked = notificationsEnabled && ('Notification' in window) && Notification.permission === 'granted';

    // Notification time preference
    const savedNotifTime = localStorage.getItem('notifTime') || '08:00';
    notifTimeSelect.value = savedNotifTime;
    notifTimeRow.style.display = notifToggle.checked ? '' : 'none';

    notifTimeSelect.addEventListener('change', () => {
        localStorage.setItem('notifTime', notifTimeSelect.value);
        if (notificationsEnabled && Notification.permission === 'granted') {
            subscribeToPush();
        }
    });

    function showNotifPrompt() {
        if (!('Notification' in window)) return;
        if (Notification.permission === 'granted') return;
        if (localStorage.getItem('notifPromptDismissed')) return;
        notifPrompt.classList.remove('hidden');
    }

    function hideNotifPrompt() {
        notifPrompt.classList.add('hidden');
    }

    notifPromptBtn.addEventListener('click', async () => {
        const perm = await Notification.requestPermission();
        hideNotifPrompt();
        if (perm === 'granted') {
            localStorage.setItem('notifications', 'true');
            notificationsEnabled = true;
            notifToggle.checked = true;
            notifTimeRow.style.display = '';
            storeNotifConfig();
            subscribeToPush();
            showDailyNotification(true);
        }
    });

    notifPromptClose.addEventListener('click', () => {
        hideNotifPrompt();
        localStorage.setItem('notifPromptDismissed', '1');
    });

    notifToggle.addEventListener('change', async (e) => {
        if (e.target.checked) {
            if (!('Notification' in window)) {
                e.target.checked = false;
                showToast('Сповіщення недоступні в цьому браузері', 'error');
                return;
            }
            if (Notification.permission === 'denied') {
                showToast('Сповіщення заблоковані. Розблокуйте їх в налаштуваннях браузера', 'error');
                e.target.checked = false;
                return;
            }
            if (Notification.permission !== 'granted') {
                const perm = await Notification.requestPermission();
                if (perm !== 'granted') {
                    e.target.checked = false;
                    return;
                }
            }
            localStorage.setItem('notifications', 'true');
            notificationsEnabled = true;
            storeNotifConfig();
            notifTimeRow.style.display = '';
            subscribeToPush();
            showDailyNotification(true);
        } else {
            localStorage.setItem('notifications', 'false');
            notificationsEnabled = false;
            notifTimeRow.style.display = 'none';
            unsubscribeFromPush();
        }
    });

    changeGroupBtn.addEventListener('click', () => {
        localStorage.removeItem('selectedGroup');
        selectedGroup = null;
        // Clear server-side group so next login doesn't restore the old one
        if (authToken) {
            authFetch('setgroup', 'POST', { group: '' }).catch(() => {});
        }
        obIntro.classList.add('hidden');
        obAuth.classList.add('hidden');
        obGroups.classList.remove('hidden');
        document.body.classList.remove('ob-lock');
        showScreen('onboarding');
        renderGroupList();
    });

    // ===== Navigation =====
    navItems.forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            const target = item.getAttribute('data-target');
            navItems.forEach(n => n.classList.remove('active'));
            item.classList.add('active');
            showScreen(target);
        });
    });

    function showScreen(screenId) {
        Object.values(screens).forEach(s => s.classList.add('hidden'));
        screens[screenId].classList.remove('hidden');

        bottomNav.classList.toggle('hidden', screenId === 'onboarding');

        if (screenId === 'schedule' && selectedGroup) {
            refreshSchedule(true);
        } else if (screenId === 'homework') {
            renderHomeworkTab();
        }
    }

    // ===== Week Type Toggle =====
    weekTypeToggle.addEventListener('click', () => {
        if (!scheduleData || !scheduleData[selectedGroup]) return;
        const availableTypes = Object.keys(scheduleData[selectedGroup]).filter(t => t !== 'ПІДВІСКА');
        if (availableTypes.length === 0) return;

        let currentIndex = availableTypes.indexOf(currentWeekType);
        if (currentIndex === -1) currentIndex = 0;
        currentWeekType = availableTypes[(currentIndex + 1) % availableTypes.length];

        weekTypeToggle.textContent = currentWeekType;
        renderSchedule();
    });

    // ===== Show skeleton while loading =====
    if (selectedGroup) {
        diaryContainer.innerHTML = '<div class="skeleton skeleton-header"></div>' +
            '<div class="skeleton skeleton-card"></div>'.repeat(4);
    }

    // ===== Fetch schedule data =====
    let _lastFetchTime = 0;
    const REFRESH_INTERVAL = 5 * 60 * 1000; // 5 minutes

    async function refreshSchedule(silent) {
        const now = Date.now();
        function rerender() {
            if (selectedGroup && screens.schedule && !screens.schedule.classList.contains('hidden')) {
                if (typeof renderCurrentView === 'function') renderCurrentView(); else renderSchedule();
            }
        }
        // If data already loaded and less than 5 min old, just re-render
        if (scheduleData && (now - _lastFetchTime < REFRESH_INTERVAL)) {
            rerender();
            return;
        }
        try {
            // Match preload: same URL + same credentials mode so browser reuses preloaded response
            const resp = await fetch('schedule.json', { credentials: 'same-origin' });
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            const data = await resp.json();
            if (data._settings) {
                if (data._settings.lessonTimes) LESSON_TIMES = data._settings.lessonTimes;
                delete data._settings;
            }
            scheduleData = data;
            _lastFetchTime = Date.now();
            rerender();
        } catch (e) {
            // If network failed but we have cached data, just re-render
            if (scheduleData && silent) {
                rerender();
                return;
            }
            if (!silent) throw e;
        }
    }

    // Refresh data when user returns to the app / tab
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && selectedGroup) {
            refreshSchedule(true);
            syncHomeworkFromServer().catch(() => {});
        }
    });

    // ===== Load Data =====
    try {
        await refreshSchedule(false);
        syncHomeworkFromServer().catch(() => {});
    } catch (e) {
        diaryContainer.innerHTML = `<div class="empty-state-container">${SVG_EMPTY_SCHEDULE}<p class="empty-state-title">Помилка завантаження</p><p class="empty-state-desc">Не вдалося завантажити розклад.</p><button id="retryLoadBtn" style="margin-top:1rem;padding:.75rem 1.5rem;border-radius:16px;border:1px solid var(--border-color);background:var(--surface-color);color:var(--text-color);font-size:1rem;font-weight:600;cursor:pointer">Спробувати знову</button></div>`;
        const retryBtn = document.getElementById('retryLoadBtn');
        if (retryBtn) retryBtn.addEventListener('click', () => location.reload());
        return;
    }

    // ===== Groups =====
    function renderGroupList(filter = '') {
        const frag = document.createDocumentFragment();
        const lowerFilter = filter.toLowerCase();
        const groups = Object.keys(scheduleData).filter(k => k !== '_settings');

        for (let i = 0; i < groups.length; i++) {
            const group = groups[i];
            if (lowerFilter && !group.toLowerCase().includes(lowerFilter)) continue;

            const el = document.createElement('div');
            el.className = 'group-item';
            el.textContent = group;
            el.dataset.group = group;
            frag.appendChild(el);
        }

        groupListContainer.innerHTML = '';
        groupListContainer.appendChild(frag);
    }

    // Event delegation for group selection
    groupListContainer.addEventListener('click', (e) => {
        const item = e.target.closest('.group-item');
        if (!item) return;
        selectedGroup = item.dataset.group;
        weekOffset = 0;
        localStorage.setItem('selectedGroup', selectedGroup);
        // Save group to server if logged in
        if (authToken) {
            authFetch('setgroup', 'POST', { group: selectedGroup }).catch(() => {});
        }
        showScreen('schedule');
    });

    // Debounced search
    let searchTimer = null;
    groupSearch.addEventListener('input', (e) => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => renderGroupList(e.target.value), 120);
    });

    // ===== Homework Modal =====
    // Focus trap utility for modals (a11y)
    function trapFocus(container, e) {
        const focusable = container.querySelectorAll('button:not([disabled]), textarea, input, [tabindex]:not([tabindex="-1"])');
        if (focusable.length === 0) return;
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }

    function openHomeworkModal(key, subject, dayLabel, existingText) {
        modalCurrentKey = key;
        hwModalSubject.textContent = `${subject} — ${dayLabel}`;
        hwModalInput.value = existingText || '';
        hwModalTitle.textContent = existingText ? 'Редагувати завдання' : 'Додати завдання';
        hwModal.classList.remove('hidden');
        // Focus input after modal animates in (300ms is safe for most transitions)
        setTimeout(() => {
            hwModalInput.focus();
            // Place cursor at end of existing text
            if (existingText) {
                hwModalInput.setSelectionRange(existingText.length, existingText.length);
            }
        }, 250);
        
        // Auto-expand setup
        hwModalInput.style.height = '100px'; 
        setTimeout(() => {
            if(hwModalInput.scrollHeight > 100) {
                hwModalInput.style.height = hwModalInput.scrollHeight + 'px';
            }
        }, 10);

        requestAnimationFrame(() => hwModalInput.focus());
    }

    hwModalInput.addEventListener('input', function() {
        this.style.height = '100px'; // base height
        this.style.height = Math.min(this.scrollHeight, 250) + 'px';
    });

    function closeHomeworkModal() {
        hwModal.classList.add('hidden');
        modalCurrentKey = null;
        hwModalInput.value = '';
    }

    hwModalCancel.addEventListener('click', closeHomeworkModal);
    hwModal.addEventListener('click', (e) => {
        if (e.target === hwModal) closeHomeworkModal();
    });
    
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !hwModal.classList.contains('hidden')) {
            closeHomeworkModal();
        }
        if (e.key === 'Tab' && !hwModal.classList.contains('hidden')) {
            trapFocus(hwModal, e);
        }
    });

    hwModalSave.addEventListener('click', () => {
        const text = hwModalInput.value.trim();
        if (!modalCurrentKey) return;

        const hw = getHomework();
        if (text) {
            hw[modalCurrentKey] = text;
        } else {
            delete hw[modalCurrentKey];
        }
        setHomework(hw);
        const parts = modalCurrentKey.split('|');
        if (parts.length === 3) syncHomeworkToServer(parts[0], parts[1], parts[2], text).catch(() => {});
        closeHomeworkModal();
        renderSchedule();
    });

    // ===== SVG icon templates (avoid re-creating the same strings) =====
    const SVG_PLUS = '<svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
    const SVG_EDIT = '<svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
    const SVG_X = '<svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    const SVG_EDIT_SM = '<svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
    const SVG_TRASH = '<svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';

    // ===== Build lesson card (optimized: single innerHTML, cached hw) =====
    function buildLessonCard(pair, dayLabel, hw, lessonStatus) {
        const key = hwKey(selectedGroup, dayLabel, pair.number);
        const savedText = hw[key] || '';

        const savedHtml = savedText
            ? `<div class="hw-saved"><span>${escHtml(savedText)}</span><button class="hw-delete-btn" data-key="${key}" aria-label="Видалити завдання">${SVG_X}</button></div>`
            : '';

        const btnLabel = savedText ? 'Редагувати' : 'Додати завдання';
        const btnIcon = savedText ? SVG_EDIT : SVG_PLUS;
        const roomHtml = pair.room ? `<span class="diary-item-room">ауд. ${escHtml(pair.room)}</span>` : '';
        const teacherHtml = (pair.teacher || pair.room) ? `<div class="diary-item-teacher">${escHtml(pair.teacher || '')}${pair.teacher && pair.room ? ' · ' : ''}${roomHtml}</div>` : '';
        const timeHtml = LESSON_TIMES[pair.number] ? `<span class="diary-item-time">${LESSON_TIMES[pair.number]}</span>` : '';

        let statusBadge = '';
        if (lessonStatus === 'now') {
            const t = LESSON_TIMES[pair.number];
            if (t) {
                const endStr = t.split(' - ')[1];
                const [eh, em] = endStr.split(':').map(Number);
                const kyiv = getKyivNow();
                const remaining = Math.max(0, (eh * 60 + em) - kyiv.totalMinutes);
                statusBadge = `<span class="badge-now">ЗАРАЗ • ще ${remaining} хв</span>`;
            }
        } else if (lessonStatus === 'next') {
            const t = LESSON_TIMES[pair.number];
            if (t) {
                const startStr = t.split(' - ')[0];
                const [sh, sm] = startStr.split(':').map(Number);
                const kyiv = getKyivNow();
                const until = Math.max(0, (sh * 60 + sm) - kyiv.totalMinutes);
                statusBadge = `<span class="badge-next">НАСТУПНА • через ${until} хв</span>`;
            }
        }

        const div = document.createElement('div');
        div.className = 'diary-item';
        if (lessonStatus === 'now') div.classList.add('is-now');
        else if (lessonStatus === 'next') div.classList.add('is-next');
        if (pair.isSubstitution) {
            div.classList.add('substitution');
        }
        
        const escapedSubject = escHtml(pair.subject);
        const safeNum = Number(pair.number) || 0;
        let subjectHtml = `<div class="diary-item-subject">${escapedSubject}</div>`;
        if (pair.isSubstitution) {
            const badgeText = pair.substitutionType === 'підвіска' ? 'ПІДВІСКА' : 'ЗАМІНА';
            subjectHtml = `<div class="diary-item-subject"><span class="badge-substitution">${badgeText}</span> ${escapedSubject}</div>`;
        }

        div.innerHTML = `<div class="diary-item-header"><span class="diary-item-number">${safeNum} пара</span>${statusBadge}${timeHtml}</div>${subjectHtml}${teacherHtml}${savedHtml}<button class="homework-btn" data-key="${key}" data-subject="${escapedSubject}" data-day="${dayLabel}">${btnIcon} ${btnLabel}</button>`;
        return div;
    }

    // ===== Event delegation (single listener on document) =====
    document.addEventListener('click', (e) => {
        const hwBtn = e.target.closest('.homework-btn');
        if (hwBtn) {
            const { key, subject, day } = hwBtn.dataset;
            openHomeworkModal(key, subject, day, getHomework()[key] || '');
            return;
        }

        const delBtn = e.target.closest('.hw-delete-btn');
        if (delBtn) {
            const hw = getHomework();
            const key = delBtn.dataset.key;
            delete hw[key];
            setHomework(hw);
            const parts = key.split('|');
            if (parts.length === 3) syncHomeworkToServer(parts[0], parts[1], parts[2], '').catch(() => {});
            renderSchedule();
            return;
        }

        const hwDelCard = e.target.closest('.hw-card-delete');
        if (hwDelCard) {
            const hw = getHomework();
            const key = hwDelCard.dataset.key;
            delete hw[key];
            setHomework(hw);
            const parts = key.split('|');
            if (parts.length === 3) syncHomeworkToServer(parts[0], parts[1], parts[2], '').catch(() => {});
            renderHomeworkTab();
            return;
        }

        const hwEditCard = e.target.closest('.hw-card-edit');
        if (hwEditCard) {
            const { key, subject, day } = hwEditCard.dataset;
            openHomeworkModal(key, subject, day, getHomework()[key] || '');
            return;
        }
    });

    // ===== Render Schedule (DocumentFragment for batch DOM insert) =====
    function renderSchedule() {
        if (!scheduleData) {
            diaryContainer.innerHTML = `<div class="empty-state-container">${SVG_EMPTY_SCHEDULE}<p class="empty-state-title">Немає з'єднання</p><p class="empty-state-desc">Не вдалося завантажити розклад. Перевірте інтернет.</p></div>`;
            return;
        }
        if (!scheduleData[selectedGroup]) {
            diaryContainer.innerHTML = `<div class="empty-state-container">${SVG_EMPTY_SCHEDULE}<p class="empty-state-title">Групу не знайдено</p><p class="empty-state-desc">Група «${escHtml(selectedGroup)}» більше не існує. Оберіть іншу.</p></div>`;
            return;
        }
        currentGroupTitle.textContent = selectedGroup;

        // Auto-detect week type based on ISO week (odd = ЧИСЕЛЬНИК, even = ЗНАМЕННИК)
        const groupTypes = Object.keys(scheduleData[selectedGroup]).filter(t => t !== 'ПІДВІСКА');
        const hasChis = groupTypes.includes('ЧИСЕЛЬНИК');
        const hasZnam = groupTypes.includes('ЗНАМЕННИК');
        if (hasChis && hasZnam && (currentWeekType === 'ОСНОВНИЙ РОЗКЛАД' || currentWeekType === 'ЧИСЕЛЬНИК' || currentWeekType === 'ЗНАМЕННИК')) {
            const isoWeek = getISOWeek(weekOffset);
            currentWeekType = isoWeek % 2 === 0 ? 'ЗНАМЕННИК' : 'ЧИСЕЛЬНИК';
        }

        let weekData = scheduleData[selectedGroup][currentWeekType];

        const isDataEmpty = !weekData || (Array.isArray(weekData) ? weekData.length === 0 : Object.keys(weekData).length === 0);
        if (isDataEmpty) {
            const availableTypes = groupTypes;
            currentWeekType = availableTypes.includes('ОСНОВНИЙ РОЗКЛАД') ? 'ОСНОВНИЙ РОЗКЛАД' : availableTypes[0];
            weekData = scheduleData[selectedGroup][currentWeekType];
            if (!currentWeekType) currentWeekType = 'ОСНОВНИЙ РОЗКЛАД';
            weekTypeToggle.textContent = currentWeekType.split(' ')[0] || 'РОЗКЛАД';
        }

        if (!weekData || (Array.isArray(weekData) && weekData.length === 0)) {
            diaryContainer.innerHTML = `<div class="empty-state-container">${SVG_EMPTY_SCHEDULE}<p class="empty-state-title">Розклад відсутній</p><p class="empty-state-desc">Для вибраного тижня немає пар.</p></div>`;
            return;
        }

        const hw = getHomework(); // read once per render
        const frag = document.createDocumentFragment();
        
        const kyivNow = getKyivNow();
        const currentDayOfWeek = kyivNow.dayOfWeek || 7; // 1-7 (Mon-Sun)
        const todayLabel = ukDays[kyivNow.dayOfWeek];
        const today = new Date(kyivNow.year, kyivNow.month - 1, kyivNow.day);

        // Compute DD.MM dates for Mon-Fri of the target week (with weekOffset)
        const weekDates = {};
        const daysOrder = ['Понеділок', 'Вівторок', 'Середа', 'Четвер', 'П\'ятниця', 'Субота', 'Неділя'];
        for (let i = 0; i < daysOrder.length; i++) {
            const offset = (i + 1) - currentDayOfWeek + (weekOffset * 7);
            const d = new Date(today);
            d.setDate(today.getDate() + offset);
            const dayStr = String(d.getDate()).padStart(2, '0');
            const monthStr = String(d.getMonth() + 1).padStart(2, '0');
            weekDates[daysOrder[i]] = `${dayStr}.${monthStr}`;
        }

        const days = ['Понеділок', 'Вівторок', 'Середа', 'Четвер', 'П\'ятниця'];
        const substitutionsList = scheduleData[selectedGroup]['ПІДВІСКА'] || [];

        for (let d = 0; d < days.length; d++) {
            const day = days[d];
            const dateStr = weekDates[day];
            
            let pairs = [];
            if (weekData[day]) {
                pairs = [...weekData[day]];
            }
            
            // Merge substitutions
            const subsForDate = substitutionsList.filter(s => s.date === dateStr);
            if (subsForDate.length > 0) {
                subsForDate.forEach(sub => {
                    const replaces = pairs.some(p => parseInt(p.number) === parseInt(sub.number));
                    pairs = pairs.filter(p => parseInt(p.number) !== parseInt(sub.number));
                    pairs.push({ ...sub, isSubstitution: true, substitutionType: replaces ? 'заміна' : 'підвіска' });
                });
            }

            if (pairs.length === 0) continue;

            pairs.sort((a, b) => parseInt(a.number) - parseInt(b.number));

            const dayEl = document.createElement('div');
            dayEl.className = 'diary-day';

            const title = document.createElement('h2');
            title.innerHTML = `${day} <span class="date-badge">${dateStr}</span>`;
            
            const isToday = weekOffset === 0 && currentWeekType !== 'ПІДВІСКА' && day === todayLabel;
            if (isToday) {
                dayEl.classList.add('is-today');
                dayEl.id = 'today-marker';
                const badge = document.createElement('span');
                badge.className = 'today-badge';
                badge.textContent = 'Сьогодні';
                title.appendChild(badge);
            }

            dayEl.appendChild(title);

            const lessonStatuses = {};
            if (isToday) {
                const nowMin = kyivNow.totalMinutes;
                let foundNext = false;
                for (const pr of pairs) {
                    const t = LESSON_TIMES[pr.number];
                    if (!t) continue;
                    const [s, e] = t.split(' - ');
                    const [sh, sm] = s.split(':').map(Number);
                    const [eh, em] = e.split(':').map(Number);
                    if (nowMin >= sh * 60 + sm && nowMin < eh * 60 + em) {
                        lessonStatuses[pr.number] = 'now';
                    } else if (nowMin < sh * 60 + sm && !foundNext) {
                        lessonStatuses[pr.number] = 'next';
                        foundNext = true;
                    }
                }
            }

            for (let p = 0; p < pairs.length; p++) {
                dayEl.appendChild(buildLessonCard(pairs[p], day, hw, lessonStatuses[pairs[p].number] || null));
            }
            frag.appendChild(dayEl);
        }

        // Week navigator
        const weekNav = document.createElement('div');
        weekNav.className = 'week-nav';

        const mondayDate = weekDates['Понеділок'];
        const fridayDate = weekDates["П'ятниця"];
        const weekLabel = weekOffset === 0 ? 'Поточний тиждень' : weekOffset === 1 ? 'Наступний тиждень' : weekOffset === -1 ? 'Минулий тиждень' : `${mondayDate} — ${fridayDate}`;

        weekNav.innerHTML = `
            <button class="week-nav-btn" data-dir="-1" aria-label="Попередній тиждень">
                <svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none"><polyline points="15 18 9 12 15 6"/></svg>
            </button>
            <div class="week-nav-center">
                <span class="week-nav-label">${weekLabel}</span>
                <span class="week-nav-dates">${mondayDate} — ${fridayDate}</span>
            </div>
            <button class="week-nav-btn" data-dir="1" aria-label="Наступний тиждень">
                <svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none"><polyline points="9 18 15 12 9 6"/></svg>
            </button>
        `;

        weekNav.querySelectorAll('.week-nav-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                weekOffset += parseInt(btn.dataset.dir);
                renderSchedule();
                window.scrollTo({ top: 0, behavior: 'smooth' });
            });
        });

        // Reset to current week on tap center
        weekNav.querySelector('.week-nav-center').addEventListener('click', () => {
            if (weekOffset !== 0) {
                weekOffset = 0;
                renderSchedule();
                window.scrollTo({ top: 0, behavior: 'smooth' });
            }
        });

        frag.appendChild(weekNav);

        diaryContainer.innerHTML = '';
        diaryContainer.appendChild(frag);

        if (weekOffset === 0 && currentWeekType !== 'ПІДВІСКА') {
            requestAnimationFrame(() => {
                const todayMarker = document.getElementById('today-marker');
                if (todayMarker) {
                    setTimeout(() => {
                        const headerH = document.querySelector('.top-nav')?.offsetHeight || 0;
                        const y = todayMarker.getBoundingClientRect().top + window.scrollY - headerH - 8;
                        window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
                    }, 50);
                }
            });
        }
    }

    // ===== Grid View =====
    function renderGridView() {
        if (!scheduleData || !selectedGroup || !scheduleData[selectedGroup]) return;
        const groupData = scheduleData[selectedGroup];

        // Same week type logic as renderSchedule
        const groupTypes = Object.keys(groupData).filter(t => t !== 'ПІДВІСКА');
        const hasChis = groupTypes.includes('ЧИСЕЛЬНИК');
        const hasZnam = groupTypes.includes('ЗНАМЕННИК');
        if (hasChis && hasZnam && (currentWeekType === 'ОСНОВНИЙ РОЗКЛАД' || currentWeekType === 'ЧИСЕЛЬНИК' || currentWeekType === 'ЗНАМЕННИК')) {
            const isoWeek = getISOWeek(weekOffset);
            currentWeekType = isoWeek % 2 === 0 ? 'ЗНАМЕННИК' : 'ЧИСЕЛЬНИК';
        }
        let weekData = groupData[currentWeekType];
        const isDataEmpty = !weekData || (Array.isArray(weekData) ? weekData.length === 0 : Object.keys(weekData).length === 0);
        if (isDataEmpty) {
            currentWeekType = groupTypes.includes('ОСНОВНИЙ РОЗКЛАД') ? 'ОСНОВНИЙ РОЗКЛАД' : groupTypes[0];
            weekData = groupData[currentWeekType];
        }
        if (!weekData) { weekData = {}; }
        weekTypeToggle.textContent = (currentWeekType || 'РОЗКЛАД').split(' ')[0];
        currentGroupTitle.textContent = selectedGroup;

        const kyivNow = getKyivNow();
        const currentDayOfWeek = kyivNow.dayOfWeek || 7;
        const todayLabel = ukDays[kyivNow.dayOfWeek];
        const today = new Date(kyivNow.year, kyivNow.month - 1, kyivNow.day);

        const daysOrder = ['Понеділок', 'Вівторок', 'Середа', 'Четвер', 'П\'ятниця'];
        const dayShort = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт'];

        const weekDates = {};
        for (let i = 0; i < daysOrder.length; i++) {
            const offset = (i + 1) - currentDayOfWeek + (weekOffset * 7);
            const d = new Date(today);
            d.setDate(today.getDate() + offset);
            weekDates[daysOrder[i]] = String(d.getDate()).padStart(2, '0') + '.' + String(d.getMonth() + 1).padStart(2, '0');
        }

        const substitutionsList = groupData['ПІДВІСКА'] || [];
        const maxPairs = 6;
        const nowMin = kyivNow.totalMinutes;

        // Build grid HTML
        let html = '';

        // Week navigator (same as list view)
        const mondayDate = weekDates['Понеділок'];
        const fridayDate = weekDates["П'ятниця"];
        const weekLabel = weekOffset === 0 ? 'Поточний тиждень' : weekOffset === 1 ? 'Наступний тиждень' : weekOffset === -1 ? 'Минулий тиждень' : `${mondayDate} — ${fridayDate}`;
        html += `<div class="grid-week-nav">
            <button class="week-nav-btn" data-dir="-1" aria-label="Попередній тиждень"><svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none"><polyline points="15 18 9 12 15 6"/></svg></button>
            <div class="week-nav-center"><span class="week-nav-label">${weekLabel}</span><span class="week-nav-dates">${mondayDate} — ${fridayDate}</span></div>
            <button class="week-nav-btn" data-dir="1" aria-label="Наступний тиждень"><svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none"><polyline points="9 18 15 12 9 6"/></svg></button>
        </div>`;

        html += '<div class="grid-schedule">';
        // Header row
        html += '<div class="grid-header"><div class="grid-time-col"></div>';
        for (let i = 0; i < daysOrder.length; i++) {
            const isToday = weekOffset === 0 && daysOrder[i] === todayLabel;
            html += `<div class="grid-day-col${isToday ? ' grid-today' : ''}"><span class="grid-day-name">${dayShort[i]}</span><span class="grid-day-date">${weekDates[daysOrder[i]].split('.')[0]}</span></div>`;
        }
        html += '</div>';

        // Time rows
        for (let p = 1; p <= maxPairs; p++) {
            const timeStr = LESSON_TIMES[p] || '';
            const startTime = timeStr ? timeStr.split(' - ')[0] : '';
            html += '<div class="grid-row">';
            html += `<div class="grid-time-col"><span class="grid-pair-num">${p}</span><span class="grid-pair-time">${startTime}</span></div>`;

            for (let d = 0; d < daysOrder.length; d++) {
                const day = daysOrder[d];
                const dateStr = weekDates[day];
                let pairs = weekData[day] ? [...weekData[day]] : [];

                const subsForDate = substitutionsList.filter(s => s.date === dateStr);
                subsForDate.forEach(sub => {
                    pairs = pairs.filter(pr => parseInt(pr.number) !== parseInt(sub.number));
                    pairs.push({ ...sub, isSubstitution: true });
                });

                const pair = pairs.find(pr => parseInt(pr.number) === p);
                const isToday = weekOffset === 0 && day === todayLabel;

                if (pair) {
                    let cellClass = 'grid-cell grid-filled';
                    if (pair.isSubstitution) cellClass += ' grid-sub';
                    if (isToday) cellClass += ' grid-today-cell';

                    if (isToday && timeStr) {
                        const [s, e] = timeStr.split(' - ');
                        const [sh, sm] = s.split(':').map(Number);
                        const [eh, em] = e.split(':').map(Number);
                        if (nowMin >= sh * 60 + sm && nowMin < eh * 60 + em) cellClass += ' grid-now';
                    }

                    const subj = escHtml(pair.subject || '');
                    const teacher = pair.teacher ? `<span class="grid-teacher">${escHtml(pair.teacher)}</span>` : '';
                    const room = pair.room ? `<span class="grid-room">ауд. ${escHtml(pair.room)}</span>` : '';
                    html += `<div class="${cellClass}"><span class="grid-subject">${subj}</span>${teacher}${room}</div>`;
                } else {
                    html += `<div class="grid-cell${isToday ? ' grid-today-cell' : ''}"></div>`;
                }
            }
            html += '</div>';
        }
        html += '</div>';

        diaryContainer.innerHTML = html;

        // Wire week nav buttons
        diaryContainer.querySelectorAll('.week-nav-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                weekOffset += parseInt(btn.dataset.dir);
                renderGridView();
                window.scrollTo({ top: 0, behavior: 'smooth' });
            });
        });
        const center = diaryContainer.querySelector('.week-nav-center');
        if (center) center.addEventListener('click', () => {
            if (weekOffset !== 0) { weekOffset = 0; renderGridView(); }
        });
    }

    // Toggle grid/list view
    function updateViewIcon() {
        if (gridView) {
            viewToggleIcon.innerHTML = '<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>';
        } else {
            viewToggleIcon.innerHTML = '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>';
        }
    }
    updateViewIcon();

    function renderCurrentView() {
        if (gridView) renderGridView(); else renderSchedule();
    }

    // ===== Pull-to-refresh (schedule screen) =====
    (function initPullToRefresh() {
        let startY = 0, pulling = false;
        const threshold = 80;
        const indicator = document.createElement('div');
        indicator.style.cssText = 'position:fixed;top:-40px;left:50%;transform:translateX(-50%);width:36px;height:36px;border-radius:50%;background:var(--surface-color);box-shadow:0 2px 8px rgba(0,0,0,.15);display:flex;align-items:center;justify-content:center;transition:top .2s;z-index:999;font-size:18px';
        indicator.textContent = '↻';
        document.body.appendChild(indicator);

        diaryContainer.addEventListener('touchstart', (e) => {
            if (diaryContainer.scrollTop <= 0 && !screens.schedule.classList.contains('hidden')) {
                startY = e.touches[0].clientY;
                pulling = true;
            }
        }, { passive: true });

        diaryContainer.addEventListener('touchmove', (e) => {
            if (!pulling) return;
            const dy = e.touches[0].clientY - startY;
            if (dy > 0 && dy < 150) {
                indicator.style.top = Math.min(dy - 40, 20) + 'px';
            }
        }, { passive: true });

        diaryContainer.addEventListener('touchend', () => {
            if (!pulling) return;
            const top = parseInt(indicator.style.top);
            pulling = false;
            indicator.style.top = '-40px';
            if (top >= 15) {
                location.reload();
            }
        });
    })();

    viewToggleBtn.addEventListener('click', () => {
        gridView = !gridView;
        localStorage.setItem('gridView', gridView ? '1' : '0');
        updateViewIcon();
        renderCurrentView();
    });

    // ===== Render Homework Tab =====
    function renderHomeworkTab() {
        const hw = getHomework();
        const prefix = selectedGroup + '|';
        const entries = [];

        for (const key in hw) {
            if (key.startsWith(prefix)) {
                const parts = key.split('|');
                entries.push({ key, day: parts[1], number: parts[2], text: hw[key] });
            }
        }

        if (entries.length === 0) {
            homeworkContainer.innerHTML = `<div class="empty-state-container">${SVG_EMPTY_HOMEWORK}<p class="empty-state-title">Немає завдань</p><p class="empty-state-desc">Ура! Ви ще не додали жодного домашнього завдання.</p></div>`;
            return;
        }

        // Group by day
        const grouped = {};
        for (let i = 0; i < entries.length; i++) {
            const e = entries[i];
            if (!grouped[e.day]) grouped[e.day] = [];
            grouped[e.day].push(e);
        }

        const frag = document.createDocumentFragment();

        for (const day in grouped) {
            const dayTitle = document.createElement('h2');
            dayTitle.className = 'diary-day';
            dayTitle.style.cssText = 'font-size:1rem;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:0.5rem;margin-top:1rem;';
            dayTitle.textContent = day;
            frag.appendChild(dayTitle);

            grouped[day].sort((a, b) => a.number - b.number);

            for (let i = 0; i < grouped[day].length; i++) {
                const entry = grouped[day][i];
                let subjectName = `Пара ${entry.number}`;

                // Lookup subject from schedule data
                if (scheduleData && scheduleData[selectedGroup]) {
                    const weekTypes = Object.keys(scheduleData[selectedGroup]);
                    for (let w = 0; w < weekTypes.length; w++) {
                        const wd = scheduleData[selectedGroup][weekTypes[w]];
                        if (Array.isArray(wd)) {
                            // ПІДВІСКА array: match by number (day in hw key is day name, not date)
                            const found = wd.find(p => parseInt(p.number) === parseInt(entry.number));
                            if (found) { subjectName = found.subject; break; }
                        } else if (wd[day]) {
                            const found = wd[day].find(p => parseInt(p.number) === parseInt(entry.number));
                            if (found) { subjectName = found.subject; break; }
                        }
                    }
                }

                const escapedSub = escHtml(subjectName);
                const card = document.createElement('div');
                card.className = 'hw-card';
                card.innerHTML = `<div class="hw-card-subject">${escapedSub}</div><div class="hw-card-meta">${entry.number} пара · ${escHtml(day)}</div><div class="hw-card-text">${escHtml(entry.text)}</div><div class="hw-card-actions"><button class="hw-card-edit" data-key="${entry.key}" data-subject="${escapedSub}" data-day="${escHtml(day)}">${SVG_EDIT_SM} Редагувати</button><button class="hw-card-delete hw-delete" data-key="${entry.key}">${SVG_TRASH} Видалити</button></div>`;
                frag.appendChild(card);
            }
        }

        homeworkContainer.innerHTML = '';
        homeworkContainer.appendChild(frag);
    }

    // ===== Share Schedule as Image (via server API) =====
    function _shareImageParams(dayParam) {
        const theme = document.body.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
        return `/api/schedule-image?group=${encodeURIComponent(selectedGroup)}&day=${dayParam}&theme=${theme}&weekOffset=${weekOffset}`;
    }

    async function _fetchAndShare(url, filename, title, text) {
        try {
            const resp = await fetch(url);
            if (!resp.ok) { showToast('Немає розкладу', 'error'); return; }
            const blob = await resp.blob();
            const file = new File([blob], filename, { type: 'image/png' });
            if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
                try { await navigator.share({ files: [file], title, text }); } catch (e) { console.warn('Share cancelled/failed:', e); }
            } else {
                const u = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = u; a.download = filename; a.click();
                URL.revokeObjectURL(u);
            }
        } catch { showToast('Помилка генерації зображення', 'error'); }
    }

    function showShareDayPicker() {
        const days = [
            { idx: 1, label: 'Понеділок' },
            { idx: 2, label: 'Вівторок' },
            { idx: 3, label: 'Середа' },
            { idx: 4, label: 'Четвер' },
            { idx: 5, label: "П'ятниця" }
        ];
        const todayIdx = new Date().getDay();

        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:flex-end;justify-content:center;animation:fadeIn .2s ease';

        const sheet = document.createElement('div');
        sheet.style.cssText = 'background:var(--surface-color,#f5f5f5);border-radius:20px 20px 0 0;padding:1.5rem;width:100%;max-width:500px;padding-bottom:calc(1.5rem + env(safe-area-inset-bottom))';

        let html = '<div style="width:40px;height:4px;background:var(--border-color,#ddd);border-radius:2px;margin:0 auto 1rem"></div>';
        html += '<h3 style="font-size:1.1rem;font-weight:700;margin-bottom:1rem;text-align:center">Оберіть день</h3>';

        html += `<button class="share-day-btn" data-day="week" style="display:flex;align-items:center;justify-content:center;width:100%;padding:.9rem 1rem;margin-bottom:.75rem;border:none;border-radius:14px;background:var(--accent-color,#000);color:var(--bg-color,#fff);font-size:1rem;font-weight:700;cursor:pointer;gap:8px"><svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2" fill="none"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg> Вся неділя</button>`;

        for (const day of days) {
            const isToday = day.idx === todayIdx;
            const badge = isToday ? ' <span style="font-size:.75rem;background:var(--accent-color);color:var(--bg-color);padding:2px 8px;border-radius:8px;margin-left:8px">Сьогодні</span>' : '';
            html += `<button class="share-day-btn" data-day="${day.idx}" style="display:flex;align-items:center;width:100%;padding:.9rem 1rem;margin-bottom:.5rem;border:1px solid var(--border-color,#e0e0e0);border-radius:14px;background:var(--bg-color,#fff);color:var(--text-color,#1a1a1a);font-size:1rem;font-weight:${isToday ? '700' : '500'};cursor:pointer">${day.label}${badge}</button>`;
        }

        sheet.innerHTML = html;
        overlay.appendChild(sheet);
        document.body.appendChild(overlay);

        overlay.addEventListener('click', (e) => {
            const btn = e.target.closest('.share-day-btn');
            if (btn) {
                const day = btn.dataset.day;
                overlay.remove();
                if (day === 'week') {
                    shareWeek();
                } else {
                    shareScheduleForDay(parseInt(day));
                }
                return;
            }
            if (e.target === overlay) overlay.remove();
        });
    }

    async function shareWeek() {
        const today = new Date();
        const monOffset = 1 - (today.getDay() || 7) + (weekOffset * 7);
        const mon = new Date(today); mon.setDate(today.getDate() + monOffset);
        const fri = new Date(mon); fri.setDate(mon.getDate() + 4);
        const rangeStr = `${String(mon.getDate()).padStart(2,'0')}.${String(mon.getMonth()+1).padStart(2,'0')} — ${String(fri.getDate()).padStart(2,'0')}.${String(fri.getMonth()+1).padStart(2,'0')}`;
        await _fetchAndShare(
            _shareImageParams('week'),
            `rozklad-week-${rangeStr}.png`,
            'Розклад на тиждень',
            `${selectedGroup} — ${rangeStr}`
        );
    }

    async function shareScheduleForDay(dayIdx) {
        const today = new Date();
        const currentDayOfWeek = today.getDay() || 7;
        const targetDayOfWeek = dayIdx || 7;
        const offset = targetDayOfWeek - currentDayOfWeek + (weekOffset * 7);
        const d = new Date(today);
        d.setDate(today.getDate() + offset);
        const dateStr = String(d.getDate()).padStart(2, '0') + '.' + String(d.getMonth() + 1).padStart(2, '0');
        const dayName = ukDays[dayIdx];
        await _fetchAndShare(
            _shareImageParams(dayIdx),
            `rozklad-${dateStr}.png`,
            `Розклад на ${dayName}`,
            `${selectedGroup} — ${dayName} ${dateStr}`
        );
    }

    shareScheduleBtn.addEventListener('click', showShareDayPicker);

    // ===== Daily Notification =====
    function getTodayScheduleText() {
        if (!scheduleData || !selectedGroup) return null;

        const kyiv = getKyivNow();
        const today = new Date(kyiv.year, kyiv.month - 1, kyiv.day);
        let dayIndex = kyiv.dayOfWeek;
        let prefix = 'Сьогодні';

        // Weekend — show Monday's schedule
        if (dayIndex === 0 || dayIndex === 6) {
            prefix = dayIndex === 6 ? 'У понеділок' : 'Завтра';
            dayIndex = 1;
        }

        const dayName = ukDays[dayIndex];
        const groupData = scheduleData[selectedGroup];
        if (!groupData) return null;

        let weekType = currentWeekType;
        let weekData = groupData[weekType];
        if (!weekData || typeof weekData !== 'object' || Array.isArray(weekData)) {
            weekType = 'ОСНОВНИЙ РОЗКЛАД';
            weekData = groupData[weekType];
        }
        if (!weekData) {
            const types = Object.keys(groupData).filter(t => t !== 'ПІДВІСКА');
            if (types.length === 0) return null;
            weekType = types[0];
            weekData = groupData[weekType];
        }
        if (!weekData || !weekData[dayName]) return null;

        let pairs = [...weekData[dayName]];

        // Merge substitutions for the target day
        const currentDayOfWeek = today.getDay() || 7;
        const targetDayOfWeek = dayIndex || 7;
        let offset = targetDayOfWeek - currentDayOfWeek;
        if (offset < 0) offset += 7;
        const d = new Date(today);
        d.setDate(today.getDate() + offset);
        const dateStr = String(d.getDate()).padStart(2, '0') + '.' + String(d.getMonth() + 1).padStart(2, '0');

        const subs = groupData['ПІДВІСКА'] || [];
        const subsForDate = subs.filter(s => s.date === dateStr);
        subsForDate.forEach(sub => {
            pairs = pairs.filter(p => parseInt(p.number) !== parseInt(sub.number));
            pairs.push({ ...sub, isSubstitution: true });
        });

        if (pairs.length === 0) return null;
        pairs.sort((a, b) => parseInt(a.number) - parseInt(b.number));

        const lines = pairs.map(p => {
            const time = LESSON_TIMES[p.number];
            const startTime = time ? time.split(' - ')[0] : '';
            const sub = p.isSubstitution ? ' ⚡' : '';
            return `${p.number}. ${p.subject}${startTime ? ' — ' + startTime : ''}${sub}`;
        });

        return {
            title: `📚 ${prefix} — ${dayName}`,
            body: lines.join('\n'),
            pairsCount: pairs.length,
            dateStr
        };
    }

    // ===== Server Push Subscription (for iOS + all platforms) =====
    function urlBase64ToUint8Array(base64String) {
        const padding = '='.repeat((4 - base64String.length % 4) % 4);
        const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
        const rawData = atob(base64);
        const outputArray = new Uint8Array(rawData.length);
        for (let i = 0; i < rawData.length; ++i) {
            outputArray[i] = rawData.charCodeAt(i);
        }
        return outputArray;
    }

    async function subscribeToPush() {
        if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
        if (!selectedGroup) return; // no group → server would reject with 400
        try {
            const reg = await navigator.serviceWorker.ready;
            let subscription = await reg.pushManager.getSubscription();
            if (!subscription) {
                subscription = await reg.pushManager.subscribe({
                    userVisibleOnly: true,
                    applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
                });
            }
            const subHeaders = { 'Content-Type': 'application/json' };
            if (authToken) subHeaders['Authorization'] = 'Bearer ' + authToken;
            await fetch('/api/push?action=subscribe', {
                method: 'POST',
                headers: subHeaders,
                body: JSON.stringify({
                    subscription: subscription.toJSON(),
                    group: selectedGroup,
                    notifyTime: localStorage.getItem('notifTime') || '08:00'
                })
            });
        } catch (e) {
            console.error('Push subscribe failed:', e);
        }
    }

    async function unsubscribeFromPush() {
        if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
        try {
            const reg = await navigator.serviceWorker.ready;
            const subscription = await reg.pushManager.getSubscription();
            if (subscription) {
                const unsubHeaders = { 'Content-Type': 'application/json' };
                if (authToken) unsubHeaders['Authorization'] = 'Bearer ' + authToken;
                await fetch('/api/push?action=unsubscribe', {
                    method: 'POST',
                    headers: unsubHeaders,
                    body: JSON.stringify({ endpoint: subscription.endpoint })
                });
                await subscription.unsubscribe();
            }
        } catch (err) {
            console.error('Push unsubscribe failed:', err);
        }
    }

    async function storeNotifConfig() {
        try {
            const cache = await caches.open('notif-config');
            await cache.put('/config', new Response(JSON.stringify({
                group: selectedGroup,
                lessonTimes: LESSON_TIMES
            })));
        } catch (e) { console.warn('storeNotifConfig failed:', e); }
    }

    async function showDailyNotification(force) {
        if (!notificationsEnabled) return;
        if (!('Notification' in window)) return;
        if (Notification.permission !== 'granted') return;
        if (!scheduleData || !selectedGroup) return;

        const today = new Date().toDateString();
        if (!force && localStorage.getItem('lastNotifDate') === today) return;

        const data = getTodayScheduleText();
        if (!data) return;

        try {
            const reg = await navigator.serviceWorker.ready;
            await reg.showNotification(data.title, {
                body: data.body,
                icon: './icon.png',
                badge: './icon.png',
                tag: 'daily-schedule',
                data: { url: `?view=day&date=${data.dateStr}` },
                renotify: true
            });
            localStorage.setItem('lastNotifDate', today);
        } catch (e) {
            try {
                new Notification(data.title, {
                    body: data.body,
                    icon: './icon.png',
                    tag: 'daily-schedule'
                });
                localStorage.setItem('lastNotifDate', today);
            } catch (e) { console.warn('Fallback notification failed:', e); }
        }
    }

    function scrollToDay(dateStr) {
        showScreen('schedule');
        navItems.forEach(n => n.classList.remove('active'));
        navItems[0].classList.add('active');

        if (dateStr && /^\d{2}\.\d{2}$/.test(dateStr)) {
            const [dd, mm] = dateStr.split('.').map(Number);
            const today = new Date();
            const targetDate = new Date(today.getFullYear(), mm - 1, dd);
            // Handle year boundary (e.g., notification from Dec, opened in Jan)
            const diff = targetDate - today;
            if (diff < -180 * 24 * 3600 * 1000) targetDate.setFullYear(today.getFullYear() + 1);
            if (diff > 180 * 24 * 3600 * 1000) targetDate.setFullYear(today.getFullYear() - 1);

            // Compute weekOffset: difference in ISO weeks
            const todayDow = today.getDay() || 7;
            const todayMon = new Date(today); todayMon.setDate(today.getDate() - todayDow + 1); todayMon.setHours(0,0,0,0);
            const targetDow = targetDate.getDay() || 7;
            const targetMon = new Date(targetDate); targetMon.setDate(targetDate.getDate() - targetDow + 1); targetMon.setHours(0,0,0,0);
            weekOffset = Math.round((targetMon - todayMon) / (7 * 24 * 3600 * 1000));
            renderSchedule();
        }

        requestAnimationFrame(() => {
            const headerH = document.querySelector('.top-nav')?.offsetHeight || 0;
            function smoothScrollTo(el) {
                const y = el.getBoundingClientRect().top + window.scrollY - headerH - 8;
                window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
            }
            // Try to scroll to the day matching dateStr
            if (dateStr) {
                const dayEls = document.querySelectorAll('.diary-day');
                for (const el of dayEls) {
                    const badge = el.querySelector('.date-badge');
                    if (badge && badge.textContent === dateStr) {
                        setTimeout(() => smoothScrollTo(el), 80);
                        return;
                    }
                }
            }
            // Fallback: scroll to today marker
            const marker = document.getElementById('today-marker');
            if (marker) {
                setTimeout(() => smoothScrollTo(marker), 80);
            }
        });
    }

    // Listen for SW postMessage (notification click while app is open)
    navigator.serviceWorker && navigator.serviceWorker.addEventListener('message', event => {
        if (event.data && (event.data.type === 'SHOW_TODAY' || event.data.type === 'SHOW_DAY')) {
            const params = new URLSearchParams((event.data.url || '').split('?')[1] || '');
            scrollToDay(params.get('date'));
        }
    });

    // Handle ?view=day&date=DD.MM or ?view=today from notification click (app was closed)
    const urlParams = new URLSearchParams(window.location.search);
    const viewParam = urlParams.get('view');
    const dateParam = urlParams.get('date');
    if (viewParam) {
        window.history.replaceState({}, '', window.location.pathname);
    }

    // ===== Init =====
    // Try to restore session
    let sessionValid = false;
    if (authToken) {
        try {
            const data = await authFetch('me', 'GET');
            applyUserInfo(data.user);
            sessionValid = true;
            // Restore group from server if local is missing
            if (data.user.group && !selectedGroup) {
                selectedGroup = data.user.group;
                localStorage.setItem('selectedGroup', selectedGroup);
            }
        } catch {
            // Token expired or invalid
            authToken = null;
            localStorage.removeItem('authToken');
        }
    }

    if (!selectedGroup) {
        showScreen('onboarding');
        if (!localStorage.getItem('onboardingIntroDone')) {
            initOnboardingIntro();
        } else if (!sessionValid) {
            showAuthScreen();
        } else {
            // Logged in but no group yet
            obIntro.classList.add('hidden');
            obAuth.classList.add('hidden');
            obGroups.classList.remove('hidden');
            document.body.classList.remove('ob-lock');
            renderGroupList();
        }
    } else {
        navItems[0].classList.add('active');
        showScreen('schedule');
        // Store config for SW background notifications
        storeNotifConfig();
        // Subscribe to server push if notifications already enabled
        if (notificationsEnabled && Notification.permission === 'granted') {
            subscribeToPush();
        }
        // Show daily notification
        showDailyNotification();
        // Show notification prompt banner if permission not yet granted
        showNotifPrompt();
        // If opened from notification, scroll to target day
        if (viewParam) {
            scrollToDay(dateParam);
        }

        // Auto-refresh every 60s to keep "ЗАРАЗ" indicator live
        let _refreshTimer = setInterval(() => {
            if (document.hidden) return;
            if (scheduleData && selectedGroup && screens.schedule && !screens.schedule.classList.contains('hidden')) {
                renderCurrentView();
            }
        }, 60000);
        // Pause refresh timer when not on schedule screen
        document.addEventListener('visibilitychange', () => {
            if (document.hidden && _refreshTimer) {
                clearInterval(_refreshTimer);
                _refreshTimer = null;
            } else if (!document.hidden && !_refreshTimer) {
                _refreshTimer = setInterval(() => {
                    if (scheduleData && selectedGroup && screens.schedule && !screens.schedule.classList.contains('hidden')) {
                        renderCurrentView();
                    }
                }, 60000);
            }
        });

        // Schedule test notification 5 min after new deployment
        const DEPLOY_VERSION = 'rozklad-v42';
        if (localStorage.getItem('lastDeployNotif') !== DEPLOY_VERSION) {
            localStorage.setItem('lastDeployNotif', DEPLOY_VERSION);
            if (notificationsEnabled && Notification.permission === 'granted') {
                setTimeout(() => showDailyNotification(true), 2 * 60 * 1000);
            }
        }
    }
});

// PWA Service Worker Registration + Periodic Sync
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').then(async reg => {
            // Try registering periodic sync for background notifications
            if ('periodicSync' in reg) {
                try {
                    await reg.periodicSync.register('daily-schedule', {
                        minInterval: 12 * 60 * 60 * 1000 // 12 hours
                    });
                } catch (e) { console.warn('Periodic sync registration failed:', e); }
            }
        }).catch((e) => console.warn('SW registration failed:', e));
    });
}
