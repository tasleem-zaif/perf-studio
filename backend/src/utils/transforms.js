// transforms.js — for a target field that needs a DERIVED version of a correlated value
// (base64/hash/case-changed), not a verbatim copy. Auto-detection can never propose these:
// a transformed value doesn't literally match anything in an earlier response, so a human
// has to notice "this needs the md5 of the login response's userId" and say so explicitly
// via a manual correlation rule's optional `transform` field (routes/ai.js's
// /correlations/manual). A fixed, whitelisted set of named transforms — not arbitrary
// scripting — keeps this safe and predictable, mirroring fieldGenerators.js's own registry
// pattern for the same reason.
//
// Every JMeter expression below was verified against the JMeter user manual's function
// reference (not guessed) — __base64Encode/__base64Decode do NOT exist as built-in JMeter
// functions (that's a real, documented gap; would need a JSR223 PreProcessor + Groovy,
// which isn't guaranteed available in every JMeter install, so it's excluded here rather
// than shipped unreliable), but __digest, __urlencode, __urldecode, and __changeCase do.
const crypto = require('crypto');

// Each engine's `wrap` builds the COMPLETE splice-ready reference text (always already
// including the outer `${...}`) from a bare variable name — JMeter's `${}` denotes both
// plain variable refs and function calls uniformly, so its own function-call syntax IS the
// wrapper; k6's `${}` is plain JS template-literal interpolation around an arbitrary
// expression, so the wrapper is added explicitly around the JS expression here.
const TRANSFORMS = {
  md5:       { label: 'MD5 hash (hex)',    jmeter: v => `\${__digest(MD5,\${${v}},,,)}`,     k6: v => `\${crypto.md5(${v}, 'hex')}`,  live: v => crypto.createHash('md5').update(v).digest('hex') },
  sha1:      { label: 'SHA-1 hash (hex)',  jmeter: v => `\${__digest(SHA-1,\${${v}},,,)}`,   k6: v => `\${crypto.sha1(${v}, 'hex')}`, live: v => crypto.createHash('sha1').update(v).digest('hex') },
  sha256:    { label: 'SHA-256 hash (hex)', jmeter: v => `\${__digest(SHA-256,\${${v}},,,)}`, k6: v => `\${crypto.sha256(${v}, 'hex')}`, live: v => crypto.createHash('sha256').update(v).digest('hex') },
  urlEncode: { label: 'URL-encode',        jmeter: v => `\${__urlencode(\${${v}})}`,         k6: v => `\${encodeURIComponent(${v})}`, live: v => encodeURIComponent(v) },
  urlDecode: { label: 'URL-decode',        jmeter: v => `\${__urldecode(\${${v}})}`,         k6: v => `\${decodeURIComponent(${v})}`, live: v => decodeURIComponent(v) },
  upperCase: { label: 'Upper case',        jmeter: v => `\${__changeCase(\${${v}},UPPER,)}`, k6: v => `\${${v}.toUpperCase()}`,       live: v => v.toUpperCase() },
  lowerCase: { label: 'Lower case',        jmeter: v => `\${__changeCase(\${${v}},LOWER,)}`, k6: v => `\${${v}.toLowerCase()}`,       live: v => v.toLowerCase() },
};

// Transforms whose k6 codegen expression references the `k6/crypto` module — buildK6Template
// only emits `import crypto from 'k6/crypto';` when at least one rule actually needs it, so
// a script with no hash transforms doesn't carry an unused import.
const K6_CRYPTO_TRANSFORMS = new Set(['md5', 'sha1', 'sha256']);

function isValidTransform(type) {
  return Object.prototype.hasOwnProperty.call(TRANSFORMS, type);
}

// Builds the complete splice-ready reference text a generated script embeds in place of a
// bare `${varName}` — e.g. `${__digest(MD5,${accessToken},,,)}` for JMeter, or
// `${crypto.md5(accessToken, 'hex')}` for k6. `varName` is always the bare captured
// variable name; each engine's own wrap function decides how to reference it.
function transformScriptExpression(type, varName, engine) {
  const t = TRANSFORMS[type];
  if (!t) return null;
  return engine === 'k6' ? t.k6(varName) : t.jmeter(varName);
}

// Computes the REAL transformed value during a live pre-run (preRunEngine.js), using
// Node's built-in crypto/encodeURIComponent — the live-firing counterpart to
// transformScriptExpression the same way getValueAtJsonPath is the live counterpart of
// jsonPathToOptionalChain.
function transformLiveValue(type, value) {
  const t = TRANSFORMS[type];
  if (!t) return value;
  try { return t.live(String(value)); } catch { return value; }
}

module.exports = {
  TRANSFORMS, K6_CRYPTO_TRANSFORMS, isValidTransform, transformScriptExpression, transformLiveValue,
};
