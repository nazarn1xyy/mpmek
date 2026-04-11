document.addEventListener('DOMContentLoaded', async () => {
    // ===== State =====
    let scheduleData = null;
    let selectedGroup = localStorage.getItem('selectedGroup');
    let currentWeekType = 'ОСНОВНИЙ РОЗКЛАД';
    let isDarkTheme = localStorage.getItem('theme') === 'dark';
    let _hwCache = null; // cached homework object
    let notificationsEnabled = localStorage.getItem('notifications') !== 'false';
    let weekOffset = 0; // 0 = current week, 1 = next week, -1 = previous week
    const VAPID_PUBLIC_KEY = 'BMOzNTERkpWZfX4i5P5E1wcd1zXOUlv-fbT1fw-cjWjZPG3xBeattWCIFUfWfHCN-7EGzqGWLnwEGgCEFW8tPpc';

    let LESSON_TIMES = {
        1: "08:30 - 09:50",
        2: "10:00 - 11:20",
        3: "11:50 - 13:10",
        4: "13:20 - 14:40",
        5: "16:00 - 17:35",
        6: "17:40 - 19:15"
    };

    const SVG_EMPTY_SCHEDULE = `<svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="empty-state-icon"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line><path d="M8 14h.01"></path><path d="M12 14h.01"></path><path d="M16 14h.01"></path><path d="M8 18h.01"></path><path d="M12 18h.01"></path><path d="M16 18h.01"></path></svg>`;
    const SVG_EMPTY_HOMEWORK = `<svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="empty-state-icon"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path><line x1="9" y1="14" x2="15" y2="14"></line></svg>`;

    const ukDays = ['Неділя', 'Понеділок', 'Вівторок', 'Середа', 'Четвер', 'П\'ятниця', 'Субота'];

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
            await fetch('/api/homework', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
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
    const installBtn = document.getElementById('installBtn');
    const installOverlay = document.getElementById('installOverlay');
    const installClose = document.getElementById('installClose');
    const hwModal = document.getElementById('hwModal');
    const hwModalTitle = document.getElementById('hwModalTitle');
    const hwModalSubject = document.getElementById('hwModalSubject');
    const hwModalInput = document.getElementById('hwModalInput');
    const hwModalCancel = document.getElementById('hwModalCancel');
    const hwModalSave = document.getElementById('hwModalSave');

    let modalCurrentKey = null;

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
    async function refreshSchedule(silent) {
        try {
            const resp = await fetch('schedule.json?t=' + Date.now());
            const data = await resp.json();
            if (data._settings) {
                if (data._settings.lessonTimes) LESSON_TIMES = data._settings.lessonTimes;
                delete data._settings;
            }
            scheduleData = data;
            if (selectedGroup && screens.schedule && !screens.schedule.classList.contains('hidden')) {
                renderSchedule();
            }
        } catch (e) {
            if (!silent) throw e;
        }
    }

    // Refresh data when user returns to the app / tab
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && selectedGroup) refreshSchedule(true);
    });

    // ===== Load Data =====
    try {
        await refreshSchedule(false);
        syncHomeworkFromServer().catch(() => {});
    } catch (e) {
        diaryContainer.innerHTML = `<div class="empty-state-container">${SVG_EMPTY_SCHEDULE}<p class="empty-state-title">Помилка завантаження</p><p class="empty-state-desc">Не вдалося завантажити розклад.</p></div>`;
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
        showScreen('schedule');
    });

    // Debounced search
    let searchTimer = null;
    groupSearch.addEventListener('input', (e) => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => renderGroupList(e.target.value), 120);
    });

    // ===== Homework Modal =====
    function openHomeworkModal(key, subject, dayLabel, existingText) {
        modalCurrentKey = key;
        hwModalSubject.textContent = `${subject} — ${dayLabel}`;
        hwModalInput.value = existingText || '';
        hwModalTitle.textContent = existingText ? 'Редагувати завдання' : 'Додати завдання';
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
    }

    hwModalCancel.addEventListener('click', closeHomeworkModal);
    hwModal.addEventListener('click', (e) => {
        if (e.target === hwModal) closeHomeworkModal();
    });
    
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !hwModal.classList.contains('hidden')) {
            closeHomeworkModal();
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
    function buildLessonCard(pair, dayLabel, hw) {
        const key = hwKey(selectedGroup, dayLabel, pair.number);
        const savedText = hw[key] || '';

        const savedHtml = savedText
            ? `<div class="hw-saved"><span>${savedText}</span><button class="hw-delete-btn" data-key="${key}" aria-label="Видалити завдання">${SVG_X}</button></div>`
            : '';

        const btnLabel = savedText ? 'Редагувати' : 'Додати завдання';
        const btnIcon = savedText ? SVG_EDIT : SVG_PLUS;
        const teacherHtml = pair.teacher ? `<div class="diary-item-teacher">${pair.teacher}</div>` : '';
        const timeHtml = LESSON_TIMES[pair.number] ? `<span class="diary-item-time">${LESSON_TIMES[pair.number]}</span>` : '';

        const div = document.createElement('div');
        div.className = 'diary-item';
        if (pair.isSubstitution) {
            div.classList.add('substitution');
        }
        
        let subjectHtml = `<div class="diary-item-subject">${pair.subject}</div>`;
        if (pair.isSubstitution) {
            const badgeText = pair.substitutionType === 'підвіска' ? 'ПІДВІСКА' : 'ЗАМІНА';
            subjectHtml = `<div class="diary-item-subject"><span class="badge-substitution">${badgeText}</span> ${pair.subject}</div>`;
        }

        div.innerHTML = `<div class="diary-item-header"><span class="diary-item-number">${pair.number} пара</span>${timeHtml}</div>${subjectHtml}${teacherHtml}${savedHtml}<button class="homework-btn" data-key="${key}" data-subject="${pair.subject}" data-day="${dayLabel}">${btnIcon} ${btnLabel}</button>`;
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
        if (!scheduleData[selectedGroup]) return;
        currentGroupTitle.textContent = selectedGroup;

        let weekData = scheduleData[selectedGroup][currentWeekType];

        const isDataEmpty = !weekData || (Array.isArray(weekData) ? weekData.length === 0 : Object.keys(weekData).length === 0);
        if (isDataEmpty) {
            const availableTypes = Object.keys(scheduleData[selectedGroup]).filter(t => t !== 'ПІДВІСКА');
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
        
        const today = new Date();
        const currentDayOfWeek = today.getDay() || 7; // 1-7 (Mon-Sun)
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

            for (let p = 0; p < pairs.length; p++) {
                dayEl.appendChild(buildLessonCard(pairs[p], day, hw));
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
                refreshSchedule(true);
                window.scrollTo({ top: 0, behavior: 'smooth' });
            });
        });

        // Reset to current week on tap center
        weekNav.querySelector('.week-nav-center').addEventListener('click', () => {
            if (weekOffset !== 0) {
                weekOffset = 0;
                refreshSchedule(true);
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
                            const found = wd.find(p => p.number === parseInt(entry.number) && p.date === day);
                            if (found) { subjectName = found.subject; break; }
                        } else if (wd[day]) {
                            const found = wd[day].find(p => p.number === parseInt(entry.number));
                            if (found) { subjectName = found.subject; break; }
                        }
                    }
                }

                const card = document.createElement('div');
                card.className = 'hw-card';
                card.innerHTML = `<div class="hw-card-subject">${subjectName}</div><div class="hw-card-meta">${entry.number} пара · ${day}</div><div class="hw-card-text">${entry.text}</div><div class="hw-card-actions"><button class="hw-card-edit" data-key="${entry.key}" data-subject="${subjectName}" data-day="${day}">${SVG_EDIT_SM} Редагувати</button><button class="hw-card-delete hw-delete" data-key="${entry.key}">${SVG_TRASH} Видалити</button></div>`;
                frag.appendChild(card);
            }
        }

        homeworkContainer.innerHTML = '';
        homeworkContainer.appendChild(frag);
    }

    // ===== Share Schedule as Image =====
    function getPairsForDay(targetDayIdx) {
        if (!scheduleData || !selectedGroup) return null;
        const groupData = scheduleData[selectedGroup];
        if (!groupData) return null;

        const dayName = ukDays[targetDayIdx];

        let weekData = groupData[currentWeekType];
        if (!weekData || typeof weekData !== 'object' || Array.isArray(weekData)) {
            weekData = groupData['ОСНОВНИЙ РОЗКЛАД'];
        }
        if (!weekData) {
            const types = Object.keys(groupData).filter(t => t !== 'ПІДВІСКА');
            if (types.length === 0) return null;
            weekData = groupData[types[0]];
        }

        const today = new Date();
        const currentDayOfWeek = today.getDay() || 7;
        const targetDayOfWeek = targetDayIdx || 7;
        const offset = targetDayOfWeek - currentDayOfWeek + (weekOffset * 7);
        const d = new Date(today);
        d.setDate(today.getDate() + offset);
        const dateStr = String(d.getDate()).padStart(2, '0') + '.' + String(d.getMonth() + 1).padStart(2, '0');

        let pairs = weekData[dayName] ? [...weekData[dayName]] : [];
        const subs = groupData['ПІДВІСКА'] || [];
        subs.filter(s => s.date === dateStr).forEach(sub => {
            const replaces = pairs.some(p => parseInt(p.number) === parseInt(sub.number));
            pairs = pairs.filter(p => parseInt(p.number) !== parseInt(sub.number));
            pairs.push({ ...sub, isSubstitution: true, substitutionType: replaces ? 'заміна' : 'підвіска' });
        });

        if (pairs.length === 0) return null;
        pairs.sort((a, b) => parseInt(a.number) - parseInt(b.number));

        return { pairs, dayName, dateStr };
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
        const isDark = document.body.getAttribute('data-theme') === 'dark';
        const hw = getHomework();
        const W = 600;
        const padX = 32;
        const baseCardH = 56;
        const hwExtraH = 16;
        const cardGap = 8;
        const dayHeaderH = 44;
        const topH = 80;
        const footerH = 50;

        const allDays = [1, 2, 3, 4, 5];
        const dayLabels = { 1: 'Понеділок', 2: 'Вівторок', 3: 'Середа', 4: 'Четвер', 5: "П'ятниця" };
        const weekData = [];
        let totalCards = 0;
        let daysWithData = 0;

        for (const idx of allDays) {
            const data = getPairsForDay(idx);
            if (data && data.pairs.length > 0) {
                weekData.push({ ...data, idx });
                totalCards += data.pairs.length;
                daysWithData++;
            }
        }

        if (weekData.length === 0) {
            alert('Немає розкладу на цей тиждень');
            return;
        }

        let totalCardsH = 0;
        for (const dd of weekData) {
            for (const p of dd.pairs) {
                const k = hwKey(selectedGroup, dd.dayName, p.number);
                totalCardsH += (hw[k] ? baseCardH + hwExtraH : baseCardH) + cardGap;
            }
        }
        const H = topH + daysWithData * dayHeaderH + totalCardsH + footerH + 20;

        const canvas = document.createElement('canvas');
        canvas.width = W * 2;
        canvas.height = H * 2;
        const ctx = canvas.getContext('2d');
        ctx.scale(2, 2);

        const bg = isDark ? '#000' : '#fff';
        const fg = isDark ? '#f5f5f5' : '#1a1a1a';
        const surface = isDark ? '#111' : '#f5f5f5';
        const muted = isDark ? '#888' : '#888';
        const accent = isDark ? '#fff' : '#000';
        const subColor = '#f59e0b';

        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, W, H);

        ctx.fillStyle = fg;
        ctx.font = 'bold 26px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.fillText(selectedGroup, padX, 42);

        ctx.fillStyle = muted;
        ctx.font = '14px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        const today = new Date();
        const monOffset = 1 - (today.getDay() || 7) + (weekOffset * 7);
        const mon = new Date(today); mon.setDate(today.getDate() + monOffset);
        const fri = new Date(mon); fri.setDate(mon.getDate() + 4);
        const rangeStr = `${String(mon.getDate()).padStart(2,'0')}.${String(mon.getMonth()+1).padStart(2,'0')} — ${String(fri.getDate()).padStart(2,'0')}.${String(fri.getMonth()+1).padStart(2,'0')}`;
        ctx.fillText(rangeStr, padX, 64);

        let y = topH;
        const todayIdx = today.getDay();

        for (const dayData of weekData) {
            const isToday = weekOffset === 0 && dayData.idx === todayIdx;

            ctx.fillStyle = isToday ? accent : fg;
            ctx.font = `bold 15px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
            ctx.fillText(dayData.dayName.toUpperCase(), padX, y + 20);

            ctx.fillStyle = muted;
            ctx.font = '13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
            ctx.fillText(dayData.dateStr, padX + ctx.measureText(dayData.dayName.toUpperCase()).width + 10, y + 20);

            if (isToday) {
                const label = 'Сьогодні';
                ctx.font = 'bold 10px -apple-system, BlinkMacSystemFont, sans-serif';
                const tw = ctx.measureText(label).width;
                const bx = W - padX - tw - 16;
                ctx.fillStyle = accent;
                roundRect(ctx, bx, y + 6, tw + 16, 20, 6);
                ctx.fill();
                ctx.fillStyle = bg;
                ctx.fillText(label, bx + 8, y + 20);
            }

            y += dayHeaderH;

            const hwColor = isDark ? '#66bb6a' : '#2e7d32';
            for (const pair of dayData.pairs) {
                const hwTextKey = hwKey(selectedGroup, dayData.dayName, pair.number);
                const hwText = hw[hwTextKey] || '';
                const cardH = hwText ? baseCardH + hwExtraH : baseCardH;

                ctx.fillStyle = surface;
                roundRect(ctx, padX, y, W - padX * 2, cardH, 12);
                ctx.fill();

                if (pair.isSubstitution) {
                    ctx.strokeStyle = subColor;
                    ctx.lineWidth = 1.5;
                    roundRect(ctx, padX, y, W - padX * 2, cardH, 12);
                    ctx.stroke();
                }

                const circleX = padX + 22;
                const circleY = y + cardH / 2;
                ctx.fillStyle = pair.isSubstitution ? subColor : accent;
                ctx.beginPath();
                ctx.arc(circleX, circleY, 14, 0, Math.PI * 2);
                ctx.fill();

                ctx.fillStyle = pair.isSubstitution ? '#fff' : bg;
                ctx.font = 'bold 13px -apple-system, BlinkMacSystemFont, sans-serif';
                ctx.textAlign = 'center';
                ctx.fillText(pair.number, circleX, circleY + 4.5);
                ctx.textAlign = 'left';

                ctx.fillStyle = fg;
                ctx.font = '600 14px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
                ctx.fillText(truncText(ctx, pair.subject, W - padX * 2 - 70), padX + 46, y + 22);

                ctx.fillStyle = muted;
                ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
                const time = LESSON_TIMES[pair.number] || '';
                const teacher = pair.teacher || '';
                const meta = [time, teacher].filter(Boolean).join('  ·  ');
                ctx.fillText(truncText(ctx, meta, W - padX * 2 - 70), padX + 46, y + 40);

                if (hwText) {
                    ctx.fillStyle = hwColor;
                    ctx.font = '10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
                    ctx.fillText('📝 ' + truncText(ctx, hwText.replace(/\n/g, ' '), W - padX * 2 - 70), padX + 46, y + 54);
                }

                y += cardH + cardGap;
            }
        }

        ctx.fillStyle = muted;
        ctx.font = '12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Розклад Студента · mpmek.site', W / 2, H - 18);
        ctx.textAlign = 'left';

        canvas.toBlob(async (blob) => {
            if (!blob) return;
            const file = new File([blob], `rozklad-week-${rangeStr}.png`, { type: 'image/png' });
            if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
                try {
                    await navigator.share({ files: [file], title: `Розклад на тиждень`, text: `${selectedGroup} — ${rangeStr}` });
                } catch {}
            } else {
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `rozklad-week.png`;
                a.click();
                URL.revokeObjectURL(url);
            }
        }, 'image/png');
    }

    async function shareScheduleForDay(dayIdx) {
        const data = getPairsForDay(dayIdx);
        if (!data) {
            alert('Немає розкладу для цього дня');
            return;
        }

        const { pairs, dayName, dateStr } = data;
        const isDark = document.body.getAttribute('data-theme') === 'dark';
        const hw = getHomework();

        // Canvas setup
        const W = 600;
        const padX = 32;
        const baseCardH = 72;
        const hwExtraH = 22;
        const cardGap = 12;
        const headerH = 120;
        const footerH = 60;
        let totalCardsH = 0;
        for (const p of pairs) {
            const k = hwKey(selectedGroup, dayName, p.number);
            totalCardsH += (hw[k] ? baseCardH + hwExtraH : baseCardH) + cardGap;
        }
        const H = headerH + totalCardsH + footerH + 20;

        const canvas = document.createElement('canvas');
        canvas.width = W * 2;
        canvas.height = H * 2;
        const ctx = canvas.getContext('2d');
        ctx.scale(2, 2);

        // Colors
        const bg = isDark ? '#000' : '#fff';
        const fg = isDark ? '#f5f5f5' : '#1a1a1a';
        const surface = isDark ? '#111' : '#f5f5f5';
        const border = isDark ? '#222' : '#e0e0e0';
        const muted = isDark ? '#888' : '#888';
        const accent = isDark ? '#fff' : '#000';
        const subColor = '#f59e0b';

        // Background
        ctx.fillStyle = bg;
        roundRect(ctx, 0, 0, W, H, 0);
        ctx.fill();

        // Header
        ctx.fillStyle = fg;
        ctx.font = 'bold 28px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.fillText(selectedGroup, padX, 50);

        ctx.font = 'bold 20px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.fillStyle = accent;
        ctx.fillText(dayName, padX, 82);

        ctx.font = '15px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.fillStyle = muted;
        ctx.fillText(dateStr, padX, 105);

        // Cards
        const hwColor = isDark ? '#66bb6a' : '#2e7d32';
        let y = headerH;
        for (const pair of pairs) {
            const hwTextKey = hwKey(selectedGroup, dayName, pair.number);
            const hwText = hw[hwTextKey] || '';
            const cardH = hwText ? baseCardH + hwExtraH : baseCardH;

            // Card background
            ctx.fillStyle = surface;
            roundRect(ctx, padX, y, W - padX * 2, cardH, 14);
            ctx.fill();

            // Substitution border
            if (pair.isSubstitution) {
                ctx.strokeStyle = subColor;
                ctx.lineWidth = 2;
                roundRect(ctx, padX, y, W - padX * 2, cardH, 14);
                ctx.stroke();
            }

            // Number circle
            const circleX = padX + 28;
            const circleY = y + cardH / 2;
            ctx.fillStyle = pair.isSubstitution ? subColor : accent;
            ctx.beginPath();
            ctx.arc(circleX, circleY, 18, 0, Math.PI * 2);
            ctx.fill();

            ctx.fillStyle = pair.isSubstitution ? '#fff' : bg;
            ctx.font = 'bold 16px -apple-system, BlinkMacSystemFont, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(pair.number, circleX, circleY + 5.5);
            ctx.textAlign = 'left';

            // Subject
            ctx.fillStyle = fg;
            ctx.font = '600 16px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
            const subjectText = pair.subject;
            ctx.fillText(truncText(ctx, subjectText, W - padX * 2 - 80), padX + 56, y + 30);

            // Time + teacher
            ctx.fillStyle = muted;
            ctx.font = '13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
            const time = LESSON_TIMES[pair.number] || '';
            const teacher = pair.teacher || '';
            const meta = [time, teacher].filter(Boolean).join('  ·  ');
            ctx.fillText(truncText(ctx, meta, W - padX * 2 - 80), padX + 56, y + 52);

            // Homework
            if (hwText) {
                ctx.fillStyle = hwColor;
                ctx.font = '12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
                ctx.fillText('📝 ' + truncText(ctx, hwText.replace(/\n/g, ' '), W - padX * 2 - 80), padX + 56, y + 70);
            }

            y += cardH + cardGap;
        }

        // Footer
        ctx.fillStyle = muted;
        ctx.font = '13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Розклад Студента · mpmek.site', W / 2, H - 24);
        ctx.textAlign = 'left';

        // Convert to blob and share
        canvas.toBlob(async (blob) => {
            if (!blob) return;
            const file = new File([blob], `rozklad-${dateStr}.png`, { type: 'image/png' });

            if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
                try {
                    await navigator.share({
                        files: [file],
                        title: `Розклад на ${dayName}`,
                        text: `${selectedGroup} — ${dayName} ${dateStr}`
                    });
                } catch {}
            } else {
                // Fallback: download
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `rozklad-${dateStr}.png`;
                a.click();
                URL.revokeObjectURL(url);
            }
        }, 'image/png');
    }

    function roundRect(ctx, x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.quadraticCurveTo(x + w, y, x + w, y + r);
        ctx.lineTo(x + w, y + h - r);
        ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        ctx.lineTo(x + r, y + h);
        ctx.quadraticCurveTo(x, y + h, x, y + h - r);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.closePath();
    }

    function truncText(ctx, text, maxWidth) {
        if (ctx.measureText(text).width <= maxWidth) return text;
        let t = text;
        while (t.length > 0 && ctx.measureText(t + '…').width > maxWidth) t = t.slice(0, -1);
        return t + '…';
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
        const offset = targetDayOfWeek - currentDayOfWeek;
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
            pairsCount: pairs.length
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
            // Skip server call if nothing changed
            const subKey = `pushSub_${subscription.endpoint}_${selectedGroup}_${localStorage.getItem('notifTime') || '08:00'}`;
            if (localStorage.getItem('lastPushSub') === subKey) return;
            await fetch('/api/subscribe', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    subscription: subscription.toJSON(),
                    group: selectedGroup,
                    notifyTime: localStorage.getItem('notifTime') || '08:00'
                })
            });
            localStorage.setItem('lastPushSub', subKey);
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
                data: { url: '?view=today' },
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

    function scrollToToday() {
        showScreen('schedule');
        navItems.forEach(n => n.classList.remove('active'));
        navItems[0].classList.add('active');
        requestAnimationFrame(() => {
            const marker = document.getElementById('today-marker');
            if (marker) {
                setTimeout(() => marker.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
            }
        });
    }

    // Listen for SW postMessage (notification click while app is open)
    navigator.serviceWorker && navigator.serviceWorker.addEventListener('message', event => {
        if (event.data && event.data.type === 'SHOW_TODAY') {
            scrollToToday();
        }
    });

    // Handle ?view=today from notification click (app was closed)
    const urlParams = new URLSearchParams(window.location.search);
    const viewToday = urlParams.get('view') === 'today';
    if (viewToday) {
        window.history.replaceState({}, '', window.location.pathname);
    }

    // ===== Init =====
    if (!selectedGroup) {
        showScreen('onboarding');
        renderGroupList();
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
        // If opened from notification, scroll to today
        if (viewToday) {
            scrollToToday();
        }

        // Schedule test notification 5 min after new deployment
        const DEPLOY_VERSION = 'rozklad-v26';
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
                } catch {}
            }
        }).catch(() => {});
    });
}
