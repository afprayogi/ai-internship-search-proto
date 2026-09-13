// Tiny localhost-only Bun server behind tools/open_dashboard.bat. It exists
// purely to let tools/dashboard.html do three things a static file:// page
// can never do on its own:
//   1. Read job_scraper/offline_jobs_log.csv so the dashboard can show
//      scraped postings, not just manually-tracked applications.
//   2. Read/write job_scraper/scraper_config.json so search keywords can be
//      edited from the browser instead of hand-editing offline_scraper.mjs.
//   3. Spawn tools/offline_scraper.mjs as a child process and stream its
//      console output back to the browser (Server-Sent Events), so "Run
//      scraper now" behaves like double-clicking run_offline_scraper.bat but
//      without leaving the dashboard.
//
// Binds to 127.0.0.1 only - never reachable from the network. If this server
// isn't running (dashboard.html opened directly as a file:// page instead),
// the page falls back to its original offline-only, localStorage-backed mode.
//
// Run manually: bun run tools/dashboard_server.mjs (or double-click open_dashboard.bat)
//
// Also runnable as a standalone .exe (no Bun install needed to launch it,
// only to build it): tools\build_dashboard_exe.bat compiles this file with
// `bun build --compile` into tools/JobSearchDashboard.exe. "Run scraper now"
// still needs `bun` on PATH though, since it spawns offline_scraper.mjs (and
// that in turn spawns the LinkedIn CLI) as separate bun subprocesses that
// aren't bundled into the compiled binary.
//
// `bun build --compile` embeds this script inside the executable, so
// import.meta.url no longer points at a real path on disk (it resolves to a
// virtual in-memory path instead) - __dirname has to come from the exe's own
// location (process.execPath) in that case, or every readFileSync below
// would fail to find dashboard.html/offline_scraper.mjs next to it. Detected
// by checking whether dashboard.html actually exists next to the resolved
// import.meta.url path, rather than pattern-matching Bun's internal virtual
// path prefix (seen in testing as "B:/~BUN/root/...", but that's an
// implementation detail that could change between Bun versions).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { DEFAULT_CONFIG } from './scraper_config_defaults.mjs';

const sourceDir = path.dirname(fileURLToPath(import.meta.url));
const __dirname = existsSync(path.join(sourceDir, 'dashboard.html')) ? sourceDir : path.dirname(process.execPath);
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.DASHBOARD_PORT) || 4870;

const DASHBOARD_HTML_PATH = path.join(__dirname, 'dashboard.html');
const SCRAPER_PATH = path.join(__dirname, 'offline_scraper.mjs');
const SCRAPED_LOG_PATH = path.join(ROOT, 'job_scraper', 'offline_jobs_log.csv');
const CONFIG_PATH = path.join(ROOT, 'job_scraper', 'scraper_config.json');
const TRACKER_PATH = path.join(ROOT, 'job_search_tracker.csv');
const ENV_PATH = path.join(ROOT, '.env');

const TRACKER_FIELDS = ['date', 'company', 'sector', 'role', 'role_type', 'channel', 'status',
  'contact_person', 'fit_rating', 'notes', 'cv_file', 'cover_letter_file', 'source'];
const SCRAPED_FIELDS = ['found_date', 'portal', 'source_type', 'title', 'company', 'location', 'location_tier',
  'employment_type_hint', 'salary', 'posted_date', 'description', 'requirements', 'eligibility', 'url'];

// ---------------------------------------------------------------------------
// CSV helpers (mirrors the parser/escaper in dashboard.html - kept in sync by
// hand since these run in different JS environments and are small enough
// that a shared module isn't worth the indirection).
// ---------------------------------------------------------------------------
function parseCsv(text) {
  const rows = [];
  let i = 0, field = '', row = [], inQuotes = false;
  const len = text.length;
  while (i < len) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    } else {
      if (c === '"') { inQuotes = true; i++; continue; }
      if (c === ',') { row.push(field); field = ''; i++; continue; }
      if (c === '\r') { i++; continue; }
      if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
      field += c; i++; continue;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ''));
}

