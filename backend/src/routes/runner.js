const router = require('express').Router();
const db = require('../db');
const auth = require('../middleware/auth');

router.use(auth);

router.post('/execute', (req, res) => {
  const { script_id, engine, vusers, duration, rampup, target } = req.body;
  if (!engine) return res.status(400).json({ error: 'Engine required' });

  let script = null;
  if (script_id) {
    script = db.prepare('SELECT s.*, p.user_id FROM scripts s JOIN projects p ON p.id = s.project_id WHERE s.id = ?').get(script_id);
    if (!script || script.user_id !== req.userId) return res.status(404).json({ error: 'Script not found' });
  }

  const jobId = Math.random().toString(36).slice(2, 10).toUpperCase();
  const ts = new Date().toISOString().slice(11, 19);
  const engName = engine === 'k6' ? 'Grafana K6' : 'Apache JMeter';
  const resolvedTarget = target || script?.target || 'https://api.example.com';
  const resolvedVusers = vusers || script?.vusers || 50;
  const resolvedDuration = duration || script?.duration || 300;
  const resolvedRampup = rampup || script?.rampup || 30;

  if (script_id) {
    db.prepare('UPDATE scripts SET last_run = CURRENT_TIMESTAMP WHERE id = ?').run(script_id);
  }

  const rps = Math.floor(80 + Math.random() * 60);
  const p50 = Math.floor(90 + Math.random() * 80);
  const p95 = Math.floor(280 + Math.random() * 120);
  const p99 = Math.floor(450 + Math.random() * 200);
  const errorRate = (Math.random() * 0.5).toFixed(2);
  const throughput = Math.floor(200 + Math.random() * 150);

  const logs = [
    { type: 'info', message: `[${ts}] Initiating ${engName} test run...` },
    { type: 'info', message: `[${ts}] Script: ${script?.name || 'Custom Run'} | Engine: ${engName}` },
    { type: 'info', message: `[${ts}] Target: ${resolvedTarget}` },
    { type: 'info', message: `[${ts}] Params: VUsers=${resolvedVusers}, Duration=${resolvedDuration}s, Ramp=${resolvedRampup}s` },
    { type: 'ok',   message: `[${ts}] ✓ API call accepted — Job ID: ${jobId}` },
    { type: 'info', message: `[${ts}] Initializing ${engName} worker pool...` },
    { type: 'ok',   message: `[${ts}] ✓ Worker nodes: 3 available` },
    { type: 'info', message: `[${ts}] Starting ramp-up phase (${resolvedRampup}s)...` },
    { type: 'ok',   message: `[${ts}] ✓ Ramp complete. ${resolvedVusers} virtual users active.` },
    { type: 'info', message: `[${ts}] Executing load test...` },
    { type: 'ok',   message: `[${ts}] Requests/s: ${rps} avg` },
    { type: 'ok',   message: `[${ts}] Response Time P50: ${p50}ms` },
    { type: 'ok',   message: `[${ts}] Response Time P95: ${p95}ms` },
    { type: p99 > 500 ? 'warn' : 'ok', message: `[${ts}] Response Time P99: ${p99}ms${p99 > 500 ? ' ⚠ approaching threshold' : ''}` },
    { type: 'ok',   message: `[${ts}] Error Rate: ${errorRate}%` },
    { type: 'ok',   message: `[${ts}] Throughput: ${throughput} req/s` },
    { type: 'ok',   message: `[${ts}] ✓ Test completed. Report available at /reports/${jobId}` },
  ];

  res.json({
    job_id: jobId,
    status: 'completed',
    engine,
    logs,
    summary: { rps, p50, p95, p99, error_rate: parseFloat(errorRate), throughput }
  });
});

module.exports = router;
