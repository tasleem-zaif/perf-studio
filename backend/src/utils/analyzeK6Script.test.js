const test = require('node:test');
const assert = require('node:assert/strict');
const { extractK6VarRefs, extractK6DefinedVars, extractK6Hostnames } = require('./analyzeK6Script');

const SAMPLE_SCRIPT = `
import http from 'k6/http';
import { SharedArray } from 'k6/data';

const BASE_URL = __ENV.BASE_URL || 'https://api.example.com';

const users = new SharedArray('users', function () {
  return [{ username: 'a', password: 'b' }];
});

export default function (data) {
  const { username, password } = users[0];
  const loginRes = http.post(\`\${BASE_URL}/login\`, JSON.stringify({ username, password }));
  const token = loginRes.json('access_token');
  const profileRes = http.get(\`\${BASE_URL}/profile\`, { headers: { Authorization: \`Bearer \${token}\` } });
}
`;

test('extractK6VarRefs finds template-literal variable references, skipping __ENV', () => {
  const refs = extractK6VarRefs(SAMPLE_SCRIPT);
  assert.ok(refs.includes('BASE_URL'));
  assert.ok(refs.includes('token'));
  assert.ok(!refs.includes('__ENV'));
});

test('extractK6DefinedVars finds const declarations, destructured bindings, and function params', () => {
  const defined = extractK6DefinedVars(SAMPLE_SCRIPT);
  assert.ok(defined.includes('BASE_URL'));
  assert.ok(defined.includes('users'));
  assert.ok(defined.includes('username'));
  assert.ok(defined.includes('password'));
  assert.ok(defined.includes('loginRes'));
  assert.ok(defined.includes('token'));
  assert.ok(defined.includes('data'));
});

test('extractK6Hostnames pulls hostnames out of URL literals/defaults', () => {
  const hosts = extractK6Hostnames(SAMPLE_SCRIPT);
  assert.ok(hosts.includes('api.example.com'));
});

test('all three helpers degrade gracefully on empty/no-match content', () => {
  assert.deepEqual(extractK6VarRefs(''), []);
  assert.deepEqual(extractK6DefinedVars('const x = 1;'.slice(0, 0)), []);
  assert.deepEqual(extractK6Hostnames('no urls here'), []);
});
