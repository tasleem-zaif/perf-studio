const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const { spawn, execSync } = require('child_process');
const db = require('../db');
const { callAi, getMaxOutputTokens } = require('./aiClient');
const { getProjectPath, resolveOrgSlugForProject } = require('./projectFolders');
const { evaluateRules, evaluateRulesFromContent } = require('./ruleEvaluator');
const { patchJmxForParams } = require('./patchJmx');
const { resolveForScript, extractAllTokens } = require('./preRunEngine');
const s3Sync = require('./s3Sync');
const resultsStore = require('./resultsStore');

// Auto-heal gets exactly 1 automatic attempt — if it doesn't fix the run, the "Custom Heal"
// button (which lets the user supply a targeted instruction) is the intended next step
// rather than more unguided automatic retries burning AI calls on the same failure.
const MAX_ATTEMPTS   = 1;
const PerfStudio_DIR = path.join(process.env.USERPROFILE || process.env.HOME, '.PerfStudio');

// Phase-1 quick-verify params — just enough to confirm the script fix is valid.
// Single user, single loop: the cheapest possible smoke test before spending real load
// on the full-params re-run in Phase 2.
const HEAL_VUSERS = 1;
const HEAL_RAMPUP = 1;    // seconds
const HEAL_LOOPS  = 1;

// ── Binary discovery ──────────────────────────────────────────────────────────
function getJMeterBin(customPath) {
  const resolve = p => {
    if (!p) return p;
    try {
      if (fs.statSync(p).isDirectory()) {
        const bat = path.join(p, 'jmeter.bat');
        const sh  = path.join(p, 'jmeter');
        if (fs.existsSync(bat)) return bat;
        if (fs.existsSync(sh))  return sh;
      }
    } catch {}
    return p;
  };
  const candidates = [
    ...(customPath ? [resolve(customPath)] : []),
    path.join(PerfStudio_DIR, 'jmeter', 'bin', 'jmeter.bat'),
    'C:\\apache-jmeter\\bin\\jmeter.bat',
    'C:\\jmeter\\bin\\jmeter.bat',
    'C:\\Program Files\\Apache\\JMeter\\bin\\jmeter.bat',
  ];
  for (const p of candidates) if (p && fs.existsSync(p)) return p;
  try { execSync('jmeter --version 2>&1', { timeout: 5000 }); return 'jmeter'; } catch {}
  return null;
}

function getK6Bin(customPath) {
  const candidates = [
    ...(customPath ? [customPath] : []),
    path.join(PerfStudio_DIR, 'k6', 'k6.exe'),
  ];
  for (const p of candidates) if (p && fs.existsSync(p)) return p;
  try { execSync('k6 version 2>&1', { timeout: 5000 }); return 'k6'; } catch {}
  return null;
}

// ── DB helpers ────────────────────────────────────────────────────────────────
async function setHealStatus(runId, status) {
  await db.prepare('UPDATE execution_runs SET heal_status=? WHERE id=?').run(status, runId);
}

async function logHealAttempt(runId, attempt, diagnosis, fix, fixType) {
  return (await db.prepare(
    'INSERT INTO auto_heal_logs (run_id, attempt, diagnosis, fix_applied, fix_type) VALUES (?,?,?,?,?)'
  ).run(runId, attempt, diagnosis, fix, fixType)).lastInsertRowid;
}

// ── Runtime params: original run values → suite defaults → hard fallback ──────
function resolveRunParams(originalRun, suite) {
  return {
    vusers:    originalRun.run_vusers    || suite.vusers    || 50,
    rampup:    originalRun.run_rampup    || suite.rampup    || 30,
    duration:  originalRun.run_duration  || suite.duration  || 300,
    loops:     originalRun.run_loops     || suite.loops     || 1,
    iter_mode: originalRun.run_iter_mode || suite.iter_mode || 'duration',
  };
}

// ── Infrastructure failure detection ─────────────────────────────────────────
const INFRA_CODES = new Set(['500', '501', '502', '503', '504', '505', '429']);
const INFRA_MSG_PATTERNS = [
  'internal server error', 'bad gateway', 'service unavailable',
  'gateway timeout', 'too many requests', 'connection refused',
  'connection reset', 'socket timeout', 'read timed out',
  'connect timed out', 'no route to host', 'connection timed out',
  'econnrefused', 'econnreset', 'etimedout',
];

function classifyErrors(jtlPath) {
  if (!jtlPath || !fs.existsSync(jtlPath)) {
    return { isInfra: false, infraCount: 0, scriptCount: 0, total: 0, summary: '' };
  }
  return classifyErrorsFromContent(fs.readFileSync(jtlPath, 'utf8'));
}

/** Same as classifyErrors, but from already-fetched CSV text (e.g. read via resultsStore). */
function classifyErrorsFromContent(content) {
  if (!content) return { isInfra: false, infraCount: 0, scriptCount: 0, total: 0, summary: '' };
  const lines   = content.split('\n');
  const headers = (lines[0] || '').split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  const si  = headers.indexOf('success');
  const rcI = headers.indexOf('responseCode');
  const rmI = headers.indexOf('responseMessage');
  const fmI = headers.indexOf('failureMessage');

  let infra = 0, script = 0, total = 0;
  const infraReasons = new Set();

  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const parts   = lines[i].split(',');
    const success = si >= 0 ? (parts[si] || '').replace(/^"|"$/g, '').trim() : 'true';
    if (success === 'true') continue;
    total++;
    const rc  = rcI >= 0 ? (parts[rcI] || '').replace(/^"|"$/g, '').trim() : '';
    const msg = ((rmI >= 0 ? parts[rmI] || '' : '') + ' ' + (fmI >= 0 ? parts[fmI] || '' : ''))
      .replace(/^"|"$/g, '').toLowerCase();
    const isInfraCode = INFRA_CODES.has(rc) || rc === '0' || rc === '';
    const isInfraMsg  = INFRA_MSG_PATTERNS.some(p => msg.includes(p));
    if (isInfraCode || isInfraMsg) {
      infra++;
      if (rc && rc !== '0') infraReasons.add(`HTTP ${rc}`);
      else { const m = INFRA_MSG_PATTERNS.find(p => msg.includes(p)); if (m) infraReasons.add(m); }
    } else {
      script++;
    }
  }

  const isInfra = total > 0 && (infra / total) >= 0.70;
  return {
    isInfra,
    infraCount: infra, scriptCount: script, total,
    summary: isInfra
      ? `${infra}/${total} errors are server/network-side (${[...infraReasons].join(', ')})`
      : '',
  };
}

