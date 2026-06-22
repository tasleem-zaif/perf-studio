/**
 * testRunner.js — shared test suite execution utility
 *
 * Used by both the single-run execution route AND the pipeline runner.
 * Handles native JMeter / K6 execution, rule evaluation, and result parsing.
 *
 * @param {object}   opts
 * @param {number}   opts.suiteId     — test_suites.id
 * @param {number}   opts.projectId
 * @param {number}   opts.userId
 * @param {function} opts.logFn       — (type:'info'|'ok'|'warn'|'err', msg) => void
 * @returns {Promise<{passed:boolean, exit_code:number, jtlPath:string|null, error:string|null}>}
 */

const { execSync, spawn } = require('child_process');
const path  = require('path');
const fs    = require('fs');
const os    = require('os');
const db    = require('../db');
const { patchJmxForParams }  = require('./patchJmx');
const { evaluateRules }       = require('./ruleEvaluator');
const { getUserProjectPath, getCollectionPath } = require('./projectFolders');

const PerfStudio_DIR = path.join(process.env.USERPROFILE || process.env.HOME, '.PerfStudio');

// ── Binary detection (mirrors execution.js) ───────────────────────────────────

function getJMeterBin() {
  const candidates = [
    path.join(PerfStudio_DIR, 'jmeter', 'bin', 'jmeter.bat'),
    'C:\\apache-jmeter\\bin\\jmeter.bat',
    'C:\\jmeter\\bin\\jmeter.bat',
    'C:\\Program Files\\Apache\\JMeter\\bin\\jmeter.bat',
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  try {
    const out = execSync('where jmeter 2>&1', { timeout: 5000 }).toString().trim().split('\n')[0].trim();
    if (out && fs.existsSync(out)) return out;
  } catch {}
  try { execSync('jmeter --version 2>&1', { timeout: 5000 }); return 'jmeter'; } catch {}
  return null;
}

function getK6Bin() {
  const candidates = [path.join(PerfStudio_DIR, 'k6', 'k6.exe')];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  try { execSync('k6 version 2>&1', { timeout: 5000 }); return 'k6'; } catch {}
  return null;
}

// ── Main export ───────────────────────────────────────────────────────────────

async function runSuite({ suiteId, projectId, userId, logFn = () => {} }) {
  const log = (type, msg) => logFn(type, msg);

  // ── Resolve suite and project ─────────────────────────────────────────────
  const suite   = db.prepare('SELECT * FROM test_suites WHERE id = ? AND project_id = ?').get(suiteId, projectId);
  if (!suite)   return { passed: false, error: `Test suite not found (id=${suiteId})` };
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  if (!project) return { passed: false, error: 'Project not found' };

  const engine     = suite.engine || 'jmeter';
  const scriptPath = engine === 'jmeter' ? suite.jmx_path : suite.js_path;

  if (!scriptPath || !fs.existsSync(scriptPath)) {
    return { passed: false, error: `Script file not found: ${scriptPath || '(not generated)'}. Go to Test Plans and generate a script first.` };
  }

  // ── Resolve result directory ──────────────────────────────────────────────
  const callerRole  = db.prepare('SELECT role FROM users WHERE id = ?').get(userId)?.role;
  const userProjPath = getUserProjectPath(userId, callerRole, project.name);
  const { buildRunDirName, extractRunNumber } = require('./buildRunName');

  function nextRunNum(dir) {
    try {
      const nums = require('fs').readdirSync(dir, { withFileTypes: true })
        .filter(d => d.isDirectory()).map(d => extractRunNumber(d.name)).filter(n => n > 0);
      return nums.length ? Math.max(...nums) + 1 : 1;
    } catch { return 1; }
  }

  const trVusers   = suite.vusers    || 10;
  const trLoops    = suite.loops     || 1;
  const trDuration = suite.duration  || 300;
  const trIterMode = suite.iter_mode || 'duration';

  let resultDir;
  try {
    if (suite.collection_id && suite.env) {
      const col = db.prepare('SELECT * FROM collections WHERE id = ?').get(suite.collection_id);
      if (col) {
        const envPath = getCollectionPath(userProjPath, col.name, suite.env);
        fs.mkdirSync(path.join(envPath, 'results'), { recursive: true });
        const n = nextRunNum(path.join(envPath, 'results'));
        resultDir = path.join(envPath, 'results', buildRunDirName(suite.name, trVusers, trIterMode, trLoops, trDuration, n));
      }
    }
  } catch (_) {}

  if (!resultDir) {
    fs.mkdirSync(path.join(userProjPath, 'results'), { recursive: true });
    const n = nextRunNum(path.join(userProjPath, 'results'));
    resultDir = path.join(userProjPath, 'results', buildRunDirName(suite.name, trVusers, trIterMode, trLoops, trDuration, n));
  }

  fs.mkdirSync(resultDir, { recursive: true });
  const jtlPath = path.join(resultDir, 'results.jtl');

  // ── JMeter execution ──────────────────────────────────────────────────────
  if (engine === 'jmeter') {
    const jmeterBin = getJMeterBin();
    if (!jmeterBin) return { passed: false, error: 'JMeter not found. Install JMeter or configure Docker execution.' };

    let patchedJmx = scriptPath;
    try {
      patchedJmx = patchJmxForParams(scriptPath, {
        vusers:    suite.vusers    || 10,
        rampup:    suite.rampup   || 30,
        duration:  suite.duration  || 300,
        loops:     suite.loops     || 1,
        iter_mode: suite.iter_mode || 'duration',
      });
    } catch (e) { log('warn', `  Could not patch JMX: ${e.message} — running original`); }

    const logPath = path.join(resultDir, 'jmeter.log');
    const args    = ['-n', '-t', patchedJmx, '-l', jtlPath, '-j', logPath];

    log('info', `  JMeter: ${jmeterBin}`);
    log('info', `  Script: ${patchedJmx}`);
    log('info', `  JTL   : ${jtlPath}`);

    return new Promise(resolve => {
      const proc = spawn(`"${jmeterBin}"`, args, { shell: true });

      function handleOutput(chunk) {
        for (const raw of chunk.toString().split('\n')) {
          const line = raw.trim();
          if (!line) continue;
          const lo = line.toLowerCase();
          const type = lo.includes('error') ? 'err'
            : lo.includes('warn')  ? 'warn'
            : (lo.includes('summary') || lo.includes('end of run')) ? 'ok'
            : 'info';
          log(type, `  ${line}`);
        }
      }

      proc.stdout.on('data', handleOutput);
      proc.stderr.on('data', handleOutput);

      proc.on('close', code => {
        log('info', `  JMeter exited (code ${code})`);
        // Evaluate rules against JTL
        let passed = true;
        try {
          if (fs.existsSync(jtlPath)) {
            const ruleResult = evaluateRules(projectId, jtlPath);
            if (!ruleResult.noRules) {
              passed = ruleResult.passed;
              (ruleResult.violations || []).forEach(v => log('warn', `  ⚠ Rule: ${v.label}`));
              if (passed) log('ok', '  ✔ All rules passed');
              else        log('err', '  ✘ Rule violations detected');
            } else {
              // No rules — use raw fail count
              const lines  = fs.readFileSync(jtlPath, 'utf8').trim().split('\n');
              const hdr    = lines[0].split(',');
              const si     = hdr.indexOf('success');
              let fail = 0;
              for (let i = 1; i < lines.length; i++) {
                const v = lines[i].split(',')[si]?.replace(/^"|"$/g,'').trim();
                if (v === 'false') fail++;
              }
              passed = fail === 0;
            }
          }
        } catch (e) { log('warn', `  Could not evaluate rules: ${e.message}`); }

        resolve({ passed, exit_code: code, jtlPath });
      });

      proc.on('error', err => resolve({ passed: false, error: err.message, jtlPath: null }));
    });
  }

  // ── K6 execution ─────────────────────────────────────────────────────────
  if (engine === 'k6') {
    const k6Bin = getK6Bin();
    if (!k6Bin) return { passed: false, error: 'K6 not found. Install K6 first.' };

    log('info', `  K6: ${k6Bin}`);
    log('info', `  Script: ${scriptPath}`);

    const args = ['run', scriptPath, '--out', `csv=${jtlPath}`];

    return new Promise(resolve => {
      const proc = spawn(`"${k6Bin}"`, args, { shell: true });
      proc.stdout.on('data', c => c.toString().split('\n').forEach(l => l.trim() && log('info', `  ${l.trim()}`)));
      proc.stderr.on('data', c => c.toString().split('\n').forEach(l => l.trim() && log('info', `  ${l.trim()}`)));
      proc.on('close', code => resolve({ passed: code === 0, exit_code: code, jtlPath }));
      proc.on('error', err => resolve({ passed: false, error: err.message, jtlPath: null }));
    });
  }

  return { passed: false, error: `Unknown engine: ${engine}` };
}

module.exports = { runSuite, getJMeterBin, getK6Bin };
