import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker/index.js';

function fixture() {
  const objects = new Map();
  const env = { BUCKET: {
    get: async key => objects.has(key) ? { text: async () => objects.get(key) } : null,
    put: async (key, value) => { objects.set(key, value); }
  } };
  const pages = {
    'https://bonoir.nl/': '<html><body><p>Gratis verzending vanaf €35</p><p>Garantie op alle producten: 2 jaar</p><a href="/pages/info">Info</a></body></html>',
    'https://bonoir.nl/pages/info': '<html><body><p>Garantie op alle producten: 3 jaar</p><p>Retourtermijn: 30 dagen</p></body></html>',
    'https://bonoir.nl/pages/voorwaarden': '<html><body><p>Retourtermijn: 14 dagen</p><p>Retourneren is niet gratis</p></body></html>',
    'https://bonoir.nl/pages/faq': '<html><body><p>Retourneren is gratis</p></body></html>',
    'https://bonoir.nl/products/truffel': '<html><body><p>Gratis verzending vanaf €35</p><p>Truffel €8,95</p></body></html>',
    'https://bonoir.nl/products/reep': '<html><body><p>Gratis verzending vanaf €35</p><p>Chocoladereep €13,95</p></body></html>'
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    url = String(url);
    if (url.endsWith('/sitemap.xml')) return new Response('<urlset>' + Object.keys(pages).map(p => '<url><loc>' + p + '</loc></url>').join('') + '</urlset>', { headers: { 'content-type': 'application/xml' } });
    return pages[url] ? new Response(pages[url], { headers: { 'content-type': 'text/html' } }) : new Response('Not found', { status: 404 });
  };
  const request = async (path, init) => {
    const response = await worker.fetch(new Request('https://dashboard.test' + path, init), env);
    assert.equal(response.status, 200);
    return response.json();
  };
  const tool = async (name, args = {}) => {
    const response = await request('/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    return JSON.parse(response.result.content[0].text);
  };
  return { env, objects, pages, request, tool, restore: () => { globalThis.fetch = originalFetch; } };
}

test('compares general claims and does not confuse product prices with shipping', async () => {
  const f = fixture();
  try {
    await f.request('/api/scan', { method: 'POST', body: '{}' });
    const state = await f.request('/api/state');
    const site = state.sites[0];
    const dashboard = await worker.fetch(new Request('https://dashboard.test/'), f.env);
    const html = await dashboard.text();
    assert.match(html, /Beoordeelde tegenstrijdigheden/);
    assert.match(html, /const conflicts=s\.reviewedConflicts\|\|\[\]/);
    assert.doesNotMatch(html, /Automatisch gevonden · controleer de context/);
    assert.equal(site.scanned, 6);
    assert.ok(site.conflicts.some(c => c.kind === 'garantie op alle producten'));
    assert.ok(site.conflicts.some(c => c.kind === 'retourtermijn'));
    assert.ok(site.conflicts.some(c => c.kind === 'retourneren is gratis'));
    assert.ok(!site.conflicts.some(c => c.kind.includes('verzending')));
    assert.ok(!site.conflicts.some(c => c.values.some(v => v.value === '8.95' || v.value === '13.95')));
    const warranty = site.conflicts.find(c => c.kind === 'garantie op alle producten');
    assert.ok(warranty.values.every(v => v.pages[0].phrase.includes('Garantie')));
    const bundle = await f.tool('website_check_review_bundle', { siteId: site.id });
    assert.equal(bundle.pages.length, 6);
    assert.ok(bundle.pages.some(p => p.text.includes('Retourtermijn')));
    const compat = command => ({ siteId: '@website-check:' + JSON.stringify({ siteId: site.id, ...command }) });
    const compatBundle = await f.tool('website_check_scan_site', compat({ action: 'review_bundle' }));
    assert.equal(compatBundle.pages.length, bundle.pages.length);
    const compatText = await f.tool('website_check_scan_site', compat({ action: 'page_text', url: 'https://bonoir.nl/pages/info' }));
    assert.ok(compatText.text.includes('Retourtermijn: 30 dagen'));
    const findings = [{
      subject: 'Retourtermijn', explanation: 'Twee pagina’s vermelden een andere termijn.', evidence: [
        { url: 'https://bonoir.nl/pages/info', quote: 'Retourtermijn: 30 dagen' },
        { url: 'https://bonoir.nl/pages/voorwaarden', quote: 'Retourtermijn: 14 dagen' }
      ]
    }];
    const saved = await f.tool('website_check_scan_site', compat({ action: 'record_findings', findings }));
    assert.equal(saved.saved, 1);
    assert.equal((await f.request('/api/state')).sites[0].reviewedConflicts.length, 1);
    const staleFindings = JSON.parse(f.objects.get('website-check/state-v1.json'));
    staleFindings.sites[0].reviewedConflicts = [];
    f.objects.set('website-check/state-v1.json', JSON.stringify(staleFindings));
    assert.equal((await f.request('/api/state')).sites[0].reviewedConflicts.length, 1);
    await f.tool('website_check_record_findings', { siteId: site.id, findings });
    assert.equal((await f.request('/api/state')).sites[0].reviewedConflicts.length, 1);
    await assert.rejects(() => f.tool('website_check_record_findings', { siteId: site.id, findings: [{
      subject: 'Onbewezen claim', explanation: 'Dit citaat bestaat niet.', evidence: [
        { url: 'https://bonoir.nl/pages/info', quote: 'Altijd vijf jaar garantie' },
        { url: 'https://bonoir.nl/pages/voorwaarden', quote: 'Nooit vijf jaar garantie' }
      ]
    }] }));
  } finally { f.restore(); }
});

test('removes legacy shipping conflicts during state migration', async () => {
  const f = fixture();
  try {
    f.objects.set('website-check/state-v1.json', JSON.stringify({ version: 1, sites: [{ id: 'bonoir-nl', url: 'https://bonoir.nl/', pages: {}, events: [{ type: 'shipping' }], claims: [{ kind: 'gratis verzending', value: '8.95' }], conflicts: [{ kind: 'gratis verzending', values: [{ value: '8.95' }] }] }] }));
    const state = await f.request('/api/state');
    assert.equal(state.version, 2);
    assert.deepEqual(state.sites[0].conflicts, []);
    assert.deepEqual(state.sites[0].events, []);
    assert.ok(!('claims' in state.sites[0]));
  } finally { f.restore(); }
});

test('removes overlapping temperature advice and rejects it as a reviewed conflict', async () => {
  const f = fixture();
  try {
    const first = 'https://bonoir.nl/products/fruitsmaken-bonbons-5-stuks';
    const second = 'https://bonoir.nl/products/stroopwafel';
    const quotes = ['Bewaren op een droge, donkere plek (14–20°C).', 'Onze bonbons bewaar je het best op een koele en droge plek, tussen de 15 en 18 graden.'];
    const finding = {
      kind: 'Aanbevolen bewaartemperatuur voor bonbons',
      explanation: 'De temperatuur verschilt.',
      source: 'codex',
      values: quotes.map((quote, index) => ({ value: quote, pages: [{ url: index ? second : first, phrase: quote }] }))
    };
    f.objects.set('snapshot-1', JSON.stringify({ text: quotes[0] }));
    f.objects.set('snapshot-2', JSON.stringify({ text: quotes[1] }));
    f.objects.set('website-check/state-v1.json', JSON.stringify({ version: 2, sites: [{ id: 'bonoir-nl', url: 'https://bonoir.nl/', pages: { [first]: { snapshotKey: 'snapshot-1' }, [second]: { snapshotKey: 'snapshot-2' } }, events: [{ type: 'conflict', summary: 'Ruwe patroonmatch' }], conflicts: [finding], reviewedConflicts: [finding] }] }));
    const state = await f.request('/api/state');
    assert.deepEqual(state.sites[0].conflicts, []);
    assert.deepEqual(state.sites[0].reviewedConflicts, []);
    assert.deepEqual(state.sites[0].events, []);
    const persisted = JSON.parse(f.objects.get('website-check/state-v1.json'));
    assert.deepEqual(persisted.sites[0].reviewedConflicts, []);
    const response = await worker.fetch(new Request('https://dashboard.test/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'website_check_record_findings', arguments: { siteId: 'bonoir-nl', findings: [{ subject: finding.kind, explanation: finding.explanation, evidence: [{ url: first, quote: quotes[0] }, { url: second, quote: quotes[1] }] }] } } }) }), f.env);
    assert.equal(response.status, 500);
    assert.match((await response.json()).error, /temperatuurbereiken overlappen/);
  } finally { f.restore(); }
});

test('discovers all review tools with both MCP protocol versions', async () => {
  const f = fixture();
  try {
    const rpc = (method, params = {}) => f.request('/mcp', { method: 'POST', headers: { 'mcp-protocol-version': '2026-07-28' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } } }) });
    const discovery = await rpc('server/discover');
    assert.ok(discovery.result.supportedVersions.includes('2026-07-28'));
    const modern = await rpc('tools/list');
    const legacy = await f.request('/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) });
    const names = modern.result.tools.map(tool => tool.name);
    assert.equal(modern.result.resultType, 'complete');
    assert.deepEqual(names, legacy.result.tools.map(tool => tool.name));
    assert.ok(['website_check_review_bundle', 'website_check_page_text', 'website_check_record_findings'].every(name => names.includes(name)));
  } finally { f.restore(); }
});

test('shows focused HTML changes with quick navigation and preserves full snapshots', async () => {
  const f = fixture();
  try {
    const beforeKey = 'website-check/snapshots/bonoir-nl/aaaaaaaaaaaaaaaaaaaa/old.json';
    const afterKey = 'website-check/snapshots/bonoir-nl/aaaaaaaaaaaaaaaaaaaa/new.json';
    const before = '<html><head><meta name="theme-color" content="#111"></head><body><p>Hallo</p><script>window.token="a"</script></body></html>';
    const after = '<html><head><meta name="theme-color" content="#222"></head><body><p>Hallo</p><script>window.token="b"</script></body></html>';
    f.objects.set(beforeKey, JSON.stringify({ text: 'Hallo', html: before }));
    f.objects.set(afterKey, JSON.stringify({ text: 'Hallo', html: after }));
    const diff = await f.request('/api/diff?before=' + encodeURIComponent(beforeKey) + '&after=' + encodeURIComponent(afterKey));
    assert.equal(diff.hasBefore, true);
    assert.equal(diff.text.total, 0);
    assert.ok(diff.html.total >= 2);
    assert.ok(diff.html.hunks.some(hunk => hunk.before.includes('#111') && hunk.after.includes('#222')));
    assert.ok(diff.html.hunks.some(hunk => hunk.before.includes('window.token="a"') && hunk.after.includes('window.token="b"')));
    const page = await worker.fetch(new Request('https://dashboard.test/'), f.env);
    const html = await page.text();
    assert.match(html, /Alleen wijzigingen/);
    assert.match(html, /Volledige vergelijking/);
    assert.match(html, /Vorige wijziging/);
    assert.match(html, /Volgende wijziging/);
    assert.match(html, /Bekijk HTML-wijziging/);
    for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => new Function(script[1]));
  } finally { f.restore(); }
});

