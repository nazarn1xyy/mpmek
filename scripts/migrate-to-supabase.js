#!/usr/bin/env node
/**
 * Migration script: Redis + schedule.json → Supabase
 *
 * Usage:
 *   KV_REST_API_URL=... KV_REST_API_TOKEN=... \
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *   node scripts/migrate-to-supabase.js
 *
 * Or with a .env.local file (requires `dotenv`):
 *   node -r dotenv/config scripts/migrate-to-supabase.js dotenv_config_path=.env.local
 */

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

// ─── Config ──────────────────────────────────────────────────────────────────

const REDIS_URL = process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌  SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

// ─── Redis helper ─────────────────────────────────────────────────────────────

async function redis(...args) {
  if (!REDIS_URL || !REDIS_TOKEN) throw new Error('Redis env vars not set');
  const resp = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args)
  });
  const data = await resp.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

async function scanKeys(pattern) {
  const keys = [];
  let cursor = '0';
  do {
    const res = await redis('SCAN', cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = String(res[0]);
    if (res[1] && res[1].length) keys.push(...res[1]);
  } while (cursor !== '0');
  return keys;
}

function parseRedisHash(raw) {
  if (!raw) return {};
  if (Array.isArray(raw)) {
    const result = {};
    for (let i = 0; i < raw.length; i += 2) result[raw[i]] = raw[i + 1];
    return result;
  }
  if (typeof raw === 'object') return raw;
  return {};
}

// ─── Step 1: Migrate schedule ─────────────────────────────────────────────────

async function migrateSchedule() {
  console.log('\n📅  Migrating schedule.json → Supabase schedule table...');
  const schedPath = path.resolve(__dirname, '../app/schedule.json');
  if (!fs.existsSync(schedPath)) {
    console.warn('   schedule.json not found, skipping');
    return;
  }
  const schedule = JSON.parse(fs.readFileSync(schedPath, 'utf8'));
  const groupCount = Object.keys(schedule).filter(k => k !== '_settings').length;

  const { error } = await supabase
    .from('schedule')
    .upsert({ id: 1, data: schedule, updated_at: new Date().toISOString() }, { onConflict: 'id' });

  if (error) {
    console.error('   ❌  schedule upsert failed:', error.message);
  } else {
    console.log(`   ✅  Inserted schedule with ${groupCount} groups`);
  }
}

// ─── Step 2: Migrate homework from Redis ─────────────────────────────────────

async function migrateHomework() {
  if (!REDIS_URL || !REDIS_TOKEN) {
    console.warn('\n📝  Redis env vars not set — skipping homework migration');
    return;
  }
  console.log('\n📝  Migrating homework from Redis → Supabase...');

  const keys = await scanKeys('hw:*');
  console.log(`   Found ${keys.length} homework hash key(s) in Redis`);

  let textTotal = 0;
  let attTotal = 0;

  for (const key of keys) {
    // key format: "hw:{safeGroup}"
    const groupPart = key.replace(/^hw:/, '');

    const raw = await redis('HGETALL', key);
    const hash = parseRedisHash(raw);
    const fields = Object.keys(hash);
    if (fields.length === 0) continue;

    console.log(`   Processing ${key} (${fields.length} fields)`);

    for (const [field, value] of Object.entries(hash)) {
      if (field.endsWith(':files')) {
        // Attachment: "day:num:files"
        const withoutSuffix = field.replace(/:files$/, '');
        const parts = withoutSuffix.split(':');
        if (parts.length < 2) continue;
        const day = parts[0];
        const num = parseInt(parts[1], 10);
        if (!day || isNaN(num)) continue;

        let attachments = [];
        try { attachments = JSON.parse(value); } catch { continue; }
        if (!Array.isArray(attachments) || attachments.length === 0) continue;

        // Deduplicate by name+size
        const seen = new Set();
        const deduped = attachments.filter(a => {
          const k = `${a.name}:${a.size}`;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });

        for (const att of deduped) {
          const { error } = await supabase.from('homework_attachments').upsert({
            group_name: groupPart,
            day,
            number: num,
            url: att.url,
            name: att.name || '',
            mime_type: att.type || 'application/octet-stream',
            size: att.size || 0
          }, { onConflict: 'group_name,day,number,url', ignoreDuplicates: true });

          if (error && error.code !== '23505') {
            console.warn(`     ⚠️  attachment insert error: ${error.message}`);
          } else {
            attTotal++;
          }
        }
      } else {
        // Text: "day:num"
        const parts = field.split(':');
        if (parts.length < 2) continue;
        const day = parts[0];
        const num = parseInt(parts[1], 10);
        if (!day || isNaN(num) || !value || !value.trim()) continue;

        const { error } = await supabase.from('homework_text').upsert({
          group_name: groupPart,
          day,
          number: num,
          text: value.trim().slice(0, 1000)
        }, { onConflict: 'group_name,day,number' });

        if (error) {
          console.warn(`     ⚠️  text insert error: ${error.message}`);
        } else {
          textTotal++;
        }
      }
    }
  }

  console.log(`   ✅  Homework texts: ${textTotal}, attachments: ${attTotal}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  console.log('🚀  Starting Supabase migration...');
  console.log(`    Supabase: ${SUPABASE_URL}`);
  console.log(`    Redis:    ${REDIS_URL ? 'configured' : 'NOT configured (homework will be skipped)'}`);

  try {
    await migrateSchedule();
    await migrateHomework();
    console.log('\n🎉  Migration complete!');
  } catch (err) {
    console.error('\n💥  Migration failed:', err);
    process.exit(1);
  }
})();
