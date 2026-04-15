(() => {
    'use strict';

    // ===== Constants =====
    const DAYS = ['Понеділок', 'Вівторок', 'Середа', 'Четвер', "П'ятниця"];
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
        bells: document.getElementById('sec-bells'),
        config: document.getElementById('sec-config')
    };

    // ===== PIN Authentication =====
    let pinCode = '';
    let verifiedPin = '';

    document.querySelectorAll('.pin-key[data-val]').forEach(btn => {
        btn.addEventListener('click', () => {
            if (pinCode.length >= 4) return;
            pinCode += btn.dataset.val;
            updatePinDots();
            if (pinCode.length === 4) {
                setTimeout(() => handlePinComplete(), 200);
            }
        });
    });

    document.getElementById('pinDelete').addEventListener('click', () => {
        pinCode = pinCode.slice(0, -1);
        updatePinDots();
        pinScreen.classList.remove('error');
    });

    function updatePinDots() {
        pinDots.forEach((dot, i) => {
            dot.dataset.filled = i < pinCode.length ? 'true' : 'false';
        });
    }

    async function handlePinComplete() {
        const deviceId = localStorage.getItem('adminDeviceId');
        if (!deviceId) {
            shakePin('Спершу увійдіть як адмін на сайті');
            return;
        }
        try {
            const resp = await fetch('/api/admin-config', {
                headers: { 'X-Admin-Pin': pinCode, 'X-Device-Id': deviceId }
            });
            if (resp.ok) {
                verifiedPin = pinCode;
                unlockAdmin();
            } else if (resp.status === 403) {
                shakePin('Пристрій не авторизовано');
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

    function unlockAdmin() {
        pinScreen.classList.add('hidden');
        adminPanel.classList.remove('hidden');
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
                    <button class="btn-icon" onclick="adminApp.renameGroup('${escAttr(name)}')" title="Перейменувати">
                        <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                    </button>
                    <button class="btn-icon danger" onclick="adminApp.deleteGroup('${escAttr(name)}')" title="Видалити">
                        <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
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
            const types = Object.keys(scheduleData[group]);
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
                        <button class="btn-add-lesson" onclick="adminApp.addLesson('${escAttr(day)}')">+ Додати пару</button>
                    </div>
                </div>
            `;
        }).join('');
    }

    function lessonRowHtml(day, index, lesson) {
        return `
            <div class="lesson-row" data-day="${escAttr(day)}" data-index="${index}">
                <input type="number" class="input lesson-num-input" value="${lesson.number}" min="1" max="8" placeholder="#"
                    onchange="adminApp.updateLesson('${escAttr(day)}', ${index}, 'number', this.value)">
                <input type="text" class="input" value="${escAttr(lesson.subject)}" placeholder="Предмет"
                    onchange="adminApp.updateLesson('${escAttr(day)}', ${index}, 'subject', this.value)">
                <input type="text" class="input" value="${escAttr(lesson.teacher)}" placeholder="Викладач"
                    onchange="adminApp.updateLesson('${escAttr(day)}', ${index}, 'teacher', this.value)">
                <button class="btn-icon danger" onclick="adminApp.removeLesson('${escAttr(day)}', ${index})" title="Видалити">
                    <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
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
                        onchange="adminApp.updateBell(${n}, 'start', this.value)">
                    <span class="bell-sep">—</span>
                    <input type="time" class="input" value="${timeToInput(end)}"
                        onchange="adminApp.updateBell(${n}, 'end', this.value)">
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
    function renderConfig() {
        const token = localStorage.getItem('ghToken') || '';
        document.getElementById('ghTokenInput').value = token ? '••••••••' : '';
        document.getElementById('ghOwnerInput').value = localStorage.getItem('ghOwner') || 'nazarn1xyy';
        document.getElementById('ghRepoInput').value = localStorage.getItem('ghRepo') || 'mpmek';
    }

    document.getElementById('saveTokenBtn').addEventListener('click', () => {
        const token = document.getElementById('ghTokenInput').value.trim();
        if (!token || token === '••••••••') {
            showToast('Введіть токен', 'error');
            return;
        }
        localStorage.setItem('ghToken', token);
        localStorage.setItem('ghOwner', document.getElementById('ghOwnerInput').value.trim());
        localStorage.setItem('ghRepo', document.getElementById('ghRepoInput').value.trim());
        showToast('Токен збережено', 'success');
    });


    // ===== Publish (GitHub API) =====
    async function pushFileToGitHub(token, owner, repo, filePath, content, message, retries) {
        for (let attempt = 0; attempt <= (retries || 1); attempt++) {
            const getResp = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`, {
                headers: { 'Authorization': `token ${token}` }
            });
            if (!getResp.ok) throw new Error('Не вдалось отримати файл з GitHub: ' + getResp.status);
            const fileInfo = await getResp.json();
            const encoded = btoa(unescape(encodeURIComponent(content)));
            const putResp = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`, {
                method: 'PUT',
                headers: { 'Authorization': `token ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ message, content: encoded, sha: fileInfo.sha })
            });
            if (putResp.ok) return await putResp.json();
            if (putResp.status === 409 && attempt < (retries || 1)) {
                await new Promise(r => setTimeout(r, 1000));
                continue;
            }
            const err = await putResp.json();
            throw new Error(err.message || 'GitHub API error ' + putResp.status);
        }
    }

    publishBtn.addEventListener('click', async () => {
        const token = localStorage.getItem('ghToken');
        const owner = localStorage.getItem('ghOwner') || 'nazarn1xyy';
        const repo = localStorage.getItem('ghRepo') || 'mpmek';

        if (!token) {
            showToast('Спочатку додайте GitHub Token у Налаштуваннях', 'error');
            return;
        }

        publishBtn.disabled = true;
        statusText.textContent = '⏳ Публікація...';

        try {
            const newContent = JSON.stringify(scheduleData, null, 2);
            await pushFileToGitHub(token, owner, repo, 'app/schedule.json', newContent, '📅 Оновлено розклад через адмін-панель', 2);

            // Also bump sw.js cache version
            await bumpServiceWorkerCache(token, owner, repo);

            originalJson = JSON.stringify(scheduleData);
            hasChanges = false;
            publishBtn.disabled = true;
            statusText.textContent = '✅ Опубліковано! Vercel оновить сайт за ~30 сек.';
            showToast('Зміни опубліковано!', 'success');
        } catch (e) {
            statusText.textContent = '❌ Помилка: ' + e.message;
            showToast('Помилка публікації: ' + e.message, 'error');
            publishBtn.disabled = false;
        }
    });

    async function bumpServiceWorkerCache(token, owner, repo) {
        try {
            const swPath = 'app/sw.js';
            const resp = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${swPath}`, {
                headers: { 'Authorization': `token ${token}` }
            });
            if (!resp.ok) return;
            const swInfo = await resp.json();
            let swContent = decodeURIComponent(escape(atob(swInfo.content.replace(/\n/g, ''))));

            // Bump version number
            const match = swContent.match(/rozklad-v(\d+)/);
            if (match) {
                const newVer = parseInt(match[1]) + 1;
                swContent = swContent.replace(/rozklad-v\d+/, `rozklad-v${newVer}`);

                await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${swPath}`, {
                    method: 'PUT',
                    headers: {
                        'Authorization': `token ${token}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        message: '🔄 Бамп версії кешу SW (v' + newVer + ')',
                        content: btoa(unescape(encodeURIComponent(swContent))),
                        sha: swInfo.sha
                    })
                });
            }
        } catch (e) {
            console.warn('SW bump failed:', e);
        }
    }

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
        return String(s).replace(/&/g, '&amp;').replace(/'/g, "\\'").replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // ===== Public API (for inline onclick handlers) =====
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
        }
    };

    // ===== Keyboard: Escape to close modals =====
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            groupModal.classList.add('hidden');
            confirmModal.classList.add('hidden');
            weekModal.classList.add('hidden');
        }
    });

})();