test('ignores rotating Shopify request tokens but detects a real HTML change', async () => {
  const f = fixture();
  try {
    const url = 'https://bonoir.nl/';
    const html = (requestId, visitorId, metaId, expiry, className = 'old') => '<html><head><meta name="shopify-s" content="' + metaId + '" data-expiration="' + expiry + '"></head><body><div class="' + className + '"><p>Welkom</p></div><script id="__st">var __st={"reqid":"' + requestId + '","u":"' + visitorId + '","p":"product"};</script></body></html>';
    const firstHtml = html('request-1', 'visitor-1', 'token-1', '1000');
    const secondHtml = html('request-2', 'visitor-2', 'token-2', '2000');
    f.pages[url] = firstHtml;
    await f.request('/api/scan', { method: 'POST', body: '{}' });
    const firstState = await f.request('/api/state');
    const firstSnapshot = firstState.sites[0].pages[url].snapshotKey;
    const legacy = JSON.parse(f.objects.get('website-check/state-v1.json'));
    legacy.sites[0].pages[url].htmlHash = 'old-raw-html-hash';
    delete legacy.sites[0].pages[url].htmlHashVersion;
    f.objects.set('website-check/state-v1.json', JSON.stringify(legacy));
    f.pages[url] = secondHtml;
    await f.request('/api/scan', { method: 'POST', body: '{}' });
    const secondState = await f.request('/api/state');
    assert.equal(secondState.sites[0].pages[url].snapshotKey, firstSnapshot);
    assert.equal(secondState.sites[0].pages[url].htmlHashVersion, 4);
    assert.ok(!secondState.sites[0].events.some(event => event.url === url && event.type === 'html'));
    const oldKey = 'website-check/snapshots/bonoir-nl/bbbbbbbbbbbbbbbbbbbb/old.json';
    const newKey = 'website-check/snapshots/bonoir-nl/bbbbbbbbbbbbbbbbbbbb/new.json';
    f.objects.set(oldKey, JSON.stringify({ text: 'Welkom', html: firstHtml }));
    f.objects.set(newKey, JSON.stringify({ text: 'Welkom', html: secondHtml }));
    const noiseDiff = await f.request('/api/diff?before=' + encodeURIComponent(oldKey) + '&after=' + encodeURIComponent(newKey));
    assert.equal(noiseDiff.ignoredDynamic, true);
    assert.equal(noiseDiff.html.total, 0);
    f.pages[url] = html('request-3', 'visitor-3', 'token-3', '3000', 'new');
    await f.request('/api/scan', { method: 'POST', body: '{}' });
    const thirdState = await f.request('/api/state');
    const change = thirdState.sites[0].events.find(event => event.url === url && event.type === 'html');
    assert.ok(change);
    assert.equal(change.normalized, true);
    const realDiff = await f.request('/api/diff?before=' + encodeURIComponent(change.beforeSnapshot) + '&after=' + encodeURIComponent(change.afterSnapshot));
    assert.ok(realDiff.html.hunks.some(hunk => hunk.before.includes('class="old"') && hunk.after.includes('class="new"')));
    assert.ok(realDiff.html.hunks.every(hunk => hunk.before !== hunk.after));
  } finally { f.restore(); }
});

