const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  isNoiseValue, flattenToLeaves, extractRequestLiterals, detectCorrelations, mergeRules,
  describeAllCapturedFields, reindexAfterEndpointRemoval,
} = require('./correlationEngine');

test('isNoiseValue filters short/common values, keeps real IDs', () => {
  assert.equal(isNoiseValue('true'), true);
  assert.equal(isNoiseValue('1'), true);
  assert.equal(isNoiseValue('ok'), true);
  assert.equal(isNoiseValue('abc123'), false);
  assert.equal(isNoiseValue('eyJhbGciOiJIUzI1NiJ9.token.sig'), false);
});

test('flattenToLeaves produces jsonPath/value pairs for nested objects and arrays', () => {
  const leaves = flattenToLeaves({ id: 'abc123', user: { name: 'x', tags: ['a', 'b'] } });
  assert.deepEqual(leaves, [
    { jsonPath: '$.id', value: 'abc123' },
    { jsonPath: '$.user.name', value: 'x' },
    { jsonPath: '$.user.tags[0]', value: 'a' },
    { jsonPath: '$.user.tags[1]', value: 'b' },
  ]);
});

test('extractRequestLiterals finds urlPath, query, header, and body literals; skips {{var}} and host', () => {
  const ep = {
    url: 'https://api.example.com/orders/abc123?ref=xyz789',
    queryParams: { ref: 'xyz789' },
    headers: { Authorization: 'Bearer sometoken123', 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId: 'abc123', note: '{{unresolved}}' }),
  };
  const lits = extractRequestLiterals(ep);
  assert.ok(lits.some(l => l.location === 'urlPath' && l.value === 'abc123'));
  assert.ok(lits.some(l => l.location === 'query' && l.key === 'ref' && l.value === 'xyz789'));
  assert.ok(lits.some(l => l.location === 'header' && l.key === 'Authorization'));
  assert.ok(!lits.some(l => l.location === 'header' && l.key === 'Content-Type'));
  assert.ok(lits.some(l => l.location === 'body' && l.key === '$.orderId' && l.value === 'abc123'));
  assert.ok(!lits.some(l => l.value.includes('{{')));
});

