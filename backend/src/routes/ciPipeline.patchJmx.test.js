// Regression test for the CI-embedded patch_jmx.py patcher (BB_PATCHER_PY in
// ciPipeline.js). Runs the REAL python source through a REAL python3 interpreter against
// a REAL generated stress JMX — not a JS re-implementation of the patcher's logic — since
// the actual bug this guards against was the patcher silently no-op'ing on
// UltimateThreadGroup (stress test) scripts: overriding VUsers/Ramp-up/Duration in the CI
// trigger dialog had zero effect on the schedule JMeter actually ran, because the patcher
// only knew how to rewrite the flat ThreadGroup's properties. A JS-only test wouldn't catch
// a mistake in the embedded Python string (e.g. a bad escape that's valid JS but breaks the
// generated .py file), which is exactly the class of bug this fix touches.
require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { buildJmxTemplate } = require('./testSuites');
const { BB_PATCHER_PY, buildGithubWorkflowYaml } = require('./ciPipeline');

let pythonAvailable = true;
try { execFileSync('python3', ['--version']); } catch { pythonAvailable = false; }

const endpoints = [{ name: 'Ping', method: 'GET', url: 'https://api.example.com/ping', headers: {}, body: '', queryParams: {} }];
const cfg = { protocol: 'https', url: 'api.example.com', port: '443', variables: {} };

function extractRows(xml) {
  return [...xml.matchAll(/<collectionProp name="\d">\s*<stringProp name="0">(\d+)<\/stringProp>\s*<stringProp name="1">(\d+)<\/stringProp>\s*<stringProp name="2">(\d+)<\/stringProp>\s*<stringProp name="3">(\d+)<\/stringProp>\s*<stringProp name="4">(\d+)<\/stringProp>/g)]
    .map(m => ({ startCount: +m[1], delay: +m[2], startup: +m[3], hold: +m[4], shutdown: +m[5] }));
}

test('patch_jmx.py rescales the UltimateThreadGroup staircase to the CI-trigger override values, not the generation-time ones', { skip: !pythonAvailable && 'python3 not available' }, () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-jmx-test-'));
  const patcherPath = path.join(tmpDir, 'patch_jmx.py');
  const scriptPath = path.join(tmpDir, 'stress.jmx');
  fs.writeFileSync(patcherPath, BB_PATCHER_PY);

  // Reproduces the exact reported scenario: script generated at 50 VUsers/20s ramp/100s
  // duration, then the CI trigger dialog overrides to 50/20/200.
  const generatedSuite = { name: 'Stress test with no existed rules', vusers: 50, rampup: 20, duration: 100 };
  const xmlBefore = buildJmxTemplate(generatedSuite, null, [], cfg, endpoints, null, 'stress');
  fs.writeFileSync(scriptPath, xmlBefore);

  execFileSync('python3', [patcherPath, scriptPath, '50', '20', '-1', '200']);
  const xmlAfter = fs.readFileSync(scriptPath, 'utf8');
  const rows = extractRows(xmlAfter);
  assert.equal(rows.length, 5, 'expected 5 staircase rows to survive the patch');

  // Every row must converge on the overridden Duration (200s), NOT the generation-time
  // duration (100s) — this is the exact assertion that fails without the fix, since an
  // unpatched UltimateThreadGroup keeps its original 100s-derived rows untouched.
  const endTimes = new Set(rows.map(r => r.delay + r.startup + r.hold));
  assert.equal(endTimes.size, 1, 'every row must still converge on a single end time after patching');
  assert.equal([...endTimes][0], 200, 'patched rows must converge on the OVERRIDDEN duration (200s), not the generation-time duration (100s)');

  const cumulative = rows.reduce((sum, r) => sum + r.startCount, 0);
  assert.equal(cumulative, 50, 'cumulative thread count across all rows must equal the overridden VUsers (50)');
});

