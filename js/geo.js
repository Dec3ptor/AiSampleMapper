/* geo.js — coordinate handling for AiSampleMapper.
 *
 * Two jobs:
 *   1. NZTM2000 <-> NZGD2000 (WGS84-compatible) lat/long, so a plan drawn on an
 *      orthophoto can be exported as real coordinates a GPS or GIS will accept.
 *   2. The georeference model that maps image pixels to ground units.
 *
 * Transverse Mercator equations follow the Redfearn series as published by LINZ
 * in "Projections and Coordinate Systems" — accurate to well under a millimetre
 * across New Zealand, which is three orders below the 0.268 m (95%) positional
 * accuracy of the orthophotography this tool is built for.
 */
(function (ASM) {
  'use strict';

  var DEG = Math.PI / 180;

  /* --- NZTM2000 on GRS80 / NZGD2000 ------------------------------------- */
  var NZTM = {
    a: 6378137.0,
    f: 1 / 298.257222101,
    lat0: 0.0,
    lon0: 173.0 * DEG,
    k0: 0.9996,
    FE: 1600000.0,
    FN: 10000000.0
  };

  function meridianArc(phi, a, e2) {
    var A0 = 1 - e2 / 4 - 3 * e2 * e2 / 64 - 5 * e2 * e2 * e2 / 256;
    var A2 = (3 / 8) * (e2 + e2 * e2 / 4 + 15 * e2 * e2 * e2 / 128);
    var A4 = (15 / 256) * (e2 * e2 + 3 * e2 * e2 * e2 / 4);
    var A6 = (35 / 3072) * e2 * e2 * e2;
    return a * (A0 * phi - A2 * Math.sin(2 * phi) + A4 * Math.sin(4 * phi) - A6 * Math.sin(6 * phi));
  }

  /** lat/long (degrees) -> {E, N} in NZTM2000 metres. */
  function toNZTM(latDeg, lonDeg) {
    var p = NZTM;
    var a = p.a, f = p.f, b = a * (1 - f), e2 = 2 * f - f * f;
    var phi = latDeg * DEG, lam = lonDeg * DEG;
    var sp = Math.sin(phi), cp = Math.cos(phi), t = Math.tan(phi);
    var W = Math.sqrt(1 - e2 * sp * sp);
    var nu = a / W;
    var rho = a * (1 - e2) / (W * W * W);
    var psi = nu / rho;
    var w = lam - p.lon0;
    var m = meridianArc(phi, a, e2);
    var m0 = meridianArc(p.lat0, a, e2);

    var t2 = t * t, t4 = t2 * t2, t6 = t4 * t2;
    var w2 = w * w, w3 = w2 * w, w4 = w2 * w2, w5 = w4 * w, w6 = w4 * w2, w7 = w6 * w, w8 = w4 * w4;
    var c2 = cp * cp, c3 = c2 * cp, c4 = c2 * c2, c5 = c4 * cp, c6 = c4 * c2, c7 = c6 * cp;

    var E = p.FE + p.k0 * nu * w * cp * (
      1 +
      (w2 / 6) * c2 * (psi - t2) +
      (w4 / 120) * c4 * (4 * psi * psi * psi * (1 - 6 * t2) + psi * psi * (1 + 8 * t2) - psi * 2 * t2 + t4) +
      (w6 / 5040) * c6 * (61 - 479 * t2 + 179 * t4 - t6)
    );

    var N = p.FN + p.k0 * (
      (m - m0) +
      (w2 / 2) * nu * sp * cp +
      (w4 / 24) * nu * sp * c3 * (4 * psi * psi + psi - t2) +
      (w6 / 720) * nu * sp * c5 * (8 * psi * psi * psi * psi * (11 - 24 * t2) - 28 * psi * psi * psi * (1 - 6 * t2) + psi * psi * (1 - 32 * t2) - psi * 2 * t2 + t4) +
      (w8 / 40320) * nu * sp * c7 * (1385 - 3111 * t2 + 543 * t4 - t6)
    );

    // silence unused-var lint on w3/w5/w7 kept for series symmetry
    void w3; void w5; void w7;
    return { E: E, N: N };
  }

  /** NZTM2000 {E, N} metres -> {lat, lon} in degrees. */
  function toLatLon(E, N) {
    var p = NZTM;
    var a = p.a, f = p.f, b = a * (1 - f), e2 = 2 * f - f * f;
    var Np = N - p.FN;
    var m0 = meridianArc(p.lat0, a, e2);
    var m = m0 + Np / p.k0;

    var n = (a - b) / (a + b), n2 = n * n, n3 = n2 * n, n4 = n2 * n2;
    var G = a * (1 - n) * (1 - n2) * (1 + 9 * n2 / 4 + 225 * n4 / 64);
    var sigma = m / G;

    var phi1 = sigma +
      (3 * n / 2 - 27 * n3 / 32) * Math.sin(2 * sigma) +
      (21 * n2 / 16 - 55 * n4 / 32) * Math.sin(4 * sigma) +
      (151 * n3 / 96) * Math.sin(6 * sigma) +
      (1097 * n4 / 512) * Math.sin(8 * sigma);

    var sp = Math.sin(phi1), cp = Math.cos(phi1), t = Math.tan(phi1);
    var W = Math.sqrt(1 - e2 * sp * sp);
    var nu = a / W;
    var rho = a * (1 - e2) / (W * W * W);
    var psi = nu / rho;

    // Ed is the true easting offset; x is that offset in radians of arc at the
    // footpoint. The latitude series is scaled by Ed, the longitude series by x
    // alone -- mixing the two costs several metres at the edge of the zone.
    var Ed = E - p.FE;
    var x = Ed / (p.k0 * nu);
    var t2 = t * t, t4 = t2 * t2, t6 = t4 * t2;
    var ps2 = psi * psi, ps3 = ps2 * psi, ps4 = ps2 * ps2;
    var x2 = x * x, x3 = x2 * x, x4 = x2 * x2, x5 = x4 * x, x6 = x4 * x2, x7 = x6 * x, x8 = x4 * x4;

    var lat = phi1 - (t / (p.k0 * rho)) * Ed * (
      x / 2 -
      (x3 / 24) * (-4 * ps2 + 9 * psi * (1 - t2) + 12 * t2) +
      (x5 / 720) * (8 * ps4 * (11 - 24 * t2) - 12 * ps3 * (21 - 71 * t2) + 15 * ps2 * (15 - 98 * t2 + 15 * t4) + 180 * psi * (5 * t2 - 3 * t4) + 360 * t4) -
      (x7 / 40320) * (1385 + 3633 * t2 + 4095 * t4 + 1575 * t6)
    );

    var lon = p.lon0 + (1 / cp) * (
      x -
      (x3 / 6) * (psi + 2 * t2) +
      (x5 / 120) * (-4 * ps3 * (1 - 6 * t2) + ps2 * (9 - 68 * t2) + 72 * psi * t2 + 24 * t4) -
      (x7 / 5040) * (61 + 662 * t2 + 1320 * t4 + 720 * t6)
    );

    void x2; void x4; void x6; void x8;
    return { lat: lat / DEG, lon: lon / DEG };
  }

  /* --- Georeference model ----------------------------------------------- */
  /* A georef is:
   *   mppx   metres per image pixel (null = unscaled, pixels only)
   *   affine {a,b,c,d,e,f} mapping pixel (col,row) -> ground (X,Y); null when
   *          only a scale is known, in which case coordinates are reported as
   *          a local grid with its origin at the image's bottom-left corner.
   *   crs    'EPSG:2193' (NZTM2000) | 'local'
   *   source how the scale was established, shown in exports for traceability
   */
  function emptyGeoref() {
    return { mppx: null, affine: null, crs: 'local', source: 'none', note: '' };
  }

  /** Scale only, no absolute position. */
  function fromGSD(mppx, source, note) {
    return { mppx: mppx, affine: null, crs: 'local', source: source || 'gsd', note: note || '' };
  }

  /** Six world-file coefficients, in the order they appear in a .tfw/.jgw. */
  function fromWorldFile(A, D, B, E, C, F, crs) {
    return {
      mppx: Math.sqrt(A * A + D * D),
      affine: { a: A, b: B, c: C, d: D, e: E, f: F },
      crs: crs || 'EPSG:2193',
      source: 'world',
      note: ''
    };
  }

  /** Parse the six numeric lines of a world file. Returns null if malformed. */
  function parseWorldFile(text) {
    var nums = String(text).split(/[\r\n]+/).map(function (s) { return parseFloat(s.trim()); })
      .filter(function (v) { return isFinite(v); });
    if (nums.length < 6) return null;
    return { A: nums[0], D: nums[1], B: nums[2], E: nums[3], C: nums[4], F: nums[5] };
  }

  /** North-up georef from one known point: pixel (px,py) is at ground (X,Y). */
  function fromAnchor(px, py, X, Y, mppx, crs) {
    return {
      mppx: mppx,
      affine: { a: mppx, b: 0, c: X - px * mppx, d: 0, e: -mppx, f: Y + py * mppx },
      crs: crs || 'EPSG:2193',
      source: 'anchor',
      note: ''
    };
  }

  /** Image pixel -> ground coordinate. Falls back to a local grid (y up). */
  function pixelToGround(georef, px, py, imgHeight) {
    if (georef.affine) {
      var m = georef.affine;
      return { x: m.a * px + m.b * py + m.c, y: m.d * px + m.e * py + m.f };
    }
    if (georef.mppx) {
      return { x: px * georef.mppx, y: (imgHeight - py) * georef.mppx };
    }
    return { x: px, y: py };
  }

  /** Ground coordinate -> image pixel. Inverts the affine when there is one. */
  function groundToPixel(georef, X, Y, imgHeight) {
    if (georef.affine) {
      var m = georef.affine;
      var det = m.a * m.e - m.b * m.d;
      if (!det) return { px: 0, py: 0 };
      var dx = X - m.c, dy = Y - m.f;
      return { px: (m.e * dx - m.b * dy) / det, py: (-m.d * dx + m.a * dy) / det };
    }
    if (georef.mppx) {
      return { px: X / georef.mppx, py: imgHeight - Y / georef.mppx };
    }
    return { px: X, py: Y };
  }

  /** Ground coordinate -> lat/long, when the georef carries a known CRS. */
  function groundToLatLon(georef, X, Y) {
    if (georef.crs === 'EPSG:2193') return toLatLon(X, Y);
    return null;
  }

  function hasScale(georef) { return !!(georef && georef.mppx && isFinite(georef.mppx) && georef.mppx > 0); }
  function isAbsolute(georef) { return !!(georef && georef.affine && georef.crs !== 'local'); }

  /* --- Formatting -------------------------------------------------------- */
  function fmtArea(m2) {
    if (!isFinite(m2)) return '—';
    if (m2 >= 10000) return (m2 / 10000).toFixed(2) + ' ha';
    return m2.toFixed(m2 < 100 ? 1 : 0) + ' m²';
  }
  function fmtLen(m) {
    if (!isFinite(m)) return '—';
    if (m >= 1000) return (m / 1000).toFixed(2) + ' km';
    return m.toFixed(m < 10 ? 2 : 1) + ' m';
  }
  function fmtVol(m3) {
    if (!isFinite(m3)) return '—';
    return Math.round(m3).toLocaleString('en-NZ') + ' m³';
  }
  function fmtCoord(v) { return isFinite(v) ? v.toFixed(2) : '—'; }
  function fmtLatLon(v) { return isFinite(v) ? v.toFixed(7) : '—'; }

  ASM.geo = {
    NZTM: NZTM,
    toNZTM: toNZTM,
    toLatLon: toLatLon,
    emptyGeoref: emptyGeoref,
    fromGSD: fromGSD,
    fromWorldFile: fromWorldFile,
    fromAnchor: fromAnchor,
    parseWorldFile: parseWorldFile,
    pixelToGround: pixelToGround,
    groundToPixel: groundToPixel,
    groundToLatLon: groundToLatLon,
    hasScale: hasScale,
    isAbsolute: isAbsolute,
    fmtArea: fmtArea,
    fmtLen: fmtLen,
    fmtVol: fmtVol,
    fmtCoord: fmtCoord,
    fmtLatLon: fmtLatLon
  };
})(window.ASM = window.ASM || {});