test('detectCorrelations: auth token flows from login response into a later Authorization header', () => {
  const endpoints = [
    { name: 'Login', method: 'POST', url: 'https://api.example.com/auth/login', headers: {}, body: '{}', queryParams: {} },
    { name: 'Get Profile', method: 'GET', url: 'https://api.example.com/me', headers: { Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.abc.sig' }, body: '', queryParams: {} },
  ];
  const preRunData = [
    { body: { accessToken: 'eyJhbGciOiJIUzI1NiJ9.abc.sig' } },
    { body: { email: 'a@b.com' } },
  ];
  const rules = detectCorrelations(endpoints, preRunData);
  const rule = rules.find(r => r.targetEndpointIndex === 1 && r.targetLocation === 'header');
  assert.ok(rule, 'expected a header correlation rule');
  assert.equal(rule.sourceEndpointIndex, 0);
  assert.equal(rule.sourceJsonPath, '$.accessToken');
  assert.equal(rule.targetKey, 'Authorization');
  assert.equal(rule.value, 'eyJhbGciOiJIUzI1NiJ9.abc.sig', 'value must be the matched token substring, not the whole "Bearer ..." header');
  assert.equal(rule.varName, 'accessToken', 'varName must preserve source-field casing');
  assert.equal(rule.confidence, 'high', 'a header match must be high confidence — its own key name never resembles the source field name, so requiring one would block the flagship auto-token case from ever auto-applying');
});

test('detectCorrelations: business ID flows from a create response into a later path segment and body field', () => {
  const endpoints = [
    { name: 'Create Order', method: 'POST', url: 'https://api.example.com/orders', headers: {}, body: '{"item":"widget"}', queryParams: {} },
    { name: 'Get Order', method: 'GET', url: 'https://api.example.com/orders/ord_9f8e7d', headers: {}, body: '', queryParams: {} },
    { name: 'Update Order', method: 'PUT', url: 'https://api.example.com/orders', headers: {}, body: '{"orderId":"ord_9f8e7d","status":"shipped"}', queryParams: {} },
  ];
  const preRunData = [
    { body: { id: 'ord_9f8e7d', item: 'widget' } },
    { body: { id: 'ord_9f8e7d', item: 'widget', status: 'pending' } },
    { body: { id: 'ord_9f8e7d', status: 'shipped' } },
  ];
  const rules = detectCorrelations(endpoints, preRunData);

  const pathRule = rules.find(r => r.targetEndpointIndex === 1 && r.targetLocation === 'urlPath');
  assert.ok(pathRule, 'expected a urlPath correlation rule for Get Order');
  assert.equal(pathRule.sourceEndpointIndex, 0);
  assert.equal(pathRule.value, 'ord_9f8e7d');

  const bodyRule = rules.find(r => r.targetEndpointIndex === 2 && r.targetLocation === 'body' && r.targetKey === '$.orderId');
  assert.ok(bodyRule, 'expected a body correlation rule for Update Order');
  assert.equal(bodyRule.sourceEndpointIndex, 0);
  assert.equal(bodyRule.confidence, 'high');
});

test('detectCorrelations: a value returned only via a response HEADER (not the body) is still detected as a source', () => {
  const endpoints = [
    { name: 'Create Order', method: 'POST', url: 'https://api.example.com/orders', headers: {}, body: '{"item":"widget"}', queryParams: {} },
    { name: 'Get Order', method: 'GET', url: 'https://api.example.com/orders/ord_9f8e7d', headers: {}, body: '', queryParams: {} },
  ];
  const preRunData = [
    // The new order's id is returned ONLY via a custom header (e.g. x-resource-id), not
    // anywhere in the JSON body — urlPath-target matching is exact-value, so the header
    // must carry exactly the id, same as if a real API returned it that way.
    { body: { item: 'widget' }, responseHeaders: { 'x-resource-id': 'ord_9f8e7d', 'content-type': 'application/json' } },
    { body: {} },
  ];
  const rules = detectCorrelations(endpoints, preRunData);
  const rule = rules.find(r => r.targetLocation === 'urlPath');
  assert.ok(rule, 'expected a rule even though the value only ever appeared in a response header');
  assert.equal(rule.sourceEndpointIndex, 0);
  assert.equal(rule.sourceLocation, 'header');
  assert.equal(rule.sourceJsonPath, 'x-resource-id');
});

test('detectCorrelations: boilerplate response headers (e.g. Date) are never treated as correlation sources, even when the value is not itself noise-filtered', () => {
  const endpoints = [
    { name: 'A', method: 'GET', url: 'https://api.example.com/a', headers: {}, body: '', queryParams: {} },
    // Coincidentally echoes the exact Date header text back as a query param — the kind of
    // accidental match the denylist exists to rule out even though the value itself
    // ("Tue, 01 Jul 2026 00:00:00 GMT") is long enough to pass isNoiseValue on its own.
    { name: 'B', method: 'GET', url: 'https://api.example.com/b', headers: {}, body: '', queryParams: { requestedAt: 'Tue, 01 Jul 2026 00:00:00 GMT' } },
  ];
  const preRunData = [
    { body: {}, responseHeaders: { date: 'Tue, 01 Jul 2026 00:00:00 GMT' } },
    { body: {} },
  ];
  const rules = detectCorrelations(endpoints, preRunData);
  assert.equal(rules.length, 0, 'the Date header must never be proposed as a correlation source, denylisted regardless of value length');
});

test('detectCorrelations: never matches a source that comes AFTER the target (no forward references)', () => {
  const endpoints = [
    { name: 'Get Order', method: 'GET', url: 'https://api.example.com/orders/ord_9f8e7d', headers: {}, body: '', queryParams: {} },
    { name: 'Create Order', method: 'POST', url: 'https://api.example.com/orders', headers: {}, body: '{"item":"widget"}', queryParams: {} },
  ];
  const preRunData = [
    { body: { error: 'not found' } },
    { body: { id: 'ord_9f8e7d' } },
  ];
  const rules = detectCorrelations(endpoints, preRunData);
  assert.equal(rules.length, 0, 'a later response must never correlate into an earlier request');
});

test('detectCorrelations: ignores coincidental matches on noise values (booleans, tiny counters)', () => {
  const endpoints = [
    { name: 'Create', method: 'POST', url: 'https://api.example.com/items', headers: {}, body: '{"active":"true"}', queryParams: {} },
    { name: 'List', method: 'GET', url: 'https://api.example.com/items', headers: {}, body: '', queryParams: { active: 'true' } },
  ];
  const preRunData = [
    { body: { active: 'true', count: 1 } },
    { body: { items: [] } },
  ];
  const rules = detectCorrelations(endpoints, preRunData);
  assert.equal(rules.length, 0, 'noise values should never produce a correlation rule');
});

test('detectCorrelations: no rules when nothing correlates', () => {
  const endpoints = [
    { name: 'A', method: 'GET', url: 'https://api.example.com/a', headers: {}, body: '', queryParams: {} },
    { name: 'B', method: 'GET', url: 'https://api.example.com/b', headers: {}, body: '', queryParams: {} },
  ];
  const preRunData = [{ body: { foo: 'bar1234' } }, { body: { baz: 'qux5678' } }];
  assert.deepEqual(detectCorrelations(endpoints, preRunData), []);
});

test('mergeRules: a confirmed rule survives re-detection unchanged (including a user-edited varName)', () => {
  const previous = [{ id: '1:body:$.orderId', status: 'confirmed', varName: 'myCustomName', confidence: 'high' }];
  const fresh = [{ id: '1:body:$.orderId', status: 'auto', varName: 'orderId', confidence: 'high' }];
  const merged = mergeRules(previous, fresh);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].status, 'confirmed');
  assert.equal(merged[0].varName, 'myCustomName');
});

