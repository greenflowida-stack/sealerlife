// Shared helpers for the PeroXcity Mix backend
import { getStore } from '@netlify/blobs';

export const THRESH = 40; // % chance of rain that counts as "rain coming"

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

export async function geocode(address, key) {
  const r = await fetch('https://maps.googleapis.com/maps/api/geocode/json?address=' + encodeURIComponent(address) + '&key=' + key);
  const d = await r.json();
  if (d.status === 'REQUEST_DENIED') throw new Error('geocoding denied: ' + (d.error_message || 'no reason given'));
  if (d.status !== 'OK' || !d.results || !d.results.length) throw new Error('address not found');
  const res = d.results[0];
  const comp = (type) => { const c = (res.address_components || []).find(x => x.types.includes(type)); return c ? c.short_name : undefined; };
  return { lat: res.geometry.location.lat, lng: res.geometry.location.lng, formatted: res.formatted_address,
    county: (comp('administrative_area_level_2') || '').replace(/ County$/, '') || undefined, state: comp('administrative_area_level_1'), zip: comp('postal_code') };
}

// Next N hours of forecast → compact rows
export async function hourly(lat, lng, key, hours = 12) {
  const r = await fetch('https://weather.googleapis.com/v1/forecast/hours:lookup?hours=' + hours + '&location.latitude=' + lat + '&location.longitude=' + lng + '&unitsSystem=IMPERIAL&key=' + key);
  const h = await r.json();
  if (h.error) throw new Error('weather: ' + h.error.message);
  return (h.forecastHours || []).map(x => ({
    time: x.interval && x.interval.startTime,
    tempF: x.temperature && Math.round(x.temperature.degrees),
    rainPct: (x.precipitation && x.precipitation.probability && x.precipitation.probability.percent) || 0,
    condition: x.weatherCondition && x.weatherCondition.description && x.weatherCondition.description.text,
  }));
}

export function rainWindow(hours) {
  const idx = hours.findIndex(h => h.rainPct >= THRESH);
  if (idx < 0) return { dryHours: hours.length, nextRain: null, maxPct: Math.max(0, ...hours.map(h => h.rainPct)) };
  return { dryHours: idx, nextRain: hours[idx].time, nextRainPct: hours[idx].rainPct, maxPct: Math.max(...hours.map(h => h.rainPct)) };
}

// ── Usage log: one small blob per event, append-only ─────────────
export async function logEvent(kind, data) {
  try {
    const store = getStore('events');
    const now = new Date();
    const key = now.toISOString().slice(0, 10) + '/' + now.getTime() + '-' + Math.random().toString(36).slice(2, 8) + '.json';
    await store.setJSON(key, { kind, at: now.toISOString(), ...data });
  } catch (e) { console.warn('log skipped:', e.message); }
}

export function jobsStore() { return getStore('jobs'); }
export function devicesStore() { return getStore('devices'); }

export function fmtTime(iso) {
  try { return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }); } catch (e) { return iso; }
}

// Multi-day jobs: a job runs from job.date for job.days days (default 1)
export function jobEnd(job) { const n = Math.max(1, Number(job.days) || 1); const d = new Date(job.date + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n - 1); return d.toISOString().slice(0, 10); }
export function jobCovers(job, dateStr) { return job.date <= dateStr && dateStr <= jobEnd(job); }
export function localDate(d, offsetDays = 0) { return new Date(d.getTime() + offsetDays * 864e5).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); }
// Rain outlook for one calendar day's working hours (6 AM–6 PM Eastern) from a multi-hour forecast
export function dayOutlook(rows, dateStr) {
  const day = rows.filter(h => { if (!h.time) return false; const t = new Date(h.time); const ds = t.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); const hr = Number(t.toLocaleTimeString('en-US', { hour: 'numeric', hour12: false, timeZone: 'America/New_York' })); return ds === dateStr && hr >= 6 && hr <= 18; });
  if (!day.length) return null;
  const hit = day.find(h => h.rainPct >= THRESH);
  return hit ? { rain: true, at: hit.time, pct: hit.rainPct, maxPct: Math.max(...day.map(h => h.rainPct)) } : { rain: false, maxPct: Math.max(...day.map(h => h.rainPct)) };
}
