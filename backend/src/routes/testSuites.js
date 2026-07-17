const router = require('express').Router({ mergeParams: true });
const path = require('path');
const fs = require('fs');
const { writeFileSync } = require('fs');
const db = require('../db');
const auth = require('../middleware/auth');
const ownsProject = require('../utils/ownsProject');
const { readCsv, readCsvContent } = require('../utils/csvUtils');
const gitEngine = require('../utils/gitEngine');
const resetSequence = require('../utils/resetSequence');
const { updateCollectionConfigs, updateProjectCollectionConfigs } = require('../utils/configWriter');
const s3Sync = require('../utils/s3Sync');
const { TOKEN_KEYS, fingerprintMatches, resolveUrlSet, resolveForScript } = require('../utils/preRunEngine');
const {
  filterApplicableRules, groupRulesBySource, groupRulesByTarget, substituteCorrelatedLiterals,
  jsonPathToOptionalChain, k6HeaderAccessor, k6CookieAccessor, toK6TemplateLiteral,
} = require('../utils/scriptCorrelation');
const { applyFieldGenerators, groupGeneratorsByTarget } = require('../utils/fieldGenerators');
const { K6_CRYPTO_TRANSFORMS } = require('../utils/transforms');

const DEFAULT_CONFIG = { protocol: 'https', url: '', port: '443', threads: 50, rampup: 30, loop: 1, duration: 300 };

const THREAD_GROUPS = {
  load:      'org.apache.jmeter.threads.ThreadGroup',
  stress:    'kg.apc.jmeter.threads.UltimateThreadGroup',
  spike:     'kg.apc.jmeter.threads.arrivals.ArrivalsThreadGroup',
  endurance: 'kg.apc.jmeter.threads.ConcurrencyThreadGroup',
};

router.use(auth);

router.get('/', async (req, res) => {
  if (!await ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });
  const { collection_id, env } = req.query;
  let suites;
  if (collection_id && env) {
    // Strict env isolation: only return suites explicitly tagged to this collection+env
    suites = await db.prepare(
      "SELECT * FROM test_suites WHERE project_id = ? AND collection_id = ? AND env = ? ORDER BY created_at DESC"
    ).all(req.params.projectId, collection_id, env);
  } else if (collection_id) {
    suites = await db.prepare(
      "SELECT * FROM test_suites WHERE project_id = ? AND collection_id = ? ORDER BY created_at DESC"
    ).all(req.params.projectId, collection_id);
  } else {
    suites = await db.prepare('SELECT * FROM test_suites WHERE project_id = ? ORDER BY created_at DESC').all(req.params.projectId);
  }
  res.json({ suites });
});

router.post('/', async (req, res) => {
  const proj = await ownsProject(req.userId, req.params.projectId);
  if (!proj) return res.status(404).json({ error: 'Project not found' });
  const { name, test_type, collection_id, env, test_data_id, test_data_ids, engine, config, vusers, rampup, iter_mode, loops, duration } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const idsArr = Array.isArray(test_data_ids) ? test_data_ids : (test_data_ids ? JSON.parse(test_data_ids) : []);
  const primaryId = idsArr.length ? idsArr[0] : (test_data_id || null);
  const result = await db.prepare(
    `INSERT INTO test_suites (project_id, name, test_type, collection_id, env, test_data_id, test_data_ids, engine, config_json, vusers, rampup, iter_mode, loops, duration)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(req.params.projectId, name, test_type || 'load', collection_id || null, env || null, primaryId,
    JSON.stringify(idsArr), engine || 'jmeter', JSON.stringify(config || {}), vusers||50, rampup||30, iter_mode||'duration', loops||1, duration||300);
  if (collection_id) {
    const _uid = req.userId, _pid = req.params.projectId;
    setImmediate(async () => {
      try {
        const p = await db.prepare('SELECT name FROM projects WHERE id = ?').get(_pid);
        const c = await db.prepare('SELECT role FROM users WHERE id = ?').get(_uid);
        const { getUserProjectPath } = require('../utils/projectFolders');
        await updateCollectionConfigs(collection_id, await getUserProjectPath(_uid, c?.role, p?.name || '', _pid), _uid);
      } catch (_) {}
    });
  }
  res.json({ suite: await db.prepare('SELECT * FROM test_suites WHERE id = ?').get(result.lastInsertRowid) });
});

router.put('/:id', async (req, res) => {
  const proj = await ownsProject(req.userId, req.params.projectId);
  if (!proj) return res.status(404).json({ error: 'Project not found' });
  const suite = await db.prepare('SELECT * FROM test_suites WHERE id = ? AND project_id = ?').get(req.params.id, req.params.projectId);
  if (!suite) return res.status(404).json({ error: 'Test plan not found — it may have been deleted in another session.' });
  const { name, test_type, collection_id, env, test_data_id, test_data_ids, engine, config, vusers, rampup, iter_mode, loops, duration } = req.body;
  const normalId = v => (v === '' || v === undefined) ? null : v;
  const idsArr = Array.isArray(test_data_ids) ? test_data_ids : (test_data_ids !== undefined ? JSON.parse(test_data_ids || '[]') : null);
  const primaryId = idsArr ? (idsArr.length ? idsArr[0] : null) : (test_data_id !== undefined ? normalId(test_data_id) : suite.test_data_id);
  await db.prepare(`UPDATE test_suites SET name=?, test_type=?, collection_id=?, env=?, test_data_id=?, test_data_ids=?, engine=?, config_json=?, vusers=?, rampup=?, iter_mode=?, loops=?, duration=? WHERE id=?`)
    .run(name || suite.name, test_type || suite.test_type,
      collection_id !== undefined ? normalId(collection_id) : suite.collection_id,
      env !== undefined ? (env || null) : suite.env,
      primaryId,
      idsArr !== null ? JSON.stringify(idsArr) : suite.test_data_ids,
      engine || suite.engine,
      config ? JSON.stringify(config) : suite.config_json,
      vusers !== undefined ? vusers : suite.vusers,
      rampup !== undefined ? rampup : suite.rampup,
      iter_mode !== undefined ? iter_mode : suite.iter_mode,
      loops !== undefined ? loops : suite.loops,
      duration !== undefined ? duration : suite.duration,
      req.params.id);
  const updatedSuite = await db.prepare('SELECT * FROM test_suites WHERE id = ?').get(req.params.id);
  if (updatedSuite?.collection_id) {
    const _uid = req.userId, _pid = req.params.projectId, _cid = updatedSuite.collection_id;
    setImmediate(async () => {
      try {
        const p = await db.prepare('SELECT name FROM projects WHERE id = ?').get(_pid);
        const c = await db.prepare('SELECT role FROM users WHERE id = ?').get(_uid);
        const { getUserProjectPath } = require('../utils/projectFolders');
        await updateCollectionConfigs(_cid, await getUserProjectPath(_uid, c?.role, p?.name || '', _pid), _uid);
      } catch (_) {}
    });
  }
  res.json({ suite: updatedSuite });
});

router.delete('/:id', async (req, res) => {
  if (!await ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });
  const suite = await db.prepare('SELECT * FROM test_suites WHERE id = ? AND project_id = ?').get(req.params.id, req.params.projectId);
  if (!suite) return res.status(404).json({ error: 'Test plan not found — it may have already been deleted.' });
  await db.prepare('DELETE FROM test_suites WHERE id = ?').run(req.params.id);
  resetSequence('test_suites');
  if (suite.collection_id) {
    const _uid = req.userId, _pid = req.params.projectId, _cid = suite.collection_id;
    setImmediate(async () => {
      try {
        const p = await db.prepare('SELECT name FROM projects WHERE id = ?').get(_pid);
        const c = await db.prepare('SELECT role FROM users WHERE id = ?').get(_uid);
        const { getUserProjectPath } = require('../utils/projectFolders');
        await updateCollectionConfigs(_cid, await getUserProjectPath(_uid, c?.role, p?.name || '', _pid), _uid);
      } catch (_) {}
    });
  }
  res.json({ ok: true });
});

// Extracted from POST /:id/generate so auto-heal can trigger the exact same deterministic
// regeneration pipeline after persisting new endpointOverrides (see ai.js's "Fix with AI"
// for the shape) — a targeted per-endpoint override + regeneration costs zero extra AI
// tokens for JMeter (generateJmx is deterministic), unlike asking the AI to rewrite the
// whole script, which fails outright once a script is too large for the model's output
// limit. Returns { ok, filename, path } on success or { error, status } on failure — the
// route below is now a thin wrapper that translates the latter into an HTTP response.
async function generateScriptForSuite(userId, projectId, suiteId, reqPreRunData) {
  const proj = await ownsProject(userId, projectId);
  if (!proj) return { error: 'Project not found', status: 404 };

  const suite = await db.prepare('SELECT * FROM test_suites WHERE id = ? AND project_id = ?').get(suiteId, projectId);
  if (!suite) return { error: 'Suite not found', status: 404 };

  // Gather context
  const collection = suite.collection_id
    ? await db.prepare('SELECT * FROM collections WHERE id = ?').get(suite.collection_id)
    : null;
  // Load multiple test data files
  let dataIds = [];
  try { dataIds = JSON.parse(suite.test_data_ids || '[]'); } catch {}
  if (!dataIds.length && suite.test_data_id) dataIds = [suite.test_data_id];
  const testDataFiles = (await Promise.all(
    dataIds.map(id => db.prepare('SELECT * FROM test_data_files WHERE id = ?').get(id))
  )).filter(Boolean);
  const rules = await db.prepare('SELECT * FROM rules WHERE project_id = ?').all(projectId);

  const globalRow = await db.prepare('SELECT config_json FROM global_config WHERE user_id = ?').get(userId);
  const projRow   = await db.prepare('SELECT config_json FROM project_config WHERE project_id = ?').get(projectId);
  const globalCfg = globalRow ? JSON.parse(globalRow.config_json) : {};
  const projCfg   = projRow   ? JSON.parse(projRow.config_json)   : {};
  const suiteCfg  = JSON.parse(suite.config_json || '{}');

  // Load env-specific config (highest priority) — overrides global + project
  const suiteEnv = suite.env || '';
  const envCfgRow = suiteEnv && suite.collection_id
    ? await db.prepare('SELECT config_json FROM collection_env_config WHERE collection_id = ? AND env = ?').get(suite.collection_id, suiteEnv)
    : null;
  const envCfg = envCfgRow ? JSON.parse(envCfgRow.config_json || '{}') : {};

  // urls/protocol/url/port are per-collection-per-env data by design (strict isolation —
  // see PROJECT_MAP.md). global_config/project_config's copies are project-wide "reference
  // only" defaults (collections.js's autoPopulateProjectConfig seeds project_config from
  // whichever collection happens to have literal hostnames, and NEVER writes
  // collection_env_config for a collection whose endpoints are all {{var}} templates —
  // e.g. Binance). Letting those leak in here meant a collection with no env URL configured
  // yet would silently inherit ANOTHER collection's server instead of failing loudly.
  // For a collection-scoped suite, target-URL fields must come only from envCfg/suiteCfg.
  let scopedGlobalCfg = globalCfg, scopedProjCfg = projCfg;
  if (suite.collection_id) {
    const strip = ({ urls, protocol, url, port, ...rest }) => rest;
    scopedGlobalCfg = strip(globalCfg);
    scopedProjCfg   = strip(projCfg);
  }

  // Merge order: DEFAULT → global → project → env-specific → suite overrides
  const cfg = { ...DEFAULT_CONFIG, ...scopedGlobalCfg, ...scopedProjCfg, ...envCfg, ...suiteCfg };

  const endpoints = collection ? (() => { try { return JSON.parse(collection.json_content); } catch { return []; } })() : [];

  // Fail loudly instead of generating a script that silently targets an empty/wrong host —
  // this is the gap left once the cross-collection URL fallback above was removed. A saved
  // env-config URL isn't the only way to have one: endpoints whose {{var}} host resolves
  // via cfg.variables (multi-host collections, or one re-imported after the {{var}}
  // auto-populate fix) count too, even if collection_env_config.urls hasn't caught up yet.
  const hasResolvableHost = (cfg.urls?.[0]?.url || cfg.url) ||
    endpoints.some(ep => resolveEndpointHost(ep.url || ep.path || '', cfg.variables || {}));
  if (suite.collection_id && !hasResolvableHost) {
    return {
      error: `No target URL configured for this collection's "${suiteEnv || 'default'}" environment. Set one under Config > Environment Config before generating a script.`,
      status: 400,
    };
  }
  // Use pre-run data from the caller's request body (legacy) or from collection row (new flow)
  const preRunData = reqPreRunData || (() => {
    if (!collection?.pre_run_data) return null;
    try { return JSON.parse(collection.pre_run_data); } catch { return null; }
  })();

  const engine = suite.engine || 'jmeter';
  const testType = suite.test_type || 'load';
  const safeName = suite.name.replace(/[^a-zA-Z0-9_-]/g, '_');

  const identity = await db.prepare('SELECT auth_method FROM user_git_configs WHERE user_id = ? AND project_id = ?').get(userId, projectId);
  const isSSH = (identity?.auth_method || 'pat') === 'ssh';
  const { resolveOrgSlugForProject, cleanName } = require('../utils/projectFolders');
  const orgSlug = await resolveOrgSlugForProject(projectId);

  try {
    // PAT mode: pre-read each test-data file's content from the gitEngine session (no local
    // file to read otherwise) so generateJmx/generateK6's CSV value-matching (buildCsvValueMap)
    // works the same as it does for SSH-mode's real local files.
    let patSession = null;
    if (!isSSH && proj.folder_path) {
      patSession = await gitEngine.openSession(proj.folder_path, orgSlug);
      for (const f of testDataFiles) {
        // f.path is stored as "<ProjectName>/<Collection>/<Env>/testData/<file>" for PAT-mode
        // uploads (see testData.js) — resolve it directly against the session's content root.
        const relFromContentRoot = f.path ? f.path.replace(/\\/g, '/').split('/').slice(1).join('/') : '';
        const fullPath = require('path').posix.join(patSession.dir, cleanName(proj.name), relFromContentRoot);
        try { f.__content = patSession.fs.existsSync(fullPath) ? patSession.fs.readFileSync(fullPath) : undefined; } catch { f.__content = undefined; }
      }
    }

    let scriptContent;
    if (engine === 'jmeter') {
      scriptContent = cleanScript(await generateJmx(userId, suite, collection, testDataFiles, cfg, endpoints, rules, preRunData, testType), 'jmeter');
    } else {
      scriptContent = cleanScript(await generateK6(userId, suite, collection, testDataFiles[0] || null, cfg, endpoints, rules, preRunData, testType), 'k6');
    }

    // Write script to collection/env/script/ — use suite.env or derive from collection
    const ext = engine === 'jmeter' ? 'jmx' : 'js';
    const filename = `${safeName}.${ext}`;
    let filePath = '';

    let targetEnv = suite.env;
    if (!targetEnv && collection) {
      try { const envs = JSON.parse(collection.environments || '[]'); targetEnv = envs[0] || collection.environment || 'Default'; } catch { targetEnv = collection.environment || 'Default'; }
    }
    const relDir = collection ? require('path').posix.join(cleanName(collection.name), cleanName(targetEnv || 'Default'), 'script') : 'script';

    if (!isSSH) {
      if (patSession) {
        const contentRoot = require('path').posix.join(patSession.dir, cleanName(proj.name));
        const relScriptPath = require('path').posix.join(relDir, filename);
        patSession.fs.mkdirSync(require('path').posix.join(contentRoot, relDir), { recursive: true });
        patSession.fs.writeFileSync(require('path').posix.join(contentRoot, relScriptPath), scriptContent, 'utf8');
        await gitEngine.persistSession(patSession, proj.folder_path, orgSlug);
        filePath = require('path').posix.join(cleanName(proj.name), relScriptPath);
      }
    } else {
      let scriptBaseDir = null;
      const { getUserProjectPath, getCollectionPath, isAdminWorkspace } = require('../utils/projectFolders');
      const callerUser = await db.prepare('SELECT role FROM users WHERE id = ?').get(userId);
      const callerRole = callerUser?.role;
      const userProjPath = await getUserProjectPath(userId, callerRole, proj.name, projectId);

      // Restore the workspace first if the S3 sweep reclaimed it since the last access —
      // mkdirSync below would otherwise happily recreate a bare folder tree with no .git and
      // none of the workspace's other content, masking the problem instead of fixing it.
      if (userProjPath) {
        await require('../routes/git').ensureGitWorkspaceHydrated(require('path').dirname(userProjPath), projectId, userId);
      }

      // Admin workspace holds only empty folders — skip script generation for admin
      if (isAdminWorkspace(userProjPath)) {
        return { error: 'Scripts cannot be generated in the admin workspace. Please use a regular user account to generate scripts.', status: 400 };
      }
      if (collection && userProjPath) {
        const envPath = getCollectionPath(userProjPath, collection.name, targetEnv);
        scriptBaseDir = require('path').join(envPath, 'script');
      } else if (userProjPath) {
        scriptBaseDir = require('path').join(userProjPath, 'script');
      }

      if (scriptBaseDir) {
        require('fs').mkdirSync(scriptBaseDir, { recursive: true });
        filePath = require('path').join(scriptBaseDir, filename);
        writeFileSync(filePath, scriptContent, 'utf8');
        const up = await s3Sync.uploadFile(filePath, orgSlug);
        if (!up.ok && !up.skipped) console.error('[TestSuites] S3 sync failed for', filePath, ':', up.error?.message);
      }
    }

    // Update DB
    const updateField = engine === 'jmeter' ? 'jmx_path' : 'js_path';
    await db.prepare(`UPDATE test_suites SET ${updateField}=?, status='generated' WHERE id=?`).run(filePath || filename, suiteId);

    if (suite.collection_id) setImmediate(async () => { await updateCollectionConfigs(suite.collection_id); });
    return { ok: true, filename, path: filePath };
  } catch (e) {
    return { error: `Script generation failed: ${e.message}. Check your AI API key in Settings and that the collection has valid endpoints.`, status: 500 };
  }
}

