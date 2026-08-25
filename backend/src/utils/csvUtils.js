const fs = require('fs');

function readCsv(filePath, maxRows = 500) {
  return readCsvContent(fs.readFileSync(filePath, 'utf8'), maxRows);
}

/** Same as readCsv, but from already-fetched text/Buffer (e.g. a multer memoryStorage buffer,
 * or content read from an in-memory gitEngine session). */
function readCsvContent(content, maxRows = 500) {
  if (Buffer.isBuffer(content)) content = content.toString('utf8');
  const lines = content.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return { headers: [], rows: [], totalRows: 0 };
  const headers = parseCsvLine(lines[0]);
  const allRows = lines.slice(1).map(parseCsvLine);
  return { headers, rows: allRows.slice(0, maxRows), totalRows: allRows.length };
}

function writeCsv(filePath, headers, rows) {
  fs.writeFileSync(filePath, buildCsvContent(headers, rows), 'utf8');
}

/** Same as writeCsv, but returns the CSV text instead of writing to a local file. */
function buildCsvContent(headers, rows) {
  const lines = [
    headers.map(escapeCsvCell).join(','),
    ...rows.map(row => row.map(escapeCsvCell).join(',')),
  ];
  return lines.join('\n');
}

function parseCsvLine(line) {
  const cells = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      cells.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur.trim());
  return cells;
}

function escapeCsvCell(val) {
  const s = String(val ?? '');
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

module.exports = { readCsv, writeCsv, readCsvContent, buildCsvContent };
