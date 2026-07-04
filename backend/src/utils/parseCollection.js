const yaml = require('js-yaml');

function parsePostman(json) {
  const endpoints = [];

  // folderPath: array of ancestor folder names, e.g. ['Auth', 'Login']
  function walk(items, folderPath) {
    for (const item of items || []) {
      if (item.item) {
        // This item is a folder — recurse with the updated folder path
        walk(item.item, [...(folderPath || []), item.name]);
        continue;
      }
      if (!item.request) continue;
      const req = item.request;
      const urlRaw = typeof req.url === 'string' ? req.url : (req.url?.raw || '');
      const hdrs = (req.header || []).reduce((a, h) => {
        if (!h.disabled) a[h.key] = h.value;
        return a;
      }, {});
      let body = '';
      if (req.body?.mode === 'raw') body = req.body.raw || '';
      else if (req.body?.mode === 'urlencoded') {
        body = (req.body.urlencoded || []).map(p => `${p.key}=${p.value}`).join('&');
      }
      // Preserve Postman v2.1 query params (req.url.query = [{ key, value, disabled }])
      const queryParams = {};
      const urlQuery = typeof req.url === 'object' ? (req.url?.query || []) : [];
      urlQuery.forEach(async q => { if (q.key && !q.disabled) queryParams[q.key] = q.value ?? ''; });

      // Store the top-level folder name (first ancestor) and full folder path
      const folder     = folderPath && folderPath.length ? folderPath[0] : null;
      const folderPath_ = folderPath && folderPath.length ? folderPath.join(' / ') : null;

      endpoints.push({
        name: item.name,
        folder,           // top-level folder name for Simple Controller grouping
        folderPath: folderPath_,  // full nested path for display
        method: req.method || 'GET',
        url: urlRaw,
        headers: hdrs,
        body,
        queryParams,
      });
    }
  }
  walk(json.item, []);
  return endpoints;
}

function parseSwagger(obj) {
  const base = obj.servers?.[0]?.url
    || (obj.host ? `${(obj.schemes?.[0] || 'https')}://${obj.host}${obj.basePath || ''}` : '');
  const endpoints = [];
  for (const [p, methods] of Object.entries(obj.paths || {})) {
    for (const [method, op] of Object.entries(methods)) {
      if (!['get','post','put','patch','delete','head','options'].includes(method)) continue;
      let body = '';
      const bodyParam = (op.parameters || []).find(param => param.in === 'body');
      if (bodyParam?.schema?.example) body = JSON.stringify(bodyParam.schema.example);
      const reqBody = op.requestBody?.content?.['application/json']?.example;
      if (reqBody) body = JSON.stringify(reqBody);
      const queryParams = {};
      (op.parameters || []).forEach(async param => {
        if (param.in === 'query' && param.name) {
          queryParams[param.name] = param.example ?? param.default ?? param.schema?.example ?? param.schema?.default ?? '';
        }
      });
      endpoints.push({
        name: op.operationId || op.summary || `${method.toUpperCase()} ${p}`,
        method: method.toUpperCase(),
        url: `${base}${p}`,
        headers: { 'Content-Type': 'application/json' },
        body,
        queryParams,
      });
    }
  }
  return endpoints;
}

function parseCollection(content, sourceType) {
  if (sourceType === 'swagger') {
    const obj = content.trim().startsWith('{') ? JSON.parse(content) : yaml.load(content);
    return parseSwagger(obj);
  }
  if (sourceType === 'postman') {
    return parsePostman(JSON.parse(content));
  }
  return [];
}

// Postman environment export: { values: [{ key, value, enabled }] } → { key: value } (enabled only)
function parsePostmanEnvironment(content) {
  const obj = JSON.parse(content);
  const values = Array.isArray(obj.values) ? obj.values : [];
  const vars = {};
  for (const v of values) {
    if (v.key && v.enabled !== false) vars[v.key] = v.value ?? '';
  }
  return vars;
}

// Postman collections can embed default values in a top-level `variable` array
// (e.g. {{prod_url}}). Harvest these as a fallback when no environment file is uploaded.
function extractCollectionVariables(content, sourceType) {
  if (sourceType !== 'postman') return {};
  try {
    const obj = JSON.parse(content);
    const list = Array.isArray(obj.variable) ? obj.variable : [];
    const vars = {};
    for (const v of list) {
      if (v.key) vars[v.key] = v.value ?? '';
    }
    return vars;
  } catch {
    return {};
  }
}

module.exports = { parseCollection, parsePostmanEnvironment, extractCollectionVariables };
