/**
 * One-time migration script: schedule.json → Supabase
 * 
 * Usage:
 *   SUPABASE_URL=https://xxx.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=eyJ... \
 *   node supabase/migrate-data.js
 */

const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function main() {
  const jsonPath = path.join(__dirname, '..', 'app', 'schedule.json');
  console.log(`📂 Reading ${jsonPath}...`);
  const raw = fs.readFileSync(jsonPath, 'utf-8');
  const data = JSON.parse(raw);

  // Extract and save settings
  if (data._settings) {
    if (data._settings.lessonTimes) {
      const { error } = await supabase
        .from('settings')
        .upsert({ key: 'lessonTimes', value: data._settings.lessonTimes });
      if (error) console.error('⚠️ Settings error:', error.message);
      else console.log('✅ Lesson times saved');
    }
    delete data._settings;
  }

  const groupNames = Object.keys(data);
  console.log(`📋 Found ${groupNames.length} groups`);

  let totalSchedules = 0;
  let totalSubs = 0;

  for (const groupName of groupNames) {
    // 1. Insert group
    const { data: groupRow, error: groupErr } = await supabase
      .from('groups')
      .upsert({ name: groupName }, { onConflict: 'name' })
      .select('id')
      .single();

    if (groupErr) {
      console.error(`❌ Group "${groupName}":`, groupErr.message);
      continue;
    }

    const groupId = groupRow.id;
    const groupData = data[groupName];

    // 2. Insert schedules (ОСНОВНИЙ РОЗКЛАД, ЧИСЕЛЬНИК, ЗНАМЕННИК)
    for (const weekType of Object.keys(groupData)) {
      if (weekType === 'ПІДВІСКА') continue;

      const weekData = groupData[weekType];
      if (!weekData || typeof weekData !== 'object' || Array.isArray(weekData)) continue;

      const rows = [];
      for (const day of Object.keys(weekData)) {
        const pairs = weekData[day];
        if (!Array.isArray(pairs)) continue;
        for (const pair of pairs) {
          rows.push({
            group_id: groupId,
            week_type: weekType,
            day,
            number: pair.number,
            subject: pair.subject || '',
            teacher: pair.teacher || ''
          });
        }
      }

      if (rows.length > 0) {
        const { error } = await supabase
          .from('schedules')
          .upsert(rows, { onConflict: 'group_id,week_type,day,number' });
        if (error) console.error(`⚠️ Schedule "${groupName}" / "${weekType}":`, error.message);
        else totalSchedules += rows.length;
      }
    }

    // 3. Insert substitutions (ПІДВІСКА)
    if (groupData['ПІДВІСКА'] && Array.isArray(groupData['ПІДВІСКА'])) {
      const subRows = groupData['ПІДВІСКА'].map(s => ({
        group_id: groupId,
        date: s.date,
        number: s.number,
        subject: s.subject || '',
        teacher: s.teacher || ''
      }));

      if (subRows.length > 0) {
        const { error } = await supabase
          .from('substitutions')
          .upsert(subRows, { onConflict: 'group_id,date,number' });
        if (error) console.error(`⚠️ Subs "${groupName}":`, error.message);
        else totalSubs += subRows.length;
      }
    }

    console.log(`  ✅ ${groupName}`);
  }

  console.log(`\n🎉 Migration complete!`);
  console.log(`   Groups: ${groupNames.length}`);
  console.log(`   Schedule entries: ${totalSchedules}`);
  console.log(`   Substitution entries: ${totalSubs}`);
}

main().catch(err => {
  console.error('💥 Fatal error:', err);
  process.exit(1);
});
