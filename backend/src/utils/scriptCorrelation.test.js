const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  filterApplicableRules, groupRulesBySource, groupRulesByTarget, substituteCorrelatedLiterals,
  jsonPathToOptionalChain, k6CookieAccessor, toK6TemplateLiteral,
} = require('./scriptCorrelation');

test('filterApplicableRules keeps confirmed and high-confidence auto rules, drops rejected and low-confidence auto', () => {
  const rules = [
    { id: 'a', status: 'confirmed', confidence: 'low' },
    { id: 'b', status: 'auto', confidence: 'high' },
    { id: 'c', status: 'auto', confidence: 'low' },
    { id: 'd', status: 'rejected', confidence: 'high' },
  ];
  const kept = filterApplicableRules(rules).map(r => r.id);
  assert.deepEqual(kept.sort(), ['a', 'b']);
});

test('groupRulesBySource dedupes identical varName+jsonPath per source endpoint', () => {
  const rules = [
    { sourceEndpointIndex: 0, sourceJsonPath: '$.accessToken', varName: 'accessToken' },
    { sourceEndpointIndex: 0, sourceJsonPath: '$.accessToken', varName: 'accessToken' }, // duplicate target, same source field
    { sourceEndpointIndex: 0, sourceJsonPath: '$.refreshToken', varName: 'refreshToken' },
    { sourceEndpointIndex: 1, sourceJsonPath: '$.id', varName: 'id' },
  ];
  const map = groupRulesBySource(rules);
  assert.equal(map.get(0).length, 2);
  assert.equal(map.get(1).length, 1);
});

test('groupRulesByTarget groups all rules for the same target endpoint together', () => {
  const rules = [
    { targetEndpointIndex: 2, targetLocation: 'urlPath', targetKey: 2 },
    { targetEndpointIndex: 2, targetLocation: 'header', targetKey: 'Authorization' },
    { targetEndpointIndex: 3, targetLocation: 'body', targetKey: '$.orderId' },
  ];
  const map = groupRulesByTarget(rules);
  assert.equal(map.get(2).length, 2);
  assert.equal(map.get(3).length, 1);
});

test('substituteCorrelatedLiterals rewrites a urlPath segment', () => {
  const normalized = { path: '/orders/ord_9f8e7d', headers: {}, body: '', queryParams: {} };
  const rules = [{ targetLocation: 'urlPath', targetKey: 2, value: 'ord_9f8e7d', varName: 'orderId' }];
  const result = substituteCorrelatedLiterals(normalized, rules);
  assert.equal(result.path, '/orders/${orderId}');
});

test('substituteCorrelatedLiterals rewrites a query param value', () => {
  const normalized = { path: '/orders', headers: {}, body: '', queryParams: { ref: 'xyz789' } };
  const rules = [{ targetLocation: 'query', targetKey: 'ref', value: 'xyz789', varName: 'ref' }];
  const result = substituteCorrelatedLiterals(normalized, rules);
  assert.equal(result.queryParams.ref, '${ref}');
});

