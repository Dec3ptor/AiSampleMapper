/* export.js — everything that leaves the app: field CSVs, GIS files, the
 * report figure, and the project file.
 *
 * Saving works two ways. Opened as a local file the app uses an ordinary
 * download link; published as a Claude Artifact the viewer sandbox blocks
 * those, so it asks the host to save instead. Copy-to-clipboard is always
 * offered as a fallback, because a blocked download must never lose work.
 */
(function (ASM) {
  'use strict';

  var downloadsCap; // memoised promise for the host save capability

  function hostDownloads() {
    if (downloadsCap === undefined) {
      downloadsCap = (window.claude && typeof window.claude.use === 'function')
        ? window.claude.use('downloads').catch(function () { return null; })
        : Promise.resolve(null);
    }
    return downloadsCap;
  }

  // The host save surface only accepts these extensions.
  var HOST_EXT = ['gif', 'png', 'jpg', 'jpeg', 'webp', 'mp4', 'webm', 'txt', 'json', 'md',
    'docx', 'pptx', 'epub', 'csv', 'ttf', 'html', 'svg', 'pdf', 'xlsx', 'zip'];

  function extOf(name) {
    var m = /\.([A-Za-z0-9]+)$/.exec(name);
    return m ? m[1].toLowerCase() : '';
  }

  /** Save a generated file. Resolves {ok, how, message}. */
  function saveFile(filename, data, mime, altExt) {
    return hostDownloads().then(function (dl) {
      if (dl && dl.save) {
        var name = filename;
        if (HOST_EXT.indexOf(extOf(name)) === -1) {
          name = name.replace(/\.[^.]+$/, '') + '.' + (altExt || 'txt');
        }
        var payload = data instanceof Blob ? data : String(data);
        return dl.save({ filename: name, data: payload }).then(function (res) {
          return { ok: true, how: res.status, name: name };
        }).catch(function (err) {
          var code = err && err.code;
          if (code === 'declined') return { ok: false, how: 'declined', message: 'Save cancelled.' };
          return { ok: false, how: code || 'error', message: 'Could not save (' + (code || 'error') + '). Use Copy instead.' };
        });
      }
      return linkDownload(filename, data, mime);
    });
  }

  function linkDownload(filename, data, mime) {
    try {
      var blob = data instanceof Blob ? data : new Blob([data], { type: mime || 'text/plain;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      return { ok: true, how: 'saved', name: filename };
    } catch (e) {
      return { ok: false, how: 'error', message: 'Download blocked. Use Copy instead.' };
    }
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return legacyCopy(text); });
    }
    return Promise.resolve(legacyCopy(text));
  }

  function legacyCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) { return false; }
  }

  /* --- Row building ------------------------------------------------------- */

  function csvCell(v) {
    if (v == null) return '';
    var s = String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function csvRows(rows) {
    return rows.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n') + '\r\n';
  }

  function sampleRows(p, imgH) {
    var g = p.georef;
    var absolute = ASM.geo.isAbsolute(g);
    var header = ['Sample_ID', 'Stockpile', 'Sample_type', 'Status', 'Depth_from_m', 'Depth_to_m',
      'Matrix', 'Increments', 'Easting_mE', 'Northing_mN', 'Latitude', 'Longitude',
      'Local_X_m', 'Local_Y_m', 'Image_col_px', 'Image_row_px', 'Planned_date', 'Collected_date', 'Notes'];
    var rows = [header];

    var ordered = p.samples.slice().sort(function (a, b) {
      return String(a.code).localeCompare(String(b.code), 'en', { numeric: true });
    });

    ordered.forEach(function (s) {
      var pile = ASM.store.pileById(s.stockpileId);
      var ground = ASM.geo.pixelToGround(g, s.px, s.py, imgH);
      var ll = absolute ? ASM.geo.groundToLatLon(g, ground.x, ground.y) : null;
      rows.push([
        s.code,
        pile ? pile.name : '',
        ASM.plan.typeById(s.type).name,
        s.status,
        s.depthFrom, s.depthTo,
        s.matrix,
        s.type === 'composite' ? s.increments : '',
        absolute ? ground.x.toFixed(2) : '',
        absolute ? ground.y.toFixed(2) : '',
        ll ? ll.lat.toFixed(7) : '',
        ll ? ll.lon.toFixed(7) : '',
        ASM.geo.hasScale(g) && !absolute ? ground.x.toFixed(2) : '',
        ASM.geo.hasScale(g) && !absolute ? ground.y.toFixed(2) : '',
        s.px.toFixed(1), s.py.toFixed(1),
        p.plannedDate || '',
        s.collectedDate || '',
        s.notes || ''
      ]);
    });
    return rows;
  }

  function pileRows(p) {
    var header = ['Stockpile', 'Material', 'Footprint_area_m2', 'Mean_height_m', 'Pile_form',
      'Form_factor', 'Volume_m3', 'Required_locations', 'Planned_locations', 'QA_locations',
      'Shortfall', 'Notes'];
    var rows = [header];
    p.stockpiles.forEach(function (pile) {
      var st = ASM.store.pileStats(pile);
      var form = ASM.plan.formById(pile.formId);
      var factor = pile.formId === 'custom' ? pile.customFactor : form.factor;
      rows.push([
        pile.name, pile.material,
        st.areaM2 != null ? st.areaM2.toFixed(1) : '',
        pile.heightM,
        form.name,
        pile.volumeOverride ? 'n/a (volume entered)' : factor,
        st.volume != null ? Math.round(st.volume) : '',
        st.required != null ? st.required : '',
        st.placed, st.qaPlaced,
        st.shortfall != null ? st.shortfall : '',
        pile.notes || ''
      ]);
    });
    return rows;
  }

  function samplesCSV(p, imgH) { return csvRows(sampleRows(p, imgH)); }
  function pilesCSV(p) { return csvRows(pileRows(p)); }

  /* --- GIS formats -------------------------------------------------------- */

  function geojson(p, imgH) {
    var g = p.georef;
    var absolute = ASM.geo.isAbsolute(g);
    function coord(px, py) {
      var ground = ASM.geo.pixelToGround(g, px, py, imgH);
      if (absolute) {
        var ll = ASM.geo.groundToLatLon(g, ground.x, ground.y);
        if (ll) return [+ll.lon.toFixed(8), +ll.lat.toFixed(8)];
      }
      return [+ground.x.toFixed(3), +ground.y.toFixed(3)];
    }

    var features = [];
    p.stockpiles.forEach(function (pile) {
      var st = ASM.store.pileStats(pile);
      var ring = pile.polygon.map(function (pt) { return coord(pt[0], pt[1]); });
      if (ring.length) ring.push(ring[0].slice());
      features.push({
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [ring] },
        properties: {
          feature: 'stockpile',
          name: pile.name,
          material: pile.material,
          area_m2: st.areaM2 != null ? +st.areaM2.toFixed(1) : null,
          height_m: pile.heightM,
          volume_m3: st.volume != null ? Math.round(st.volume) : null,
          required_locations: st.required,
          planned_locations: st.placed,
          notes: pile.notes
        }
      });
    });

    p.samples.forEach(function (s) {
      var pile = ASM.store.pileById(s.stockpileId);
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: coord(s.px, s.py) },
        properties: {
          feature: 'sample',
          sample_id: s.code,
          stockpile: pile ? pile.name : null,
          sample_type: ASM.plan.typeById(s.type).name,
          status: s.status,
          depth_from_m: s.depthFrom,
          depth_to_m: s.depthTo,
          matrix: s.matrix,
          notes: s.notes
        }
      });
    });

    var fc = {
      type: 'FeatureCollection',
      name: p.name || 'Sampling plan',
      metadata: {
        generated: new Date().toISOString(),
        coordinates: absolute ? 'WGS84 lon/lat, projected from ' + g.crs : 'local grid in metres (image not georeferenced)',
        source_crs: g.crs,
        scale_source: g.source,
        metres_per_pixel: g.mppx,
        sampling_rule: ASM.plan.describeRule(p.rule),
        qaqc: ASM.plan.describeQA(p.qa)
      },
      features: features
    };
    return JSON.stringify(fc, null, 2);
  }

  function kml(p, imgH) {
    var g = p.georef;
    if (!ASM.geo.isAbsolute(g)) return null;
    function ll(px, py) {
      var ground = ASM.geo.pixelToGround(g, px, py, imgH);
      var c = ASM.geo.groundToLatLon(g, ground.x, ground.y);
      return c.lon.toFixed(8) + ',' + c.lat.toFixed(8) + ',0';
    }
    function esc(s) {
      return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    var out = ['<?xml version="1.0" encoding="UTF-8"?>',
      '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>',
      '<name>' + esc(p.name) + '</name>'];

    ASM.plan.SAMPLE_TYPES.forEach(function (t) {
      var bgr = t.color.replace('#', '');
      var abgr = 'ff' + bgr.slice(4, 6) + bgr.slice(2, 4) + bgr.slice(0, 2);
      out.push('<Style id="t_' + t.id + '"><IconStyle><color>' + abgr + '</color><scale>1.1</scale>' +
        '<Icon><href>http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href></Icon></IconStyle></Style>');
    });

    out.push('<Folder><name>Stockpiles</name>');
    p.stockpiles.forEach(function (pile) {
      var st = ASM.store.pileStats(pile);
      var ring = pile.polygon.map(function (pt) { return ll(pt[0], pt[1]); });
      if (ring.length) ring.push(ring[0]);
      out.push('<Placemark><name>' + esc(pile.name) + '</name><description>' +
        esc((st.volume != null ? Math.round(st.volume) + ' m3; ' : '') +
            (st.required != null ? st.required + ' locations required' : '')) +
        '</description><Polygon><outerBoundaryIs><LinearRing><coordinates>' +
        ring.join(' ') + '</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>');
    });
    out.push('</Folder><Folder><name>Sample locations</name>');
    p.samples.forEach(function (s) {
      var pile = ASM.store.pileById(s.stockpileId);
      out.push('<Placemark><name>' + esc(s.code) + '</name>' +
        '<styleUrl>#t_' + s.type + '</styleUrl>' +
        '<description>' + esc((pile ? pile.name + ' — ' : '') + ASM.plan.typeById(s.type).name +
          ', ' + s.depthFrom + '–' + s.depthTo + ' m') + '</description>' +
        '<Point><coordinates>' + ll(s.px, s.py) + '</coordinates></Point></Placemark>');
    });
    out.push('</Folder></Document></kml>');
    return out.join('\n');
  }

  /* --- Report figure ------------------------------------------------------ */

  function figurePNG(opts) {
    var p = ASM.store.state.project;
    var img = ASM.store.state.image;
    var outW = opts.width || 2400;
    var margin = Math.round(outW * 0.015);
    var titleH = Math.round(outW * 0.098);
    var mapW = outW - margin * 2;

    var srcW = img ? img.width : 1200;
    var srcH = img ? img.height : 900;
    var region = opts.region || { x: 0, y: 0, w: srcW, h: srcH };
    var mapH = Math.round(mapW * region.h / region.w);
    var outH = mapH + titleH + margin * 3;

    var cv = document.createElement('canvas');
    cv.width = outW;
    cv.height = outH;
    var ctx = cv.getContext('2d');

    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, outW, outH);

    ctx.save();
    ctx.beginPath();
    ctx.rect(margin, margin, mapW, mapH);
    ctx.clip();

    var view = { scale: mapW / region.w, tx: margin - region.x * (mapW / region.w), ty: margin - region.y * (mapW / region.w) };
    var labelScale = Math.max(1, outW / 1400);

    ASM.render.drawScene(ctx, {
      width: outW, height: outH, view: view, project: p, image: img,
      ui: {}, forExport: true, background: '#FFFFFF', labelScale: labelScale
    });
    ctx.restore();

    ctx.strokeStyle = '#1B2523';
    ctx.lineWidth = 2;
    ctx.strokeRect(margin, margin, mapW, mapH);

    var barTarget = Math.round(outW * 0.13);
    var arrowR = Math.round(outW * 0.017);
    ASM.render.drawScaleBar(ctx, view, p.georef, margin + 26,
      margin + mapH - Math.round(outW * 0.022), barTarget);
    ASM.render.drawNorthArrow(ctx, margin + mapW - arrowR * 2.4, margin + arrowR * 2.2,
      ASM.render.northAngle(p.georef, srcH), arrowR);

    drawTitleBlock(ctx, p, margin, margin * 2 + mapH, mapW, titleH, labelScale);

    return new Promise(function (resolve) {
      cv.toBlob(function (b) { resolve(b); }, 'image/png');
    });
  }

  function drawTitleBlock(ctx, p, x, y, w, h, s) {
    ctx.fillStyle = '#F2F4F3';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = '#1B2523';
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);

    var t = ASM.store.totals();
    var pad = Math.round(h * 0.12);
    var col1 = x + pad;
    var colW = w / 3.4;

    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';

    ctx.fillStyle = '#5A6B64';
    ctx.font = '600 ' + Math.round(11 * s) + 'px "Barlow Condensed", system-ui, sans-serif';
    ctx.fillText('CONTAMINATED LAND — STOCKPILE SAMPLING PLAN', col1, y + pad * 0.7);

    ctx.fillStyle = '#16211D';
    ctx.font = '700 ' + Math.round(22 * s) + 'px Barlow, system-ui, sans-serif';
    ctx.fillText(p.name || 'Untitled sampling plan', col1, y + pad * 0.7 + 15 * s);

    ctx.font = '400 ' + Math.round(12 * s) + 'px Barlow, system-ui, sans-serif';
    ctx.fillStyle = '#3E4D47';
    var line3 = [p.client, p.jobRef].filter(Boolean).join('  ·  ');
    if (line3) ctx.fillText(line3, col1, y + pad * 0.7 + 42 * s);

    function pairs(list, cx, startY) {
      var yy = startY;
      list.forEach(function (row) {
        ctx.font = '600 ' + Math.round(10 * s) + 'px "Barlow Condensed", system-ui, sans-serif';
        ctx.fillStyle = '#6B7D76';
        ctx.fillText(row[0].toUpperCase(), cx, yy);
        ctx.font = '500 ' + Math.round(12.5 * s) + 'px "IBM Plex Mono", ui-monospace, monospace';
        ctx.fillStyle = '#16211D';
        ctx.fillText(String(row[1]), cx, yy + 12 * s);
        yy += 28 * s;
      });
    }

    var g = p.georef;
    pairs([
      ['Stockpiles', t.piles],
      ['Total volume', t.volume != null ? ASM.geo.fmtVol(t.volume) : 'not calculated'],
      ['Locations planned', t.primary + (t.required ? ' of ' + t.required + ' required' : '')]
    ], x + colW * 1.15, y + pad * 0.7);

    pairs([
      ['Coordinate system', ASM.geo.isAbsolute(g) ? g.crs + ' (NZTM2000)' : 'local grid — not georeferenced'],
      ['Image scale', ASM.geo.hasScale(g) ? g.mppx.toFixed(4) + ' m/pixel (' + g.source + ')' : 'not set'],
      ['Plan date', p.plannedDate || '—']
    ], x + colW * 2.15, y + pad * 0.7);

    // Legend sits on the bottom rule, right-aligned; measure it before drawing
    // so the basis statement can be clipped to whatever room is left.
    var used = {};
    p.samples.forEach(function (sm) { used[sm.type] = true; });
    var items = ASM.plan.SAMPLE_TYPES.filter(function (ty) { return used[ty.id]; });

    ctx.font = '500 ' + Math.round(11 * s) + 'px Barlow, system-ui, sans-serif';
    var gapAfter = 22 * s, legW = 0;
    items.forEach(function (ty) { legW += 15 * s + ctx.measureText(ty.name).width + gapAfter; });

    var baseY = y + h - pad * 0.55 - 11 * s;
    var midY = baseY + 5.5 * s;
    var lx = x + w - pad - legW + gapAfter;

    ctx.textBaseline = 'middle';
    items.forEach(function (ty) {
      ctx.beginPath();
      ctx.arc(lx + 5 * s, midY, 5 * s, 0, Math.PI * 2);
      ctx.fillStyle = ty.color;
      ctx.fill();
      ctx.strokeStyle = '#1B2523';
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.fillStyle = '#16211D';
      ctx.fillText(ty.name, lx + 15 * s, midY);
      lx += 15 * s + ctx.measureText(ty.name).width + gapAfter;
    });
    ctx.textBaseline = 'top';

    var basis = 'Density rule: ' + ASM.plan.describeRule(p.rule) + '     QA/QC: ' + ASM.plan.describeQA(p.qa);
    var room = (items.length ? x + w - pad - legW : x + w - pad) - col1 - 14 * s;
    ctx.save();
    ctx.beginPath();
    ctx.rect(col1, baseY - 4 * s, Math.max(40, room), 18 * s);
    ctx.clip();
    ctx.font = '400 ' + Math.round(10.5 * s) + 'px Barlow, system-ui, sans-serif';
    ctx.fillStyle = '#5A6B64';
    ctx.fillText(basis, col1, baseY);
    ctx.restore();
  }

  /* --- Project file ------------------------------------------------------- */

  function projectJSON() {
    var p = ASM.store.state.project;
    return JSON.stringify({
      format: 'AiSampleMapper project',
      version: p.version,
      exported: new Date().toISOString(),
      project: p
    }, null, 2);
  }

  function slug(s) {
    return String(s || 'sampling-plan').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'sampling-plan';
  }

  ASM.exporter = {
    saveFile: saveFile,
    copyText: copyText,
    samplesCSV: samplesCSV,
    pilesCSV: pilesCSV,
    sampleRows: sampleRows,
    pileRows: pileRows,
    geojson: geojson,
    kml: kml,
    figurePNG: figurePNG,
    projectJSON: projectJSON,
    hostDownloads: hostDownloads,
    slug: slug
  };
})(window.ASM = window.ASM || {});
