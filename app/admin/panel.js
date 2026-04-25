(() => {
    'use strict';

    // ===== User session state =====
    let currentUser = null; // { username, displayName, group, role }
    let authToken = localStorage.getItem('authToken');

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
    let undoStack = [];
    let lastSavedJson = '';
    let undoInProgress = false;
    let actionLogs = [];

    // ===== DOM refs =====
    const loginScreen = document.getElementById('loginScreen');
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
        homework: document.getElementById('sec-homework'),
        bells: document.getElementById('sec-bells'),
        users: document.getElementById('sec-users'),
        config: document.getElementById('sec-config')
    };

    // Track new substitutions added in this session (for push notification)
    let newSubsAdded = [];

    // ===== Login Screen =====
    const loginHint = document.getElementById('loginHint');
    const loginSubmitBtn = document.getElementById('loginSubmit');

    let loginBusy = false;
    function doLogin() {
        if (loginBusy) return;
        const u = document.getElementById('loginUsername').value.trim().toLowerCase();
        const p = document.getElementById('loginPassword').value;
        if (!u || !p) {
            loginHint.textContent = 'Введіть логін і пароль';
            loginHint.style.color = '#ff4444';
            return;
        }
        loginBusy = true;
        loginSubmitBtn.disabled = true;
        loginSubmitBtn.textContent = 'Вхід...';
        loginHint.textContent = '';
        fetch('/api/auth?action=login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: u, password: p })
        })
        .then(r => r.json().then(d => ({ ok: r.ok, data: d })))
        .then(res => {
            if (!res.ok) {
                loginHint.textContent = res.data.error || 'Помилка входу';
                loginHint.style.color = '#ff4444';
                loginSubmitBtn.disabled = false;
                loginSubmitBtn.textContent = 'Увійти';
                loginBusy = false;
                return;
            }
            authToken = res.data.token;
            localStorage.setItem('authToken', authToken);
            currentUser = res.data.user;
            proceedAfterLogin();
        })
        .catch(err => {
            loginHint.textContent = 'Помилка: ' + err.message;
            loginHint.style.color = '#ff4444';
            loginSubmitBtn.disabled = false;
            loginSubmitBtn.textContent = 'Увійти';
            loginBusy = false;
        });
    }

    // If admin-early.js loaded first, use its form submit handler + our callback
    // Otherwise attach our own listeners as fallback
    if (window._doLogin) {
        window._onLoginSuccess = function(data) {
            authToken = data.token;
            currentUser = data.user;
            proceedAfterLogin();
        };
    } else {
        const loginForm = document.getElementById('loginForm');
        if (loginForm) {
            loginForm.addEventListener('submit', (e) => { e.preventDefault(); doLogin(); });
        }
    }

    // Check if user already has a valid session
    (async function checkExistingSession() {
        if (!authToken) return;
        try {
            const resp = await fetch('/api/auth?action=me', {
                headers: { 'Authorization': 'Bearer ' + authToken }
            });
            if (resp.ok) {
                const data = await resp.json();
                currentUser = data.user;
                proceedAfterLogin();
            }
        } catch {}
    })();

    function proceedAfterLogin() {
        loginScreen.classList.add('hidden');
        if (currentUser.role === 'admin') {
            pinScreen.classList.remove('hidden');
        } else if (currentUser.role === 'starosta') {
            unlockStarosta();
        } else {
            loginHint.textContent = 'У вас немає доступу до адмін-панелі';
            loginHint.style.color = '#ff4444';
            loginScreen.classList.remove('hidden');
        }
    }

    // ===== PIN Authentication (Admin only) =====
    let verifiedPin = '';
    let pinCode = '';

    function updatePinDots() {
        pinDots.forEach((dot, i) => {
            dot.setAttribute('data-filled', i < pinCode.length ? 'true' : 'false');
        });
    }

    // If admin-early.js loaded first, use its PIN input handling + our callback
    if (typeof window._getPinCode === 'function') {
        window._onPinComplete = function(code) {
            pinCode = code;
            updatePinDots();
            handlePinComplete();
        };
    } else {
        // Fallback: attach our own PIN listeners
        document.querySelectorAll('.pin-key[data-val]').forEach(btn => {
            function handler(e) {
                e.preventDefault();
                if (pinCode.length >= 4) return;
                pinCode += btn.getAttribute('data-val');
                updatePinDots();
                if (pinCode.length === 4) {
                    setTimeout(() => handlePinComplete(), 200);
                }
            }
            btn.addEventListener('click', handler);
            btn.addEventListener('touchend', handler);
        });

        const pinDeleteBtn = document.getElementById('pinDelete');
        if (pinDeleteBtn) {
            function delHandler(e) {
                e.preventDefault();
                pinCode = pinCode.slice(0, -1);
                pinScreen.classList.remove('error');
                updatePinDots();
            }
            pinDeleteBtn.addEventListener('click', delHandler);
            pinDeleteBtn.addEventListener('touchend', delHandler);
        }
    }

    async function handlePinComplete() {
        if (!authToken) {
            showPinError('Сесія не знайдена', true);
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
            } else if (resp.status === 401) {
                showPinError('Сесія закінчилась', true);
            } else if (resp.status === 403) {
                showPinError('Немає прав адміна', true);
            } else if (resp.status === 429) {
                shakePin('Забагато спроб. Зачекайте хвилину');
            } else {
                shakePin('Невірний PIN-код');
            }
        } catch (e) {
            shakePin('Помилка з\'єднання');
        }
    }

    function shakePin(msg) {
        pinScreen.classList.add('error');
        pinHint.textContent = msg;
        pinHint.style.color = '#ff4444';
        pinHint.style.fontWeight = '600';
        pinCode = '';
        if (typeof window._pinReset === 'function') window._pinReset();
        updatePinDots();
        setTimeout(() => {
            pinScreen.classList.remove('error');
            pinHint.style.color = '';
            pinHint.style.fontWeight = '';
        }, 1500);
    }

    function showPinError(msg, showLoginBtn) {
        pinScreen.classList.add('error');
        pinHint.innerHTML = '';
        const msgEl = document.createElement('div');
        msgEl.textContent = msg;
        msgEl.style.cssText = 'color:#ff4444;font-weight:600;font-size:15px;margin-bottom:12px';
        pinHint.appendChild(msgEl);
        if (showLoginBtn) {
            const btn = document.createElement('a');
            btn.href = '../';
            btn.textContent = 'Перейти на головний сайт →';
            btn.style.cssText = 'display:inline-block;padding:10px 16px;background:#fff;color:#000;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px';
            pinHint.appendChild(btn);
        }
        pinCode = '';
        if (typeof window._pinReset === 'function') window._pinReset();
        updatePinDots();
    }

    // ===== Unlock: Admin (full access) =====
    async function unlockAdmin() {
        pinScreen.classList.add('hidden');
        adminPanel.classList.remove('hidden');
        await loadAdminConfig();
        loadSchedule();
    }

    // ===== Unlock: Starosta (limited access) =====
    function unlockStarosta() {
        adminPanel.classList.remove('hidden');
        // Hide admin-only sidebar items
        document.querySelectorAll('.sidebar-item').forEach(item => {
            const sec = item.dataset.section;
            if (['groups', 'schedule', 'bells', 'users', 'config'].includes(sec)) {
                item.style.display = 'none';
            }
        });
        // Hide publish button
        publishBtn.style.display = 'none';
        // Set header
        document.querySelector('.sidebar-header h2').textContent = '📋 ' + (currentUser.group || 'Староста');
        // Activate substitutions section by default
        document.querySelectorAll('.sidebar-item').forEach(s => s.classList.remove('active'));
        Object.values(sections).forEach(s => { if (s) s.classList.remove('active'); });
        const subsBtn = document.querySelector('.sidebar-item[data-section="subs"]');
        if (subsBtn) subsBtn.classList.add('active');
        if (sections.subs) sections.subs.classList.add('active');
        // Load schedule data
        loadSchedule();
    }

    // ===== Navigation =====
    document.querySelectorAll('.sidebar-item').forEach(item => {
        item.addEventListener('click', () => {
            const target = item.dataset.section;
            document.querySelectorAll('.sidebar-item').forEach(s => s.classList.remove('active'));
            item.classList.add('active');
            Object.values(sections).forEach(s => { if (s) s.classList.remove('active'); });
            if (sections[target]) sections[target].classList.add('active');

            if (target === 'subs') renderSubsSection();
            if (target === 'homework') renderHomeworkSection();
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
            lastSavedJson = originalJson;
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
        const currentJson = JSON.stringify(scheduleData);
        if (!undoInProgress && lastSavedJson && currentJson !== lastSavedJson) {
            undoStack.push(lastSavedJson);
            if (undoStack.length > 10) undoStack.shift();
        }
        lastSavedJson = currentJson;
        hasChanges = currentJson !== originalJson;
        publishBtn.disabled = !hasChanges;
        const ub = document.getElementById('undoBtn');
        if (ub) ub.disabled = undoStack.length === 0;
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
            <div class="lesson-row" draggable="true" data-day="${escAttr(day)}" data-index="${index}">
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
        if (currentUser && currentUser.role === 'starosta' && currentUser.group) {
            // Starosta: lock to their group
            subsGroupSelect.innerHTML = `<option value="${escAttr(currentUser.group)}" selected>${escHtml(currentUser.group)}</option>`;
            subsGroupSelect.disabled = true;
        } else {
            const current = subsGroupSelect.value;
            subsGroupSelect.innerHTML = '<option value="">Оберіть групу...</option>' +
                groups.map(g => `<option value="${escAttr(g)}"${g === current ? ' selected' : ''}>${escHtml(g)}</option>`).join('');
        }
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

    document.getElementById('subModalOk').addEventListener('click', async () => {
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

        const newSub = { date, number, subject, teacher };

        // Starosta: use API directly
        if (currentUser && currentUser.role === 'starosta') {
            subModal.classList.add('hidden');
            statusText.textContent = '⏳ Додаємо заміну...';
            try {
                const resp = await fetch('/api/pidveska', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + authToken
                    },
                    body: JSON.stringify({ group, entries: [newSub] })
                });
                const data = await resp.json();
                if (!resp.ok) throw new Error(data.error || 'HTTP ' + resp.status);
                showToast('Заміну додано!', 'success');
                // Reload schedule to show updated data
                await loadSchedule();
                renderSubsEditor();
            } catch (e) {
                showToast('Помилка: ' + e.message, 'error');
                statusText.textContent = '❌ ' + e.message;
            }
            return;
        }

        // Admin: local edit + publish later
        if (!scheduleData[group]['ПІДВІСКА']) {
            scheduleData[group]['ПІДВІСКА'] = [];
        }

        scheduleData[group]['ПІДВІСКА'].push(newSub);
        newSubsAdded.push({ group, ...newSub });

        subModal.classList.add('hidden');
        markChanged();
        renderSubsEditor();
        showToast('Заміну додано', 'success');
    });

    // ===== Homework Section (Starosta) =====
    let hwData = {}; // { "group|day|num": "text" }

    async function renderHomeworkSection() {
        const hwEditor = document.getElementById('hwEditor');
        if (!hwEditor) return;
        const group = currentUser && currentUser.group;
        if (!group || !scheduleData || !scheduleData[group]) {
            hwEditor.innerHTML = '<p class="placeholder-text">Група не знайдена у розкладі</p>';
            return;
        }

        // Load homework from server
        hwEditor.innerHTML = '<p class="placeholder-text">Завантаження ДЗ...</p>';
        try {
            const resp = await fetch('/api/homework?group=' + encodeURIComponent(group));
            if (resp.ok) {
                const data = await resp.json();
                hwData = data.texts || {};
            }
        } catch (e) {
            console.warn('Failed to load HW:', e);
        }

        // Determine current week schedule
        const groupData = scheduleData[group];
        const weekTypes = Object.keys(groupData).filter(k => k !== 'ПІДВІСКА' && k !== '_settings');
        // Use first available week type (simplified — could detect numerator/denominator)
        const weekType = weekTypes.includes('ОСНОВНИЙ РОЗКЛАД') ? 'ОСНОВНИЙ РОЗКЛАД' : weekTypes[0];
        if (!weekType) {
            hwEditor.innerHTML = '<p class="placeholder-text">Розклад групи порожній</p>';
            return;
        }

        const weekData = groupData[weekType];
        let html = `<p style="color:var(--text-muted);font-size:13px;margin-bottom:12px">Група: <strong>${escHtml(group)}</strong> • ${escHtml(weekType)}</p>`;

        DAYS.forEach(day => {
            const lessons = weekData[day] || [];
            if (lessons.length === 0) return;
            html += `<div class="sub-date-group" style="margin-bottom:16px">
                <div class="sub-date-header"><span>${escHtml(day)}</span></div>
                <div class="sub-date-body">`;
            lessons.forEach(l => {
                const key = `${group}|${day}|${l.number}`;
                const existing = hwData[key] || '';
                html += `
                    <div class="hw-row">
                        <div class="hw-label">
                            <span class="hw-num">${l.number}</span>
                            <span class="hw-subject">${escHtml(l.subject)}${l.teacher ? ' <span style="opacity:.5">(' + escHtml(l.teacher) + ')</span>' : ''}</span>
                        </div>
                        <div class="hw-input-wrap">
                            <input type="text" class="input" placeholder="Домашнє завдання..."
                                value="${escAttr(existing)}" data-hw-group="${escAttr(group)}" data-hw-day="${escAttr(day)}" data-hw-num="${l.number}">
                            <button class="btn-icon" data-action="saveHw" data-hw-group="${escAttr(group)}" data-hw-day="${escAttr(day)}" data-hw-num="${l.number}" title="Зберегти">
                                <svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none"><polyline points="20 6 9 17 4 12"/></svg>
                            </button>
                        </div>
                    </div>`;
            });
            html += `</div></div>`;
        });

        hwEditor.innerHTML = html;
    }

    // Save homework via API
    document.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-action="saveHw"]');
        if (!btn) return;
        const group = btn.dataset.hwGroup;
        const day = btn.dataset.hwDay;
        const number = btn.dataset.hwNum;
        const input = document.querySelector(`input[data-hw-group="${group}"][data-hw-day="${day}"][data-hw-num="${number}"]`);
        if (!input) return;
        const text = input.value.trim();
        try {
            const resp = await fetch('/api/homework', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + authToken
                },
                body: JSON.stringify({ group, day, number: parseInt(number), text })
            });
            if (!resp.ok) {
                const data = await resp.json().catch(() => ({}));
                throw new Error(data.error || 'HTTP ' + resp.status);
            }
            showToast('ДЗ збережено!', 'success');
            btn.style.color = '#4caf50';
            setTimeout(() => { btn.style.color = ''; }, 1500);
        } catch (err) {
            showToast('Помилка: ' + err.message, 'error');
        }
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
            lastSavedJson = originalJson;
            undoStack = [];
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

        async removeSub(idx) {
            const group = subsGroupSelect.value;
            if (!group || !scheduleData[group]['ПІДВІСКА']) return;
            const sub = scheduleData[group]['ПІДВІСКА'][idx];
            if (!sub) return;
            openConfirm('Видалити заміну', sub.date + ' пара ' + sub.number + ' — ' + (sub.subject || ''), async () => {

            // Starosta: use API
            if (currentUser && currentUser.role === 'starosta') {
                statusText.textContent = '⏳ Видаляємо заміну...';
                try {
                    const resp = await fetch('/api/pidveska', {
                        method: 'DELETE',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': 'Bearer ' + authToken
                        },
                        body: JSON.stringify({ group, date: sub.date, number: sub.number })
                    });
                    const data = await resp.json();
                    if (!resp.ok) throw new Error(data.error || 'HTTP ' + resp.status);
                    showToast('Заміну видалено!', 'success');
                    await loadSchedule();
                    renderSubsEditor();
                } catch (e) {
                    showToast('Помилка: ' + e.message, 'error');
                    statusText.textContent = '❌ ' + e.message;
                }
                return;
            }

            // Admin: local edit
            scheduleData[group]['ПІДВІСКА'].splice(idx, 1);
            if (scheduleData[group]['ПІДВІСКА'].length === 0) {
                delete scheduleData[group]['ПІДВІСКА'];
            }
            markChanged();
            renderSubsEditor();
            showToast('Заміну видалено', 'success');
            });
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
            openConfirm('Видалити заміни', `Видалити всі заміни за ${date}?`, async () => {
                // Starosta: delete each sub via API
                if (currentUser && currentUser.role === 'starosta') {
                    const subsForDate = scheduleData[group]['ПІДВІСКА'].filter(s => s.date === date);
                    statusText.textContent = '⏳ Видаляємо заміни...';
                    try {
                        for (const sub of subsForDate) {
                            await fetch('/api/pidveska', {
                                method: 'DELETE',
                                headers: {
                                    'Content-Type': 'application/json',
                                    'Authorization': 'Bearer ' + authToken
                                },
                                body: JSON.stringify({ group, date: sub.date, number: sub.number })
                            });
                        }
                        showToast('Заміни видалено!', 'success');
                        await loadSchedule();
                        renderSubsEditor();
                    } catch (e) {
                        showToast('Помилка: ' + e.message, 'error');
                    }
                    return;
                }

                // Admin: local edit
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

    // ===== NEW FEATURES =====

    // -- Action Log helper --
    function logAction(msg) {
        actionLogs.unshift({ t: new Date().toLocaleTimeString('uk'), u: currentUser?.username || '?', m: msg });
        if (actionLogs.length > 50) actionLogs.pop();
        const el = document.getElementById('actionLog');
        if (!el) return;
        el.innerHTML = actionLogs.map(e =>
            '<div style="padding:4px 0;border-bottom:1px solid var(--border)">' +
            e.t + ' <b>' + escHtml(e.u) + '</b>: ' + escHtml(e.m) + '</div>'
        ).join('');
    }

    // -- Undo Button --
    const undoBtn = document.getElementById('undoBtn');
    if (undoBtn) {
        undoBtn.addEventListener('click', () => {
            if (undoStack.length === 0) return;
            undoInProgress = true;
            scheduleData = JSON.parse(undoStack.pop());
            lastSavedJson = JSON.stringify(scheduleData);
            undoInProgress = false;
            hasChanges = JSON.stringify(scheduleData) !== originalJson;
            publishBtn.disabled = !hasChanges;
            undoBtn.disabled = undoStack.length === 0;
            statusText.textContent = hasChanges ? '⚠️ Є незбережені зміни' : 'Дані завантажено • ' + countGroups() + ' груп';
            renderGroups();
            renderScheduleSelects();
            showToast('↩ Скасовано', 'success');
            logAction('Undo');
        });
    }

    // -- Group Search --
    const groupSearchEl = document.getElementById('groupSearch');
    if (groupSearchEl) {
        groupSearchEl.addEventListener('input', () => {
            const q = groupSearchEl.value.trim().toLowerCase();
            document.querySelectorAll('#groupsList .group-card').forEach(c => {
                c.style.display = (c.querySelector('.group-card-name')?.textContent.toLowerCase() || '').includes(q) ? '' : 'none';
            });
        });
    }

    // -- Drag & Drop for Lessons --
    let dragDay = null, dragIdx = null;
    schedEditor.addEventListener('dragstart', e => {
        const r = e.target.closest('.lesson-row');
        if (!r) return;
        dragDay = r.dataset.day;
        dragIdx = +r.dataset.index;
        r.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
    });
    schedEditor.addEventListener('dragend', e => {
        const r = e.target.closest('.lesson-row');
        if (r) r.classList.remove('dragging');
    });
    schedEditor.addEventListener('dragover', e => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
    });
    schedEditor.addEventListener('drop', e => {
        e.preventDefault();
        const r = e.target.closest('.lesson-row');
        if (!r || dragDay === null) return;
        const tDay = r.dataset.day, tIdx = +r.dataset.index;
        if (dragDay === tDay && dragIdx === tIdx) return;
        const g = schedGroupSelect.value, wt = schedWeekSelect.value;
        if (!g || !wt) return;
        const src = scheduleData[g][wt][dragDay] || [];
        const item = src.splice(dragIdx, 1)[0];
        if (!item) return;
        if (!scheduleData[g][wt][tDay]) scheduleData[g][wt][tDay] = [];
        scheduleData[g][wt][tDay].splice(tIdx, 0, item);
        markChanged();
        renderScheduleEditor();
        logAction('Drag: ' + dragDay + '[' + dragIdx + '] → ' + tDay + '[' + tIdx + ']');
    });

    // -- Autosave Homework (debounced 1.5s) --
    let hwT = {};
    document.addEventListener('input', e => {
        const inp = e.target.closest('input[data-hw-group]');
        if (!inp) return;
        const k = inp.dataset.hwGroup + '|' + inp.dataset.hwDay + '|' + inp.dataset.hwNum;
        clearTimeout(hwT[k]);
        hwT[k] = setTimeout(async () => {
            try {
                const r = await fetch('/api/homework', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + authToken },
                    body: JSON.stringify({ group: inp.dataset.hwGroup, day: inp.dataset.hwDay, number: +inp.dataset.hwNum, text: inp.value.trim() })
                });
                if (r.ok) {
                    const b = inp.parentElement?.querySelector('[data-action="saveHw"]');
                    if (b) { b.style.color = '#4caf50'; setTimeout(() => b.style.color = '', 1500); }
                }
            } catch {}
        }, 1500);
    });

    // -- Unsaved Changes Warning --
    window.addEventListener('beforeunload', e => {
        if (hasChanges) { e.preventDefault(); e.returnValue = ''; }
    });

    // -- Session Timeout (30 min) --
    let sessTimer = null;
    function resetSess() {
        clearTimeout(sessTimer);
        sessTimer = setTimeout(() => {
            showToast('Сесія закінчилась (30 хв неактивності)', 'error');
            setTimeout(doLogout, 2000);
        }, 30 * 60 * 1000);
    }
    ['click', 'keydown', 'scroll', 'touchstart'].forEach(ev =>
        document.addEventListener(ev, resetSess, { passive: true })
    );
    resetSess();

    // -- Logout --
    function doLogout() {
        localStorage.removeItem('authToken');
        location.reload();
    }
    document.getElementById('logoutBtn')?.addEventListener('click', () => {
        openConfirm('Вийти', 'Ви впевнені, що хочете вийти?', doLogout);
    });

    // -- Copy Schedule Between Groups --
    document.getElementById('copyScheduleBtn')?.addEventListener('click', () => {
        const tg = schedGroupSelect.value;
        if (!tg) { showToast('Спочатку оберіть групу', 'error'); return; }
        const gs = Object.keys(scheduleData).filter(k => k !== '_settings' && k !== tg).sort();
        if (!gs.length) { showToast('Немає інших груп', 'error'); return; }
        const src = prompt('Скопіювати розклад з групи:\n\n' + gs.join(', '));
        if (!src || !scheduleData[src]) { if (src) showToast('Група не знайдена', 'error'); return; }
        openConfirm('Копіювати розклад', 'Перезаписати ' + tg + ' даними з ' + src + '?', () => {
            scheduleData[tg] = JSON.parse(JSON.stringify(scheduleData[src]));
            markChanged();
            updateWeekTypes();
            renderScheduleEditor();
            showToast('Скопійовано з ' + src, 'success');
            logAction('Copy: ' + src + ' → ' + tg);
        });
    });

    // -- Copy Week Type --
    document.getElementById('copyWeekBtn')?.addEventListener('click', () => {
        const g = schedGroupSelect.value, wt = schedWeekSelect.value;
        if (!g || !wt) { showToast('Оберіть групу та тип', 'error'); return; }
        const t = prompt('Копіювати "' + wt + '" в новий тип:\n(ЧИСЕЛЬНИК, ЗНАМЕННИК, або нова назва)');
        if (!t) return;
        const doCopy = () => {
            scheduleData[g][t] = JSON.parse(JSON.stringify(scheduleData[g][wt]));
            markChanged();
            updateWeekTypes();
            showToast('Скопійовано → ' + t, 'success');
            logAction('Copy week: ' + wt + ' → ' + t);
        };
        if (scheduleData[g][t]) openConfirm('Перезаписати', '"' + t + '" вже існує. Перезаписати?', doCopy);
        else doCopy();
    });

    // -- Auto-clean Old Substitutions --
    document.getElementById('cleanOldSubsBtn')?.addEventListener('click', () => {
        const g = subsGroupSelect.value;
        if (!g || !scheduleData[g]?.['ПІДВІСКА']?.length) {
            showToast('Немає замін для очищення', 'error');
            return;
        }
        const now = new Date();
        now.setHours(0, 0, 0, 0);
        const before = scheduleData[g]['ПІДВІСКА'].length;
        scheduleData[g]['ПІДВІСКА'] = scheduleData[g]['ПІДВІСКА'].filter(s => {
            const [d, m] = s.date.split('.').map(Number);
            return new Date(now.getFullYear(), m - 1, d) >= now;
        });
        if (!scheduleData[g]['ПІДВІСКА'].length) delete scheduleData[g]['ПІДВІСКА'];
        const rm = before - (scheduleData[g]['ПІДВІСКА']?.length || 0);
        if (rm > 0) {
            markChanged();
            renderSubsEditor();
            showToast('Видалено ' + rm + ' минулих замін', 'success');
            logAction('Clean subs: -' + rm);
        } else {
            showToast('Минулих замін не знайдено', 'success');
        }
    });

    // -- CSV Import --
    document.getElementById('csvImport')?.addEventListener('change', e => {
        const f = e.target.files[0];
        if (!f) return;
        const g = schedGroupSelect.value, wt = schedWeekSelect.value;
        if (!g || !wt) { showToast('Оберіть групу та тип тижня', 'error'); e.target.value = ''; return; }
        const reader = new FileReader();
        reader.onload = ev => {
            const lines = ev.target.result.split('\n').filter(l => l.trim());
            let day = '', n = 0;
            lines.forEach(line => {
                const p = line.split(/[;,\t]/).map(s => s.trim());
                if (p.length >= 3) {
                    if (p.length >= 4) day = p[0];
                    const off = p.length >= 4 ? 1 : 0;
                    const num = +p[off], subj = p[off + 1], teacher = p[off + 2] || '';
                    if (day && num && subj) {
                        if (!scheduleData[g][wt][day]) scheduleData[g][wt][day] = [];
                        scheduleData[g][wt][day].push({ number: num, subject: subj, teacher: teacher });
                        n++;
                    }
                } else if (p.length === 1 && p[0]) {
                    day = p[0];
                }
            });
            markChanged();
            renderScheduleEditor();
            showToast('Імпортовано ' + n + ' пар', 'success');
            logAction('CSV: ' + g + '/' + wt + ', +' + n);
        };
        reader.readAsText(f);
        e.target.value = '';
    });

    // -- Stats --
    async function loadStats() {
        const el = document.getElementById('statsGrid');
        if (!el) return;
        el.innerHTML = '<p style="color:var(--text-muted);font-size:13px">Завантаження...</p>';
        try {
            const gc = countGroups();
            let lc = 0, sc = 0;
            Object.keys(scheduleData).filter(k => k !== '_settings').forEach(g => {
                Object.keys(scheduleData[g]).forEach(w => {
                    if (w === 'ПІДВІСКА') sc += scheduleData[g][w]?.length || 0;
                    else Object.values(scheduleData[g][w]).forEach(ls => lc += ls.length);
                });
            });
            let pc = '—';
            try {
                const r = await fetch('/api/push?action=count', { headers: { 'Authorization': 'Bearer ' + authToken } });
                if (r.ok) { pc = (await r.json()).count ?? '—'; }
            } catch {}
            el.innerHTML = [
                ['' + gc, 'Груп'], ['' + lc, 'Пар'], ['' + sc, 'Замін'], ['' + pc, 'Push']
            ].map(([n, l]) => '<div class="stat-box"><span class="stat-num">' + n + '</span><span class="stat-label">' + l + '</span></div>').join('');
        } catch {
            el.innerHTML = '<p style="color:var(--danger);font-size:13px">Помилка</p>';
        }
    }

    // Load stats/users when navigating to their tabs
    document.querySelectorAll('.sidebar-item').forEach(i => {
        i.addEventListener('click', () => {
            if (i.dataset.section === 'config') loadStats();
            if (i.dataset.section === 'users') loadUsers();
        });
    });

    // -- Bulk Sub Add (+ Ще одну) --
    document.getElementById('subModalAddMore')?.addEventListener('click', async () => {
        const g = subsGroupSelect.value;
        if (!g) return;
        const dateRaw = document.getElementById('subDateInput').value;
        const num = +document.getElementById('subNumberInput').value;
        const subj = document.getElementById('subSubjectInput').value.trim();
        const teacher = document.getElementById('subTeacherInput').value.trim();
        if (!dateRaw) { showToast('Оберіть дату', 'error'); return; }
        if (!num || num < 1) { showToast('Введіть номер пари', 'error'); return; }
        if (!subj) { showToast('Введіть предмет', 'error'); return; }
        const pd = new Date(dateRaw);
        if (pd.getDay() === 0 || pd.getDay() === 6) { showToast('Не можна на вихідний', 'error'); return; }
        const parts = dateRaw.split('-');
        const date = parts[2] + '.' + parts[1];
        const newSub = { date, number: num, subject: subj, teacher };
        if (currentUser?.role === 'starosta') {
            try {
                const r = await fetch('/api/pidveska', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + authToken },
                    body: JSON.stringify({ group: g, entries: [newSub] })
                });
                if (!r.ok) { const d = await r.json(); throw new Error(d.error); }
                await loadSchedule();
                renderSubsEditor();
            } catch (e) { showToast('Помилка: ' + e.message, 'error'); return; }
        } else {
            if (!scheduleData[g]['ПІДВІСКА']) scheduleData[g]['ПІДВІСКА'] = [];
            scheduleData[g]['ПІДВІСКА'].push(newSub);
            newSubsAdded.push({ group: g, ...newSub });
            markChanged();
            renderSubsEditor();
        }
        showToast('Додано пару #' + num, 'success');
        logAction('Sub: ' + g + ' ' + date + ' #' + num);
        // Keep modal open, clear fields except date
        document.getElementById('subNumberInput').value = '';
        document.getElementById('subSubjectInput').value = '';
        document.getElementById('subTeacherInput').value = '';
        document.getElementById('subNumberInput').focus();
    });

    // -- Users Section --
    let usersLoaded = false;
    async function loadUsers() {
        const container = document.getElementById('usersList');
        if (!container) return;
        container.innerHTML = '<p class="placeholder-text">Завантаження...</p>';
        try {
            const resp = await fetch('/api/admin-config?action=users', {
                headers: {
                    'Authorization': 'Bearer ' + authToken,
                    'X-Admin-Pin': verifiedPin
                }
            });
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            const data = await resp.json();
            renderUsers(data.users || []);
            usersLoaded = true;
        } catch (e) {
            container.innerHTML = '<p class="placeholder-text" style="color:var(--danger)">Помилка: ' + escHtml(e.message) + '</p>';
        }
    }

    function renderUsers(users) {
        const container = document.getElementById('usersList');
        if (!container) return;
        const countEl = document.getElementById('usersCount');
        if (countEl) countEl.textContent = '(' + users.length + ')';
        if (users.length === 0) {
            container.innerHTML = '<p class="placeholder-text">Немає зареєстрованих користувачів</p>';
            return;
        }
        container.innerHTML = users.map(u => {
            const initials = (u.displayName || u.username).slice(0, 2).toUpperCase();
            const roleClass = u.role === 'admin' ? 'admin' : u.role === 'starosta' ? 'starosta' : 'user';
            const roleLabel = u.role === 'admin' ? 'Admin' : u.role === 'starosta' ? 'Староста' : 'User';
            const date = u.createdAt ? new Date(u.createdAt).toLocaleDateString('uk') : '';
            return '<div class="user-card" data-username="' + escAttr(u.username) + '">'
                + '<div class="user-avatar">' + escHtml(initials) + '</div>'
                + '<div class="user-info">'
                + '<div class="user-name">' + escHtml(u.displayName || u.username) + '</div>'
                + '<div class="user-meta">'
                + '<span>@' + escHtml(u.username) + '</span>'
                + (u.group ? ' <span>\uD83D\uDCDA ' + escHtml(u.group) + '</span>' : '')
                + (date ? ' <span>\uD83D\uDCC5 ' + date + '</span>' : '')
                + '</div></div>'
                + '<span class="user-badge ' + roleClass + '">' + roleLabel + '</span>'
                + '</div>';
        }).join('');
    }

    // -- User Search Filter --
    const userSearchEl = document.getElementById('userSearch');
    if (userSearchEl) {
        userSearchEl.addEventListener('input', () => {
            const q = userSearchEl.value.trim().toLowerCase();
            document.querySelectorAll('#usersList .user-card').forEach(c => {
                const text = (c.querySelector('.user-name')?.textContent + ' ' + c.querySelector('.user-meta')?.textContent).toLowerCase();
                c.style.display = text.includes(q) ? '' : 'none';
            });
        });
    }

})();