function csvEscape(v) {
  const s = String(v == null ? '' : v);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function csvToRecords(text, fields) {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((cells) => {
    const record = {};
    header.forEach((h, idx) => { record[h] = (cells[idx] || '').trim(); });
    if (fields) {
      const filtered = {};
      fields.forEach((f) => { filtered[f] = record[f] ?? ''; });
      return filtered;
    }
    return record;
  });
}

function recordsToCsv(records, fields) {
  const lines = [fields.join(',')];
  for (const r of records) {
    lines.push(fields.map((f) => csvEscape(r[f])).join(','));
  }
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Scraper run state - single run at a time, broadcast to any connected
// Server-Sent Events clients (usually just the one dashboard tab).
// ---------------------------------------------------------------------------
const runState = {
  running: false,
  log: [],
  exitCode: null,
  startedAt: null,
};
const subscribers = new Set();

function broadcast(event, data) {
  const chunk = (event ? `event: ${event}\n` : '') + `data: ${data}\n\n`;
  for (const controller of subscribers) {
    try { controller.enqueue(new TextEncoder().encode(chunk)); } catch { /* client gone */ }
  }
}

function pushLog(line) {
  runState.log.push(line);
  if (runState.log.length > 2000) runState.log.shift(); // cap memory for a very chatty run
  broadcast(null, JSON.stringify(line));
}

async function pumpStream(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let leftover = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = leftover + decoder.decode(value, { stream: true });
    const lines = text.split('\n');
    leftover = lines.pop();
    for (const line of lines) pushLog(line);
  }
  if (leftover) pushLog(leftover);
}

function startScraperRun() {
  if (runState.running) return { started: false, reason: 'already_running' };
  runState.running = true;
  runState.log = [];
  runState.exitCode = null;
  runState.startedAt = new Date().toISOString();
  pushLog(`[dashboard] Menjalankan tools/offline_scraper.mjs...`);

  const proc = Bun.spawn(['bun', 'run', SCRAPER_PATH], {
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  pumpStream(proc.stdout);
  pumpStream(proc.stderr);
  proc.exited.then((code) => {
    runState.running = false;
    runState.exitCode = code;
    pushLog(`[dashboard] Selesai (exit code ${code}).`);
    broadcast('done', JSON.stringify({ code }));
  });

  return { started: true };
}

// ---------------------------------------------------------------------------
// Config (search keywords/settings) - job_scraper/scraper_config.json,
// created from DEFAULT_CONFIG the first time it's requested.
// ---------------------------------------------------------------------------
function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n', 'utf-8');
    return DEFAULT_CONFIG;
  }
  try {
    const onDisk = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    return { ...DEFAULT_CONFIG, ...onDisk };
  } catch {
    return DEFAULT_CONFIG;
  }
}

function saveConfig(partial) {
  const merged = { ...DEFAULT_CONFIG, ...partial };
  writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
  return merged;
}

// ---------------------------------------------------------------------------
// .env read/write - used only for LINKEDIN_LI_AT_COOKIE right now. Never
// returns the stored value to the browser, only whether it's set - the value
// travels browser -> this local server -> disk and nowhere else.
// ---------------------------------------------------------------------------
function readEnvText() {
  return existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf-8') : '';
}

function getEnvValue(text, key) {
  const re = new RegExp('^' + key + '=(.*)$', 'm');
  const m = text.match(re);
  return m ? m[1].trim() : '';
}

function setEnvValue(text, key, value) {
  const re = new RegExp('^' + key + '=.*$', 'm');
  const line = key + '=' + value;
  if (re.test(text)) return text.replace(re, line);
  const sep = text.length && !text.endsWith('\n') ? '\n' : '';
  return text + sep + line + '\n';
}

function linkedinCookieStatus() {
  return { set: getEnvValue(readEnvText(), 'LINKEDIN_LI_AT_COOKIE').length > 0 };
}

function saveLinkedinCookie(cookie) {
  writeFileSync(ENV_PATH, setEnvValue(readEnvText(), 'LINKEDIN_LI_AT_COOKIE', cookie), 'utf-8');
  return { ok: true };
}

function clearLinkedinCookie() {
  writeFileSync(ENV_PATH, setEnvValue(readEnvText(), 'LINKEDIN_LI_AT_COOKIE', ''), 'utf-8');
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Expired-postings cleanup - offline_jobs_log.csv is append-only by design
// (it's the scraper's permanent "everything ever found" record), so it only
// ever grows. This is the one place that actually deletes rows from it:
// anything older than maxAgeDays (by found_date) gets dropped for good.
// Rows with an unparseable found_date are kept rather than guessed at.
// ---------------------------------------------------------------------------
function clearAllScrapedPostings() {
  const removed = existsSync(SCRAPED_LOG_PATH)
    ? csvToRecords(readFileSync(SCRAPED_LOG_PATH, 'utf-8'), SCRAPED_FIELDS).length
    : 0;
  writeFileSync(SCRAPED_LOG_PATH, SCRAPED_FIELDS.join(',') + '\n', 'utf-8');
  return { removed, remaining: 0 };
}

function cleanupExpiredPostings(maxAgeDays) {
  if (!existsSync(SCRAPED_LOG_PATH)) return { removed: 0, remaining: 0 };
  const records = csvToRecords(readFileSync(SCRAPED_LOG_PATH, 'utf-8'), SCRAPED_FIELDS);
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const kept = records.filter((r) => {
    const t = Date.parse(r.found_date);
    return isNaN(t) || t >= cutoff;
  });
  writeFileSync(SCRAPED_LOG_PATH, recordsToCsv(kept, SCRAPED_FIELDS), 'utf-8');
  return { removed: records.length - kept.length, remaining: kept.length };
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
function json(data, init) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...(init && init.headers) },
  });
}

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(readFileSync(DASHBOARD_HTML_PATH, 'utf-8'), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    if (url.pathname === '/api/scraped' && req.method === 'GET') {
      if (!existsSync(SCRAPED_LOG_PATH)) return json([]);
      const text = readFileSync(SCRAPED_LOG_PATH, 'utf-8');
      return json(csvToRecords(text));
    }

    if (url.pathname === '/api/linkedin/cookie/status' && req.method === 'GET') {
      return json(linkedinCookieStatus());
    }
    if (url.pathname === '/api/linkedin/cookie' && req.method === 'POST') {
      const body = await req.json().catch(() => null);
      const cookie = body && typeof body.cookie === 'string' ? body.cookie.trim() : '';
      if (!cookie) return json({ error: 'cookie value required' }, { status: 400 });
      return json(saveLinkedinCookie(cookie));
    }
    if (url.pathname === '/api/linkedin/cookie' && req.method === 'DELETE') {
      return json(clearLinkedinCookie());
    }

    if (url.pathname === '/api/scraped/clear' && req.method === 'POST') {
      return json(clearAllScrapedPostings());
    }
    if (url.pathname === '/api/scraped/cleanup' && req.method === 'POST') {
      const body = await req.json().catch(() => ({}));
      const maxAgeDays = Number(body.maxAgeDays);
      if (!Number.isFinite(maxAgeDays) || maxAgeDays < 0) {
        return json({ error: 'maxAgeDays must be a non-negative number' }, { status: 400 });
      }
      return json(cleanupExpiredPostings(maxAgeDays));
    }

    if (url.pathname === '/api/config' && req.method === 'GET') {
      return json(loadConfig());
    }
    if (url.pathname === '/api/config' && req.method === 'POST') {
      const body = await req.json().catch(() => null);
      if (!body || !Array.isArray(body.keywords)) {
        return json({ error: 'keywords array required' }, { status: 400 });
      }
      return json(saveConfig(body));
    }

    if (url.pathname === '/api/scraper/run' && req.method === 'POST') {
      return json(startScraperRun());
    }
    if (url.pathname === '/api/scraper/state' && req.method === 'GET') {
      return json({ running: runState.running, exitCode: runState.exitCode, startedAt: runState.startedAt });
    }
    if (url.pathname === '/api/scraper/stream' && req.method === 'GET') {
      let controllerRef;
      const stream = new ReadableStream({
        start(controller) {
          controllerRef = controller;
          subscribers.add(controller);
          for (const line of runState.log) {
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(line)}\n\n`));
          }
          if (!runState.running && runState.exitCode !== null) {
            controller.enqueue(new TextEncoder().encode(`event: done\ndata: ${JSON.stringify({ code: runState.exitCode })}\n\n`));
          }
        },
        cancel() {
          if (controllerRef) subscribers.delete(controllerRef);
        },
      });
      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
      });
    }

    if (url.pathname === '/api/tracker' && req.method === 'GET') {
      if (!existsSync(TRACKER_PATH)) return json([]);
      const text = readFileSync(TRACKER_PATH, 'utf-8');
      return json(csvToRecords(text, TRACKER_FIELDS));
    }
    if (url.pathname === '/api/tracker' && req.method === 'POST') {
      const body = await req.json().catch(() => null);
      if (!Array.isArray(body)) return json({ error: 'array of records required' }, { status: 400 });
      writeFileSync(TRACKER_PATH, recordsToCsv(body, TRACKER_FIELDS), 'utf-8');
      return json({ ok: true, rows: body.length });
    }

    return new Response('Not found', { status: 404 });
  },
});

console.log(`Job search dashboard: http://127.0.0.1:${server.port}/`);
console.log('Tekan Ctrl+C di jendela ini untuk mematikan server.');
