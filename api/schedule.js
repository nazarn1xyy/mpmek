/**
 * Schedule API — main endpoint for reading / writing schedule data.
 *
 * GET /api/schedule              → list of all group names
 * GET /api/schedule?group=X      → full schedule for group X (compatible format)
 * GET /api/schedule?group=X&format=full → same + substitutions + settings
 * POST /api/schedule             → save full schedule for a group (from admin)
 */

const { supabase } = require('./_lib/supabase');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Pin');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (req.method === 'GET') {
      return await handleGet(req, res);
    } else if (req.method === 'POST') {
      return await handlePost(req, res);
    }
    return res.status(405).json({ error: 'method not allowed' });
  } catch (err) {
    console.error('schedule API error:', err);
    return res.status(500).json({ error: err.message });
  }
};

async function handleGet(req, res) {
  const { group, format } = req.query;

  // No group — check if format=all (returns everything like schedule.json)
  if (!group && format === 'all') {
    return await returnAllGroups(res);
  }

  // No group specified → return group name list
  if (!group) {
    const { data: groups, error } = await supabase
      .from('groups')
      .select('name')
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true });

    if (error) throw error;
    return res.json({ groups: groups.map(g => g.name) });
  }

  // Get group ID
  const { data: groupRow, error: groupErr } = await supabase
    .from('groups')
    .select('id')
    .eq('name', group)
    .single();

  if (groupErr || !groupRow) {
    return res.status(404).json({ error: `Group "${group}" not found` });
  }

  const groupId = groupRow.id;

  // Fetch schedules
  const { data: schedules, error: schedErr } = await supabase
    .from('schedules')
    .select('week_type, day, number, subject, teacher')
    .eq('group_id', groupId)
    .order('number', { ascending: true });

  if (schedErr) throw schedErr;

  // Fetch substitutions
  const { data: subs, error: subsErr } = await supabase
    .from('substitutions')
    .select('date, number, subject, teacher')
    .eq('group_id', groupId)
    .order('date', { ascending: true })
    .order('number', { ascending: true });

  if (subsErr) throw subsErr;

  // Build response in the same format as schedule.json[group]
  const result = {};

  for (const row of schedules) {
    if (!result[row.week_type]) result[row.week_type] = {};
    if (!result[row.week_type][row.day]) result[row.week_type][row.day] = [];
    result[row.week_type][row.day].push({
      number: row.number,
      subject: row.subject,
      teacher: row.teacher
    });
  }

  // Add substitutions as ПІДВІСКА array
  if (subs.length > 0) {
    result['ПІДВІСКА'] = subs.map(s => ({
      date: s.date,
      number: s.number,
      subject: s.subject,
      teacher: s.teacher
    }));
  }

  // If full format requested, include settings
  if (format === 'full') {
    const { data: settingsRow } = await supabase
      .from('settings')
      .select('value')
      .eq('key', 'lessonTimes')
      .single();

    if (settingsRow) {
      result._settings = { lessonTimes: settingsRow.value };
    }
  }

  res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
  return res.json(result);
}

async function handlePost(req, res) {
  // Auth: require admin PIN
  const pin = req.headers['x-admin-pin'];
  if (pin !== '0411') {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { scheduleData, settings } = req.body;

  if (!scheduleData || typeof scheduleData !== 'object') {
    return res.status(400).json({ error: 'scheduleData object required' });
  }

  const groupNames = Object.keys(scheduleData).filter(k => k !== '_settings');

  for (const groupName of groupNames) {
    // Upsert group
    const { data: groupRow, error: groupErr } = await supabase
      .from('groups')
      .upsert({ name: groupName }, { onConflict: 'name' })
      .select('id')
      .single();

    if (groupErr) {
      console.error(`Group upsert error "${groupName}":`, groupErr.message);
      continue;
    }

    const groupId = groupRow.id;
    const groupData = scheduleData[groupName];

    // Delete existing schedules for this group (full replace)
    await supabase.from('schedules').delete().eq('group_id', groupId);

    // Insert all week types
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
        const { error } = await supabase.from('schedules').insert(rows);
        if (error) console.error(`Schedule insert error "${groupName}/${weekType}":`, error.message);
      }
    }

    // Handle substitutions
    if (groupData['ПІДВІСКА'] && Array.isArray(groupData['ПІДВІСКА'])) {
      // Delete old subs for this group and reinsert
      await supabase.from('substitutions').delete().eq('group_id', groupId);

      const subRows = groupData['ПІДВІСКА'].map(s => ({
        group_id: groupId,
        date: s.date,
        number: s.number,
        subject: s.subject || '',
        teacher: s.teacher || ''
      }));

      if (subRows.length > 0) {
        const { error } = await supabase.from('substitutions').insert(subRows);
        if (error) console.error(`Subs insert error "${groupName}":`, error.message);
      }
    }
  }

  // Handle deleted groups: remove groups that are in DB but not in incoming data
  const { data: existingGroups } = await supabase.from('groups').select('name');
  if (existingGroups) {
    const incomingNames = new Set(groupNames);
    for (const g of existingGroups) {
      if (!incomingNames.has(g.name)) {
        await supabase.from('groups').delete().eq('name', g.name);
      }
    }
  }

  // Save settings if provided
  if (scheduleData._settings && scheduleData._settings.lessonTimes) {
    await supabase
      .from('settings')
      .upsert({ key: 'lessonTimes', value: scheduleData._settings.lessonTimes });
  }

  return res.json({ ok: true, groups: groupNames.length });
}

/**
 * Returns ALL groups with their schedules + substitutions in the exact 
 * same format as the old schedule.json file. This is the compatibility
 * layer that allows app.js and admin to work with minimal changes.
 */
async function returnAllGroups(res) {
  // Fetch all groups
  const { data: groups, error: gErr } = await supabase
    .from('groups')
    .select('id, name')
    .order('sort_order')
    .order('name');
  if (gErr) throw gErr;

  // Fetch all schedules
  const { data: allSchedules } = await supabase
    .from('schedules')
    .select('group_id, week_type, day, number, subject, teacher')
    .order('number');

  // Fetch all substitutions
  const { data: allSubs } = await supabase
    .from('substitutions')
    .select('group_id, date, number, subject, teacher')
    .order('date')
    .order('number');

  // Fetch settings
  const { data: settingsRow } = await supabase
    .from('settings')
    .select('value')
    .eq('key', 'lessonTimes')
    .single();

  // Build the full schedule.json-compatible object
  const result = {};

  if (settingsRow) {
    result._settings = { lessonTimes: settingsRow.value };
  }

  const groupMap = {};
  for (const g of groups) {
    groupMap[g.id] = g.name;
    result[g.name] = {};
  }

  // Fill schedules
  for (const row of (allSchedules || [])) {
    const name = groupMap[row.group_id];
    if (!name) continue;
    if (!result[name][row.week_type]) result[name][row.week_type] = {};
    if (!result[name][row.week_type][row.day]) result[name][row.week_type][row.day] = [];
    result[name][row.week_type][row.day].push({
      number: row.number,
      subject: row.subject,
      teacher: row.teacher
    });
  }

  // Fill substitutions
  for (const row of (allSubs || [])) {
    const name = groupMap[row.group_id];
    if (!name) continue;
    if (!result[name]['ПІДВІСКА']) result[name]['ПІДВІСКА'] = [];
    result[name]['ПІДВІСКА'].push({
      date: row.date,
      number: row.number,
      subject: row.subject,
      teacher: row.teacher
    });
  }

  res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
  return res.json(result);
}