router.post('/:id/generate', async (req, res) => {
  const result = await generateScriptForSuite(req.userId, req.params.projectId, req.params.id, req.body.preRunData);
  if (result.error) return res.status(result.status || 500).json({ error: result.error });
  res.json(result);
});

router.get('/:id/download/:type', async (req, res) => {
  const proj = await ownsProject(req.userId, req.params.projectId);
  if (!proj) return res.status(404).json({ error: 'Project not found' });
  const suite = await db.prepare('SELECT * FROM test_suites WHERE id = ? AND project_id = ?').get(req.params.id, req.params.projectId);
  if (!suite) return res.status(404).json({ error: 'Test plan not found — it may have been deleted. Try regenerating the script.' });

  const filePath = req.params.type === 'jmx' ? suite.jmx_path : suite.js_path;
  if (!filePath) return res.status(404).json({ error: 'Script not generated yet' });
  const filename = path.basename(filePath);

  const identity = await db.prepare('SELECT auth_method FROM user_git_configs WHERE user_id = ? AND project_id = ?').get(req.userId, req.params.projectId);
  const isSSH = (identity?.auth_method || 'pat') === 'ssh';

  if (!isSSH) {
    try {
      const { resolveOrgSlugForProject } = require('../utils/projectFolders');
      const orgSlug = await resolveOrgSlugForProject(req.params.projectId);
      const session = await gitEngine.openSession(proj.folder_path, orgSlug);
      const full = path.posix.join(session.dir, filePath.replace(/\\/g, '/'));
      if (!session.fs.existsSync(full)) return res.status(404).json({ error: 'File not found' });
      const content = session.fs.readFileSync(full);
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.send(content);
    } catch (e) {
      return res.status(500).json({ error: `Failed to read script: ${e.message}` });
    }
  }

  // ── SSH mode: unchanged ──────────────────────────────────────────────────────────────
  try {
    const { getUserProjectPath } = require('../utils/projectFolders');
    const callerUser = await db.prepare('SELECT role FROM users WHERE id = ?').get(req.userId);
    const userProjPath = await getUserProjectPath(req.userId, callerUser?.role, proj.name, req.params.projectId);
    if (userProjPath) await require('../routes/git').ensureGitWorkspaceHydrated(path.dirname(userProjPath), req.params.projectId, req.userId);
  } catch (e) { console.error('[TestSuites] Workspace hydrate failed:', e.message); }

  res.download(filePath, filename, err => {
    if (err) res.status(404).json({ error: 'File not found on disk' });
  });
});

// ─── AI output cleaner ────────────────────────────────────────────────────

// JMeter elements that must be followed by a <hashTree/> sibling
const JMX_ELEMENTS = [
  'HTTPSamplerProxy','GenericSampler','DebugSampler','TestAction',
  'ThreadGroup','SetupThreadGroup','PostThreadGroup',
  'UltimateThreadGroup','ConcurrencyThreadGroup','ArrivalsThreadGroup',
  'TestPlan','Arguments','UserDefinedVariables',
  'HeaderManager','CacheManager','CookieManager','AuthManager',
  'CSVDataSet',
  'ConstantTimer','GaussianRandomTimer','UniformRandomTimer','ConstantThroughputTimer','PoissonRandomTimer',
  'ResponseAssertion','DurationAssertion','SizeAssertion','XPathAssertion','JSONPathAssertion',
  'MD5HexAssertion','HTMLAssertion','BeanShellAssertion','JSR223Assertion','SMIMEAssertion',
  'RegExExtractor','JSONPathExtractor','XPathExtractor','BoundaryExtractor','HtmlExtractor','ResultSaver',
  'BeanShellPreProcessor','BeanShellPostProcessor','JSR223PreProcessor','JSR223PostProcessor',
  'IfController','LoopController','WhileController','ForeachController','OnceOnlyController',
  'TransactionController','ThroughputController','RunTime','InterleaveControl','RandomController',
  'ModuleController','IncludeController','CriticalSectionController',
  'ResultCollector','Summariser','StatVisualizer','ViewResultsFullVisualizer',
  'BackendListener','AbstractBackendListenerClient',
].join('|');

function fixJmxHashTrees(xml) {
  // After every closing tag of a known JMeter element, insert <hashTree/> only when
  // no <hashTree already follows (handles CRLF, LF, mixed indentation via \s* in lookahead)
  const re = new RegExp(`(</(${JMX_ELEMENTS})>)(?!\\s*<hashTree)`, 'g');
  return xml.replace(re, '$1\n<hashTree/>');
}

