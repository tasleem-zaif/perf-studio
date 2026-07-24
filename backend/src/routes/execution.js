const express = require('express');
const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const dns = require('dns');
const https = require('https');
const http = require('http');
const { ZipArchive } = require('archiver');
const router = express.Router();

const auth = require('../middleware/auth');
const db = require('../db');
const ownsProject = require('../utils/ownsProject');
const { getProjectPath, PROJECTS_ROOT, resolveSuiteEnv, resolveOrgSlugForProject } = require('../utils/projectFolders');
const { generateAnalyticsPdf } = require('../utils/generateAnalyticsPdf');
const { startAutoHeal, getHealStatus } = require('../utils/autoHealer');
const { evaluateRules } = require('../utils/ruleEvaluator');
const { patchJmxForParams } = require('../utils/patchJmx');
const { parseJtl, parseJtlContent } = require('../utils/parseJtl');
const s3Sync = require('../utils/s3Sync');
const resultsStore = require('../utils/resultsStore');

const PerfStudio_DIR = path.join(process.env.USERPROFILE || process.env.HOME, '.PerfStudio');

// Converts a container-internal path to the equivalent HOST-machine path for
// Docker -v volume mount arguments. When the backend runs inside Docker Compose,
// PROJECTS_ROOT is the container path (/data/projects) but Docker socket mounts
// must reference the actual host path. Set HOST_PROJECTS_ROOT in .env to enable.
function toHostPath(p) {
  const containerRoot = (process.env.PROJECTS_ROOT || '').replace(/\\/g, '/');
  const hostRoot = (process.env.HOST_PROJECTS_ROOT || containerRoot).replace(/\\/g, '/');
  return p.replace(/\\/g, '/').replace(containerRoot, hostRoot);
}

