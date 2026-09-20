// Browser/WebView port of tools/offline_scraper.mjs + the LinkedIn jobs-guest CLI, for the
// standalone Android app (no PC server). Kept as a plain script (window.ScraperLib, and
// module.exports for Node) so the same file can be unit-tested in Node and shipped to the
// WebView. Network calls use global fetch(): inside the app, Capacitor's native HTTP plugin
// (plugins.CapacitorHttp.enabled) patches it, which is what lets these calls bypass CORS and
// set a real User-Agent. Deliberately NOT ported: LinkedIn feed-post search (needs a login
// cookie) and WhatsApp notifications (needs the Docker gateway on a PC).
(function (root) {
  'use strict';

  const UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const jitter = (base, spread) => base + Math.floor(Math.random() * spread);

  // ---------------------------------------------------------------- text helpers
  function decodeEntities(str) {
    return String(str || '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, (_, d) => { const c = parseInt(d, 10); return c >= 0 && c <= 0x10ffff ? String.fromCodePoint(c) : ''; })
      .replace(/&#[xX]([0-9a-fA-F]+);/g, (_, h) => { const c = parseInt(h, 16); return c >= 0 && c <= 0x10ffff ? String.fromCodePoint(c) : ''; })
      .replace(/&nbsp;/g, ' ');
  }
  const stripTags = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const clean = (html) => decodeEntities(stripTags(html));
  function htmlToText(html) {
    const withBreaks = html.replace(/<\s*br\s*\/?>/gi, '\n').replace(/<\/(p|li|ul|ol|div|h[1-6])>/gi, '\n');
    return decodeEntities(withBreaks.replace(/<[^>]+>/g, ' ')).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  }
  function extractDivBy(html, attrRe) {
    const open = new RegExp('<div[^>]*' + attrRe + '[^>]*>', 'i').exec(html);
    if (!open) return null;
    let i = open.index + open[0].length, depth = 1;
    while (depth > 0 && i < html.length) {
      const o = html.indexOf('<div', i), c = html.indexOf('</div>', i);
      if (c === -1) return null;
      if (o !== -1 && o < c) { depth++; i = o + 4; } else { depth--; i = c + 6; }
    }
    return html.slice(open.index + open[0].length, i - 6);
  }

  // ---------------------------------------------------------------- LinkedIn (public guest API)
  const LI_SEARCH = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search';
  const LI_DETAIL = 'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting';

  async function htmlFetch(url, headers) {
    let delay = 500;
    for (let attempt = 0; attempt <= 4; attempt++) {
      const res = await fetch(url, { headers: Object.assign({ 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'Accept-Language': 'id-ID,id;q=0.9,en;q=0.8' }, headers || {}) });
      if (res.status === 429 || res.status >= 500) {
        if (attempt === 4) throw new Error('HTTP ' + res.status);
        await sleep(delay + Math.floor(Math.random() * 400)); delay = Math.min(delay * 2, 6000); continue;
      }
      if (res.status === 404) return '';
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.text();
    }
    throw new Error('max retries');
  }

  function parseJobCards(html) {
    const out = [];
    for (const chunk of html.split(/data-entity-urn="urn:li:jobPosting:/).slice(1)) {
      const idm = chunk.match(/^(\d+)/); if (!idm) continue;
      const id = idm[1];
      const link = chunk.match(/class="base-card__full-link[^"]*"[^>]*href="([^"]+)"/i);
      const url = link ? decodeEntities(link[1]).split('?')[0] : '';
      let title = null;
      const h3 = chunk.match(/class="base-search-card__title"[^>]*>([\s\S]*?)<\/h3>/i);
      if (h3) title = clean(h3[1]);
      if (!title) { const sr = chunk.match(/class="sr-only"[^>]*>([\s\S]*?)<\/span>/i); if (sr) title = clean(sr[1]); }
      if (!title) continue;
      const sub = chunk.match(/class="base-search-card__subtitle"[^>]*>([\s\S]*?)<\/h4>/i);
      const loc = chunk.match(/class="job-search-card__location"[^>]*>([\s\S]*?)<\/span>/i);
      const dt = chunk.match(/class="job-search-card__listdate[^"]*"[^>]*datetime="([^"]+)"/i);
      out.push({ id, title, company: sub ? clean(sub[1]) || null : null, location: loc ? clean(loc[1]) || null : null,
        date: dt ? dt[1] : null, url: url || 'https://www.linkedin.com/jobs/view/' + id });
    }
    return out;
  }

  async function linkedinSearch(query, page, jobageDays) {
    const p = new URLSearchParams();
    p.set('keywords', query); p.set('location', 'Indonesia');
    if (jobageDays) p.set('f_TPR', 'r' + jobageDays * 86400);
    p.set('start', String(((page || 1) - 1) * 10));
    return parseJobCards(await htmlFetch(LI_SEARCH + '?' + p.toString(), { 'X-Requested-With': 'XMLHttpRequest' }));
  }

  async function linkedinDetail(url) {
    const m = String(url).match(/-(\d{6,})(?:\?|$)/) || String(url).match(/(\d{6,})/);
    if (!m) return '';
    const html = await htmlFetch(LI_DETAIL + '/' + m[1], { 'X-Requested-With': 'XMLHttpRequest' });
    const d = extractDivBy(html, 'class="[^"]*show-more-less-html__markup[^"]*"') || extractDivBy(html, 'class="[^"]*description__text[^"]*"');
    return d ? htmlToText(d) : '';
  }

  // ---------------------------------------------------------------- JobStreet
  function extractJsonAfterMarker(html, marker) {
    const idx = html.indexOf(marker); if (idx === -1) return null;
    const start = html.indexOf('{', html.indexOf('=', idx)); if (start === -1) return null;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < html.length; i++) {
      const ch = html[i];
      if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') { inStr = true; continue; }
      if (ch === '{') depth++; else if (ch === '}') { depth--; if (depth === 0) return html.slice(start, i + 1); }
    }
    return null;
  }

  async function jobstreetSearch(query, page) {
    let html, res;
    try {
      res = await fetch('https://id.jobstreet.com/id/jobs?keywords=' + encodeURIComponent(query) + '&page=' + page, { headers: { 'User-Agent': UA, Accept: 'text/html,*/*;q=0.8', 'Accept-Language': 'id-ID,id;q=0.9' } });
      html = await res.text();
    } catch (e) { return { jobs: [], blocked: false, error: String(e.message || e) }; }
    if (!res.ok) return { jobs: [], blocked: res.headers.get('cf-mitigated') === 'challenge' || /Just a moment/i.test(html), error: 'HTTP ' + res.status };
    const raw = extractJsonAfterMarker(html, 'window.SEEK_APOLLO_DATA');
    if (!raw) return { jobs: [], blocked: false, error: 'data not found' };
    let data; try { data = JSON.parse(raw); } catch { return { jobs: [], blocked: false, error: 'bad json' }; }
    const rq = data.ROOT_QUERY || {};
    const key = Object.keys(rq).find((k) => k.startsWith('jobSearchV7'));
    const jobs = key ? (rq[key] && rq[key].results && rq[key].results.jobs) || [] : [];
    return { blocked: false, jobs: jobs.map((job) => {
      const locObj = job.location && job.location.__ref ? data[job.location.__ref] : null;
      const wt = (job.cjs && job.cjs.workTypes && job.cjs.workTypes[0]) || {};
      const s = job.salary;
      return { portal: 'jobstreet', title: job.title || '', company: (job.advertiser && job.advertiser.name) || '',
        location: (locObj && locObj.displayName && locObj.displayName.text) || '',
        date: job.listedAt && job.listedAt.dateTimeUtc ? job.listedAt.dateTimeUtc.slice(0, 10) : '',
        url: job.id ? 'https://id.jobstreet.com/id/job/' + job.id : '',
        description: String(job.abstract || '').replace(/\s+/g, ' ').trim().slice(0, 200),
        work_type: wt['name({"locale":"id-ID"})'] || wt.name || '',
        salary: s && s.min && s.max ? s.currency + ' ' + s.min.toLocaleString('id-ID') + '-' + s.max.toLocaleString('id-ID') + '/' + s.period : '' };
    }) };
  }

  async function jobstreetDetail(url) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,*/*;q=0.8', 'Accept-Language': 'id-ID,id;q=0.9' } });
      if (!res.ok) return null;
      const block = extractDivBy(await res.text(), 'data-automation="jobAdDetails"');
      return block ? htmlToText(block) : null;
    } catch { return null; }
  }

  // ---------------------------------------------------------------- Glints (page 1 only)
  const slugify = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'job';
  const NEXT_DATA_RE = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/;

  async function glintsSearch(query) {
    let html;
    try {
      const res = await fetch('https://glints.com/id/opportunities/jobs/explore?keyword=' + encodeURIComponent(query) + '&country=ID', { headers: { 'User-Agent': UA, Accept: 'text/html,*/*;q=0.8', 'Accept-Language': 'id-ID,id;q=0.9' } });
      html = await res.text();
      if (!res.ok) return { jobs: [], error: 'HTTP ' + res.status };
    } catch (e) { return { jobs: [], error: String(e.message || e) }; }
    const m = html.match(NEXT_DATA_RE); if (!m) return { jobs: [], error: 'data not found' };
    let data; try { data = JSON.parse(m[1]); } catch { return { jobs: [], error: 'bad json' }; }
    const jobs = (data.props && data.props.pageProps && data.props.pageProps.initialJobs && data.props.pageProps.initialJobs.jobsInPage) || [];
    return { jobs: jobs.filter((j) => j.id).map((job) => {
      const s = (job.salaries || [])[0];
      return { portal: 'glints', title: job.title || '', company: (job.company && job.company.name) || '', location: (job.location && job.location.name) || '',
        date: job.createdAt ? job.createdAt.slice(0, 10) : '', url: 'https://glints.com/id/opportunities/jobs/' + slugify(job.title) + '/' + job.id,
        description: '', work_type: job.type === 'INTERNSHIP' ? 'Internship' : (job.type || ''),
        salary: s && s.minAmount && s.maxAmount ? (s.CurrencyCode || 'IDR') + ' ' + s.minAmount.toLocaleString('id-ID') + '-' + s.maxAmount.toLocaleString('id-ID') : '' };
    }) };
  }

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
  
  var magentaSession = null;
  function cookiesFrom(res) {
    var raw = res.headers.get('set-cookie') || '';
    return raw.split(/,(?=\s*[A-Za-z0-9_.-]+=)/).map(function (c) { return c.split(';')[0].trim(); }).filter(Boolean).join('; ');
  }
  async function magentaOpen() {
    var res = await fetch('https://magentaku.id/lowongan', { headers: { 'User-Agent': UA, 'Accept-Language': 'id-ID,id;q=0.9' } });
    var html = await res.text();
    var token = (html.match(/csrf-token" content="([^"]*)/) || [])[1];
    if (!res.ok || !token) throw new Error('HTTP ' + res.status + (token ? '' : ' (token tidak ketemu)'));
    magentaSession = { token: token, cookies: cookiesFrom(res) };
    return magentaSession;
  }
  async function magentaPost(pathname, body) {
    var s = magentaSession || await magentaOpen();
    var headers = { 'User-Agent': UA, 'X-CSRF-TOKEN': s.token, 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' };
    if (s.cookies) headers.Cookie = s.cookies;
    var res = await fetch('https://magentaku.id' + pathname, { method: 'POST', headers: headers, body: new URLSearchParams(body).toString() });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.text();
  }
  async function magentaSearch() {
    var jobs = [], ids = {}, error = '';
    try {
      for (var page = 1; page <= 10; page++) {
        var data = JSON.parse(await magentaPost('/lowongan/list', { page: page, type: 'all' }));
        var cards = parseMagentaCards(data.jobposting).filter(function (c) { return !ids[c.id]; });
        if (!cards.length) break;
        cards.forEach(function (c) {
          ids[c.id] = 1;
          jobs.push({ portal: 'magenta', title: decodeEntities(c.title), company: decodeEntities(c.company), location: decodeEntities(c.location), date: '',
            url: 'https://magentaku.id/lowongan?posting=' + c.id + '&lokasi=' + c.kota,
            description: c.closing ? 'Batas pendaftaran: ' + c.closing + '.' : '',
            work_type: /magang/i.test(c.badges[0] || '') ? 'Internship' : (c.badges[0] || ''), salary: '', _mid: c.id, _mkota: c.kota });
        });
        await sleep(300);
      }
    } catch (e) { error = String(e.message || e); }
    return { jobs: jobs, error: error };
  }
  async function magentaDetail(job) {
    try {
      var html = await magentaPost('/lowongan/' + job._mid + '/detail', { lokasi: job._mkota, kota_id: job._mkota });
      return (job.description ? job.description + '\n' : '') + htmlToText(html);
    } catch (e) { return ''; }
  }

  // ---------------------------------------------------------------- MagangHub (Kemnaker) - vacancy list is embedded as JSON in the server-rendered page
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
    const parts = [...html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)].map((m) => { try { return JSON.parse(m[1]); } catch (e) { return ''; } });
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
      else if (c === '}' && --d === 0) { try { return resolveMagangHubRefs(JSON.parse(t.slice(s, j + 1)), t); } catch (e) { return null; } }
    }
    return null;
  }
  const MH_LEVEL = { diploma: 'D3/D4', bachelor: 'S1', profession: 'Profesi', master: 'S2' };
  async function magangHubSearch(query, page) {
    try {
      const res = await fetch('https://maganghub.kemnaker.go.id/magang-nasional/lowongan?keyword=' + encodeURIComponent(query) + '&page=' + page, { headers: { 'User-Agent': UA, 'Accept-Language': 'id-ID,id;q=0.9' } });
      if (!res.ok) return { jobs: [], error: 'HTTP ' + res.status };
      const data = extractMagangHubVacancies(await res.text());
      if (!data || !Array.isArray(data.data)) return { jobs: [], error: 'data tidak ketemu' };
      return { jobs: data.data.filter((v) => v.id).map((v) => ({
        portal: 'maganghub', title: v.positionName || '', company: (v.organizer && v.organizer.name) || '', location: (v.city && v.city.name) || '',
        date: v.publishedAt ? v.publishedAt.slice(0, 10) : '',
        url: 'https://maganghub.kemnaker.go.id/magang-nasional/lowongan/' + slugify(v.positionName) + '-' + v.id,
        description: 'Program Pemagangan Lulusan Perguruan Tinggi (MagangHub Kemnaker). Jenjang: ' + (v.educationLevels || []).map((l) => MH_LEVEL[l] || l).join(', ') + '. Program studi: ' + (v.studyPrograms || []).map((p) => p.name).join(', ') + '. Kuota: ' + (v.approvedQuantity || v.quantityNeeded || '-') + '. ' + (v.taskDescription || ''),
        work_type: 'Internship', salary: '' })) };
    } catch (e) { return { jobs: [], error: String(e.message || e) }; }
  }

  async function glintsDetail(url) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,*/*;q=0.8' } });
      if (!res.ok) return null;
      const m = (await res.text()).match(NEXT_DATA_RE); if (!m) return null;
      const str = JSON.parse(m[1]).props.pageProps.initialData.data.descriptionJsonString; if (!str) return null;
      return (JSON.parse(str).blocks || []).map((b) => b.text || '').join('\n') || null;
    } catch { return null; }
  }

  // ---------------------------------------------------------------- enrichment (pure)
  const STUDENT_OK = [/mahasiswa aktif/i, /mahasiswa tingkat akhir/i, /masih (ber)?kuliah/i, /semester akhir/i, /minimal semester \d/i, /on-?going student/i, /final year student/i, /currently (enrolled|studying)/i, /sedang menempuh pendidikan/i, /\bmagang\b/i, /\binternship\b/i, /kerja praktek/i, /\bKP\b/, /\bPKL\b/, /program magang/i];
  const GRAD_REQ = [/fresh graduate/i, /lulusan (baru|S1|D3|D4)\b/i, /sudah lulus/i, /min(imal)? (sudah )?lulus/i, /pengalaman (kerja )?(min(imal)?\s*)?\d+\s*tahun/i, /\d+\+?\s*years?\s*(of\s*)?experience/i, /full[- ]?time (position|employee|staff)\b/i, /karyawan tetap/i, /\bnon-?internship\b/i];
  function classifyEligibility(text) {
    if (!text) return '';
    const s = STUDENT_OK.some((p) => p.test(text)), g = GRAD_REQ.some((p) => p.test(text));
    return s && g ? 'unclear' : s ? 'student_ok' : g ? 'graduate_required' : '';
  }

  function extractRequirements(text) {
    if (!text) return '';
    const re = /\b(?:requirements?|qualifications?|persyaratan|kualifikasi)\b(?:\s+(?:and|dan)\s+\w+)?\s*:?\s*/gi;
    let m;
    while ((m = re.exec(text)) !== null) {
      const start = m.index + m[0].length, c = text[start];
      if (c === '\n' || (c >= 'A' && c <= 'Z')) {
        const rest = text.slice(start), stop = rest.search(/\n\s*\n/);
        return (stop === -1 ? rest : rest.slice(0, stop)).trim().slice(0, 600);
      }
    }
    return '';
  }

  const MONTHS = { january: 0, januari: 0, jan: 0, february: 1, februari: 1, feb: 1, march: 2, maret: 2, mar: 2, april: 3, apr: 3, may: 4, mei: 4, june: 5, juni: 5, jun: 5, july: 6, juli: 6, jul: 6, august: 7, agustus: 7, aug: 7, september: 8, sept: 8, sep: 8, october: 9, oktober: 9, oct: 9, november: 10, nov: 10, december: 11, desember: 11, dec: 11 };
  const DL_KEY = /(?:deadline|batas\s*(?:waktu\s*)?(?:pendaftaran|lamaran|akhir)?|closing\s*date|apply\s*(?:by|before)|daftar\s*(?:paling\s*lambat|sebelum|maksimal)|pendaftaran\s*(?:ditutup|paling\s*lambat|berakhir)|berakhir(?:\s*pada)?|expir(?:es|ed|y)(?:\s*(?:on|date))?)/gi;
  const DATE_SHAPE = /(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})|([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})|(\d{4})-(\d{2})-(\d{2})|(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/;
  function dateToIso(d) {
    try {
      if (d[1] && d[2] && d[3]) { const mo = MONTHS[d[2].toLowerCase()]; return mo == null ? '' : new Date(Date.UTC(+d[3], mo, +d[1])).toISOString().slice(0, 10); }
      if (d[4] && d[5] && d[6]) { const mo = MONTHS[d[4].toLowerCase()]; return mo == null ? '' : new Date(Date.UTC(+d[6], mo, +d[5])).toISOString().slice(0, 10); }
      if (d[7] && d[8] && d[9]) return d[7] + '-' + d[8] + '-' + d[9];
      if (d[10] && d[11] && d[12]) return (d[12].length === 2 ? '20' + d[12] : d[12]) + '-' + d[11].padStart(2, '0') + '-' + d[10].padStart(2, '0');
    } catch (e) { /* fall through */ }
    return '';
  }
  function extractDeadline(text) {
    if (!text) return { raw: '', iso: '' };
    const re = new RegExp(DL_KEY.source, 'gi'); let m;
    while ((m = re.exec(text)) !== null) {
      const dm = text.slice(m.index, m.index + 100).match(DATE_SHAPE);
      if (dm) return { raw: dm[0], iso: dateToIso(dm) };
    }
    return { raw: '', iso: '' };
  }

  function computeFitScore(text, skills) {
    if (!text || !skills || !skills.length) return null;
    const lower = text.toLowerCase(); let hits = 0;
    for (const s of skills) if (s && lower.includes(String(s).toLowerCase())) hits++;
    return Math.min(100, Math.round((hits / 8) * 100));
  }

  const FALLBACK = { jobstreet: 'Via JobStreet (klik Open)', glints: 'Via Glints (klik Open)', magenta: 'Via MAGENTA (klik Open, perlu akun)', maganghub: 'Via MagangHub (klik Open, perlu akun SIAPkerja)', linkedin: 'Via LinkedIn (klik Open, perlu login)' };
  function detectApplyMethod(text, portal) {
    const fb = FALLBACK[portal] || 'Via portal (klik Open)';
    if (!text) return fb;
    const form = text.match(/\b(?:docs\.google\.com\/forms\/[^\s)"'<>]+|forms\.gle\/[^\s)"'<>]+)/i);
    if (form) return 'Google Form: ' + form[0];
    const ext = (text.match(/\bhttps?:\/\/[^\s)"'<>]+/gi) || []).find((u) => !/linkedin\.com|jobstreet\.com|glints\.com|magentaku\.id|kemnaker\.go\.id/i.test(u));
    if (ext) return 'Link lain di postingan: ' + ext;
    const em = text.match(/(?:kirim|send|apply|lamar|cv|resume|daftar)[^.\n]{0,60}?([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/i);
    return em ? 'Kirim CV via email: ' + em[1] : fb;
  }

  function locationTier(loc, ideal, acceptable) {
    const t = String(loc || '').toLowerCase();
    if ((ideal || []).some((c) => t.includes(c))) return 'ideal (dekat Surabaya)';
    if ((acceptable || []).some((c) => t.includes(c))) return 'acceptable';
    return 'cek jarak';
  }
  const INTERN = /\b(intern|internship|magang|apprentice)\b/i;
  const employmentTypeHint = (job) => job.work_type || (INTERN.test(job.title + ' ' + (job.description || '')) ? 'Kemungkinan magang (dari judul)' : '');

  function normalizeCompany(text) {
    return String(text || '').toLowerCase().replace(/^(pt|cv|ud|pd|cs)\.?\s*/i, '').replace(/\s*\b(tbk|persero)\b\.?\s*$/i, '').replace(/[.,()]/g, '').replace(/\s+/g, ' ').trim();
  }
  function alreadyApplied(tracker, company, title) {
    const c = normalizeCompany(company), t = String(title || '').toLowerCase().trim();
    if (!c || !t) return false;
    return (tracker || []).some((r) => {
      const rc = normalizeCompany(r.company), rt = String(r.role || '').toLowerCase();
      return rc && rt && (rc.includes(c) || c.includes(rc)) && (rt.includes(t) || t.includes(rt));
    });
  }

  function consolidate(jobs) {
    const norm = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const groups = new Map();
    for (const j of jobs) { const k = String(j.company || '').toLowerCase() + '|||' + norm(j.title); (groups.get(k) || groups.set(k, []).get(k)).push(j); }
    const out = [];
    for (const g of groups.values()) {
      const locs = [...new Set(g.map((j) => j.location).filter(Boolean))];
      if (g.length === 1 || locs.length <= 1) { out.push(...g); continue; }
      const m = Object.assign({}, g[0]);
      m.title = m.title + ' (posting sama di ' + locs.length + ' kota)';
      m.location = locs.slice(0, 5).join('; ') + (locs.length > 5 ? ', ...' : '');
      out.push(m);
    }
    return out;
  }

  // ---------------------------------------------------------------- orchestration
  // opts: { config, group ('' = all enabled), seen{url:..}, tracker[], log(line), stopSignal() }
  // returns { records[] (same fields as offline_jobs_log.csv rows), seenAdditions{} }
  // Full description + everything derived from it (requirements, eligibility, deadline, fit, apply method) for one stored record.
  // Used for background enrichment right after a search, and again on demand when the user opens a record that is still pending.
  async function enrichRecord(rec, cfg) {
    let full = rec.description || '';
    try {
      if (rec.portal === 'linkedin') full = (await linkedinDetail(rec.url)) || full;
      else if (rec.portal === 'jobstreet') full = (await jobstreetDetail(rec.url)) || full;
      else if (rec.portal === 'glints') full = (await glintsDetail(rec.url)) || full;
      else if (rec.portal === 'magenta') {
        const m = /posting=(\d+)&lokasi=(\d+)/.exec(rec.url || '');
        if (m) full = (await magentaDetail({ description: rec.description, _mid: m[1], _mkota: m[2] })) || full;
      }
    } catch (e) { /* keep what we have */ }
    const dl = extractDeadline(full);
    return {
      description: full, requirements: extractRequirements(full), eligibility: classifyEligibility(rec.title + ' ' + full),
      deadline: dl.raw, deadline_iso: dl.iso, fit_score: String(computeFitScore(rec.title + ' ' + full, cfg.profileSkills) ?? ''),
      apply_method: detectApplyMethod(full, rec.portal),
    };
  }

  async function runScrape(opts) {
    const cfg = opts.config, log = opts.log || (() => {}), seen = opts.seen || {};
    const groups = (cfg.keywordGroups || []).filter((g) => (opts.group ? g.name === opts.group : g.enabled !== false));
    const entries = groups.flatMap((g) => (g.keywords || []).map((k) => ({ q: k, group: g.name })));
    if (!entries.length) { log('⚠ Belum ada keyword aktif. Ketuk "Keyword" untuk menambahkan.'); return { records: [], seenAdditions: {} }; }
    const collected = [];
    const newish = (jobs) => jobs.filter((j) => j.url && !seen[j.url]).length;
    const stopped = () => !!(opts.stopSignal && opts.stopSignal());
    const said = (jobs, err) => log('      → ' + (jobs.length ? jobs.length + ' hasil, ' + newish(jobs) + ' baru' : 'belum ada hasil') + (err ? ' (' + err + ')' : ''));
    // Small worker pool: phones are slow mostly because of network latency, so overlapping requests is the big win.
    async function pool(items, n, fn) {
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
        while (next < items.length && !stopped()) { const i = next++; try { await fn(items[i], i); } catch (e) { /* one bad item must not stop the rest */ } }
      }));
    }

    // Every portal searches at the same time; inside a portal keywords run 2 at a time (JobStreet 1: Cloudflare is touchy).
    const portalTasks = [];
    portalTasks.push(async () => {
      log('▶ LinkedIn');
      await pool(entries, 2, async ({ q, group }) => {
        for (let p = 1; p <= (cfg.linkedinMaxPages || 1); p++) {
          try {
            const cards = (await linkedinSearch(q, p, 14)).slice(0, 20);
            cards.forEach((c) => collected.push({ portal: 'linkedin', keyword_group: group, title: c.title, company: c.company, location: c.location, date: c.date, url: c.url, description: '' }));
            log('  • LinkedIn: ' + q); said(cards);
          } catch (e) { log('  ✖ LinkedIn "' + q + '": ' + (e.message || e)); }
        }
      });
    });
    portalTasks.push(async () => {
      let blocks = 0, gaveUp = false;
      log('▶ JobStreet');
      await pool(entries, 1, async ({ q, group }) => {
        for (let p = 1; p <= (cfg.jobstreetMaxPages || 1) && !gaveUp; p++) {
          const r = await jobstreetSearch(q, p);
          r.jobs.forEach((j) => { j.keyword_group = group; });
          collected.push(...r.jobs);
          if (r.blocked) { blocks++; log('  ⚠ JobStreet: diblokir Cloudflare' + (blocks >= 2 ? ', dilewati untuk pencarian ini (coba lagi nanti)' : '')); if (blocks >= 2) gaveUp = true; }
          else { blocks = 0; log('  • JobStreet: ' + q); said(r.jobs, r.error); }
          await sleep(jitter(150, 150));
        }
      });
    });
    portalTasks.push(async () => {
      log('▶ Glints');
      await pool(entries, 2, async ({ q, group }) => {
        const r = await glintsSearch(q);
        r.jobs.forEach((j) => { j.keyword_group = group; });
        collected.push(...r.jobs);
        log('  • Glints: ' + q); said(r.jobs, r.error);
      });
    });
    if (cfg.maganghubEnabled !== false) portalTasks.push(async () => {
      log('▶ MagangHub');
      await pool(entries, 2, async ({ q, group }) => {
        const acc = [];
        let err = '';
        for (let p = 1; p <= Math.min(cfg.maganghubMaxPages || 1, 3); p++) {
          const r = await magangHubSearch(q, p);
          acc.push(...r.jobs); if (r.error) err = r.error;
          if (r.jobs.length < 18) break;
        }
        acc.forEach((j) => { j.keyword_group = group; });
        collected.push(...acc);
        log('  • MagangHub: ' + q); said(acc, err);
      });
    });
    if (cfg.magentaEnabled !== false) portalTasks.push(async () => {
      log('▶ MAGENTA (BUMN)');
      const mr = await magentaSearch();
      mr.jobs.forEach((j) => { j.keyword_group = entries[0].group; });
      collected.push(...mr.jobs);
      log('  • MAGENTA: semua lowongan'); said(mr.jobs, mr.error);
    });
    log('Mencari di ' + portalTasks.length + ' portal sekaligus...');
    await Promise.all(portalTasks.map((t) => t().catch((e) => log('  ✖ ' + (e.message || e)))));

    const fresh = [], seenRun = new Set();
    for (const j of collected) {
      if (!j.url || seen[j.url] || seenRun.has(j.url) || alreadyApplied(opts.tracker, j.company, j.title)) continue;
      seenRun.add(j.url); fresh.push(j);
    }

    // 1) Build the records from what the search already gave us and hand them over immediately: the user sees results
    //    after the search (seconds), not after every detail page has been fetched (minutes on a phone).
    const today = new Date().toISOString().slice(0, 10);
    const records = consolidate(fresh).map((j) => ({
      found_date: today, portal: j.portal, source_type: 'job_listing', keyword_group: j.keyword_group || '',
      title: j.title, company: j.company, location: j.location, location_tier: locationTier(j.location, cfg.idealLocations, cfg.acceptableLocations),
      employment_type_hint: employmentTypeHint(j), salary: j.salary || '', posted_date: j.date || '', description: j.description || '',
      requirements: '', eligibility: classifyEligibility(j.title || ''), deadline: '', deadline_iso: '',
      fit_score: String(computeFitScore(j.title || '', cfg.profileSkills) ?? ''), apply_method: '', url: j.url,
      _pending: j.portal === 'maganghub' ? '' : '1',
    }));
    const seenAdditions = {};
    fresh.forEach((j) => { seenAdditions[j.url] = { title: j.title, company: j.company, first_seen: today }; });
    // MagangHub already returned the full description, so it needs no extra request
    for (const r of records) if (r.portal === 'maganghub') Object.assign(r, await enrichRecord(r, cfg));
    log('✔ Pencarian selesai: ' + records.length + ' lowongan baru' + (fresh.length ? ' (detail dilengkapi di latar belakang)' : '') + '.');
    if (opts.onProvisional) await opts.onProvisional(records, seenAdditions);

    // 2) Fill in details in the background, 6 at a time, reporting every few records so the UI can refresh.
    const pending = records.filter((r) => r._pending);
    let doneCount = 0, batch = [];
    await pool(pending, 6, async (rec) => {
      Object.assign(rec, await enrichRecord(rec, cfg));
      rec._pending = '';
      batch.push(rec); doneCount++;
      if (batch.length >= 10 || doneCount === pending.length) {
        log('  … detail ' + doneCount + '/' + pending.length);
        if (opts.onUpdate) opts.onUpdate(batch);
        batch = [];
      }
    });
    if (batch.length && opts.onUpdate) opts.onUpdate(batch);
    if (pending.length) log('✔ Semua detail sudah lengkap.');
    return { records, seenAdditions };
  }

  const api = { runScrape, enrichRecord, magangHubSearch, magentaSearch, magentaDetail, parseJobCards, linkedinSearch, linkedinDetail, jobstreetSearch, glintsSearch, classifyEligibility, extractRequirements, extractDeadline, computeFitScore, detectApplyMethod, alreadyApplied, normalizeCompany, htmlToText };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ScraperLib = api;
})(typeof window !== 'undefined' ? window : globalThis);
