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
      scale: 'fit',          // 'fit' or a denominator, e.g. 500 for 1:500
      dpi: 200,
      overview: true,
      schedule: true,
      offsetX: 0,            // shift of the sheet grid, in image pixels
      offsetY: 0,
      skip: []               // sheet numbers the user has excluded
    };
  }

  /** The live options, kept on the project so they survive a reload. */
  function opts() {
    var st = S.project.settings;
    if (!st.print) st.print = defaults();
    else st.print = Object.assign(defaults(), st.print);
    return st.print;
  }

  function setOpt(k, v) {
    var o = opts();
    o[k] = v;
    // Moving the paper or the scale invalidates which sheets were skipped.
    if (k === 'paper' || k === 'orientation' || k === 'scale') o.skip = [];
    return o;
  }

  function isSkipped(n) { return opts().skip.indexOf(n) !== -1; }

  function toggleSkip(n) {
    var o = opts();
    var i = o.skip.indexOf(n);
    if (i === -1) o.skip.push(n); else o.skip.splice(i, 1);
    return o;
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
    // The offset slides the whole grid; widen the run so shifting it never
    // pushes the far edge of the plan off the last sheet.
    var offX = o.offsetX || 0, offY = o.offsetY || 0;
    var cols = Math.max(1, Math.ceil((ex.w + Math.abs(offX)) / stepW));
    var rows = Math.max(1, Math.ceil((ex.h + Math.abs(offY)) / stepH));

    return {
      page: page, orientation: orientation, mapW: mapW, mapH: mapH, extent: ex, mppx: mppx,
      cols: cols, rows: rows, sheets: cols * rows,
      tileW: tileW, tileH: tileH, stepW: stepW, stepH: stepH,
      offX: offX, offY: offY,
      denom: denom, fitted: false
    };
  }

  /** Top-left of a sheet, in image pixels. */
  function sheetOrigin(L, col, row) {
    return {
      x: L.extent.x0 + col * L.stepW + (L.offX || 0),
      y: L.extent.y0 + row * L.stepH + (L.offY || 0)
    };
  }

  /** Sheets in print order, skipped ones dropped. */
  function sheetList(L) {
    var out = [];
    var n = 0;
    for (var r = 0; r < L.rows; r++) {
      for (var c = 0; c < L.cols; c++) {
        n++;
        if (!isSkipped(n)) out.push({ no: n, col: c, row: r });
      }
    }
    return out;
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
      var og = sheetOrigin(L, col, row);
      originX = og.x;
      originY = og.y;
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
        if (isSkipped(n)) continue;
        var og = sheetOrigin(L, c, r);
        var x = og.x * scale + view.tx;
        var y = og.y * scale + view.ty;
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


  /* ===================== PDF ===================== */

  function pdfBlock(page, L, o, sheetNo, total, caption) {
    var p = S.project, t = store.totals(), g = S.project.georef;
    var bx = MARGIN;
    var by = L.page.h - MARGIN - BLOCK;
    var w = L.mapW;

    page.line(bx, by, bx + w, by, { width: 0.6, color: '#16211D' });

    page.text('CONTAMINATED LAND — STOCKPILE SAMPLING PLAN', bx, by + 3.4,
      { size: 6.4, font: 'helvB', color: '#5A6B64' });
    page.text(p.name || 'Untitled sampling plan', bx, by + 10.2, { size: 13, font: 'helvB' });
    var sub = [p.client, p.jobRef].filter(Boolean).join('   ·   ');
    if (sub) page.text(sub, bx, by + 15.2, { size: 8, color: '#3E4D47' });
    if (caption) page.text(caption, bx, by + 20, { size: 7, color: '#5A6B64' });

    /* Four label/value rows in BLOCK millimetres. page.text() takes the TOP of
     * the text and a line occupies about one em below that, so a row needs
     * label-em + value-em plus air: 5.5pt + 7.2pt is 4.5mm, so 5.8mm apart
     * clears, and the last value still stops above the basis rule. */
    function pairs(list, x) {
      var y = by + 3.2;
      list.forEach(function (r) {
        page.text(String(r[0]).toUpperCase(), x, y, { size: 5.5, font: 'helvB', color: '#6B7D76' });
        page.text(String(r[1]), x, y + 2.5, { size: 7.2, font: 'mono' });
        y += 5.8;
      });
    }

    pairs([
      ['Stockpiles', t.piles],
      ['Volume', t.volume != null ? geo.fmtVol(t.volume) : 'not calculated'],
      ['Locations', t.primary + (t.required ? ' of ' + t.required : '')],
      ['Laboratory samples', t.labSamples]
    ], bx + w * 0.40);

    pairs([
      ['Coordinate system', geo.isAbsolute(g) ? g.crs : 'local grid'],
      ['Scale', L.fitted ? (L.denom ? '1:' + L.denom + ' approx' : 'fitted') : '1:' + L.denom],
      ['Plan date', p.plannedDate || '—'],
      ['Prepared by', p.preparedBy || '—']
    ], bx + w * 0.63);

    page.text('Sheet ' + sheetNo + ' of ' + total, bx + w, by + 5,
      { size: 10, font: 'helvB', align: 'right' });

    var used = {};
    p.samples.forEach(function (sm) { used[sm.type] = true; });
    var items = ASM.plan.SAMPLE_TYPES.filter(function (ty) { return used[ty.id]; });
    var lx = bx + w, ly = by + 11.5;
    items.slice().reverse().forEach(function (ty) {
      var tw = page.measure(ty.name, 'helv', 7);
      page.text(ty.name, lx - tw, ly, { size: 7 });
      page.circle(lx - tw - 2.2, ly - 1.1, 1.05, { fill: ty.color, stroke: '#1B2523', width: 0.15 });
      lx -= tw + 7.5;
    });

    page.line(bx, by + BLOCK - 4.2, bx + w, by + BLOCK - 4.2, { width: 0.2, color: '#CFD8D4' });
    page.text(ASM.plan.describeRule(p.rule) + '   ·   QA/QC: ' + ASM.plan.describeQA(p.qa),
      bx, by + BLOCK - 3.2, { size: 6.6, color: '#5A6B64' });
  }

  /* Rows of the schedule that fit one sheet, so the total page count is known
   * before any of them is drawn. */
  function scheduleRows(L) {
    var avail = L.page.h - MARGIN * 2 - 14;
    return Math.max(5, Math.floor(avail / 5.2));
  }

  function pdfSchedule(doc, L, o, rows, firstSheet, total) {
    var perPage = scheduleRows(L);
    var cols = [
      ['ID', 0.00, 'helvB'], ['Stockpile', 0.13], ['Type', 0.27],
      ['From', 0.40], ['To', 0.46], ['mE', 0.53], ['mN', 0.68], ['Status', 0.83], ['Collected', 0.93]
    ];
    var w = L.page.w - MARGIN * 2;
    var made = 0;

    for (var start = 1; start < rows.length; start += perPage) {
      var page = doc.addPage(L.page.w, L.page.h);
      made++;
      var y = MARGIN + 6;
      page.text('Sample schedule — ' + (S.project.name || ''), MARGIN, y, { size: 12, font: 'helvB' });
      y += 7;
      cols.forEach(function (c) {
        page.text(c[0].toUpperCase(), MARGIN + w * c[1], y, { size: 6.4, font: 'helvB', color: '#3E4D47' });
      });
      y += 2.2;
      page.line(MARGIN, y, MARGIN + w, y, { width: 0.4, color: '#16211D' });
      y += 3.4;

      for (var r = start; r < Math.min(start + perPage, rows.length); r++) {
        var row = rows[r];
        cols.forEach(function (c, ci) {
          if (ci >= row.length) return;
          page.text(String(row[ci] == null ? '' : row[ci]), MARGIN + w * c[1], y,
            { size: 7.2, font: ci === 0 ? 'helvB' : 'mono' });
        });
        // A rule under the last column to sign against.
        page.line(MARGIN + w * 0.93, y + 1.1, MARGIN + w, y + 1.1, { width: 0.15, color: '#8D9C96' });
        y += 5.2;
        page.line(MARGIN, y - 3.4, MARGIN + w, y - 3.4, { width: 0.1, color: '#D2DAD6' });
      }

      page.text('Sheet ' + (firstSheet + made - 1) + ' of ' + total,
        L.page.w - MARGIN, L.page.h - MARGIN - 1, { size: 8, font: 'helvB', align: 'right' });
    }
    return made;
  }

  function scheduleTable() {
    var imgH = S.image ? S.image.height : 0;
    var all = ASM.exporter.sampleRows(S.project, imgH);
    var head = all[0];
    var keep = ['Sample_ID', 'Stockpile', 'Sample_type', 'Depth_from_m', 'Depth_to_m',
      'Easting_mE', 'Northing_mN', 'Status'];
    var idx = keep.map(function (k) { return head.indexOf(k); });
    return all.map(function (row) {
      return idx.map(function (i) { return i >= 0 ? row[i] : ''; });
    });
  }

  /** Build the whole document and hand back a PDF blob. */
  function makePDF(o) {
    o = Object.assign(defaults(), opts(), o || {});
    if (!S.image) return Promise.reject(new Error('no image'));

    var L = layout(o);
    var list = sheetList(L);
    if (L.fitted) list = [{ no: 1, col: 0, row: 0 }];
    if (!list.length) return Promise.reject(new Error('every sheet is skipped'));

    var wantOverview = o.overview && !L.fitted && list.length > 1;
    var rows = o.schedule && S.project.samples.length ? scheduleTable() : null;
    var schedulePages = rows ? Math.ceil((rows.length - 1) / scheduleRows(L)) : 0;
    var total = list.length + (wantOverview ? 1 : 0) + schedulePages;

    var doc = ASM.pdf.create();
    var sheetNo = 0;

    function placeMap(canvas, caption) {
      return ASM.pdf.canvasJPEG(canvas, 0.88).then(function (bytes) {
        canvas.width = canvas.height = 0;
        var idx = doc.addJPEG(bytes);
        var info = ASM.pdf.jpegInfo(bytes);
        // Fit inside the map area and centre, the way the screen preview does.
        var s = Math.min(L.mapW / info.width, L.mapH / info.height);
        var dw = info.width * s, dh = info.height * s;
        var page = doc.addPage(L.page.w, L.page.h);
        page.image(idx, MARGIN + (L.mapW - dw) / 2, MARGIN + (L.mapH - dh) / 2, dw, dh);
        sheetNo++;
        pdfBlock(page, L, o, sheetNo, total, caption);
        return page;
      });
    }

    var chain = Promise.resolve();
    if (wantOverview) {
      chain = chain.then(function () {
        return placeMap(renderOverview(L, o),
          'Sheet index — ' + list.length + ' map sheets at 1:' + L.denom);
      });
    }
    list.forEach(function (sh, i) {
      chain = chain.then(function () {
        return placeMap(renderTile(L, sh.col, sh.row, o),
          L.fitted ? null : 'Map sheet ' + (i + 1) + ' of ' + list.length +
            ' — row ' + (sh.row + 1) + ', column ' + (sh.col + 1));
      });
    });

    return chain.then(function () {
      if (rows) pdfSchedule(doc, L, o, rows, sheetNo + 1, total);
      return { blob: doc.build({ title: S.project.name }), sheets: total, layout: L };
    });
  }

  /* ===================== In-app layout mode ===================== */

  var LO = { on: false, drag: null, moved: false };

  function isLayoutOn() { return LO.on; }

  function openLayout() {
    if (!S.image) return;
    LO.on = true;
    document.documentElement.setAttribute('data-mode', 'layout');
    document.getElementById('layoutUI').hidden = false;
    syncLayoutBar();
    if (ASM.app && ASM.app.fit) ASM.app.fit();
    if (ASM.app) ASM.app.requestDraw();
  }

  function closeLayout() {
    LO.on = false;
    document.documentElement.removeAttribute('data-mode');
    document.getElementById('layoutUI').hidden = true;
    if (ASM.app) ASM.app.requestDraw();
  }

  /** The sheet grid, drawn over the live map so the split can be judged. */
  function drawOverlay(ctx, view) {
    if (!LO.on) return;
    var o = opts();
    var L = layout(o);
    if (L.fitted) return;

    var n = 0;
    ctx.save();
    ctx.font = '700 13px Barlow, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (var r = 0; r < L.rows; r++) {
      for (var c = 0; c < L.cols; c++) {
        n++;
        var og = sheetOrigin(L, c, r);
        var x = og.x * view.scale + view.tx;
        var y = og.y * view.scale + view.ty;
        var w = L.tileW * view.scale;
        var h = L.tileH * view.scale;
        var off = isSkipped(n);

        ctx.fillStyle = off ? 'rgba(12,18,16,0.45)' : 'rgba(226,98,12,0.07)';
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = off ? 'rgba(160,170,166,0.8)' : 'rgba(226,98,12,0.95)';
        ctx.lineWidth = 2;
        ctx.setLineDash(off ? [6, 5] : []);
        ctx.strokeRect(x, y, w, h);
        ctx.setLineDash([]);

        var bw = 30, bh = 22;
        ctx.fillStyle = off ? 'rgba(20,28,25,0.85)' : 'rgba(255,255,255,0.92)';
        ctx.fillRect(x + 8, y + 8, bw, bh);
        ctx.strokeStyle = off ? 'rgba(160,170,166,0.8)' : 'rgba(226,98,12,0.95)';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x + 8, y + 8, bw, bh);
        ctx.fillStyle = off ? '#9EAFA9' : '#7A3405';
        ctx.fillText(off ? '—' : String(n), x + 8 + bw / 2, y + 8 + bh / 2);
      }
    }
    ctx.restore();
  }

  function sheetAt(px, py) {
    var L = layout(opts());
    if (L.fitted) return 0;
    var n = 0;
    for (var r = 0; r < L.rows; r++) {
      for (var c = 0; c < L.cols; c++) {
        n++;
        var og = sheetOrigin(L, c, r);
        if (px >= og.x && px <= og.x + L.tileW && py >= og.y && py <= og.y + L.tileH) return n;
      }
    }
    return 0;
  }

  /* Dragging inside the grid slides it; outside, the map pans as usual. */
  function onPointerDown(p) {
    if (!LO.on) return false;
    if (!sheetAt(p[0], p[1])) return false;
    var o = opts();
    LO.drag = { px: p[0], py: p[1], ox: o.offsetX, oy: o.offsetY };
    LO.moved = false;
    return true;
  }

  function onPointerMove(p) {
    if (!LO.drag) return false;
    var o = opts();
    var dx = p[0] - LO.drag.px, dy = p[1] - LO.drag.py;
    if (Math.abs(dx) + Math.abs(dy) > 3) LO.moved = true;
    o.offsetX = LO.drag.ox + dx;
    o.offsetY = LO.drag.oy + dy;
    syncLayoutBar();
    if (ASM.app) ASM.app.requestDraw();
    return true;
  }

  function onPointerUp(p) {
    if (!LO.drag) return false;
    var wasDrag = LO.moved;
    LO.drag = null;
    if (!wasDrag && p) {
      var n = sheetAt(p[0], p[1]);
      if (n) {
        toggleSkip(n);
        syncLayoutBar();
        if (ASM.app) ASM.app.requestDraw();
      }
    }
    store.saveLocal();
    return true;
  }

  function syncLayoutBar() {
    var o = opts();
    var L = layout(o);
    var list = L.fitted ? [{}] : sheetList(L);
    var el = document.getElementById('loSheets');
    if (el) {
      el.textContent = L.fitted ? '1 sheet' : list.length + ' of ' + L.sheets + ' sheets';
    }
    var el2 = document.getElementById('loScaleText');
    if (el2) el2.textContent = describe(o);
    ['loPaper', 'loOrient', 'loScale'].forEach(function (id) {
      var node = document.getElementById(id);
      if (!node) return;
      var key = id === 'loPaper' ? 'paper' : (id === 'loOrient' ? 'orientation' : 'scale');
      node.value = String(o[key]);
    });
  }

  function centreGrid() {
    var o = opts();
    var L = layout(Object.assign({}, o, { offsetX: 0, offsetY: 0 }));
    if (!L.fitted) {
      // Middle the covered area on the plan so the spare overlap is shared.
      o.offsetX = -(L.cols * L.stepW + L.tileW * OVERLAP - L.extent.w) / 2;
      o.offsetY = -(L.rows * L.stepH + L.tileH * OVERLAP - L.extent.h) / 2;
    } else {
      o.offsetX = 0; o.offsetY = 0;
    }
    o.skip = [];
    syncLayoutBar();
    if (ASM.app) ASM.app.requestDraw();
  }

  ASM.printer = {
    defaults: defaults,
    opts: opts,
    setOpt: setOpt,
    layout: layout,
    describe: describe,
    build: build,
    print: print,
    makePDF: makePDF,
    openLayout: openLayout,
    closeLayout: closeLayout,
    isLayoutOn: isLayoutOn,
    drawOverlay: drawOverlay,
    onPointerDown: onPointerDown,
    onPointerMove: onPointerMove,
    onPointerUp: onPointerUp,
    syncLayoutBar: syncLayoutBar,
    centreGrid: centreGrid,
    toggleSkip: toggleSkip,
    sheetList: sheetList,
    PAPER: PAPER
  };
})(window.ASM = window.ASM || {});
