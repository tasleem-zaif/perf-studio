const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  isValidGeneratorType, generatorExpression, applyFieldGenerators, groupGeneratorsByTarget,
} = require('./fieldGenerators');

test('isValidGeneratorType recognizes the built-in generators and rejects anything else', () => {
  assert.equal(isValidGeneratorType('uuid'), true);
  assert.equal(isValidGeneratorType('timestamp'), true);
  assert.equal(isValidGeneratorType('unique'), true);
  assert.equal(isValidGeneratorType('bogus'), false);
});

test('generatorExpression returns JMeter function syntax for jmeter and a JS expression for k6', () => {
  assert.equal(generatorExpression('uuid', 'jmeter'), '${__UUID()}');
  assert.ok(generatorExpression('uuid', 'k6').startsWith('${'));
  assert.equal(generatorExpression('timestamp', 'jmeter'), '${__time()}');
  assert.equal(generatorExpression('timestamp', 'k6'), '${Date.now()}');
  assert.equal(generatorExpression('bogus', 'jmeter'), null);
});

test('applyFieldGenerators rewrites a query param with a JMeter UUID function call', () => {
  const normalized = { path: '/signup', headers: {}, body: '', queryParams: { email: 'recorded@example.com' } };
  const rules = [{ targetLocation: 'query', targetKey: 'email', value: 'recorded@example.com', generator: 'uuid' }];
  const result = applyFieldGenerators(normalized, rules, 'jmeter');
  assert.equal(result.queryParams.email, '${__UUID()}');
});

test('applyFieldGenerators rewrites a body field with the k6 expression', () => {
  const normalized = { path: '/signup', headers: {}, body: '{"email": "recorded@example.com"}', queryParams: {} };
  const rules = [{ targetLocation: 'body', targetKey: '$.email', value: 'recorded@example.com', generator: 'timestamp' }];
  const result = applyFieldGenerators(normalized, rules, 'k6');
  assert.equal(result.body, '{"email": "${Date.now()}"}');
});

test('applyFieldGenerators is a no-op when the current value no longer matches (stale rule safety)', () => {
  const normalized = { path: '/signup', headers: {}, body: '', queryParams: { email: 'CHANGED@example.com' } };
  const rules = [{ targetLocation: 'query', targetKey: 'email', value: 'recorded@example.com', generator: 'uuid' }];
  const result = applyFieldGenerators(normalized, rules, 'jmeter');
  assert.equal(result.queryParams.email, 'CHANGED@example.com');
});

test('applyFieldGenerators silently skips an unknown generator type', () => {
  const normalized = { path: '/x', headers: {}, body: '', queryParams: { a: 'val' } };
  const rules = [{ targetLocation: 'query', targetKey: 'a', value: 'val', generator: 'not-a-real-generator' }];
  const result = applyFieldGenerators(normalized, rules, 'jmeter');
  assert.equal(result.queryParams.a, 'val');
});

test('groupGeneratorsByTarget groups by endpoint index and drops invalid generator types', () => {
  const rules = [
    { targetEndpointIndex: 1, generator: 'uuid' },
    { targetEndpointIndex: 1, generator: 'timestamp' },
    { targetEndpointIndex: 2, generator: 'bogus' },
  ];
  const map = groupGeneratorsByTarget(rules);
  assert.equal(map.get(1).length, 2);
  assert.equal(map.has(2), false, 'a rule with an invalid generator type must be dropped, not passed through');
});