// ── Core run spawner ──────────────────────────────────────────────────────────
// mode = 'quick'  → HEAL_VUSERS / HEAL_LOOPS (no report generation)
// mode = 'full'   → exact runtime params from the original failed run
async function spawnRun(userId, originalRun, suite, project, mode) {
  const cfgRow   = await db.prepare('SELECT config_json FROM global_config WHERE user_id = ?').get(userId);
  const savedCfg = cfgRow ? JSON.parse(cfgRow.config_json || '{}') : {};

  const engine     = originalRun.engine;
  const scriptPath = engine === 'jmeter' ? suite.jmx_path : suite.js_path;
  if (!scriptPath || !fs.existsSync(scriptPath)) {
    throw new Error(`Script file not found: ${scriptPath || '(not set)'}`);
  }

  const projectFolder = project.folder_path || getProjectPath(project.name, project.id);
  const orgSlug        = await resolveOrgSlugForProject(originalRun.project_id);
  const runCount      = (await db.prepare('SELECT COUNT(*) as n FROM execution_runs WHERE project_id = ?').get(originalRun.project_id)).n;
  const runNumber     = runCount + 1;
  const resultDir     = path.join(projectFolder, 'results', `Run_${runNumber}`);
  fs.mkdirSync(resultDir, { recursive: true });

  const allLogs = [];
  const addLog  = (type, message) => allLogs.push({ type, message });

  const modeLabel = mode === 'quick'
    ? `Quick-verify: ${HEAL_VUSERS} VUser × ${HEAL_LOOPS} loop`
    : `Full run with original params`;

  addLog('info', `[Auto Healer] Run #${runNumber} — ${modeLabel}`);

  // Resolve params based on mode
  const orig = resolveRunParams(originalRun, suite);
  const p = mode === 'quick'
    ? { vusers: HEAL_VUSERS, rampup: HEAL_RAMPUP, iter_mode: 'loops', duration: 0, loops: HEAL_LOOPS }
    : orig;

  const newRunId = (await db.prepare(`
    INSERT INTO execution_runs
      (project_id, suite_id, engine, status, result_dir, logs, started_at, auto_heal,
       run_vusers, run_rampup, run_duration, run_loops, run_iter_mode)
    VALUES (?, ?, ?, 'running', ?, '[]', NOW(), 1, ?, ?, ?, ?, ?)
  `).run(
    originalRun.project_id, originalRun.suite_id, engine, resultDir,
    p.vusers, p.rampup, p.duration, p.loops, p.iter_mode
  )).lastInsertRowid;

  try {
    let cmd, args, reportPath = null, jtlPath = null, jmeterLogPath = null;

    let patchedJmx = null;
    if (engine === 'jmeter') {
      const bin = getJMeterBin(savedCfg.jmeter_path);
      if (!bin) throw new Error('JMeter binary not found');

      jtlPath       = path.join(resultDir, 'results.jtl');
      jmeterLogPath = path.join(resultDir, 'jmeter.log');

      // Patch runtime params directly into JMX XML so they override hardcoded values
      patchedJmx = patchJmxForParams(scriptPath, {
        vusers:    p.vusers,
        rampup:    p.rampup,
        duration:  p.duration,
        loops:     p.loops,
        iter_mode: p.iter_mode,
      });

      cmd  = bin;
      args = ['-n', '-t', patchedJmx, '-l', jtlPath, '-j', jmeterLogPath];

      // Full runs get HTML report; quick runs skip it (saves ~5s)
      if (mode === 'full') {
        const reportDir = path.join(resultDir, 'report');
        fs.mkdirSync(reportDir, { recursive: true });
        reportPath = path.join(reportDir, 'index.html');
        args.push('-e', '-o', reportDir);
      }

      // Also keep -J for any ${__P()} references in the script
      args.push(`-Jthreads=${p.vusers}`, `-Jrampup=${p.rampup}`);
      if (p.iter_mode === 'loops') {
        args.push(`-Jloops=${p.loops}`, '-Jduration=-1');
      } else {
        args.push(`-Jduration=${p.duration}`, '-Jloops=-1');
      }

    } else if (engine === 'k6') {
      const bin = getK6Bin(savedCfg.k6_path);
      if (!bin) throw new Error('k6 binary not found');

      cmd  = bin;
      args = ['run', scriptPath, '--out', `json=${path.join(resultDir, 'results.json')}`];
      args.push('--vus', String(p.vusers));
      if (p.iter_mode === 'loops') {
        args.push('--iterations', String(p.loops));
      } else {
        args.push('--duration', `${p.duration}s`);
      }
      if (p.rampup) args.push('--stage', `${p.rampup}s:${p.vusers}`);
    }

    // Tail jmeter.log while running
    let tailer = null;
    if (jmeterLogPath) {
      let pos = 0;
      tailer = setInterval(async () => {
        if (!fs.existsSync(jmeterLogPath)) return;
        try {
          const size = fs.statSync(jmeterLogPath).size;
          if (size <= pos) return;
          const fd  = fs.openSync(jmeterLogPath, 'r');
          const buf = Buffer.alloc(size - pos);
          fs.readSync(fd, buf, 0, buf.length, pos);
          fs.closeSync(fd);
          pos = size;
          for (const raw of buf.toString('utf8').split('\n')) {
            const line = raw.trim();
            if (!line) continue;
            const clean = line.replace(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d+\s+/, '');
            const up = clean.toUpperCase();
            if (up.startsWith('ERROR') || up.includes(' ERROR '))    addLog('err',  `[jmeter.log] ${clean}`);
            else if (up.startsWith('WARN') || up.includes(' WARN ')) addLog('warn', `[jmeter.log] ${clean}`);
          }
        } catch {}
      }, 300);
    }

    await new Promise((resolve, reject) => {
      const proc = spawn(cmd, args, { shell: true });
      proc.stdout.on('data', c => { for (const l of c.toString().split('\n')) { const t = l.trim(); if (t) addLog('info', t); } });
      proc.stderr.on('data', c => { for (const l of c.toString().split('\n')) { const t = l.trim(); if (t) addLog('info', t); } });
      proc.on('close', code => { if (tailer) clearInterval(tailer); code === 0 ? resolve() : reject(new Error(`Process exited with code ${code}`)); });
      proc.on('error', err  => { if (tailer) clearInterval(tailer); reject(err); });
    });

    // Determine pass/fail via Rule Engine → raw fail count fallback
    let finalStatus = 'completed';
    if (jtlPath && fs.existsSync(jtlPath)) {
      const ruleResult = await evaluateRules(originalRun.project_id, jtlPath);
      if (!ruleResult.noRules) {
        if (ruleResult.passed === false) {
          finalStatus = 'failed';
          const msgs = ruleResult.violations.filter(v => v.rule.severity === 'error').map(v => v.label);
          if (msgs.length) addLog('err', `[Rules] ${msgs.join(' | ')}`);
        }
      } else {
        const lines   = fs.readFileSync(jtlPath, 'utf8').trim().split('\n');
        const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
        const si      = headers.indexOf('success');
        let fc = 0;
        for (let i = 1; i < lines.length; i++) {
          const parts = lines[i].split(',');
          if (si >= 0 && (parts[si] || '').replace(/^"|"$/g, '').trim() !== 'true') fc++;
        }
        if (fc > 0) finalStatus = 'failed';
      }
    }

    await db.prepare(`UPDATE execution_runs SET status=?, logs=?, report_path=?, finished_at=NOW() WHERE id=?`)
      .run(finalStatus, JSON.stringify(allLogs), reportPath, newRunId);

    s3Sync.uploadDir(resultDir, orgSlug).then(r => {
      if (!r.ok && !r.skipped) console.error('[AutoHealer] S3 sync failed for', resultDir, ':', r.failed?.length, 'file(s)');
    });

    return newRunId;

  } catch (e) {
    addLog('err', e.message);
    await db.prepare(`UPDATE execution_runs SET status='failed', logs=?, finished_at=NOW() WHERE id=?`)
      .run(JSON.stringify(allLogs), newRunId);
    return newRunId;
  } finally {
    if (patchedJmx) try { fs.unlinkSync(patchedJmx); } catch {}
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// ── Analysis helpers ──────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

// Extract every ${VAR} reference from the script (skip JMeter built-in functions)
function extractVarRefs(content) {
  const refs = new Set();
  for (const m of content.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_.]*)\}/g)) {
    if (!m[1].startsWith('__')) refs.add(m[1]);
  }
  return [...refs];
}

// Extract every variable that HAS a definition in the script
function extractDefinedVars(content) {
  const d = new Set();
  // User Defined Variables
  for (const m of content.matchAll(/<elementProp name="([A-Za-z_][A-Za-z0-9_]*)" elementType="Argument"/g))
    d.add(m[1]);
  // RegexExtractor
  for (const m of content.matchAll(/<stringProp name="RegexExtractor\.refname">([^<]+)<\/stringProp>/g))
    m[1].split(';').forEach(async v => v.trim() && d.add(v.trim()));
  // JSONPath extractor
  for (const m of content.matchAll(/<stringProp name="JSONPostProcessor\.referenceNames">([^<]+)<\/stringProp>/g))
    m[1].split(';').forEach(async v => v.trim() && d.add(v.trim()));
  // Boundary extractor
  for (const m of content.matchAll(/<stringProp name="BoundaryExtractor\.refname">([^<]+)<\/stringProp>/g))
    d.add(m[1].trim());
  // CSS/HTML extractor
  for (const m of content.matchAll(/<stringProp name="HtmlExtractor\.refname">([^<]+)<\/stringProp>/g))
    d.add(m[1].trim());
  // XPath extractor
  for (const m of content.matchAll(/<stringProp name="XPathExtractor\.refname">([^<]+)<\/stringProp>/g))
    d.add(m[1].trim());
  // CSV DataSet variableNames
  for (const m of content.matchAll(/<stringProp name="variableNames">([^<]+)<\/stringProp>/g))
    m[1].split(',').forEach(async v => v.trim() && d.add(v.trim()));
  return [...d];
}

// Parse JTL comprehensively — group errors by label, code, and failure category
async function parseJtlComprehensive(jtlPath) {
  const empty = {
    byLabel: {}, byCode: {},
    assertionErrors: [], correlationErrors: [],
    variableErrors: [], dnsErrors: [], requestErrors: [],
    totalFail: 0, errorSummaryText: '',
  };
  if (!jtlPath || !fs.existsSync(jtlPath)) return empty;
  return parseJtlComprehensiveFromContent(fs.readFileSync(jtlPath, 'utf8'));
}

/** Same as parseJtlComprehensive, but from already-fetched CSV text (e.g. via resultsStore). */
function parseJtlComprehensiveFromContent(content) {
  const empty = {
    byLabel: {}, byCode: {},
    assertionErrors: [], correlationErrors: [],
    variableErrors: [], dnsErrors: [], requestErrors: [],
    totalFail: 0, errorSummaryText: '',
  };
  if (!content) return empty;
  const lines = content.split('\n');
  if (lines.length < 2) return empty;
  const hdr = (lines[0] || '').split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  const ix = {
    label: hdr.indexOf('label'), success: hdr.indexOf('success'),
    code:  hdr.indexOf('responseCode'), msg: hdr.indexOf('responseMessage'),
    fail:  hdr.indexOf('failureMessage'),
  };

  const out = { ...empty, byLabel: {}, byCode: {} };

  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const p = lines[i].split(',');
    const ok = (p[ix.success] || '').replace(/^"|"$/g, '').trim();
    if (ok === 'true') continue;

    const label   = ix.label >= 0 ? (p[ix.label] || '').replace(/^"|"$/g, '').trim() : '';
    const code    = ix.code  >= 0 ? (p[ix.code]  || '').replace(/^"|"$/g, '').trim() : '';
    const msg     = ix.msg   >= 0 ? (p[ix.msg]   || '').replace(/^"|"$/g, '').trim() : '';
    const failMsg = ix.fail  >= 0 ? (p[ix.fail]  || '').replace(/^"|"$/g, '').trim() : '';
    const combo   = (code + ' ' + msg + ' ' + failMsg).toLowerCase();
    out.totalFail++;

    if (!out.byLabel[label]) out.byLabel[label] = { count: 0, codes: {}, samples: [] };
    out.byLabel[label].count++;
    out.byLabel[label].codes[code] = (out.byLabel[label].codes[code] || 0) + 1;
    if (out.byLabel[label].samples.length < 3) out.byLabel[label].samples.push({ code, msg: msg.slice(0, 120), failMsg: failMsg.slice(0, 200) });
    out.byCode[code] = (out.byCode[code] || 0) + 1;

    const e = { label, code, msg: msg.slice(0, 120), failMsg: failMsg.slice(0, 200) };

    if (!code || code === '0' || combo.includes('connection refused') || combo.includes('unknownhost') ||
        combo.includes('no route to host') || combo.includes('failed to connect') ||
        combo.includes('econnrefused') || combo.includes('connect timed out') ||
        combo.includes('non http response code') || combo.includes('host not found')) {
      out.dnsErrors.push(e);
    } else if (code === '401' || code === '403' || combo.includes('unauthorized') ||
               combo.includes('forbidden') || combo.includes('invalid token') ||
               combo.includes('session expired') || combo.includes('csrf') ||
               combo.includes('access denied') || combo.includes('token expired') ||
               combo.includes('invalid session') || combo.includes('authentication required')) {
      out.correlationErrors.push(e);
    } else if (combo.includes('assertion') || combo.includes('test failed') ||
               combo.includes('expected to contain') || combo.includes('expected to not') ||
               combo.includes('response code: expected') || combo.includes('expected <') ||
               failMsg.toLowerCase().includes('assert')) {
      out.assertionErrors.push(e);
    } else if (combo.includes('${') || combo.includes('null pointer') ||
               (msg.trim() === 'null' || msg.trim() === '') ||
               combo.includes('variable') || combo.includes('undefined variable')) {
      out.variableErrors.push(e);
    } else {
      out.requestErrors.push(e);  // 400, 404, 405, 422, other 4xx
    }
  }

  // Human-readable summary grouped by label
  out.errorSummaryText = Object.entries(out.byLabel)
    .sort((a, b) => b[1].count - a[1].count)
    .map(([lbl, d]) => {
      const codes = Object.entries(d.codes).map(([c, n]) => `${c}×${n}`).join(', ');
      const sample = d.samples[0];
      const detail = sample?.failMsg || sample?.msg || '';
      return `  [${lbl}] ${d.count} failures  codes: ${codes}${detail ? '  → ' + detail.slice(0, 120) : ''}`;
    }).join('\n');

  return out;
}

