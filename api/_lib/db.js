/**
 * Database abstraction layer — Supabase (Postgres) backend.
 * Drop-in replacement for redis.js helpers used across API endpoints.
 */
const crypto = require('crypto');
const { supabase } = require('./supabase');

// ─── Utilities ───────────────────────────────────────────────────────────────

function safeKey(str, maxLen = 80) {
  if (!str || typeof str !== 'string') return '';
  return str.replace(/[^a-zA-Z0-9а-яА-ЯіІїЇєЄґҐ._:-]/g, '_').slice(0, maxLen);
}

function safeCompare(a, b) {
  if (!a || !b) return false;
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function checkOrigin(req) {
  const origin = req.headers.origin || req.headers.referer || '';
  const allowed = ['https://mpmek.site', 'http://localhost'];
  return allowed.some(a => origin.startsWith(a));
}

// ─── Rate Limiting ───────────────────────────────────────────────────────────

async function rateLimit(key, limit, windowSec) {
  const { data, error } = await supabase.rpc('rl_check', {
    p_key: key,
    p_limit: limit,
    p_window_sec: windowSec
  });
  if (error) {
    console.error('Rate limit error:', error.message);
    return false; // fail-open on DB errors
  }
  return data === true;
}

// ─── Sessions ────────────────────────────────────────────────────────────────

async function getSessionUsername(req) {
  let token = null;
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    const t = auth.slice(7).trim();
    if (t.length > 0 && t.length <= 128) token = t;
  }
  if (!token) {
    const cookieStr = req.headers.cookie || '';
    const match = cookieStr.match(/(?:^|;\s*)auth_token=([^;]+)/);
    if (match && match[1].length <= 128) token = match[1];
  }
  if (!token) return null;

  const { data } = await supabase
    .from('sessions')
    .select('username, session_ver, expires_at')
    .eq('token', token)
    .single();
  if (!data || new Date(data.expires_at) < new Date()) return null;

  // Verify session version
  const { data: sv } = await supabase
    .from('session_versions')
    .select('version, expires_at')
    .eq('username', data.username)
    .single();
  if (sv && new Date(sv.expires_at) > new Date() && sv.version !== data.session_ver) {
    return null;
  }
  return data.username;
}

async function getSessionData(token) {
  const { data } = await supabase
    .from('sessions')
    .select('username, session_ver, expires_at')
    .eq('token', token)
    .single();
  if (!data || new Date(data.expires_at) < new Date()) return null;
  return `${data.username}:${data.session_ver}`;
}

async function getSessionVersion(username) {
  const { data } = await supabase
    .from('session_versions')
    .select('version, expires_at')
    .eq('username', username)
    .single();
  if (!data || new Date(data.expires_at) < new Date()) return null;
  return data.version;
}

async function setSessionVersion(username, version, ttlSec) {
  const expires_at = new Date(Date.now() + ttlSec * 1000).toISOString();
  await supabase
    .from('session_versions')
    .upsert({ username, version, expires_at }, { onConflict: 'username' });
}

async function createSession(token, username, sessionVer, ttlSec) {
  const expires_at = new Date(Date.now() + ttlSec * 1000).toISOString();
  await supabase
    .from('sessions')
    .upsert({ token, username, session_ver: sessionVer, expires_at }, { onConflict: 'token' });
}

async function deleteSession(token) {
  await supabase.from('sessions').delete().eq('token', token);
}

async function deleteUserSessions(username) {
  await supabase.from('sessions').delete().eq('username', username);
}

// ─── Users ───────────────────────────────────────────────────────────────────

async function getUser(username) {
  const { data } = await supabase
    .from('users')
    .select('*')
    .eq('username', username)
    .single();
  if (!data) return null;
  return {
    displayName: data.display_name,
    passwordHash: data.password_hash,
    salt: data.salt,
    group: data.group,
    role: data.role,
    teacherName: data.teacher_name,
    createdAt: data.created_at
  };
}

async function createUser(username, userData) {
  const { error } = await supabase.from('users').insert({
    username,
    display_name: userData.displayName || '',
    password_hash: userData.passwordHash || null,
    salt: userData.salt || null,
    group: userData.group || '',
    role: userData.role || 'user',
    teacher_name: userData.teacherName || '',
    created_at: userData.createdAt || new Date().toISOString()
  });
  if (error) {
    if (error.code === '23505') return false; // unique violation
    console.error('createUser error:', error.message);
    return false;
  }
  return true;
}

