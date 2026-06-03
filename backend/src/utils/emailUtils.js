/**
 * emailUtils.js — sends post-run alert emails with PDF analytics + JMeter HTML ZIP.
 */
const nodemailer = require('nodemailer');
const path       = require('path');
const fs         = require('fs');
const os         = require('os');
const { decrypt } = require('./encryption');

const db = require('../db');

// ── helpers ──────────────────────────────────────────────────────────────────

function getAlertConfig(userId) {
  const row = db.prepare('SELECT * FROM alert_configs WHERE user_id = ?').get(userId);
  return row || null;
}

function getRecipients(userId, projectId) {
  return db.prepare(`
    SELECT DISTINCT email, name FROM alert_recipients
    WHERE (user_id = ? AND project_id IS NULL)
       OR (project_id = ?)
    ORDER BY email
  `).all(userId, projectId);
}

function createTransport(cfg) {
  return nodemailer.createTransport({
    host:   cfg.smtp_host,
    port:   Number(cfg.smtp_port) || 587,
    secure: !!cfg.smtp_secure,
    auth:   cfg.smtp_user ? { user: cfg.smtp_user, pass: decrypt(cfg.smtp_pass) } : undefined,
    tls:    { rejectUnauthorized: false },
  });
}

/** Zip a directory into a temp file using platform-native commands. */
function zipDirectory(srcDir) {
  return new Promise((resolve, reject) => {
    const tmpFile = path.join(os.tmpdir(), `jmeter_report_${Date.now()}.zip`);
    const { exec } = require('child_process');

    let cmd;
    if (process.platform === 'win32') {
      // PowerShell Compress-Archive — built into all modern Windows
      const src  = srcDir.replace(/'/g, "''");
      const dest = tmpFile.replace(/'/g, "''");
      cmd = `powershell -NoProfile -Command "Compress-Archive -Path '${src}\\*' -DestinationPath '${dest}' -Force"`;
    } else {
      // zip is standard on Linux/macOS
      cmd = `zip -r "${tmpFile}" . `;
    }

    const opts = process.platform === 'win32'
      ? { timeout: 60000 }
      : { cwd: srcDir, timeout: 60000 };

    exec(cmd, opts, (err, stdout, stderr) => {
      if (err) {
        console.error('[Alerts] ZIP failed:', err.message, stderr);
        return reject(err);
      }
      if (!fs.existsSync(tmpFile)) {
        return reject(new Error('ZIP file was not created'));
      }
      console.log('[Alerts] ZIP created:', tmpFile, `(${fs.statSync(tmpFile).size} bytes)`);
      resolve(tmpFile);
    });
  });
}

/** Render one KPI card as a table cell (email-safe HTML, no CSS grid) */
function kpiCell(label, value, sub, color) {
  return `
    <td style="width:25%;padding:4px;">
      <div style="background:#222b42;border:1px solid #2e3a55;border-radius:10px;padding:14px 16px;">
        <div style="font-size:10px;font-weight:700;color:#7a8eaa;text-transform:uppercase;letter-spacing:.6px;margin-bottom:6px;">${label}</div>
        <div style="font-size:22px;font-weight:700;color:${color};line-height:1.1;font-family:monospace;margin-bottom:4px;">${value}</div>
        <div style="font-size:11px;color:#7a8eaa;">${sub}</div>
      </div>
    </td>`;
}

/** Build HTML email body — dark Analytics-style KPI grid */
function buildEmailBody(runData, orgName, recipientName, reportDir) {
  const m = runData.meta || {};
  const s = runData.summary || {};

  const suiteName = m.suite_name || 'Test Plan';
  const startedAt = m.started_at ? new Date(m.started_at).toLocaleString() : '—';
  const durationS = m.duration_s != null ? `${m.duration_s}s` : '—';
  const status    = (m.status || 'completed').toUpperCase();
  const isPassed  = status === 'COMPLETED' || status === 'passed';

  const errRateNum  = s.total_requests > 0 ? (s.total_failed / s.total_requests) * 100 : 0;
  const errRateStr  = errRateNum.toFixed(2) + '%';
  const errColor    = errRateNum === 0 ? '#22c55e' : errRateNum < 5 ? '#f59e0b' : '#ef4444';
  const passedCount = (s.total_success || (s.total_requests - s.total_failed) || 0).toLocaleString();
  const passRate    = s.total_requests > 0 ? (100 - errRateNum).toFixed(1) + '% pass rate' : '0% pass rate';

  // Matches Analytics page fmt exactly — 0 and Infinity treated as not-recorded
  const fmt = ms => {
    const n = Number(ms);
    if (ms == null || ms === '' || isNaN(n) || !isFinite(n) || n <= 0) return '—';
    return n >= 1000 ? `${(n/1000).toFixed(2)}s` : `${Math.round(n)}ms`;
  };
  const fmtB = b => {
    const n = Number(b);
    if (b == null || isNaN(n) || !isFinite(n) || n <= 0) return 'N/A';
    if (n >= 1048576) return `${(n/1048576).toFixed(2)} MB`;
    if (n >= 1024)    return `${(n/1024).toFixed(1)} KB`;
    return `${n} B`;
  };

  const rulesPassed = !runData.rule_violations || runData.rule_violations.length === 0;
  const verdictBg   = rulesPassed ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)';
  const verdictBdr  = rulesPassed ? '#22c55e' : '#ef4444';
  const verdictIcon = rulesPassed ? '✅' : '❌';
  const verdictText = rulesPassed ? 'All performance rules passed' : `${(runData.rule_violations||[]).length} rule(s) violated`;

  const greeting = recipientName ? `Dear ${recipientName},` : 'Dear Team,';

  // KPI rows — 4 columns each, matching the Analytics page grid
  const row1 = `<tr>
    ${kpiCell('Total Requests',  (s.total_requests||0).toLocaleString(), 'All samplers',              '#49CC3D')}
    ${kpiCell('Passed',          passedCount,                             passRate,                    '#22c55e')}
    ${kpiCell('Failed',          (s.total_failed||0).toLocaleString(),   'HTTP errors / assertions',  '#ef4444')}
    ${kpiCell('Error Rate',      errRateStr,  errRateNum===0?'All passing':errRateNum<5?'Acceptable':'High — investigate', errColor)}
  </tr>`;
  const row2 = `<tr>
    ${kpiCell('Avg Response',    fmt(s.avg_response_time), 'Mean across all requests',  '#8b5cf6')}
    ${kpiCell('Min Response',    fmt(s.min_response_time), 'Fastest single request',    '#22c55e')}
    ${kpiCell('Max Response',    fmt(s.max_response_time), 'Slowest single request',    '#ef4444')}
    ${kpiCell('Throughput',      `${Number(s.overall_tps||s.avg_tps||0).toFixed(2)} TPS`, 'Requests per second', '#06b6d4')}
  </tr>`;
  const row3 = `<tr>
    ${kpiCell('P90',             fmt(s.p90),                     '90th percentile',  '#a78bfa')}
    ${kpiCell('P95',             fmt(s.p95),                     '95th percentile',  '#06b6d4')}
    ${kpiCell('Bytes Received',  fmtB(s.total_bytes_received),   'Total download',   '#f59e0b')}
    ${kpiCell('Bytes Sent',      fmtB(s.total_bytes_sent),       'Total upload',     '#f97316')}
  </tr>`;

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#111827;font-family:'Segoe UI',Arial,sans-serif;">
<div style="max-width:680px;margin:0 auto;background:#1a2035;border-radius:12px;overflow:hidden;">

  <!-- Header bar -->
  <div style="background:linear-gradient(135deg,#0f172a 0%,#1e3a5f 100%);padding:20px 24px;">
    <table style="width:100%;border-collapse:collapse;">
      <tr>
        <td style="vertical-align:middle;">
          <img src="https://www.qtsolv.com/wp-content/themes/qtsolvtheme/assets/images/svg/logo.svg"
               alt="Quarks" height="36"
               style="display:inline-block;height:36px;vertical-align:middle;margin-right:12px;filter:brightness(0) invert(1);" />
          <span style="color:#f0f3fa;font-size:17px;font-weight:700;vertical-align:middle;">Performance Studio</span>
          <span style="color:#7a8eaa;font-size:12px;margin-left:10px;vertical-align:middle;">Test Execution Report</span>
        </td>
      </tr>
    </table>
  </div>

  <!-- Greeting -->
  <div style="padding:22px 24px 0;">
    <p style="color:#f0f3fa;font-size:14px;margin:0 0 6px;">${greeting}</p>
    <p style="color:#b8c4d8;font-size:13px;line-height:1.6;margin:0 0 18px;">
      Your test plan <strong style="color:#f0f3fa;">${suiteName}</strong> was executed on
      <strong style="color:#f0f3fa;">${startedAt}</strong>
      (Duration: <strong style="color:#f0f3fa;">${durationS}</strong>).
      Below is the analytics summary. Full report is attached.
    </p>

    <!-- Verdict banner -->
    <div style="background:${verdictBg};border:1px solid ${verdictBdr};border-radius:8px;padding:12px 16px;margin-bottom:20px;">
      <span style="font-size:16px;margin-right:8px;">${verdictIcon}</span>
      <span style="font-weight:700;color:${verdictBdr};font-size:13px;">Status: ${status}</span>
      <span style="color:#b8c4d8;font-size:12px;margin-left:12px;">${verdictText}</span>
    </div>
  </div>

  <!-- KPI Grid -->
  <div style="padding:0 20px 20px;">
    <table style="width:100%;border-collapse:collapse;table-layout:fixed;">
      ${row1}
      <tr><td colspan="4" style="padding:3px 0;"></td></tr>
      ${row2}
      <tr><td colspan="4" style="padding:3px 0;"></td></tr>
      ${row3}
    </table>
  </div>

  <!-- Attachments note -->
  <div style="margin:0 20px 20px;background:#1e2840;border:1px solid #2e3a55;border-radius:8px;padding:11px 14px;font-size:12px;color:#7a8eaa;">
    📎 <strong style="color:#b8c4d8;">Attached:</strong>&nbsp; Full Analytics Report (PDF)
    ${reportDir ? `<br><span style="margin-top:5px;display:block;">📁 <strong style="color:#b8c4d8;">HTML Report:</strong>&nbsp;<code style="color:#58a6ff;font-size:11px;">${reportDir.replace(/\\/g, '/')}</code></span>` : ''}
  </div>

  <!-- Sign-off -->
  <div style="padding:0 24px 22px;">
    <p style="color:#b8c4d8;font-size:13px;margin:0 0 4px;">Thanks,</p>
    <p style="color:#f0f3fa;font-size:14px;font-weight:600;margin:0;">${orgName || 'Performance Studio Team'}</p>
  </div>

  <!-- Footer -->
  <div style="background:#0f172a;padding:12px 24px;text-align:center;border-top:1px solid #2e3a55;">
    <p style="color:#4b5563;font-size:11px;margin:0;">Automated report from Performance Studio &nbsp;·&nbsp; Do not reply</p>
  </div>

</div>
</body>
</html>`;
}

// ── main export ───────────────────────────────────────────────────────────────

/**
 * Send post-run alert email.
 * @param {number} runId
 * @param {number} userId
 * @param {number} projectId
 * @param {object} runData  — the same object returned by /runs/:id/report-data
 * @param {string} pdfPath  — path to generated PDF (may be null)
 * @param {string} reportDir — path to JMeter HTML report directory (may be null)
 */
async function sendAlertEmail(runId, userId, projectId, runData, pdfPath, reportDir) {
  try {
    const cfg = getAlertConfig(userId);
    if (!cfg || !cfg.smtp_host || !cfg.from_email) return;

    const recipients = getRecipients(userId, projectId);
    if (!recipients.length) return;

    // Get org name
    const userRow = db.prepare('SELECT u.name, o.name as org_name FROM users u LEFT JOIN organizations o ON u.org_id = o.id WHERE u.id = ?').get(userId);
    const orgName = userRow?.org_name || userRow?.name || 'Performance Studio';

    // Build attachments
    const attachments = [];

    if (pdfPath && fs.existsSync(pdfPath)) {
      attachments.push({
        filename: `${(runData.meta?.suite_name || 'Analytics').replace(/[^a-zA-Z0-9_-]/g, '_')}_Report.pdf`,
        path: pdfPath,
        contentType: 'application/pdf',
      });
    }

    // Note: JMeter HTML report is NOT attached as ZIP — Gmail/Outlook block ZIP
    // files containing JS/HTML for security reasons. The report path is included
    // in the email body so recipients can open it directly from the server.

    const transport = createTransport(cfg);
    const suiteName = runData.meta?.suite_name || 'Test Plan';
    const subject   = `[PerfStudio] ${suiteName} — Test Execution Report`;

    for (const recipient of recipients) {
      const html = buildEmailBody(runData, orgName, recipient.name, reportDir);
      const s = runData.summary || {};
      const plainText = [
        `Performance Studio — Test Execution Report`,
        ``,
        `Hello ${recipient.name || 'Team'},`,
        ``,
        `Your test plan "${suiteName}" has completed.`,
        `Status: ${(runData.meta?.status || 'completed').toUpperCase()}`,
        ``,
        `Summary:`,
        `  Total Requests : ${(s.total_requests||0).toLocaleString()}`,
        `  Failed         : ${(s.total_failed||0).toLocaleString()}`,
        `  Avg Resp Time  : ${s.avg_response_time != null ? Math.round(s.avg_response_time)+'ms' : '—'}`,
        `  Error Rate     : ${s.total_requests > 0 ? ((s.total_failed/s.total_requests)*100).toFixed(2)+'%' : '0.00%'}`,
        ``,
        `See attached PDF for the full analytics report.`,
        reportDir ? `HTML Report (open in browser): ${reportDir.replace(/\\/g, '/')}` : '',
        ``,
        `Thanks,`,
        `${orgName}`,
      ].join('\n');

      await transport.sendMail({
        from:       `"${cfg.from_name || 'Performance Studio'}" <${cfg.from_email}>`,
        to:         recipient.name ? `"${recipient.name}" <${recipient.email}>` : recipient.email,
        replyTo:    cfg.from_email,
        subject,
        text:       plainText,
        html,
        attachments,
        headers: {
          'X-Mailer':        'Performance Studio',
          'X-Priority':      '3',
          'Importance':      'Normal',
          'Precedence':      'bulk',
          'Auto-Submitted':  'auto-generated',
        },
      });
    }

    // Clean up temp ZIP files
    for (const a of attachments) {
      if (a.path && a.path.includes(os.tmpdir())) {
        try { fs.unlinkSync(a.path); } catch (_) {}
      }
    }

    console.log(`[Alerts] Sent to ${recipients.length} recipient(s) for run ${runId}`);
  } catch (e) {
    console.error('[Alerts] Failed to send alert email:', e.message);
  }
}

module.exports = { sendAlertEmail, getAlertConfig, getRecipients };
