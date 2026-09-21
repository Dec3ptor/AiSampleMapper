/* field.js — the on-site mode.
 *
 * Planning happens at a desk; collecting happens in a paddock, one-handed, in
 * sunlight, with gloves on. This mode trades the panels for big targets, a
 * running count, a rate worked out from what you have already done, and an
 * arrow to the next sample.
 *
 * Position comes from the phone's GPS, which is good to a few metres. The
 * orthophoto behind it is good to about a quarter of a metre, so the arrow gets
 * you to the right pile, not to the right shovel-width. The accuracy circle is
 * drawn at the size the phone reports so that limit is visible rather than
 * implied.
 */
(function (ASM) {
  'use strict';

  var store = ASM.store, geo = ASM.geo, S = ASM.store.state;

  var F = {
    on: false,
    fix: null,          // {lat, lon, accuracy, at, E, N, px, py, accuracyPx}
    targetId: null,
    follow: true,
    headingDeg: null,   // compass, when the device gives us one
    compassOn: false,
    watchId: null,
    wakeLock: null,
    gpsError: null,
    hudTimer: null
  };

  var el = {};
  function $(id) { return document.getElementById(id); }

  function imgH() {
    if (S.image) return S.image.height;
    return S.project.image ? S.project.image.height : 0;
  }

  function app() { return ASM.app || {}; }
  function toast(m, e) { if (app().toast) app().toast(m, e); }
  function redraw() { if (app().requestDraw) app().requestDraw(); }

  /* ===================== Mode ===================== */

  function enter() {
    if (!S.project.samples.length) {
      toast('Place some sample locations before going out.', true);
      return;
    }
    F.on = true;
    document.documentElement.setAttribute('data-mode', 'field');
    el.ui.hidden = false;
    startGps();
    keepAwake();
    if (!F.targetId) setTarget(pickNext());
    // The stage resizes as the planning chrome goes away, so frame the target
    // again once that has settled.
    setTimeout(function () {
      if (!F.on || F.fix) return;
      var t = target();
      if (t && app().zoomTo) app().zoomTo(t.px, t.py, null);
    }, 80);
    renderHud();
    renderNav();
    F.hudTimer = setInterval(renderHud, 15000);
    redraw();
  }

  function exit() {
    F.on = false;
    document.documentElement.removeAttribute('data-mode');
    el.ui.hidden = true;
    stopGps();
    releaseWake();
    clearInterval(F.hudTimer);
    F.hudTimer = null;
    redraw();
  }

  function isOn() { return F.on; }

  /* ===================== Position ===================== */

  function startGps() {
    if (!navigator.geolocation) {
      F.gpsError = 'This browser has no location support.';
      renderNav();
      return;
    }
    if (F.watchId != null) return;
    F.watchId = navigator.geolocation.watchPosition(onFix, onGpsError, {
      enableHighAccuracy: true,
      maximumAge: 2000,
      timeout: 20000
    });
  }

  function stopGps() {
    if (F.watchId != null && navigator.geolocation) navigator.geolocation.clearWatch(F.watchId);
    F.watchId = null;
  }

  function onFix(pos) {
    var c = pos.coords;
    var g = S.project.georef;
    var fix = {
      lat: c.latitude,
      lon: c.longitude,
      accuracy: c.accuracy,
      at: pos.timestamp,
      speed: c.speed
    };

    if (geo.isAbsolute(g)) {
      var n = geo.toNZTM(fix.lat, fix.lon);
      fix.E = n.E;
      fix.N = n.N;
      var px = geo.groundToPixel(g, n.E, n.N, imgH());
      fix.px = px.px;
      fix.py = px.py;
      fix.accuracyPx = g.mppx ? c.accuracy / g.mppx : 0;
      // Course over ground is only meaningful once actually walking.
      if (c.heading != null && !isNaN(c.heading) && c.speed != null && c.speed > 0.7) {
        fix.headingDeg = c.heading;
        if (!F.compassOn) F.headingDeg = c.heading;
      }
    }

    F.gpsError = null;
    F.fix = fix;
    if (F.follow && fix.px != null && app().centreOn) app().centreOn(fix.px, fix.py);
    renderNav();
    redraw();
  }

  function onGpsError(err) {
    F.gpsError = err.code === 1
      ? 'Location permission denied — allow it in the browser settings.'
      : (err.code === 3 ? 'Waiting for a GPS fix…' : 'Location unavailable.');
    renderNav();
  }

  /* --- Compass. iOS needs an explicit tap before it will hand one over. --- */
  function onOrientation(e) {
    var h = null;
    if (e.webkitCompassHeading != null && !isNaN(e.webkitCompassHeading)) {
      h = e.webkitCompassHeading;                 // already true-north referenced
    } else if (e.alpha != null && !isNaN(e.alpha)) {
      h = (360 - e.alpha) % 360;
    }
    if (h == null) return;
    F.headingDeg = h;
    F.compassOn = true;
    renderNav();
    redraw();
  }

  function enableCompass() {
    var DOE = window.DeviceOrientationEvent;
    if (!DOE) { toast('No compass on this device — the arrow points relative to north.'); return; }
    if (typeof DOE.requestPermission === 'function') {
      DOE.requestPermission().then(function (res) {
        if (res === 'granted') {
          window.addEventListener('deviceorientation', onOrientation, true);
          toast('Compass on — the arrow now points the way you are facing.');
        } else {
          toast('Compass not allowed. The arrow points relative to north.', true);
        }
      }).catch(function () {
        toast('Compass unavailable. The arrow points relative to north.', true);
      });
    } else {
      window.addEventListener('deviceorientationabsolute', onOrientation, true);
      window.addEventListener('deviceorientation', onOrientation, true);
      toast('Compass on, if this device has one.');
    }
  }

  /* --- Keep the screen up while walking between points. --- */
  function keepAwake() {
    if (!navigator.wakeLock || !navigator.wakeLock.request) return;
    navigator.wakeLock.request('screen').then(function (lock) {
      F.wakeLock = lock;
      lock.addEventListener('release', function () { F.wakeLock = null; });
    }).catch(function () { /* denied or unsupported; not worth a message */ });
  }

  function releaseWake() {
    if (F.wakeLock) { try { F.wakeLock.release(); } catch (e) { /* already gone */ } }
    F.wakeLock = null;
  }

  document.addEventListener('visibilitychange', function () {
    if (F.on && document.visibilityState === 'visible' && !F.wakeLock) keepAwake();
  });

  /* ===================== Target ===================== */

  function pending() {
    return S.project.samples.filter(function (s) { return s.status === 'planned'; });
  }

  /** Nearest outstanding sample when we know where we are, else next by ID. */
  function pickNext(exceptId) {
    var list = pending().filter(function (s) { return s.id !== exceptId; });
    if (!list.length) return null;
    if (F.fix && F.fix.px != null) {
      list.sort(function (a, b) {
        return Math.hypot(a.px - F.fix.px, a.py - F.fix.py) -
               Math.hypot(b.px - F.fix.px, b.py - F.fix.py);
      });
    } else {
      list.sort(function (a, b) {
        return String(a.code).localeCompare(String(b.code), 'en', { numeric: true });
      });
    }
    return list[0];
  }

  function setTarget(s) {
    F.targetId = s ? s.id : null;   // any sample, done ones included
    if (s && app().zoomTo && !F.fix) app().zoomTo(s.px, s.py, null);
    renderNav();
    renderHud();
    redraw();
  }

  function target() { return store.sampleById(F.targetId); }

  /** Distance and grid bearing from here to the sample we are walking to. */
  function vector() {
    var t = target();
    if (!t || !F.fix || F.fix.E == null) return null;
    var g = S.project.georef;
    var tg = geo.pixelToGround(g, t.px, t.py, imgH());
    var dE = tg.x - F.fix.E, dN = tg.y - F.fix.N;
    return {
      sample: t,
      dist: Math.hypot(dE, dN),
      bearing: (Math.atan2(dE, dN) * 180 / Math.PI + 360) % 360
    };
  }

  /* ===================== Actions ===================== */

  /* One button: collect what is outstanding, put back what was collected by
   * mistake. Tapping a done marker on the map is how you get to the second. */
  function toggleDone() {
    var t = target();
    if (!t) { toast('Nothing selected.', true); return; }

    if (t.status === 'collected') {
      store.checkpoint();
      store.markPlanned(t);
      commit();
      toast(t.code + ' put back to outstanding.');
      return;
    }

    store.checkpoint();
    store.markCollected(t);
    if (F.fix && F.fix.accuracy != null) t.gpsAccuracy = Math.round(F.fix.accuracy * 10) / 10;
    commit();
    var pr = store.progress();
    setTarget(pickNext());
    toast(t.code + ' collected — ' + pr.left + ' to go' +
      (pr.perHour ? ' at ' + pr.perHour.toFixed(1) + '/hr' : '') + '.');
  }

  function markSkipped() {
    var t = target();
    if (!t) return;
    if (t.status === 'skipped') {
      store.checkpoint();
      store.markPlanned(t);
      commit();
      toast(t.code + ' put back to outstanding.');
      return;
    }
    var why = window.prompt('Why is ' + t.code + ' not being sampled?', t.notes || 'No access');
    if (why === null) return;
    store.checkpoint();
    t.status = 'skipped';
    t.notes = why;
    commit();
    setTarget(pickNext());
    toast(t.code + ' marked no access.');
  }

  function moveHere() {
    var t = target();
    if (!t) return;
    if (!F.fix || F.fix.px == null) { toast('No GPS fix to move it to.', true); return; }
    store.checkpoint();
    store.moveSample(t, F.fix.px, F.fix.py);
    t.gpsAccuracy = Math.round(F.fix.accuracy * 10) / 10;
    t.stockpileId = store.pileAt(t.px, t.py);
    store.recode();
    commit();
    toast(t.code + ' moved to where you are standing (±' + Math.round(F.fix.accuracy) + ' m).');
  }

  function addHere() {
    if (!F.fix || F.fix.px == null) { toast('No GPS fix yet.', true); return; }
    store.checkpoint();
    var s = store.addSample(F.fix.px, F.fix.py, {});
    s.gpsAccuracy = Math.round(F.fix.accuracy * 10) / 10;
    s.notes = 'Added in the field';
    store.recode();
    commit();
    setTarget(s);
    toast('Added ' + s.code + ' where you are standing.');
  }

  function skipToNext() {
    var next = pickNext(F.targetId);
    if (!next) { toast('Nothing else outstanding.'); return; }
    setTarget(next);
  }

  function commit() {
    if (app().afterChange) app().afterChange();
    renderHud();
    renderNav();
    redraw();
  }

  /* ===================== HUD ===================== */

  function fmtDuration(hours) {
    if (hours == null || !isFinite(hours)) return '—';
    var mins = Math.round(hours * 60);
    if (mins < 60) return mins + ' min';
    return Math.floor(mins / 60) + 'h ' + String(mins % 60).padStart(2, '0') + 'm';
  }

  function fmtClock(d) {
    if (!d) return '—';
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function renderHud() {
    if (!F.on) return;
    var pr = store.progress();
    var pct = pr.total ? ((pr.done + pr.skipped) / pr.total) * 100 : 0;
    el.fill.style.width = pct.toFixed(1) + '%';
    el.done.textContent = pr.done + '/' + pr.total;
    el.left.textContent = pr.left + ' left' + (pr.skipped ? ' · ' + pr.skipped + ' skipped' : '');
    el.rate.textContent = pr.perHour
      ? pr.perHour.toFixed(1) + '/hr'
      : (pr.idle ? 'paused' : '—/hr');
    el.eta.textContent = pr.etaHours != null
      ? fmtDuration(pr.etaHours) + ' · ' + fmtClock(pr.finishAt)
      : (pr.idle ? 'rate resumes on next' : (pr.done < 2 ? 'rate after 2' : '—'));

    // Say so when the stint is a slice of the total, so the pace is not read
    // as covering everything done across several days.
    if (pr.sessionDone && pr.sessionDone < pr.done) {
      el.left.textContent += ' · ' + pr.sessionDone + ' this stint';
    }
  }

  function renderNav() {
    if (!F.on) return;
    var t = target();
    var v = vector();

    if (el.done2) {
      var collected = t && t.status === 'collected';
      var skipped = t && t.status === 'skipped';
      el.done2.textContent = collected ? 'Un-collect' : 'Collected';
      el.done2.classList.toggle('is-undo', !!collected);
      el.skip2.textContent = skipped ? 'Reinstate' : 'No access';
      el.done2.disabled = !t;
      el.skip2.disabled = !t;
    }

    el.target.textContent = t ? t.code : 'All done';
    el.sub.textContent = t
      ? [
        t.stockpileId ? (store.pileById(t.stockpileId) || {}).name : 'off-pile',
        ASM.plan.typeById(t.type).name +
          (t.type === 'composite' ? ' ×' + ASM.plan.incrementCount(t) : ''),
        t.depthFrom + '–' + t.depthTo + ' m'
      ].filter(Boolean).join(' · ')
      : 'Nothing outstanding';

    if (!geo.isAbsolute(S.project.georef)) {
      el.dist.textContent = 'no georef';
      el.src.textContent = 'Pin NZTM coordinates in Setup to use GPS';
      el.arrow.style.transform = 'rotate(0deg)';
      el.arrow.classList.add('is-idle');
      return;
    }
    if (F.gpsError) {
      el.dist.textContent = '—';
      el.src.textContent = F.gpsError;
      el.arrow.classList.add('is-idle');
      return;
    }
    if (!v) {
      el.dist.textContent = '—';
      el.src.textContent = 'Waiting for a GPS fix…';
      el.arrow.classList.add('is-idle');
      return;
    }

    el.arrow.classList.remove('is-idle');
    el.dist.textContent = v.dist < 10 ? v.dist.toFixed(1) + ' m' : Math.round(v.dist) + ' m';
    el.card.classList.toggle('is-close', v.dist <= Math.max(4, F.fix.accuracy || 5));

    var rot = F.compassOn && F.headingDeg != null ? v.bearing - F.headingDeg : v.bearing;
    el.arrow.style.transform = 'rotate(' + rot.toFixed(1) + 'deg)';

    el.src.textContent = '±' + Math.round(F.fix.accuracy) + ' m · ' +
      (F.compassOn && F.headingDeg != null
        ? 'ahead of you'
        : (Math.round(v.bearing) % 360) + '° from north');
  }

  /* ===================== Map overlay ===================== */

  function drawOverlay(ctx, view) {
    if (!F.on) return;
    var t = target();
    if (t) ASM.render.drawTargetRing(ctx, view, t.px, t.py, Date.now());
    if (F.fix && F.fix.px != null) {
      if (t) ASM.render.drawRoute(ctx, view, F.fix.px, F.fix.py, t.px, t.py);
      ASM.render.drawFix(ctx, view, {
        px: F.fix.px, py: F.fix.py,
        accuracyPx: F.fix.accuracyPx || 0,
        headingDeg: F.compassOn ? F.headingDeg : F.fix.headingDeg
      });
    }
  }

  /** A tap on a marker in field mode makes it the target. */
  function onMapPick(sample) {
    if (!F.on || !sample) return false;
    setTarget(sample);
    return true;
  }

  /* ===================== Wiring ===================== */

  function bind() {
    ['fieldUI', 'fpFill', 'fpDone', 'fpLeft', 'fpRate', 'fpEta', 'navCard', 'navArrow',
     'navTarget', 'navSub', 'navDist', 'navSrc'].forEach(function (id) { el[id] = $(id); });
    el.ui = el.fieldUI; el.fill = el.fpFill; el.done = el.fpDone; el.left = el.fpLeft;
    el.rate = el.fpRate; el.eta = el.fpEta; el.card = el.navCard; el.arrow = el.navArrow;
    el.target = el.navTarget; el.sub = el.navSub; el.dist = el.navDist; el.src = el.navSrc;
    el.done2 = $('fieldDone'); el.skip2 = $('fieldSkip');

    $('fieldExit').addEventListener('click', exit);
    $('fieldDone').addEventListener('click', toggleDone);
    $('fieldSkip').addEventListener('click', markSkipped);
    $('fieldNext').addEventListener('click', skipToNext);
    $('fieldMove').addEventListener('click', moveHere);
    $('fieldAdd').addEventListener('click', addHere);
    $('fieldCompass').addEventListener('click', enableCompass);
    $('fieldFollow').addEventListener('click', function () {
      F.follow = !F.follow;
      $('fieldFollow').classList.toggle('is-on', F.follow);
      if (F.follow && F.fix && F.fix.px != null && app().centreOn) app().centreOn(F.fix.px, F.fix.py);
      toast(F.follow ? 'Following your position.' : 'Map stays where you put it.');
    });
    $('fieldFollow').classList.toggle('is-on', F.follow);
  }

  ASM.field = {
    bind: bind,
    enter: enter,
    exit: exit,
    isOn: isOn,
    drawOverlay: drawOverlay,
    onMapPick: onMapPick,
    setTarget: setTarget,
    renderHud: renderHud,
    renderNav: renderNav,
    state: F
  };
})(window.ASM = window.ASM || {});
