const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const { spawn, execSync } = require('child_process');
const db = require('../db');
const { callAi } = require('./aiClient');
const { getProjectPath } = require('./projectFolders');
const { evaluateRules } = require('./ruleEvaluator');
const { patchJmxForParams } = require('./patchJmx');

const MAX_ATTEMPTS   = 3;
const Peako_DIR = path.join(process.env.USERPROFILE || process.env.HOME, '.Peako');

// Phase-1 quick-verify params — just enough to confirm the script fix is valid.
// Runs in ~20 seconds regardless of original test duration.
const HEAL_VUSERS   = 3;
const HEAL_DURATION = 20;   // seconds
const HEAL_RAMPUP   = 2;    // seconds

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
    path.join(Peako_DIR, 'jmeter', 'bin', 'jmeter.bat'),
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
    path.join(Peako_DIR, 'k6', 'k6.exe'),
  ];
  for (const p of candidates) if (p && fs.existsSync(p)) return p;
  try { execSync('k6 version 2>&1', { timeout: 5000 }); return 'k6'; } catch {}
  return null;
}

// ── DB helpers ────────────────────────────────────────────────────────────────
function setHealStatus(runId, status) {
  db.prepare('UPDATE execution_runs SET heal_status=? WHERE id=?').run(status, runId);
}