test('compares Shopify app blocks by identity instead of pairing unrelated apps', async () => {
  const f = fixture();
  try {
    const block = (app, content) => '<!-- BEGIN app block: shopify://apps/' + app + '/blocks/config/123 -->' + content + '<!-- END app block -->';
    const klaviyo = block('klaviyo-email-marketing-sms', '<script src="https://static.klaviyo.com/klaviyo.js"></script>');
    const bss = block('bss-b2b-solution', '<script id="bss-config">const plan="advanced"</script>');
    const meta = token => '<meta name="shopify-y" content="' + token + '" data-expiration="123">';
    const wrap = (blocks, token) => '<html><head>' + blocks + meta(token) + '</head><body><p>Welkom</p></body></html>';
    const beforeKey = 'website-check/snapshots/bonoir-nl/cccccccccccccccccccc/old.json';
    const afterKey = 'website-check/snapshots/bonoir-nl/cccccccccccccccccccc/new.json';
    const readDiff = async (oldHtml, newHtml) => {
      f.objects.set(beforeKey, JSON.stringify({ text: 'Welkom', html: oldHtml }));
      f.objects.set(afterKey, JSON.stringify({ text: 'Welkom', html: newHtml }));
      return f.request('/api/diff?before=' + encodeURIComponent(beforeKey) + '&after=' + encodeURIComponent(afterKey));
    };
    const reordered = await readDiff(wrap(klaviyo + bss, 'old'), wrap(bss + klaviyo, 'new'));
    assert.equal(reordered.html.total, 0);
    assert.equal(reordered.html.reorderedAppBlocks, true);
    const replaced = await readDiff(wrap(klaviyo, 'old'), wrap(bss, 'new'));
    assert.equal(replaced.html.total, 2);
    assert.ok(replaced.html.hunks.some(hunk => hunk.kind.includes('klaviyo') && hunk.kind.includes('verwijderd') && hunk.after === '—'));
    assert.ok(replaced.html.hunks.some(hunk => hunk.kind.includes('bss b2b') && hunk.kind.includes('toegevoegd') && hunk.before === '—'));
    assert.ok(!replaced.html.hunks.some(hunk => hunk.before.includes('klaviyo') && hunk.after.includes('bss-b2b')));
    const changed = await readDiff(wrap(klaviyo + bss, 'old'), wrap(klaviyo + block('bss-b2b-solution', '<script id="bss-config">const plan="basic"</script>'), 'new'));
    assert.equal(changed.html.total, 1);
    assert.match(changed.html.hunks[0].kind, /bss b2b solution gewijzigd/);
    const url = 'https://bonoir.nl/';
    f.pages[url] = wrap(klaviyo + bss, 'old');
    await f.request('/api/scan', { method: 'POST', body: '{}' });
    const first = await f.request('/api/state');
    const snapshot = first.sites[0].pages[url].snapshotKey;
    f.pages[url] = wrap(bss + klaviyo, 'new');
    await f.request('/api/scan', { method: 'POST', body: '{}' });
    const second = await f.request('/api/state');
    assert.equal(second.sites[0].pages[url].snapshotKey, snapshot);
    assert.ok(!second.sites[0].events.some(event => event.url === url && event.type === 'html'));
  } finally { f.restore(); }
});

