// Global error handlers — show visible fallback ONLY for OUR script errors (filter out third-party / extensions)
(function() {
    var shown = false;
    function showCrash(detail) {
        if (shown) return;
        shown = true;
        if (detail) console.error('[crash]', detail);
        var d = document.getElementById('app');
        if (!d) d = document.body;
        d.innerHTML = '<div style="padding:2rem;text-align:center;font-family:-apple-system,sans-serif;color:#333">' +
            '<h2 style="margin-bottom:1rem">Щось пішло не так</h2>' +
            '<p style="margin-bottom:1rem;font-size:14px;color:#888">Спробуйте перезавантажити сторінку. Якщо помилка повторюється — напишіть нам в Telegram.</p>' +
            '<button onclick="location.reload()" style="padding:10px 24px;border:none;border-radius:10px;background:#000;color:#fff;font-size:15px;cursor:pointer">Перезавантажити</button>' +
            '</div>';
    }
    // Only treat as crash if error originates from OUR script files.
    // Extensions/injects often report src as the page URL or empty — ignore those.
    function isOurScript(src) {
        if (!src || typeof src !== 'string') return false;
        return /\/(app|inline-boot)\.js(\?|$)/.test(src);
    }
    window.addEventListener('unhandledrejection', function(e) {
        console.error('Unhandled promise rejection:', e.reason);
        // Rejection has no src — be conservative: log only, let safety net catch real crashes
    });
    window.onerror = function(msg, src, line) {
        // Safari JSON-LD @context quirk — not our bug, suppress noise
        if (typeof msg === 'string' && msg.indexOf('@context') !== -1) return;
        console.error('Global error:', msg, src, line);
        if (isOurScript(src)) {
            showCrash(msg + ' (line ' + line + ')');
        }
    };
    // Safety net: if after 6s nothing visible, show fallback
    setTimeout(function() {
        var app = document.getElementById('app');
        if (!app) return;
        var screens = app.querySelectorAll('.screen');
        var anyVisible = false;
        for (var i = 0; i < screens.length; i++) {
            if (!screens[i].classList.contains('hidden')) { anyVisible = true; break; }
        }
        if (!anyVisible && !shown) showCrash('Додаток не завантажився вчасно');
    }, 6000);
})();

// ===== Offline/Online indicator =====
(function() {
    const bar = document.createElement('div');
    bar.id = 'offlineBar';
    bar.className = 'offline-banner';
    bar.textContent = 'Офлайн — розклад з кешу';
    bar.style.display = 'none';
    document.body.appendChild(bar);
    function update() { bar.style.display = navigator.onLine ? 'none' : 'block'; }
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    update();
})();

