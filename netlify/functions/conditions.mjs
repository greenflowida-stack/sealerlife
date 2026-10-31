// PeroXcity Mix — job-site conditions backend (Netlify Function)
//
// GET /conditions?address=<street>  → { address, lat, lng, weather, rain, pollen, photo }
// GET /conditions?photo=1&lat=&lng=  → the Street View image (proxied so the key stays private)
//
// Uses the same GOOGLE_MAPS_KEY as /property. Services: Geocoding, Weather, Pollen, Street View Static.

import { logEvent } from '../lib/shared.mjs';

export const config = { path: '/conditions' };

export default async (req) => {
  const url = new URL(req.url);
  const key = process.env.GOOGLE_MAPS_KEY || '';
  if (!key) return json({ error: 'not configured — set GOOGLE_MAPS_KEY in Netlify' }, 503);

  if (url.searchParams.get('photo')) {
    const lat = url.searchParams.get('lat'), lng = url.searchParams.get('lng');
    if (!lat || !lng) return json({ error: 'lat and lng required' }, 400);
    const r = await fetch('https://maps.googleapis.com/maps/api/streetview?size=640x360&location=' + lat + ',' + lng + '&fov=80&source=outdoor&key=' + key);
    if (!r.ok) return json({ error: 'no street view' }, 404);
    return new Response(await r.arrayBuffer(), { status: 200, headers: { 'content-type': r.headers.get('content-type') || 'image/jpeg', 'cache-control': 'public, max-age=86400' } });
  }

  // Satellite tile for the trace tool (proxied: key stays private)
  if (url.searchParams.get('sat')) {
    const lat = url.searchParams.get('lat'), lng = url.searchParams.get('lng'), zoom = Math.max(17, Math.min(21, Number(url.searchParams.get('zoom') || 20)));
    if (!lat || !lng) return json({ error: 'lat and lng required' }, 400);
    const r = await fetch('https://maps.googleapis.com/maps/api/staticmap?center=' + lat + ',' + lng + '&zoom=' + zoom + '&size=640x640&scale=2&maptype=satellite&key=' + key);
    if (!r.ok) { const t = await r.text(); console.error('static map failed:', r.status, t.slice(0, 200)); return json({ error: 'satellite image failed: ' + t.slice(0, 120) }, 502); }
    return new Response(await r.arrayBuffer(), { status: 200, headers: { 'content-type': r.headers.get('content-type') || 'image/png', 'cache-control': 'public, max-age=86400' } });
  }

  const address = (url.searchParams.get('address') || '').trim();
  if (!address) return json({ error: 'address is required' }, 400);

  // Geocode only (trace tool)
  if (url.searchParams.get('geo')) {
    try { const g = await geocode(address, key); logEvent('trace', { device: url.searchParams.get('device') || undefined, address: g.formatted, lat: g.lat, lng: g.lng, sqft: url.searchParams.get('sqft') || undefined, surface: url.searchParams.get('surface') || undefined }); return json({ address: g.formatted, lat: g.lat, lng: g.lng }); }
    catch (e) { return json({ error: e.message }, 502); }
  }

  try {
    const geo = await geocode(address, key);
    const [weather, pollen, hasPhoto] = await Promise.all([
      weatherAt(geo.lat, geo.lng, key).catch(e => ({ error: e.message })),
      pollenAt(geo.lat, geo.lng, key).catch(e => ({ error: e.message })),
      streetViewExists(geo.lat, geo.lng, key).catch(() => false),
    ]);
    const pt = (code) => { const t = pollen && pollen.types && pollen.types.find(x => x.code === code); return t ? t.category : undefined; };
    logEvent('conditions', { device: url.searchParams.get('device') || undefined, address: geo.formatted, lat: geo.lat, lng: geo.lng, tempF: weather.now && weather.now.tempF, rainPct12h: weather.error ? undefined : Math.max(0, ...weather.hours.map(h => h.rainPct)), pollenTree: pt('TREE'), pollenGrass: pt('GRASS'), pollenWeed: pt('WEED') });
    return json({
      address: geo.formatted, lat: geo.lat, lng: geo.lng,
      weather: weather.error ? null : weather,
      rain: weather.error ? null : rainWindow(weather),
      pollen: pollen.error ? null : pollen,
      photo: hasPhoto ? '/conditions?photo=1&lat=' + geo.lat + '&lng=' + geo.lng : null,
      notes: [weather.error, pollen.error].filter(Boolean),
    });
  } catch (e) {
    const raw = e.message || String(e);
    console.error('conditions lookup failed:', raw);
    return json({ error: raw }, 502);
  }
};