// Extract hostnames declared in JMX HTTPSampler.domain or UDV URLs
function extractHostnames(scriptContent) {
  const hosts = new Set();
  for (const m of scriptContent.matchAll(/<stringProp name="HTTPSampler\.domain">([^<$\s]+)<\/stringProp>/g))
    if (m[1].trim()) hosts.add(m[1].trim());
  for (const m of scriptContent.matchAll(/<stringProp name="Argument\.value">(https?:\/\/[^<$\s]+)<\/stringProp>/g))
    try { const u = new URL(m[1]); if (u.hostname) hosts.add(u.hostname); } catch {}
  return [...hosts];
}

// DNS-resolve each hostname; returns { host: { ok, addresses|error } }
async function validateEndpoints(hostnames) {
  const results = {};
  await Promise.all(hostnames.map(async host => {
    try {
      const addrs = await dns.resolve(host);
      results[host] = { ok: true, addresses: addrs.slice(0, 3) };
    } catch (e) {
      results[host] = { ok: false, error: e.code || e.message };
    }
  }));
  return results;
}

// ── Build rich diagnostic context (async for DNS checks) ─────────────────────
async function buildContext(run, suite) {
  // jtlPath stays a path-SHAPED naming string (for logging/labels) — the actual JTL
  // content is fetched from S3 via resultsStore, since result_dir is an S3 key prefix now.
  const jtlPath = path.join(run.result_dir, 'results.jtl');
  const orgSlug = await resolveOrgSlugForProject(run.project_id);
  const jtlText = await resultsStore.readText(run.result_dir, orgSlug, 'results.jtl');

  // jmeter.log only ever existed for a native/local execution run — never produced or
  // synced for a CI-triggered run, so this naturally comes back empty for those (same
  // as the old fs.existsSync check would have for a path that was never created).
  const jmeterLog = (await resultsStore.readText(run.result_dir, orgSlug, 'jmeter.log')) || '';

  const scriptPath    = run.engine === 'jmeter' ? suite.jmx_path : suite.js_path;
  const scriptContent = scriptPath && fs.existsSync(scriptPath)
    ? fs.readFileSync(scriptPath, 'utf8') : '';

  // All run log lines (errors + warns + info) for full picture
  const runLogs = (JSON.parse(run.logs || '[]'))
    .map(l => `[${l.type}] ${l.message}`).slice(-80).join('\n');

  // ── JTL analysis ────────────────────────────────────────────────────────────
  const jtl = parseJtlComprehensiveFromContent(jtlText);

  // Label sets
  const allLabels = new Set(), failingLabels = new Set();
  if (jtlText) {
    const lines = jtlText.split('\n');
    const hdr = (lines[0] || '').split(',').map(h => h.trim().replace(/^"|"$/g, ''));
    const si = hdr.indexOf('success'), li = hdr.indexOf('label');
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      const parts = lines[i].split(',');
      const lbl = li >= 0 ? (parts[li] || '').replace(/^"|"$/g, '').trim() : '';
      const ok  = si >= 0 ? (parts[si] || '').replace(/^"|"$/g, '').trim() : 'true';
      if (lbl) allLabels.add(lbl);
      if (ok !== 'true' && lbl) failingLabels.add(lbl);
    }
  }

  // ── Variable analysis ────────────────────────────────────────────────────────
  const varRefs    = extractVarRefs(scriptContent);
  const definedSet = new Set(extractDefinedVars(scriptContent));
  const missingVars = varRefs.filter(v => !definedSet.has(v));

  // ── DNS/endpoint validation (only when connection-type errors detected) ──────
  const hostnames = extractHostnames(scriptContent);
  let endpointStatus = {};
  if (jtl.dnsErrors.length > 0 || hostnames.length > 0) {
    endpointStatus = await validateEndpoints(hostnames);
  }

  // ── Rule + overall hasErrors ──────────────────────────────────────────────
  const ruleResult = await evaluateRulesFromContent(run.project_id, jtlText);
  let hasErrors;
  if (!ruleResult.noRules) {
    hasErrors = ruleResult.passed === false || run.status === 'failed';
  } else {
    hasErrors = run.status === 'failed' || jtl.totalFail > 0
      || jmeterLog.toLowerCase().includes('error')
      || runLogs.toLowerCase().includes('[err]');
  }

  return {
    jmeterLog, scriptContent, scriptPath, runLogs, hasErrors, jtlPath,
    jtl,
    allLabels:    [...allLabels],
    failingLabels: [...failingLabels],
    passingLabels: [...allLabels].filter(l => !failingLabels.has(l)),
    varRefs, missingVars,
    hostnames, endpointStatus,
    ruleViolations: ruleResult.violations || [],
    errorClass: classifyErrorsFromContent(jtlText),
  };
}

// Escape bare control characters (0x00–0x1F) that appear inside JSON string
// literals — the AI sometimes embeds multi-line JMX/XML without escaping newlines.
function sanitizeJsonControlChars(s) {
  const ESC = { '\n': '\\n', '\r': '\\r', '\t': '\\t', '\b': '\\b', '\f': '\\f' };
  let inString = false, escaped = false, out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (escaped)             { out += c; escaped = false; continue; }
    if (c === '\\' && inString) { out += c; escaped = true;  continue; }
    if (c === '"')           { inString = !inString; out += c; continue; }
    if (inString && c.charCodeAt(0) < 0x20) {
      out += ESC[c] || `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`;
      continue;
    }
    out += c;
  }
  return out;
}

// Detects literal Postman-style {{var}} tokens still baked into a generated script.
// Unlike every other failure category this needs no AI diagnosis: JMeter/K6 do not
// support {{var}} syntax at all, so the server receives that literal text instead of a
// real value — guaranteed to fail every request that uses it, with no ambiguity about
// the cause. Fixed deterministically: a variable with a known value in the collection's
// env config is baked in as that real value (same rule testSuites.js's
// resolveTemplateVars applies at generation time); anything unresolved falls back to a
// JMeter ${var} reference so it can still be supplied by a CSV Data Set / User Defined
// Variable instead of being sent to the server as broken literal text.
async function tryFixTemplateVars(suite, ctx) {
  const scriptContent = ctx.scriptContent || '';
  const templateVars = [...new Set([...scriptContent.matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]))];
  if (!templateVars.length) return null;

  let variables = {};
  if (suite.collection_id) {
    try {
      const row = await db.prepare('SELECT config_json FROM collection_env_config WHERE collection_id = ? AND env = ?')
        .get(suite.collection_id, suite.env || 'Default');
      variables = JSON.parse(row?.config_json || '{}')?.variables || {};
    } catch (_) {}
  }

  const fixedScript = resolveForScript(scriptContent, variables);
  const resolved   = templateVars.filter(k => Object.prototype.hasOwnProperty.call(variables, k));
  const unresolved = templateVars.filter(k => !resolved.includes(k));

  return {
    issue: `Script contains ${templateVars.length} literal Postman-style {{var}} token(s) — {{${templateVars.join('}}, {{')}}}}. ` +
      `JMeter/K6 do not support {{var}} syntax; the server was receiving that literal text instead of a real value, which fails every request using it.`,
    fix: [
      resolved.length
        ? `Replaced ${resolved.length} variable(s) (${resolved.join(', ')}) with the real value from the collection's environment config.`
        : null,
      unresolved.length
        ? `Converted ${unresolved.length} variable(s) (${unresolved.join(', ')}) to a JMeter \${var} reference — no matching value was found in the collection's environment config, so add a User Defined Variable or CSV Data Set column for it if requests using it still fail.`
        : null,
    ].filter(Boolean).join(' '),
    fix_type: 'script_rewrite',
    fixed_script: fixedScript,
  };
}

