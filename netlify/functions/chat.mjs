// PeroXcity Mix — AI technician
//
// POST /chat { device, messages:[{role:'user'|'assistant', content}] } → { text }
// Calls the Claude API with the PeroXcity knowledge base as the system briefing.
// Needs ANTHROPIC_API_KEY in Netlify (optional CHAT_MODEL). Without a key it returns { text:null, offline:true }
// and the app falls back to its built-in answers.

import { json, logEvent } from '../lib/shared.mjs';
import { KB } from '../lib/kb.mjs';

export const config = { path: '/chat' };

const SYSTEM = `You are the PeroXcity technician inside the PeroXcity Mix field app, used by professional exterior cleaners and homeowners, often on a jobsite on a phone.

How to answer:
- 2 to 5 short sentences, plain American English, no markdown, no bullet lists unless the user asks for a list. Whole ounces only, never decimals.
- Be a confident, friendly tradesman-technician, not a salesperson. Specific and practical.
- Always get the mixing order right: Part A, then water, then Part B slowly. One 32 oz bottle of Part B per gallon of Part A no matter the water.
- Bleach: PeroXcity is an alternative to bleach (sodium hypochlorite), not a crusade against it. Never mock bleach or its users. Concede that bleach is cheaper per jug in some markets; make the true-cost case (corroded equipment, dead landscaping, callbacks, customer pushback). Keep claims to what any contractor has seen. No EPA or Safer Choice claims.
- Safety: when the question touches hazards, include the PPE line (goggles, chemical-resistant gloves; respirator in enclosed spaces) and Poison Control 1-800-222-1222 when relevant. Never give medical advice beyond label first aid; say to call Poison Control or 911.
- If the question is about pricing, orders, shipping, warranty or anything the briefing doesn't cover, say so plainly and offer the PeroXcity line 1-888-253-6962 or the website peroxcity.com.
- If the user asks for a human, say you'll flag a technician.

The briefing below is the only product source of truth. Do not invent ratios, dwell times or claims that are not in it.

=== PEROXCITY BRIEFING ===
` + KB;

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  let body; try { body = await req.json(); } catch (e) { return json({ error: 'bad json' }, 400); }
  // tolerate a value pasted with extra text or whitespace around it: pull out the key itself
  const raw = process.env.ANTHROPIC_API_KEY || '';
  const km = raw.match(/sk-ant-[A-Za-z0-9_\-]{20,}/);
  const key = km ? km[0] : raw.trim().replace(/[^\x21-\x7e]/g, '');
  const model = process.env.CHAT_MODEL || 'claude-haiku-4-5-20251001';
  const msgs = Array.isArray(body.messages) ? body.messages.slice(-10).filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map(m => ({ role: m.role, content: m.content.slice(0, 2000) })) : [];
  if (!msgs.length || msgs[msgs.length - 1].role !== 'user') return json({ error: 'need a user message' }, 400);
  if (!key) return json({ text: null, offline: true });
  if (!/^sk-ant-/.test(key)) return json({ text: null, error: 'key saved in Netlify does not look like an Anthropic API key (should start with sk-ant-)' }, 502);
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 400, system: SYSTEM, messages: msgs }),
    });
    const d = await r.json();
    if (!r.ok) return json({ text: null, error: (d.error && d.error.message) || ('api ' + r.status) }, 502);
    const text = (d.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
    try { await logEvent('chat', { device: body.device || '', q: msgs[msgs.length - 1].content.slice(0, 200), a: text.slice(0, 300) }); } catch (e) {}
    return json({ text });
  } catch (e) {
    return json({ text: null, error: e.message }, 502);
  }
};