test('substituteCorrelatedLiterals rewrites a header value by substring (Bearer prefix preserved)', () => {
  const normalized = { path: '/me', headers: { Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.abc.sig' }, body: '', queryParams: {} };
  const rules = [{ targetLocation: 'header', targetKey: 'Authorization', value: 'eyJhbGciOiJIUzI1NiJ9.abc.sig', varName: 'accessToken' }];
  const result = substituteCorrelatedLiterals(normalized, rules);
  assert.equal(result.headers.Authorization, 'Bearer ${accessToken}');
});

test('substituteCorrelatedLiterals rewrites a quoted string body field', () => {
  const normalized = { path: '/orders', headers: {}, body: '{\n  "orderId": "ord_9f8e7d",\n  "status": "shipped"\n}', queryParams: {} };
  const rules = [{ targetLocation: 'body', targetKey: '$.orderId', value: 'ord_9f8e7d', varName: 'orderId' }];
  const result = substituteCorrelatedLiterals(normalized, rules);
  assert.ok(result.body.includes('"orderId": "${orderId}"'));
  assert.ok(result.body.includes('"status": "shipped"'), 'unrelated fields must be left alone');
});

test('substituteCorrelatedLiterals rewrites a bare numeric body field', () => {
  const normalized = { path: '/orders', headers: {}, body: '{"orderId": 98765}', queryParams: {} };
  const rules = [{ targetLocation: 'body', targetKey: '$.orderId', value: '98765', varName: 'orderId' }];
  const result = substituteCorrelatedLiterals(normalized, rules);
  assert.equal(result.body, '{"orderId": ${orderId}}');
});

test('substituteCorrelatedLiterals is a no-op when the current value no longer matches the rule (stale rule safety)', () => {
  const normalized = { path: '/orders/ord_DIFFERENT', headers: {}, body: '', queryParams: {} };
  const rules = [{ targetLocation: 'urlPath', targetKey: 2, value: 'ord_9f8e7d', varName: 'orderId' }];
  const result = substituteCorrelatedLiterals(normalized, rules);
  assert.equal(result.path, '/orders/ord_DIFFERENT');
});

test('substituteCorrelatedLiterals returns the input unchanged when there are no target rules', () => {
  const normalized = { path: '/x', headers: { a: 'b' }, body: 'c', queryParams: { d: 'e' } };
  assert.equal(substituteCorrelatedLiterals(normalized, []), normalized);
});

test('jsonPathToOptionalChain converts a simple top-level path', () => {
  assert.equal(jsonPathToOptionalChain('$.accessToken'), '?.accessToken');
});

test('jsonPathToOptionalChain converts a nested path with an array index', () => {
  assert.equal(jsonPathToOptionalChain('$.user.tags[0]'), '?.user?.tags[0]');
});

test('jsonPathToOptionalChain handles an empty/root path', () => {
  assert.equal(jsonPathToOptionalChain('$'), '');
});

test('toK6TemplateLiteral escapes backticks and backslashes but leaves ${...} placeholders interpolatable', () => {
  assert.equal(toK6TemplateLiteral('Bearer ${accessToken}'), 'Bearer ${accessToken}');
  assert.equal(toK6TemplateLiteral('a`b'), 'a\\`b');
  assert.equal(toK6TemplateLiteral('a\\b'), 'a\\\\b');
});

test('substituteCorrelatedLiterals rewrites a value inside a form-urlencoded body', () => {
  const normalized = { path: '/me', headers: {}, body: 'sessionId=sess_9f8e7d6c5b&other=1', queryParams: {} };
  const rules = [{ targetLocation: 'body', targetKey: '$.sessionId', value: 'sess_9f8e7d6c5b', varName: 'sessionId' }];
  const result = substituteCorrelatedLiterals(normalized, rules);
  assert.equal(result.body, 'sessionId=${sessionId}&other=1');
});

test('k6CookieAccessor builds a case-sensitive res.cookies lookup', () => {
  assert.equal(k6CookieAccessor('res0', 'sessionId'), "res0.cookies['sessionId']?.[0]?.value");
});

test('substituteCorrelatedLiterals INJECT mode adds a header that was never recorded on this endpoint', () => {
  const normalized = { path: '/orders', headers: { 'Content-Type': 'application/json' }, body: '', queryParams: {} };
  const rules = [{ targetLocation: 'header', targetKey: 'Authorization', value: null, varName: 'sessionToken' }];
  const result = substituteCorrelatedLiterals(normalized, rules);
  assert.equal(result.headers.Authorization, '${sessionToken}');
  assert.equal(result.headers['Content-Type'], 'application/json', 'unrelated headers must be untouched');
});

test('substituteCorrelatedLiterals INJECT mode overwrites an existing header under its own casing', () => {
  const normalized = { path: '/orders', headers: { authorization: 'Bearer stale-value' }, body: '', queryParams: {} };
  const rules = [{ targetLocation: 'header', targetKey: 'Authorization', value: null, varName: 'sessionToken' }];
  const result = substituteCorrelatedLiterals(normalized, rules);
  assert.deepEqual(Object.keys(result.headers), ['authorization'], 'must overwrite the existing key, not add a second one with different casing');
  assert.equal(result.headers.authorization, '${sessionToken}');
});

test('substituteCorrelatedLiterals INJECT mode also works with a transform', () => {
  const normalized = { path: '/orders', headers: {}, body: '', queryParams: {} };
  const rules = [{ targetLocation: 'header', targetKey: 'X-Signed-Token', value: null, varName: 'sessionToken', transform: 'sha256' }];
  const result = substituteCorrelatedLiterals(normalized, rules, 'k6');
  assert.equal(result.headers['X-Signed-Token'], "${crypto.sha256(sessionToken, 'hex')}");
});

test('substituteCorrelatedLiterals INJECT mode into a literal "cookie" header reconstructs name=value, not the bare reference', () => {
  // A real HTTP Cookie request header is a "name=value" pair (RFC 6265) — a cookie-sourced
  // rule injected as a bare ${var} reference into a literal "cookie" header target would
  // generate a script no server-side cookie parser could ever recognize.
  const normalized = { path: '/me', headers: {}, body: '', queryParams: {} };
  const rules = [{
    targetLocation: 'header', targetKey: 'cookie', value: null, varName: 'sessionId',
    sourceLocation: 'cookie', sourceJsonPath: 'automationai_session',
  }];
  const result = substituteCorrelatedLiterals(normalized, rules);
  assert.equal(result.headers.cookie, 'automationai_session=${sessionId}');
});

test('substituteCorrelatedLiterals INJECT mode into a non-cookie header from a cookie source stays a bare reference', () => {
  const normalized = { path: '/me', headers: {}, body: '', queryParams: {} };
  const rules = [{
    targetLocation: 'header', targetKey: 'X-Session-Token', value: null, varName: 'sessionId',
    sourceLocation: 'cookie', sourceJsonPath: 'automationai_session',
  }];
  const result = substituteCorrelatedLiterals(normalized, rules);
  assert.equal(result.headers['X-Session-Token'], '${sessionId}');
});