// Detects the single most common, zero-ambiguity cause of ZERO_SAMPLES (JMeter produced no
// requests at all): a ThreadGroup/Sampler/Controller left with enabled="false" — e.g. from a
// manual edit, or a prior heal attempt that disabled an element while isolating a failing
// endpoint and never re-enabled it. Fixed deterministically (a plain attribute flip) rather
// than via AI: this is the case where a full-script AI rewrite is both unnecessary (the fix
// is one attribute) and, for a large script, impossible to even attempt without truncating —
// see the token-budget guard in diagnoseWithAi below.
function tryFixDisabledElements(ctx) {
  if (ctx.allLabels.length > 0) return null; // samples exist — not a disabled-element issue
  const content = ctx.scriptContent || '';
  if (!content) return null;
  const DISABLED_TAGS = ['ThreadGroup', 'HTTPSamplerProxy', 'GenericController', 'TransactionController', 'LoopController'];
  const pattern = new RegExp(`<(${DISABLED_TAGS.join('|')})([^>]*?)\\benabled="false"([^>]*)>`, 'g');
  const matches = [...content.matchAll(pattern)];
  if (!matches.length) return null;

  const fixedScript = content.replace(pattern, (m, tag, pre, post) => `<${tag}${pre}enabled="true"${post}>`);
  const kinds = [...new Set(matches.map(m => m[1]))].join(', ');
  return {
    issue: `${matches.length} element(s) (${kinds}) had enabled="false" — JMeter skips disabled elements entirely, so this test plan executed zero requests.`,
    fix: `Re-enabled ${matches.length} disabled element(s) (enabled="false" → "true") so the test plan actually runs.`,
    fix_type: 'script_rewrite',
    fixed_script: fixedScript,
  };
}

// For JMeter runs backed by a real collection, endpoint-scoped failures (bad body/headers/
// auth — NOT structural issues like ZERO_SAMPLES/DNS) can be fixed with a small per-endpoint
// patch instead of asking the AI to reproduce the entire script. This is the difference
// between success and a guaranteed truncation failure once a script is too large for the
// model's output limit (e.g. a 247KB JMX with 100+ endpoints, ~60K+ tokens on its own).
// The patch is stored in the exact same `endpointOverrides` shape pre-run's "Fix with AI"
// already writes (routes/ai.js), then applied by regenerating the script — testSuites.js's
// deterministic JMX builder already knows how to honor an override, so the actual rewrite
// costs zero extra AI tokens; the AI only ever has to describe the fix, never the file.
async function tryEndpointOverridePatch(userId, run, suite, ctx, cats, customInstruction) {
  if (run.engine !== 'jmeter' || !suite.collection_id) return null;
  // Deliberately excludes CORRELATION_PARAMETERIZATION: that category usually needs a
  // token/session value captured from an earlier response, and this lightweight prompt
  // doesn't carry captured-field context the way the full-rewrite prompt below does — safer
  // to let those fall through to full diagnosis (where there's still headroom) than to
  // have the AI either guess wrong or reliably burn every attempt on "no_fix".
  const ENDPOINT_SCOPED = ['VARIABLE_REFERENCE', 'REQUEST_MALFUNCTION'];
  if (!cats.some(c => ENDPOINT_SCOPED.includes(c))) return null;
  if (!ctx.failingLabels.length) return null;

  const collection = await db.prepare('SELECT * FROM collections WHERE id = ?').get(suite.collection_id);
  let endpoints = [];
  try { endpoints = JSON.parse(collection?.json_content || '[]'); } catch {}
  if (!endpoints.length) return null;

  // Only endpoints we can actually locate by name in the collection. Cap the count — a run
  // with dozens of distinct failing endpoints at once is unusual and more likely a
  // structural problem the full-rewrite path (or a human) should look at instead.
  const targets = ctx.failingLabels
    .map(label => endpoints.find(ep => (ep.name || '') === label))
    .filter(Boolean)
    .slice(0, 8);
  if (!targets.length) return null;

  const envRow = suite.env
    ? await db.prepare('SELECT config_json FROM collection_env_config WHERE collection_id = ? AND env = ?').get(suite.collection_id, suite.env)
    : null;
  let variables = {};
  try { variables = JSON.parse(envRow?.config_json || '{}')?.variables || {}; } catch {}

  // Same captured-token detection pre-run's "Fix with AI" uses (routes/ai.js) — without this,
  // the AI's only visible option for an Authorization/token fix was a static collection
  // variable, which is how a blank leftover env placeholder (e.g. "bearerToken") ended up
  // hard-wired into a header instead of the token actually returned by login.
  const capturedTokens = {};
  try {
    for (const r of JSON.parse(collection?.pre_run_data || '[]')) {
      if (!r) continue;
      for (const [k, v] of Object.entries(extractAllTokens(r.body, r.responseHeaders))) {
        if (!capturedTokens[k]) capturedTokens[k] = v;
      }
    }
  } catch {}

  const endpointBlocks = targets.map(ep => {
    const stat = ctx.jtl.byLabel?.[ep.name];
    const errLines = (stat?.samples || []).slice(0, 3)
      .map(s => `    ${s.code} — ${s.failMsg || s.msg}`).join('\n') || '    (no specific JTL error captured)';
    return [
      `### ${ep.name}`,
      `Method: ${ep.method || 'GET'}`,
      `Current headers: ${JSON.stringify(ep.headers || {}, null, 2)}`,
      `Current body: ${typeof ep.body === 'string' ? ep.body : JSON.stringify(ep.body || {}, null, 2)}`,
      `Errors seen (${stat?.count || 0} total):`,
      errLines,
    ].join('\n');
  }).join('\n\n');

  const systemPrompt =
    `You are an expert JMeter performance test auto-healer. Fix ONLY the specific failing endpoints ` +
    `listed below by proposing corrected headers/body/url for each — do NOT rewrite the whole script, ` +
    `and do NOT reference or reproduce any endpoint not listed.\n\n` +
    `Output ONLY a single valid JSON object, no markdown fences:\n` +
    `{\n` +
    `  "issue": "root cause in 1-3 sentences covering all endpoints listed",\n` +
    `  "fix": "what you changed and why",\n` +
    `  "fix_type": "endpoint_overrides" | "no_fix",\n` +
    `  "overrides": [{ "name": "<exact endpoint name from the list below>", "method": "GET|POST|...", "headers": {}, "body": "", "url": "" }]\n` +
    `}\n` +
    `Rules:\n` +
    `- "name" MUST exactly match one of the endpoint names given below, verbatim.\n` +
    `- In each override, only include "headers"/"body"/"url" for fields you're actually changing — omit the rest.\n` +
    `- A value that should come from another response captured earlier (e.g. a login's access token) MUST use the placeholder {{captured:KEY}}, where KEY is one of the "Captured token fields" listed below — never invent a KEY that is not listed.\n` +
    `- A value that should come from the collection's own configured variables MUST use {{key}}, where key is one of the Collection variables listed below.\n` +
    `- For an Authorization header or any other token/session value, ALWAYS prefer {{captured:KEY}} over a collection variable — a token is normally produced dynamically by a login/auth response, not configured statically. Only fall back to a collection variable if no matching captured field exists.\n` +
    `- If you cannot determine a confident fix from the information given (e.g. it needs a token captured from another endpoint's response, which isn't available here), return fix_type "no_fix" and explain why — do not guess.`;

  const userPrompt = [
    customInstruction ? `=== USER INSTRUCTION (HIGHEST PRIORITY) ===\n${customInstruction}\n` : '',
    `=== Failing Endpoints (fix ONLY these — ${targets.length} of them) ===`,
    endpointBlocks,
    ``,
    `=== Captured token fields available (from this suite's last pre-run) ===`,
    Object.keys(capturedTokens).join(', ') || '(none captured yet)',
    ``,
    `=== Collection variables available ===`,
    // Blank values (e.g. a leftover placeholder from an imported Postman environment) are
    // excluded — listing them just invites the AI to "fix" a 401 by wiring in an empty
    // credential, which is how a static "bearerToken": "" ended up in an Authorization header.
    Object.keys(variables).filter(k => variables[k] !== '' && variables[k] != null).join(', ') || '(none)',
    ``,
    `=== JMeter Log (last 4 KB) ===`,
    (ctx.jmeterLog || '').slice(-4000) || '(empty)',
  ].filter(Boolean).join('\n');

  const raw = await callAi(userId, systemPrompt, userPrompt, 'heal');
  const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/) || raw.match(/(\{[\s\S]*\})/);
  const jsonStr = match ? (match[1] || match[0]) : raw;
  if (!jsonStr.trim().startsWith('{')) return { fix_type: 'no_fix', issue: raw.slice(0, 300), fix: 'Could not parse AI response' };
  try { return JSON.parse(jsonStr.trim()); }
  catch {
    try { return JSON.parse(sanitizeJsonControlChars(jsonStr.trim())); }
    catch (e2) { return { fix_type: 'no_fix', issue: `JSON parse error: ${e2.message}`, fix: '' }; }
  }
}

