const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isValidTransform, transformScriptExpression, transformLiveValue } = require('./transforms');

test('isValidTransform recognizes the whitelisted transforms and rejects anything else', () => {
  for (const t of ['md5', 'sha1', 'sha256', 'urlEncode', 'urlDecode', 'upperCase', 'lowerCase']) {
    assert.equal(isValidTransform(t), true, `${t} should be valid`);
  }
  assert.equal(isValidTransform('base64'), false, 'base64 has no native JMeter function and must not be offered');
  assert.equal(isValidTransform('trim'), false);
  assert.equal(isValidTransform('bogus'), false);
});

test('transformScriptExpression: JMeter forms use verified built-in functions', () => {
  assert.equal(transformScriptExpression('md5', 'accessToken', 'jmeter'), '${__digest(MD5,${accessToken},,,)}');
  assert.equal(transformScriptExpression('sha1', 'x', 'jmeter'), '${__digest(SHA-1,${x},,,)}');
  assert.equal(transformScriptExpression('sha256', 'x', 'jmeter'), '${__digest(SHA-256,${x},,,)}');
  assert.equal(transformScriptExpression('urlEncode', 'email', 'jmeter'), '${__urlencode(${email})}');
  assert.equal(transformScriptExpression('urlDecode', 'email', 'jmeter'), '${__urldecode(${email})}');
  assert.equal(transformScriptExpression('upperCase', 'code', 'jmeter'), '${__changeCase(${code},UPPER,)}');
  assert.equal(transformScriptExpression('lowerCase', 'code', 'jmeter'), '${__changeCase(${code},LOWER,)}');
});

test('transformScriptExpression: k6 forms use k6/crypto, k6/encoding-free built-ins, and plain JS', () => {
  assert.equal(transformScriptExpression('md5', 'accessToken', 'k6'), "${crypto.md5(accessToken, 'hex')}");
  assert.equal(transformScriptExpression('sha256', 'x', 'k6'), "${crypto.sha256(x, 'hex')}");
  assert.equal(transformScriptExpression('urlEncode', 'email', 'k6'), '${encodeURIComponent(email)}');
  assert.equal(transformScriptExpression('urlDecode', 'email', 'k6'), '${decodeURIComponent(email)}');
  assert.equal(transformScriptExpression('upperCase', 'code', 'k6'), '${code.toUpperCase()}');
  assert.equal(transformScriptExpression('lowerCase', 'code', 'k6'), '${code.toLowerCase()}');
});

test('transformScriptExpression returns null for an unknown transform type', () => {
  assert.equal(transformScriptExpression('bogus', 'x', 'jmeter'), null);
});

test('transformLiveValue computes the real hash/case/encoding for pre-run verification', () => {
  assert.equal(transformLiveValue('md5', 'hello'), '5d41402abc4b2a76b9719d911017c592');
  assert.equal(transformLiveValue('upperCase', 'abc'), 'ABC');
  assert.equal(transformLiveValue('lowerCase', 'ABC'), 'abc');
  assert.equal(transformLiveValue('urlEncode', 'a b'), 'a%20b');
  assert.equal(transformLiveValue('urlDecode', 'a%20b'), 'a b');
});

test('transformLiveValue falls back to the original value on an unknown type rather than throwing', () => {
  assert.equal(transformLiveValue('bogus', 'abc'), 'abc');
});
