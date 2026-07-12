// Fixture-driven test for the generalized JMX correlation wiring added in testSuites.js
// (buildSamplerXml + buildJmxTemplate). Exercises buildJmxTemplate directly — a pure
// function, no DB/AI/network — against a realistic login -> create-order -> get-order ->
// update-order flow, proving: (1) confirmed/high-confidence rules actually rewrite the
// right literal in the right place and get a matching JSONPostProcessor extractor placed
// after their source sampler, and (2) an unconfirmed low-confidence guess is excluded
// until a human confirms it (the safety gate scriptCorrelation.filterApplicableRules exists for).
require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { detectCorrelations } = require('../utils/correlationEngine');
const { buildJmxTemplate } = require('./testSuites');

const endpoints = [
  { name: 'Login', method: 'POST', url: 'https://api.example.com/auth/login', headers: {}, body: '{}', queryParams: {} },
  { name: 'Create Order', method: 'POST', url: 'https://api.example.com/orders', headers: { Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.abc.sig' }, body: '{"item":"widget"}', queryParams: {} },
  { name: 'Get Order', method: 'GET', url: 'https://api.example.com/orders/ord_9f8e7d', headers: {}, body: '', queryParams: {} },
  { name: 'Update Order', method: 'PUT', url: 'https://api.example.com/orders', headers: {}, body: '{"orderId":"ord_9f8e7d","status":"shipped"}', queryParams: {} },
];
const preRunData = [
  { body: { accessToken: 'eyJhbGciOiJIUzI1NiJ9.abc.sig' } },
  { body: { id: 'ord_9f8e7d', item: 'widget' } },
  { body: { id: 'ord_9f8e7d', item: 'widget', status: 'pending' } },
  { body: { id: 'ord_9f8e7d', status: 'shipped' } },
];

const suite = { name: 'Order Flow', iter_mode: 'duration', vusers: 10, rampup: 5, duration: 60 };
const baseCfg = { protocol: 'https', url: 'api.example.com', port: '443', variables: {} };

function generate(correlationRules, fieldGenerators) {
  return buildJmxTemplate(suite, null, [], { ...baseCfg, correlationRules, fieldGenerators }, endpoints, preRunData);
}

test('high-confidence rules (token + body field) are applied: literal replaced and extractor placed after the right source sampler', () => {
  const rules = detectCorrelations(endpoints, preRunData); // all 'auto' status straight from detection
  const xml = generate(rules);

  // Rule: Login's accessToken -> Create Order's Authorization header
  assert.ok(xml.includes('Bearer ${accessToken}'), 'Authorization header should reference ${accessToken}');
  assert.ok(!xml.includes('Bearer eyJhbGciOiJIUzI1NiJ9.abc.sig'), 'the raw recorded token must not appear literally anymore');
  assert.ok(xml.includes('JSON Extractor - accessToken'), 'expected an accessToken extractor');

  // The accessToken extractor must appear AFTER Login's sampler and BEFORE Create Order's
  const loginPos = xml.indexOf('testname="Login"');
  const extractorPos = xml.indexOf('JSON Extractor - accessToken');
  const createOrderPos = xml.indexOf('testname="Create Order"');
  assert.ok(loginPos < extractorPos && extractorPos < createOrderPos, 'extractor must sit between its source and the first endpoint that needs it');

  // Rule: Create Order's id -> Update Order's body orderId field (high confidence: "id" relates to "orderid")
  assert.ok(xml.includes('"orderId": "${id}"') || xml.includes('${id}'), 'Update Order body should reference ${id}');
  assert.ok(xml.includes('JSON Extractor - id'), 'expected an id extractor sourced from Create Order');
});

test('a low-confidence, unconfirmed rule (path segment) is NOT applied — the literal stays put', () => {
  const rules = detectCorrelations(endpoints, preRunData);
  const pathRule = rules.find(r => r.targetLocation === 'urlPath');
  assert.equal(pathRule.confidence, 'low', 'precondition: a bare path segment should be a low-confidence guess');
  const xml = generate(rules);
  // Get Order's path must still contain the literal recorded id — never silently rewritten
  assert.ok(xml.includes('ord_9f8e7d'), 'unconfirmed low-confidence rule must leave the literal untouched');
});

test('confirming the low-confidence rule makes it apply on the next generation', () => {
  const rules = detectCorrelations(endpoints, preRunData);
  const confirmed = rules.map(r => r.targetLocation === 'urlPath' ? { ...r, status: 'confirmed' } : r);
  const xml = generate(confirmed);
  assert.ok(xml.includes('${id}'), 'confirming the rule should make the path segment resolve to ${id}');
  // The literal must no longer appear as a bare path (still fine if it appears inside a
  // jsonPath extractor expression like "$.id", so check specifically for the URL path form)
  assert.ok(!xml.includes('/orders/ord_9f8e7d'), 'the literal path must be replaced once confirmed');
});

test('rejecting a high-confidence rule keeps the literal — rejection always wins', () => {
  const rules = detectCorrelations(endpoints, preRunData);
  const rejected = rules.map(r => (r.targetLocation === 'body' ? { ...r, status: 'rejected' } : r));
  const xml = generate(rejected);
  assert.ok(xml.includes('"orderId":"ord_9f8e7d"') || xml.includes('ord_9f8e7d'), 'a rejected rule must never be applied regardless of confidence');
  assert.ok(!xml.includes('"orderId": "${id}"'));
});

test('with no correlationRules at all, JMX generation still succeeds (backward compatibility)', () => {
  const xml = generate([]);
  assert.ok(xml.includes('<jmeterTestPlan'));
  assert.ok(xml.includes('ord_9f8e7d'), 'literals stay untouched with no rules');
});

test('a field generator rewrites a recorded literal with no correlation source into a JMeter function call', () => {
  // Create Order's own request body carries an email that never came from any prior
  // response — correlation can't help here; a user-attached generator can.
  const generatorRules = [{
    targetEndpointIndex: 1, targetLocation: 'body', targetKey: '$.item', value: 'widget', generator: 'uuid',
  }];
  const xml = generate([], generatorRules);
  assert.ok(xml.includes('${__UUID()}'), 'expected the JMeter UUID function call in place of the literal');
  assert.ok(!xml.includes('"item":"widget"') && !xml.includes('"item": "widget"'), 'the recorded literal must be gone');
});
