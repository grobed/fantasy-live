// Ported verbatim from index.html (parseCSV / fetchCSV). The published Google
// Sheet CSVs are quoted CSV; this hand-rolled parser handles embedded quotes,
// commas and newlines without a dependency.

export function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { field += c; }
    } else if (c === '"') { inQuotes = true; }
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') { field += c; }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export async function fetchCSV(url: string): Promise<string[][]> {
  // Cache-buster: the published CSV is cached by the CDN, so a poll could
  // otherwise be served a stale copy after a sheet edit. The published URLs
  // already carry a query string, so "&_=" appends cleanly.
  const res = await fetch(url + '&_=' + Date.now());
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return parseCSV(await res.text());
}
