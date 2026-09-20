// Standalone mode: replaces tools/dashboard_server.mjs with an in-page fake of its /api/* routes,
// so the exact same dashboard.html runs inside the Android app with no PC. Active only inside
// the Capacitor app, or in a normal browser when opened with ?standalone=1 (for testing).
(function () {
  'use strict';
  var native = window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform();
  if (!native && !/[?&]standalone=1/.test(location.search)) return;
  window.__STANDALONE__ = true;

  var K = { config: 'sa.config', scraped: 'sa.scraped', seen: 'sa.seen', tracker: 'jobSearchTracker.v1' };
  // Big collections live in IndexedDB (localStorage caps out around 5 MB, which a few thousand postings would exceed);
  // small things (config, tracker, flags) stay in localStorage. Reads are served from memory once `ready` resolves.
  var BIG = { 'sa.scraped': 1, 'sa.seen': 1 };
  var cache = {}, idb = null, dirty = {}, flushTimer = null;
  var ready = new Promise(function (resolve) {
    function finishLoad() { Object.keys(BIG).forEach(function (k) { if (cache[k] === undefined) { try { var v = localStorage.getItem(k); if (v) { cache[k] = JSON.parse(v); dirty[k] = 1; } } catch (e) { /* ignore */ } } }); flush(); resolve(); }
    try {
      var req = indexedDB.open('jobsearch', 2);
      req.onupgradeneeded = function () { if (!req.result.objectStoreNames.contains('kv')) req.result.createObjectStore('kv'); };
      req.onerror = function () { idb = null; finishLoad(); };
      req.onsuccess = function () {
        idb = req.result;
        var keys = Object.keys(BIG), left = keys.length, st = idb.transaction('kv').objectStore('kv');
        keys.forEach(function (k) {
          var g = st.get(k);
          g.onsuccess = function () { if (g.result !== undefined) cache[k] = g.result; if (--left === 0) finishLoad(); };
          g.onerror = function () { if (--left === 0) finishLoad(); };
        });
      };
    } catch (e) { finishLoad(); }
  });
  function flush() {
    clearTimeout(flushTimer); flushTimer = null;
    var keys = Object.keys(dirty); if (!keys.length) return;
    dirty = {};
    if (!idb) { keys.forEach(function (k) { try { localStorage.setItem(k, JSON.stringify(cache[k])); } catch (e) { pushLog('[warn] penyimpanan penuh'); } }); return; }
    var tx = idb.transaction('kv', 'readwrite'), st = tx.objectStore('kv');
    keys.forEach(function (k) { st.put(cache[k], k); });
    tx.oncomplete = function () { keys.forEach(function (k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }); };
    tx.onerror = function () { pushLog('[warn] gagal menyimpan data'); };
  }
  document.addEventListener('visibilitychange', function () { if (document.hidden) flush(); });
  window.addEventListener('pagehide', flush);
  function load(key, fallback) {
    if (BIG[key]) return cache[key] !== undefined ? cache[key] : fallback;
    try { var v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; }
  }
  function store(key, val) {
    if (BIG[key]) { cache[key] = val; dirty[key] = 1; if (!flushTimer) flushTimer = setTimeout(flush, 250); return; }
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { pushLog('[warn] penyimpanan HP penuh / gagal nyimpen'); }
  }
  window.__resetAll = function () {
    try { if (idb) idb.close(); } catch (e) { /* ignore */ }
    try { localStorage.clear(); } catch (e) { /* ignore */ }
    var del = indexedDB.deleteDatabase('jobsearch');
    del.onsuccess = del.onerror = del.onblocked = function () { location.reload(); };
    setTimeout(function () { location.reload(); }, 1500);
  };
  function getConfig() {
    var c = load(K.config, null);
    if (!c || c.__v !== 2) {
      // First run (or upgrade from the pre-tutorial build): start blank so the guided tutorial can walk the user through it.
      c = JSON.parse(JSON.stringify(window.__DEFAULT_CONFIG__ || {}));
      c.keywordGroups = [{ name: 'Pencarian 1', enabled: true, keywords: [] }];
      c.idealLocations = []; c.acceptableLocations = []; c.profileSkills = [];
      c.schedule = { enabled: false, times: ['08:00', '19:00'] };
      c.__v = 2;
      store(K.config, c);
    }
    return c;
  }

  // ---- run state + fake SSE ------------------------------------------------
  var run = { running: false, exitCode: null, startedAt: null, log: [] };
  var listeners = [];
  function pushLog(line) { run.log.push(line); listeners.forEach(function (l) { l.msg(line); }); }
  function emitDone() { listeners.forEach(function (l) { l.done(); }); }

  function FakeEventSource(url) {
    var self = this, handlers = { done: [] };
    this.onmessage = null; this.onerror = null; this.readyState = 1;
    var l = {
      msg: function (line) { if (self.onmessage) self.onmessage({ data: JSON.stringify(line) }); },
      done: function () { handlers.done.forEach(function (h) { h({ data: JSON.stringify({ code: 0 }) }); }); },
    };
    this.addEventListener = function (ev, h) { if (ev === 'done') handlers.done.push(h); };
    this.close = function () { listeners = listeners.filter(function (x) { return x !== l; }); };
    listeners.push(l);
    setTimeout(function () {
      run.log.forEach(function (line) { l.msg(line); });
      if (!run.running && run.exitCode !== null) l.done();
    }, 0);
  }
  var RealEventSource = window.EventSource;
  window.EventSource = function (url) {
    return /\/api\/scraper\/stream/.test(url) ? new FakeEventSource(url) : new RealEventSource(url);
  };

  function patchScraped(batch) {
    var all = load(K.scraped, []), byUrl = {};
    batch.forEach(function (r) { byUrl[r.url] = r; });
    all.forEach(function (r) { if (byUrl[r.url]) Object.assign(r, JSON.parse(JSON.stringify(byUrl[r.url]))); });
    store(K.scraped, all);
  }
  // Called by the UI when a record is opened before its background detail fetch reached it.
  window.__enrichOne = function (rec) {
    return window.ScraperLib.enrichRecord(rec, getConfig()).then(function (patch) {
      patch._pending = ''; var merged = Object.assign({}, rec, patch); delete merged.__loading;
      patchScraped([merged]); return merged;
    });
  };

  function startRun(group) {
    if (run.running) return { started: false, reason: 'already_running' };
    run = { running: true, exitCode: null, startedAt: new Date().toISOString(), log: [] };
    pushLog(group ? '[app] Menjalankan grup: ' + group : '[app] Menjalankan semua grup aktif');
    var seen = load(K.seen, {});
    var finished = false;
    function finish() { if (finished) return; finished = true; run.running = false; run.exitCode = 0; pushLog('[app] Selesai.'); emitDone(); }
    window.ScraperLib.runScrape({
      config: getConfig(), group: group || '', seen: seen, tracker: load(K.tracker, []), log: pushLog,
      // results are stored + shown as soon as the search itself is done; details are filled in afterwards
      onProvisional: function (records, seenAdditions) {
        var copy = JSON.parse(JSON.stringify(records));
        store(K.scraped, copy.concat(load(K.scraped, [])));
        store(K.seen, Object.assign(seen, seenAdditions));
        store('sa.lastRun', Date.now());
        var n = records.length;
        if (n && getConfig().notifyEnabled !== false) {
          notify(n + ' lowongan baru', records.slice(0, 3).map(function (x) { return x.title + ' - ' + x.company; }).join(String.fromCharCode(10)));
        }
        finish();
      },
      onUpdate: function (batch) { patchScraped(batch); window.dispatchEvent(new Event('sa:data')); },
    })
      .then(function () { window.dispatchEvent(new Event('sa:data')); })
      .catch(function (e) { pushLog('[error] ' + (e && e.message || e)); })
      .then(function () { finish(); });
    return { started: true };
  }

  // ---- notifications + auto-run (only inside the app) -------------------------
  function LN() { return window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.LocalNotifications; }
  window.__askNotifyPermission = function () {
    var p = LN(); if (!p) return;
    p.checkPermissions().then(function (r) { if (r.display !== 'granted') return p.requestPermissions(); }).catch(function () {});
  };
  function notify(title, body) {
    var p = LN(); if (!p) return;
    p.checkPermissions().then(function (r) {
      return r.display === 'granted' ? r : p.requestPermissions();
    }).then(function (r) {
      if (!r || r.display !== 'granted') return;
      return p.schedule({ notifications: [{ id: Math.floor(Date.now() / 1000) % 2147483000, title: title, body: body }] });
    }).catch(function () {});
  }
  // Daily reminders at the scheduled times (repeat even while the app is closed).
  // Tapping one opens the app, and maybeAutoRun() then catches up the missed run.
  function syncSchedule() {
    var p = LN(); if (!p) return;
    var sc = getConfig().schedule || {}, ids = [];
    for (var i = 0; i < 12; i++) ids.push({ id: 9001 + i });
    p.cancel({ notifications: ids }).catch(function () {}).then(function () {
      if (!sc.enabled || !sc.times || !sc.times.length) return;
      return p.schedule({ notifications: sc.times.slice(0, 12).map(function (t, i) {
        var hm = t.split(':');
        return { id: 9001 + i, title: 'Waktunya cek lowongan', body: 'Ketuk untuk menjalankan pencarian otomatis.', schedule: { on: { hour: +hm[0], minute: +hm[1] }, allowWhileIdle: true } };
      }) });
    }).catch(function () {});
  }
  function lastDue(sc) {
    var now = new Date(), best = 0;
    (sc.times || []).forEach(function (t) {
      var hm = t.split(':'), d = new Date(now); d.setHours(+hm[0], +hm[1], 0, 0);
      if (d > now) d.setDate(d.getDate() - 1);
      if (+d > best) best = +d;
    });
    return best;
  }
  function lastRunAt() { return Number(load('sa.lastRun', 0)) || 0; }
  function maybeAutoRun() {
    var c = getConfig();
    if (run.running) return;
    if (!(c.keywordGroups || []).some(function (g) { return g.enabled !== false && (g.keywords || []).length; })) return;
    var sc = c.schedule;
    if (sc && sc.enabled && sc.times && sc.times.length) { if (lastRunAt() >= lastDue(sc)) return; }
    else if (c.autoRunEnabled === false || Date.now() - lastRunAt() < (c.autoRunHours || 12) * 3600000) return;
    var btn = document.getElementById('runScraperBtn');
    if (btn && !btn.disabled) { btn.click(); }
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden) setTimeout(maybeAutoRun, 1500); });
  window.addEventListener('load', function () {
    setTimeout(function () { syncSchedule(); maybeAutoRun(); }, 3000);
  });

  // Android hardware Back: close the top layer (detail / sheet / modal), only leave the app when nothing is open.
  window.addEventListener('load', function () {
    var App = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
    if (!App || !native) return;
    App.addListener('backButton', function () {
      if (window.__hasLayers && window.__hasLayers()) history.back(); else App.exitApp();
    });
  });

  // ---- fake /api routes ----------------------------------------------------
  function json(data, status) {
    return Promise.resolve(new Response(JSON.stringify(data), { status: status || 200, headers: { 'Content-Type': 'application/json' } }));
  }
  function bodyOf(init) { try { return init && init.body ? JSON.parse(init.body) : {}; } catch (e) { return {}; } }

  function route(path, init) {
    var method = ((init && init.method) || 'GET').toUpperCase();
    if (path === '/api/scraped' && method === 'GET') return json(load(K.scraped, []));
    if (path === '/api/config' && method === 'GET') return json(getConfig());
    if (path === '/api/config' && method === 'POST') { var c = bodyOf(init); if (!Array.isArray(c.keywordGroups)) return json({ error: 'keywordGroups array required' }, 400); store(K.config, c); setTimeout(syncSchedule, 0); return json(c); }
    if (path === '/api/scraper/run' && method === 'POST') return json(startRun(bodyOf(init).group));
    if (path === '/api/scraper/state') return json({ running: run.running, exitCode: run.exitCode, startedAt: run.startedAt });
    if (path === '/api/tracker' && method === 'GET') return json(load(K.tracker, []));
    if (path === '/api/tracker' && method === 'POST') { var t = bodyOf(init); return json({ ok: true, rows: Array.isArray(t) ? t.length : 0 }); }
    if (path === '/api/scraped/clear' && method === 'POST') { var n = load(K.scraped, []).length; store(K.scraped, []); store(K.seen, {}); return json({ removed: n, remaining: 0 }); }
    if (path === '/api/scraped/delete' && method === 'POST') {
      var db = bodyOf(init), urlSet = {}, before = load(K.scraped, []);
      (db.urls || []).forEach(function (u) { urlSet[u] = 1; });
      var keptRows = before.filter(function (r) { return !(urlSet[r.url] || (db.group && r.keyword_group === db.group)); });
      store(K.scraped, keptRows); // stays in the seen-list on purpose, so a deleted posting does not come back
      return json({ removed: before.length - keptRows.length, remaining: keptRows.length });
    }
    if (path === '/api/scraped/cleanup' && method === 'POST') {
      var days = Number(bodyOf(init).maxAgeDays);
      if (!isFinite(days) || days < 0) return json({ error: 'maxAgeDays must be a non-negative number' }, 400);
      var cutoff = Date.now() - days * 86400000, all = load(K.scraped, []), seen = load(K.seen, {}), kept = [];
      all.forEach(function (r) { var t2 = Date.parse(r.found_date); if (isNaN(t2) || t2 >= cutoff) kept.push(r); else delete seen[r.url]; });
      store(K.scraped, kept); store(K.seen, seen);
      return json({ removed: all.length - kept.length, remaining: kept.length });
    }
    if (path.indexOf('/api/linkedin/cookie') === 0) return json(method === 'GET' ? { set: false } : { error: 'tidak tersedia di versi HP' }, method === 'GET' ? 200 : 400);
    return json({ error: 'not found' }, 404);
  }

  var realFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    return url.indexOf('/api/') === 0 ? ready.then(function () { return route(url, init); }) : realFetch(input, init);
  };

  window.addEventListener('load', function () {
    setTimeout(function () {
      var b = document.getElementById('linkedinCookieBtn'); if (b) b.style.display = 'none';
      var t = document.getElementById('serverBannerText');
      if (t) t.textContent = 'Mode mandiri - scraper jalan langsung di HP, data disimpan di HP (LinkedIn feed & WhatsApp gak tersedia).';
    }, 1200);
  });
})();