async function updateUser(username, fields) {
  const update = {};
  if (fields.displayName !== undefined) update.display_name = fields.displayName;
  if (fields.passwordHash !== undefined) update.password_hash = fields.passwordHash;
  if (fields.salt !== undefined) update.salt = fields.salt;
  if (fields.group !== undefined) update.group = fields.group;
  if (fields.role !== undefined) update.role = fields.role;
  if (fields.teacherName !== undefined) update.teacher_name = fields.teacherName;
  await supabase.from('users').update(update).eq('username', username);
}

async function deleteUser(username) {
  await supabase.from('users').delete().eq('username', username);
}

async function getAllUsers() {
  const { data } = await supabase.from('users').select('*').order('username');
  return (data || []).map(d => ({
    username: d.username,
    displayName: d.display_name,
    passwordHash: d.password_hash,
    salt: d.salt,
    group: d.group,
    role: d.role,
    teacherName: d.teacher_name,
    createdAt: d.created_at
  }));
}

// ─── WebAuthn ────────────────────────────────────────────────────────────────

async function getWebauthnCreds(username) {
  const { data } = await supabase
    .from('webauthn_creds')
    .select('creds_json')
    .eq('username', username)
    .single();
  if (!data) return [];
  return data.creds_json || [];
}

async function setWebauthnCreds(username, creds) {
  await supabase
    .from('webauthn_creds')
    .upsert({ username, creds_json: creds }, { onConflict: 'username' });
}

async function getWebauthnChallenge(username) {
  const { data } = await supabase
    .from('webauthn_challenges')
    .select('challenge, expires_at')
    .eq('username', username)
    .single();
  if (!data || new Date(data.expires_at) < new Date()) return null;
  return data.challenge;
}

async function setWebauthnChallenge(username, challenge, ttlSec) {
  const expires_at = new Date(Date.now() + ttlSec * 1000).toISOString();
  await supabase
    .from('webauthn_challenges')
    .upsert({ username, challenge, expires_at }, { onConflict: 'username' });
}

async function deleteWebauthnChallenge(username) {
  await supabase.from('webauthn_challenges').delete().eq('username', username);
}

// ─── Schedule ────────────────────────────────────────────────────────────────

async function getSchedule() {
  const { data } = await supabase
    .from('schedule')
    .select('data')
    .eq('id', 1)
    .single();
  return data ? data.data : {};
}

async function getScheduleGroups() {
  const schedule = await getSchedule();
  return Object.keys(schedule).filter(k => k !== '_settings');
}

async function upsertScheduleGroups(scheduleData) {
  await supabase
    .from('schedule')
    .upsert({ id: 1, data: scheduleData, updated_at: new Date().toISOString() }, { onConflict: 'id' });
}

// ─── Homework ────────────────────────────────────────────────────────────────

async function getHomework(groupName) {
  const [{ data: texts }, { data: atts }] = await Promise.all([
    supabase.from('homework_text').select('*').eq('group_name', groupName),
    supabase.from('homework_attachments').select('*').eq('group_name', groupName)
  ]);

  const result = {};
  for (const t of (texts || [])) {
    result[`${groupName}|${t.day}|${t.number}`] = t.text;
  }

  const files = {};
  for (const a of (atts || [])) {
    const key = `${groupName}|${a.day}|${a.number}`;
    if (!files[key]) files[key] = [];
    files[key].push({ url: a.url, name: a.name, type: a.mime_type, size: a.size });
  }

  return { texts: result, files };
}

async function setHomeworkText(groupName, day, number, text) {
  if (text && text.trim()) {
    await supabase.from('homework_text').upsert(
      { group_name: groupName, day, number, text: text.trim().slice(0, 1000) },
      { onConflict: 'group_name,day,number' }
    );
  } else {
    await supabase.from('homework_text').delete()
      .eq('group_name', groupName).eq('day', day).eq('number', number);
  }
}

async function deleteHomeworkText(groupName, day, number) {
  await supabase.from('homework_text').delete()
    .eq('group_name', groupName).eq('day', day).eq('number', number);
}

async function getHomeworkAttachments(groupName, day, number) {
  const { data } = await supabase.from('homework_attachments')
    .select('*')
    .eq('group_name', groupName).eq('day', day).eq('number', number);
  return (data || []).map(a => ({ url: a.url, name: a.name, type: a.mime_type, size: a.size }));
}

