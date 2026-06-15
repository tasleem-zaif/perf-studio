const router = require('express').Router({ mergeParams: true });
const db     = require('../db');
const auth   = require('../middleware/auth');
const ownsProject = require('../utils/ownsProject');
const { runSuite } = require('../utils/testRunner');

router.use(auth);

// ── GET / — list all pipelines for project ────────────────────────────────────
router.get('/', (req, res) => {
  if (!ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });
  const pipelines = db.prepare('SELECT * FROM pipeline_configs WHERE project_id = ? ORDER BY created_at DESC').all(req.params.projectId);
  res.json({ pipelines });
});

// ── POST / — create pipeline ──────────────────────────────────────────────────
router.post('/', (req, res) => {
  if (!ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });
  const { name, description, steps, stop_on_failure, environment } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Pipeline name is required' });
  const result = db.prepare(
    'INSERT INTO pipeline_configs (project_id, name, description, steps, stop_on_failure, environment) VALUES (?,?,?,?,?,?)'
  ).run(req.params.projectId, name.trim(), description || '', JSON.stringify(steps || []), stop_on_failure !== false ? 1 : 0, environment || '');
  const pipeline = db.prepare('SELECT * FROM pipeline_configs WHERE id = ?').get(result.lastInsertRowid);
  res.json({ pipeline });
});

// ── PUT /:id — update pipeline ────────────────────────────────────────────────
router.put('/:id', (req, res) => {
  if (!ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });
  const { name, description, steps, stop_on_failure, environment } = req.body;
  const existing = db.prepare('SELECT * FROM pipeline_configs WHERE id = ? AND project_id = ?').get(req.params.id, req.params.projectId);
  if (!existing) return res.status(404).json({ error: 'Pipeline not found' });
  db.prepare('UPDATE pipeline_configs SET name=?, description=?, steps=?, stop_on_failure=?, environment=? WHERE id=?')
    .run(
      name || existing.name,
      description ?? existing.description,
      JSON.stringify(steps || JSON.parse(existing.steps || '[]')),
      stop_on_failure !== undefined ? (stop_on_failure ? 1 : 0) : existing.stop_on_failure,
      environment ?? existing.environment,
      req.params.id
    );
  res.json({ pipeline: db.prepare('SELECT * FROM pipeline_configs WHERE id = ?').get(req.params.id) });
});

// ── DELETE /:id — delete pipeline ─────────────────────────────────────────────
router.delete('/:id', (req, res) => {
  if (!ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });
  db.prepare('DELETE FROM pipeline_configs WHERE id = ? AND project_id = ?').run(req.params.id, req.params.projectId);
  res.json({ ok: true });
});

// ── GET /:id/runs — run history ───────────────────────────────────────────────
router.get('/:id/runs', (req, res) => {
  if (!ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });
  const runs = db.prepare('SELECT id, pipeline_id, project_id, status, steps_result, started_at, finished_at FROM pipeline_runs WHERE pipeline_id = ? ORDER BY started_at DESC LIMIT 20').all(req.params.id);
  res.json({ runs });
});

// ── GET /runs/:runId — single run status ──────────────────────────────────────
router.get('/runs/:runId', (req, res) => {
  if (!ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });
  const run = db.prepare('SELECT * FROM pipeline_runs WHERE id = ? AND project_id = ?').get(req.params.runId, req.params.projectId);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  res.json({ run });
});

