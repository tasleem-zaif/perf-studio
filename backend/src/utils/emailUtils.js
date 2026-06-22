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
  // Try the triggering user's own SMTP config first
  const row = db.prepare('SELECT * FROM alert_configs WHERE user_id = ?').get(userId);
  if (row?.smtp_host) return row;

  // Fallback: use any org_admin or super_admin's SMTP config
  // This means regular users benefit from the admin's email setup automatically
  const adminCfg = db.prepare(`
    SELECT ac.* FROM alert_configs ac
    JOIN users u ON u.id = ac.user_id
    WHERE u.role IN ('org_admin', 'super_admin')
      AND ac.smtp_host IS NOT NULL AND ac.smtp_host != ''
    ORDER BY CASE u.role WHEN 'super_admin' THEN 0 ELSE 1 END
    LIMIT 1
  `).get();
  return adminCfg || null;
}

function getRecipients(userId, projectId) {
  // Collect ALL relevant recipients:
  // 1. Global recipients configured by this user
  // 2. Global recipients configured by any admin (so admin-configured lists apply to all runs)
  // 3. Project-specific recipients (tied to projectId regardless of who configured them)
  return db.prepare(`
    SELECT DISTINCT ar.email, ar.name FROM alert_recipients ar
    LEFT JOIN users u ON u.id = ar.user_id
    WHERE (
      ar.project_id IS NULL
      AND (ar.user_id = ? OR u.role IN ('org_admin', 'super_admin'))
    )
    OR ar.project_id = ?
    ORDER BY ar.email
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

function deriveFailureReason(runData) {
  const s = runData.summary || {};
  if (!s.total_requests || s.total_requests === 0) {
    return 'No requests were executed. The JMeter process may have failed to start, the test script is invalid, or the CI pipeline failed to patch the JMX file before execution.';
  }
  if (runData.rule_violations && runData.rule_violations.length > 0) {
    const errCount = runData.rule_violations.filter(v => v.rule?.severity === 'error').length;
    return `${runData.rule_violations.length} performance rule${runData.rule_violations.length > 1 ? 's' : ''} violated (${errCount} error-level threshold${errCount !== 1 ? 's' : ''}). See the Breached Rules section below.`;
  }
  const errRate = s.total_requests > 0 ? (s.total_failed / s.total_requests) * 100 : 0;
  if (errRate > 0) {
    return `${errRate.toFixed(1)}% of requests failed — ${(s.total_failed || 0).toLocaleString()} HTTP errors or assertion failures recorded.`;
  }
  return 'Test execution completed with a failure status. Review the attached PDF report for details.';
}

/** Build HTML email body — dark Analytics-style KPI grid */
function buildEmailBody(runData, orgName, recipientName, reportDir) {
  const m = runData.meta || {};
  const s = runData.summary || {};

  const suiteName = m.suite_name || 'Test Plan';
  const startedAt = m.started_at ? new Date(m.started_at).toLocaleString() : '—';
  const durationS = m.duration_s != null && m.duration_s > 0 ? `${m.duration_s}s` : '—';
  const status    = (m.status || 'completed').toUpperCase();
  const isFailed  = status === 'FAILED' || status === 'ERROR';

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
  const isSuccess   = !isFailed && rulesPassed;
  const verdictBg   = isSuccess ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)';
  const verdictBdr  = isSuccess ? '#22c55e' : '#ef4444';
  const verdictIcon = isSuccess ? '✅' : '❌';
  const verdictStatus = isSuccess ? 'PASSED' : 'FAILED';
  const verdictText = isFailed && rulesPassed
    ? deriveFailureReason(runData)
    : rulesPassed
      ? 'All performance rules passed'
      : `${(runData.rule_violations||[]).length} rule(s) violated`;

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
          <span style="color:#f0f3fa;font-size:17px;font-weight:700;vertical-align:middle;">Peako</span>
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
      <strong style="color:#f0f3fa;">${startedAt}</strong>${durationS !== '—' ? ` (Duration: <strong style="color:#f0f3fa;">${durationS}</strong>)` : ''}.
      Below is the analytics summary. Full report is attached.
    </p>

    <!-- Verdict banner -->
    <div style="background:${verdictBg};border:1px solid ${verdictBdr};border-radius:8px;padding:12px 16px;margin-bottom:12px;">
      <span style="font-size:16px;margin-right:8px;">${verdictIcon}</span>
      <span style="font-weight:700;color:${verdictBdr};font-size:13px;">Status: ${verdictStatus}</span>
      ${isSuccess ? `<span style="color:#b8c4d8;font-size:12px;margin-left:12px;">${verdictText}</span>` : ''}
    </div>
    ${isFailed ? `
    <!-- Failure reason -->
    <div style="background:rgba(239,68,68,0.06);border:1px solid rgba(239,68,68,0.25);border-radius:8px;padding:12px 16px;margin-bottom:12px;">
      <div style="font-size:11px;font-weight:700;color:#ef4444;text-transform:uppercase;letter-spacing:.5px;margin-bottom:5px;">Failure Reason</div>
      <div style="font-size:13px;color:#e6edf3;line-height:1.6;">${deriveFailureReason(runData)}</div>
    </div>` : ''}

    ${!rulesPassed ? `
    <!-- Rule violations detail -->
    <div style="background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.3);border-radius:8px;padding:14px 16px;margin-bottom:20px;">
      <div style="font-weight:700;color:#ef4444;font-size:13px;margin-bottom:10px;">⚠ Breached Rules</div>
      <table style="width:100%;border-collapse:collapse;font-size:12px;">
        <tr style="background:rgba(0,0,0,0.2);">
          <th style="padding:6px 10px;text-align:left;color:#8b949e;font-weight:600;">Metric</th>
          <th style="padding:6px 10px;text-align:center;color:#8b949e;font-weight:600;">Threshold</th>
          <th style="padding:6px 10px;text-align:center;color:#8b949e;font-weight:600;">Actual Value</th>
          <th style="padding:6px 10px;text-align:center;color:#8b949e;font-weight:600;">Severity</th>
        </tr>
        ${(runData.rule_violations||[]).map(v => {
          const sevColor = v.rule?.severity === 'error' ? '#ef4444' : '#f59e0b';
          const thresholdLabel = v.rule?.operator === 'between'
            ? `between ${v.rule.value_min}–${v.rule.value_max} ${v.rule.unit}`
            : `${v.rule?.operator || ''} ${v.rule?.value || ''} ${v.rule?.unit || ''}`;
          return `<tr style="border-top:1px solid rgba(255,255,255,0.05);">
            <td style="padding:7px 10px;color:#e6edf3;font-weight:600;">${v.rule?.metric || 'Unknown'}</td>
            <td style="padding:7px 10px;text-align:center;color:#8b949e;font-family:monospace;">${thresholdLabel}</td>
            <td style="padding:7px 10px;text-align:center;color:#ef4444;font-weight:700;font-family:monospace;">${v.actual ?? '—'} ${v.rule?.unit || ''}</td>
            <td style="padding:7px 10px;text-align:center;"><span style="padding:2px 8px;border-radius:20px;font-size:10px;font-weight:700;background:${sevColor}22;color:${sevColor};border:1px solid ${sevColor};">${(v.rule?.severity||'error').toUpperCase()}</span></td>
          </tr>`;
        }).join('')}
      </table>
    </div>` : ''}
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
  </div>

  <!-- Sign-off -->
  <div style="padding:0 24px 22px;">
    <p style="color:#b8c4d8;font-size:13px;margin:0 0 4px;">Thanks,</p>
    <p style="color:#f0f3fa;font-size:14px;font-weight:600;margin:0;">${orgName || 'Peako Team'}</p>
  </div>

  <!-- Footer -->
  <div style="background:#0f172a;padding:12px 24px;text-align:center;border-top:1px solid #2e3a55;">
    <p style="color:#4b5563;font-size:11px;margin:0;">Automated report from Peako &nbsp;·&nbsp; Do not reply</p>
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
    const orgName = userRow?.org_name || userRow?.name || 'Peako';

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
    const subject   = `[Peako] ${suiteName} — Test Execution Report`;

    for (const recipient of recipients) {
      const html = buildEmailBody(runData, orgName, recipient.name, reportDir);
      const s = runData.summary || {};
      const plainText = [
        `Peako — Test Execution Report`,
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
        ``,
        `Thanks,`,
        `${orgName}`,
      ].join('\n');

      await transport.sendMail({
        from:       `"${cfg.from_name || 'Peako'}" <${cfg.from_email}>`,
        to:         recipient.name ? `"${recipient.name}" <${recipient.email}>` : recipient.email,
        replyTo:    cfg.from_email,
        subject,
        text:       plainText,
        html,
        attachments,
        headers: {
          'X-Mailer':        'Peako',
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

// ── Mid-run breach alert ──────────────────────────────────────────────────────

function buildBreachEmailBody(params, orgName, recipientName) {
  const { violations, suiteName, projectName, elapsedSec, totalDuration, runId } = params;
  const greeting   = recipientName ? `Dear ${recipientName},` : 'Dear Team,';
  const elapsedMin = Math.floor(elapsedSec / 60);
  const elapsedStr = elapsedMin > 0 ? `${elapsedMin}m ${elapsedSec % 60}s` : `${elapsedSec}s`;
  const totalStr   = totalDuration ? `${Math.floor(totalDuration / 60)}m` : 'unknown';

  const violationRows = violations.map(v => {
    const severityColor = v.rule.severity === 'error' ? '#ef4444' : '#f59e0b';
    const severityBg    = v.rule.severity === 'error' ? 'rgba(239,68,68,0.12)' : 'rgba(245,158,11,0.12)';
    const icon          = v.rule.severity === 'error' ? '🔴' : '⚠️';
    const thresholdLabel = v.rule.operator === 'between'
      ? `between ${v.rule.value_min}–${v.rule.value_max} ${v.rule.unit}`
      : `${v.rule.operator} ${v.rule.value} ${v.rule.unit}`;
    return `
      <tr>
        <td style="padding:10px 14px;border-bottom:1px solid #2e3a55;">
          <div style="display:flex;align-items:center;gap:8px;">
            <span style="font-size:15px;">${icon}</span>
            <div>
              <div style="font-weight:700;color:#f0f3fa;font-size:13px;">${v.rule.metric}</div>
              <div style="font-size:11px;color:#7a8eaa;margin-top:2px;">Rule: ${thresholdLabel}</div>
            </div>
          </div>
        </td>
        <td style="padding:10px 14px;border-bottom:1px solid #2e3a55;text-align:center;">
          <span style="font-family:monospace;font-size:14px;font-weight:700;color:${severityColor};">${v.actual} ${v.rule.unit}</span>
        </td>
        <td style="padding:10px 14px;border-bottom:1px solid #2e3a55;text-align:center;">
          <span style="padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700;background:${severityBg};color:${severityColor};border:1px solid ${severityColor};">${v.rule.severity.toUpperCase()}</span>
        </td>
      </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#111827;font-family:'Segoe UI',Arial,sans-serif;">
<div style="max-width:640px;margin:0 auto;background:#1a2035;border-radius:12px;overflow:hidden;">

  <!-- Header -->
  <div style="background:linear-gradient(135deg,#7f1d1d 0%,#1e3a5f 100%);padding:20px 24px;">
    <table style="width:100%;border-collapse:collapse;"><tr>
      <td style="vertical-align:middle;">
        <img src="https://www.qtsolv.com/wp-content/themes/qtsolvtheme/assets/images/svg/logo.svg"
             alt="Quarks" height="32" style="height:32px;filter:brightness(0) invert(1);vertical-align:middle;margin-right:10px;"/>
        <span style="color:#f0f3fa;font-size:16px;font-weight:700;vertical-align:middle;">Peako</span>
        <span style="color:#fca5a5;font-size:12px;margin-left:8px;vertical-align:middle;">⚡ Live Rule Breach Alert</span>
      </td>
    </tr></table>
  </div>

  <!-- Body -->
  <div style="padding:22px 24px 0;">
    <p style="color:#f0f3fa;font-size:14px;margin:0 0 6px;">${greeting}</p>
    <p style="color:#b8c4d8;font-size:13px;line-height:1.6;margin:0 0 18px;">
      A performance rule breach has been detected in your running test
      <strong style="color:#f0f3fa;">${suiteName}</strong>
      (Project: <strong style="color:#f0f3fa;">${projectName || '—'}</strong>).<br>
      Detected at <strong style="color:#fbbf24;">${elapsedStr}</strong> into a
      <strong style="color:#f0f3fa;">${totalStr}</strong> test run.
    </p>

    <!-- Alert banner -->
    <div style="background:rgba(239,68,68,0.12);border:1px solid #ef4444;border-radius:8px;padding:12px 16px;margin-bottom:20px;">
      <span style="font-size:16px;margin-right:8px;">🚨</span>
      <span style="font-weight:700;color:#ef4444;font-size:13px;">${violations.length} rule${violations.length > 1 ? 's' : ''} breached during active test execution</span>
    </div>

    <!-- Violations table -->
    <table style="width:100%;border-collapse:collapse;background:#1e2840;border-radius:8px;overflow:hidden;margin-bottom:20px;">
      <thead>
        <tr style="background:#0f172a;">
          <th style="padding:10px 14px;text-align:left;font-size:11px;color:#7a8eaa;font-weight:700;text-transform:uppercase;letter-spacing:.5px;">Metric / Rule</th>
          <th style="padding:10px 14px;text-align:center;font-size:11px;color:#7a8eaa;font-weight:700;text-transform:uppercase;letter-spacing:.5px;">Actual Value</th>
          <th style="padding:10px 14px;text-align:center;font-size:11px;color:#7a8eaa;font-weight:700;text-transform:uppercase;letter-spacing:.5px;">Severity</th>
        </tr>
      </thead>
      <tbody>${violationRows}</tbody>
    </table>

    <p style="color:#b8c4d8;font-size:12px;line-height:1.6;margin:0 0 20px;background:#1e2840;border-radius:8px;padding:12px 14px;border-left:3px solid #f59e0b;">
      ⏱ The test is still running. This is an early warning — the final report will be sent when the test completes.
      Consider stopping the test if these breaches indicate a critical issue.
    </p>
  </div>

  <!-- Sign-off -->
  <div style="padding:0 24px 22px;">
    <p style="color:#b8c4d8;font-size:13px;margin:0 0 4px;">Thanks,</p>
    <p style="color:#f0f3fa;font-size:14px;font-weight:600;margin:0;">${orgName || 'Peako Team'}</p>
  </div>

  <!-- Footer -->
  <div style="background:#0f172a;padding:12px 24px;text-align:center;border-top:1px solid #2e3a55;">
    <p style="color:#4b5563;font-size:11px;margin:0;">Automated breach alert from Peako &nbsp;·&nbsp; Run ID: ${runId}</p>
  </div>

</div>
</body>
</html>`;
}

/**
 * Send mid-run rule breach alert emails.
 * Called when the monitoring loop detects a new breach during test execution.
 */
async function sendBreachAlertEmail(runId, userId, projectId, params) {
  try {
    const cfg = getAlertConfig(userId);
    if (!cfg || !cfg.smtp_host || !cfg.from_email) return;

    const recipients = getRecipients(userId, projectId);
    if (!recipients.length) return;

    const userRow = db.prepare('SELECT u.name, o.name as org_name FROM users u LEFT JOIN organizations o ON u.org_id = o.id WHERE u.id = ?').get(userId);
    const orgName = userRow?.org_name || userRow?.name || 'Peako';

    const transport = createTransport(cfg);
    const subject = `🚨 [Peako ALERT] Rule Breach — ${params.suiteName} (Run #${runId})`;

    for (const recipient of recipients) {
      const html = buildBreachEmailBody(params, orgName, recipient.name);
      const plain = [
        `Peako — Rule Breach Alert`,
        ``,
        `Hello ${recipient.name || 'Team'},`,
        ``,
        `A rule breach was detected in test "${params.suiteName}" at ${Math.floor(params.elapsedSec / 60)}m ${params.elapsedSec % 60}s into the run.`,
        ``,
        `Breached Rules:`,
        ...(params.violations || []).map(v => `  - ${v.label} [${v.rule.severity}]`),
        ``,
        `The test is still running. Final report will follow on completion.`,
        ``,
        `Thanks,`,
        `${orgName}`,
      ].join('\n');

      await transport.sendMail({
        from:    `"${cfg.from_name || 'Peako'}" <${cfg.from_email}>`,
        to:      recipient.name ? `"${recipient.name}" <${recipient.email}>` : recipient.email,
        replyTo: cfg.from_email,
        subject,
        text:    plain,
        html,
        headers: { 'X-Mailer': 'Peako', 'X-Priority': '1', 'Importance': 'High' },
      });
    }

    console.log(`[Alerts] Breach alert sent to ${recipients.length} recipient(s) — Run ${runId}, ${params.violations.length} violation(s)`);
  } catch (e) {
    console.error('[Alerts] Failed to send breach alert:', e.message);
  }
}

// ── Post-run rule violation alert ─────────────────────────────────────────────

function buildRuleViolationEmailBody(runId, suiteName, projectName, violations, orgName, recipientName) {
  const greeting = recipientName ? `Dear ${recipientName},` : 'Dear Team,';

  const violationRows = violations.map(v => {
    const sevColor = v.rule?.severity === 'error' ? '#ef4444' : '#f59e0b';
    const sevBg    = v.rule?.severity === 'error' ? 'rgba(239,68,68,0.12)' : 'rgba(245,158,11,0.12)';
    const icon     = v.rule?.severity === 'error' ? '🔴' : '⚠️';
    const thresholdLabel = v.rule?.operator === 'between'
      ? `between ${v.rule.value_min}–${v.rule.value_max} ${v.rule.unit || ''}`
      : `${v.rule?.operator || ''} ${v.rule?.value || ''} ${v.rule?.unit || ''}`.trim();
    return `
      <tr style="border-top:1px solid #2e3a55;">
        <td style="padding:10px 14px;">
          <div style="display:flex;align-items:center;gap:8px;">
            <span style="font-size:14px;">${icon}</span>
            <div>
              <div style="font-weight:700;color:#f0f3fa;font-size:13px;">${v.rule?.metric || 'Unknown'}</div>
              <div style="font-size:11px;color:#7a8eaa;margin-top:2px;">Rule: ${thresholdLabel}</div>
            </div>
          </div>
        </td>
        <td style="padding:10px 14px;text-align:center;">
          <span style="font-family:monospace;font-size:14px;font-weight:700;color:${sevColor};">${v.actual ?? '—'} ${v.rule?.unit || ''}</span>
        </td>
        <td style="padding:10px 14px;text-align:center;">
          <span style="padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700;background:${sevBg};color:${sevColor};border:1px solid ${sevColor};">${(v.rule?.severity || 'error').toUpperCase()}</span>
        </td>
      </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#111827;font-family:'Segoe UI',Arial,sans-serif;">
<div style="max-width:640px;margin:0 auto;background:#1a2035;border-radius:12px;overflow:hidden;">

  <!-- Header -->
  <div style="background:linear-gradient(135deg,#450a0a 0%,#1e3a5f 100%);padding:20px 24px;">
    <table style="width:100%;border-collapse:collapse;"><tr>
      <td style="vertical-align:middle;">
        <img src="https://www.qtsolv.com/wp-content/themes/qtsolvtheme/assets/images/svg/logo.svg"
             alt="Quarks" height="32" style="height:32px;filter:brightness(0) invert(1);vertical-align:middle;margin-right:10px;"/>
        <span style="color:#f0f3fa;font-size:16px;font-weight:700;vertical-align:middle;">Peako</span>
        <span style="color:#fca5a5;font-size:12px;margin-left:8px;vertical-align:middle;">Rule Violation Alert</span>
      </td>
    </tr></table>
  </div>

  <!-- Body -->
  <div style="padding:22px 24px 0;">
    <p style="color:#f0f3fa;font-size:14px;margin:0 0 12px;">${greeting}</p>
    <p style="color:#b8c4d8;font-size:13px;line-height:1.6;margin:0 0 18px;">
      The following performance rules were violated in test plan
      <strong style="color:#f0f3fa;">${suiteName}</strong>
      ${projectName ? `in project <strong style="color:#f0f3fa;">${projectName}</strong>` : ''}.
    </p>

    <!-- Alert banner -->
    <div style="background:rgba(239,68,68,0.12);border:1px solid #ef4444;border-radius:8px;padding:12px 16px;margin-bottom:20px;">
      <span style="font-size:16px;margin-right:8px;">❌</span>
      <span style="font-weight:700;color:#ef4444;font-size:13px;">${violations.length} rule${violations.length > 1 ? 's' : ''} violated — performance thresholds exceeded</span>
    </div>

    <!-- Violations table -->
    <table style="width:100%;border-collapse:collapse;background:#1e2840;border-radius:8px;overflow:hidden;margin-bottom:20px;">
      <thead>
        <tr style="background:#0f172a;">
          <th style="padding:10px 14px;text-align:left;font-size:11px;color:#7a8eaa;font-weight:700;text-transform:uppercase;letter-spacing:.5px;">Metric / Rule</th>
          <th style="padding:10px 14px;text-align:center;font-size:11px;color:#7a8eaa;font-weight:700;text-transform:uppercase;letter-spacing:.5px;">Actual Value</th>
          <th style="padding:10px 14px;text-align:center;font-size:11px;color:#7a8eaa;font-weight:700;text-transform:uppercase;letter-spacing:.5px;">Severity</th>
        </tr>
      </thead>
      <tbody>${violationRows}</tbody>
    </table>
  </div>

  <!-- Sign-off -->
  <div style="padding:0 24px 22px;">
    <p style="color:#b8c4d8;font-size:13px;margin:0 0 4px;">Thanks,</p>
    <p style="color:#f0f3fa;font-size:14px;font-weight:600;margin:0;">${orgName || 'Peako Team'}</p>
  </div>

  <!-- Footer -->
  <div style="background:#0f172a;padding:12px 24px;text-align:center;border-top:1px solid #2e3a55;">
    <p style="color:#4b5563;font-size:11px;margin:0;">Post-run rule violation alert from Peako &nbsp;·&nbsp; Run ID: ${runId}</p>
  </div>

</div>
</body>
</html>`;
}

/**
 * Send post-run rule violation alert. Called once after a run completes if rules were violated.
 * Sends a focused email with only the violated rules — no KPIs or run stats.
 */
async function sendRuleViolationEmail(runId, userId, projectId, violations, suiteName, projectName) {
  try {
    if (!violations || violations.length === 0) return;
    const cfg = getAlertConfig(userId);
    if (!cfg || !cfg.smtp_host || !cfg.from_email) return;

    const recipients = getRecipients(userId, projectId);
    if (!recipients.length) return;

    const userRow = db.prepare('SELECT u.name, o.name as org_name FROM users u LEFT JOIN organizations o ON u.org_id = o.id WHERE u.id = ?').get(userId);
    const orgName = userRow?.org_name || userRow?.name || 'Peako';

    const runRow = db.prepare('SELECT result_dir FROM execution_runs WHERE id = ?').get(runId);
    const runNum = (runRow?.result_dir?.match(/Run_?(\d+)/i) || [])[1] || runId;

    const transport = createTransport(cfg);
    const subject = `❌ [Peako] Rule Violations — ${suiteName} (Run #${runNum})`;

    for (const recipient of recipients) {
      const html = buildRuleViolationEmailBody(runId, suiteName, projectName, violations, orgName, recipient.name);
      const plain = [
        `Peako — Rule Violation Alert`,
        ``,
        `Hello ${recipient.name || 'Team'},`,
        ``,
        `Performance rules were violated after test plan "${suiteName}" completed.`,
        ``,
        `Violated Rules:`,
        ...violations.map(v => {
          const threshold = v.rule?.operator === 'between'
            ? `between ${v.rule.value_min}–${v.rule.value_max} ${v.rule.unit || ''}`
            : `${v.rule?.operator || ''} ${v.rule?.value || ''} ${v.rule?.unit || ''}`.trim();
          return `  - ${v.rule?.metric || 'Unknown'}: actual ${v.actual} ${v.rule?.unit || ''} (rule: ${threshold}) [${v.rule?.severity || 'error'}]`;
        }),
        ``,
        `Thanks,`,
        `${orgName}`,
      ].join('\n');

      await transport.sendMail({
        from:    `"${cfg.from_name || 'Peako'}" <${cfg.from_email}>`,
        to:      recipient.name ? `"${recipient.name}" <${recipient.email}>` : recipient.email,
        replyTo: cfg.from_email,
        subject,
        text:    plain,
        html,
        headers: { 'X-Mailer': 'Peako', 'X-Priority': '2', 'Importance': 'High' },
      });
    }

    console.log(`[Alerts] Rule violation email sent to ${recipients.length} recipient(s) — Run ${runId}, ${violations.length} violation(s)`);
  } catch (e) {
    console.error('[Alerts] Failed to send rule violation email:', e.message);
  }
}

module.exports = { sendAlertEmail, sendBreachAlertEmail, sendRuleViolationEmail, getAlertConfig, getRecipients };
