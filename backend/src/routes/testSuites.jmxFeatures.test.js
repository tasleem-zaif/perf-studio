// Verifies the JMeter-parity additions: a per-request ResponseAssertion (status code
// matches 2xx/3xx, mirroring k6's check()) and a single Thread-Group-scoped ConstantTimer
// for request pacing (mirroring k6's sleep(1)). The exact property keys/values below were
// verified against JMeter's own ResponseAssertion.java / ConstantTimer.java source —
// including the real "Asserion.test_strings" typo baked into JMeter itself — not guessed,
// since a wrong constant here would silently produce a no-op assertion.
require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildJmxTemplate } = require('./testSuites');

const endpoints = [
  { name: 'Login', method: 'POST', url: 'https://api.example.com/auth/login', headers: {}, body: '{}', queryParams: {} },
  { name: 'Get Profile', method: 'GET', url: 'https://api.example.com/me', headers: {}, body: '', queryParams: {} },
];
const suite = { name: 'Feature Test', iter_mode: 'duration', vusers: 5, rampup: 5, duration: 30 };
const cfg = { protocol: 'https', url: 'api.example.com', port: '443', variables: {} };

function generate() {
  return buildJmxTemplate(suite, null, [], cfg, endpoints, null);
}

test('every sampler gets a ResponseAssertion with the exact JMeter property keys', () => {
  const xml = generate();
  const count = (xml.match(/<ResponseAssertion /g) || []).length;
  assert.equal(count, endpoints.length, 'expected one ResponseAssertion per endpoint');
  assert.ok(xml.includes('<collectionProp name="Asserion.test_strings">'), 'must use JMeter\'s real (typo\'d) property name, not the "corrected" spelling');
  assert.ok(xml.includes('<stringProp name="Assertion.test_field">Assertion.response_code</stringProp>'));
  assert.ok(xml.includes('<intProp name="Assertion.test_type">1</intProp>'), 'test_type 1 = MATCH');
  assert.ok(xml.includes('[23]\\d\\d'));
});

test('the response assertion for each sampler sits inside that sampler\'s own hashTree', () => {
  const xml = generate();
  const loginPos = xml.indexOf('testname="Login"');
  const loginAssertionPos = xml.indexOf('ResponseAssertion', loginPos);
  const profilePos = xml.indexOf('testname="Get Profile"');
  assert.ok(loginAssertionPos > loginPos && loginAssertionPos < profilePos, 'Login\'s assertion must appear between Login and the next sampler');
});

test('exactly one ConstantTimer is declared at Thread Group scope (not per-sampler)', () => {
  const xml = generate();
  const count = (xml.match(/<ConstantTimer /g) || []).length;
  assert.equal(count, 1, 'a single Timer at Thread Group scope applies to every sampler beneath it — one copy is correct, not one per endpoint');
  assert.ok(xml.includes('<stringProp name="ConstantTimer.delay">1000</stringProp>'));
  // Must be declared before any HTTPSamplerProxy (thread-group level, sibling to CSVDataSet/
  // HTTP Request Defaults), not nested inside one.
  const timerPos = xml.indexOf('<ConstantTimer');
  const firstSamplerPos = xml.indexOf('<HTTPSamplerProxy');
  assert.ok(timerPos < firstSamplerPos, 'the timer must be declared before the first sampler, at Thread Group scope');
});

test('assertions and timer do not break hashTree pairing (every opening tag closed)', () => {
  const xml = generate();
  const opens = (xml.match(/<hashTree>/g) || []).length;
  const closes = (xml.match(/<\/hashTree>/g) || []).length;
  const selfClosed = (xml.match(/<hashTree\/>/g) || []).length;
  // Every <hashTree> open must have a matching </hashTree>; self-closed <hashTree/> tags
  // are independent leaf markers and don't need a pair.
  assert.equal(opens, closes, `mismatched hashTree open/close tags (${opens} opens vs ${closes} closes) — likely from the new assertion/timer blocks`);
  assert.ok(selfClosed > 0);
});
