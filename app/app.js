document.addEventListener('DOMContentLoaded', async () => {
    // ===== State =====
    let scheduleData = null;
    let selectedGroup = localStorage.getItem('selectedGroup');
    let currentWeekType = 'ОСНОВНИЙ РОЗКЛАД';
    let isDarkTheme = localStorage.getItem('theme') === 'dark';
    let _hwCache = null; // cached homework object

    const LESSON_TIMES = {
        1: "08:30 - 10:05",
        2: "10:20 - 11:55",
        3: "12:10 - 13:45",
        4: "14:15 - 15:50",
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
    const navItems = document.querySelectorAll('.nav-item');
    const themeToggle = document.getElementById('themeToggle');
    const changeGroupBtn = document.getElementById('changeGroupBtn');
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

    themeToggle.addEventListener('change', (e) => {
        const dark = e.target.checked;
        document.body.classList.add('theme-transitioning');
        document.body.setAttribute('data-theme', dark ? 'dark' : '');
        if (!dark) document.body.removeAttribute('data-theme');
        localStorage.setItem('theme', dark ? 'dark' : 'light');
        setTimeout(() => document.body.classList.remove('theme-transitioning'), 350);
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

        if (screenId === 'schedule' && selectedGroup && scheduleData) {
            renderSchedule();
        } else if (screenId === 'homework') {
            renderHomeworkTab();
        }
    }

    // ===== Week Type Toggle =====
    weekTypeToggle.addEventListener('click', () => {
        if (!scheduleData || !scheduleData[selectedGroup]) return;
        const availableTypes = Object.keys(scheduleData[selectedGroup]);
        if (availableTypes.length === 0) return;

        let currentIndex = availableTypes.indexOf(currentWeekType);
        if (currentIndex === -1) currentIndex = 0;
        currentWeekType = availableTypes[(currentIndex + 1) % availableTypes.length];

        weekTypeToggle.textContent = currentWeekType.split(' ')[0];
        renderSchedule();
    });

    // ===== Load Data =====
    try {
        const response = await fetch('schedule.json');
        scheduleData = await response.json();
    } catch (e) {
        diaryContainer.innerHTML = `<div class="empty-state-container">${SVG_EMPTY_SCHEDULE}<p class="empty-state-title">Помилка завантаження</p><p class="empty-state-desc">Не вдалося завантажити розклад.</p></div>`;
        return;
    }

    // ===== Groups =====
    function renderGroupList(filter = '') {
        const frag = document.createDocumentFragment();
        const lowerFilter = filter.toLowerCase();
        const groups = Object.keys(scheduleData);

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
        div.innerHTML = `<div class="diary-item-header"><span class="diary-item-number">${pair.number} пара</span>${timeHtml}</div><div class="diary-item-subject">${pair.subject}</div>${teacherHtml}${savedHtml}<button class="homework-btn" data-key="${key}" data-subject="${pair.subject}" data-day="${dayLabel}">${btnIcon} ${btnLabel}</button>`;
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
            delete hw[delBtn.dataset.key];
            setHomework(hw);
            renderSchedule();
            return;
        }

        const hwDelCard = e.target.closest('.hw-card-delete');
        if (hwDelCard) {
            const hw = getHomework();
            delete hw[hwDelCard.dataset.key];
            setHomework(hw);
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
            const availableTypes = Object.keys(scheduleData[selectedGroup]);
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
        const todayLabel = ukDays[new Date().getDay()];

        if (currentWeekType === 'ПІДВІСКА') {
            const groupedByDate = {};
            for (let i = 0; i < weekData.length; i++) {
                const item = weekData[i];
                if (!groupedByDate[item.date]) groupedByDate[item.date] = [];
                groupedByDate[item.date].push(item);
            }

            const sortedDates = Object.keys(groupedByDate).sort();
            for (let d = 0; d < sortedDates.length; d++) {
                const date = sortedDates[d];
                const dayEl = document.createElement('div');
                dayEl.className = 'diary-day';

                const title = document.createElement('h2');
                title.textContent = date;
                dayEl.appendChild(title);

                const pairs = groupedByDate[date].sort((a, b) => a.number - b.number);
                for (let p = 0; p < pairs.length; p++) {
                    dayEl.appendChild(buildLessonCard(pairs[p], date, hw));
                }
                frag.appendChild(dayEl);
            }
        } else {
            const days = ['Понеділок', 'Вівторок', 'Середа', 'Четвер', 'П\'ятниця'];
            for (let d = 0; d < days.length; d++) {
                const day = days[d];
                if (!weekData[day] || weekData[day].length === 0) continue;

                const dayEl = document.createElement('div');
                dayEl.className = 'diary-day';

                const title = document.createElement('h2');
                title.textContent = day;
                
                const isToday = currentWeekType !== 'ПІДВІСКА' && day === todayLabel;
                if (isToday) {
                    dayEl.classList.add('is-today');
                    dayEl.id = 'today-marker';
                    const badge = document.createElement('span');
                    badge.className = 'today-badge';
                    badge.textContent = 'Сьогодні';
                    title.appendChild(badge);
                }

                dayEl.appendChild(title);

                const pairs = [...weekData[day]].sort((a, b) => a.number - b.number);
                for (let p = 0; p < pairs.length; p++) {
                    dayEl.appendChild(buildLessonCard(pairs[p], day, hw));
                }
                frag.appendChild(dayEl);
            }
        }

        diaryContainer.innerHTML = '';
        diaryContainer.appendChild(frag);

        if (currentWeekType !== 'ПІДВІСКА') {
            requestAnimationFrame(() => {
                const todayMarker = document.getElementById('today-marker');
                if (todayMarker) {
                    // Small delay to ensure render is complete
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

    // ===== Init =====
    if (!selectedGroup) {
        showScreen('onboarding');
        renderGroupList();
    } else {
        navItems[0].classList.add('active');
        showScreen('schedule');
    }
});

// PWA Service Worker Registration
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').catch(() => {});
    });
}