function getJMeterBin(customPath) {
  // If user gave a directory (e.g. C:\jmeter\bin), resolve to jmeter.bat inside it
  const resolveJmeterPath = p => {
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
    ...(customPath ? [resolveJmeterPath(customPath)] : []),
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
  try {
    execSync('jmeter --version 2>&1', { timeout: 5000 });
    return 'jmeter';
  } catch {
    return null;
  }
}

function getK6Bin(customPath) {
  const candidates = [
    ...(customPath ? [customPath] : []),
    path.join(PerfStudio_DIR, 'k6', 'k6.exe'),
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  try {
    execSync('k6 version 2>&1', { timeout: 5000 });
    return 'k6';
  } catch {
    return null;
  }
}

// Formerly deleted any non-running execution_runs row whose result_dir no longer existed
// ON REAL DISK — a real guard back when a result folder could be removed out from under the
// DB by something outside the app (a manual disk cleanup, an OS-level delete). Since the
// S3-backed, zero-local-disk migration (resultsStore.js), result_dir is a path-SHAPED S3 key
// prefix that is NEVER a real directory — fs.existsSync(run.result_dir) is unconditionally
// false for every row, so this used to silently wipe EVERY completed/failed run for the
// project on every single `/runs` fetch (Analytics loading, or right after a CI sync just
// inserted one) — the reason a freshly CI-synced run's data vanished from Analytics almost
// immediately, and any run created moments earlier during renumbering (getNextRunNumber())
// too. S3 objects don't silently disappear out from under the DB the way a local folder
// could, so there's no longer a real drift case for this to guard — safe to no-op.
async function cleanStaleRuns(_projectId) {}

async function getNextRunNumber(projectId) {
  cleanStaleRuns(projectId);
  const { extractRunNumber } = require('../utils/buildRunName');
  const rows = await db.prepare('SELECT result_dir FROM execution_runs WHERE project_id = ?').all(projectId);
  let maxNum = 0;
  for (const r of rows) {
    const n = extractRunNumber(r.result_dir);
    if (n > maxNum) maxNum = n;
  }
  return maxNum + 1;
}

const MAX_CONCURRENT_RUNS = 5; // soft cap per user

async function countActiveRuns(userId) {
  const row = await db.prepare(`
    SELECT COUNT(*) as n FROM execution_runs r
    JOIN projects p ON p.id = r.project_id
    WHERE p.user_id = ? AND r.status = 'running'
  `).get(userId);
  return row?.n || 0;
}

// Check whether we're running in native mode (JMeter/K6 in PATH) or Docker mode
function isNativeMode() {
  return process.env.EXECUTION_MODE === 'native' || !!getJMeterBin(null) || !!getK6Bin(null);
}

router.get('/check-deps', auth, async (req, res) => {
  // RETIRED — local/native test execution is no longer supported; CI-pipeline execution only.
  return res.status(410).json({ error: 'Local test execution has been retired. Run tests via the CI pipeline instead.' });
  const native = isNativeMode();
  const deps = [];

  if (native) {
    // ── Native mode: check JMeter + K6 binaries directly ──────────────────
    const jmeterBin = getJMeterBin(null);
    let jmeterVersion = null;
    if (jmeterBin) {
      try { jmeterVersion = execSync(`"${jmeterBin}" --version 2>&1`, { timeout: 8000 }).toString().split('\n')[0].trim(); } catch {}
    }
    deps.push({ name: 'jmeter', status: jmeterBin ? 'ok' : 'missing', version: jmeterVersion || (jmeterBin ? 'installed' : null), path: jmeterBin });

    const k6Bin = getK6Bin(null);
    let k6Version = null;
    if (k6Bin) {
      try { k6Version = execSync(`"${k6Bin}" version 2>&1`, { timeout: 5000 }).toString().trim(); } catch {}
    }
    deps.push({ name: 'k6', status: k6Bin ? 'ok' : 'missing', version: k6Version || (k6Bin ? 'installed' : null), path: k6Bin });

    let javaVersion = null;
    try { javaVersion = execSync('java -version 2>&1', { timeout: 5000 }).toString().split('\n')[0].trim(); } catch {}
    deps.push({ name: 'java', status: javaVersion ? 'ok' : 'missing', version: javaVersion });

  } else {
    // ── Docker mode: check Docker daemon ──────────────────────────────────
    let dockerStatus = 'missing';
    let dockerVersion = null;
    try {
      execSync('docker info 2>&1', { timeout: 8000 });
      dockerVersion = execSync('docker --version 2>&1', { timeout: 3000 }).toString().trim();
      dockerStatus = 'ok';
    } catch (_) {
      try { dockerVersion = execSync('docker --version 2>&1', { timeout: 3000 }).toString().trim() + ' (daemon not running)'; } catch {}
    }
    deps.push({ name: 'docker', status: dockerStatus, version: dockerVersion });
  }

  res.json({ deps, mode: native ? 'native' : 'docker' });
});

// Standalone Docker check — used by the Configuration page
router.get('/check-docker', auth, async (req, res) => {
  // RETIRED — local/native test execution is no longer supported; CI-pipeline execution only.
  return res.status(410).json({ error: 'Local test execution has been retired. Run tests via the CI pipeline instead.' });
  let status = 'missing', version = null;
  try {
    version = execSync('docker --version 2>&1', { timeout: 5000 }).toString().trim();
    // Docker is installed — now check if daemon is running
    try {
      execSync('docker info', { timeout: 8000, stdio: 'pipe' });
      status = 'ok'; // installed + running
    } catch (_) {
      status = 'installed'; // installed but daemon not running
    }
  } catch (_) {
    status = 'missing'; // not installed at all
  }
  res.json({ status, version });
});

// Start Docker Desktop — fires the launch command and returns immediately.
// The frontend polls /system-check every 5s to detect when the daemon is ready.
router.post('/start-docker', auth, async (req, res) => {
  // RETIRED — local/native test execution is no longer supported; CI-pipeline execution only.
  return res.status(410).json({ error: 'Local test execution has been retired. Run tests via the CI pipeline instead.' });
  const platform = process.platform;
  try {
    if (platform === 'win32') {
      // Try the default install path first; fall back to searching Program Files
      const defaultPath = 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe';
      const altPath     = 'C:\\Program Files (x86)\\Docker\\Docker\\Docker Desktop.exe';
      const exePath     = require('fs').existsSync(defaultPath) ? defaultPath
                        : require('fs').existsSync(altPath)     ? altPath
                        : defaultPath; // still try default — error will be caught
      const escapedPath = exePath.replace(/'/g, "''");
      require('child_process').exec(
        `powershell -Command "Start-Process '${escapedPath}' -ErrorAction SilentlyContinue"`,
        { timeout: 8000 },
        () => {} // fire-and-forget
      );
    } else if (platform === 'darwin') {
      require('child_process').exec('open -a Docker', () => {});
    } else {
      require('child_process').exec('sudo systemctl start docker || sudo service docker start', () => {});
    }
    res.json({ ok: true, message: 'Docker Desktop launch command sent. Waiting for daemon…' });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// Enable Hyper-V, WSL2 and VirtualMachinePlatform via elevated dism commands (Windows only).
// Writes a temp PS1 script and launches it in an elevated PowerShell window (UAC prompt).
// A system restart is required after the features are enabled.
router.post('/enable-virtualization', auth, async (req, res) => {
  // RETIRED — local/native test execution is no longer supported; CI-pipeline execution only.
  return res.status(410).json({ error: 'Local test execution has been retired. Run tests via the CI pipeline instead.' });
  if (process.platform !== 'win32') {
    return res.status(400).json({ ok: false, message: 'Only supported on Windows.' });
  }
  try {
    const script = [
      'Write-Host "Enabling Hyper-V..." -ForegroundColor Cyan',
      'dism.exe /online /enable-feature /featurename:Microsoft-Hyper-V-All /all /norestart',
      'Write-Host "Enabling WSL2..." -ForegroundColor Cyan',
      'dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart',
      'Write-Host "Enabling Virtual Machine Platform..." -ForegroundColor Cyan',
      'dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart',
      'Write-Host ""',
      'Write-Host "Done! All features enabled." -ForegroundColor Green',
      'Write-Host "Please RESTART your computer, then start Docker Desktop." -ForegroundColor Yellow',
      'Read-Host -Prompt "Press Enter to close this window"',
    ].join('\r\n');

    const tmpScript = path.join(os.tmpdir(), 'ps_enable_virt.ps1');
    fs.writeFileSync(tmpScript, script, 'utf8');

    // Launch an elevated PowerShell window — triggers a UAC prompt
    require('child_process').exec(
      `powershell -Command "Start-Process powershell -Verb RunAs -ArgumentList '-ExecutionPolicy Bypass -File \\"${tmpScript.replace(/\\/g, '\\\\')}\\""  "`,
      { timeout: 8000 },
      () => {}
    );
    res.json({ ok: true, message: 'UAC prompt launched — accept it to enable the features. A restart will be required to complete installation.' });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// Comprehensive system requirements check — used by Configuration → System Requirements
router.get('/system-check', auth, async (req, res) => {
  // RETIRED — local/native test execution is no longer supported; CI-pipeline execution only.
  return res.status(410).json({ error: 'Local test execution has been retired. Run tests via the CI pipeline instead.' });
  const checks = [];
  const { PROJECTS_ROOT, BACKUPS_ROOT } = require('../utils/projectFolders');

  const nativeMode = isNativeMode();

  if (nativeMode) {
    // ── Native mode: check Java, JMeter, K6 directly ─────────────────────
    let javaVer = null;
    try { javaVer = execSync('java -version 2>&1', { timeout: 5000, stdio: 'pipe' }).toString().split('\n')[0].trim(); } catch {}
    checks.push({ id: 'java', name: 'Java (JDK)', status: javaVer ? 'ok' : 'fail', detail: javaVer || 'Not found — Java 17+ required for JMeter' });

    const jmeterBin = getJMeterBin(null);
    let jmeterVer = null;
    if (jmeterBin) {
      try { jmeterVer = execSync(`"${jmeterBin}" --version 2>&1`, { timeout: 10000, stdio: 'pipe' }).toString().split('\n')[0].trim(); } catch {}
    }
    checks.push({ id: 'jmeter', name: 'Apache JMeter', status: jmeterBin ? 'ok' : 'fail', detail: jmeterVer || (jmeterBin ? 'Installed' : 'Not found — install JMeter 5.6+') });

    const k6Bin = getK6Bin(null);
    let k6Ver = null;
    if (k6Bin) {
      try { k6Ver = execSync(`"${k6Bin}" version 2>&1`, { timeout: 5000, stdio: 'pipe' }).toString().trim(); } catch {}
    }
    checks.push({ id: 'k6', name: 'K6', status: k6Bin ? 'ok' : 'fail', detail: k6Ver || (k6Bin ? 'Installed' : 'Not found — install K6') });

    let gitVer = null;
    try { gitVer = execSync('git --version 2>&1', { timeout: 5000, stdio: 'pipe' }).toString().trim(); } catch {}
    checks.push({ id: 'git', name: 'Git', status: gitVer ? 'ok' : 'warn', detail: gitVer || 'Not found (optional — needed for Git integration)' });

  } else {
    // ── Docker mode: check Docker daemon ─────────────────────────────────
    let dockerOk = false;
    try {
      execSync('docker info', { timeout: 8000, stdio: 'pipe' });
      const ver = execSync('docker --version', { timeout: 3000, stdio: 'pipe' }).toString().trim();
      checks.push({ id: 'docker_daemon', name: 'Docker Daemon', status: 'ok', detail: ver });
      dockerOk = true;
    } catch (_) {
      try {
        const ver = execSync('docker --version', { timeout: 3000, stdio: 'pipe' }).toString().trim();
        checks.push({ id: 'docker_daemon', name: 'Docker Daemon', status: 'fail', detail: ver + ' (daemon not running — start Docker Desktop)' });
      } catch (_) {
        checks.push({ id: 'docker_daemon', name: 'Docker Daemon', status: 'fail', detail: 'Not installed — download Docker Desktop from docker.com' });
      }
    }
  }

  // Keep dockerOk in scope for downstream checks that use it
  let dockerOk = !nativeMode && checks.find(c => c.id === 'docker_daemon')?.status === 'ok';

  // 2. Windows Virtualization — detect via services + WSL executable (no admin needed)
  if (process.platform === 'win32') {
    try {
      const missing = [];
      const details = [];

      // Hyper-V: check for vmms (Virtual Machine Management Service)
      try {
        const svc = execSync(
          'powershell -NoProfile -Command "(Get-Service -Name vmms -ErrorAction SilentlyContinue).Status"',
          { timeout: 6000, stdio: 'pipe' }
        ).toString().trim();
        if (svc === 'Running' || svc === 'Stopped') {
          details.push('Hyper-V ✓');
        } else {
          missing.push('Hyper-V');
        }
      } catch (_) { missing.push('Hyper-V'); }

      // WSL2: check if wsl.exe is reachable and returns a version
      try {
        execSync('wsl --status', { timeout: 6000, stdio: 'pipe' });
        details.push('WSL2 ✓');
      } catch (_) {
        // wsl --status may exit non-zero on older WSL but wsl.exe still exists
        try {
          const wslPath = execSync('where wsl', { timeout: 4000, stdio: 'pipe' }).toString().trim();
          if (wslPath) details.push('WSL2 ✓');
          else missing.push('WSL2');
        } catch (__) { missing.push('WSL2'); }
      }

      // Virtual Machine Platform: check vmcompute service
      try {
        const svc = execSync(
          'powershell -NoProfile -Command "(Get-Service -Name vmcompute -ErrorAction SilentlyContinue).Status"',
          { timeout: 6000, stdio: 'pipe' }
        ).toString().trim();
        if (svc === 'Running' || svc === 'Stopped') {
          details.push('VMP ✓');
        } else {
          missing.push('Virtual Machine Platform');
        }
      } catch (_) { missing.push('Virtual Machine Platform'); }

      if (missing.length === 0) {
        checks.push({ id: 'virtualization', name: 'Hyper-V & WSL2', status: 'ok', detail: `Enabled — ${details.join(', ')}` });
      } else {
        checks.push({ id: 'virtualization', name: 'Hyper-V & WSL2', status: 'fail', detail: `Not detected: ${missing.join(', ')} — required for Docker Desktop` });
      }
    } catch (_) {
      checks.push({ id: 'virtualization', name: 'Hyper-V & WSL2', status: 'warn', detail: 'Could not check Windows virtualization features' });
    }
  }

  // 3. Docker Compose
  try {
    const ver = execSync('docker compose version', { timeout: 5000, stdio: 'pipe' }).toString().trim();
    checks.push({ id: 'docker_compose', name: 'Docker Compose v2', status: 'ok', detail: ver });
  } catch (_) {
    try {
      const ver = execSync('docker-compose --version', { timeout: 5000, stdio: 'pipe' }).toString().trim();
      checks.push({ id: 'docker_compose', name: 'Docker Compose', status: 'ok', detail: ver + ' (v1 — upgrade to v2 recommended)' });
    } catch (_) {
      checks.push({ id: 'docker_compose', name: 'Docker Compose v2', status: 'warn', detail: 'Not found — needed for docker-start.bat / setup.sh deployment' });
    }
  }

  // 4. Docker socket permission (Linux/macOS)
  if (process.platform !== 'win32') {
    const socketPath = '/var/run/docker.sock';
    try {
      fs.accessSync(socketPath, fs.constants.R_OK | fs.constants.W_OK);
      checks.push({ id: 'docker_socket', name: 'Docker Socket (/var/run/docker.sock)', status: 'ok', detail: 'Read/write access confirmed' });
    } catch (_) {
      checks.push({ id: 'docker_socket', name: 'Docker Socket (/var/run/docker.sock)', status: 'fail', detail: 'No access — fix with: sudo usermod -aG docker $USER && newgrp docker' });
    }
  } else {
    checks.push({ id: 'docker_socket', name: 'Docker Socket', status: 'ok', detail: 'Windows — Docker Desktop manages socket access via named pipe' });
  }

  // 4. Node.js version
  const nodeVer = process.version;
  const nodeMajor = parseInt(nodeVer.slice(1).split('.')[0]);
  checks.push({
    id: 'nodejs',
    name: 'Node.js Runtime',
    status: nodeMajor >= 18 ? 'ok' : 'fail',
    detail: `${nodeVer} — v18+ required`,
  });

  // 5. Projects directory — write permission
  try {
    fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
    const testFile = path.join(PROJECTS_ROOT, '.ps_writetest');
    fs.writeFileSync(testFile, 'ok');
    fs.unlinkSync(testFile);
    checks.push({ id: 'projects_write', name: 'Projects Directory (Write)', status: 'ok', detail: PROJECTS_ROOT });
  } catch (e) {
    checks.push({ id: 'projects_write', name: 'Projects Directory (Write)', status: 'fail', detail: `No write access to ${PROJECTS_ROOT}: ${e.message}` });
  }

  // 6. Backups directory — write permission
  try {
    fs.mkdirSync(BACKUPS_ROOT, { recursive: true });
    const testFile = path.join(BACKUPS_ROOT, '.ps_writetest');
    fs.writeFileSync(testFile, 'ok');
    fs.unlinkSync(testFile);
    checks.push({ id: 'backups_write', name: 'Backups Directory (Write)', status: 'ok', detail: BACKUPS_ROOT });
  } catch (e) {
    checks.push({ id: 'backups_write', name: 'Backups Directory (Write)', status: 'fail', detail: `No write access to ${BACKUPS_ROOT}: ${e.message}` });
  }

  // 7. Disk space
  try {
    let availableGB;
    if (process.platform === 'win32') {
      const driveLetter = (path.parse(path.resolve(PROJECTS_ROOT)).root || 'C:\\').slice(0, 1);
      const out = execSync(
        `powershell -NoProfile -Command "(Get-PSDrive -Name '${driveLetter}').Free"`,
        { timeout: 5000, stdio: 'pipe' }
      ).toString().trim();
      availableGB = parseInt(out) / (1024 ** 3);
    } else {
      const out = execSync(`df -B1 "${PROJECTS_ROOT}" 2>/dev/null | tail -1`, { timeout: 5000, stdio: 'pipe' }).toString().trim();
      availableGB = parseInt(out.split(/\s+/)[3] || '0') / (1024 ** 3);
    }
    const gb = availableGB.toFixed(1);
    const status = availableGB > 10 ? 'ok' : availableGB > 5 ? 'warn' : 'fail';
    checks.push({ id: 'disk_space', name: 'Available Disk Space', status, detail: `${gb} GB available (10 GB+ recommended — Docker images + test results)` });
  } catch (_) {
    checks.push({ id: 'disk_space', name: 'Available Disk Space', status: 'warn', detail: 'Could not determine available disk space' });
  }

  // 8 & 9. Docker images (JMeter, K6)
  const cfgRow = await db.prepare('SELECT config_json FROM global_config WHERE user_id = ?').get(req.userId);
  const savedCfg = cfgRow ? JSON.parse(cfgRow.config_json || '{}') : {};
  const jmeterImage = savedCfg.jmeter_docker_image || process.env.JMETER_DOCKER_IMAGE || 'justb4/jmeter:latest';
  const k6Image     = savedCfg.k6_docker_image     || process.env.K6_DOCKER_IMAGE     || 'grafana/k6:latest';

  for (const [toolId, toolName, image] of [['jmeter', 'JMeter', jmeterImage], ['k6', 'K6', k6Image]]) {
    if (dockerOk) {
      try {
        execSync(`docker image inspect ${image}`, { timeout: 5000, stdio: 'pipe' });
        checks.push({ id: `image_${toolId}`, name: `${toolName} Image (${image})`, status: 'ok', detail: 'Pulled and available locally' });
      } catch (_) {
        checks.push({ id: `image_${toolId}`, name: `${toolName} Image (${image})`, status: 'warn', detail: 'Not pulled yet — go to Configuration → Docker Engine → Pull' });
      }
    } else {
      checks.push({ id: `image_${toolId}`, name: `${toolName} Image (${image})`, status: 'warn', detail: 'Cannot verify — Docker daemon not running' });
    }
  }

  // 10. Internet connectivity (Docker Hub DNS)
  await new Promise((resolve) => {
    dns.lookup('hub.docker.com', (err) => {
      checks.push({
        id: 'internet',
        name: 'Internet (Docker Hub)',
        status: err ? 'warn' : 'ok',
        detail: err
          ? 'Cannot resolve hub.docker.com — Docker image pulls will fail unless images are already cached'
          : 'hub.docker.com reachable — image pulls will work',
      });
      resolve();
    });
  });

  // 11. HOST_PROJECTS_ROOT configuration (Docker-in-Docker path mapping)
  const hostProjRoot = process.env.HOST_PROJECTS_ROOT;
  if (hostProjRoot) {
    checks.push({ id: 'host_path', name: 'HOST_PROJECTS_ROOT (Docker path mapping)', status: 'ok', detail: `Configured: ${hostProjRoot} — test containers will use this path for volume mounts` });
  } else if (process.env.NODE_ENV === 'production') {
    checks.push({ id: 'host_path', name: 'HOST_PROJECTS_ROOT (Docker path mapping)', status: 'warn', detail: 'Not set — required when backend runs in Docker Compose; add HOST_PROJECTS_ROOT to .env' });
  } else {
    checks.push({ id: 'host_path', name: 'HOST_PROJECTS_ROOT (Docker path mapping)', status: 'ok', detail: `Not set — dev mode uses PROJECTS_ROOT (${PROJECTS_ROOT}) directly for volume mounts` });
  }

  const failed  = checks.filter(c => c.status === 'fail').length;
  const warned  = checks.filter(c => c.status === 'warn').length;
  const overall = failed > 0 ? 'fail' : warned > 0 ? 'warn' : 'ok';

  res.json({ checks, overall, platform: process.platform, node_version: process.version });
});

async function setJavaEnvVarsPermanently(platform, javaHome, sendLog) {
  const javaBinDir = path.join(javaHome, 'bin');
  process.env.JAVA_HOME = javaHome;
  process.env.PATH = javaBinDir + path.delimiter + (process.env.PATH || '');

  if (platform === 'win32') {
    try {
      execSync(`powershell -NoProfile -Command "[Environment]::SetEnvironmentVariable('JAVA_HOME', '${javaHome}', 'User')"`, { timeout: 10000 });
      sendLog('ok', 'JAVA_HOME set permanently in user environment (Windows).');
    } catch (e) {
      sendLog('warn', 'Could not set JAVA_HOME permanently: ' + e.message);
    }
    try {
      const currentPath = execSync("powershell -NoProfile -Command \"[Environment]::GetEnvironmentVariable('PATH', 'User')\"", { timeout: 5000 }).toString().trim();
      if (!currentPath.includes(javaBinDir)) {
        const newPath = javaBinDir + ';' + currentPath;
        execSync(`powershell -NoProfile -Command "[Environment]::SetEnvironmentVariable('PATH', '${newPath}', 'User')"`, { timeout: 10000 });
        sendLog('ok', 'Java bin directory added to user PATH (Windows).');
      } else {
        sendLog('info', 'Java bin directory is already in user PATH.');
      }
    } catch (e) {
      sendLog('warn', 'Could not update PATH: ' + e.message);
    }
  } else {
    const profileFiles = [
      path.join(process.env.HOME, '.profile'),
      path.join(process.env.HOME, '.bashrc'),
    ];
    const exportLines = `\n# Java (set by PerfStudio)\nexport JAVA_HOME="${javaHome}"\nexport PATH="$JAVA_HOME/bin:$PATH"\n`;
    for (const pf of profileFiles) {
      try {
        const existing = fs.existsSync(pf) ? fs.readFileSync(pf, 'utf8') : '';
        if (!existing.includes('JAVA_HOME')) {
          fs.appendFileSync(pf, exportLines);
          sendLog('ok', `JAVA_HOME export added to ${pf}`);
        } else {
          sendLog('info', `JAVA_HOME already present in ${pf}`);
        }
      } catch (e) {
        sendLog('warn', `Could not update ${pf}: ${e.message}`);
      }
    }
  }
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const client = parsedUrl.protocol === 'https:' ? https : http;
    const file = fs.createWriteStream(dest);
    const request = client.get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        file.close();
        fs.unlink(dest, () => {});
        return downloadFile(response.headers.location, dest).then(resolve).catch(reject);
      }
      if (response.statusCode !== 200) {
        file.close();
        fs.unlink(dest, () => {});
        return reject(new Error(`HTTP ${response.statusCode} downloading ${url}`));
      }
      response.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', (err) => { fs.unlink(dest, () => {}); reject(err); });
    });
    request.on('error', (err) => { fs.unlink(dest, () => {}); reject(err); });
  });
}

router.post('/install-deps', auth, async (req, res) => {
  // RETIRED — local/native test execution is no longer supported; CI-pipeline execution only.
  return res.status(410).json({ error: 'Local test execution has been retired. Run tests via the CI pipeline instead.' });
  const { tool } = req.body;
  if (!tool) return res.status(400).json({ error: 'tool is required' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  if (res.socket) res.socket.setNoDelay(true);

  function sendLog(type, msg) {
    res.write('data: ' + JSON.stringify({ type, message: msg }) + '\n\n');
  }

  function sendDone(result) {
    res.write('data: ' + JSON.stringify({ done: true, ...result }) + '\n\n');
    res.end();
  }

  try {
    if (tool === 'docker') {
      const platform = process.platform;
      const arch = process.arch;
      sendLog('info', `Detecting OS: ${platform} (${arch})`);

      if (platform === 'win32') {
        const installerUrl = 'https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe';
        const installerPath = path.join(os.tmpdir(), 'DockerDesktopInstaller.exe');
        sendLog('info', 'Downloading Docker Desktop for Windows (~580 MB)...');
        sendLog('info', 'This may take several minutes depending on your connection.');
        await downloadFile(installerUrl, installerPath);
        const sizeMB = (fs.statSync(installerPath).size / 1024 / 1024).toFixed(1);
        sendLog('ok', `Downloaded: ${installerPath} (${sizeMB} MB)`);
        sendLog('info', 'Launching Docker Desktop installer — a UAC prompt will appear, click Yes to allow...');
        try {
          // Use Start-Process -Verb RunAs so Windows shows the UAC elevation prompt.
          // We do NOT wait for completion (no -Wait) so the SSE stream stays open
          // and the user can see the guidance while the installer runs in the background.
          execSync(
            `powershell -Command "Start-Process -FilePath '${installerPath.replace(/'/g, "''")}' -Verb RunAs"`,
            { timeout: 30000 }
          );
          sendLog('ok', 'Installer launched. Follow the Docker Desktop setup wizard.');
          sendLog('warn', 'Keep this page open — after the wizard finishes, restart your computer if prompted.');
          sendLog('info', 'Once Docker Desktop is running, come back and click "Re-check" to verify.');
          return sendDone({ ok: true });
        } catch (e) {
          // UAC was denied or PowerShell failed — guide user to run manually
          sendLog('warn', 'Could not launch installer automatically (UAC may have been denied).');
          sendLog('info', `Run the installer manually: ${installerPath}`);
          sendLog('info', 'Right-click the file → "Run as administrator" → follow the setup wizard.');
          return sendDone({ ok: false, error: e.message });
        }
      }

      if (platform === 'linux') {
        sendLog('info', 'Downloading Docker install script from get.docker.com...');
        const scriptPath = path.join(os.tmpdir(), 'get-docker.sh');
        await downloadFile('https://get.docker.com', scriptPath);
        sendLog('ok', 'Install script downloaded.');
        sendLog('info', 'Running install script (requires sudo/root)...');
        try {
          execSync(`sh "${scriptPath}"`, { timeout: 300000, stdio: 'pipe' });
          sendLog('ok', 'Docker Engine installed successfully.');
          sendLog('info', 'Adding current user to docker group...');
          try { execSync(`usermod -aG docker ${process.env.USER || 'root'}`, { timeout: 10000 }); } catch (_) {}
          sendLog('ok', 'Done. You may need to log out and back in for group changes to take effect.');
          return sendDone({ ok: true });
        } catch (e) {
          sendLog('err', 'Install script failed: ' + e.message);
          return sendDone({ ok: false, error: e.message });
        } finally {
          try { fs.unlinkSync(scriptPath); } catch (_) {}
        }
      }

      if (platform === 'darwin') {
        const dmgUrl = arch === 'arm64'
          ? 'https://desktop.docker.com/mac/main/arm64/Docker.dmg'
          : 'https://desktop.docker.com/mac/main/amd64/Docker.dmg';
        const dmgPath = path.join(os.tmpdir(), 'Docker.dmg');
        sendLog('info', `Downloading Docker Desktop for macOS (${arch === 'arm64' ? 'Apple Silicon' : 'Intel'})...`);
        sendLog('info', 'This may take several minutes (~600 MB)...');
        await downloadFile(dmgUrl, dmgPath);
        const sizeMB = (fs.statSync(dmgPath).size / 1024 / 1024).toFixed(1);
        sendLog('ok', `Downloaded: ${dmgPath} (${sizeMB} MB)`);
        sendLog('info', 'Mounting disk image...');
        execSync(`hdiutil attach "${dmgPath}" -nobrowse -quiet`, { timeout: 60000 });
        sendLog('info', 'Copying Docker.app to /Applications...');
        execSync('cp -R /Volumes/Docker/Docker.app /Applications/', { timeout: 120000 });
        execSync('hdiutil detach /Volumes/Docker -quiet', { timeout: 30000 });
        sendLog('ok', 'Docker Desktop installed to /Applications.');
        sendLog('info', 'Launch Docker Desktop from Applications to complete setup.');
        try { fs.unlinkSync(dmgPath); } catch (_) {}
        return sendDone({ ok: true });
      }

      return sendDone({ ok: false, error: `Unsupported platform: ${platform}` });
    }

    sendLog('info', `Unknown or no-longer-needed tool: ${tool}`);
    sendLog('info', 'All execution tools (JMeter, K6) now run inside Docker. Use the Docker Engine section in Configuration to pull images.');
    return sendDone({ ok: false, error: `Tool "${tool}" is not available — use Docker images instead` });
  } catch (err) {
    sendLog('err', err.message);
    return sendDone({ ok: false, error: err.message });
  }
});

router.post('/run', auth, async (req, res) => {
  // RETIRED — local/native/Docker-spawned test execution is no longer supported; CI-pipeline execution only.
  return res.status(410).json({ error: 'Local test execution has been retired. Run tests via the CI pipeline instead.' });
  // SSE setup — stream logs in real-time
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  // Disable Nagle's algorithm so each res.write() flushes immediately
  if (res.socket) res.socket.setNoDelay(true);

  const allLogs = [];
  function log(type, message) {
    const entry = { type, message };
    allLogs.push(entry);
    res.write('data: ' + JSON.stringify(entry) + '\n\n');
    // Force immediate flush through any compression/proxy middleware
    if (typeof res.flush === 'function') res.flush();
  }
  function done(data) {
    res.write('data: ' + JSON.stringify({ done: true, ...data }) + '\n\n');
    res.end();
  }

  const { project_id, suite_id, engine, vusers, rampup, iteration_mode, loops, duration, auto_heal } = req.body;

  if (!project_id || !suite_id || !engine) {
    log('err', 'Missing required parameters: project_id, suite_id, engine');
    return done({ ok: false, error: 'Missing required parameters' });
  }

  const project = await ownsProject(req.userId, project_id);
  if (!project) { log('err', 'Access denied'); return done({ ok: false, error: 'Forbidden' }); }

  // Git repository must be initialized before running tests
  if (!project.folder_path) {
    log('err', 'Git repository not initialized');
    return done({ ok: false, error: 'Git repository not initialized. Go to Configuration → Git to initialize the repository first.' });
  }

  // Restore the workspace first if the S3 sweep reclaimed it since the last access — the
  // existence check inside is a synchronous stat, so this adds no latency once warm (the
  // common case). Must happen before the scriptPath existence check below, since scriptPath
  // lives inside this same folder.
  await require('./git').ensureGitWorkspaceHydrated(project.folder_path, project_id, req.userId);

  // Soft concurrency cap — prevent accidental resource exhaustion
  const activeCount = await countActiveRuns(req.userId);
  if (activeCount >= MAX_CONCURRENT_RUNS) {
    log('err', `Too many concurrent runs (${activeCount} active). Wait for a run to finish before starting another.`);
    return done({ ok: false, error: `Too many concurrent runs. Max ${MAX_CONCURRENT_RUNS} simultaneous runs allowed.` });
  }

  const suite = await db.prepare('SELECT * FROM test_suites WHERE id = ? AND project_id = ?').get(suite_id, project_id);
  if (!suite) { log('err', `Test suite not found (id=${suite_id})`); return done({ ok: false, error: 'Test suite not found' }); }

  const scriptPath = engine === 'jmeter' ? suite.jmx_path : suite.js_path;
  if (!scriptPath || !fs.existsSync(scriptPath)) {
    log('err', `Script file not found: ${scriptPath || '(not set)'}`);
    log('err', 'Go to Test Plans and generate a script first.');
    return done({ ok: false, error: 'Script file not found' });
  }

  // ── Preparation summary ──────────────────────────────────────────────────
  log('info', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log('info', '  PerfStudio  —  TEST EXECUTION ENGINE');
  log('info', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log('info', `  Engine     : ${engine.toUpperCase()} (Docker)`);
  log('info', `  Test Plan  : ${suite.name}`);
  log('info', `  Project    : ${project.name}`);
  log('info', `  VUsers     : ${vusers || suite.vusers}`);
  log('info', `  Ramp-up    : ${rampup || suite.rampup}s`);
  if (iteration_mode === 'duration') {
    log('info', `  Mode       : Duration — ${duration || suite.duration}s`);
  } else {
    log('info', `  Mode       : Iterations — ${loops || suite.loops} loops`);
  }
  log('info', `  Script     : ${scriptPath}`);
  log('info', `  Started at : ${new Date().toLocaleString()}`);
  log('info', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const projectFolderPath = project.folder_path || getProjectPath(project.name, project.id);
  const orgSlug = await resolveOrgSlugForProject(project_id);
  const runNumber = await getNextRunNumber(project_id);
  const { buildRunDirName } = require('../utils/buildRunName');
  const effectiveUsers    = vusers    || suite.vusers    || 1;
  const effectiveLoops    = loops     || suite.loops     || 1;
  const effectiveDuration = duration  || suite.duration  || 0;
  const effectiveIterMode = iteration_mode || suite.iter_mode || 'duration';
  const runDirName = buildRunDirName(suite.name, effectiveUsers, effectiveIterMode, effectiveLoops, effectiveDuration, runNumber);

  // Results go into collection/env/results/{runDirName}/ — tracked per environment in git.
  // resolveSuiteEnv falls back to the collection's own default env when suite.env is
  // blank, so a collection-scoped suite never drops to the project-level fallback below
  // just because its env wasn't explicitly set.
  let resultDir;
  if (suite.collection_id && projectFolderPath) {
    try {
      const suiteCol = await db.prepare('SELECT * FROM collections WHERE id = ?').get(suite.collection_id);
      const resolvedEnv = resolveSuiteEnv(suiteCol, suite);
      if (suiteCol && resolvedEnv) {
        const { getCollectionPath } = require('../utils/projectFolders');
        const envPath = getCollectionPath(projectFolderPath, suiteCol.name, resolvedEnv);
        resultDir = path.join(envPath, 'results', runDirName);
      }
    } catch (e) {
      log('warn', `Collection/env result path resolution failed, falling back to project-level results: ${e.message}`);
    }
  }
  // Project-level fallback is only legitimate for a suite with no collection at all.
  if (!resultDir) resultDir = path.join(projectFolderPath, 'results', runDirName);
  fs.mkdirSync(resultDir, { recursive: true });
  log('info', `  Result dir : ${resultDir}`);
  log('info', `  Run #      : ${runNumber}`);

  const runRow = await db.prepare(`
    INSERT INTO execution_runs
      (project_id, suite_id, engine, status, result_dir, logs, started_at, auto_heal,
       run_vusers, run_rampup, run_duration, run_loops, run_iter_mode)
    VALUES (?, ?, ?, 'running', ?, '[]', NOW(), ?, ?, ?, ?, ?, ?)
  `).run(
    project_id, suite_id, engine, resultDir, auto_heal ? 1 : 0,
    vusers    || null,
    rampup    || null,
    duration  || null,
    loops     || null,
    iteration_mode || null
  );
  const runId = runRow.lastInsertRowid;

  const cfgRow = await db.prepare('SELECT config_json FROM global_config WHERE user_id = ?').get(req.userId);
  const savedCfg = cfgRow ? JSON.parse(cfgRow.config_json || '{}') : {};

  let patchedJmx = null;
  // SSE keepalive — forces buffered proxies (Vite dev server, nginx, etc.) to flush
  // every second so log lines reach the browser in real-time.
  const heartbeat = setInterval(async () => {
    try { if (!res.writableEnded) res.write(': ping\n\n'); } catch {}
  }, 1000);

  try {
    let cmd, args, reportPath = null, jtlPath = null, jmeterLogPath = null;

    if (engine === 'jmeter') {
      const jmeterImage = savedCfg.jmeter_docker_image || process.env.JMETER_DOCKER_IMAGE || 'justb4/jmeter:latest';
      const reportDir = path.join(resultDir, 'report');
      fs.mkdirSync(reportDir, { recursive: true });
      jtlPath = path.join(resultDir, 'results.jtl');
      jmeterLogPath = path.join(resultDir, 'jmeter.log');
      reportPath = path.join(reportDir, 'index.html');

      patchedJmx = patchJmxForParams(scriptPath, {
        vusers, rampup, duration, loops, iter_mode: iteration_mode || 'duration',
      });

      // Use host-side paths for Docker -v mounts (handles Docker-in-Docker mode)
      const dockerScriptDir  = toHostPath(path.dirname(patchedJmx));
      const dockerResultDir  = toHostPath(resultDir);
      const scriptName       = path.basename(patchedJmx);

      // Mount testData dir — use collection/env/testData (where files actually live)
      // Fall back to project/testData for legacy scripts
      let testDataHostDir, testDataExists;
      const suiteCollection = suite.collection_id
        ? await db.prepare('SELECT * FROM collections WHERE id = ?').get(suite.collection_id)
        : null;
      const suiteEnvName = suite.env || '';

      if (suiteCollection && suiteEnvName && projectFolderPath) {
        const { getCollectionPath } = require('../utils/projectFolders');
        const envPath = getCollectionPath(projectFolderPath, suiteCollection.name, suiteEnvName);
        const envTestDataDir = path.join(envPath, 'testData');
        if (fs.existsSync(envTestDataDir)) {
          testDataHostDir = toHostPath(envTestDataDir);
          testDataExists  = true;
        }
      }
      // Fallback: project-root testData (legacy)
      if (!testDataExists) {
        testDataHostDir = toHostPath(path.join(projectFolderPath, 'testData'));
        testDataExists  = fs.existsSync(path.join(projectFolderPath, 'testData'));
      }
      if (testDataExists) {
        let jmxContent = fs.readFileSync(patchedJmx, 'utf8');

        if (isNativeMode()) {
          // Native mode: replace testData paths with the actual disk path
          const nativeTestDataDir = testDataHostDir.replace(/\\/g, '/').replace(/\/?$/, '/');
          jmxContent = jmxContent.replace(/[A-Za-z]:[/\\][^\s<"]*[/\\]testData[/\\]?/gi, nativeTestDataDir);
          jmxContent = jmxContent.replace(/\/[^\s<"]*\/testData\/?/gi, nativeTestDataDir);
          log('info', `  Test data  : ${nativeTestDataDir} (native)`);
        } else {
          // Docker mode: replace with container mount point /jmeter/testdata/
          jmxContent = jmxContent.replace(/[A-Za-z]:[/\\][^\s<"]*[/\\]testData[/\\]?/gi, '/jmeter/testdata/');
          jmxContent = jmxContent.replace(/\/[^\s<"]*\/testData\/?/gi, '/jmeter/testdata/');
          log('info', `  Test data  : ${testDataHostDir} → /jmeter/testdata`);
        }

        fs.writeFileSync(patchedJmx, jmxContent, 'utf8');
      }

      if (!isNativeMode()) {
        log('info', `  JMeter img : ${jmeterImage}`);
        log('info', `  JTL file   : ${jtlPath}`);
        log('info', `  Report dir : ${reportDir}`);
        log('info', `  JMeter log : ${jmeterLogPath}`);
        if (testDataExists) log('info', `  Test data  : ${testDataHostDir} → /jmeter/testdata`);
      }

      if (isNativeMode()) {
        // ── Native mode: run JMeter binary directly (no Docker) ──────────────
        const jmeterBin = process.env.JMETER_BIN || getJMeterBin(null) || 'jmeter';
        log('info', `  Mode       : Native (${jmeterBin})`);
        log('info', `  JTL file   : ${jtlPath}`);
        log('info', `  Report dir : ${reportDir}`);
        log('info', `  JMeter log : ${jmeterLogPath}`);
        cmd  = jmeterBin;
        args = [
          '-n', '-t', patchedJmx || scriptPath,
          '-l', jtlPath,
          '-e', '-o', reportDir,
          '-j', jmeterLogPath,
        ];
        if (vusers)  args.push(`-Jthreads=${vusers}`);
        if (rampup)  args.push(`-Jrampup=${rampup}`);
        if (iteration_mode === 'loops' && loops)       args.push(`-Jloops=${loops}`);
        if (iteration_mode === 'duration' && duration) args.push(`-Jduration=${duration}`);
      } else {
        // ── Docker mode: run via justb4/jmeter image ─────────────────────────
        cmd = 'docker';
        args = ['run', '--rm',
          '-v', `${dockerScriptDir}:/jmeter/scripts`,
          '-v', `${dockerResultDir}:/jmeter/results`,
        ];
        if (testDataExists) args.push('-v', `${testDataHostDir}:/jmeter/testdata`);
        args.push(
          jmeterImage,
          '-n', '-t', `/jmeter/scripts/${scriptName}`,
          '-l', '/jmeter/results/results.jtl',
          '-e', '-o', '/jmeter/results/report',
          '-j', '/jmeter/results/jmeter.log',
        );
        if (vusers)  args.push(`-Jthreads=${vusers}`);
        if (rampup)  args.push(`-Jrampup=${rampup}`);
        if (iteration_mode === 'loops' && loops)       args.push(`-Jloops=${loops}`);
        if (iteration_mode === 'duration' && duration) args.push(`-Jduration=${duration}`);
      }

      // NOTE: PROTOCOL/SERVER/PORT are baked into JMX User Defined Variables at generation time.
      // Runtime only controls execution params (threads, ramp-up, duration/loops).

    } else if (engine === 'k6') {
      const resultsJson = path.join(resultDir, 'results.json');

      if (isNativeMode()) {
        // ── Native mode: run K6 binary directly ──────────────────────────────
        const k6Bin = process.env.K6_BIN || getK6Bin(null) || 'k6';
        log('info', `  Mode       : Native (${k6Bin})`);
        cmd  = k6Bin;
        args = ['run', scriptPath, '--out', `json=${resultsJson}`];
        if (vusers) args.push('--vus', String(vusers));
        if (rampup) args.push('--stage', `${rampup}s:${vusers || 1}`);
        if (iteration_mode === 'duration' && duration) args.push('--duration', `${duration}s`);
        if (iteration_mode === 'loops' && loops)       args.push('--iterations', String(loops));
      } else {
        // ── Docker mode: run via grafana/k6 image ─────────────────────────────
        const k6Image = savedCfg.k6_docker_image || process.env.K6_DOCKER_IMAGE || 'grafana/k6:latest';
        const dockerScriptDir = toHostPath(path.dirname(scriptPath));
        const dockerResultDir = toHostPath(resultDir);
        const scriptName = path.basename(scriptPath);
        log('info', `  K6 image   : ${k6Image}`);
        cmd  = 'docker';
        args = [
          'run', '--rm',
          '-v', `${dockerScriptDir}:/scripts`,
          '-v', `${dockerResultDir}:/results`,
          k6Image,
          'run', `/scripts/${scriptName}`,
          '--out', 'json=/results/results.json',
        ];
        if (vusers) args.push('--vus', String(vusers));
        if (rampup) args.push('--stage', `${rampup}s:${vusers || 1}`);
        if (iteration_mode === 'duration' && duration) args.push('--duration', `${duration}s`);
        if (iteration_mode === 'loops' && loops)       args.push('--iterations', String(loops));
      }

    } else {
      log('err', `Unsupported engine: ${engine}`);
      return done({ ok: false, error: `Unsupported engine: ${engine}` });
    }

    log('info', '');
    log('info', `▶  Launching ${engine.toUpperCase()} process...`);
    log('info', `   ${cmd} ${args.join(' ')}`);
    log('info', '');

    // Tail jmeter.log file while JMeter is running
    let logTailer = null;
    if (jmeterLogPath) {
      let filePos = 0;
      logTailer = setInterval(async () => {
        if (!fs.existsSync(jmeterLogPath)) return;
        try {
          const size = fs.statSync(jmeterLogPath).size;
          if (size <= filePos) return;
          const fd = fs.openSync(jmeterLogPath, 'r');
          const buf = Buffer.alloc(size - filePos);
          fs.readSync(fd, buf, 0, buf.length, filePos);
          fs.closeSync(fd);
          filePos = size;
          for (const raw of buf.toString('utf8').split('\n')) {
            const line = raw.trim();
            if (!line) continue;
            // Strip log4j timestamp prefix: "2026-05-22 10:30:00,123 INFO ..."
            const clean = line.replace(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d+\s+/, '');
            const up = clean.toUpperCase();
            if (up.startsWith('ERROR') || up.includes(' ERROR '))       log('err',  `[jmeter.log] ${clean}`);
            else if (up.startsWith('WARN') || up.includes(' WARN '))    log('warn', `[jmeter.log] ${clean}`);
            else if (up.includes('SUMMARY') || up.includes('SUMMARISER') ||
                     up.includes('STARTING') || up.includes('TIDYING') ||
                     up.includes('END OF RUN') || up.includes('TEST STARTED'))
                                                                         log('info', `[jmeter.log] ${clean}`);
          }
        } catch {}
      }, 300);
    }

    // ── Mid-run rule monitoring setup ─────────────────────────────────────────
    const { sendRuleViolationEmail: sendMidRunViolationEmail } = require('../utils/emailUtils');
    const alertedRuleIds = new Set();   // track which rule IDs already fired an alert
    const testStartMs    = Date.now();
    const project        = await db.prepare('SELECT * FROM projects WHERE id = ?').get(project_id);
    const suiteName      = suite?.name || 'Test Run';
    const projectName    = project?.name || '';

    // All rule metrics can be monitored in real-time against the partial JTL.
    const LIVE_MONITOR_METRICS = new Set([
      'error rate',
      'cpu usage',
      'memory usage',
      'response time',
      'avg response time',
      'average response time',
      'p90',
      'p95',
      'throughput',
      'tps',
    ]);

    // Check rules against current partial JTL every second
    const ruleMonitor = setInterval(async () => {
      if (!jtlPath || !fs.existsSync(jtlPath)) return;
      try {
        const { evaluateRules: evalRules } = require('../utils/ruleEvaluator');
        const result = evalRules(project_id, jtlPath);
        if (!result || result.noRules || !result.violations?.length) return;

        // Only alert on live-monitorable metrics — ignore Response Time, P95, etc.
        const liveViolations = result.violations.filter(
          v => LIVE_MONITOR_METRICS.has((v.rule.metric || '').toLowerCase().trim())
        );
        if (!liveViolations.length) return;

        // Find new violations (not yet alerted for this run)
        const newViolations = liveViolations.filter(v => !alertedRuleIds.has(v.rule.id));
        if (!newViolations.length) return;

        // Mark as alerted — each rule fires at most once per run
        newViolations.forEach(async v => alertedRuleIds.add(v.rule.id));

        const elapsedSec = Math.floor((Date.now() - testStartMs) / 1000);
        log('warn', `  [Rules] ⚡ ${newViolations.length} rule breach(es) detected at ${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s — sending alert…`);
        newViolations.forEach(async v => log('warn', `          ${v.label} [${v.rule.severity}]`));

        // Send rule violation alert email (non-blocking) — fires once per rule per run
        sendMidRunViolationEmail(
          runId, req.userId, project_id,
          newViolations,
          suiteName,
          projectName
        ).catch(e => console.error('[Alerts] Rule violation email error:', e.message));

      } catch (e) {
        console.error('[RuleMonitor] Error:', e.message);
      }
    }, 1000); // check every second

    await new Promise((resolve, reject) => {
      const proc = spawn(cmd, args, { shell: true });

      function handleLines(chunk, stream) {
        for (const raw of chunk.toString().split('\n')) {
          const line = raw.trim();
          if (!line) continue;
          // Classify JMeter output lines
          const lo = line.toLowerCase();
          const isSummaryProgress = lo.includes('summary +');  // interim summary
          const isSummaryFinal    = lo.includes('summary =');  // final summary
          const isError = lo.includes('error') && !isSummaryProgress && !isSummaryFinal;
          const isWarn  = lo.includes('warn');
          let type = 'info';
          if (isError)           type = 'err';
          else if (isWarn)       type = 'warn';
          else if (isSummaryFinal)    type = 'ok';
          else if (isSummaryProgress) type = 'ok';
          log(type, line);
        }
      }

      proc.stdout.on('data', c => handleLines(c, 'stdout'));
      proc.stderr.on('data', c => handleLines(c, 'stderr'));

      proc.on('close', code => {
        clearInterval(ruleMonitor); // stop monitoring when test ends
        if (logTailer) clearInterval(logTailer);
        // Resolve regardless of exit code — JMeter exits non-zero even when all
        // samples pass (e.g. when using certain plugins or non-GUI flags).
        // The JTL file is the authoritative source for pass/fail status.
        resolve(code);
      });
      proc.on('error', err => {
        clearInterval(ruleMonitor);
        if (logTailer) clearInterval(logTailer);
        reject(err);
      });
    });

    // ── Completion summary ─────────────────────────────────────────────────
    log('info', '');
    log('info', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    log('ok',   '  ✔  TEST EXECUTION COMPLETED');
    log('info', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    // Declared here so rule engine block below can always reference them
    let pass = 0, fail = 0;

    if (jtlPath && fs.existsSync(jtlPath)) {
      const lines = fs.readFileSync(jtlPath, 'utf8').trim().split('\n');
      const rowCount = Math.max(0, lines.length - 1);
      const sizeMB   = (fs.statSync(jtlPath).size / 1024 / 1024).toFixed(2);

      // Quick pass to compute pass/fail counts from the JTL
      // Use proper CSV splitting to handle quoted fields containing commas.
      function splitCsvLine(line) {
        const result = [];
        let cur = '', inQuote = false;
        for (let ci = 0; ci < line.length; ci++) {
          const ch = line[ci];
          if (ch === '"') { inQuote = !inQuote; }
          else if (ch === ',' && !inQuote) { result.push(cur); cur = ''; }
          else { cur += ch; }
        }
        result.push(cur);
        return result;
      }
      const headers = splitCsvLine(lines[0]).map(h => h.trim().replace(/^"|"$/g, ''));
      const successIdx = headers.indexOf('success');
      for (let i = 1; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        if (successIdx >= 0) {
          const parts = splitCsvLine(lines[i]);
          const v = (parts[successIdx] || '').replace(/^"|"$/g, '').trim();
          v === 'true' ? pass++ : fail++;
        }
      }

      log('info', `  Requests   : ${rowCount.toLocaleString()} total`);
      if (pass > 0 || fail > 0) {
        log('ok',   `  Passed     : ${pass.toLocaleString()}`);
        if (fail > 0) log('err', `  Failed     : ${fail.toLocaleString()}`);
        log('info', `  Error rate : ${rowCount > 0 ? ((fail / rowCount) * 100).toFixed(2) : 0}%`);
      }
      log('info', `  JTL file   : ${jtlPath}  (${sizeMB} MB)`);
    }
    if (reportPath && fs.existsSync(reportPath)) {
      log('ok', `  HTML report: ${reportPath}`);
    }
    log('info', `  Result dir : ${resultDir}`);
    log('info', `  Finished   : ${new Date().toLocaleString()}`);
    log('info', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    // ── Rule Engine verdict ────────────────────────────────────────────────────
    let finalStatus = 'completed';
    let ruleViolations = [];

    // Zero requests = test completely failed to execute (missing URL, script error, etc.)
    // Treat as failure regardless of rules — no point evaluating rules against empty data.
    const rowCount = jtlPath && fs.existsSync(jtlPath)
      ? Math.max(0, fs.readFileSync(jtlPath, 'utf8').trim().split('\n').length - 1)
      : 0;

    if (rowCount === 0) {
      finalStatus = 'failed';
      log('err', '');
      log('err', '  ✘  TEST FAILED — 0 requests were executed.');
      log('err', '     Likely cause: target URL not configured for this environment.');
      log('err', '     Fix: Configuration → select env → add target URL → Save Config.');
    } else if (jtlPath && fs.existsSync(jtlPath)) {
      const ruleResult = await evaluateRules(project_id, jtlPath);
      if (!ruleResult.noRules) {
        ruleViolations = ruleResult.violations || [];
        const errorViolations = ruleViolations.filter(v => v.rule.severity === 'error');
        if (errorViolations.length > 0) {
          finalStatus = 'failed';
          log('err', '');
          log('err', '  ✘  RULE ENGINE — Performance thresholds breached:');
          for (const v of errorViolations) log('err', `     ${v.label}`);
        } else {
          const warnViolations = ruleViolations.filter(v => v.rule.severity === 'warn');
          for (const v of warnViolations) log('warn', `  [Rules] Warning: ${v.label}`);
          if (fail > 0) log('warn', `  [Rules] ${fail} request(s) failed but within acceptable thresholds — PASS`);
          log('ok', '  ✔  RULE ENGINE — All performance thresholds passed');
        }
      } else if (fail > 0) {
        finalStatus = 'failed';
      }
    }

    await db.prepare(`UPDATE execution_runs SET status=?, logs=?, report_path=?, finished_at=NOW() WHERE id=?`)
      .run(finalStatus, JSON.stringify(allLogs), reportPath, runId);

    // Mirror results (JTL, jmeter.log) to S3 right away — additive, doesn't block anything below.
    s3Sync.uploadDir(resultDir, orgSlug).then(r => {
      if (!r.ok && !r.skipped) console.error('[Execution] S3 sync failed for', resultDir, ':', r.failed?.length, 'file(s)');
    });

    // ── Auto-zip JMeter HTML report into results folder ───────────────────────
    if (engine === 'jmeter' && reportPath && fs.existsSync(path.dirname(reportPath))) {
      setImmediate(async () => {
        try {
          const reportDir = path.dirname(reportPath);
          const runNum    = (resultDir.match(/Run_(\d+)/) || [])[1] || runId;
          const zipPath   = path.join(resultDir, `JMeter_Report_Run_${runNum}.zip`);
          const { ZipArchive } = require('archiver');
          await new Promise((resolve, reject) => {
            const output  = fs.createWriteStream(zipPath);
            const archive = new ZipArchive({ zlib: { level: 6 } });
            output.on('close', resolve);
            archive.on('error', reject);
            archive.pipe(output);
            archive.directory(reportDir, false);
            archive.finalize();
          });
          log('info', `  Report ZIP : ${zipPath}`);
          const up = await s3Sync.uploadFile(zipPath, orgSlug);
          if (!up.ok && !up.skipped) console.error('[Execution] S3 sync failed for', zipPath, ':', up.error?.message);
        } catch (e) {
          console.error('[Execution] Failed to zip JMeter report:', e.message);
        }
      });
    }

    // Trigger auto healer only when rules say the run actually failed
    const shouldHeal = auto_heal && finalStatus === 'failed';

    // ── Email alert logic ──────────────────────────────────────────────────────
    // • Passed run              → send immediately for this run
    // • Failed + auto-heal ON   → defer until healer finishes (1 attempt);
    //                             send for the healed run if successful,
    //                             or the final failed run if the attempt is exhausted
    // • Failed + auto-heal OFF  → send immediately with failed status
    const sendEmailForRun = async (targetRunId) => {
      console.log(`[Alerts] sendEmailForRun started for run #${targetRunId}`);
      try {
        const { sendAlertEmail } = require('../utils/emailUtils');
        const { generateAnalyticsPdfToFile } = require('../utils/generateAnalyticsPdf');

        const runRow = await db.prepare(`
          SELECT r.*, s.name AS suite_name
          FROM execution_runs r LEFT JOIN test_suites s ON s.id = r.suite_id
          WHERE r.id = ?
        `).get(targetRunId);
        if (!runRow) return;

        const jtlPath = path.join(runRow.result_dir || '', 'results.jtl');
        console.log('[Alerts] Checking JTL at:', jtlPath);
        if (!fs.existsSync(jtlPath)) {
          console.warn('[Alerts] JTL not found at:', jtlPath, '— result_dir:', runRow.result_dir);
          return;
        }
        console.log('[Alerts] JTL found, building report data for email...');

        const runMeta = {
          run_id: runRow.id, suite_name: runRow.suite_name || 'Test Plan',
          engine: runRow.engine, status: runRow.status,
          started_at: runRow.started_at, finished_at: runRow.finished_at,
        };
        const parsed = parseJtl(jtlPath, runMeta);
        if (!parsed) return;

        // Evaluate rules against this run's JTL so violations appear in the email
        let ruleViolationsForEmail = [];
        try {
          const rr = await evaluateRules(runRow.project_id, jtlPath);
          ruleViolationsForEmail = rr?.violations || [];
        } catch (_) {}

        const reportData = { ...parsed, rule_violations: ruleViolationsForEmail };

        // Cache parsed data so Analytics page never needs to re-read the JTL
        try {
          await db.prepare('UPDATE execution_runs SET report_data=? WHERE id=?')
            .run(JSON.stringify(parsed), targetRunId);
        } catch (_) {}

        // Generate PDF — save to result_dir for permanent storage AND send via email
        let pdfPath = null;
        try {
          const runNum    = (runRow.result_dir || '').match(/Run_(\d+)/)?.[1] || runRow.id;
          const suiteName = (runRow.suite_name || 'Analytics').replace(/[^a-zA-Z0-9_-]/g, '_');
          // Primary: save directly to result_dir so it persists
          const resultPdf = runRow.result_dir && fs.existsSync(runRow.result_dir)
            ? path.join(runRow.result_dir, `${suiteName}_Run${runNum}_Analytics.pdf`)
            : path.join(os.tmpdir(), `PerfStudio_run_${targetRunId}_${Date.now()}.pdf`);
          await generateAnalyticsPdfToFile(reportData, runNum, resultPdf);
          pdfPath = resultPdf;
          console.log('[Alerts] Analytics PDF saved:', pdfPath);
          if (runRow.result_dir && fs.existsSync(runRow.result_dir)) {
            const up = await s3Sync.uploadFile(pdfPath, orgSlug);
            if (!up.ok && !up.skipped) console.error('[Alerts] S3 sync failed for', pdfPath, ':', up.error?.message);
          }
        } catch (pdfErr) {
          console.error('[Alerts] PDF generation failed:', pdfErr.message);
        }

        // JMeter HTML report dir — use the target run's result_dir
        const targetResultDir = runRow.result_dir || '';
        const htmlDir = path.join(targetResultDir, 'report');
        const htmlDirExists = fs.existsSync(htmlDir);
        if (htmlDirExists) console.log('[Alerts] HTML report dir:', htmlDir);

        await sendAlertEmail(targetRunId, req.userId, project_id, reportData, pdfPath, htmlDirExists ? htmlDir : null);
      } catch (e) {
        console.error('[Alerts] Error sending alert email:', e.message);
      }
    };

    // PDF is saved inside sendEmailForRun which builds the full reportData
    // (with by_api, timeline, errors) required by generateAnalyticsPdfToFile.
    // The separate minimal-reportData approach was removed because it crashed.

    if (shouldHeal) {
      log('warn', '');
      log('warn', '[Auto Healer] Starting automatic diagnosis and repair...');
      startAutoHeal(req.userId, runId, (finalRunId, succeeded) => {
        console.log(`[Alerts] Auto-heal finished. Final run: ${finalRunId}, succeeded: ${succeeded}`);
        log('info', `[Alerts] Sending ${succeeded ? 'success' : 'failure'} report email for run ${finalRunId}`);
        sendEmailForRun(finalRunId);
      });
    } else {
      setImmediate(() => sendEmailForRun(runId));
    }


    return done({ ok: true, run_id: runId, result_dir: resultDir, auto_heal: shouldHeal });

  } catch (err) {
    log('err', '');
    log('err', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    log('err', `  ✘  TEST EXECUTION FAILED`);
    log('err', `  Error: ${err.message}`);
    log('err', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    await db.prepare(`UPDATE execution_runs SET status='failed', logs=?, finished_at=NOW() WHERE id=?`)
      .run(JSON.stringify(allLogs), runId);
    if (auto_heal) {
      log('warn', '');
      log('warn', '[Auto Healer] Test failed — starting automatic diagnosis and repair...');
      startAutoHeal(req.userId, runId);
    }
    return done({ ok: false, error: err.message, run_id: runId, auto_heal: !!auto_heal });
  } finally {
    clearInterval(heartbeat);
    if (patchedJmx) try { fs.unlinkSync(patchedJmx); } catch {}
  }
});

router.get('/runs', auth, async (req, res) => {
  const { project_id } = req.query;
  if (!project_id) return res.status(400).json({ error: 'project_id is required' });

  const project = await ownsProject(req.userId, project_id);
  if (!project) return res.status(403).json({ error: 'Forbidden' });

  cleanStaleRuns(project_id);

  // Background: sync any completed CI runs that don't have an execution_runs record yet.
  // Returns syncing_count so the frontend knows to poll again shortly.
  let syncingCount = 0;
  try {
    // Only auto-sync runs finished within the last 7 days — older ones likely
    // have expired artifacts and must not trigger email notifications retroactively.
    // Includes 'failed' as well as 'completed' — a genuinely failed CI job (JMeter crashed,
    // pipeline errored) still deserves its own sync attempt (which will correctly find no
    // results and mark no_results below, or record real partial results if some exist) — the
    // ci/:runId/status route's own catch-up already treats 'completed' and 'failed' the same
    // way; this mirrors that. Excludes no_results=1: a prior sync attempt already confirmed
    // this run produced zero JMeter samples/artifacts — nothing real to show in Analytics, and
    // without this exclusion it looked identical to "never tried syncing" and got retried on
    // every single page load forever, which is what kept the "Syncing…" banner stuck.
    const unsyncedCiRuns = await db.prepare(`
      SELECT * FROM ci_pipeline_runs
      WHERE project_id = ? AND status IN ('completed', 'failed')
        AND (no_results = 0 OR no_results IS NULL)
        AND finished_at >= NOW() - INTERVAL '7 days'
        AND NOT EXISTS (SELECT 1 FROM execution_runs WHERE ci_run_id = ci_pipeline_runs.id)
    `).all(project_id);

    syncingCount = unsyncedCiRuns.length;
    if (syncingCount > 0) {
      console.log(`[Auto-sync] Found ${syncingCount} unsynced CI run(s) for project ${project_id}`);
      const http = require('http');
      const authHeader = req.headers.authorization || '';
      for (const ciRun of unsyncedCiRuns) {
        const options = {
          method: 'POST',
          host: 'localhost',
          port: 3001,
          // suppress_email=true: auto-sync is retrospective; never spam old-run alerts
          path: `/api/projects/${project_id}/ci/runs/${ciRun.id}/sync-results?suppress_email=true`,
          headers: { Authorization: authHeader, 'Content-Type': 'application/json', 'Content-Length': 0 },
        };
        const syncReq = http.request(options, syncRes => {
          let data = '';
          syncRes.on('data', c => data += c);
          syncRes.on('end', () => console.log(`[Auto-sync] CI run #${ciRun.id} → HTTP ${syncRes.statusCode}`));
        });
        syncReq.on('error', e => console.warn(`[Auto-sync] CI run #${ciRun.id} failed: ${e.message}`));
        syncReq.end();
      }
    }
  } catch (e) {
    console.warn('[Auto-sync] Background check error:', e.message);
  }

  const includeArchived = req.query.include_archived === 'true';
  const runs = await db.prepare(`
    SELECT r.*, s.name as suite_name, s.env as suite_env, s.collection_id as collection_id,
           ci.web_url as ci_web_url, ci.provider as ci_provider, ci.external_id as ci_external_id
    FROM execution_runs r
    LEFT JOIN test_suites s ON s.id = r.suite_id
    LEFT JOIN ci_pipeline_runs ci ON ci.id = r.ci_run_id
    WHERE r.project_id = ? AND (r.archived = 0 OR r.archived IS NULL OR ? = 1)
    ORDER BY r.started_at DESC
  `).all(project_id, includeArchived ? 1 : 0);

  const { GIT_WORKSPACES_ROOT } = require('../utils/projectFolders');
  const parsed = runs.map(r => {
    let report_url = null;
    if (r.report_path && fs.existsSync(r.report_path)) {
      // Use lower-case comparison to handle Windows case-insensitive paths
      const absReport  = path.resolve(r.report_path).toLowerCase().replace(/\\/g, '/');
      const absWS      = path.resolve(GIT_WORKSPACES_ROOT).toLowerCase().replace(/\\/g, '/');
      const absAdmin   = path.resolve(PROJECTS_ROOT).toLowerCase().replace(/\\/g, '/');
      if (absReport.startsWith(absWS)) {
        const rel = path.relative(path.resolve(GIT_WORKSPACES_ROOT), path.resolve(r.report_path)).replace(/\\/g, '/');
        report_url = `/workspace-files/${rel}`;
      } else if (absReport.startsWith(absAdmin)) {
        const rel = path.relative(path.resolve(PROJECTS_ROOT), path.resolve(r.report_path)).replace(/\\/g, '/');
        report_url = `/projects-files/${rel}`;
      } else {
        // Absolute path outside known roots — serve relative to GIT_WORKSPACES_ROOT as best-effort
        try {
          const rel = path.relative(path.resolve(GIT_WORKSPACES_ROOT), path.resolve(r.report_path)).replace(/\\/g, '/');
          if (!rel.startsWith('..')) report_url = `/workspace-files/${rel}`;
        } catch {}
      }
    }
    return { ...r, logs: JSON.parse(r.logs || '[]'), report_url, heal_status: r.heal_status, heal_run_id: r.heal_run_id };
  });
  res.json({ runs: parsed, syncing_count: syncingCount });
});

// ── Delete / archive a run ────────────────────────────────────────────────────
// delete_files=true  → hard delete (wipe disk files + remove DB record, unrecoverable)
// delete_files=false → soft delete (set archived=1, hide from list, fully recoverable)
router.delete('/runs/:id', auth, async (req, res) => {
  const run = await db.prepare('SELECT * FROM execution_runs WHERE id = ?').get(req.params.id);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  if (!await ownsProject(req.userId, run.project_id)) return res.status(403).json({ error: 'Forbidden' });
  if (run.status === 'running') return res.status(400).json({ error: 'Cannot delete a run that is currently in progress' });

  if (req.query.delete_files === 'true') {
    // Hard delete — wipe stored results then remove the record. Everything under
    // result_dir has been S3-only since the resultsStore.js migration (no local file ever
    // exists, not even transiently) — the old fs.rmSync-only version left every hard-deleted
    // run's JTL/report/PDF orphaned in S3 forever, since result_dir there is a path-SHAPED
    // string, not a real directory (fs.existsSync was always false, silently no-opping).
    if (run.result_dir) {
      try {
        const orgSlugDel = await resolveOrgSlugForProject(run.project_id);
        const del = await resultsStore.deleteAll(run.result_dir, orgSlugDel);
        if (!del.ok && !del.skipped) console.error('[Execution] S3 delete failed for run', run.id, ':', del.error?.message);
      } catch (e) { console.error('[Execution] Result cleanup failed for run', run.id, ':', e.message); }
    }
    await db.prepare('DELETE FROM execution_runs WHERE id = ?').run(run.id);
    res.json({ deleted: true, archived: false, id: run.id });
  } else {
    // Soft delete — archive only; disk files and DB record are preserved for recovery
    await db.prepare('UPDATE execution_runs SET archived=1 WHERE id=?').run(run.id);
    res.json({ deleted: false, archived: true, id: run.id });
  }
});

// ── Restore a soft-deleted (archived) run ────────────────────────────────────
router.patch('/runs/:id/restore', auth, async (req, res) => {
  const run = await db.prepare('SELECT * FROM execution_runs WHERE id = ?').get(req.params.id);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  if (!await ownsProject(req.userId, run.project_id)) return res.status(403).json({ error: 'Forbidden' });
  await db.prepare('UPDATE execution_runs SET archived=0 WHERE id=?').run(run.id);
  res.json({ restored: true, id: run.id });
});

router.get('/runs/:id/heal-status', auth, async (req, res) => {
  const run = await db.prepare('SELECT r.project_id FROM execution_runs r WHERE r.id = ?').get(req.params.id);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  if (!await ownsProject(req.userId, run.project_id)) return res.status(403).json({ error: 'Forbidden' });
  const result = getHealStatus(req.params.id);
  if (!result) return res.status(404).json({ error: 'No heal data' });
  res.json(result);
});

// Restores a project's workspace (script/config/testData/results) if the S3 sweep reclaimed
// it since the last access. Most routes below serve from the DB-cached report_data/report
// columns first and only fall back to these local files when that cache is empty — so this
// is a rare cold path in practice, not something every report view pays for.
async function hydrateProjectWorkspace(projectId, userId) {
  try {
    const proj = await db.prepare('SELECT folder_path FROM projects WHERE id = ?').get(projectId);
    if (proj?.folder_path) await require('./git').ensureGitWorkspaceHydrated(proj.folder_path, projectId, userId);
  } catch (e) { console.error('[Execution] Workspace hydrate failed for project', projectId, ':', e.message); }
}

router.get('/runs/:id/report-data', auth, async (req, res) => {
  const run = await db.prepare(`
    SELECT r.*, s.name as suite_name
    FROM execution_runs r
    LEFT JOIN test_suites s ON s.id = r.suite_id
    WHERE r.id = ?
  `).get(req.params.id);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  if (!await ownsProject(req.userId, run.project_id)) return res.status(403).json({ error: 'Forbidden' });
  if (run.engine !== 'jmeter') return res.status(400).json({ error: 'Custom analytics only available for JMeter runs' });

  const storedLogs = JSON.parse(run.logs || '[]');

  // ── serve from DB cache if available ──────────────────────────────────────
  if (run.report_data) {
    try {
      const cached = JSON.parse(run.report_data);
      // Backfill timing fields from DB row — CI sync may have stored meta without them
      if (cached.meta) {
        if (!cached.meta.finished_at && run.finished_at) cached.meta.finished_at = run.finished_at;
        if (!cached.meta.started_at  && run.started_at)  cached.meta.started_at  = run.started_at;
        if (!(cached.meta.duration_s > 0) && run.finished_at && run.started_at) {
          const ms = new Date(run.finished_at.replace(' ', 'T') + 'Z') - new Date(run.started_at.replace(' ', 'T') + 'Z');
          if (ms > 0) cached.meta.duration_s = Math.round(ms / 1000);
        }
      }
      return res.json({ ...cached, logs: storedLogs });
    } catch (_) { /* corrupt cache — fall through to disk */ }
  }

  // ── fall back to S3, then cache the result ───────────────────────────────
  const orgSlug0 = run.result_dir ? await resolveOrgSlugForProject(run.project_id) : null;
  const jtlText = run.result_dir ? await resultsStore.readText(run.result_dir, orgSlug0, 'results.jtl') : null;
  if (!jtlText) {
    return res.status(404).json({
      error: 'not_cached',
      message: 'Report data is not available. Re-sync results from the CI pipeline to regenerate.',
      ci_run_id: run.ci_run_id || null,
    });
  }

  const runMeta = {
    run_id:      run.id,
    suite_name:  run.suite_name || 'Unknown',
    engine:      run.engine,
    status:      run.status,
    started_at:  run.started_at,
    finished_at: run.finished_at,
  };
  const parsed = parseJtlContent(jtlText, runMeta);
  if (!parsed) return res.status(400).json({ error: 'JTL file contains no data rows' });

  // Backfill cache so next request is instant
  try {
    await db.prepare('UPDATE execution_runs SET report_data=? WHERE id=?')
      .run(JSON.stringify(parsed), run.id);
  } catch (_) {}

  return res.json({ ...parsed, logs: storedLogs });
});

// ── Export analytics as a real server-side PDF ────────────────────────────────
router.get('/runs/:id/export-pdf', auth, async (req, res) => {
  const run = await db.prepare(`
    SELECT r.*, s.name as suite_name
    FROM execution_runs r
    LEFT JOIN test_suites s ON s.id = r.suite_id
    WHERE r.id = ?
  `).get(req.params.id);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  if (!await ownsProject(req.userId, run.project_id)) return res.status(403).json({ error: 'Forbidden' });
  if (run.engine !== 'jmeter') return res.status(400).json({ error: 'PDF export only available for JMeter runs' });

  // ── resolve report data (DB cache → disk fallback) ─────────────────────────
  let reportData = null;
  if (run.report_data) {
    try { reportData = JSON.parse(run.report_data); } catch (_) {}
  }
  if (!reportData) {
    const orgSlug1 = run.result_dir ? await resolveOrgSlugForProject(run.project_id) : null;
    const jtlText = run.result_dir ? await resultsStore.readText(run.result_dir, orgSlug1, 'results.jtl') : null;
    if (!jtlText) {
      return res.status(404).json({ error: 'JTL results file not found and no cached report data available' });
    }
    const runMeta = {
      run_id: run.id, suite_name: run.suite_name || 'Unknown', engine: run.engine,
      status: run.status, started_at: run.started_at, finished_at: run.finished_at,
    };
    reportData = parseJtlContent(jtlText, runMeta);
    if (!reportData) return res.status(400).json({ error: 'JTL file contains no data rows' });
    // Backfill cache
    try { await db.prepare('UPDATE execution_runs SET report_data=? WHERE id=?').run(JSON.stringify(reportData), run.id); } catch (_) {}
  }

  const runNum    = (run.result_dir?.match(/Run_(\d+)/) || [])[1] || run.id;
  const suiteName = (run.suite_name || 'Analytics').replace(/[^a-zA-Z0-9_-]/g, '_');
  const pdfFilename = `${suiteName}_Run${runNum}_Analytics.pdf`;

  // Stream PDF to browser
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${pdfFilename}"`);
  await generateAnalyticsPdf(reportData, runNum, res);
});

router.get('/runs/:id/download-report', auth, async (req, res) => {
  const run = await db.prepare(`
    SELECT r.*, s.name as suite_name
    FROM execution_runs r
    LEFT JOIN test_suites s ON s.id = r.suite_id
    WHERE r.id = ?
  `).get(req.params.id);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  if (!await ownsProject(req.userId, run.project_id)) return res.status(403).json({ error: 'Forbidden' });
  if (!run.result_dir) return res.status(404).json({ error: 'No results recorded for this run' });

  const orgSlug = await resolveOrgSlugForProject(run.project_id);
  const reportFiles = await resultsStore.listFiles(run.result_dir, orgSlug, 'report');
  if (!reportFiles.length) {
    return res.status(404).json({ error: `Report directory not found for run ${run.id}` });
  }

  const runNum = (run.result_dir.match(/Run_(\d+)/) || [])[1] || run.id;
  const zipName = `JMeter_Report_Run_${runNum}.zip`;

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);

  const archive = new ZipArchive({ zlib: { level: 6 } });
  archive.on('error', err => { console.error('Archive error:', err); res.status(500).end(); });
  archive.pipe(res);
  for (const relPath of reportFiles) {
    const buf = await resultsStore.readFile(run.result_dir, orgSlug, relPath);
    if (buf) archive.append(buf, { name: relPath.replace(/^report\//, '') });
  }
  archive.finalize();
});

// ── Patch jmeter.properties to enable latency + bytes recording ──────────────
router.post('/jmeter/enable-latency', auth, async (req, res) => {
  // RETIRED — local/native test execution is no longer supported; CI-pipeline execution only.
  return res.status(410).json({ error: 'Local test execution has been retired. Run tests via the CI pipeline instead.' });
  const cfgRow = await db.prepare('SELECT config_json FROM global_config WHERE user_id = ?').get(req.userId);
  const savedCfg = cfgRow ? JSON.parse(cfgRow.config_json || '{}') : {};

  // Use stored path directly if valid, otherwise fall back to getJMeterBin() discovery
  let binDir;
  const storedPath = savedCfg.jmeter_path;
  if (storedPath && fs.existsSync(storedPath)) {
    binDir = fs.statSync(storedPath).isDirectory() ? storedPath : path.dirname(storedPath);
  } else {
    const discovered = getJMeterBin(storedPath);
    if (!discovered) {
      return res.status(404).json({ error: 'JMeter installation not found. Set the path in Configuration → Tool Paths and save.' });
    }
    binDir = path.dirname(discovered);
  }

  const propsPath = path.join(binDir, 'jmeter.properties');

  if (!fs.existsSync(propsPath)) {
    return res.status(404).json({ error: `jmeter.properties not found at: ${propsPath}` });
  }

  const PROPS = {
    'jmeter.save.saveservice.latency':      'true',
    'jmeter.save.saveservice.connect_time': 'true',
    'jmeter.save.saveservice.bytes':        'true',
    'jmeter.save.saveservice.sent_bytes':   'true',
  };

  let content = fs.readFileSync(propsPath, 'utf8');
  const changed = [];

  for (const [key, value] of Object.entries(PROPS)) {
    // Match the line whether it is active or commented out, with any existing value
    const activeRe   = new RegExp(`^(${key.replace(/\./g, '\\.')}\\s*=.*)$`, 'm');
    const commentedRe= new RegExp(`^#\\s*(${key.replace(/\./g, '\\.')}\\s*=.*)$`, 'm');
    const desired = `${key}=${value}`;

    if (activeRe.test(content)) {
      const before = content.match(activeRe)[0];
      content = content.replace(activeRe, desired);
      if (before !== desired) changed.push(key);
    } else if (commentedRe.test(content)) {
      content = content.replace(commentedRe, desired);
      changed.push(key);
    } else {
      content += `\n${desired}\n`;
      changed.push(key);
    }
  }

  fs.writeFileSync(propsPath, content, 'utf8');
  res.json({ ok: true, path: propsPath, changed });
});

// ── Check whether jmeter.properties already has latency props set ─────────────
router.get('/jmeter/latency-status', auth, async (req, res) => {
  // RETIRED — local/native test execution is no longer supported; CI-pipeline execution only.
  return res.status(410).json({ error: 'Local test execution has been retired. Run tests via the CI pipeline instead.' });
  const cfgRow = await db.prepare('SELECT config_json FROM global_config WHERE user_id = ?').get(req.userId);
  const savedCfg = cfgRow ? JSON.parse(cfgRow.config_json || '{}') : {};

  let binDir;
  const storedPath = savedCfg.jmeter_path;
  if (storedPath && fs.existsSync(storedPath)) {
    binDir = fs.statSync(storedPath).isDirectory() ? storedPath : path.dirname(storedPath);
  } else {
    const discovered = getJMeterBin(storedPath);
    if (!discovered) return res.json({ found: false });
    binDir = path.dirname(discovered);
  }

  const propsPath = path.join(binDir, 'jmeter.properties');
  if (!fs.existsSync(propsPath)) return res.json({ found: false });

  const content = fs.readFileSync(propsPath, 'utf8');
  const PROPS = [
    'jmeter.save.saveservice.latency',
    'jmeter.save.saveservice.connect_time',
    'jmeter.save.saveservice.bytes',
    'jmeter.save.saveservice.sent_bytes',
  ];

  const configured = PROPS.every(key => {
    const m = content.match(new RegExp(`^${key.replace(/\./g, '\\.')}\\s*=\\s*(\\S+)`, 'm'));
    return m && m[1].toLowerCase() === 'true';
  });

  res.json({ found: true, configured, path: propsPath });
});

// ── Pull JMeter Docker image ─────────────────────────────────────────────────
router.post('/jmeter/pull-image', auth, async (req, res) => {
  // RETIRED — local/native test execution is no longer supported; CI-pipeline execution only.
  return res.status(410).json({ error: 'Local test execution has been retired. Run tests via the CI pipeline instead.' });
  const cfgRow = await db.prepare('SELECT config_json FROM global_config WHERE user_id = ?').get(req.userId);
  const savedCfg = cfgRow ? JSON.parse(cfgRow.config_json || '{}') : {};
  const image = (req.body.image || savedCfg.jmeter_docker_image || 'justb4/jmeter:latest').trim();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  if (res.socket) res.socket.setNoDelay(true);

  function sendLog(type, msg) { res.write('data: ' + JSON.stringify({ type, message: msg }) + '\n\n'); }
  function sendDone(result) { res.write('data: ' + JSON.stringify({ done: true, ...result }) + '\n\n'); res.end(); }

  // Check Docker daemon is running before attempting pull
  try {
    execSync('docker info', { timeout: 6000, stdio: 'pipe' });
  } catch (_) {
    sendLog('warn', 'Docker Desktop is not running on this machine.');
    sendLog('info', 'Local pull is only needed if you want to run tests directly on this machine.');
    sendLog('info', 'Cloud CI (GitHub Actions, GitLab CI, Bitbucket Pipelines) pulls the image automatically on the CI runner — no local Docker required.');
    sendDone({ ok: false, error: 'Docker daemon not running' });
    return;
  }

  sendLog('info', `Pulling Docker image: ${image}`);
  sendLog('info', 'This may take a few minutes on first pull...');

  const proc = spawn('docker', ['pull', image]);
  proc.stdout.on('data', d => { for (const l of d.toString().split('\n')) { if (l.trim()) sendLog('info', l.trim()); } });
  proc.stderr.on('data', d => { for (const l of d.toString().split('\n')) { if (l.trim()) sendLog('info', l.trim()); } });
  proc.on('close', code => {
    if (code === 0) { sendLog('ok', `Image ready: ${image}`); sendDone({ ok: true }); }
    else { sendLog('err', `docker pull exited with code ${code}`); sendDone({ ok: false, error: `Exit code ${code}` }); }
  });
  proc.on('error', err => sendDone({ ok: false, error: err.message }));
});

module.exports = router;
