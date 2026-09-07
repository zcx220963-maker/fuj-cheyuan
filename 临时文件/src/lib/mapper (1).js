(function () {
  'use strict';

  const FIELD_ALIASES = {
    vehicleType: ['车辆类型', '类型', '车身类型', '车型类别', '类型级别', 'typelevel', 'vehicleType', 'cartype'],
    withTrailer: ['是否带挂', '带挂', '挂车', 'withTrailer', 'trailer'],
    ownerPhone: ['车主手机号', '车主电话', '手机号', '联系电话', 'ownerPhone', 'phone'],
    vin: ['VIN', 'vin码', '车架号', '车辆识别代码', '识别代码', 'vin', 'vinCode', 'licenseInfo.vinCode'],
    color: ['车身颜色', '颜色', '外观颜色', 'carColor', 'baseInfo.carColor', 'color'],
    mileage: ['表显里程', '里程', '公里数', '行驶里程', 'mileage', 'baseInfo.mileage'],
    registerDate: ['上牌日期', '上牌时间', '上牌月份', '登记日期', '初登日期', '首次登记日期', 'spTime', 'registerdate'],
    registeredAddr: ['车籍所在地', '车籍地', '车辆所在地', 'registeredAddr', 'baseInfo.registeredAddr'],
    parkAddr: ['停放地区', '停放地', '停放区域', 'parkAddr', 'baseInfo.parkAddr'],
    parkAddrDetail: ['停放详细地址', '详细地址', '停放地址', 'parkAddrDetail', 'baseInfo.parkAddrDetail'],
    registeredType: ['车籍性质', '户籍性质', 'registeredType', 'baseInfo.registeredType'],
    transferInfo: ['过户信息', '过户', '提档过户', 'ghinfo', 'baseInfo.ghinfo'],
    brandName: ['品牌', '品牌名称', '车辆品牌', '厂牌', 'brand', 'brandname', 'brandId', 'specInfo.brandId'],
    seriesName: ['车系', '车系名称', '系列', '车辆系列', 'series', 'seriesname', 'seriesId', 'serialId', 'specInfo.seriesId'],
    modelName: ['车型', '车型名称', '型号', '车辆型号', '公告型号', 'model', 'modelname', 'modelId', 'specInfo.modelId'],
    description: ['车辆描述', '车况描述', '补充信息', '描述', '说明', 'description', 'desc'],
    referenceReservePrice: ['参考底价', '底价', '保留价', '起拍价', 'reservePrice'],
    referenceQuotedPrice: ['参考售价', '售价', '报价', '销售价', '挂牌价', 'quotedPrice'],
    subModelName: ['子类', '配置', '车型配置', '配置名称', '款型', '版本', '版型', 'config', 'configuration', 'configName', 'submodel'],
    year: ['年款', '年份', '生产年份', '款', 'year', 'modelyear'],
    engineNo: ['发动机号', '发动机号码', '发动机编号', 'engine', 'engineno', 'engineCode'],
    title: ['标题', '车源标题', '车辆标题', '名称', 'title'],
    emissionStandard: ['排放标准', '排放', 'emission', 'emissionStandard'],
    fuelType: ['燃料', '燃油', '燃料类型', '能源类型', 'fuel', 'fuelType'],
    gearbox: ['变速箱', '变速器', 'gearbox', 'transmission'],
  };

  const FIELD_LABELS = {
    vehicleType: '车辆类型',
    withTrailer: '是否带挂',
    ownerPhone: '车主手机号',
    vin: 'VIN',
    color: '车身颜色',
    mileage: '表显里程',
    registerDate: '上牌日期',
    registeredAddr: '车籍所在地',
    parkAddr: '停放地区',
    parkAddrDetail: '停放详细地址',
    registeredType: '车籍性质',
    transferInfo: '过户信息',
    brandName: '品牌',
    seriesName: '车系',
    modelName: '车型',
    description: '车辆描述',
    referenceReservePrice: '参考底价',
    referenceQuotedPrice: '参考售价',
    subModelName: '子类/配置',
    year: '年款',
    engineNo: '发动机号',
    title: '标题',
    emissionStandard: '排放标准',
    fuelType: '燃料类型',
    gearbox: '变速箱',
  };

  const RECORDED_PAYLOAD_FIELDS = [
    'id', 'rowNumber', 'displayName',
    'vehicleType', 'withTrailer', 'ownerPhone', 'vin', 'color', 'mileage', 'registerDate',
    'registeredAddr', 'parkAddr', 'parkAddrDetail', 'registeredType', 'transferInfo',
    'brandName', 'seriesName', 'modelName', 'description',
    'referenceReservePrice', 'referenceQuotedPrice'
  ];

  function normalizeKey(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/[\s_\-:/\\（）()【】\[\]·.，,。]/g, '')
      .replace(/号码$/, '号');
  }

  function findHeader(headers, aliases) {
    const normalized = headers.map(h => ({ raw: h, key: normalizeKey(h) }));
    const aliasKeys = aliases.map(normalizeKey);
    for (const alias of aliasKeys) {
      const exact = normalized.find(h => h.key === alias);
      if (exact) return exact.raw;
    }
    for (const alias of aliasKeys) {
      const fuzzy = normalized.find(h => h.key.includes(alias) || alias.includes(h.key));
      if (fuzzy) return fuzzy.raw;
    }
    return '';
  }

  function mapTable(table) {
    const headers = table.headers || [];
    const headerMap = {};
    Object.entries(FIELD_ALIASES).forEach(([field, aliases]) => {
      headerMap[field] = findHeader(headers, aliases);
    });

    const importedAt = Date.now();
    const rows = (table.records || []).map((record, index) => {
      const normalized = {
        id: `${importedAt}-${index}`,
        rowNumber: record.__rowNumber || index + 2,
        sourceRow: record,
        sourceType: table.sourceType,
        vehicleType: cleanValue(record, headerMap.vehicleType),
        withTrailer: normalizeTrailer(cleanValue(record, headerMap.withTrailer)),
        ownerPhone: normalizeDigits(cleanValue(record, headerMap.ownerPhone)),
        vin: normalizeVin(cleanValue(record, headerMap.vin)),
        color: cleanValue(record, headerMap.color),
        mileage: normalizeNumberText(cleanValue(record, headerMap.mileage)),
        registerDate: normalizeDateValue(cleanValue(record, headerMap.registerDate)),
        registeredAddr: cleanValue(record, headerMap.registeredAddr),
        parkAddr: cleanValue(record, headerMap.parkAddr),
        parkAddrDetail: cleanValue(record, headerMap.parkAddrDetail),
        registeredType: cleanValue(record, headerMap.registeredType),
        transferInfo: cleanValue(record, headerMap.transferInfo),
        brandName: cleanValue(record, headerMap.brandName),
        seriesName: cleanValue(record, headerMap.seriesName),
        modelName: cleanValue(record, headerMap.modelName),
        description: cleanValue(record, headerMap.description),
        referenceReservePrice: normalizeNumberText(cleanValue(record, headerMap.referenceReservePrice)),
        referenceQuotedPrice: normalizeNumberText(cleanValue(record, headerMap.referenceQuotedPrice)),
        subModelName: cleanValue(record, headerMap.subModelName),
        year: cleanValue(record, headerMap.year),
        engineNo: cleanValue(record, headerMap.engineNo),
        title: cleanValue(record, headerMap.title),
        emissionStandard: cleanValue(record, headerMap.emissionStandard),
        fuelType: cleanValue(record, headerMap.fuelType),
        gearbox: cleanValue(record, headerMap.gearbox),
        aiNormalized: null,
        confidence: 0,
        status: 'imported',
        errors: [],
      };
      normalized.displayName = buildDisplayName(normalized);
      return normalized;
    });

    return { headers, headerMap, rows };
  }

  function cleanValue(record, header) {
    if (!header) return '';
    return String(record[header] == null ? '' : record[header]).replace(/^﻿/, '').trim();
  }

  function normalizeNumberText(value) {
    return String(value || '').trim().replace(/\.0$/, '');
  }

  function normalizeDigits(value) {
    return normalizeNumberText(value).replace(/[^0-9]/g, '');
  }

  function normalizeVin(value) {
    return normalizeNumberText(value).toUpperCase();
  }

  function normalizeTrailer(value) {
    const s = String(value || '').trim();
    if (!s) return '';
    if (/^0$|否|不带|无/.test(s)) return '否';
    if (/^1$|是|带挂|有/.test(s)) return '是';
    return s;
  }

  function normalizeDateValue(value) {
    const s = String(value || '').trim();
    if (!s) return '';
    const textMatch = s.match(/(\d{4})[年\/.\-]?(\d{1,2})(?:[月\/.\-]?(\d{1,2}))?/);
    if (textMatch) {
      const y = textMatch[1];
      const m = textMatch[2].padStart(2, '0');
      return `${y}-${m}`;
    }

    const n = Number(s);
    if (Number.isFinite(n) && n > 30000 && n < 80000) {
      const epoch = new Date(Date.UTC(1899, 11, 30));
      epoch.setUTCDate(epoch.getUTCDate() + Math.floor(n));
      const y = epoch.getUTCFullYear();
      const m = String(epoch.getUTCMonth() + 1).padStart(2, '0');
      return `${y}-${m}`;
    }
    return s;
  }

  function buildDisplayName(row) {
    return [row.vehicleType, row.brandName, row.seriesName, row.modelName].filter(Boolean).join(' / ') || row.title || `第 ${row.rowNumber} 行`;
  }

  function applyAiResult(row, ai) {
    if (!ai || typeof ai !== 'object') return row;
    const next = { ...row };
    const patch = {
      brandName: ai.brandName,
      seriesName: ai.seriesName,
      modelName: ai.modelName,
      subModelName: ai.configName || ai.subModelName,
      vehicleType: ai.vehicleType,
      year: ai.year,
    };
    Object.entries(patch).forEach(([k, v]) => {
      if (v != null && String(v).trim()) next[k] = String(v).trim();
    });
    next.aiNormalized = ai;
    next.confidence = Number(ai.confidence) || 0;
    next.status = next.confidence >= 0.7 ? 'ai-ok' : 'need-confirm';
    next.displayName = buildDisplayName(next);
    return next;
  }

  function uniqueValues(rows, field) {
    const seen = new Set();
    const out = [];
    rows.forEach(row => {
      const val = String(row[field] || '').trim();
      const key = normalizeKey(val);
      if (!key || seen.has(key)) return;
      seen.add(key);
      out.push(val);
    });
    return out;
  }

  function buildMissingReport(rows, probe) {
    const optionsByKind = collectOptionsByKind(probe || {});
    const specs = [
      ['brandName', '品牌', optionsByKind.brand],
      ['seriesName', '车系', optionsByKind.series],
      ['modelName', '车型', optionsByKind.model],
      ['vehicleType', '车辆类型', optionsByKind.vehicleType],
    ];

    return specs.map(([field, label, options]) => {
      const values = uniqueValues(rows, field);
      const optionKeys = new Set((options || []).map(normalizeKey));
      const optionReadable = (options || []).length > 0;
      const missing = optionReadable ? values.filter(v => !optionKeys.has(normalizeKey(v)) && ![...optionKeys].some(k => k.includes(normalizeKey(v)))) : [];
      const matched = optionReadable ? values.filter(v => !missing.includes(v)) : [];
      return {
        field,
        label,
        values,
        matched,
        missing,
        optionCount: (options || []).length,
        optionReadable,
        message: optionReadable ? '' : '当前页面未暴露可读取选项，复杂下拉需人工确认。',
      };
    });
  }

  function collectOptionsByKind(probe) {
    const out = { brand: [], series: [], model: [], vehicleType: [] };
    const fields = probe.fields || [];
    fields.forEach(field => {
      const hay = normalizeKey(`${field.label || ''}${field.name || ''}${field.id || ''}${field.placeholder || ''}${field.context || ''}`);
      const kind = detectKind(hay);
      if (!kind || !field.options) return;
      field.options.forEach(opt => {
        if (opt && !out[kind].some(v => normalizeKey(v) === normalizeKey(opt))) out[kind].push(opt);
      });
    });
    return out;
  }

  function detectKind(text) {
    if (/车辆类型|车身类型|类型级别|vehicletype|cartype|typelevel/.test(text)) return 'vehicleType';
    if (/品牌|brand/.test(text)) return 'brand';
    if (/车系|series|serial/.test(text)) return 'series';
    if (/车型|model/.test(text)) return 'model';
    return '';
  }

  function toFillPayload(row) {
    const payload = {};
    RECORDED_PAYLOAD_FIELDS.forEach(k => {
      if (row[k] != null && String(row[k]).trim()) payload[k] = row[k];
    });
    return payload;
  }

  window.VehicleMapper = {
    FIELD_ALIASES,
    FIELD_LABELS,
    normalizeKey,
    mapTable,
    applyAiResult,
    buildMissingReport,
    toFillPayload,
  };
})();
