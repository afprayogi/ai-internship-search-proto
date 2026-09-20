// Offline job scraper - no Claude/AI involved. Runs the LinkedIn CLI tool AND
// fetches JobStreet + Glints directly (via their own server-rendered search
// pages), then dedupes, cross-checks against jobs you've already applied to,
// tags rough location/employment-type signals, and appends new listings to a
// CSV log.
//
// freehire.me was dropped from this script on purpose - for Indonesia its
// --country=ID facet conflated Indonesia with the US state abbreviation
// "ID" (Idaho), and most results were senior/global roles, not internships.
// LinkedIn + JobStreet + Glints cover this market far better on their own.
//
// This does NOT evaluate fit, write CVs, or do anything that requires judgment -
// that part of the framework needs Claude Code running interactively. This script
// only automates the raw "go find new postings" step so it can run unattended,
// as many times as you want, without opening Claude Code or spending any AI usage.
//
// Run manually:   bun run tools/offline_scraper.mjs   (or double-click run_offline_scraper.bat)
// Edit queries:   edit keyword groups via the dashboard's Search settings panel
//                 (or job_scraper/scraper_config.json's keywordGroups directly).
// Output:         job_scraper/offline_jobs_log.csv (append-only, one row per new listing)
// Dedup state:    job_scraper/offline_seen.json (separate from Claude's own seen_jobs.json
//                  on purpose, so this script never touches /scrape's state)

import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { DEFAULT_CONFIG } from './scraper_config_defaults.mjs';

// ---------------------------------------------------------------------------
// Console output - friendly and consistent. Colors only when attached to a real
// terminal (not when the dashboard pipes this into its log box) and NO_COLOR unset.
// ---------------------------------------------------------------------------
const USE_COLOR = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code, s) => (USE_COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
const RUN_STARTED_AT = Date.now();
let uiPortal = '';
const ERROR_HINTS = [
  [/HTTP (403|429)|Cloudflare|diblokir/i, 'kemungkinan diblokir sementara - dilewati, coba lagi nanti'],
  [/HTTP 5\d\d/i, 'server portalnya lagi bermasalah - coba lagi nanti'],
  [/fetch failed|ENOTFOUND|ECONN|ETIMEDOUT|timed out|network/i, 'cek koneksi internet'],
  [/tidak ketemu|tidak bisa dibaca|layout/i, 'tampilan situs mungkin berubah'],
];
function hintFor(msg) {
  const h = ERROR_HINTS.find(([re]) => re.test(msg));
  return h ? paint(2, ` (${h[1]})`) : '';
}
const ui = {
  banner(lines) {
    const bar = '='.repeat(56);
    console.log(paint(36, bar));
    lines.forEach((l, i) => console.log(i === 0 ? paint(1, ' ' + l) : ' ' + l));
    console.log(paint(36, bar));
  },
  head(text) { console.log('\n' + paint(1, text)); },
  query(portal, group, keyword) {
    if (portal !== uiPortal) { uiPortal = portal; console.log('\n' + paint(1, `▶ ${portal}`)); }
    console.log(`  • ${keyword}` + (group ? paint(2, `  [${group}]`) : ''));
  },
  line(portal, group, keyword, total, fresh) {
    const tail = total === 0 ? paint(2, 'belum ada hasil') : `${total} hasil` + (fresh ? paint(32, `, ${fresh} baru`) : paint(2, ', belum ada yang baru'));
    console.log(`  ${total === 0 ? paint(2, '·') : paint(32, '✔')} ${paint(1, portal)} · ${keyword}${group ? paint(2, `  [${group}]`) : ''}  →  ${tail}`);
  },
  result(total, fresh) {
    console.log(total === 0
      ? paint(2, '      belum ada hasil')
      : `      → ${total} hasil` + (fresh ? paint(32, `, ${fresh} baru`) : paint(2, ', belum ada yang baru')));
  },
  ok(msg) { console.log(paint(32, '  ✔ ') + msg); },
  note(msg) { console.log(paint(36, '  ℹ ') + msg); },
  warn(msg) { console.error(paint(33, '  ⚠ ') + msg + hintFor(msg)); },
  fail(msg) { console.error(paint(31, '  ✖ ') + msg + hintFor(msg)); },
  duration() {
    const s = Math.round((Date.now() - RUN_STARTED_AT) / 1000);
    return s < 60 ? `${s} detik` : `${Math.floor(s / 60)} menit ${s % 60} detik`;
  },
};


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
    const merged = { ...DEFAULT_CONFIG, ...onDisk };
    // Pre-groups config files only ever had a flat `keywords` array. Wrap it
    // in a single "Default" group rather than forcing a one-time manual
    // migration - an old job_scraper/scraper_config.json just keeps working.
    if (!onDisk.keywordGroups && Array.isArray(onDisk.keywords)) {
      merged.keywordGroups = [{ name: 'Default', enabled: true, keywords: onDisk.keywords }];
    }
    return merged;
  } catch {
    ui.warn(`job_scraper/scraper_config.json gagal dibaca, pakai default bawaan.`);
    return DEFAULT_CONFIG;
  }
}

const CONFIG = loadConfig();
const KEYWORD_GROUPS = Array.isArray(CONFIG.keywordGroups) ? CONFIG.keywordGroups : [];

// Which group(s) to search this run. Set by the dashboard's per-group "Run"
// button (SCRAPER_GROUP=<name> on the spawned process); double-clicking
// run_offline_scraper.bat or the dashboard's combined "Run scraper now"
// leaves it unset, which searches every group that isn't disabled.
const RUN_GROUP = (process.env.SCRAPER_GROUP || '').trim();
const ACTIVE_GROUPS = RUN_GROUP
  ? KEYWORD_GROUPS.filter((g) => g.name === RUN_GROUP)
  : KEYWORD_GROUPS.filter((g) => g.enabled !== false);
if (RUN_GROUP && !ACTIVE_GROUPS.length) {
  ui.warn(`Grup keyword "${RUN_GROUP}" tidak ketemu di scraper_config.json - gak ada yang dicari.`);
}
// Flattened {keyword, group} pairs - every search loop below iterates this
// once instead of re-implementing the group nesting four times over.
const KEYWORD_ENTRIES = ACTIVE_GROUPS.flatMap((g) => (g.keywords || []).map((k) => ({ keyword: k, group: g.name })));

// How many result pages to pull per keyword, per portal. LinkedIn's own ToS asks
// for low volume, so it defaults to 1 page; JobStreet is the main coverage gap
// this script exists to close, so it defaults to 2.
const LINKEDIN_MAX_PAGES = CONFIG.linkedinMaxPages;
const JOBSTREET_MAX_PAGES = CONFIG.jobstreetMaxPages;

// Cities/regions close to Surabaya (no relocation needed) vs. generally workable
// vs. everything else.
const IDEAL_LOCATIONS = CONFIG.idealLocations;
const ACCEPTABLE_LOCATIONS = CONFIG.acceptableLocations;

