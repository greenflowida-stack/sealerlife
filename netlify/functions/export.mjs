// PeroXcity Mix — usage log export (owner only)
// GET /export?key=ADMIN_KEY            → CSV of every logged lookup
// GET /export?key=ADMIN_KEY&from=2026-10-01&to=2026-10-31
import { getStore } from '@netlify/blobs';

export const config = { path: '/export' };

export default async (req) => {
  const url = new URL(req.url);
  const admin = process.env.ADMIN_KEY || '';
  if (!admin || url.searchParams.get('key') !== admin) return new Response('forbidden', { status: 403 });
  const from = url.searchParams.get('from') || '0000', to = url.searchParams.get('to') || '9999';
  const store = getStore('events');
  const { blobs } = await store.list();
  const rows = [];
  for (const b of blobs) {
    const day = b.key.slice(0, 10);
    if (day < from || day > to) continue;
    const e = await store.get(b.key, { type: 'json' });
    if (e) rows.push(e);
  }
  rows.sort((a, b) => (a.at || '').localeCompare(b.at || ''));
  const cols = ['at', 'kind', 'address', 'city', 'state', 'zip', 'county', 'lat', 'lng', 'sqft', 'surface', 'strength', 'roofSqft', 'pitch', 'tempF', 'rainPct12h', 'pollenTree', 'pollenGrass', 'pollenWeed', 'source', 'device'];
  const esc = (v) => v == null ? '' : /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
  const csv = [cols.join(',')].concat(rows.map(r => cols.map(c => esc(r[c])).join(','))).join('\n');
  return new Response(csv, { status: 200, headers: { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="peroxcity-usage.csv"' } });
};
