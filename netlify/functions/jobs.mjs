// PeroXcity Mix — saved jobs + rain-alert subscriptions
//
// GET  /jobs?device=ID            → { jobs, alerts, vapid }
// POST /jobs  { device, add: { address, date, label } }     → saves a job (geocoded)
// POST /jobs  { device, remove: jobId }
// POST /jobs  { device, subscription }                       → enable push alerts on this phone
// POST /jobs  { device, unsubscribe: true }
// GET  /jobs?device=ID&test=1     → sends a test push to this phone
//
// Storage: Netlify Blobs. One record per device (the phone), written only by that phone.

import { json, geocode, jobsStore, devicesStore, hourly, rainWindow, fmtTime, logEvent, jobEnd, localDate } from '../lib/shared.mjs';

export const config = { path: '/jobs' };

export default async (req) => {
  const url = new URL(req.url);
  const key = process.env.GOOGLE_MAPS_KEY || '';
  const vapid = process.env.VAPID_PUBLIC_KEY || '';

  if (req.method === 'GET') {
    const device = url.searchParams.get('device');
    if (!device) return json({ error: 'device required' }, 400);
    const rec = (await jobsStore().get(device, { type: 'json' })) || { jobs: [] };
    const dev = await devicesStore().get(device, { type: 'json' });
    if (url.searchParams.get('test')) {
      if (!dev || !dev.subscription) return json({ error: 'alerts are not enabled on this phone yet' }, 400);
      try { await sendPush(dev.subscription, { title: 'PeroXcity rain alerts are on', body: 'You\'ll get a buzz at 7 AM and noon if rain is coming to a saved job.' }); return json({ ok: true }); }
      catch (e) { return json({ error: 'push failed: ' + e.message }, 502); }
    }
    return json({ jobs: rec.jobs, alerts: !!(dev && dev.subscription), morning: !(dev && dev.morning === false), evening: !(dev && dev.evening === false), vapid, lastCheck: dev && dev.lastCheck });
  }

  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  let body; try { body = await req.json(); } catch (e) { return json({ error: 'bad json' }, 400); }
  const device = body.device;
  if (!device || typeof device !== 'string' || device.length > 64) return json({ error: 'device required' }, 400);

  if (body.profit && typeof body.profit === 'object') {
    // anonymous job pricing log — feeds the "what applicators charge" benchmark
    const j = body.profit; const pick = {};
    ['surface','sqft','strength','baseRate','adder','price','kitsUsed','kitPrice','productCost','labor','crew','hours','fuel','other','commission','expenses','profit','margin'].forEach(k => { if (j[k] !== undefined) pick[k] = typeof j[k] === 'string' ? String(j[k]).slice(0, 60) : Number(j[k]); });
    await logEvent('profit', { device, ...pick });
    return json({ ok: true });
  }

  if (body.subscription) {
    const s = body.subscription;
    if (!s.endpoint || !s.keys) return json({ error: 'bad subscription' }, 400);
    const prev = (await devicesStore().get(device, { type: 'json' })) || {};
    await devicesStore().setJSON(device, { ...prev, subscription: s, updated: new Date().toISOString() });
    return json({ ok: true, alerts: true });
  }
  if (typeof body.morning === 'boolean' || typeof body.evening === 'boolean') {
    const prev = (await devicesStore().get(device, { type: 'json' })) || {};
    const next = { ...prev }; if (typeof body.morning === 'boolean') next.morning = body.morning; if (typeof body.evening === 'boolean') next.evening = body.evening;
    await devicesStore().setJSON(device, next);
    return json({ ok: true, morning: next.morning !== false, evening: next.evening !== false });
  }
  if (body.unsubscribe) {
    const prev = (await devicesStore().get(device, { type: 'json' })) || {};
    delete prev.subscription;
    await devicesStore().setJSON(device, { ...prev, updated: new Date().toISOString() });
    return json({ ok: true, alerts: false });
  }

  const rec = (await jobsStore().get(device, { type: 'json' })) || { jobs: [] };
  if (body.start || body.stop) {
    const id = body.start || body.stop;
    const j = rec.jobs.find(x => x.id === id);
    if (!j) return json({ error: 'job not found' }, 404);
    if (body.stop) { j.startedAt = null; j.endsAt = null; j.alertedFor = null; j.urgentFor = null; }
    else {
      const hours = Math.max(1, Math.min(8, Number(body.window) || 3));
      j.startedAt = new Date().toISOString(); j.endsAt = new Date(Date.now() + hours * 3600e3).toISOString(); j.window = hours; j.alertedFor = null; j.urgentFor = null;
    }
    await jobsStore().setJSON(device, rec);
    // Check right away so a bad window is caught at the start, not 15 minutes in
    let outlook = null;
    if (body.start && key) { try { outlook = await checkActiveJob(device, j, key); } catch (e) { outlook = { error: e.message }; } }
    return json({ jobs: rec.jobs, outlook });
  }
  if (body.remove) {
    rec.jobs = rec.jobs.filter(j => j.id !== body.remove);
    await jobsStore().setJSON(device, rec);
    return json({ jobs: rec.jobs });
  }
  if (body.add) {
    const a = body.add;
    if (!a.address || !a.date || !/^\d{4}-\d{2}-\d{2}$/.test(a.date)) return json({ error: 'address and date (YYYY-MM-DD) required' }, 400);
    if (!key) return json({ error: 'not configured' }, 503);
    let geo; try { geo = await geocode(String(a.address).slice(0, 200), key); } catch (e) { return json({ error: e.message }, 502); }
    const days = Math.max(1, Math.min(14, Number(a.days) || 1));
    const job = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), address: geo.formatted, lat: geo.lat, lng: geo.lng, date: a.date, days, label: String(a.label || '').slice(0, 60), created: new Date().toISOString() };
    rec.jobs = [...rec.jobs.filter(j => jobEnd(j) >= today(-7)), job].slice(-40);
    await jobsStore().setJSON(device, rec);
    // Immediate look at the forecast if the job is today or tomorrow
    let outlook = null;
    try { if (job.date <= today(1)) { const rw = rainWindow(await hourly(job.lat, job.lng, key, 12)); outlook = rw.nextRain ? ('Rain ' + rw.nextRainPct + '% by ' + fmtTime(rw.nextRain)) : 'Clear for the next 12 h'; } } catch (e) {}
    return json({ jobs: rec.jobs, outlook });
  }
  return json({ error: 'nothing to do' }, 400);
};

