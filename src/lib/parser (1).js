(function () {
  'use strict';

  function extOf(name) {
    const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
    return m ? m[1] : '';
  }

  // ---------------- 对外主入口 ----------------
  async function parseFile(file) {
    if (!file) throw new Error('请选择文件');
    const name = String(file.name || '');
    const ext = extOf(name);
    const type = String(file.type || '').toLowerCase();

    // 先看文件头，尽量按内容识别，不只依赖扩展名或 MIME
    const head512 = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
    const isZip = head512[0] === 0x50 && head512[1] === 0x4b;
    const headText = stripBom(decodeBinaryAsText(head512.buffer || head512)).trimStart();

    if (isZip) {
      const full = await file.arrayBuffer();
      return parseXlsxBuffer(full);
    }

    if (looksLikeHtmlTable(headText)) {
      const full = await file.arrayBuffer();
      return parseHtmlTable(decodeBinaryAsText(full));
    }

    if (looksLikeSpreadsheetXml(headText)) {
      const full = await file.arrayBuffer();
      return parseSpreadsheetXml(stripBom(decodeBinaryAsText(full)));
    }

    const csvByName = ext === 'csv' || /\.csv$/i.test(name);
    const csvByType = /csv/.test(type);
    if (looksLikeCsv(headText) || csvByName || csvByType) {
      const text = await readCsvAsText(file);
      return parseCsvText(text);
    }

    if (ext === 'xlsx' || ext === 'xls') {
      throw new Error(`${name} 不是有效的 XLSX/HTML/XML/CSV 导出文件。旧版二进制 XLS 不支持，请另存为 .xlsx 或 CSV 再导入。`);
    }

    throw new Error(`无法识别文件格式：${name || '(无扩展名)'}。支持 .csv / .xlsx / Excel 导出的 HTML/XML/CSV。`);
  }

  function looksLikeCsv(text) {
    const head = String(text || '').slice(0, 4096);
    if (looksLikeHtmlTable(head) || looksLikeSpreadsheetXml(head)) return false;
    const comma = (head.match(/,/g) || []).length;
    const semicolon = (head.match(/;/g) || []).length;
    const tab = (head.match(/\t/g) || []).length;
    const newline = (head.match(/\n/g) || []).length;
    const quote = (head.match(/"/g) || []).length;
    return newline >= 1 && (comma >= 1 || semicolon >= 1 || tab >= 1 || quote >= 2);
  }

  function looksLikeHtmlTable(text) {
    const head = String(text || '').slice(0, 4096);
    return /^<html[\s>]/i.test(head) || /<table[\s>]/i.test(head);
  }

  function looksLikeSpreadsheetXml(text) {
    const head = String(text || '').slice(0, 4096);
    return /^<\?xml/i.test(head) || /<Workbook[\s>]/i.test(head);
  }

  function readCsvAsText(file) {
    // FileReader.readAsText：浏览器会按 UTF-8/BOM 自动解码；GBK 的 Excel CSV 也尽量 decode 一次
    return new Promise(function (resolve, reject) {
      try {
        // 先尝试原生 readAsText（跟随浏览器默认编码 + BOM 识别）
        const fr = new FileReader();
        fr.onload = function () { resolve(String(fr.result || '')); };
        fr.onerror = function () {
          // 读失败：走 arrayBuffer + 多种 TextDecoder 兜底
          file.arrayBuffer().then(function (buf) {
            resolve(decodeTextAnyEncoding(buf));
          }, function (e) { reject(e); });
        };
        fr.readAsText(file);
      } catch (e) { reject(e); }
    });
  }

  function decodeTextAnyEncoding(buffer) {
    const candidates = ['utf-8', 'gb18030', 'gbk', 'big5'];
    let best = '';
    for (const enc of candidates) {
      try {
        const text = new TextDecoder(enc, { fatal: false }).decode(buffer);
        best = text;
        if (!text.includes('�')) return text;
      } catch {}
    }
    return best;
  }

  function decodeBinaryAsText(buffer) {
    return decodeTextAnyEncoding(buffer);
  }

  // ---------------- 简单可靠的 CSV 解析（同步，逐行）----------------
  function parseCsvText(raw) {
    // 先把 \r\n / \r 都统一成 \n
    const text = stripBom(String(raw || '')).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (!text.trim()) throw new Error('CSV 文件为空');

    const rows = [];
    let row = [];
    let cell = '';
    let inQuote = false;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQuote) {
        if (ch === '"') {
          if (text[i + 1] === '"') {
            cell += '"';
            i++;
          } else {
            inQuote = false;
          }
        } else {
          cell += ch;
        }
      } else {
        if (ch === '"') {
          inQuote = true;
        } else if (ch === ',') {
          row.push(cell);
          cell = '';
        } else if (ch === '\n') {
          row.push(cell);
          rows.push(row);
          row = [];
          cell = '';
        } else {
          cell += ch;
        }
      }
    }
    // 末尾的剩余 cell 和 row
    row.push(cell);
    rows.push(row);

    return rowsToTable(rows, 'csv');
  }

  // ---------------- XLSX / HTML / XML Excel 解析（保留原同步逻辑）----------------
  async function parseXlsxBuffer(buffer) {
    const files = await unzipXlsx(buffer);
    const workbookXml = textFile(files, 'xl/workbook.xml');
    const relsXml = textFile(files, 'xl/_rels/workbook.xml.rels', false);
    const sharedXml = textFile(files, 'xl/sharedStrings.xml', false);
    if (!workbookXml) throw new Error('XLSX 缺少 xl/workbook.xml');

    const workbook = parseXml(workbookXml);
    const rels = relsXml ? parseRels(parseXml(relsXml)) : {};
    const firstSheet = [...workbook.getElementsByTagNameNS('*', 'sheet')][0] || [...workbook.getElementsByTagName('sheet')][0];
    if (!firstSheet) throw new Error('XLSX 中没有 Sheet');
    const relId = firstSheet.getAttribute('r:id') || firstSheet.getAttribute('id');
    let target = rels[relId] || 'worksheets/sheet1.xml';
    target = normalizeZipPath(target.startsWith('/') ? target.slice(1) : 'xl/' + target);
    const sheetXml = textFile(files, target);
    if (!sheetXml) throw new Error('XLSX 缺少工作表文件：' + target);

    const sharedStrings = sharedXml ? parseSharedStrings(parseXml(sharedXml)) : [];
    const sheet = parseXml(sheetXml);
    const rows = parseWorksheetRows(sheet, sharedStrings);
    return rowsToTable(rows, 'xlsx');
  }

  function parseWorksheetRows(doc, sharedStrings) {
    const rowNodes = [...doc.getElementsByTagNameNS('*', 'row')];
    const rows = [];
    rowNodes.forEach(function (rowNode) {
      const rowIndex = Number(rowNode.getAttribute('r')) || (rows.length + 1);
      const values = [];
      [...rowNode.getElementsByTagNameNS('*', 'c')].forEach(function (c) {
        const ref = c.getAttribute('r') || '';
        const colIndex = ref ? columnNameToIndex(ref.replace(/\d+/g, '')) : values.length;
        values[colIndex] = readCellValue(c, sharedStrings);
      });
      rows[rowIndex - 1] = values.map(function (v) { return v == null ? '' : String(v).trim(); });
    });
    return rows.filter(function (r) { return r && r.some(Boolean); });
  }

  function readCellValue(cell, sharedStrings) {
    const type = cell.getAttribute('t');
    if (type === 'inlineStr') {
      const tNodes = [...cell.getElementsByTagNameNS('*', 't')];
      return tNodes.map(function (n) { return n.textContent; }).join('');
    }
    const v = cell.getElementsByTagNameNS('*', 'v')[0];
    if (!v) return '';
    const raw = v.textContent || '';
    if (type === 's') return sharedStrings[Number(raw)] || '';
    if (type === 'b') return raw === '1' ? 'TRUE' : 'FALSE';
    return raw;
  }

  function parseSharedStrings(doc) {
    return [...doc.getElementsByTagNameNS('*', 'si')].map(function (si) {
      return [...si.getElementsByTagNameNS('*', 't')].map(function (t) { return t.textContent || ''; }).join('');
    });
  }

  function parseRels(doc) {
    const out = {};
    [...doc.getElementsByTagNameNS('*', 'Relationship')].forEach(function (rel) {
      out[rel.getAttribute('Id')] = rel.getAttribute('Target');
    });
    return out;
  }

  async function unzipXlsx(buffer) {
    const view = new DataView(buffer);
    const eocd = findEndOfCentralDirectory(view);
    const entries = {};
    let pos = eocd.centralOffset;
    for (let i = 0; i < eocd.totalEntries; i++) {
      if (view.getUint32(pos, true) !== 0x02014b50) throw new Error('XLSX ZIP 中央目录损坏');
      const method = view.getUint16(pos + 10, true);
      const compressedSize = view.getUint32(pos + 20, true);
      const fileNameLength = view.getUint16(pos + 28, true);
      const extraLength = view.getUint16(pos + 30, true);
      const commentLength = view.getUint16(pos + 32, true);
      const localOffset = view.getUint32(pos + 42, true);
      const nameBytes = new Uint8Array(buffer, pos + 46, fileNameLength);
      const name = normalizeZipPath(new TextDecoder('utf-8').decode(nameBytes));
      entries[name] = { method: method, compressedSize: compressedSize, localOffset: localOffset, buffer: buffer };
      pos += 46 + fileNameLength + extraLength + commentLength;
    }
    const files = {};
    for (const entryKey in entries) {
      if (!Object.prototype.hasOwnProperty.call(entries, entryKey)) continue;
      files[entryKey] = await readZipEntry(entries[entryKey]);
    }
    return files;
  }

  async function readZipEntry(entry) {
    const view = new DataView(entry.buffer);
    const pos = entry.localOffset;
    if (view.getUint32(pos, true) !== 0x04034b50) throw new Error('XLSX ZIP 本地文件头损坏');
    const fileNameLength = view.getUint16(pos + 26, true);
    const extraLength = view.getUint16(pos + 28, true);
    const dataStart = pos + 30 + fileNameLength + extraLength;
    const bytes = new Uint8Array(entry.buffer, dataStart, entry.compressedSize);
    if (entry.method === 0) return bytes;
    if (entry.method !== 8) throw new Error('XLSX ZIP 压缩方式不支持：' + entry.method);
    if (!('DecompressionStream' in self)) {
      throw new Error('当前浏览器不支持 DecompressionStream，无法直接解析 XLSX');
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    const ab = await new Response(stream).arrayBuffer();
    return new Uint8Array(ab);
  }

  function findEndOfCentralDirectory(view) {
    const min = Math.max(0, view.byteLength - 0xffff - 22);
    for (let pos = view.byteLength - 22; pos >= min; pos--) {
      if (view.getUint32(pos, true) === 0x06054b50) {
        return {
          totalEntries: view.getUint16(pos + 10, true),
          centralOffset: view.getUint32(pos + 16, true),
        };
      }
    }
    throw new Error('XLSX ZIP 结构无效');
  }

  function textFile(files, name, required) {
    if (required === undefined) required = true;
    const bytes = files[normalizeZipPath(name)];
    if (!bytes) {
      if (required) throw new Error('XLSX 文件缺失：' + name);
      return '';
    }
    return new TextDecoder('utf-8').decode(bytes);
  }

  function parseHtmlTable(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const table = doc.querySelector('table');
    if (!table) throw new Error('XLS/HTML 文件中未找到表格');
    const rows = [...table.querySelectorAll('tr')].map(function (tr) {
      return [...tr.children]
        .filter(function (td) { return /^(td|th)$/i.test(td.tagName); })
        .map(function (td) { return (td.textContent || '').trim(); });
    });
    return rowsToTable(rows, 'xls-html');
  }

  function parseSpreadsheetXml(xml) {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    assertXml(doc, 'Excel XML 解析失败');
    const table = doc.getElementsByTagName('Table')[0] || doc.getElementsByTagNameNS('*', 'Table')[0];
    if (!table) throw new Error('Excel XML 中未找到 Worksheet/Table');
    const rows = [...table.getElementsByTagNameNS('*', 'Row')].map(function (row) {
      return [...row.getElementsByTagNameNS('*', 'Cell')].map(function (cell) {
        const data = cell.getElementsByTagNameNS('*', 'Data')[0];
        return data ? (data.textContent || '').trim() : '';
      });
    });
    return rowsToTable(rows, 'xls-xml');
  }

  function parseXml(xml) {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    assertXml(doc, 'XML 解析失败');
    return doc;
  }

  function assertXml(doc, msg) {
    if (doc.getElementsByTagName('parsererror').length) throw new Error(msg);
  }

  function rowsToTable(rows, sourceType) {
    rows = (rows || []).map(function (r) {
      return (r || []).map(function (v) { return String(v == null ? '' : v).trim(); });
    });
    rows = rows.filter(function (r) { return r.some(Boolean); });
    if (!rows.length) throw new Error('文件没有有效数据行');
    const headers = rows[0].map(function (h, i) { return h || ('列' + (i + 1)); });
    const records = rows.slice(1).map(function (r, rowIndex) {
      const rec = { __rowNumber: rowIndex + 2 };
      headers.forEach(function (h, i) { rec[h] = r[i] || ''; });
      return rec;
    }).filter(function (rec) {
      return Object.keys(rec).some(function (k) { return !k.startsWith('__') && rec[k]; });
    });
    if (!records.length) throw new Error('文件只有表头，没有有效数据行');
    return { sourceType: sourceType, headers: headers, records: records };
  }

  function columnNameToIndex(name) {
    let n = 0;
    for (const ch of String(name || '').toUpperCase()) {
      if (ch < 'A' || ch > 'Z') continue;
      n = n * 26 + (ch.charCodeAt(0) - 64);
    }
    return Math.max(0, n - 1);
  }

  function stripBom(text) {
    return String(text || '').replace(/^\uFEFF/, '');
  }

  function normalizeZipPath(path) {
    const parts = String(path || '').replace(/\\/g, '/').split('/');
    const out = [];
    for (const part of parts) {
      if (!part || part === '.') continue;
      if (part === '..') out.pop(); else out.push(part);
    }
    return out.join('/');
  }

  window.VehicleParser = { parseFile: parseFile, parseCsvText: parseCsvText };
})();
