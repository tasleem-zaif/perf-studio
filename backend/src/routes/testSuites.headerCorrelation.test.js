// Verifies correlation sourced from a RESPONSE HEADER (not the JSON body) flows correctly
// into BOTH generated engines: JMeter gets a header-targeted RegexExtractor, k6 gets a
// case-insensitive res.headers lookup — see headerRegexExtractorXml/k6HeaderAccessor for
// why each needs its own handling (JMeter needs a case-insensitive (?i) regex flag; k6
// needs a case-insensitive scan of res.headers, since the server's real casing may differ
// from the lowercase-normalized header name correlationEngine.js detected it under).
require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { detectCorrelations } = require('../utils/correlationEngine');
const { buildJmxTemplate, buildK6Template } = require('./testSuites');

// Create Order returns the new resource's id ONLY via a custom response header
// (x-resource-id) — never in the JSON body — mirroring a common REST pattern
// (Location/X-Resource-Id headers on 201 Created).
const endpoints = [
  { name: 'Create Order', method: 'POST', url: 'https://api.example.com/orders', headers: {}, body: '{"item":"widget"}', queryParams: {} },
  { name: 'Get Order', method: 'GET', url: 'https://api.example.com/orders/ord_9f8e7d', headers: {}, body: '', queryParams: {} },
];
const preRunData = [
  { body: { item: 'widget' }, responseHeaders: { 'x-resource-id': 'ord_9f8e7d', 'content-type': 'application/json' } },
  { body: {} },
];
const suite = { name: 'Header Correlation Test', iter_mode: 'duration', vusers: 5, rampup: 5, duration: 30 };
const baseCfg = { protocol: 'https', url: 'api.example.com', port: '443', variables: {} };

function rulesForTest() {
  return detectCorrelations(endpoints, preRunData).map(r => ({ ...r, status: 'confirmed' }));
}

test('JMX: a header-sourced value gets a RegexExtractor (useHeaders=true, case-insensitive) and the target literal is rewritten', () => {
  const rules = rulesForTest();
  const xml = buildJmxTemplate(suite, null, [], { ...baseCfg, correlationRules: rules }, endpoints, preRunData);

  assert.ok(xml.includes('<RegexExtractor '), 'expected a RegexExtractor for the header-sourced field');
  assert.ok(xml.includes('<stringProp name="RegexExtractor.useHeaders">true</stringProp>'));
  assert.ok(xml.includes('(?i)x-resource-id:'), 'the regex must be case-insensitive against the header name');
  assert.ok(xml.includes('<stringProp name="RegexExtractor.template">$1$</stringProp>'));
  assert.ok(xml.includes('/orders/${'), 'Get Order\'s path must reference the extracted variable');
  assert.ok(!xml.includes('/orders/ord_9f8e7d</stringProp>') && !xml.includes('HTTPSampler.path">/orders/ord_9f8e7d'), 'the stale literal must be gone from Get Order\'s path');

  // The RegexExtractor must sit inside Create Order's own sampler hashTree (right after it).
  const createPos = xml.indexOf('testname="Create Order"');
  const extractorPos = xml.indexOf('<RegexExtractor');
  const getOrderPos = xml.indexOf('testname="Get Order"');
  assert.ok(createPos < extractorPos && extractorPos < getOrderPos);
});

test('k6: a header-sourced value is extracted via a case-insensitive res.headers lookup', () => {
  const rules = rulesForTest();
  const script = buildK6Template(suite, null, null, { ...baseCfg, correlationRules: rules }, endpoints, [], preRunData, 'load');

  assert.ok(script.includes("Object.entries(res0.headers).find(([k]) => k.toLowerCase() === 'x-resource-id')?.[1]"));
  assert.ok(script.includes('/orders/${'), 'Get Order\'s URL must reference the extracted variable');
  assert.ok(!script.includes('/orders/ord_9f8e7d'), 'the stale literal must be gone');
});