async function geocode(address, key) {
  const r = await fetch('https://maps.googleapis.com/maps/api/geocode/json?address=' + encodeURIComponent(address) + '&key=' + key);
  const d = await r.json();
  if (d.status === 'REQUEST_DENIED') throw new Error('geocoding denied: ' + (d.error_message || 'no reason given'));
  if (d.status !== 'OK' || !d.results || !d.results.length) throw new Error('address not found');
  const res = d.results[0];
  return { lat: res.geometry.location.lat, lng: res.geometry.location.lng, formatted: res.formatted_address };
}

// ── Google Weather API: current + next 12 hours ─────────────────
async function weatherAt(lat, lng, key) {
  const loc = 'location.latitude=' + lat + '&location.longitude=' + lng + '&unitsSystem=IMPERIAL&key=' + key;
  const [cr, hr] = await Promise.all([
    fetch('https://weather.googleapis.com/v1/currentConditions:lookup?' + loc),
    fetch('https://weather.googleapis.com/v1/forecast/hours:lookup?hours=12&' + loc),
  ]);
  const c = await cr.json(), h = await hr.json();
  if (c.error) throw new Error('weather: ' + c.error.message);
  if (h.error) throw new Error('weather: ' + h.error.message);
  const hours = (h.forecastHours || []).map(x => ({
    time: x.interval && x.interval.startTime,
    tempF: x.temperature && Math.round(x.temperature.degrees),
    rainPct: (x.precipitation && x.precipitation.probability && x.precipitation.probability.percent) || 0,
    condition: x.weatherCondition && x.weatherCondition.description && x.weatherCondition.description.text,
    windMph: x.wind && x.wind.speed && Math.round(x.wind.speed.value),
  }));
  return {
    now: {
      tempF: c.temperature && Math.round(c.temperature.degrees),
      feelsF: c.feelsLikeTemperature && Math.round(c.feelsLikeTemperature.degrees),
      humidity: c.relativeHumidity,
      windMph: c.wind && c.wind.speed && Math.round(c.wind.speed.value),
      condition: c.weatherCondition && c.weatherCondition.description && c.weatherCondition.description.text,
      isDay: c.isDaytime,
    },
    hours,
  };
}

// First hour with a real chance of rain → how long the surface can stay dry
function rainWindow(w) {
  const THRESH = 40;
  const idx = w.hours.findIndex(h => h.rainPct >= THRESH);
  if (idx < 0) return { dryHours: w.hours.length, nextRain: null, maxPct: Math.max(0, ...w.hours.map(h => h.rainPct)) };
  return { dryHours: idx, nextRain: w.hours[idx].time, nextRainPct: w.hours[idx].rainPct, maxPct: Math.max(...w.hours.map(h => h.rainPct)) };
}

// ── Google Pollen API: today's tree / grass / weed index ────────
async function pollenAt(lat, lng, key) {
  const r = await fetch('https://pollen.googleapis.com/v1/forecast:lookup?location.latitude=' + lat + '&location.longitude=' + lng + '&days=1&plantsDescription=false&key=' + key);
  const d = await r.json();
  if (d.error) throw new Error('pollen: ' + d.error.message);
  const day = (d.dailyInfo || [])[0];
  if (!day) return { types: [], plants: [] };
  const types = (day.pollenTypeInfo || []).map(t => ({
    code: t.code, name: t.displayName,
    value: t.indexInfo ? t.indexInfo.value : 0,
    category: t.indexInfo ? t.indexInfo.category : 'None',
    inSeason: !!t.inSeason,
  }));
  const plants = (day.plantInfo || []).filter(p => p.indexInfo && p.indexInfo.value > 0)
    .sort((a, b) => b.indexInfo.value - a.indexInfo.value).slice(0, 4)
    .map(p => ({ name: p.displayName, value: p.indexInfo.value, category: p.indexInfo.category }));
  return { types, plants, date: day.date };
}

async function streetViewExists(lat, lng, key) {
  const r = await fetch('https://maps.googleapis.com/maps/api/streetview/metadata?location=' + lat + ',' + lng + '&source=outdoor&key=' + key);
  const d = await r.json();
  return d.status === 'OK';
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}
