// Netlify Function: write a canvass meeting point to the scheduling site's
// Supabase `session_meeting_points` table for one shift. This is the hosted
// equivalent of push_meeting_point.py (which serve.py runs locally).
//
// Upserts one row per (week_id, shift_key); re-sending updates it. The
// scheduling site shows it as the session's meeting spot (staff + volunteers).
// Reads SUPABASE_URL + SUPABASE_SERVICE_KEY from the Netlify environment.

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

  // Upsert one row per (week_id, shift_key) — PostgREST merges on the PK.
  const row = { week_id, shift_key, label, lat, long: lng, updated_at: new Date().toISOString() };
  const up = await sb('POST', 'session_meeting_points', { body: row, prefer: 'resolution=merge-duplicates,return=representation' });
  if (!up.ok) return json(502, { ok: false, error: `save failed (${up.status}): ${typeof up.data === 'string' ? up.data : JSON.stringify(up.data)}` });
  return json(200, { ok: true, week_id, shift_key, label });
}
