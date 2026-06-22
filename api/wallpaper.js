const { getSchedule } = require('./_lib/db');

const DAY_MAP = {
  monday: 'Понеділок',
  tuesday: 'Вівторок',
  wednesday: 'Середа',
  thursday: 'Четвер',
  friday: "П'ятниця",
  saturday: 'Субота',
  sunday: 'Неділя'
};

const DAY_MAP_REVERSE = {
  0: 'sunday', 1: 'monday', 2: 'tuesday', 3: 'wednesday',
  4: 'thursday', 5: 'friday', 6: 'saturday'
};

const LESSON_TIMES = {
  1: { start: '08:30', end: '09:50' },
  2: { start: '10:00', end: '11:20' },
  3: { start: '11:50', end: '13:10' },
  4: { start: '13:20', end: '14:40' },
  5: { start: '14:50', end: '16:10' },
  6: { start: '16:20', end: '17:40' }
};

const UK_MONTHS = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня',
  'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'];

function normalizeGroup(g) {
  if (!g) return '';
  return g.split('-').map(p => {
    if (/^\d{2}$/.test(p) && parseInt(p) >= 20) return (parseInt(p) < 50 ? '20' : '19') + p;
    return p;
  }).join('-');
}

function getKyivDate() {
  // Vercel runs in UTC — add 3 hours fixed offset for Kyiv (UTC+3)
  const now = new Date();
  return new Date(now.getTime() + 3 * 60 * 60 * 1000);
}

