// Netlify Function: compute ASSIGNED-volunteer counts per shift LIVE, by
// reading the scheduling site's published schedule over HTTP. This replaces the
// stale static fellow_availability.json on the hosted planner so the numbers are
// always current with what the staff dashboard shows (no manual refresh).
//
// Same output shape as export_fellow_availability.py, so app.js parses it as-is.

const JSON_HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const SCHED = (process.env.SCHED_SITE_URL || 'https://velvety-semolina-29ec06.netlify.app').replace(/\/$/, '');

function json(statusCode, body) {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

export async function handler() {
  try {
    const idxRes = await fetch(`${SCHED}/data/week_index.json?t=${Date.now()}`);
    if (!idxRes.ok) return json(502, { ok: false, error: `week_index fetch failed (${idxRes.status})` });
    const index = await idxRes.json();

    const entries = await Promise.all((index.weeks || []).map(async (w) => {
      const ws = w.week_start, rel = w.assignments_file;
      if (!ws || !rel) return null;
      try {
        const r = await fetch(`${SCHED}/${String(rel).replace(/^\//, '')}`);
        if (!r.ok) return null;
        const a = await r.json();
        const counts = {};
        for (const [k, sh] of Object.entries(a.shifts || {})) {
          const n = Array.isArray(sh.volunteers) ? sh.volunteers.length : 0;
          if (n) counts[k] = n;
        }
        const total = Object.values(counts).reduce((s, x) => s + x, 0);
        return [ws, { published_at: a.published_at || null, assigned_total: total, shift_counts: counts }];
      } catch {
        return null;
      }
    }));

    const weeks = {};
    for (const e of entries) if (e) weeks[e[0]] = e[1];

    return json(200, {
      generated_at: new Date().toISOString(),
      note: 'Aggregated counts only — no volunteer names or personal info.',
      basis: 'assigned',
      source: 'scheduling published schedule (live)',
      weeks,
    });
  } catch (e) {
    return json(502, { ok: false, error: String(e) });
  }
}
