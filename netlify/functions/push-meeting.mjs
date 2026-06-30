// Netlify Function: write a canvass meeting point to the scheduling site's
// Supabase as a session_group "meeting spot" for one shift. This is the hosted
// equivalent of push_meeting_point.py (which serve.py runs locally).
//
// Idempotent: upserts a single group tagged "Canvass meeting point" per
// (week_id, shift_key); never touches groups staff created themselves.
// Reads SUPABASE_URL + SUPABASE_SERVICE_KEY from the Netlify environment.

const GROUP_NAME = 'Canvass meeting point';
const JSON_HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

function json(statusCode, body) {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) };
}
function cfg() {
  return {
    url: (process.env.SUPABASE_URL || '').replace(/\/$/, ''),
    key: process.env.SUPABASE_SERVICE_KEY || '',
  };
}
async function sb(method, table, { params = {}, body, prefer } = {}) {
  const c = cfg();
  const url = new URL(`${c.url}/rest/v1/${table}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const headers = { apikey: c.key, Authorization: `Bearer ${c.key}`, 'Content-Type': 'application/json' };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(url.toString(), {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch { data = text; }
  return { ok: res.ok, status: res.status, data };
}

export async function handler(event) {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'POST only' });
  const c = cfg();
  if (!c.url || !c.key) {
    return json(503, { ok: false, error: 'Set SUPABASE_URL and SUPABASE_SERVICE_KEY in Netlify.' });
  }
  let p;
  try { p = JSON.parse(event.body || '{}'); } catch { return json(400, { ok: false, error: 'Bad JSON' }); }
  const week_start = String(p.week_start || '').trim();
  const shift_key = String(p.shift_key || '').trim();
  const label = String(p.label || 'Meeting point').trim();
  const lat = String(p.lat ?? '').trim();
  const lng = String(p.lng ?? '').trim();
  if (!week_start || !shift_key) return json(400, { ok: false, error: 'Missing week_start or shift_key.' });

  const wk = await sb('GET', 'weeks', { params: { week_start: `eq.${week_start}`, select: 'id', limit: '1' } });
  if (!wk.ok) return json(502, { ok: false, error: `weeks lookup failed (${wk.status})` });
  if (!Array.isArray(wk.data) || !wk.data.length) {
    return json(404, { ok: false, error: `No scheduling week for ${week_start} — open that week first.` });
  }
  const week_id = String(wk.data[0].id);

  const row = {
    week_id, shift_key, name: GROUP_NAME,
    location_lat: lat, location_long: lng, location_note: label,
    position: 0, updated_at: new Date().toISOString(),
  };
  const ex = await sb('GET', 'session_groups', {
    params: { week_id: `eq.${week_id}`, shift_key: `eq.${shift_key}`, name: `eq.${GROUP_NAME}`, select: 'id', limit: '1' },
  });
  if (ex.ok && Array.isArray(ex.data) && ex.data.length) {
    const id = ex.data[0].id;
    const up = await sb('PATCH', 'session_groups', { params: { id: `eq.${id}` }, body: row });
    if (!up.ok) return json(502, { ok: false, error: `update failed (${up.status})` });
    return json(200, { ok: true, action: 'updated', group_id: id, week_id, shift_key, label });
  }
  const ins = await sb('POST', 'session_groups', { body: row, prefer: 'return=representation' });
  if (!ins.ok) return json(502, { ok: false, error: `insert failed (${ins.status})` });
  const gid = Array.isArray(ins.data) && ins.data[0] ? ins.data[0].id : null;
  return json(201, { ok: true, action: 'created', group_id: gid, week_id, shift_key, label });
}
