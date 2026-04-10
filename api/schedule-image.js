const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');
const path = require('path');
const fs = require('fs');

const UK_DAYS = ['Неділя', 'Понеділок', 'Вівторок', 'Середа', 'Четвер', "П'ятниця", 'Субота'];
const LESSON_TIMES = { 1: '08:30 - 09:50', 2: '10:00 - 11:20', 3: '11:50 - 13:10', 4: '13:20 - 14:40', 5: '16:00 - 17:20', 6: '17:40 - 19:00' };
const FONT = 'Inter';

let fontLoaded = false;
async function ensureFont() {
  if (fontLoaded) return;
  const localFont = path.join(__dirname, '_fonts', 'Inter-Regular.ttf');
  if (fs.existsSync(localFont)) {
    GlobalFonts.registerFromPath(localFont, 'Inter');
  } else {
    // Fallback: fetch variable font from Google Fonts
    try {
      const resp = await fetch('https://github.com/google/fonts/raw/main/ofl/inter/Inter%5Bopsz%2Cwght%5D.ttf');
      const buf = Buffer.from(await resp.arrayBuffer());
      GlobalFonts.register(buf, 'Inter');
    } catch {}
  }
  fontLoaded = true;
}

async function fetchSchedule() {
  const baseUrl = `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL}`;
  const resp = await fetch(`${baseUrl}/schedule.json`);
  const data = await resp.json();
  delete data._settings;
  return data;
}

