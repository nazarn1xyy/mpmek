const {
  rateLimit, safeKey, checkOrigin, getSessionUsername,
  getUser: dbGetUser, getSchedule,
  getHomework, setHomeworkText, deleteHomeworkText,
  getHomeworkAttachments, addHomeworkAttachment, deleteHomeworkAttachment
} = require('./_lib/db');
const { put, del } = require('@vercel/blob');
const { ADMIN_USERNAMES, TEACHER_ACCOUNTS } = require('./_lib/config');

// Normalize group name to full-year format for comparison (КСМ-24-1 → КСМ-2024-1)
function normalizeGroup(g) {
  if (!g) return '';
  return g.split('-').map(p => {
    if (/^\d{2}$/.test(p) && parseInt(p) >= 20) return (parseInt(p) < 50 ? '20' : '19') + p;
    return p;
  }).join('-');
}
function sameGroup(a, b) { return normalizeGroup(a) === normalizeGroup(b); }

// Verify teacher actually teaches in this group (server-side check)
async function verifyTeacherGroup(teacherName, group) {
  if (!teacherName || !group) return false;
  const ng = normalizeGroup(group);
  try {
    const schedule = await getSchedule();
    const teacherGroups = [];
    for (const [gName, gData] of Object.entries(schedule)) {
      if (gName === '_settings' || !gData || typeof gData !== 'object') continue;
      let found = false;
      for (const [weekType, weekData] of Object.entries(gData)) {
        if (weekType === 'ПІДВІСКА' || !weekData || typeof weekData !== 'object') continue;
        for (const dayPairs of Object.values(weekData)) {
          if (!Array.isArray(dayPairs)) continue;
          if (dayPairs.some(p => p.teacher && p.teacher.trim() === teacherName)) { found = true; break; }
        }
        if (found) break;
      }
      if (found) teacherGroups.push(normalizeGroup(gName));
    }
    return teacherGroups.includes(ng) || teacherGroups.includes(group);
  } catch {
    return false; // fail-closed: deny on error
  }
}