// Skill/domain keywords used for the offline fit score - see computeFitScore.
const PROFILE_SKILLS = CONFIG.profileSkills || [];

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const CSV_HEADER = 'found_date,portal,source_type,keyword_group,title,company,location,location_tier,employment_type_hint,salary,posted_date,description,requirements,eligibility,deadline,deadline_iso,fit_score,apply_method,url\n';

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

async function execBunAsync(args) {
  try {
    return (await execFileAsync('bun', args, { encoding: 'utf-8', timeout: 30000, maxBuffer: 20 * 1024 * 1024 })).stdout;
  } catch (err) {
    if (err.code === 'ENOENT' && existsSync(BUN_FALLBACK)) {
      return (await execFileAsync(BUN_FALLBACK, args, { encoding: 'utf-8', timeout: 30000, maxBuffer: 20 * 1024 * 1024 })).stdout;
    }
    throw err;
  }
}

async function runCli(cliPath, args, label) {
  try {
    const out = await execBunAsync(['run', cliPath, 'search', ...args, '--format', 'json']);
    return JSON.parse(out);
  } catch (err) {
    const stderr = String(err.stderr || err.message || err);
    if (/429/.test(stderr)) {
      ui.warn(`Dibatasi portal - ${label}: portal lagi throttle, coba lagi nanti (jangan diulang buru-buru)`);
    } else {
      ui.fail(`${label}: ${stderr.split('\n')[0]}`);
    }
    return { results: [] };
  }
}

// Fetches one LinkedIn job's full detail page (the CLI's own `detail`
// subcommand) for its complete description - the search-results card only
// has title/company/location/date, no requirements text. Only called for
// genuinely new postings (not on every search result) to keep request
// volume low, per LinkedIn's ToS concerns already noted above.
async function runCliDetail(cliPath, id, label) {
  try {
    const out = await execBunAsync(['run', cliPath, 'detail', id, '--format', 'json']);
    return JSON.parse(out);
  } catch (err) {
    const stderr = String(err.stderr || err.message || err);
    if (/429/.test(stderr)) {
      ui.warn(`Dibatasi portal - detail ${label}: portal lagi throttle, skip detail buat ini.`);
    } else {
      ui.fail(`detail ${label}: ${stderr.split('\n')[0]}`);
    }
    return null;
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

// Balanced-depth extraction of a <div data-automation="X">...</div> block,
// so nested <div>s inside the description (bullet lists, etc.) don't
// truncate it early. Same technique as extractJsonAfterMarker above, applied
// to tags instead of braces.
function extractDivByAttr(html, attr, value) {
  const openRe = new RegExp(`<div[^>]*${attr}="${value}"[^>]*>`, 'i');
  const open = openRe.exec(html);
  if (!open) return null;
  let i = open.index + open[0].length;
  let depth = 1;
  while (depth > 0 && i < html.length) {
    const nextOpen = html.indexOf('<div', i);
    const nextClose = html.indexOf('</div>', i);
    if (nextClose === -1) return null;
    if (nextOpen !== -1 && nextOpen < nextClose) { depth++; i = nextOpen + 4; }
    else { depth--; i = nextClose + 6; }
  }
  return html.slice(open.index + open[0].length, i - 6);
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)));
}

function htmlToText(html) {
  const withBreaks = html
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|ul|ol|div|h[1-6])>/gi, '\n');
  return decodeHtmlEntities(withBreaks.replace(/<[^>]+>/g, ' ')).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

