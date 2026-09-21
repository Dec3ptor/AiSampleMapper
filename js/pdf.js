/* pdf.js — a small PDF writer.
 *
 * Enough of PDF 1.4 to place JPEG images and draw text and lines: pages,
 * content streams, image XObjects and the base-14 fonts. That is all a map
 * sheet needs, and writing it here rather than pulling in a library keeps the
 * app dependency-free and working with no network, which is the whole point of
 * the offline shell.
 *
 * JPEGs go in untouched as DCTDecode streams, so there is no encoder to write
 * and no quality lost re-compressing. Text is real text in the file: Helvetica
 * and Courier are built into every reader, so nothing needs embedding and the
 * title block stays selectable and sharp at any zoom.
 */
(function (ASM) {
  'use strict';

  var MM = 72 / 25.4;     // millimetres to PDF points

  /* Advance widths per 1000 units for the base-14 faces, ASCII 32-126. Needed
   * because the layout right-aligns and centres text, and a PDF reader will not
   * measure it for us. */
  var W_HELV = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,
    556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,
    667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,
    278,278,278,469,556,333,
    556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,
    334,260,334,584];
  var W_HELVB = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,
    556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,
    722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,
    333,278,333,584,556,333,
    556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,
    389,280,389,584];

  var FONTS = {
    helv: { name: 'Helvetica', widths: W_HELV },
    helvB: { name: 'Helvetica-Bold', widths: W_HELVB },
    mono: { name: 'Courier', widths: null },        // fixed 600
    monoB: { name: 'Courier-Bold', widths: null }
  };

  /* WinAnsi has most of what the app writes; the rest gets a plain-text stand-in
   * so a degree sign never turns into mojibake in someone's report. */
  var WINANSI = {
    '—': 0x97, '–': 0x96, '‘': 0x91, '’': 0x92,
    '“': 0x93, '”': 0x94, '•': 0x95, '·': 0xB7,
    '°': 0xB0, '±': 0xB1, '²': 0xB2, '³': 0xB3,
    '×': 0xD7, 'é': 0xE9, '…': 0x85
  };
  var ASCII_FALLBACK = { '≈': '~', '≤': '<=', '≥': '>=', ' ': ' ' };

  function encodeText(str) {
    var out = '';
    for (var i = 0; i < str.length; i++) {
      var ch = str[i], c = ch.charCodeAt(0);
      if (c >= 32 && c <= 126) { out += ch; continue; }
      if (WINANSI[ch] != null) { out += String.fromCharCode(WINANSI[ch]); continue; }
      if (ASCII_FALLBACK[ch] != null) { out += ASCII_FALLBACK[ch]; continue; }
      if (c >= 160 && c <= 255) { out += ch; continue; }
      out += '?';
    }
    return out;
  }

  function escapeText(str) {
    return str.replace(/[\\()]/g, function (m) { return '\\' + m; });
  }

  /** Width of a string in points, for centring and right alignment. */
  function measure(str, fontKey, sizePt) {
    var f = FONTS[fontKey] || FONTS.helv;
    var s = encodeText(str);
    var total = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (!f.widths) { total += 600; continue; }
      total += (c >= 32 && c <= 126) ? f.widths[c - 32] : 556;
    }
    return total / 1000 * sizePt;
  }

  function rgb(hex) {
    var h = String(hex).replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  function f3(v) { return (Math.round(v * 1000) / 1000).toString(); }

  /* --- JPEG header sniffing: the PDF needs the real pixel dimensions ------- */
  function jpegInfo(bytes) {
    var i = 2;
    while (i < bytes.length) {
      if (bytes[i] !== 0xFF) { i++; continue; }
      var marker = bytes[i + 1];
      // SOF0..SOF15, skipping the four that are not frame headers
      if (marker >= 0xC0 && marker <= 0xCF &&
          marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
        return {
          height: (bytes[i + 5] << 8) | bytes[i + 6],
          width: (bytes[i + 7] << 8) | bytes[i + 8],
          components: bytes[i + 9]
        };
      }
      i += 2 + ((bytes[i + 2] << 8) | bytes[i + 3]);
    }
    return null;
  }

  /* --- Document ----------------------------------------------------------- */

  function create() {
    var pages = [];
    var images = [];   // {bytes, w, h, comps}

    function addPage(wMm, hMm) {
      var page = {
        w: wMm * MM, h: hMm * MM,
        ops: [],
        used: {}                      // which image XObjects this page refers to
      };

      // Everything below takes millimetres measured from the TOP-left, which is
      // how the layout thinks, and flips into PDF's bottom-left space here.
      function Y(mm) { return page.h - mm * MM; }

      page.image = function (imgIndex, xMm, yMm, wMm2, hMm2) {
        page.used['Im' + imgIndex] = imgIndex;
        page.ops.push('q ' + f3(wMm2 * MM) + ' 0 0 ' + f3(hMm2 * MM) + ' ' +
          f3(xMm * MM) + ' ' + f3(Y(yMm + hMm2)) + ' cm /Im' + imgIndex + ' Do Q');
        return page;
      };

      page.text = function (str, xMm, yMm, o) {
        o = o || {};
        var size = o.size || 9;
        var fontKey = o.font || 'helv';
        var col = rgb(o.color || '#16211D');
        var w = measure(str, fontKey, size);
        var x = xMm * MM;
        if (o.align === 'right') x -= w;
        else if (o.align === 'center') x -= w / 2;
        page.ops.push('BT /' + fontKey + ' ' + f3(size) + ' Tf ' +
          f3(col[0]) + ' ' + f3(col[1]) + ' ' + f3(col[2]) + ' rg ' +
          '1 0 0 1 ' + f3(x) + ' ' + f3(Y(yMm) - size * 0.78) + ' Tm (' +
          escapeText(encodeText(str)) + ') Tj ET');
        return page;
      };

      page.line = function (x1, y1, x2, y2, o) {
        o = o || {};
        var col = rgb(o.color || '#16211D');
        page.ops.push('q ' + f3(o.width || 0.2) * 1 + ' w ' +
          f3(col[0]) + ' ' + f3(col[1]) + ' ' + f3(col[2]) + ' RG ' +
          f3(x1 * MM) + ' ' + f3(Y(y1)) + ' m ' + f3(x2 * MM) + ' ' + f3(Y(y2)) + ' l S Q');
        return page;
      };

      page.rect = function (xMm, yMm, wMm2, hMm2, o) {
        o = o || {};
        var parts = ['q'];
        if (o.fill) {
          var fc = rgb(o.fill);
          parts.push(f3(fc[0]) + ' ' + f3(fc[1]) + ' ' + f3(fc[2]) + ' rg');
        }
        if (o.stroke) {
          var sc = rgb(o.stroke);
          parts.push(f3(sc[0]) + ' ' + f3(sc[1]) + ' ' + f3(sc[2]) + ' RG');
          parts.push(f3((o.width || 0.3) * MM) + ' w');
        }
        parts.push(f3(xMm * MM) + ' ' + f3(Y(yMm + hMm2)) + ' ' +
          f3(wMm2 * MM) + ' ' + f3(hMm2 * MM) + ' re');
        parts.push(o.fill && o.stroke ? 'B' : (o.fill ? 'f' : 'S'));
        parts.push('Q');
        page.ops.push(parts.join(' '));
        return page;
      };

      /** Four Béziers, which is how a circle is drawn in PDF. */
      page.circle = function (cxMm, cyMm, rMm, o) {
        o = o || {};
        var k = 0.5523, cx = cxMm * MM, cy = Y(cyMm), r = rMm * MM;
        var parts = ['q'];
        if (o.fill) {
          var fc = rgb(o.fill);
          parts.push(f3(fc[0]) + ' ' + f3(fc[1]) + ' ' + f3(fc[2]) + ' rg');
        }
        if (o.stroke) {
          var sc = rgb(o.stroke);
          parts.push(f3(sc[0]) + ' ' + f3(sc[1]) + ' ' + f3(sc[2]) + ' RG');
          parts.push(f3((o.width || 0.25) * MM) + ' w');
        }
        parts.push(f3(cx + r) + ' ' + f3(cy) + ' m');
        parts.push(f3(cx + r) + ' ' + f3(cy + r * k) + ' ' + f3(cx + r * k) + ' ' + f3(cy + r) + ' ' + f3(cx) + ' ' + f3(cy + r) + ' c');
        parts.push(f3(cx - r * k) + ' ' + f3(cy + r) + ' ' + f3(cx - r) + ' ' + f3(cy + r * k) + ' ' + f3(cx - r) + ' ' + f3(cy) + ' c');
        parts.push(f3(cx - r) + ' ' + f3(cy - r * k) + ' ' + f3(cx - r * k) + ' ' + f3(cy - r) + ' ' + f3(cx) + ' ' + f3(cy - r) + ' c');
        parts.push(f3(cx + r * k) + ' ' + f3(cy - r) + ' ' + f3(cx + r) + ' ' + f3(cy - r * k) + ' ' + f3(cx + r) + ' ' + f3(cy) + ' c');
        parts.push(o.fill && o.stroke ? 'B' : (o.fill ? 'f' : 'S'));
        parts.push('Q');
        page.ops.push(parts.join(' '));
        return page;
      };

      page.measure = function (str, fontKey, size) { return measure(str, fontKey, size) / MM; };

      pages.push(page);
      return page;
    }

    /** Register a JPEG once; the same bytes can be placed on several pages. */
    function addJPEG(bytes) {
      var info = jpegInfo(bytes);
      if (!info) throw new Error('not a JPEG');
      images.push({ bytes: bytes, w: info.width, h: info.height, comps: info.components });
      return images.length - 1;
    }

    function build(meta) {
      meta = meta || {};
      var chunks = [];
      var length = 0;
      function put(x) {
        var b = typeof x === 'string' ? latin1(x) : x;
        chunks.push(b);
        length += b.length;
        return length;
      }
      function latin1(str) {
        var out = new Uint8Array(str.length);
        for (var i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xFF;
        return out;
      }

      var offsets = [0];          // object 0 is the free head
      function beginObj(n) { offsets[n] = length; put(n + ' 0 obj\n'); }
      function endObj() { put('endobj\n'); }

      put('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');

      // 1 catalog, 2 page tree, then fonts, then images, then a pair per page.
      var fontKeys = Object.keys(FONTS);
      var objFontStart = 3;
      var objImgStart = objFontStart + fontKeys.length;
      var objPageStart = objImgStart + images.length;
      var totalObjs = objPageStart + pages.length * 2;

      beginObj(1);
      put('<< /Type /Catalog /Pages 2 0 R >>\n');
      endObj();

      beginObj(2);
      put('<< /Type /Pages /Count ' + pages.length + ' /Kids [' +
        pages.map(function (_, i) { return (objPageStart + i * 2) + ' 0 R'; }).join(' ') + '] >>\n');
      endObj();

      fontKeys.forEach(function (k, i) {
        beginObj(objFontStart + i);
        put('<< /Type /Font /Subtype /Type1 /BaseFont /' + FONTS[k].name +
          ' /Encoding /WinAnsiEncoding >>\n');
        endObj();
      });

      images.forEach(function (img, i) {
        beginObj(objImgStart + i);
        put('<< /Type /XObject /Subtype /Image /Width ' + img.w + ' /Height ' + img.h +
          ' /ColorSpace /' + (img.comps === 1 ? 'DeviceGray' : 'DeviceRGB') +
          ' /BitsPerComponent 8 /Filter /DCTDecode /Length ' + img.bytes.length + ' >>\nstream\n');
        put(img.bytes);
        put('\nendstream\n');
        endObj();
      });

      pages.forEach(function (page, i) {
        var pageObj = objPageStart + i * 2;
        var contentObj = pageObj + 1;
        var body = page.ops.join('\n') + '\n';

        beginObj(pageObj);
        put('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + f3(page.w) + ' ' + f3(page.h) + ']' +
          ' /Resources << /Font << ' +
          fontKeys.map(function (k, fi) { return '/' + k + ' ' + (objFontStart + fi) + ' 0 R'; }).join(' ') +
          ' >>' +
          (Object.keys(page.used).length
            ? ' /XObject << ' + Object.keys(page.used).map(function (name) {
              return '/' + name + ' ' + (objImgStart + page.used[name]) + ' 0 R';
            }).join(' ') + ' >>'
            : '') +
          ' >> /Contents ' + contentObj + ' 0 R >>\n');
        endObj();

        beginObj(contentObj);
        var bodyBytes = latin1(body);
        put('<< /Length ' + bodyBytes.length + ' >>\nstream\n');
        put(bodyBytes);
        put('endstream\n');
        endObj();
      });

      // totalObjs is already one past the last page object, so it IS the next
      // free number. Adding one left a gap, and a gap in the xref is an object
      // declared with offset zero, which is invalid.
      var infoObj = totalObjs;
      beginObj(infoObj);
      put('<< /Producer (Stockpile Sample Mapper) /Title (' +
        escapeText(encodeText(meta.title || 'Sampling plan')) + ') /CreationDate (' + pdfDate() + ') >>\n');
      endObj();

      var xrefAt = length;
      var count = infoObj + 1;
      put('xref\n0 ' + count + '\n');
      put('0000000000 65535 f \n');
      for (var n = 1; n < count; n++) {
        put(String(offsets[n] || 0).padStart(10, '0') + ' 00000 n \n');
      }
      put('trailer\n<< /Size ' + count + ' /Root 1 0 R /Info ' + infoObj + ' 0 R >>\n');
      put('startxref\n' + xrefAt + '\n%%EOF\n');

      var out = new Uint8Array(length);
      var at = 0;
      chunks.forEach(function (c) { out.set(c, at); at += c.length; });
      return new Blob([out], { type: 'application/pdf' });
    }

    return { addPage: addPage, addJPEG: addJPEG, build: build, pages: pages };
  }

  function pdfDate() {
    var d = new Date();
    function p(n) { return String(n).padStart(2, '0'); }
    return 'D:' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
      p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  /** canvas -> JPEG bytes, without a round trip through a data URL. */
  function canvasJPEG(canvas, quality) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) {
        if (!blob) return reject(new Error('canvas encode failed'));
        var fr = new FileReader();
        fr.onload = function () { resolve(new Uint8Array(fr.result)); };
        fr.onerror = function () { reject(fr.error); };
        fr.readAsArrayBuffer(blob);
      }, 'image/jpeg', quality == null ? 0.9 : quality);
    });
  }

  ASM.pdf = {
    create: create,
    measure: measure,
    canvasJPEG: canvasJPEG,
    jpegInfo: jpegInfo,
    MM: MM
  };
})(window.ASM = window.ASM || {});
