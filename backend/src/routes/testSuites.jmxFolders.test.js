// Verifies the nested Simple Controller (GenericController) folder hierarchy in
// buildJmxTemplate — extended from a single top-level grouping to the endpoint's FULL
// recorded folderPath (e.g. "Auth / Login"), while preserving the flat (no folder) and
// single-level cases the old implementation already handled.
require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildJmxTemplate } = require('./testSuites');

const suite = { name: 'Folder Test', iter_mode: 'duration', vusers: 5, rampup: 5, duration: 30 };
const cfg = { protocol: 'https', url: 'api.example.com', port: '443', variables: {} };

function generate(endpoints) {
  return buildJmxTemplate(suite, null, [], cfg, endpoints, null);
}

test('no folder info at all renders flat — no GenericController wrapper', () => {
  const xml = generate([
    { name: 'A', method: 'GET', url: 'https://api.example.com/a', headers: {}, body: '', queryParams: {} },
    { name: 'B', method: 'GET', url: 'https://api.example.com/b', headers: {}, body: '', queryParams: {} },
  ]);
  assert.ok(!xml.includes('GenericController'));
  assert.ok(xml.includes('testname="A"') && xml.includes('testname="B"'));
});

test('a single top-level folder (no nesting) wraps its endpoints in one Simple Controller', () => {
  const xml = generate([
    { name: 'Login', method: 'POST', url: 'https://api.example.com/login', headers: {}, body: '', queryParams: {}, folder: 'Auth', folderPath: 'Auth' },
    { name: 'Logout', method: 'POST', url: 'https://api.example.com/logout', headers: {}, body: '', queryParams: {}, folder: 'Auth', folderPath: 'Auth' },
  ]);
  const count = (xml.match(/<GenericController /g) || []).length;
  assert.equal(count, 1, 'expected exactly one Simple Controller for the single shared folder');
  assert.ok(xml.includes('testname="Auth"'));
  const folderPos = xml.indexOf('testname="Auth"');
  const loginPos = xml.indexOf('testname="Login"');
  assert.ok(folderPos < loginPos, 'the controller must be declared before the samplers it wraps');
});

test('a nested folderPath produces nested Simple Controllers matching the recorded hierarchy', () => {
  const xml = generate([
    { name: 'Login', method: 'POST', url: 'https://api.example.com/auth/login', headers: {}, body: '', queryParams: {}, folder: 'Auth', folderPath: 'Auth / Login' },
  ]);
  const count = (xml.match(/<GenericController /g) || []).length;
  assert.equal(count, 2, 'expected one controller for "Auth" and a nested one for "Login"');
  const authPos = xml.indexOf('testname="Auth"');
  const loginFolderPos = xml.indexOf('testname="Login"'); // the nested Simple Controller, not the sampler
  const samplerPos = xml.lastIndexOf('testname="Login"'); // the HTTPSamplerProxy itself
  assert.ok(authPos < loginFolderPos, '"Auth" controller must come before the nested "Login" controller');
  assert.ok(loginFolderPos <= samplerPos, 'the nested controller must come before (or be) the sampler it wraps');
});

test('endpoints at the folder root AND endpoints in a subfolder coexist correctly', () => {
  const xml = generate([
    { name: 'Health', method: 'GET', url: 'https://api.example.com/health', headers: {}, body: '', queryParams: {} }, // no folder — root level
    { name: 'Login', method: 'POST', url: 'https://api.example.com/auth/login', headers: {}, body: '', queryParams: {}, folder: 'Auth', folderPath: 'Auth' },
  ]);
  assert.ok(xml.includes('testname="Health"'));
  assert.ok(xml.includes('testname="Auth"'));
  const count = (xml.match(/<GenericController /g) || []).length;
  assert.equal(count, 1, 'only the foldered endpoint should get a wrapper');
});

test('a folder containing both its own endpoints and a subfolder emits both as siblings', () => {
  const xml = generate([
    { name: 'List Users', method: 'GET', url: 'https://api.example.com/users', headers: {}, body: '', queryParams: {}, folder: 'Users', folderPath: 'Users' },
    { name: 'Get Address', method: 'GET', url: 'https://api.example.com/users/address', headers: {}, body: '', queryParams: {}, folder: 'Users', folderPath: 'Users / Address' },
  ]);
  const count = (xml.match(/<GenericController /g) || []).length;
  assert.equal(count, 2, 'one controller for "Users", one nested for "Address"');
  assert.ok(xml.includes('testname="List Users"'));
  assert.ok(xml.includes('testname="Get Address"'));
});

test('nested folders still produce balanced hashTree pairs', () => {
  const xml = generate([
    { name: 'A', method: 'GET', url: 'https://api.example.com/a', headers: {}, body: '', queryParams: {}, folder: 'F1', folderPath: 'F1 / F2 / F3' },
  ]);
  const opens = (xml.match(/<hashTree>/g) || []).length;
  const closes = (xml.match(/<\/hashTree>/g) || []).length;
  assert.equal(opens, closes, `mismatched hashTree tags (${opens} opens vs ${closes} closes) in a 3-level-deep folder`);
});