// Persists AI-proposed per-endpoint overrides into collection_env_config (same shape/table
// pre-run's "Fix with AI" already uses — see routes/ai.js) and regenerates the script via
// testSuites.js's deterministic generator so the override actually takes effect. Returns the
// number of overrides successfully matched to a real endpoint and applied.
async function applyEndpointOverrides(userId, projectId, suite, overrides) {
  if (!suite.collection_id || !overrides?.length) return 0;
  const collection = await db.prepare('SELECT * FROM collections WHERE id = ?').get(suite.collection_id);
  let endpoints = [];
  try { endpoints = JSON.parse(collection?.json_content || '[]'); } catch {}
  if (!endpoints.length) return 0;

  const env = suite.env || 'Default';
  const envRow = await db.prepare('SELECT config_json FROM collection_env_config WHERE collection_id = ? AND env = ?')
    .get(suite.collection_id, env);
  const envCfg = envRow ? JSON.parse(envRow.config_json || '{}') : {};
  const existing = envCfg.endpointOverrides || {};

  let applied = 0;
  for (const o of overrides) {
    const idx = endpoints.findIndex(ep => (ep.name || '') === o.name &&
      (!o.method || (ep.method || 'GET').toUpperCase() === String(o.method).toUpperCase()));
    if (idx === -1) continue; // couldn't confidently match — skip rather than guess wrong
    // Store the endpoint's own method/name verbatim (not upper-cased) — testSuites.js's
    // fingerprintMatches() does an exact-case comparison against the raw endpoint object,
    // the same convention routes/ai.js's "Fix with AI" override already follows.
    existing[idx] = {
      method: endpoints[idx].method || 'GET',
      name: endpoints[idx].name || '',
      ...(o.headers ? { headers: o.headers } : {}),
      ...(o.body !== undefined ? { body: o.body } : {}),
      ...(o.url ? { url: o.url } : {}),
      issue: o.issue || '', fix: o.fix || '',
      updatedAt: new Date().toISOString(),
    };
    applied++;
  }
  if (!applied) return 0;

  envCfg.endpointOverrides = existing;
  if (envRow) {
    await db.prepare('UPDATE collection_env_config SET config_json = ? WHERE collection_id = ? AND env = ?')
      .run(JSON.stringify(envCfg), suite.collection_id, env);
  } else {
    await db.prepare('INSERT INTO collection_env_config (collection_id, env, config_json) VALUES (?, ?, ?)')
      .run(suite.collection_id, env, JSON.stringify(envCfg));
  }

  // Regenerate — deterministic for JMeter, so this costs no extra AI tokens and can't
  // suffer the same truncation failure as asking the AI to output the file itself.
  const { generateScriptForSuite } = require('../routes/testSuites');
  const genResult = await generateScriptForSuite(userId, projectId, suite.id, null);
  if (genResult.error) throw new Error(`Regeneration after endpoint patch failed: ${genResult.error}`);
  return applied;
}

// Applies a set of surgical find/replace edits to a script. Each `find` must match the
// script's current content EXACTLY ONCE — anything ambiguous (0 or 2+ matches) is skipped
// rather than guessed at, since applying a replace against the wrong occurrence (or none)
// would silently corrupt or no-op the fix. Returns which edits actually landed so the caller
// can decide whether the patch as a whole succeeded.
function applyDiffPatch(content, edits) {
  let result = content;
  const applied = [], skipped = [];
  for (const e of edits || []) {
    const find = e?.find;
    if (typeof find !== 'string' || !find) { skipped.push('(missing "find")'); continue; }
    const count = result.split(find).length - 1;
    if (count !== 1) {
      skipped.push(`"${find.slice(0, 60)}${find.length > 60 ? '…' : ''}" matched ${count} time(s) (need exactly 1)`);
      continue;
    }
    result = result.replace(find, e.replace ?? '');
    applied.push(find.slice(0, 60));
  }
  return { result, applied, skipped };
}

// Lightweight structural check — this codebase has no XML parser dependency (patchJmx.js
// does all its own JMX editing via regex too), so this isn't a full validator, just enough
// to catch the failure mode a find/replace patch can introduce that a full-file rewrite
// mostly can't: an edit that leaves a tag unclosed or mismatched (e.g. "replace" text with
// a subtly different tag name than "find" had). Strips comments/CDATA/PIs, then walks every
// remaining tag with a stack requiring strict open/close nesting.
function isWellFormedXmlish(content) {
  const stripped = content
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')
    .replace(/<\?[\s\S]*?\?>/g, '');
  const tagRe = /<(\/?)([A-Za-z_][\w.-]*)\b[^>]*?(\/?)>/g;
  const stack = [];
  let m;
  while ((m = tagRe.exec(stripped))) {
    const [, closing, name, selfClose] = m;
    if (selfClose === '/') continue; // self-closing — no stack effect either way
    if (closing === '/') {
      if (stack.length === 0 || stack[stack.length - 1] !== name) return false;
      stack.pop();
    } else {
      stack.push(name);
    }
  }
  return stack.length === 0;
}

// Same idea for k6 (plain JS) scripts — not a real parser, just a brace/paren balance check
// to catch a patch that dropped or duplicated a closing token.
function hasBalancedBrackets(content) {
  const pairs = { ')': '(', ']': '[', '}': '{' };
  const stack = [];
  for (const ch of content) {
    if (ch === '(' || ch === '[' || ch === '{') stack.push(ch);
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (stack.pop() !== pairs[ch]) return false;
    }
  }
  return stack.length === 0;
}

// The token-efficient middle path between a zero-AI mechanical fix and a full-script
// rewrite: instead of asking the AI to reproduce the whole file (output size = file size,
// the exact thing that guarantees truncation on a large script), ask it for a small list of
// surgical find/replace edits (output size = size of the CHANGE, independent of file size).
// Unlike tryEndpointOverridePatch this isn't restricted to endpoint-scoped categories or
// JMeter-with-a-collection — it's a general repair mechanism for any engine/category, since
// it's just exact-text substitution against the script the AI was already shown. Falls
// through (returns null) whenever the AI can't express the fix this way (e.g. it genuinely
// needs to restructure large portions of the file) so the full-rewrite path remains the
// backstop for those rarer cases.
async function tryDiffPatch(userId, run, suite, ctx, cats, customInstruction) {
  const scriptContent = ctx.scriptContent || '';
  if (!scriptContent) return null;

  const isJmeter = run.engine === 'jmeter';
  const systemPrompt =
    `You are an expert ${isJmeter ? 'JMeter 5.6' : 'k6 v0.50'} performance test auto-healer. Fix the failure described ` +
    `below by proposing a SMALL number of surgical text edits to the script — do NOT reproduce the whole file.\n\n` +
    `Output ONLY a single valid JSON object, no markdown fences:\n` +
    `{\n` +
    `  "issue": "root cause in 1-3 sentences",\n` +
    `  "fix": "what you changed and why",\n` +
    `  "fix_type": "diff_patch" | "no_fix",\n` +
    `  "edits": [{ "find": "<exact text copied verbatim from the script below>", "replace": "<replacement text>" }]\n` +
    `}\n` +
    `Rules:\n` +
    `- Each "find" MUST be an exact, verbatim substring of the script below (identical whitespace/quoting) that appears EXACTLY ONCE — include enough surrounding text (e.g. the full element tag, or a nearby unique attribute) to make it unique. An edit whose "find" doesn't match exactly once will be rejected and discarded.\n` +
    `- Keep each edit minimal — change only what's broken, don't reformat or rewrite unrelated lines.\n` +
    `- Prefer few, larger, unambiguous edits over many tiny fragile ones.\n` +
    `- If the fix genuinely requires restructuring large portions of the file (not expressible as a handful of surgical edits), return fix_type "no_fix" and explain why — do not force it.`;

  const userPrompt = [
    customInstruction ? `=== USER INSTRUCTION (HIGHEST PRIORITY) ===\n${customInstruction}\n` : '',
    `Failure categories detected: ${cats.join(', ')}`,
    ``,
    `=== JTL Error Summary ===`,
    ctx.jtl.errorSummaryText || '(no errors in JTL — see log below)',
    ``,
    `=== Endpoint DNS Status ===`,
    Object.entries(ctx.endpointStatus).map(([h, r]) => `  ${h}: ${r.ok ? 'OK' : 'UNREACHABLE — ' + r.error}`).join('\n') || '  (not checked)',
    ``,
    `=== JMeter/k6 Log (last 8 KB) ===`,
    (ctx.jmeterLog || '').slice(-8000) || '(empty)',
    ``,
    `=== Current Script (copy "find" text from here verbatim) ===`,
    scriptContent,
  ].filter(Boolean).join('\n');

  const raw = await callAi(userId, systemPrompt, userPrompt, 'heal');
  const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/) || raw.match(/(\{[\s\S]*\})/);
  const jsonStr = match ? (match[1] || match[0]) : raw;
  if (!jsonStr.trim().startsWith('{')) return null;

  let parsed;
  try { parsed = JSON.parse(jsonStr.trim()); }
  catch { try { parsed = JSON.parse(sanitizeJsonControlChars(jsonStr.trim())); } catch { return null; } }

  if (parsed.fix_type !== 'diff_patch' || !parsed.edits?.length) return null;

  const { result, applied, skipped } = applyDiffPatch(scriptContent, parsed.edits);
  if (!applied.length) return null; // every edit was ambiguous/missing — nothing actually changed, fall through

  // Same non-negotiable guard as the full-rewrite path: never let a patch silently drop a
  // sampler that was passing before.
  if (ctx.allLabels.length > 0) {
    const missing = ctx.allLabels.filter(lbl => !result.includes(lbl));
    if (missing.length > 0) return null; // let the full-rewrite path handle it instead of risking data loss
  }

  // A patch that leaves the file structurally broken (unclosed tag, unbalanced braces) is
  // worse than no fix at all — it would burn the one heal attempt on a script JMeter/k6
  // can't even parse. Reject and fall through to the full-rewrite path instead, which at
  // least produces the AI's own self-consistent version of the whole file.
  const stillWellFormed = isJmeter ? isWellFormedXmlish(result) : hasBalancedBrackets(result);
  if (!stillWellFormed) return null;

  return {
    issue: parsed.issue || 'Unknown issue',
    fix: (parsed.fix || '') + (skipped.length ? ` (${skipped.length} proposed edit(s) skipped — ambiguous or not found, did not apply.)` : ''),
    fix_type: 'script_rewrite',
    fixed_script: result,
  };
}

