/* render.js — all canvas drawing.
 * The on-screen map and the exported figure run through the same draw calls so
 * what a reviewer sees in the report is exactly what was planned on screen.
 */
(function (ASM) {
  'use strict';

  var CANVAS_BG = '#161D1A';

  function makeView() { return { scale: 1, tx: 0, ty: 0 }; }

  function toScreen(view, px, py) {
    return [px * view.scale + view.tx, py * view.scale + view.ty];
  }
  function toImage(view, sx, sy) {
    return [(sx - view.tx) / view.scale, (sy - view.ty) / view.scale];
  }

  function fitView(view, imgW, imgH, vw, vh, pad) {
    pad = pad == null ? 24 : pad;
    var s = Math.min((vw - pad * 2) / imgW, (vh - pad * 2) / imgH);
    if (!isFinite(s) || s <= 0) s = 1;
    view.scale = s;
    view.tx = (vw - imgW * s) / 2;
    view.ty = (vh - imgH * s) / 2;
    return view;
  }

  function zoomAt(view, sx, sy, factor, min, max) {
    var next = Math.max(min || 0.02, Math.min(max || 80, view.scale * factor));
    var k = next / view.scale;
    view.tx = sx - (sx - view.tx) * k;
    view.ty = sy - (sy - view.ty) * k;
    view.scale = next;
    return view;
  }

  /* --- Primitives --------------------------------------------------------- */

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /** Text on a translucent slab so labels stay legible over any imagery. */
  function labelPill(ctx, x, y, text, opts) {
    opts = opts || {};
    var fs = opts.size || 12;
    ctx.font = (opts.weight || 600) + ' ' + fs + 'px Barlow, system-ui, sans-serif';
    var w = ctx.measureText(text).width;
    var padX = 5, padY = 3, h = fs + padY * 2;
    var bx = opts.center ? x - w / 2 - padX : x;
    var by = y - h / 2;
    ctx.fillStyle = opts.bg || 'rgba(12,18,16,0.78)';
    roundRect(ctx, bx, by, w + padX * 2, h, 4);
    ctx.fill();
    if (opts.border) {
      ctx.strokeStyle = opts.border;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.fillStyle = opts.color || '#fff';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, bx + padX, y + 0.5);
    return { x: bx, y: by, w: w + padX * 2, h: h };
  }

  function drawPolygon(ctx, view, poly, opts) {
    if (poly.length < 2) return;
    ctx.beginPath();
    for (var i = 0; i < poly.length; i++) {
      var s = toScreen(view, poly[i][0], poly[i][1]);
      if (i === 0) ctx.moveTo(s[0], s[1]); else ctx.lineTo(s[0], s[1]);
    }
    if (opts.close !== false) ctx.closePath();
    if (opts.fill) { ctx.fillStyle = opts.fill; ctx.fill(); }
    // White underlay keeps the outline readable over both pasture and gravel.
    if (opts.halo !== false) {
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.lineWidth = (opts.width || 2) + 2.5;
      ctx.stroke();
    }
    ctx.strokeStyle = opts.stroke || '#fff';
    ctx.lineWidth = opts.width || 2;
    ctx.setLineDash(opts.dash || []);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  function drawVertices(ctx, view, poly, color) {
    for (var i = 0; i < poly.length; i++) {
      var s = toScreen(view, poly[i][0], poly[i][1]);
      ctx.beginPath();
      ctx.arc(s[0], s[1], 4.5, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = color;
      ctx.stroke();
    }
  }

  /** One sample marker. Planned reads as a ring, collected as a solid disc. */
  function drawSample(ctx, view, s, opts) {
    opts = opts || {};
    var t = ASM.plan.typeById(s.type);
    var p = toScreen(view, s.px, s.py);
    var r = (opts.radius || 7) * (opts.scale || 1);

    ctx.beginPath();
    ctx.arc(p[0], p[1], r + 2.5, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(8,12,10,0.6)';
    ctx.fill();

    ctx.beginPath();
    ctx.arc(p[0], p[1], r, 0, Math.PI * 2);
    if (s.status === 'collected') {
      ctx.fillStyle = t.color;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#0B0F0D';
      ctx.stroke();
    } else {
      ctx.fillStyle = 'rgba(10,15,13,0.55)';
      ctx.fill();
      ctx.lineWidth = Math.max(2, r * 0.42);
      ctx.strokeStyle = t.color;
      ctx.stroke();
    }

    if (opts.selected) {
      ctx.beginPath();
      ctx.arc(p[0], p[1], r + 7, 0, Math.PI * 2);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (opts.label && s.code) {
      labelPill(ctx, p[0] + r + 6, p[1], s.code, {
        size: 11 * (opts.scale || 1),
        color: '#F4F8F6',
        bg: 'rgba(10,16,14,0.8)'
      });
    }
    return p;
  }

  /* --- Map furniture ------------------------------------------------------ */

  function niceDistance(target) {
    var pow = Math.pow(10, Math.floor(Math.log10(target)));
    var candidates = [1, 2, 5, 10].map(function (m) { return m * pow; });
    var best = candidates[0];
    for (var i = 0; i < candidates.length; i++) {
      if (Math.abs(candidates[i] - target) < Math.abs(best - target)) best = candidates[i];
    }
    return best;
  }

  function drawScaleBar(ctx, view, georef, x, y, targetPx) {
    if (!ASM.geo.hasScale(georef)) return;
    targetPx = targetPx || 140;
    var metres = niceDistance(targetPx * georef.mppx / view.scale);
    var barPx = metres / georef.mppx * view.scale;
    if (!isFinite(barPx) || barPx < 10) return;

    var h = Math.max(7, Math.round(targetPx / 20));
    var fs = Math.max(11, Math.round(targetPx / 13));
    ctx.fillStyle = 'rgba(10,16,14,0.72)';
    roundRect(ctx, x - 8, y - fs - 14, barPx + 16, h + fs + 20, 6);
    ctx.fill();

    // Alternating light/dark segments, the way a plan's bar scale is drawn.
    var segs = 4, sw = barPx / segs;
    for (var i = 0; i < segs; i++) {
      ctx.fillStyle = i % 2 ? '#0F1614' : '#F2F6F4';
      ctx.fillRect(x + i * sw, y, sw, h);
    }
    ctx.strokeStyle = '#F2F6F4';
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, barPx, h);

    ctx.fillStyle = '#F2F6F4';
    ctx.font = '600 ' + fs + 'px "IBM Plex Mono", ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('0', x - 2, y - 6);
    var lbl = metres >= 1000 ? (metres / 1000) + ' km' : metres + ' m';
    ctx.textAlign = 'right';
    ctx.fillText(lbl, x + barPx + 2, y - 6);
    ctx.textAlign = 'left';
  }

  /** Grid north, derived from the georef so a rotated image still reads true. */
  function northAngle(georef, imgH) {
    if (!georef.affine) return -Math.PI / 2;
    var a = ASM.geo.groundToPixel(georef, 0, 0, imgH);
    var b = ASM.geo.groundToPixel(georef, 0, 100, imgH);
    var dx = b.px - a.px, dy = b.py - a.py;
    if (!isFinite(dx) || !isFinite(dy) || (dx === 0 && dy === 0)) return -Math.PI / 2;
    return Math.atan2(dy, dx);
  }

  function drawNorthArrow(ctx, x, y, angle, size) {
    size = size || 17;
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = 'rgba(10,16,14,0.72)';
    ctx.beginPath();
    ctx.arc(0, 0, size + 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.rotate(angle + Math.PI / 2);
    ctx.beginPath();
    ctx.moveTo(0, -size);
    ctx.lineTo(size * 0.52, size * 0.72);
    ctx.lineTo(0, size * 0.34);
    ctx.closePath();
    ctx.fillStyle = '#F2F6F4';
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(0, -size);
    ctx.lineTo(-size * 0.52, size * 0.72);
    ctx.lineTo(0, size * 0.34);
    ctx.closePath();
    ctx.fillStyle = '#8D9C96';
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = '#F2F6F4';
    ctx.font = '700 11px Barlow, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('N', x, y - size - 1);
    ctx.textAlign = 'left';
  }

  /* --- Whole scene -------------------------------------------------------- */

  function drawScene(ctx, o) {
    var p = o.project, view = o.view, ui = o.ui || {};
    ctx.save();
    ctx.fillStyle = o.background || CANVAS_BG;
    ctx.fillRect(0, 0, o.width, o.height);

    if (o.image) {
      // Blit only the source pixels that can land on the canvas. At 20x on a
      // 35 megapixel ortho tile this is a few thousand source pixels instead of
      // all of them, which keeps the sampling exact as well as fast.
      var iw = o.image.width, ih = o.image.height, z = view.scale;
      var sx0 = Math.max(0, Math.floor((0 - view.tx) / z));
      var sy0 = Math.max(0, Math.floor((0 - view.ty) / z));
      var sx1 = Math.min(iw, Math.ceil((o.width - view.tx) / z));
      var sy1 = Math.min(ih, Math.ceil((o.height - view.ty) / z));
      if (sx1 > sx0 && sy1 > sy0) {
        // Smooth when shrinking (a high-quality downsample beats dropped
        // pixels); above 1:1 show the real pixels unless asked otherwise.
        var smooth = z < 1 || p.settings.interpolation === 'smooth';
        ctx.imageSmoothingEnabled = smooth;
        if (smooth) ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(o.image,
          sx0, sy0, sx1 - sx0, sy1 - sy0,
          view.tx + sx0 * z, view.ty + sy0 * z, (sx1 - sx0) * z, (sy1 - sy0) * z);
        ctx.imageSmoothingEnabled = true;
      }
    }

    // Stockpiles
    p.stockpiles.forEach(function (pile) {
      var selected = ui.selectedPileId === pile.id;
      drawPolygon(ctx, view, pile.polygon, {
        fill: hexA(pile.color, selected ? 0.3 : 0.17),
        stroke: pile.color,
        width: selected ? 3 : 2
      });
      if (selected && !o.forExport) drawVertices(ctx, view, pile.polygon, pile.color);
    });

    // Pile labels drawn after all polygons so they are never overdrawn.
    if (p.settings.showLabels || o.forExport) {
      p.stockpiles.forEach(function (pile) {
        // Below this size the pill covers the outline it is meant to name.
        var bb = ASM.geom.bbox(pile.polygon);
        if (!o.forExport && Math.min(bb.w, bb.h) * view.scale < 34) return;
        var c = ASM.geom.centroid(pile.polygon);
        var s = toScreen(view, c[0], c[1]);
        var st = ASM.store.pileStats(pile);
        var txt = pile.name;
        if (st.required != null) txt += '  ' + st.placed + '/' + st.required;
        labelPill(ctx, s[0], s[1], txt, {
          center: true,
          size: 12 * (o.labelScale || 1),
          color: '#fff',
          bg: 'rgba(12,18,16,0.8)',
          border: st.shortfall ? '#E2620C' : pile.color
        });
      });
    }

    // In-progress polygon
    if (ui.draft && ui.draft.length) {
      var draft = ui.draft.slice();
      if (ui.cursor) draft.push(ui.cursor);
      drawPolygon(ctx, view, draft, {
        fill: 'rgba(226,98,12,0.16)',
        stroke: '#FF8330',
        width: 2,
        dash: [6, 4],
        close: ui.draft.length > 2
      });
      drawVertices(ctx, view, ui.draft, '#FF8330');
    }

    // Samples
    p.samples.forEach(function (s) {
      drawSample(ctx, view, s, {
        radius: 7 * (p.settings.markerScale || 1),
        scale: o.labelScale || 1,
        selected: !o.forExport && ui.selectedSampleId === s.id,
        label: p.settings.showLabels || o.forExport
      });
    });

    // Measure overlay
    if (ui.measure && ui.measure.length > 1) {
      drawPolygon(ctx, view, ui.measure, {
        stroke: '#FFD21E', width: 2, dash: [7, 4],
        close: ui.measureMode === 'area',
        fill: ui.measureMode === 'area' ? 'rgba(255,210,30,0.14)' : null
      });
      drawVertices(ctx, view, ui.measure, '#FFD21E');
    }

    ctx.restore();
  }

  function hexA(hex, alpha) {
    var h = hex.replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + alpha + ')';
  }

  ASM.render = {
    CANVAS_BG: CANVAS_BG,
    makeView: makeView,
    toScreen: toScreen,
    toImage: toImage,
    fitView: fitView,
    zoomAt: zoomAt,
    drawScene: drawScene,
    drawScaleBar: drawScaleBar,
    drawNorthArrow: drawNorthArrow,
    northAngle: northAngle,
    labelPill: labelPill,
    roundRect: roundRect,
    niceDistance: niceDistance,
    hexA: hexA
  };
})(window.ASM = window.ASM || {});
