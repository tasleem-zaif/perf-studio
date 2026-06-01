function parseCurl(curlStr) {
  const str = curlStr.replace(/\\\n/g, ' ').replace(/\s+/g, ' ');

  const methodMatch = str.match(/(?:-X|--request)\s+['"]?(\w+)['"]?/);
  const method = (methodMatch?.[1] || 'GET').toUpperCase();

  const urlMatch = str.match(/curl\s+(?:[^'"]*\s+)?['"]?(https?:\/\/[^\s'"]+)['"]?/);
  const url = urlMatch?.[1] || '';

  const headers = {};
  const headerRe = /-H\s+['"]([^'"]+)['"]/g;
  let m;
  while ((m = headerRe.exec(str)) !== null) {
    const colonIdx = m[1].indexOf(':');
    if (colonIdx > -1) {
      const key = m[1].slice(0, colonIdx).trim();
      const val = m[1].slice(colonIdx + 1).trim();
      headers[key] = val;
    }
  }

  const bodyMatch = str.match(/(?:-d|--data(?:-raw)?|--data-binary)\s+['"](.+?)['"]\s*(?:-|$)/s)
    || str.match(/(?:-d|--data(?:-raw)?|--data-binary)\s+'(.+?)'\s*$/s)
    || str.match(/(?:-d|--data(?:-raw)?|--data-binary)\s+"(.+?)"\s*$/s);
  const body = bodyMatch?.[1] || '';

  return { method, url, headers, body };
}

module.exports = { parseCurl };