function cleanScript(content, engine) {
  let s = content.trim();
  // Strip markdown code fences
  s = s.replace(/^```[a-zA-Z]*\r?\n?/, '').replace(/\r?\n?```$/, '').trim();
  s = s.replace(/^~~~[a-zA-Z]*\r?\n?/, '').replace(/\r?\n?~~~$/, '').trim();

  if (engine === 'jmeter') {
    // Discard any text before the XML declaration or root element
    const xmlStart = s.search(/<\?xml|<jmeterTestPlan/);
    if (xmlStart > 0) s = s.slice(xmlStart);
    // Fix missing hashTree siblings for assertion/element nodes
    s = fixJmxHashTrees(s);
  }

  return s;
}

// ─── Deterministic JMX template builder ───────────────────────────────────

function xmlEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// runtimeOverridable=true wraps the value in ${__P(NAME, default)} so the var can be
// overridden at runtime with: jmeter -n -t script.jmx -JTHREADS=100 -JDURATION=600
function udvEntry(name, value, runtimeOverridable = false) {
  const val = runtimeOverridable ? `\${__P(${name},${value})}` : value;
  return [
    `          <elementProp name="${xmlEsc(name)}" elementType="Argument">`,
    `            <stringProp name="Argument.name">${xmlEsc(name)}</stringProp>`,
    `            <stringProp name="Argument.value">${xmlEsc(val)}</stringProp>`,
    `            <stringProp name="Argument.metadata">=</stringProp>`,
    `          </elementProp>`,
  ].join('\n');
}

function listenerXml(testname, guiclass) {
  return `      <ResultCollector guiclass="${guiclass}" testclass="ResultCollector" testname="${xmlEsc(testname)}" enabled="true">
        <boolProp name="ResultCollector.error_logging">false</boolProp>
        <objProp>
          <name>saveConfig</name>
          <value class="SampleSaveConfiguration">
            <time>true</time><latency>true</latency><timestamp>true</timestamp>
            <success>true</success><label>true</label><code>true</code>
            <message>true</message><threadName>true</threadName><dataType>true</dataType>
            <encoding>false</encoding><assertions>true</assertions><subresults>true</subresults>
            <responseData>false</responseData><samplerData>false</samplerData><xml>false</xml>
            <fieldNames>true</fieldNames><responseHeaders>false</responseHeaders>
            <requestHeaders>false</requestHeaders><responseDataOnError>false</responseDataOnError>
            <saveAssertionResultsFailureMessage>true</saveAssertionResultsFailureMessage>
            <assertionsResultsToSave>0</assertionsResultsToSave>
            <bytes>true</bytes><sentBytes>true</sentBytes><url>true</url>
            <threadCounts>true</threadCounts><idleTime>true</idleTime><connectTime>true</connectTime>
          </value>
        </objProp>
        <stringProp name="filename"></stringProp>
      </ResultCollector>`;
}

// Response status-code assertion (JMeter's equivalent of k6's check() call) — every
// sampler gets one, matching k6's per-request `status is 2xx/3xx` check, so JMX and k6
// validate responses to the same standard rather than JMX silently treating a 404/500 as
// just "a response that happened" (JMeter, unlike k6, doesn't fail a sample on a non-2xx
// status by default — only a connection error counts as a JMeter failure without this).
//
// Property keys/values verified directly against JMeter's own ResponseAssertion.java
// source (not guessed): the collection-of-patterns property really is spelled
// "Asserion.test_strings" (missing the second "s") — a typo baked into JMeter itself since
// early versions and kept for file-format compatibility. Getting this "typo" wrong (i.e.
// "fixing" it to the correct spelling) would make JMeter silently ignore the assertion.
function responseAssertionXml(testname) {
  return [
    `          <ResponseAssertion guiclass="AssertionGui" testclass="ResponseAssertion" testname="${xmlEsc(testname)}" enabled="true">`,
    `            <collectionProp name="Asserion.test_strings">`,
    `              <stringProp name="0">[23]\\d\\d</stringProp>`,
    `            </collectionProp>`,
    `            <stringProp name="Assertion.custom_message"></stringProp>`,
    `            <stringProp name="Assertion.test_field">Assertion.response_code</stringProp>`,
    `            <boolProp name="Assertion.assume_success">false</boolProp>`,
    `            <intProp name="Assertion.test_type">1</intProp>`,
    `          </ResponseAssertion>`,
    `          <hashTree/>`,
  ].join('\n');
}

// Think-time pacing between requests — JMeter's equivalent of k6's `sleep(1)` between
// every http call. A Timer applies to every sampler within its own scope, so ONE
// ConstantTimer declared at the Thread Group level (see buildJmxTemplate) paces every
// sampler in the whole test, rather than needing one copy per sampler.
function constantTimerXml(delayMs, testname) {
  return [
    `        <ConstantTimer guiclass="ConstantTimerGui" testclass="ConstantTimer" testname="${xmlEsc(testname)}" enabled="true">`,
    `          <stringProp name="ConstantTimer.delay">${delayMs}</stringProp>`,
    `        </ConstantTimer>`,
    `        <hashTree/>`,
  ].join('\n');
}

// Extractor for a value sourced from a RESPONSE HEADER rather than the JSON body (e.g. a
// `Location` header on a 201 Created, or a session token returned via a custom header) —
// a RegexExtractor with useHeaders=true, searching the raw header block text. Property
// keys/shape verified against a real captured .jmx (not guessed): RegexExtractor.useHeaders
// is the stringProp "true"/"false" switch, template uses Perl "$1$" group syntax.
//
// The regex's header-name portion is wrapped in the inline case-insensitive flag `(?i)` —
// preRunEngine.js's response header names come from the Fetch API's Headers.entries(),
// which the spec always normalizes to lowercase, but the REAL header text JMeter searches
// at runtime keeps whatever casing the target server actually sends (e.g. "Location", not
// "location"). Without (?i) a header detected as "location" would never match a live
// server that sends "Location", silently breaking the exact thing this extractor is for.
function headerRegexExtractorXml(headerName, varName) {
  const pattern = `(?i)${headerName}:\\s*(.+)`;
  return [
    `          <RegexExtractor guiclass="RegexExtractorGui" testclass="RegexExtractor" testname="Header Extractor - ${xmlEsc(varName)}" enabled="true">`,
    `            <stringProp name="RegexExtractor.useHeaders">true</stringProp>`,
    `            <stringProp name="RegexExtractor.refname">${xmlEsc(varName)}</stringProp>`,
    `            <stringProp name="RegexExtractor.regex">${xmlEsc(pattern)}</stringProp>`,
    `            <stringProp name="RegexExtractor.template">$1$</stringProp>`,
    `            <stringProp name="RegexExtractor.default">NOT_FOUND</stringProp>`,
    `            <stringProp name="RegexExtractor.match_number">1</stringProp>`,
    `          </RegexExtractor>`,
    `          <hashTree/>`,
  ].join('\n');
}

// Extractor for a value sourced from a COOKIE — cookies arrive as `Set-Cookie` response
// headers, so this is the same RegexExtractor/useHeaders mechanism as headerRegexExtractorXml
// above, just with a pattern matching `cookieName=value` (stopping at the next `;` — the
// rest of a Set-Cookie header is attributes like Path/HttpOnly/Max-Age, not part of the
// value) instead of `headerName: value`. Case-insensitive on the cookie name for the same
// reason as headers, even though cookie names are technically case-sensitive per spec —
// being lenient here costs nothing and matches this app's lowercase-normalized detection.
function cookieRegexExtractorXml(cookieName, varName) {
  const pattern = `(?i)${cookieName}=([^;\\r\\n]+)`;
  return [
    `          <RegexExtractor guiclass="RegexExtractorGui" testclass="RegexExtractor" testname="Cookie Extractor - ${xmlEsc(varName)}" enabled="true">`,
    `            <stringProp name="RegexExtractor.useHeaders">true</stringProp>`,
    `            <stringProp name="RegexExtractor.refname">${xmlEsc(varName)}</stringProp>`,
    `            <stringProp name="RegexExtractor.regex">${xmlEsc(pattern)}</stringProp>`,
    `            <stringProp name="RegexExtractor.template">$1$</stringProp>`,
    `            <stringProp name="RegexExtractor.default">NOT_FOUND</stringProp>`,
    `            <stringProp name="RegexExtractor.match_number">1</stringProp>`,
    `          </RegexExtractor>`,
    `          <hashTree/>`,
  ].join('\n');
}

function isLoginEp(ep) {
  const n = (ep.name || ep.testname || '').toLowerCase();
  const p = (ep.path || ep.url || '').toLowerCase();
  return /login|signin|sign-in|authenticate/.test(n) || /\/login|\/auth\/login|\/signin/.test(p);
}

// Detects every token-like field in the login response (reusing the same field-name list
// pre-run's live extraction uses — utils/preRunEngine.js — so a field pre-run captures at
// runtime, e.g. refreshToken, is also available here as its own JMeter variable). This lets
// a per-endpoint override (endpointOverrides, set via pre-run's "Fix with AI" action) request
// a *different* captured field than the default for its own Authorization header/body.
function detectCapturedFields(preRunData, loginEp) {
  if (!preRunData || !Array.isArray(preRunData)) return {};
  const loginName = (loginEp?.name || '').toLowerCase();
  const loginPath = (loginEp?.path || loginEp?.url || '').toLowerCase();
  // Match against the pre-run row's endpoint label AND its actual fired URL — a collection
  // whose login endpoint is simply named "Login" (no URL text in `r.endpoint`, per
  // ai.js's `endpoint: ep.name || ep.url`) previously matched nothing at all.
  const match = preRunData.find(r => {
    const label = (r.endpoint || '').toLowerCase();
    const url = (r.url || '').toLowerCase();
    return (loginName && label.includes(loginName)) ||
      (loginPath && (label.includes(loginPath) || url.includes(loginPath))) ||
      /login|signin|sign-in|authenticate/.test(label) ||
      url.includes('/login') || url.includes('/auth');
  });
  if (!match?.body) return {};
  let body;
  try { body = typeof match.body === 'string' ? JSON.parse(match.body) : match.body; } catch { return {}; }
  const fields = {};
  for (const k of TOKEN_KEYS) {
    if (typeof body[k] === 'string' && body[k].length > 8) fields[k] = { varName: k.replace(/[^a-zA-Z0-9]/g, '_'), jsonPath: `$.${k}` };
  }
  if (!Object.keys(fields).length) {
    for (const [k] of Object.entries(body)) {
      if (/token|jwt|bearer/i.test(k)) { fields[k] = { varName: k.replace(/[^a-zA-Z0-9]/g, '_'), jsonPath: `$.${k}` }; break; }
    }
  }
  return fields;
}

// Which captured field is used as the *default* Authorization value (no per-endpoint
// override) — same priority order pre-run's blanket 401-retry uses, deliberately
// excluding refresh-type fields (a refresh token should only be used where an explicit
// override says so, never as the generic default — that's the bug this whole feature fixes).
const DEFAULT_FIELD_PRIORITY = ['accessToken','access_token','token','jwt','bearerToken','bearer_token','authToken','id_token'];
function pickDefaultField(fields) {
  for (const k of DEFAULT_FIELD_PRIORITY) if (fields[k]) return fields[k];
  const anyKey = Object.keys(fields)[0];
  return anyKey ? fields[anyKey] : null;
}

