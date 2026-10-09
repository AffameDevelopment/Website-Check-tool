const KEY = 'website-check/state-v1.json';
const CHANGE_REVIEW_KEY = siteId => `website-check/change-reviews/${siteId}.json`;
const FINDING_REVIEW_KEY = siteId => `website-check/finding-reviews/${siteId}.json`;
const MAX_PAGES_PER_RUN = 30;
const MAX_DISCOVERED = 3000;
const MAX_EVENTS = 1200;
const USER_AGENT = 'WebsiteCheck/1.0 (+scheduled site quality monitor)';
const SNAPSHOT_KEY = /^website-check\/snapshots\/[a-z0-9-]+\/[a-f0-9]{20}\/[a-zA-Z0-9-]+\.json$/;

const seed = () => ({ version: 2, sites: [{ id: 'bonoir-nl', name: 'Bonoir', url: 'https://bonoir.nl/', frequency: 2, enabled: true, cursor: 0, pages: {}, events: [], conflicts: [], reviewedConflicts: [], lastScan: null, lastStatus: 'pending', lastError: null, lastDurationMs: null, discovered: 0, scanned: 0 }], updatedAt: null });
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const hash = async input => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input)))).map(x => x.toString(16).padStart(2, '0')).join('').slice(0, 20);
const eventId = (siteId, event) => hash(JSON.stringify([siteId, event.at, event.type, event.url, event.summary, event.beforeSnapshot || '', event.afterSnapshot || '']));
const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
const decode = s => String(s || '').replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&').replace(/&euro;|&#8364;/gi, '€').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
const safeUrl = value => {
  const u = new URL(value);
  if (!['http:', 'https:'].includes(u.protocol) || !u.hostname.includes('.') || /^(localhost|127\.|0\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1)/i.test(u.hostname)) throw new Error('Gebruik een publieke http(s)-website.');
  u.hash = '';
  return u;
};
const sameHost = (a, b) => { try { return new URL(a).hostname.replace(/^www\./, '') === new URL(b).hostname.replace(/^www\./, ''); } catch { return false; } };
const slug = value => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'website';
const APP_BLOCK = /<!--\s*BEGIN app block:\s*(shopify:\/\/apps\/[^>]*?)\s*-->([\s\S]*?)<!--\s*END app block(?:\s*:[^>]*)?\s*-->/gi;
const maskVolatileHtml = value => String(value || '')
  .replace(/<!--\s*Performance optimized by Redis Object Cache\.[\s\S]*?-->/gi, '<!-- Redis Object Cache diagnostics -->')
  .replace(/<!--\s*This website is like a Rocket[\s\S]*?Debug:\s*cached@\d+\s*-->/gi, '<!-- WP Rocket cache diagnostics -->')
  .replace(/"eventMetadataId"\s*:\s*"[^"]*"/g, '"eventMetadataId":"<rotating>"')
  .replace(/(&quot;stocklevel&quot;\s*:\s*)(?:&quot;)?-?\d+(?:\.\d+)?(?:&quot;)?/gi, '$1<rotating>')
  .replace(/("stocklevel"\s*:\s*)"?-?\d+(?:\.\d+)?"?/gi, '$1<rotating>')
  .replace(/<script\b(?=[^>]*\bid\s*=\s*(["'])__st\1)[^>]*>[\s\S]*?<\/script>/gi, script => script
    .replace(/"reqid"\s*:\s*"[^"]*"/g, '"reqid":"<rotating>"')
    .replace(/"u"\s*:\s*"[^"]*"/g, '"u":"<rotating>"'))
  .replace(/<meta\b(?=[^>]*\bname\s*=\s*(["'])shopify-(?:s|y|paypal)\1)[^>]*>/gi, tag => tag
    .replace(/\b(content|data-expiration)\s*=\s*(["'])[^"']*\2/gi, (_, name, quote) => `${name}=${quote}<rotating>${quote}`));
const separateAppBlocks = value => {
  const html = maskVolatileHtml(value);
  const headEnd = html.search(/<\/head\s*>/i);
  const bodyStart = html.search(/<body\b/i);
  const blocks = [];
  const skeleton = html.replace(APP_BLOCK, (whole, id, content, offset) => {
    const scope = headEnd >= 0 && offset < headEnd ? 'head' : bodyStart >= 0 && offset >= bodyStart ? 'body' : 'other';
    blocks.push({ id: clean(id), scope, html: whole.trim() });
    return '<!-- Shopify app block -->';
  });
  return { skeleton, blocks };
};
const normalizeHtml = value => {
  const { skeleton, blocks } = separateAppBlocks(value);
  if (!blocks.length) return skeleton;
  const sorted = blocks.map(({ id, scope, html }) => [scope, id, html]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return skeleton + '\n<!-- Shopify app blocks by identity -->' + JSON.stringify(sorted);
};
const temperatureRange = value => {
  const text = clean(value).toLowerCase().replace(/,/g, '.');
  const match = text.match(/(\d+(?:\.\d+)?)\s*[–—-]\s*(\d+(?:\.\d+)?)\s*(?:°\s*c|graden\b)/)
    || text.match(/tussen\s+(?:de\s+)?(\d+(?:\.\d+)?)\s+en\s+(?:de\s+)?(\d+(?:\.\d+)?)\s*(?:°\s*c|graden\b)/);
  return match ? [Number(match[1]), Number(match[2])] : null;
};
const compatibleTemperatureAdvice = finding => {
  if (!/bewaar|temperatuur/i.test(`${finding.kind || ''} ${finding.explanation || ''}`)) return false;
  const ranges = (finding.values || []).map(value => temperatureRange(value.pages?.[0]?.phrase || value.value));
  return ranges.length >= 2 && ranges.every(range => range && range[0] <= range[1])
    && Math.max(...ranges.map(range => range[0])) <= Math.min(...ranges.map(range => range[1]));
};
const readState = async env => {
  if (!env.BUCKET) throw new Error('Opslag is niet beschikbaar.');
  const saved = await env.BUCKET.get(KEY);
  const state = saved ? JSON.parse(await saved.text()) : seed();
  if ((state.version || 1) < 2) {
    for (const site of state.sites || []) {
      site.conflicts = [];
      site.reviewedConflicts = [];
      site.lastConflictSignature = null;
      site.events = (site.events || []).filter(event => event.type !== 'conflict' && event.type !== 'shipping');
      delete site.claims;
      for (const page of Object.values(site.pages || {})) delete page.claims;
    }
    state.version = 2;
    await env.BUCKET.put(KEY, JSON.stringify(state), { httpMetadata: { contentType: 'application/json' } });
  }
  let corrected = false;
  for (const site of state.sites || []) for (const field of ['conflicts', 'reviewedConflicts']) {
    const items = site[field] || [];
    const valid = items.filter(item => !compatibleTemperatureAdvice(item));
    if (valid.length !== items.length) { site[field] = valid; corrected = true; }
  }
  for (const site of state.sites || []) {
    const events = site.events || [];
    const valid = events.filter(event => event.type !== 'conflict' || event.source === 'codex');
    if (valid.length !== events.length) { site.events = valid; corrected = true; }
    if (!site.changeReviews) { site.changeReviews = {}; corrected = true; }
    for (const event of site.events || []) if (!event.id) { event.id = await eventId(site.id, event); corrected = true; }
  }
  if (corrected) await env.BUCKET.put(KEY, JSON.stringify(state), { httpMetadata: { contentType: 'application/json' } });
  // Reviews have their own objects so a long-running scan cannot overwrite a
  // Codex decision saved while that scan was still working from an older state.
  for (const site of state.sites || []) {
    const [changes, findings] = await Promise.all([
      env.BUCKET.get(CHANGE_REVIEW_KEY(site.id)),
      env.BUCKET.get(FINDING_REVIEW_KEY(site.id))
    ]);
    if (changes) site.changeReviews = { ...site.changeReviews, ...JSON.parse(await changes.text()) };
    if (findings) site.reviewedConflicts = JSON.parse(await findings.text());
  }
  return state;
};
const writeState = async (env, state) => {
  for (const site of state.sites || []) for (const event of site.events || []) if (!event.id) event.id = await eventId(site.id, event);
  state.updatedAt = new Date().toISOString();
  await env.BUCKET.put(KEY, JSON.stringify(state), { httpMetadata: { contentType: 'application/json' } });
};

async function fetchText(url, limit = 2000000) {
  const started = Date.now();
  const response = await fetch(url, { headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xml,text/xml;q=0.9,*/*;q=0.5' }, redirect: 'follow', signal: AbortSignal.timeout(12000) });
  const type = response.headers.get('content-type') || '';
  if (!response.ok) return { status: response.status, text: '', durationMs: Date.now() - started, type };
  if (!/html|xml|text/i.test(type)) return { status: response.status, text: '', durationMs: Date.now() - started, type };
  const length = Number(response.headers.get('content-length') || 0);
  if (length > limit) return { status: response.status, text: '', durationMs: Date.now() - started, type, oversized: true };
  const text = await response.text();
  if (text.length > limit) return { status: response.status, text: '', durationMs: Date.now() - started, type, oversized: true };
  return { status: response.status, text, durationMs: Date.now() - started, type };
}

async function discover(base) {
  const found = new Set([base]);
  try {
    const home = await fetchText(base);
    for (const m of home.text.matchAll(/<a\b[^>]*href=["']([^"']+)["']/gi)) {
      try {
        const link = new URL(decode(m[1]), base);
        link.hash = ''; link.search = '';
        const linked = link.href;
        if (sameHost(linked, base) && !/\.(?:jpe?g|png|webp|gif|svg|pdf|zip)(?:\?|$)/i.test(linked) && !/\/(?:cart|account|checkout)(?:\/|$)/i.test(link.pathname)) found.add(linked);
      } catch { /* Ignore broken links. */ }
    }
  } catch { /* The homepage will be checked again in the scan. */ }
  const pending = [new URL('/sitemap.xml', base).href];
  const visited = new Set();
  while (pending.length && visited.size < 14 && found.size < MAX_DISCOVERED) {
    const url = pending.shift();
    if (visited.has(url)) continue;
    visited.add(url);
    try {
      const { status, text } = await fetchText(url, 1800000);
      if (status !== 200 || !text) continue;
      for (const m of text.matchAll(/<loc>([\s\S]*?)<\/loc>/gi)) {
        const candidate = decode(m[1]).trim();
        if (!sameHost(candidate, base)) continue;
        if (/\.xml(?:\?|$)/i.test(candidate)) { if (pending.length < 40) pending.push(candidate); }
        else if (!/\.(?:jpe?g|png|webp|gif|svg|pdf|zip)(?:\?|$)/i.test(candidate)) found.add(candidate.split('#')[0]);
        if (found.size >= MAX_DISCOVERED) break;
      }
    } catch { /* A missing sitemap should not block the homepage check. */ }
  }
  const urls = Array.from(found);
  const priority = url => url === base ? -2 : /\/(?:pages|policies|faq|help|over-ons|about|contact|service|informatie|voorwaarden)(?:\/|$)/i.test(new URL(url).pathname) ? -1 : 0;
  return urls.sort((a, b) => priority(a) - priority(b));
}

function extractFacts(html, url) {
  const body = (html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i) || [, html])[1];
  const blocks = decode(body.replace(/<script\b[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[\s\S]*?<\/style>/gi, ' ').replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ').replace(/<!--[^]*?-->/g, ' ').replace(/<\/?(?:p|li|h[1-6]|div|section|article|tr|td|th|br)\b[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' ')).split(/\n+/).map(clean).filter(Boolean);
  const facts = new Map();
  const polarityFacts = new Map();
  const productPage = /\/(?:products?|collections?|product-category)\//i.test(new URL(url).pathname);
  for (const block of blocks.slice(0, 1000)) {
    for (const raw of block.split(/(?<=[.!?])\s+/)) {
      const phrase = clean(raw).slice(0, 220);
      if (phrase.length < 9 || phrase.length > 180 || /https?:\/\/|@/.test(phrase)) continue;
      const lower = phrase.toLocaleLowerCase('nl-NL').replace(/[’]/g, "'").replace(/[\s.,;!]+$/g, '');
      const words = lower.match(/[\p{L}\p{N}]+/gu) || [];
      const labelled = lower.match(/^([^:]{4,55}):\s*(.{2,115})$/);
      let labelledAdded = false;
      if (labelled && !productPage && !/\d$/.test(labelled[1])) {
        const label = clean(labelled[1]);
        const value = clean(labelled[2]);
        const key = `label:${label}`;
        facts.set(`${key}|${value}`, { key, subject: label, value, phrase, url, source: 'label' });
        labelledAdded = true;
      }
      const numbers = lower.match(/\d+(?:[.,:–-]\d+)*/g) || [];
      if (!labelledAdded && numbers.length === 1 && words.length >= 4 && words.length <= 25) {
        const template = lower.replace(/\d+(?:[.,:–-]\d+)*/g, '#').replace(/\s+/g, ' ').trim();
        if ((template.match(/[\p{L}]{2,}/gu) || []).length >= 3) {
          const key = `number:${template}`;
          const value = numbers.map(n => n.replace(',', '.')).join(' / ');
          facts.set(`${key}|${value}`, { key, subject: template.replace(/#/g, '…').slice(0, 100), value, phrase, url, source: 'number' });
        }
      }
      if (words.length >= 3 && words.length <= 22 && /\b(?:niet|geen|nooit|zonder)\b/.test(lower)) {
        const template = lower.replace(/\b(?:niet|geen|nooit|zonder)\b/g, '').replace(/\s+/g, ' ').trim();
        if (template.length >= 16) {
          const key = `polarity:${template}`;
          polarityFacts.set(`${key}|nee`, { key, subject: template.slice(0, 100), value: 'ontkend', phrase, url, source: 'polarity' });
        }
      } else if (words.length >= 3 && words.length <= 22) {
        const key = `polarity:${lower}`;
        polarityFacts.set(`${key}|ja`, { key, subject: lower.slice(0, 100), value: 'bevestigd', phrase, url, source: 'polarity' });
      }
    }
  }
  return [...facts.values(), ...polarityFacts.values()].slice(0, 90);
}

function extract(html, url) {
  const title = decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [,''])[1]);
  const description = decode((html.match(/<meta\s+[^>]*name=["']description["'][^>]*content=["']([^"']*)/i) || [,''])[1]);
  const css = [...html.matchAll(/<link\b[^>]*rel=["'][^"']*stylesheet[^"']*["'][^>]*>/gi)].map(m => (m[0].match(/href=["']([^"']+)/i) || [,''])[1]).filter(Boolean).sort();
  const scripts = [...html.matchAll(/<script\b[^>]*src=["']([^"']+)/gi)].map(m => m[1]).filter(Boolean).sort();
  const removed = html.replace(/<script\b[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[\s\S]*?<\/style>/gi, ' ').replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ').replace(/<!--[^]*?-->/g, ' ');
  const text = clean(decode(removed.replace(/<[^>]+>/g, ' ')));
  const prices = new Set();
  for (const m of html.matchAll(/(?:"price"\s*:\s*"?)(\d+(?:[.,]\d{1,2})?)/gi)) prices.add(m[1].replace(',', '.'));
  for (const m of text.matchAll(/(?:€\s?|EUR\s?)(\d{1,5}(?:[.,]\d{2})?)/gi)) prices.add(m[1].replace(',', '.'));
  const facts = extractFacts(html, url);
  return { url, title: clean(title), description: clean(description), text, prices: [...prices].sort(), css, scripts, facts };
}

async function scanSite(site, env) {
  const started = Date.now();
  const now = new Date().toISOString();
  const base = safeUrl(site.url).href;
  const urls = await discover(base);
  site.discovered = urls.length;
  const cursor = site.cursor || 0;
  const chosen = urls.length <= MAX_PAGES_PER_RUN ? urls : [...urls.slice(cursor, cursor + MAX_PAGES_PER_RUN), ...urls.slice(0, Math.max(0, cursor + MAX_PAGES_PER_RUN - urls.length))].slice(0, MAX_PAGES_PER_RUN);
  site.cursor = urls.length ? (cursor + chosen.length) % urls.length : 0;
  const events = [];
  let ok = 0, failures = 0;
  for (let i = 0; i < chosen.length; i += 5) {
    const batch = chosen.slice(i, i + 5);
    const results = await Promise.all(batch.map(async url => {
      try { return { url, result: await fetchText(url) }; }
      catch (error) { return { url, error: String(error.message || error) }; }
    }));
    for (const { url, result, error } of results) {
      const previous = site.pages[url];
      if (error || !result || result.status >= 400 || result.status === 0) {
        failures++;
        const status = result?.status || 0;
        site.pages[url] = { ...(previous || {}), url, status, error: error || `HTTP ${status}`, checkedAt: now };
        if (!previous || previous.status !== status || previous.error !== site.pages[url].error) events.push({ at: now, type: 'error', url, summary: site.pages[url].error });
        continue;
      }
      ok++;
      if (!result.text) {
        if (result.oversized) {
          failures++;
          if (previous?.error !== 'Pagina groter dan scanlimiet (2 MB)') events.push({ at: now, type: 'error', url, summary: 'Pagina groter dan scanlimiet (2 MB)' });
        }
        site.pages[url] = { ...(previous || {}), url, status: result.status, error: result.oversized ? 'Pagina groter dan scanlimiet (2 MB)' : null, checkedAt: now, durationMs: result.durationMs };
        continue;
      }
      const page = extract(result.text, url);
      const next = { url, title: page.title, description: page.description, prices: page.prices, facts: page.facts, status: result.status, durationMs: result.durationMs, checkedAt: now, textHash: await hash(page.text), htmlHash: await hash(normalizeHtml(result.text)), htmlHashVersion: 4, themeHash: await hash(page.css.join('|') + '|' + page.scripts.join('|')), textSample: page.text.slice(0, 260) };
      let previousHtmlHash = previous?.htmlHash || null;
      if (previous && previous.htmlHashVersion !== 4) {
        const saved = previous.snapshotKey ? await env.BUCKET.get(previous.snapshotKey) : null;
        const snapshot = saved ? JSON.parse(await saved.text()) : null;
        previousHtmlHash = snapshot?.html ? await hash(normalizeHtml(snapshot.html)) : null;
      }
      const htmlChanged = Boolean(previousHtmlHash && previousHtmlHash !== next.htmlHash);
      const eventStart = events.length;
      if (!previous || htmlChanged || previous.status !== next.status || previous.textHash !== next.textHash || previous.themeHash !== next.themeHash || JSON.stringify(previous.prices || []) !== JSON.stringify(next.prices) || JSON.stringify(previous.facts || []) !== JSON.stringify(next.facts)) {
        const snapshotKey = `website-check/snapshots/${site.id}/${await hash(url)}/${Date.now()}-${crypto.randomUUID()}.json`;
        await env.BUCKET.put(snapshotKey, JSON.stringify({ checkedAt: now, url, status: result.status, title: page.title, description: page.description, text: page.text, html: result.text, prices: page.prices, css: page.css, scripts: page.scripts, facts: page.facts }), { httpMetadata: { contentType: 'application/json' } });
        next.snapshotKey = snapshotKey;
      } else next.snapshotKey = previous.snapshotKey;
      if (previous) {
        if (previous.status !== 200) events.push({ at: now, type: 'recovery', url, summary: `Pagina hersteld: HTTP ${result.status}` });
        if (previous.textHash && previous.textHash !== next.textHash) events.push({ at: now, type: 'text', url, summary: 'Zichtbare tekst gewijzigd', before: previous.textSample || '', after: next.textSample });
        if (htmlChanged && previous.textHash === next.textHash) events.push({ at: now, type: 'html', url, summary: 'HTML gewijzigd zonder tekstwijziging', normalized: true });
        if (previous.themeHash && previous.themeHash !== next.themeHash) events.push({ at: now, type: 'theme', url, summary: 'CSS- of scriptbestanden gewijzigd' });
        if (JSON.stringify(previous.prices || []) !== JSON.stringify(next.prices)) events.push({ at: now, type: 'price', url, summary: `Prijzen: ${(previous.prices || []).join(', ') || '—'} → ${next.prices.join(', ') || '—'}` });
        if (JSON.stringify((previous.facts || []).map(c => [c.key, c.value])) !== JSON.stringify(next.facts.map(c => [c.key, c.value])) && previous.facts) events.push({ at: now, type: 'facts', url, summary: 'Feitelijke claims gewijzigd' });
        if (previous.title !== next.title || previous.description !== next.description) events.push({ at: now, type: 'meta', url, summary: 'Titel of metabeschrijving gewijzigd' });
      }
      for (const event of events.slice(eventStart)) { event.beforeSnapshot = previous?.snapshotKey || null; event.afterSnapshot = next.snapshotKey || null; }
      site.pages[url] = next;
    }
  }
  const grouped = new Map();
  for (const page of Object.values(site.pages)) for (const fact of page.facts || []) {
    if (!grouped.has(fact.key)) grouped.set(fact.key, { subject: fact.subject, source: fact.source, values: new Map() });
    const values = grouped.get(fact.key).values;
    if (!values.has(fact.value)) values.set(fact.value, []);
    if (values.get(fact.value).length < 8) values.get(fact.value).push({ url: fact.url, phrase: fact.phrase });
  }
  site.conflicts = [...grouped].filter(([, group]) => group.values.size > 1).slice(0, 100).map(([, group]) => ({ kind: group.subject, source: group.source, values: [...group.values].map(([value, pages]) => ({ value, pages })) })).filter(item => !compatibleTemperatureAdvice(item));
  const conflictSignature = JSON.stringify(site.conflicts.map(c => [c.kind, c.values.map(v => v.value)]));
  site.lastConflictSignature = conflictSignature;
  site.events = [...events.reverse(), ...(site.events || [])].slice(0, MAX_EVENTS);
  site.lastScan = now;
  site.lastStatus = failures ? (ok ? 'warning' : 'error') : 'ok';
  site.lastError = failures ? `${failures} pagina's niet bereikbaar` : null;
  site.lastDurationMs = Date.now() - started;
  site.scanned = chosen.length;
  return { site: site.name, status: site.lastStatus, discovered: site.discovered, scanned: chosen.length, failed: failures, changes: events.length, conflicts: (site.reviewedConflicts || []).length, candidates: site.conflicts.length, durationMs: site.lastDurationMs };
}

function due(site, now = new Date()) {
  if (!site.enabled) return false;
  if (!site.lastScan) return true;
  const hours = site.frequency === 2 ? 11 : 23;
  return now - new Date(site.lastScan) >= hours * 3600000;
}

async function runScans(env, { siteId = null, onlyDue = false } = {}) {
  const state = await readState(env);
  const selected = state.sites.filter(s => s.enabled && (!siteId || s.id === siteId) && (!onlyDue || due(s)));
  const results = [];
  for (const site of selected) {
    try { results.push(await scanSite(site, env)); }
    catch (error) {
      const message = String(error.message || error);
      site.lastScan = new Date().toISOString(); site.lastStatus = 'error'; site.lastError = message;
      site.events.unshift({ at: site.lastScan, type: 'error', url: site.url, summary: message });
      site.events = site.events.slice(0, MAX_EVENTS);
      results.push({ site: site.name, status: 'error', error: message });
    }
    await writeState(env, state);
  }
  return { checkedAt: new Date().toISOString(), results, skipped: state.sites.length - selected.length };
}

async function reviewBundle(env, siteId) {
  const state = await readState(env);
  const site = state.sites.find(s => s.id === siteId);
  if (!site) throw new Error('Website niet gevonden.');
  const recent = Object.values(site.pages || {}).filter(p => p.snapshotKey).sort((a, b) => String(b.checkedAt).localeCompare(String(a.checkedAt))).slice(0, 30);
  const pages = await Promise.all(recent.map(async page => {
    const saved = await env.BUCKET.get(page.snapshotKey);
    const snapshot = saved ? JSON.parse(await saved.text()) : null;
    return { url: page.url, title: page.title, checkedAt: page.checkedAt, text: (snapshot?.text || '').slice(0, 1200), facts: (page.facts || []).slice(0, 12) };
  }));
  return { siteId, name: site.name, lastScan: site.lastScan, pages, candidates: site.conflicts || [], reviewedConflicts: site.reviewedConflicts || [] };
}

async function pageText(env, siteId, url) {
  const state = await readState(env);
  const site = state.sites.find(s => s.id === siteId);
  const page = site?.pages?.[url];
  if (!page?.snapshotKey) throw new Error('Gecontroleerde pagina niet gevonden.');
  const saved = await env.BUCKET.get(page.snapshotKey);
  if (!saved) throw new Error('Momentopname niet gevonden.');
  const snapshot = JSON.parse(await saved.text());
  return { url, title: page.title, checkedAt: page.checkedAt, text: snapshot.text.slice(0, 30000) };
}

async function recordFindings(env, { siteId, findings }) {
  const state = await readState(env);
  const site = state.sites.find(s => s.id === siteId);
  if (!site) throw new Error('Website niet gevonden.');
  if (!Array.isArray(findings) || findings.length > 20) throw new Error('Geef maximaal 20 bevindingen op.');
  const accepted = [];
  for (const finding of findings) {
    const kind = clean(finding.subject).slice(0, 120);
    const explanation = clean(finding.explanation).slice(0, 400);
    const evidence = finding.evidence;
    if (!kind || !explanation || !Array.isArray(evidence) || evidence.length < 2 || evidence.length > 4) throw new Error('Elke bevinding vereist een onderwerp, uitleg en twee tot vier broncitaten.');
    const values = [];
    for (const item of evidence) {
      const url = String(item.url || '');
      const quote = clean(item.quote).slice(0, 300);
      if (quote.length < 8) throw new Error('Broncitaat is te kort.');
      const page = site.pages?.[url];
      if (!page?.snapshotKey) throw new Error('Bronpagina hoort niet bij deze website.');
      const saved = await env.BUCKET.get(page.snapshotKey);
      const snapshot = saved ? JSON.parse(await saved.text()) : null;
      if (!snapshot || !snapshot.text.toLocaleLowerCase('nl-NL').includes(quote.toLocaleLowerCase('nl-NL'))) throw new Error('Broncitaat staat niet in de actuele momentopname.');
      values.push({ value: quote, pages: [{ url, phrase: quote }] });
    }
    const reviewed = { kind, explanation, source: 'codex', reviewedAt: new Date().toISOString(), values };
    if (compatibleTemperatureAdvice(reviewed)) throw new Error('Deze temperatuurbereiken overlappen en bewijzen geen tegenstrijdigheid.');
    accepted.push(reviewed);
  }
  const existing = site.reviewedConflicts || [];
  for (const finding of accepted) {
    const signature = JSON.stringify([finding.kind, finding.values.map(v => v.pages[0].url).sort()]);
    const index = existing.findIndex(item => JSON.stringify([item.kind, item.values.map(v => v.pages[0].url).sort()]) === signature);
    if (index >= 0) existing[index] = finding;
    else existing.push(finding);
  }
  site.reviewedConflicts = existing.slice(-40);
  if (accepted.length) {
    await env.BUCKET.put(FINDING_REVIEW_KEY(siteId), JSON.stringify(site.reviewedConflicts), { httpMetadata: { contentType: 'application/json' } });
    await writeState(env, state);
  }
  return { siteId, saved: accepted.length, total: site.reviewedConflicts.length };
}

function diffTokens(value, mode) {
  return mode === 'html'
    ? String(value || '').match(/<!--[\s\S]*?-->|<script\b[^>]*>[\s\S]*?<\/script>|<style\b[^>]*>[\s\S]*?<\/style>|<[^>]+>|[^<]+/gi) || []
    : String(value || '').match(/\S+\s*/g) || [];
}

function changedExcerpt(value, mode) {
  const formatted = mode === 'html' ? value.replace(/></g, '>\n<') : value;
  if (formatted.length <= 1100) return formatted || '—';
  return `${formatted.slice(0, 750)}\n… ${formatted.length - 1000} tekens overgeslagen …\n${formatted.slice(-250)}`;
}

function focusedChange(before, after, mode) {
  if (Math.max(before.length, after.length) <= 1100) return { before: changedExcerpt(before, mode), after: changedExcerpt(after, mode) };
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - suffix - 1] === after[after.length - suffix - 1]) suffix++;
  const beforeContext = before.slice(Math.max(0, prefix - 80), prefix);
  const afterContext = before.slice(before.length - suffix, before.length - suffix + 80);
  return {
    before: changedExcerpt(beforeContext + before.slice(prefix, before.length - suffix) + afterContext, mode),
    after: changedExcerpt(beforeContext + after.slice(prefix, after.length - suffix) + afterContext, mode)
  };
}

function changeType(before, after, mode) {
  if (mode === 'text') return 'Zichtbare tekst';
  const sample = `${before.slice(0, 500)} ${after.slice(0, 500)}`;
  if (/<script\b|<script\s|__NEXT_DATA__|application\/ld\+json/i.test(sample)) return 'Script of ingebedde gegevens';
  if (/<style\b|\.css\b|<link\b[^>]*stylesheet/i.test(sample)) return 'CSS of opmaak';
  if (/<meta\b|<title\b/i.test(sample)) return 'Metadata';
  if (/<!--/.test(sample)) return 'HTML-opmerking';
  return 'HTML-element of attribuut';
}

function compareSnapshots(before, after, mode) {
  const oldTokens = diffTokens(before, mode);
  const newTokens = diffTokens(after, mode);
  if (before === after) return { total: 0, hunks: [], truncated: false };
  const tooLarge = oldTokens.length > 30000 || newTokens.length > 30000;
  const matches = [];
  let limited = tooLarge;
  if (!tooLarge) {
    const positions = new Map();
    for (let index = 0; index < newTokens.length; index++) {
      const token = newTokens[index];
      if (!positions.has(token)) positions.set(token, []);
      const found = positions.get(token);
      if (found.length <= 50) found.push(index);
    }
    const pending = [[0, oldTokens.length, 0, newTokens.length]];
    let examined = 0;
    while (pending.length) {
      const [oldStart, oldEnd, newStart, newEnd] = pending.pop();
      examined += oldEnd - oldStart;
      if (examined > 120000) { limited = true; break; }
      let bestOld = 0, bestNew = 0, bestLength = 0;
      let previous = new Map();
      for (let oldIndex = oldStart; oldIndex < oldEnd; oldIndex++) {
        const current = new Map();
        const found = positions.get(oldTokens[oldIndex]) || [];
        if (found.length > 50) { previous = current; continue; }
        for (const newIndex of found) {
          if (newIndex < newStart || newIndex >= newEnd) continue;
          const length = (previous.get(newIndex - 1) || 0) + 1;
          current.set(newIndex, length);
          if (length > bestLength) { bestOld = oldIndex - length + 1; bestNew = newIndex - length + 1; bestLength = length; }
        }
        previous = current;
      }
      if (bestLength) {
        matches.push([bestOld, bestNew, bestLength]);
        if (oldStart < bestOld || newStart < bestNew) pending.push([oldStart, bestOld, newStart, bestNew]);
        if (bestOld + bestLength < oldEnd || bestNew + bestLength < newEnd) pending.push([bestOld + bestLength, oldEnd, bestNew + bestLength, newEnd]);
      }
    }
    matches.sort((a, b) => a[0] - b[0]);
  }
  matches.push([oldTokens.length, newTokens.length, 0]);
  const hunks = [];
  let oldCursor = 0, newCursor = 0;
  for (const [oldIndex, newIndex, length] of matches) {
    if (oldIndex > oldCursor || newIndex > newCursor) {
      const removed = oldTokens.slice(oldCursor, oldIndex).join('');
      const added = newTokens.slice(newCursor, newIndex).join('');
      if (removed !== added) hunks.push({ kind: changeType(removed, added, mode), ...focusedChange(removed, added, mode), removedLength: removed.length, addedLength: added.length });
    }
    oldCursor = oldIndex + length;
    newCursor = newIndex + length;
  }
  if (!hunks.length) hunks.push({ kind: changeType(before, after, mode), ...focusedChange(before, after, mode), removedLength: before.length, addedLength: after.length });
  return { total: hunks.length, hunks: hunks.slice(0, 100), truncated: limited || hunks.length > 100 };
}

function compareHtml(before, after) {
  const oldParts = separateAppBlocks(before);
  const newParts = separateAppBlocks(after);
  const core = compareSnapshots(oldParts.skeleton, newParts.skeleton, 'html');
  const oldById = new Map();
  const newById = new Map();
  for (const [blocks, target] of [[oldParts.blocks, oldById], [newParts.blocks, newById]]) for (const block of blocks) {
    const key = `${block.scope}:${block.id}`;
    if (!target.has(key)) target.set(key, []);
    target.get(key).push(block);
  }
  const appHunks = [];
  for (const key of new Set([...oldById.keys(), ...newById.keys()])) {
    const oldBlocks = oldById.get(key) || [];
    const newBlocks = newById.get(key) || [];
    const name = key.split('/apps/')[1]?.split('/')[0]?.replace(/-/g, ' ') || key;
    for (let index = 0; index < Math.max(oldBlocks.length, newBlocks.length); index++) {
      const removed = oldBlocks[index]?.html || '';
      const added = newBlocks[index]?.html || '';
      if (removed === added) continue;
      const action = removed && added ? 'gewijzigd' : removed ? 'verwijderd' : 'toegevoegd';
      appHunks.push({ kind: `Shopify-app ${name} ${action}`, ...focusedChange(removed, added, 'html'), removedLength: removed.length, addedLength: added.length });
    }
  }
  const oldOrder = oldParts.blocks.map(block => `${block.scope}:${block.id}`).join('\n');
  const newOrder = newParts.blocks.map(block => `${block.scope}:${block.id}`).join('\n');
  const reorderedAppBlocks = oldOrder !== newOrder && [...oldById.keys()].sort().join('\n') === [...newById.keys()].sort().join('\n');
  const hunks = [...appHunks, ...core.hunks];
  return { total: appHunks.length + core.total, hunks: hunks.slice(0, 100), truncated: core.truncated || hunks.length > 100, reorderedAppBlocks };
}

const CHANGE_TYPES = new Set(['price', 'text', 'html', 'theme', 'meta', 'facts']);

async function loadEventSnapshots(env, event) {
  const [savedBefore, savedAfter] = await Promise.all([
    event.beforeSnapshot ? env.BUCKET.get(event.beforeSnapshot) : null,
    event.afterSnapshot ? env.BUCKET.get(event.afterSnapshot) : null
  ]);
  return {
    before: savedBefore ? JSON.parse(await savedBefore.text()) : null,
    after: savedAfter ? JSON.parse(await savedAfter.text()) : null
  };
}

async function reviewChanges(env, { siteId, cursor = 0, limit = 10 }) {
  const state = await readState(env);
  const site = state.sites.find(item => item.id === siteId);
  if (!site) throw new Error('Website niet gevonden.');
  const offset = Math.max(0, Number(cursor) || 0);
  const size = Math.min(20, Math.max(1, Number(limit) || 10));
  const pending = (site.events || []).filter(event => CHANGE_TYPES.has(event.type) && !site.changeReviews?.[event.id]);
  const items = [];
  for (const event of pending.slice(offset, offset + size)) {
    const { before, after } = await loadEventSnapshots(env, event);
    const text = compareSnapshots(before?.text || '', after?.text || '', 'text');
    const html = compareHtml(before?.html || '', after?.html || '');
    items.push({
      id: event.id, at: event.at, type: event.type, url: event.url, summary: event.summary,
      snapshotsAvailable: Boolean(before && after),
      textChanges: text.hunks.slice(0, 3).map(hunk => ({ before: hunk.before.slice(0, 400), after: hunk.after.slice(0, 400) })),
      htmlChanges: html.hunks.slice(0, 5).map(hunk => ({ kind: hunk.kind, before: hunk.before.slice(0, 400), after: hunk.after.slice(0, 400) })),
      htmlChangeCount: html.total, appBlocksReordered: html.reorderedAppBlocks,
      onlyDynamicHtml: Boolean(before && after && before.html !== after.html && normalizeHtml(before.html) === normalizeHtml(after.html)),
      beforeTextExcerpt: (before?.text || '').slice(0, 500), afterTextExcerpt: (after?.text || '').slice(0, 500)
    });
  }
  return { siteId, pending: pending.length, cursor: offset, nextCursor: offset + size < pending.length ? offset + size : null, items };
}

async function changeContext(env, { siteId, eventId: id }) {
  const state = await readState(env);
  const site = state.sites.find(item => item.id === siteId);
  const event = site?.events?.find(item => item.id === id);
  if (!event) throw new Error('Wijziging niet gevonden.');
  const { before, after } = await loadEventSnapshots(env, event);
  const html = compareHtml(before?.html || '', after?.html || '');
  return { id, type: event.type, url: event.url, at: event.at, beforeText: (before?.text || '').slice(0, 30000), afterText: (after?.text || '').slice(0, 30000), htmlChanges: html.hunks.slice(0, 20), htmlChangeCount: html.total, appBlocksReordered: html.reorderedAppBlocks };
}

async function recordChangeReviews(env, { siteId, reviews }) {
  const state = await readState(env);
  const site = state.sites.find(item => item.id === siteId);
  if (!site) throw new Error('Website niet gevonden.');
  if (!Array.isArray(reviews) || reviews.length < 1 || reviews.length > 20) throw new Error('Geef 1 tot 20 beoordelingen op.');
  const events = new Map((site.events || []).map(event => [event.id, event]));
  for (const review of reviews) {
    const event = events.get(review.id);
    const decision = String(review.decision || '');
    const title = clean(review.title).slice(0, 140);
    const explanation = clean(review.explanation).slice(0, 600);
    if (!event || !CHANGE_TYPES.has(event.type)) throw new Error('Wijziging hoort niet bij deze website.');
    if (!['meaningful', 'noise', 'uncertain'].includes(decision) || !title || explanation.length < 8) throw new Error('Elke beoordeling vereist een besluit, titel en concrete uitleg.');
    site.changeReviews[review.id] = { decision, title, explanation, reviewedAt: new Date().toISOString(), source: 'codex' };
  }
  await env.BUCKET.put(CHANGE_REVIEW_KEY(siteId), JSON.stringify(site.changeReviews), { httpMetadata: { contentType: 'application/json' } });
  await writeState(env, state);
  return { siteId, saved: reviews.length, remaining: (site.events || []).filter(event => CHANGE_TYPES.has(event.type) && !site.changeReviews?.[event.id]).length };
}

async function handleApi(request, env, path) {
  if (path === '/api/state' && request.method === 'GET') return json(await readState(env));
  if (path === '/api/snapshot' && request.method === 'GET') {
    const key = new URL(request.url).searchParams.get('key') || '';
    if (!SNAPSHOT_KEY.test(key)) return json({ error: 'Ongeldige momentopname.' }, 400);
    const saved = await env.BUCKET.get(key);
    return saved ? json(JSON.parse(await saved.text())) : json({ error: 'Momentopname niet gevonden.' }, 404);
  }
  if (path === '/api/diff' && request.method === 'GET') {
    const params = new URL(request.url).searchParams;
    const beforeKey = params.get('before') || '';
    const afterKey = params.get('after') || '';
    if (!SNAPSHOT_KEY.test(afterKey) || (beforeKey && !SNAPSHOT_KEY.test(beforeKey))) return json({ error: 'Ongeldige momentopname.' }, 400);
    const [savedBefore, savedAfter] = await Promise.all([beforeKey ? env.BUCKET.get(beforeKey) : null, env.BUCKET.get(afterKey)]);
    if (!savedAfter || (beforeKey && !savedBefore)) return json({ error: 'Momentopname niet gevonden.' }, 404);
    const before = savedBefore ? JSON.parse(await savedBefore.text()) : null;
    const after = JSON.parse(await savedAfter.text());
    const beforeHtml = normalizeHtml(before?.html || '');
    const afterHtml = normalizeHtml(after.html || '');
    const html = compareHtml(before?.html || '', after.html || '');
    return json({ hasBefore: Boolean(before), ignoredDynamic: Boolean(before && before.html !== after.html && beforeHtml === afterHtml), text: compareSnapshots(before?.text || '', after.text || '', 'text'), html });
  }
  if (path === '/api/sites' && request.method === 'POST') {
    const input = await request.json();
    const url = safeUrl(input.url).href;
    const state = await readState(env);
    const existing = state.sites.find(s => s.id === input.id || new URL(s.url).hostname === new URL(url).hostname);
    const frequency = Number(input.frequency) === 1 ? 1 : 2;
    if (existing) { existing.name = clean(input.name || existing.name).slice(0, 80); existing.url = url; existing.frequency = frequency; existing.enabled = input.enabled !== false; }
    else state.sites.push({ id: `${slug(new URL(url).hostname)}-${Date.now().toString(36)}`, name: clean(input.name || new URL(url).hostname).slice(0, 80), url, frequency, enabled: true, cursor: 0, pages: {}, events: [], conflicts: [], reviewedConflicts: [], lastScan: null, lastStatus: 'pending', lastError: null, discovered: 0, scanned: 0 });
    await writeState(env, state);
    return json({ ok: true, sites: state.sites });
  }
  if (path === '/api/scan' && request.method === 'POST') return json(await runScans(env, await request.json()));
  return json({ error: 'Niet gevonden.' }, 404);
}

const MCP_TOOLS = [
  { name: 'website_check_status', description: 'Lees de websites, laatste scans, recente wijzigingen en mogelijke tegenstrijdigheden.', inputSchema: { type: 'object', properties: {} } },
  { name: 'website_check_scan_due', description: 'Scan ingeschakelde websites waarvan de controle volgens hun frequentie nodig is. Sla bevindingen op.', inputSchema: { type: 'object', properties: {} } },
  { name: 'website_check_scan_site', description: 'Scan één website nu. Accepteert ook @website-check: gevolgd door JSON met action review_bundle, page_text, record_findings, review_changes, change_context of record_change_reviews als compatibiliteitsroute.', inputSchema: { type: 'object', properties: { siteId: { type: 'string' } }, required: ['siteId'] } },
  { name: 'website_check_review_bundle', description: 'Lees claims en tekstfragmenten van gecontroleerde pagina’s om inhoudelijke tegenstrijdigheden te beoordelen.', inputSchema: { type: 'object', properties: { siteId: { type: 'string' } }, required: ['siteId'] } },
  { name: 'website_check_page_text', description: 'Lees de actuele zichtbare tekst van één gecontroleerde pagina voor broncontrole.', inputSchema: { type: 'object', properties: { siteId: { type: 'string' }, url: { type: 'string' } }, required: ['siteId', 'url'] } },
  { name: 'website_check_record_findings', description: 'Sla inhoudelijk beoordeelde tegenstrijdigheden met geverifieerde broncitaten op.', inputSchema: { type: 'object', properties: { siteId: { type: 'string' }, findings: { type: 'array', maxItems: 20, items: { type: 'object', properties: { subject: { type: 'string' }, explanation: { type: 'string' }, evidence: { type: 'array', minItems: 2, maxItems: 4, items: { type: 'object', properties: { url: { type: 'string' }, quote: { type: 'string' } }, required: ['url', 'quote'] } } }, required: ['subject', 'explanation', 'evidence'] } } }, required: ['siteId', 'findings'] } },
  { name: 'website_check_review_changes', description: 'Lees onbeoordeelde websitewijzigingen met oude en nieuwe bronfragmenten.', inputSchema: { type: 'object', properties: { siteId: { type: 'string' }, cursor: { type: 'integer' }, limit: { type: 'integer' } }, required: ['siteId'] } },
  { name: 'website_check_change_context', description: 'Lees volledige oude en nieuwe zichtbare tekst plus HTML-fragmenten van één wijziging.', inputSchema: { type: 'object', properties: { siteId: { type: 'string' }, eventId: { type: 'string' } }, required: ['siteId', 'eventId'] } },
  { name: 'website_check_record_change_reviews', description: 'Sla Codex-oordelen over concrete wijzigingsmeldingen op.', inputSchema: { type: 'object', properties: { siteId: { type: 'string' }, reviews: { type: 'array', maxItems: 20, items: { type: 'object', properties: { id: { type: 'string' }, decision: { type: 'string', enum: ['meaningful', 'noise', 'uncertain'] }, title: { type: 'string' }, explanation: { type: 'string' } }, required: ['id', 'decision', 'title', 'explanation'] } } }, required: ['siteId', 'reviews'] } }
];

const MCP_COMPAT_PREFIX = '@website-check:';

async function compatToolCall(env, value) {
  let command;
  try { command = JSON.parse(value.slice(MCP_COMPAT_PREFIX.length)); }
  catch { throw new Error('Ongeldige Website Check-opdracht.'); }
  if (!command || typeof command !== 'object' || Array.isArray(command) || typeof command.siteId !== 'string') throw new Error('Ongeldige Website Check-opdracht.');
  if (command.action === 'review_bundle') return reviewBundle(env, command.siteId);
  if (command.action === 'page_text') return pageText(env, command.siteId, command.url);
  if (command.action === 'record_findings') return recordFindings(env, command);
  if (command.action === 'review_changes') return reviewChanges(env, command);
  if (command.action === 'change_context') return changeContext(env, command);
  if (command.action === 'record_change_reviews') return recordChangeReviews(env, command);
  throw new Error('Onbekende Website Check-opdracht.');
}

async function handleMcp(request, env) {
  if (request.method !== 'POST') return json({ error: 'POST vereist.' }, 405);
  const body = await request.json();
  const id = body.id ?? null;
  const response = result => json({ jsonrpc: '2.0', id, result });
  const modern = body.params?._meta?.['io.modelcontextprotocol/protocolVersion'] === '2026-07-28' || request.headers.get('mcp-protocol-version') === '2026-07-28';
  if (body.method === 'server/discover') return response({
    resultType: 'complete',
    supportedVersions: ['2026-07-28', '2025-03-26'],
    capabilities: { tools: {} },
    _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'website-check', version: '1.1.0' } },
    ttlMs: 0,
    cacheScope: 'public'
  });
  if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
  if (body.method === 'initialize') return response({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'website-check', version: '1.1.0' } });
  if (body.method === 'ping') return response({});
  if (body.method === 'tools/list') return response(modern ? { resultType: 'complete', tools: MCP_TOOLS, ttlMs: 0, cacheScope: 'public' } : { tools: MCP_TOOLS });
  if (body.method === 'tools/call') {
    const name = body.params?.name;
    let data;
    if (name === 'website_check_status') {
      const state = await readState(env);
      data = state.sites.map(s => ({ id: s.id, name: s.name, url: s.url, frequency: s.frequency, lastScan: s.lastScan, status: s.lastStatus, error: s.lastError, recentEvents: s.events.slice(0, 12), candidates: s.conflicts, reviewedConflicts: s.reviewedConflicts || [] }));
    } else if (name === 'website_check_scan_due') data = await runScans(env, { onlyDue: true });
    else if (name === 'website_check_scan_site') {
      const siteId = body.params?.arguments?.siteId;
      data = typeof siteId === 'string' && siteId.startsWith(MCP_COMPAT_PREFIX)
        ? await compatToolCall(env, siteId)
        : await runScans(env, { siteId });
    }
    else if (name === 'website_check_review_bundle') data = await reviewBundle(env, body.params?.arguments?.siteId);
    else if (name === 'website_check_page_text') data = await pageText(env, body.params?.arguments?.siteId, body.params?.arguments?.url);
    else if (name === 'website_check_record_findings') data = await recordFindings(env, body.params?.arguments || {});
    else if (name === 'website_check_review_changes') data = await reviewChanges(env, body.params?.arguments || {});
    else if (name === 'website_check_change_context') data = await changeContext(env, body.params?.arguments || {});
    else if (name === 'website_check_record_change_reviews') data = await recordChangeReviews(env, body.params?.arguments || {});
    else return json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Tool niet gevonden.' } });
    return response({ ...(modern ? { resultType: 'complete' } : {}), content: [{ type: 'text', text: JSON.stringify(data) }] });
  }
  return json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Methode niet gevonden.' } });
}

const PAGE = String.raw`<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Website Check</title><style>
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#e6edf6;background:#0b1421;font-size:16px}*{box-sizing:border-box}body{margin:0}button,input,select{font:inherit}button{cursor:pointer}a{color:#7bc5f7;text-decoration:none}a:hover{text-decoration:underline}.shell{max-width:1440px;margin:auto;padding:34px 40px 60px}.head{display:flex;justify-content:space-between;gap:24px;align-items:flex-start;border-bottom:1px solid #27394d;padding-bottom:28px}.eyebrow{font-size:.76rem;letter-spacing:.16em;text-transform:uppercase;color:#75b9ce;font-weight:700}h1{font-size:2rem;letter-spacing:-.04em;margin:8px 0 4px}h2{font-size:1.16rem;margin:0 0 16px;letter-spacing:-.02em}p{margin:0;color:#a3b2c2}.head .sub{font-size:.95rem}.button{border:1px solid #37556e;background:#15283b;color:#eef6fc;border-radius:10px;padding:11px 16px;font-weight:600;white-space:nowrap}.button:hover{background:#203a53}.button.primary{background:#1c9db8;border-color:#37b3ca;color:#061620}.button:disabled{opacity:.55;cursor:wait}.grid{display:grid;grid-template-columns:290px minmax(0,1fr);gap:24px;margin-top:28px}.sidebar,.panel,.stat{background:#101e2d;border:1px solid #27394d;border-radius:16px}.sidebar{padding:20px;height:max-content}.sidebarhead{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}.sidebar h2{margin:0}.sitebutton{width:100%;text-align:left;background:transparent;border:1px solid transparent;color:#e6edf6;padding:13px 12px;border-radius:10px;display:block;margin:4px 0}.sitebutton.active{background:#183449;border-color:#31637a}.sitebutton span{display:block;font-weight:650}.sitebutton small{display:block;color:#9aaec0;margin-top:4px;font-size:.8rem}.add{width:100%;margin-top:12px}.main{min-width:0}.site-top{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:20px}.site-top h2{font-size:1.55rem;margin:0 0 4px}.site-top p{font-size:.9rem}.actions{display:flex;gap:8px}.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:20px}.stat{padding:18px}.stat label{display:block;color:#9aafbf;font-size:.83rem;margin-bottom:9px}.stat strong{font-size:1.3rem;letter-spacing:-.03em}.stat small{display:block;color:#8ba1b2;margin-top:5px;font-size:.78rem}.two{display:grid;grid-template-columns:1.1fr .9fr;gap:18px;margin-bottom:18px}.panel{padding:22px;margin-bottom:18px}.panelhead{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:16px}.panelhead h2{margin:0}.list{display:grid;gap:10px}.event,.claim,.page-row{border:1px solid #27394d;background:#132337;border-radius:10px;padding:13px 14px}.eventtop{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.badge{padding:4px 8px;border-radius:999px;font-size:.74rem;font-weight:700;background:#23465b;color:#8bd6ed}.badge.price{background:#46381e;color:#f7cd72}.badge.error,.badge.conflict{background:#4b2a2d;color:#f6a7aa}.badge.theme{background:#3a3157;color:#cbb6fa}.badge.ok{background:#1d493e;color:#7de0bd}.event p,.claim p{font-size:.86rem;margin-top:7px;overflow-wrap:anywhere}.event time{color:#93a6b7;font-size:.78rem}.claim strong{font-size:.92rem}.evidence{margin:10px 0;padding:12px;background:#0c1b2c;border-left:3px solid #4bb3ca;border-radius:6px}.evidence .quote{line-height:1.45;font-size:.9rem;margin-bottom:5px}.evidence a{font-size:.82rem;overflow-wrap:anywhere}.claim p{line-height:1.4}.muted{color:#91a6b7;font-size:.88rem}.empty{padding:24px;text-align:center;border:1px dashed #355067;border-radius:10px;color:#9bafbf;font-size:.9rem}.pages{max-height:330px;overflow:auto}.page-row{display:flex;justify-content:space-between;gap:10px;font-size:.87rem;margin-bottom:8px}.page-row a{overflow-wrap:anywhere}.page-row span{white-space:nowrap;color:#a1b4c2}.notice{padding:12px 15px;background:#183449;border:1px solid #31637a;border-radius:10px;margin-bottom:18px;color:#cae9f1;font-size:.88rem}dialog{background:#111f2d;color:#e6edf6;border:1px solid #3b546a;border-radius:16px;box-shadow:0 25px 80px #0009;width:min(460px,calc(100vw - 30px));padding:26px}dialog::backdrop{background:#06101bc9}dialog h2{margin-bottom:14px}form{display:grid;gap:13px}form label{display:grid;gap:6px;font-size:.87rem;color:#adbfcd}input,select{background:#0b1724;border:1px solid #40566a;color:#eef6fc;border-radius:9px;padding:11px 12px;width:100%}.formactions{display:flex;justify-content:flex-end;gap:9px;margin-top:12px}.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}@media(max-width:1000px){.grid{grid-template-columns:1fr}.sidebar{display:block}.sites{display:flex;overflow:auto;gap:6px}.sitebutton{min-width:170px}.two{grid-template-columns:1fr}}@media(max-width:680px){.shell{padding:22px 16px 40px}.head,.site-top{flex-direction:column;align-items:stretch}.stats{grid-template-columns:repeat(2,1fr)}.head h1{font-size:1.65rem}.actions{width:100%}.actions .button{flex:1}.panel{padding:17px}.stat{padding:15px}}
.diff-dialog{width:min(1180px,calc(100vw - 24px));max-height:92vh;overflow:auto}.diff-controls{display:flex;gap:14px;flex-wrap:wrap;margin:14px 0}.diff-controls label{min-width:200px}.diff-nav{display:flex;align-items:center;gap:9px;position:sticky;top:-26px;padding:10px 0;background:#111f2d;z-index:1}.diff-nav .muted{margin-right:auto}.diff-hunks{display:grid;gap:12px;margin-top:8px}.diff-hunk{border:1px solid #34546b;border-radius:12px;padding:14px;background:#122539;scroll-margin-top:75px}.diff-hunk.active{border-color:#75c7df;box-shadow:0 0 0 2px #75c7df33}.diff-hunk h3{margin:0 0 12px;font-size:.94rem}.diff-columns{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.diff-columns h3{font-size:.86rem;margin:0 0 7px}.diff-columns pre{white-space:pre-wrap;overflow-wrap:anywhere;overflow:auto;max-height:55vh;background:#0b1724;border-radius:9px;padding:13px;font-size:.79rem;line-height:1.5;margin:0}.diff-before{border-left:3px solid #e69494;background:#321f2a!important}.diff-after{border-left:3px solid #77cfab;background:#16352e!important}[hidden]{display:none!important}@media(max-width:680px){.diff-columns{grid-template-columns:1fr}.diff-nav{flex-wrap:wrap}}
</style></head><body><div class="shell"><header class="head"><div><div class="eyebrow">CONTROLECENTRUM</div><h1>Website Check</h1><p class="sub">Wijzigingen, claims en bereikbaarheid op één plek.</p></div><button id="scanAll" class="button primary">Controleer websites</button></header><div class="grid"><aside class="sidebar"><div class="sidebarhead"><h2>Websites</h2><span id="siteCount" class="muted"></span></div><div id="sites" class="sites"></div><button id="addSite" class="button add">Website toevoegen</button></aside><main id="main" class="main"><div class="empty">Dashboard laden…</div></main></div></div><dialog id="editor"><h2 id="editorTitle">Website toevoegen</h2><form id="siteForm"><input type="hidden" name="id"><label>Naam<input name="name" maxlength="80" required placeholder="Naam van de website"></label><label>Website URL<input name="url" type="url" required placeholder="https://voorbeeld.nl/"></label><label>Controlefrequentie<select name="frequency"><option value="1">1 keer per dag</option><option value="2">2 keer per dag</option></select></label><div class="formactions"><button type="button" class="button" id="cancel">Annuleren</button><button class="button primary" type="submit">Opslaan</button></div></form></dialog><script>
const $=s=>document.querySelector(s);let state=null,selected=null,busy=false;const formatDate=s=>s?new Intl.DateTimeFormat('nl-NL',{dateStyle:'medium',timeStyle:'short',timeZone:'Europe/Amsterdam'}).format(new Date(s)):'Nog niet gecontroleerd';const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));const tag=t=>({'price':'Prijs','text':'Tekst','html':'HTML','theme':'Thema','meta':'Metadata','facts':'Claims','error':'Fout','recovery':'Hersteld','conflict':'Tegenstrijdig'}[t]||t);async function api(path,options){const r=await fetch(path,options);const d=await r.json();if(!r.ok)throw Error(d.error||'Er ging iets mis.');return d}async function refresh(){try{state=await api('/api/state');selected=state.sites.some(x=>x.id===selected)?selected:state.sites[0]?.id;render()}catch(e){$('#main').innerHTML='<div class="empty">'+escape(e.message)+'</div>'}}function render(){const sites=state.sites;$('#siteCount').textContent=sites.length;$('#sites').innerHTML=sites.map(s=>'<button class="sitebutton '+(s.id===selected?'active':'')+'" data-id="'+escape(s.id)+'"><span>'+escape(s.name)+'</span><small>'+escape(new URL(s.url).hostname)+' · '+(s.frequency===2?'2×':'1×')+' per dag</small></button>').join('');document.querySelectorAll('.sitebutton').forEach(b=>b.onclick=()=>{selected=b.dataset.id;render()});const s=sites.find(x=>x.id===selected);if(!s){$('#main').innerHTML='<div class="empty">Voeg een website toe om te beginnen.</div>';return}const pages=Object.values(s.pages||{}).sort((a,b)=>(a.status>=400?-1:0)-(b.status>=400?-1:0));const candidates=s.events||[];const changeReviews=s.changeReviews||{};const reviewedMeaningful=candidates.filter(e=>changeReviews[e.id]?.decision==='meaningful');const pendingCount=candidates.filter(e=>['price','text','html','theme','meta','facts'].includes(e.type)&&!changeReviews[e.id]).length;const events=candidates.filter(e=>e.type==='error'||e.type==='recovery'||changeReviews[e.id]?.decision==='meaningful').slice(0,40).map(e=>({...e,summary:changeReviews[e.id]?.title||e.summary,reviewExplanation:changeReviews[e.id]?.explanation||''}));const conflicts=s.reviewedConflicts||[];const status=s.lastStatus==='ok'?'Bereikbaar':s.lastStatus==='warning'?'Deels bereikbaar':s.lastStatus==='error'?'Fout':'Nog geen scan';$('#main').innerHTML='<div class="site-top"><div><h2>'+escape(s.name)+'</h2><p><a href="'+escape(s.url)+'" target="_blank" rel="noopener noreferrer">'+escape(s.url)+'</a> · Laatste controle: '+formatDate(s.lastScan)+'</p></div><div class="actions"><button class="button" id="editSite">Instellen</button><button class="button primary" id="scanSite" '+(busy?'disabled':'')+'>Nu controleren</button></div></div>'+(s.lastError?'<div class="notice">'+escape(s.lastError)+'</div>':'')+'<div class="stats"><div class="stat"><label>Status</label><strong>'+escape(status)+'</strong><small>'+escape(s.scanned||0)+' pagina’s gecontroleerd</small></div><div class="stat"><label>Ontdekte pagina’s</label><strong>'+escape(s.discovered||0)+'</strong><small>via sitemap</small></div><div class="stat"><label>Beoordeelde wijzigingen</label><strong>'+reviewedMeaningful.length+'</strong><small>'+pendingCount+' wachten op Codex</small></div><div class="stat"><label>Tegenstrijdigheden</label><strong>'+conflicts.length+'</strong><small>met gecontroleerde broncitaten</small></div></div><div class="two"><section class="panel"><div class="panelhead"><h2>Beoordeelde tegenstrijdigheden</h2></div><div class="list">'+(conflicts.length?conflicts.map(c=>'<div class="claim"><strong>'+escape(c.kind)+'</strong><p class="muted">'+escape(c.explanation||(c.source==='number'?'Dezelfde uitspraak bevat verschillende getallen.':c.source==='polarity'?'Een uitspraak wordt bevestigd en ontkend.':'Dezelfde aanduiding heeft verschillende antwoorden.'))+'</p>'+c.values.map(v=>{const p=v.pages?.[0];return '<div class="evidence"><div class="quote">“'+escape(p?.phrase||v.value)+'”</div>'+(p?'<a target="_blank" rel="noopener noreferrer" href="'+escape(p.url)+'">'+escape(new URL(p.url).pathname||'/')+'</a>':'')+(v.pages.length>1?'<span class="muted"> · ook op '+escape(v.pages.length-1)+' andere pagina’s</span>':'')+'</div>'}).join('')+'<small class="muted">'+'Beoordeeld door Codex'+'</small></div>').join(''):'<div class="empty">Nog geen door Codex bevestigde tegenstrijdigheden.</div>')+'</div></section><section class="panel"><div class="panelhead"><h2>Bereikbaarheid</h2></div><div class="list"><div class="claim"><strong>Laatste scan</strong><p>'+formatDate(s.lastScan)+'</p><p>'+escape(s.lastDurationMs?Math.round(s.lastDurationMs/1000)+' sec':'—')+' · '+escape(s.frequency)+' keer per dag</p></div><div class="claim"><strong>Fouten</strong><p>'+escape(pages.filter(p=>p.status>=400||p.error).length)+' pagina’s met een fout in de laatste controles</p></div></div></section></div><section class="panel"><div class="panelhead"><h2>Beoordeelde wijzigingen en fouten</h2><span class="muted">'+pendingCount+' wachten op Codex</span></div><div class="list">'+(events.length?events.map(e=>'<div class="event"><div class="eventtop"><span class="badge '+escape(e.type)+'">'+escape(tag(e.type))+'</span><strong>'+escape(e.type==='html'&&!e.normalized&&!e.reviewExplanation?'HTML-melding van oude scanner':e.summary)+'</strong><time>'+formatDate(e.at)+'</time></div><p><a target="_blank" rel="noopener noreferrer" href="'+escape(e.url)+'">'+escape(e.url)+'</a></p>'+(e.reviewExplanation?'<p class="muted">Beoordeeld door Codex: '+escape(e.reviewExplanation)+'</p>':'')+(e.type==='html'&&!e.reviewExplanation?'<p class="muted">'+(e.normalized?'Zichtbare tekst gelijk; de wijziging zit in de HTML-code.':'Oude melding: deze kan wisselende Shopify-tokens bevatten. Open de vergelijking om dit te controleren.')+'</p>':'')+(e.afterSnapshot?'<button class="button diffbutton" data-type="'+escape(e.type)+'" data-before="'+escape(e.beforeSnapshot||'')+'" data-after="'+escape(e.afterSnapshot)+'">'+(e.type==='html'?'Bekijk HTML-wijziging':'Bekijk verschil')+'</button>':'')+'</div>').join(''):'<div class="empty">Nog geen door Codex bevestigde wijzigingen of bereikbaarheidsfouten. Nieuwe scanverschillen wachten op beoordeling.</div>')+'</div></section><section class="panel"><div class="panelhead"><h2>Gecontroleerde pagina’s</h2><span class="muted">'+pages.length+' opgeslagen</span></div><div class="pages">'+(pages.length?pages.slice(0,80).map(p=>'<div class="page-row"><a target="_blank" rel="noopener noreferrer" href="'+escape(p.url)+'">'+escape(p.title||new URL(p.url).pathname||'/')+'</a><span>HTTP '+escape(p.status||'—')+(p.snapshotKey?' · <button class="button diffbutton" data-before="" data-after="'+escape(p.snapshotKey)+'">Momentopname</button>':'')+'</span></div>').join(''):'<div class="empty">Nog geen pagina’s gecontroleerd.</div>')+'</div></section>';$('#editSite').onclick=()=>openEditor(s);$('#scanSite').onclick=()=>scan(s.id)}$('#addSite').onclick=()=>openEditor(null);$('#cancel').onclick=()=>$('#editor').close();$('#siteForm').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.target);try{await api('/api/sites',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(Object.fromEntries(f))});$('#editor').close();await refresh()}catch(err){alert(err.message)}};$('#scanAll').onclick=()=>scan(null);function openEditor(site){$('#editorTitle').textContent=site?'Website instellen':'Website toevoegen';const form=$('#siteForm');form.elements.id.value=site?.id||'';form.elements.name.value=site?.name||'';form.elements.url.value=site?.url||'';form.elements.frequency.value=site?.frequency||2;$('#editor').showModal()}async function scan(siteId){if(busy)return;busy=true;$('#scanAll').disabled=true;$('#scanAll').textContent='Controleren…';render();try{await api('/api/scan',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(siteId?{siteId}:{})});await refresh()}catch(e){alert(e.message)}finally{busy=false;$('#scanAll').disabled=false;$('#scanAll').textContent='Controleer websites';render()}}refresh();
</script><script>
document.addEventListener('click', async event => {
  const button = event.target.closest('.diffbutton');
  if (!button) return;
  button.disabled = true;
  try {
    const params = new URLSearchParams({ after: button.dataset.after });
    if (button.dataset.before) params.set('before', button.dataset.before);
    const [before, after, diff] = await Promise.all([
      button.dataset.before ? api('/api/snapshot?key=' + encodeURIComponent(button.dataset.before)) : Promise.resolve(null),
      api('/api/snapshot?key=' + encodeURIComponent(button.dataset.after)),
      api('/api/diff?' + params.toString())
    ]);
    let dialog = document.querySelector('#diffDialog');
    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.id = 'diffDialog';
      dialog.className = 'diff-dialog';
      dialog.innerHTML = '<div class="panelhead"><h2>Momentopnames vergelijken</h2><button class="button" id="closeDiff">Sluiten</button></div>' +
        '<div class="diff-controls"><label>Inhoud<select id="diffMode"><option value="text">Zichtbare tekst</option><option value="html">HTML-bron</option></select></label>' +
        '<label>Weergave<select id="diffView"><option value="changes">Alleen wijzigingen</option><option value="full">Volledige vergelijking</option></select></label></div>' +
        '<p id="diffNote" class="muted" aria-live="polite"></p>' +
        '<div id="diffOnly"><div class="diff-nav"><span id="diffCount" class="muted" aria-live="polite"></span><button class="button" id="diffPrev">Vorige wijziging</button><button class="button" id="diffNext">Volgende wijziging</button></div><div id="diffHunks" class="diff-hunks"></div></div>' +
        '<div id="diffFull" class="diff-columns" hidden><section><h3>Vorige meting</h3><pre id="diffBefore"></pre></section><section><h3>Nieuwe meting</h3><pre id="diffAfter"></pre></section></div>';
      document.body.appendChild(dialog);
      dialog.querySelector('#closeDiff').onclick = () => dialog.close();
    }
    dialog.querySelector('#diffMode').value = button.dataset.type === 'html' || button.dataset.type === 'theme' ? 'html' : 'text';
    dialog.querySelector('#diffView').value = before ? 'changes' : 'full';
    const renderDiff = () => {
      const mode = dialog.querySelector('#diffMode').value;
      const view = dialog.querySelector('#diffView').value;
      const result = diff[mode];
      const showChanges = view === 'changes' && diff.hasBefore;
      dialog.querySelector('#diffOnly').hidden = !showChanges;
      dialog.querySelector('#diffFull').hidden = showChanges;
      dialog.querySelector('#diffBefore').textContent = before?.[mode] || 'Geen eerdere momentopname';
      dialog.querySelector('#diffAfter').textContent = after?.[mode] || '';
      const note = dialog.querySelector('#diffNote');
      if (!diff.hasBefore) note.textContent = 'Dit is de eerste opgeslagen momentopname van deze pagina.';
      else if (mode === 'text' && result.total === 0) note.textContent = 'De zichtbare tekst is gelijk gebleven. Kies HTML-bron om technische wijzigingen te bekijken.';
      else if (mode === 'html' && result.total === 0 && result.reorderedAppBlocks) note.textContent = 'Dezelfde Shopify-appblokken staan in een andere volgorde. Hun inhoud is gelijk; er is geen app toegevoegd of verwijderd.';
      else if (mode === 'html' && diff.ignoredDynamic) note.textContent = 'Alleen wisselende Shopify-verzoek-ID’s, tijdelijke tokens of vervaltijden veranderden. Geen inhoudelijke HTML-wijziging gevonden.';
      else if (mode === 'html' && diff.text.total === 0) note.textContent = 'De zichtbare tekst is gelijk gebleven; hieronder staan de gewijzigde HTML-fragmenten.';
      else note.textContent = 'Vergelijk de gemarkeerde fragmenten of open de volledige versie.';
      const container = dialog.querySelector('#diffHunks');
      container.replaceChildren();
      const count = dialog.querySelector('#diffCount');
      const prev = dialog.querySelector('#diffPrev');
      const next = dialog.querySelector('#diffNext');
      if (!result.hunks.length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'Geen verschillen in deze inhoud.';
        container.appendChild(empty);
        count.textContent = '0 wijzigingen';
        prev.disabled = true;
        next.disabled = true;
        return;
      }
      result.hunks.forEach((hunk, index) => {
        const card = document.createElement('section');
        card.className = 'diff-hunk';
        const heading = document.createElement('h3');
        heading.textContent = (index + 1) + '. ' + hunk.kind;
        card.appendChild(heading);
        const columns = document.createElement('div');
        columns.className = 'diff-columns';
        for (const [label, value, className] of [['Voor', hunk.before, 'diff-before'], ['Na', hunk.after, 'diff-after']]) {
          const section = document.createElement('section');
          const title = document.createElement('h3');
          title.textContent = label;
          const snippet = document.createElement('pre');
          snippet.className = className;
          snippet.textContent = value;
          section.append(title, snippet);
          columns.appendChild(section);
        }
        card.appendChild(columns);
        container.appendChild(card);
      });
      const cards = [...container.querySelectorAll('.diff-hunk')];
      let current = 0;
      const select = (index, scroll) => {
        current = Math.max(0, Math.min(cards.length - 1, index));
        cards.forEach((card, item) => card.classList.toggle('active', item === current));
        count.textContent = 'Wijziging ' + (current + 1) + ' van ' + result.total + (result.truncated ? ' (eerste ' + cards.length + ' getoond)' : '');
        prev.disabled = current === 0;
        next.disabled = current === cards.length - 1;
        if (scroll) cards[current].scrollIntoView({ behavior: 'smooth', block: 'center' });
      };
      prev.onclick = () => select(current - 1, true);
      next.onclick = () => select(current + 1, true);
      select(0, false);
    };
    dialog.querySelector('#diffMode').onchange = renderDiff;
    dialog.querySelector('#diffView').onchange = renderDiff;
    renderDiff();
    dialog.showModal();
  } catch (error) {
    alert(error.message);
  } finally {
    button.disabled = false;
  }
});
</script></body></html>`;

export default { async fetch(request, env) {
  try {
    const path = new URL(request.url).pathname;
    if (path === '/mcp') return await handleMcp(request, env);
    if (path.startsWith('/api/')) return await handleApi(request, env, path);
    if (path === '/') return new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
    return new Response('Niet gevonden', { status: 404 });
  } catch (error) { return json({ error: String(error.message || error) }, 500); }
} };
