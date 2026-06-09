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
const { getProjectPath, PROJECTS_ROOT } = require('../utils/projectFolders');
const { generateAnalyticsPdf } = require('../utils/generateAnalyticsPdf');
const { startAutoHeal, getHealStatus } = require('../utils/autoHealer');
const { evaluateRules } = require('../utils/ruleEvaluator');
const { patchJmxForParams } = require('../utils/patchJmx');

const PERFSTUDIO_DIR = path.join(process.env.USERPROFILE || process.env.HOME, '.perfstudio');

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
    path.join(PERFSTUDIO_DIR, 'jmeter', 'bin', 'jmeter.bat'),
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
    path.join(PERFSTUDIO_DIR, 'k6', 'k6.exe'),
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

const resetSequence = require('../utils/resetSequence');

function cleanStaleRuns(projectId) {
  const runs = db.prepare('SELECT id, result_dir FROM execution_runs WHERE project_id = ?').all(projectId);
  let deleted = false;
  for (const run of runs) {
    if (run.result_dir && !fs.existsSync(run.result_dir)) {
      db.prepare('DELETE FROM execution_runs WHERE id = ?').run(run.id);
      deleted = true;
    }
  }
  if (deleted) resetSequence('execution_runs');
}

function getNextRunNumber(projectId) {
  cleanStaleRuns(projectId);
  // Use DB max(id) as the source of truth to avoid race conditions when
  // multiple runs start simultaneously for the same project.
  const rows = db.prepare('SELECT result_dir FROM execution_runs WHERE project_id = ?').all(projectId);
  let maxNum = 0;
  for (const r of rows) {
    const m = r.result_dir?.match(/Run_(\d+)/);
    if (m) maxNum = Math.max(maxNum, parseInt(m[1]));
  }
  return maxNum + 1;
}

const MAX_CONCURRENT_RUNS = 5; // soft cap per user

function countActiveRuns(userId) {
  // Count running/pending runs across all projects owned by this user
  return db.prepare(`
    SELECT COUNT(*) as n FROM execution_runs r
    JOIN projects p ON p.id = r.project_id
    WHERE p.user_id = ? AND r.status = 'running'
  `).get(userId)?.n || 0;
}

// Check whether we're running in native mode (JMeter/K6 in PATH) or Docker mode
function isNativeMode() {
  return process.env.EXECUTION_MODE === 'native' || !!getJMeterBin(null) || !!getK6Bin(null);
}