function today(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 864e5);
  return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

export async function sendPush(subscription, payload) {
  const webpush = (await import('web-push')).default;
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:greenflowida@gmail.com', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
  await webpush.sendNotification(subscription, JSON.stringify(payload), { TTL: 6 * 3600 });
}

// Look at the forecast for the rest of an active job's window. Sends ONE push per rain event.
// Returns what it saw (for the immediate response when a job is started).
export async function checkActiveJob(device, job, key) {
  const hoursLeft = Math.max(1, Math.ceil((new Date(job.endsAt).getTime() - Date.now()) / 3600e3));
  const rows = await hourly(job.lat, job.lng, key, hoursLeft + 1);
  const rw = rainWindow(rows);
  if (!rw.nextRain) return { clear: true, hoursLeft };
  const hit = rw.nextRain.slice(0, 13); // hour bucket of the first rainy hour
  const mins = Math.max(0, Math.round((new Date(rw.nextRain).getTime() - Date.now()) / 60000));
  // Two stages per rain event: a heads-up when it first shows, and an urgent one inside 30 minutes.
  const stage = mins <= 30 ? 'urgent' : 'headsup';
  if (job.alertedFor === hit && (stage === 'headsup' || job.urgentFor === hit)) return { alreadyAlerted: true, nextRain: rw.nextRain, pct: rw.nextRainPct, mins };
  const dev = await devicesStore().get(device, { type: 'json' });
  if (dev && dev.subscription) {
    const where = job.label || String(job.address).split(',')[0];
    const when = mins < 60 ? 'in about ' + mins + ' min' : mins < 120 ? 'in about an hour' : 'by ' + fmtTime(rw.nextRain);
    const msg = stage === 'urgent'
      ? { title: 'Rain ' + when + ' — ' + where, body: rw.nextRainPct + '% chance. Rinse now; don\'t start a new section.' }
      : { title: 'Heads up: rain ' + when + ' — ' + where, body: rw.nextRainPct + '% chance at ' + fmtTime(rw.nextRain) + '. Plan to be rinsed before then.' };
    try {
      await sendPush(dev.subscription, { ...msg, url: '/' });
      const rec = (await jobsStore().get(device, { type: 'json' })) || { jobs: [] };
      const k = rec.jobs.find(x => x.id === job.id);
      if (k) { k.alertedFor = hit; if (stage === 'urgent') k.urgentFor = hit; await jobsStore().setJSON(device, rec); }
      job.alertedFor = hit; if (stage === 'urgent') job.urgentFor = hit;
      await logEvent('rain-alert', { device, address: job.address, lat: job.lat, lng: job.lng, rainPct12h: rw.nextRainPct, source: 'on-site ' + stage });
    } catch (e) { console.warn('push failed', e.statusCode || '', e.message); }
  }
  return { alerted: true, stage, nextRain: rw.nextRain, pct: rw.nextRainPct, mins, dryHours: rw.dryHours };
}
