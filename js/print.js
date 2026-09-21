/* print.js — paper output.
 *
 * Goes through the browser's own print dialogue rather than bundling a PDF
 * library: it needs no network (so it still works on a laptop in a site hut),
 * "Save as PDF" is a destination in that dialogue, and the title block prints
 * as real text at printer resolution instead of being flattened into an image.
 * Only the map itself is raster, rendered through the same drawScene the
 * screen uses so the paper matches what was planned.
 *
 * A whole site squeezed onto one A4 is unreadable, so the default is to hold a
 * real scale and lay the plan across as many sheets as that needs, with an
 * overview sheet showing how they fit together.
 */
(function (ASM) {
  'use strict';

  var store = ASM.store, geo = ASM.geo, geom = ASM.geom, R = ASM.render;
  var S = ASM.store.state;

  // Portrait millimetres.
  var PAPER = { a4: [210, 297], a3: [297, 420] };
  var MARGIN = 9;          // mm of white around the sheet
  var BLOCK = 31;          // mm of title block along the bottom
  var OVERLAP = 0.04;      // sheets share a little edge so nothing falls in a join

  function defaults() {
    return {
      paper: 'a4',
      orientation: 'auto',   // 'auto' picks whichever wastes less of the sheet
      scale: 'fit',        // 'fit' or a denominator, e.g. 500 for 1:500
      dpi: 200,
      overview: true,
      schedule: true
    };
  }

  /* Auto orientation: a tall site on a landscape sheet leaves half the paper
   * blank, so try both and keep whichever fills more of the map area. */
  function resolveOrientation(o, ex) {
    if (o.orientation === 'landscape' || o.orientation === 'portrait') return o.orientation;
    var p = PAPER[o.paper] || PAPER.a4;
    function unused(w, h) {
      var mw = w - MARGIN * 2, mh = h - MARGIN * 2 - BLOCK;
      if (mw <= 0 || mh <= 0) return 1;
      var s = Math.min(mw / ex.w, mh / ex.h);
      return 1 - (ex.w * s * ex.h * s) / (mw * mh);
    }
    return unused(p[1], p[0]) <= unused(p[0], p[1]) ? 'landscape' : 'portrait';
  }

  function pageSize(o, orientation) {
    var p = PAPER[o.paper] || PAPER.a4;
    return orientation === 'landscape' ? { w: p[1], h: p[0] } : { w: p[0], h: p[1] };
  }

  /** Everything that has to appear on paper, in image pixels. */
  function extent() {
    var p = S.project;
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    function take(x, y) {
      if (x < x0) x0 = x; if (y < y0) y0 = y;
      if (x > x1) x1 = x; if (y > y1) y1 = y;
    }
    p.stockpiles.forEach(function (pile) {
      pile.polygon.forEach(function (pt) { take(pt[0], pt[1]); });
    });
    p.samples.forEach(function (s) {
      take(s.px, s.py);
      (s.incPts || []).forEach(function (pt) { take(pt[0], pt[1]); });
    });
    if (!isFinite(x0)) {
      var w = S.image ? S.image.width : 1000, h = S.image ? S.image.height : 1000;
      return { x0: 0, y0: 0, x1: w, y1: h, w: w, h: h };
    }
    // A margin of breathing room, never less than a marker's worth.
    var padX = Math.max((x1 - x0) * 0.05, 30);
    var padY = Math.max((y1 - y0) * 0.05, 30);
    x0 -= padX; y0 -= padY; x1 += padX; y1 += padY;
    return { x0: x0, y0: y0, x1: x1, y1: y1, w: x1 - x0, h: y1 - y0 };
  }

  /** How the plan divides across sheets at the chosen scale. */
  function layout(o) {
    var ex = extent();
    var orientation = resolveOrientation(o, ex);
    var page = pageSize(o, orientation);
    var mapW = page.w - MARGIN * 2;
    var mapH = page.h - MARGIN * 2 - BLOCK;
    var g = S.project.georef;
    var mppx = geo.hasScale(g) ? g.mppx : null;

    if (o.scale === 'fit' || !mppx) {
      // One sheet: whatever scale makes the plan fit.
      var fit = Math.min(mapW / ex.w, mapH / ex.h);   // mm per image pixel
      return {
        page: page, orientation: orientation, mapW: mapW, mapH: mapH, extent: ex, mppx: mppx,
        cols: 1, rows: 1, sheets: 1,
        tileW: ex.w, tileH: ex.h,
        denom: mppx ? Math.round(mppx * 1000 / fit) : null,
        fitted: true
      };
    }

    // 1:denom means one millimetre of paper is `denom` millimetres of ground.
    var denom = o.scale;
    var groundPerMm = denom / 1000;                 // metres of ground per mm
    var tileW = (mapW * groundPerMm) / mppx;        // image pixels across a sheet
    var tileH = (mapH * groundPerMm) / mppx;
    var stepW = tileW * (1 - OVERLAP);
    var stepH = tileH * (1 - OVERLAP);
    var cols = Math.max(1, Math.ceil(ex.w / stepW));
    var rows = Math.max(1, Math.ceil(ex.h / stepH));

    return {
      page: page, orientation: orientation, mapW: mapW, mapH: mapH, extent: ex, mppx: mppx,
      cols: cols, rows: rows, sheets: cols * rows,
      tileW: tileW, tileH: tileH, stepW: stepW, stepH: stepH,
      denom: denom, fitted: false
    };
  }

  function describe(o) {
    var L = layout(o);
    if (L.fitted) {
      return 'One ' + o.paper.toUpperCase() + ' ' + L.orientation +
        (L.denom ? ' at about 1:' + L.denom : '');
    }
    return L.cols + ' × ' + L.rows + ' = ' + L.sheets + ' sheet' + (L.sheets === 1 ? '' : 's') +
      ' at 1:' + L.denom + ', ' + o.paper.toUpperCase() + ' ' + L.orientation;
  }

  /* --- Rendering one sheet's map ----------------------------------------- */

  function renderTile(L, col, row, o) {
    var pxPerMm = o.dpi / 25.4;
    var cw, ch, originX, originY, scale;

    if (L.fitted) {
      scale = Math.min((L.mapW * pxPerMm) / L.extent.w, (L.mapH * pxPerMm) / L.extent.h);
      cw = Math.round(L.extent.w * scale);
      ch = Math.round(L.extent.h * scale);
      originX = L.extent.x0;
      originY = L.extent.y0;
    } else {
      cw = Math.round(L.mapW * pxPerMm);
      ch = Math.round(L.mapH * pxPerMm);
      scale = cw / L.tileW;
      originX = L.extent.x0 + col * L.stepW;
      originY = L.extent.y0 + row * L.stepH;
    }

    var cv = document.createElement('canvas');
    cv.width = cw; cv.height = ch;
    var ctx = cv.getContext('2d');
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, cw, ch);

    var view = { scale: scale, tx: -originX * scale, ty: -originY * scale };
    var labelScale = Math.max(1, cw / 1500);

    R.drawScene(ctx, {
      width: cw, height: ch, view: view,
      project: S.project, image: S.image, ui: {},
      forExport: true, background: '#FFFFFF', labelScale: labelScale
    });

    R.drawScaleBar(ctx, view, S.project.georef, Math.round(cw * 0.03),
      ch - Math.round(cw * 0.035), Math.round(cw * 0.16));
    var arrowR = Math.round(cw * 0.022);
    R.drawNorthArrow(ctx, cw - arrowR * 2.4, arrowR * 2.2,
      R.northAngle(S.project.georef, S.image ? S.image.height : 0), arrowR);

    ctx.strokeStyle = '#1B2523';
    ctx.lineWidth = 2;
    ctx.strokeRect(0.5, 0.5, cw - 1, ch - 1);

    return cv;
  }

  /** The index sheet: the whole plan with the sheet grid drawn over it. */
  function renderOverview(L, o) {
    var pxPerMm = o.dpi / 25.4;
    var scale = Math.min((L.mapW * pxPerMm) / L.extent.w, (L.mapH * pxPerMm) / L.extent.h);
    var cw = Math.round(L.extent.w * scale);
    var ch = Math.round(L.extent.h * scale);

    var cv = document.createElement('canvas');
    cv.width = cw; cv.height = ch;
    var ctx = cv.getContext('2d');
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, cw, ch);

    var originX = L.extent.x0;
    var originY = L.extent.y0;
    var view = { scale: scale, tx: -originX * scale, ty: -originY * scale };

    R.drawScene(ctx, {
      width: cw, height: ch, view: view,
      project: S.project, image: S.image, ui: {},
      forExport: true, background: '#FFFFFF', labelScale: Math.max(1, cw / 2200)
    });

    // Sheet footprints.
    ctx.lineWidth = Math.max(1.5, cw / 700);
    ctx.font = '700 ' + Math.round(cw / 34) + 'px Barlow, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    var n = 0;
    for (var r = 0; r < L.rows; r++) {
      for (var c = 0; c < L.cols; c++) {
        n++;
        var x = (L.extent.x0 + c * L.stepW) * scale + view.tx;
        var y = (L.extent.y0 + r * L.stepH) * scale + view.ty;
        var w = L.tileW * scale, h = L.tileH * scale;
        ctx.strokeStyle = 'rgba(226,98,12,0.95)';
        ctx.strokeRect(x, y, w, h);
        ctx.fillStyle = 'rgba(255,255,255,0.88)';
        var bw = cw / 16, bh = cw / 22;
        ctx.fillRect(x + 6, y + 6, bw, bh);
        ctx.strokeRect(x + 6, y + 6, bw, bh);
        ctx.fillStyle = '#7A3405';
        ctx.fillText(String(n), x + 6 + bw / 2, y + 6 + bh / 2);
      }
    }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';

    ctx.strokeStyle = '#1B2523';
    ctx.lineWidth = 2;
    ctx.strokeRect(0.5, 0.5, cw - 1, ch - 1);
    return cv;
  }

  /* --- Sheet markup ------------------------------------------------------- */

  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function legendHTML() {
    var used = {};
    S.project.samples.forEach(function (s) { used[s.type] = true; });
    return ASM.plan.SAMPLE_TYPES.filter(function (t) { return used[t.id]; })
      .map(function (t) {
        return '<span class="pl-key"><i style="background:' + esc(t.color) + '"></i>' + esc(t.name) + '</span>';
      }).join('');
  }

  function blockHTML(L, o, sheetNo, sheetTotal, caption) {
    var p = S.project;
    var t = store.totals();
    var g = p.georef;
    var pr = [
      ['Stockpiles', t.piles],
      ['Volume', t.volume != null ? geo.fmtVol(t.volume) : 'not calculated'],
      ['Locations', t.primary + (t.required ? ' of ' + t.required : '')],
      ['Laboratory samples', t.labSamples]
    ];
    var rt = [
      ['Coordinate system', geo.isAbsolute(g) ? g.crs + ' (NZTM2000)' : 'local grid — not georeferenced'],
      ['Scale', L.fitted ? (L.denom ? '≈ 1:' + L.denom + ' on ' + o.paper.toUpperCase() : 'fitted to sheet')
        : '1:' + L.denom + ' on ' + o.paper.toUpperCase()],
      ['Plan date', p.plannedDate || '—'],
      ['Prepared by', p.preparedBy || '—']
    ];
    function pairs(rows) {
      return rows.map(function (r) {
        return '<div class="pl-pair"><dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd></div>';
      }).join('');
    }
    return '<div class="pl-block">' +
      '<div class="pl-id">' +
        '<div class="pl-eyebrow">Contaminated land — stockpile sampling plan</div>' +
        '<h1>' + esc(p.name || 'Untitled sampling plan') + '</h1>' +
        '<div class="pl-sub">' + esc([p.client, p.jobRef].filter(Boolean).join('  ·  ')) + '</div>' +
        (caption ? '<div class="pl-caption">' + esc(caption) + '</div>' : '') +
      '</div>' +
      '<dl class="pl-cols">' + pairs(pr) + '</dl>' +
      '<dl class="pl-cols">' + pairs(rt) + '</dl>' +
      '<div class="pl-side">' +
        '<div class="pl-sheet">Sheet ' + sheetNo + ' of ' + sheetTotal + '</div>' +
        '<div class="pl-legend">' + legendHTML() + '</div>' +
      '</div>' +
      '<div class="pl-basis">' + esc(ASM.plan.describeRule(p.rule)) +
        '   ·   QA/QC: ' + esc(ASM.plan.describeQA(p.qa)) + '</div>' +
      '</div>';
  }

  function scheduleHTML() {
    var p = S.project;
    var imgH = S.image ? S.image.height : 0;
    var rows = ASM.exporter.sampleRows(p, imgH);
    var head = rows[0];
    var keep = ['Sample_ID', 'Stockpile', 'Sample_type', 'Depth_from_m', 'Depth_to_m',
      'Easting_mE', 'Northing_mN', 'Status'];
    var idx = keep.map(function (k) { return head.indexOf(k); }).filter(function (i) { return i >= 0; });
    var label = { Sample_ID: 'ID', Stockpile: 'Stockpile', Sample_type: 'Type',
      Depth_from_m: 'From', Depth_to_m: 'To', Easting_mE: 'mE', Northing_mN: 'mN', Status: 'Status' };

    var html = '<table class="pl-table"><thead><tr>' +
      idx.map(function (i) { return '<th>' + esc(label[head[i]] || head[i]) + '</th>'; }).join('') +
      '<th class="pl-tick">Collected</th></tr></thead><tbody>';
    for (var r = 1; r < rows.length; r++) {
      html += '<tr>' + idx.map(function (i) { return '<td>' + esc(rows[r][i]) + '</td>'; }).join('') +
        '<td class="pl-tick"></td></tr>';
    }
    return html + '</tbody></table>';
  }

  /* --- Build and print ---------------------------------------------------- */

  function build(o) {
    o = Object.assign(defaults(), o || {});
    var L = layout(o);
    var doc = document.getElementById('printDoc');
    doc.innerHTML = '';

    var mapSheets = L.sheets;
    var wantOverview = o.overview && mapSheets > 1;
    var total = mapSheets + (wantOverview ? 1 : 0);

    var style = document.getElementById('printPageStyle');
    style.textContent = '@page { size: ' + o.paper.toUpperCase() + ' ' + L.orientation +
      '; margin: 0; }\n.sheet { width: ' + L.page.w + 'mm; height: ' + L.page.h + 'mm; }\n' +
      '.sheet-map { height: ' + (L.page.h - MARGIN * 2 - BLOCK) + 'mm; }\n' +
      '.sheet-inner { padding: ' + MARGIN + 'mm; }\n' +
      '.pl-block { height: ' + BLOCK + 'mm; }';

    var canvases = [];
    var n = 0;

    if (wantOverview) {
      n++;
      canvases.push({ cv: renderOverview(L, o), no: n, caption: 'Sheet index — ' + L.cols + ' × ' + L.rows + ' at 1:' + L.denom });
    }
    for (var r = 0; r < L.rows; r++) {
      for (var c = 0; c < L.cols; c++) {
        n++;
        canvases.push({
          cv: renderTile(L, c, r, o), no: n,
          caption: L.fitted ? null : 'Map sheet ' + (n - (wantOverview ? 1 : 0)) + ' — row ' + (r + 1) + ', column ' + (c + 1)
        });
      }
    }

    var imgs = [];
    canvases.forEach(function (item) {
      var sec = document.createElement('section');
      sec.className = 'sheet';
      var img = document.createElement('img');
      img.src = item.cv.toDataURL('image/jpeg', 0.9);
      imgs.push(img);
      var inner = document.createElement('div');
      inner.className = 'sheet-inner';
      var map = document.createElement('div');
      map.className = 'sheet-map';
      map.appendChild(img);
      inner.appendChild(map);
      inner.insertAdjacentHTML('beforeend', blockHTML(L, o, item.no, total, item.caption));
      sec.appendChild(inner);
      doc.appendChild(sec);
      item.cv.width = item.cv.height = 0;    // let the bitmap go
    });

    if (o.schedule && S.project.samples.length) {
      var sec2 = document.createElement('section');
      sec2.className = 'sheet sheet-text';
      sec2.innerHTML = '<div class="sheet-inner">' +
        '<h2 class="pl-h2">Sample schedule — ' + esc(S.project.name || '') + '</h2>' +
        scheduleHTML() + '</div>';
      doc.appendChild(sec2);
    }

    return Promise.all(imgs.map(function (img) {
      return img.decode ? img.decode().catch(function () {}) : Promise.resolve();
    })).then(function () { return { sheets: total, layout: L }; });
  }

  function print(o) {
    if (!S.image) return Promise.reject(new Error('no image'));
    document.documentElement.setAttribute('data-printing', '1');
    return build(o).then(function (res) {
      window.print();
      return res;
    }).catch(function (e) {
      document.documentElement.removeAttribute('data-printing');
      throw e;
    });
  }

  window.addEventListener('afterprint', function () {
    document.documentElement.removeAttribute('data-printing');
    var doc = document.getElementById('printDoc');
    if (doc) doc.innerHTML = '';
  });

  ASM.printer = {
    defaults: defaults,
    layout: layout,
    describe: describe,
    build: build,
    print: print,
    PAPER: PAPER
  };
})(window.ASM = window.ASM || {});
