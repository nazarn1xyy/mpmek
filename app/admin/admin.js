(() => {
    'use strict';

    // ===== Constants =====
    const DAYS = ['Понеділок', 'Вівторок', 'Середа', 'Четвер', "П'ятниця"];
    const DAYS_FULL = ['Неділя', 'Понеділок', 'Вівторок', 'Середа', 'Четвер', "П'ятниця", 'Субота'];

    function getWeekdayForDate(ddmm) {
        const [dd, mm] = ddmm.split('.').map(Number);
        const year = new Date().getFullYear();
        const d = new Date(year, mm - 1, dd);
        const today = new Date();
        today.setHours(0,0,0,0);
        return { dayIndex: d.getDay(), name: DAYS_FULL[d.getDay()], isPast: d < today };
    }
    const DEFAULT_TIMES = {
        1: "08:30 - 10:05",
        2: "10:20 - 11:55",
        3: "12:10 - 13:45",
        4: "14:15 - 15:50",
        5: "16:00 - 17:35",
        6: "17:40 - 19:15"
    };

    // ===== State =====
    let scheduleData = null;
    let originalJson = '';
    let hasChanges = false;

    // ===== DOM refs =====
    const pinScreen = document.getElementById('pinScreen');
    const adminPanel = document.getElementById('adminPanel');
    const pinHint = document.getElementById('pinHint');
    const pinDots = document.querySelectorAll('.pin-dot');
    const publishBtn = document.getElementById('publishBtn');
    const statusText = document.getElementById('statusText');
    const toast = document.getElementById('toast');

    // Sections
    const sections = {
        groups: document.getElementById('sec-groups'),
        schedule: document.getElementById('sec-schedule'),
        subs: document.getElementById('sec-subs'),
        bells: document.getElementById('sec-bells'),
        config: document.getElementById('sec-config')
    };

    // Track new substitutions added in this session (for push notification)
    let newSubsAdded = [];

    // ===== PIN Authentication =====
    let pinCode = '';
    let verifiedPin = '';

    // Event delegation on the keypad — one listener for all buttons.
    // Using `click` which fires reliably on all browsers (iOS, Android, desktop).
    const keypad = document.querySelector('.pin-keypad');
    keypad.addEventListener('click', (e) => {
        const btn = e.target.closest('.pin-key');
        if (!btn) return;

        if (btn.id === 'pinDelete') {
            pinCode = pinCode.slice(0, -1);
            updatePinDots();
            pinScreen.classList.remove('error');
            return;
        }

        const val = btn.dataset.val;
        if (!val) return; // empty spacer
        if (pinCode.length >= 4) return;
        pinCode += val;
        updatePinDots();
        if (pinCode.length === 4) {
            setTimeout(() => handlePinComplete(), 200);
        }
    });

    function updatePinDots() {
        pinDots.forEach((dot, i) => {
            dot.dataset.filled = i < pinCode.length ? 'true' : 'false';
        });
    }

    async function handlePinComplete() {
        const authToken = localStorage.getItem('authToken');
        if (!authToken) {
            shakePin('Спершу увійдіть як адмін на сайті');
            return;
        }
        try {
            const resp = await fetch('/api/admin-config', {
                headers: {
                    'X-Admin-Pin': pinCode,
                    'Authorization': 'Bearer ' + authToken
                }
            });
            if (resp.ok) {
                verifiedPin = pinCode;
                unlockAdmin();
            } else if (resp.status === 403) {
                shakePin('Потрібен акаунт адміна');
            } else if (resp.status === 429) {
                shakePin('Забагато спроб. Зачекайте');
            } else {
                shakePin('Невірний PIN-код');
            }
        } catch {
            shakePin('Помилка з\'єднання');
        }
    }

    function shakePin(msg) {
        pinScreen.classList.add('error');
        pinHint.textContent = msg;
        pinCode = '';
        setTimeout(() => {
            updatePinDots();
            pinScreen.classList.remove('error');
        }, 600);
    }

    async function unlockAdmin() {
        pinScreen.classList.add('hidden');
        adminPanel.classList.remove('hidden');
        await loadAdminConfig();
        loadSchedule();
    }

    // ===== Navigation =====
    document.querySelectorAll('.sidebar-item').forEach(item => {
        item.addEventListener('click', () => {
            const target = item.dataset.section;
            document.querySelectorAll('.sidebar-item').forEach(s => s.classList.remove('active'));
            item.classList.add('active');
            Object.values(sections).forEach(s => s.classList.remove('active'));
            sections[target].classList.add('active');

            if (target === 'subs') renderSubsSection();
            if (target === 'bells') renderBells();
            if (target === 'config') renderConfig();
        });
    });

    // ===== Data Loading =====
    async function loadSchedule() {
        try {
            statusText.textContent = 'Завантаження даних...';
            const resp = await fetch('../schedule.json?t=' + Date.now());
            scheduleData = await resp.json();

            // Extract settings if present
            if (!scheduleData._settings) {
                scheduleData._settings = { lessonTimes: { ...DEFAULT_TIMES } };
            }

            originalJson = JSON.stringify(scheduleData);
            hasChanges = false;
            publishBtn.disabled = true;
            statusText.textContent = 'Дані завантажено • ' + countGroups() + ' груп';
            renderGroups();
            renderScheduleSelects();
        } catch (e) {
            statusText.textContent = '❌ Помилка завантаження: ' + e.message;
        }
    }

    function countGroups() {
        return Object.keys(scheduleData).filter(k => k !== '_settings').length;
    }

    function markChanged() {
        hasChanges = JSON.stringify(scheduleData) !== originalJson;
        publishBtn.disabled = !hasChanges;
        statusText.textContent = hasChanges
            ? '⚠️ Є незбережені зміни'
            : 'Дані завантажено • ' + countGroups() + ' груп';
    }

    // ===== Groups Section =====
    function renderGroups() {
        const container = document.getElementById('groupsList');
        const groups = Object.keys(scheduleData).filter(k => k !== '_settings').sort();

        if (groups.length === 0) {
            container.innerHTML = '<p class="placeholder-text">Немає груп. Додайте першу!</p>';
            return;
        }

        container.innerHTML = groups.map(name => `
            <div class="group-card">
                <span class="group-card-name">${escHtml(name)}</span>
                <div class="group-card-actions">
                    <button class="btn-icon" data-action="renameGroup" data-name="${escAttr(name)}" title="Перейменувати" aria-label="Перейменувати групу ${escAttr(name)}">
                        <svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                    </button>
                    <button class="btn-icon danger" data-action="deleteGroup" data-name="${escAttr(name)}" title="Видалити" aria-label="Видалити групу ${escAttr(name)}">
                        <svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                    </button>
                </div>
            </div>
        `).join('');
    }

    // Add Group
    document.getElementById('addGroupBtn').addEventListener('click', () => {
        openGroupModal('Додати групу', '', (name) => {
            if (scheduleData[name]) {
                showToast('Група вже існує', 'error');
                return;
            }
            scheduleData[name] = { "ОСНОВНИЙ РОЗКЛАД": {} };
            markChanged();
            renderGroups();
            renderScheduleSelects();
            showToast('Групу додано', 'success');
        });
    });

    // ===== Group Modal =====
    const groupModal = document.getElementById('groupModal');
    const groupNameInput = document.getElementById('groupNameInput');
    const groupModalTitle = document.getElementById('groupModalTitle');
    let groupModalCallback = null;

    function openGroupModal(title, value, cb) {
        groupModalTitle.textContent = title;
        groupNameInput.value = value;
        groupModalCallback = cb;
        groupModal.classList.remove('hidden');
        setTimeout(() => groupNameInput.focus(), 100);
    }

    document.getElementById('groupModalCancel').addEventListener('click', () => {
        groupModal.classList.add('hidden');
    });

    document.getElementById('groupModalOk').addEventListener('click', () => {
        const name = groupNameInput.value.trim().toUpperCase();
        if (!name) {
            showToast('Введіть назву групи', 'error');
            return;
        }
        groupModal.classList.add('hidden');
        if (groupModalCallback) groupModalCallback(name);
    });

    groupModal.addEventListener('click', e => {
        if (e.target === groupModal) groupModal.classList.add('hidden');
    });

    // ===== Confirm Modal =====
    const confirmModal = document.getElementById('confirmModal');
    let confirmCallback = null;

    function openConfirm(title, text, cb) {
        document.getElementById('confirmTitle').textContent = title;
        document.getElementById('confirmText').textContent = text;
        confirmCallback = cb;
        confirmModal.classList.remove('hidden');
    }

    document.getElementById('confirmCancel').addEventListener('click', () => {
        confirmModal.classList.add('hidden');
    });

    document.getElementById('confirmOk').addEventListener('click', () => {
        confirmModal.classList.add('hidden');
        if (confirmCallback) confirmCallback();
    });

    confirmModal.addEventListener('click', e => {
        if (e.target === confirmModal) confirmModal.classList.add('hidden');
    });

    // ===== Schedule Section =====
    const schedGroupSelect = document.getElementById('schedGroupSelect');
    const schedWeekSelect = document.getElementById('schedWeekSelect');
    const schedEditor = document.getElementById('schedEditor');

    function renderScheduleSelects() {
        const groups = Object.keys(scheduleData).filter(k => k !== '_settings').sort();
        const currentGroup = schedGroupSelect.value;

        schedGroupSelect.innerHTML = '<option value="">Оберіть групу...</option>' +
            groups.map(g => `<option value="${escAttr(g)}"${g === currentGroup ? ' selected' : ''}>${escHtml(g)}</option>`).join('');

        updateWeekTypes();
    }

    function updateWeekTypes() {
        const group = schedGroupSelect.value;
        schedWeekSelect.innerHTML = '<option value="">Тип тижня...</option>';

        if (group && scheduleData[group]) {
            const types = Object.keys(scheduleData[group]).filter(t => t !== 'ПІДВІСКА');
            schedWeekSelect.innerHTML += types.map(t =>
                `<option value="${escAttr(t)}">${escHtml(t)}</option>`
            ).join('');
        }
    }

    schedGroupSelect.addEventListener('change', () => {
        updateWeekTypes();
        schedEditor.innerHTML = '<p class="placeholder-text">Оберіть тип тижня для редагування</p>';
    });

    schedWeekSelect.addEventListener('change', () => {
        renderScheduleEditor();
    });

    function renderScheduleEditor() {
        const group = schedGroupSelect.value;
        const weekType = schedWeekSelect.value;

        if (!group || !weekType || !scheduleData[group] || !scheduleData[group][weekType]) {
            schedEditor.innerHTML = '<p class="placeholder-text">Оберіть групу та тип тижня</p>';
            return;
        }

        const weekData = scheduleData[group][weekType];

        schedEditor.innerHTML = DAYS.map(day => {
            const lessons = weekData[day] || [];
            return `
                <div class="day-block" data-day="${escAttr(day)}">
                    <div class="day-block-header">
                        <span>${escHtml(day)}</span>
                    </div>
                    <div class="day-block-body">
                        ${lessons.map((l, i) => lessonRowHtml(day, i, l)).join('')}
                        <button class="btn-add-lesson" data-action="addLesson" data-day="${escAttr(day)}">+ Додати пару</button>
                    </div>
                </div>
            `;
        }).join('');
    }

    function lessonRowHtml(day, index, lesson) {
        return `
            <div class="lesson-row" data-day="${escAttr(day)}" data-index="${index}">
                <input type="number" class="input lesson-num-input" value="${lesson.number}" min="1" max="8" placeholder="#"
                    data-action="updateLesson" data-day="${escAttr(day)}" data-index="${index}" data-field="number">
                <input type="text" class="input" value="${escAttr(lesson.subject)}" placeholder="Предмет"
                    data-action="updateLesson" data-day="${escAttr(day)}" data-index="${index}" data-field="subject">
                <input type="text" class="input" value="${escAttr(lesson.teacher)}" placeholder="Викладач"
                    data-action="updateLesson" data-day="${escAttr(day)}" data-index="${index}" data-field="teacher">
                <button class="btn-icon danger" data-action="removeLesson" data-day="${escAttr(day)}" data-index="${index}" title="Видалити" aria-label="Видалити пару">
                    <svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
            </div>
        `;
    }

    // Add Week Type
    const weekModal = document.getElementById('weekModal');

    document.getElementById('addWeekTypeBtn').addEventListener('click', () => {
        const group = schedGroupSelect.value;
        if (!group) {
            showToast('Спочатку оберіть групу', 'error');
            return;
        }
        weekModal.classList.remove('hidden');
    });

    document.getElementById('weekModalCancel').addEventListener('click', () => {
        weekModal.classList.add('hidden');
    });

    document.getElementById('weekModalOk').addEventListener('click', () => {
        const group = schedGroupSelect.value;
        const type = document.getElementById('weekTypeSelect').value;
        weekModal.classList.add('hidden');

        if (scheduleData[group][type]) {
            showToast('Цей тип вже існує', 'error');
            return;
        }

        scheduleData[group][type] = {};
        markChanged();
        updateWeekTypes();
        showToast('Тип тижня додано', 'success');
    });

    weekModal.addEventListener('click', e => {
        if (e.target === weekModal) weekModal.classList.add('hidden');
    });

    // ===== Substitutions Section =====
    const subsGroupSelect = document.getElementById('subsGroupSelect');
    const subsEditor = document.getElementById('subsEditor');
    const subModal = document.getElementById('subModal');

    function renderSubsSection() {
        const groups = Object.keys(scheduleData).filter(k => k !== '_settings').sort();
        const current = subsGroupSelect.value;
        subsGroupSelect.innerHTML = '<option value="">Оберіть групу...</option>' +
            groups.map(g => `<option value="${escAttr(g)}"${g === current ? ' selected' : ''}>${escHtml(g)}</option>`).join('');
        renderSubsEditor();
    }

    subsGroupSelect.addEventListener('change', () => renderSubsEditor());

    function renderSubsEditor() {
        const group = subsGroupSelect.value;
        if (!group || !scheduleData[group]) {
            subsEditor.innerHTML = '<p class="placeholder-text">Оберіть групу для редагування замін</p>';
            return;
        }

        const subs = scheduleData[group]['ПІДВІСКА'] || [];

        // Group by date
        const byDate = {};
        subs.forEach((s, i) => {
            if (!byDate[s.date]) byDate[s.date] = [];
            byDate[s.date].push({ ...s, _idx: i });
        });

        // Sort dates
        const dates = Object.keys(byDate).sort((a, b) => {
            const [da, ma] = a.split('.').map(Number);
            const [db, mb] = b.split('.').map(Number);
            return (ma * 100 + da) - (mb * 100 + db);
        });

        let html = '<button class="btn-primary" data-action="openAddSub" style="align-self:flex-start;margin-bottom:12px">+ Додати заміну</button>';

        if (dates.length === 0) {
            html += '<p class="placeholder-text">Немає замін. Додайте першу!</p>';
        } else {
            html += dates.map(date => {
                const info = getWeekdayForDate(date);
                const pastClass = info.isPast ? ' sub-date-past' : '';
                const pastLabel = info.isPast ? ' <span class="sub-past-label">минуло</span>' : '';
                return `
                <div class="sub-date-group${pastClass}">
                    <div class="sub-date-header">
                        <span>⚡ ${escHtml(date)} (${info.name})${pastLabel}</span>
                        <button class="btn-icon danger" data-action="deleteSubDate" data-date="${escAttr(date)}" title="Видалити всі заміни за цю дату" aria-label="Видалити всі заміни за ${escAttr(date)}">
                            <svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                        </button>
                    </div>
                    <div class="sub-date-body">
                        ${byDate[date].sort((a, b) => a.number - b.number).map(s => `
                            <div class="sub-row">
                                <input type="number" class="input lesson-num-input" value="${s.number}" min="1" max="8"
                                    data-action="updateSub" data-idx="${s._idx}" data-field="number">
                                <input type="text" class="input" value="${escAttr(s.subject)}" placeholder="Предмет"
                                    data-action="updateSub" data-idx="${s._idx}" data-field="subject">
                                <input type="text" class="input" value="${escAttr(s.teacher)}" placeholder="Викладач"
                                    data-action="updateSub" data-idx="${s._idx}" data-field="teacher">
                                <button class="btn-icon danger" data-action="removeSub" data-idx="${s._idx}" title="Видалити" aria-label="Видалити заміну">
                                    <svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                                </button>
                            </div>
                        `).join('')}
                    </div>
                </div>`;
            }).join('');
        }

        subsEditor.innerHTML = html;
    }

    // Sub modal handlers
    document.getElementById('subModalCancel').addEventListener('click', () => {
        subModal.classList.add('hidden');
    });

    subModal.addEventListener('click', e => {
        if (e.target === subModal) subModal.classList.add('hidden');
    });

    document.getElementById('subModalOk').addEventListener('click', () => {
        const group = subsGroupSelect.value;
        if (!group) return;

        const dateRaw = document.getElementById('subDateInput').value;
        const number = parseInt(document.getElementById('subNumberInput').value);
        const subject = document.getElementById('subSubjectInput').value.trim();
        const teacher = document.getElementById('subTeacherInput').value.trim();

        if (!dateRaw) { showToast('Оберіть дату', 'error'); return; }
        if (!number || number < 1) { showToast('Введіть номер пари', 'error'); return; }
        if (!subject) { showToast('Введіть предмет', 'error'); return; }

        // Check for weekends
        const pickedDate = new Date(dateRaw);
        const pickedDay = pickedDate.getDay();
        if (pickedDay === 0 || pickedDay === 6) {
            showToast('Не можна додати заміну на вихідний (' + DAYS_FULL[pickedDay] + ')', 'error');
            return;
        }

        // Convert YYYY-MM-DD to DD.MM
        const parts = dateRaw.split('-');
        const date = parts[2] + '.' + parts[1];

        if (!scheduleData[group]['ПІДВІСКА']) {
            scheduleData[group]['ПІДВІСКА'] = [];
        }

        const newSub = { date, number, subject, teacher };
        scheduleData[group]['ПІДВІСКА'].push(newSub);

        // Track for push notification
        newSubsAdded.push({ group, ...newSub });

        subModal.classList.add('hidden');
        markChanged();
        renderSubsEditor();
        showToast('Заміну додано', 'success');
    });

    // ===== Bells Section =====
    function renderBells() {
        const times = scheduleData?._settings?.lessonTimes || DEFAULT_TIMES;
        const container = document.getElementById('bellsEditor');

        container.innerHTML = [1,2,3,4,5,6].map(n => {
            const parts = (times[n] || '').split(' - ');
            const start = parts[0] || '';
            const end = parts[1] || '';
            return `
                <div class="bell-row">
                    <span class="bell-label">${n} пара</span>
                    <input type="time" class="input" value="${timeToInput(start)}"
                        data-action="updateBell" data-num="${n}" data-part="start">
                    <span class="bell-sep">—</span>
                    <input type="time" class="input" value="${timeToInput(end)}"
                        data-action="updateBell" data-num="${n}" data-part="end">
                </div>
            `;
        }).join('');
    }

    function timeToInput(t) {
        // "08:30" → "08:30"
        return t.trim();
    }

    function inputToTime(v) {
        // "08:30" → "08:30"
        return v;
    }

    // ===== Config Section =====
    // GitHub token is now stored server-side in GITHUB_TOKEN env var.
    // No need to load/save from client.
    async function loadAdminConfig() {
        // Clean up legacy localStorage values for security
        localStorage.removeItem('ghToken');
        localStorage.removeItem('ghOwner');
        localStorage.removeItem('ghRepo');
        localStorage.removeItem('adminDeviceId');
    }

    function renderConfig() {
        const tokenInput = document.getElementById('ghTokenInput');
        const ownerInput = document.getElementById('ghOwnerInput');
        const repoInput = document.getElementById('ghRepoInput');
        if (tokenInput) {
            tokenInput.value = '';
            tokenInput.placeholder = 'Зберігається на сервері (env GITHUB_TOKEN)';
            tokenInput.disabled = true;
        }
        if (ownerInput) { ownerInput.value = 'nazarn1xyy'; ownerInput.disabled = true; }
        if (repoInput) { repoInput.value = 'mpmek'; repoInput.disabled = true; }
        const saveBtn = document.getElementById('saveTokenBtn');
        if (saveBtn) saveBtn.style.display = 'none';
    }

    // No-op for legacy HTML button (config is server-side now)
    document.getElementById('saveTokenBtn')?.addEventListener('click', () => {
        showToast('Налаштування зберігаються на сервері', 'success');
    });


    // ===== Publish (via server endpoint /api/admin-publish) =====
    publishBtn.addEventListener('click', async () => {
        const authToken = localStorage.getItem('authToken');
        if (!authToken || !verifiedPin) {
            showToast('Сесія втрачена. Увійдіть знову', 'error');
            return;
        }

        publishBtn.disabled = true;
        statusText.textContent = '⏳ Публікація...';

        try {
            const resp = await fetch('/api/admin-config?action=publish', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Admin-Pin': verifiedPin,
                    'Authorization': 'Bearer ' + authToken
                },
                body: JSON.stringify({ schedule: scheduleData })
            });
            const data = await resp.json().catch(() => ({}));
            if (!resp.ok) throw new Error(data.error || 'HTTP ' + resp.status);

            // Send push + Telegram notifications about new substitutions
            if (newSubsAdded.length > 0) {
                statusText.textContent = '⏳ Надсилаємо сповіщення про заміни...';
                const notifyBody = JSON.stringify({ substitutions: newSubsAdded });
                const notifyHeaders = {
                    'Content-Type': 'application/json',
                    'X-Admin-Pin': verifiedPin,
                    'Authorization': 'Bearer ' + authToken
                };
                try {
                    await Promise.all([
                        fetch('/api/notify-subs', { method: 'POST', headers: notifyHeaders, body: notifyBody }),
                        fetch('/api/telegram-notify', { method: 'POST', headers: notifyHeaders, body: notifyBody }),
                    ]);
                    showToast('Опубліковано + сповіщення (web + Telegram)', 'success');
                } catch (e) {
                    console.warn('Notify failed:', e);
                    showToast('Опубліковано (сповіщення не вдалось)', 'success');
                }
                newSubsAdded = [];
            } else {
                showToast('Зміни опубліковано!', 'success');
            }

            originalJson = JSON.stringify(scheduleData);
            hasChanges = false;
            publishBtn.disabled = true;
            statusText.textContent = '✅ Опубліковано! Vercel оновить сайт за ~30 сек.';
        } catch (e) {
            statusText.textContent = '❌ Помилка: ' + e.message;
            showToast('Помилка публікації: ' + e.message, 'error');
            publishBtn.disabled = false;
        }
    });

    // ===== Toast =====
    let toastTimer = null;
    function showToast(msg, type = 'success') {
        toast.textContent = msg;
        toast.className = 'toast ' + type;
        toast.classList.remove('hidden');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toast.classList.add('hidden'), 3000);
    }

    // ===== Helpers =====
    function escHtml(s) {
        const d = document.createElement('div');
        d.textContent = s;
        return d.innerHTML;
    }

    function escAttr(s) {
        // HTML-entity encode for use inside quoted attributes.
        // Safe now that we use data-* + event delegation (no JS string contexts).
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    // ===== Actions API (called by delegated event listeners below) =====
    window.adminApp = {
        deleteGroup(name) {
            openConfirm('Видалити групу', `Ви впевнені, що хочете видалити "${name}"?`, () => {
                delete scheduleData[name];
                markChanged();
                renderGroups();
                renderScheduleSelects();
                showToast('Групу видалено', 'success');
            });
        },

        renameGroup(oldName) {
            openGroupModal('Перейменувати групу', oldName, (newName) => {
                if (newName === oldName) return;
                if (scheduleData[newName]) {
                    showToast('Група з такою назвою вже існує', 'error');
                    return;
                }
                scheduleData[newName] = scheduleData[oldName];
                delete scheduleData[oldName];
                markChanged();
                renderGroups();
                renderScheduleSelects();
                showToast('Групу перейменовано', 'success');
            });
        },

        addLesson(day) {
            const group = schedGroupSelect.value;
            const weekType = schedWeekSelect.value;
            if (!group || !weekType) return;

            if (!scheduleData[group][weekType][day]) {
                scheduleData[group][weekType][day] = [];
            }

            const lessons = scheduleData[group][weekType][day];
            const nextNum = lessons.length > 0 ? lessons[lessons.length - 1].number + 1 : 1;

            lessons.push({ number: nextNum, subject: '', teacher: '' });
            markChanged();
            renderScheduleEditor();
        },

        removeLesson(day, index) {
            const group = schedGroupSelect.value;
            const weekType = schedWeekSelect.value;
            if (!group || !weekType) return;

            scheduleData[group][weekType][day].splice(index, 1);
            if (scheduleData[group][weekType][day].length === 0) {
                delete scheduleData[group][weekType][day];
            }
            markChanged();
            renderScheduleEditor();
        },

        updateLesson(day, index, field, value) {
            const group = schedGroupSelect.value;
            const weekType = schedWeekSelect.value;
            if (!group || !weekType) return;

            if (field === 'number') {
                scheduleData[group][weekType][day][index][field] = parseInt(value) || 1;
            } else {
                scheduleData[group][weekType][day][index][field] = value;
            }
            markChanged();
        },

        updateBell(num, part, value) {
            if (!scheduleData._settings) scheduleData._settings = { lessonTimes: { ...DEFAULT_TIMES } };
            const times = scheduleData._settings.lessonTimes;
            const parts = (times[num] || '').split(' - ');

            if (part === 'start') {
                times[num] = inputToTime(value) + ' - ' + (parts[1] || '');
            } else {
                times[num] = (parts[0] || '') + ' - ' + inputToTime(value);
            }
            markChanged();
        },

        // Substitutions
        openAddSub() {
            const group = subsGroupSelect.value;
            if (!group) { showToast('Спочатку оберіть групу', 'error'); return; }
            // Default to tomorrow
            const tmrw = new Date();
            tmrw.setDate(tmrw.getDate() + 1);
            document.getElementById('subDateInput').value = tmrw.toISOString().split('T')[0];
            document.getElementById('subNumberInput').value = '';
            document.getElementById('subSubjectInput').value = '';
            document.getElementById('subTeacherInput').value = '';
            subModal.classList.remove('hidden');
            setTimeout(() => document.getElementById('subNumberInput').focus(), 100);
        },

        removeSub(idx) {
            const group = subsGroupSelect.value;
            if (!group || !scheduleData[group]['ПІДВІСКА']) return;
            scheduleData[group]['ПІДВІСКА'].splice(idx, 1);
            if (scheduleData[group]['ПІДВІСКА'].length === 0) {
                delete scheduleData[group]['ПІДВІСКА'];
            }
            markChanged();
            renderSubsEditor();
            showToast('Заміну видалено', 'success');
        },

        updateSub(idx, field, value) {
            const group = subsGroupSelect.value;
            if (!group || !scheduleData[group]['ПІДВІСКА']) return;
            if (field === 'number') {
                scheduleData[group]['ПІДВІСКА'][idx][field] = parseInt(value) || 1;
            } else {
                scheduleData[group]['ПІДВІСКА'][idx][field] = value;
            }
            markChanged();
        },

        deleteSubDate(date) {
            const group = subsGroupSelect.value;
            if (!group || !scheduleData[group]['ПІДВІСКА']) return;
            openConfirm('Видалити заміни', `Видалити всі заміни за ${date}?`, () => {
                scheduleData[group]['ПІДВІСКА'] = scheduleData[group]['ПІДВІСКА'].filter(s => s.date !== date);
                if (scheduleData[group]['ПІДВІСКА'].length === 0) {
                    delete scheduleData[group]['ПІДВІСКА'];
                }
                markChanged();
                renderSubsEditor();
                showToast('Заміни видалено', 'success');
            });
        }
    };

    // ===== Event delegation (replaces inline onclick/onchange) =====
    document.addEventListener('click', (e) => {
        const el = e.target.closest('[data-action]');
        if (!el) return;
        const action = el.dataset.action;
        const ds = el.dataset;
        switch (action) {
            case 'renameGroup': return adminApp.renameGroup(ds.name);
            case 'deleteGroup': return adminApp.deleteGroup(ds.name);
            case 'addLesson': return adminApp.addLesson(ds.day);
            case 'removeLesson': return adminApp.removeLesson(ds.day, parseInt(ds.index, 10));
            case 'openAddSub': return adminApp.openAddSub();
            case 'deleteSubDate': return adminApp.deleteSubDate(ds.date);
            case 'removeSub': return adminApp.removeSub(parseInt(ds.idx, 10));
        }
    });

    document.addEventListener('change', (e) => {
        const el = e.target.closest('[data-action]');
        if (!el) return;
        const action = el.dataset.action;
        const ds = el.dataset;
        switch (action) {
            case 'updateLesson':
                return adminApp.updateLesson(ds.day, parseInt(ds.index, 10), ds.field, el.value);
            case 'updateSub':
                return adminApp.updateSub(parseInt(ds.idx, 10), ds.field, el.value);
            case 'updateBell':
                return adminApp.updateBell(parseInt(ds.num, 10), ds.part, el.value);
        }
    });

    // ===== Keyboard: Escape to close modals =====
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            groupModal.classList.add('hidden');
            confirmModal.classList.add('hidden');
            weekModal.classList.add('hidden');
            subModal.classList.add('hidden');
        }
    });

})();