document.addEventListener('DOMContentLoaded', async () => {
    // Legacy localStorage cleanup (adminDeviceId was used pre-Bearer-auth)
    localStorage.removeItem('adminDeviceId');

    // ===== Telegram Mini App init =====
    const tgApp = window.Telegram?.WebApp;
    if (tgApp) {
        document.documentElement.classList.add('in-tg-webapp');
        tgApp.ready();
        tgApp.expand();
        function applyTgInset() {
            const top = (tgApp.safeAreaInset?.top ?? 0) + (tgApp.contentSafeAreaInset?.top ?? 0);
            document.documentElement.style.setProperty('--tg-inset-top', Math.max(top, 96) + 'px');
        }
        applyTgInset();
        tgApp.onEvent?.('safeAreaChanged', applyTgInset);
        tgApp.onEvent?.('contentSafeAreaChanged', applyTgInset);
    }

    // ===== State =====
    let scheduleData = null;
    let selectedGroup = localStorage.getItem('selectedGroup');
    let currentWeekType = 'ОСНОВНИЙ РОЗКЛАД';
    let isDarkTheme = localStorage.getItem('theme') === 'dark';
    let _hwCache = null; // cached homework object
    let _hwFiles = {};   // cached homework attachments { key: [{url,name,type,size}] }
    let _hwDueISO = null; // due date ISO for homework modal (YYYY-MM-DD)
    let notificationsEnabled = localStorage.getItem('notifications') !== 'false';
    let weekOffset = 0; // 0 = current week, 1 = next week, -1 = previous week
    let VAPID_PUBLIC_KEY = 'BMOzNTERkpWZfX4i5P5E1wcd1zXOUlv-fbT1fw-cjWjZPG3xBeattWCIFUfWfHCN-7EGzqGWLnwEGgCEFW8tPpc';
    // Fetch fresh VAPID key from server (allows rotation without client rebuild)
    fetch('/api/auth?action=vapid-key').then(r => r.json()).then(d => { if (d.publicKey) VAPID_PUBLIC_KEY = d.publicKey; }).catch(() => {});

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

    // SVG icon templates (must be above buildLessonCard / renderSchedule)
    const SVG_PLUS = '<svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
    const SVG_EDIT = '<svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
    const SVG_X = '<svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    const SVG_EDIT_SM = '<svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
    const SVG_TRASH = '<svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
    const SVG_BOOK = '<svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>';
    const SVG_CALENDAR = '<svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>';
    const SVG_CLOCK = '<svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';

    const ukDays = ['Неділя', 'Понеділок', 'Вівторок', 'Середа', 'Четвер', 'П\'ятниця', 'Субота'];

    // Escape HTML to prevent XSS (reuse single element)
    const _escDiv = document.createElement('div');
    function escHtml(s) {
        _escDiv.textContent = s;
        return _escDiv.innerHTML;
    }
    // Sanitize URL — only allow https: (prevents javascript: / data: XSS)
    function safeUrl(url) {
        if (typeof url !== 'string') return '#';
        const u = url.trim();
        return (u.startsWith('https://') || u.startsWith('http://')) ? escHtml(u) : '#';
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
    // Returns today's date as YYYY-MM-DD in Kyiv timezone
    function getTodayISO() {
        const k = getKyivNow();
        return `${k.year}-${String(k.month).padStart(2,'0')}-${String(k.day).padStart(2,'0')}`;
    }
    // Formats YYYY-MM-DD to a readable Ukrainian short form: "Чт, 15.05"
    function dateISOtoDisplay(iso) {
        if (!iso) return '';
        const [y, m, d] = iso.split('-');
        const dt = new Date(parseInt(y), parseInt(m) - 1, parseInt(d));
        const short = ['Нд','Пн','Вт','Ср','Чт','Пт','Сб'];
        return `${short[dt.getDay()]}, ${d}.${m}.${y}`;
    }
    // Converts YYYY-MM-DD to Ukrainian full day name
    function isoToUkDay(iso) {
        if (!iso) return '';
        const full = ['Неділя','Понеділок','Вівторок','Середа','Четвер',"П'ятниця",'Субота'];
        const [y, m, d] = iso.split('-').map(Number);
        return full[new Date(y, m - 1, d).getDay()];
    }
    // Finds the next date (YYYY-MM-DD) when subject+lessonNum appears in schedule after fromDateISO
    function findNextSubjectDateISO(subject, lessonNum, fromDateISO) {
        const fallback = () => { const [fy, fm, fd] = fromDateISO.split('-').map(Number); const fb = new Date(fy, fm - 1, fd + 7); return `${fb.getFullYear()}-${String(fb.getMonth()+1).padStart(2,'0')}-${String(fb.getDate()).padStart(2,'0')}`; };
        if (!subject || typeof subject !== 'string') return fallback();
        if (!scheduleData || !selectedGroup || !scheduleData[selectedGroup]) return fallback();
        const ukFull = ['Неділя','Понеділок','Вівторок','Середа','Четвер',"П'ятниця",'Субота'];
        const groupData = scheduleData[selectedGroup];
        const subNorm = subject.toLowerCase().replace(/\s+/g,'');
        if (!subNorm) return fallback();
        const [_fy, _fm, _fd] = fromDateISO.split('-').map(Number);
        const from = new Date(_fy, _fm - 1, _fd);
        for (let offset = 1; offset <= 21; offset++) {
            const d = new Date(from); d.setDate(from.getDate() + offset);
            const dow = d.getDay();
            if (dow === 0 || dow === 6) continue;
            const dayName = ukFull[dow];
            const weekTypes = Object.keys(groupData).filter(t => t !== 'ПІДВІСКА');
            for (const wt of weekTypes) {
                const wd = groupData[wt];
                if (!wd || typeof wd !== 'object' || !wd[dayName] || !Array.isArray(wd[dayName])) continue;
                const found = wd[dayName].find(p =>
                    p && parseInt(p.number) === parseInt(lessonNum) &&
                    typeof p.subject === 'string' &&
                    p.subject.toLowerCase().replace(/\s+/g,'') === subNorm
                );
                if (found) return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
            }
        }
        return fallback();
    }

    // Homework server sync
    async function syncHomeworkToServer(group, day, number, text) {
        if (!authToken) return; // skip if not authenticated
        try {
            const headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + authToken };
            const resp = await fetch('/api/homework', {
                method: 'POST',
                headers,
                body: JSON.stringify({ group, day, number: parseInt(number), text: text || '' })
            });
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                console.warn('[hw-sync] POST failed:', resp.status, err.error);
            }
        } catch (e) { console.warn('HW sync push failed:', e); }
    }

    async function syncHomeworkFromServer() {
        if (!selectedGroup) return;
        // Teacher: fetch HW from all groups where teacher has lessons
        if (selectedGroup === '__teacher__') {
            await syncTeacherHomework();
            return;
        }
        try {
            const resp = await fetch(`/api/homework?group=${encodeURIComponent(selectedGroup)}`, { cache: 'no-store' });
            if (!resp.ok) return;
            const data = await resp.json();
            // New format: { texts: {...}, files: {...} }
            const serverTexts = data.texts || data; // backward compat
            const serverFiles = data.files || {};
            const localHw = getHomework();
            let merged = { ...localHw };
            let changed = false;
            // Server wins for existing server keys (skip empty values)
            for (const [key, value] of Object.entries(serverTexts)) {
                if (!value) { if (merged[key]) { delete merged[key]; changed = true; } continue; }
                if (merged[key] !== value) { merged[key] = value; changed = true; }
            }
            // Push local-only keys to server
            const prefix = selectedGroup + '|';
            for (const key of Object.keys(localHw)) {
                if (key.startsWith(prefix) && !serverTexts[key]) {
                    const parts = key.split('|');
                    syncHomeworkToServer(parts[0], parts[1], parts[2], localHw[key]);
                }
            }
            _hwFiles = serverFiles;
            if (changed) setHomework(merged);
            // Re-render only visible screens
            if (screens.schedule && !screens.schedule.classList.contains('hidden')) renderCurrentView();
            if (screens.homework && !screens.homework.classList.contains('hidden')) renderHomeworkTab();
        } catch (e) { console.warn('[hw-sync] FAILED:', e); }
    }

    async function syncTeacherHomework() {
        if (!scheduleData || !currentUser) return;
        const teacherName = currentUser.teacherName || currentUser.displayName || '';
        if (!teacherName) return;
        // Find all groups where teacher has lessons
        const teacherGroups = new Set();
        const groups = Object.keys(scheduleData).filter(k => k !== '_settings');
        for (const group of groups) {
            const gd = scheduleData[group];
            if (!gd) continue;
            const types = Object.keys(gd).filter(t => t !== 'ПІДВІСКА');
            for (const wt of types) {
                const wd = gd[wt];
                if (!wd) continue;
                for (const day of Object.values(wd)) {
                    if (!Array.isArray(day)) continue;
                    for (const pair of day) {
                        if (pair.teacher === teacherName) { teacherGroups.add(group); break; }
                    }
                }
            }
        }
        if (teacherGroups.size === 0) return;
        // Fetch HW from each group (parallel, max 5 at a time)
        const localHw = getHomework();
        let merged = { ...localHw };
        let changed = false;
        let allFiles = { ..._hwFiles };
        const fetchGroup = async (group) => {
            try {
                const resp = await fetch(`/api/homework?group=${encodeURIComponent(group)}`, { cache: 'no-store' });
                if (!resp.ok) return;
                const data = await resp.json();
                const serverTexts = data.texts || data;
                const serverFiles = data.files || {};
                for (const [key, value] of Object.entries(serverTexts)) {
                    if (!value) { if (merged[key]) { delete merged[key]; changed = true; } continue; }
                    if (merged[key] !== value) { merged[key] = value; changed = true; }
                }
                Object.assign(allFiles, serverFiles);
            } catch (e) { console.warn(`[teacher-hw] fetch ${group} failed:`, e); }
        };
        const arr = [...teacherGroups];
        for (let i = 0; i < arr.length; i += 5) {
            await Promise.all(arr.slice(i, i + 5).map(fetchGroup));
        }
        _hwFiles = allFiles;
        if (changed) setHomework(merged);
        if (screens.schedule && !screens.schedule.classList.contains('hidden')) renderCurrentView();
        if (screens.homework && !screens.homework.classList.contains('hidden')) renderHomeworkTab();
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
    const hwFileInput = document.getElementById('hwFileInput');
    const hwAttachPreview = document.getElementById('hwAttachPreview');
    const hwUploadStatus = document.getElementById('hwUploadStatus');

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
    let swipeView = localStorage.getItem('swipeView') === '1';
    let _swipeDayIdx = -1; // currently selected day in swipe mode (0-4, Mon-Fri)

    let modalCurrentKey = null;
    let authToken = null; // in-memory only — actual auth via httpOnly cookie
    let currentUser = null; // { username, displayName, group, role, teacherName? }
    let isLoginMode = false;

    function isTeacher() {
        return currentUser && currentUser.role === 'teacher';
    }
    function canEditHw() {
        return currentUser && (currentUser.role === 'starosta' || currentUser.role === 'admin' || currentUser.role === 'teacher');
    }

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
        const benefitsList = document.getElementById('authBenefits');
        if (benefitsList) benefitsList.style.display = login ? 'none' : '';
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

    const _avatarColors = ['#FF6B6B','#4ECDC4','#45B7D1','#96CEB4','#FFEAA7','#DDA0DD','#98D8C8','#F7DC6F','#BB8FCE','#85C1E9','#F0B27A','#82E0AA'];
    function _avatarColor(name) {
        let h = 0;
        for (let i = 0; i < (name || '').length; i++) h = ((h << 5) - h + name.charCodeAt(i)) | 0;
        return _avatarColors[Math.abs(h) % _avatarColors.length];
    }
    function _avatarInitials(name) {
        if (!name) return 'U';
        const parts = name.trim().split(/\s+/);
        if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
        return parts[0].substring(0, 2).toUpperCase();
    }

    const accountSection = document.getElementById('accountSection');

    function applyUserInfo(user) {
        currentUser = user;
        // Preserve teacherName from login/me response
        if (user && user.teacherName) currentUser.teacherName = user.teacherName;
        if (user) {
            userInfoCard.classList.remove('hidden');
            accountSection.classList.remove('hidden');
            userDisplayNameEl.textContent = user.displayName;
            userUsernameEl.textContent = user.role === 'teacher' ? 'Вчитель' : '@' + user.username;
            const initials = _avatarInitials(user.displayName);
            userAvatar.textContent = initials;
            userAvatar.style.backgroundColor = _avatarColor(user.displayName);
            logoutRow.style.display = '';
            const chPwdRow = document.getElementById('changePasswordRow');
            if (chPwdRow) chPwdRow.style.display = '';
            const delRow = document.getElementById('deleteAccountRow');
            if (delRow) delRow.style.display = '';
            // Hide group-related UI for teachers
            const changeGroupBtn = document.getElementById('changeGroupBtn');
            if (changeGroupBtn) changeGroupBtn.closest('.setting-item').style.display = user.role === 'teacher' ? 'none' : '';
        } else {
            userInfoCard.classList.add('hidden');
            accountSection.classList.add('hidden');
            logoutRow.style.display = 'none';
            const chPwdRow = document.getElementById('changePasswordRow');
            if (chPwdRow) chPwdRow.style.display = 'none';
            const delRow = document.getElementById('deleteAccountRow');
            if (delRow) delRow.style.display = 'none';
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

        const origText = authSubmit.textContent;
        authSubmit.disabled = true;
        authSubmit.textContent = 'Зачекайте...';
        try {
            let data;
            if (isLoginMode) {
                data = await authFetch('login', 'POST', { username, password });
            } else {
                const displayName = authDisplayName.value.trim();
                if (!displayName) { showAuthError('Введіть ім\'я та прізвище'); authSubmit.disabled = false; authSubmit.textContent = origText; return; }
                data = await authFetch('register', 'POST', { username, password, displayName });
            }
            authToken = data.token;
            localStorage.setItem('hasSession', '1');
            applyUserInfo(data.user);

            if (data.user.role === 'teacher') {
                // Teacher doesn't need to select a group — go straight to schedule
                selectedGroup = '__teacher__';
                localStorage.setItem('selectedGroup', '__teacher__');
                obAuth.classList.add('hidden');
                document.body.classList.remove('ob-lock');
                navItems[0].classList.add('active');
                showScreen('schedule');
            } else if (data.user.group) {
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
        authSubmit.textContent = origText;
    }

    authSubmit.addEventListener('click', handleAuthSubmit);
    authToggleBtn.addEventListener('click', () => setAuthMode(!isLoginMode));

    // Enter key submits
    [authUsername, authPassword, authDisplayName].forEach(el => {
        el.addEventListener('keydown', e => { if (e.key === 'Enter') handleAuthSubmit(); });
    });

    // Logout with confirmation (custom modal)
    const logoutModalEl = document.getElementById('logoutModal');
    const logoutModalCancel = document.getElementById('logoutModalCancel');
    const logoutModalConfirm = document.getElementById('logoutModalConfirm');

    logoutBtn.addEventListener('click', () => { logoutModalEl.classList.remove('hidden'); });
    logoutModalCancel.addEventListener('click', () => { logoutModalEl.classList.add('hidden'); });
    logoutModalEl.addEventListener('click', (e) => { if (e.target === logoutModalEl) logoutModalEl.classList.add('hidden'); });

    logoutModalConfirm.addEventListener('click', async () => {
        logoutModalConfirm.disabled = true;
        logoutModalConfirm.textContent = 'Вихід...';
        try { await authFetch('logout', 'POST'); } catch (e) { console.warn('Logout request failed:', e); }
        authToken = null;
        currentUser = null;
        localStorage.removeItem('hasSession');
        localStorage.removeItem('selectedGroup');
        selectedGroup = null;
        applyUserInfo(null);
        logoutModalEl.classList.add('hidden');
        logoutModalConfirm.disabled = false;
        logoutModalConfirm.textContent = 'Вийти';
        showScreen('onboarding');
        showAuthScreen();
    });

    // Change password (custom modal)
    const chPwdModal = document.getElementById('chPwdModal');
    const chPwdCurrent = document.getElementById('chPwdCurrent');
    const chPwdNew = document.getElementById('chPwdNew');
    const chPwdConfirm = document.getElementById('chPwdConfirm');
    const chPwdError = document.getElementById('chPwdError');
    const chPwdSave = document.getElementById('chPwdSave');

    function openChPwdModal() {
        chPwdCurrent.value = '';
        chPwdNew.value = '';
        chPwdConfirm.value = '';
        chPwdError.classList.add('hidden');
        chPwdSave.disabled = false;
        chPwdSave.textContent = 'Змінити';
        chPwdModal.classList.remove('hidden');
        setTimeout(() => chPwdCurrent.focus(), 250);
    }
    function closeChPwdModal() { chPwdModal.classList.add('hidden'); }

    document.getElementById('changePasswordBtn')?.addEventListener('click', openChPwdModal);
    document.getElementById('chPwdCancel').addEventListener('click', closeChPwdModal);
    chPwdModal.addEventListener('click', (e) => { if (e.target === chPwdModal) closeChPwdModal(); });

    chPwdSave.addEventListener('click', async () => {
        chPwdError.classList.add('hidden');
        const currentPassword = chPwdCurrent.value;
        const newPassword = chPwdNew.value;
        const confirmPassword = chPwdConfirm.value;
        if (!currentPassword) { chPwdError.textContent = 'Введіть поточний пароль'; chPwdError.classList.remove('hidden'); return; }
        if (!newPassword || newPassword.length < 8) { chPwdError.textContent = 'Новий пароль — мінімум 8 символів'; chPwdError.classList.remove('hidden'); return; }
        if (newPassword !== confirmPassword) { chPwdError.textContent = 'Паролі не збігаються'; chPwdError.classList.remove('hidden'); return; }
        chPwdSave.disabled = true;
        chPwdSave.textContent = 'Зміна...';
        try {
            const data = await authFetch('change-password', 'POST', { currentPassword, newPassword });
            if (data.token) authToken = data.token;
            closeChPwdModal();
            showToast('Пароль змінено');
        } catch (e) {
            chPwdError.textContent = e.message || 'Помилка зміни пароля';
            chPwdError.classList.remove('hidden');
        }
        chPwdSave.disabled = false;
        chPwdSave.textContent = 'Змінити';
    });

    [chPwdCurrent, chPwdNew, chPwdConfirm].forEach(el => {
        el.addEventListener('keydown', (e) => { if (e.key === 'Enter') chPwdSave.click(); });
    });

    // Delete account (custom modal)
    const delAccModal = document.getElementById('delAccModal');
    const delAccPassword = document.getElementById('delAccPassword');
    const delAccError = document.getElementById('delAccError');
    const delAccConfirm = document.getElementById('delAccConfirm');

    function openDelAccModal() {
        delAccPassword.value = '';
        delAccError.classList.add('hidden');
        delAccConfirm.disabled = false;
        delAccConfirm.textContent = 'Видалити';
        delAccModal.classList.remove('hidden');
        setTimeout(() => delAccPassword.focus(), 250);
    }
    function closeDelAccModal() { delAccModal.classList.add('hidden'); }

    document.getElementById('deleteAccountBtn')?.addEventListener('click', openDelAccModal);
    document.getElementById('delAccCancel').addEventListener('click', closeDelAccModal);
    delAccModal.addEventListener('click', (e) => { if (e.target === delAccModal) closeDelAccModal(); });

    delAccConfirm.addEventListener('click', async () => {
        delAccError.classList.add('hidden');
        const password = delAccPassword.value;
        if (!password) { delAccError.textContent = 'Введіть пароль'; delAccError.classList.remove('hidden'); return; }
        delAccConfirm.disabled = true;
        delAccConfirm.textContent = 'Видалення...';
        try {
            await authFetch('delete-account', 'POST', { password });
            authToken = null;
            currentUser = null;
            localStorage.clear();
            closeDelAccModal();
            showToast('Акаунт видалено');
            setTimeout(() => { location.reload(); }, 1000);
        } catch (e) {
            delAccError.textContent = e.message || 'Помилка видалення';
            delAccError.classList.remove('hidden');
            delAccConfirm.disabled = false;
            delAccConfirm.textContent = 'Видалити';
        }
    });

    delAccPassword.addEventListener('keydown', (e) => { if (e.key === 'Enter') delAccConfirm.click(); });

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
    notifToggle.checked = notificationsEnabled && ('Notification' in window) && window.Notification?.permission === 'granted';

    // Notification time preference
    const savedNotifTime = localStorage.getItem('notifTime') || '08:00';
    notifTimeSelect.value = savedNotifTime;
    notifTimeRow.style.display = notifToggle.checked ? '' : 'none';

    notifTimeSelect.addEventListener('change', () => {
        localStorage.setItem('notifTime', notifTimeSelect.value);
        if (notificationsEnabled && window.Notification?.permission === 'granted') {
            subscribeToPush();
        }
    });

    function showNotifPrompt() {
        if (!('Notification' in window)) return;
        if (window.Notification?.permission === 'granted') return;
        if (localStorage.getItem('notifPromptDismissed')) return;
        notifPrompt.classList.remove('hidden');
    }

    function hideNotifPrompt() {
        notifPrompt.classList.add('hidden');
    }

    notifPromptBtn.addEventListener('click', async () => {
        const perm = await window.Notification?.requestPermission();
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
            if (window.Notification?.permission === 'denied') {
                showToast('Сповіщення заблоковані. Розблокуйте їх в налаштуваннях браузера', 'error');
                e.target.checked = false;
                return;
            }
            if (window.Notification?.permission !== 'granted') {
                const perm = await window.Notification?.requestPermission();
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
            // Show skeleton while syncing
            if (selectedGroup && !Object.keys(getHomework()).some(k => k.startsWith(selectedGroup + '|'))) {
                homeworkContainer.innerHTML = '<div class="hw-skeleton">' +
                    '<div class="hw-skeleton-item"><div class="skeleton hw-skeleton-circle"></div><div class="hw-skeleton-lines"><div class="skeleton hw-skeleton-line1"></div><div class="skeleton hw-skeleton-line2"></div></div></div>'.repeat(4) + '</div>';
            } else {
                renderHomeworkTab();
            }
            // Fetch latest from server in background (will re-render when done)
            if (selectedGroup) syncHomeworkFromServer().catch(() => {});
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
        renderCurrentView();
    });

    // ===== Show skeleton while loading =====
    if (selectedGroup) {
        diaryContainer.innerHTML = '<div class="skeleton skeleton-header"></div>' +
            '<div class="skeleton-lesson"><div class="skeleton skeleton-lesson-num"></div><div class="skeleton-lesson-body"><div class="skeleton skeleton-lesson-title"></div><div class="skeleton skeleton-lesson-sub"></div></div></div>'.repeat(5);
    }

    // ===== Fetch schedule data =====
    let _lastFetchTime = 0;
    let _scheduleUpdatedAt = null;
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
            _scheduleUpdatedAt = resp.headers.get('last-modified') || new Date().toISOString();
            // Auto-migrate short-year group names to full-year (e.g. КСМ-24-1 → КСМ-2024-1)
            if (selectedGroup && selectedGroup !== '__teacher__' && !data[selectedGroup]) {
                var migrated = selectedGroup.split('-').map(function(p) {
                    if (/^\d{2}$/.test(p) && parseInt(p) >= 20) return (parseInt(p) < 50 ? '20' : '19') + p;
                    return p;
                }).join('-');
                if (migrated !== selectedGroup && data[migrated]) {
                    selectedGroup = migrated;
                    localStorage.setItem('selectedGroup', selectedGroup);
                    if (authToken) authFetch('setgroup', 'POST', { group: selectedGroup }).catch(function(){});
                }
            }
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
            // refreshSchedule already calls renderSchedule via rerender(),
            // syncHomeworkFromServer will only re-render visible screens
            refreshSchedule(true);
            syncHomeworkFromServer().catch(() => {});
        }
    });

    // ===== Load Data =====
    // Schedule FIRST (runs group name migration), THEN homework (uses correct group)
    try {
        await refreshSchedule(false);
    } catch (e) { console.warn('[init] schedule load error:', e); }
    if (scheduleData) renderCurrentView();
    try {
        await syncHomeworkFromServer();
    } catch (e) { console.warn('[init] hw sync error:', e); }

    // ===== Groups =====
    function renderGroupList(filter = '') {
        if (!scheduleData) return;
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
        // Sync homework then re-render so homework appears immediately
        syncHomeworkFromServer().then(() => { renderCurrentView(); renderHomeworkTab(); }).catch(() => {});
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

    // ===== Attachment helpers =====
    let _pendingFiles = []; // files queued in modal before save

    // Convert image to WebP via canvas (client-side, fast)
    function imageToWebP(file, maxDim = 1600, quality = 0.82) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
                URL.revokeObjectURL(img.src);
                let w = img.width, h = img.height;
                if (w > maxDim || h > maxDim) {
                    const scale = maxDim / Math.max(w, h);
                    w = Math.round(w * scale);
                    h = Math.round(h * scale);
                }
                const c = document.createElement('canvas');
                c.width = w; c.height = h;
                c.getContext('2d').drawImage(img, 0, 0, w, h);
                c.toBlob(blob => {
                    if (!blob) return reject(new Error('WebP conversion failed'));
                    resolve(blob);
                }, 'image/webp', quality);
            };
            img.onerror = () => { URL.revokeObjectURL(img.src); reject(new Error('Image load failed')); };
            img.src = URL.createObjectURL(file);
        });
    }

    function blobToBase64(blob) {
        return new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(r.result.split(',')[1]);
            r.onerror = reject;
            r.readAsDataURL(blob);
        });
    }

    async function uploadAttachment(group, day, number, file) {
        if (!authToken) throw new Error('Авторизуйтесь для завантаження файлів');
        let blob = file, fileName = file.name, fileType = file.type;
        // Convert images to WebP
        if (file.type.startsWith('image/')) {
            blob = await imageToWebP(file);
            fileName = file.name.replace(/\.[^.]+$/, '.webp');
            fileType = 'image/webp';
        }
        if (blob.size > 3 * 1024 * 1024) {
            throw new Error('Файл занадто великий (макс 3 МБ)');
        }
        const base64 = await blobToBase64(blob);
        const headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + authToken };
        const resp = await fetch('/api/homework?action=upload', {
            method: 'POST',
            headers,
            body: JSON.stringify({ group, day, number, fileName, fileType, fileData: base64 })
        });
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            throw new Error(err.error || `Upload failed (${resp.status})`);
        }
        return (await resp.json()).attachment;
    }

    async function deleteAttachment(group, day, number, url) {
        const headers = { 'Content-Type': 'application/json' };
        if (authToken) headers['Authorization'] = 'Bearer ' + authToken;
        const resp = await fetch('/api/homework?action=delete-attachment', {
            method: 'POST',
            headers,
            body: JSON.stringify({ group, day, number, url })
        });
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            throw new Error(err.error || 'Помилка видалення');
        }
    }

    let _previewObjUrls = [];
    function renderAttachPreview() {
        // Revoke previous ObjectURLs to prevent memory leak
        _previewObjUrls.forEach(u => URL.revokeObjectURL(u));
        _previewObjUrls = [];
        // Show existing server attachments + pending local files
        hwAttachPreview.innerHTML = '';
        const existing = (_hwFiles[modalCurrentKey] || []);
        existing.forEach(att => {
            const chip = document.createElement('div');
            chip.className = 'hw-attach-chip';
            if (att.type && att.type.startsWith('image/')) {
                chip.innerHTML = `<img src="${safeUrl(att.url)}" alt="${escHtml(att.name)}" loading="lazy" crossorigin="anonymous"><button class="hw-chip-remove" data-url="${safeUrl(att.url)}" aria-label="Видалити ${escHtml(att.name)}">&times;</button>`;
            } else {
                chip.innerHTML = `<div class="hw-chip-file">📄 ${escHtml(att.name)}</div><button class="hw-chip-remove" data-url="${safeUrl(att.url)}" aria-label="Видалити ${escHtml(att.name)}">&times;</button>`;
            }
            hwAttachPreview.appendChild(chip);
        });
        _pendingFiles.forEach((f, i) => {
            const chip = document.createElement('div');
            chip.className = 'hw-attach-chip';
            if (f.type.startsWith('image/')) {
                const url = URL.createObjectURL(f);
                _previewObjUrls.push(url);
                chip.innerHTML = `<img src="${url}" alt="${escHtml(f.name)}" loading="lazy"><button class="hw-chip-remove" data-pending="${i}" aria-label="Видалити ${escHtml(f.name)}">&times;</button>`;
            } else {
                chip.innerHTML = `<div class="hw-chip-file">📄 ${escHtml(f.name)}</div><button class="hw-chip-remove" data-pending="${i}" aria-label="Видалити ${escHtml(f.name)}">&times;</button>`;
            }
            hwAttachPreview.appendChild(chip);
        });
    }

    // Delegate clicks on attachment preview chips
    hwAttachPreview.addEventListener('click', async (e) => {
        const removeBtn = e.target.closest('.hw-chip-remove');
        if (!removeBtn) return;
        const url = removeBtn.dataset.url;
        const pendingIdx = removeBtn.dataset.pending;
        if (url && modalCurrentKey) {
            // Delete server attachment
            const parts = modalCurrentKey.split('|');
            try {
                removeBtn.disabled = true;
                removeBtn.textContent = '...';
                await deleteAttachment(parts[0], parts[1], parts[2], url);
                _hwFiles[modalCurrentKey] = (_hwFiles[modalCurrentKey] || []).filter(a => a.url !== url);
            } catch (e) {
                console.warn('Delete attachment failed:', e);
                hwUploadStatus.textContent = e.message || 'Помилка видалення';
                setTimeout(() => { hwUploadStatus.textContent = ''; }, 3000);
                return; // Don't re-render — file wasn't deleted
            }
        } else if (pendingIdx !== undefined) {
            _pendingFiles.splice(Number(pendingIdx), 1);
        }
        renderAttachPreview();
    });

    // File input handler
    hwFileInput.addEventListener('change', () => {
        if (!authToken) {
            hwUploadStatus.textContent = 'Увійдіть щоб прикріпити файли';
            hwFileInput.value = '';
            return;
        }
        const files = Array.from(hwFileInput.files);
        const maxTotal = 5;
        const existingCount = (_hwFiles[modalCurrentKey] || []).length + _pendingFiles.length;
        const allowed = files.slice(0, maxTotal - existingCount);
        if (allowed.length < files.length) {
            hwUploadStatus.textContent = `Макс ${maxTotal} файлів`;
            setTimeout(() => { hwUploadStatus.textContent = ''; }, 2000);
        }
        _pendingFiles.push(...allowed);
        hwFileInput.value = '';
        renderAttachPreview();
    });

    function openHomeworkModal(key, subject, dayLabel, existingText, dueISO) {
        // Determine actual save key: if dueISO differs from key's date, rebuild key
        _hwDueISO = dueISO || null;
        const parts = key.split('|');
        if (dueISO && parts.length === 3 && parts[1] !== dueISO) {
            modalCurrentKey = hwKey(parts[0], dueISO, parts[2]);
        } else {
            modalCurrentKey = key;
        }
        _pendingFiles = [];
        hwModalSubject.textContent = `${subject} — ${dayLabel}`;
        hwModalInput.value = existingText || '';
        hwModalTitle.textContent = existingText ? 'Редагувати завдання' : 'Додати завдання';
        hwUploadStatus.textContent = '';
        // Show due date row
        const dueDateRow = document.getElementById('hwDueDateRow');
        const dueDateLabel = document.getElementById('hwDueDateLabel');
        if (dueDateRow && dueISO) {
            dueDateRow.classList.remove('hidden');
            if (dueDateLabel) dueDateLabel.textContent = dateISOtoDisplay(dueISO);
        } else if (dueDateRow) {
            dueDateRow.classList.add('hidden');
        }
        hwModal.classList.remove('hidden');
        renderAttachPreview();
        // Focus input after modal animates in
        setTimeout(() => {
            hwModalInput.focus();
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
        _pendingFiles = [];
        hwAttachPreview.innerHTML = '';
        hwUploadStatus.textContent = '';
    }

    hwModalCancel.addEventListener('click', closeHomeworkModal);
    hwModal.addEventListener('click', (e) => {
        if (e.target === hwModal) closeHomeworkModal();
    });
    
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            if (!hwModal.classList.contains('hidden')) closeHomeworkModal();
            else if (!chPwdModal.classList.contains('hidden')) closeChPwdModal();
            else if (!delAccModal.classList.contains('hidden')) closeDelAccModal();
            else if (!logoutModalEl.classList.contains('hidden')) logoutModalEl.classList.add('hidden');
        }
        if (e.key === 'Tab' && !hwModal.classList.contains('hidden')) {
            trapFocus(hwModal, e);
        }
    });

    let _hwSaveBusy = false;
    hwModalSave.addEventListener('click', async () => {
        if (_hwSaveBusy) return; // guard against double-click
        if (!modalCurrentKey) return;
        _hwSaveBusy = true;
        hwModalSave.disabled = true;
        const text = hwModalInput.value.trim();
        const key = modalCurrentKey;
        const parts = key.split('|');

        try {
            // Save text
            const hw = getHomework();
            if (text) {
                hw[key] = text;
            } else {
                delete hw[key];
            }
            setHomework(hw);
            if (parts.length === 3) syncHomeworkToServer(parts[0], parts[1], parts[2], text).then(() => showToast('Збережено')).catch(() => showToast('Помилка синхронізації', 'error'));

            // Upload pending files
            if (_pendingFiles.length > 0 && parts.length === 3) {
                // Snapshot and clear to prevent re-upload if handler re-runs
                const filesToUpload = _pendingFiles.slice();
                _pendingFiles = [];
                hwUploadStatus.textContent = 'Завантаження...';
                let uploaded = 0;
                for (const file of filesToUpload) {
                    try {
                        hwUploadStatus.textContent = `Завантаження ${++uploaded}/${filesToUpload.length}...`;
                        const att = await uploadAttachment(parts[0], parts[1], parts[2], file);
                        if (!_hwFiles[key]) _hwFiles[key] = [];
                        _hwFiles[key].push(att);
                    } catch (e) {
                        console.warn('Upload failed:', e);
                        hwUploadStatus.textContent = e.message || 'Помилка завантаження';
                        await new Promise(r => setTimeout(r, 1500));
                    }
                }
            }
        } finally {
            _hwSaveBusy = false;
            hwModalSave.disabled = false;
            closeHomeworkModal();
            renderCurrentView();
            renderHomeworkTab();
        }
    });

    // ===== Build lesson card (optimized: single innerHTML, cached hw) =====
    function buildLessonCard(pair, dayLabel, hw, lessonStatus, dateISO) {
        const todayISO = getTodayISO();
        const legacyKey = hwKey(selectedGroup, dayLabel, pair.number);

        // Date-based key for display: lookup HW stored for this exact date
        const displayDateKey = dateISO ? hwKey(selectedGroup, dateISO, pair.number) : null;
        const savedText = (displayDateKey && hw[displayDateKey]) ? hw[displayDateKey] : hw[legacyKey] || '';
        const displayKey = (displayDateKey && hw[displayDateKey]) ? displayDateKey : legacyKey;

        // Suggested due date for NEW homework: this lesson's date if future, else next occurrence
        let suggestedDueISO = dateISO;
        if (!dateISO || dateISO < todayISO) {
            suggestedDueISO = dateISO ? findNextSubjectDateISO(pair.subject, pair.number, dateISO) : null;
        }
        // Button key: edit existing under displayKey, add new under suggestedDueISO key
        const buttonKey = savedText ? displayKey : (suggestedDueISO ? hwKey(selectedGroup, suggestedDueISO, pair.number) : legacyKey);

        const savedHtml = savedText
            ? `<div class="hw-saved"><span>${escHtml(savedText)}</span><button class="hw-delete-btn" data-key="${displayKey}" aria-label="Видалити завдання">${SVG_X}</button></div>`
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

        // Attachment thumbnails (use displayKey for files)
        const keyFiles = _hwFiles[displayKey] || [];
        let attachHtml = '';
        if (keyFiles.length > 0) {
            attachHtml = '<div class="hw-attachments">' + keyFiles.map(a => {
                if (a.type && a.type.startsWith('image/')) {
                    return `<img src="${safeUrl(a.url)}" alt="${escHtml(a.name)}" class="hw-att-thumb" data-full="${safeUrl(a.url)}" loading="lazy" crossorigin="anonymous">`;
                }
                return `<a href="${safeUrl(a.url)}" target="_blank" rel="noopener" class="hw-att-file-link">📄 ${escHtml(a.name)}</a>`;
            }).join('') + '</div>';
        }

        // Due-date badge shown on the lesson card when HW is stored for this date
        const dueBadgeHtml = savedText && dateISO ? `<span class="hw-due-badge">${SVG_CALENDAR} ${dateISOtoDisplay(dateISO)}</span>` : '';

        const hwBtnHtml = canEditHw() ? `<button class="homework-btn" data-key="${buttonKey}" data-subject="${escapedSubject}" data-day="${dayLabel}" data-dueiso="${suggestedDueISO || ''}" aria-label="${btnLabel}: ${escapedSubject}">${btnIcon} ${btnLabel}</button>` : '';
        const deleteHtml = canEditHw() ? savedHtml : savedText ? `<div class="hw-saved"><span>${escHtml(savedText)}</span></div>` : '';
        div.innerHTML = `<div class="diary-item-header"><span class="diary-item-number">${safeNum} пара</span>${statusBadge}${timeHtml}</div>${subjectHtml}${teacherHtml}${deleteHtml}${attachHtml}${hwBtnHtml}`;
        return div;
    }

    // ===== Image lightbox =====
    function showLightbox(src) {
        const lb = document.createElement('div');
        lb.className = 'hw-lightbox';
        lb.innerHTML = `<button class="lb-close" aria-label="Закрити">&times;</button><img src="${safeUrl(src)}" alt="Фото" crossorigin="anonymous">`;
        // Close on background click or close button
        lb.addEventListener('click', (ev) => {
            if (ev.target === lb || ev.target.classList.contains('lb-close')) {
                lb.classList.add('lb-closing');
                setTimeout(() => lb.remove(), 200);
            }
        });
        // Close on Escape
        const onKey = (ev) => {
            if (ev.key === 'Escape') { lb.classList.add('lb-closing'); setTimeout(() => lb.remove(), 200); document.removeEventListener('keydown', onKey); }
        };
        document.addEventListener('keydown', onKey);
        document.body.appendChild(lb);
    }

    // ===== Event delegation (single listener on document) =====
    document.addEventListener('click', (e) => {
        // Lightbox for attachment thumbnails
        const thumb = e.target.closest('.hw-att-thumb');
        if (thumb) {
            showLightbox(thumb.dataset.full || thumb.src);
            return;
        }

        const hwBtn = e.target.closest('.homework-btn');
        if (hwBtn) {
            // Teacher HW buttons use data-group/day/number instead of data-key
            if (hwBtn.classList.contains('teacher-hw-btn')) {
                const group = hwBtn.dataset.group;
                const day = hwBtn.dataset.day;
                const number = hwBtn.dataset.number;
                const key = `${group}|${day}|${number}`;
                const hw = getHomework();
                const existingText = hw[key] || '';
                const dayDisplay = /^\d{4}-\d{2}-\d{2}$/.test(day) ? dateISOtoDisplay(day) : day;
                openHomeworkModal(key, hwBtn.closest('.diary-item')?.querySelector('.diary-item-subject')?.textContent || '', `${group} · ${dayDisplay}`, existingText, null);
                return;
            }
            const { key, subject, day, dueiso } = hwBtn.dataset;
            const hw = getHomework();
            // Look up existing text: check both the button key and any dueiso-based key
            const existingText = hw[key] || '';
            openHomeworkModal(key, subject, day, existingText, dueiso || null);
            return;
        }

        const delBtn = e.target.closest('.hw-delete-btn');
        if (delBtn) {
            const hw = getHomework();
            const key = delBtn.dataset.key;
            delete hw[key];
            setHomework(hw);
            const parts = key.split('|');
            if (parts.length === 3) {
                syncHomeworkToServer(parts[0], parts[1], parts[2], '').catch(() => {});
                // Also delete all file attachments for this lesson
                const files = _hwFiles[key] || [];
                files.forEach(f => deleteAttachment(parts[0], parts[1], parts[2], f.url).catch(() => {}));
                delete _hwFiles[key];
            }
            renderCurrentView();
            return;
        }

        const hwDelCard = e.target.closest('.hw-card-delete');
        if (hwDelCard) {
            const hw = getHomework();
            const key = hwDelCard.dataset.key;
            delete hw[key];
            setHomework(hw);
            const parts = key.split('|');
            if (parts.length === 3) {
                syncHomeworkToServer(parts[0], parts[1], parts[2], '').catch(() => {});
                const files = _hwFiles[key] || [];
                files.forEach(f => deleteAttachment(parts[0], parts[1], parts[2], f.url).catch(() => {}));
                delete _hwFiles[key];
            }
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
            currentWeekType = isoWeek % 2 === 0 ? 'ЧИСЕЛЬНИК' : 'ЗНАМЕННИК';
        }

        let weekData = scheduleData[selectedGroup][currentWeekType];

        const isDataEmpty = !weekData || (Array.isArray(weekData) ? weekData.length === 0 : Object.keys(weekData).length === 0);
        if (isDataEmpty) {
            const availableTypes = groupTypes;
            currentWeekType = availableTypes.includes('ОСНОВНИЙ РОЗКЛАД') ? 'ОСНОВНИЙ РОЗКЛАД' : availableTypes[0];
            weekData = scheduleData[selectedGroup][currentWeekType];
            if (!currentWeekType) currentWeekType = 'ОСНОВНИЙ РОЗКЛАД';
        }

        weekTypeToggle.style.display = '';
        shareScheduleBtn.style.display = '';
        weekTypeToggle.textContent = (currentWeekType || 'РОЗКЛАД').split(' ')[0];

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

        // Compute DD.MM dates AND ISO dates for Mon-Fri of the target week (with weekOffset)
        const weekDates = {};
        const weekDatesISO = {};
        const daysOrder = ['Понеділок', 'Вівторок', 'Середа', 'Четвер', 'П\'ятниця', 'Субота', 'Неділя'];
        for (let i = 0; i < daysOrder.length; i++) {
            const offset = (i + 1) - currentDayOfWeek + (weekOffset * 7);
            const d = new Date(today);
            d.setDate(today.getDate() + offset);
            const dayStr = String(d.getDate()).padStart(2, '0');
            const monthStr = String(d.getMonth() + 1).padStart(2, '0');
            weekDates[daysOrder[i]] = `${dayStr}.${monthStr}`;
            weekDatesISO[daysOrder[i]] = `${d.getFullYear()}-${monthStr}-${dayStr}`;
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

            const pairWord = pairs.length === 1 ? 'пара' : (pairs.length >= 2 && pairs.length <= 4) ? 'пари' : 'пар';
            const title = document.createElement('h2');
            title.innerHTML = `${day} <span class="date-badge">${dateStr} · ${pairs.length} ${pairWord}</span>`;
            
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
                dayEl.appendChild(buildLessonCard(pairs[p], day, hw, lessonStatuses[pairs[p].number] || null, weekDatesISO[day]));
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

        // "Updated at" footer for data freshness
        if (_scheduleUpdatedAt) {
            const updEl = document.createElement('div');
            updEl.className = 'schedule-updated';
            try {
                const d = new Date(_scheduleUpdatedAt);
                updEl.textContent = `Оновлено: ${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')}.${d.getFullYear()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
            } catch { updEl.textContent = ''; }
            frag.appendChild(updEl);
        }

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
            currentWeekType = isoWeek % 2 === 0 ? 'ЧИСЕЛЬНИК' : 'ЗНАМЕННИК';
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
        // Pre-index substitutions by date for O(1) lookup per cell
        const subsIndex = {};
        for (const s of substitutionsList) {
            if (!subsIndex[s.date]) subsIndex[s.date] = [];
            subsIndex[s.date].push(s);
        }
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

                const subsForDate = subsIndex[dateStr] || [];
                for (const sub of subsForDate) {
                    pairs = pairs.filter(pr => parseInt(pr.number) !== parseInt(sub.number));
                    pairs.push({ ...sub, isSubstitution: true });
                }

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

    // ===== Swipe Day View =====
    function renderSwipeView() {
        if (!scheduleData) {
            diaryContainer.innerHTML = `<div class="empty-state-container">${SVG_EMPTY_SCHEDULE}<p class="empty-state-title">Немає з'єднання</p><p class="empty-state-desc">Не вдалося завантажити розклад.</p></div>`;
            return;
        }
        if (!scheduleData[selectedGroup]) {
            diaryContainer.innerHTML = `<div class="empty-state-container">${SVG_EMPTY_SCHEDULE}<p class="empty-state-title">Групу не знайдено</p></div>`;
            return;
        }
        currentGroupTitle.textContent = selectedGroup;

        // Week type detection (same as renderSchedule)
        const groupTypes = Object.keys(scheduleData[selectedGroup]).filter(t => t !== 'ПІДВІСКА');
        const hasChis = groupTypes.includes('ЧИСЕЛЬНИК');
        const hasZnam = groupTypes.includes('ЗНАМЕННИК');
        if (hasChis && hasZnam && (currentWeekType === 'ОСНОВНИЙ РОЗКЛАД' || currentWeekType === 'ЧИСЕЛЬНИК' || currentWeekType === 'ЗНАМЕННИК')) {
            const isoWeek = getISOWeek(weekOffset);
            currentWeekType = isoWeek % 2 === 0 ? 'ЧИСЕЛЬНИК' : 'ЗНАМЕННИК';
        }
        let weekData = scheduleData[selectedGroup][currentWeekType];
        const isDataEmpty = !weekData || (Array.isArray(weekData) ? weekData.length === 0 : Object.keys(weekData).length === 0);
        if (isDataEmpty) {
            currentWeekType = groupTypes.includes('ОСНОВНИЙ РОЗКЛАД') ? 'ОСНОВНИЙ РОЗКЛАД' : groupTypes[0];
            weekData = scheduleData[selectedGroup][currentWeekType];
            if (!currentWeekType) currentWeekType = 'ОСНОВНИЙ РОЗКЛАД';
        }
        weekTypeToggle.textContent = (currentWeekType || 'РОЗКЛАД').split(' ')[0];
        if (!weekData) {
            diaryContainer.innerHTML = `<div class="empty-state-container">${SVG_EMPTY_SCHEDULE}<p class="empty-state-title">Розклад відсутній</p></div>`;
            return;
        }

        const hw = getHomework();
        const kyivNow = getKyivNow();
        const currentDayOfWeek = kyivNow.dayOfWeek || 7;
        const todayLabel = ukDays[kyivNow.dayOfWeek];
        const today = new Date(kyivNow.year, kyivNow.month - 1, kyivNow.day);
        const days = ['Понеділок', 'Вівторок', 'Середа', 'Четвер', 'П\'ятниця'];
        const shortDays = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт'];
        const substitutionsList = scheduleData[selectedGroup]['ПІДВІСКА'] || [];

        // Compute week dates
        const weekDates = {};
        const weekDatesISO = {};
        const daysOrder = ['Понеділок', 'Вівторок', 'Середа', 'Четвер', 'П\'ятниця', 'Субота', 'Неділя'];
        for (let i = 0; i < daysOrder.length; i++) {
            const offset = (i + 1) - currentDayOfWeek + (weekOffset * 7);
            const d = new Date(today);
            d.setDate(today.getDate() + offset);
            const dayStr = String(d.getDate()).padStart(2, '0');
            const monthStr = String(d.getMonth() + 1).padStart(2, '0');
            weekDates[daysOrder[i]] = `${dayStr}.${monthStr}`;
            weekDatesISO[daysOrder[i]] = `${d.getFullYear()}-${monthStr}-${dayStr}`;
        }

        // Build pairs per day
        const dayPairs = [];
        for (let di = 0; di < days.length; di++) {
            const day = days[di];
            const dateStr = weekDates[day];
            let pairs = weekData[day] ? [...weekData[day]] : [];
            const subsForDate = substitutionsList.filter(s => s.date === dateStr);
            if (subsForDate.length > 0) {
                subsForDate.forEach(sub => {
                    const replaces = pairs.some(p => parseInt(p.number) === parseInt(sub.number));
                    pairs = pairs.filter(p => parseInt(p.number) !== parseInt(sub.number));
                    pairs.push({ ...sub, isSubstitution: true, substitutionType: replaces ? 'заміна' : 'підвіска' });
                });
            }
            pairs.sort((a, b) => parseInt(a.number) - parseInt(b.number));
            dayPairs.push({ day, dateStr, dateISO: weekDatesISO[day], pairs, hasSub: subsForDate.length > 0 });
        }

        // Auto-select today (or Mon) on first render / week change
        if (_swipeDayIdx < 0 || _swipeDayIdx > 4) {
            const todayIdx = days.indexOf(todayLabel);
            _swipeDayIdx = (weekOffset === 0 && todayIdx >= 0 && todayIdx < 5) ? todayIdx : 0;
        }

        // Day chips bar
        let chipsHtml = '<div class="swipe-day-bar">';
        for (let i = 0; i < days.length; i++) {
            const isActive = i === _swipeDayIdx;
            const hasSub = dayPairs[i].hasSub;
            const dateNum = dayPairs[i].dateStr.split('.')[0];
            chipsHtml += `<button class="swipe-day-chip${isActive ? ' active' : ''}${hasSub ? ' has-sub' : ''}" data-idx="${i}">${shortDays[i]}<br><span style="font-size:11px;font-weight:400;opacity:.7">${dateNum}</span></button>`;
        }
        chipsHtml += '</div>';

        // Slides
        let slidesHtml = '<div class="swipe-track"><div class="swipe-slides" style="transform:translateX(-' + (_swipeDayIdx * 100) + '%)">';
        for (let di = 0; di < days.length; di++) {
            const dp = dayPairs[di];
            slidesHtml += '<div class="swipe-slide"><div class="diary-day">';
            const swPairWord = dp.pairs.length === 1 ? 'пара' : (dp.pairs.length >= 2 && dp.pairs.length <= 4) ? 'пари' : 'пар';
            slidesHtml += `<h2>${dp.day} <span class="date-badge">${dp.dateStr} · ${dp.pairs.length} ${swPairWord}</span>`;
            const isToday = weekOffset === 0 && dp.day === todayLabel;
            if (isToday) slidesHtml += '<span class="today-badge">Сьогодні</span>';
            slidesHtml += '</h2>';

            if (dp.pairs.length === 0) {
                slidesHtml += '<div style="padding:2rem 0;text-align:center;color:var(--text-secondary);font-size:14px">Немає пар</div>';
            } else {
                // Lesson statuses
                const lessonStatuses = {};
                if (isToday) {
                    const nowMin = kyivNow.totalMinutes;
                    let foundNext = false;
                    for (const pr of dp.pairs) {
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
                // Use a temp container to get HTML from buildLessonCard
                const tempDiv = document.createElement('div');
                for (const pair of dp.pairs) {
                    tempDiv.appendChild(buildLessonCard(pair, dp.day, hw, lessonStatuses[pair.number] || null, dp.dateISO));
                }
                slidesHtml += tempDiv.innerHTML;
            }
            slidesHtml += '</div></div>';
        }
        slidesHtml += '</div></div>';

        // Week nav
        const mondayDate = weekDates['Понеділок'];
        const fridayDate = weekDates["П'ятниця"];
        const weekLabel = weekOffset === 0 ? 'Поточний тиждень' : weekOffset === 1 ? 'Наступний тиждень' : weekOffset === -1 ? 'Минулий тиждень' : `${mondayDate} — ${fridayDate}`;
        const weekNavHtml = `<div class="week-nav">
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
        </div>`;

        diaryContainer.innerHTML = chipsHtml + slidesHtml + weekNavHtml;

        // --- Event wiring ---

        // Day chips tap
        diaryContainer.querySelectorAll('.swipe-day-chip').forEach(chip => {
            chip.addEventListener('click', () => {
                _swipeDayIdx = parseInt(chip.dataset.idx);
                goToSlide(_swipeDayIdx);
            });
        });

        // Week nav
        diaryContainer.querySelectorAll('.week-nav-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                weekOffset += parseInt(btn.dataset.dir);
                _swipeDayIdx = 0;
                renderSwipeView();
                window.scrollTo({ top: 0, behavior: 'smooth' });
            });
        });
        const center = diaryContainer.querySelector('.week-nav-center');
        if (center) center.addEventListener('click', () => {
            if (weekOffset !== 0) { weekOffset = 0; _swipeDayIdx = -1; renderSwipeView(); }
        });

        // --- Touch swipe handling ---
        const track = diaryContainer.querySelector('.swipe-track');
        const slides = diaryContainer.querySelector('.swipe-slides');
        if (!track || !slides) return;

        let startX = 0, startY = 0, deltaX = 0, isSwiping = false, locked = false;
        const THRESHOLD = 50;

        function goToSlide(idx) {
            _swipeDayIdx = Math.max(0, Math.min(4, idx));
            slides.classList.remove('dragging');
            slides.style.transform = `translateX(-${_swipeDayIdx * 100}%)`;
            // Update chips
            diaryContainer.querySelectorAll('.swipe-day-chip').forEach((c, i) => {
                c.classList.toggle('active', i === _swipeDayIdx);
            });
        }

        track.addEventListener('touchstart', (e) => {
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
            deltaX = 0;
            isSwiping = false;
            locked = false;
        }, { passive: true });

        track.addEventListener('touchmove', (e) => {
            const dx = e.touches[0].clientX - startX;
            const dy = e.touches[0].clientY - startY;

            // Lock direction after 10px movement
            if (!locked && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) {
                locked = true;
                isSwiping = Math.abs(dx) > Math.abs(dy);
            }
            if (!isSwiping) return;

            e.preventDefault();
            deltaX = dx;
            const baseOffset = -_swipeDayIdx * 100;
            const pxToPercent = (deltaX / track.offsetWidth) * 100;
            slides.classList.add('dragging');
            slides.style.transform = `translateX(${baseOffset + pxToPercent}%)`;
        }, { passive: false });

        track.addEventListener('touchend', () => {
            if (!isSwiping) return;
            if (deltaX < -THRESHOLD && _swipeDayIdx < 4) {
                goToSlide(_swipeDayIdx + 1);
            } else if (deltaX > THRESHOLD && _swipeDayIdx > 0) {
                goToSlide(_swipeDayIdx - 1);
            } else {
                goToSlide(_swipeDayIdx); // snap back
            }
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

    // ===== Teacher Schedule View =====
    function renderTeacherSchedule() {
        if (!scheduleData) {
            diaryContainer.innerHTML = `<div class="empty-state-container">${SVG_EMPTY_SCHEDULE}<p class="empty-state-title">Завантаження...</p></div>`;
            return;
        }
        if (!currentUser) {
            diaryContainer.innerHTML = `<div class="empty-state-container">${SVG_EMPTY_SCHEDULE}<p class="empty-state-title">Завантаження...</p></div>`;
            return;
        }
        // Use teacherName or fall back to displayName (for accounts where teacherName wasn't stored)
        const teacherName = currentUser.teacherName || currentUser.displayName || '';
        if (!teacherName) {
            diaryContainer.innerHTML = `<div class="empty-state-container">${SVG_EMPTY_SCHEDULE}<p class="empty-state-title">Ім'я в розкладі не налаштовано</p><p class="empty-state-desc">Зверніться до адміністратора.</p></div>`;
            return;
        }
        currentGroupTitle.textContent = teacherName;
        weekTypeToggle.style.display = 'none';
        shareScheduleBtn.style.display = 'none';

        const kyivNow = getKyivNow();
        const currentDayOfWeek = kyivNow.dayOfWeek || 7;
        const todayLabel = ukDays[kyivNow.dayOfWeek];
        const today = new Date(kyivNow.year, kyivNow.month - 1, kyivNow.day);

        const daysOrder = ['Понеділок', 'Вівторок', 'Середа', 'Четвер', 'П\'ятниця'];
        const weekDates = {};
        const weekDatesISO = {};
        for (let i = 0; i < 7; i++) {
            const allDays = ['Понеділок', 'Вівторок', 'Середа', 'Четвер', 'П\'ятниця', 'Субота', 'Неділя'];
            const offset = (i + 1) - currentDayOfWeek + (weekOffset * 7);
            const d = new Date(today);
            d.setDate(today.getDate() + offset);
            const dayStr = String(d.getDate()).padStart(2, '0');
            const monthStr = String(d.getMonth() + 1).padStart(2, '0');
            weekDates[allDays[i]] = `${dayStr}.${monthStr}`;
            weekDatesISO[allDays[i]] = `${d.getFullYear()}-${monthStr}-${dayStr}`;
        }

        // Collect teacher's pairs from ALL groups
        const frag = document.createDocumentFragment();
        const groups = Object.keys(scheduleData).filter(k => k !== '_settings');

        // Determine which week type to use per group
        function getWeekData(group) {
            const gd = scheduleData[group];
            if (!gd) return null;
            const types = Object.keys(gd).filter(t => t !== 'ПІДВІСКА');
            if (types.includes(currentWeekType)) return { weekData: gd[currentWeekType], subs: gd['ПІДВІСКА'] || [] };
            if (types.length > 0) return { weekData: gd[types[0]], subs: gd['ПІДВІСКА'] || [] };
            return null;
        }

        for (let di = 0; di < daysOrder.length; di++) {
            const day = daysOrder[di];
            const dateStr = weekDates[day];
            const dayPairs = []; // { pair, group }

            for (const group of groups) {
                const wd = getWeekData(group);
                if (!wd || !wd.weekData || !wd.weekData[day]) continue;

                // Regular pairs
                let groupPairs = [...wd.weekData[day]];

                // Merge substitutions for this date
                const subsForDate = (wd.subs || []).filter(s => s.date === dateStr);
                if (subsForDate.length > 0) {
                    subsForDate.forEach(sub => {
                        groupPairs = groupPairs.filter(p => parseInt(p.number) !== parseInt(sub.number));
                        groupPairs.push({ ...sub, isSubstitution: true, substitutionType: 'заміна' });
                    });
                }

                for (const pair of groupPairs) {
                    if (pair.teacher === teacherName) {
                        dayPairs.push({ pair, group });
                    }
                }
            }

            if (dayPairs.length === 0) continue;
            dayPairs.sort((a, b) => parseInt(a.pair.number) - parseInt(b.pair.number));

            const dayEl = document.createElement('div');
            dayEl.className = 'diary-day';

            const pairWord = dayPairs.length === 1 ? 'пара' : (dayPairs.length >= 2 && dayPairs.length <= 4) ? 'пари' : 'пар';
            const title = document.createElement('h2');
            title.innerHTML = `${day} <span class="date-badge">${dateStr} · ${dayPairs.length} ${pairWord}</span>`;

            const isToday = weekOffset === 0 && day === todayLabel;
            if (isToday) {
                dayEl.classList.add('is-today');
                dayEl.id = 'today-marker';
                const badge = document.createElement('span');
                badge.className = 'today-badge';
                badge.textContent = 'Сьогодні';
                title.appendChild(badge);
            }
            dayEl.appendChild(title);

            // Lesson statuses for today
            const lessonStatuses = {};
            if (isToday) {
                const nowMin = kyivNow.totalMinutes;
                let foundNext = false;
                for (const { pair: pr } of dayPairs) {
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

            for (const { pair, group } of dayPairs) {
                const card = document.createElement('div');
                card.className = 'diary-item';
                if (lessonStatuses[pair.number] === 'now') card.classList.add('is-now');
                else if (lessonStatuses[pair.number] === 'next') card.classList.add('is-next');
                if (pair.isSubstitution) card.classList.add('substitution');

                const safeNum = Number(pair.number) || 0;
                const escapedSubject = escHtml(pair.subject);
                const timeHtml = LESSON_TIMES[pair.number] ? `<span class="diary-item-time">${LESSON_TIMES[pair.number]}</span>` : '';
                const roomHtml = pair.room ? `<span class="diary-item-room">ауд. ${escHtml(pair.room)}</span>` : '';

                let statusBadge = '';
                if (lessonStatuses[pair.number] === 'now') {
                    const t = LESSON_TIMES[pair.number];
                    if (t) {
                        const endStr = t.split(' - ')[1];
                        const [eh, em] = endStr.split(':').map(Number);
                        const remaining = Math.max(0, (eh * 60 + em) - kyivNow.totalMinutes);
                        statusBadge = `<span class="badge-now">ЗАРАЗ • ще ${remaining} хв</span>`;
                    }
                } else if (lessonStatuses[pair.number] === 'next') {
                    const t = LESSON_TIMES[pair.number];
                    if (t) {
                        const startStr = t.split(' - ')[0];
                        const [sh, sm] = startStr.split(':').map(Number);
                        const until = Math.max(0, (sh * 60 + sm) - kyivNow.totalMinutes);
                        statusBadge = `<span class="badge-next">НАСТУПНА • через ${until} хв</span>`;
                    }
                }

                let subBadge = '';
                if (pair.isSubstitution) {
                    const badgeText = pair.substitutionType === 'підвіска' ? 'ПІДВІСКА' : 'ЗАМІНА';
                    subBadge = `<span class="badge-substitution">${badgeText}</span> `;
                }

                // Teacher sees group name instead of teacher name
                const groupBadge = `<span class="diary-item-group-badge">${escHtml(group)}</span>`;

                // Homework button for teacher (check both day-name and ISO-date keys)
                const hwKeyDay = `${group}|${day}|${safeNum}`;
                const hwKeyISO = weekDatesISO[day] ? `${group}|${weekDatesISO[day]}|${safeNum}` : '';
                const hw = getHomework();
                const existingHw = hw[hwKeyISO] || hw[hwKeyDay] || '';
                const hwBtnHtml = `<button class="homework-btn teacher-hw-btn" data-group="${escHtml(group)}" data-day="${hwKeyISO ? escHtml(weekDatesISO[day]) : escHtml(day)}" data-number="${safeNum}">${existingHw ? '✏️ ДЗ' : '+ ДЗ'}</button>`;

                card.innerHTML = `<div class="diary-item-header"><span class="diary-item-number">${safeNum} пара</span>${statusBadge}${timeHtml}</div><div class="diary-item-subject">${subBadge}${escapedSubject}</div><div class="diary-item-teacher">${groupBadge}${roomHtml ? ' · ' + roomHtml : ''}</div>${existingHw ? '<div class="diary-item-hw">' + escHtml(existingHw) + '</div>' : ''}${hwBtnHtml}`;
                dayEl.appendChild(card);
            }
            frag.appendChild(dayEl);
        }

        if (frag.childElementCount === 0) {
            diaryContainer.innerHTML = `<div class="empty-state-container">${SVG_EMPTY_SCHEDULE}<p class="empty-state-title">Немає пар</p><p class="empty-state-desc">На цьому тижні у вас немає пар.</p></div>`;
        } else {
            diaryContainer.innerHTML = '';
            diaryContainer.appendChild(frag);
        }

        // Week navigation (reuse existing pattern)
        const tMon = weekDates['Понеділок'] || '';
        const tFri = weekDates["П'ятниця"] || '';
        const tLabel = weekOffset === 0 ? 'Поточний тиждень' : weekOffset === 1 ? 'Наступний тиждень' : weekOffset === -1 ? 'Минулий тиждень' : `${tMon} — ${tFri}`;
        const navHtml = `<div class="week-nav">
            <button class="week-nav-btn" data-dir="-1" aria-label="Попередній тиждень"><svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none"><polyline points="15 18 9 12 15 6"/></svg></button>
            <div class="week-nav-center"><span class="week-nav-label">${tLabel}</span><span class="week-nav-dates">${tMon} — ${tFri}</span></div>
            <button class="week-nav-btn" data-dir="1" aria-label="Наступний тиждень"><svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none"><polyline points="9 18 15 12 9 6"/></svg></button>
        </div>`;
        diaryContainer.insertAdjacentHTML('beforeend', navHtml);
        diaryContainer.querySelectorAll('.week-nav-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                weekOffset += parseInt(btn.dataset.dir);
                renderTeacherSchedule();
                window.scrollTo({ top: 0, behavior: 'smooth' });
            });
        });
        const center = diaryContainer.querySelector('.week-nav-center');
        if (center) center.addEventListener('click', () => {
            if (weekOffset !== 0) { weekOffset = 0; renderTeacherSchedule(); }
        });

        // Scroll to today
        requestAnimationFrame(() => {
            const todayMarker = document.getElementById('today-marker');
            if (todayMarker) {
                todayMarker.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        });
    }

    function renderCurrentView() {
        // Always use teacher view when logged in as teacher
        if (isTeacher() || selectedGroup === '__teacher__') { renderTeacherSchedule(); return; }
        if (swipeView) renderSwipeView();
        else if (gridView) renderGridView();
        else renderSchedule();
    }

    // ===== Swipe View Toggle (settings) =====
    const swipeViewToggle = document.getElementById('swipeViewToggle');
    swipeViewToggle.checked = swipeView;
    swipeViewToggle.addEventListener('change', () => {
        swipeView = swipeViewToggle.checked;
        localStorage.setItem('swipeView', swipeView ? '1' : '0');
        renderCurrentView();
    });

    // ===== Pull-to-refresh (schedule screen) =====
    (function initPullToRefresh() {
        let startY = 0, pulling = false, dist = 0;
        const TRIGGER = 120; // px needed to trigger refresh
        const indicator = document.createElement('div');
        indicator.style.cssText = 'position:fixed;top:-44px;left:50%;transform:translateX(-50%);width:36px;height:36px;border-radius:50%;background:var(--surface-color);box-shadow:0 2px 8px rgba(0,0,0,.15);display:flex;align-items:center;justify-content:center;transition:top .2s;z-index:999;font-size:18px;pointer-events:none';
        indicator.textContent = '↻';
        document.body.appendChild(indicator);

        window.addEventListener('touchstart', (e) => {
            // Only activate when page is scrolled to the very top and schedule is visible
            if (window.scrollY <= 0 && !screens.schedule.classList.contains('hidden')) {
                startY = e.touches[0].clientY;
                dist = 0;
                pulling = true;
            }
        }, { passive: true });

        window.addEventListener('touchmove', (e) => {
            if (!pulling) return;
            dist = e.touches[0].clientY - startY;
            if (dist > 10 && dist < 200) {
                indicator.style.top = Math.min(dist - 44, 24) + 'px';
                indicator.style.opacity = Math.min(dist / TRIGGER, 1);
            } else if (dist <= 0) {
                // User is scrolling up (normal), cancel pull
                pulling = false;
                indicator.style.top = '-44px';
                indicator.style.opacity = '0';
            }
        }, { passive: true });

        window.addEventListener('touchend', () => {
            if (!pulling) { return; }
            pulling = false;
            indicator.style.top = '-44px';
            indicator.style.opacity = '0';
            if (dist >= TRIGGER) {
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
        const isTeacherView = isTeacher() || selectedGroup === '__teacher__';
        const prefix = isTeacherView ? null : selectedGroup + '|';
        const todayISO = getTodayISO();
        const activeEntries = [];  // date >= today OR legacy (day name)
        const historyEntries = []; // date < today

        // Detect whether a key segment is an ISO date
        function isISODate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s); }

        function collectEntry(key, text) {
            const parts = key.split('|');
            if (parts.length !== 3) return;
            const dayOrDate = parts[1];
            if (isISODate(dayOrDate)) {
                (dayOrDate < todayISO ? historyEntries : activeEntries).push({ key, date: dayOrDate, number: parts[2], text, group: parts[0] });
            } else {
                activeEntries.push({ key, day: dayOrDate, number: parts[2], text, group: parts[0] });
            }
        }

        for (const key in hw) {
            if (prefix ? key.startsWith(prefix) : true) collectEntry(key, hw[key]);
        }
        for (const key in _hwFiles) {
            if ((prefix ? key.startsWith(prefix) : true) && !hw[key] && _hwFiles[key].length > 0) collectEntry(key, '');
        }

        if (activeEntries.length === 0 && historyEntries.length === 0) {
            const desc = canEditHw()
                ? 'Натисніть «Додати завдання» в розкладі, щоб створити запис.'
                : 'Завдання з\'являться тут, коли староста їх додасть.';
            homeworkContainer.innerHTML = `<div class="empty-state-container">${SVG_EMPTY_HOMEWORK}<p class="empty-state-title">Немає завдань</p><p class="empty-state-desc">${desc}</p></div>`;
            return;
        }

        // Sort: active by date ASC, history by date DESC
        activeEntries.sort((a, b) => (a.date || a.day || '').localeCompare(b.date || b.day || '') || a.number - b.number);
        historyEntries.sort((a, b) => (b.date || '').localeCompare(a.date || '') || a.number - b.number);

        function lookupSubject(entry) {
            const dayName = entry.date ? isoToUkDay(entry.date) : entry.day;
            let subjectName = `Пара ${entry.number}`;
            const groupKey = entry.group || selectedGroup;
            if (scheduleData && scheduleData[groupKey]) {
                const groupData = scheduleData[groupKey];
                const weekTypes = Object.keys(groupData).filter(t => t !== 'ПІДВІСКА');
                for (const wt of weekTypes) {
                    const wd = groupData[wt];
                    if (wd && wd[dayName]) {
                        const found = wd[dayName].find(p => parseInt(p.number) === parseInt(entry.number));
                        if (found) { subjectName = found.subject; break; }
                    }
                }
            }
            return subjectName;
        }

        function buildCard(entry, isHistory) {
            const subjectName = lookupSubject(entry);
            const escapedSub = escHtml(subjectName);
            const card = document.createElement('div');
            card.className = 'hw-card' + (isHistory ? ' hw-card-history' : '');
            const metaDate = entry.date ? `${SVG_CALENDAR} ${dateISOtoDisplay(entry.date)}` : escHtml(entry.day || '');
            const cardFiles = _hwFiles[entry.key] || [];
            let cardAttHtml = '';
            if (cardFiles.length > 0) {
                cardAttHtml = '<div class="hw-attachments">' + cardFiles.map(a => {
                    if (a.type && a.type.startsWith('image/')) {
                        return `<img src="${safeUrl(a.url)}" alt="${escHtml(a.name)}" class="hw-att-thumb" data-full="${safeUrl(a.url)}" loading="lazy" crossorigin="anonymous">`;
                    }
                    return `<a href="${safeUrl(a.url)}" target="_blank" rel="noopener" class="hw-att-file-link">📄 ${escHtml(a.name)}</a>`;
                }).join('') + '</div>';
            }
            const actionsHtml = !isHistory && canEditHw()
                ? `<div class="hw-card-actions"><button class="hw-card-edit" data-key="${entry.key}" data-subject="${escapedSub}" data-day="${escHtml(entry.day || isoToUkDay(entry.date || ''))}" aria-label="Редагувати: ${escapedSub}">${SVG_EDIT_SM} Редагувати</button><button class="hw-card-delete hw-delete" data-key="${entry.key}" aria-label="Видалити: ${escapedSub}">${SVG_TRASH} Видалити</button></div>`
                : '';
            const groupLabel = (isTeacherView && entry.group) ? `<span class="diary-item-group-badge">${escHtml(entry.group)}</span> · ` : '';
            card.innerHTML = `<div class="hw-card-subject">${escapedSub}</div><div class="hw-card-meta">${groupLabel}${entry.number} пара · ${metaDate}</div><div class="hw-card-text">${escHtml(entry.text)}</div>${cardAttHtml}${actionsHtml}`;
            return card;
        }

        const frag = document.createDocumentFragment();

        // Active section
        if (activeEntries.length > 0) {
            const hdr = document.createElement('h2');
            hdr.className = 'hw-section-title';
            hdr.innerHTML = SVG_BOOK + ' Активні завдання';
            frag.appendChild(hdr);
            activeEntries.forEach(e => frag.appendChild(buildCard(e, false)));
        }

        // History section (collapsible)
        if (historyEntries.length > 0) {
            const details = document.createElement('details');
            details.className = 'hw-history-details';
            const summary = document.createElement('summary');
            summary.className = 'hw-history-summary';
            summary.innerHTML = SVG_CLOCK + ` Минулі завдання (${historyEntries.length})`;
            details.appendChild(summary);
            historyEntries.forEach(e => details.appendChild(buildCard(e, true)));
            frag.appendChild(details);
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
        if (window.Notification?.permission !== 'granted') return;
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
            renderCurrentView();
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
    // Try to restore session via httpOnly cookie (hasSession is a non-sensitive hint)
    let sessionValid = false;
    if (localStorage.getItem('hasSession')) {
        try {
            const data = await authFetch('me', 'GET');
            applyUserInfo(data.user);
            sessionValid = true;
            // Restore group from server if local is missing
            if (data.user.group && !selectedGroup) {
                selectedGroup = data.user.group;
                localStorage.setItem('selectedGroup', selectedGroup);
            }
            // Re-render now that we have user info (fixes teacher view loading)
            if (scheduleData && selectedGroup) renderCurrentView();
        } catch {
            // Cookie expired or invalid — clear the hint
            localStorage.removeItem('hasSession');
        }
    }

    // Teacher doesn't need a group — force __teacher__ (handles upgrade from student→teacher too)
    if (isTeacher() && sessionValid && selectedGroup !== '__teacher__') {
        selectedGroup = '__teacher__';
        localStorage.setItem('selectedGroup', '__teacher__');
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
        if (notificationsEnabled && window.Notification?.permission === 'granted') {
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
            if (notificationsEnabled && window.Notification?.permission === 'granted') {
                setTimeout(() => showDailyNotification(true), 2 * 60 * 1000);
            }
        }
    }
});

// PWA Service Worker Registration + Periodic Sync + Update Prompt
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
            // SW update detection
            reg.addEventListener('updatefound', () => {
                const newWorker = reg.installing;
                if (!newWorker) return;
                newWorker.addEventListener('statechange', () => {
                    if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                        // New version available
                        const banner = document.createElement('div');
                        banner.className = 'sw-update-banner';
                        banner.innerHTML = '<span>Доступна нова версія</span><button id="swUpdateBtn">Оновити</button>';
                        document.body.appendChild(banner);
                        document.getElementById('swUpdateBtn').addEventListener('click', () => {
                            newWorker.postMessage({ type: 'SKIP_WAITING' });
                            banner.remove();
                        });
                    }
                });
            });
        }).catch((e) => console.warn('SW registration failed:', e));
    });
    // Reload page when new SW takes control
    navigator.serviceWorker.addEventListener('controllerchange', () => {
        window.location.reload();
    });
}

// Keyboard shortcuts: ← → for week navigation on schedule screen
document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
    const scheduleEl = document.getElementById('schedule');
    if (!scheduleEl || scheduleEl.classList.contains('hidden')) return;
    if (e.key === 'ArrowLeft') {
        document.querySelector('.week-nav-btn[data-dir="-1"]')?.click();
    } else if (e.key === 'ArrowRight') {
        document.querySelector('.week-nav-btn[data-dir="1"]')?.click();
    }
});