test('ignores WordPress cache diagnostics and Shopify event metadata IDs', async () => {
  const f = fixture();
  try {
    const beforeKey = 'website-check/snapshots/bonoir-nl/dddddddddddddddddddd/old.json';
    const afterKey = 'website-check/snapshots/bonoir-nl/dddddddddddddddddddd/new.json';
    const html = (count, cache, id) => `<html><body><p>Welkom</p><!-- Performance optimized by Redis Object Cache. Opgehaald ${count} objecten van Redis gebruikt PhpRedis. --><!-- This website is like a Rocket, isn't it? Performance optimized by WP Rocket. Debug: cached@${cache} --><script>window.meta={"eventMetadataId":"${id}"}</script></body></html>`;
    f.objects.set(beforeKey, JSON.stringify({ text: 'Welkom', html: html(3923, 1791558575, 'request-one') }));
    f.objects.set(afterKey, JSON.stringify({ text: 'Welkom', html: html(3960, 1791558705, 'request-two') }));
    const diff = await f.request('/api/diff?before=' + encodeURIComponent(beforeKey) + '&after=' + encodeURIComponent(afterKey));
    assert.equal(diff.ignoredDynamic, true);
    assert.equal(diff.html.total, 0);
  } finally { f.restore(); }
});

test('ignores a hidden stock count while preserving availability changes', async () => {
  const f = fixture();
  try {
    const beforeKey = 'website-check/snapshots/bonoir-nl/eeeeeeeeeeeeeeeeeeee/old.json';
    const afterKey = 'website-check/snapshots/bonoir-nl/eeeeeeeeeeeeeeeeeeee/new.json';
    const html = (stocklevel, stockstatus) => `<html><body><div data-product="{&quot;sku&quot;:&quot;Sundy107&quot;,&quot;stocklevel&quot;:${stocklevel},&quot;stockstatus&quot;:&quot;${stockstatus}&quot;}"><p>Handgel</p></div></body></html>`;
    const readDiff = async (oldHtml, newHtml) => {
      f.objects.set(beforeKey, JSON.stringify({ text: 'Handgel', html: oldHtml }));
      f.objects.set(afterKey, JSON.stringify({ text: 'Handgel', html: newHtml }));
      return f.request('/api/diff?before=' + encodeURIComponent(beforeKey) + '&after=' + encodeURIComponent(afterKey));
    };
    const countOnly = await readDiff(html(2362, 'instock'), html(2363, 'instock'));
    assert.equal(countOnly.ignoredDynamic, true);
    assert.equal(countOnly.html.total, 0);
    const availability = await readDiff(html(1, 'instock'), html(0, 'outofstock'));
    assert.equal(availability.ignoredDynamic, false);
    assert.ok(availability.html.total > 0);
  } finally { f.restore(); }
});