// Translates the {{captured:KEY}} placeholders used in an endpointOverride's headers/body
// (same syntax the pre-run heal AI prompt is instructed to use) into a JMeter variable
// reference for whichever field KEY was actually detected — {{var}} for a plain collection
// variable is already handled by the existing toJmeterVar() and runs after this.
function applyOverridePlaceholders(str, capturedFields) {
  if (typeof str !== 'string') return str;
  return str.replace(/\{\{captured:(\w+)\}\}/g, (m, key) => capturedFields[key] ? `\${${capturedFields[key].varName}}` : m);
}

function toJmeterVar(v) {
  // Convert Postman {{var}} → JMeter ${var}
  return String(v ?? '').replace(/\{\{(\w+)\}\}/g, '$${$1}');
}

// True when a query-param value is already a `${...}` reference — a correlation variable,
// a transform-wrapped expression (which itself nests another `${...}` inside, e.g.
// `${__digest(MD5,${x},,,)}`), or a CSV/generator placeholder — rather than a literal
// string that still needs percent-encoding. Anchored to the whole string (not just a
// prefix) so a literal value that merely happens to CONTAIN "${" text somewhere isn't
// mistaken for a full placeholder.
function isPlaceholderRef(v) {
  return typeof v === 'string' && /^\$\{[\s\S]*\}$/.test(v);
}

// Resolves {{var}} tokens in a request body/header/query-param value against the
// collection's known variable map — delegates to the shared resolveForScript()
// (preRunEngine.js), the same rule autoHealer.js's mechanical {{var}} fix applies, so a
// script that's regenerated behaves identically to one auto-heal fixed in place.
const resolveTemplateVars = resolveForScript;

// Resolves the {protocol,url,port} an endpoint's raw URL targets — delegates to the single
// shared resolveUrlSet() (preRunEngine.js) that handles both nested {{var}} resolution and
// the port-variable fallback, so this file doesn't carry its own independent copy of that
// logic. Multi-host collections (e.g. Binance's Spot/Futures/Options/Wallet APIs) define one
// base-URL variable per API family instead of sharing a single host — this lets each
// endpoint be mapped back to the specific host its own {{var}} pointed to.
const resolveEndpointHost = resolveUrlSet;

function normalizeEp(ep, variables) {
  let epPath = ep.path || '';
  let urlQueryParams = {};

  // Always extract query params from the URL, regardless of whether ep.path is set.
  // This covers: cURL imports (only url set), Postman (url + queryParams), manual JSON
  // (path set but url may have query string), and OpenAPI (parameters array).
  const rawUrl = ep.url || ep.request?.url?.raw || '';
  if (rawUrl) {
    try {
      const parsed = new URL(rawUrl.startsWith('http') ? rawUrl : 'https://x' + rawUrl);
      // `.pathname` percent-encodes characters that aren't valid URL code points — including
      // { and } — so an unresolved Postman {{var}} path segment (e.g. /products/{{productId}})
      // comes back as /products/%7B%7BproductId%7D%7D, permanently destroying the template
      // before resolveTemplateVars() below ever gets a chance to convert it to ${var}. Decode
      // it back to plain text first; `.searchParams` (used just below) doesn't have this
      // problem since reading it already decodes.
      if (!epPath) { try { epPath = decodeURIComponent(parsed.pathname); } catch { epPath = parsed.pathname; } }
      parsed.searchParams.forEach(async (v, k) => { urlQueryParams[k] = v; });
    } catch {
      if (!epPath) epPath = rawUrl;                    // fallback: use raw string as path
    }
  }

  // Strip query string from path if it crept in (e.g. manual JSON with path="/users?q=1")
  const qIdx = epPath.indexOf('?');
  let queryParams = { ...urlQueryParams, ...(ep.params || ep.queryParams || {}) };
  if (qIdx !== -1) {
    new URLSearchParams(epPath.slice(qIdx + 1)).forEach(async (v, k) => { queryParams[k] = v; });
    epPath = epPath.slice(0, qIdx);
  }
  // Postman v2.1: request.url.query = [{ key, value, disabled }]
  const postmanQuery = ep.request?.url?.query || ep.url?.query;
  if (Array.isArray(postmanQuery)) {
    postmanQuery.forEach(async q => { if (q.key && !q.disabled) queryParams[q.key] = q.value ?? ''; });
  }
  // OpenAPI/Swagger: parameters = [{ in: 'query', name, example, default, schema }]
  if (Array.isArray(ep.parameters)) {
    ep.parameters.forEach(async p => {
      if (p.in === 'query' && p.name) {
        queryParams[p.name] = p.example ?? p.default ?? p.schema?.example ?? p.schema?.default ?? '';
      }
    });
  }
  // Resolve {{var}} in query param values: known collection variables become their real
  // value, unresolved ones fall back to JMeter's ${var} syntax.
  for (const k of Object.keys(queryParams)) queryParams[k] = resolveTemplateVars(queryParams[k], variables);
  // Same resolution for the path itself — Postman path variables (e.g. /products/{{productId}})
  // were previously left as literal "{{productId}}" text, which JMeter doesn't recognize as a
  // variable reference at all; it just percent-encodes the unsafe { } characters when building
  // the request, producing /products/%7B%7BproductId%7D%7D instead of a working ${productId}.
  epPath = resolveTemplateVars(epPath, variables);
  const rawHeaders = ep.headers || ep.request?.header || [];
  const headers = {};
  if (Array.isArray(rawHeaders)) rawHeaders.forEach(async h => { const k = h.key || h.name; if (k) headers[k] = h.value; });
  else if (typeof rawHeaders === 'object') Object.assign(headers, rawHeaders);
  // Same {{var}} resolution for header values (e.g. {{apiKey}} in a custom auth header).
  for (const k of Object.keys(headers)) headers[k] = resolveTemplateVars(headers[k], variables);

  let body = ep.body ?? ep.requestBody ?? ep.request?.body?.raw ?? null;
  if (body && typeof body === 'object') body = JSON.stringify(body, null, 2);
  // Same {{var}} resolution for the JSON/raw body — e.g. {"username": "{{username}}"}.
  // Must run before substituteCSVVars() so a variable that's ALSO a CSV column still
  // gets the ${col} treatment (substituteCSVVars matches by key name regardless of the
  // value it finds there).
  if (typeof body === 'string') body = resolveTemplateVars(body, variables);

  const method = (ep.method || ep.request?.method || 'GET').toUpperCase();
  return { name: ep.name || ep.testname || epPath || 'HTTP Request', method, path: epPath, headers, body, queryParams };
}

