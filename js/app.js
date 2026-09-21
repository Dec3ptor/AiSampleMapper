/* app.js — interaction, panels and wiring. */
(function (ASM) {
  'use strict';

  var store = ASM.store, geo = ASM.geo, geom = ASM.geom, plan = ASM.plan, R = ASM.render;
  var S = store.state;

  var view = R.makeView();
  var ui = {
    tool: 'select',
    pending: null,          // 'calibrate' | 'anchor' when a click is being captured
    draft: [],              // polygon under construction
    measure: [],
    measureMode: 'line',
    cursor: null,
    selectedPileId: null,
    selectedSampleId: null,
    sampleFilter: 'all',
    drag: null,
    panelOpen: false
  };

  // Exposed so the interaction state can be inspected from the console, and so
  // the field module can drive the map without reaching into internals.
  ASM.ui = ui;
  ASM.view = view;
  ASM.app = {
    requestDraw: requestDraw,
    centreOn: centreOn,
    zoomTo: function (px, py, sc) { zoomTo(px, py, sc); },
    fit: function () { fit(); },
    toast: function (m, e) { toast(m, e); },
    afterChange: function () { afterChange(); }
  };

  var el = {};
  var needsDraw = true;
  var canvas, ctx, dpr = 1;

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function requestDraw() { needsDraw = true; }

  /* ===================== Canvas ===================== */

  function sizeCanvas() {
    var r = el.stage.getBoundingClientRect();
    // Render at the display's true pixel density so a zoomed-in ortho is as
    // sharp as the screen allows, but keep the backing store under ~16 MP so a
    // 4K panel does not cost hundreds of megabytes.
    var want = window.devicePixelRatio || 1;
    var area = Math.max(1, r.width * r.height);
    dpr = Math.max(1, Math.min(want, 3, Math.sqrt(16e6 / area)));
    canvas.width = Math.max(1, Math.round(r.width * dpr));
    canvas.height = Math.max(1, Math.round(r.height * dpr));
    requestDraw();
  }

  function draw() {
    if (!needsDraw) return;
    needsDraw = false;
    var w = canvas.width / dpr, h = canvas.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    R.drawScene(ctx, {
      width: w, height: h, view: view,
      project: S.project, image: S.image, ui: ui
    });

    if (ASM.field) ASM.field.drawOverlay(ctx, view);

    if (S.image) {
      R.drawScaleBar(ctx, view, S.project.georef, 18, h - 22);
      R.drawNorthArrow(ctx, w - 36, 38, R.northAngle(S.project.georef, S.image.height), 15);
    }
  }

  var lastFieldFrame = 0;
  function tick(now) {
    // The target ring pulses, so field mode needs a heartbeat — but at about
    // 10 fps, not 60, because this runs on a phone battery all afternoon.
    if (ASM.field && ASM.field.isOn() && now - lastFieldFrame > 100) {
      lastFieldFrame = now;
      needsDraw = true;
    }
    draw();
    requestAnimationFrame(tick);
  }

  function fit() {
    if (!S.image) return;
    var r = el.stage.getBoundingClientRect();
    R.fitView(view, S.image.width, S.image.height, r.width, r.height, 28);
    requestDraw();
  }

  function centreOn(px, py) {
    var r = el.stage.getBoundingClientRect();
    view.tx = r.width / 2 - px * view.scale;
    view.ty = r.height / 2 - py * view.scale;
    requestDraw();
  }

  function zoomTo(px, py, targetScale) {
    var r = el.stage.getBoundingClientRect();
    view.scale = targetScale || Math.max(view.scale, 2);
    view.tx = r.width / 2 - px * view.scale;
    view.ty = r.height / 2 - py * view.scale;
    requestDraw();
  }

  function eventImagePoint(ev) {
    var r = canvas.getBoundingClientRect();
    return R.toImage(view, ev.clientX - r.left, ev.clientY - r.top);
  }

  /* ===================== Hit testing ===================== */

  function sampleAt(px, py) {
    var best = null, bestD = Infinity;
    var tol = (10 * (S.project.settings.markerScale || 1) + 4) / view.scale;
    S.project.samples.forEach(function (s) {
      var d = Math.hypot(s.px - px, s.py - py);
      if (d < tol && d < bestD) { bestD = d; best = s; }
      // Clicking any increment selects the sample it belongs to.
      (s.incPts || []).forEach(function (pt) {
        var di = Math.hypot(pt[0] - px, pt[1] - py);
        if (di < tol && di < bestD) { bestD = di; best = s; }
      });
    });
    return best;
  }

  function incrementAt(s, px, py) {
    if (!s || !s.incPts || s.incPts.length < 2) return -1;
    var tol = (9 * (S.project.settings.markerScale || 1)) / view.scale;
    for (var i = 0; i < s.incPts.length; i++) {
      if (Math.hypot(s.incPts[i][0] - px, s.incPts[i][1] - py) < tol) return i;
    }
    return -1;
  }

  function vertexAt(pile, px, py) {
    var tol = 8 / view.scale;
    for (var i = 0; i < pile.polygon.length; i++) {
      if (Math.hypot(pile.polygon[i][0] - px, pile.polygon[i][1] - py) < tol) return i;
    }
    return -1;
  }

  /* ===================== Tools ===================== */

  function setTool(name) {
    if (ui.tool === 'pile' && name !== 'pile') ui.draft = [];
    if (ui.tool === 'measure' && name !== 'measure') ui.measure = [];
    ui.tool = name;
    ui.pending = null;
    document.querySelectorAll('.tool[data-tool]').forEach(function (b) {
      b.classList.toggle('is-active', b.dataset.tool === name);
    });
    updateHud();
    requestDraw();
  }

  var HINTS = {
    select: 'Click a marker or outline to edit it. Drag to pan, scroll to zoom.',
    pile: 'Click around the stockpile. <kbd>Enter</kbd> or click the first point to close, <kbd>Esc</kbd> to cancel.',
    sample: 'Click to drop a sample location. It is assigned to whichever stockpile it lands in.',
    measure: 'Click along the line. Close it back to the start for an area. <kbd>Esc</kbd> clears.',
    erase: 'Click a sample or a stockpile outline to delete it. <kbd>Ctrl</kbd>+<kbd>Z</kbd> undoes.'
  };

  function updateHud() {
    var html = '';
    if (ui.pending === 'calibrate') {
      html = '<b>Calibrating scale.</b> Click the two ends of a length you know on the ground — a container, a lane width, a fence line.' +
        (ui.draft.length === 1 ? ' One point set.' : '');
    } else if (ui.pending === 'increments') {
      var t = store.sampleById(ui.incTarget);
      var n = t ? plan.incrementCount(t) : 0;
      html = '<b>Marking increments for ' + esc(t ? t.code : '') + '.</b> Click each spot you will ' +
        'take material from \u2014 they all go into this one sample. ' +
        '<b>' + n + '</b> so far. <kbd>Esc</kbd> or <kbd>Enter</kbd> when done.';
    } else if (ui.pending === 'anchor') {
      html = '<b>Pinning coordinates.</b> Click the exact feature those NZTM coordinates belong to.';
    } else if (ui.tool === 'measure' && ui.measure.length) {
      html = measureReadout();
    } else if (ui.tool !== 'select') {
      html = HINTS[ui.tool] || '';
    } else if (!S.image) {
      html = '<b>Start here.</b> Load an aerial image, set the scale, then outline each stockpile.';
    }
    el.hudTool.innerHTML = html;
    el.hudTool.hidden = !html;
    el.stHint.innerHTML = html ? html.replace(/<[^>]+>/g, '') : (HINTS[ui.tool] || '');
  }

  function measureReadout() {
    var g = S.project.georef, pts = ui.measure.slice();
    if (ui.cursor) pts.push(ui.cursor);
    var lenPx = 0;
    for (var i = 1; i < pts.length; i++) lenPx += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    var out = '<b>Length</b> ' + (geo.hasScale(g) ? geo.fmtLen(lenPx * g.mppx) : Math.round(lenPx) + ' px');
    if (pts.length > 2) {
      var a = geom.area(pts);
      out += ' &nbsp; <b>Area</b> ' + (geo.hasScale(g) ? geo.fmtArea(a * g.mppx * g.mppx) : Math.round(a) + ' px²');
    }
    return out + ' &nbsp;<kbd>Esc</kbd> to clear';
  }

  function closeDraft() {
    if (ui.draft.length < 3) { toast('A stockpile needs at least three points.', true); return; }
    store.checkpoint();
    var pile = store.addPile(ui.draft.slice());
    ui.draft = [];
    ui.selectedPileId = pile.id;
    // Samples already dropped inside this outline now belong to it.
    S.project.samples.forEach(function (s) {
      if (!s.stockpileId && geom.contains(pile.polygon, s.px, s.py)) s.stockpileId = pile.id;
    });
    store.recode();
    afterChange();
    switchTab('piles');
    toast(pile.name + ' added.');
  }

  /* ===================== Pointer ===================== */

  function onPointerDown(ev) {
    if (!S.image) return;
    canvas.setPointerCapture(ev.pointerId);
    var p = eventImagePoint(ev);
    var isPan = ev.button === 1 || ev.altKey || ev.shiftKey;

    if (ui.pending === 'calibrate') {
      ui.draft.push(p);
      if (ui.draft.length === 2) finishCalibrate();
      updateHud(); requestDraw();
      return;
    }
    if (ui.pending === 'anchor') { finishAnchor(p); return; }

    if (ui.pending === 'increments') {
      var target = store.sampleById(ui.incTarget);
      if (!target) { ui.pending = null; updateHud(); return; }
      store.checkpoint();
      store.addIncrement(target, p[0], p[1]);
      afterChange();
      updateHud();
      return;
    }

    if (isPan || ui.tool === 'select') {
      if (!isPan && ui.tool === 'select') {
        // Vertex drag on the selected outline takes priority over everything.
        var selPile = store.pileById(ui.selectedPileId);
        if (selPile) {
          var vi = vertexAt(selPile, p[0], p[1]);
          if (vi >= 0) {
            store.checkpoint();
            ui.drag = { kind: 'vertex', pile: selPile, index: vi };
            return;
          }
        }
        var selSample = store.sampleById(ui.selectedSampleId);
        if (selSample) {
          var ii = incrementAt(selSample, p[0], p[1]);
          if (ii >= 0) {
            store.checkpoint();
            ui.drag = { kind: 'increment', sample: selSample, index: ii };
            return;
          }
        }
        var s = sampleAt(p[0], p[1]);
        if (s && ASM.field && ASM.field.isOn()) { ASM.field.onMapPick(s); return; }
        if (s) {
          selectSample(s.id);
          store.checkpoint();
          ui.drag = { kind: 'sample', sample: s, moved: false };
          return;
        }
        var pid = store.pileAt(p[0], p[1]);
        if (pid) { selectPile(pid); return; }
        selectSample(null); selectPile(null);
      }
      ui.drag = { kind: 'pan', x: ev.clientX, y: ev.clientY, tx: view.tx, ty: view.ty };
      canvas.style.cursor = 'grabbing';
      return;
    }

    if (ui.tool === 'pile') {
      if (ui.draft.length > 2) {
        var first = ui.draft[0];
        if (Math.hypot(first[0] - p[0], first[1] - p[1]) < 10 / view.scale) { closeDraft(); return; }
      }
      ui.draft.push(p);
      updateHud(); requestDraw();
      return;
    }

    if (ui.tool === 'sample') {
      store.checkpoint();
      var ns = store.addSample(p[0], p[1], {});
      store.recode();
      ui.selectedSampleId = ns.id;
      afterChange();
      return;
    }

    if (ui.tool === 'measure') {
      if (ui.measure.length > 2) {
        var f = ui.measure[0];
        if (Math.hypot(f[0] - p[0], f[1] - p[1]) < 10 / view.scale) {
          ui.measureMode = 'area'; updateHud(); requestDraw(); return;
        }
      }
      ui.measure.push(p);
      updateHud(); requestDraw();
      return;
    }

    if (ui.tool === 'erase') {
      var hit = sampleAt(p[0], p[1]);
      if (hit) {
        store.checkpoint();
        store.removeSample(hit.id);
        if (ui.selectedSampleId === hit.id) ui.selectedSampleId = null;
        store.recode(); afterChange();
        return;
      }
      var hp = store.pileAt(p[0], p[1]);
      if (hp) {
        var pile = store.pileById(hp);
        store.checkpoint();
        store.removePile(hp);
        if (ui.selectedPileId === hp) ui.selectedPileId = null;
        store.recode(); afterChange();
        toast(pile.name + ' and its samples deleted.');
      }
    }
  }

  function onPointerMove(ev) {
    if (!S.image) return;
    var p = eventImagePoint(ev);
    ui.cursor = p;
    updateStatusCoord(p);

    if (ui.drag) {
      if (ui.drag.kind === 'pan') {
        view.tx = ui.drag.tx + (ev.clientX - ui.drag.x);
        view.ty = ui.drag.ty + (ev.clientY - ui.drag.y);
      } else if (ui.drag.kind === 'sample') {
        store.moveSample(ui.drag.sample, p[0], p[1]);
        ui.drag.moved = true;
      } else if (ui.drag.kind === 'increment') {
        ui.drag.sample.incPts[ui.drag.index] = p;
        store.syncComposite(ui.drag.sample);
        ui.drag.moved = true;
      } else if (ui.drag.kind === 'vertex') {
        ui.drag.pile.polygon[ui.drag.index] = p;
      }
      requestDraw();
      return;
    }

    if (ui.tool === 'pile' && ui.draft.length) requestDraw();
    if (ui.tool === 'measure' && ui.measure.length) { updateHud(); requestDraw(); }
    if (ui.pending === 'calibrate' && ui.draft.length === 1) requestDraw();
  }

  function onPointerUp(ev) {
    if (ui.drag) {
      var d = ui.drag;
      ui.drag = null;
      canvas.style.cursor = '';
      if (d.kind === 'sample' && d.moved) {
        d.sample.stockpileId = store.pileAt(d.sample.px, d.sample.py);
        store.recode();
        afterChange();
      } else if (d.kind === 'vertex' || (d.kind === 'increment' && d.moved)) {
        afterChange();
      }
    }
    if (ev && ev.pointerId != null && canvas.hasPointerCapture && canvas.hasPointerCapture(ev.pointerId)) {
      canvas.releasePointerCapture(ev.pointerId);
    }
  }

  function onWheel(ev) {
    if (!S.image) return;
    ev.preventDefault();
    var r = canvas.getBoundingClientRect();
    var factor = Math.pow(0.999, ev.deltaY * (ev.deltaMode === 1 ? 18 : 1));
    R.zoomAt(view, ev.clientX - r.left, ev.clientY - r.top, factor, 0.01, 240);
    updateStatusZoom();
    requestDraw();
  }

  function onDblClick(ev) {
    if (ui.tool === 'pile' && ui.draft.length > 2) { closeDraft(); return; }
    if (ui.tool !== 'select' || !S.image) return;
    var p = eventImagePoint(ev);
    var hit = sampleAt(p[0], p[1]);
    if (hit) { selectSample(hit.id); focusRename(); return; }
    var pid = store.pileAt(p[0], p[1]);
    if (pid) { selectPile(pid); focusRename(); }
  }

  /* ===================== Scale capture ===================== */

  function finishCalibrate() {
    var a = ui.draft[0], b = ui.draft[1];
    var px = Math.hypot(b[0] - a[0], b[1] - a[1]);
    ui.draft = [];
    ui.pending = null;
    if (px < 2) { toast('Those two points are too close to measure.', true); updateHud(); return; }
    var answer = window.prompt('How long is that line on the ground, in metres?', '20');
    if (answer == null) { updateHud(); requestDraw(); return; }
    var metres = parseFloat(answer);
    if (!isFinite(metres) || metres <= 0) { toast('Enter a length in metres.', true); updateHud(); return; }
    store.checkpoint();
    var mppx = metres / px;
    var g = S.project.georef;
    if (g.affine) {
      // Keep the absolute position, restate the scale around the anchor pixel.
      var centre = ASM.geo.pixelToGround(g, a[0], a[1], S.image.height);
      S.project.georef = geo.fromAnchor(a[0], a[1], centre.x, centre.y, mppx, g.crs);
    } else {
      S.project.georef = geo.fromGSD(mppx, 'calibration',
        'Measured ' + metres + ' m across ' + px.toFixed(1) + ' px');
    }
    afterChange();
    toast('Scale set to ' + mppx.toFixed(4) + ' m per pixel.');
  }

  function finishAnchor(p) {
    ui.pending = null;
    var E = parseFloat(el.fAnchorE.value), N = parseFloat(el.fAnchorN.value);
    var g = S.project.georef;
    if (!isFinite(E) || !isFinite(N)) { toast('Enter both an easting and a northing first.', true); updateHud(); return; }
    if (!geo.hasScale(g)) { toast('Set metres per pixel before pinning a coordinate.', true); updateHud(); return; }
    store.checkpoint();
    S.project.georef = geo.fromAnchor(p[0], p[1], E, N, g.mppx, 'EPSG:2193');
    afterChange();
    toast('Image pinned to NZTM2000.');
  }

  /* ===================== Files ===================== */

  function loadImageFromBlob(blob, name, keepProject) {
    function adopt(bitmap) {
      if (S.image && S.image.close) S.image.close();
      S.image = bitmap;
      S.project.image = { name: name, width: bitmap.width, height: bitmap.height };
      if (!keepProject) store.saveImageBlob(blob, S.project.image);
      el.dropzone.hidden = true;
      fit();
      renderAll();
      updateHud();
      var mp = bitmap.width * bitmap.height / 1e6;
      if (mp >= 20) toast(mp.toFixed(0) + ' MP loaded at full resolution.');
    }

    function viaImageElement() {
      var url = URL.createObjectURL(blob);
      var img = new Image();
      img.onload = function () { adopt(img); };
      img.onerror = function () {
        toast('That image could not be read.', true);
        URL.revokeObjectURL(url);
      };
      img.src = url;
    }

    // createImageBitmap decodes off the main thread and, unlike an <img>, is
    // never subsampled by the browser on very large images -- which is exactly
    // what happens to a full ortho tile on iOS otherwise.
    if (window.createImageBitmap) {
      createImageBitmap(blob).then(adopt).catch(viaImageElement);
    } else {
      viaImageElement();
    }
  }

  function loadExample() {
    var img = new Image();
    img.onload = function () {
      S.image = img;
      S.project.image = { name: 'site-aerial.jpg (example)', width: img.width, height: img.height };
      S.project.name = 'Example — stockpile validation';
      S.project.client = 'Example client';
      S.project.jobRef = 'DEMO-001';
      S.project.georef = geo.fromGSD(0.1, 'gsd', 'Assumed 10 cm GSD — verify before use');
      S.project.isExample = true;

      // One worked stockpile so the whole flow is visible on opening.
      var poly = [[100, 462], [312, 470], [318, 648], [96, 640]];
      var pile = store.addPile(poly);
      pile.name = 'EXAMPLE A';
      pile.material = 'Excavated soil';
      pile.heightM = 2.0;
      pile.notes = 'Example only — delete and draw your own.';
      var st = store.pileStats(pile);
      var n = st.required || 3;
      geom.generate('systematic', poly, n, 1.0 / 0.1, 11).forEach(function (pt) {
        store.addSample(pt[0], pt[1], { stockpileId: pile.id, type: 'discrete' });
      });
      store.recode();
      el.dropzone.hidden = true;
      fit();
      renderAll();
      updateHud();
      toast('Example loaded. Drop your own image to replace it.');
    };
    img.onerror = function () {
      el.dropzone.hidden = false;
      updateHud();
    };
    img.src = 'sample/site-aerial.jpg';
  }

  function readWorldFile(file) {
    var fr = new FileReader();
    fr.onload = function () {
      var c = geo.parseWorldFile(fr.result);
      if (!c) { toast('That does not look like a world file.', true); return; }
      store.checkpoint();
      S.project.georef = geo.fromWorldFile(c.A, c.D, c.B, c.E, c.C, c.F, 'EPSG:2193');
      afterChange();
      toast('World file applied — ' + S.project.georef.mppx.toFixed(4) + ' m per pixel.');
    };
    fr.readAsText(file);
  }

  function readProjectFile(file) {
    var fr = new FileReader();
    fr.onload = function () {
      try {
        var obj = JSON.parse(fr.result);
        store.setProject(obj.project || obj);
        ui.selectedPileId = null;
        ui.selectedSampleId = null;
        renderAll();
        fit();
        toast('Project opened.');
      } catch (e) {
        toast('That file could not be read as a project.', true);
      }
    };
    fr.readAsText(file);
  }

  /* ===================== Panels ===================== */

  function switchTab(name) {
    document.querySelectorAll('.tab').forEach(function (t) { t.classList.toggle('is-active', t.dataset.tab === name); });
    document.querySelectorAll('.pane').forEach(function (p) { p.classList.toggle('is-active', p.dataset.pane === name); });
    if (window.matchMedia('(max-width: 820px)').matches) openPanel(true);
  }

  function openPanel(open) {
    ui.panelOpen = open;
    el.panel.classList.toggle('is-open', open);
  }

  function selectPile(id) {
    ui.selectedPileId = id;
    if (id) ui.selectedSampleId = null;
    renderPiles();
    requestDraw();
    if (id) switchTab('piles');
  }

  function selectSample(id) {
    ui.selectedSampleId = id;
    if (id) ui.selectedPileId = null;
    renderSamples();
    requestDraw();
    if (id) switchTab('samples');
  }

  function renderAll() {
    renderSetup();
    renderPiles();
    renderSamples();
    renderPlan();
    renderExportHints();
    updateCounts();
    updateStatusZoom();
    requestDraw();
  }

  function afterChange() {
    renderAll();
    store.saveLocal();
  }

  function updateCounts() {
    el.countPiles.textContent = S.project.stockpiles.length;
    el.countSamples.textContent = S.project.samples.length;
    var t = store.totals();
    el.stTally.textContent = t.piles + ' piles · ' + t.primary + '/' + (t.required || 0) + ' locations · ' + t.labSamples + ' lab';
    el.btnUndo.disabled = !store.canUndo();
    el.btnRedo.disabled = !store.canRedo();
  }

  /* ---- Setup ---- */
  function renderSetup() {
    var p = S.project, g = p.georef;
    if (document.activeElement !== el.fName) el.fName.value = p.name || '';
    if (document.activeElement !== el.fClient) el.fClient.value = p.client || '';
    if (document.activeElement !== el.fJobRef) el.fJobRef.value = p.jobRef || '';
    if (document.activeElement !== el.fBy) el.fBy.value = p.preparedBy || '';
    if (document.activeElement !== el.fDate) el.fDate.value = p.plannedDate || '';
    if (document.activeElement !== el.fMppx) el.fMppx.value = g.mppx != null ? g.mppx : '';

    el.imgStat.textContent = p.image
      ? p.image.name + ' — ' + p.image.width + ' × ' + p.image.height + ' px (' +
        (p.image.width * p.image.height / 1e6).toFixed(1) + ' MP)'
      : 'No image loaded';

    var state = el.georefState;
    if (!geo.hasScale(g)) {
      state.className = 'georef-state is-warn';
      state.innerHTML = '<strong>No scale set.</strong> Areas, volumes and sample counts cannot be ' +
        'calculated until you set metres per pixel.';
    } else if (geo.isAbsolute(g)) {
      var c = geo.pixelToGround(g, (p.image ? p.image.width : 0) / 2, (p.image ? p.image.height : 0) / 2, p.image ? p.image.height : 0);
      var ll = geo.groundToLatLon(g, c.x, c.y);
      state.className = 'georef-state is-ok';
      state.innerHTML = '<strong>Georeferenced — ' + esc(g.crs) + ' (NZTM2000).</strong><br>' +
        '<code>' + g.mppx.toFixed(4) + ' m/px</code> from ' + esc(g.source) + '.<br>' +
        'Centre of image <code>' + geo.fmtCoord(c.x) + ' mE, ' + geo.fmtCoord(c.y) + ' mN</code>' +
        (ll ? '<br><code>' + geo.fmtLatLon(ll.lat) + ', ' + geo.fmtLatLon(ll.lon) + '</code>' : '');
    } else {
      state.className = 'georef-state';
      state.innerHTML = '<strong>Scaled, not positioned.</strong> <code>' + g.mppx.toFixed(4) + ' m/px</code> from ' +
        esc(g.source) + '. Distances, areas and volumes are correct; exports carry a local grid ' +
        'rather than NZTM coordinates. Pin a known coordinate to fix that.';
    }

    document.querySelectorAll('#interpMode .seg-btn').forEach(function (b) {
      b.classList.toggle('is-active', b.dataset.interp === (p.settings.interpolation || 'crisp'));
    });

    el.scaleChip.classList.toggle('is-set', geo.hasScale(g));
    el.scaleChipText.textContent = geo.hasScale(g)
      ? (geo.isAbsolute(g) ? 'NZTM · ' : '') + g.mppx.toFixed(3) + ' m/px'
      : 'No scale set';
  }

  /* ---- Piles ---- */
  function renderPiles() {
    var p = S.project, list = el.pileList;
    list.innerHTML = '';

    if (!p.stockpiles.length) {
      list.innerHTML = '<div class="list-empty">No stockpiles yet. Pick the Stockpile tool and click around one.</div>';
    }

    p.stockpiles.forEach(function (pile) {
      var st = store.pileStats(pile);
      var tagCls = 'row-tag', tagTxt;
      if (st.required == null) { tagTxt = '—'; }
      else if (st.shortfall > 0) { tagCls += ' is-warn'; tagTxt = st.placed + '/' + st.required; }
      else { tagCls += ' is-ok'; tagTxt = st.placed + '/' + st.required; }

      var b = document.createElement('div');
      b.className = 'row' + (ui.selectedPileId === pile.id ? ' is-active' : '');
      b.setAttribute('role', 'button');
      b.tabIndex = 0;
      b.innerHTML =
        '<span class="row-swatch" style="background:' + esc(pile.color) + '"></span>' +
        '<span class="row-main"><span class="row-name">' + esc(pile.name) + '</span>' +
        '<span class="row-meta">' + (st.areaM2 != null ? geo.fmtArea(st.areaM2) : 'no scale') +
        (st.volume != null ? ' · ' + geo.fmtVol(st.volume) : '') + '</span></span>' +
        '<span class="' + tagCls + '">' + tagTxt + '</span>' +
        renameButton('Rename ' + pile.name);

      function open() {
        selectPile(pile.id);
        var c = geom.centroid(pile.polygon);
        zoomTo(c[0], c[1], view.scale);
      }
      b.addEventListener('click', open);
      b.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      });
      b.querySelector('.row-edit').addEventListener('click', function (e) {
        e.stopPropagation();
        open();
        focusRename();
      });
      list.appendChild(b);
    });

    renderPileEditor();
  }

  function renderPileEditor() {
    var box = el.pileEditor;
    var pile = store.pileById(ui.selectedPileId);
    if (!pile) {
      box.hidden = !S.project.stockpiles.length;
      box.innerHTML = '<div class="list-empty">Pick a stockpile above, or click one on the map, to ' +
        'rename it, set its height and auto-place sample locations.</div>';
      return;
    }
    box.hidden = false;
    var st = store.pileStats(pile);
    var isCustom = pile.formId === 'custom';
    var asComposite = S.project.settings.autoType === 'composite';

    box.innerHTML =
      '<div class="group-head"><h3 class="group-title">' + esc(pile.name) + '</h3>' +
      '<button class="btn btn-sm btn-danger" data-act="del">Delete</button></div>' +

      '<div class="field-row">' +
        '<label class="field"><span>Name</span><input data-f="name" type="text" value="' + esc(pile.name) + '"></label>' +
        '<label class="field"><span>Material</span><input data-f="material" type="text" value="' + esc(pile.material) + '" placeholder="e.g. excavated soil"></label>' +
      '</div>' +

      '<div class="field-row">' +
        '<label class="field"><span>Mean height (m)</span><input data-f="heightM" type="number" step="0.1" min="0" value="' + esc(pile.heightM) + '"></label>' +
        '<label class="field"><span>Pile form</span><select data-f="formId">' +
          plan.FORMS.map(function (f) {
            return '<option value="' + f.id + '"' + (f.id === pile.formId ? ' selected' : '') + '>' + esc(f.name) + '</option>';
          }).join('') + '</select></label>' +
      '</div>' +

      (isCustom ? '<label class="field"><span>Custom form factor (volume ÷ area × height)</span>' +
        '<input data-f="customFactor" type="number" step="0.05" min="0.05" max="1" value="' + esc(pile.customFactor) + '"></label>' : '') +

      '<div class="summary">' +
        tile('Footprint', st.areaM2 != null ? geo.fmtArea(st.areaM2) : '—', st.perimM != null ? geo.fmtLen(st.perimM) + ' perimeter' : '') +
        tile('Volume', st.volume != null ? geo.fmtVol(st.volume) : '—',
          pile.volumeOverride ? 'entered directly' : (isCustom ? 'factor ' + pile.customFactor : 'factor ' + plan.formById(pile.formId).factor)) +
        tile('Required', st.required != null ? st.required : '—', 'by the active rule',
          st.shortfall > 0 ? 'is-warn' : 'is-ok') +
        tile('Placed', st.placed + (st.qaPlaced ? ' + ' + st.qaPlaced + ' QA' : ''),
          st.shortfall > 0 ? st.shortfall + ' short' : 'complete', st.shortfall > 0 ? 'is-warn' : 'is-ok') +
      '</div>' +

      '<div class="field-row">' +
        '<label class="field"><span>Volume override (m³)</span><input data-f="volumeOverride" type="number" step="1" min="0" value="' + (pile.volumeOverride == null ? '' : esc(pile.volumeOverride)) + '" placeholder="calculated"></label>' +
        '<label class="field"><span>Required override</span><input data-f="requiredOverride" type="number" step="1" min="0" value="' + (pile.requiredOverride == null ? '' : esc(pile.requiredOverride)) + '" placeholder="' + (st.required == null ? 'auto' : st.required) + '"></label>' +
      '</div>' +

      '<label class="field"><span>Notes</span><textarea data-f="notes" placeholder="Access, odour, staining, material description…">' + esc(pile.notes) + '</textarea></label>' +

      '<div class="divider"></div>' +
      '<label class="field"><span>Auto-place locations</span><select data-f="method">' +
        '<option value="systematic"' + (S.project.settings.method === 'systematic' ? ' selected' : '') + '>Systematic grid</option>' +
        '<option value="stratified"' + (S.project.settings.method === 'stratified' ? ' selected' : '') + '>Stratified random</option>' +
        '<option value="random"' + (S.project.settings.method === 'random' ? ' selected' : '') + '>Simple random</option>' +
      '</select></label>' +
      '<div class="seg seg-wide" role="group" aria-label="Sample form">' +
        '<button class="seg-btn' + (asComposite ? '' : ' is-active') + '" data-autotype="discrete" type="button">Discrete</button>' +
        '<button class="seg-btn' + (asComposite ? ' is-active' : '') + '" data-autotype="composite" type="button">Composite</button>' +
      '</div>' +
      (asComposite
        ? '<label class="field"><span>Increments per composite</span>' +
          '<input data-f="incPerComposite" type="number" min="2" max="40" step="1" value="' +
          esc(S.project.settings.incPerComposite) + '"></label>'
        : '') +
      '<div class="btn-row">' +
        '<button class="btn btn-block btn-primary" data-act="auto">Place ' +
          (st.required != null ? st.required : 'n') +
          (asComposite ? ' composites' : ' locations') + '</button>' +
        '<button class="btn btn-sm" data-act="clear">Clear</button>' +
      '</div>' +
      '<p class="hint">Replaces the locations already in this stockpile. Points are kept ' +
        esc(S.project.settings.insetM) + ' m clear of the toe.' +
        (asComposite
          ? ' The pile is split into sections along its longest axis, one composite per section, ' +
            'so a result can still be traced to part of the pile.'
          : '') + '</p>';

    box.querySelectorAll('[data-f]').forEach(function (input) {
      input.addEventListener('change', function () {
        store.checkpoint();
        var k = input.dataset.f, v = input.value;
        if (k === 'method') { S.project.settings.method = v; afterChange(); return; }
        if (k === 'incPerComposite') {
          S.project.settings.incPerComposite = Math.max(2, Math.min(40, parseInt(v, 10) || 5));
          afterChange(); return;
        }
        if (k === 'volumeOverride' || k === 'requiredOverride') {
          pile[k] = v === '' ? null : parseFloat(v);
        } else if (k === 'heightM' || k === 'customFactor') {
          pile[k] = parseFloat(v);
        } else {
          pile[k] = v;
        }
        if (k === 'name') { pile.nameLocked = true; store.recode(); }
        afterChange();
      });
    });

    box.querySelector('[data-act="del"]').addEventListener('click', function () {
      store.checkpoint();
      store.removePile(pile.id);
      ui.selectedPileId = null;
      store.recode();
      afterChange();
      toast(pile.name + ' deleted.');
    });
    box.querySelectorAll('[data-autotype]').forEach(function (b) {
      b.addEventListener('click', function () {
        S.project.settings.autoType = b.dataset.autotype;
        store.saveLocal();
        renderPiles();
      });
    });
    box.querySelector('[data-act="auto"]').addEventListener('click', function () { autoPlace(pile); });
    box.querySelector('[data-act="clear"]').addEventListener('click', function () {
      store.checkpoint();
      S.project.samples = S.project.samples.filter(function (s) { return s.stockpileId !== pile.id; });
      store.recode();
      afterChange();
    });
  }

  /* A composite is one laboratory sample with one id, taken from several
   * spots. This block is where those spots get marked. */
  function compositeBlock(s) {
    var marked = (s.incPts || []).length;
    var out = '<div class="georef-state' + (marked > 1 ? ' is-ok' : '') + '">' +
      '<strong>Composite \u2014 one sample, one ID.</strong><br>' +
      (marked > 1
        ? marked + ' increment' + (marked === 1 ? '' : 's') + ' marked on the photo. ' +
          'The marker sits at their centre, and that is the position exported for ' +
          esc(s.code) + '.'
        : 'No increment spots marked yet, so the schedule will simply record the count you type.') +
      '</div>';

    if (marked <= 1) {
      out += '<label class="field"><span>Increments combined</span>' +
        '<input data-f="increments" type="number" min="2" step="1" value="' + esc(s.increments) + '"></label>';
    }

    out += '<div class="btn-row">' +
      '<button class="btn btn-sm btn-block btn-primary" data-act="markinc">' +
        (marked > 1 ? 'Mark more increments' : 'Mark increments on the map') + '</button>' +
      (marked > 1
        ? '<button class="btn btn-sm" data-act="incundo">Remove last</button>' +
          '<button class="btn btn-sm" data-act="incclear">Clear</button>'
        : '') +
      '</div>';
    return out;
  }

  function renameButton(label) {
    return '<button class="row-edit" type="button" title="Rename (F2)" aria-label="' + esc(label) + '">' +
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16Zm12.5-16.5 4 4" ' +
      'fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
      '</button>';
  }

  /** Put the cursor in the name/ID box of whatever is selected. */
  function focusRename() {
    var node = null;
    if (ui.selectedSampleId) node = document.querySelector('#sampleEditor [data-f="code"]');
    else if (ui.selectedPileId) node = document.querySelector('#pileEditor [data-f="name"]');
    if (!node) return false;
    node.focus();
    node.select();
    return true;
  }

  function tile(k, v, sub, cls) {
    return '<div class="stat ' + (cls || '') + '"><span class="stat-k">' + esc(k) + '</span>' +
      '<span class="stat-v">' + esc(v) + '</span>' +
      (sub ? '<span class="stat-sub">' + esc(sub) + '</span>' : '') + '</div>';
  }

  function autoPlace(pile) {
    var st = store.pileStats(pile);
    var n = st.required;
    if (n == null) { toast('Set the scale and a pile height first — the count comes from the volume.', true); return; }
    var g = S.project.georef;
    var insetPx = geo.hasScale(g) ? (S.project.settings.insetM / g.mppx) : 2;
    var set = S.project.settings;
    var seed = Date.now() % 100000;
    var composite = set.autoType === 'composite';
    var k = composite ? Math.max(2, Math.min(40, Math.round(set.incPerComposite) || 5)) : 1;

    var pts = geom.generate(set.method, pile.polygon, n * k, insetPx, seed);
    if (!pts.length) {
      toast('No room inside that outline for the inset. Reduce it in Plan settings.', true);
      return;
    }

    store.checkpoint();
    S.project.samples = S.project.samples.filter(function (s) { return s.stockpileId !== pile.id; });

    if (!composite) {
      pts.forEach(function (pt) {
        store.addSample(pt[0], pt[1], { stockpileId: pile.id, type: 'discrete' });
      });
      store.recode();
      afterChange();
      toast(pts.length + ' locations placed in ' + pile.name +
        (pts.length < n ? ' (' + (n - pts.length) + ' would not fit)' : '') + '.');
      return;
    }

    // Split the pile into n sections along its longest axis and build one
    // composite per section. Interleaving the increments instead would make
    // every composite cover the whole pile -- n replicates of the same answer,
    // with no way to tell which end a result came from.
    var bb = geom.bbox(pile.polygon);
    var alongX = bb.w >= bb.h;
    var sorted = pts.slice().sort(function (a, b) {
      return alongX ? (a[0] - b[0]) || (a[1] - b[1]) : (a[1] - b[1]) || (a[0] - b[0]);
    });
    var groups = [];
    for (var i = 0; i < n; i++) {
      groups.push(sorted.slice(
        Math.floor(i * sorted.length / n),
        Math.floor((i + 1) * sorted.length / n)
      ));
    }

    var made = 0;
    groups.forEach(function (g) {
      if (!g.length) return;
      var smp = store.addSample(g[0][0], g[0][1], {
        stockpileId: pile.id, type: 'composite', incPts: g.length > 1 ? g : []
      });
      smp.increments = g.length;
      store.syncComposite(smp);
      made++;
    });
    store.recode();
    afterChange();
    toast(made + ' composite sample' + (made === 1 ? '' : 's') + ' in ' + pile.name +
      ', ' + k + ' increments each \u2014 ' + pts.length + ' spots to visit.');

  }

  /* ---- Samples ---- */
  function renderSamples() {
    var p = S.project, list = el.sampleList;
    list.innerHTML = '';
    var items = p.samples.filter(function (s) {
      if (ui.sampleFilter === 'planned') return s.status === 'planned';
      if (ui.sampleFilter === 'skipped') return s.status === 'skipped';
      if (ui.sampleFilter === 'collected') return s.status === 'collected';
      if (ui.sampleFilter === 'qa') return s.type === 'duplicate' || s.type === 'split';
      return true;
    });
    items.sort(function (a, b) { return String(a.code).localeCompare(String(b.code), 'en', { numeric: true }); });

    if (!items.length) {
      list.innerHTML = '<div class="list-empty">No sample locations in this view.</div>';
    }

    items.forEach(function (s) {
      var t = plan.typeById(s.type);
      var pile = store.pileById(s.stockpileId);
      var b = document.createElement('div');
      b.className = 'row' + (ui.selectedSampleId === s.id ? ' is-active' : '');
      b.setAttribute('role', 'button');
      b.tabIndex = 0;
      b.innerHTML =
        '<span class="row-dot" style="border-color:' + esc(t.color) + ';background:' +
          (s.status === 'collected' ? esc(t.color) : 'transparent') + '"></span>' +
        '<span class="row-main"><span class="row-name">' + esc(s.code || '(unnumbered)') +
          (s.codeLocked ? '<span class="row-pin" title="Custom ID, kept when renumbering">\u2022</span>' : '') +
        '</span>' +
        '<span class="row-meta">' + esc(pile ? pile.name : 'off-pile') + ' · ' + esc(t.name) +
        (s.type === 'composite' ? ' \u00D7' + plan.incrementCount(s) : '') +
        ' · ' + esc(s.depthFrom) + '–' + esc(s.depthTo) + ' m</span></span>' +
        '<span class="row-tag' + (s.status === 'collected' ? ' is-ok' : '') + '">' + esc(s.status) + '</span>' +
        renameButton('Rename ' + (s.code || 'sample'));

      function open() {
        selectSample(s.id);
        zoomTo(s.px, s.py, Math.max(view.scale, 3));
      }
      b.addEventListener('click', open);
      b.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      });
      b.querySelector('.row-edit').addEventListener('click', function (e) {
        e.stopPropagation();
        open();
        focusRename();
      });
      list.appendChild(b);
    });

    renderSampleEditor();
  }

  function renderSampleEditor() {
    var box = el.sampleEditor;
    var s = store.sampleById(ui.selectedSampleId);
    if (!s) {
      box.hidden = !S.project.samples.length;
      box.innerHTML = '<div class="list-empty">Pick a location above, or click a marker on the map, ' +
        'to change its ID, type, depth and status.</div>';
      return;
    }
    box.hidden = false;

    var g = S.project.georef;
    var ground = S.image ? geo.pixelToGround(g, s.px, s.py, S.image.height) : { x: s.px, y: s.py };
    var ll = geo.isAbsolute(g) ? geo.groundToLatLon(g, ground.x, ground.y) : null;

    box.innerHTML =
      '<div class="group-head"><h3 class="group-title">' + esc(s.code || 'Sample') + '</h3>' +
      '<button class="btn btn-sm btn-danger" data-act="del">Delete</button></div>' +

      '<div class="field-row">' +
        '<label class="field"><span>ID</span><input data-f="code" type="text" value="' + esc(s.code) + '"></label>' +
        '<label class="field"><span>Stockpile</span><select data-f="stockpileId">' +
          '<option value="">— off-pile —</option>' +
          S.project.stockpiles.map(function (pl) {
            return '<option value="' + esc(pl.id) + '"' + (pl.id === s.stockpileId ? ' selected' : '') + '>' + esc(pl.name) + '</option>';
          }).join('') + '</select></label>' +
      '</div>' +

      '<div class="field-row">' +
        '<label class="field"><span>Type</span><select data-f="type">' +
          plan.SAMPLE_TYPES.map(function (t) {
            return '<option value="' + t.id + '"' + (t.id === s.type ? ' selected' : '') + '>' + esc(t.name) + '</option>';
          }).join('') + '</select></label>' +
        '<label class="field"><span>Status</span><select data-f="status">' +
          ['planned', 'collected', 'skipped'].map(function (v) {
            return '<option value="' + v + '"' + (v === s.status ? ' selected' : '') + '>' + v + '</option>';
          }).join('') + '</select></label>' +
      '</div>' +

      (s.type === 'composite' ? compositeBlock(s) : '') +

      '<div class="field-row">' +
        '<label class="field"><span>Depth from (m)</span><input data-f="depthFrom" type="number" step="0.1" min="0" value="' + esc(s.depthFrom) + '"></label>' +
        '<label class="field"><span>Depth to (m)</span><input data-f="depthTo" type="number" step="0.1" min="0" value="' + esc(s.depthTo) + '"></label>' +
      '</div>' +

      '<div class="field-row">' +
        '<label class="field"><span>Matrix</span><input data-f="matrix" type="text" value="' + esc(s.matrix) + '"></label>' +
        '<label class="field"><span>Collected</span><input data-f="collectedDate" type="date" value="' + esc(s.collectedDate) + '"></label>' +
      '</div>' +

      '<label class="field"><span>Notes</span><textarea data-f="notes">' + esc(s.notes) + '</textarea></label>' +

      '<div class="georef-state"><code>' +
        (ll
          ? geo.fmtCoord(ground.x) + ' mE, ' + geo.fmtCoord(ground.y) + ' mN<br>' +
            geo.fmtLatLon(ll.lat) + ', ' + geo.fmtLatLon(ll.lon)
          : (geo.hasScale(g)
            ? 'local ' + geo.fmtCoord(ground.x) + ', ' + geo.fmtCoord(ground.y) + ' m'
            : 'pixel ' + s.px.toFixed(0) + ', ' + s.py.toFixed(0))) +
      '</code></div>' +

      (s.codeLocked
        ? '<button class="btn btn-sm btn-block" data-act="unlock">Return ' + esc(s.code) +
          ' to automatic numbering</button>'
        : '') +

      '<div class="btn-row">' +
        '<button class="btn btn-block" data-act="dup">Add field duplicate here</button>' +
      '</div>';

    box.querySelectorAll('[data-f]').forEach(function (input) {
      input.addEventListener('change', function () {
        store.checkpoint();
        var k = input.dataset.f, v = input.value;
        if (k === 'code') { s.code = v; s.codeLocked = true; }
        else if (k === 'stockpileId') { s.stockpileId = v || null; store.recode(); }
        else if (k === 'depthFrom' || k === 'depthTo' || k === 'increments') s[k] = parseFloat(v);
        else { s[k] = v; if (k === 'type') store.recode(); }
        afterChange();
      });
    });

    box.querySelector('[data-act="del"]').addEventListener('click', function () {
      store.checkpoint();
      store.removeSample(s.id);
      ui.selectedSampleId = null;
      store.recode();
      afterChange();
    });

    var mark = box.querySelector('[data-act="markinc"]');
    if (mark) mark.addEventListener('click', function () {
      if (!S.image) { toast('Load an aerial image first.', true); return; }
      ui.pending = 'increments';
      ui.incTarget = s.id;
      setToolSilently('select');
      updateHud();
      requestDraw();
      if (window.matchMedia('(max-width: 820px)').matches) openPanel(false);
    });

    var incUndo = box.querySelector('[data-act="incundo"]');
    if (incUndo) incUndo.addEventListener('click', function () {
      store.checkpoint();
      store.removeIncrement(s, s.incPts.length - 1);
      afterChange();
    });

    var incClear = box.querySelector('[data-act="incclear"]');
    if (incClear) incClear.addEventListener('click', function () {
      store.checkpoint();
      s.incPts = [];
      afterChange();
      toast('Increment spots cleared. ' + esc(s.code) + ' is a single point again.');
    });

    var unlock = box.querySelector('[data-act="unlock"]');
    if (unlock) unlock.addEventListener('click', function () {
      store.checkpoint();
      s.codeLocked = false;
      store.recode();
      afterChange();
      toast('Back to automatic numbering.');
    });

    box.querySelector('[data-act="dup"]').addEventListener('click', function () {
      store.checkpoint();
      // A field duplicate is co-located: offset only enough to stay clickable.
      var off = 6 / Math.max(view.scale, 0.5);
      var d = store.addSample(s.px + off, s.py + off, { stockpileId: s.stockpileId, type: 'duplicate' });
      d.depthFrom = s.depthFrom; d.depthTo = s.depthTo; d.matrix = s.matrix;
      d.notes = 'Field duplicate of ' + s.code;
      store.recode();
      ui.selectedSampleId = d.id;
      afterChange();
      toast('Field duplicate added at ' + s.code + '.');
    });
  }

  /* ---- Plan ---- */
  function renderPlan() {
    var p = S.project, r = p.rule;

    document.querySelectorAll('#ruleMode .seg-btn').forEach(function (b) {
      b.classList.toggle('is-active', b.dataset.mode === r.mode);
    });
    el.ruleRate.hidden = r.mode !== 'rate';
    el.ruleBanded.hidden = r.mode !== 'banded';
    el.ruleFixed.hidden = r.mode !== 'fixed';

    setVal(el.fPerCubic, r.rate.perCubic);
    setVal(el.fMinPer, r.rate.min);
    setVal(el.fPerExtra, r.banded.perExtra);
    setVal(el.fFixed, r.fixed);
    setVal(el.fDupEvery, p.qa.dupEvery);
    setVal(el.fSplitEvery, p.qa.splitEvery);
    setVal(el.fBlanks, p.qa.blanks);
    setVal(el.fPrefix, p.settings.idPrefix);
    setVal(el.fPad, p.settings.pad);
    setVal(el.fPilePrefix, p.settings.pilePrefix);
    setVal(el.fPilePad, p.settings.pilePad);
    setVal(el.fPileStart, p.settings.pileStart);
    setVal(el.fNamingOrder, p.settings.namingOrder || 'northSouth');
    el.pileOrderHint.textContent =
      'New outlines take the next free number automatically. Renumbering runs in ' +
      store.describeNamingOrder() + ', and keeps any name you typed yourself.';
    renderNamingPreview();

    document.querySelectorAll('#idScope .seg-btn').forEach(function (b) {
      b.classList.toggle('is-active', b.dataset.scope === p.settings.idScope);
    });

    // Bands
    el.bandRows.innerHTML = '';
    r.banded.bands.slice().sort(function (a, b) { return a.upTo - b.upTo; }).forEach(function (band, i) {
      var tr = document.createElement('tr');
      tr.innerHTML =
        '<td><input type="number" min="1" step="1" data-band="upTo" data-i="' + i + '" value="' + esc(band.upTo) + '"></td>' +
        '<td><input type="number" min="1" step="1" data-band="samples" data-i="' + i + '" value="' + esc(band.samples) + '"></td>' +
        '<td><button class="x" type="button" data-band-del="' + i + '" aria-label="Remove band">×</button></td>';
      el.bandRows.appendChild(tr);
    });
    el.bandRows.querySelectorAll('[data-band]').forEach(function (inp) {
      inp.addEventListener('change', function () {
        store.checkpoint();
        var sorted = r.banded.bands.slice().sort(function (a, b) { return a.upTo - b.upTo; });
        var v = parseFloat(inp.value);
        if (isFinite(v) && v > 0) sorted[+inp.dataset.i][inp.dataset.band] = v;
        r.banded.bands = sorted;
        afterChange();
      });
    });
    el.bandRows.querySelectorAll('[data-band-del]').forEach(function (b) {
      b.addEventListener('click', function () {
        store.checkpoint();
        var sorted = r.banded.bands.slice().sort(function (a, x) { return a.upTo - x.upTo; });
        sorted.splice(+b.dataset.bandDel, 1);
        r.banded.bands = sorted;
        afterChange();
      });
    });

    el.ruleReadout.textContent = plan.describeRule(r);

    // Summary
    var t = store.totals();
    el.summary.innerHTML =
      tile('Stockpiles', t.piles, t.areaM2 ? geo.fmtArea(t.areaM2) + ' total footprint' : '') +
      tile('Volume', t.volume != null ? geo.fmtVol(t.volume) : '—', 'in situ, estimated') +
      tile('Locations required', t.required || '—', plan.describeRule(r).slice(0, 40)) +
      tile('Locations planned', t.primary, t.collected + ' collected',
        t.required && t.primary < t.required ? 'is-warn' : 'is-ok') +
      tile('QA/QC due', t.qaRequired.total,
        t.qaRequired.duplicates + ' dup · ' + t.qaRequired.splits + ' split · ' + t.qaRequired.blanks + ' blank',
        t.qaPlaced >= t.qaRequired.duplicates + t.qaRequired.splits ? 'is-ok' : 'is-warn') +
      tile('QA/QC placed', t.qaPlaced, 'on the map') +
      tile('Laboratory samples', t.labSamples,
        t.visits > t.primary + t.qaPlaced
          ? 'primary + QA/QC · ' + t.visits + ' spots to visit on site'
          : 'primary + QA/QC', 'is-wide');

    // Shortfalls
    var short = [];
    p.stockpiles.forEach(function (pile) {
      var st = store.pileStats(pile);
      if (st.shortfall > 0) short.push({ name: pile.name, n: st.shortfall });
    });
    if (!p.stockpiles.length) {
      el.shortfall.innerHTML = '<div class="list-empty">Draw a stockpile to see what the rule requires.</div>';
    } else if (!short.length) {
      el.shortfall.innerHTML = '<div class="short-ok">Every stockpile has the locations the rule requires.</div>';
    } else {
      el.shortfall.innerHTML = short.map(function (x) {
        return '<div class="short-row"><span>' + esc(x.name) + '</span><b>' + x.n + ' short</b></div>';
      }).join('');
    }
  }

  function setVal(node, v) {
    if (node && document.activeElement !== node) node.value = v;
  }

  /* Show what the current convention produces, from the live field values so
   * the preview tracks typing rather than the last committed setting. */
  function renderNamingPreview() {
    var p = S.project, st = p.settings;
    var prefix = el.fPilePrefix.value !== '' ? el.fPilePrefix.value : (st.pilePrefix || '');
    var pad = Math.max(1, Math.min(4, parseInt(el.fPilePad.value, 10) || st.pilePad || 1));
    var start = parseInt(el.fPileStart.value, 10);
    if (!isFinite(start)) start = isFinite(st.pileStart) ? st.pileStart : 1;

    function pileName(n) { return prefix + String(n).padStart(pad, '0'); }
    var names = [pileName(start), pileName(start + 1), pileName(start + 2)];
    el.pilePreview.innerHTML = '<b>' + names.map(esc).join('</b> · <b>') + '</b> · …';

    var sPrefix = el.fPrefix.value !== '' ? el.fPrefix.value : (st.idPrefix || '');
    var sPad = Math.max(1, Math.min(4, parseInt(el.fPad.value, 10) || st.pad || 1));
    var out;
    if (st.idScope === 'pile') {
      var first = p.stockpiles.length ? p.stockpiles[0].name : pileName(start);
      out = [1, 2].map(function (n) { return first + '-' + String(n).padStart(sPad, '0'); });
      out.push(pileName(start + 1) + '-' + String(1).padStart(sPad, '0'));
    } else {
      out = [1, 2, 3].map(function (n) { return sPrefix + String(n).padStart(sPad, '0'); });
    }
    el.samplePreview.innerHTML = '<b>' + out.map(esc).join('</b> · <b>') + '</b> · …';
  }

  function renderExportHints() {
    var g = S.project.georef;
    el.gisHint.textContent = geo.isAbsolute(g)
      ? 'Coordinates are projected from ' + g.crs + ' to WGS84 longitude/latitude, which is what GeoJSON and KML require.'
      : 'Not georeferenced — GeoJSON falls back to a local metre grid and KML is unavailable. Pin a known coordinate in Setup to enable them.';
  }

  /* ===================== Status ===================== */

  function updateStatusCoord(p) {
    var g = S.project.georef;
    if (!S.image) { el.stCoord.textContent = '—'; return; }
    var ground = geo.pixelToGround(g, p[0], p[1], S.image.height);
    if (geo.isAbsolute(g)) {
      var ll = geo.groundToLatLon(g, ground.x, ground.y);
      el.stCoord.textContent = geo.fmtCoord(ground.x) + ' mE  ' + geo.fmtCoord(ground.y) + ' mN' +
        (ll ? '   ' + geo.fmtLatLon(ll.lat) + ', ' + geo.fmtLatLon(ll.lon) : '');
    } else if (geo.hasScale(g)) {
      el.stCoord.textContent = geo.fmtCoord(ground.x) + ', ' + geo.fmtCoord(ground.y) + ' m (local)';
    } else {
      el.stCoord.textContent = p[0].toFixed(0) + ', ' + p[1].toFixed(0) + ' px';
    }
  }

  function updateStatusZoom() {
    var g = S.project.georef;
    var txt = Math.round(view.scale * 100) + '%';
    if (geo.hasScale(g)) txt += '  ·  1 screen px = ' + (g.mppx / view.scale * 1000).toFixed(0) + ' mm';
    el.stZoom.textContent = txt;
  }

  var toastTimer;
  function toast(msg, isErr) {
    el.toast.textContent = msg;
    el.toast.classList.toggle('is-err', !!isErr);
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.hidden = true; }, isErr ? 5200 : 3200);
  }

  /* ===================== Exports ===================== */

  function exportText(kind) {
    var p = S.project;
    var imgH = S.image ? S.image.height : 0;
    if (kind === 'samples-csv') return { text: ASM.exporter.samplesCSV(p, imgH), name: ASM.exporter.slug(p.name) + '-samples.csv', mime: 'text/csv' };
    if (kind === 'increments-csv') return { text: ASM.exporter.incrementsCSV(p, imgH), name: ASM.exporter.slug(p.name) + '-increments.csv', mime: 'text/csv' };
    if (kind === 'piles-csv') return { text: ASM.exporter.pilesCSV(p), name: ASM.exporter.slug(p.name) + '-stockpiles.csv', mime: 'text/csv' };
    if (kind === 'geojson') return { text: ASM.exporter.geojson(p, imgH), name: ASM.exporter.slug(p.name) + '.geojson', mime: 'application/geo+json', altExt: 'json' };
    if (kind === 'kml') {
      var k = ASM.exporter.kml(p, imgH);
      return k ? { text: k, name: ASM.exporter.slug(p.name) + '.kml', mime: 'application/vnd.google-earth.kml+xml', altExt: 'txt' } : null;
    }
    if (kind === 'project') return { text: ASM.exporter.projectJSON(), name: ASM.exporter.slug(p.name) + '.json', mime: 'application/json' };
    return null;
  }

  function doExport(kind) {
    if (kind === 'figure') {
      if (!S.image) { toast('Load an aerial image first.', true); return; }
      toast('Drawing the figure…');
      ASM.exporter.figurePNG({ width: parseInt(el.fFigW.value, 10) || 2400 }).then(function (blob) {
        return ASM.exporter.saveFile(ASM.exporter.slug(S.project.name) + '-figure.png', blob, 'image/png');
      }).then(function (res) {
        toast(res.ok ? 'Figure saved.' : (res.message || 'Not saved.'), !res.ok);
      });
      return;
    }
    if (kind === 'increments-csv' && !hasMarkedIncrements()) {
      toast('No composite has its increment spots marked yet — set a sample to Composite and use "Mark increments on the map".', true);
      return;
    }
    var out = exportText(kind);
    if (!out) { toast('Georeference the image first — KML needs real coordinates.', true); return; }
    if (!S.project.samples.length && kind !== 'project') toast('Nothing placed yet, exporting an empty schedule.');
    ASM.exporter.saveFile(out.name, out.text, out.mime, out.altExt).then(function (res) {
      if (!res.ok) { toast(res.message || 'Not saved.', true); return; }
      toast(res.name !== out.name
        ? 'Saved as ' + res.name + ' — rename it to ' + out.name.split('.').pop() + ' if your software needs that.'
        : out.name + ' saved.');
    });
  }

  function hasMarkedIncrements() {
    return S.project.samples.some(function (s) { return s.incPts && s.incPts.length > 1; });
  }

  function doCopy(kind) {
    if (kind === 'increments-csv' && !hasMarkedIncrements()) {
      toast('No composite has its increment spots marked yet.', true);
      return;
    }
    var out = exportText(kind);
    if (!out) { toast('Georeference the image first — KML needs real coordinates.', true); return; }
    ASM.exporter.copyText(out.text).then(function (ok) {
      toast(ok ? 'Copied to the clipboard.' : 'Could not reach the clipboard.', !ok);
    });
  }

  /* ===================== Wiring ===================== */

  function bind() {
    ['stage', 'dropzone', 'hudTool', 'panel', 'toast', 'imgStat', 'georefState',
     'scaleChip', 'scaleChipText', 'pileList', 'pileEditor', 'sampleList', 'sampleEditor',
     'countPiles', 'countSamples', 'summary', 'shortfall', 'ruleReadout', 'bandRows',
     'ruleRate', 'ruleBanded', 'ruleFixed', 'gisHint', 'stCoord', 'stZoom', 'stHint', 'stTally',
     'fName', 'fClient', 'fJobRef', 'fBy', 'fDate', 'fMppx', 'fAnchorE', 'fAnchorN',
     'fPerCubic', 'fMinPer', 'fPerExtra', 'fFixed', 'fDupEvery', 'fSplitEvery', 'fBlanks',
     'fPrefix', 'fPad', 'fPilePrefix', 'fPilePad', 'fPileStart', 'fNamingOrder', 'pileOrderHint',
     'pilePreview', 'samplePreview', 'fFigW', 'fileImage', 'fileProject', 'fileWorld',
     'btnUndo', 'btnRedo'
    ].forEach(function (id) { el[id] = $(id); });

    canvas = $('map');
    ctx = canvas.getContext('2d');

    // Tools
    document.querySelectorAll('.tool[data-tool]').forEach(function (b) {
      b.addEventListener('click', function () { setTool(b.dataset.tool); });
    });
    $('btnUndo').addEventListener('click', function () { if (store.undo()) { renderAll(); store.saveLocal(); } });
    $('btnRedo').addEventListener('click', function () { if (store.redo()) { renderAll(); store.saveLocal(); } });
    $('btnFit').addEventListener('click', fit);
    $('btnZoomIn').addEventListener('click', function () { zoomStep(1.35); });
    $('btnZoomOut').addEventListener('click', function () { zoomStep(1 / 1.35); });
    $('btnZoom11').addEventListener('click', function () {
      if (!S.image) return;
      var r = el.stage.getBoundingClientRect();
      R.zoomAt(view, r.width / 2, r.height / 2, 1 / view.scale, 0.01, 240);
      updateStatusZoom();
      requestDraw();
      toast('Actual image pixels — 1 photo pixel per screen pixel.');
    });

    document.querySelectorAll('#interpMode .seg-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        S.project.settings.interpolation = b.dataset.interp;
        store.saveLocal();
        renderSetup();
        requestDraw();
      });
    });

    // Tabs
    document.querySelectorAll('.tab').forEach(function (t) {
      t.addEventListener('click', function () { switchTab(t.dataset.tab); });
    });
    $('panelHandle').addEventListener('click', function () { openPanel(!ui.panelOpen); });

    // Canvas
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('dblclick', onDblClick);
    canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });

    // Files
    $('btnImage').addEventListener('click', function () { el.fileImage.click(); });
    $('btnImage2').addEventListener('click', function () { el.fileImage.click(); });
    $('btnSample').addEventListener('click', function () {
      if (S.project.stockpiles.length || S.project.samples.length) {
        if (!window.confirm('Replace the current plan with the example?')) return;
      }
      store.setProject(store.createProject());
      loadExample();
    });
    el.fileImage.addEventListener('change', function () {
      var f = el.fileImage.files[0];
      if (!f) return;
      if (S.project.isExample) { store.setProject(store.createProject()); }
      loadImageFromBlob(f, f.name);
      el.fileImage.value = '';
    });
    $('btnOpen').addEventListener('click', function () { el.fileProject.click(); });
    $('btnOpen2').addEventListener('click', function () { el.fileProject.click(); });
    el.fileProject.addEventListener('change', function () {
      var f = el.fileProject.files[0];
      if (f) readProjectFile(f);
      el.fileProject.value = '';
    });
    $('btnWorld').addEventListener('click', function () { el.fileWorld.click(); });
    el.fileWorld.addEventListener('change', function () {
      var f = el.fileWorld.files[0];
      if (f) readWorldFile(f);
      el.fileWorld.value = '';
    });
    $('btnSave').addEventListener('click', function () { doExport('project'); });
    $('btnField').addEventListener('click', function () { ASM.field.enter(); });
    ASM.field.bind();

    // Drag and drop
    ['dragenter', 'dragover'].forEach(function (t) {
      el.stage.addEventListener(t, function (e) { e.preventDefault(); el.dropzone.hidden = false; });
    });
    el.stage.addEventListener('dragleave', function (e) {
      if (e.relatedTarget && el.stage.contains(e.relatedTarget)) return;
      if (S.image) el.dropzone.hidden = true;
    });
    el.stage.addEventListener('drop', function (e) {
      e.preventDefault();
      if (S.image) el.dropzone.hidden = true;
      var files = Array.prototype.slice.call(e.dataTransfer.files || []);
      var img = files.filter(function (f) { return /^image\//.test(f.type); })[0];
      var world = files.filter(function (f) { return /\.(jgw|pgw|tfw|wld)$/i.test(f.name); })[0];
      var proj = files.filter(function (f) { return /\.json$/i.test(f.name); })[0];
      if (img) { if (S.project.isExample) store.setProject(store.createProject()); loadImageFromBlob(img, img.name); }
      if (world) readWorldFile(world);
      if (proj && !img) readProjectFile(proj);
    });

    // Setup fields
    [['fName', 'name'], ['fClient', 'client'], ['fJobRef', 'jobRef'], ['fBy', 'preparedBy'], ['fDate', 'plannedDate']]
      .forEach(function (pair) {
        el[pair[0]].addEventListener('change', function () {
          S.project[pair[1]] = el[pair[0]].value;
          store.saveLocal();
          updateCounts();
        });
      });

    el.fMppx.addEventListener('change', function () {
      var v = parseFloat(el.fMppx.value);
      if (!isFinite(v) || v <= 0) { toast('Metres per pixel must be greater than zero.', true); return; }
      store.checkpoint();
      var g = S.project.georef;
      if (g.affine && S.image) {
        var c = geo.pixelToGround(g, 0, 0, S.image.height);
        S.project.georef = geo.fromAnchor(0, 0, c.x, c.y, v, g.crs);
      } else {
        S.project.georef = geo.fromGSD(v, 'entered', '');
      }
      afterChange();
    });

    $('btnGsd10').addEventListener('click', function () {
      store.checkpoint();
      var g = S.project.georef;
      if (g.affine && S.image) {
        var c = geo.pixelToGround(g, 0, 0, S.image.height);
        S.project.georef = geo.fromAnchor(0, 0, c.x, c.y, 0.1, g.crs);
      } else {
        S.project.georef = geo.fromGSD(0.1, 'gsd', 'BOPRC post weather event imagery, 10 cm GSD');
      }
      afterChange();
      toast('Scale set to 0.1 m per pixel. Check it against something you can measure.');
    });

    $('btnCalibrate').addEventListener('click', function () {
      if (!S.image) { toast('Load an image first.', true); return; }
      ui.pending = 'calibrate';
      ui.draft = [];
      setToolSilently('select');
      updateHud();
      if (window.matchMedia('(max-width: 820px)').matches) openPanel(false);
    });

    $('btnAnchor').addEventListener('click', function () {
      if (!S.image) { toast('Load an image first.', true); return; }
      ui.pending = 'anchor';
      updateHud();
      if (window.matchMedia('(max-width: 820px)').matches) openPanel(false);
    });

    el.scaleChip.addEventListener('click', function () { switchTab('setup'); });

    // Plan controls
    document.querySelectorAll('#ruleMode .seg-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        store.checkpoint();
        S.project.rule.mode = b.dataset.mode;
        afterChange();
      });
    });
    document.querySelectorAll('[data-preset]').forEach(function (b) {
      b.addEventListener('click', function () {
        store.checkpoint();
        S.project.rule.rate.perCubic = parseInt(b.dataset.preset, 10);
        afterChange();
      });
    });
    $('btnAddBand').addEventListener('click', function () {
      store.checkpoint();
      var bands = S.project.rule.banded.bands;
      var last = bands.slice().sort(function (a, b) { return a.upTo - b.upTo; })[bands.length - 1];
      bands.push({ upTo: last ? last.upTo * 2 : 100, samples: last ? last.samples + 1 : 3 });
      afterChange();
    });

    numField(el.fPerCubic, function (v) { S.project.rule.rate.perCubic = v; });
    numField(el.fMinPer, function (v) { S.project.rule.rate.min = v; });
    numField(el.fPerExtra, function (v) { S.project.rule.banded.perExtra = v; });
    numField(el.fFixed, function (v) { S.project.rule.fixed = v; });
    numField(el.fDupEvery, function (v) { S.project.qa.dupEvery = v; }, true);
    numField(el.fSplitEvery, function (v) { S.project.qa.splitEvery = v; }, true);
    numField(el.fBlanks, function (v) { S.project.qa.blanks = v; }, true);
    numField(el.fPad, function (v) { S.project.settings.pad = Math.max(1, Math.min(4, v)); store.recode(); });

    el.fNamingOrder.addEventListener('change', function () {
      store.checkpoint();
      S.project.settings.namingOrder = el.fNamingOrder.value;
      store.recode();   // sample ids follow the order immediately
      afterChange();
      toast(el.fNamingOrder.value === 'created'
        ? 'Numbering now follows the order things are drawn.'
        : 'Numbering now runs ' + store.describeNamingOrder() + '.');
    });

    // Stockpile naming: commit on change, preview while typing.
    ['fPilePrefix', 'fPilePad', 'fPileStart'].forEach(function (id) {
      el[id].addEventListener('input', renderNamingPreview);
    });
    el.fPilePrefix.addEventListener('change', function () {
      store.checkpoint();
      S.project.settings.pilePrefix = el.fPilePrefix.value;
      afterChange();
    });
    numField(el.fPilePad, function (v) {
      S.project.settings.pilePad = Math.max(1, Math.min(4, Math.round(v)));
    });
    numField(el.fPileStart, function (v) {
      S.project.settings.pileStart = Math.round(v);
    }, true);

    $('btnRenumberPiles').addEventListener('click', function () {
      if (!S.project.stockpiles.length) { toast('No stockpiles to renumber yet.', true); return; }
      store.checkpoint();
      var r = store.renumberPiles();
      afterChange();
      toast('Renumbered ' + r.changed + ' stockpile' + (r.changed === 1 ? '' : 's') +
        ' in ' + store.describeNamingOrder() +
        (r.kept ? ' \u2014 ' + r.kept + ' custom name' + (r.kept === 1 ? '' : 's') + ' kept.' : '.'));
    });

    el.fPrefix.addEventListener('input', renderNamingPreview);
    el.fPad.addEventListener('input', renderNamingPreview);

    el.fPrefix.addEventListener('change', function () {
      store.checkpoint();
      S.project.settings.idPrefix = el.fPrefix.value || 'SP';
      store.recode();
      afterChange();
    });
    document.querySelectorAll('#idScope .seg-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        store.checkpoint();
        S.project.settings.idScope = b.dataset.scope;
        store.recode();
        afterChange();
      });
    });
    $('btnRecode').addEventListener('click', function () {
      var custom = S.project.samples.filter(function (s) { return s.codeLocked && s.code; }).length;
      store.checkpoint();
      store.recode();
      afterChange();
      toast('Renumbered in map order' +
        (custom ? ' \u2014 ' + custom + ' custom ID' + (custom === 1 ? '' : 's') + ' kept.' : '.'));
    });
    $('btnAddPile').addEventListener('click', function () { setTool('pile'); });

    document.querySelectorAll('#sampleFilter .seg-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        ui.sampleFilter = b.dataset.filter;
        document.querySelectorAll('#sampleFilter .seg-btn').forEach(function (x) {
          x.classList.toggle('is-active', x === b);
        });
        renderSamples();
      });
    });

    // Exports
    document.querySelectorAll('[data-export]').forEach(function (b) {
      b.addEventListener('click', function () { doExport(b.dataset.export); });
    });
    document.querySelectorAll('[data-copy]').forEach(function (b) {
      b.addEventListener('click', function () { doCopy(b.dataset.copy); });
    });

    $('btnReset').addEventListener('click', function () {
      if (!window.confirm('Discard this plan and start a new one? Save it first if you need it.')) return;
      store.setProject(store.createProject());
      store.clearLocal();
      ui.selectedPileId = null;
      ui.selectedSampleId = null;
      renderAll();
      toast('New plan started. The image is still loaded.');
    });

    // Theme
    $('btnTheme').addEventListener('click', function () {
      var cur = document.documentElement.getAttribute('data-theme');
      var next = cur === 'dark' ? 'light' : (cur === 'light' ? 'dark' : (prefersDark() ? 'light' : 'dark'));
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem('asm.theme', next); } catch (e) { /* storage may be blocked */ }
    });

    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', sizeCanvas);
    if (window.ResizeObserver) new ResizeObserver(sizeCanvas).observe(el.stage);
    window.addEventListener('beforeunload', function () { store.saveLocal(); });
  }

  function numField(node, apply, allowZero) {
    if (!node) return;
    node.addEventListener('change', function () {
      var v = parseFloat(node.value);
      if (!isFinite(v) || (allowZero ? v < 0 : v <= 0)) { renderPlan(); return; }
      store.checkpoint();
      apply(v);
      afterChange();
    });
  }

  function setToolSilently(name) {
    ui.tool = name;
    document.querySelectorAll('.tool[data-tool]').forEach(function (b) {
      b.classList.toggle('is-active', b.dataset.tool === name);
    });
  }

  function zoomStep(f) {
    var r = el.stage.getBoundingClientRect();
    R.zoomAt(view, r.width / 2, r.height / 2, f, 0.01, 240);
    updateStatusZoom();
    requestDraw();
  }

  function prefersDark() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  function onKey(e) {
    var t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey ? store.redo() : store.undo()) { renderAll(); store.saveLocal(); }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault(); doExport('project'); return;
    }

    switch (e.key) {
      case 'v': case 'V': setTool('select'); break;
      case 'p': case 'P': setTool('pile'); break;
      case 's': case 'S': setTool('sample'); break;
      case 'm': case 'M': setTool('measure'); break;
      case 'x': case 'X': setTool('erase'); break;
      case 'f': case 'F': fit(); break;
      case 'F2':
        e.preventDefault();
        if (!focusRename()) toast('Select a stockpile or a location first.');
        break;
      case 'Enter':
        if (ui.pending === 'increments') { ui.pending = null; updateHud(); requestDraw(); break; }
        if (ui.tool === 'pile' && ui.draft.length > 2) closeDraft();
        break;
      case 'Escape':
        ui.draft = []; ui.measure = []; ui.pending = null;
        ui.measureMode = 'line';
        updateHud(); requestDraw();
        break;
      case 'Backspace': case 'Delete':
        if (ui.tool === 'pile' && ui.draft.length) { ui.draft.pop(); updateHud(); requestDraw(); break; }
        if (ui.selectedSampleId) {
          store.checkpoint();
          store.removeSample(ui.selectedSampleId);
          ui.selectedSampleId = null;
          store.recode(); afterChange();
        } else if (ui.selectedPileId) {
          store.checkpoint();
          store.removePile(ui.selectedPileId);
          ui.selectedPileId = null;
          store.recode(); afterChange();
        }
        break;
    }
  }

  /* ===================== Boot ===================== */

  function boot() {
    try {
      var savedTheme = localStorage.getItem('asm.theme');
      if (savedTheme) document.documentElement.setAttribute('data-theme', savedTheme);
    } catch (e) { /* storage may be blocked */ }

    bind();
    sizeCanvas();
    requestAnimationFrame(tick);

    var saved = store.loadLocal();
    if (saved && (saved.stockpiles.length || saved.samples.length || saved.image)) {
      store.setProject(saved);
      store.loadImageBlob().then(function (rec) {
        if (rec && rec.blob) {
          loadImageFromBlob(rec.blob, (S.project.image && S.project.image.name) || 'image', true);
        } else {
          el.dropzone.hidden = false;
          renderAll();
          toast('Plan restored. Load the aerial image again to see it.');
        }
      });
      renderAll();
    } else {
      loadExample();
    }

    // Register the offline shell only when served as a real page. Inside an
    // embedded frame a worker would be pointless and could cache stale files.
    if (window.top === window.self && 'serviceWorker' in navigator &&
        /^https?:$/.test(location.protocol)) {
      navigator.serviceWorker.register('sw.js', { scope: './' }).catch(function () {});
    }

    setInterval(function () { if (S.dirty) store.saveLocal(); }, 8000);
    renderAll();
    updateHud();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

})(window.ASM = window.ASM || {});