test('keeps scan candidates out of the portal until Codex records a review', async () => {
  const f = fixture();
  try {
    await f.request('/api/scan', { method: 'POST', body: '{}' });
    f.pages['https://bonoir.nl/'] = '<html><body><p>Gratis verzending vanaf €45</p><p>Garantie op alle producten: 2 jaar</p><a href="/pages/info">Info</a></body></html>';
    await f.request('/api/scan', { method: 'POST', body: '{}' });
    const state = await f.request('/api/state');
    const candidates = state.sites[0].events.filter(event => ['price', 'text', 'html', 'theme', 'meta', 'facts'].includes(event.type));
    assert.ok(candidates.length >= 2);
    assert.ok(candidates.every(event => event.id && !state.sites[0].changeReviews[event.id]));
    const command = value => ({ siteId: '@website-check:' + JSON.stringify({ siteId: 'bonoir-nl', ...value }) });
    const bundle = await f.tool('website_check_scan_site', command({ action: 'review_changes', limit: 20 }));
    assert.equal(bundle.pending, candidates.length);
    assert.ok(bundle.items.some(item => item.textChanges.some(change => change.before.includes('35') && change.after.includes('45'))));
    const reviews = bundle.items.map((item, index) => ({ id: item.id, decision: index === 0 ? 'meaningful' : 'noise', title: index === 0 ? 'Verzenddrempel gewijzigd' : 'Dubbele technische melding', explanation: index === 0 ? 'De zichtbare verzenddrempel veranderde van €35 naar €45.' : 'Deze melding hoort bij dezelfde zichtbare tekstwijziging.' }));
    const saved = await f.tool('website_check_scan_site', command({ action: 'record_change_reviews', reviews }));
    assert.equal(saved.saved, reviews.length);
    assert.equal(saved.remaining, 0);
    const staleScan = JSON.parse(f.objects.get('website-check/state-v1.json'));
    staleScan.sites[0].changeReviews = {};
    f.objects.set('website-check/state-v1.json', JSON.stringify(staleScan));
    const reviewed = await f.request('/api/state');
    assert.equal(Object.keys(reviewed.sites[0].changeReviews).length, reviews.length);
    assert.equal((await f.tool('website_check_review_changes', { siteId: 'bonoir-nl' })).pending, 0);
    const page = await worker.fetch(new Request('https://dashboard.test/'), f.env);
    const html = await page.text();
    assert.match(html, /Beoordeelde wijzigingen en fouten/);
    assert.match(html, /changeReviews\[e\.id\]\?\.decision==='meaningful'/);
    for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => new Function(script[1]));
  } finally { f.restore(); }
});