function escapeRegexStr(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Builds a map of { lowercaseValue → columnName } from the actual CSV row data.
 * Used to detect when a query-param VALUE happens to be a CSV data value so we
 * can replace e.g. ?q=emilys → ?q=${username} automatically.
 * Only indexes string values with 2+ chars to avoid false-positives on numbers.
 */
function buildCsvValueMap(testDataFiles) {
  const valueMap = new Map(); // lc(value) → columnName
  for (const f of (testDataFiles || [])) {
    // f.__content is pre-read content for PAT-mode workspaces (no local file to read here —
    // see generateScriptForSuite, which populates it from the gitEngine session up front).
    // SSH-mode workspaces still have a real local file, read directly as before.
    if (f.__content === undefined && (!f.path || !fs.existsSync(f.path))) continue;
    try {
      const { headers, rows } = f.__content !== undefined ? readCsvContent(f.__content, 50) : readCsv(f.path, 50); // sample first 50 rows
      for (let ci = 0; ci < headers.length; ci++) {
        const col = headers[ci];
        if (!col) continue;
        for (const row of rows) {
          const cell = (row[ci] || '').trim();
          if (cell.length >= 2) {
            valueMap.set(cell.toLowerCase(), col);
          }
        }
      }
    } catch (_) {}
  }
  return valueMap;
}

function substituteCSVVars(body, csvCols) {
  if (!body || !csvCols.length) return body;
  let result = body;
  for (const col of csvCols) {
    if (!col) continue;
    const esc = escapeRegexStr(col);
    // Replace string values: "colName": "anyValue" (skip if already a JMeter variable)
    result = result.replace(
      new RegExp(`("${esc}"\\s*:\\s*)"(?!\\$\\{${esc}\\})[^"]*"`, 'gi'),
      `$1"\${${col}}"`
    );
    // Replace numeric / boolean / null values without quotes so JMeter inlines the raw value
    result = result.replace(
      new RegExp(`("${esc}"\\s*:\\s*)(-?\\d+(?:\\.\\d+)?|true|false|null)(?=[,\\s\\n\\r}])`, 'gi'),
      `$1\${${col}}`
    );
  }
  return result;
}

// Full nested folder path for an endpoint — parseCollection.js's `folderPath` is the whole
// ancestor chain ("Auth / Login / Sub"), while `folder` is only the first (top-level)
// ancestor; prefer folderPath so nested Postman folders become nested Simple Controllers
// instead of being flattened into one top-level group.
function folderPathSegments(ep) {
  if (ep.folderPath) return ep.folderPath.split(' / ').filter(Boolean);
  if (ep.folder) return [ep.folder];
  return [];
}

// Builds a tree mirroring the recorded folder hierarchy: { order, children: Map<name,node>,
// endpoints } — `order` preserves first-seen folder order (so output order is stable and
// predictable), `endpoints` holds whatever sits directly at that level (no subfolder).
function buildFolderTree(endpoints) {
  const root = { order: [], children: new Map(), endpoints: [] };
  for (const ep of endpoints) {
    let node = root;
    for (const seg of folderPathSegments(ep)) {
      if (!node.children.has(seg)) {
        node.children.set(seg, { order: [], children: new Map(), endpoints: [] });
        node.order.push(seg);
      }
      node = node.children.get(seg);
    }
    node.endpoints.push(ep);
  }
  return root;
}

function indentBlock(str, spaces) {
  const pad = ' '.repeat(spaces);
  return str.split('\n').map(l => pad + l).join('\n');
}

// Recursively emits a folder tree node: endpoints sitting directly at this level first
// (no wrapper), then each subfolder as a nested Simple Controller (GenericController) —
// JMeter allows a controller's hashTree to mix samplers and further controllers as
// siblings, so a folder with both its own endpoints AND subfolders is naturally supported.
// `ctx` carries everything a sampler needs (see buildSamplerXml's params) plus the shared
// login/token-extraction state, threaded by reference so it stays correct across recursion.
function renderFolderNode(node, ctx) {
  const parts = [];
  for (const ep of node.endpoints) {
    const isLogin = ep === ctx.loginEp;
    parts.push(buildSamplerXml(
      ep, isLogin, ctx.tokenState.extracted ? ctx.tokenVar : null,
      ctx.allCsvCols, ctx.csvValueMap, ctx.hostVarsFor(ep), ctx.overrideFor(ep),
      ctx.capturedFields, ctx.variables, ctx.sourceFieldsFor(ep), ctx.targetRulesFor(ep), ctx.generatorRulesFor(ep),
    ));
    if (isLogin) ctx.tokenState.extracted = true;
  }
  for (const name of node.order) {
    const childXml = renderFolderNode(node.children.get(name), ctx);
    parts.push([
      `        <GenericController guiclass="LogicControllerGui" testclass="GenericController" testname="${xmlEsc(name)}" enabled="true">`,
      `          <stringProp name="TestPlan.comments"></stringProp>`,
      `        </GenericController>`,
      `        <hashTree>`,
      indentBlock(childXml, 2),
      `        </hashTree>`,
    ].join('\n'));
  }
  return parts.join('\n');
}

function buildSamplerXml(ep, isLogin, tokenVar, csvCols, csvValueMap, hostVars, override, capturedFields, variables, sourceFields, targetRules, generatorRules) {
  // Full correlation (tokens, query params, path segments, body fields) rewrites the
  // endpoint's own recorded literals to ${var} BEFORE anything else touches them (override
  // merge, CSV substitution) — those only ever act on values that are still literal. A
  // user-attached generator (fieldGenerators.js) runs right after — its own stale-value
  // guard means it silently no-ops on anything correlation already replaced.
  const preGenerated = substituteCorrelatedLiterals(normalizeEp(ep, variables), targetRules, 'jmeter');
  const { name, method, path: epPath, headers, body: rawBody, queryParams } = applyFieldGenerators(preGenerated, generatorRules, 'jmeter');
  const { protocol: protoVar = 'PROTOCOL', server: serverVar = 'SERVER', port: portVar = 'PORT' } = hostVars || {};
  const lines = [];
  // A saved per-endpoint fix (endpointOverrides, from pre-run's "Fix with AI" action)
  // always wins over the endpoint's own stored body — it's the known-correct request now.
  // The AI sometimes returns "body" as a JSON object rather than a pre-stringified string
  // (same ambiguity normalizeEp() handles for ep.body above) — String() on an object would
  // silently produce the literal text "[object Object]" instead of the intended JSON.
  let overrideBody = override?.body;
  if (overrideBody !== undefined && typeof overrideBody !== 'string') overrideBody = JSON.stringify(overrideBody, null, 2);
  const body = overrideBody !== undefined ? toJmeterVar(applyOverridePlaceholders(overrideBody, capturedFields || {})) : rawBody;
  const isBody = ['POST', 'PUT', 'PATCH'].includes(method) && body;

  lines.push(`        <HTTPSamplerProxy guiclass="HttpTestSampleGui" testclass="HTTPSamplerProxy" testname="${xmlEsc(name)}" enabled="true">`);
  lines.push(`          <stringProp name="HTTPSampler.domain">\${${serverVar}}</stringProp>`);
  lines.push(`          <stringProp name="HTTPSampler.port">\${${portVar}}</stringProp>`);
  lines.push(`          <stringProp name="HTTPSampler.protocol">\${${protoVar}}</stringProp>`);
  // Build query string with CSV value substitution (used only for POST/PUT/PATCH inline path)
  const queryString = Object.entries(queryParams)
    .map(([k, v]) => {
      let resolvedVal;
      if (csvCols.includes(k)) {
        resolvedVal = `\${${k}}`;
      } else if (csvValueMap && csvValueMap.has(String(v).toLowerCase())) {
        resolvedVal = `\${${csvValueMap.get(String(v).toLowerCase())}}`;
      } else if (isPlaceholderRef(v)) {
        // Already a correlation/generator ${...} reference (or a transform-wrapped one) —
        // percent-encoding it here would corrupt the placeholder text itself (e.g. "${" ->
        // "%24%7B"), which JMeter would then send to the server literally instead of
        // resolving. Pass it through untouched; JMeter resolves the reference at runtime,
        // encoding whatever real value comes out of it via the sampler's own handling.
        resolvedVal = v;
      } else {
        resolvedVal = encodeURIComponent(String(v));
      }
      return `${encodeURIComponent(k)}=${resolvedVal}`;
    })
    .join('&');
  const fullPath = (isBody && queryString) ? `${epPath}?${queryString}` : epPath;
  lines.push(`          <stringProp name="HTTPSampler.path">${xmlEsc(fullPath)}</stringProp>`);
  lines.push(`          <stringProp name="HTTPSampler.method">${method}</stringProp>`);
  lines.push(`          <boolProp name="HTTPSampler.follow_redirects">true</boolProp>`);
  lines.push(`          <boolProp name="HTTPSampler.auto_redirects">false</boolProp>`);
  lines.push(`          <boolProp name="HTTPSampler.use_keepalive">true</boolProp>`);
  lines.push(`          <boolProp name="HTTPSampler.DO_MULTIPART_POST">false</boolProp>`);

  if (isBody) {
    const processedBody = substituteCSVVars(body, csvCols);
    lines.push(`          <boolProp name="HTTPSampler.postBodyRaw">true</boolProp>`);
    lines.push(`          <elementProp name="HTTPsampler.Arguments" elementType="Arguments">`);
    lines.push(`            <collectionProp name="Arguments.arguments">`);
    lines.push(`              <elementProp name="" elementType="HTTPArgument">`);
    lines.push(`                <boolProp name="HTTPArgument.always_encode">false</boolProp>`);
    lines.push(`                <stringProp name="Argument.value">${xmlEsc(processedBody)}</stringProp>`);
    lines.push(`                <stringProp name="Argument.metadata">=</stringProp>`);
    lines.push(`              </elementProp>`);
    lines.push(`            </collectionProp>`);
    lines.push(`          </elementProp>`);
  } else {
    lines.push(`          <boolProp name="HTTPSampler.postBodyRaw">false</boolProp>`);
    lines.push(`          <elementProp name="HTTPsampler.Arguments" elementType="Arguments" guiclass="HTTPArgumentsPanel" testclass="Arguments" testname="User Defined Variables">`);
    const paramEntries = Object.entries(queryParams);
    if (paramEntries.length) {
      lines.push(`            <collectionProp name="Arguments.arguments">`);
      for (const [k, v] of paramEntries) {
        let val;
        if (csvCols.includes(k)) {
          // Param name matches a CSV column name exactly → use that column var
          val = `\${${k}}`;
        } else if (csvValueMap && csvValueMap.has(String(v).toLowerCase())) {
          // Param VALUE matches an actual CSV data value → parameterize with that column
          val = `\${${csvValueMap.get(String(v).toLowerCase())}}`;
        } else {
          val = String(v);
        }
        lines.push(`              <elementProp name="${xmlEsc(k)}" elementType="HTTPArgument">`);
        lines.push(`                <stringProp name="Argument.name">${xmlEsc(k)}</stringProp>`);
        lines.push(`                <stringProp name="Argument.value">${xmlEsc(val)}</stringProp>`);
        lines.push(`                <stringProp name="Argument.metadata">=</stringProp>`);
        lines.push(`                <boolProp name="HTTPArgument.use_equals">true</boolProp>`);
        lines.push(`              </elementProp>`);
      }
      lines.push(`            </collectionProp>`);
    } else {
      lines.push(`            <collectionProp name="Arguments.arguments"/>`);
    }
    lines.push(`          </elementProp>`);
  }
  lines.push(`        </HTTPSamplerProxy>`);

  // Sampler hashTree: HeaderManager + optional JSONPostProcessor
  lines.push(`        <hashTree>`);
  const headerEntries = [{ name: 'Content-Type', value: 'application/json' }];
  // Recorded/correlated headers are added FIRST so a specific correlation rule (e.g. this
  // endpoint's Authorization needs ${refreshToken}, not the blanket default) wins; the
  // blanket "any non-login request gets the default token" fallback below only fires when
  // this endpoint recorded no Authorization header of its own to correlate.
  for (const [k, v] of Object.entries(headers)) {
    if (!headerEntries.find(h => h.name.toLowerCase() === k.toLowerCase()))
      headerEntries.push({ name: k, value: String(v) });
  }
  if (!isLogin && tokenVar && !headerEntries.find(h => h.name.toLowerCase() === 'authorization')) {
    headerEntries.push({ name: 'Authorization', value: `Bearer \${${tokenVar}}` });
  }
  // A saved per-endpoint fix normally wins — add or replace by header name (e.g. swap the
  // default accessToken Authorization value for {{captured:refreshToken}}'s JMeter var) —
  // UNLESS a confirmed correlation rule already targets this exact header, in which case
  // the rule wins instead. The rule is the newer, more reliable source of truth (it threads
  // a real live value through detection, not a static AI guess); an override predating that
  // rule commonly references a field `capturedFields` has no entry for at all (e.g. a
  // cookie-sourced value — detectCapturedFields below never covers cookies), so applying it
  // here would silently bake an unresolvable {{captured:X}} placeholder — syntax JMeter has
  // never supported — directly into the script, clobbering output the rule already got right.
  if (override?.headers) {
    const correlatedHeaderKeys = new Set((targetRules || []).filter(r => r.targetLocation === 'header').map(r => String(r.targetKey).toLowerCase()));
    for (const [k, v] of Object.entries(override.headers)) {
      if (correlatedHeaderKeys.has(k.toLowerCase())) continue;
      const translated = toJmeterVar(applyOverridePlaceholders(String(v), capturedFields || {}));
      const existing = headerEntries.find(h => h.name.toLowerCase() === k.toLowerCase());
      if (existing) existing.value = translated;
      else headerEntries.push({ name: k, value: translated });
    }
  }
  lines.push(`          <HeaderManager guiclass="HeaderPanel" testclass="HeaderManager" testname="HTTP Header Manager" enabled="true">`);
  lines.push(`            <collectionProp name="HeaderManager.headers">`);
  for (const h of headerEntries) {
    lines.push(`              <elementProp name="${xmlEsc(h.name)}" elementType="Header">`);
    lines.push(`                <stringProp name="Header.name">${xmlEsc(h.name)}</stringProp>`);
    lines.push(`                <stringProp name="Header.value">${xmlEsc(h.value)}</stringProp>`);
    lines.push(`              </elementProp>`);
  }
  lines.push(`            </collectionProp>`);
  lines.push(`          </HeaderManager>`);
  lines.push(`          <hashTree/>`);
  lines.push(responseAssertionXml(`${name} status is 2xx/3xx`));

  // One extractor per confirmed correlation rule sourced from THIS endpoint's response —
  // not just the login endpoint's token fields anymore. Falls back to the legacy
  // login-only token detection only when this collection has no correlationRules at all
  // yet (e.g. pre-run hasn't been re-run since upgrading), so older scripts keep working.
  const fieldsToExtract = (sourceFields && sourceFields.length)
    ? sourceFields
    : (isLogin
        ? (capturedFields && Object.keys(capturedFields).length
            ? Object.values(capturedFields)
            : [{ varName: tokenVar || 'accessToken', jsonPath: tokenVar ? `$.${tokenVar.replace(/_/g, '')}` : '$.accessToken' }])
        : []);
  if (fieldsToExtract.length) {
    for (const { varName, jsonPath, sourceLocation } of fieldsToExtract) {
      if (sourceLocation === 'header') {
        lines.push(headerRegexExtractorXml(jsonPath, varName));
        continue;
      }
      if (sourceLocation === 'cookie') {
        lines.push(cookieRegexExtractorXml(jsonPath, varName));
        continue;
      }
      lines.push(`          <JSONPostProcessor guiclass="JSONPostProcessorGui" testclass="JSONPostProcessor" testname="JSON Extractor - ${xmlEsc(varName)}" enabled="true">`);
      lines.push(`            <stringProp name="JSONPostProcessor.referenceNames">${xmlEsc(varName)}</stringProp>`);
      lines.push(`            <stringProp name="JSONPostProcessor.jsonPathExprs">${xmlEsc(jsonPath)}</stringProp>`);
      lines.push(`            <stringProp name="JSONPostProcessor.match_numbers">1</stringProp>`);
      lines.push(`            <stringProp name="JSONPostProcessor.defaultValues">NOT_FOUND</stringProp>`);
      lines.push(`          </JSONPostProcessor>`);
      lines.push(`          <hashTree/>`);
    }
  }
  lines.push(`        </hashTree>`);
  return lines.join('\n');
}

function buildJmxTemplate(suite, collection, testDataFiles, cfg, endpoints, preRunData) {
  // Accept single file or array for backward compat
  if (!Array.isArray(testDataFiles)) testDataFiles = testDataFiles ? [testDataFiles] : [];

  const name = suite.name || 'Test Plan';
  const iterMode = suite.iter_mode || 'duration';
  const vusers = suite.vusers || 50;
  const rampup = suite.rampup || 30;
  const loops  = suite.loops || 1;
  const duration = suite.duration || 300;

  // Resolve server/protocol/port from config
  // Multi-host support: a single collection can span several API families with different
  // base hosts (e.g. Binance's Spot/Futures/Options/Wallet APIs, each via its own {{var}}).
  // Resolve every endpoint's own host first — needed both for the multi-host indexed UDVs
  // below AND as a fallback for the single-host default (right after) when
  // collection_env_config.urls hasn't been populated yet, e.g. a collection whose base URL
  // is itself a template (baseUrl = "{{protocol}}://{{host}}") that hasn't been re-saved
  // since {{var}} auto-populate was fixed to resolve that kind of indirection.
  const variables = cfg.variables || {};
  const hostKey = h => `${h.protocol}|${h.url}|${h.port}`;
  const hostList = [];
  const hostIndexByKey = new Map();
  const epHostIndex = new Map();
  for (const ep of endpoints) {
    const resolved = resolveEndpointHost(ep.url || ep.path || '', variables);
    if (!resolved) continue;
    const key = hostKey(resolved);
    if (!hostIndexByKey.has(key)) { hostIndexByKey.set(key, hostList.length); hostList.push(resolved); }
    epHostIndex.set(ep, hostIndexByKey.get(key));
  }
  const multiHost = hostList.length > 1;

  // Resolve server/protocol/port for the single-host default: a real `collection_env_config`
  // URL wins if present, otherwise fall back to whatever host the endpoints themselves
  // resolve to via {{var}} — so this never silently generates a script with an empty host
  // just because the env config's `urls` array hasn't caught up yet.
  const configuredUrl = (cfg.urls || []).find(u => u?.url);
  const fallbackHost = !multiHost ? hostList[0] : null;
  const { protocol = 'https', url: server = '', port = '443' } = configuredUrl || fallbackHost || { protocol: cfg.protocol, url: cfg.url, port: cfg.port };
  // Endpoints whose host couldn't be resolved (relative path, missing variable value)
  // default to host #1 — same as the single-host fallback below.
  function hostVarsFor(ep) {
    if (!multiHost) return null; // null → buildSamplerXml uses plain PROTOCOL/SERVER/PORT
    const n = (epHostIndex.get(ep) ?? 0) + 1;
    return { protocol: `PROTOCOL_${n}`, server: `SERVER_${n}`, port: `PORT_${n}` };
  }

  // Parse CSV metadata for each file
  const csvMeta = testDataFiles.map((f, i) => {
    const dir  = path.dirname(f.path).replace(/\\/g, '/');
    const file = path.basename(f.path);
    let colsRaw = [];
    try { colsRaw = JSON.parse(f.columns); } catch { colsRaw = (f.columns || '').split(','); }
    const cols = colsRaw.map(c => c.trim()).filter(Boolean);
    // Single file keeps old var names; multiple files use numbered vars
    const pathVar = testDataFiles.length === 1 ? 'CSV_PATH' : `CSV_PATH_${i + 1}`;
    const fileVar = testDataFiles.length === 1 ? 'CSV_FILE' : `CSV_FILE_${i + 1}`;
    return { dir, file, cols, colsStr: cols.join(','), pathVar, fileVar, original_name: f.original_name || file };
  });

  // All CSV column names combined (for variable substitution across all files)
  const allCsvCols = csvMeta.flatMap(m => m.cols);

  // Value-based CSV map: lowercaseValue → columnName (for smart query-param detection)
  const csvValueMap = buildCsvValueMap(testDataFiles);

  // Login & token detection — captures every token-like field (not just the default one),
  // so a per-endpoint override can reference a specific field (e.g. refreshToken).
  const loginEp        = endpoints.find(isLoginEp) || null;
  const capturedFields = loginEp ? detectCapturedFields(preRunData, loginEp) : {};
  const tokenInfo       = loginEp ? (pickDefaultField(capturedFields) || { varName: 'accessToken', jsonPath: '$.accessToken' }) : null;
  const tokenVar        = tokenInfo?.varName || null;

  // Per-endpoint fixes applied via pre-run's "Fix with AI" heal action (cfg.endpointOverrides,
  // stored on collection_env_config — same row this suite's envCfg was already merged from).
  // Keyed by the endpoint's position in the original `endpoints` array (same indexing
  // routes/ai.js's pre-run uses), validated against a method+name fingerprint so a stale
  // override left over from before a collection re-import isn't silently misapplied.
  const endpointOverrides = cfg.endpointOverrides || {};
  const epIndexOf = new Map(endpoints.map((e, i) => [e, i]));
  function overrideFor(ep) {
    const saved = endpointOverrides[epIndexOf.get(ep)];
    return fingerprintMatches(ep, saved) ? saved : null;
  }

  // Full correlation — tokens, query params, path segments, body fields — from
  // collection_env_config.correlationRules (utils/correlationEngine.js + ai.js's
  // /pre-run route). Only rules a human confirmed, or detection was confident about,
  // are ever burned into the script (see scriptCorrelation.filterApplicableRules).
  const correlationRules = filterApplicableRules(cfg.correlationRules);
  const rulesBySource = groupRulesBySource(correlationRules);
  const rulesByTarget = groupRulesByTarget(correlationRules);
  function sourceFieldsFor(ep) { return rulesBySource.get(epIndexOf.get(ep)) || []; }
  function targetRulesFor(ep) { return rulesByTarget.get(epIndexOf.get(ep)) || []; }

  // User-attached generators (fieldGenerators.js) for a recorded literal that never came
  // from any earlier response — a unique email/username/idempotency key. Always
  // user-authored (see groupGeneratorsByTarget), never auto-detected.
  const generatorsByTarget = groupGeneratorsByTarget(cfg.fieldGenerators);
  function generatorRulesFor(ep) { return generatorsByTarget.get(epIndexOf.get(ep)) || []; }

  // User Defined Variables — rt:true vars use ${__P(NAME,default)} so they can be
  // overridden at run time: jmeter -n -t script.jmx -JTHREADS=100 -JDURATION=600 -JRAMP_UP=60
  //
  // Single-host collections keep the plain PROTOCOL/SERVER/PORT names (unchanged from
  // before). Multi-host collections get PROTOCOL_N/SERVER_N/PORT_N per distinct host
  // instead — no plain/unindexed set, since it would just be a confusing duplicate of
  // whichever host happened to be first.
  const RESERVED_UDV_NAMES = new Set([
    'PROTOCOL', 'SERVER', 'PORT', 'THREADS', 'RAMP_UP', 'DURATION', 'LOOP_COUNT',
    ...csvMeta.flatMap(m => [m.pathVar, m.fileVar]),
    ...(multiHost ? hostList.flatMap((_, i) => [`PROTOCOL_${i + 1}`, `SERVER_${i + 1}`, `PORT_${i + 1}`]) : []),
  ]);
  // Collection environment variables (e.g. username/password from an imported Postman
  // env file). normalizeEp() already inlines any {{var}} whose value it can resolve
  // directly into the request text — but whenever it can't (resolveForScript's fallback
  // to a bare ${var} reference), nothing ever defined that variable anywhere in the
  // script, so JMeter sent the literal, un-substituted "${var}" text instead of a real
  // value. Declare every collection variable as a User Defined Variable — same treatment
  // PROTOCOL/SERVER/PORT/THREADS already get — so any ${var} left in the script resolves.
  // A collection variable's own value can itself be a template referencing other variables
  // (e.g. baseUrl = "{{protocol}}://{{host}}") — resolve those against the full variables
  // map before declaring the UDV, otherwise the literal "{{protocol}}"/"{{host}}" text ends
  // up baked into the script even though every *request* in it already resolved correctly.
  // Auto-heal's mechanical {{var}} scan can't tell "unused declarative UDV" apart from "a
  // template a live request actually sends", so a leftover unresolved one here gets reported
  // as a guaranteed failure cause on every heal cycle even though it never affected any request.
  const collectionVarUdv = Object.entries(variables)
    .filter(([k, v]) => k && !RESERVED_UDV_NAMES.has(k.toUpperCase()) && v !== null && typeof v !== 'object')
    .map(([k, v]) => ({ n: k, v: resolveTemplateVars(String(v ?? ''), variables) }));
  const udv = [
    ...(multiHost
      ? hostList.flatMap((h, i) => [
          { n: `PROTOCOL_${i + 1}`, v: h.protocol,          rt: true },
          { n: `SERVER_${i + 1}`,   v: h.url,               rt: true },
          { n: `PORT_${i + 1}`,     v: String(h.port || ''), rt: true },
        ])
      : [
          { n: 'PROTOCOL', v: protocol,        rt: true },
          { n: 'SERVER',   v: server,          rt: true },
          { n: 'PORT',     v: String(port),    rt: true },
        ]),
    { n: 'THREADS',    v: String(vusers),  rt: true },
    { n: 'RAMP_UP',    v: String(rampup),  rt: true },
    ...(iterMode === 'loops'
      ? [{ n: 'LOOP_COUNT', v: String(loops),    rt: true }]
      : [{ n: 'DURATION',   v: String(duration), rt: true }, { n: 'LOOP_COUNT', v: '-1' }]),
    ...csvMeta.flatMap(m => [{ n: m.pathVar, v: m.dir }, { n: m.fileVar, v: m.file }]),
    ...collectionVarUdv,
  ];

  // Runtime override comment — all UPPERCASE vars accept -J flags. Multi-host collections
  // expose one -JSERVER_N/-JPROTOCOL_N/-JPORT_N triplet per distinct host instead of a
  // single -JSERVER.
  const hostOverrideFlags = multiHost
    ? hostList.map((_, i) => `-JPROTOCOL_${i + 1}=https -JSERVER_${i + 1}=api.example.com -JPORT_${i + 1}=443`).join(' ')
    : '-JPROTOCOL=https -JSERVER=api.example.com -JPORT=443';

  const L = []; // output lines
  L.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  L.push(`<!-- Runtime override: jmeter -n -t script.jmx -JTHREADS=100 -JRAMP_UP=60 -JDURATION=600 ${hostOverrideFlags} -->`);
  L.push(`<jmeterTestPlan version="1.2" properties="5.0" jmeter="5.6.3">`);
  L.push(`  <hashTree>`);
  L.push(`    <TestPlan guiclass="TestPlanGui" testclass="TestPlan" testname="${xmlEsc(name)}" enabled="true">`);
  L.push(`      <stringProp name="TestPlan.comments">Runtime override: jmeter -n -t script.jmx -JTHREADS=100 -JRAMP_UP=60 -JDURATION=600</stringProp>`);
  L.push(`      <boolProp name="TestPlan.functional_mode">false</boolProp>`);
  L.push(`      <boolProp name="TestPlan.tearDown_on_shutdown">true</boolProp>`);
  L.push(`      <boolProp name="TestPlan.serialize_threadgroups">false</boolProp>`);
  L.push(`      <elementProp name="TestPlan.user_defined_variables" elementType="Arguments" guiclass="ArgumentsPanel" testclass="Arguments" testname="User Defined Variables" enabled="true">`);
  L.push(`        <collectionProp name="Arguments.arguments"/>`);
  L.push(`      </elementProp>`);
  L.push(`      <stringProp name="TestPlan.user_define_classpath"></stringProp>`);
  L.push(`    </TestPlan>`);
  L.push(`    <hashTree>`);

  // User Defined Variables
  L.push(`      <Arguments guiclass="ArgumentsPanel" testclass="Arguments" testname="User Defined Variables">`);
  L.push(`        <collectionProp name="Arguments.arguments">`);
  for (const { n, v, rt } of udv) L.push(udvEntry(n, v, !!rt));
  L.push(`        </collectionProp>`);
  L.push(`      </Arguments>`);
  L.push(`      <hashTree/>`);

  // Listeners
  L.push(listenerXml('View Results Tree', 'ViewResultsFullVisualizer'));
  L.push(`      <hashTree/>`);
  L.push(listenerXml('Aggregate Report', 'StatVisualizer'));
  L.push(`      <hashTree/>`);

  // Thread Group
  L.push(`      <ThreadGroup guiclass="ThreadGroupGui" testclass="ThreadGroup" testname="Thread Group">`);
  L.push(`        <stringProp name="ThreadGroup.num_threads">\${THREADS}</stringProp>`);
  L.push(`        <stringProp name="ThreadGroup.ramp_time">\${RAMP_UP}</stringProp>`);
  L.push(`        <boolProp name="ThreadGroup.same_user_on_next_iteration">true</boolProp>`);
  L.push(`        <stringProp name="ThreadGroup.on_sample_error">continue</stringProp>`);
  if (iterMode === 'loops') {
    L.push(`        <elementProp name="ThreadGroup.main_controller" elementType="LoopController" guiclass="LoopControlPanel" testclass="LoopController">`);
    L.push(`          <stringProp name="LoopController.loops">\${LOOP_COUNT}</stringProp>`);
    L.push(`          <boolProp name="LoopController.continue_forever">false</boolProp>`);
    L.push(`        </elementProp>`);
  } else {
    L.push(`        <boolProp name="ThreadGroup.scheduler">true</boolProp>`);
    L.push(`        <stringProp name="ThreadGroup.duration">\${DURATION}</stringProp>`);
    L.push(`        <elementProp name="ThreadGroup.main_controller" elementType="LoopController" guiclass="LoopControlPanel" testclass="LoopController">`);
    L.push(`          <intProp name="LoopController.loops">-1</intProp>`);
    L.push(`          <boolProp name="LoopController.continue_forever">true</boolProp>`);
    L.push(`        </elementProp>`);
  }
  L.push(`      </ThreadGroup>`);
  L.push(`      <hashTree>`);

  // HTTP Request Defaults — every sampler sets its own domain/port/protocol explicitly
  // (see buildSamplerXml), so this is only a fallback; point it at host #1 when multi-host.
  const defaultHostVars = multiHost ? { server: 'SERVER_1', port: 'PORT_1', protocol: 'PROTOCOL_1' } : { server: 'SERVER', port: 'PORT', protocol: 'PROTOCOL' };
  L.push(`        <ConfigTestElement guiclass="HttpDefaultsGui" testclass="ConfigTestElement" testname="HTTP Request Defaults">`);
  L.push(`          <stringProp name="HTTPSampler.domain">\${${defaultHostVars.server}}</stringProp>`);
  L.push(`          <stringProp name="HTTPSampler.port">\${${defaultHostVars.port}}</stringProp>`);
  L.push(`          <stringProp name="HTTPSampler.protocol">\${${defaultHostVars.protocol}}</stringProp>`);
  L.push(`          <elementProp name="HTTPsampler.Arguments" elementType="Arguments" guiclass="HTTPArgumentsPanel" testclass="Arguments" testname="User Defined Variables">`);
  L.push(`            <collectionProp name="Arguments.arguments"/>`);
  L.push(`          </elementProp>`);
  L.push(`          <stringProp name="HTTPSampler.implementation"></stringProp>`);
  L.push(`        </ConfigTestElement>`);
  L.push(`        <hashTree/>`);

  // CSV Data Set Config — one block per file
  for (const m of csvMeta) {
    L.push(`        <CSVDataSet guiclass="TestBeanGUI" testclass="CSVDataSet" testname="${xmlEsc(m.original_name)}">`);
    L.push(`          <stringProp name="filename">\${${m.pathVar}}/\${${m.fileVar}}</stringProp>`);
    L.push(`          <stringProp name="fileEncoding">UTF-8</stringProp>`);
    L.push(`          <stringProp name="variableNames">${xmlEsc(m.colsStr)}</stringProp>`);
    L.push(`          <stringProp name="delimiter">,</stringProp>`);
    L.push(`          <boolProp name="ignoreFirstLine">true</boolProp>`);
    L.push(`          <boolProp name="recycle">true</boolProp>`);
    L.push(`          <boolProp name="stopThread">false</boolProp>`);
    L.push(`          <boolProp name="quotedData">false</boolProp>`);
    L.push(`          <stringProp name="shareMode">shareMode.all</stringProp>`);
    L.push(`        </CSVDataSet>`);
    L.push(`        <hashTree/>`);
  }

  // Think-time pacing — one Timer at Thread Group scope applies to every sampler beneath
  // it, matching k6's flat `sleep(1)` between every request without needing a copy per
  // sampler (see constantTimerXml's comment for why scope alone is enough).
  L.push(constantTimerXml(1000, 'Think Time'));

  // HTTP Samplers — grouped by folder using Simple Controllers when folders exist.
  // Login endpoint always comes first regardless of folder — UNLESS it's itself a
  // correlation target (depends on a value from some other endpoint's response), in which
  // case moving it to position 0 would emit it before its own source's extractor exists.
  // Every other correlation source→target pair is already safe: detectCorrelations only
  // ever points backward in the original endpoints array, and reordering everything else
  // around login preserves each pair's original relative order.
  const loginHasInboundCorrelation = loginEp && targetRulesFor(loginEp).length > 0;
  const ordered = (loginEp && !loginHasInboundCorrelation)
    ? [loginEp, ...endpoints.filter(e => e !== loginEp)]
    : [...endpoints];

  // Nested Simple Controllers mirroring each endpoint's full recorded folder path (not
  // just the top-level folder) — an endpoint with no folder info at all just lands at the
  // tree root and renders flat, with no wrapper, so this naturally covers the old
  // no-folders case too.
  const folderTree = buildFolderTree(ordered);
  L.push(renderFolderNode(folderTree, {
    loginEp, tokenVar, allCsvCols, csvValueMap, hostVarsFor, overrideFor, capturedFields,
    variables, sourceFieldsFor, targetRulesFor, generatorRulesFor, tokenState: { extracted: false },
  }));

  L.push(`      </hashTree>`); // ThreadGroup hashTree
  L.push(`    </hashTree>`);   // TestPlan hashTree
  L.push(`  </hashTree>`);
  L.push(`</jmeterTestPlan>`);
  return L.join('\n');
}

function generateJmx(userId, suite, collection, testDataFiles, cfg, endpoints, rules, preRunData, testType) {
  return buildJmxTemplate(suite, collection, testDataFiles, cfg, endpoints, preRunData);
}

// Builds one k6 http.*() call + its check() + any correlation extractors, from the same
// normalizeEp()/substituteCorrelatedLiterals()/substituteCSVVars() pipeline buildSamplerXml
// uses for JMX — a `${var}` placeholder those produce is valid JMeter property syntax AND
// valid JS template-literal interpolation, so the exact same substitution output can be
// embedded directly into a backtick-quoted k6 URL/body/header without any translation step.
function buildK6Request(ep, index, ctx) {
  const { isLogin, tokenVar, csvCols, csvValueMap, override, capturedFields, variables, sourceFields, targetRules, generatorRules } = ctx;

  const correlated = substituteCorrelatedLiterals(normalizeEp(ep, variables), targetRules, 'k6');
  const normalized = applyFieldGenerators(correlated, generatorRules, 'k6');
  const { name, method, path: epPath, headers, body: rawBody, queryParams } = normalized;

  let overrideBody = override?.body;
  if (overrideBody !== undefined && typeof overrideBody !== 'string') overrideBody = JSON.stringify(overrideBody, null, 2);
  let body = overrideBody !== undefined ? toJmeterVar(applyOverridePlaceholders(overrideBody, capturedFields || {})) : rawBody;

  const isBody = ['POST', 'PUT', 'PATCH'].includes(method) && body;
  if (isBody) body = substituteCSVVars(body, csvCols);

  // Query params always fold into the URL for k6 — its http module has no separate
  // "arguments" concept the way a JMeter sampler does.
  const queryString = Object.entries(queryParams).map(([k, v]) => {
    let val;
    if (csvCols.includes(k)) val = `\${${k}}`;
    else if (csvValueMap && csvValueMap.has(String(v).toLowerCase())) val = `\${${csvValueMap.get(String(v).toLowerCase())}}`;
    // Already a correlation/generator ${...} reference — percent-encoding it here would
    // corrupt the placeholder text itself and get sent to the server literally instead of
    // k6 evaluating the real JS expression inside it at runtime.
    else if (isPlaceholderRef(v)) val = v;
    else val = encodeURIComponent(String(v));
    return `${encodeURIComponent(k)}=${val}`;
  }).join('&');
  const fullPath = queryString ? `${epPath}${epPath.includes('?') ? '&' : '?'}${queryString}` : epPath;

  // Headers — recorded/correlated headers win over the blanket token default (same
  // precedence bug-fix as buildSamplerXml, for the same reason: a specific correlation
  // rule must never be silently clobbered by the generic fallback), override wins last.
  const headerEntries = { 'Content-Type': 'application/json' };
  const keyByLower = { 'content-type': 'Content-Type' };
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase();
    if (!(lower in keyByLower)) { keyByLower[lower] = k; headerEntries[k] = String(v); }
  }
  if (!isLogin && tokenVar && !('authorization' in keyByLower)) {
    headerEntries['Authorization'] = `Bearer \${${tokenVar}}`;
    keyByLower['authorization'] = 'Authorization';
  }
  // Same precedence fix as buildSamplerXml: a confirmed correlation rule targeting this
  // exact header must win over a saved override, or a stale pre-rule override (often
  // referencing a cookie-sourced {{captured:X}} that capturedFields never resolves) bakes
  // invalid, unresolvable placeholder text into the script instead of the rule's correct output.
  if (override?.headers) {
    const correlatedHeaderKeys = new Set((targetRules || []).filter(r => r.targetLocation === 'header').map(r => String(r.targetKey).toLowerCase()));
    for (const [k, v] of Object.entries(override.headers)) {
      if (correlatedHeaderKeys.has(k.toLowerCase())) continue;
      const translated = toJmeterVar(applyOverridePlaceholders(String(v), capturedFields || {}));
      const existingKey = keyByLower[k.toLowerCase()] || k;
      headerEntries[existingKey] = translated;
      keyByLower[k.toLowerCase()] = existingKey;
    }
  }

  const resVar = `res${index}`;
  const k6Method = method === 'DELETE' ? 'del' : method.toLowerCase();
  const urlExpr = '`${BASE_URL}' + toK6TemplateLiteral(fullPath) + '`';
  const headerLines = Object.entries(headerEntries)
    .map(([k, v]) => `        '${k.replace(/'/g, "\\'")}': \`${toK6TemplateLiteral(v)}\`,`)
    .join('\n');

  const lines = [];
  lines.push(`  // ${name}`);
  if (isBody) {
    lines.push(`  let ${resVar} = http.${k6Method}(${urlExpr}, \`${toK6TemplateLiteral(body || '{}')}\`, {`);
  } else {
    lines.push(`  let ${resVar} = http.${k6Method}(${urlExpr}, {`);
  }
  lines.push(`    headers: {`);
  lines.push(headerLines);
  lines.push(`    },`);
  lines.push(`  });`);
  lines.push(`  check(${resVar}, { '${name.replace(/'/g, "\\'")} status is 2xx/3xx': (r) => r.status >= 200 && r.status < 400 });`);
  for (const { varName, jsonPath, sourceLocation } of (sourceFields || [])) {
    if (sourceLocation === 'header') {
      lines.push(`  const ${varName} = ${k6HeaderAccessor(resVar, jsonPath)};`);
    } else if (sourceLocation === 'cookie') {
      lines.push(`  const ${varName} = ${k6CookieAccessor(resVar, jsonPath)};`);
    } else {
      lines.push(`  const ${varName} = ${resVar}.json()${jsonPathToOptionalChain(jsonPath)};`);
    }
  }
  lines.push(`  sleep(1);`);
  return lines.join('\n');
}

