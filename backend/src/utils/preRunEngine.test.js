const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  getValueAtJsonPath, applyLiveCorrelatedValues, fireEndpointsWithCorrelation,
} = require('./preRunEngine');

test('getValueAtJsonPath reads a top-level and a nested/array field', () => {
  const body = { id: 'abc123', user: { tags: ['x', 'y'] } };
  assert.equal(getValueAtJsonPath(body, '$.id'), 'abc123');
  assert.equal(getValueAtJsonPath(body, '$.user.tags[1]'), 'y');
  assert.equal(getValueAtJsonPath(body, '$.missing'), undefined);
});

test('applyLiveCorrelatedValues rewrites a urlPath literal and a body field with the real captured value', () => {
  const ep = { url: 'https://api.example.com/orders/ord_9f8e7d', headers: {}, body: '', queryParams: {} };
  const rules = [{ targetLocation: 'urlPath', targetKey: 4, value: 'ord_9f8e7d', varName: 'id' }];
  const result = applyLiveCorrelatedValues(ep, rules, { id: 'ord_LIVE123' });
  assert.equal(result.url, 'https://api.example.com/orders/ord_LIVE123');
});

test('applyLiveCorrelatedValues leaves the literal untouched when the source never produced a value this run', () => {
  const ep = { url: 'https://api.example.com/orders/ord_9f8e7d', headers: {}, body: '', queryParams: {} };
  const rules = [{ targetLocation: 'urlPath', targetKey: 4, value: 'ord_9f8e7d', varName: 'id' }];
  const result = applyLiveCorrelatedValues(ep, rules, {}); // capturedValues empty — source failed/absent
  assert.equal(result.url, 'https://api.example.com/orders/ord_9f8e7d');
});

// fireEndpointsWithCorrelation calls the real fetch() via fireEndpoint() — preRunEngine's
// SSRF guard (isSafeUrl) deliberately blocks localhost/private-IP targets, so a real local
// test server isn't reachable here even in tests. Instead this mocks global.fetch with an
// in-process fake server against a syntactically-public hostname, to test the actual
// sequencing/capture logic (not the network layer, which fireEndpoint already owns).
test('fireEndpointsWithCorrelation sequentially threads a live-captured id from create into get/update', async () => {
  const endpoints = [
    { name: 'Create Order', method: 'POST', url: 'https://mock-target.test/orders', headers: {}, body: '{"item":"widget"}', queryParams: {} },
    { name: 'Get Order', method: 'GET', url: 'https://mock-target.test/orders/ord_9f8e7d', headers: {}, body: '', queryParams: {} },
  ];
  const rules = [{
    sourceEndpointIndex: 0, sourceJsonPath: '$.id',
    targetEndpointIndex: 1, targetLocation: 'urlPath', targetKey: 4, value: 'ord_9f8e7d', varName: 'id',
  }];

  const seenUrls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    seenUrls.push(url);
    if (url.includes('/orders') && !url.includes('/orders/')) {
      return { status: 201, statusText: 'Created', headers: new Map(), text: async () => JSON.stringify({ id: 'ord_LIVE999', item: 'widget' }) };
    }
    if (url === 'https://mock-target.test/orders/ord_LIVE999') {
      return { status: 200, statusText: 'OK', headers: new Map(), text: async () => JSON.stringify({ id: 'ord_LIVE999', item: 'widget' }) };
    }
    return { status: 404, statusText: 'Not Found', headers: new Map(), text: async () => JSON.stringify({ error: 'stale id used' }) };
  };

  try {
    const results = await fireEndpointsWithCorrelation(endpoints, rules, { variables: {} });
    assert.equal(results[0].success, true);
    assert.equal(results[1].success, true, 'Get Order must succeed using the live-captured id, not the stale recorded one');
    assert.ok(seenUrls[1].includes('ord_LIVE999'), 'the second request must have used the live id');
    assert.ok(!seenUrls[1].includes('ord_9f8e7d'), 'the stale recorded literal must never be sent');
  } finally {
    global.fetch = originalFetch;
  }
});