// ── AI diagnosis with category-specific guidance ──────────────────────────────
async function diagnoseWithAi(userId, run, suite, ctx, attemptNum, customInstruction = null) {
  // Literal {{var}} tokens are always broken and don't need AI diagnosis — fix them
  // deterministically first. If the run still fails afterward, the {{var}} tokens will
  // be gone by the next attempt and it'll fall through to full AI diagnosis for
  // whatever's left (these were never the only possible cause, just a guaranteed one).
  const mechanicalFix = await tryFixTemplateVars(suite, ctx);
  if (mechanicalFix) return mechanicalFix;

  // Same reasoning as above — a disabled ThreadGroup/sampler is a guaranteed, unambiguous
  // cause of zero samples and needs no AI call to fix (and, on a large script, a full
  // rewrite couldn't even attempt it — see the token-budget guard further below).
  const disabledFix = tryFixDisabledElements(ctx);
  if (disabledFix) return disabledFix;

  const isJmeter    = run.engine === 'jmeter';
  const engineLabel = isJmeter ? 'JMeter 5.6' : 'k6 v0.50';
  const allCount    = ctx.allLabels.length;
  const samplerTag  = isJmeter ? 'HTTPSamplerProxy' : 'http request';
  const jtl         = ctx.jtl;

  // ── Detect active failure categories ────────────────────────────────────────
  const zeroSamples = ctx.allLabels.length === 0;
  const cats = [];
  if (zeroSamples)                                          cats.push('ZERO_SAMPLES');
  if (!zeroSamples && jtl.dnsErrors.length)                cats.push('DNS_HOST_FAILURE');
  if (!zeroSamples && jtl.correlationErrors.length)        cats.push('CORRELATION_PARAMETERIZATION');
  if (!zeroSamples && jtl.assertionErrors.length)          cats.push('ASSERTION_FAILURE');
  if (!zeroSamples && (jtl.variableErrors.length || ctx.missingVars.length)) cats.push('VARIABLE_REFERENCE');
  if (!zeroSamples && jtl.requestErrors.length)            cats.push('REQUEST_MALFUNCTION');
  if (!cats.length)                                         cats.push('UNKNOWN');

  // For endpoint-scoped categories, try a small targeted patch before ever building the
  // (potentially huge) full-script-rewrite prompt below — this is what makes healing work
  // at all on a script too large for the model to reproduce whole. Only returns non-null
  // when it actually found endpoints to target; falls through to full diagnosis otherwise
  // (e.g. no collection, k6 engine, or a structural category like ZERO_SAMPLES/DNS).
  const patchResp = await tryEndpointOverridePatch(userId, run, suite, ctx, cats, customInstruction);
  if (patchResp) return patchResp;

  // Before ever asking the AI to reproduce the whole file, try expressing the fix as a
  // small set of surgical find/replace edits instead — output size scales with the size of
  // the CHANGE, not the file, so this works regardless of how large the script is. Covers
  // every category the endpoint-override patch doesn't (ZERO_SAMPLES, DNS, correlation,
  // assertions, unknown) without ever risking the truncation the full rewrite below can hit.
  let diffResp = null;
  try { diffResp = await tryDiffPatch(userId, run, suite, ctx, cats, customInstruction); }
  catch (e) { console.warn('[Auto Heal] diff-patch attempt failed, falling back:', e.message); }
  if (diffResp) return diffResp;

  // Nothing deterministic, endpoint-scoped, or diff-patchable applied, so the only path left
  // is the full-script rewrite below — which asks the AI to reproduce the ENTIRE script
  // verbatim inside one JSON string field. That output is capped at the provider's hard
  // ceiling (16000 tokens for GPT-4o, 8192 for Claude — a real model limit, not a config knob
  // that can be raised). A script whose own size already approaches that ceiling is
  // mathematically guaranteed to truncate — confirmed live on a 247KB JMX, which truncated
  // identically on every one of 3 attempts across multiple heal sessions, each attempt
  // costing a real AI call for a result already known before sending it. Check that BEFORE
  // calling, not after, so this returns one honest no_fix immediately instead of burning
  // the whole attempt budget on guaranteed-identical failures.
  const maxOutputTokens = await getMaxOutputTokens();
  if (maxOutputTokens) {
    const approxScriptTokens = Math.ceil((ctx.scriptContent || '').length / 3.5); // XML/code averages under 4 chars/token
    const reserveForMetadata = 600; // issue/fix text + JSON wrapper overhead
    if (approxScriptTokens > maxOutputTokens - reserveForMetadata) {
      return {
        fix_type: 'no_fix',
        issue: `This script is ~${Math.round((ctx.scriptContent || '').length / 1024)} KB (~${approxScriptTokens} tokens), too large for a full-script rewrite — every AI provider caps a single response at ${maxOutputTokens} tokens, a hard model limit that no retry can exceed. ` +
          (zeroSamples
            ? `This run produced zero samples/no results at all, which on a script this size usually means the CI job itself failed before JMeter could run (build step, missing dependency, unreachable runner) rather than a fixable script bug — check the raw CI pipeline logs for the actual failure, since auto-heal has no way to inspect those directly.`
            : `Auto-heal can only fix a script this size via small, endpoint-scoped patches (already attempted above for the applicable categories) — a structural fix at this size needs manual review.`),
        fix: '',
        fixed_script: '',
      };
    }
  }

  // ── Category-specific fix instructions ──────────────────────────────────────
  const catGuidance = [];
  if (cats.includes('ZERO_SAMPLES')) {
    catGuidance.push(
      `ZERO SAMPLES — JMeter produced NO requests at all. This means either JMeter didn't start properly or the test plan is structurally broken.\n` +
      `Common root causes (check the pipeline logs and script carefully):\n` +
      `  1. ThreadGroup has enabled="false" — ALL thread groups must have enabled="true"\n` +
      `  2. Thread count or duration is 0 — jmeter_users / jmeter_rampup / jmeter_duration variables may not be substituted\n` +
      `  3. ${isJmeter ? 'HTTPSamplerProxy' : 'http.get/post'} elements disabled — check enabled attributes\n` +
      `  4. Variable reference ${isJmeter ? '${jmeter_users}, ${jmeter_rampup}, ${jmeter_duration}' : 'VU/duration overrides'} missing from test plan\n` +
      `  5. XML/JMX is malformed — TestPlan or ThreadGroup element broken\n` +
      `→ REGENERATE the complete script. Ensure:\n` +
      `  • All ThreadGroup elements: enabled="true", num_threads="\${jmeter_users}", ramp_time="\${jmeter_rampup}", duration="\${jmeter_duration}"\n` +
      `  • TestPlan scheduler enabled where duration is used\n` +
      `  • Every ${isJmeter ? 'HTTPSamplerProxy' : 'request'} element: enabled="true"\n` +
      `  • User Defined Variables element defines defaults for any variable used that may not be passed at runtime`
    );
  }
  if (cats.includes('DNS_HOST_FAILURE')) {
    const dnsLines = Object.entries(ctx.endpointStatus)
      .map(([h, r]) => `  ${h}: ${r.ok ? 'RESOLVES → ' + r.addresses.join(',') : 'UNREACHABLE — ' + r.error}`).join('\n');
    catGuidance.push(
      `DNS/HOST FAILURES detected:\n${dnsLines || '  (could not validate)'}\n` +
      `  → Verify protocol (http vs https), domain, and port in HTTPSampler.\n` +
      `  → If domain is a variable (e.g. \${HOST}), ensure it is defined in User Defined Variables.\n` +
      `  → Do NOT change the endpoint URL to a placeholder — use the domain that DNS resolves successfully.`
    );
  }
  if (cats.includes('CORRELATION_PARAMETERIZATION')) {
    const sample = jtl.correlationErrors.slice(0, 5).map(e => `    [${e.label}] ${e.code} ${e.failMsg || e.msg}`).join('\n');
    catGuidance.push(
      `CORRELATION / TOKEN FAILURES (401/403/session expired/CSRF):\n${sample}\n` +
      `  → Identify which request returns the token/session/CSRF value (usually a login or init call).\n` +
      `  → Add a JSON/Regex Extractor on that response to capture the value into a variable.\n` +
      `  → Pass the extracted variable in subsequent requests as an Authorization header, cookie, or body param.\n` +
      `  → Ensure the extraction sampler runs BEFORE the samplers that use the token.\n` +
      `  → For CSRF: extract from the HTML form or a dedicated token endpoint, add to every state-changing request.`
    );
  }
  if (cats.includes('ASSERTION_FAILURE')) {
    const sample = jtl.assertionErrors.slice(0, 5).map(e => `    [${e.label}] ${e.failMsg || e.msg}`).join('\n');
    catGuidance.push(
      `ASSERTION FAILURES:\n${sample}\n` +
      `  → If the server legitimately returns a different code (e.g. 201 instead of 200), update the assertion.\n` +
      `  → For timing assertions: add a Constant Timer (ConstantTimer) before the sampler or increase timeout.\n` +
      `  → For body/text assertions: widen the pattern or remove over-strict checks that break on valid responses.\n` +
      `  → Do NOT remove all assertions — fix them to match correct expected behavior.`
    );
  }
  if (cats.includes('VARIABLE_REFERENCE')) {
    const missing = ctx.missingVars.length
      ? `  UNDEFINED variables used in script: ${ctx.missingVars.join(', ')}`
      : '  (could not statically determine — check extractor placement)';
    const sample = jtl.variableErrors.slice(0, 5).map(e => `    [${e.label}] ${e.failMsg || e.msg}`).join('\n');
    catGuidance.push(
      `VARIABLE / REFERENCE FAILURES:\n${missing}\n${sample}\n` +
      `  → For each undefined variable: add a User Defined Variable element OR an extractor BEFORE the first sampler that uses it.\n` +
      `  → Ensure CSV DataSet Config variableNames match the actual CSV header columns exactly (case-sensitive).\n` +
      `  → Verify extractor scope — if variable is populated in one thread group, it may not be visible in another.\n` +
      `  → If a response body is null/empty, the extractor produces empty variable — add a default value to the extractor.`
    );
  }
  if (cats.includes('REQUEST_MALFUNCTION')) {
    const sample = jtl.requestErrors.slice(0, 5).map(e => `    [${e.label}] HTTP ${e.code} — ${e.msg}`).join('\n');
    catGuidance.push(
      `REQUEST MALFUNCTION (400/404/405/415/422):\n${sample}\n` +
      `  → 400 Bad Request: fix request body structure (JSON vs form-urlencoded), required fields, data types.\n` +
      `  → 404 Not Found: verify URL path — check trailing slashes, path parameters, URL encoding.\n` +
      `  → 405 Method Not Allowed: change HTTP method (GET/POST/PUT/PATCH/DELETE) to match API spec.\n` +
      `  → 415 Unsupported Media Type: set Content-Type header to match body format (application/json, etc.).\n` +
      `  → 422 Unprocessable: fix request body — check required fields, enum values, format constraints.`
    );
  }

  // ── API inventory ────────────────────────────────────────────────────────────
  const failingList = ctx.failingLabels.length
    ? ctx.failingLabels.map(l => `  - "${l}" (FAILING)`).join('\n')
    : '  (none identified from JTL)';
  const passingList = ctx.passingLabels.length
    ? ctx.passingLabels.map(l => `  - "${l}" (PASSING — do NOT modify)`).join('\n')
    : '  (none)';

  // ── DNS endpoint status ──────────────────────────────────────────────────────
  const endpointLines = Object.entries(ctx.endpointStatus)
    .map(([h, r]) => `  ${h}: ${r.ok ? 'OK (' + r.addresses.join(',') + ')' : 'UNREACHABLE — ' + r.error}`)
    .join('\n') || '  (not checked)';

  // ── System prompt ────────────────────────────────────────────────────────────
  const samplerRule = zeroSamples
    ? `1. REGENERATE the complete ${engineLabel} script from scratch — fix ALL structural issues so JMeter actually executes requests.\n` +
      `   The regenerated script must have all thread groups enabled and all variable references correct.\n`
    : `1. The fixed script MUST contain ALL ${allCount || 'original'} ${samplerTag} elements — zero may be removed.\n` +
      `2. Only modify elements directly responsible for FAILING requests. Preserve PASSING requests byte-for-byte.\n`;

  const systemPrompt =
    `You are an expert ${engineLabel} performance test auto-healer with deep knowledge of:\n` +
    `  • HTTP request construction (methods, headers, body formats, URL encoding)\n` +
    `  • JMeter correlation (Regex/JSON/Boundary extractors, variable scoping, execution order)\n` +
    `  • Authentication flows (Bearer tokens, session cookies, CSRF, OAuth2)\n` +
    `  • JMeter assertions (Response Code, Duration, Text, Size assertions)\n` +
    `  • CSV DataSet configuration and parameterization\n` +
    `  • JMeter timers (Constant Timer, Gaussian, Uniform) and connection settings\n\n` +
    `## ABSOLUTE RULES — never break these:\n` +
    samplerRule +
    (zeroSamples ? '' : `3. Maintain original sampler ORDER — reorder only if a dependency requires it (e.g. extractor before consumer).\n`) +
    (zeroSamples ? '' : `4. When adding extractors, place them as post-processors on the RESPONSE that contains the value.\n`) +
    `${zeroSamples ? '2' : '5'}. Fix the root cause — do not mask failures by removing assertions or catching all errors.\n` +
    `${zeroSamples ? '3' : '6'}. Output ONLY a single valid JSON object — no markdown fences, no explanation outside JSON.\n\n` +
    `JSON schema (all fields required):\n` +
    `{\n` +
    `  "issue":        "root cause in 1-3 sentences — be specific (e.g. all thread groups were disabled)",\n` +
    `  "fix":          "exactly what was changed and why — reference element names and types",\n` +
    `  "fix_type":     "script_rewrite" | "no_fix",\n` +
    `  "fixed_script": "${zeroSamples ? 'complete regenerated script with all thread groups enabled and variable references fixed' : 'complete corrected script — every original sampler present'}"\n` +
    `}`;

  // ── User prompt ───────────────────────────────────────────────────────────────
  const userPrompt = [
    `Engine: ${run.engine.toUpperCase()}   Attempt: ${attemptNum}/${MAX_ATTEMPTS}`,
    `Failure categories detected: ${cats.join(', ')}`,
    ``,
    `=== FAILURE ANALYSIS & FIX GUIDANCE ===`,
    catGuidance.join('\n\n'),
    ``,
    `=== API Inventory (${allCount} total samplers) ===`,
    `FAILING:\n${failingList}`,
    `PASSING:\n${passingList}`,
    ``,
    `=== Endpoint DNS Status ===`,
    endpointLines,
    ``,
    `=== Variable Analysis ===`,
    `Variables referenced in script: ${ctx.varRefs.join(', ') || '(none)'}`,
    `Variables with definitions:     ${[...new Set([...ctx.varRefs].filter(v => !ctx.missingVars.includes(v)))].join(', ') || '(none)'}`,
    `UNDEFINED (no extractor/UDV):   ${ctx.missingVars.join(', ') || '(none — all variables have definitions)'}`,
    ``,
    `=== JTL Error Summary (grouped by API) ===`,
    jtl.errorSummaryText || '(no errors in JTL)',
    ``,
    `=== JMeter Log (last 15 KB) ===`,
    ctx.jmeterLog || '(empty)',
    ``,
    `=== Execution Console Logs ===`,
    ctx.runLogs || '(none)',
    ``,
    `=== Rule Violations ===`,
    ctx.ruleViolations.length
      ? ctx.ruleViolations.map(v => `  ${v.label}`).join('\n')
      : '  (none)',
    ``,
    `=== Current Script (ALL ${allCount} samplers must appear in fixed_script) ===`,
    ctx.scriptContent || '(script file not found)',
  ].join('\n');

  const customPrefix = customInstruction
    ? `=== USER INSTRUCTION (APPLY THIS FIX — HIGHEST PRIORITY) ===\n${customInstruction}\n\nThe above instruction MUST be implemented in the fixed_script. Also address any other issues found below.\n\n`
    : '';

  const raw = await callAi(userId, systemPrompt, customPrefix + userPrompt, 'heal');

  // Extract JSON — handle both plain and markdown-fenced responses
  const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/) || raw.match(/(\{[\s\S]*\})/);
  const jsonStr = match ? (match[1] || match[0]) : raw;
  if (!jsonStr.trim().startsWith('{')) {
    return { fix_type: 'no_fix', issue: raw.slice(0, 300), fix: 'Could not parse AI response', fixed_script: '' };
  }

  let parsed;
  try { parsed = JSON.parse(jsonStr.trim()); }
  catch {
    // AI sometimes embeds the JMX with bare newlines/tabs inside a JSON string value.
    // Sanitize control characters that are inside string literals and retry.
    try {
      const sanitized = sanitizeJsonControlChars(jsonStr.trim());
      parsed = JSON.parse(sanitized);
    } catch (e2) {
      return { fix_type: 'no_fix', issue: `JSON parse error: ${e2.message}`, fix: '', fixed_script: '' };
    }
  }

  // Guard: reject if AI dropped any sampler label
  if (parsed.fix_type === 'script_rewrite' && parsed.fixed_script && ctx.allLabels.length > 0) {
    const missing = ctx.allLabels.filter(lbl => !parsed.fixed_script.includes(lbl));
    if (missing.length > 0) {
      return {
        fix_type: 'no_fix',
        issue: `AI fix dropped ${missing.length} sampler(s): ${missing.join(', ')}. Rejected to preserve all APIs.`,
        fix: '', fixed_script: '',
      };
    }
  }
  // Guard: reject a structurally broken rewrite (unclosed/mismatched tag, unbalanced
  // brackets) — same reasoning as tryDiffPatch's check, applied here too since a full
  // rewrite can make this mistake just as easily as a surgical edit can.
  if (parsed.fix_type === 'script_rewrite' && parsed.fixed_script) {
    const stillWellFormed = isJmeter ? isWellFormedXmlish(parsed.fixed_script) : hasBalancedBrackets(parsed.fixed_script);
    if (!stillWellFormed) {
      return {
        fix_type: 'no_fix',
        issue: `AI's rewritten script is structurally broken (${isJmeter ? 'unclosed/mismatched XML tag' : 'unbalanced brackets'}) — rejected rather than writing a file that would fail to even parse.`,
        fix: '', fixed_script: '',
      };
    }
  }
  return parsed;
}