// Fetches a single JobStreet job's own page for its full description - the
// search-results page only gives a ~200-char teaser (job.abstract), not
// enough to tell "open to students" from "graduate hire only". Same
// no-login public GET as fetchJobStreetPage; only called for genuinely new
// postings (not on every search result) to keep request volume down.
async function fetchJobStreetDetail(url) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
      },
      redirect: 'follow',
    });
    const html = await res.text();
    if (!res.ok) return null;
    const block = extractDivByAttr(html, 'data-automation', 'jobAdDetails');
    return block ? htmlToText(block) : null;
  } catch {
    return null;
  }
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
        ui.warn(`Diblokir - jobstreet "${query}" p${page}: Cloudflare minta verifikasi browser, tidak bisa dilewati skrip.`);
        return { jobs: [], blocked: true };
      }
      ui.fail(`jobstreet "${query}" p${page}: HTTP ${res.status}`);
      return { jobs: [], blocked: false };
    }
  } catch (err) {
    ui.fail(`jobstreet "${query}" p${page}: ${String(err.message || err).split('\n')[0]}`);
    return { jobs: [], blocked: false };
  }

  const raw = extractJsonAfterMarker(html, 'window.SEEK_APOLLO_DATA');
  if (!raw) {
    ui.fail(`jobstreet "${query}" p${page}: data tidak ketemu (tampilan situs mungkin berubah)`);
    return { jobs: [], blocked: false };
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    ui.fail(`jobstreet "${query}" p${page}: data tidak bisa dibaca`);
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
// Glints - same idea as JobStreet: a plain GET with a browser User-Agent
// gets the first page of results server-rendered into a Next.js
// __NEXT_DATA__ blob, no login needed. Deliberately page-1-only: results
// beyond page 1 are fetched client-side via Glints' internal GraphQL API on
// the real site, which isn't reverse-engineered here - that would mean
// guessing at query/header shapes for an undocumented API rather than
// reading data the page already sends you, a meaningfully different (and
// more fragile) kind of scraping than everything else in this file.
// ---------------------------------------------------------------------------
function slugify(text) {
  return (text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'job';
}

// MAGENTA (magentaku.id, BUMN internships) - a Laravel site: GET /lowongan gives a
// CSRF token + session cookie, then POST /lowongan/list returns the job cards as HTML
// inside JSON. The inventory is small (dozens of postings), so we list everything once
// per run instead of searching per keyword; the fit score ranks relevance.
function parseMagentaCards(html) {
  const out = [];
  const parts = String(html || '').split('job-posting-item').slice(1);
  for (const c of parts) {
    const id = (c.match(/data-id="(\d+)"/) || [])[1];
    if (!id) continue;
    const kota = (c.match(/data-kota="(\d+)"/) || [])[1] || '';
    const title = ((c.match(/<h2[^>]*>([^<]*)<\/h2>/) || [])[1] || '').trim();
    const company = ((c.match(/alt="([^"]*)"/) || [])[1] || '').trim();
    const location = ((c.match(/<\/h2>\s*<p[^>]*>\s*([^<]*?)\s*<\/p>/) || [])[1] || '').trim();
    const badges = [];
    c.replace(/rounded-20px caption">\s*([^<]*?)\s*<\/span>/g, (_m, t) => { badges.push(t); return _m; });
    const closing = ((c.match(/Penutupan[^<]*<strong[^>]*>([^<]*)</) || [])[1] || '').trim();
    const published = ((c.match(/Diterbitkan\s*([^<]*)</) || [])[1] || '').trim();
    out.push({ id, kota, title, company, location, badges, closing, published });
  }
  return out;
}

// magentaku.id sits behind Cloudflare, which rejects Node/Bun's own fetch (TLS
// fingerprint) with 403 but accepts curl, so this portal shells out to curl.
const MAGENTA_JAR = path.join(ROOT, 'job_scraper', '.magenta_cookies.txt');
let magentaToken = null;
async function magentaCurl(args) {
  return (await execFileAsync('curl', ['-s', '-S', '--max-time', '25', '-A', USER_AGENT, '-b', MAGENTA_JAR, '-c', MAGENTA_JAR, ...args], { encoding: 'utf-8', maxBuffer: 20 * 1024 * 1024 })).stdout;
}
async function magentaOpen() {
  const html = await magentaCurl(['https://magentaku.id/lowongan']);
  magentaToken = (html.match(/csrf-token" content="([^"]*)/) || [])[1];
  if (!magentaToken) throw new Error('token tidak ketemu (diblokir Cloudflare atau curl tidak ada)');
}
async function magentaPost(pathname, body) {
  if (!magentaToken) await magentaOpen();
  return magentaCurl(['-X', 'POST', 'https://magentaku.id' + pathname, '-H', 'X-CSRF-TOKEN: ' + magentaToken, '-H', 'X-Requested-With: XMLHttpRequest', '-H', 'Accept: application/json', '-d', new URLSearchParams(body).toString()]);
}
async function fetchMagentaJobs() {
  const jobs = [], seenIds = new Set();
  try {
    for (let page = 1; page <= 10; page++) {
      const data = JSON.parse(await magentaPost('/lowongan/list', { page, type: 'all' }));
      const cards = parseMagentaCards(data.jobposting).filter((c) => !seenIds.has(c.id));
      if (!cards.length) break;
      for (const c of cards) {
        seenIds.add(c.id);
        const isIntern = /magang/i.test(c.badges[0] || '');
        jobs.push({
          portal: 'magenta', title: decodeHtmlEntities(c.title), company: decodeHtmlEntities(c.company), location: decodeHtmlEntities(c.location), date: '',
          url: 'https://magentaku.id/lowongan?posting=' + c.id + '&lokasi=' + c.kota,
          description: c.closing ? 'Batas pendaftaran: ' + c.closing + '.' : '',
          work_type: isIntern ? 'Internship' : (c.badges[0] || ''), salary: '', _mid: c.id, _mkota: c.kota,
        });
      }
      await sleep(300);
    }
  } catch (err) {
    ui.fail('magenta: ' + String(err.message || err).split('\n')[0]);
  }
  return jobs;
}
async function fetchMagentaDetail(job) {
  try {
    const html = await magentaPost('/lowongan/' + job._mid + '/detail', { lokasi: job._mkota, kota_id: job._mkota });
    const text = htmlToText(html);
    return (job.description ? job.description + '\n' : '') + text;
  } catch { return ''; }
}

// MagangHub (Kemnaker national internship program) - the lowongan page is server-rendered
// Next.js and embeds its vacancy list as JSON in the RSC payload (self.__next_f), 18 per
// page, filtered by ?keyword=. No login needed to read the public list.
function resolveMagangHubRefs(obj, t) {
  // Long strings are sent as separate RSC rows ("$24" -> a "24:T<hexLen>,<text>" row).
  (obj.data || []).forEach((v) => {
    const m = /^\$([0-9a-f]+)$/i.exec(v.taskDescription || '');
    if (!m) return;
    const at = t.search(new RegExp('(^|\\n)' + m[1] + ':T[0-9a-f]+,'));
    if (at < 0) { v.taskDescription = ''; return; }
    const head = /:T([0-9a-f]+),/.exec(t.slice(at, at + 24));
    let bytes = parseInt(head[1], 16), out = '';
    const start = at + head.index + head[0].length;
    for (let k = start; k < t.length && bytes > 0; k++) {
      const cp = t.codePointAt(k); const ch = String.fromCodePoint(cp);
      bytes -= cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
      out += ch; if (cp > 0xffff) k++;
    }
    v.taskDescription = out.trim();
  });
  return obj;
}
function extractMagangHubVacancies(html) {
  const parts = [...html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)].map((m) => { try { return JSON.parse(m[1]); } catch { return ''; } });
  const t = parts.join('');
  const i = t.indexOf('"initialVacancies":');
  if (i < 0) return null;
  let d = 0, inStr = false, esc = false;
  const s = t.indexOf('{', i);
  for (let j = s; j < t.length; j++) {
    const c = t[j];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; }
    else if (c === '"') inStr = true;
    else if (c === '{') d++;
    else if (c === '}' && --d === 0) { try { return resolveMagangHubRefs(JSON.parse(t.slice(s, j + 1)), t); } catch { return null; } }
  }
  return null;
}
const MAGANGHUB_LEVEL = { diploma: 'D3/D4', bachelor: 'S1', profession: 'Profesi', master: 'S2' };
async function fetchMagangHubPage(query, page) {
  const url = `https://maganghub.kemnaker.go.id/magang-nasional/lowongan?keyword=${encodeURIComponent(query)}&page=${page}`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'id-ID,id;q=0.9' } });
    if (!res.ok) { ui.fail(`maganghub "${query}": HTTP ${res.status}`); return []; }
    const data = extractMagangHubVacancies(await res.text());
    if (!data || !Array.isArray(data.data)) { ui.fail(`maganghub "${query}": data tidak ketemu (layout situs berubah?)`); return []; }
    return data.data.filter((v) => v.id).map((v) => {
      const levels = (v.educationLevels || []).map((l) => MAGANGHUB_LEVEL[l] || l).join(', ');
      const prodi = (v.studyPrograms || []).map((p) => p.name).join(', ');
      return {
        portal: 'maganghub',
        title: v.positionName || '',
        company: (v.organizer && v.organizer.name) || '',
        location: (v.city && v.city.name) || '',
        date: v.publishedAt ? v.publishedAt.slice(0, 10) : '',
        url: `https://maganghub.kemnaker.go.id/magang-nasional/lowongan/${slugify(v.positionName)}-${v.id}`,
        description: `Program Pemagangan Lulusan Perguruan Tinggi (MagangHub Kemnaker). Jenjang: ${levels}. Program studi: ${prodi}. Kuota: ${v.approvedQuantity || v.quantityNeeded || '-'}. ${v.taskDescription || ''}`,
        work_type: 'Internship',
        salary: '',
      };
    });
  } catch (err) {
    ui.fail(`maganghub "${query}": ${String(err.message || err).split('\n')[0]}`);
    return [];
  }
}

let glintsBlockedCount = 0;
async function fetchGlintsPage(query) {
  const url = `https://glints.com/id/opportunities/jobs/explore?keyword=${encodeURIComponent(query)}&country=ID`;
  let html;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
      },
      redirect: 'follow',
    });
    html = await res.text();
    if (!res.ok) {
      if (res.status === 403 || res.status === 429) glintsBlockedCount++;
      ui.fail(`glints "${query}": HTTP ${res.status}`);
      return [];
    }
  } catch (err) {
    ui.fail(`glints "${query}": ${String(err.message || err).split('\n')[0]}`);
    return [];
  }

  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) {
    ui.fail(`glints "${query}": data tidak ketemu (tampilan situs mungkin berubah)`);
    return [];
  }
  let data;
  try {
    data = JSON.parse(m[1]);
  } catch {
    ui.fail(`glints "${query}": data tidak bisa dibaca`);
    return [];
  }
  const jobs = data?.props?.pageProps?.initialJobs?.jobsInPage || [];

  return jobs.filter((job) => job.id).map((job) => {
    const s = (job.salaries || [])[0];
    const salaryText = s && s.minAmount && s.maxAmount
      ? `${s.CurrencyCode || 'IDR'} ${s.minAmount.toLocaleString('id-ID')}-${s.maxAmount.toLocaleString('id-ID')}`
      : '';
    return {
      portal: 'glints',
      title: job.title || '',
      company: job.company?.name || '',
      location: job.location?.name || '',
      date: job.createdAt ? job.createdAt.slice(0, 10) : '',
      url: `https://glints.com/id/opportunities/jobs/${slugify(job.title)}/${job.id}`,
      description: '',
      work_type: job.type === 'INTERNSHIP' ? 'Internship' : (job.type || ''),
      salary: salaryText,
    };
  });
}

