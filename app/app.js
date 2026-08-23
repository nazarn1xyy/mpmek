document.addEventListener('DOMContentLoaded', async () => {
    // ===== Migration: clear stale push subscription key (one-time) =====
    if (!localStorage.getItem('_migrated_push_v1')) {
        localStorage.removeItem('lastPushSub');
        localStorage.setItem('_migrated_push_v1', '1');
    }

    // ===== State =====
    let scheduleData = null;
    let selectedGroup = localStorage.getItem('selectedGroup');
    let currentWeekType = null; // determined dynamically from schedule data
    let _hwCache = null; // cached homework object
    let notificationsEnabled = localStorage.getItem('notifications') !== 'false';
    let weekOffset = 0; // 0 = current week, 1 = next week, -1 = previous week
    const VAPID_PUBLIC_KEY = 'BMOzNTERkpWZfX4i5P5E1wcd1zXOUlv-fbT1fw-cjWjZPG3xBeattWCIFUfWfHCN-7EGzqGWLnwEGgCEFW8tPpc';

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

    function getWeekType(date) {
        const d = new Date(date || new Date());
        d.setHours(0, 0, 0, 0);
        d.setDate(d.getDate() + 3 - (d.getDay() + 6) % 7);
        const week1 = new Date(d.getFullYear(), 0, 4);
        const weekNum = 1 + Math.round(((d - week1) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);
        return weekNum % 2 === 0 ? 'ЗНАМЕННИК' : 'ЧИСЕЛЬНИК';
    }

    // ===== XSS protection =====
    const _escDiv = document.createElement('div');
    function escHtml(str) {
        _escDiv.textContent = str;
        return _escDiv.innerHTML;
    }

    // Homework storage with in-memory cache
    function parseHw(val) {
        if (!val) return null;
        if (typeof val === 'string') {
            return { text: val, done: false, deadline: '' };
        }
        return {
            text: val.text || '',
            done: !!val.done,
            deadline: val.deadline || ''
        };
    }

    function isDeadlineUrgent(deadlineStr) {
        if (!deadlineStr) return false;
        const d = new Date(deadlineStr);
        const now = new Date();
        now.setHours(0, 0, 0, 0);
        const diffDays = Math.ceil((d - now) / 86400000);
        return diffDays <= 1;
    }

    function formatDeadline(deadlineStr) {
        if (!deadlineStr) return '';
        const parts = deadlineStr.split('-');
        if (parts.length < 3) return deadlineStr;
        return `${parts[2]}.${parts[1]}`;
    }

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
    async function syncHomeworkToServer(group, day, number, val) {
        try {
            const hwObj = parseHw(val);
            await fetch('/api/homework', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ group, day, number, text: hwObj ? hwObj.text : '' })
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
            // Server wins for existing server keys
            for (const [key, value] of Object.entries(serverHw)) {
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
            if (changed) setHomework(merged);
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
    const installClose = document.getElementById('installClose');
    const hwModal = document.getElementById('hwModal');
    const hwModalTitle = document.getElementById('hwModalTitle');
    const hwModalSubject = document.getElementById('hwModalSubject');
    const hwModalInput = document.getElementById('hwModalInput');
    const hwModalDeadline = document.getElementById('hwModalDeadline');
    const hwModalCancel = document.getElementById('hwModalCancel');
    const hwModalSave = document.getElementById('hwModalSave');

    const offlineBanner = document.getElementById('offlineBanner');
    const searchBtn = document.getElementById('searchBtn');
    const searchModal = document.getElementById('searchModal');
    const searchModalClose = document.getElementById('searchModalClose');
    const globalSearchInput = document.getElementById('globalSearchInput');
    const searchResults = document.getElementById('searchResults');
    const openBellsBtn = document.getElementById('openBellsBtn');
    const bellsModal = document.getElementById('bellsModal');
    const bellsModalClose = document.getElementById('bellsModalClose');
    const bellsList = document.getElementById('bellsList');

    const profileNavBtn = document.getElementById('profileNavBtn');
    const profileCard = document.getElementById('profileCard');
    const authModal = document.getElementById('authModal');
    const authModalClose = document.getElementById('authModalClose');
    const authTabLogin = document.getElementById('authTabLogin');
    const authTabRegister = document.getElementById('authTabRegister');
    const loginForm = document.getElementById('loginForm');
    const registerForm = document.getElementById('registerForm');
    const loginUsername = document.getElementById('loginUsername');
    const loginPassword = document.getElementById('loginPassword');
    const loginError = document.getElementById('loginError');
    const registerName = document.getElementById('registerName');
    const registerUsername = document.getElementById('registerUsername');
    const registerPassword = document.getElementById('registerPassword');
    const registerGroupSelect = document.getElementById('registerGroupSelect');
    const registerError = document.getElementById('registerError');

    let currentUser = null;
    try {
        currentUser = JSON.parse(localStorage.getItem('currentUser') || 'null');
    } catch { currentUser = null; }
    let authToken = localStorage.getItem('authToken') || null;

    let modalCurrentKey = null;

    // ===== Offline Status Management =====
    function updateOnlineStatus() {
        if (!offlineBanner) return;
        if (!navigator.onLine) {
            offlineBanner.classList.remove('hidden');
        } else {
            offlineBanner.classList.add('hidden');
        }
    }
    window.addEventListener('online', () => {
        updateOnlineStatus();
        refreshSchedule(true);
    });
    window.addEventListener('offline', updateOnlineStatus);
    updateOnlineStatus();

    // ===== Theme Management =====
    function updateThemeSubtitle(dark) {
        const sub = document.getElementById('themeSubtitle');
        if (sub) {
            sub.textContent = dark ? 'Темна тема увімкнена' : 'Світла тема увімкнена';
        }
    }

    function applyTheme(dark) {
        if (dark) {
            document.documentElement.setAttribute('data-theme', 'dark');
            document.body.setAttribute('data-theme', 'dark');
            document.documentElement.style.backgroundColor = '#000000';
            document.body.style.backgroundColor = '#000000';
        } else {
            document.documentElement.removeAttribute('data-theme');
            document.body.removeAttribute('data-theme');
            document.documentElement.style.backgroundColor = '#ffffff';
            document.body.style.backgroundColor = '#ffffff';
        }
        const meta = document.getElementById('metaThemeColor');
        if (meta) meta.setAttribute('content', dark ? '#000000' : '#ffffff');
        if (themeToggle) themeToggle.checked = dark;
        updateThemeSubtitle(dark);
    }

    const savedTheme = localStorage.getItem('theme');
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const initialDark = savedTheme === 'dark' || (!savedTheme && prefersDark);
    applyTheme(initialDark);

    if (themeToggle) {
        themeToggle.addEventListener('change', (e) => {
            const dark = e.target.checked;
            document.documentElement.classList.add('theme-transitioning');
            document.body.classList.add('theme-transitioning');
            applyTheme(dark);
            localStorage.setItem('theme', dark ? 'dark' : 'light');
            setTimeout(() => {
                document.documentElement.classList.remove('theme-transitioning');
                document.body.classList.remove('theme-transitioning');
            }, 350);
        });
    }

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
                return;
            }
            if (Notification.permission === 'denied') {
                alert('Сповіщення заблоковані в налаштуваннях браузера. Розблокуйте їх вручну.');
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
        } else if (screenId === 'settings') {
            renderProfileUI();
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

        weekTypeToggle.textContent = currentWeekType.split(' ')[0];
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
        // If data already loaded and less than 5 min old, just re-render
        if (scheduleData && (now - _lastFetchTime < REFRESH_INTERVAL)) {
            if (selectedGroup && screens.schedule && !screens.schedule.classList.contains('hidden')) {
                renderSchedule();
            }
            return;
        }
        try {
            const resp = await fetch('schedule.json');
            const data = await resp.json();
            if (data._settings) {
                if (data._settings.lessonTimes) LESSON_TIMES = data._settings.lessonTimes;
                delete data._settings;
            }
            scheduleData = data;
            _lastFetchTime = Date.now();
            if (selectedGroup && screens.schedule && !screens.schedule.classList.contains('hidden')) {
                renderSchedule();
            }
        } catch (e) {
            // If network failed but we have cached data, just re-render
            if (scheduleData && silent) {
                if (selectedGroup && screens.schedule && !screens.schedule.classList.contains('hidden')) {
                    renderSchedule();
                }
                return;
            }
            if (!silent) throw e;
        }
    }

    // Refresh data when user returns to the app / tab
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && selectedGroup) refreshSchedule(true);
    });

    // ===== Groups =====
    function renderGroupList(filter = '') {
        if (!groupListContainer || !scheduleData) return;
        const frag = document.createDocumentFragment();
        const lowerFilter = filter.toLowerCase();
        const groups = Object.keys(scheduleData).filter(k => k !== '_settings');
        let count = 0;

        for (let i = 0; i < groups.length; i++) {
            const group = groups[i];
            if (lowerFilter && !group.toLowerCase().includes(lowerFilter)) continue;

            const el = document.createElement('div');
            el.className = 'group-item';
            el.textContent = group;
            el.dataset.group = group;
            frag.appendChild(el);
            count++;
        }

        if (count === 0) {
            groupListContainer.innerHTML = '<div class="empty-state" style="padding:2rem 1rem;margin-top:0"><p class="empty-state-title" style="font-size:1.1rem">Групу не знайдено</p><p class="empty-state-desc">Перевірте правильність написання назви групи</p></div>';
            return;
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
        showScreen('schedule');
    });

    // Debounced search
    let searchTimer = null;
    groupSearch.addEventListener('input', (e) => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => renderGroupList(e.target.value), 120);
    });

    // ===== Homework Modal =====
    // ===== Homework Modal Management =====
    function openHomeworkModal(key, subject, dayLabel, existingVal) {
        modalCurrentKey = key;
        const hwObj = parseHw(existingVal);
        hwModalSubject.textContent = `${subject} — ${dayLabel}`;
        hwModalInput.value = hwObj ? hwObj.text : '';
        if (hwModalDeadline) hwModalDeadline.value = hwObj ? hwObj.deadline : '';
        hwModalTitle.textContent = hwObj && hwObj.text ? 'Редагувати завдання' : 'Додати завдання';
        hwModal.classList.remove('hidden');
        
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
        if (hwModalDeadline) hwModalDeadline.value = '';
    }

    hwModalCancel.addEventListener('click', closeHomeworkModal);
    hwModal.addEventListener('click', (e) => {
        if (e.target === hwModal) closeHomeworkModal();
    });
    
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            if (hwModal && !hwModal.classList.contains('hidden')) closeHomeworkModal();
            if (bellsModal && !bellsModal.classList.contains('hidden')) closeBellsModal();
            if (searchModal && !searchModal.classList.contains('hidden')) closeSearchModal();
        }
    });

    hwModalSave.addEventListener('click', () => {
        const text = hwModalInput.value.trim();
        const deadline = hwModalDeadline ? hwModalDeadline.value : '';
        if (!modalCurrentKey) return;

        const hw = getHomework();
        if (text) {
            const prev = parseHw(hw[modalCurrentKey]);
            hw[modalCurrentKey] = {
                text,
                done: prev ? prev.done : false,
                deadline: deadline || ''
            };
        } else {
            delete hw[modalCurrentKey];
        }
        setHomework(hw);
        const parts = modalCurrentKey.split('|');
        if (parts.length === 3) syncHomeworkToServer(parts[0], parts[1], parts[2], text).catch(() => {});
        syncUserDataToCloud();
        closeHomeworkModal();
        renderSchedule();
        if (screens.homework && !screens.homework.classList.contains('hidden')) {
            renderHomeworkTab();
        }
    });

    // ===== Toast Notifications =====
    function showToast(msg) {
        let toast = document.getElementById('appToast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'appToast';
            toast.className = 'app-toast';
            document.body.appendChild(toast);
        }
        toast.textContent = msg;
        toast.className = 'app-toast is-visible';
        setTimeout(() => {
            toast.classList.remove('is-visible');
        }, 3200);
    }

    // ===== User Profile & Cloud Sync =====
    function renderProfileUI() {
        if (profileNavBtn) {
            if (currentUser) {
                const name = currentUser.name || currentUser.username || 'Студент';
                const initials = name.slice(0, 2).toUpperCase();
                profileNavBtn.innerHTML = `<span style="font-weight:800;font-size:0.85rem">${escHtml(initials)}</span>`;
                profileNavBtn.title = `@${currentUser.username}`;
            } else {
                profileNavBtn.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;
                profileNavBtn.title = 'Увійти в акаунт';
            }
        }

        if (profileCard) {
            if (currentUser) {
                const name = currentUser.name || currentUser.username;
                const initials = name.slice(0, 2).toUpperCase();
                profileCard.innerHTML = `
                    <div class="profile-card-header">
                        <div class="profile-avatar">${escHtml(initials)}</div>
                        <div class="profile-info">
                            <div class="profile-name">${escHtml(name)}</div>
                            <div class="profile-meta">
                                <span>@${escHtml(currentUser.username)}</span>
                                ${currentUser.group ? `<span class="profile-group-pill">${escHtml(currentUser.group)}</span>` : ''}
                                <span class="profile-sync-status">🟢 Синхронізовано</span>
                            </div>
                        </div>
                        <button class="btn-profile-logout" id="profileLogoutBtn">Вийти</button>
                    </div>`;
            } else {
                profileCard.innerHTML = `
                    <div class="profile-card-header">
                        <div class="profile-avatar guest-avatar">👤</div>
                        <div class="profile-info">
                            <div class="profile-name">Гість</div>
                            <div class="profile-meta">Створіть акаунт для збереження на всіх пристроях</div>
                        </div>
                    </div>
                    <div class="profile-actions">
                        <button class="btn-profile-auth" id="profileLoginCtaBtn">Увійти або зареєструватися</button>
                    </div>`;
            }
        }

        const groupSub = document.getElementById('settingsCurrentGroupSub');
        if (groupSub && selectedGroup) {
            groupSub.textContent = `Поточна група: ${selectedGroup}`;
        }
    }

    let _syncTimer = null;
    function syncUserDataToCloud() {
        if (!currentUser || !authToken) return;
        clearTimeout(_syncTimer);
        _syncTimer = setTimeout(async () => {
            try {
                await fetch('/api/auth?action=sync', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${authToken}`
                    },
                    body: JSON.stringify({
                        username: currentUser.username,
                        group: selectedGroup,
                        homework: getHomework(),
                        settings: {
                            theme: localStorage.getItem('theme'),
                            notifTime: localStorage.getItem('notifTime')
                        }
                    })
                });
            } catch (e) {
                console.warn('Cloud sync error:', e);
            }
        }, 1000);
    }

    function populateRegisterGroups() {
        if (!registerGroupSelect || !scheduleData) return;
        const groups = Object.keys(scheduleData).filter(k => k !== '_settings').sort();
        registerGroupSelect.innerHTML = groups.map(g => `<option value="${escHtml(g)}" ${g === selectedGroup ? 'selected' : ''}>${escHtml(g)}</option>`).join('');
    }

    function openAuthModal(mode = 'login') {
        if (!authModal) return;
        populateRegisterGroups();
        setAuthTab(mode);
        if (loginError) loginError.classList.add('hidden');
        if (registerError) registerError.classList.add('hidden');
        authModal.classList.remove('hidden');
    }

    function closeAuthModal() {
        if (authModal) authModal.classList.add('hidden');
    }

    function setAuthTab(tab) {
        if (tab === 'login') {
            authTabLogin.classList.add('active');
            authTabRegister.classList.remove('active');
            loginForm.classList.remove('hidden');
            registerForm.classList.add('hidden');
            setTimeout(() => loginUsername && loginUsername.focus(), 50);
        } else {
            authTabRegister.classList.add('active');
            authTabLogin.classList.remove('active');
            registerForm.classList.remove('hidden');
            loginForm.classList.add('hidden');
            setTimeout(() => registerName && registerName.focus(), 50);
        }
    }

    if (authModalClose) authModalClose.addEventListener('click', closeAuthModal);
    if (authModal) {
        authModal.addEventListener('click', (e) => {
            if (e.target === authModal) closeAuthModal();
        });
    }
    if (authTabLogin) authTabLogin.addEventListener('click', () => setAuthTab('login'));
    if (authTabRegister) authTabRegister.addEventListener('click', () => setAuthTab('register'));

    // Handle Login Form Submit
    if (loginForm) {
        loginForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const username = loginUsername.value.trim();
            const password = loginPassword.value;
            if (!username || !password) return;

            loginError.classList.add('hidden');
            const submitBtn = document.getElementById('loginSubmitBtn');
            const origText = submitBtn.textContent;
            submitBtn.disabled = true;
            submitBtn.textContent = 'Вхід...';

            try {
                const resp = await fetch('/api/auth?action=login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, password })
                });
                const data = await resp.json();
                if (!resp.ok || !data.ok) {
                    throw new Error(data.error || 'Невірний логін або пароль');
                }

                currentUser = data.user;
                authToken = data.token;
                localStorage.setItem('currentUser', JSON.stringify(currentUser));
                localStorage.setItem('authToken', authToken);

                // Merge homework
                if (data.homework && typeof data.homework === 'object') {
                    const localHw = getHomework();
                    const merged = { ...localHw, ...data.homework };
                    setHomework(merged);
                }

                // Switch group if user has a preferred group
                if (data.user.group && data.user.group !== selectedGroup) {
                    selectedGroup = data.user.group;
                    localStorage.setItem('selectedGroup', selectedGroup);
                }

                closeAuthModal();
                renderProfileUI();
                renderSchedule();
                showToast(`Вітаємо, ${currentUser.name || currentUser.username}! Дані синхронізовано ✨`);
            } catch (err) {
                loginError.textContent = err.message;
                loginError.classList.remove('hidden');
            } finally {
                submitBtn.disabled = false;
                submitBtn.textContent = origText;
            }
        });
    }

    // Handle Register Form Submit
    if (registerForm) {
        registerForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const name = registerName.value.trim();
            const username = registerUsername.value.trim();
            const password = registerPassword.value;
            const group = registerGroupSelect ? registerGroupSelect.value : selectedGroup;

            if (!username || !password) return;

            registerError.classList.add('hidden');
            const submitBtn = document.getElementById('registerSubmitBtn');
            const origText = submitBtn.textContent;
            submitBtn.disabled = true;
            submitBtn.textContent = 'Створення...';

            try {
                const resp = await fetch('/api/auth?action=register', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        name,
                        username,
                        password,
                        group,
                        initialData: {
                            homework: getHomework(),
                            settings: { theme: localStorage.getItem('theme'), notifTime: localStorage.getItem('notifTime') }
                        }
                    })
                });
                const data = await resp.json();
                if (!resp.ok || !data.ok) {
                    throw new Error(data.error || 'Помилка реєстрації');
                }

                currentUser = data.user;
                authToken = data.token;
                localStorage.setItem('currentUser', JSON.stringify(currentUser));
                localStorage.setItem('authToken', authToken);

                if (group) {
                    selectedGroup = group;
                    localStorage.setItem('selectedGroup', selectedGroup);
                }

                closeAuthModal();
                renderProfileUI();
                renderSchedule();
                showToast(`Акаунт створено! Ласкаво просимо, ${currentUser.name}! 🎉`);
            } catch (err) {
                registerError.textContent = err.message;
                registerError.classList.remove('hidden');
            } finally {
                submitBtn.disabled = false;
                submitBtn.textContent = origText;
            }
        });
    }

    function handleLogout() {
        if (confirm('Ви дійсно бажаєте вийти з акаунта?')) {
            currentUser = null;
            authToken = null;
            localStorage.removeItem('currentUser');
            localStorage.removeItem('authToken');
            renderProfileUI();
            showToast('Ви вийшли з акаунта');
        }
    }

    renderProfileUI();

    // ===== Bells Schedule Modal =====
    const BELLS_SCHEDULE = [
        { num: 1, start: '08:30', end: '09:50', breakText: 'Перерва 10 хв' },
        { num: 2, start: '10:00', end: '11:20', breakText: 'Велика перерва 30 хв ☕' },
        { num: 3, start: '11:50', end: '13:10', breakText: 'Перерва 10 хв' },
        { num: 4, start: '13:20', end: '14:40', breakText: 'Перерва 10 хв' },
        { num: 5, start: '14:50', end: '16:10', breakText: 'Перерва 10 хв' },
        { num: 6, start: '16:20', end: '17:40', breakText: null }
    ];

    function openBellsModal() {
        if (!bellsModal || !bellsList) return;
        const now = new Date();
        const nowMin = now.getHours() * 60 + now.getMinutes();

        let html = '';
        for (let i = 0; i < BELLS_SCHEDULE.length; i++) {
            const b = BELLS_SCHEDULE[i];
            const [sh, sm] = b.start.split(':').map(Number);
            const [eh, em] = b.end.split(':').map(Number);
            const startMin = sh * 60 + sm;
            const endMin = eh * 60 + em;

            const isLessonNow = nowMin >= startMin && nowMin < endMin;
            const badgeNow = isLessonNow ? `<span class="bell-badge-now">Зараз • ще ${endMin - nowMin} хв</span>` : '';

            html += `<div class="bell-item ${isLessonNow ? 'is-current' : ''}">
                <div class="bell-item-left">
                    <span class="bell-item-num">${b.num}</span>
                    <span class="bell-item-time">${b.start} – ${b.end}</span>
                </div>
                ${badgeNow}
            </div>`;

            if (b.breakText && i < BELLS_SCHEDULE.length - 1) {
                const nextB = BELLS_SCHEDULE[i + 1];
                const [nsh, nsm] = nextB.start.split(':').map(Number);
                const nextStartMin = nsh * 60 + nsm;
                const isBreakNow = nowMin >= endMin && nowMin < nextStartMin;

                html += `<div class="bell-break ${isBreakNow ? 'is-break-now' : ''}">
                    <span>${isBreakNow ? '☕ ' : ''}${b.breakText}${isBreakNow ? ` (ще ${nextStartMin - nowMin} хв)` : ''}</span>
                </div>`;
            }
        }

        bellsList.innerHTML = html;
        bellsModal.classList.remove('hidden');
    }

    function closeBellsModal() {
        if (bellsModal) bellsModal.classList.add('hidden');
    }

    if (openBellsBtn) openBellsBtn.addEventListener('click', openBellsModal);
    if (bellsModalClose) bellsModalClose.addEventListener('click', closeBellsModal);
    if (bellsModal) {
        bellsModal.addEventListener('click', (e) => {
            if (e.target === bellsModal) closeBellsModal();
        });
    }

    // ===== Search Teachers & Rooms Modal =====
    function openSearchModal() {
        if (!searchModal) return;
        searchModal.classList.remove('hidden');
        if (globalSearchInput) {
            globalSearchInput.value = '';
            setTimeout(() => globalSearchInput.focus(), 50);
        }
        renderSearchResults('');
    }

    function closeSearchModal() {
        if (searchModal) searchModal.classList.add('hidden');
    }

    let searchCurrentDayFilter = 'all';
    let lastSearchQuery = '';

    const UK_DAYS_ORDER = ['Понеділок', 'Вівторок', 'Середа', 'Четвер', "П'ятниця", 'Субота'];
    const UK_DAYS_SHORT = {
        'Понеділок': 'Пн',
        'Вівторок': 'Вт',
        'Середа': 'Ср',
        'Четвер': 'Чт',
        "П'ятниця": 'Пт',
        'Субота': 'Сб'
    };

    function renderSearchResults(query) {
        if (!searchResults) return;
        if (query !== undefined) lastSearchQuery = query;
        const q = (lastSearchQuery || '').trim().toLowerCase();

        if (!q || q.length < 2) {
            searchResults.innerHTML = `<div class="empty-search-prompt">
                <div class="search-prompt-icon">🔍</div>
                <p>Введіть викладача, номер аудиторії або предмет</p>
                <div class="search-suggestions">
                    <span class="search-suggestion-chip" data-search="Сабірова">Сабірова</span>
                    <span class="search-suggestion-chip" data-search="69">ауд. 69</span>
                    <span class="search-suggestion-chip" data-search="Компанієць">Компанієць</span>
                    <span class="search-suggestion-chip" data-search="Волков">Волков</span>
                    <span class="search-suggestion-chip" data-search="Математика">Математика</span>
                </div>
            </div>`;
            return;
        }

        if (!scheduleData) {
            fetch('schedule.json').then(r => r.json()).then(d => {
                if (d._settings) {
                    if (d._settings.lessonTimes) LESSON_TIMES = d._settings.lessonTimes;
                    delete d._settings;
                }
                scheduleData = d;
                renderSearchResults();
            }).catch(() => {});
            return;
        }

        const results = [];
        const seen = new Set();
        const groups = Object.keys(scheduleData || {}).filter(k => k !== '_settings');

        const now = new Date();
        const todayName = ukDays[now.getDay()];
        const nowMin = now.getHours() * 60 + now.getMinutes();

        for (const grp of groups) {
            const groupData = scheduleData[grp];
            for (const wt of Object.keys(groupData)) {
                if (wt === 'ПІДВІСКА') {
                    const subs = groupData[wt];
                    if (Array.isArray(subs)) {
                        for (const s of subs) {
                            const matchTeacher = s.teacher && s.teacher.toLowerCase().includes(q);
                            const matchRoom = s.room && String(s.room).toLowerCase().includes(q);
                            const matchSubject = s.subject && s.subject.toLowerCase().includes(q);
                            if (matchTeacher || matchRoom || matchSubject) {
                                const key = `${grp}|${s.date}|${s.number}|${s.subject}|${s.teacher || ''}|${s.room || ''}`;
                                if (!seen.has(key)) {
                                    seen.add(key);
                                    results.push({
                                        group: grp,
                                        day: s.date,
                                        number: s.number,
                                        subject: s.subject,
                                        teacher: s.teacher || '',
                                        room: s.room || '',
                                        isSubstitution: true
                                    });
                                }
                            }
                        }
                    }
                    continue;
                }

                const weekTable = groupData[wt];
                if (typeof weekTable !== 'object' || Array.isArray(weekTable)) continue;

                for (const day of Object.keys(weekTable)) {
                    const pairs = weekTable[day];
                    if (!Array.isArray(pairs)) continue;
                    for (const p of pairs) {
                        const matchTeacher = p.teacher && p.teacher.toLowerCase().includes(q);
                        const matchRoom = p.room && String(p.room).toLowerCase().includes(q);
                        const matchSubject = p.subject && p.subject.toLowerCase().includes(q);

                        if (matchTeacher || matchRoom || matchSubject) {
                            const key = `${grp}|${day}|${p.number}|${p.subject}|${p.teacher || ''}|${p.room || ''}|${wt}`;
                            if (!seen.has(key)) {
                                seen.add(key);
                                let isHappeningNow = false;
                                if (day === todayName) {
                                    const t = LESSON_TIMES[p.number];
                                    if (t) {
                                        const [s, e] = t.split(' - ');
                                        const [sh, sm] = s.split(':').map(Number);
                                        const [eh, em] = e.split(':').map(Number);
                                        isHappeningNow = nowMin >= sh * 60 + sm && nowMin < eh * 60 + em;
                                    }
                                }

                                results.push({
                                    group: grp,
                                    day,
                                    number: p.number,
                                    subject: p.subject,
                                    teacher: p.teacher || '',
                                    room: p.room || '',
                                    isHappeningNow,
                                    weekType: wt
                                });
                            }
                        }
                    }
                }
            }
        }

        if (results.length === 0) {
            searchResults.innerHTML = `<div class="empty-search-prompt">
                <div class="search-prompt-icon">🔍</div>
                <p>Нічого не знайдено за запитом <strong>«${escHtml(q)}»</strong></p>
                <p class="search-prompt-hint">Спробуйте перевірити написання або ввести номер кабінету (напр. 69)</p>
            </div>`;
            return;
        }

        // Group by Day
        const grouped = {};
        for (const item of results) {
            const d = item.day || 'Інше';
            if (!grouped[d]) grouped[d] = [];
            grouped[d].push(item);
        }

        // Available days for filter
        const daysWithResults = UK_DAYS_ORDER.filter(d => grouped[d] && grouped[d].length > 0);
        Object.keys(grouped).forEach(d => {
            if (!UK_DAYS_ORDER.includes(d) && !daysWithResults.includes(d)) daysWithResults.push(d);
        });

        // Filter chips HTML
        let chipsHtml = `<div class="search-filter-chips">
            <button class="search-chip ${searchCurrentDayFilter === 'all' ? 'active' : ''}" data-day="all">Всі (${results.length})</button>`;
        for (const d of daysWithResults) {
            const short = UK_DAYS_SHORT[d] || d;
            chipsHtml += `<button class="search-chip ${searchCurrentDayFilter === d ? 'active' : ''}" data-day="${d}">${short} (${grouped[d].length})</button>`;
        }
        chipsHtml += `</div>`;

        // Render days
        let listHtml = '';
        const targetDays = searchCurrentDayFilter === 'all' ? daysWithResults : [searchCurrentDayFilter];

        for (const day of targetDays) {
            const items = grouped[day];
            if (!items || items.length === 0) continue;

            // Sort by lesson number
            items.sort((a, b) => a.number - b.number);

            const isToday = day === todayName;

            listHtml += `<div class="search-day-section">
                <div class="search-day-header">
                    <span class="search-day-title">${escHtml(day)} ${isToday ? '<span class="today-tag">СЬОГОДНІ</span>' : ''}</span>
                    <span class="search-day-count">${items.length} ${items.length === 1 ? 'пара' : (items.length < 5 ? 'пари' : 'пар')}</span>
                </div>
                <div class="search-cards-grid">`;

            for (const item of items) {
                const liveBadge = item.isHappeningNow ? '<span class="search-live-badge"><span class="live-dot"></span>ЗАРАЗ</span>' : '';
                const timeStr = LESSON_TIMES[item.number] || '';
                const weekBadge = item.weekType && item.weekType !== 'ОСНОВНИЙ РОЗКЛАД' && !item.isSubstitution
                    ? `<span class="search-week-pill">${escHtml(item.weekType.toLowerCase())}</span>`
                    : '';
                const subBadge = item.isSubstitution ? '<span class="search-sub-pill">ЗАМІНА</span>' : '';

                listHtml += `<div class="search-card ${item.isHappeningNow ? 'is-live-card' : ''}">
                    <div class="search-card-left">
                        <div class="search-card-pair-badge">${item.number} пара</div>
                        <div class="search-card-time">${timeStr}</div>
                    </div>
                    <div class="search-card-main">
                        <div class="search-card-subject">${escHtml(item.subject)}</div>
                        <div class="search-card-tags">
                            <span class="search-tag-group">${escHtml(item.group)}</span>
                            ${weekBadge}
                            ${subBadge}
                            ${liveBadge}
                        </div>
                        <div class="search-card-meta">
                            ${item.teacher ? `<span class="search-meta-teacher"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg> ${escHtml(item.teacher)}</span>` : ''}
                            ${item.room ? `<span class="search-meta-room"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/><circle cx="15" cy="12" r="1"/></svg> ауд. ${escHtml(item.room)}</span>` : ''}
                        </div>
                    </div>
                </div>`;
            }

            listHtml += `</div></div>`;
        }

        searchResults.innerHTML = `${chipsHtml}${listHtml}`;
    }

    if (searchBtn) searchBtn.addEventListener('click', openSearchModal);
    if (searchModalClose) searchModalClose.addEventListener('click', closeSearchModal);
    if (searchModal) {
        searchModal.addEventListener('click', (e) => {
            if (e.target === searchModal) closeSearchModal();
        });
    }
    if (globalSearchInput) {
        globalSearchInput.addEventListener('input', (e) => {
            renderSearchResults(e.target.value);
        });
    }

    // ===== SVG icon templates (avoid re-creating the same strings) =====
    const SVG_PLUS = '<svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
    const SVG_EDIT = '<svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
    const SVG_X = '<svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    const SVG_EDIT_SM = '<svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
    const SVG_TRASH = '<svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';

    // ===== Build lesson card (optimized: single innerHTML, cached hw) =====
    function buildLessonCard(pair, dayLabel, hw, lessonStatus) {
        const key = hwKey(selectedGroup, dayLabel, pair.number);
        const hwItem = parseHw(hw[key]);

        let savedHtml = '';
        if (hwItem && hwItem.text) {
            const deadlineBadge = hwItem.deadline
                ? `<div class="hw-deadline-badge ${isDeadlineUrgent(hwItem.deadline) ? 'is-urgent' : ''}">📅 до ${formatDeadline(hwItem.deadline)}</div>`
                : '';
            savedHtml = `<div class="hw-saved ${hwItem.done ? 'hw-done' : ''}">
                <input type="checkbox" class="hw-checkbox" data-hw-key="${key}" aria-label="Позначити виконаним" ${hwItem.done ? 'checked' : ''}>
                <div class="hw-text-content" style="flex:1;min-width:0">
                    <span>${escHtml(hwItem.text)}</span>
                    ${deadlineBadge}
                </div>
                <button class="hw-delete-btn" data-key="${key}" aria-label="Видалити завдання">${SVG_X}</button>
            </div>`;
        }

        const btnLabel = hwItem && hwItem.text ? 'Редагувати' : 'Додати завдання';
        const btnIcon = hwItem && hwItem.text ? SVG_EDIT : SVG_PLUS;
        const roomHtml = pair.room ? `<span class="diary-item-room">ауд. ${pair.room}</span>` : '';
        const teacherHtml = (pair.teacher || pair.room) ? `<div class="diary-item-teacher">${pair.teacher || ''}${pair.teacher && pair.room ? ' · ' : ''}${roomHtml}</div>` : '';
        const timeHtml = LESSON_TIMES[pair.number] ? `<span class="diary-item-time" data-open-bells="true" style="cursor:pointer" title="Натисніть, щоб відкрити розклад дзвінків">${LESSON_TIMES[pair.number]}</span>` : '';

        let statusBadge = '';
        if (lessonStatus === 'now') {
            const t = LESSON_TIMES[pair.number];
            if (t) {
                const endStr = t.split(' - ')[1];
                const [eh, em] = endStr.split(':').map(Number);
                const now = new Date();
                const remaining = (eh * 60 + em) - (now.getHours() * 60 + now.getMinutes());
                statusBadge = `<span class="badge-now">ЗАРАЗ • ще ${remaining} хв</span>`;
            }
        } else if (lessonStatus === 'next') {
            const t = LESSON_TIMES[pair.number];
            if (t) {
                const startStr = t.split(' - ')[0];
                const [sh, sm] = startStr.split(':').map(Number);
                const now = new Date();
                const until = (sh * 60 + sm) - (now.getHours() * 60 + now.getMinutes());
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
        let subjectHtml = `<div class="diary-item-subject">${escapedSubject}</div>`;
        if (pair.isSubstitution) {
            const badgeText = pair.substitutionType === 'підвіска' ? 'ПІДВІСКА' : 'ЗАМІНА';
            subjectHtml = `<div class="diary-item-subject"><span class="badge-substitution">${badgeText}</span> ${escapedSubject}</div>`;
        }

        div.innerHTML = `<div class="diary-item-header"><span class="diary-item-number">${pair.number} пара</span>${statusBadge}${timeHtml}</div>${subjectHtml}${teacherHtml}${savedHtml}<button class="homework-btn" data-key="${key}" data-subject="${escapedSubject}" data-day="${dayLabel}">${btnIcon} ${btnLabel}</button>`;
        return div;
    }

    // ===== Event delegation (single listener on document) =====
    document.addEventListener('click', (e) => {
        // Profile & Auth triggers
        const profileTrigger = e.target.closest('#profileNavBtn, .profile-nav-btn');
        if (profileTrigger) {
            e.preventDefault();
            if (currentUser) {
                navItems.forEach(n => n.classList.remove('active'));
                const settingsNav = document.querySelector('.nav-item[data-target="settings"]');
                if (settingsNav) settingsNav.classList.add('active');
                showScreen('settings');
            } else {
                openAuthModal('login');
            }
            return;
        }

        const profileLoginCta = e.target.closest('#profileLoginCtaBtn');
        if (profileLoginCta) {
            e.preventDefault();
            openAuthModal('login');
            return;
        }

        const profileLogout = e.target.closest('#profileLogoutBtn');
        if (profileLogout) {
            e.preventDefault();
            handleLogout();
            return;
        }

        // Toggle password visibility
        const togglePwdBtn = e.target.closest('.auth-toggle-pwd');
        if (togglePwdBtn && togglePwdBtn.dataset.target) {
            e.preventDefault();
            const targetInput = document.getElementById(togglePwdBtn.dataset.target);
            if (targetInput) {
                const isPwd = targetInput.type === 'password';
                targetInput.type = isPwd ? 'text' : 'password';
                togglePwdBtn.textContent = isPwd ? '🙈' : '👁️';
            }
            return;
        }

        // Search button trigger
        const searchTrigger = e.target.closest('#searchBtn, .search-nav-btn');
        if (searchTrigger) {
            e.preventDefault();
            openSearchModal();
            return;
        }

        const searchCloseTrigger = e.target.closest('#searchModalClose');
        if (searchCloseTrigger) {
            e.preventDefault();
            closeSearchModal();
            return;
        }

        // Search day filter chip
        const searchChip = e.target.closest('.search-chip');
        if (searchChip && searchChip.dataset.day) {
            e.preventDefault();
            searchCurrentDayFilter = searchChip.dataset.day;
            renderSearchResults();
            return;
        }

        // Search suggestion chip
        const searchSuggest = e.target.closest('.search-suggestion-chip');
        if (searchSuggest && searchSuggest.dataset.search) {
            e.preventDefault();
            if (globalSearchInput) {
                globalSearchInput.value = searchSuggest.dataset.search;
                searchCurrentDayFilter = 'all';
                renderSearchResults(searchSuggest.dataset.search);
            }
            return;
        }

        // Bells modal trigger (button, setting row, or diary pair time)
        const bellsTrigger = e.target.closest('#openBellsBtn, #bellsSettingRow, [data-open-bells="true"]');
        if (bellsTrigger) {
            e.preventDefault();
            openBellsModal();
            return;
        }

        const bellsCloseTrigger = e.target.closest('#bellsModalClose');
        if (bellsCloseTrigger) {
            e.preventDefault();
            closeBellsModal();
            return;
        }

        // Theme row click trigger
        const themeRowTrigger = e.target.closest('#themeSettingRow');
        if (themeRowTrigger && !e.target.closest('.switch') && !e.target.closest('input')) {
            e.preventDefault();
            const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
            const nextDark = !isDark;
            applyTheme(nextDark);
            localStorage.setItem('theme', nextDark ? 'dark' : 'light');
            return;
        }

        // Change group row trigger
        const changeGroupTrigger = e.target.closest('#changeGroupBtn, #changeGroupRow');
        if (changeGroupTrigger) {
            e.preventDefault();
            localStorage.removeItem('selectedGroup');
            selectedGroup = null;
            showScreen('onboarding');
            renderGroupList();
            return;
        }

        const hwBtn = e.target.closest('.homework-btn');
        if (hwBtn) {
            const { key, subject, day } = hwBtn.dataset;
            openHomeworkModal(key, subject, day, getHomework()[key] || null);
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
            openHomeworkModal(key, subject, day, getHomework()[key] || null);
            return;
        }

        // Week navigator (delegated to avoid listener leak on re-render)
        const weekNavBtn = e.target.closest('.week-nav-btn');
        if (weekNavBtn) {
            weekOffset += parseInt(weekNavBtn.dataset.dir);
            renderSchedule();
            window.scrollTo({ top: 0, behavior: 'smooth' });
            return;
        }

        const weekNavCenter = e.target.closest('.week-nav-center');
        if (weekNavCenter && weekOffset !== 0) {
            weekOffset = 0;
            renderSchedule();
            window.scrollTo({ top: 0, behavior: 'smooth' });
            return;
        }
    });

    // Handle Homework checkbox toggles (Done / Undone)
    document.addEventListener('change', (e) => {
        const chk = e.target.closest('.hw-checkbox');
        if (chk && chk.dataset.hwKey) {
            const key = chk.dataset.hwKey;
            const hw = getHomework();
            const prev = parseHw(hw[key]);
            if (prev) {
                hw[key] = {
                    ...prev,
                    done: chk.checked
                };
                setHomework(hw);
                const savedContainer = chk.closest('.hw-saved');
                if (savedContainer) {
                    savedContainer.classList.toggle('hw-done', chk.checked);
                }
                const cardContainer = chk.closest('.hw-card');
                if (cardContainer) {
                    cardContainer.classList.toggle('hw-done', chk.checked);
                }
            }
        }
    });

    // ===== Touch Swipe Gestures for Weeks =====
    let touchStartX = 0;
    let touchStartY = 0;
    let isTouching = false;

    diaryContainer.addEventListener('touchstart', (e) => {
        if (e.touches.length === 1) {
            touchStartX = e.touches[0].clientX;
            touchStartY = e.touches[0].clientY;
            isTouching = true;
        }
    }, { passive: true });

    diaryContainer.addEventListener('touchend', (e) => {
        if (!isTouching) return;
        isTouching = false;
        const dx = e.changedTouches[0].clientX - touchStartX;
        const dy = e.changedTouches[0].clientY - touchStartY;

        // Check horizontal swipe gesture (min 60px distance, > 1.5x horizontal dominance)
        if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
            if (dx < 0) {
                // Swipe left -> Next week
                weekOffset += 1;
                renderSchedule();
                window.scrollTo({ top: 0, behavior: 'smooth' });
            } else {
                // Swipe right -> Previous week
                weekOffset -= 1;
                renderSchedule();
                window.scrollTo({ top: 0, behavior: 'smooth' });
            }
        }
    }, { passive: true });

    // ===== Render Schedule (DocumentFragment for batch DOM insert) =====
    function renderSchedule() {
        if (!scheduleData[selectedGroup]) return;
        currentGroupTitle.textContent = selectedGroup;

        const today = new Date();
        const isSunday = today.getDay() === 0;
        const currentDayOfWeek = isSunday ? 0 : today.getDay(); // 0 for Sun (points to upcoming Mon), 1-6 for Mon-Sat
        const targetMon = new Date(today);
        targetMon.setDate(today.getDate() + (1 - currentDayOfWeek + (weekOffset * 7)));
        const targetParity = getWeekType(targetMon);

        // Determine week type: prefer current choice if valid, else calculate parity
        const availableTypes = Object.keys(scheduleData[selectedGroup]).filter(t => t !== 'ПІДВІСКА');
        if (!currentWeekType || !availableTypes.includes(currentWeekType)) {
            if (availableTypes.includes(targetParity)) {
                currentWeekType = targetParity;
            } else if (availableTypes.includes('ОСНОВНИЙ РОЗКЛАД')) {
                currentWeekType = 'ОСНОВНИЙ РОЗКЛАД';
            } else {
                currentWeekType = availableTypes[0] || 'ОСНОВНИЙ РОЗКЛАД';
            }
        }
        if (!currentWeekType) currentWeekType = 'ОСНОВНИЙ РОЗКЛАД';
        weekTypeToggle.textContent = currentWeekType.split(' ')[0] || 'РОЗКЛАД';

        let weekData = scheduleData[selectedGroup][currentWeekType];

        if (!weekData || (Array.isArray(weekData) && weekData.length === 0)) {
            diaryContainer.innerHTML = `<div class="empty-state-container">${SVG_EMPTY_SCHEDULE}<p class="empty-state-title">Розклад відсутній</p><p class="empty-state-desc">Для вибраного тижня немає пар.</p></div>`;
            return;
        }

        const hw = getHomework(); // read once per render
        const frag = document.createDocumentFragment();
        
        const todayLabel = ukDays[today.getDay()];

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
                const now = new Date();
                const nowMin = now.getHours() * 60 + now.getMinutes();
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

        // Week navigator — placed BEFORE days for easy access
        const weekNav = document.createElement('div');
        weekNav.className = 'week-nav';

        const mondayDate = weekDates['Понеділок'];
        const fridayDate = weekDates["П'ятниця"];
        const weekLabel = weekOffset === 0 ? (isSunday ? 'Наступний тиждень' : 'Поточний тиждень') : weekOffset === 1 ? 'Наступний тиждень' : weekOffset === -1 ? 'Минулий тиждень' : `${mondayDate} — ${fridayDate}`;

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

        // Insert week nav FIRST, then days
        const finalFrag = document.createDocumentFragment();
        finalFrag.appendChild(weekNav);
        // Move all day elements from frag into finalFrag
        while (frag.firstChild) finalFrag.appendChild(frag.firstChild);

        diaryContainer.innerHTML = '';
        diaryContainer.appendChild(finalFrag);

        if (weekOffset === 0 && currentWeekType !== 'ПІДВІСКА') {
            requestAnimationFrame(() => {
                const todayMarker = document.getElementById('today-marker');
                if (todayMarker) {
                    setTimeout(() => {
                        todayMarker.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    }, 50);
                }
            });
        }
    }

    // ===== Render Homework Tab =====
    function renderHomeworkTab() {
        const hw = getHomework();
        const prefix = selectedGroup + '|';
        const entries = [];

        for (const key in hw) {
            if (key.startsWith(prefix)) {
                const parts = key.split('|');
                const hwItem = parseHw(hw[key]);
                if (hwItem && hwItem.text) {
                    entries.push({
                        key,
                        day: parts[1],
                        number: parseInt(parts[2]),
                        text: hwItem.text,
                        done: !!hwItem.done,
                        deadline: hwItem.deadline || ''
                    });
                }
            }
        }

        if (entries.length === 0) {
            homeworkContainer.innerHTML = `<div class="empty-state-container">${SVG_EMPTY_HOMEWORK}<p class="empty-state-title">Немає завдань</p><p class="empty-state-desc">Ура! Ви ще не додали жодного домашнього завдання.</p></div>`;
            return;
        }

        // Sort: undone first, then by deadline ascending, then by day/number
        entries.sort((a, b) => {
            if (a.done !== b.done) return a.done ? 1 : -1;
            if (a.deadline && b.deadline) return a.deadline.localeCompare(b.deadline);
            if (a.deadline && !b.deadline) return -1;
            if (!a.deadline && b.deadline) return 1;
            return a.number - b.number;
        });

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
            dayTitle.style.cssText = 'font-size:1.1rem;font-weight:700;margin-bottom:0.75rem;margin-top:1.25rem;';
            dayTitle.textContent = day;
            frag.appendChild(dayTitle);

            for (let i = 0; i < grouped[day].length; i++) {
                const entry = grouped[day][i];
                let subjectName = `Пара ${entry.number}`;

                // Lookup subject from schedule data
                if (scheduleData && scheduleData[selectedGroup]) {
                    const weekTypes = Object.keys(scheduleData[selectedGroup]);
                    for (let w = 0; w < weekTypes.length; w++) {
                        const wd = scheduleData[selectedGroup][weekTypes[w]];
                        if (Array.isArray(wd)) {
                            const found = wd.find(p => p.number === entry.number && p.date === day);
                            if (found) { subjectName = found.subject; break; }
                        } else if (wd[day]) {
                            const found = wd[day].find(p => p.number === entry.number);
                            if (found) { subjectName = found.subject; break; }
                        }
                    }
                }

                const deadlineBadge = entry.deadline
                    ? `<div class="hw-deadline-badge ${isDeadlineUrgent(entry.deadline) ? 'is-urgent' : ''}">📅 до ${formatDeadline(entry.deadline)}</div>`
                    : '';

                const card = document.createElement('div');
                card.className = `hw-card ${entry.done ? 'hw-done' : ''}`;
                card.innerHTML = `<div style="display:flex;align-items:flex-start;gap:10px">
                    <input type="checkbox" class="hw-checkbox" data-hw-key="${entry.key}" aria-label="Позначити виконаним" ${entry.done ? 'checked' : ''} style="margin-top:2px">
                    <div style="flex:1;min-width:0">
                        <div class="hw-card-subject">${escHtml(subjectName)}</div>
                        <div class="hw-card-meta">${entry.number} пара · ${escHtml(day)}</div>
                        ${deadlineBadge}
                        <div class="hw-card-text">${escHtml(entry.text)}</div>
                    </div>
                </div>
                <div class="hw-card-actions" style="margin-left:32px">
                    <button class="hw-card-edit" data-key="${entry.key}" data-subject="${escHtml(subjectName)}" data-day="${escHtml(day)}">${SVG_EDIT_SM} Редагувати</button>
                    <button class="hw-card-delete hw-delete" data-key="${entry.key}">${SVG_TRASH} Видалити</button>
                </div>`;
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
            if (!resp.ok) { alert('Немає розкладу'); return; }
            const blob = await resp.blob();
            const file = new File([blob], filename, { type: 'image/png' });
            if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
                try { await navigator.share({ files: [file], title, text }); } catch {}
            } else {
                const u = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = u; a.download = filename; a.click();
                URL.revokeObjectURL(u);
            }
        } catch { alert('Помилка генерації зображення'); }
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
        overlay.className = 'modal-overlay';

        const sheet = document.createElement('div');
        sheet.className = 'modal-sheet share-picker-sheet';

        let html = '<div class="modal-handle"></div>';
        html += '<h2 style="text-align:center;margin-bottom:1rem">Оберіть день</h2>';

        html += `<button class="share-day-btn share-day-primary" data-day="week"><svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2" fill="none"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg> Весь тиждень</button>`;

        for (const day of days) {
            const isToday = day.idx === todayIdx;
            const badge = isToday ? ' <span style="font-size:.75rem;background:var(--accent-color);color:var(--bg-color);padding:2px 8px;border-radius:8px;margin-left:8px">Сьогодні</span>' : '';
            html += `<button class="share-day-btn share-day-option${isToday ? ' share-day-today' : ''}" data-day="${day.idx}">${day.label}${badge}</button>`;
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

        const today = new Date();
        let dayIndex = today.getDay();
        let prefix = 'Сьогодні';

        // Weekend — show Monday's schedule
        if (dayIndex === 0 || dayIndex === 6) {
            prefix = dayIndex === 6 ? 'У понеділок' : 'Завтра';
            dayIndex = 1;
        }

        const dayName = ukDays[dayIndex];
        const groupData = scheduleData[selectedGroup];
        if (!groupData) return null;

        // Calculate target day date
        const currentDayOfWeek = today.getDay() || 7;
        const targetDayOfWeek = dayIndex || 7;
        let offset = targetDayOfWeek - currentDayOfWeek;
        if (offset < 0) offset += 7;
        const d = new Date(today);
        d.setDate(today.getDate() + offset);
        const dateStr = String(d.getDate()).padStart(2, '0') + '.' + String(d.getMonth() + 1).padStart(2, '0');

        const targetWeekType = getWeekType(d);
        let weekData = groupData['ОСНОВНИЙ РОЗКЛАД'] || groupData[targetWeekType];
        if (!weekData || typeof weekData !== 'object' || Array.isArray(weekData)) {
            const types = Object.keys(groupData).filter(t => t !== 'ПІДВІСКА');
            if (types.length === 0) return null;
            weekData = groupData[types.includes(targetWeekType) ? targetWeekType : types[0]];
        }
        if (!weekData || !weekData[dayName]) return null;

        let pairs = [...weekData[dayName]];

        // Merge substitutions for the target day
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
        try {
            const reg = await navigator.serviceWorker.ready;
            let subscription = await reg.pushManager.getSubscription();
            if (!subscription) {
                subscription = await reg.pushManager.subscribe({
                    userVisibleOnly: true,
                    applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
                });
            }
            await fetch('/api/subscribe', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
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
                await fetch('/api/unsubscribe', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
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
        } catch {}
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
            } catch {}
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
            // Try to scroll to the day matching dateStr
            if (dateStr) {
                const dayEls = document.querySelectorAll('.diary-day');
                for (const el of dayEls) {
                    const badge = el.querySelector('.date-badge');
                    if (badge && badge.textContent === dateStr) {
                        setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
                        return;
                    }
                }
            }
            // Fallback: scroll to today marker
            const marker = document.getElementById('today-marker');
            if (marker) {
                setTimeout(() => marker.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
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

    // ===== Init (non-blocking) =====
    (async () => {
        try {
            await refreshSchedule(false);
            syncHomeworkFromServer().catch(() => {});
        } catch (e) {
            console.warn('Schedule load notice:', e);
        }

        if (!selectedGroup) {
            showScreen('onboarding');
            renderGroupList();
        } else {
            navItems[0].classList.add('active');
            showScreen('schedule');
            storeNotifConfig();
            if (notificationsEnabled && Notification.permission === 'granted') {
                subscribeToPush();
            }
            showDailyNotification();
            showNotifPrompt();
            if (viewParam) {
                scrollToDay(dateParam);
            }
        }
    })();

    // Auto-refresh every 60s to keep "ЗАРАЗ" indicator live
    setInterval(() => {
        if (scheduleData && selectedGroup && screens.schedule && !screens.schedule.classList.contains('hidden')) {
            renderSchedule();
        }
    }, 60000);
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
                } catch {}
            }
        }).catch(() => {});
    });
}
