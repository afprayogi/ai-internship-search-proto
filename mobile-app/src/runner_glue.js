// Background Runner entry (headless JS, no DOM / no WebView). build_www.mjs concatenates this file after
// scraper_lib.js into www/runners/runner.js. The runner has its own storage (CapacitorKV), so the app
// pushes the config / seen-list / tracker into it ("sync"), the OS wakes it up periodically ("checkNewJobs")
// and the app collects what it found the next time it is opened ("drain").
/* global CapacitorKV, CapacitorNotifications, ScraperLib */

// The runner has no URLSearchParams; the scraper only needs set/append/toString.
if (typeof URLSearchParams === 'undefined') {
  globalThis.URLSearchParams = function (init) {
    var pairs = [];
    this.set = function (k, v) { pairs = pairs.filter(function (p) { return p[0] !== k; }); pairs.push([k, String(v)]); };
    this.append = function (k, v) { pairs.push([k, String(v)]); };
    this.toString = function () { return pairs.map(function (p) { return encodeURIComponent(p[0]) + '=' + encodeURIComponent(p[1]); }).join('&'); };
    if (init && typeof init === 'object') Object.keys(init).forEach(function (k) { pairs.push([k, String(init[k])]); });
  };
}

// The runner's fetch insists on an explicit method (undefined is rejected) and only honours method/headers/body.
(function () {
  var nativeFetch = globalThis.fetch;
  globalThis.fetch = function (url, opts) {
    var o = opts || {};
    return nativeFetch(url, { method: o.method || 'GET', headers: o.headers || {}, body: o.body });
  };
})();

function kvGet(key, fallback) {
  try { var r = CapacitorKV.get(key); return r && r.value ? JSON.parse(r.value) : fallback; } catch (e) { return fallback; }
}
function kvSet(key, val) { CapacitorKV.set(key, JSON.stringify(val)); }

// most recent scheduled HH:MM that has already passed (same rule the app uses when it is opened)
function lastDue(schedule) {
  var now = new Date(), best = 0;
  (schedule.times || []).forEach(function (t) {
    var hm = String(t).split(':'), d = new Date(now); d.setHours(+hm[0], +hm[1], 0, 0);
    if (d > now) d.setDate(d.getDate() - 1);
    if (+d > best) best = +d;
  });
  return best;
}

function isDue(cfg, force) {
  if (force) return true;
  var last = kvGet('lastRun', 0), sc = cfg.schedule;
  if (sc && sc.enabled && sc.times && sc.times.length) return last < lastDue(sc);
  return Date.now() - last >= (cfg.autoRunHours || 6) * 3600000;
}

addEventListener('sync', function (resolve, reject, args) {
  try {
    if (args.config) kvSet('config', args.config);
    if (args.tracker) kvSet('tracker', args.tracker);
    if (args.lastRun) kvSet('lastRun', Math.max(args.lastRun, kvGet('lastRun', 0)));
    if (args.seenUrls) {
      var seen = {};
      args.seenUrls.forEach(function (u) { seen[u] = 1; });
      var extra = kvGet('seenAdded', {}); // what the runner found itself and the app has not collected yet
      Object.keys(extra).forEach(function (u) { seen[u] = 1; });
      kvSet('seen', seen);
    }
    resolve({ ok: true });
  } catch (e) { reject(String(e && e.message || e)); }
});

addEventListener('drain', function (resolve, reject) {
  try {
    var out = { records: kvGet('pending', []), seenAdded: kvGet('seenAdded', {}), lastRun: kvGet('lastRun', 0), lastLog: kvGet('lastLog', '') };
    kvSet('pending', []); kvSet('seenAdded', {});
    resolve(out);
  } catch (e) { reject(String(e && e.message || e)); }
});

addEventListener('checkNewJobs', function (resolve, reject, args) {
  (async function () {
    var force = !!(args && args.force);
    var cfg = kvGet('config', null);
    if (!cfg || cfg.backgroundEnabled === false) { resolve({ skipped: 'off' }); return; }
    var hasKeywords = (cfg.keywordGroups || []).some(function (g) { return g.enabled !== false && (g.keywords || []).length; });
    if (!hasKeywords) { resolve({ skipped: 'no keywords' }); return; }
    if (!isDue(cfg, force)) { resolve({ skipped: 'not due' }); return; }

    var seen = kvGet('seen', {}), lines = [], found = [];
    var result = await ScraperLib.runScrape({
      config: cfg, group: '', seen: seen, tracker: kvGet('tracker', []),
      log: function (l) { lines.push(l); },
      skipDetails: true, // keep it short: details are fetched when the app is opened
      onProvisional: function (records) { found = records; },
    });
    found = found.length ? found : (result.records || []);

    var added = kvGet('seenAdded', {});
    Object.keys(result.seenAdditions || {}).forEach(function (u) { added[u] = 1; seen[u] = 1; });
    var pending = found.map(function (r) { r._pending = '1'; return r; }).concat(kvGet('pending', [])).slice(0, 300);
    kvSet('seenAdded', added); kvSet('seen', seen); kvSet('pending', pending);
    kvSet('lastRun', Date.now());
    kvSet('lastLog', lines.slice(-12).join('\n'));

    if (found.length && cfg.notifyEnabled !== false) {
      CapacitorNotifications.schedule([{
        id: 4100, title: found.length + ' lowongan baru',
        body: found.slice(0, 3).map(function (r) { return r.title + ' - ' + r.company; }).join('\n'),
      }]);
    }
    resolve({ found: found.length });
  })().catch(function (e) { try { kvSet('lastLog', 'ERROR ' + String(e && e.message || e)); } catch (x) { /* ignore */ } reject(String(e && e.message || e)); });
});