test('mergeRules: a rejected rule stays rejected across re-detection', () => {
  const previous = [{ id: '1:query:ref', status: 'rejected' }];
  const fresh = [{ id: '1:query:ref', status: 'auto' }];
  const merged = mergeRules(previous, fresh);
  assert.equal(merged[0].status, 'rejected');
});

test('mergeRules: a manual rule is kept even when the fresh pass does not redetect it', () => {
  const previous = [{ id: '2:header:X-Custom', status: 'confirmed', confidence: 'manual' }];
  const fresh = [];
  const merged = mergeRules(previous, fresh);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, '2:header:X-Custom');
});

test('mergeRules: an unreviewed auto rule is replaced by fresh detection, and dropped if fresh no longer finds it', () => {
  const previous = [{ id: '3:body:$.x', status: 'auto', confidence: 'low' }];
  const merged = mergeRules(previous, []);
  assert.equal(merged.length, 0);
});

test('mergeRules: a confirmed rule survives even when fresh detection no longer redetects it at all', () => {
  // For a volatile source value (a session token that's different on every live run),
  // detection only re-matches the SAME id when this run's captured value happens to
  // literally equal the target's still-static recorded literal — true at most once. A
  // confirmed rule must not silently disappear from storage just because that coincidence
  // doesn't repeat on a later pre-run.
  const previous = [{ id: '4:header:Authorization', status: 'confirmed', varName: 'accessToken', confidence: 'high' }];
  const merged = mergeRules(previous, []);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, '4:header:Authorization');
  assert.equal(merged[0].status, 'confirmed');
});

test('mergeRules: a rejected rule survives even when fresh detection no longer redetects it at all', () => {
  const previous = [{ id: '5:query:ref', status: 'rejected' }];
  const merged = mergeRules(previous, []);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].status, 'rejected');
});

test('reindexAfterEndpointRemoval drops rules/generators/overrides that referenced a removed endpoint', () => {
  const cfg = {
    correlationRules: [
      { id: '2:header:Authorization', sourceEndpointIndex: 0, targetEndpointIndex: 2, targetLocation: 'header', targetKey: 'Authorization' },
    ],
    fieldGenerators: [
      { id: '2:body:$.email', targetEndpointIndex: 2, targetLocation: 'body', targetKey: '$.email' },
    ],
    endpointOverrides: { 2: { method: 'GET', name: 'x' } },
  };
  const result = reindexAfterEndpointRemoval(cfg, [2]);
  assert.equal(result.correlationRules.length, 0);
  assert.equal(result.fieldGenerators.length, 0);
  assert.deepEqual(result.endpointOverrides, {});
});

test('reindexAfterEndpointRemoval shifts indices AFTER a removed endpoint down by one, and rebuilds each id to match', () => {
  const cfg = {
    correlationRules: [
      { id: '5:header:X-Token', sourceEndpointIndex: 0, targetEndpointIndex: 5, targetLocation: 'header', targetKey: 'X-Token' },
    ],
    fieldGenerators: [
      { id: '5:body:$.uuid', targetEndpointIndex: 5, targetLocation: 'body', targetKey: '$.uuid' },
    ],
    endpointOverrides: { 5: { method: 'GET', name: 'y' } },
  };
  // Removing index 2 (before 5) must shift 5 -> 4, and re-derive every id from the NEW index.
  const result = reindexAfterEndpointRemoval(cfg, [2]);
  assert.equal(result.correlationRules[0].targetEndpointIndex, 4);
  assert.equal(result.correlationRules[0].id, '4:header:X-Token');
  assert.equal(result.fieldGenerators[0].targetEndpointIndex, 4);
  assert.equal(result.fieldGenerators[0].id, '4:body:$.uuid');
  assert.deepEqual(result.endpointOverrides, { 4: { method: 'GET', name: 'y' } });
});

