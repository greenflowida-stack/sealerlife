# Sealer Life — field app

Repo greenflowida-stack/sealerlife. The Sealer Life app: the PeroXcity Mix app (measure, mix, price, conditions, rain alerts, AI technician, Outdoor mode) restructured as a platform for the whole Sealer Life product line.

- `index.html` — the app (self-contained bundle).
- `products/catalog.json` — the product catalog. PeroXcity is live; sealers are placeholders until their data sheets arrive.
- `knowledge/` — AI technician briefings per product.
- `netlify/functions/` — backend: /chat (AI technician), /conditions, /property, /jobs, /rain-check, /export.

## Netlify setup (new project from this repo)
Environment variables to copy from the peroxcity-mix project: `ANTHROPIC_API_KEY`, `GOOGLE_MAPS_KEY`, `ADMIN_KEY`, optional `REGRID_TOKEN`.
Generate NEW `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` for this app (push subscriptions are per site).
Domains: app.sealerlife.com (and sealerlife.com).

## Plan
1. Seed = copy of PeroXcity Mix (done).
2. Product catalog drives the mixing/coverage tools; each product brings its own rules and AI briefing.
3. Sealer tools: coverage per coat, coats, dry/recoat/cure timers, temperature and dew-point windows from job conditions.
4. app.peroxcity.com becomes a front door into the PeroXcity section of this app.