const MAX_FILE_SIZE = 3 * 1024 * 1024; // 3 MB
const MAX_ATTACHMENTS = 5;
const ALLOWED_TYPES = ['image/webp', 'image/jpeg', 'image/png', 'application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];

// Authenticate via Bearer token, return { username, group, role, canEdit, teacherName } or null
async function authenticate(req) {
  const uname = await getSessionUsername(req);
  if (!uname) return null;
  const user = await dbGetUser(uname);
  if (!user) return null;
  const isAdmin = ADMIN_USERNAMES.includes(uname);
  const isStarosta = !isAdmin && (user.role === 'starosta');
  const isTeacher = !isAdmin && !isStarosta && (!!TEACHER_ACCOUNTS[uname] || user.role === 'teacher');
  const role = isAdmin ? 'admin' : isStarosta ? 'starosta' : isTeacher ? 'teacher' : 'user';
  const teacherName = TEACHER_ACCOUNTS[uname] || user.teacherName || '';
  return { username: uname, group: user.group || '', role, canEdit: isAdmin || isStarosta || isTeacher, teacherName };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://mpmek.site');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // CSRF check for state-changing requests
  if ((req.method === 'POST' || req.method === 'DELETE') && !checkOrigin(req)) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';

  try {
    const action = req.query.action;

    if (req.method === 'GET' && !action) {
      // GET is public — anyone in the group can read collaborative homework
      if (await rateLimit(`hw:read:${ip}`, 60, 60)) {
        return res.status(429).json({ error: 'Too many requests' });
      }
      const { group } = req.query;
      if (!group) return res.status(400).json({ error: 'group is required' });
      if (typeof group !== 'string' || group.length > 50) return res.status(400).json({ error: 'invalid group' });

      const ng = normalizeGroup(group);
      const { texts, files } = await getHomework(ng);
      return res.json({ texts, files });
    }

    // ── Upload attachment ──
    if (req.method === 'POST' && action === 'upload') {
      const user = await authenticate(req);
      if (!user) return res.status(401).json({ error: 'Авторизуйтесь' });
      if (!user.canEdit) return res.status(403).json({ error: 'Тільки староста або адмін може додавати завдання' });
      if (await rateLimit(`hw:upload:${user.username}`, 15, 60)) {
        return res.status(429).json({ error: 'Too many uploads' });
      }

      const { group, day, number, fileName, fileType, fileData } = req.body || {};
      if (!group || !day || number === undefined || !fileData || !fileName) {
        return res.status(400).json({ error: 'group, day, number, fileName, fileData required' });
      }
      // Starosta: own group only. Teacher: verify group/subject. Admin: any.
      if (user.role === 'starosta' && !sameGroup(user.group, group)) {
        return res.status(403).json({ error: 'Можна редагувати тільки свою групу' });
      }
      if (user.role === 'teacher') {
        const ok = await verifyTeacherGroup(user.teacherName, group);
        if (!ok) return res.status(403).json({ error: 'Ви не викладаєте у цій групі' });
      }
      const mimeType = typeof fileType === 'string' ? fileType : 'application/octet-stream';
      if (!ALLOWED_TYPES.includes(mimeType)) {
        return res.status(400).json({ error: 'Недозволений тип файлу' });
      }

      // Decode base64
      const buf = Buffer.from(fileData, 'base64');
      if (buf.length > MAX_FILE_SIZE) {
        return res.status(400).json({ error: `Файл занадто великий (макс ${MAX_FILE_SIZE / 1024 / 1024} МБ)` });
      }

      const num = Number(number);
      if (!Number.isFinite(num) || num < 1 || num > 8) {
        return res.status(400).json({ error: 'invalid number' });
      }
      const ng = normalizeGroup(group);
      const sd = safeKey(day, 20);

      // Check existing attachments count
      const existing = await getHomeworkAttachments(ng, sd, num);
      if (existing.length >= MAX_ATTACHMENTS) {
        return res.status(400).json({ error: `Максимум ${MAX_ATTACHMENTS} файлів` });
      }

      // Prevent duplicate uploads (same name + same size)
      const isDuplicate = existing.some(e => e.name === fileName.slice(0, 100) && e.size === buf.length);
      if (isDuplicate) {
        return res.json({ ok: true, attachment: existing.find(e => e.name === fileName.slice(0, 100)), total: existing.length, duplicate: true });
      }

      // Upload to Vercel Blob
      const sg = safeKey(ng);
      const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
      const blobPath = `hw/${sg}/${sd}/${num}/${Date.now()}_${safeName}`;
      const blob = await put(blobPath, buf, {
        access: 'public',
        contentType: mimeType,
        addRandomSuffix: false
      });

      const att = { url: blob.url, name: fileName.slice(0, 100), type: mimeType, size: buf.length };
      await addHomeworkAttachment(ng, sd, num, att);

      return res.json({ ok: true, attachment: att, total: existing.length + 1 });
    }

    // ── Delete attachment ──
    if (req.method === 'POST' && action === 'delete-attachment') {
      const user = await authenticate(req);
      if (!user) return res.status(401).json({ error: 'Авторизуйтесь' });
      if (!user.canEdit) return res.status(403).json({ error: 'Тільки староста або адмін може видаляти завдання' });
      if (await rateLimit(`hw:del:${user.username}`, 30, 60)) {
        return res.status(429).json({ error: 'Too many requests' });
      }

      const { group, day, number, url } = req.body || {};
      if (!group || !day || number === undefined || !url) {
        return res.status(400).json({ error: 'group, day, number, url required' });
      }
      // Starosta: own group only. Teacher: verify group. Admin: any.
      if (user.role === 'starosta' && !sameGroup(user.group, group)) {
        return res.status(403).json({ error: 'Можна редагувати тільки свою групу' });
      }
      if (user.role === 'teacher') {
        const ok = await verifyTeacherGroup(user.teacherName, group);
        if (!ok) return res.status(403).json({ error: 'Ви не викладаєте у цій групі' });
      }
      const num = Number(number);
      if (!Number.isFinite(num) || num < 1 || num > 8) {
        return res.status(400).json({ error: 'invalid number' });
      }
      const ng = normalizeGroup(group);
      const sd = safeKey(day, 20);

      const existing = await getHomeworkAttachments(ng, sd, num);
      const idx = existing.findIndex(a => a.url === url);
      if (idx === -1) return res.status(404).json({ error: 'Файл не знайдено' });

      // Delete from Vercel Blob
      try { await del(url); } catch (e) { console.warn('Blob delete failed:', e); }

      await deleteHomeworkAttachment(ng, sd, num, url);

      return res.json({ ok: true, remaining: existing.length - 1 });
    }

    // Write operations (text) require authentication + starosta/admin role
    if ((req.method === 'POST' && !action) || req.method === 'DELETE') {
      const user = await authenticate(req);
      if (!user) {
        return res.status(401).json({ error: 'Авторизуйтесь, щоб редагувати завдання' });
      }
      if (!user.canEdit) {
        return res.status(403).json({ error: 'Тільки староста або адмін може редагувати завдання' });
      }

      if (await rateLimit(`hw:${user.username}`, 30, 60)) {
        return res.status(429).json({ error: 'Too many requests' });
      }
      if (await rateLimit(`hw:ip:${ip}`, 60, 60)) {
        return res.status(429).json({ error: 'Too many requests' });
      }

      const source = req.method === 'POST' ? (req.body || {}) : (req.query || {});
      const { group, day, number, text } = source;

      if (!group || !day || number === undefined) {
        return res.status(400).json({ error: 'group, day, number required' });
      }
      if (typeof group !== 'string' || group.length > 50) return res.status(400).json({ error: 'invalid group' });
      if (typeof day !== 'string' || day.length > 20) return res.status(400).json({ error: 'invalid day' });

      // Starosta: own group only. Teacher: verify group. Admin: any.
      if (user.role === 'starosta' && !sameGroup(user.group, group)) {
        return res.status(403).json({ error: 'Можна редагувати тільки свою групу' });
      }
      if (user.role === 'teacher') {
        const ok = await verifyTeacherGroup(user.teacherName, group);
        if (!ok) return res.status(403).json({ error: 'Ви не викладаєте у цій групі' });
      }

      const num = Number(number);
      if (!Number.isFinite(num) || num < 1 || num > 8) {
        return res.status(400).json({ error: 'invalid number' });
      }

      const ng = normalizeGroup(group);
      const sd = safeKey(day, 20);

      if (req.method === 'POST') {
        if (text !== undefined && typeof text !== 'string') {
          return res.status(400).json({ error: 'text must be string' });
        }
        if (text && text.length > 1000) return res.status(400).json({ error: 'text too long' });

        await setHomeworkText(ng, sd, num, text || '');
      } else {
        await deleteHomeworkText(ng, sd, num);
      }
      return res.json({ ok: true });
    }

    return res.status(405).json({ error: 'method not allowed' });
  } catch (err) {
    console.error('homework API error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
