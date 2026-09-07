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

  async function readCsvAsText(file) {
    // 优先使用 Blob.text()，比 FileReader 更稳；失败再走 arrayBuffer + 多编码兜底
    try {
      if (file && typeof file.text === 'function') {
        return await file.text();
      }
    } catch (e) {
      // 继续走兜底
    }

    try {
      const buf = await file.arrayBuffer();
      return decodeTextAnyEncoding(buf);
    } catch (e) {
      throw new Error('CSV 读取失败：' + (e && (e.message || e) || e));
    }
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
    const sharedStrings = sharedXml ? parseSharedStrings(parseXml(sharedXml)) : [];
    const sheetInfos = parseWorkbookSheetInfos(workbook, rels);
    if (!sheetInfos.length) throw new Error('XLSX 中没有 Sheet');

    const parsedSheets = sheetInfos.map(function (info) {
      const sheetXml = textFile(files, info.target);
      if (!sheetXml) throw new Error('XLSX 缺少工作表文件：' + info.target);
      const sheet = parseXml(sheetXml);
      return { info: info, rows: parseWorksheetRows(sheet, sharedStrings) };
    });

    // 真实上传模板的数据在 Sheet2 长表里；先优先识别 Sheet2，再回退识别 Sheet1 的 10 列固定模板。
    for (const parsed of parsedSheets) {
      const sheet2TemplateTable = buildSheet2WorkbookTemplateTable(parsed.rows);
      if (sheet2TemplateTable) return sheet2TemplateTable;
    }

    for (const parsed of parsedSheets) {
      const fixedTemplateTable = buildFixedWorkbookTemplateTable(parsed.rows);
      if (fixedTemplateTable) return fixedTemplateTable;
    }

    return rowsToTable(parsedSheets[0].rows, 'xlsx');
  }

  function parseWorkbookSheetInfos(workbook, rels) {
    const sheetNodes = [...workbook.getElementsByTagNameNS('*', 'sheet')];
    const fallbackNodes = sheetNodes.length ? sheetNodes : [...workbook.getElementsByTagName('sheet')];
    return fallbackNodes.map(function (sheet, index) {
      const relId = sheet.getAttribute('r:id') || sheet.getAttribute('id');
      let target = rels[relId] || ('worksheets/sheet' + (index + 1) + '.xml');
      target = normalizeZipPath(target.startsWith('/') ? target.slice(1) : 'xl/' + target);
      return {
        name: sheet.getAttribute('name') || ('Sheet' + (index + 1)),
        target: target,
        index: index,
      };
    });
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

  const FIXED_TEMPLATE_HEADERS = [
    'VIN', '品系2', '燃料种类', '产品代码', '产品名称', '公告车型', '驾驶室', '驱动形式', '发动机厂家', '变速箱'
  ];
  const FIXED_TEMPLATE_SIGNATURE = FIXED_TEMPLATE_HEADERS.map(normalizeHeaderText);
  const STANDARD_IMPORT_HEADERS = [
    '车辆类型', '是否带挂', '车主手机号', 'VIN', '车身颜色', '表显里程', '上牌日期', '车籍所在地', '停放地区', '停放详细地址',
    '车籍性质', '过户信息', '品牌', '车系', '车型', '车辆描述', '参考底价', '参考售价'
  ];
  const TEMPLATE_SERIES_RULES = [
    { prefix: '龙V2.0', brand: '一汽解放' },
    { prefix: '悍V2.0', brand: '一汽解放' },
    { prefix: '国六虎6G', brand: '一汽解放' },
    { prefix: '龙V', brand: '一汽解放' },
    { prefix: 'JH6', brand: '青岛解放' },
    { prefix: 'JK6', brand: '青岛解放' },
    { prefix: 'JM6', brand: '青岛解放' },
    { prefix: '鹰途', brand: '青岛解放' },
    { prefix: '鹰航', brand: '青岛解放' },
    { prefix: '鹰驰', brand: '青岛解放' },
  ];
  const TEMPLATE_PREFIXES = TEMPLATE_SERIES_RULES.map(function (item) { return item.prefix; }).sort(function (a, b) { return b.length - a.length; });
  const TEMPLATE_BRAND_BY_PREFIX = TEMPLATE_SERIES_RULES.reduce(function (out, item) {
    out[item.prefix] = item.brand;
    return out;
  }, {});
  const TEMPLATE_COLOR_CYCLE = ['咖金', '白色', '黑色', '蓝色', '黄色', '红色', '银色', '灰色', '粉色', '珍珠白色'];
  const TEMPLATE_REGIONS = [
    '内蒙古自治区/赤峰市', '北京市/北京市', '江苏省/南京市', '河南省/郑州市', '广东省/广州市',
    '四川省/成都市', '浙江省/杭州市', '湖南省/长沙市', '陕西省/西安市', '湖北省/武汉市',
    '河北省/石家庄市', '天津市/天津市', '山东省/济南市', '上海市/上海市'
  ];
  const TEMPLATE_PRICE_BASE = {
    '牵引车': 18000,
    '自卸车': 9500,
    '专用车': 15000,
    '载货车': 12000,
    '新能源车': 22000,
  };

  function normalizeHeaderText(text) {
    return String(text == null ? '' : text).replace(/^﻿/, '').trim().replace(/\s+/g, '');
  }

  function normalizeTemplateText(text) {
    const value = String(text == null ? '' : text).replace(/^﻿/, '').trim();
    if (!value || value === '0' || value === '0.0' || value.toLowerCase() === 'null' || value.toLowerCase() === 'undefined') return '';
    return value;
  }

  function compactTemplateText(text) {
    return normalizeTemplateText(text).replace(/[\s　]+/g, '');
  }

  function isFixedWorkbookTemplate(headers) {
    const normalized = (headers || []).map(normalizeHeaderText);
    if (normalized.length !== FIXED_TEMPLATE_SIGNATURE.length) return false;
    for (let i = 0; i < FIXED_TEMPLATE_SIGNATURE.length; i++) {
      if (normalized[i] !== FIXED_TEMPLATE_SIGNATURE[i]) return false;
    }
    return true;
  }

  function buildFixedWorkbookTemplateTable(rows, sourceType, sourceLabel) {
    if (!rows || !rows.length) return null;
    const headers = rows[0] || [];
    if (!isFixedWorkbookTemplate(headers)) return null;
    const records = rows.slice(1).filter(function (row) { return row && row.some(Boolean); }).map(function (row, index) {
      return buildFixedWorkbookTemplateRecord(row, index + 2, sourceLabel);
    });
    if (!records.length) throw new Error('固定模板工作簿没有有效数据行');
    return { sourceType: sourceType || 'xlsx-fixed-template', headers: STANDARD_IMPORT_HEADERS.slice(), records: records };
  }

  function buildSheet2WorkbookTemplateTable(rows) {
    if (!rows || !rows.length) return null;
    const headers = rows[0] || [];
    const mapping = buildSheet2HeaderMapping(headers);
    if (!mapping) return null;

    const fixedRows = [FIXED_TEMPLATE_HEADERS.slice()];
    rows.slice(1).forEach(function (row) {
      if (!row || !row.some(Boolean)) return;
      const fixedRow = [
        readSheet2Cell(row, mapping.vin),
        readSheet2Cell(row, mapping.vehicleClass),
        readSheet2Cell(row, mapping.fuelType),
        readSheet2Cell(row, mapping.productCode),
        readSheet2Cell(row, mapping.productName),
        readSheet2Cell(row, mapping.announcementModel),
        readSheet2Cell(row, mapping.cab),
        readSheet2Cell(row, mapping.drive),
        readSheet2Cell(row, mapping.engineMaker),
        readSheet2Cell(row, mapping.gearbox),
      ];
      if (fixedRow.some(Boolean)) fixedRows.push(fixedRow);
    });

    if (fixedRows.length <= 1) throw new Error('Sheet2 模板没有有效车辆数据行');
    return buildFixedWorkbookTemplateTable(fixedRows, 'xlsx-sheet2-fixed-template', '来源Sheet2宽表模板');
  }

  function buildSheet2HeaderMapping(headers) {
    const indexes = buildHeaderIndexes(headers);
    if (!isSheet2WideTemplate(headers, indexes)) return null;

    const required = {
      vehicleClass: indexes[normalizeHeaderText('品系2')],
      fuelType: indexes[normalizeHeaderText('燃料种类')],
      productCode: indexes[normalizeHeaderText('产品代码')],
      productName: indexes[normalizeHeaderText('产品名称')],
      announcementModel: indexes[normalizeHeaderText('公告车型')],
      cab: indexes[normalizeHeaderText('驾驶室')],
      drive: indexes[normalizeHeaderText('驱动形式')],
      engineMaker: indexes[normalizeHeaderText('发动机厂家')],
      gearbox: indexes[normalizeHeaderText('变速箱')],
    };

    const vinIndexes = indexes[normalizeHeaderText('VIN')] || [];
    const hasRequired = Object.keys(required).every(function (key) {
      return required[key] && required[key].length;
    });
    if (!hasRequired || !vinIndexes.length) return null;

    return {
      // Sheet2 里有两个 VIN 列，业务上两列应保持一致；解析时按用户确认优先取第一个 VIN。
      vin: vinIndexes.slice(),
      vehicleClass: required.vehicleClass,
      fuelType: required.fuelType,
      productCode: required.productCode,
      productName: required.productName,
      announcementModel: required.announcementModel,
      cab: required.cab,
      drive: required.drive,
      engineMaker: required.engineMaker,
      gearbox: required.gearbox,
    };
  }

  function buildHeaderIndexes(headers) {
    return (headers || []).reduce(function (out, header, index) {
      const key = normalizeHeaderText(header);
      if (!key) return out;
      if (!out[key]) out[key] = [];
      out[key].push(index);
      return out;
    }, {});
  }

  function readSheet2Cell(row, indexes) {
    for (const index of indexes || []) {
      const value = normalizeTemplateText(row[index]);
      if (value) return value;
    }
    return '';
  }

  function isSheet2WideTemplate(headers, indexes) {
    const width = (headers || []).filter(function (h) { return normalizeTemplateText(h); }).length;
    if (width < 40) return false;

    const mustHave = [
      '平台', 'VIN', '厂家开票情况', '售出情况', '匹配里程', '品系2', '燃料种类', '产品代码', '产品名称', '公告车型',
      '发动机号', '入基地库时间', '时间段', '数量', '驾驶室', '驱动形式', '发动机厂家', '变速箱', '后桥', '轴距', '轮胎', '后桥速比'
    ];
    for (const key of mustHave) {
      const bucket = indexes[normalizeHeaderText(key)];
      if (!bucket || !bucket.length) return false;
    }
    return true;
  }

  function buildFixedWorkbookTemplateRecord(row, rowNumber, sourceLabel) {
    const vin = normalizeTemplateText(row[0]);
    const vehicleClass = normalizeTemplateText(row[1]);
    const fuelType = normalizeTemplateText(row[2]);
    const productCode = normalizeTemplateText(row[3]);
    const productName = normalizeTemplateText(row[4]);
    const announcementModel = normalizeTemplateText(row[5]);
    const cab = normalizeTemplateText(row[6]);
    const drive = normalizeTemplateText(row[7]);
    const engineMaker = normalizeTemplateText(row[8]);
    const gearbox = normalizeTemplateText(row[9]);
    const seriesName = deriveTemplateSeriesName(productName, vehicleClass, announcementModel, productCode);
    const brandName = deriveTemplateBrandName(seriesName, productName, vehicleClass);
    const vehicleType = deriveTemplateVehicleType(vehicleClass, productName, fuelType);
    const modelName = deriveTemplateModelName(productName, announcementModel, seriesName, productCode, rowNumber);
    const synthetic = buildTemplateSyntheticFields(rowNumber, vehicleType);

    return {
      __rowNumber: rowNumber,
      '车辆类型': vehicleType,
      '是否带挂': synthetic.withTrailer,
      '车主手机号': synthetic.ownerPhone,
      'VIN': vin,
      '车身颜色': synthetic.color,
      '表显里程': synthetic.mileage,
      '上牌日期': synthetic.registerDate,
      '车籍所在地': synthetic.registeredAddr,
      '停放地区': synthetic.parkAddr,
      '停放详细地址': synthetic.parkAddrDetail,
      '车籍性质': synthetic.registeredType,
      '过户信息': synthetic.transferInfo,
      '品牌': brandName,
      '车系': seriesName,
      '车型': modelName,
      '车辆描述': buildTemplateDescription({
        rowNumber: rowNumber,
        vehicleType: vehicleType,
        brandName: brandName,
        seriesName: seriesName,
        modelName: modelName,
        vehicleClass: vehicleClass,
        fuelType: fuelType,
        productCode: productCode,
        productName: productName,
        announcementModel: announcementModel,
        cab: cab,
        drive: drive,
        engineMaker: engineMaker,
        gearbox: gearbox,
        sourceLabel: sourceLabel || '来源固定模板工作簿1(1).xlsx',
      }),
      '参考底价': synthetic.reservePrice,
      '参考售价': synthetic.salePrice,
    };
  }

  function deriveTemplateVehicleType(vehicleClass, productName, fuelType) {
    const product = compactTemplateText(productName);
    const klass = compactTemplateText(vehicleClass);
    const fuel = compactTemplateText(fuelType);
    if (/新能源/.test(product) || /新能源/.test(klass) || /新能源/.test(fuel) || /电动/.test(product) || /电机/.test(product)) return '新能源车';
    if (/自卸车/.test(product) || /自卸/.test(klass)) return '自卸车';
    if (/牵引车/.test(product) || /牵引/.test(klass)) return '牵引车';
    if (/专用车/.test(product) || /专用/.test(klass) || /底盘/.test(product)) return '专用车';
    if (/冷藏|厢式|载货/.test(product) || /载货/.test(klass)) return '载货车';
    if (klass === '新能源') return '新能源车';
    if (klass === '牵引') return '牵引车';
    if (klass === '自卸') return '自卸车';
    if (klass === '专用') return '专用车';
    if (klass === '载货') return '载货车';
    return '牵引车';
  }

  function deriveTemplateSeriesName(productName, vehicleClass, announcementModel, productCode) {
    const product = compactTemplateText(productName);
    for (const prefix of TEMPLATE_PREFIXES) {
      if (product.indexOf(compactTemplateText(prefix)) === 0) return prefix;
    }
    const klass = normalizeTemplateText(vehicleClass);
    if (klass) return klass + '系列';
    const model = normalizeTemplateText(announcementModel);
    if (model) return model;
    const code = normalizeTemplateText(productCode);
    if (code) return code;
    return '固定模板系列';
  }

  function deriveTemplateBrandName(seriesName, productName, vehicleClass) {
    const series = compactTemplateText(seriesName);
    for (const prefix of TEMPLATE_PREFIXES) {
      if (series.indexOf(compactTemplateText(prefix)) === 0) return TEMPLATE_BRAND_BY_PREFIX[prefix];
    }
    const product = compactTemplateText(productName);
    for (const prefix of TEMPLATE_PREFIXES) {
      if (product.indexOf(compactTemplateText(prefix)) === 0) return TEMPLATE_BRAND_BY_PREFIX[prefix];
    }
    if (/安凯/.test(product)) return '安凯客车';
    if (/龙V|悍V|国六虎6G/.test(product)) return '一汽解放';
    if (/JH6|JK6|JM6|鹰途|鹰航|鹰驰/.test(product)) return '青岛解放';
    if (/载货|自卸|牵引|专用/.test(normalizeTemplateText(vehicleClass))) return '一汽解放';
    return '一汽解放';
  }

  function deriveTemplateModelName(productName, announcementModel, seriesName, productCode, rowNumber) {
    const product = normalizeTemplateText(productName);
    if (product) return product.replace(/\s+/g, ' ');
    const model = normalizeTemplateText(announcementModel);
    if (model) return model;
    const code = normalizeTemplateText(productCode);
    if (code) return code;
    const series = normalizeTemplateText(seriesName);
    if (series) return series + '车型' + rowNumber;
    return '固定模板车型' + rowNumber;
  }

  function buildTemplateSyntheticFields(rowNumber, vehicleType) {
    const index = Math.max(1, Number(rowNumber) || 1);
    const color = TEMPLATE_COLOR_CYCLE[(index - 1) % TEMPLATE_COLOR_CYCLE.length];
    const region = TEMPLATE_REGIONS[(index - 1) % TEMPLATE_REGIONS.length];
    const parkRegion = TEMPLATE_REGIONS[(index + 3) % TEMPLATE_REGIONS.length];
    const basePrice = TEMPLATE_PRICE_BASE[vehicleType] || 15000;
    const reservePrice = basePrice + ((index - 1) % 5) * 200;
    const month = String(((index - 1) % 12) + 1).padStart(2, '0');

    return {
      withTrailer: '否',
      ownerPhone: String(19719230000 + index),
      color: color,
      mileage: String(5000 + index * 137),
      registerDate: '2026-' + month,
      registeredAddr: region,
      parkAddr: parkRegion,
      parkAddrDetail: (parkRegion.split('/').pop() || parkRegion) + '测试停车场' + String(index).padStart(3, '0'),
      registeredType: index % 5 === 0 ? '私户' : '公户',
      transferInfo: index % 7 === 0 ? '不可提档过户' : '可提档过户',
      reservePrice: String(reservePrice),
      salePrice: String(reservePrice * 10),
    };
  }

  function buildTemplateDescription(parts) {
    return [
      parts.sourceLabel || '来源固定模板工作簿1(1).xlsx',
      '第' + parts.rowNumber + '行',
      '车辆类型=' + (parts.vehicleType || '-'),
      '品牌=' + (parts.brandName || '-'),
      '车系=' + (parts.seriesName || '-'),
      '车型=' + (parts.modelName || '-'),
      '品系2=' + (parts.vehicleClass || '-'),
      '燃料种类=' + (parts.fuelType || '-'),
      '产品代码=' + (parts.productCode || '-'),
      '产品名称=' + (parts.productName || '-'),
      '公告车型=' + (parts.announcementModel || '-'),
      '驾驶室=' + (parts.cab || '-'),
      '驱动形式=' + (parts.drive || '-'),
      '发动机厂家=' + (parts.engineMaker || '-'),
      '变速箱=' + (parts.gearbox || '-'),
    ].join('，') + '。';
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
