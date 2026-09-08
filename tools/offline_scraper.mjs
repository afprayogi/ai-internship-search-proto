// Offline job scraper - no Claude/AI involved. Runs the LinkedIn CLI tool AND
// fetches JobStreet directly (via its own server-rendered search pages), then
// dedupes, cross-checks against jobs you've already applied to, tags rough
// location/employment-type signals, and appends new listings to a CSV log.
//
// freehire.me was dropped from this script on purpose - for Indonesia its
// --country=ID facet conflated Indonesia with the US state abbreviation
// "ID" (Idaho), and most results were senior/global roles, not internships.
// LinkedIn + JobStreet cover this market far better on their own.
//
// This does NOT evaluate fit, write CVs, or do anything that requires judgment -
// that part of the framework needs Claude Code running interactively. This script
// only automates the raw "go find new postings" step so it can run unattended,
// as many times as you want, without opening Claude Code or spending any AI usage.
//
// Run manually:   bun run tools/offline_scraper.mjs   (or double-click run_offline_scraper.bat)
// Edit queries:   change KEYWORDS below.
// Output:         job_scraper/offline_jobs_log.csv (append-only, one row per new listing)
// Dedup state:    job_scraper/offline_seen.json (separate from Claude's own seen_jobs.json
//                  on purpose, so this script never touches /scrape's state)

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { DEFAULT_CONFIG } from './scraper_config_defaults.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SEEN_PATH = path.join(ROOT, 'job_scraper', 'offline_seen.json');
const LOG_PATH = path.join(ROOT, 'job_scraper', 'offline_jobs_log.csv');
const TRACKER_PATH = path.join(ROOT, 'job_search_tracker.csv');
const CONFIG_PATH = path.join(ROOT, 'job_scraper', 'scraper_config.json');

const LINKEDIN_CLI = path.join(ROOT, '.agents/skills/linkedin-search/cli/src/cli.ts');

// ---------------------------------------------------------------------------
// SEARCH TERMS - edit these via the dashboard's "Search settings" panel
// (tools/open_dashboard.bat), or by hand-editing job_scraper/scraper_config.json
// directly. Falls back to tools/scraper_config_defaults.mjs if that file
// doesn't exist yet (fresh clone). Mirrors the Priority 1/2/3/5 categories in
// .claude/skills/job-scraper/search-queries.md.
// ---------------------------------------------------------------------------
function loadConfig() {
  if (!existsSync(CONFIG_PATH)) return DEFAULT_CONFIG;
  try {
    const onDisk = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    return { ...DEFAULT_CONFIG, ...onDisk };
  } catch {
    console.error(`  [warn] job_scraper/scraper_config.json gagal dibaca, pakai default bawaan.`);
    return DEFAULT_CONFIG;
  }
}

const CONFIG = loadConfig();
const KEYWORDS = CONFIG.keywords;

// How many result pages to pull per keyword, per portal. LinkedIn's own ToS asks
// for low volume, so it defaults to 1 page; JobStreet is the main coverage gap
// this script exists to close, so it defaults to 2.
const LINKEDIN_MAX_PAGES = CONFIG.linkedinMaxPages;
const JOBSTREET_MAX_PAGES = CONFIG.jobstreetMaxPages;

// Cities/regions close to Surabaya (no relocation needed) vs. generally workable
// vs. everything else.
const IDEAL_LOCATIONS = CONFIG.idealLocations;
const ACCEPTABLE_LOCATIONS = CONFIG.acceptableLocations;

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const CSV_HEADER = 'found_date,portal,title,company,location,location_tier,employment_type_hint,salary,posted_date,description,url\n';

// ---------------------------------------------------------------------------
// bun CLI helper (LinkedIn)
// ---------------------------------------------------------------------------

// Fallback path in case `bun` isn't on PATH for whatever runs this (e.g. a stale
// Task Scheduler environment) - matches where winget installs it on this machine.
const BUN_FALLBACK = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'bun.exe');