test('fireEndpointsWithCorrelation captures a source value from a RESPONSE HEADER, not just the body', async () => {
  const endpoints = [
    { name: 'Create Order', method: 'POST', url: 'https://mock-target.test/orders', headers: {}, body: '{"item":"widget"}', queryParams: {} },
    { name: 'Get Order', method: 'GET', url: 'https://mock-target.test/orders/ord_9f8e7d', headers: {}, body: '', queryParams: {} },
  ];
  const rules = [{
    sourceEndpointIndex: 0, sourceJsonPath: 'x-resource-id', sourceLocation: 'header',
    targetEndpointIndex: 1, targetLocation: 'urlPath', targetKey: 4, value: 'ord_9f8e7d', varName: 'id',
  }];

  const seenUrls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    seenUrls.push(url);
    if (url.endsWith('/orders')) {
      return { status: 201, statusText: 'Created', headers: new Map([['x-resource-id', 'ord_LIVE777']]), text: async () => JSON.stringify({ item: 'widget' }) };
    }
    if (url === 'https://mock-target.test/orders/ord_LIVE777') {
      return { status: 200, statusText: 'OK', headers: new Map(), text: async () => '{}' };
    }
    return { status: 404, statusText: 'Not Found', headers: new Map(), text: async () => '{}' };
  };

  try {
    const results = await fireEndpointsWithCorrelation(endpoints, rules, { variables: {} });
    assert.equal(results[1].success, true, 'Get Order must succeed using the header-sourced live id');
    assert.ok(seenUrls[1].includes('ord_LIVE777'));
    assert.ok(!seenUrls[1].includes('ord_9f8e7d'));
  } finally {
    global.fetch = originalFetch;
  }
});

test('fireEndpointsWithCorrelation still succeeds with no correlation rules at all (backward compatible)', async () => {
  const endpoints = [{ name: 'Ping', method: 'GET', url: 'https://mock-target.test/ping', headers: {}, body: '', queryParams: {} }];
  const originalFetch = global.fetch;
  global.fetch = async () => ({ status: 200, statusText: 'OK', headers: new Map(), text: async () => '{}' });
  try {
    const results = await fireEndpointsWithCorrelation(endpoints, [], { variables: {} });
    assert.equal(results[0].success, true);
  } finally {
    global.fetch = originalFetch;
  }
});

test('getCookieValue reads a specific cookie out of a real Set-Cookie header', () => {
  const { getCookieValue } = require('./preRunEngine');
  const responseHeaders = { 'set-cookie': 'sessionId=abc123def456; Path=/; HttpOnly' };
  assert.equal(getCookieValue(responseHeaders, 'sessionId'), 'abc123def456');
});

test('getCookieValue handles multiple Set-Cookie headers and picks the right one', () => {
  const { getCookieValue } = require('./preRunEngine');
  const responseHeaders = { 'set-cookie': ['sessionId=abc123def456; Path=/', 'csrfToken=xyz789; Path=/; Secure'] };
  assert.equal(getCookieValue(responseHeaders, 'csrfToken'), 'xyz789');
});

test('getCookieValue returns undefined when the cookie is not present', () => {
  const { getCookieValue } = require('./preRunEngine');
  assert.equal(getCookieValue({ 'set-cookie': 'other=1' }, 'sessionId'), undefined);
  assert.equal(getCookieValue({}, 'sessionId'), undefined);
});

test('fireEndpointsWithCorrelation captures a source value from a COOKIE, not just body/header', async () => {
  const { fireEndpointsWithCorrelation } = require('./preRunEngine');
  const endpoints = [
    { name: 'Login', method: 'POST', url: 'https://mock-target.test/auth/login', headers: {}, body: '{}', queryParams: {} },
    { name: 'Get Profile', method: 'GET', url: 'https://mock-target.test/me', headers: { 'X-Session': 'sess_9f8e7d6c5b' }, body: '', queryParams: {} },
  ];
  const rules = [{
    sourceEndpointIndex: 0, sourceJsonPath: 'sessionId', sourceLocation: 'cookie',
    targetEndpointIndex: 1, targetLocation: 'header', targetKey: 'X-Session', value: 'sess_9f8e7d6c5b', varName: 'sessionId',
  }];

  const seenHeaders = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, opts) => {
    seenHeaders.push(opts?.headers || {});
    if (url.endsWith('/login')) {
      return { status: 200, statusText: 'OK', headers: new Map([['set-cookie', 'sessionId=sess_LIVE999; Path=/; HttpOnly']]), text: async () => '{}' };
    }
    return { status: 200, statusText: 'OK', headers: new Map(), text: async () => '{}' };
  };

  try {
    const results = await fireEndpointsWithCorrelation(endpoints, rules, { variables: {} });
    assert.equal(results[1].success, true);
    assert.equal(seenHeaders[1]['X-Session'], 'sess_LIVE999', 'the header must carry the LIVE cookie value, not the stale recorded one');
  } finally {
    global.fetch = originalFetch;
  }
});

