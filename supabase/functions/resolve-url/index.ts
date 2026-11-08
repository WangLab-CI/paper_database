// Supabase Edge Function: resolve-url
// Reads an article web page server-side (browsers can't, because of CORS) and returns
// its <meta> tags so the portal can find the DOI / PMID / title. Members only.
//
// Deploy: Supabase Dashboard → Edge Functions → Deploy a new function → Via Editor,
// name it `resolve-url`, paste this file, Deploy. Keep "Verify JWT" ON.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

// Refuse internal / non-web targets (server-side request forgery guard)
function allowed(u: URL) {
  if (!/^https?:$/.test(u.protocol)) return false;
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.supabase.co')) return false;
  if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) || h.includes(':') || /^\d+$/.test(h)) return false;
  return true;
}

function decode(s: string) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k[0] === '#') return String.fromCodePoint(k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10));
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' } as Record<string, string>)[k] ?? m;
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  // Only approved lab members (role member/admin in public.profiles)
  const auth = req.headers.get('Authorization') ?? '';
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: auth } } });
  const { data: user } = await sb.auth.getUser();
  if (!user?.user) return json({ error: 'not signed in' }, 401);
  const { data: prof } = await sb.from('profiles').select('role').eq('id', user.user.id).maybeSingle();
  if (!prof || !['member', 'admin'].includes(prof.role)) return json({ error: 'members only' }, 403);

  let target: URL;
  try { target = new URL((await req.json()).url); } catch { return json({ error: 'invalid url' }, 400); }
  if (!allowed(target)) return json({ error: 'url not allowed' }, 400);

  try {
    const r = await fetch(target, {
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
        Accept: 'text/html,application/xhtml+xml',
      },
    });
    if (!r.ok) return json({ error: `publisher returned ${r.status}` }, 502);
    // read at most ~1.5 MB; citation tags are in <head>
    const reader = r.body!.getReader();
    let html = '', size = 0;
    const dec = new TextDecoder();
    while (size < 1_500_000) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      html += dec.decode(value, { stream: true });
      if (/<\/head>/i.test(html)) break;
    }
    reader.cancel().catch(() => {});
    const meta: [string, string][] = [];
    for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
      const name = tag.match(/\b(?:name|property)\s*=\s*["']([^"']+)["']/i)?.[1];
      const content = tag.match(/\bcontent\s*=\s*"([^"]*)"/i)?.[1] ?? tag.match(/\bcontent\s*=\s*'([^']*)'/i)?.[1];
      if (name && content != null) meta.push([name, decode(content)]);
    }
    const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
    return json({ final_url: r.url, title: title ? decode(title).replace(/\s+/g, ' ').trim() : null, meta: meta.slice(0, 400) });
  } catch (e) {
    return json({ error: `fetch failed: ${(e as Error).message}` }, 502);
  }
});
