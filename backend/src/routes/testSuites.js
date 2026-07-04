const router = require('express').Router({ mergeParams: true });
const path = require('path');
const fs = require('fs');
const { writeFileSync } = require('fs');
const db = require('../db');
const auth = require('../middleware/auth');
const ownsProject = require('../utils/ownsProject');
const { callAi } = require('../utils/aiClient');
const { readCsv } = require('../utils/csvUtils');
const resetSequence = require('../utils/resetSequence');
const { updateCollectionConfigs, updateProjectCollectionConfigs } = require('../utils/configWriter');

const DEFAULT_CONFIG = { protocol: 'https', url: '', port: '443', threads: 50, rampup: 30, loop: 1, duration: 300 };

const THREAD_GROUPS = {
  load:      'org.apache.jmeter.threads.ThreadGroup',
  stress:    'kg.apc.jmeter.threads.UltimateThreadGroup',
  spike:     'kg.apc.jmeter.threads.arrivals.ArrivalsThreadGroup',
  endurance: 'kg.apc.jmeter.threads.ConcurrencyThreadGroup',
};

const TEST_TYPE_LABELS = { load: 'Load Test', stress: 'Stress Test', spike: 'Spike Test', endurance: 'Endurance Test' };

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
        await updateCollectionConfigs(collection_id, await getUserProjectPath(_uid, c?.role, p?.name || ''));
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
        await updateCollectionConfigs(_cid, await getUserProjectPath(_uid, c?.role, p?.name || ''));
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
        await updateCollectionConfigs(_cid, await getUserProjectPath(_uid, c?.role, p?.name || ''));
      } catch (_) {}
    });
  }
  res.json({ ok: true });
});

router.post('/:id/generate', async (req, res) => {
  const proj = await ownsProject(req.userId, req.params.projectId);
  if (!proj) return res.status(404).json({ error: 'Project not found' });

  const suite = await db.prepare('SELECT * FROM test_suites WHERE id = ? AND project_id = ?').get(req.params.id, req.params.projectId);
  if (!suite) return res.status(404).json({ error: 'Suite not found' });

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
  const rules = await db.prepare('SELECT * FROM rules WHERE project_id = ?').all(req.params.projectId);

  const globalRow = await db.prepare('SELECT config_json FROM global_config WHERE user_id = ?').get(req.userId);
  const projRow   = await db.prepare('SELECT config_json FROM project_config WHERE project_id = ?').get(req.params.projectId);
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
    return res.status(400).json({
      error: `No target URL configured for this collection's "${suiteEnv || 'default'}" environment. Set one under Config > Environment Config before generating a script.`,
    });
  }
  // Use pre-run data from request body (legacy) or from collection row (new flow)
  const preRunData = req.body.preRunData || (() => {
    if (!collection?.pre_run_data) return null;
    try { return JSON.parse(collection.pre_run_data); } catch { return null; }
  })();

  const engine = suite.engine || 'jmeter';
  const testType = suite.test_type || 'load';
  const safeName = suite.name.replace(/[^a-zA-Z0-9_-]/g, '_');

  try {
    let scriptContent;
    if (engine === 'jmeter') {
      scriptContent = cleanScript(await generateJmx(req.userId, suite, collection, testDataFiles, cfg, endpoints, rules, preRunData, testType), 'jmeter');
    } else {
      scriptContent = cleanScript(await generateK6(req.userId, suite, collection, testDataFiles[0] || null, cfg, endpoints, rules, preRunData, testType), 'k6');
    }

    // Write script to collection/env/script/ — use suite.env or derive from collection
    const ext = engine === 'jmeter' ? 'jmx' : 'js';
    const filename = `${safeName}.${ext}`;
    let filePath = '';

    let scriptBaseDir = null;
    const { getUserProjectPath, getCollectionPath, isAdminWorkspace } = require('../utils/projectFolders');
    const callerUser = await db.prepare('SELECT role FROM users WHERE id = ?').get(req.userId);
    const callerRole = callerUser?.role;
    const userProjPath = await getUserProjectPath(req.userId, callerRole, proj.name);

    // Admin workspace holds only empty folders — skip script generation for admin
    if (isAdminWorkspace(userProjPath)) {
      return res.status(400).json({ error: 'Scripts cannot be generated in the admin workspace. Please use a regular user account to generate scripts.' });
    }
    if (collection && userProjPath) {
      let targetEnv = suite.env;
      if (!targetEnv && collection) {
        try { const envs = JSON.parse(collection.environments || '[]'); targetEnv = envs[0] || collection.environment || 'Default'; } catch { targetEnv = collection.environment || 'Default'; }
      }
      const envPath = getCollectionPath(userProjPath, collection.name, targetEnv);
      scriptBaseDir = require('path').join(envPath, 'script');
    } else if (userProjPath) {
      scriptBaseDir = require('path').join(userProjPath, 'script');
    }

    if (scriptBaseDir) {
      require('fs').mkdirSync(scriptBaseDir, { recursive: true });
      filePath = require('path').join(scriptBaseDir, filename);
      writeFileSync(filePath, scriptContent, 'utf8');
    }

    // Update DB
    const updateField = engine === 'jmeter' ? 'jmx_path' : 'js_path';
    await db.prepare(`UPDATE test_suites SET ${updateField}=?, status='generated' WHERE id=?`).run(filePath || filename, req.params.id);

    if (suite.collection_id) setImmediate(async () => { await updateCollectionConfigs(suite.collection_id); });
    res.json({ ok: true, filename, path: filePath });
  } catch (e) {
    res.status(500).json({ error: `Script generation failed: ${e.message}. Check your AI API key in Settings and that the collection has valid endpoints.` });
  }
});