test('reindexAfterEndpointRemoval leaves indices before every removed one untouched', () => {
  const cfg = {
    correlationRules: [
      { id: '1:header:X-Token', sourceEndpointIndex: 0, targetEndpointIndex: 1, targetLocation: 'header', targetKey: 'X-Token' },
    ],
  };
  const result = reindexAfterEndpointRemoval(cfg, [10]);
  assert.equal(result.correlationRules[0].targetEndpointIndex, 1);
  assert.equal(result.correlationRules[0].id, '1:header:X-Token');
});

test('reindexAfterEndpointRemoval handles multiple removed indices at once, correctly compounding the shift', () => {
  const cfg = {
    correlationRules: [
      { id: '8:header:X-Token', sourceEndpointIndex: 0, targetEndpointIndex: 8, targetLocation: 'header', targetKey: 'X-Token' },
    ],
  };
  // Removing indices 2 and 5 (both before 8) must shift 8 -> 6.
  const result = reindexAfterEndpointRemoval(cfg, [2, 5]);
  assert.equal(result.correlationRules[0].targetEndpointIndex, 6);
  assert.equal(result.correlationRules[0].id, '6:header:X-Token');
});

test('reindexAfterEndpointRemoval drops a rule whose SOURCE (not target) was removed', () => {
  const cfg = {
    correlationRules: [
      { id: '3:header:X-Token', sourceEndpointIndex: 1, targetEndpointIndex: 3, targetLocation: 'header', targetKey: 'X-Token' },
    ],
  };
  const result = reindexAfterEndpointRemoval(cfg, [1]);
  assert.equal(result.correlationRules.length, 0);
});

test('reindexAfterEndpointRemoval leaves other envCfg fields (variables, urls) untouched', () => {
  const cfg = { variables: { foo: 'bar' }, urls: [{ protocol: 'https', url: 'x', port: '443' }], correlationRules: [] };
  const result = reindexAfterEndpointRemoval(cfg, [0]);
  assert.deepEqual(result.variables, { foo: 'bar' });
  assert.deepEqual(result.urls, [{ protocol: 'https', url: 'x', port: '443' }]);
});

test('describeAllCapturedFields flattens body fields and headers across all prior responses, attributed to their endpoint', () => {
  const endpoints = [
    { name: 'Login', url: 'https://api.example.com/auth/login' },
    { name: 'Create Order', url: 'https://api.example.com/orders' },
  ];
  const priorResults = [
    { body: { accessToken: 'eyJhbGciOiJIUzI1NiJ9.abc.sig', refreshToken: 'refresh_abc123456' } },
    { body: { id: 'ord_9f8e7d' }, responseHeaders: { 'x-resource-id': 'ord_9f8e7d', 'content-type': 'application/json' } },
  ];
  const { fields, described } = describeAllCapturedFields(priorResults, endpoints);
  assert.equal(fields.accessToken, 'eyJhbGciOiJIUzI1NiJ9.abc.sig');
  assert.equal(fields.refreshToken, 'refresh_abc123456');
  assert.equal(fields.id, 'ord_9f8e7d');
  assert.equal(fields['x-resource-id'], 'ord_9f8e7d');
  assert.ok(!('content-type' in fields), 'boilerplate headers must not appear as captured fields');

  const idEntry = described.find(d => d.name === 'id');
  assert.equal(idEntry.fromEndpoint, 'Create Order');
  const headerEntry = described.find(d => d.name === 'x-resource-id');
  assert.equal(headerEntry.location, 'header');
});

test('describeAllCapturedFields: first occurrence wins for the resolvable value, but every occurrence is still described', () => {
  const endpoints = [{ name: 'A' }, { name: 'B' }];
  const priorResults = [{ body: { id: 'first_value_123' } }, { body: { id: 'second_value_456' } }];
  const { fields, described } = describeAllCapturedFields(priorResults, endpoints);
  assert.equal(fields.id, 'first_value_123');
  assert.equal(described.filter(d => d.name === 'id').length, 2);
});

