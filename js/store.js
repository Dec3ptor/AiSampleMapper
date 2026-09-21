/* store.js — project state, identifiers, undo history and persistence.
 * The project object is the single source of truth and is what save/load,
 * autosave and every export read from.
 */
(function (ASM) {
  'use strict';

  var LS_KEY = 'asm.project.v2';
  var PILE_COLORS = ['#FF8A3D', '#4ADE80', '#38BDF8', '#F472B6', '#FACC15', '#A78BFA', '#2DD4BF', '#FB7185'];

  function todayISO() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function createProject() {
    return {
      version: 2,
      name: 'Untitled sampling plan',
      client: '',
      jobRef: '',
      preparedBy: '',
      plannedDate: todayISO(),
      notes: '',
      image: null,              // {name, width, height}
      georef: ASM.geo.emptyGeoref(),
      stockpiles: [],
      samples: [],
      rule: ASM.plan.defaultRule(),
      qa: ASM.plan.defaultQA(),
      settings: {
        pilePrefix: 'SP',       // stockpile / windrow naming convention
        pilePad: 1,             // 1 = WR1, 2 = WR01, 3 = WR001
        pileStart: 1,
        namingOrder: 'northSouth',   // 'northSouth' | 'westEast' | 'created'
        idPrefix: 'SP',
        idScope: 'site',        // 'site' = SP01.. across the job, 'pile' = per stockpile
        pad: 2,
        method: 'systematic',   // default distribution for auto-placement
        autoType: 'discrete',   // auto-placement makes discrete or composite samples
        incPerComposite: 5,
        insetM: 1.0,            // keep generated points off the toe of the pile
        defaultDepthFrom: 0,
        defaultDepthTo: 0.5,
        markerScale: 1,
        showLabels: true,
        interpolation: 'crisp'   // 'crisp' shows real pixels above 1:1

      },
      seq: { pile: 0, sample: 0 }
    };
  }

  var state = {
    project: createProject(),
    image: null,                // HTMLImageElement, never serialised
    dirty: false
  };

  var undoStack = [];
  var redoStack = [];
  var LIMIT = 50;
  var listeners = [];

  function on(fn) { listeners.push(fn); return fn; }
  function emit(what) {
    for (var i = 0; i < listeners.length; i++) listeners[i](what, state);
  }

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  /** Take an undo snapshot. Call immediately BEFORE a mutation. */
  function checkpoint() {
    undoStack.push(clone(state.project));
    if (undoStack.length > LIMIT) undoStack.shift();
    redoStack.length = 0;
    state.dirty = true;
  }

  function undo() {
    if (!undoStack.length) return false;
    redoStack.push(clone(state.project));
    state.project = undoStack.pop();
    state.dirty = true;
    emit('project');
    return true;
  }

  function redo() {
    if (!redoStack.length) return false;
    undoStack.push(clone(state.project));
    state.project = redoStack.pop();
    state.dirty = true;
    emit('project');
    return true;
  }

  function canUndo() { return undoStack.length > 0; }
  function canRedo() { return redoStack.length > 0; }

  /* --- Stockpiles -------------------------------------------------------- */

  /* The order numbers are handed out in. Position-based ordering walks the
   * site the way a field team would; 'created' keeps the order things were
   * drawn, which is what you want when you place them in a deliberate sequence
   * or when the photo is not north-up. */
  function sortForNaming(items, getXY) {
    var mode = state.project.settings.namingOrder || 'northSouth';
    var list = items.slice();
    if (mode === 'created') return list;   // arrays are already in draw order
    list.sort(function (a, b) {
      var pa = getXY(a), pb = getXY(b);
      return mode === 'westEast'
        ? (pa[0] - pb[0]) || (pa[1] - pb[1])
        : (pa[1] - pb[1]) || (pa[0] - pb[0]);
    });
    return list;
  }

  function describeNamingOrder() {
    var mode = state.project.settings.namingOrder || 'northSouth';
    if (mode === 'created') return 'the order they were drawn';
    if (mode === 'westEast') return 'left to right across the photo';
    return 'top to bottom down the photo';
  }

  /** Build a stockpile name from the project's convention, e.g. WR07. */
  function formatPileName(n) {
    var st = state.project.settings;
    var prefix = st.pilePrefix == null ? 'SP' : st.pilePrefix;
    var pad = Math.max(1, Math.min(4, st.pilePad || 1));
    return prefix + String(n).padStart(pad, '0');
  }

  /* One past the highest number in use for the current prefix. Reading it off
   * the existing names rather than a counter means changing the prefix starts a
   * fresh run, and a number is never handed to two piles at once. Deleting the
   * last pile frees its number; deleting one from the middle leaves the gap,
   * so a windrow number never silently moves to different material. */
  function nextPileNumber() {
    var st = state.project.settings;
    var prefix = st.pilePrefix == null ? 'SP' : st.pilePrefix;
    var start = isFinite(st.pileStart) ? Math.round(st.pileStart) : 1;
    var re = new RegExp('^' + prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '0*(\\d+)$');
    var max = start - 1;
    state.project.stockpiles.forEach(function (pile) {
      var m = re.exec(pile.name || '');
      if (m) max = Math.max(max, parseInt(m[1], 10));
    });
    return max + 1;
  }

  /** Re-apply the convention to every stockpile, top of the site downwards.
   *  Names the user typed are left alone and keep their place. */
  function renumberPiles() {
    var p = state.project;
    var start = isFinite(p.settings.pileStart) ? Math.round(p.settings.pileStart) : 1;
    var order = sortForNaming(p.stockpiles, function (pile) {
      return ASM.geom.centroid(pile.polygon);
    });
    // Never hand out a number that a hand-typed name already occupies.
    var taken = {};
    p.stockpiles.forEach(function (pile) {
      if (pile.nameLocked && pile.name) taken[pile.name] = true;
    });

    var n = start, changed = 0, kept = 0;
    order.forEach(function (pile) {
      if (pile.nameLocked) { kept++; return; }
      while (taken[formatPileName(n)]) n++;
      pile.name = formatPileName(n);
      n++; changed++;
    });
    recode();   // sample ids can be derived from the pile name
    return { changed: changed, kept: kept };
  }

  function addPile(polygon) {
    var p = state.project;
    p.seq.pile += 1;
    var pile = {
      id: 'pile-' + p.seq.pile,
      name: formatPileName(nextPileNumber()),
      nameLocked: false,
      material: '',
      polygon: polygon,
      heightM: 1.5,
      formId: 'flat',
      customFactor: 0.6,
      volumeOverride: null,
      requiredOverride: null,
      notes: '',
      color: PILE_COLORS[(p.seq.pile - 1) % PILE_COLORS.length]
    };
    p.stockpiles.push(pile);
    return pile;
  }

  function pileById(id) {
    var list = state.project.stockpiles;
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function removePile(id) {
    var p = state.project;
    p.stockpiles = p.stockpiles.filter(function (s) { return s.id !== id; });
    p.samples = p.samples.filter(function (s) { return s.stockpileId !== id; });
  }

  /** Footprint area, perimeter, volume and required count for one stockpile. */
  function pileStats(pile) {
    var p = state.project;
    var mppx = ASM.geo.hasScale(p.georef) ? p.georef.mppx : null;
    var areaPx = ASM.geom.area(pile.polygon);
    var areaM2 = mppx ? areaPx * mppx * mppx : null;
    var perimM = mppx ? ASM.geom.perimeter(pile.polygon) * mppx : null;
    var volume = areaM2 != null ? ASM.plan.volumeOf(pile, areaM2) : null;
    var required = pile.requiredOverride != null && isFinite(pile.requiredOverride)
      ? Math.max(0, Math.round(pile.requiredOverride))
      : ASM.plan.requiredFor(p.rule, volume);
    var placed = 0, dups = 0;
    for (var i = 0; i < p.samples.length; i++) {
      var s = p.samples[i];
      if (s.stockpileId !== pile.id) continue;
      if (s.type === 'duplicate' || s.type === 'split') dups++; else placed++;
    }
    return {
      areaM2: areaM2, perimM: perimM, volume: volume,
      required: required, placed: placed, qaPlaced: dups,
      shortfall: required == null ? null : Math.max(0, required - placed)
    };
  }

  /* --- Samples ----------------------------------------------------------- */
  function addSample(px, py, opts) {
    var p = state.project;
    opts = opts || {};
    p.seq.sample += 1;
    var s = {
      id: 'smp-' + p.seq.sample,
      code: '',
      codeLocked: false,
      stockpileId: opts.stockpileId !== undefined ? opts.stockpileId : pileAt(px, py),
      px: px, py: py,
      type: opts.type || 'discrete',
      increments: opts.increments || 5,
      // Where each increment of a composite is taken. One sample, one id,
      // many locations. Empty for a single-point sample.
      incPts: opts.incPts ? opts.incPts.slice() : [],
      // For a QA sample, the primary it checks. Its id is derived from that
      // one rather than taking a number out of the primary sequence.
      duplicateOf: opts.duplicateOf || null,
      depthFrom: p.settings.defaultDepthFrom,
      depthTo: p.settings.defaultDepthTo,
      matrix: 'Soil',
      status: 'planned',      // planned | collected | skipped
      collectedDate: '',
      collectedAt: null,      // epoch ms, what the field rate is worked out from
      gpsAccuracy: null,      // metres, when the position came from a phone fix
      notes: ''
    };
    p.samples.push(s);
    return s;
  }

  /* A composite reports itself at the centre of its increments, so the marker,
   * the label and every exported coordinate agree with the material. */
  function syncComposite(s) {
    if (!s || !s.incPts || !s.incPts.length) return s;
    var sx = 0, sy = 0;
    s.incPts.forEach(function (pt) { sx += pt[0]; sy += pt[1]; });
    s.px = sx / s.incPts.length;
    s.py = sy / s.incPts.length;
    return s;
  }

  function addIncrement(s, px, py) {
    if (!s.incPts) s.incPts = [];
    // The first increment inherits the position the sample already had.
    if (!s.incPts.length) s.incPts.push([s.px, s.py]);
    s.incPts.push([px, py]);
    syncComposite(s);
    return s;
  }

  function removeIncrement(s, index) {
    if (!s.incPts || index < 0 || index >= s.incPts.length) return s;
    s.incPts.splice(index, 1);
    if (s.incPts.length === 1) s.incPts = [];   // back to a plain single point
    syncComposite(s);
    return s;
  }

  /** Shift a whole composite, increments included. */
  function moveSample(s, px, py) {
    var dx = px - s.px, dy = py - s.py;
    s.px = px; s.py = py;
    if (s.incPts && s.incPts.length) {
      s.incPts = s.incPts.map(function (pt) { return [pt[0] + dx, pt[1] + dy]; });
    }
    return s;
  }

  function sampleById(id) {
    var list = state.project.samples;
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function removeSample(id) {
    state.project.samples = state.project.samples.filter(function (s) { return s.id !== id; });
  }

  /** Which stockpile polygon encloses this pixel, if any. */
  function pileAt(px, py) {
    var list = state.project.stockpiles;
    for (var i = list.length - 1; i >= 0; i--) {
      if (ASM.geom.contains(list[i].polygon, px, py)) return list[i].id;
    }
    return null;
  }

  function isQA(s) { return s.type === 'duplicate' || s.type === 'split'; }

  /** Regenerate sample codes in map order. Manually edited codes are kept.
   *
   * Primaries carry the numbering: a composite is one sample and takes exactly
   * one number, so the singles after it carry straight on. QA samples are not
   * separate locations at all -- a field duplicate is a second jar from the
   * same spot -- so they take the id of the sample they check with a suffix,
   * never a number of their own. Numbering one would shift every sample after
   * it every time a duplicate was added. */
  function recode() {
    var p = state.project, st = p.settings;
    var primaries = p.samples.filter(function (s) { return !isQA(s); });
    var siteN = 0;

    if (st.idScope === 'pile') {
      // Each stockpile carries its own run, so grouping is the point here.
      var order = p.stockpiles.map(function (x) { return x.id; });
      order.push(null);
      order.forEach(function (pid) {
        var inPile = sortForNaming(
          primaries.filter(function (s) { return s.stockpileId === pid; }),
          function (s) { return [s.px, s.py]; }
        );
        var pileN = 0;
        inPile.forEach(function (s) {
          if (s.codeLocked && s.code) return;
          if (pid) {
            pileN += 1;
            s.code = ((pileById(pid) || {}).name || st.idPrefix) + '-' + String(pileN).padStart(st.pad, '0');
          } else {
            siteN += 1;
            s.code = st.idPrefix + String(siteN).padStart(st.pad, '0');
          }
        });
      });
    } else {
      // One run across the whole job. Which stockpile a sample happens to sit
      // in must not affect its number: grouping by pile here put a sample that
      // landed inside one at the front of the sequence and shifted every other
      // id along by one.
      sortForNaming(primaries, function (s) { return [s.px, s.py]; })
        .forEach(function (s) {
          if (s.codeLocked && s.code) return;
          siteN += 1;
          s.code = st.idPrefix + String(siteN).padStart(st.pad, '0');
        });
    }

    var used = {};
    sortForNaming(p.samples.filter(isQA), function (s) { return [s.px, s.py]; })
      .forEach(function (s) {
        if (s.codeLocked && s.code) return;
        var parent = s.duplicateOf ? sampleById(s.duplicateOf) : null;
        var suffix = s.type === 'duplicate' ? 'D' : 'S';
        if (parent && parent.code) {
          var base = parent.code + suffix;
          used[base] = (used[base] || 0) + 1;
          // A second duplicate of the same primary becomes SP03D2.
          s.code = base + (used[base] > 1 ? used[base] : '');
        } else {
          // Orphaned, usually because its primary was deleted. Give it a
          // number of its own so it still has a unique, obvious id.
          siteN += 1;
          s.code = st.idPrefix + String(siteN).padStart(st.pad, '0') + suffix;
        }
      });
  }

  /** Whole-job totals for the summary panel and exports. */
  function totals() {
    var p = state.project;
    var primary = 0, qa = 0, collected = 0, volume = 0, areaM2 = 0, required = 0;
    var anyVolume = false;
    var visits = 0;   // spots the field team physically stops at
    p.samples.forEach(function (s) {
      if (s.type === 'duplicate' || s.type === 'split') qa++; else primary++;
      if (s.status === 'collected') collected++;
      visits += (s.incPts && s.incPts.length > 1) ? s.incPts.length : 1;
    });
    p.stockpiles.forEach(function (pile) {
      var st = pileStats(pile);
      if (st.areaM2 != null) areaM2 += st.areaM2;
      if (st.volume != null) { volume += st.volume; anyVolume = true; }
      if (st.required != null) required += st.required;
    });
    var need = ASM.plan.qaFor(p.qa, primary);
    return {
      piles: p.stockpiles.length,
      areaM2: areaM2,
      volume: anyVolume ? volume : null,
      required: required,
      primary: primary,
      qaPlaced: qa,
      qaRequired: need,
      collected: collected,
      visits: visits,
      labSamples: primary + qa + need.blanks
    };
  }

  /* --- Field progress ----------------------------------------------------
   * Rate comes from a rolling window of the most recent completions, not the
   * whole day: a slow start while you find the site should not drag the
   * estimate down for the rest of the afternoon. */
  function progress(windowSize) {
    var list = state.project.samples;
    var done = 0, skipped = 0;
    var times = [];
    list.forEach(function (s) {
      if (s.status === 'collected') {
        done++;
        if (s.collectedAt) times.push(s.collectedAt);
      } else if (s.status === 'skipped') {
        skipped++;
      }
    });
    var left = list.length - done - skipped;

    times.sort(function (a, b) { return a - b; });
    var perHour = null;
    var win = times.slice(-(windowSize || 6));
    if (win.length >= 2) {
      var hours = (win[win.length - 1] - win[0]) / 3600000;
      if (hours > 0) perHour = (win.length - 1) / hours;
    }

    var etaHours = (perHour && left > 0) ? left / perHour : null;
    return {
      total: list.length,
      done: done,
      skipped: skipped,
      left: left,
      perHour: perHour,
      etaHours: etaHours,
      finishAt: etaHours != null ? new Date(Date.now() + etaHours * 3600000) : null,
      lastAt: times.length ? times[times.length - 1] : null
    };
  }

  /** Mark one sample done, stamping the time the rate is derived from. */
  function markCollected(s, when) {
    if (!s) return null;
    var t = when || Date.now();
    s.status = 'collected';
    s.collectedAt = t;
    var d = new Date(t);
    s.collectedDate = d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
    return s;
  }

  /* --- Persistence ------------------------------------------------------- */
  function saveLocal() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(state.project));
      state.dirty = false;
      return true;
    } catch (e) { return false; }
  }

  function loadLocal() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (!raw) return null;
      var obj = JSON.parse(raw);
      return migrate(obj);
    } catch (e) { return null; }
  }

  function clearLocal() {
    try { localStorage.removeItem(LS_KEY); } catch (e) { /* storage may be blocked */ }
  }

  /** Accept older/foreign project files without throwing. */
  function migrate(obj) {
    var base = createProject();
    if (!obj || typeof obj !== 'object') return base;
    var out = Object.assign(base, obj);
    out.settings = Object.assign(base.settings, obj.settings || {});
    out.rule = Object.assign(ASM.plan.defaultRule(), obj.rule || {});
    out.qa = Object.assign(ASM.plan.defaultQA(), obj.qa || {});
    out.georef = Object.assign(ASM.geo.emptyGeoref(), obj.georef || {});
    out.seq = Object.assign({ pile: 0, sample: 0 }, obj.seq || {});
    out.stockpiles = (obj.stockpiles || []).filter(function (s) { return s && s.polygon && s.polygon.length > 2; });
    out.samples = (obj.samples || []).filter(function (s) { return s && isFinite(s.px) && isFinite(s.py); });
    var pileIds = {};
    out.stockpiles.forEach(function (pile) { pileIds[pile.id] = true; });

    out.samples.forEach(function (s) {
      s.incPts = Array.isArray(s.incPts)
        ? s.incPts.filter(function (pt) { return pt && isFinite(pt[0]) && isFinite(pt[1]); })
        : [];
      if (s.duplicateOf === undefined) s.duplicateOf = null;
      // Numbering groups samples by stockpile id and compares against null for
      // off-pile. An undefined or dangling id would match no group at all and
      // the sample would silently never be numbered.
      if (s.stockpileId === undefined || (s.stockpileId && !pileIds[s.stockpileId])) {
        s.stockpileId = null;
      }
      if (typeof s.status !== 'string') s.status = 'planned';
    });
    // Projects saved before QA samples were linked to their primary: a
    // duplicate sits all but on top of the sample it checks, so the nearest
    // primary is the one it came from.
    var byId = {};
    out.samples.forEach(function (s) { byId[s.id] = s; });
    out.samples.forEach(function (s) {
      if (!isQA(s) || (s.duplicateOf && byId[s.duplicateOf])) return;
      var best = null, bestD = Infinity;
      out.samples.forEach(function (o) {
        if (o === s || isQA(o)) return;
        var d = Math.hypot(o.px - s.px, o.py - s.py);
        if (d < bestD) { bestD = d; best = o; }
      });
      s.duplicateOf = best ? best.id : null;
    });
    // Rebuild counters so new items never collide with loaded ids.
    out.seq.pile = Math.max(out.seq.pile, out.stockpiles.length);
    out.seq.sample = Math.max(out.seq.sample, out.samples.length);
    return out;
  }

  function setProject(p) {
    state.project = migrate(p);
    undoStack.length = 0;
    redoStack.length = 0;
    emit('project');
  }

  /* --- Image storage (IndexedDB; blobs are too big for localStorage) ------ */
  function idb() {
    return new Promise(function (resolve, reject) {
      try {
        var req = indexedDB.open('asm-images', 1);
        req.onupgradeneeded = function () {
          if (!req.result.objectStoreNames.contains('img')) req.result.createObjectStore('img');
        };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      } catch (e) { reject(e); }
    });
  }

  function saveImageBlob(blob, meta) {
    return idb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('img', 'readwrite');
        tx.objectStore('img').put({ blob: blob, meta: meta }, 'current');
        tx.oncomplete = function () { resolve(true); };
        tx.onerror = function () { reject(tx.error); };
      });
    }).catch(function () { return false; });
  }

  function loadImageBlob() {
    return idb().then(function (db) {
      return new Promise(function (resolve) {
        var tx = db.transaction('img', 'readonly');
        var rq = tx.objectStore('img').get('current');
        rq.onsuccess = function () { resolve(rq.result || null); };
        rq.onerror = function () { resolve(null); };
      });
    }).catch(function () { return null; });
  }

  function clearImageBlob() {
    return idb().then(function (db) {
      return new Promise(function (resolve) {
        var tx = db.transaction('img', 'readwrite');
        tx.objectStore('img').delete('current');
        tx.oncomplete = function () { resolve(true); };
        tx.onerror = function () { resolve(false); };
      });
    }).catch(function () { return false; });
  }

  ASM.store = {
    state: state,
    PILE_COLORS: PILE_COLORS,
    createProject: createProject,
    setProject: setProject,
    migrate: migrate,
    on: on, emit: emit,
    checkpoint: checkpoint, undo: undo, redo: redo, canUndo: canUndo, canRedo: canRedo,
    addPile: addPile, pileById: pileById, removePile: removePile, pileStats: pileStats,
    formatPileName: formatPileName, nextPileNumber: nextPileNumber, renumberPiles: renumberPiles,
    sortForNaming: sortForNaming, describeNamingOrder: describeNamingOrder,
    addSample: addSample, sampleById: sampleById, removeSample: removeSample, pileAt: pileAt,
    syncComposite: syncComposite, addIncrement: addIncrement, removeIncrement: removeIncrement,
    moveSample: moveSample,
    recode: recode, totals: totals, progress: progress, markCollected: markCollected,
    isQA: isQA,
    saveLocal: saveLocal, loadLocal: loadLocal, clearLocal: clearLocal,
    saveImageBlob: saveImageBlob, loadImageBlob: loadImageBlob, clearImageBlob: clearImageBlob,
    todayISO: todayISO
  };
})(window.ASM = window.ASM || {});
