/* geometry.js — polygon measurement and sample-location generation.
 * All functions work in image-pixel space; callers convert to metres with the
 * georef so that a change of scale never invalidates stored geometry.
 */
(function (ASM) {
  'use strict';

  function area(poly) {
    var n = poly.length, s = 0;
    if (n < 3) return 0;
    for (var i = 0, j = n - 1; i < n; j = i++) {
      s += (poly[j][0] + poly[i][0]) * (poly[j][1] - poly[i][1]);
    }
    return Math.abs(s / 2);
  }

  function perimeter(poly) {
    var n = poly.length, s = 0;
    if (n < 2) return 0;
    for (var i = 0; i < n; i++) {
      var a = poly[i], b = poly[(i + 1) % n];
      s += Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
    return s;
  }

  function centroid(poly) {
    var n = poly.length;
    if (!n) return [0, 0];
    if (n < 3) {
      var sx = 0, sy = 0;
      for (var k = 0; k < n; k++) { sx += poly[k][0]; sy += poly[k][1]; }
      return [sx / n, sy / n];
    }
    var cx = 0, cy = 0, A = 0;
    for (var i = 0, j = n - 1; i < n; j = i++) {
      var cross = poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
      A += cross;
      cx += (poly[j][0] + poly[i][0]) * cross;
      cy += (poly[j][1] + poly[i][1]) * cross;
    }
    A = A / 2;
    if (Math.abs(A) < 1e-9) return poly[0].slice();
    return [cx / (6 * A), cy / (6 * A)];
  }

  function bbox(poly) {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (var i = 0; i < poly.length; i++) {
      if (poly[i][0] < x0) x0 = poly[i][0];
      if (poly[i][1] < y0) y0 = poly[i][1];
      if (poly[i][0] > x1) x1 = poly[i][0];
      if (poly[i][1] > y1) y1 = poly[i][1];
    }
    return { x0: x0, y0: y0, x1: x1, y1: y1, w: x1 - x0, h: y1 - y0 };
  }

  function contains(poly, x, y) {
    var inside = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      var xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }

  /** Shortest distance from a point to a polygon's edges. */
  function distToEdge(poly, x, y) {
    var best = Infinity;
    for (var i = 0; i < poly.length; i++) {
      var a = poly[i], b = poly[(i + 1) % poly.length];
      var vx = b[0] - a[0], vy = b[1] - a[1];
      var len2 = vx * vx + vy * vy;
      var t = len2 ? Math.max(0, Math.min(1, ((x - a[0]) * vx + (y - a[1]) * vy) / len2)) : 0;
      var d = Math.hypot(x - (a[0] + t * vx), y - (a[1] + t * vy));
      if (d < best) best = d;
    }
    return best;
  }

  function distToSegment(px, py, ax, ay, bx, by) {
    var vx = bx - ax, vy = by - ay, len2 = vx * vx + vy * vy;
    var t = len2 ? Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len2)) : 0;
    return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
  }

  /* --- Sample location generation ---------------------------------------- */
  /* Each generator returns up to n points inside the polygon, inset from the
   * edge so a sampler is not sent to the toe of the pile where the material is
   * least representative. */

  function mulberry32(seed) {
    var t = seed >>> 0;
    return function () {
      t = (t + 0x6D2B79F5) >>> 0;
      var r = Math.imul(t ^ (t >>> 15), 1 | t);
      r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }

  function randomPoints(poly, n, inset, seed) {
    var bb = bbox(poly), rnd = mulberry32(seed || 1), out = [];
    var guard = n * 800 + 2000;
    while (out.length < n && guard-- > 0) {
      var x = bb.x0 + rnd() * bb.w, y = bb.y0 + rnd() * bb.h;
      if (contains(poly, x, y) && distToEdge(poly, x, y) >= inset) out.push([x, y]);
    }
    return out;
  }

  /** Stratified random: one point per cell of a near-square grid over the bbox. */
  function stratifiedPoints(poly, n, inset, seed) {
    if (n <= 0) return [];
    var bb = bbox(poly), rnd = mulberry32(seed || 1);
    var cols = Math.max(1, Math.round(Math.sqrt(n * (bb.w || 1) / (bb.h || 1))));
    var rows = Math.max(1, Math.ceil(n / cols));
    var cells = [];
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) cells.push([c, r]);
    }
    // Shuffle so that a partial fill is not biased to the top-left.
    for (var i = cells.length - 1; i > 0; i--) {
      var j = Math.floor(rnd() * (i + 1)), tmp = cells[i]; cells[i] = cells[j]; cells[j] = tmp;
    }
    var cw = bb.w / cols, ch = bb.h / rows, out = [];
    for (var k = 0; k < cells.length && out.length < n; k++) {
      var cx = bb.x0 + cells[k][0] * cw, cy = bb.y0 + cells[k][1] * ch;
      for (var tries = 0; tries < 60; tries++) {
        var x = cx + rnd() * cw, y = cy + rnd() * ch;
        if (contains(poly, x, y) && distToEdge(poly, x, y) >= inset) { out.push([x, y]); break; }
      }
    }
    if (out.length < n) out = out.concat(randomPoints(poly, n - out.length, inset, (seed || 1) + 7));
    return out.slice(0, n);
  }

  /** Systematic grid on a random origin, spacing solved so the count lands on n. */
  function systematicPoints(poly, n, inset, seed) {
    if (n <= 0) return [];
    var bb = bbox(poly), rnd = mulberry32(seed || 1);
    var usable = area(poly);
    if (usable <= 0) return [];

    function build(spacing) {
      var ox = bb.x0 + rnd0 * spacing, oy = bb.y0 + rnd1 * spacing, pts = [];
      for (var y = oy - spacing; y <= bb.y1 + spacing; y += spacing) {
        for (var x = ox - spacing; x <= bb.x1 + spacing; x += spacing) {
          if (x >= bb.x0 && x <= bb.x1 && y >= bb.y0 && y <= bb.y1 &&
              contains(poly, x, y) && distToEdge(poly, x, y) >= inset) pts.push([x, y]);
        }
      }
      return pts;
    }
    var rnd0 = rnd(), rnd1 = rnd();

    // Bisect on spacing until the grid yields at least n points.
    var lo = Math.sqrt(usable / n) / 6, hi = Math.sqrt(usable / n) * 2, best = null;
    for (var it = 0; it < 24; it++) {
      var mid = (lo + hi) / 2;
      var pts = build(mid);
      if (pts.length >= n) { best = pts; lo = mid; } else { hi = mid; }
      if (best && best.length === n) break;
    }
    if (!best) best = build(lo) ;
    if (best.length < n) return stratifiedPoints(poly, n, inset, seed);

    // Keep an evenly spread subset: walk the list at a constant stride.
    if (best.length > n) {
      var stride = best.length / n, picked = [];
      for (var i = 0; i < n; i++) picked.push(best[Math.min(best.length - 1, Math.floor(i * stride))]);
      best = picked;
    }
    return best;
  }

  function generate(method, poly, n, inset, seed) {
    if (method === 'random') return randomPoints(poly, n, inset, seed);
    if (method === 'stratified') return stratifiedPoints(poly, n, inset, seed);
    return systematicPoints(poly, n, inset, seed);
  }

  ASM.geom = {
    area: area,
    perimeter: perimeter,
    centroid: centroid,
    bbox: bbox,
    contains: contains,
    distToEdge: distToEdge,
    distToSegment: distToSegment,
    generate: generate,
    mulberry32: mulberry32
  };
})(window.ASM = window.ASM || {});