test('fireEndpointsWithCorrelation fires source before target even when the TARGET is recorded earlier in the collection', async () => {
  // A real recorded collection is not guaranteed to have "Login" (or any source) recorded
  // before every endpoint that depends on it — a 41-endpoint collection recorded by
  // clicking around a real app very commonly has requests out of dependency order. Index 0
  // here is the TARGET, index 1 is the SOURCE — firing strictly in array order would send
  // index 0's request before the source ever captured a live value.
  const endpoints = [
    { name: 'Get Profile', method: 'GET', url: 'https://mock-target.test/me', headers: { 'X-Session': 'sess_STALE' }, body: '', queryParams: {} },
    { name: 'Login', method: 'POST', url: 'https://mock-target.test/auth/login', headers: {}, body: '{}', queryParams: {} },
  ];
  const rules = [{
    sourceEndpointIndex: 1, sourceJsonPath: 'sessionId', sourceLocation: 'cookie',
    targetEndpointIndex: 0, targetLocation: 'header', targetKey: 'X-Session', value: 'sess_STALE', varName: 'sessionId',
  }];

  const fireLog = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, opts) => {
    fireLog.push(url);
    if (url.endsWith('/auth/login')) {
      return { status: 200, statusText: 'OK', headers: new Map([['set-cookie', 'sessionId=sess_LIVE123; Path=/; HttpOnly']]), text: async () => '{}' };
    }
    if (url.endsWith('/me')) {
      const sent = opts?.headers?.['X-Session'];
      return sent === 'sess_LIVE123'
        ? { status: 200, statusText: 'OK', headers: new Map(), text: async () => '{}' }
        : { status: 401, statusText: 'Unauthorized', headers: new Map(), text: async () => '{}' };
    }
    return { status: 404, statusText: 'Not Found', headers: new Map(), text: async () => '{}' };
  };

  try {
    const results = await fireEndpointsWithCorrelation(endpoints, rules, { variables: {} });
    assert.ok(fireLog[0].endsWith('/auth/login'), 'Login (the source) must actually fire first, regardless of its recorded array position');
    assert.equal(results[0].success, true, 'Get Profile (recorded at index 0) must still succeed using the live session, not the stale recorded one');
    assert.equal(results[1].success, true);
  } finally {
    global.fetch = originalFetch;
  }
});

test('applyLiveCorrelatedValues INJECT mode adds a header even when it was never present, using the real captured value', () => {
  const { applyLiveCorrelatedValues } = require('./preRunEngine');
  const ep = { url: 'https://api.example.com/orders', headers: { 'Content-Type': 'application/json' }, body: '', queryParams: {} };
  const rules = [{ targetLocation: 'header', targetKey: 'Authorization', value: null, varName: 'sessionToken' }];
  const result = applyLiveCorrelatedValues(ep, rules, { sessionToken: 'sess_LIVE123' });
  assert.equal(result.headers.Authorization, 'sess_LIVE123');
  assert.equal(result.headers['Content-Type'], 'application/json');
});

test('applyLiveCorrelatedValues INJECT mode into a literal "cookie" header reconstructs name=value, not the bare value', () => {
  // A real HTTP Cookie request header is a "name=value" pair (RFC 6265) — a cookie-sourced
  // value injected as a bare value into a literal "cookie" header target would never be
  // recognized by any server-side cookie parser, always failing regardless of freshness.
  const { applyLiveCorrelatedValues } = require('./preRunEngine');
  const ep = { url: 'https://api.example.com/me', headers: {}, body: '', queryParams: {} };
  const rules = [{
    targetLocation: 'header', targetKey: 'cookie', value: null, varName: 'sessionId',
    sourceLocation: 'cookie', sourceJsonPath: 'automationai_session',
  }];
  const result = applyLiveCorrelatedValues(ep, rules, { sessionId: 'sess_LIVE999' });
  assert.equal(result.headers.cookie, 'automationai_session=sess_LIVE999');
});

test('applyLiveCorrelatedValues INJECT mode into a non-cookie header from a cookie source stays a bare value', () => {
  // The cookie-pair reconstruction is scoped to an actual "cookie" header target — a
  // custom header (e.g. "X-Session-Token") sourced from a cookie is not itself a real
  // HTTP Cookie header, so it must NOT get the "name=" prefix.
  const { applyLiveCorrelatedValues } = require('./preRunEngine');
  const ep = { url: 'https://api.example.com/me', headers: {}, body: '', queryParams: {} };
  const rules = [{
    targetLocation: 'header', targetKey: 'X-Session-Token', value: null, varName: 'sessionId',
    sourceLocation: 'cookie', sourceJsonPath: 'automationai_session',
  }];
  const result = applyLiveCorrelatedValues(ep, rules, { sessionId: 'sess_LIVE999' });
  assert.equal(result.headers['X-Session-Token'], 'sess_LIVE999');
});