// Deterministic k6 script builder — mirrors buildJmxTemplate's structure and reuses the
// exact same helpers (normalizeEp, detectCapturedFields, correlation grouping, CSV
// substitution) so both engines apply identical correlation/CSV/override logic instead of
// k6 depending on an LLM re-deriving it from a raw JSON dump on every generation.
function buildK6Template(suite, collection, testDataFile, cfg, endpoints, rules, preRunData, testType) {
  const variables = cfg.variables || {};
  const vusers = suite.vusers || 50;
  const rampup = suite.rampup || 30;
  const duration = suite.duration || 300;

  // All executor configs reference the top-level constants (THREADS, DURATION, RAMP_UP)
  // which are read from __ENV so they can be overridden at run time:
  //   k6 run --env THREADS=100 --env DURATION=600 --env RAMP_UP=60 script.js
  const executorConfigs = {
    load:      `scenarios: { load:      { executor: 'constant-vus',       vus: THREADS, duration: DURATION + 's' } }`,
    stress:    `scenarios: { stress:    { executor: 'ramping-vus', startVUs: 0, stages: [
      { duration: RAMP_UP + 's', target: Math.round(THREADS / 2) },
      { duration: DURATION + 's', target: THREADS },
      { duration: RAMP_UP + 's', target: THREADS * 2 },
      { duration: DURATION + 's', target: THREADS * 2 },
      { duration: '30s', target: 0 }
    ] } }`,
    spike:     `scenarios: { spike:     { executor: 'ramping-arrival-rate', startRate: 1, timeUnit: '1s', preAllocatedVUs: THREADS * 2, stages: [
      { duration: '10s', target: 1 },
      { duration: '10s', target: THREADS * 5 },
      { duration: '30s', target: THREADS * 5 },
      { duration: '10s', target: 1 }
    ] } }`,
    endurance: `scenarios: { endurance: { executor: 'constant-arrival-rate', rate: THREADS, timeUnit: '1s', duration: DURATION + 's', preAllocatedVUs: THREADS } }`,
  };

  const thresholds = (rules || []).map(r => {
    if (r.metric === 'Response Time') return `    http_req_duration: ['p(95)<${r.value}']`;
    if (r.metric === 'Error Rate') return `    http_req_failed: ['rate<${parseFloat(r.value) / 100}']`;
    if (r.metric === 'Throughput') return `    http_reqs: ['rate>${r.value}']`;
    return null;
  }).filter(Boolean).join(',\n');

  // CSV — k6 has no per-request "variable" concept like JMeter's CSVDataSet, so the
  // current VU/iteration's row is destructured into bare variables matching each column
  // name; a `${col}` placeholder from substituteCSVVars/substituteCorrelatedLiterals then
  // just needs a same-named variable in scope to interpolate correctly.
  let csvCols = [];
  let csvValueMap = new Map();
  let csvImportLines = '';
  let csvSetupLines = '';
  if (testDataFile) {
    let cols = [];
    try { cols = JSON.parse(testDataFile.columns); } catch { cols = String(testDataFile.columns || '').split(',').map(c => c.trim()).filter(Boolean); }
    csvCols = cols.filter(c => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(c)); // must be valid JS identifiers to destructure
    csvValueMap = buildCsvValueMap([testDataFile]);
    const filePath = testDataFile.path.replace(/\\/g, '/').replace(/'/g, "\\'");
    csvImportLines = `import { SharedArray } from 'k6/data';\nimport papaparse from 'https://jslib.k6.io/papaparse/5.1.1/index.js';`;
    csvSetupLines = `const testData = new SharedArray('testData', function () {\n  return papaparse.parse(open('${filePath}'), { header: true, skipEmptyLines: true }).data;\n});`;
  }

  const loginEp = endpoints.find(isLoginEp) || null;
  const capturedFields = loginEp ? detectCapturedFields(preRunData, loginEp) : {};
  const tokenInfo = loginEp ? (pickDefaultField(capturedFields) || { varName: 'accessToken', jsonPath: '$.accessToken' }) : null;
  const tokenVar = tokenInfo?.varName || null;

  const endpointOverrides = cfg.endpointOverrides || {};
  const epIndexOf = new Map(endpoints.map((e, i) => [e, i]));
  function overrideFor(ep) {
    const saved = endpointOverrides[epIndexOf.get(ep)];
    return fingerprintMatches(ep, saved) ? saved : null;
  }

  const correlationRules = filterApplicableRules(cfg.correlationRules);
  const rulesBySource = groupRulesBySource(correlationRules);
  const rulesByTarget = groupRulesByTarget(correlationRules);
  function sourceFieldsFor(ep) { return rulesBySource.get(epIndexOf.get(ep)) || []; }
  function targetRulesFor(ep) { return rulesByTarget.get(epIndexOf.get(ep)) || []; }

  const generatorsByTarget = groupGeneratorsByTarget(cfg.fieldGenerators);
  function generatorRulesFor(ep) { return generatorsByTarget.get(epIndexOf.get(ep)) || []; }

  // Same login-first reorder + inbound-correlation guard as buildJmxTemplate — see its
  // comment for why an endpoint that depends on an earlier response can't be moved ahead
  // of that source.
  const loginHasInboundCorrelation = loginEp && targetRulesFor(loginEp).length > 0;
  const ordered = (loginEp && !loginHasInboundCorrelation)
    ? [loginEp, ...endpoints.filter(e => e !== loginEp)]
    : [...endpoints];

  let tokenExtracted = false;
  const requestBlocks = ordered.map((ep, i) => {
    const isLogin = ep === loginEp;
    const block = buildK6Request(ep, i, {
      isLogin, tokenVar: tokenExtracted ? tokenVar : null, csvCols, csvValueMap,
      override: overrideFor(ep), capturedFields, variables,
      sourceFields: sourceFieldsFor(ep), targetRules: targetRulesFor(ep), generatorRules: generatorRulesFor(ep),
    });
    if (isLogin) tokenExtracted = true;
    return block;
  });

  const rowDestructure = csvCols.length
    ? `  const row = testData[(__VU - 1 + __ITER) % testData.length];\n  const { ${csvCols.join(', ')} } = row;\n`
    : '';

  // k6/crypto is only imported when a confirmed rule actually uses a hash transform
  // (utils/transforms.js) — a script with no such rules shouldn't carry an unused import.
  const needsCryptoImport = correlationRules.some(r => r.transform && K6_CRYPTO_TRANSFORMS.has(r.transform));

  const lines = [];
  lines.push(`import http from 'k6/http';`);
  lines.push(`import { check, sleep } from 'k6';`);
  if (needsCryptoImport) lines.push(`import crypto from 'k6/crypto';`);
  if (csvImportLines) lines.push(csvImportLines);
  lines.push('');
  if (csvSetupLines) { lines.push(csvSetupLines); lines.push(''); }
  lines.push(`// Runtime override: k6 run --env THREADS=100 --env DURATION=600 --env RAMP_UP=60 --env PROTOCOL=https --env URL=api.example.com --env PORT=443 script.js`);
  lines.push(`const THREADS  = parseInt(__ENV.THREADS  || '${vusers}');`);
  lines.push(`const RAMP_UP  = parseInt(__ENV.RAMP_UP  || '${rampup}');`);
  lines.push(`const DURATION = parseInt(__ENV.DURATION || '${duration}');`);
  lines.push(`const PROTOCOL = __ENV.PROTOCOL || '${cfg.protocol || 'https'}';`);
  lines.push(`const URL      = __ENV.URL      || '${cfg.url || ''}';`);
  lines.push(`const PORT     = __ENV.PORT     || '${cfg.port || '443'}';`);
  lines.push('const BASE_URL = `${PROTOCOL}://${URL}:${PORT}`;');
  lines.push('');
  lines.push(`export const options = {`);
  lines.push(`  ${executorConfigs[testType] || executorConfigs.load},`);
  lines.push(`  thresholds: {`);
  lines.push(thresholds || "    http_req_duration: ['p(95)<2000']");
  lines.push(`  }`);
  lines.push(`};`);
  lines.push('');
  lines.push(`export default function () {`);
  if (rowDestructure) lines.push(rowDestructure);
  lines.push(requestBlocks.join('\n\n'));
  lines.push(`}`);
  return lines.join('\n');
}

function generateK6(userId, suite, collection, testDataFile, cfg, endpoints, rules, preRunData, testType) {
  return buildK6Template(suite, collection, testDataFile, cfg, endpoints, rules, preRunData, testType);
}

module.exports = router;
module.exports.generateScriptForSuite = generateScriptForSuite;
module.exports.buildJmxTemplate = buildJmxTemplate;
module.exports.buildK6Template = buildK6Template;