// Glints stores the full description as a Draft.js-style JSON string
// ({"blocks":[{"text": "..."}, ...]}) rather than HTML, so this joins the
// blocks' text instead of stripping tags like the other two portals' detail
// fetchers do.
async function fetchGlintsDetail(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      redirect: 'follow',
    });
    const html = await res.text();
    if (!res.ok) return null;
    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) return null;
    const data = JSON.parse(m[1]);
    const descJsonStr = data?.props?.pageProps?.initialData?.data?.descriptionJsonString;
    if (!descJsonStr) return null;
    const descJson = JSON.parse(descJsonStr);
    return (descJson.blocks || []).map((b) => b.text || '').join('\n') || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// LinkedIn feed-post search - optional, only runs when LINKEDIN_LI_AT_COOKIE
// is set in .env (via the dashboard's "LinkedIn feed login" setup). Separate
// from the LinkedIn Jobs search above: this covers magang/internship
// openings shared as ordinary feed posts rather than formal job postings,
// which the public jobs-guest API never sees at all.
//
// Uses your own already-logged-in session cookie - automated access like
// this is against LinkedIn's Terms of Service and carries real account
// risk, which the dashboard's cookie-setup modal states before you ever
// enter a cookie. Kept deliberately conservative: hard caps on total
// requests per run, a real delay between every single one, and an
// immediate full stop the moment a response looks like a login/checkpoint
// wall (a sign the cookie may be flagged or expired) rather than
// continuing to hammer it.
//
// LinkedIn's post pages are a "Server-Driven UI" JSON tree embedded as
// HTML-entity-escaped JSON, not a simple data payload like Jobs/JobStreet/
// Glints - confirmed by fetching real pages directly before writing this.
// Caption text only extracts reliably for some post types (plain original
// posts); reshared "share" posts nest their content differently and this
// can come back empty for those - checked against two real posts of each
// kind while building this. The post still gets found and linked either
// way, just without an extracted description to run eligibility/
// requirements/deadline against when extraction comes up empty.
// ---------------------------------------------------------------------------
const FEED_MAX_DETAIL_PER_RUN = 15;
const FEED_MAX_SEARCHES_PER_RUN = 15;
const FEED_LOGIN_WALL_PATTERN = /authwall|challengesV2|checkpoint\/challenge|Sign in to LinkedIn to continue|session_redirect/i;
const FEED_BOILERPLATE_TEXT = new Set([
  'Settings & Privacy', 'Help', 'Language', 'Posts & Activity', 'Job Posting Account',
  'Hire on LinkedIn', 'Sell with LinkedIn', 'Post a job for free', 'Advertise on LinkedIn',
  'Elevate your small business', 'Learn with LinkedIn', 'Admin Center', 'My Apps',
]);

function decodeHtmlEntitiesLoose(str) {
  return str
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// A real authenticated page here is always well over a megabyte - a much
// smaller response is itself a signal something's wrong, on top of the
// explicit login/checkpoint text patterns.
function isLinkedinLoginWall(html) {
  return FEED_LOGIN_WALL_PATTERN.test(html) || html.length < 20000;
}

async function fetchLinkedinFeedSearch(query, cookie) {
  const url = `https://www.linkedin.com/search/results/content/?keywords=${encodeURIComponent(query)}&origin=GLOBAL_SEARCH_HEADER`;
  let html;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
        Cookie: `li_at=${cookie}`,
      },
    });
    html = await res.text();
  } catch (err) {
    ui.fail(`linkedin-feed "${query}": ${String(err.message || err).split('\n')[0]}`);
    return { urls: [], blocked: false };
  }
  if (isLinkedinLoginWall(html)) return { urls: [], blocked: true };

  const normalized = html.split('\\/').join('/');
  const matches = normalized.match(/https:\/\/www\.linkedin\.com\/posts\/[^"\\]+/g) || [];
  const urls = [...new Set(matches.map((u) => u.replace(/[?&]utm_.*$/, '').replace(/\\+$/, '')))];
  return { urls, blocked: false };
}

async function fetchLinkedinPostDetail(url, cookie) {
  let html;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        Cookie: `li_at=${cookie}`,
      },
      redirect: 'follow',
    });
    html = await res.text();
  } catch {
    return { text: '', blocked: false };
  }
  if (isLinkedinLoginWall(html)) return { text: '', blocked: true };

  const re = /&quot;text&quot;:&quot;((?:[^&]|&(?!quot;))*?)&quot;,&quot;attributesV2&quot;:\[\],&quot;accessibilityTextAttributesV2&quot;:\[\],&quot;accessibilityText&quot;:null,&quot;\$recipeTypes&quot;:\[[^\]]*\],&quot;\$type&quot;:&quot;com\.linkedin\.voyager\.dash\.common\.text\.TextViewModel&quot;/g;
  const matches = [...html.matchAll(re)]
    .map((m) => decodeHtmlEntitiesLoose(m[1]))
    .filter((t) => t && !FEED_BOILERPLATE_TEXT.has(t) && !/^Reactivate Premium/i.test(t));
  const text = matches.length ? matches[matches.length - 1] : '';
  return { text, blocked: false };
}

