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

const LESSON_TIMES = {
  1: { start: '08:30', end: '09:50' },
  2: { start: '10:00', end: '11:20' },
  3: { start: '11:50', end: '13:10' },
  4: { start: '13:20', end: '14:40' },
  5: { start: '14:50', end: '16:10' },
  6: { start: '16:20', end: '17:40' }
};

function normalizeGroup(g) {
  if (!g) return '';
  return g.split('-').map(p => {
    if (/^\d{2}$/.test(p) && parseInt(p) >= 20) return (parseInt(p) < 50 ? '20' : '19') + p;
    return p;
  }).join('-');
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

function getPairsForDay(scheduleData, groupName, dayName, weekOffset = 0) {
  const groupData = scheduleData[groupName];
  if (!groupData) return null;

  const types = Object.keys(groupData).filter(t => t !== 'ПІДВІСКА');
  if (types.length === 0) return null;

  const weekKey = getWeekKey(groupData);
  let weekData = groupData[weekKey];
  if (!weekData || typeof weekData !== 'object' || Array.isArray(weekData)) {
    weekData = groupData[types[0]];
  }

  const today = new Date();
  const currentDow = today.getDay() || 7;
  const dayIdx = Object.values(DAY_MAP).indexOf(dayName) + 1;
  const offset = dayIdx - currentDow + (weekOffset * 7);
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
  return { pairs, dateStr };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { group, day } = req.query;

  if (!group || !day) {
    return res.status(400).json({ error: 'group and day are required' });
  }

  const dayName = DAY_MAP[day.toLowerCase()];
  if (!dayName) {
    return res.status(400).json({ error: 'invalid day. Use: monday, tuesday, wednesday, thursday, friday, saturday, sunday' });
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
      return res.status(200).json({ group, day, lessons: [] });
    }

    const result = getPairsForDay(scheduleData, groupName, dayName);
    if (!result) {
      return res.status(200).json({ group, day, lessons: [] });
    }

    const lessons = result.pairs.map(p => {
      const times = LESSON_TIMES[p.number] || { start: '', end: '' };
      return {
        number: p.number,
        name: p.subject || '',
        teacher: p.teacher || '',
        room: p.room || '',
        time_start: times.start,
        time_end: times.end,
        isSubstitution: p.isSubstitution || false,
        substitutionType: p.substitutionType || null
      };
    });

    return res.status(200).json({
      group: groupName,
      day,
      date: result.dateStr,
      lessons
    });
  } catch (err) {
    console.error('schedule API error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