router.get('/:id/download/:type', async (req, res) => {
  const proj = await ownsProject(req.userId, req.params.projectId);
  if (!proj) return res.status(404).json({ error: 'Project not found' });
  const suite = await db.prepare('SELECT * FROM test_suites WHERE id = ? AND project_id = ?').get(req.params.id, req.params.projectId);
  if (!suite) return res.status(404).json({ error: 'Test plan not found — it may have been deleted. Try regenerating the script.' });

  const filePath = req.params.type === 'jmx' ? suite.jmx_path : suite.js_path;
  if (!filePath) return res.status(404).json({ error: 'Script not generated yet' });

  const filename = path.basename(filePath);
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

function isLoginEp(ep) {
  const n = (ep.name || ep.testname || '').toLowerCase();
  const p = (ep.path || ep.url || '').toLowerCase();
  return /login|signin|sign-in|authenticate/.test(n) || /\/login|\/auth\/login|\/signin/.test(p);
}

function detectTokenKey(preRunData, loginEp) {
  if (!preRunData || !Array.isArray(preRunData)) return null;
  const loginPath = (loginEp?.path || loginEp?.url || '').toLowerCase();
  const match = preRunData.find(r => {
    const ep = (r.endpoint || '').toLowerCase();
    return ep.includes('/login') || ep.includes('/auth') || ep.includes(loginPath);
  });
  if (!match?.body) return null;
  let body;
  try { body = typeof match.body === 'string' ? JSON.parse(match.body) : match.body; } catch { return null; }
  const priorities = ['accessToken','access_token','token','jwt','bearerToken','bearer_token','authToken','id_token'];
  for (const k of priorities) {
    if (body[k] !== undefined) return { varName: k.replace(/[^a-zA-Z0-9]/g, '_'), jsonPath: `$.${k}` };
  }
  for (const [k] of Object.entries(body)) {
    if (/token|jwt|bearer/i.test(k)) return { varName: k.replace(/[^a-zA-Z0-9]/g, '_'), jsonPath: `$.${k}` };
  }
  return null;
}

function toJmeterVar(v) {
  // Convert Postman {{var}} → JMeter ${var}
  return String(v ?? '').replace(/\{\{(\w+)\}\}/g, '$${$1}');
}

// Resolves the literal {protocol,url,port} an endpoint's raw URL targets, substituting
// a single leading {{var}} token against the collection's resolved variables map.
// Multi-host collections (e.g. Binance's Spot/Futures/Options/Wallet APIs) define one
// base-URL variable per API family instead of sharing a single host — this lets each
// endpoint be mapped back to the specific host its own {{var}} pointed to.
function resolveEndpointHost(rawUrl, variables) {
  if (!rawUrl) return null;
  let urlForParse = rawUrl;
  const m = rawUrl.match(/^\{\{(\w+)\}\}/);
  if (m) {
    const val = variables?.[m[1]];
    if (!val) return null; // variable has no known value — can't resolve
    urlForParse = val + rawUrl.slice(m[0].length);
  } else if (rawUrl.startsWith('/') && !rawUrl.includes('://')) {
    return null; // relative path with no host token — falls back to the collection default
  }
  try {
    const raw = urlForParse.startsWith('http') ? urlForParse : `https://${urlForParse}`;
    const u = new URL(raw);
    if (!u.hostname || u.hostname.includes('{{')) return null;
    return { protocol: u.protocol.replace(':', ''), url: u.hostname, port: u.port || '' };
  } catch { return null; }
}

function normalizeEp(ep) {
  let epPath = ep.path || '';
  let urlQueryParams = {};

  // Always extract query params from the URL, regardless of whether ep.path is set.
  // This covers: cURL imports (only url set), Postman (url + queryParams), manual JSON
  // (path set but url may have query string), and OpenAPI (parameters array).
  const rawUrl = ep.url || ep.request?.url?.raw || '';
  if (rawUrl) {
    try {
      const parsed = new URL(rawUrl.startsWith('http') ? rawUrl : 'https://x' + rawUrl);
      if (!epPath) epPath = parsed.pathname;           // only set path from URL if not already set
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
  // Normalise all query param values: Postman {{var}} → JMeter ${var}
  for (const k of Object.keys(queryParams)) queryParams[k] = toJmeterVar(queryParams[k]);
  const rawHeaders = ep.headers || ep.request?.header || [];
  const headers = {};
  if (Array.isArray(rawHeaders)) rawHeaders.forEach(async h => { const k = h.key || h.name; if (k) headers[k] = h.value; });
  else if (typeof rawHeaders === 'object') Object.assign(headers, rawHeaders);

  let body = ep.body ?? ep.requestBody ?? ep.request?.body?.raw ?? null;
  if (body && typeof body === 'object') body = JSON.stringify(body, null, 2);

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
    if (!f.path || !fs.existsSync(f.path)) continue;
    try {
      const { headers, rows } = readCsv(f.path, 50); // sample first 50 rows
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

function buildSamplerXml(ep, isLogin, tokenVar, csvCols, csvValueMap, hostVars) {
  const { name, method, path: epPath, headers, body, queryParams } = normalizeEp(ep);
  const { protocol: protoVar = 'PROTOCOL', server: serverVar = 'SERVER', port: portVar = 'PORT' } = hostVars || {};
  const lines = [];
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
  if (!isLogin && tokenVar) headerEntries.push({ name: 'Authorization', value: `Bearer \${${tokenVar}}` });
  // Merge any custom headers from endpoint (skip Content-Type already added)
  for (const [k, v] of Object.entries(headers)) {
    if (!headerEntries.find(h => h.name.toLowerCase() === k.toLowerCase()))
      headerEntries.push({ name: k, value: String(v) });
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

  if (isLogin) {
    const tVar = tokenVar || 'accessToken';
    const tPath = tokenVar ? `$.${tokenVar.replace(/_/g, '')}` : '$.accessToken';
    lines.push(`          <JSONPostProcessor guiclass="JSONPostProcessorGui" testclass="JSONPostProcessor" testname="JSON Extractor - Token" enabled="true">`);
    lines.push(`            <stringProp name="JSONPostProcessor.referenceNames">${xmlEsc(tVar)}</stringProp>`);
    lines.push(`            <stringProp name="JSONPostProcessor.jsonPathExprs">${xmlEsc(tPath)}</stringProp>`);
    lines.push(`            <stringProp name="JSONPostProcessor.match_numbers">1</stringProp>`);
    lines.push(`            <stringProp name="JSONPostProcessor.defaultValues">NOT_FOUND</stringProp>`);
    lines.push(`          </JSONPostProcessor>`);
    lines.push(`          <hashTree/>`);
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
  const urls = cfg.urls || [{ protocol: cfg.protocol || 'https', url: cfg.url || '', port: cfg.port || '443' }];
  const { protocol = 'https', url: server = '', port = '443' } = urls[0] || {};

  // Multi-host support: a single collection can span several API families with different
  // base hosts (e.g. Binance's Spot/Futures/Options/Wallet APIs, each via its own {{var}}).
  // Resolve every endpoint's own host and, when more than one distinct host is actually
  // used, emit indexed PROTOCOL_N/SERVER_N/PORT_N instead of forcing every sampler onto
  // the single default host from `urls[0]`.
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

  // Login & token detection
  const loginEp   = endpoints.find(isLoginEp) || null;
  const tokenInfo = loginEp ? (detectTokenKey(preRunData, loginEp) || { varName: 'accessToken', jsonPath: '$.accessToken' }) : null;
  const tokenVar  = tokenInfo?.varName || null;

  // User Defined Variables — rt:true vars use ${__P(NAME,default)} so they can be
  // overridden at run time: jmeter -n -t script.jmx -JTHREADS=100 -JDURATION=600 -JRAMP_UP=60
  //
  // Single-host collections keep the plain PROTOCOL/SERVER/PORT names (unchanged from
  // before). Multi-host collections get PROTOCOL_N/SERVER_N/PORT_N per distinct host
  // instead — no plain/unindexed set, since it would just be a confusing duplicate of
  // whichever host happened to be first.
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

  // HTTP Samplers — grouped by folder using Simple Controllers when folders exist.
  // Login endpoint always comes first regardless of folder.
  let tokenExtracted = false;
  const ordered = loginEp
    ? [loginEp, ...endpoints.filter(e => e !== loginEp)]
    : [...endpoints];

  // Check if any endpoint has folder info
  const hasFolders = ordered.some(e => e.folder);

  if (!hasFolders) {
    // Flat list — emit samplers directly under ThreadGroup
    for (const ep of ordered) {
      const isLogin = ep === loginEp;
      const activeToken = tokenExtracted ? tokenVar : null;
      L.push(buildSamplerXml(ep, isLogin, activeToken, allCsvCols, csvValueMap, hostVarsFor(ep)));
      if (isLogin) tokenExtracted = true;
    }
  } else {
    // Group by folder — login endpoint (if any) gets its own group or goes into its natural folder
    // Build ordered list of [folderName, ep[]] preserving first-seen folder order
    const folderMap = new Map(); // folderName → ep[]
    const NO_FOLDER = '__no_folder__';
    for (const ep of ordered) {
      const key = ep.folder || NO_FOLDER;
      if (!folderMap.has(key)) folderMap.set(key, []);
      folderMap.get(key).push(ep);
    }

    for (const [folderName, eps] of folderMap) {
      if (folderName === NO_FOLDER) {
        // Ungrouped endpoints — emit directly (no Simple Controller wrapper)
        for (const ep of eps) {
          const isLogin = ep === loginEp;
          L.push(buildSamplerXml(ep, isLogin, tokenExtracted ? tokenVar : null, allCsvCols, csvValueMap, hostVarsFor(ep)));
          if (isLogin) tokenExtracted = true;
        }
      } else {
        // Wrap folder's endpoints in a Simple Controller (GenericController = JMeter Simple Controller)
        L.push(`        <GenericController guiclass="LogicControllerGui" testclass="GenericController" testname="${xmlEsc(folderName)}" enabled="true">`);
        L.push(`          <stringProp name="TestPlan.comments"></stringProp>`);
        L.push(`        </GenericController>`);
        L.push(`        <hashTree>`);
        for (const ep of eps) {
          const isLogin = ep === loginEp;
          // Indent samplers one level deeper inside the Simple Controller
          const samplerXml = buildSamplerXml(ep, isLogin, tokenExtracted ? tokenVar : null, allCsvCols, csvValueMap, hostVarsFor(ep))
            .split('\n').map(line => '  ' + line).join('\n');
          L.push(samplerXml);
          if (isLogin) tokenExtracted = true;
        }
        L.push(`        </hashTree>`);
      }
    }
  }

  L.push(`      </hashTree>`); // ThreadGroup hashTree
  L.push(`    </hashTree>`);   // TestPlan hashTree
  L.push(`  </hashTree>`);
  L.push(`</jmeterTestPlan>`);
  return L.join('\n');
}

function generateJmx(userId, suite, collection, testDataFiles, cfg, endpoints, rules, preRunData, testType) {
  return buildJmxTemplate(suite, collection, testDataFiles, cfg, endpoints, preRunData);
}

async function generateK6(userId, suite, collection, testDataFile, cfg, endpoints, rules, preRunData, testType) {
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

  const thresholds = rules.map(r => {
    if (r.metric === 'Response Time') return `  http_req_duration: ['p(95)<${r.value}']`;
    if (r.metric === 'Error Rate') return `  http_req_failed: ['rate<${parseFloat(r.value) / 100}']`;
    if (r.metric === 'Throughput') return `  http_reqs: ['rate>${r.value}']`;
    return null;
  }).filter(Boolean).join(',\n');

  const testDataFiles = testDataFile ? [testDataFile] : [];
  const csvSection = testDataFiles.length ? testDataFiles.map((f, i) => {
    let cols = [];
    try { cols = JSON.parse(f.columns); } catch { cols = String(f.columns || '').split(',').map(c => c.trim()).filter(Boolean); }
    const varName = testDataFiles.length === 1 ? 'testData' : `testData${i + 1}`;
    return `
TEST DATA FILE ${i + 1}: ${f.original_name || f.path}
Load using SharedArray (name: "${varName}"):
  const ${varName} = new SharedArray('${varName}', function() {
    return papaparse.parse(open('${f.path}'), { header: true, skipEmptyLines: true }).data;
  });
CSV columns (exact names, case-insensitive matching): ${cols.join(', ')}
- Access per-VU row: const row = ${varName}[(__VU - 1 + __ITER) % ${varName}.length];
- Use row.<columnName> to get each value (column names are case-sensitive in the row object — use exact casing from the header).
- CRITICAL: Scan every request body in the collection. For each JSON key that matches a CSV column name (case-insensitive), replace its value with the CSV variable regardless of whether the original value is a string, number, or boolean.
  Example: if CSV has column "expiresInMins" and a request body has "expiresInMins": 30, replace with "expiresInMins": row.expiresInMins
  Example: if CSV has column "username" and a request body has "username": "admin", replace with "username": row.username
- Apply this substitution to ALL matched fields across ALL endpoints.`;
  }).join('\n') : '';

  const correlationSection = preRunData ? `
CORRELATION:
Pre-run responses below. Extract dynamic values (tokens, IDs) from responses using regex or jsonpath.
Pass extracted values to subsequent requests.
${JSON.stringify(preRunData, null, 2).slice(0, 2000)}
` : '';

  const systemPrompt = `You are an expert k6 v0.50 JavaScript performance test script generator.
Output ONLY raw valid JavaScript. No markdown fences, no explanation.`;

  const userPrompt = `Generate a complete k6 test script with these specifications:

TEST TYPE: ${TEST_TYPE_LABELS[testType] || testType}
SUITE NAME: ${suite.name}

RUNTIME PARAMETERS — declare these constants at the very top of the file (before the options export).
They read from __ENV so values can be overridden at run time without editing the script:
// Runtime override: k6 run --env THREADS=100 --env DURATION=600 --env RAMP_UP=60 --env PROTOCOL=https --env URL=api.example.com --env PORT=443 script.js
const THREADS  = parseInt(__ENV.THREADS  || '${cfg.threads}');
const RAMP_UP  = parseInt(__ENV.RAMP_UP  || '${cfg.rampup}');
const DURATION = parseInt(__ENV.DURATION || '${cfg.duration}');
const PROTOCOL = __ENV.PROTOCOL || '${cfg.protocol}';
const URL      = __ENV.URL      || '${cfg.url}';
const PORT     = __ENV.PORT     || '${cfg.port}';
const BASE_URL = \`\${PROTOCOL}://\${URL}:\${PORT}\`;

IMPORTANT: Use THREADS, RAMP_UP, DURATION, PROTOCOL, URL, PORT, BASE_URL throughout the script.
Never hardcode any of these values anywhere.

SCENARIO CONFIG (reference the constants above — do NOT use literal numbers):
export const options = {
  ${executorConfigs[testType] || executorConfigs.load},
  thresholds: {
${thresholds || "  http_req_duration: ['p(95)<2000']"}
  }
};

HTTP REQUESTS — generate one function call per endpoint using k6's http module:
Collection: ${collection?.name || 'No collection'}
Endpoints:
${JSON.stringify(endpoints, null, 2).slice(0, 4000)}

Use BASE_URL as the URL prefix for all requests.
Add k6 check() calls to verify HTTP 200/201 status codes.
Add sleep(1) between requests.
${csvSection}
${correlationSection}

Output the complete k6 JavaScript file only.`;

  return callAi(userId, systemPrompt, userPrompt, 'script');
}

module.exports = router;
