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
