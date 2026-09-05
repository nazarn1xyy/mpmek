document.addEventListener('DOMContentLoaded', async () => {
    // ===== State =====
    let scheduleData = null;
    let selectedGroup = localStorage.getItem('selectedGroup');
    let currentWeekType = null;
    let weekOffset = 0; // 0 = current week, 1 = next week, -1 = previous week

    // Instant local cache recovery for 0ms initial load
    try {
        const cachedRaw = localStorage.getItem('cached_schedule_data');
        if (cachedRaw) {
            const cachedParsed = JSON.parse(cachedRaw);
            if (cachedParsed && typeof cachedParsed === 'object') {
                if (cachedParsed._settings && cachedParsed._settings.lessonTimes) {
                    LESSON_TIMES = cachedParsed._settings.lessonTimes;
                }
                scheduleData = cachedParsed;
            }
        }
    } catch (_) {}

    let LESSON_TIMES = {
        1: "08:30 - 09:50",
        2: "10:00 - 11:20",
        3: "11:50 - 13:10",
        4: "13:20 - 14:40",
        5: "14:50 - 16:10",
        6: "16:20 - 17:40"
    };

    const BELLS_SCHEDULE = [
        { num: 1, start: '08:30', end: '09:50', breakText: 'Перерва 10 хв' },
        { num: 2, start: '10:00', end: '11:20', breakText: 'Велика перерва 30 хв' },
        { num: 3, start: '11:50', end: '13:10', breakText: 'Перерва 10 хв' },
        { num: 4, start: '13:20', end: '14:40', breakText: 'Перерва 10 хв' },
        { num: 5, start: '14:50', end: '16:10', breakText: 'Перерва 10 хв' },
        { num: 6, start: '16:20', end: '17:40', breakText: null }
    ];

    const SVG_EMPTY_SCHEDULE = `<svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="empty-state-icon"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line><path d="M8 14h.01"></path><path d="M12 14h.01"></path><path d="M16 14h.01"></path><path d="M8 18h.01"></path><path d="M12 18h.01"></path><path d="M16 18h.01"></path></svg>`;

    const ukDays = ['Неділя', 'Понеділок', 'Вівторок', 'Середа', 'Четвер', 'П\'ятниця', 'Субота'];
    const UK_DAYS_ORDER = ['Понеділок', 'Вівторок', 'Середа', 'Четвер', "П'ятниця", 'Субота'];
    const UK_DAYS_SHORT = {
        'Понеділок': 'Пн',
        'Вівторок': 'Вт',
        'Середа': 'Ср',
        'Четвер': 'Чт',
        "П'ятниця": 'Пт',
        'Субота': 'Сб'
    };

    function getWeekType(date) {
        const d = new Date(date || new Date());
        d.setHours(0, 0, 0, 0);
        d.setDate(d.getDate() + 3 - (d.getDay() + 6) % 7);
        const week1 = new Date(d.getFullYear(), 0, 4);
        const weekNum = 1 + Math.round(((d - week1) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);
        return weekNum % 2 === 0 ? 'ЧИСЕЛЬНИК' : 'ЗНАМЕННИК';
    }

    // ===== XSS protection =====
    const _escDiv = document.createElement('div');
    function escHtml(str) {
        if (!str) return '';
        _escDiv.textContent = str;
        return _escDiv.innerHTML;
    }

    // ===== DOM Elements =====
    const screens = {
        onboarding: document.getElementById('onboarding'),
        schedule: document.getElementById('schedule'),
        settings: document.getElementById('settings')
    };

    const bottomNav = document.getElementById('bottomNav');
    const navItems = document.querySelectorAll('.bottom-nav .nav-item');

    const groupListContainer = document.getElementById('groupList');
    const groupSearch = document.getElementById('groupSearch');
    const currentGroupTitle = document.getElementById('currentGroupTitle');
    const diaryContainer = document.getElementById('diaryContainer');
    const weekTypeToggle = document.getElementById('weekTypeToggle');
    const shareScheduleBtn = document.getElementById('shareScheduleBtn');

    const changeGroupBtn = null; // removed from UI
    const changeGroupRow = document.getElementById('changeGroupRow');
    const settingsCurrentGroupSub = document.getElementById('settingsCurrentGroupSub');
    const themeSettingRow = document.getElementById('themeSettingRow');
    const themeSubtitle = document.getElementById('themeSubtitle');
    const themeToggle = document.getElementById('themeToggle');
    const bellsSettingRow = document.getElementById('bellsSettingRow');
    const openBellsBtn = document.getElementById('openBellsBtn');
    const exportCalendarRow = document.getElementById('exportCalendarRow');
    const installRow = document.getElementById('installRow');
    const sidebarGroupBadge = document.getElementById('sidebarGroupBadge');

    const offlineBanner = document.getElementById('offlineBanner');
    const searchBtn = document.getElementById('searchBtn');
    const searchModal = document.getElementById('searchModal');
    const searchModalClose = document.getElementById('searchModalClose');
    const globalSearchInput = document.getElementById('globalSearchInput');
    const searchResults = document.getElementById('searchResults');
    const bellsModal = document.getElementById('bellsModal');
    const bellsModalClose = document.getElementById('bellsModalClose');
    const bellsList = document.getElementById('bellsList');

    // ===== Offline Status =====
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
        if (themeSubtitle) {
            themeSubtitle.textContent = dark ? 'Темна тема увімкнена' : 'Світла тема увімкнена';
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

    // Hide install row if already installed / standalone
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    if (isStandalone && installRow) {
        installRow.style.display = 'none';
    }

    // ===== Screen Navigation =====
    function showScreen(screenId) {
        Object.values(screens).forEach(s => s && s.classList.add('hidden'));
        if (screens[screenId]) {
            screens[screenId].classList.remove('hidden');
        }

        if (bottomNav) {
            bottomNav.classList.toggle('hidden', screenId === 'onboarding');
        }

        navItems.forEach(n => {
            n.classList.toggle('active', n.dataset.target === screenId);
        });

        if (screenId === 'schedule' && selectedGroup) {
            refreshSchedule(true);
        } else if (screenId === 'settings') {
            updateSettingsUI();
        }
    }

    function updateSettingsUI() {
        if (sidebarGroupBadge) {
            sidebarGroupBadge.textContent = selectedGroup || 'Не обрано';
        }
        if (settingsCurrentGroupSub) {
            settingsCurrentGroupSub.textContent = selectedGroup || '—';
        }
        const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        if (themeToggle) themeToggle.checked = isDark;
        updateThemeSubtitle(isDark);
    }

    navItems.forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            const target = item.dataset.target;
            if (!target) return;
            showScreen(target);
        });
    });

    // ===== Group Selection (Frictionless Onboarding) =====
    function renderGroupList(filter = '') {
        if (!groupListContainer || !scheduleData) return;
        const frag = document.createDocumentFragment();
        const lowerFilter = filter.toLowerCase().trim();
        const groups = Object.keys(scheduleData).filter(k => k !== '_settings').sort();
        let count = 0;

        for (let i = 0; i < groups.length; i++) {
            const group = groups[i];
            if (lowerFilter && !group.toLowerCase().includes(lowerFilter)) continue;

            const el = document.createElement('div');
            el.className = 'group-item' + (group === selectedGroup ? ' group-selected' : '');
            el.textContent = group;
            el.dataset.group = group;
            frag.appendChild(el);
            count++;
        }

        if (count === 0) {
            groupListContainer.innerHTML = '<div class="empty-state" style="padding:2rem 1rem;margin-top:0;text-align:center"><p class="empty-state-title" style="font-size:1.1rem;font-weight:600">Групу не знайдено</p><p class="empty-state-desc" style="color:var(--secondary-text);font-size:0.9rem">Перевірте назву або спробуйте інший запит</p></div>';
            return;
        }

        groupListContainer.innerHTML = '';
        groupListContainer.appendChild(frag);
    }

    // Instant group select on click -> straight to schedule!
    if (groupListContainer) {
        groupListContainer.addEventListener('click', (e) => {
            const item = e.target.closest('.group-item');
            if (!item) return;
            selectedGroup = item.dataset.group;
            weekOffset = 0;
            localStorage.setItem('selectedGroup', selectedGroup);
            showScreen('schedule');
            renderSchedule();
        });
    }

    // Debounced search on group list
    let searchTimer = null;
    if (groupSearch) {
        groupSearch.addEventListener('input', (e) => {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(() => renderGroupList(e.target.value), 100);
        });
    }

    // Settings actions
    function handleGroupChangePrompt() {
        showScreen('onboarding');
        if (groupSearch) {
            groupSearch.value = '';
            setTimeout(() => groupSearch.focus(), 50);
        }
        renderGroupList();
    }

    if (changeGroupBtn) changeGroupBtn.addEventListener('click', handleGroupChangePrompt);
    const sidebarGroupBtn = document.getElementById('sidebarGroupBtn');
    if (sidebarGroupBtn) sidebarGroupBtn.addEventListener('click', handleGroupChangePrompt);
    if (changeGroupRow) {
        changeGroupRow.addEventListener('click', (e) => {
            if (e.target !== changeGroupBtn) handleGroupChangePrompt();
        });
    }

    if (themeSettingRow) {
        themeSettingRow.addEventListener('click', (e) => {
            if (e.target.closest('.switch') || e.target.closest('input')) return;
            const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
            const nextDark = !isDark;
            applyTheme(nextDark);
            localStorage.setItem('theme', nextDark ? 'dark' : 'light');
        });
    }

    // ===== Week Type Toggle =====
    if (weekTypeToggle) {
        weekTypeToggle.addEventListener('click', () => {
            if (!scheduleData || !scheduleData[selectedGroup]) return;
            const availableTypes = Object.keys(scheduleData[selectedGroup]).filter(t => t !== 'ПІДВІСКА');
            if (availableTypes.length === 0) return;

            let currentIndex = availableTypes.indexOf(currentWeekType);
            if (currentIndex === -1) currentIndex = 0;
            currentWeekType = availableTypes[(currentIndex + 1) % availableTypes.length];

            weekTypeToggle.textContent = currentWeekType.split(' ')[0] || 'РОЗКЛАД';
            renderSchedule();
        });
    }

    // ===== Fetch schedule data =====
    let _lastFetchTime = 0;
    const REFRESH_INTERVAL = 5 * 60 * 1000;

    async function refreshSchedule(silent) {
        const now = Date.now();
        if (scheduleData && (now - _lastFetchTime < REFRESH_INTERVAL)) {
            if (selectedGroup && screens.schedule && !screens.schedule.classList.contains('hidden')) {
                renderSchedule();
            }
            return;
        }
        try {
            const resp = await fetch('schedule.json');
            const data = await resp.json();
            try {
                localStorage.setItem('cached_schedule_data', JSON.stringify(data));
            } catch (_) {}
            if (data._settings) {
                if (data._settings.lessonTimes) LESSON_TIMES = data._settings.lessonTimes;
                delete data._settings;
            }
            scheduleData = data;
            _lastFetchTime = Date.now();
            if (selectedGroup && screens.schedule && !screens.schedule.classList.contains('hidden')) {
                renderSchedule();
            }
            if (screens.onboarding && !screens.onboarding.classList.contains('hidden')) {
                renderGroupList(groupSearch ? groupSearch.value : '');
            }
        } catch (e) {
            if (scheduleData && silent) {
                if (selectedGroup && screens.schedule && !screens.schedule.classList.contains('hidden')) {
                    renderSchedule();
                }
                return;
            }
            if (!silent) throw e;
        }
    }

    // Refresh data when user returns to app
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && selectedGroup) refreshSchedule(true);
    });

    // ===== Bells Schedule Modal =====
    function lockBody() {
        document.body.style.overflow = 'hidden';
    }
    function unlockBody() {
        document.body.style.overflow = '';
        if (document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA')) {
            document.activeElement.blur();
        }
        window.scrollTo(window.scrollX, window.scrollY);
    }

    function openBellsModal() {
        if (!bellsModal || !bellsList) return;
        lockBody();
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
                    <span>${b.breakText}${isBreakNow ? ` (ще ${nextStartMin - nowMin} хв)` : ''}</span>
                </div>`;
            }
        }

        bellsList.innerHTML = html;
        bellsModal.classList.remove('hidden');
    }

    function closeBellsModal() {
        if (bellsModal) bellsModal.classList.add('hidden');
        unlockBody();
    }

    if (openBellsBtn) openBellsBtn.addEventListener('click', openBellsModal);
    if (bellsSettingRow) {
        bellsSettingRow.addEventListener('click', (e) => {
            if (e.target !== openBellsBtn) openBellsModal();
        });
    }
    if (exportCalendarRow) {
        exportCalendarRow.addEventListener('click', exportCalendarICS);
    }
    if (bellsModalClose) bellsModalClose.addEventListener('click', closeBellsModal);
    if (bellsModal) {
        bellsModal.addEventListener('click', (e) => {
            if (e.target === bellsModal) closeBellsModal();
        });
        bellsModal.addEventListener('touchmove', (e) => {
            if (e.target === bellsModal) e.preventDefault();
        }, { passive: false });
    }

    // ===== Search Teachers & Rooms Modal =====
    function openSearchModal() {
        if (!searchModal) return;
        lockBody();
        searchModal.classList.remove('hidden');
        if (globalSearchInput) {
            globalSearchInput.value = '';
            setTimeout(() => globalSearchInput.focus(), 50);
        }
        renderSearchResults('');
    }

    function closeSearchModal() {
        if (searchModal) searchModal.classList.add('hidden');
        unlockBody();
    }

    let searchCurrentDayFilter = 'all';
    let lastSearchQuery = '';

    function renderSearchResults(query) {
        if (!searchResults) return;
        if (query !== undefined) lastSearchQuery = query;
        const q = (lastSearchQuery || '').trim().toLowerCase();

        if (!q || q.length < 2) {
            const SVG_SEARCH_LG = `<svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.4"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`;
            searchResults.innerHTML = `<div class="empty-search-prompt">
                <div class="search-prompt-icon">${SVG_SEARCH_LG}</div>
                <p style="font-weight:600;margin-bottom:0.25rem">Пошук розкладу</p>
                <p style="font-size:0.85rem;color:var(--secondary-text);margin-bottom:1rem">Введіть викладача, номер кабінету або предмет</p>
                <div class="search-suggestions">
                    <span class="search-suggestion-chip" data-search="Сабірова">Сабірова</span>
                    <span class="search-suggestion-chip" data-search="69">ауд. 69</span>
                    <span class="search-suggestion-chip" data-search="Компанієць">Компанієць</span>
                    <span class="search-suggestion-chip" data-search="Математика">Математика</span>
                </div>
            </div>`;
            return;
        }

        if (!scheduleData) return;

        const results = [];
        const now = new Date();
        const todayName = ukDays[now.getDay()];
        const nowMin = now.getHours() * 60 + now.getMinutes();

        const groups = Object.keys(scheduleData).filter(k => k !== '_settings');

        for (const grp of groups) {
            const groupData = scheduleData[grp];
            if (!groupData) continue;

            const weekTypes = Object.keys(groupData);
            for (const wt of weekTypes) {
                if (wt === 'ПІДВІСКА') {
                    const subs = groupData[wt];
                    if (Array.isArray(subs)) {
                        for (const sub of subs) {
                            const matchSubject = sub.subject && sub.subject.toLowerCase().includes(q);
                            const matchTeacher = sub.teacher && sub.teacher.toLowerCase().includes(q);
                            const matchRoom = sub.room && String(sub.room).toLowerCase().includes(q);

                            if (matchSubject || matchTeacher || matchRoom) {
                                results.push({
                                    group: grp,
                                    day: sub.date || 'Підвіска',
                                    number: sub.number,
                                    subject: sub.subject,
                                    teacher: sub.teacher || '',
                                    room: sub.room || '',
                                    isSubstitution: true,
                                    weekType: 'ПІДВІСКА'
                                });
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
                        const matchSubject = p.subject && p.subject.toLowerCase().includes(q);
                        const matchTeacher = p.teacher && p.teacher.toLowerCase().includes(q);
                        const matchRoom = p.room && String(p.room).toLowerCase().includes(q);

                        if (matchSubject || matchTeacher || matchRoom) {
                            let isHappeningNow = false;
                            if (day === todayName && LESSON_TIMES[p.number]) {
                                const [s, e] = LESSON_TIMES[p.number].split(' - ');
                                const [sh, sm] = s.split(':').map(Number);
                                const [eh, em] = e.split(':').map(Number);
                                if (nowMin >= sh * 60 + sm && nowMin < eh * 60 + em) {
                                    isHappeningNow = true;
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

        if (results.length === 0) {
            searchResults.innerHTML = `<div class="empty-search-prompt">
                <p>Нічого не знайдено за запитом <strong>«${escHtml(q)}»</strong></p>
                <p class="search-prompt-hint">Спробуйте скоротити запит або перевірити назву</p>
            </div>`;
            return;
        }

        const grouped = {};
        for (const item of results) {
            const d = item.day || 'Інше';
            if (!grouped[d]) grouped[d] = [];
            grouped[d].push(item);
        }

        const daysWithResults = UK_DAYS_ORDER.filter(d => grouped[d] && grouped[d].length > 0);
        Object.keys(grouped).forEach(d => {
            if (!UK_DAYS_ORDER.includes(d) && !daysWithResults.includes(d)) daysWithResults.push(d);
        });

        let chipsHtml = `<div class="search-filter-chips">
            <button class="search-chip ${searchCurrentDayFilter === 'all' ? 'active' : ''}" data-day="all">Всі (${results.length})</button>`;
        for (const d of daysWithResults) {
            const short = UK_DAYS_SHORT[d] || d;
            chipsHtml += `<button class="search-chip ${searchCurrentDayFilter === d ? 'active' : ''}" data-day="${d}">${short} (${grouped[d].length})</button>`;
        }
        chipsHtml += `</div>`;

        let listHtml = '';
        const targetDays = searchCurrentDayFilter === 'all' ? daysWithResults : [searchCurrentDayFilter];

        for (const day of targetDays) {
            const items = grouped[day];
            if (!items || items.length === 0) continue;

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
                            ${item.teacher ? `<span class="search-meta-teacher">${escHtml(item.teacher)}</span>` : ''}
                            ${item.room ? `<span class="search-meta-room">ауд. ${escHtml(item.room)}</span>` : ''}
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
        searchModal.addEventListener('touchmove', (e) => {
            if (e.target === searchModal) e.preventDefault();
        }, { passive: false });
    }
    let globalSearchTimer = null;
    if (globalSearchInput) {
        globalSearchInput.addEventListener('input', (e) => {
            clearTimeout(globalSearchTimer);
            const val = e.target.value;
            globalSearchTimer = setTimeout(() => {
                renderSearchResults(val);
            }, 120);
        });
    }

    // Modal close on Escape
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            if (bellsModal && !bellsModal.classList.contains('hidden')) closeBellsModal();
            if (searchModal && !searchModal.classList.contains('hidden')) closeSearchModal();
        }
    });

    // Delegated clicks for search chips
    document.addEventListener('click', (e) => {
        const searchChip = e.target.closest('.search-chip');
        if (searchChip && searchChip.dataset.day) {
            e.preventDefault();
            searchCurrentDayFilter = searchChip.dataset.day;
            renderSearchResults();
            return;
        }

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

        const openBellsTrigger = e.target.closest('[data-open-bells="true"]');
        if (openBellsTrigger) {
            e.preventDefault();
            openBellsModal();
            return;
        }

        const weekNavBtn = e.target.closest('.week-nav-btn');
        if (weekNavBtn) {
            e.preventDefault();
            weekOffset += parseInt(weekNavBtn.dataset.dir);
            currentWeekType = null;
            renderSchedule();
            window.scrollTo({ top: 0, behavior: 'smooth' });
            return;
        }

        const weekNavCenter = e.target.closest('.week-nav-center');
        if (weekNavCenter && weekOffset !== 0) {
            e.preventDefault();
            weekOffset = 0;
            currentWeekType = null;
            renderSchedule();
            window.scrollTo({ top: 0, behavior: 'smooth' });
            return;
        }
    });

    // ===== Build Lesson Card (Minimalist & Clean) =====
    function buildLessonCard(pair, dayLabel, lessonStatus) {
        const roomHtml = pair.room ? `<span class="diary-item-room">ауд. ${escHtml(pair.room)}</span>` : '';
        const teacherHtml = (pair.teacher || pair.room) ? `<div class="diary-item-teacher">${escHtml(pair.teacher || '')}${pair.teacher && pair.room ? ' · ' : ''}${roomHtml}</div>` : '';
        const timeHtml = LESSON_TIMES[pair.number] ? `<span class="diary-item-time" data-open-bells="true" style="cursor:pointer" title="Розклад дзвінків">${LESSON_TIMES[pair.number]}</span>` : '';

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
        if (pair.isSubstitution) div.classList.add('substitution');

        const escapedSubject = escHtml(pair.subject);
        let subjectHtml = `<div class="diary-item-subject">${escapedSubject}</div>`;
        if (pair.isSubstitution) {
            const badgeText = pair.substitutionType === 'підвіска' ? 'ПІДВІСКА' : 'ЗАМІНА';
            subjectHtml = `<div class="diary-item-subject"><span class="badge-substitution">${badgeText}</span> ${escapedSubject}</div>`;
        }

        div.innerHTML = `<div class="diary-item-header"><span class="diary-item-number">${pair.number} пара</span>${statusBadge}${timeHtml}</div>${subjectHtml}${teacherHtml}`;
        return div;
    }

    // ===== Touch Swipe Gestures for Weeks =====
    let touchStartX = 0;
    let touchStartY = 0;
    let isTouching = false;

    if (diaryContainer) {
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

            if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
                currentWeekType = null;
                if (dx < 0) {
                    weekOffset += 1;
                    renderSchedule();
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                } else {
                    weekOffset -= 1;
                    renderSchedule();
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                }
            }
        }, { passive: true });
    }

    // ===== Render Schedule =====
    function renderSchedule() {
        if (!diaryContainer) return;
        if (!scheduleData || !selectedGroup || !scheduleData[selectedGroup]) {
            if (!selectedGroup) {
                showScreen('onboarding');
                renderGroupList();
            }
            return;
        }

        if (currentGroupTitle) currentGroupTitle.textContent = selectedGroup;
        if (sidebarGroupBadge) sidebarGroupBadge.textContent = selectedGroup || 'Не обрано';

        const today = new Date();
        const isSunday = today.getDay() === 0;
        const currentDayOfWeek = isSunday ? 0 : today.getDay();
        const targetMon = new Date(today);
        targetMon.setDate(today.getDate() + (1 - currentDayOfWeek + (weekOffset * 7)));
        const targetParity = getWeekType(targetMon);

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
        if (weekTypeToggle) weekTypeToggle.textContent = currentWeekType.split(' ')[0] || 'РОЗКЛАД';

        let weekData = scheduleData[selectedGroup][currentWeekType];

        if (!weekData || (Array.isArray(weekData) && weekData.length === 0)) {
            diaryContainer.innerHTML = `<div class="empty-state-container">${SVG_EMPTY_SCHEDULE}<p class="empty-state-title">Розклад відсутній</p><p class="empty-state-desc">Для вибраного тижня немає пар.</p></div>`;
            return;
        }

        const frag = document.createDocumentFragment();
        const todayLabel = ukDays[today.getDay()];

        const weekDates = {};
        const daysOrder = ['Понеділок', 'Вівторок', 'Середа', 'Четвер', "П'ятниця", 'Субота', 'Неділя'];
        for (let i = 0; i < daysOrder.length; i++) {
            const offset = (i + 1) - currentDayOfWeek + (weekOffset * 7);
            const d = new Date(today);
            d.setDate(today.getDate() + offset);
            const dayStr = String(d.getDate()).padStart(2, '0');
            const monthStr = String(d.getMonth() + 1).padStart(2, '0');
            weekDates[daysOrder[i]] = `${dayStr}.${monthStr}`;
        }

        const days = ['Понеділок', 'Вівторок', 'Середа', 'Четвер', "П'ятниця"];
        const substitutionsList = scheduleData[selectedGroup]['ПІДВІСКА'] || [];

        for (let d = 0; d < days.length; d++) {
            const day = days[d];
            const dateStr = weekDates[day];

            let pairs = [];
            if (weekData[day]) {
                pairs = [...weekData[day]];
            }

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
                dayEl.appendChild(buildLessonCard(pairs[p], day, lessonStatuses[pairs[p].number] || null));
            }
            frag.appendChild(dayEl);
        }

        // Week Navigator
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

        const finalFrag = document.createDocumentFragment();
        finalFrag.appendChild(weekNav);
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

    // ===== Share Schedule =====
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


    // ===== Calendar Export (.ics) =====
    function generateScheduleICS(group) {
        if (!scheduleData || !scheduleData[group]) return { ics: '', eventCount: 0 };
        const groupData = scheduleData[group];

        const pad = (n) => String(n).padStart(2, '0');
        const formatIcsDate = (date, timeStr) => {
            const [hh, mm] = timeStr.split(':').map(Number);
            const y = date.getFullYear();
            const m = pad(date.getMonth() + 1);
            const d = pad(date.getDate());
            return `${y}${m}${d}T${pad(hh)}${pad(mm)}00`;
        };

        const escapeIcal = (str) => {
            if (!str) return '';
            return String(str)
                .replace(/\\/g, '\\\\')
                .replace(/;/g, '\\;')
                .replace(/,/g, '\\,')
                .replace(/\n/g, '\\n');
        };

        const now = new Date();
        const nowStamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;

        const lines = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'PRODID:-//MPMEK//Розклад Студента//UK',
            'CALSCALE:GREGORIAN',
            'METHOD:PUBLISH',
            `X-WR-CALNAME:Розклад ${group}`,
            'X-WR-TIMEZONE:Europe/Kyiv',
            'BEGIN:VTIMEZONE',
            'TZID:Europe/Kyiv',
            'X-LIC-LOCATION:Europe/Kyiv',
            'BEGIN:STANDARD',
            'TZOFFSETFROM:+0300',
            'TZOFFSETTO:+0200',
            'TZNAME:EET',
            'DTSTART:19701025T030000',
            'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
            'END:STANDARD',
            'BEGIN:DAYLIGHT',
            'TZOFFSETFROM:+0200',
            'TZOFFSETTO:+0300',
            'TZNAME:EEST',
            'DTSTART:19700329T030000',
            'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
            'END:DAYLIGHT',
            'END:VTIMEZONE'
        ];

        // Start from Monday of current week
        const curDay = now.getDay();
        const diffToMon = (curDay + 6) % 7;
        const startMonday = new Date(now);
        startMonday.setDate(now.getDate() - diffToMon);
        startMonday.setHours(0, 0, 0, 0);

        // Generate for 14 weeks ahead
        const WEEKS_COUNT = 14;
        let eventCount = 0;

        for (let w = 0; w < WEEKS_COUNT; w++) {
            for (let d = 0; d < 6; d++) {
                const dayDate = new Date(startMonday);
                dayDate.setDate(startMonday.getDate() + (w * 7) + d);
                const dayName = UK_DAYS_ORDER[d];
                const weekType = getWeekType(dayDate);
                const weekSchedule = groupData[weekType] || groupData['ОСНОВНИЙ'];

                if (!weekSchedule || !weekSchedule[dayName]) continue;

                const lessons = weekSchedule[dayName];
                for (const lesson of lessons) {
                    if (!lesson || !lesson.subject) continue;
                    const bell = BELLS_SCHEDULE.find(b => b.num === lesson.number) || { start: '08:30', end: '09:50' };
                    const dtStart = formatIcsDate(dayDate, bell.start);
                    const dtEnd = formatIcsDate(dayDate, bell.end);
                    const datePrefix = `${dayDate.getFullYear()}${pad(dayDate.getMonth() + 1)}${pad(dayDate.getDate())}`;
                    const uid = `${datePrefix}-${lesson.number}-${group.replace(/[^a-zA-Z0-9]/g, '')}-${w}@mpmek.site`;

                    lines.push(
                        'BEGIN:VEVENT',
                        `UID:${uid}`,
                        `DTSTAMP:${nowStamp}`,
                        `DTSTART;TZID=Europe/Kyiv:${dtStart}`,
                        `DTEND;TZID=Europe/Kyiv:${dtEnd}`,
                        `SUMMARY:${lesson.number}. ${escapeIcal(lesson.subject)}`,
                        `DESCRIPTION:${escapeIcal(`Викладач: ${lesson.teacher || '—'}\nАудиторія: ${lesson.room || '—'}\nГрупа: ${group} (${weekType})`)}`,
                        `LOCATION:${escapeIcal(lesson.room ? `ауд. ${lesson.room}` : '')}`,
                        'STATUS:CONFIRMED',
                        'END:VEVENT'
                    );
                    eventCount++;
                }
            }
        }

        lines.push('END:VCALENDAR');
        return { ics: lines.join('\r\n'), eventCount };
    }

    async function exportCalendarICS() {
        if (!selectedGroup || !scheduleData || !scheduleData[selectedGroup]) {
            alert('Спочатку оберіть групу');
            return;
        }

        const { ics, eventCount } = generateScheduleICS(selectedGroup);
        if (!ics || eventCount === 0) {
            alert('Не знайдено занять для експорту');
            return;
        }

        const cleanGroupName = selectedGroup.replace(/[^a-zA-Z0-9А-Яа-яіІїЇєЄґҐ]/g, '_');
        const filename = `Rozklad_${cleanGroupName}.ics`;
        const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });

        if (navigator.canShare) {
            try {
                const file = new File([blob], filename, { type: 'text/calendar' });
                if (navigator.canShare({ files: [file] })) {
                    await navigator.share({
                        files: [file],
                        title: `Розклад ${selectedGroup}`,
                        text: `Розклад занять для групи ${selectedGroup}`
                    });
                    return;
                }
            } catch (err) {
                if (err.name === 'AbortError') return;
            }
        }

        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 1500);
    }

    function showShareDayPicker() {
        const days = [
            { idx: 1, label: 'Понеділок' },
            { idx: 2, label: 'Вівторок' },
            { idx: 3, label: 'Середа' },
            { idx: 4, label: 'Четвер' },
            { idx: 5, label: "П'ятниця" }
        ];

        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';

        const sheet = document.createElement('div');
        sheet.className = 'modal-sheet share-picker-sheet';

        let html = '<div class="modal-handle"></div>';
        html += '<h2 style="text-align:center;margin-bottom:1rem">Оберіть дію</h2>';
        html += `<button class="share-day-btn share-day-primary" id="exportIcsFromPickerBtn" style="margin-bottom:0.75rem;background:var(--surface-color);color:var(--text-color);border:1px solid var(--border-color);display:flex;align-items:center;justify-content:center;gap:8px">
            <svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg> Додати в Календар (.ics)
        </button>`;
        html += `<button class="share-day-btn share-day-primary" data-day="week">
            <svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2" fill="none"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg> Поділитися картинкою тижня
        </button>`;
        html += '<div class="share-days-grid">';

        for (const d of days) {
            html += `<button class="share-day-btn" data-day="${d.idx}">${d.label}</button>`;
        }

        html += '</div>';
        html += '<button class="modal-btn-cancel share-picker-cancel" style="width:100%;margin-top:0.75rem">Скасувати</button>';

        sheet.innerHTML = html;
        overlay.appendChild(sheet);
        document.body.appendChild(overlay);

        function closePicker() {
            overlay.remove();
        }

        sheet.querySelector('.share-picker-cancel').addEventListener('click', closePicker);
        const pickerIcsBtn = sheet.querySelector('#exportIcsFromPickerBtn');
        if (pickerIcsBtn) {
            pickerIcsBtn.addEventListener('click', () => {
                closePicker();
                exportCalendarICS();
            });
        }
        overlay.addEventListener('click', (e) => { if (e.target === overlay) closePicker(); });

        sheet.querySelectorAll('.share-day-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const day = btn.dataset.day;
                closePicker();
                const theme = document.body.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
                const url = `/api/schedule-image?group=${encodeURIComponent(selectedGroup)}&day=${day}&theme=${theme}&weekOffset=${weekOffset}`;
                _fetchAndShare(url, `rozklad-${selectedGroup}-${day}.png`, `Розклад ${selectedGroup}`, `Розклад для ${selectedGroup}`);
            });
        });
    }

    if (shareScheduleBtn) {
        shareScheduleBtn.addEventListener('click', showShareDayPicker);
    }

    // ===== App Initialization =====
    if (!selectedGroup) {
        showScreen('onboarding');
        if (scheduleData) renderGroupList();
    } else {
        navItems[0].classList.add('active');
        showScreen('schedule');
        if (scheduleData) {
            renderSchedule();
        }
    }

    // Background Stale-While-Revalidate refresh
    refreshSchedule(!scheduleData).catch(e => {
        console.warn('Schedule background refresh warning:', e);
    });

    // Live update interval for 'ЗАРАЗ' indicator every 60s
    setInterval(() => {
        if (scheduleData && selectedGroup && screens.schedule && !screens.schedule.classList.contains('hidden')) {
            renderSchedule();
        }
    }, 60000);
});

// Register Service Worker
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').catch(() => {});
    });
}
