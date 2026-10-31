// PeroXcity Mix — scheduled rain check
// Runs every 15 minutes.
//  - On-site windows: a job the contractor tapped "On site" on is watched until its window closes; one push per rain event.
//  - 11:00 UTC: morning summary of today's jobs (multi-day jobs included every day they run).
//  - 22:00 UTC: evening look-ahead for tomorrow's jobs, if the phone has it on.

import { jobsStore, devicesStore, hourly, rainWindow, fmtTime, THRESH, logEvent, jobCovers, localDate, dayOutlook } from '../lib/shared.mjs';
import { sendPush, checkActiveJob } from './jobs.mjs';

export const config = { schedule: '*/15 * * * *' };

export default async () => {
  const key = process.env.GOOGLE_MAPS_KEY || '';
  if (!key || !process.env.VAPID_PRIVATE_KEY) { console.log('rain-check: not configured'); return new Response('not configured'); }
  const now = new Date();
  const todayStr = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const morning = now.getUTCHours() === 11 && now.getUTCMinutes() < 15; // 7 AM Eastern in summer, 6 AM in winter
  const evening = now.getUTCHours() === 22 && now.getUTCMinutes() < 15; // 6 PM Eastern in summer, 5 PM in winter
  const tomorrowStr = localDate(now, 1);
  const devices = devicesStore(), jobs = jobsStore();
  const { blobs } = await devices.list();
  let checked = 0, sent = 0, active = 0;
  for (const b of blobs) {
    const dev = await devices.get(b.key, { type: 'json' });
    if (!dev || !dev.subscription) continue;
    const rec = (await jobs.get(b.key, { type: 'json' })) || { jobs: [] };
    // 1. On-site windows: jobs the contractor has started and not finished
    for (const j of rec.jobs) {
      if (!j.endsAt || new Date(j.endsAt).getTime() < Date.now()) continue;
      active++;
      try { const r = await checkActiveJob(b.key, j, key); if (r.alerted) sent++; } catch (e) { console.warn('active check failed', e.message); }
    }
    // 2. Daily summaries: morning (today's jobs) and evening (tomorrow's jobs), each once a day, each switchable per phone
    const isMorning = morning && dev.morning !== false, isEvening = evening && dev.evening !== false;
    if (!isMorning && !isEvening) continue;
    const dateStr = isMorning ? todayStr : tomorrowStr;
    const todays = rec.jobs.filter(j => jobCovers(j, dateStr));
    if (!todays.length) continue;
    const lines = [];
    for (const j of todays) {
      try {
        const where = j.label || shortAddr(j.address);
        const dayN = (Number(j.days) || 1) > 1 ? ' (day ' + (Math.round((new Date(dateStr) - new Date(j.date)) / 864e5) + 1) + ' of ' + j.days + ')' : '';
        if (isMorning) { const rw = rainWindow(await hourly(j.lat, j.lng, key, 12)); lines.push(where + dayN + ': ' + (rw.nextRain ? 'rain ' + rw.nextRainPct + '% by ' + fmtTime(rw.nextRain) : 'clear')); }
        else { const o = dayOutlook(await hourly(j.lat, j.lng, key, 36), dateStr); lines.push(where + dayN + ': ' + (!o ? 'no forecast yet' : o.rain ? 'rain ' + o.pct + '% by ' + fmtTime(o.at) : 'looks clear (max ' + o.maxPct + '%)')); }
        checked++;
      } catch (e) { console.warn('forecast failed for', j.address, e.message); }
    }
    const stamp = { lastCheck: new Date().toISOString(), lastResult: lines.length ? lines.join(' · ') : 'clear' };
    try { await devices.setJSON(b.key, { ...dev, ...stamp }); } catch (e) {}
    if (!lines.length) continue;
    try {
      await sendPush(dev.subscription, { title: (isMorning ? 'Today\'s jobs — ' : 'Tomorrow\'s jobs — ') + (lines.some(l => /rain \d/.test(l)) ? 'rain in the forecast' : 'all clear'), body: lines.join('\n'), url: '/' });
      sent++;
      await logEvent('rain-alert', { device: b.key, jobs: todays.length, lines });
    } catch (e) {
      console.warn('push failed', e.statusCode || '', e.message);
      if (e.statusCode === 404 || e.statusCode === 410) { delete dev.subscription; await devices.setJSON(b.key, dev); } // phone unsubscribed
    }
  }
  console.log('rain-check:', morning ? 'morning summary,' : evening ? 'evening look-ahead,' : 'window check,', 'active', active, 'summary jobs', checked, 'sent', sent, 'threshold', THRESH + '%');
  return new Response('ok');
};

function shortAddr(a) { return String(a).split(',')[0]; }
