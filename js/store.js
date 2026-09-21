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
        idPrefix: 'SP',
        idScope: 'site',        // 'site' = SP01.. across the job, 'pile' = per stockpile
        pad: 2,
        method: 'systematic',   // default distribution for auto-placement
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
    var order = p.stockpiles.slice().sort(function (a, b) {
      var ca = ASM.geom.centroid(a.polygon), cb = ASM.geom.centroid(b.polygon);
      return (ca[1] - cb[1]) || (ca[0] - cb[0]);
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
      depthFrom: p.settings.defaultDepthFrom,
      depthTo: p.settings.defaultDepthTo,
      matrix: 'Soil',
      status: 'planned',
      collectedDate: '',
      notes: ''
    };
    p.samples.push(s);
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

  /** Regenerate sample codes in map order. Manually edited codes are kept. */
  function recode() {
    var p = state.project, st = p.settings;
    var order = p.stockpiles.map(function (s) { return s.id; });
    order.push(null);
    var siteN = 0;

    order.forEach(function (pid) {
      var inPile = p.samples.filter(function (s) { return s.stockpileId === pid; });
      // Down the page, then across — the order a field team would walk them.
      inPile.sort(function (a, b) { return (a.py - b.py) || (a.px - b.px); });
      var pileN = 0;
      inPile.forEach(function (s) {
        if (s.codeLocked && s.code) return;
        var num, prefix;
        if (st.idScope === 'pile' && pid) {
          pileN += 1; num = pileN;
          prefix = (pileById(pid) || {}).name || st.idPrefix;
          s.code = prefix + '-' + String(num).padStart(st.pad, '0');
        } else {
          siteN += 1; num = siteN;
          s.code = st.idPrefix + String(num).padStart(st.pad, '0');
        }
        if (s.type === 'duplicate') s.code += 'D';
        else if (s.type === 'split') s.code += 'S';
      });
    });
  }

  /** Whole-job totals for the summary panel and exports. */
  function totals() {
    var p = state.project;
    var primary = 0, qa = 0, collected = 0, volume = 0, areaM2 = 0, required = 0;
    var anyVolume = false;
    p.samples.forEach(function (s) {
      if (s.type === 'duplicate' || s.type === 'split') qa++; else primary++;
      if (s.status === 'collected') collected++;
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
      labSamples: primary + qa + need.blanks
    };
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
    addSample: addSample, sampleById: sampleById, removeSample: removeSample, pileAt: pileAt,
    recode: recode, totals: totals,
    saveLocal: saveLocal, loadLocal: loadLocal, clearLocal: clearLocal,
    saveImageBlob: saveImageBlob, loadImageBlob: loadImageBlob, clearImageBlob: clearImageBlob,
    todayISO: todayISO
  };
})(window.ASM = window.ASM || {});