async function addHomeworkAttachment(groupName, day, number, att) {
  await supabase.from('homework_attachments').insert({
    group_name: groupName, day, number,
    url: att.url, name: att.name, mime_type: att.type, size: att.size
  });
}

async function deleteHomeworkAttachment(groupName, day, number, url) {
  await supabase.from('homework_attachments').delete()
    .eq('group_name', groupName).eq('day', day).eq('number', number).eq('url', url);
}

// ─── Push Subscriptions ──────────────────────────────────────────────────────

async function upsertPushSub(id, data) {
  await supabase.from('push_subscriptions').upsert({
    id,
    subscription_enc: data.subscriptionEnc || null,
    subscription_raw: data.subscription || null,
    group: data.group,
    notify_time: data.notifyTime || '08:00'
  }, { onConflict: 'id' });
}

async function deletePushSub(id) {
  await supabase.from('push_subscriptions').delete().eq('id', id);
}

async function getAllPushSubs() {
  const { data } = await supabase.from('push_subscriptions').select('*');
  return (data || []).map(d => ({
    id: d.id,
    encrypted: d.subscription_enc || undefined,
    subscription: d.subscription_raw || undefined,
    group: d.group,
    notifyTime: d.notify_time
  }));
}

// ─── Logs ────────────────────────────────────────────────────────────────────

async function insertLoginLog({ username, role, ip, success }) {
  await supabase.from('login_log').insert({ username, role, ip, success });
}

async function getLoginLog(limit = 100) {
  const { data } = await supabase.from('login_log')
    .select('*').order('ts', { ascending: false }).limit(limit);
  return (data || []).map(d => ({ ts: d.ts, user: d.username, role: d.role, ip: d.ip, ok: d.success }));
}

async function insertAuditLog({ username, ip, action, detail }) {
  await supabase.from('audit_log').insert({
    username: username || 'unknown',
    ip: ip || 'unknown',
    action,
    detail: (detail || '').slice(0, 500)
  });
}

async function getAuditLog(limit = 100) {
  const { data } = await supabase.from('audit_log')
    .select('*').order('ts', { ascending: false }).limit(limit);
  return (data || []).map(d => ({ ts: d.ts, user: d.username, ip: d.ip, action: d.action, detail: d.detail }));
}

async function insertCspReport({ url, violated, blocked }) {
  await supabase.from('csp_reports').insert({ url, violated, blocked });
}

async function getCspReports(limit = 100) {
  const { data } = await supabase.from('csp_reports')
    .select('*').order('ts', { ascending: false }).limit(limit);
  return (data || []).map(d => ({ ts: d.ts, url: d.url, violated: d.violated, blocked: d.blocked }));
}

// ─── Bot Users ───────────────────────────────────────────────────────────────

async function getBotUsers() {
  const { data } = await supabase.from('bot_users').select('*');
  return (data || []).map(d => ({
    chatId: d.chat_id,
    name: d.name,
    group: d.group,
    notifyTime: d.notify_time,
    active: d.active,
    syncedAt: d.synced_at
  }));
}

async function upsertBotUser(chatId, userData) {
  await supabase.from('bot_users').upsert({
    chat_id: chatId,
    name: userData.name || '',
    group: userData.group || '',
    notify_time: userData.notifyTime || '07:30',
    active: userData.active !== false,
    synced_at: new Date().toISOString()
  }, { onConflict: 'chat_id' });
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  // Utilities
  safeKey, safeCompare, checkOrigin,
  // Rate limiting
  rateLimit,
  // Sessions
  getSessionUsername, getSessionData, getSessionVersion,
  setSessionVersion, createSession, deleteSession, deleteUserSessions,
  // Users
  getUser, createUser, updateUser, deleteUser, getAllUsers,
  // WebAuthn
  getWebauthnCreds, setWebauthnCreds,
  getWebauthnChallenge, setWebauthnChallenge, deleteWebauthnChallenge,
  // Schedule
  getSchedule, getScheduleGroups, upsertScheduleGroups,
  // Homework
  getHomework, setHomeworkText, deleteHomeworkText,
  getHomeworkAttachments, addHomeworkAttachment, deleteHomeworkAttachment,
  // Push
  upsertPushSub, deletePushSub, getAllPushSubs,
  // Logs
  insertLoginLog, getLoginLog,
  insertAuditLog, getAuditLog,
  insertCspReport, getCspReports,
  // Bot
  getBotUsers, upsertBotUser
};