// ── POST /:id/run — trigger pipeline run with SSE streaming ───────────────────
router.post('/:id/run', auth, async (req, res) => {
  if (!ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });

  const pipeline = db.prepare('SELECT * FROM pipeline_configs WHERE id = ? AND project_id = ?').get(req.params.id, req.params.projectId);
  if (!pipeline) return res.status(404).json({ error: 'Pipeline not found' });

  const steps = JSON.parse(pipeline.steps || '[]');
  if (!steps.length) return res.status(400).json({ error: 'Pipeline has no steps. Add test plans first.' });

  // ── SSE setup ──────────────────────────────────────────────────────────────
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  if (res.socket) res.socket.setNoDelay(true);

  const allLogs = [];
  function ts() { return new Date().toLocaleTimeString('en-GB', { hour12: false }); }
  function log(type, message) {
    const entry = { type, message: `${ts()} ${message}` };
    allLogs.push(entry);
    res.write('data: ' + JSON.stringify(entry) + '\n\n');
    if (typeof res.flush === 'function') res.flush();
  }
  function send(data) {
    res.write('data: ' + JSON.stringify(data) + '\n\n');
    if (typeof res.flush === 'function') res.flush();
  }
  function done(data) {
    res.write('data: ' + JSON.stringify({ done: true, ...data }) + '\n\n');
    res.end();
  }

  // Keep-alive ping so proxies don't close the connection
  const heartbeat = setInterval(() => {
    try { if (!res.writableEnded) res.write(': ping\n\n'); } catch {}
  }, 1000);

  // ── Create run record ─────────────────────────────────────────────────────
  const stepsResult = steps.map(s => ({ suite_id: s.suite_id, name: s.name, engine: s.engine, status: 'pending', error: null }));
  const runRow = db.prepare(
    'INSERT INTO pipeline_runs (pipeline_id, project_id, status, steps_result, triggered_by) VALUES (?,?,?,?,?)'
  ).run(pipeline.id, req.params.projectId, 'running', JSON.stringify(stepsResult), req.userId);
  const runId = runRow.lastInsertRowid;

  function saveSteps() {
    db.prepare('UPDATE pipeline_runs SET steps_result=? WHERE id=?').run(JSON.stringify(stepsResult), runId);
  }

  // ── Header ────────────────────────────────────────────────────────────────
  log('info', '╔══════════════════════════════════════════════════════════');
  log('info', `║  PIPELINE: ${pipeline.name}`);
  log('info', `║  Steps   : ${steps.length} test plan(s)`);
  if (pipeline.environment) log('info', `║  Env     : ${pipeline.environment}`);
  log('info', `║  On fail : ${pipeline.stop_on_failure ? 'Stop pipeline' : 'Continue to next step'}`);
  log('info', `║  Run ID  : #${runId}`);
  log('info', '╚══════════════════════════════════════════════════════════');

  // Notify frontend of run_id immediately so it can poll status
  send({ run_id: runId, total_steps: steps.length });
  log('ok', `Pipeline queued — Run #${runId} | ${steps.length} step(s)`);
  log('info', `Started at: ${new Date().toLocaleString()}`);

  // ── Execute steps sequentially ────────────────────────────────────────────
  let finalStatus = 'completed';
  let stoppedAt   = null;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    log('info', '');
    log('info', `┌─ Step ${i + 1}/${steps.length}: ${step.name} ─────────────────────────`);
    log('info', `│  Engine: ${step.engine?.toUpperCase() || 'JMETER'} · Type: ${step.test_type || 'load'}`);
    log('info', `│  Status: RUNNING`);

    // Mark step as running
    stepsResult[i].status = 'running';
    stepsResult[i].started_at = new Date().toISOString();
    saveSteps();
    send({ step_update: { index: i, status: 'running', name: step.name } });

    try {
      const result = await runSuite({
        suiteId:   step.suite_id,
        projectId: parseInt(req.params.projectId),
        userId:    req.userId,
        logFn:     (type, msg) => log(type, msg),
      });

      if (result.error) {
        stepsResult[i].status = 'failed';
        stepsResult[i].error  = result.error;
        log('err', `└─ ✘ FAILED — ${result.error}`);
        finalStatus = 'failed';
        send({ step_update: { index: i, status: 'failed', name: step.name, error: result.error } });
        saveSteps();
        if (pipeline.stop_on_failure) { stoppedAt = i; break; }

      } else if (result.passed) {
        stepsResult[i].status = 'completed';
        log('ok',  `└─ ✔ PASSED`);
        send({ step_update: { index: i, status: 'completed', name: step.name } });
        saveSteps();

      } else {
        stepsResult[i].status = 'failed';
        log('err', `└─ ✘ FAILED — rule violations`);
        finalStatus = 'failed';
        send({ step_update: { index: i, status: 'failed', name: step.name } });
        saveSteps();
        if (pipeline.stop_on_failure) { stoppedAt = i; break; }
      }
    } catch (e) {
      stepsResult[i].status = 'failed';
      stepsResult[i].error  = e.message;
      log('err', `└─ ✘ EXCEPTION — ${e.message}`);
      finalStatus = 'failed';
      send({ step_update: { index: i, status: 'failed', name: step.name, error: e.message } });
      saveSteps();
      if (pipeline.stop_on_failure) { stoppedAt = i; break; }
    }
  }

  // Mark remaining steps as skipped if we stopped early
  if (stoppedAt !== null) {
    for (let j = stoppedAt + 1; j < stepsResult.length; j++) {
      stepsResult[j].status = 'skipped';
      send({ step_update: { index: j, status: 'skipped', name: stepsResult[j].name } });
    }
    saveSteps();
    log('warn', '');
    log('warn', `Pipeline stopped at step ${stoppedAt + 1} due to failure.`);
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const passed  = stepsResult.filter(s => s.status === 'completed').length;
  const failed  = stepsResult.filter(s => s.status === 'failed').length;
  const skipped = stepsResult.filter(s => s.status === 'skipped').length;

  log('info', '');
  log('info', '═══════════════════════════════════════════════════════════');
  log(finalStatus === 'completed' ? 'ok' : 'err',
    `  PIPELINE ${finalStatus.toUpperCase()}  —  ✔ ${passed} passed  ✘ ${failed} failed  ⊘ ${skipped} skipped`);
  log('info', `  Finished: ${new Date().toLocaleString()}`);
  log('info', '═══════════════════════════════════════════════════════════');

  // ── Persist final state ───────────────────────────────────────────────────
  clearInterval(heartbeat);
  db.prepare(`UPDATE pipeline_runs SET status=?, finished_at=datetime('now'), logs=?, steps_result=? WHERE id=?`)
    .run(finalStatus, JSON.stringify(allLogs), JSON.stringify(stepsResult), runId);

  // ── Send pipeline completion alert email ──────────────────────────────────
  setImmediate(async () => {
    try {
      const { sendAlertEmail, getAlertConfig, getRecipients } = require('../utils/emailUtils');
      const cfg        = getAlertConfig(req.userId);
      const recipients = getRecipients(req.userId, req.params.projectId);
      if (!cfg?.smtp_host || !cfg?.from_email || !recipients.length) return;

      const project  = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.projectId);
      const userRow  = db.prepare('SELECT u.name, o.name as org_name FROM users u LEFT JOIN organizations o ON u.org_id = o.id WHERE u.id = ?').get(req.userId);
      const orgName  = userRow?.org_name || userRow?.name || 'Performance Studio';
      const finished = new Date().toLocaleString();

      // Build summary report data for the email template
      const reportData = {
        meta: {
          suite_name: `Pipeline: ${pipeline.name}`,
          started_at: new Date(Date.now() - (Date.now() % 1000)).toISOString(),
          duration_s: null,
          status: finalStatus,
        },
        summary: { total_requests: 0, total_failed: failed, total_success: passed },
        rule_violations: stepsResult
          .filter(s => s.status === 'failed' && s.error)
          .map(s => ({ rule: { metric: s.name, severity: 'error' }, label: s.error })),
      };

      await sendAlertEmail(runId, req.userId, req.params.projectId, reportData, null, null);
      console.log(`[Pipeline] Alert email sent for pipeline run #${runId}`);
    } catch (e) {
      console.error('[Pipeline] Failed to send alert email:', e.message);
    }
  });

  done({ ok: true, run_id: runId, status: finalStatus, passed, failed, skipped });
});

module.exports = router;