test('describeAllCapturedFields skips noise values and null/missing entries gracefully', () => {
  const { fields, described } = describeAllCapturedFields([null, { body: { flag: 'true' } }, undefined], [{}, {}, {}]);
  assert.deepEqual(fields, {});
  assert.equal(described.length, 0);
});

test('parseBodyToObject parses a JSON object body', () => {
  const { parseBodyToObject } = require('./correlationEngine');
  assert.deepEqual(parseBodyToObject('{"a":"b","c":1}'), { a: 'b', c: 1 });
});

test('parseBodyToObject parses a form-urlencoded body', () => {
  const { parseBodyToObject } = require('./correlationEngine');
  assert.deepEqual(parseBodyToObject('username=demo&password=Secret123'), { username: 'demo', password: 'Secret123' });
});

test('parseBodyToObject returns null for XML, plain text, and empty/invalid input', () => {
  const { parseBodyToObject } = require('./correlationEngine');
  assert.equal(parseBodyToObject('<xml><a>b</a></xml>'), null);
  assert.equal(parseBodyToObject('just some plain text'), null);
  assert.equal(parseBodyToObject(''), null);
  assert.equal(parseBodyToObject('{not valid json'), null);
  assert.equal(parseBodyToObject(null), null);
});

test('detectCorrelations: correlates a value into/out of a form-urlencoded body, not just JSON', () => {
  const endpoints = [
    { name: 'Login', method: 'POST', url: 'https://api.example.com/auth/login', headers: {}, body: 'username=demo&password=Secret123', queryParams: {} },
    { name: 'Get Profile', method: 'GET', url: 'https://api.example.com/me', headers: {}, body: '', queryParams: { sessionId: 'sess_9f8e7d6c5b' } },
  ];
  const preRunData = [
    { body: 'sessionId=sess_9f8e7d6c5b&expiresIn=3600' }, // a form-urlencoded RESPONSE body
    { body: '' },
  ];
  const rules = detectCorrelations(endpoints, preRunData);
  const rule = rules.find(r => r.targetLocation === 'query' && r.targetKey === 'sessionId');
  assert.ok(rule, 'expected a rule correlating the form-urlencoded response field into the query param');
  assert.equal(rule.sourceEndpointIndex, 0);
  assert.equal(rule.sourceJsonPath, '$.sessionId');
});

test('resolveFieldNameToJsonPath finds a unique bare field name at any depth', () => {
  const { resolveFieldNameToJsonPath } = require('./correlationEngine');
  const body = { user: { accessToken: 'eyJabc123456789' }, meta: { count: 1 } };
  const result = resolveFieldNameToJsonPath(body, 'accessToken');
  assert.equal(result.jsonPath, '$.user.accessToken');
  assert.equal(result.ambiguous, false);
});

test('resolveFieldNameToJsonPath is case-insensitive on the field name', () => {
  const { resolveFieldNameToJsonPath } = require('./correlationEngine');
  const body = { orderId: 'ord_9f8e7d' };
  assert.equal(resolveFieldNameToJsonPath(body, 'ORDERID').jsonPath, '$.orderId');
});

test('resolveFieldNameToJsonPath reports ambiguity when multiple leaves share the name', () => {
  const { resolveFieldNameToJsonPath } = require('./correlationEngine');
  const body = { user: { id: 'u1' }, order: { id: 'o1' } };
  const result = resolveFieldNameToJsonPath(body, 'id');
  assert.equal(result.jsonPath, null);
  assert.equal(result.ambiguous, true);
  assert.deepEqual(result.candidates.sort(), ['$.order.id', '$.user.id']);
});

test('resolveFieldNameToJsonPath returns not-found for a name that does not exist', () => {
  const { resolveFieldNameToJsonPath } = require('./correlationEngine');
  const result = resolveFieldNameToJsonPath({ foo: 'bar1234' }, 'doesNotExist');
  assert.equal(result.jsonPath, null);
  assert.equal(result.ambiguous, false);
  assert.deepEqual(result.candidates, []);
});

test('resolveFieldNameToJsonPath handles a non-object body gracefully', () => {
  const { resolveFieldNameToJsonPath } = require('./correlationEngine');
  assert.deepEqual(resolveFieldNameToJsonPath(null, 'x'), { jsonPath: null, ambiguous: false, candidates: [] });
  assert.deepEqual(resolveFieldNameToJsonPath('not an object', 'x'), { jsonPath: null, ambiguous: false, candidates: [] });
});