router.get('/check-deps', auth, (req, res) => {
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
router.get('/check-docker', auth, (req, res) => {
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
router.post('/start-docker', auth, (req, res) => {
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
router.post('/enable-virtualization', auth, (req, res) => {
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
  const cfgRow = db.prepare('SELECT config_json FROM global_config WHERE user_id = ?').get(req.userId);
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
    const exportLines = `\n# Java (set by Performance Studio)\nexport JAVA_HOME="${javaHome}"\nexport PATH="$JAVA_HOME/bin:$PATH"\n`;
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

  const project = ownsProject(req.userId, project_id);
  if (!project) { log('err', 'Access denied'); return done({ ok: false, error: 'Forbidden' }); }

  // Git repository must be initialized before running tests
  if (!project.folder_path) {
    log('err', 'Git repository not initialized');
    return done({ ok: false, error: 'Git repository not initialized. Go to Configuration → Git to initialize the repository first.' });
  }

  // Soft concurrency cap — prevent accidental resource exhaustion
  const activeCount = countActiveRuns(req.userId);
  if (activeCount >= MAX_CONCURRENT_RUNS) {
    log('err', `Too many concurrent runs (${activeCount} active). Wait for a run to finish before starting another.`);
    return done({ ok: false, error: `Too many concurrent runs. Max ${MAX_CONCURRENT_RUNS} simultaneous runs allowed.` });
  }

  const suite = db.prepare('SELECT * FROM test_suites WHERE id = ? AND project_id = ?').get(suite_id, project_id);
  if (!suite) { log('err', `Test suite not found (id=${suite_id})`); return done({ ok: false, error: 'Test suite not found' }); }

  const scriptPath = engine === 'jmeter' ? suite.jmx_path : suite.js_path;
  if (!scriptPath || !fs.existsSync(scriptPath)) {
    log('err', `Script file not found: ${scriptPath || '(not set)'}`);
    log('err', 'Go to Test Plans and generate a script first.');
    return done({ ok: false, error: 'Script file not found' });
  }

  // ── Preparation summary ──────────────────────────────────────────────────
  log('info', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log('info', '  PERFORMANCE STUDIO  —  TEST EXECUTION ENGINE');
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
  const runNumber = getNextRunNumber(project_id);

  // Results go into collection/env/results/Run_X/ — tracked per environment in git
  let resultDir;
  if (suite.collection_id && suite.env && projectFolderPath) {
    try {
      const suiteCol = db.prepare('SELECT * FROM collections WHERE id = ?').get(suite.collection_id);
      if (suiteCol) {
        const { getCollectionPath } = require('../utils/projectFolders');
        const envPath = getCollectionPath(projectFolderPath, suiteCol.name, suiteCol.id, suite.env);
        resultDir = path.join(envPath, 'results', `Run_${runNumber}`);
      }
    } catch (_) {}
  }
  // Fallback to project-level results
  if (!resultDir) resultDir = path.join(projectFolderPath, 'results', `Run_${runNumber}`);
  fs.mkdirSync(resultDir, { recursive: true });
  log('info', `  Result dir : ${resultDir}`);
  log('info', `  Run #      : ${runNumber}`);

  const runRow = db.prepare(`
    INSERT INTO execution_runs
      (project_id, suite_id, engine, status, result_dir, logs, started_at, auto_heal,
       run_vusers, run_rampup, run_duration, run_loops, run_iter_mode)
    VALUES (?, ?, ?, 'running', ?, '[]', datetime('now'), ?, ?, ?, ?, ?, ?)
  `).run(
    project_id, suite_id, engine, resultDir, auto_heal ? 1 : 0,
    vusers    || null,
    rampup    || null,
    duration  || null,
    loops     || null,
    iteration_mode || null
  );
  const runId = runRow.lastInsertRowid;

  const cfgRow = db.prepare('SELECT config_json FROM global_config WHERE user_id = ?').get(req.userId);
  const savedCfg = cfgRow ? JSON.parse(cfgRow.config_json || '{}') : {};

  let patchedJmx = null;
  // SSE keepalive — forces buffered proxies (Vite dev server, nginx, etc.) to flush
  // every second so log lines reach the browser in real-time.
  const heartbeat = setInterval(() => {
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
        ? db.prepare('SELECT * FROM collections WHERE id = ?').get(suite.collection_id)
        : null;
      const suiteEnvName = suite.env || '';

      if (suiteCollection && suiteEnvName && projectFolderPath) {
        const { getCollectionPath } = require('../utils/projectFolders');
        const envPath = getCollectionPath(projectFolderPath, suiteCollection.name, suiteCollection.id, suiteEnvName);
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
      logTailer = setInterval(() => {
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
    const { sendBreachAlertEmail } = require('../utils/emailUtils');
    const alertedRuleIds = new Set();   // track which rule IDs already fired an alert
    const testStartMs    = Date.now();
    const project        = db.prepare('SELECT * FROM projects WHERE id = ?').get(project_id);
    const suiteName      = suite?.name || 'Test Run';
    const projectName    = project?.name || '';

    // Metrics that can be meaningfully evaluated in real-time (mid-run).
    // Response Time / P95 / P90 can swing during ramp-up and only stabilise at
    // the end, so we intentionally exclude them from live monitoring.
    const LIVE_MONITOR_METRICS = new Set([
      'error rate',
      'cpu usage',
      'memory usage',
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
        newViolations.forEach(v => alertedRuleIds.add(v.rule.id));

        const elapsedSec = Math.floor((Date.now() - testStartMs) / 1000);
        log('warn', `  [Rules] ⚡ ${newViolations.length} rule breach(es) detected at ${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s — sending alert…`);
        newViolations.forEach(v => log('warn', `          ${v.label} [${v.rule.severity}]`));

        // Send breach alert email (non-blocking)
        sendBreachAlertEmail(runId, req.userId, project_id, {
          violations:    newViolations,
          suiteName,
          projectName,
          elapsedSec,
          totalDuration: duration || 0,
          runId,
        }).catch(e => console.error('[Alerts] Breach email error:', e.message));

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
      const ruleResult = evaluateRules(project_id, jtlPath);
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

    db.prepare(`UPDATE execution_runs SET status=?, logs=?, report_path=?, finished_at=datetime('now') WHERE id=?`)
      .run(finalStatus, JSON.stringify(allLogs), reportPath, runId);

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
        } catch (e) {
          console.error('[Execution] Failed to zip JMeter report:', e.message);
        }
      });
    }

    // Trigger auto healer only when rules say the run actually failed
    const shouldHeal = auto_heal && finalStatus === 'failed';

    // ── Email alert logic ──────────────────────────────────────────────────────
    // • Passed run              → send immediately for this run
    // • Failed + auto-heal ON   → defer until healer finishes (up to 3 attempts);
    //                             send for the healed run if successful,
    //                             or the final failed run if all 3 attempts exhausted
    // • Failed + auto-heal OFF  → send immediately with failed status
    const sendEmailForRun = async (targetRunId) => {
      try {
        const { sendAlertEmail }             = require('../utils/emailUtils');
        const { generateAnalyticsPdfToFile } = require('../utils/generateAnalyticsPdf');

        const runRow = db.prepare(`
          SELECT r.*, s.name AS suite_name
          FROM execution_runs r LEFT JOIN test_suites s ON s.id = r.suite_id
          WHERE r.id = ?
        `).get(targetRunId);
        if (!runRow) return;

        const jtlPath = path.join(runRow.result_dir || '', 'results.jtl');
        if (!fs.existsSync(jtlPath)) {
          console.warn('[Alerts] JTL not found, skipping email:', jtlPath);
          return;
        }

        const content = fs.readFileSync(jtlPath, 'utf8');
        const lines   = content.trim().split('\n').filter(Boolean);
        if (lines.length < 2) return;

        const HNORM = { Latency:'latency', Connect:'connect', Bytes:'bytes', SentBytes:'sentBytes' };
        const hdrs  = lines[0].split(',').map(h => { const c = h.trim().replace(/^"|"$/g,''); return HNORM[c]||c; });

        const splitCsvLine = line => {
          const cells = []; let cur = '', inQ = false;
          for (const ch of line) {
            if (ch === '"') inQ = !inQ;
            else if (ch === ',' && !inQ) { cells.push(cur.trim()); cur = ''; }
            else cur += ch;
          }
          cells.push(cur.trim()); return cells;
        };
        const parseRow = ln => { const p=splitCsvLine(ln),r={}; hdrs.forEach((h,i)=>{r[h]=(p[i]||'').replace(/^"|"$/g,'').trim();}); return r; };
        const pctFn  = (arr,p) => { if(!arr.length)return null; const s=[...arr].sort((a,b)=>a-b); return s[Math.max(0,Math.ceil(p/100*s.length)-1)]; };
        const safeMin = arr => { const v=arr.filter(n=>n>0); return v.length ? Math.min(...v) : null; };
        const safeMax = arr => { const v=arr.filter(n=>n>0); return v.length ? Math.max(...v) : null; };

        const allRows    = lines.slice(1).map(parseRow);
        const allElapsed = allRows.map(r=>parseInt(r.elapsed)||0);
        const allLat     = allRows.map(r=>parseInt(r.latency)||0);
        const allConn    = allRows.map(r=>parseInt(r.connect)||0);
        const allBytes   = allRows.map(r=>parseInt(r.bytes)||0);
        const allSentB   = allRows.map(r=>parseInt(r.sentBytes)||0);
        const totalReqs  = allRows.length;
        const totalSucc  = allRows.filter(r=>r.success==='true').length;
        const totalFail  = totalReqs - totalSucc;
        const elSum      = allElapsed.reduce((a,b)=>a+b,0);
        const tsList     = allRows.map(r=>parseInt(r.timeStamp)||0).filter(Boolean);
        const minTs2     = tsList.length ? Math.min(...tsList) : 0;
        const maxTsEnd   = tsList.length ? Math.max(...allRows.map((r,i)=>(parseInt(r.timeStamp)||0)+(allElapsed[i]||0))) : 0;
        const durS2      = tsList.length ? (maxTsEnd - minTs2)/1000 : 1;

        const byLabel = {};
        allRows.forEach(r => {
          const lbl = r.label||'Unknown';
          if (!byLabel[lbl]) byLabel[lbl]={elapsed:[],success:0,failed:0,latency:[],connect:[],bytes:[],responseCodes:{},failMessages:{}};
          const d = byLabel[lbl];
          d.elapsed.push(parseInt(r.elapsed)||0); d.latency.push(parseInt(r.latency)||0);
          d.connect.push(parseInt(r.connect)||0); d.bytes.push(parseInt(r.bytes)||0);
          if (r.success==='true') d.success++;
          else { d.failed++; const cd=r.responseCode||'unknown'; d.responseCodes[cd]=(d.responseCodes[cd]||0)+1; const mg=r.failureMessage||r.responseMessage||''; if(mg) d.failMessages[mg]=(d.failMessages[mg]||0)+1; }
        });
        const by_api = Object.entries(byLabel).map(([label,d])=>({
          label, total:d.elapsed.length, success:d.success, failed:d.failed,
          error_rate: parseFloat(((d.failed/d.elapsed.length)*100).toFixed(2)),
          avg: parseFloat((d.elapsed.reduce((a,b)=>a+b,0)/d.elapsed.length).toFixed(1)),
          min: safeMin(d.elapsed), max: safeMax(d.elapsed),
          p90: pctFn(d.elapsed,90), p95: pctFn(d.elapsed,95),
          tps: parseFloat((d.elapsed.length/durS2).toFixed(3)),
          avg_latency: parseFloat((d.latency.reduce((a,b)=>a+b,0)/d.elapsed.length).toFixed(1)),
          avg_connect: parseFloat((d.connect.reduce((a,b)=>a+b,0)/d.elapsed.length).toFixed(1)),
          avg_bytes:   parseFloat((d.bytes.reduce((a,b)=>a+b,0)/d.elapsed.length).toFixed(0)),
          response_codes: d.responseCodes, fail_messages: d.failMessages,
        }));

        const tlMap = {};
        allRows.forEach((r,i) => {
          const sec = Math.floor(((parseInt(r.timeStamp)||0) - minTs2)/1000);
          if (!tlMap[sec]) tlMap[sec]={count:0,elapsed:[],latency:[],connect:[],bytes:0,sentBytes:0,threads:[],errors:0};
          const t=tlMap[sec];
          t.count++; t.elapsed.push(allElapsed[i]); t.latency.push(allLat[i]); t.connect.push(allConn[i]);
          t.bytes+=allBytes[i]; t.sentBytes+=allSentB[i]; t.threads.push(parseInt(r.allThreads)||0);
          if (r.success!=='true') t.errors++;
        });
        const timeline = Object.entries(tlMap).sort(([a],[b])=>+a-+b).map(([sec,d])=>({
          second:+sec, tps:d.count,
          avg_rt: parseFloat((d.elapsed.reduce((a,b)=>a+b,0)/d.elapsed.length).toFixed(1)),
          avg_latency: parseFloat((d.latency.reduce((a,b)=>a+b,0)/d.latency.length).toFixed(1)),
          avg_connect: parseFloat((d.connect.reduce((a,b)=>a+b,0)/d.connect.length).toFixed(1)),
          bytes_received:d.bytes, bytes_sent:d.sentBytes,
          threads: d.threads.length ? Math.max(...d.threads) : 0, errors:d.errors,
          error_rate: parseFloat(((d.errors/d.count)*100).toFixed(1)),
        }));

        const summary = {
          total_requests:totalReqs, total_success:totalSucc, total_failed:totalFail,
          error_rate: parseFloat(((totalFail/totalReqs)*100).toFixed(2)),
          avg_response_time: parseFloat((elSum/(totalReqs||1)).toFixed(1)),
          overall_tps: parseFloat((totalReqs/durS2).toFixed(3)),
          p90: pctFn(allElapsed,90), p95: pctFn(allElapsed,95),
          min_response_time: safeMin(allElapsed), max_response_time: safeMax(allElapsed),
          avg_latency: parseFloat((allLat.reduce((a,b)=>a+b,0)/(totalReqs||1)).toFixed(1)),
          avg_connect: parseFloat((allConn.reduce((a,b)=>a+b,0)/(totalReqs||1)).toFixed(1)),
          total_bytes_received: allBytes.reduce((a,b)=>a+b,0),
          total_bytes_sent: allSentB.reduce((a,b)=>a+b,0),
        };

        const errMap = {};
        allRows.filter(r=>r.success!=='true').forEach(r => {
          const k=`${r.label}||${r.responseCode||'N/A'}`;
          if (!errMap[k]) errMap[k]={label:r.label||'Unknown',response_code:r.responseCode||'N/A',response_message:(r.responseMessage||'').slice(0,120),failure_message:(r.failureMessage||'').slice(0,200),count:0};
          errMap[k].count++;
        });

        const reportData = {
          meta: {
            run_id: runRow.id, suite_name: runRow.suite_name || 'Test Plan',
            engine: runRow.engine, status: runRow.status,
            started_at: runRow.started_at, finished_at: runRow.finished_at,
            duration_s: parseFloat(durS2.toFixed(1)),
          },
          summary, by_api, timeline, errors: Object.values(errMap), logs: [],
        };

        // Generate PDF — save to result_dir for permanent storage AND send via email
        let pdfPath = null;
        try {
          const runNum    = (runRow.result_dir || '').match(/Run_(\d+)/)?.[1] || runRow.id;
          const suiteName = (runRow.suite_name || 'Analytics').replace(/[^a-zA-Z0-9_-]/g, '_');
          // Primary: save directly to result_dir so it persists
          const resultPdf = runRow.result_dir && fs.existsSync(runRow.result_dir)
            ? path.join(runRow.result_dir, `${suiteName}_Run${runNum}_Analytics.pdf`)
            : path.join(os.tmpdir(), `perfstudio_run_${targetRunId}_${Date.now()}.pdf`);
          await generateAnalyticsPdfToFile(reportData, runNum, resultPdf);
          pdfPath = resultPdf;
          console.log('[Alerts] Analytics PDF saved:', pdfPath);
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

    if (shouldHeal) {
      log('warn', '');
      log('warn', '[Auto Healer] Starting automatic diagnosis and repair...');
      // Pass onComplete so email waits for final result
      startAutoHeal(req.userId, runId, (finalRunId, succeeded) => {
        console.log(`[Alerts] Auto-heal finished. Final run: ${finalRunId}, succeeded: ${succeeded}`);
        log('info', `[Alerts] Sending ${succeeded ? 'success' : 'failure'} report email for run ${finalRunId}`);
        sendEmailForRun(finalRunId);
      });
    } else {
      // No auto-heal — send immediately (passed or failed without healer)
      setImmediate(() => sendEmailForRun(runId));
    }


    return done({ ok: true, run_id: runId, result_dir: resultDir, auto_heal: shouldHeal });

  } catch (err) {
    log('err', '');
    log('err', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    log('err', `  ✘  TEST EXECUTION FAILED`);
    log('err', `  Error: ${err.message}`);
    log('err', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    db.prepare(`UPDATE execution_runs SET status='failed', logs=?, finished_at=datetime('now') WHERE id=?`)
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

router.get('/runs', auth, (req, res) => {
  const { project_id } = req.query;
  if (!project_id) return res.status(400).json({ error: 'project_id is required' });

  const project = ownsProject(req.userId, project_id);
  if (!project) return res.status(403).json({ error: 'Forbidden' });

  cleanStaleRuns(project_id);

  const runs = db.prepare(`
    SELECT r.*, s.name as suite_name, s.env as suite_env, s.collection_id as collection_id
    FROM execution_runs r
    LEFT JOIN test_suites s ON s.id = r.suite_id
    WHERE r.project_id = ?
    ORDER BY r.started_at DESC
  `).all(project_id);

  const parsed = runs.map(r => {
    let report_url = null;
    if (r.report_path && fs.existsSync(r.report_path)) {
      const rel = path.relative(PROJECTS_ROOT, r.report_path).replace(/\\/g, '/');
      report_url = `/projects-files/${rel}`;
    }
    return { ...r, logs: JSON.parse(r.logs || '[]'), report_url, heal_status: r.heal_status, heal_run_id: r.heal_run_id };
  });
  res.json({ runs: parsed });
});

router.get('/runs/:id/heal-status', auth, (req, res) => {
  const run = db.prepare('SELECT r.project_id FROM execution_runs r WHERE r.id = ?').get(req.params.id);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  if (!ownsProject(req.userId, run.project_id)) return res.status(403).json({ error: 'Forbidden' });
  const result = getHealStatus(req.params.id);
  if (!result) return res.status(404).json({ error: 'No heal data' });
  res.json(result);
});

router.get('/runs/:id/report-data', auth, (req, res) => {
  const run = db.prepare(`
    SELECT r.*, s.name as suite_name
    FROM execution_runs r
    LEFT JOIN test_suites s ON s.id = r.suite_id
    WHERE r.id = ?
  `).get(req.params.id);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  if (!ownsProject(req.userId, run.project_id)) return res.status(403).json({ error: 'Forbidden' });
  if (run.engine !== 'jmeter') return res.status(400).json({ error: 'Custom analytics only available for JMeter runs' });

  const jtlPath = path.join(run.result_dir, 'results.jtl');
  if (!fs.existsSync(jtlPath)) return res.status(404).json({ error: 'JTL results file not found for this run' });

  const content = fs.readFileSync(jtlPath, 'utf8');
  const lines = content.trim().split('\n').filter(Boolean);
  if (lines.length < 2) return res.status(400).json({ error: 'JTL file contains no data rows' });

  // JMeter may capitalize some column names (e.g. Latency, Connect) — normalize them
  const HEADER_NORM = { 'Latency': 'latency', 'Connect': 'connect', 'Bytes': 'bytes', 'SentBytes': 'sentBytes' };
  const headers = lines[0].split(',').map(h => {
    const clean = h.trim().replace(/^"|"$/g, '');
    return HEADER_NORM[clean] || clean;
  });

  function parseRow(line) {
    const parts = line.split(',');
    const row = {};
    headers.forEach((h, i) => { row[h] = (parts[i] || '').replace(/^"|"$/g, '').trim(); });
    return row;
  }

  function pct(arr, p) {
    if (!arr.length) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
  }

  const byLabel = {};
  let minTs = Infinity, maxTs = -Infinity;

  for (let i = 1; i < lines.length; i++) {
    const row = parseRow(lines[i]);
    const ts = parseInt(row.timeStamp) || 0;
    const elapsed = parseInt(row.elapsed) || 0;
    const success = row.success === 'true';
    const label = row.label || 'Unknown';

    if (ts < minTs) minTs = ts;
    if (ts + elapsed > maxTs) maxTs = ts + elapsed;

    if (!byLabel[label]) byLabel[label] = {
      elapsed: [], timestamps: [], latency: [], connect: [],
      bytes: [], sentBytes: [], success: 0, failed: 0,
      responseCodes: {}, failMessages: {},
    };
    const d = byLabel[label];
    d.elapsed.push(elapsed);
    d.timestamps.push(ts);
    d.latency.push(parseInt(row.latency) || 0);
    d.connect.push(parseInt(row.connect) || 0);
    d.bytes.push(parseInt(row.bytes) || 0);
    d.sentBytes.push(parseInt(row.sentBytes) || 0);
    if (success) {
      d.success++;
    } else {
      d.failed++;
      const code = row.responseCode || 'unknown';
      const msg  = row.failureMessage || row.responseMessage || '';
      d.responseCodes[code] = (d.responseCodes[code] || 0) + 1;
      if (msg) d.failMessages[msg] = (d.failMessages[msg] || 0) + 1;
    }
  }

  const totalDuration = minTs < maxTs ? (maxTs - minTs) / 1000 : 1;

  const by_api = Object.entries(byLabel).map(([label, d]) => {
    const total = d.elapsed.length;
    const sum = d.elapsed.reduce((a, b) => a + b, 0);
    const latSum = d.latency.reduce((a, b) => a + b, 0);
    const connSum = d.connect.reduce((a, b) => a + b, 0);
    const bytesSum = d.bytes.reduce((a, b) => a + b, 0);
    return {
      label,
      total,
      success: d.success,
      failed: d.failed,
      error_rate: parseFloat(((d.failed / total) * 100).toFixed(2)),
      avg: parseFloat((sum / total).toFixed(1)),
      min: d.elapsed.reduce((a, b) => Math.min(a, b), Infinity) || 0,
      max: d.elapsed.reduce((a, b) => Math.max(a, b), 0),
      median: pct(d.elapsed, 50),
      p90: pct(d.elapsed, 90),
      p95: pct(d.elapsed, 95),
      tps: parseFloat((total / totalDuration).toFixed(3)),
      avg_latency: parseFloat((latSum / total).toFixed(1)),
      avg_connect: parseFloat((connSum / total).toFixed(1)),
      avg_bytes: parseFloat((bytesSum / total).toFixed(0)),
      response_codes: d.responseCodes,
      fail_messages: d.failMessages,
    };
  });

  const allRows = [];
  for (let i = 1; i < lines.length; i++) allRows.push(parseRow(lines[i]));
  const totalRequests = allRows.length;
  const totalSuccess = allRows.filter(r => r.success === 'true').length;
  const totalFailed = totalRequests - totalSuccess;
  const allElapsed  = allRows.map(r => parseInt(r.elapsed)   || 0);
  const allLatency  = allRows.map(r => parseInt(r.latency)   || 0);
  const allConnect  = allRows.map(r => parseInt(r.connect)   || 0);
  const allBytes    = allRows.map(r => parseInt(r.bytes)     || 0);
  const allSentBytes= allRows.map(r => parseInt(r.sentBytes) || 0);
  const elapsedSum  = allElapsed.reduce((a, b) => a + b, 0);

  const summary = {
    total_requests: totalRequests,
    total_success: totalSuccess,
    total_failed: totalFailed,
    error_rate: parseFloat(((totalFailed / totalRequests) * 100).toFixed(2)),
    avg_response_time: parseFloat((elapsedSum / (totalRequests || 1)).toFixed(1)),
    overall_tps: parseFloat((totalRequests / totalDuration).toFixed(3)),
    p90: pct(allElapsed, 90),
    p95: pct(allElapsed, 95),
    min_response_time: allElapsed.reduce((a, b) => Math.min(a, b), Infinity) || 0,
    max_response_time: allElapsed.reduce((a, b) => Math.max(a, b), 0),
    avg_latency: parseFloat((allLatency.reduce((a, b) => a + b, 0) / (totalRequests || 1)).toFixed(1)),
    avg_connect: parseFloat((allConnect.reduce((a, b) => a + b, 0) / (totalRequests || 1)).toFixed(1)),
    total_bytes_received: allBytes.reduce((a, b) => a + b, 0),
    total_bytes_sent: allSentBytes.reduce((a, b) => a + b, 0),
  };

  // Timeline — group requests by second bucket
  const timelineMap = {};
  for (const row of allRows) {
    const ts      = parseInt(row.timeStamp) || 0;
    const elapsed = parseInt(row.elapsed)   || 0;
    const latency = parseInt(row.latency)   || 0;
    const connect = parseInt(row.connect)   || 0;
    const bytes   = parseInt(row.bytes)     || 0;
    const sentB   = parseInt(row.sentBytes) || 0;
    const threads = parseInt(row.allThreads)|| 0;
    const success = row.success === 'true';
    const sec = Math.floor((ts - minTs) / 1000);
    if (!timelineMap[sec]) timelineMap[sec] = { count: 0, elapsed: [], latency: [], connect: [], bytes: 0, sentBytes: 0, threads: [], errors: 0 };
    const t = timelineMap[sec];
    t.count++;
    t.elapsed.push(elapsed);
    t.latency.push(latency);
    t.connect.push(connect);
    t.bytes   += bytes;
    t.sentBytes += sentB;
    t.threads.push(threads);
    if (!success) t.errors++;
  }
  const timeline = Object.entries(timelineMap)
    .sort(([a], [b]) => parseInt(a) - parseInt(b))
    .map(([sec, d]) => ({
      second: parseInt(sec),
      tps: d.count,
      avg_rt: parseFloat((d.elapsed.reduce((a, b) => a + b, 0) / d.elapsed.length).toFixed(1)),
      avg_latency: parseFloat((d.latency.reduce((a, b) => a + b, 0) / d.latency.length).toFixed(1)),
      avg_connect: parseFloat((d.connect.reduce((a, b) => a + b, 0) / d.connect.length).toFixed(1)),
      bytes_received: d.bytes,
      bytes_sent: d.sentBytes,
      threads: Math.max(...d.threads),
      errors: d.errors,
      error_rate: parseFloat(((d.errors / d.count) * 100).toFixed(1)),
    }));

  // Error analysis — aggregate across all APIs
  const errorMap = {};
  for (const row of allRows) {
    if (row.success === 'true') continue;
    const key = `${row.label}||${row.responseCode || 'N/A'}||${row.responseMessage || ''}`;
    if (!errorMap[key]) errorMap[key] = {
      label: row.label || 'Unknown',
      response_code: row.responseCode || 'N/A',
      response_message: (row.responseMessage || '').slice(0, 120),
      failure_message: (row.failureMessage || '').slice(0, 200),
      count: 0,
    };
    errorMap[key].count++;
  }
  const errors = Object.values(errorMap).sort((a, b) => b.count - a.count);

  // Logs from stored run
  const storedLogs = JSON.parse(run.logs || '[]');

  res.json({
    meta: {
      run_id: run.id,
      suite_name: run.suite_name || 'Unknown',
      engine: run.engine,
      status: run.status,
      started_at: run.started_at,
      finished_at: run.finished_at,
      duration_s: parseFloat(totalDuration.toFixed(1)),
    },
    summary,
    by_api,
    timeline,
    errors,
    logs: storedLogs,
  });
});

// ── Export analytics as a real server-side PDF ────────────────────────────────
router.get('/runs/:id/export-pdf', auth, async (req, res) => {
  const run = db.prepare(`
    SELECT r.*, s.name as suite_name
    FROM execution_runs r
    LEFT JOIN test_suites s ON s.id = r.suite_id
    WHERE r.id = ?
  `).get(req.params.id);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  if (!ownsProject(req.userId, run.project_id)) return res.status(403).json({ error: 'Forbidden' });
  if (run.engine !== 'jmeter') return res.status(400).json({ error: 'PDF export only available for JMeter runs' });

  const jtlPath = path.join(run.result_dir, 'results.jtl');
  if (!fs.existsSync(jtlPath)) return res.status(404).json({ error: 'JTL results file not found' });

  // ── parse JTL ──────────────────────────────────────────────────────────────
  const content = fs.readFileSync(jtlPath, 'utf8');
  const lines   = content.trim().split('\n').filter(Boolean);
  if (lines.length < 2) return res.status(400).json({ error: 'JTL file contains no data rows' });

  const HEADER_NORM = { 'Latency': 'latency', 'Connect': 'connect', 'Bytes': 'bytes', 'SentBytes': 'sentBytes' };
  const headers = lines[0].split(',').map(h => {
    const clean = h.trim().replace(/^"|"$/g, '');
    return HEADER_NORM[clean] || clean;
  });

  function parseRow(line) {
    const parts = line.split(',');
    const row = {};
    headers.forEach((h, i) => { row[h] = (parts[i] || '').replace(/^"|"$/g, '').trim(); });
    return row;
  }
  function pct(arr, p) {
    if (!arr.length) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
  }

  const byLabel = {};
  let minTs = Infinity, maxTs = -Infinity;
  for (let i = 1; i < lines.length; i++) {
    const row     = parseRow(lines[i]);
    const ts      = parseInt(row.timeStamp) || 0;
    const elapsed = parseInt(row.elapsed)   || 0;
    const success = row.success === 'true';
    const label   = row.label || 'Unknown';
    if (ts < minTs) minTs = ts;
    if (ts + elapsed > maxTs) maxTs = ts + elapsed;
    if (!byLabel[label]) byLabel[label] = { elapsed: [], timestamps: [], latency: [], connect: [], bytes: [], sentBytes: [], success: 0, failed: 0, responseCodes: {}, failMessages: {} };
    const d = byLabel[label];
    d.elapsed.push(elapsed); d.timestamps.push(ts);
    d.latency.push(parseInt(row.latency) || 0);
    d.connect.push(parseInt(row.connect) || 0);
    d.bytes.push(parseInt(row.bytes) || 0);
    d.sentBytes.push(parseInt(row.sentBytes) || 0);
    if (success) { d.success++; } else {
      d.failed++;
      const code = row.responseCode || 'unknown';
      const msg  = row.failureMessage || row.responseMessage || '';
      d.responseCodes[code] = (d.responseCodes[code] || 0) + 1;
      if (msg) d.failMessages[msg] = (d.failMessages[msg] || 0) + 1;
    }
  }

  const totalDuration = minTs < maxTs ? (maxTs - minTs) / 1000 : 1;
  const by_api = Object.entries(byLabel).map(([label, d]) => {
    const total    = d.elapsed.length;
    const sum      = d.elapsed.reduce((a, b) => a + b, 0);
    const latSum   = d.latency.reduce((a, b) => a + b, 0);
    const connSum  = d.connect.reduce((a, b) => a + b, 0);
    const bytesSum = d.bytes.reduce((a, b) => a + b, 0);
    return {
      label, total, success: d.success, failed: d.failed,
      error_rate: parseFloat(((d.failed / total) * 100).toFixed(2)),
      avg: parseFloat((sum / total).toFixed(1)),
      min: d.elapsed.reduce((a, b) => Math.min(a, b), Infinity) || 0,
      max: d.elapsed.reduce((a, b) => Math.max(a, b), 0),
      median: pct(d.elapsed, 50), p90: pct(d.elapsed, 90), p95: pct(d.elapsed, 95),
      tps: parseFloat((total / totalDuration).toFixed(3)),
      avg_latency: parseFloat((latSum  / total).toFixed(1)),
      avg_connect: parseFloat((connSum / total).toFixed(1)),
      avg_bytes:   parseFloat((bytesSum / total).toFixed(0)),
      response_codes: d.responseCodes, fail_messages: d.failMessages,
    };
  });

  const allRows     = [];
  for (let i = 1; i < lines.length; i++) allRows.push(parseRow(lines[i]));
  const totalReqs   = allRows.length;
  const totalSucc   = allRows.filter(r => r.success === 'true').length;
  const totalFail   = totalReqs - totalSucc;
  const allElapsed  = allRows.map(r => parseInt(r.elapsed)   || 0);
  const allLatency  = allRows.map(r => parseInt(r.latency)   || 0);
  const allConnect  = allRows.map(r => parseInt(r.connect)   || 0);
  const allBytes    = allRows.map(r => parseInt(r.bytes)     || 0);
  const allSentB    = allRows.map(r => parseInt(r.sentBytes) || 0);
  const elapsedSum  = allElapsed.reduce((a, b) => a + b, 0);

  const summary = {
    total_requests: totalReqs, total_success: totalSucc, total_failed: totalFail,
    error_rate: parseFloat(((totalFail / totalReqs) * 100).toFixed(2)),
    avg_response_time: parseFloat((elapsedSum / (totalReqs || 1)).toFixed(1)),
    overall_tps: parseFloat((totalReqs / totalDuration).toFixed(3)),
    p90: pct(allElapsed, 90), p95: pct(allElapsed, 95),
    min_response_time: allElapsed.reduce((a, b) => Math.min(a, b), Infinity) || 0,
    max_response_time: allElapsed.reduce((a, b) => Math.max(a, b), 0),
    avg_latency: parseFloat((allLatency.reduce((a, b) => a + b, 0) / (totalReqs || 1)).toFixed(1)),
    avg_connect: parseFloat((allConnect.reduce((a, b) => a + b, 0) / (totalReqs || 1)).toFixed(1)),
    total_bytes_received: allBytes.reduce((a, b) => a + b, 0),
    total_bytes_sent:     allSentB.reduce((a, b) => a + b, 0),
  };

  const timelineMap = {};
  for (const row of allRows) {
    const ts  = parseInt(row.timeStamp) || 0;
    const sec = Math.floor((ts - minTs) / 1000);
    if (!timelineMap[sec]) timelineMap[sec] = { count: 0, elapsed: [], latency: [], connect: [], bytes: 0, sentBytes: 0, threads: [], errors: 0 };
    const t = timelineMap[sec];
    t.count++; t.elapsed.push(parseInt(row.elapsed)||0); t.latency.push(parseInt(row.latency)||0);
    t.connect.push(parseInt(row.connect)||0); t.bytes += parseInt(row.bytes)||0;
    t.sentBytes += parseInt(row.sentBytes)||0; t.threads.push(parseInt(row.allThreads)||0);
    if (row.success !== 'true') t.errors++;
  }
  const timeline = Object.entries(timelineMap).sort(([a],[b])=>parseInt(a)-parseInt(b)).map(([sec,d])=>({
    second: parseInt(sec),
    tps: d.count,
    avg_rt: parseFloat((d.elapsed.reduce((a,b)=>a+b,0)/d.elapsed.length).toFixed(1)),
    avg_latency: parseFloat((d.latency.reduce((a,b)=>a+b,0)/d.latency.length).toFixed(1)),
    avg_connect: parseFloat((d.connect.reduce((a,b)=>a+b,0)/d.connect.length).toFixed(1)),
    bytes_received: d.bytes, bytes_sent: d.sentBytes,
    threads: Math.max(...d.threads), errors: d.errors,
    error_rate: parseFloat(((d.errors/d.count)*100).toFixed(1)),
  }));

  const errorMap = {};
  for (const row of allRows) {
    if (row.success === 'true') continue;
    const key = `${row.label}||${row.responseCode||'N/A'}||${row.responseMessage||''}`;
    if (!errorMap[key]) errorMap[key] = { label: row.label||'Unknown', response_code: row.responseCode||'N/A', response_message: (row.responseMessage||'').slice(0,120), failure_message: (row.failureMessage||'').slice(0,200), count: 0 };
    errorMap[key].count++;
  }
  const errors = Object.values(errorMap).sort((a,b)=>b.count-a.count);

  const runNum = (run.result_dir.match(/Run_(\d+)/)||[])[1] || run.id;
  const suiteName = (run.suite_name||'Analytics').replace(/[^a-zA-Z0-9_-]/g,'_');
  const meta = {
    run_id: run.id, suite_name: run.suite_name||'Unknown', engine: run.engine,
    status: run.status, started_at: run.started_at, finished_at: run.finished_at,
    duration_s: parseFloat(totalDuration.toFixed(1)),
  };

  const pdfFilename = `${suiteName}_Run${runNum}_Analytics.pdf`;

  // Save PDF to results folder on disk
  if (run.result_dir && fs.existsSync(run.result_dir)) {
    try {
      const { generateAnalyticsPdfToFile } = require('../utils/generateAnalyticsPdf');
      const pdfPath = path.join(run.result_dir, pdfFilename);
      await generateAnalyticsPdfToFile({ summary, by_api, timeline, errors, meta }, runNum, pdfPath);
    } catch (e) {
      console.error('[Execution] Failed to save analytics PDF to results:', e.message);
    }
  }

  // Stream PDF to browser for download
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${pdfFilename}"`);
  await generateAnalyticsPdf({ summary, by_api, timeline, errors, meta }, runNum, res);
});

router.get('/runs/:id/download-report', auth, (req, res) => {
  const run = db.prepare(`
    SELECT r.*, s.name as suite_name
    FROM execution_runs r
    LEFT JOIN test_suites s ON s.id = r.suite_id
    WHERE r.id = ?
  `).get(req.params.id);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  if (!ownsProject(req.userId, run.project_id)) return res.status(403).json({ error: 'Forbidden' });

  // Prefer deriving reportDir from report_path (exact stored path)
  let reportDir;
  if (run.report_path) {
    reportDir = path.dirname(run.report_path);
  } else {
    reportDir = path.join(run.result_dir, 'report');
  }

  if (!reportDir || !fs.existsSync(reportDir)) {
    return res.status(404).json({ error: `Report directory not found: ${reportDir}` });
  }

  const runNum = (run.result_dir.match(/Run_(\d+)/) || [])[1] || run.id;
  const zipName = `JMeter_Report_Run_${runNum}.zip`;

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);

  const archive = new ZipArchive({ zlib: { level: 6 } });
  archive.on('error', err => { console.error('Archive error:', err); res.status(500).end(); });
  archive.pipe(res);
  archive.directory(reportDir, false);
  archive.finalize();
});

// ── Patch jmeter.properties to enable latency + bytes recording ──────────────
router.post('/jmeter/enable-latency', auth, (req, res) => {
  const cfgRow = db.prepare('SELECT config_json FROM global_config WHERE user_id = ?').get(req.userId);
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
router.get('/jmeter/latency-status', auth, (req, res) => {
  const cfgRow = db.prepare('SELECT config_json FROM global_config WHERE user_id = ?').get(req.userId);
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
router.post('/jmeter/pull-image', auth, (req, res) => {
  const cfgRow = db.prepare('SELECT config_json FROM global_config WHERE user_id = ?').get(req.userId);
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
