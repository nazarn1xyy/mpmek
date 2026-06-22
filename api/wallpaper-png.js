const satori = require('satori').default;
const { Resvg } = require('@resvg/resvg-js');
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

const THEMES = {
  dark: {
    background: '#0A0A0A',
    cardBg: '#1A1A1A',
    cardActiveBg: '#1E3A5F',
    textPrimary: '#FFFFFF',
    textSecondary: '#888888',
    accent: '#3B82F6',
    numBg: '#333333',
    numColor: '#888888',
    footerColor: '#555555'
  },
  light: {
    background: '#F5F5F5',
    cardBg: '#FFFFFF',
    cardActiveBg: '#DBEAFE',
    textPrimary: '#111111',
    textSecondary: '#666666',
    accent: '#3B82F6',
    numBg: '#E0E0E0',
    numColor: '#666666',
    footerColor: '#999999'
  }
};

let cachedFont = null;

async function loadFont() {
  if (cachedFont) return cachedFont;
  const url = 'https://fonts.gstatic.com/s/inter/v13/UcCO3FwrK3iLTeHuS_fvQtMwCp50KnMw2boKoduKmMEVuLyfAZ9hiJ-Ek-_EeA.woff2';
  const resp = await fetch(url);
  cachedFont = await resp.arrayBuffer();
  return cachedFont;
}