function logHealAttempt(runId, attempt, diagnosis, fix, fixType) {
  return db.prepare(
    'INSERT INTO auto_heal_logs (run_id, attempt, diagnosis, fix_applied, fix_type) VALUES (?,?,?,?,?)'
  ).run(runId, attempt, diagnosis, fix, fixType).lastInsertRowid;
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
  const lines   = fs.readFileSync(jtlPath, 'utf8').split('\n');
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
// mode = 'quick'  → HEAL_VUSERS / HEAL_DURATION (no report generation)
// mode = 'full'   → exact runtime params from the original failed run
async function spawnRun(userId, originalRun, suite, project, mode) {
  const cfgRow   = db.prepare('SELECT config_json FROM global_config WHERE user_id = ?').get(userId);
  const savedCfg = cfgRow ? JSON.parse(cfgRow.config_json || '{}') : {};

  const engine     = originalRun.engine;
  const scriptPath = engine === 'jmeter' ? suite.jmx_path : suite.js_path;
  if (!scriptPath || !fs.existsSync(scriptPath)) {
    throw new Error(`Script file not found: ${scriptPath || '(not set)'}`);
  }

  const projectFolder = project.folder_path || getProjectPath(project.name, project.id);
  const runCount      = db.prepare('SELECT COUNT(*) as n FROM execution_runs WHERE project_id = ?').get(originalRun.project_id).n;
  const runNumber     = runCount + 1;
  const resultDir     = path.join(projectFolder, 'results', `Run_${runNumber}`);
  fs.mkdirSync(resultDir, { recursive: true });

  const allLogs = [];
  const addLog  = (type, message) => allLogs.push({ type, message });

  const modeLabel = mode === 'quick'
    ? `Quick-verify: ${HEAL_VUSERS} VUsers × ${HEAL_DURATION}s`
    : `Full run with original params`;

  addLog('info', `[Auto Healer] Run #${runNumber} — ${modeLabel}`);

  // Resolve params based on mode
  const orig = resolveRunParams(originalRun, suite);
  const p = mode === 'quick'
    ? { vusers: HEAL_VUSERS, rampup: HEAL_RAMPUP, iter_mode: 'duration', duration: HEAL_DURATION, loops: 1 }
    : orig;

  const newRunId = db.prepare(`
    INSERT INTO execution_runs
      (project_id, suite_id, engine, status, result_dir, logs, started_at, auto_heal,
       run_vusers, run_rampup, run_duration, run_loops, run_iter_mode)
    VALUES (?, ?, ?, 'running', ?, '[]', datetime('now'), 1, ?, ?, ?, ?, ?)
  `).run(
    originalRun.project_id, originalRun.suite_id, engine, resultDir,
    p.vusers, p.rampup, p.duration, p.loops, p.iter_mode
  ).lastInsertRowid;

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
      tailer = setInterval(() => {
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
      const ruleResult = evaluateRules(originalRun.project_id, jtlPath);
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

    db.prepare(`UPDATE execution_runs SET status=?, logs=?, report_path=?, finished_at=datetime('now') WHERE id=?`)
      .run(finalStatus, JSON.stringify(allLogs), reportPath, newRunId);
    return newRunId;

  } catch (e) {
    addLog('err', e.message);
    db.prepare(`UPDATE execution_runs SET status='failed', logs=?, finished_at=datetime('now') WHERE id=?`)
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
    m[1].split(';').forEach(v => v.trim() && d.add(v.trim()));
  // JSONPath extractor
  for (const m of content.matchAll(/<stringProp name="JSONPostProcessor\.referenceNames">([^<]+)<\/stringProp>/g))
    m[1].split(';').forEach(v => v.trim() && d.add(v.trim()));
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
    m[1].split(',').forEach(v => v.trim() && d.add(v.trim()));
  return [...d];
}

// Parse JTL comprehensively — group errors by label, code, and failure category
function parseJtlComprehensive(jtlPath) {
  const empty = {
    byLabel: {}, byCode: {},
    assertionErrors: [], correlationErrors: [],
    variableErrors: [], dnsErrors: [], requestErrors: [],
    totalFail: 0, errorSummaryText: '',
  };
  if (!jtlPath || !fs.existsSync(jtlPath)) return empty;

  const lines = fs.readFileSync(jtlPath, 'utf8').split('\n');
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
  const logPath = path.join(run.result_dir, 'jmeter.log');
  const jtlPath = path.join(run.result_dir, 'results.jtl');

  // Full jmeter.log (last 15 KB — large enough to catch all lifecycle events)
  const jmeterLog = fs.existsSync(logPath)
    ? fs.readFileSync(logPath, 'utf8').slice(-15000)
    : '';

  const scriptPath    = run.engine === 'jmeter' ? suite.jmx_path : suite.js_path;
  const scriptContent = scriptPath && fs.existsSync(scriptPath)
    ? fs.readFileSync(scriptPath, 'utf8') : '';

  // All run log lines (errors + warns + info) for full picture
  const runLogs = (JSON.parse(run.logs || '[]'))
    .map(l => `[${l.type}] ${l.message}`).slice(-80).join('\n');

  // ── JTL analysis ────────────────────────────────────────────────────────────
  const jtl = parseJtlComprehensive(jtlPath);

  // Label sets
  const allLabels = new Set(), failingLabels = new Set();
  if (fs.existsSync(jtlPath)) {
    const lines = fs.readFileSync(jtlPath, 'utf8').split('\n');
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
  const ruleResult = evaluateRules(run.project_id, jtlPath);
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
    errorClass: classifyErrors(jtlPath),
  };
}

// ── AI diagnosis with category-specific guidance ──────────────────────────────
async function diagnoseWithAi(userId, run, suite, ctx, attemptNum) {
  const isJmeter    = run.engine === 'jmeter';
  const engineLabel = isJmeter ? 'JMeter 5.6' : 'k6 v0.50';
  const allCount    = ctx.allLabels.length;
  const samplerTag  = isJmeter ? 'HTTPSamplerProxy' : 'http request';
  const jtl         = ctx.jtl;

  // ── Detect active failure categories ────────────────────────────────────────
  const cats = [];
  if (jtl.dnsErrors.length)         cats.push('DNS_HOST_FAILURE');
  if (jtl.correlationErrors.length) cats.push('CORRELATION_PARAMETERIZATION');
  if (jtl.assertionErrors.length)   cats.push('ASSERTION_FAILURE');
  if (jtl.variableErrors.length || ctx.missingVars.length) cats.push('VARIABLE_REFERENCE');
  if (jtl.requestErrors.length)     cats.push('REQUEST_MALFUNCTION');
  if (!cats.length)                 cats.push('UNKNOWN');

  // ── Category-specific fix instructions ──────────────────────────────────────
  const catGuidance = [];
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
  const systemPrompt =
    `You are an expert ${engineLabel} performance test auto-healer with deep knowledge of:\n` +
    `  • HTTP request construction (methods, headers, body formats, URL encoding)\n` +
    `  • JMeter correlation (Regex/JSON/Boundary extractors, variable scoping, execution order)\n` +
    `  • Authentication flows (Bearer tokens, session cookies, CSRF, OAuth2)\n` +
    `  • JMeter assertions (Response Code, Duration, Text, Size assertions)\n` +
    `  • CSV DataSet configuration and parameterization\n` +
    `  • JMeter timers (Constant Timer, Gaussian, Uniform) and connection settings\n\n` +
    `## ABSOLUTE RULES — never break these:\n` +
    `1. The fixed script MUST contain ALL ${allCount || 'original'} ${samplerTag} elements — zero may be removed.\n` +
    `2. Only modify elements directly responsible for FAILING requests. Preserve PASSING requests byte-for-byte.\n` +
    `3. Maintain original sampler ORDER — reorder only if a dependency requires it (e.g. extractor before consumer).\n` +
    `4. When adding extractors, place them as post-processors on the RESPONSE that contains the value.\n` +
    `5. Fix the root cause — do not mask failures by removing assertions or catching all errors.\n` +
    `6. Output ONLY a single valid JSON object — no markdown fences, no explanation outside JSON.\n\n` +
    `JSON schema (all fields required):\n` +
    `{\n` +
    `  "issue":        "root cause in 1-3 sentences — be specific (e.g. login response token not extracted)",\n` +
    `  "fix":          "exactly what was changed and why — reference sampler names and element types",\n` +
    `  "fix_type":     "script_rewrite" | "no_fix",\n` +
    `  "fixed_script": "complete corrected script — every original sampler present"\n` +
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

  const raw = await callAi(userId, systemPrompt, userPrompt, 'heal');

  // Extract JSON — handle both plain and markdown-fenced responses
  const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/) || raw.match(/(\{[\s\S]*\})/);
  const jsonStr = match ? (match[1] || match[0]) : raw;
  if (!jsonStr.trim().startsWith('{')) {
    return { fix_type: 'no_fix', issue: raw.slice(0, 300), fix: 'Could not parse AI response', fixed_script: '' };
  }

  let parsed;
  try { parsed = JSON.parse(jsonStr.trim()); }
  catch (e) { return { fix_type: 'no_fix', issue: `JSON parse error: ${e.message}`, fix: '', fixed_script: '' }; }

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
  return parsed;
}

// ── Core healing cycle ────────────────────────────────────────────────────────
// Two-phase approach:
//   Phase 1 — Quick verify  (3 VUsers × 20s):  fast proof-of-concept the fix compiles and runs
//   Phase 2 — Full run      (original params):  confirm fix holds under real load
async function healCycle(userId, targetRunId, project, suite, attemptNum) {
  if (attemptNum > MAX_ATTEMPTS) {
    setHealStatus(targetRunId, 'exhausted');
    return;
  }

  setHealStatus(targetRunId, 'diagnosing');
  const run = db.prepare('SELECT * FROM execution_runs WHERE id = ?').get(targetRunId);
  const ctx = await buildContext(run, suite);

  // Nothing to fix
  if (!ctx.hasErrors) { setHealStatus(targetRunId, null); return; }

  // Infrastructure failure — script changes won't help
  if (ctx.errorClass.isInfra) {
    const logId = logHealAttempt(targetRunId, attemptNum,
      `Infrastructure/server failure: ${ctx.errorClass.summary}. Script changes cannot fix server-side errors.`,
      '', 'no_fix');
    db.prepare('UPDATE auto_heal_logs SET result=? WHERE id=?').run('infra_error', logId);
    setHealStatus(targetRunId, 'infra_error');
    return;
  }

  // AI diagnosis
  let aiResp;
  try {
    aiResp = await diagnoseWithAi(userId, run, suite, ctx, attemptNum);
  } catch (e) {
    const logId = logHealAttempt(targetRunId, attemptNum, `AI error: ${e.message}`, '', 'no_fix');
    db.prepare('UPDATE auto_heal_logs SET result=? WHERE id=?').run('failed', logId);
    setHealStatus(targetRunId, 'failed');
    return;
  }

  const logId = logHealAttempt(targetRunId, attemptNum,
    aiResp.issue   || 'Unknown issue',
    aiResp.fix     || '',
    aiResp.fix_type || 'no_fix'
  );

  if (aiResp.fix_type !== 'script_rewrite' || !aiResp.fixed_script) {
    db.prepare('UPDATE auto_heal_logs SET result=? WHERE id=?').run('no_fix', logId);
    setHealStatus(targetRunId, 'failed');
    return;
  }

  // Apply fix (keep .bak of original)
  setHealStatus(targetRunId, 'applying_fix');
  try {
    if (ctx.scriptPath) {
      if (fs.existsSync(ctx.scriptPath)) fs.copyFileSync(ctx.scriptPath, ctx.scriptPath + '.bak');
      fs.writeFileSync(ctx.scriptPath, aiResp.fixed_script, 'utf8');
    }
  } catch (e) {
    db.prepare('UPDATE auto_heal_logs SET result=? WHERE id=?').run('failed', logId);
    setHealStatus(targetRunId, 'failed');
    return;
  }

  // ── Phase 1: Quick verify ─────────────────────────────────────────────────
  setHealStatus(targetRunId, 'rerunning');
  let quickRunId;
  try { quickRunId = await spawnRun(userId, run, suite, project, 'quick'); }
  catch (e) {
    db.prepare('UPDATE auto_heal_logs SET result=? WHERE id=?').run('failed', logId);
    setHealStatus(targetRunId, 'failed');
    return;
  }

  db.prepare('UPDATE auto_heal_logs SET new_run_id=? WHERE id=?').run(quickRunId, logId);
  db.prepare('UPDATE execution_runs SET heal_run_id=? WHERE id=?').run(quickRunId, targetRunId);

  const quickRun      = db.prepare('SELECT * FROM execution_runs WHERE id = ?').get(quickRunId);
  const quickJtlPath  = path.join(quickRun.result_dir, 'results.jtl');
  const quickInfra    = classifyErrors(quickJtlPath);

  // Quick verify hit infra errors — stop immediately
  if (quickInfra.isInfra) {
    db.prepare('UPDATE auto_heal_logs SET result=? WHERE id=?').run('infra_error', logId);
    setHealStatus(targetRunId, 'infra_error');
    return;
  }

  const quickRuleCheck  = evaluateRules(quickRun.project_id, quickJtlPath);
  const quickPassed = quickRun.status === 'completed' &&
    (quickRuleCheck.noRules ? true : quickRuleCheck.passed !== false);

  if (!quickPassed) {
    // Script fix didn't help even under minimal load — try again next attempt
    db.prepare('UPDATE auto_heal_logs SET result=? WHERE id=?').run('still_failing', logId);
    if (attemptNum < MAX_ATTEMPTS) {
      await healCycle(userId, quickRunId, project, suite, attemptNum + 1);
      const fr = db.prepare('SELECT heal_status, heal_run_id FROM execution_runs WHERE id = ?').get(quickRunId);
      setHealStatus(targetRunId, fr?.heal_status || 'failed');
      if (fr?.heal_run_id) db.prepare('UPDATE execution_runs SET heal_run_id=? WHERE id=?').run(fr.heal_run_id, targetRunId);
    } else {
      setHealStatus(targetRunId, 'exhausted');
    }
    return;
  }

  // ── Phase 2: Full run with original runtime params ────────────────────────
  setHealStatus(targetRunId, 'rerunning_full');
  let fullRunId;
  try { fullRunId = await spawnRun(userId, run, suite, project, 'full'); }
  catch (e) {
    // Quick verify passed but full run couldn't start — still count as healed at quick level
    db.prepare('UPDATE auto_heal_logs SET result=? WHERE id=?').run('healed', logId);
    setHealStatus(targetRunId, 'healed');
    return;
  }

  db.prepare('UPDATE execution_runs SET heal_run_id=? WHERE id=?').run(fullRunId, targetRunId);

  const fullRun     = db.prepare('SELECT * FROM execution_runs WHERE id = ?').get(fullRunId);
  const fullJtlPath = path.join(fullRun.result_dir, 'results.jtl');
  const fullInfra   = classifyErrors(fullJtlPath);

  if (fullInfra.isInfra) {
    // Server can't handle the original load level — infra problem, not script
    db.prepare('UPDATE auto_heal_logs SET result=? WHERE id=?').run('infra_error', logId);
    setHealStatus(targetRunId, 'infra_error');
    return;
  }

  const fullRuleCheck = evaluateRules(fullRun.project_id, fullJtlPath);
  const fullPassed = fullRun.status === 'completed' &&
    (fullRuleCheck.noRules ? true : fullRuleCheck.passed !== false);

  if (fullPassed) {
    db.prepare('UPDATE auto_heal_logs SET result=? WHERE id=?').run('healed', logId);
    setHealStatus(targetRunId, 'healed');
  } else {
    // Full run failed — try another healing attempt
    db.prepare('UPDATE auto_heal_logs SET result=? WHERE id=?').run('still_failing', logId);
    if (attemptNum < MAX_ATTEMPTS) {
      await healCycle(userId, fullRunId, project, suite, attemptNum + 1);
      const fr = db.prepare('SELECT heal_status, heal_run_id FROM execution_runs WHERE id = ?').get(fullRunId);
      setHealStatus(targetRunId, fr?.heal_status || 'failed');
      if (fr?.heal_run_id) db.prepare('UPDATE execution_runs SET heal_run_id=? WHERE id=?').run(fr.heal_run_id, targetRunId);
    } else {
      setHealStatus(targetRunId, 'exhausted');
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
function startAutoHeal(userId, runId, onComplete) {
  const run     = db.prepare('SELECT * FROM execution_runs WHERE id = ?').get(runId);
  const suite   = run && db.prepare('SELECT * FROM test_suites WHERE id = ?').get(run.suite_id);
  const project = run && db.prepare('SELECT * FROM projects WHERE id = ?').get(run.project_id);

  if (!run || !suite || !project) {
    console.warn(`[AutoHealer] Cannot heal run ${runId} — missing data`);
    if (onComplete) onComplete(runId, false);
    return;
  }

  setHealStatus(runId, 'pending');
  setImmediate(async () => {
    try {
      await healCycle(userId, runId, project, suite, 1);
    } catch (e) {
      console.error('[AutoHealer] Unexpected error:', e);
      setHealStatus(runId, 'failed');
    }
    // Resolve the final run: follow heal_run_id chain to the last run
    if (onComplete) {
      try {
        let finalId = runId;
        let hops = 0;
        while (hops < 10) {
          const r = db.prepare('SELECT heal_run_id, heal_status FROM execution_runs WHERE id = ?').get(finalId);
          if (!r || !r.heal_run_id) break;
          finalId = r.heal_run_id;
          hops++;
        }
        const finalRun = db.prepare('SELECT status, heal_status FROM execution_runs WHERE id = ?').get(finalId);
        const succeeded = finalRun?.status === 'completed' || finalRun?.heal_status === 'healed';
        onComplete(finalId, succeeded);
      } catch (e) {
        console.error('[AutoHealer] onComplete error:', e.message);
        onComplete(runId, false);
      }
    }
  });
}

function getHealStatus(runId) {
  const run = db.prepare('SELECT heal_status, heal_run_id FROM execution_runs WHERE id = ?').get(runId);
  if (!run) return null;
  const logs = db.prepare('SELECT * FROM auto_heal_logs WHERE run_id = ? ORDER BY attempt ASC').all(runId);
  return { status: run.heal_status, heal_run_id: run.heal_run_id, logs };
}

module.exports = { startAutoHeal, getHealStatus };