function getPairsForDay(scheduleData, group, dayIdx) {
  const groupData = scheduleData[group];
  if (!groupData) return null;
  const dayName = UK_DAYS[dayIdx];

  let weekData = groupData['ОСНОВНИЙ РОЗКЛАД'];
  if (!weekData || typeof weekData !== 'object' || Array.isArray(weekData)) {
    const types = Object.keys(groupData).filter(t => t !== 'ПІДВІСКА');
    if (types.length === 0) return null;
    weekData = groupData[types[0]];
  }

  const today = new Date();
  const currentDow = today.getDay() || 7;
  const targetDow = dayIdx || 7;
  const offset = targetDow - currentDow;
  const d = new Date(today);
  d.setDate(today.getDate() + offset);
  const dateStr = String(d.getDate()).padStart(2, '0') + '.' + String(d.getMonth() + 1).padStart(2, '0');

  let pairs = weekData[dayName] ? [...weekData[dayName]] : [];
  const subs = groupData['ПІДВІСКА'] || [];
  subs.filter(s => s.date === dateStr).forEach(sub => {
    pairs = pairs.filter(p => parseInt(p.number) !== parseInt(sub.number));
    pairs.push({ ...sub, isSubstitution: true });
  });

  if (pairs.length === 0) return null;
  pairs.sort((a, b) => parseInt(a.number) - parseInt(b.number));
  return { pairs, dayName, dateStr };
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

function renderDayImage(group, data, dark) {
  const { pairs, dayName, dateStr } = data;
  const W = 600, padX = 32, cardH = 72, cardGap = 12, headerH = 120, footerH = 60;
  const H = headerH + pairs.length * (cardH + cardGap) + footerH + 20;

  const canvas = createCanvas(W * 2, H * 2);
  const ctx = canvas.getContext('2d');
  ctx.scale(2, 2);

  const bg = dark ? '#000' : '#fff';
  const fg = dark ? '#f5f5f5' : '#1a1a1a';
  const surface = dark ? '#111' : '#f5f5f5';
  const muted = '#888';
  const accent = dark ? '#fff' : '#000';
  const subColor = '#f59e0b';

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = fg;
  ctx.font = `bold 28px ${FONT}`;
  ctx.fillText(group, padX, 50);

  ctx.font = `bold 20px ${FONT}`;
  ctx.fillStyle = accent;
  ctx.fillText(dayName, padX, 82);

  ctx.font = `15px ${FONT}`;
  ctx.fillStyle = muted;
  ctx.fillText(dateStr, padX, 105);

  let y = headerH;
  for (const pair of pairs) {
    ctx.fillStyle = surface;
    roundRect(ctx, padX, y, W - padX * 2, cardH, 14);
    ctx.fill();

    if (pair.isSubstitution) {
      ctx.strokeStyle = subColor;
      ctx.lineWidth = 2;
      roundRect(ctx, padX, y, W - padX * 2, cardH, 14);
      ctx.stroke();
    }

    const cx = padX + 28, cy = y + cardH / 2;
    ctx.fillStyle = pair.isSubstitution ? subColor : accent;
    ctx.beginPath();
    ctx.arc(cx, cy, 18, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = pair.isSubstitution ? '#fff' : bg;
    ctx.font = `bold 16px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText(String(pair.number), cx, cy + 5.5);
    ctx.textAlign = 'left';

    ctx.fillStyle = fg;
    ctx.font = `600 16px ${FONT}`;
    ctx.fillText(truncText(ctx, pair.subject, W - padX * 2 - 80), padX + 56, y + 30);

    ctx.fillStyle = muted;
    ctx.font = `13px ${FONT}`;
    const time = LESSON_TIMES[pair.number] || '';
    const teacher = pair.teacher || '';
    const meta = [time, teacher].filter(Boolean).join('  ·  ');
    ctx.fillText(truncText(ctx, meta, W - padX * 2 - 80), padX + 56, y + 52);

    y += cardH + cardGap;
  }

  ctx.fillStyle = muted;
  ctx.font = `13px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.fillText('Розклад Студента · mpmek.site', W / 2, H - 24);
  ctx.textAlign = 'left';

  return canvas.toBuffer('image/png');
}

function renderWeekImage(group, scheduleData, dark) {
  const W = 600, padX = 32, cardH = 56, cardGap = 8, dayHeaderH = 44, topH = 80, footerH = 50;
  const today = new Date();
  const todayIdx = today.getDay();

  const weekData = [];
  let totalCards = 0, daysWithData = 0;

  for (let idx = 1; idx <= 5; idx++) {
    const data = getPairsForDay(scheduleData, group, idx);
    if (data && data.pairs.length > 0) {
      weekData.push({ ...data, idx });
      totalCards += data.pairs.length;
      daysWithData++;
    }
  }

  if (weekData.length === 0) return null;

  const H = topH + daysWithData * dayHeaderH + totalCards * (cardH + cardGap) + footerH + 20;
  const canvas = createCanvas(W * 2, H * 2);
  const ctx = canvas.getContext('2d');
  ctx.scale(2, 2);

  const bg = dark ? '#000' : '#fff';
  const fg = dark ? '#f5f5f5' : '#1a1a1a';
  const surface = dark ? '#111' : '#f5f5f5';
  const muted = '#888';
  const accent = dark ? '#fff' : '#000';
  const subColor = '#f59e0b';

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = fg;
  ctx.font = `bold 26px ${FONT}`;
  ctx.fillText(group, padX, 42);

  const monOffset = 1 - (today.getDay() || 7);
  const mon = new Date(today); mon.setDate(today.getDate() + monOffset);
  const fri = new Date(mon); fri.setDate(mon.getDate() + 4);
  const rangeStr = `${String(mon.getDate()).padStart(2, '0')}.${String(mon.getMonth() + 1).padStart(2, '0')} — ${String(fri.getDate()).padStart(2, '0')}.${String(fri.getMonth() + 1).padStart(2, '0')}`;

  ctx.fillStyle = muted;
  ctx.font = `14px ${FONT}`;
  ctx.fillText(rangeStr, padX, 64);

  let y = topH;
  for (const dayData of weekData) {
    const isToday = dayData.idx === todayIdx;

    ctx.fillStyle = isToday ? accent : fg;
    ctx.font = `bold 15px ${FONT}`;
    ctx.fillText(dayData.dayName.toUpperCase(), padX, y + 20);

    ctx.fillStyle = muted;
    ctx.font = `13px ${FONT}`;
    ctx.fillText(dayData.dateStr, padX + ctx.measureText(dayData.dayName.toUpperCase()).width + 10, y + 20);

    if (isToday) {
      const label = 'Сьогодні';
      ctx.font = `bold 10px ${FONT}`;
      const tw = ctx.measureText(label).width;
      const bx = W - padX - tw - 16;
      ctx.fillStyle = accent;
      roundRect(ctx, bx, y + 6, tw + 16, 20, 6);
      ctx.fill();
      ctx.fillStyle = bg;
      ctx.fillText(label, bx + 8, y + 20);
    }

    y += dayHeaderH;

    for (const pair of dayData.pairs) {
      ctx.fillStyle = surface;
      roundRect(ctx, padX, y, W - padX * 2, cardH, 12);
      ctx.fill();

      if (pair.isSubstitution) {
        ctx.strokeStyle = subColor;
        ctx.lineWidth = 1.5;
        roundRect(ctx, padX, y, W - padX * 2, cardH, 12);
        ctx.stroke();
      }

      const cx = padX + 22, cy = y + cardH / 2;
      ctx.fillStyle = pair.isSubstitution ? subColor : accent;
      ctx.beginPath();
      ctx.arc(cx, cy, 14, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = pair.isSubstitution ? '#fff' : bg;
      ctx.font = `bold 13px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText(String(pair.number), cx, cy + 4.5);
      ctx.textAlign = 'left';

      ctx.fillStyle = fg;
      ctx.font = `600 14px ${FONT}`;
      ctx.fillText(truncText(ctx, pair.subject, W - padX * 2 - 70), padX + 46, y + 22);

      ctx.fillStyle = muted;
      ctx.font = `11px ${FONT}`;
      const time = LESSON_TIMES[pair.number] || '';
      const teacher = pair.teacher || '';
      const meta = [time, teacher].filter(Boolean).join('  ·  ');
      ctx.fillText(truncText(ctx, meta, W - padX * 2 - 70), padX + 46, y + 40);

      y += cardH + cardGap;
    }
  }

  ctx.fillStyle = muted;
  ctx.font = `12px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.fillText('Розклад Студента · mpmek.site', W / 2, H - 18);
  ctx.textAlign = 'left';

  return canvas.toBuffer('image/png');
}

module.exports = async function handler(req, res) {
  try {
    await ensureFont();

    const { group, day, theme } = req.query;
    if (!group) return res.status(400).json({ error: 'group is required' });

    const scheduleData = await fetchSchedule();
    if (!scheduleData[group]) return res.status(404).json({ error: 'group not found' });

    const dark = theme === 'dark';
    let buf;

    if (day === 'week') {
      buf = renderWeekImage(group, scheduleData, dark);
      if (!buf) return res.status(404).json({ error: 'no schedule for this week' });
    } else {
      const dayIdx = parseInt(day) || new Date().getDay();
      const data = getPairsForDay(scheduleData, group, dayIdx);
      if (!data) return res.status(404).json({ error: 'no schedule for this day' });
      buf = renderDayImage(group, data, dark);
    }

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.send(buf);
  } catch (err) {
    console.error('schedule-image error:', err);
    return res.status(500).json({ error: err.message });
  }
};