test('patch_jmx.py rescales the spike UltimateThreadGroup (2-row baseline/peak shape) to the CI-trigger override values, and never confuses it with the 5-row stress shape', { skip: !pythonAvailable && 'python3 not available' }, () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-jmx-test-'));
  const patcherPath = path.join(tmpDir, 'patch_jmx.py');
  const scriptPath = path.join(tmpDir, 'spike.jmx');
  fs.writeFileSync(patcherPath, BB_PATCHER_PY);

  const generatedSuite = { name: 'Spike Test', vusers: 100, duration: 100 }; // < 120s -> 1 spike (2 rows)
  fs.writeFileSync(scriptPath, buildJmxTemplate(generatedSuite, null, [], cfg, endpoints, null, 'spike'));

  // Override duration crosses into what WOULD be the 2-spike tier if regenerated from
  // scratch — the row count must stay whatever was baked in at generation time (2 rows),
  // exactly like stress always stays at 5 steps regardless of override, only the TIMING
  // within that fixed row count rescales.
  execFileSync('python3', [patcherPath, scriptPath, '200', '-1', '-1', '400']);
  const xmlAfter = fs.readFileSync(scriptPath, 'utf8');
  const rows = extractRows(xmlAfter);
  assert.equal(rows.length, 2, 'row count must stay whatever was generated (2), not be recomputed from the override duration');

  const [baseline, spike] = rows;
  assert.equal(baseline.startCount, 20, 'baseline row should be 10% of the OVERRIDDEN VUsers (200), not the generation-time 100');
  assert.equal(baseline.delay + baseline.startup + baseline.hold, 400, 'baseline row must span the overridden duration (400s)');
  assert.equal(baseline.startCount + spike.startCount, 200, 'cumulative peak concurrency must equal the overridden VUsers exactly');
  assert.ok(spike.delay > 0 && spike.delay < 400, 'the spike must start partway through the run, not at t=0');
  assert.ok(spike.delay + spike.startup + spike.hold + spike.shutdown < 400, 'the spike must fully finish (back to baseline) well before the test ends, leaving a real recovery window');
});

test('patch_jmx.py preserves and correctly rescales a multi-spike (3-cycle) UltimateThreadGroup', { skip: !pythonAvailable && 'python3 not available' }, () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-jmx-test-'));
  const patcherPath = path.join(tmpDir, 'patch_jmx.py');
  const scriptPath = path.join(tmpDir, 'spike3.jmx');
  fs.writeFileSync(patcherPath, BB_PATCHER_PY);

  const generatedSuite = { name: 'Multi Spike Test', vusers: 100, duration: 400 }; // >= 300s -> 3 spikes (4 rows)
  fs.writeFileSync(scriptPath, buildJmxTemplate(generatedSuite, null, [], cfg, endpoints, null, 'spike'));

  execFileSync('python3', [patcherPath, scriptPath, '200', '-1', '-1', '800']);
  const xmlAfter = fs.readFileSync(scriptPath, 'utf8');
  const rows = extractRows(xmlAfter);
  assert.equal(rows.length, 4, 'expected 1 baseline + 3 spike rows, preserved from generation time');

  const [baseline, ...spikes] = rows;
  assert.equal(baseline.startCount, 20, '10% of the overridden 200 VUsers');
  assert.equal(baseline.delay + baseline.startup + baseline.hold, 800, 'baseline must span the overridden 800s duration');
  assert.ok(spikes.every(s => baseline.startCount + s.startCount === 200), 'every one of the 3 spikes must reach the overridden peak (200) exactly');

  const ends = spikes.map(s => s.delay + s.startup + s.hold + s.shutdown);
  for (let i = 1; i < spikes.length; i++) {
    assert.ok(spikes[i].delay >= ends[i - 1], `spike #${i + 1} must not start before spike #${i} finishes`);
  }
});