function getWeekKey(groupData) {
  const types = Object.keys(groupData).filter(t => t !== 'ПІДВІСКА');
  const hasChis = types.includes('ЧИСЕЛЬНИК');
  const hasZnam = types.includes('ЗНАМЕННИК');
  if (!hasChis || !hasZnam) return 'ОСНОВНИЙ РОЗКЛАД';

  const now = new Date();
  const target = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  target.setUTCDate(target.getUTCDate() + 4 - (target.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const isoWeek = Math.ceil(((target.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return isoWeek % 2 === 0 ? 'ЧИСЕЛЬНИК' : 'ЗНАМЕННИК';
}

function getPairsForDay(scheduleData, groupName, dayName) {
  const groupData = scheduleData[groupName];
  if (!groupData) return null;

  const types = Object.keys(groupData).filter(t => t !== 'ПІДВІСКА');
  if (types.length === 0) return null;

  const weekKey = getWeekKey(groupData);
  let weekData = groupData[weekKey];
  if (!weekData || typeof weekData !== 'object' || Array.isArray(weekData)) {
    weekData = groupData[types[0]];
  }

  const kyiv = getKyivDate();
  const dateStr = String(kyiv.getDate()).padStart(2, '0') + '.' + String(kyiv.getMonth() + 1).padStart(2, '0');

  let pairs = weekData[dayName] ? [...weekData[dayName]] : [];
  const subs = groupData['ПІДВІСКА'] || [];
  subs.filter(s => s.date === dateStr).forEach(sub => {
    const replaces = pairs.some(p => parseInt(p.number) === parseInt(sub.number));
    pairs = pairs.filter(p => parseInt(p.number) !== parseInt(sub.number));
    pairs.push({ ...sub, isSubstitution: true, substitutionType: replaces ? 'заміна' : 'підвіска' });
  });

  if (pairs.length === 0) return null;
  pairs.sort((a, b) => parseInt(a.number) - parseInt(b.number));
  return { pairs, dateStr };
}

function parseTimeToMinutes(t) {
  if (!t || typeof t !== 'string') return null;
  const [h, m] = t.split(':').map(Number);
  if (isNaN(h) || isNaN(m)) return null;
  return h * 60 + m;
}

function findActiveLessonIndex(lessons, currentTime) {
  if (!currentTime) return -1;
  const currentMin = parseTimeToMinutes(currentTime);
  if (currentMin === null) return -1;
  for (let i = 0; i < lessons.length; i++) {
    const start = parseTimeToMinutes(LESSON_TIMES[lessons[i].number]?.start);
    const end = parseTimeToMinutes(LESSON_TIMES[lessons[i].number]?.end);
    if (start !== null && end !== null && currentMin >= start && currentMin <= end) {
      return i;
    }
  }
  return -1;
}

function renderErrorPage(message) {
  return `<!DOCTYPE html>
<html lang="uk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Розклад — Помилка</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: 1170px; height: 2532px;
    font-family: system-ui, -apple-system, sans-serif;
    display: flex; align-items: center; justify-content: center;
    background: #F5F5F5;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #0A0A0A; }
    .error-text { color: #FFFFFF; }
    .error-sub { color: #888888; }
  }
  @media (prefers-color-scheme: light) {
    .error-text { color: #111111; }
    .error-sub { color: #666666; }
  }
  .container { text-align: center; padding: 0 80px; }
  .error-text { font-size: 48px; font-weight: 700; margin-bottom: 24px; }
  .error-sub { font-size: 32px; font-weight: 400; }
</style>
</head>
<body>
  <div class="container">
    <div class="error-text">${message}</div>
    <div class="error-sub">Розклад Студента · mpmek.site</div>
  </div>
</body>
</html>`;
}

function renderWallpage(groupName, dayName, dayKey, lessons, currentTime, dateStr) {
  const activeIdx = findActiveLessonIndex(lessons, currentTime);
  const currentMin = parseTimeToMinutes(currentTime);

  const cardsHtml = lessons.length === 0
    ? `<div class="no-lessons">Сьогодні пар немає</div>`
    : lessons.map((lesson, i) => {
        const times = LESSON_TIMES[lesson.number] || { start: '', end: '' };
        const isActive = i === activeIdx;
        const lessonEnd = parseTimeToMinutes(times.end);
        const isPast = lessonEnd !== null && currentMin !== null && currentMin > lessonEnd;
        const opacityClass = isPast ? 'past' : '';
        const activeClass = isActive ? 'active' : '';
        const subBadge = lesson.isSubstitution
          ? `<span class="sub-badge ${lesson.substitutionType === 'заміна' ? 'sub-replace' : 'sub-add'}">${lesson.substitutionType === 'заміна' ? 'Заміна' : 'Підвіска'}</span>`
          : '';

        return `
      <div class="card ${activeClass} ${opacityClass}">
        <div class="lesson-num ${isActive ? 'num-active' : ''}">${lesson.number}</div>
        <div class="card-content">
          <div class="subject-row">
            <span class="subject">${lesson.subject || lesson.name || ''}</span>
            ${subBadge}
            ${isActive ? '<span class="now-badge">● Зараз</span>' : ''}
          </div>
          <div class="meta">
            <span class="time">${times.start} — ${times.end}</span>
            ${lesson.teacher ? `<span class="teacher">${lesson.teacher}</span>` : ''}
            ${lesson.room ? `<span class="room">ауд. ${lesson.room}</span>` : ''}
          </div>
        </div>
      </div>`;
      }).join('');

  const kyiv = getKyivDate();
  const dateLabel = `${kyiv.getDate()} ${UK_MONTHS[kyiv.getMonth()]}`;

  return `<!DOCTYPE html>
<html lang="uk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Розклад — ${groupName} — ${dayName}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: 1170px;
    height: 2532px;
    font-family: system-ui, -apple-system, sans-serif;
    overflow: hidden;
    padding: 100px 40px 60px;
    position: relative;
  }
  .header { margin-bottom: 48px; }
  .header-group { font-size: 56px; font-weight: 800; margin-bottom: 8px; }
  .header-day { font-size: 40px; font-weight: 600; margin-bottom: 4px; }
  .header-date { font-size: 30px; font-weight: 400; }

  /* ─── Light theme (default) ─── */
  body { background: #F5F5F5; color: #111111; }
  .header-group { color: #111111; }
  .header-day { color: #111111; }
  .header-date { color: #666666; }
  .card-content { flex: 1; min-width: 0; }
  .subject-row { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
  .card {
    background: #FFFFFF;
    border-radius: 24px;
    margin-bottom: 24px;
    padding: 36px 40px;
    display: flex;
    align-items: center;
    gap: 32px;
    transition: all 0.3s;
  }
  .card.active {
    background: #DBEAFE;
    border-left: 4px solid #3B82F6;
  }
  .card.past { opacity: 0.5; }
  .lesson-num {
    width: 64px; height: 64px;
    border-radius: 50%;
    background: #E0E0E0;
    color: #666666;
    display: flex; align-items: center; justify-content: center;
    font-size: 28px; font-weight: 700;
    flex-shrink: 0;
  }
  .lesson-num.num-active {
    background: #3B82F6;
    color: #FFFFFF;
  }
  .subject { font-size: 32px; font-weight: 700; color: #111111; }
  .meta { margin-top: 8px; display: flex; gap: 20px; flex-wrap: wrap; }
  .time { font-size: 26px; color: #666666; font-weight: 600; }
  .teacher { font-size: 26px; color: #666666; }
  .room { font-size: 26px; color: #666666; }
  .now-badge {
    font-size: 22px; font-weight: 700; color: #3B82F6;
    margin-left: 12px;
  }
  .sub-badge {
    font-size: 20px; font-weight: 600;
    padding: 4px 14px; border-radius: 10px;
    margin-left: 12px;
  }
  .sub-replace { background: #FEF3C7; color: #92400E; }
  .sub-add { background: #D1FAE5; color: #065F46; }
  .no-lessons {
    text-align: center;
    font-size: 42px; font-weight: 600;
    color: #666666;
    margin-top: 400px;
  }
  .footer {
    position: absolute;
    bottom: 60px; left: 0; right: 0;
    text-align: center;
    font-size: 24px;
    color: #999999;
  }

  /* ─── Dark theme ─── */
  @media (prefers-color-scheme: dark) {
    body { background: #0A0A0A; color: #FFFFFF; }
    .header-group { color: #FFFFFF; }
    .header-day { color: #FFFFFF; }
    .header-date { color: #888888; }
    .card {
      background: #1A1A1A;
    }
    .card.active {
      background: #1E3A5F;
      border-left: 4px solid #3B82F6;
    }
    .lesson-num {
      background: #333333;
      color: #888888;
    }
    .lesson-num.num-active {
      background: #3B82F6;
      color: #FFFFFF;
    }
    .subject { color: #FFFFFF; }
    .time { color: #888888; }
    .teacher { color: #888888; }
    .room { color: #888888; }
    .now-badge { color: #3B82F6; }
    .sub-replace { background: #78350F; color: #FCD34D; }
    .sub-add { background: #064E3B; color: #6EE7B7; }
    .no-lessons { color: #888888; }
    .footer { color: #555555; }
  }
</style>
</head>
<body>
  <div class="header">
    <div class="header-group">${groupName}</div>
    <div class="header-day">${dayName}</div>
    <div class="header-date">${dateLabel}</div>
  </div>
  <div class="lessons">
    ${cardsHtml}
  </div>
  <div class="footer">Розклад Студента · mpmek.site</div>
</body>
</html>`;
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');

  const { group, day, time } = req.query;

  if (!group) {
    return res.status(400).send(renderErrorPage('Вкажіть групу: ?group=ksm-2024-1'));
  }

  try {
    const scheduleData = await getSchedule();

    const ng = normalizeGroup(group);
    let groupName = null;
    for (const key of Object.keys(scheduleData)) {
      if (key === '_settings') continue;
      if (normalizeGroup(key).toLowerCase() === ng.toLowerCase() || key.toLowerCase() === group.toLowerCase()) {
        groupName = key;
        break;
      }
    }

    if (!groupName) {
      return res.status(404).send(renderErrorPage('Групу не знайдено'));
    }

    const kyiv = getKyivDate();
    let dayKey = day || DAY_MAP_REVERSE[kyiv.getDay()];
    const dayName = DAY_MAP[dayKey.toLowerCase()] || DAY_MAP[dayKey];

    if (!dayName) {
      return res.status(400).send(renderErrorPage('Невірний день. Використовуйте: monday, tuesday, ...'));
    }

    const currentTime = time || `${String(kyiv.getHours()).padStart(2, '0')}:${String(kyiv.getMinutes()).padStart(2, '0')}`;

    const result = getPairsForDay(scheduleData, groupName, dayName);
    const lessons = result ? result.pairs : [];

    const html = renderWallpage(groupName, dayName, dayKey, lessons, currentTime, result?.dateStr || '');
    return res.status(200).send(html);
  } catch (err) {
    console.error('wallpaper API error:', err);
    return res.status(500).send(renderErrorPage('Помилка завантаження розкладу'));
  }
};