// ── Core healing cycle ────────────────────────────────────────────────────────
// Two-phase approach:
//   Phase 1 — Quick verify  (3 VUsers × 20s):  fast proof-of-concept the fix compiles and runs
//   Phase 2 — Full run      (original params):  confirm fix holds under real load
async function healCycle(userId, targetRunId, project, suite, attemptNum) {
  if (attemptNum > MAX_ATTEMPTS) {
    await setHealStatus(targetRunId, 'exhausted');
    return;
  }

  await setHealStatus(targetRunId, 'diagnosing');
  const run = await db.prepare('SELECT * FROM execution_runs WHERE id = ?').get(targetRunId);
  const ctx = await buildContext(run, suite);

  // Nothing to fix
  if (!ctx.hasErrors) { await setHealStatus(targetRunId, null); return; }

  // Infrastructure failure — script changes won't help
  if (ctx.errorClass.isInfra) {
    const logId = await logHealAttempt(targetRunId, attemptNum,
      `Infrastructure/server failure: ${ctx.errorClass.summary}. Script changes cannot fix server-side errors.`,
      '', 'no_fix');
    await db.prepare('UPDATE auto_heal_logs SET result=? WHERE id=?').run('infra_error', logId);
    await setHealStatus(targetRunId, 'infra_error');
    return;
  }

  // AI diagnosis
  let aiResp;
  try {
    aiResp = await diagnoseWithAi(userId, run, suite, ctx, attemptNum);
  } catch (e) {
    const logId = await logHealAttempt(targetRunId, attemptNum, `AI error: ${e.message}`, '', 'no_fix');
    await db.prepare('UPDATE auto_heal_logs SET result=? WHERE id=?').run('failed', logId);
    await setHealStatus(targetRunId, 'failed');
    return;
  }

  const logId = await logHealAttempt(targetRunId, attemptNum,
    aiResp.issue   || 'Unknown issue',
    aiResp.fix     || '',
    aiResp.fix_type || 'no_fix'
  );

  const isEndpointPatch = aiResp.fix_type === 'endpoint_overrides' && aiResp.overrides?.length;
  if (aiResp.fix_type !== 'script_rewrite' && !isEndpointPatch) {
    await db.prepare('UPDATE auto_heal_logs SET result=? WHERE id=?').run('no_fix', logId);
    await setHealStatus(targetRunId, 'failed');
    return;
  }
  if (aiResp.fix_type === 'script_rewrite' && !aiResp.fixed_script) {
    await db.prepare('UPDATE auto_heal_logs SET result=? WHERE id=?').run('no_fix', logId);
    await setHealStatus(targetRunId, 'failed');
    return;
  }

  // Apply fix (keep .bak of original)
  await setHealStatus(targetRunId, 'applying_fix');
  try {
    if (isEndpointPatch) {
      if (ctx.scriptPath && fs.existsSync(ctx.scriptPath)) fs.copyFileSync(ctx.scriptPath, ctx.scriptPath + '.bak');
      const applied = await applyEndpointOverrides(userId, run.project_id, suite, aiResp.overrides);
      if (!applied) throw new Error('None of the proposed overrides matched a real endpoint by name.');
    } else if (ctx.scriptPath) {
      if (fs.existsSync(ctx.scriptPath)) fs.copyFileSync(ctx.scriptPath, ctx.scriptPath + '.bak');
      fs.writeFileSync(ctx.scriptPath, aiResp.fixed_script, 'utf8');
      const scriptOrgSlug = await resolveOrgSlugForProject(run.project_id);
      const up = await s3Sync.uploadFile(ctx.scriptPath, scriptOrgSlug);
      if (!up.ok && !up.skipped) console.error('[AutoHealer] S3 sync failed for', ctx.scriptPath, ':', up.error?.message);
    }
  } catch (e) {
    await db.prepare('UPDATE auto_heal_logs SET result=? WHERE id=?').run('failed', logId);
    await setHealStatus(targetRunId, 'failed');
    return;
  }

  // ── Phase 1: Quick verify ─────────────────────────────────────────────────
  await setHealStatus(targetRunId, 'rerunning');
  let quickRunId;
  try { quickRunId = await spawnRun(userId, run, suite, project, 'quick'); }
  catch (e) {
    await db.prepare('UPDATE auto_heal_logs SET result=? WHERE id=?').run('failed', logId);
    await setHealStatus(targetRunId, 'failed');
    return;
  }

  await db.prepare('UPDATE auto_heal_logs SET new_run_id=? WHERE id=?').run(quickRunId, logId);
  await db.prepare('UPDATE execution_runs SET heal_run_id=? WHERE id=?').run(quickRunId, targetRunId);

  const quickRun      = await db.prepare('SELECT * FROM execution_runs WHERE id = ?').get(quickRunId);
  const quickJtlPath  = path.join(quickRun.result_dir, 'results.jtl');
  const quickInfra    = classifyErrors(quickJtlPath);

  // Quick verify hit infra errors — stop immediately
  if (quickInfra.isInfra) {
    await db.prepare('UPDATE auto_heal_logs SET result=? WHERE id=?').run('infra_error', logId);
    await setHealStatus(targetRunId, 'infra_error');
    return;
  }

  const quickRuleCheck  = await evaluateRules(quickRun.project_id, quickJtlPath);
  const quickPassed = quickRun.status === 'completed' &&
    (quickRuleCheck.noRules ? true : quickRuleCheck.passed !== false);

  if (!quickPassed) {
    // Script fix didn't help even under minimal load — try again next attempt
    await db.prepare('UPDATE auto_heal_logs SET result=? WHERE id=?').run('still_failing', logId);
    if (attemptNum < MAX_ATTEMPTS) {
      await healCycle(userId, quickRunId, project, suite, attemptNum + 1);
      const fr = await db.prepare('SELECT heal_status, heal_run_id FROM execution_runs WHERE id = ?').get(quickRunId);
      await setHealStatus(targetRunId, fr?.heal_status || 'failed');
      if (fr?.heal_run_id) await db.prepare('UPDATE execution_runs SET heal_run_id=? WHERE id=?').run(fr.heal_run_id, targetRunId);
    } else {
      await setHealStatus(targetRunId, 'exhausted');
    }
    return;
  }

  // ── Phase 2: Full run with original runtime params ────────────────────────
  await setHealStatus(targetRunId, 'rerunning_full');
  let fullRunId;
  try { fullRunId = await spawnRun(userId, run, suite, project, 'full'); }
  catch (e) {
    // Quick verify passed but full run couldn't start — still count as healed at quick level
    await db.prepare('UPDATE auto_heal_logs SET result=? WHERE id=?').run('healed', logId);
    await setHealStatus(targetRunId, 'healed');
    return;
  }

  await db.prepare('UPDATE execution_runs SET heal_run_id=? WHERE id=?').run(fullRunId, targetRunId);

  const fullRun     = await db.prepare('SELECT * FROM execution_runs WHERE id = ?').get(fullRunId);
  const fullJtlPath = path.join(fullRun.result_dir, 'results.jtl');
  const fullInfra   = classifyErrors(fullJtlPath);

  if (fullInfra.isInfra) {
    // Server can't handle the original load level — infra problem, not script
    await db.prepare('UPDATE auto_heal_logs SET result=? WHERE id=?').run('infra_error', logId);
    await setHealStatus(targetRunId, 'infra_error');
    return;
  }

  const fullRuleCheck = await evaluateRules(fullRun.project_id, fullJtlPath);
  const fullPassed = fullRun.status === 'completed' &&
    (fullRuleCheck.noRules ? true : fullRuleCheck.passed !== false);

  if (fullPassed) {
    await db.prepare('UPDATE auto_heal_logs SET result=? WHERE id=?').run('healed', logId);
    await setHealStatus(targetRunId, 'healed');
  } else {
    // Full run failed — try another healing attempt
    await db.prepare('UPDATE auto_heal_logs SET result=? WHERE id=?').run('still_failing', logId);
    if (attemptNum < MAX_ATTEMPTS) {
      await healCycle(userId, fullRunId, project, suite, attemptNum + 1);
      const fr = await db.prepare('SELECT heal_status, heal_run_id FROM execution_runs WHERE id = ?').get(fullRunId);
      await setHealStatus(targetRunId, fr?.heal_status || 'failed');
      if (fr?.heal_run_id) await db.prepare('UPDATE execution_runs SET heal_run_id=? WHERE id=?').run(fr.heal_run_id, targetRunId);
    } else {
      await setHealStatus(targetRunId, 'exhausted');
    }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────
/**
 * Start the auto-heal cycle.
 * @param {number} userId
 * @param {number} runId
 * @param {Function} [onComplete] — optional callback(finalRunId, succeeded) fired when
 *   the heal cycle fully completes (healed or exhausted/failed). Used by the email
 *   alert system so it can wait for the healer before deciding what to send.
 */
async function startAutoHeal(userId, runId, onComplete) {
  // RETIRED — this is the native/local-execution heal entry point (its only caller,
  // execution.js's POST /run, is itself retired). CI-triggered runs heal via
  // ciPipeline.js's startAutoHealCI/healCycleCI instead, which is unaffected.
  console.warn(`[AutoHealer] startAutoHeal(native) called for run ${runId} but local execution heal has been retired.`);
  if (onComplete) onComplete(runId, false);
  return;
  const run     = await db.prepare('SELECT * FROM execution_runs WHERE id = ?').get(runId);
  const suite   = run && await db.prepare('SELECT * FROM test_suites WHERE id = ?').get(run.suite_id);
  const project = run && await db.prepare('SELECT * FROM projects WHERE id = ?').get(run.project_id);

  if (!run || !suite || !project) {
    console.warn(`[AutoHealer] Cannot heal run ${runId} — missing data`);
    if (onComplete) onComplete(runId, false);
    return;
  }

  await setHealStatus(runId, 'pending');
  setImmediate(async () => {
    try {
      await healCycle(userId, runId, project, suite, 1);
    } catch (e) {
      console.error('[AutoHealer] Unexpected error:', e);
      await setHealStatus(runId, 'failed');
    }
    // Resolve the final run: follow heal_run_id chain to the last run
    if (onComplete) {
      try {
        let finalId = runId;
        let hops = 0;
        while (hops < 10) {
          const r = await db.prepare('SELECT heal_run_id, heal_status FROM execution_runs WHERE id = ?').get(finalId);
          if (!r || !r.heal_run_id) break;
          finalId = r.heal_run_id;
          hops++;
        }
        const finalRun = await db.prepare('SELECT status, heal_status FROM execution_runs WHERE id = ?').get(finalId);
        const succeeded = finalRun?.status === 'completed' || finalRun?.heal_status === 'healed';
        onComplete(finalId, succeeded);
      } catch (e) {
        console.error('[AutoHealer] onComplete error:', e.message);
        onComplete(runId, false);
      }
    }
  });
}

async function getHealStatus(runId) {
  const run = await db.prepare('SELECT heal_status, heal_run_id FROM execution_runs WHERE id = ?').get(runId);
  if (!run) return null;
  const logs = await db.prepare('SELECT * FROM auto_heal_logs WHERE run_id = ? ORDER BY attempt ASC').all(runId);
  return { status: run.heal_status, heal_run_id: run.heal_run_id, logs };
}

module.exports = { startAutoHeal, getHealStatus, buildContext, diagnoseWithAi, classifyErrors, applyEndpointOverrides };