function execBun(args) {
  try {
    return execFileSync('bun', args, { encoding: 'utf-8', timeout: 30000 });
  } catch (err) {
    if (err.code === 'ENOENT' && existsSync(BUN_FALLBACK)) {
      return execFileSync(BUN_FALLBACK, args, { encoding: 'utf-8', timeout: 30000 });
    }
    throw err;
  }
}

function runCli(cliPath, args, label) {
  try {
    const out = execBun(['run', cliPath, 'search', ...args, '--format', 'json']);
    return JSON.parse(out);
  } catch (err) {
    const stderr = String(err.stderr || err.message || err);
    if (/429/.test(stderr)) {
      console.error(`  [rate-limited] ${label}: portal lagi throttle, coba lagi nanti (jangan diulang buru-buru)`);
    } else {
      console.error(`  [error] ${label}: ${stderr.split('\n')[0]}`);
    }
    return { results: [] };
  }
}

// ---------------------------------------------------------------------------
// JobStreet - no CLI exists for it, so this fetches its own server-rendered
// search pages directly and pulls the embedded JSON state out of the HTML.
// JobStreet renders full job data server-side for SEO, so a plain GET with a
// browser User-Agent gets real data back - no login, no API key.
//
// Fragile by nature: if JobStreet changes how they embed this data, this will
// start returning 0 results (not crash - see the try/catch below). If that
// happens, tell Claude "JobStreet berhenti kasih hasil" and it can re-diagnose.
// ---------------------------------------------------------------------------