test('patch_jmx.py leaves the flat ThreadGroup (Load Test) path unaffected', { skip: !pythonAvailable && 'python3 not available' }, () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-jmx-test-'));
  const patcherPath = path.join(tmpDir, 'patch_jmx.py');
  const scriptPath = path.join(tmpDir, 'load.jmx');
  fs.writeFileSync(patcherPath, BB_PATCHER_PY);

  const suite = { name: 'Load test', vusers: 10, rampup: 10, duration: 60 };
  fs.writeFileSync(scriptPath, buildJmxTemplate(suite, null, [], cfg, endpoints, null, 'load'));

  execFileSync('python3', [patcherPath, scriptPath, '25', '15', '-1', '120']);
  const xmlAfter = fs.readFileSync(scriptPath, 'utf8');
  assert.ok(xmlAfter.includes('<stringProp name="ThreadGroup.num_threads">25</stringProp>'));
  assert.ok(xmlAfter.includes('<stringProp name="ThreadGroup.ramp_time">15</stringProp>'));
  assert.ok(xmlAfter.includes('<stringProp name="ThreadGroup.duration">120</stringProp>'));
  assert.ok(!xmlAfter.includes('UltimateThreadGroup'), 'a Load Test script must never contain an UltimateThreadGroup element');
});

// Guards against the actual bug reported in production: the GitHub Actions workflow file
// embeds the patcher as a fixed base64 blob baked in AT GENERATION TIME. If /trigger never
// regenerates that file, a fix to BB_PATCHER_PY (like the UltimateThreadGroup support above)
// silently never reaches a user's real repo, no matter how correct the backend source is —
// the trigger dialog's VUsers/Ramp-up/Duration overrides just keep doing nothing. This test
// makes sure the embedded blob a freshly-built workflow carries is always today's patcher.
test('buildGithubWorkflowYaml embeds the CURRENT patch_jmx.py, not a frozen copy', () => {
  const yaml = buildGithubWorkflowYaml({
    dockerImage: 'tasleemzaif/perfstudio:latest',
    k6Image: 'grafana/k6:latest',
    defaultScript: 'test.jmx',
    userBranch: 'feature/someone',
    scriptList: '      # Some Suite: test.jmx',
  });
  const m = yaml.match(/echo '([A-Za-z0-9+/=]+)' \| base64 -d > \.PerfStudio\/patch_jmx\.py/);
  assert.ok(m, 'expected the workflow to embed a base64 patcher blob');
  const decoded = Buffer.from(m[1], 'base64').toString('utf8');
  assert.equal(decoded, BB_PATCHER_PY, 'the embedded blob must decode to exactly today\'s BB_PATCHER_PY, not a stale hand-copied version');
  assert.ok(decoded.includes('UltimateThreadGroup'), 'the embedded patcher must include stress-test staircase support');
  assert.ok(yaml.includes("default: '10'") && yaml.includes('feature/someone') && yaml.includes('test.jmx'), 'workflow inputs must reflect the passed-in defaults');
});

// Regression for a real production failure: k6 discards a script's own `options.scenarios`
// entirely whenever CLI-level --vus/--duration are ALSO passed ("cli level configuration
// overrode scenarios configuration entirely") — every generated k6 script (load/spike/stress/
// endurance) defines its load profile as a scenario, so passing those flags silently flattened
// every one of them into one flat constant-VUs run, no ramp, no steps, regardless of test type.
test('the k6 duration-mode invocation uses --env, never --vus/--duration, so it never overrides the script\'s own scenarios', () => {
  const yaml = buildGithubWorkflowYaml({
    dockerImage: 'tasleemzaif/perfstudio:latest', k6Image: 'grafana/k6:latest',
    defaultScript: 'test.jmx', userBranch: 'feature/someone', scriptList: '',
  });
  const k6StepIdx = yaml.indexOf('Run k6');
  assert.ok(k6StepIdx > -1, 'expected a Run k6 step');
  const k6Step = yaml.slice(k6StepIdx, yaml.indexOf('Validate results (JMeter)'));

  assert.ok(!/--vus\s+"?\$\{\{\s*inputs\.k6_vus\s*\}\}"?\s+\$K6_MODE_ARGS/.test(k6Step), 'the duration-mode docker run must not pass --vus alongside --duration/--env args (that\'s exactly what triggers k6\'s scenario override)');
  assert.ok(k6Step.includes('--env THREADS=') && k6Step.includes('--env DURATION='), 'duration mode must pass THREADS/DURATION as --env so the script\'s own scenarios definition runs unmodified');
  assert.ok(k6Step.includes('inputs.k6_rampup'), 'k6 needs its own ramp-up input, mirroring jmeter_rampup, for stress/spike/endurance profiles to be configurable at trigger time');
});