function buildSatoriTree(groupName, dayName, lessons, currentTime, dateStr, themeName) {
  const t = THEMES[themeName] || THEMES.dark;
  const activeIdx = findActiveLessonIndex(lessons, currentTime);
  const currentMin = parseTimeToMinutes(currentTime);
  const kyiv = getKyivDate();
  const dateLabel = `${kyiv.getDate()} ${UK_MONTHS[kyiv.getMonth()]}`;

  const header = {
    type: 'div',
    props: {
      style: { display: 'flex', flexDirection: 'column', marginBottom: 48 },
      children: [
        { type: 'span', props: { style: { fontSize: 56, fontWeight: 800, color: t.textPrimary, marginBottom: 8 }, children: groupName } },
        { type: 'span', props: { style: { fontSize: 40, fontWeight: 600, color: t.textPrimary, marginBottom: 4 }, children: dayName } },
        { type: 'span', props: { style: { fontSize: 30, fontWeight: 400, color: t.textSecondary }, children: dateLabel } }
      ]
    }
  };

  let bodyChildren;

  if (lessons.length === 0) {
    bodyChildren = [
      {
        type: 'div',
        props: {
          style: { display: 'flex', alignItems: 'center', justifyContent: 'center', marginTop: 400 },
          children: { type: 'span', props: { style: { fontSize: 42, fontWeight: 600, color: t.textSecondary }, children: 'Сьогодні пар немає' } }
        }
      }
    ];
  } else {
    bodyChildren = lessons.map((lesson, i) => {
      const times = LESSON_TIMES[lesson.number] || { start: '', end: '' };
      const isActive = i === activeIdx;
      const lessonEnd = parseTimeToMinutes(times.end);
      const isPast = lessonEnd !== null && currentMin !== null && currentMin > lessonEnd;
      const opacity = isPast ? 0.45 : 1;

      const subjectChildren = [
        { type: 'span', props: { style: { fontSize: 34, fontWeight: 700, color: t.textPrimary }, children: lesson.subject || lesson.name || '' } }
      ];

      if (isActive) {
        subjectChildren.push({
          type: 'span',
          props: { style: { fontSize: 22, fontWeight: 700, color: t.accent, marginLeft: 12 }, children: '● Зараз' }
        });
      }

      if (lesson.isSubstitution) {
        const isReplace = lesson.substitutionType === 'заміна';
        subjectChildren.push({
          type: 'span',
          props: {
            style: { fontSize: 20, fontWeight: 600, marginLeft: 12, color: isReplace ? '#FCD34D' : '#6EE7B7' },
            children: isReplace ? 'Заміна' : 'Підвіска'
          }
        });
      }

      const metaChildren = [
        { type: 'span', props: { style: { fontSize: 26, fontWeight: 600, color: t.textSecondary }, children: `${times.start} — ${times.end}` } }
      ];
      if (lesson.teacher) {
        metaChildren.push({ type: 'span', props: { style: { fontSize: 26, fontWeight: 400, color: t.textSecondary }, children: lesson.teacher } });
      }
      if (lesson.room) {
        metaChildren.push({ type: 'span', props: { style: { fontSize: 26, fontWeight: 400, color: t.textSecondary }, children: `ауд. ${lesson.room}` } });
      }

      const cardContent = {
        type: 'div',
        props: {
          style: { display: 'flex', flexDirection: 'column', flex: 1 },
          children: [
            { type: 'div', props: { style: { display: 'flex', flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' }, children: subjectChildren } },
            { type: 'div', props: { style: { display: 'flex', flexDirection: 'row', gap: 20, marginTop: 8 }, children: metaChildren } }
          ]
        }
      };

      const numCircle = {
        type: 'div',
        props: {
          style: {
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: 64, height: 64, borderRadius: 32,
            background: isActive ? t.accent : t.numBg,
            flexShrink: 0
          },
          children: { type: 'span', props: { style: { fontSize: 28, fontWeight: 700, color: isActive ? '#FFFFFF' : t.numColor }, children: String(lesson.number) } }
        }
      };

      const cardInner = {
        type: 'div',
        props: {
          style: {
            display: 'flex', flexDirection: 'row', gap: 32,
            padding: 36, paddingLeft: 40, paddingRight: 40,
            borderRadius: 20,
            background: isActive ? t.cardActiveBg : t.cardBg,
            opacity,
            marginBottom: 24,
            alignItems: 'center'
          },
          children: [numCircle, cardContent]
        }
      };

      if (isActive) {
        return {
          type: 'div',
          props: {
            style: { display: 'flex', flexDirection: 'row', marginBottom: 24 },
            children: [
              { type: 'div', props: { style: { display: 'flex', width: 6, background: t.accent, borderTopLeftRadius: 20, borderBottomLeftRadius: 20 } } },
              {
                type: 'div',
                props: {
                  style: { display: 'flex', flexDirection: 'row', flex: 1, gap: 32, padding: 36, paddingLeft: 34, paddingRight: 40, borderRadius: 20, background: t.cardActiveBg, opacity },
                  children: [numCircle, cardContent]
                }
              }
            ]
          }
        };
      }

      return cardInner;
    });
  }

  const footer = {
    type: 'div',
    props: {
      style: { display: 'flex', justifyContent: 'center', marginTop: 'auto' },
      children: { type: 'span', props: { style: { fontSize: 24, color: t.footerColor }, children: 'Розклад Студента · mpmek.site' } }
    }
  };

  return {
    type: 'div',
    props: {
      style: {
        display: 'flex',
        flexDirection: 'column',
        width: 1170,
        height: 2532,
        background: t.background,
        padding: 100,
        paddingLeft: 40,
        paddingRight: 40,
        paddingBottom: 60
      },
      children: [header, ...bodyChildren, footer]
    }
  };
}

function buildErrorTree(message, themeName) {
  const t = THEMES[themeName] || THEMES.dark;
  return {
    type: 'div',
    props: {
      style: {
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: 1170, height: 2532, background: t.background,
        padding: 80
      },
      children: {
        type: 'div',
        props: {
          style: { display: 'flex', flexDirection: 'column', alignItems: 'center' },
          children: [
            { type: 'span', props: { style: { fontSize: 48, fontWeight: 700, color: t.textPrimary, marginBottom: 24 }, children: message } },
            { type: 'span', props: { style: { fontSize: 32, fontWeight: 400, color: t.textSecondary }, children: 'Розклад Студента · mpmek.site' } }
          ]
        }
      }
    }
  };
}

async function renderToPng(tree) {
  const fontData = await loadFont();
  const svg = await satori(tree, {
    width: 1170,
    height: 2532,
    fonts: [{ name: 'Inter', data: fontData, weight: 400, style: 'normal' }]
  });
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: 1170 } });
  const png = resvg.render().asPng();
  return Buffer.from(png);
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-cache');

  const { group, day, time, theme } = req.query;
  const themeName = theme === 'light' ? 'light' : 'dark';

  if (!group) {
    try {
      const tree = buildErrorTree('Вкажіть групу: ?group=ksm-2024-1', themeName);
      const png = await renderToPng(tree);
      res.setHeader('Content-Type', 'image/png');
      return res.status(400).send(png);
    } catch (err) {
      console.error('wallpaper-png error render:', err);
      return res.status(500).json({ error: 'Render failed' });
    }
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
      const tree = buildErrorTree('Групу не знайдено', themeName);
      const png = await renderToPng(tree);
      res.setHeader('Content-Type', 'image/png');
      return res.status(404).send(png);
    }

    const kyiv = getKyivDate();
    let dayKey = day || DAY_MAP_REVERSE[kyiv.getDay()];
    const dayName = DAY_MAP[dayKey.toLowerCase()] || DAY_MAP[dayKey];

    if (!dayName) {
      const tree = buildErrorTree('Невірний день', themeName);
      const png = await renderToPng(tree);
      res.setHeader('Content-Type', 'image/png');
      return res.status(400).send(png);
    }

    const currentTime = time || `${String(kyiv.getHours()).padStart(2, '0')}:${String(kyiv.getMinutes()).padStart(2, '0')}`;

    const result = getPairsForDay(scheduleData, groupName, dayName);
    const lessons = result ? result.pairs : [];

    const tree = buildSatoriTree(groupName, dayName, lessons, currentTime, result?.dateStr || '', themeName);
    const png = await renderToPng(tree);

    res.setHeader('Content-Type', 'image/png');
    return res.status(200).send(png);
  } catch (err) {
    console.error('wallpaper-png error:', err);
    try {
      const tree = buildErrorTree('Помилка завантаження розкладу', themeName);
      const png = await renderToPng(tree);
      res.setHeader('Content-Type', 'image/png');
      return res.status(500).send(png);
    } catch {
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
};