// Balanced-brace extraction (not a naive regex) so a stray "};" inside a
// string value in the embedded JSON can't truncate the object early.
function extractJsonAfterMarker(html, marker) {
  const idx = html.indexOf(marker);
  if (idx === -1) return null;
  const eq = html.indexOf('=', idx);
  const start = html.indexOf('{', eq);
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Returns { jobs, blocked }. `blocked: true` means JobStreet's Cloudflare
// bot-protection served a JS challenge page instead of real data - a plain
// script cannot solve that (it requires running actual JavaScript in a real
// browser), so the caller should back off rather than keep hammering it.
async function fetchJobStreetPage(query, page) {
  const url = `https://id.jobstreet.com/id/jobs?keywords=${encodeURIComponent(query)}&page=${page}`;
  let html;
  let res;
  try {
    res = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
      },
      redirect: 'follow',
    });
    html = await res.text();
    if (!res.ok) {
      const challenged = res.headers.get('cf-mitigated') === 'challenge' || /Just a moment/i.test(html);
      if (challenged) {
        console.error(`  [blocked] jobstreet "${query}" p${page}: Cloudflare ngeluarin JS challenge - gak bisa diselesain script biasa.`);
        return { jobs: [], blocked: true };
      }
      console.error(`  [error] jobstreet "${query}" p${page}: HTTP ${res.status}`);
      return { jobs: [], blocked: false };
    }
  } catch (err) {
    console.error(`  [error] jobstreet "${query}" p${page}: ${String(err.message || err).split('\n')[0]}`);
    return { jobs: [], blocked: false };
  }

  const raw = extractJsonAfterMarker(html, 'window.SEEK_APOLLO_DATA');
  if (!raw) {
    console.error(`  [error] jobstreet "${query}" p${page}: embedded data not found (site layout may have changed)`);
    return { jobs: [], blocked: false };
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    console.error(`  [error] jobstreet "${query}" p${page}: embedded data did not parse as JSON`);
    return { jobs: [], blocked: false };
  }

  const rootQuery = data.ROOT_QUERY || {};
  const searchKey = Object.keys(rootQuery).find((k) => k.startsWith('jobSearchV7'));
  if (!searchKey) return { jobs: [], blocked: false };
  const jobs = rootQuery[searchKey]?.results?.jobs || [];

  const mapped = jobs.map((job) => {
    const locRef = job.location?.__ref;
    const locObj = locRef ? data[locRef] : null;
    const locationText = locObj?.displayName?.text || '';
    const workTypeEntry = job.cjs?.workTypes?.[0] || {};
    const workType = workTypeEntry['name({"locale":"id-ID"})'] || workTypeEntry.name || '';
    const s = job.salary;
    const salaryText = s && s.min && s.max
      ? `${s.currency} ${s.min.toLocaleString('id-ID')}-${s.max.toLocaleString('id-ID')}/${s.period}`
      : '';
    return {
      portal: 'jobstreet',
      title: job.title || '',
      company: job.advertiser?.name || '',
      location: locationText,
      date: job.listedAt?.dateTimeUtc ? job.listedAt.dateTimeUtc.slice(0, 10) : '',
      url: job.id ? `https://id.jobstreet.com/id/job/${job.id}` : '',
      description: (job.abstract || '').replace(/\s+/g, ' ').trim().slice(0, 200),
      work_type: workType,
      salary: salaryText,
    };
  });
  return { jobs: mapped, blocked: false };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function loadSeen() {
  if (!existsSync(SEEN_PATH)) return {};
  try {
    return JSON.parse(readFileSync(SEEN_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function saveSeen(seen) {
  writeFileSync(SEEN_PATH, JSON.stringify(seen, null, 2), 'utf-8');
}

// Loose substring match against the tracker's raw lines - robust to whatever
// exact column layout job_search_tracker.csv ends up with.
function loadTrackerLines() {
  if (!existsSync(TRACKER_PATH)) return [];
  try {
    return readFileSync(TRACKER_PATH, 'utf-8').split('\n').slice(1).filter((l) => l.trim()).map((l) => l.toLowerCase());
  } catch {
    return [];
  }
}

function alreadyApplied(trackerLines, company, title) {
  if (!trackerLines.length) return false;
  const c = (company || '').toLowerCase();
  const t = (title || '').toLowerCase();
  if (!c || !t) return false;
  return trackerLines.some((line) => line.includes(c) && line.includes(t));
}

function locationTier(locationText) {
  const t = (locationText || '').toLowerCase();
  if (IDEAL_LOCATIONS.some((c) => t.includes(c))) return 'ideal (dekat Surabaya)';
  if (ACCEPTABLE_LOCATIONS.some((c) => t.includes(c))) return 'acceptable';
  return 'cek jarak';
}

function normTitle(t) {
  return (t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

const INTERN_PATTERN = /\b(intern|internship|magang|apprentice)\b/i;

function employmentTypeHint(job) {
  if (job.work_type) return job.work_type;
  const text = `${job.title} ${job.description || ''}`;
  return INTERN_PATTERN.test(text) ? 'Kemungkinan magang (dari judul)' : '';
}

// Consolidate same company+title posted across multiple cities into one row,
// instead of presenting each city as a separate "new" listing.
function consolidateMassPostings(jobs) {
  const groups = new Map();
  for (const job of jobs) {
    const key = `${(job.company || '').toLowerCase()}|||${normTitle(job.title)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(job);
  }
  const out = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      out.push(group[0]);
      continue;
    }
    const locs = [...new Set(group.map((j) => j.location).filter(Boolean))];
    if (locs.length <= 1) {
      out.push(...group);
      continue;
    }
    const merged = { ...group[0] };
    merged.title = `${merged.title} (posting sama di ${locs.length} kota)`;
    merged.location = locs.slice(0, 5).join('; ') + (locs.length > 5 ? ', ...' : '');
    out.push(merged);
  }
  return out;
}

function csvEscape(value) {
  if (value == null) return '';
  const str = String(value);
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

function ensureLogHeader() {
  if (!existsSync(LOG_PATH)) {
    writeFileSync(LOG_PATH, CSV_HEADER, 'utf-8');
    return;
  }
  const firstLine = readFileSync(LOG_PATH, 'utf-8').split('\n')[0] + '\n';
  if (firstLine !== CSV_HEADER) {
    const backupPath = LOG_PATH.replace(/\.csv$/, '.legacy.csv');
    writeFileSync(backupPath, readFileSync(LOG_PATH));
    console.log(`  [info] Format kolom CSV berubah - data lama dipindah ke ${path.basename(backupPath)}, mulai file baru.`);
    writeFileSync(LOG_PATH, CSV_HEADER, 'utf-8');
  }
}

function appendRow(job) {
  const row = [
    new Date().toISOString().slice(0, 10),
    job.portal,
    job.title,
    job.company,
    job.location,
    locationTier(job.location),
    employmentTypeHint(job),
    job.salary || '',
    job.date,
    job.description || '',
    job.url,
  ].map(csvEscape).join(',');
  appendFileSync(LOG_PATH, row + '\n', 'utf-8');
}

function beepIfNew(count) {
  if (count <= 0 || process.platform !== 'win32') return;
  try {
    execFileSync('powershell', ['-NoProfile', '-Command', '[console]::beep(900,250); [console]::beep(1300,250);'], { timeout: 5000 });
  } catch {
    // best-effort only - never fail the run over a sound
  }
}

// Live progress feedback so the process is visible while it runs, not just a
// silent pause followed by a final total at the end.
function logQueryProgress(total, newCount) {
  if (total === 0) {
    console.log('    -> 0 hasil');
  } else {
    console.log(`    -> ${total} hasil (${newCount} kemungkinan baru)`);
  }
}

// ---------------------------------------------------------------------------
// WhatsApp notification (optional, best-effort - a WA send failure never
// fails the run; the CSV is still the source of truth either way).
//
// Talks to a local WhatsApp gateway (e.g. go-whatsapp-web-multidevice /
// wuzapi-style server) that YOU run and control on this machine. This script
// never talks to WhatsApp directly - only to your own localhost:3000 server.
//
// No duplicate-message risk by construction: this only ever gets called with
// `consolidated`, which is already filtered against job_scraper/offline_seen.json
// earlier in main() - a listing can only ever appear in a WA notification once,
// on the run where it was first found.
//
// All settings below come from .env (Bun loads it automatically, no extra
// package needed) - edit .env to change number/credentials, never this file.
// See .env.example for the full list with comments. Falls back to sane
// defaults if .env is missing so the script still runs.
// ---------------------------------------------------------------------------
const WA_ENABLED = (process.env.WA_ENABLED ?? 'true') !== 'false';
const WA_BASE_URL = process.env.WA_BASE_URL || 'http://localhost:3000';
const WA_AUTH_USER = process.env.WA_AUTH_USER || 'user1';
const WA_AUTH_PASS = process.env.WA_AUTH_PASS || 'pass1';
const WA_DEVICE_ID = process.env.WA_DEVICE_ID || '';
// Placeholder only - never a real number. Set WA_TARGET in .env (gitignored);
// see .env.example for the format. No .env means this placeholder gets used,
// so a send would go nowhere real rather than to a hardcoded personal number.
const WA_TARGETS = (process.env.WA_TARGET || '6281234567890@s.whatsapp.net')
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);
// When true, builds every message and logs it, but never actually calls the WA
// API - nothing can be delivered to anyone. Set WA_DRY_RUN=true in .env whenever
// testing/debugging so a live send never happens by accident.
const WA_DRY_RUN = (process.env.WA_DRY_RUN ?? 'false') === 'true';

function waAuthHeader() {
  return 'Basic ' + Buffer.from(`${WA_AUTH_USER}:${WA_AUTH_PASS}`).toString('base64');
}

// Permanent proof-of-send record - separate from the console output, which
// disappears once the cmd window closes. One row per attempt, success or fail.
const WA_LOG_PATH = path.join(ROOT, 'job_scraper', 'whatsapp_log.csv');
const WA_LOG_HEADER = 'timestamp,status,target,job_count,http_status,error,message_preview\n';

function logWhatsAppAttempt({ status, target, jobCount, httpStatus, error, message }) {
  if (!existsSync(WA_LOG_PATH)) {
    writeFileSync(WA_LOG_PATH, WA_LOG_HEADER, 'utf-8');
  }
  const preview = (message || '').replace(/\n/g, ' | ').slice(0, 150);
  const row = [
    new Date().toISOString(),
    status,
    target,
    jobCount,
    httpStatus ?? '',
    error ?? '',
    preview,
  ].map(csvEscape).join(',');
  appendFileSync(WA_LOG_PATH, row + '\n', 'utf-8');
}

async function sendToOneTarget(target, text, jobCount) {
  if (WA_DRY_RUN) {
    console.log(`  [whatsapp] DRY-RUN - akan kirim ke ${target} tapi TIDAK beneran dikirim (WA_DRY_RUN=true di .env).`);
    logWhatsAppAttempt({ status: 'dry_run', target, jobCount, httpStatus: '', error: '', message: text });
    return true;
  }
  const headers = { 'Content-Type': 'application/json', Authorization: waAuthHeader() };
  if (WA_DEVICE_ID) headers['X-Device-Id'] = WA_DEVICE_ID;
  try {
    const res = await fetch(`${WA_BASE_URL}/send/message`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ phone: target, message: text }),
    });
    if (!res.ok) {
      console.error(`  [whatsapp] gagal kirim ke ${target} (HTTP ${res.status}) - cek server WA-nya nyala apa enggak. (dicatat di job_scraper/whatsapp_log.csv)`);
      logWhatsAppAttempt({ status: 'failed', target, jobCount, httpStatus: res.status, error: `HTTP ${res.status}`, message: text });
      return false;
    }
    console.log(`  [whatsapp] notifikasi terkirim ke ${target} (dicatat di job_scraper/whatsapp_log.csv).`);
    logWhatsAppAttempt({ status: 'sent', target, jobCount, httpStatus: res.status, error: '', message: text });
    return true;
  } catch (err) {
    const errMsg = String(err.message || err).split('\n')[0];
    console.error(`  [whatsapp] gagal kirim ke ${target}: ${errMsg} - server WA-nya (${WA_BASE_URL}) kemungkinan belum nyala. (dicatat di job_scraper/whatsapp_log.csv)`);
    logWhatsAppAttempt({ status: 'failed', target, jobCount, httpStatus: '', error: errMsg, message: text });
    return false;
  }
}

// Sends the same message to every configured target (WA_TARGETS - one or more,
// from the comma-separated WA_TARGET in .env).
async function sendWhatsAppMessage(text, jobCount) {
  let allOk = true;
  for (const target of WA_TARGETS) {
    const ok = await sendToOneTarget(target, text, jobCount);
    if (!ok) allOk = false;
  }
  return allOk;
}

// Groups jobs by the search keyword that found them, so each WhatsApp message
// can be complete (no top-N cap) while staying a manageable size per message.
function groupByKeyword(jobs) {
  const groups = new Map();
  for (const job of jobs) {
    const k = job.keyword || '(lainnya)';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(job);
  }
  return groups;
}

// Full, untruncated listing for one keyword - every job found for it.
function buildKeywordMessage(keyword, jobs) {
  const lines = [];
  lines.push(`*Lowongan Baru - "${keyword}"* (${new Date().toISOString().slice(0, 10)})`);
  lines.push(`${jobs.length} lowongan baru buat kata kunci ini:`);
  lines.push('');
  jobs.forEach((job, i) => {
    lines.push(`${i + 1}. ${job.title}`);
    lines.push(`   ${job.company} - ${job.location} [${job.portal}]`);
    const hint = employmentTypeHint(job);
    const extras = [hint, job.salary].filter(Boolean).join(' | ');
    if (extras) lines.push(`   ${extras}`);
    lines.push(`   ${job.url}`);
  });
  return lines.join('\n');
}

// Sends one complete message per keyword (not one combined/truncated summary).
// Every job found gets sent - if that means several messages, that's fine, as
// long as nothing gets left out. Still duplicate-free by construction, since
// `jobs` here is always the already-deduped `consolidated` list.
async function notifyWhatsApp(jobs) {
  if (!WA_ENABLED || jobs.length === 0) return;
  const groups = groupByKeyword(jobs);
  console.log(`  [whatsapp] ngirim ${groups.size} pesan (1 per kata kunci, isinya lengkap semua)...`);
  for (const [keyword, groupJobs] of groups) {
    const message = buildKeywordMessage(keyword, groupJobs);
    await sendWhatsAppMessage(message, groupJobs.length);
    await sleep(1200 + Math.floor(Math.random() * 800)); // jeda antar pesan biar gak keliatan spam ke WhatsApp
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`[${new Date().toISOString()}] Offline job scraper starting...`);
  const seen = loadSeen();
  const trackerLines = loadTrackerLines();
  ensureLogHeader();

  const collected = [];

  for (const q of KEYWORDS) {
    console.log(`  LinkedIn: "${q}"`);
    for (let page = 1; page <= LINKEDIN_MAX_PAGES; page++) {
      const data = runCli(LINKEDIN_CLI, ['-q', q, '-l', 'Indonesia', '--jobage', '14', '--limit', '20', '--page', String(page)], `linkedin "${q}" p${page}`);
      const before = collected.length;
      let newish = 0;
      for (const job of data.results || []) {
        if (!job.url) continue;
        collected.push({ portal: 'linkedin', keyword: q, title: job.title, company: job.company, location: job.location, date: job.date, url: job.url, description: '' });
        if (!seen[job.url]) newish++;
      }
      logQueryProgress(collected.length - before, newish);
    }
  }

  let consecutiveBlocks = 0;
  let jobstreetGaveUp = false;
  for (const q of KEYWORDS) {
    if (jobstreetGaveUp) break;
    console.log(`  JobStreet: "${q}"`);
    for (let page = 1; page <= JOBSTREET_MAX_PAGES; page++) {
      const { jobs, blocked } = await fetchJobStreetPage(q, page);
      jobs.forEach((j) => { j.keyword = q; });
      collected.push(...jobs);
      if (!blocked) {
        const newish = jobs.filter((j) => !seen[j.url]).length;
        logQueryProgress(jobs.length, newish);
      }
      if (blocked) {
        consecutiveBlocks++;
        if (consecutiveBlocks >= 2) {
          console.error('  [jobstreet] Kena Cloudflare challenge 2x berturut-turut - berhenti nyoba JobStreet buat run ini. LinkedIn tetap lanjut. Coba lagi beberapa jam lagi.');
          jobstreetGaveUp = true;
          break;
        }
      } else {
        consecutiveBlocks = 0;
      }
      await sleep(400 + Math.floor(Math.random() * 400)); // jeda sopan antar request
    }
  }

  // Dedup against this script's own memory + skip anything already applied to.
  const fresh = collected.filter((job) => {
    if (!job.url || seen[job.url]) return false;
    if (alreadyApplied(trackerLines, job.company, job.title)) return false;
    return true;
  });

  // Dedup within this run too (same job can surface from overlapping keywords).
  const dedupedThisRun = [];
  const seenThisRun = new Set();
  for (const job of fresh) {
    if (seenThisRun.has(job.url)) continue;
    seenThisRun.add(job.url);
    dedupedThisRun.push(job);
  }

  const consolidated = consolidateMassPostings(dedupedThisRun);

  for (const job of consolidated) {
    appendRow(job);
  }
  for (const job of dedupedThisRun) {
    seen[job.url] = { title: job.title, company: job.company, first_seen: new Date().toISOString().slice(0, 10) };
  }
  saveSeen(seen);

  console.log(`\n[${new Date().toISOString()}] Done. ${consolidated.length} new listing(s) appended to ${LOG_PATH}`);
  if (trackerLines.length) {
    console.log(`  (${trackerLines.length} baris di job_search_tracker.csv dipakai buat nyaring yang udah pernah dilamar)`);
  }
  if (consolidated.length > 0) {
    console.log('\nLowongan baru yang ketemu:');
    const SHOW_MAX = 30;
    consolidated.slice(0, SHOW_MAX).forEach((job, i) => {
      console.log(`  ${i + 1}. [${job.portal}] ${job.title} - ${job.company} (${job.location})`);
    });
    if (consolidated.length > SHOW_MAX) {
      console.log(`  ... + ${consolidated.length - SHOW_MAX} lainnya, lihat job_scraper/offline_jobs_log.csv buat daftar lengkap`);
    }
  }
  await notifyWhatsApp(consolidated);
  beepIfNew(consolidated.length);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