// Turns a post URL's slug into a readable fallback title when the caption
// couldn't be extracted, e.g. ".../posts/calling-for-all-fresh-graduate..."
// -> "Calling for all fresh graduate".
function titleFromPostSlug(url) {
  const m = url.match(/\/posts\/([^/?]+)/);
  if (!m) return 'LinkedIn post';
  const slug = m[1].replace(/^[a-z0-9-]+_/i, '').replace(/-(activity|ugcPost|share)-\d+.*$/i, '');
  const words = slug.split('-').filter(Boolean);
  if (!words.length) return 'LinkedIn post';
  return (words[0][0].toUpperCase() + words[0].slice(1) + ' ' + words.slice(1).join(' ')).trim();
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

// Strips common Indonesian legal-entity prefixes/suffixes so "PT. Astra
// International Tbk" and "Astra International" are recognized as the same
// company - the single biggest real-world source of missed already-applied
// matches, since postings and the tracker rarely spell a company name the
// same way twice. The normalized text is only used as the search needle;
// the tracker's raw lines are searched as-is, so a normalized needle like
// "astra international" still matches inside the untouched raw line.
function normalizeCompanyText(text) {
  return (text || '')
    .toLowerCase()
    .replace(/^(pt|cv|ud|pd|cs|pd)\.?\s*/i, '')
    .replace(/\s*\b(tbk|persero)\b\.?\s*$/i, '')
    .replace(/[.,()]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function alreadyApplied(trackerLines, company, title) {
  if (!trackerLines.length) return false;
  const c = normalizeCompanyText(company);
  const t = (title || '').toLowerCase().trim();
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

// ---------------------------------------------------------------------------
// Eligibility classification - is this posting actually open to an active
// student (magang/internship), or does it require an already-completed
// degree? Keyword-based on purpose: a real postingan's wording varies too
// much for anything fancier to be worth the false-confidence risk. Flags
// "unclear" rather than guessing when a posting mixes both kinds of signal
// (e.g. "magang atau fresh graduate") - better to leave that for the user to
// read than to silently pick a side.
// ---------------------------------------------------------------------------
const STUDENT_OK_PATTERNS = [
  /mahasiswa aktif/i, /mahasiswa tingkat akhir/i, /masih (ber)?kuliah/i, /semester akhir/i,
  /minimal semester \d/i, /on-?going student/i, /final year student/i, /currently (enrolled|studying)/i,
  /sedang menempuh pendidikan/i, /\bmagang\b/i, /\binternship\b/i, /kerja praktek/i, /\bKP\b/,
  /\bPKL\b/, /program magang/i,
];
const GRADUATE_REQUIRED_PATTERNS = [
  /fresh graduate/i, /lulusan (baru|S1|D3|D4)\b/i, /sudah lulus/i, /min(imal)? (sudah )?lulus/i,
  /pengalaman (kerja )?(min(imal)?\s*)?\d+\s*tahun/i, /\d+\+?\s*years?\s*(of\s*)?experience/i,
  /full[- ]?time (position|employee|staff)\b/i, /karyawan tetap/i, /\bnon-?internship\b/i,
];

function classifyEligibility(text) {
  if (!text) return '';
  const studentHit = STUDENT_OK_PATTERNS.some((p) => p.test(text));
  const gradHit = GRADUATE_REQUIRED_PATTERNS.some((p) => p.test(text));
  if (studentHit && gradHit) return 'unclear';
  if (studentHit) return 'student_ok';
  if (gradHit) return 'graduate_required';
  return '';
}

// Pulls the "Requirements"/"Qualifications"/"Persyaratan"/"Kualifikasi"
// section out of a full description, so the dashboard can show just the
// relevant bit instead of the whole posting text.
//
// Headers frequently run straight into the following content with no line
// break once HTML gets flattened to text (e.g. "Minimum Qualifications
// Currently pursuing a degree..." - no colon, no newline), so this can't
// just anchor to its own line. Instead it scans every occurrence of the
// header word (case-insensitively - postings vary) and, for each, checks
// with a plain character comparison (deliberately NOT case-insensitive)
// whether what follows starts a new sentence: an actual capital letter or a
// newline. That's true right after a real header, but not after
// "requirements" used as an ordinary word mid-sentence ("...meet project
// requirements. Participate in...", where "." follows, not a capital).
const REQUIREMENTS_HEADER = /\b(?:requirements?|qualifications?|persyaratan|kualifikasi)\b(?:\s+(?:and|dan)\s+\w+)?\s*:?\s*/gi;

function extractRequirements(text) {
  if (!text) return '';
  const re = new RegExp(REQUIREMENTS_HEADER.source, 'gi');
  let m;
  while ((m = re.exec(text)) !== null) {
    const start = m.index + m[0].length;
    const nextChar = text[start];
    if (nextChar === '\n' || (nextChar >= 'A' && nextChar <= 'Z')) {
      const rest = text.slice(start);
      const stop = rest.search(/\n\s*\n/);
      return (stop === -1 ? rest : rest.slice(0, stop)).trim().slice(0, 600);
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// Deadline extraction - pure date-pattern matching, no AI involved. Looks
// for a deadline-ish keyword (English or Indonesian) and grabs the nearest
// date-shaped text after it. Best-effort: postings phrase this too many
// ways for perfect recall, and this only tries to PARSE a small set of
// common formats into ISO (so the dashboard can flag "closing soon"/
// "closed") - if parsing fails, the raw matched text is kept so it's still
// readable even when the date math isn't available.
// ---------------------------------------------------------------------------
const MONTH_NAMES = {
  january: 0, januari: 0, jan: 0, february: 1, februari: 1, feb: 1,
  march: 2, maret: 2, mar: 2, april: 3, apr: 3,
  may: 4, mei: 4, june: 5, juni: 5, jun: 5, july: 6, juli: 6, jul: 6,
  august: 7, agustus: 7, aug: 7,
  september: 8, sept: 8, sep: 8, october: 9, oktober: 9, oct: 9,
  november: 10, nov: 10, december: 11, desember: 11, dec: 11,
};
const DEADLINE_KEYWORD = /(?:deadline|batas\s*(?:waktu\s*)?(?:pendaftaran|lamaran|akhir)?|closing\s*date|apply\s*(?:by|before)|daftar\s*(?:paling\s*lambat|sebelum|maksimal)|pendaftaran\s*(?:ditutup|paling\s*lambat|berakhir)|berakhir(?:\s*pada)?|expir(?:es|ed|y)(?:\s*(?:on|date))?)/gi;
const DATE_SHAPE = /(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})|(\d{4})-(\d{2})-(\d{2})|(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/;

function dateMatchToIso(dm) {
  try {
    if (dm[1] && dm[2] && dm[3]) {
      const month = MONTH_NAMES[dm[2].toLowerCase()];
      if (month == null) return '';
      return new Date(Date.UTC(parseInt(dm[3], 10), month, parseInt(dm[1], 10))).toISOString().slice(0, 10);
    }
    if (dm[4] && dm[5] && dm[6]) return `${dm[4]}-${dm[5]}-${dm[6]}`;
    if (dm[7] && dm[8] && dm[9]) {
      const year = dm[9].length === 2 ? `20${dm[9]}` : dm[9];
      return `${year}-${dm[8].padStart(2, '0')}-${dm[7].padStart(2, '0')}`; // dd/mm/yyyy (ID convention)
    }
  } catch { /* fall through to '' below */ }
  return '';
}

function extractDeadline(text) {
  if (!text) return { raw: '', iso: '' };
  const re = new RegExp(DEADLINE_KEYWORD.source, 'gi');
  let m;
  while ((m = re.exec(text)) !== null) {
    const windowText = text.slice(m.index, m.index + 100);
    const dm = windowText.match(DATE_SHAPE);
    if (dm) return { raw: dm[0], iso: dateMatchToIso(dm) };
  }
  return { raw: '', iso: '' };
}

// ---------------------------------------------------------------------------
// Offline fit score - keyword overlap between the posting text and your
// profile's skill/domain list (job_scraper/scraper_config.json's
// profileSkills, editable via Search settings). This is NOT the same as
// Claude actually reading and judging a posting (that's what /rank does) -
// it's a cheap, fully offline proxy: more of your skills mentioned = more
// likely worth a closer look. Capped at MATCH_CAP matches for a 100 score
// so a handful of real hits already reads as a strong signal, rather than
// requiring an unrealistic number of exact keyword hits.
// ---------------------------------------------------------------------------
const FIT_MATCH_CAP = 8;

function computeFitScore(text) {
  if (!text || !PROFILE_SKILLS.length) return null;
  const lower = text.toLowerCase();
  let hits = 0;
  for (const skill of PROFILE_SKILLS) {
    if (skill && lower.includes(skill.toLowerCase())) hits++;
  }
  return Math.min(100, Math.round((hits / FIT_MATCH_CAP) * 100));
}

// ---------------------------------------------------------------------------
// How to apply - scans the full posting text itself for a Google Form link,
// another external URL, or an email address mentioned near an apply-ish
// word. Works the same for both portals and needs no login, unlike relying
// on LinkedIn's own applyUrl: LinkedIn's public guest pages never expose the
// real apply destination (the "Lamar"/"Apply" button just opens a sign-up/
// login wall for a logged-out visitor - checked directly, it's always a
// sign-up-modal trigger, not a real link, so that field would be null 100%
// of the time and isn't worth reading). Falls back to "via the portal
// itself" when nothing else is mentioned in the text.
// ---------------------------------------------------------------------------
const GOOGLE_FORM_PATTERN = /\b(?:docs\.google\.com\/forms\/[^\s)"'<>]+|forms\.gle\/[^\s)"'<>]+)/i;
const GENERIC_URL_PATTERN = /\bhttps?:\/\/[^\s)"'<>]+/gi;
const EMAIL_NEAR_APPLY = /(?:kirim|send|apply|lamar|cv|resume|daftar)[^.\n]{0,60}?([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/i;

const PORTAL_FALLBACK_METHOD = {
  jobstreet: 'Via JobStreet (klik Open)',
  glints: 'Via Glints (klik Open)',
  magenta: 'Via MAGENTA (klik Open, perlu akun)',
  maganghub: 'Via MagangHub (klik Open, perlu akun SIAPkerja)',
  linkedin: 'Via LinkedIn (klik Open, perlu login)',
};

function detectApplyMethod(text, portal) {
  const fallback = PORTAL_FALLBACK_METHOD[portal] || 'Via portal (klik Open)';
  if (!text) return fallback;
  const form = text.match(GOOGLE_FORM_PATTERN);
  if (form) return `Google Form: ${form[0]}`;
  const urls = text.match(GENERIC_URL_PATTERN) || [];
  const external = urls.find((u) => !/linkedin\.com|jobstreet\.com|glints\.com|magentaku\.id|kemnaker\.go\.id/i.test(u));
  if (external) return `Link lain di postingan: ${external}`;
  const email = text.match(EMAIL_NEAR_APPLY);
  if (email) return `Kirim CV via email: ${email[1]}`;
  return fallback;
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
    ui.note(`Format kolom CSV berubah - data lama dipindah ke ${path.basename(backupPath)}, mulai file baru.`);
    writeFileSync(LOG_PATH, CSV_HEADER, 'utf-8');
  }
}

function appendRow(job) {
  const row = [
    new Date().toISOString().slice(0, 10),
    job.portal,
    job.source_type || 'job_listing',
    job.keyword_group || '',
    job.title,
    job.company,
    job.location,
    locationTier(job.location),
    employmentTypeHint(job),
    job.salary || '',
    job.date,
    job.description || '',
    job.requirements || '',
    job.eligibility || '',
    job.deadline || '',
    job.deadline_iso || '',
    job.fit_score == null ? '' : job.fit_score,
    job.apply_method || '',
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

// ---------------------------------------------------------------------------
// Relevance filter. Broad portals (MAGENTA lists everything, MagangHub answers a keyword with
// loose matches like "Fisioterapi" for "electrical") get a second check; every portal honours
// the user's exclusion words. Tokens come from the active keywords, the profile skills, and
// the user's study programs (MagangHub lists the study programs each posting accepts).
// ---------------------------------------------------------------------------
const RELEVANCE_STOP = new Set(['intern', 'internship', 'magang', 'fresh', 'graduate', 'junior', 'senior', 'entry', 'level', 'staff', 'trainee', 'and', 'dan', 'the', 'for', 'untuk', 'program', 'officer', 'assistant', 'specialist', 'engineer', 'engineering', 'manager', 'with', 'dengan', 'of', 'di']);
function relevanceTokens(keywords, skills) {
  const out = new Set();
  [...(keywords || []), ...(skills || [])].forEach((k) => String(k).toLowerCase().split(/[^a-z0-9+#.]+/).forEach((t) => { if (t.length >= 3 && !RELEVANCE_STOP.has(t)) out.add(t); }));
  return [...out];
}
function makeRelevanceFilter(cfg, entries) {
  const tokens = relevanceTokens(entries.map((e) => e.keyword || e.q), cfg.profileSkills);
  const majors = (cfg.majors || []).map((m) => String(m).toLowerCase().trim()).filter(Boolean);
  const exclude = (cfg.excludeKeywords || []).map((m) => String(m).toLowerCase().trim()).filter(Boolean);
  const broad = new Set(['magenta', 'maganghub']);
  return function keep(job) {
    const head = ((job.title || '') + ' ' + (job.company || '')).toLowerCase();
    if (exclude.some((x) => head.includes(x))) return { ok: false, why: 'kata dikecualikan' };
    if (cfg.broadPortalFilter === false || !broad.has(job.portal)) return { ok: true };
    const text = (head + ' ' + String(job.description || '').slice(0, 1500)).toLowerCase();
    if (majors.some((m) => text.includes(m))) return { ok: true };
    if (!tokens.length && !majors.length) return { ok: true };
    const words = new Set(text.split(/[^a-z0-9+#.]+/));
    return tokens.some((t) => words.has(t) || (t.length >= 5 && text.includes(t))) ? { ok: true } : { ok: false, why: 'tidak relevan' };
  };
}

// Live progress feedback so the process is visible while it runs, not just a
// silent pause followed by a final total at the end.
function logQueryProgress(total, newCount) {
  ui.result(total, newCount);
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
    ui.note(`WhatsApp: DRY-RUN - akan kirim ke ${target} tapi TIDAK beneran dikirim (WA_DRY_RUN=true di .env).`);
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
      ui.warn(`WhatsApp: gagal kirim ke ${target} (HTTP ${res.status}) - cek server WA-nya nyala apa enggak. (dicatat di job_scraper/whatsapp_log.csv)`);
      logWhatsAppAttempt({ status: 'failed', target, jobCount, httpStatus: res.status, error: `HTTP ${res.status}`, message: text });
      return false;
    }
    ui.note(`WhatsApp: notifikasi terkirim ke ${target} (dicatat di job_scraper/whatsapp_log.csv).`);
    logWhatsAppAttempt({ status: 'sent', target, jobCount, httpStatus: res.status, error: '', message: text });
    return true;
  } catch (err) {
    const errMsg = String(err.message || err).split('\n')[0];
    ui.warn(`WhatsApp: gagal kirim ke ${target}: ${errMsg} - server WA-nya (${WA_BASE_URL}) kemungkinan belum nyala. (dicatat di job_scraper/whatsapp_log.csv)`);
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
  ui.note(`WhatsApp: ngirim ${groups.size} pesan (1 per kata kunci, isinya lengkap semua)...`);
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
  ui.banner([
    'JobSearch - pencarian lowongan dimulai',
    new Date().toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' }) +
      ` - ${KEYWORD_ENTRIES.length} keyword` + (RUN_GROUP ? ` - grup "${RUN_GROUP}"` : ''),
    'Portal: LinkedIn, JobStreet, Glints' + (CONFIG.maganghubEnabled !== false ? ', MagangHub' : '') + (CONFIG.magentaEnabled !== false ? ', MAGENTA' : ''),
  ]);
  if (!KEYWORD_ENTRIES.length) ui.warn('Belum ada keyword aktif. Tambahkan lewat Pengaturan di dashboard atau job_scraper/scraper_config.json.');
  const seen = loadSeen();
  const trackerLines = loadTrackerLines();
  ensureLogHeader();

  const collected = [];

  // All portals search at the same time (each keeps its own polite pacing); inside a portal, keywords run 2 at a time.
  // Sequential searching was the reason a 30-keyword run took minutes.
  async function pool(items, n, fn) {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        try { await fn(items[i], i); } catch (e) { ui.fail(String((e && e.message) || e).split('\n')[0]); }
      }
    }));
  }
  const portalTasks = [];

  portalTasks.push(() => pool(KEYWORD_ENTRIES, 2, async ({ keyword: q, group }) => {
    let total = 0, newish = 0;
    for (let page = 1; page <= LINKEDIN_MAX_PAGES; page++) {
      const data = await runCli(LINKEDIN_CLI, ['-q', q, '-l', 'Indonesia', '--jobage', '14', '--limit', '20', '--page', String(page)], `linkedin "${q}" p${page}`);
      for (const job of data.results || []) {
        if (!job.url) continue;
        collected.push({ portal: 'linkedin', keyword: q, keyword_group: group, title: job.title, company: job.company, location: job.location, date: job.date, url: job.url, description: '' });
        total++;
        if (!seen[job.url]) newish++;
      }
    }
    ui.line('LinkedIn', group, q, total, newish);
  }));

  portalTasks.push(async () => {
    let consecutiveBlocks = 0, gaveUp = false;
    await pool(KEYWORD_ENTRIES, 1, async ({ keyword: q, group }) => {
      let total = 0, newish = 0;
      for (let page = 1; page <= JOBSTREET_MAX_PAGES && !gaveUp; page++) {
        const { jobs, blocked } = await fetchJobStreetPage(q, page);
        jobs.forEach((j) => { j.keyword = q; j.keyword_group = group; });
        collected.push(...jobs);
        total += jobs.length; newish += jobs.filter((j) => !seen[j.url]).length;
        if (blocked && ++consecutiveBlocks >= 2) {
          ui.warn('JobStreet: kena verifikasi Cloudflare 2x berturut-turut, dilewati untuk run ini (LinkedIn dll tetap jalan). Coba lagi beberapa jam lagi.');
          gaveUp = true;
        } else if (!blocked) consecutiveBlocks = 0;
        await sleep(200 + Math.floor(Math.random() * 200));
      }
      if (!gaveUp) ui.line('JobStreet', group, q, total, newish);
    });
  });

  portalTasks.push(() => pool(KEYWORD_ENTRIES, 2, async ({ keyword: q, group }) => {
    if (glintsBlockedCount >= 2) return; // Glints answered 403/429 twice already - stop hammering it
    const jobs = await fetchGlintsPage(q);
    jobs.forEach((j) => { j.keyword = q; j.keyword_group = group; });
    collected.push(...jobs);
    ui.line('Glints', group, q, jobs.length, jobs.filter((j) => !seen[j.url]).length);
  }));

  if (CONFIG.maganghubEnabled !== false) {
    portalTasks.push(() => pool(KEYWORD_ENTRIES, 2, async ({ keyword: q, group }) => {
      const jobs = [];
      for (let p = 1; p <= Math.min(CONFIG.maganghubMaxPages || 1, 3); p++) {
        const got = await fetchMagangHubPage(q, p);
        jobs.push(...got);
        if (got.length < 18) break;
      }
      jobs.forEach((j) => { j.keyword = q; j.keyword_group = group; });
      collected.push(...jobs);
      ui.line('MagangHub', group, q, jobs.length, jobs.filter((j) => !seen[j.url]).length);
    }));
  }

  if (CONFIG.magentaEnabled !== false && KEYWORD_ENTRIES.length) {
    portalTasks.push(async () => {
      const mg = KEYWORD_ENTRIES[0].group;
      const jobs = await fetchMagentaJobs();
      jobs.forEach((j) => { j.keyword = 'MAGENTA'; j.keyword_group = mg; });
      collected.push(...jobs);
      ui.line('MAGENTA (BUMN)', mg, 'semua lowongan', jobs.length, jobs.filter((j) => !seen[j.url]).length);
    });
  }
  ui.head(`Mencari di ${portalTasks.length} portal sekaligus...`);
  await Promise.all(portalTasks.map((t) => t()));

  const feedCookie = process.env.LINKEDIN_LI_AT_COOKIE;
  if (feedCookie) {
    ui.note('LinkedIn feed aktif (memakai sesi login kamu sendiri - di luar ToS LinkedIn, risiko ada di kamu).');
    let feedSearchCount = 0;
    let feedDetailCount = 0;
    let feedBlocked = false;
    for (const { keyword: q, group } of KEYWORD_ENTRIES) {
      if (feedBlocked || feedSearchCount >= FEED_MAX_SEARCHES_PER_RUN || feedDetailCount >= FEED_MAX_DETAIL_PER_RUN) break;
      feedSearchCount++;
      ui.query('LinkedIn feed', group, q);
      const { urls, blocked } = await fetchLinkedinFeedSearch(q, feedCookie);
      if (blocked) {
        ui.warn('LinkedIn feed: Kena halaman login/checkpoint - berhenti total buat run ini. Cek akun LinkedIn kamu, cookie mungkin udah gak valid/expired.');
        feedBlocked = true;
        break;
      }
      await sleep(1500 + Math.floor(Math.random() * 1000));
      let newish = 0;
      for (const url of urls) {
        if (feedDetailCount >= FEED_MAX_DETAIL_PER_RUN) break;
        if (seen[url]) continue; // don't spend a detail-fetch (and more account risk) on something already logged
        const { text, blocked: detailBlocked } = await fetchLinkedinPostDetail(url, feedCookie);
        if (detailBlocked) {
          ui.warn('LinkedIn feed: Kena halaman login/checkpoint - berhenti total buat run ini.');
          feedBlocked = true;
          break;
        }
        feedDetailCount++;
        newish++;
        collected.push({
          portal: 'linkedin', keyword: q, keyword_group: group, source_type: 'feed_post',
          title: text ? text.slice(0, 80) : titleFromPostSlug(url),
          company: '', location: '', date: '', url, description: text,
        });
        await sleep(1500 + Math.floor(Math.random() * 1000));
      }
      logQueryProgress(urls.length, newish);
    }
  }

  // Dedup against this script's own memory + skip anything already applied to.
  const keepRelevant = makeRelevanceFilter(CONFIG, KEYWORD_ENTRIES);
  let filteredOut = 0;
  const fresh = collected.filter((job) => {
    if (!job.url || seen[job.url]) return false;
    if (alreadyApplied(trackerLines, job.company, job.title)) return false;
    if (!keepRelevant(job).ok) { filteredOut++; seen[job.url] = { title: job.title, company: job.company, first_seen: new Date().toISOString().slice(0, 10) }; return false; }
    return true;
  });
  if (filteredOut) ui.note(`${filteredOut} lowongan disaring (tidak relevan atau mengandung kata yang kamu kecualikan).`);

  // Dedup within this run too (same job can surface from overlapping keywords).
  const dedupedThisRun = [];
  const seenThisRun = new Set();
  for (const job of fresh) {
    if (seenThisRun.has(job.url)) continue;
    seenThisRun.add(job.url);
    dedupedThisRun.push(job);
  }

  // Only new postings get their detail page opened - re-fetching detail for
  // postings already in the log on every run would multiply request volume
  // for no benefit (their description/requirements never change after the
  // fact anyway).
  if (dedupedThisRun.length) {
    ui.head(`Membaca detail ${dedupedThisRun.length} lowongan baru (syarat, deadline, kelayakan)...`);
  }
  let detailDone = 0;
  await pool(dedupedThisRun, 5, async (job) => {
    if (!job.source_type) job.source_type = 'job_listing';
    let fullText = job.description || '';
    if (job.source_type === 'feed_post') {
      // Already fully fetched (search + detail combined in one pass, above -
      // a feed post's URL only exists once its detail page has already been
      // read, unlike the other portals where search and detail are separate
      // steps). Nothing more to do here.
    } else if (job.portal === 'linkedin') {
      const detail = await runCliDetail(LINKEDIN_CLI, job.url, `${job.company} - ${job.title}`);
      if (detail && detail.description) fullText = detail.description;
      await sleep(100 + Math.floor(Math.random() * 150));
    } else if (job.portal === 'jobstreet') {
      const full = await fetchJobStreetDetail(job.url);
      if (full) fullText = full;
      await sleep(100 + Math.floor(Math.random() * 150));
    } else if (job.portal === 'glints') {
      const full = await fetchGlintsDetail(job.url);
      if (full) fullText = full;
      await sleep(100 + Math.floor(Math.random() * 150));
    } else if (job.portal === 'magenta') {
      const full = await fetchMagentaDetail(job);
      if (full) fullText = full;
    }
    job.description = fullText;
    job.requirements = extractRequirements(fullText);
    job.eligibility = classifyEligibility(`${job.title} ${fullText}`);
    const deadline = extractDeadline(fullText);
    job.deadline = deadline.raw;
    job.deadline_iso = deadline.iso;
    job.fit_score = computeFitScore(`${job.title} ${fullText}`);
    job.apply_method = detectApplyMethod(fullText, job.portal);
    const elig = job.eligibility === 'student_ok' ? 'mahasiswa OK'
      : job.eligibility === 'graduate_required' ? 'perlu lulusan'
      : job.eligibility === 'unclear' ? 'sinyal campuran' : '';
    const bits = [elig, job.fit_score == null ? '' : `cocok ${job.fit_score}`, job.deadline ? `deadline ${job.deadline}` : ''].filter(Boolean);
    console.log(paint(2, `  [${++detailDone}/${dedupedThisRun.length}] `) + `${job.title} - ${job.company}` + (bits.length ? paint(2, `  (${bits.join(' - ')})`) : ''));
  });

  const consolidated = consolidateMassPostings(dedupedThisRun);

  for (const job of consolidated) {
    appendRow(job);
  }
  for (const job of dedupedThisRun) {
    seen[job.url] = { title: job.title, company: job.company, first_seen: new Date().toISOString().slice(0, 10) };
  }
  saveSeen(seen);

  const perPortal = {};
  consolidated.forEach((j) => { perPortal[j.portal] = (perPortal[j.portal] || 0) + 1; });
  console.log('');
  ui.banner([
    `Selesai dalam ${ui.duration()}`,
    consolidated.length ? `${consolidated.length} lowongan baru disimpan ke ${path.relative(ROOT, LOG_PATH).replace(/\\/g, '/')}` : 'Belum ada lowongan baru kali ini.',
    ...(consolidated.length ? [Object.entries(perPortal).map(([p, n]) => `${p} ${n}`).join(' - ')] : []),
  ]);
  if (trackerLines.length) {
    ui.note(`${trackerLines.length} lamaran di job_search_tracker.csv dipakai untuk menyaring yang sudah pernah kamu lamar.`);
  }
  if (consolidated.length > 0) {
    ui.head('Lowongan baru (yang paling cocok di atas):');
    const SHOW_MAX = 15;
    const ranked = [...consolidated].sort((x, y) => (Number(y.fit_score) || 0) - (Number(x.fit_score) || 0));
    ranked.slice(0, SHOW_MAX).forEach((job, i) => {
      console.log(`  ${String(i + 1).padStart(2)}. ${job.title} - ${job.company}` + paint(2, `  (${job.location || '-'}, ${job.portal}${job.fit_score ? ', cocok ' + job.fit_score : ''})`));
    });
    if (consolidated.length > SHOW_MAX) {
      console.log(paint(2, `  ... dan ${consolidated.length - SHOW_MAX} lainnya. Daftar lengkap ada di job_scraper/offline_jobs_log.csv atau dashboard.`));
    }
  } else {
    ui.note('Tips: tambah keyword, atau jalankan lagi nanti - lowongan baru muncul terus.');
  }
  await notifyWhatsApp(consolidated);
  beepIfNew(consolidated.length);
}

main().catch((err) => {
  ui.fail('Terjadi error tak terduga: ' + String((err && err.message) || err));
  if (process.env.DEBUG) console.error(err);
  else ui.note('Jalankan ulang dengan DEBUG=1 untuk melihat detail teknis, lalu kirim log-nya kalau butuh bantuan.');
  process.exit(1);
});
