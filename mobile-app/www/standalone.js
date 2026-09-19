// Standalone mode: replaces tools/dashboard_server.mjs with an in-page fake of its /api/* routes,
// so the exact same dashboard.html runs inside the Android app with no PC. Active only inside
// the Capacitor app, or in a normal browser when opened with ?standalone=1 (for testing).
(function () {
  'use strict';
  var native = window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform();
  if (!native && !/[?&]standalone=1/.test(location.search)) return;
  window.__STANDALONE__ = true;

  var K = { config: 'sa.config', scraped: 'sa.scraped', seen: 'sa.seen', tracker: 'jobSearchTracker.v1' };
  function load(key, fallback) { try { var v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; } }
  function store(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { pushLog('[warn] penyimpanan HP penuh / gagal nyimpen'); } }
  function getConfig() {
    var c = load(K.config, null);
    if (!c) { c = JSON.parse(JSON.stringify(window.__DEFAULT_CONFIG__ || {})); store(K.config, c); }
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

  function startRun(group) {
    if (run.running) return { started: false, reason: 'already_running' };
    run = { running: true, exitCode: null, startedAt: new Date().toISOString(), log: [] };
    pushLog(group ? '[app] Menjalankan grup: ' + group : '[app] Menjalankan semua grup aktif');
    var seen = load(K.seen, {});
    window.ScraperLib.runScrape({ config: getConfig(), group: group || '', seen: seen, tracker: load(K.tracker, []), log: pushLog })
      .then(function (res) {
        var scraped = load(K.scraped, []);
        store(K.scraped, res.records.concat(scraped));
        store(K.seen, Object.assign(seen, res.seenAdditions));
        store('sa.lastRun', Date.now());
        var n = res.records.length;
        if (n && getConfig().notifyEnabled !== false) {
          var top = res.records.slice(0, 3).map(function (x) { return x.title + ' - ' + x.company; }).join(String.fromCharCode(10));
          notify(n + ' lowongan baru', top);
        }
      })
      .catch(function (e) { pushLog('[error] ' + (e && e.message || e)); })
      .then(function () { run.running = false; run.exitCode = 0; pushLog('[app] Selesai.'); emitDone(); });
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
      if (r.display !== 'granted') return;
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
    setTimeout(function () { if (getConfig().notifyEnabled !== false) window.__askNotifyPermission(); syncSchedule(); maybeAutoRun(); }, 3000);
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
    return url.indexOf('/api/') === 0 ? route(url, init) : realFetch(input, init);
  };

  window.addEventListener('load', function () {
    setTimeout(function () {
      var b = document.getElementById('linkedinCookieBtn'); if (b) b.style.display = 'none';
      var t = document.getElementById('serverBannerText');
      if (t) t.textContent = 'Mode mandiri - scraper jalan langsung di HP, data disimpan di HP (LinkedIn feed & WhatsApp gak tersedia).';
    }, 1200);
  });
})();
