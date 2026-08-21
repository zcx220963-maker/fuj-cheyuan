(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  let state = null;
  let busy = false;
  let tabFallbackTimer = null;

  document.addEventListener('DOMContentLoaded', function () {
    try { init(); } catch (e) {
      window.__bootError && window.__bootError('初始化失败：' + (e && (e.stack || e.message) || e));
      throw e;
    }
  });

  async function init() {
    logLine('panel initialized （sidepanel 启动成功，事件绑定中）', 'info', false);
    bindEventsSafe();
    logLine('bindEvents 全部完成（dataFile/清空/开始/暂停/上下行/重填 当前行/日志清空）', 'info', false);
    chrome.runtime.onMessage.addListener(onRuntimeMessage);
    chrome.tabs.onUpdated.addListener(onTabUpdated);
    state = await VehicleStore.load();
    applyStateToUI();
    renderAll();
    logLine('录制流程版插件已就绪：导入表后点击"开始/继续批量录入"', 'ok', false);
  }

  function bindEventsSafe() {
    const handlers = [
      ['dataFile', 'change', onFileSelected],
      ['btnClear', 'click', clearAll],
      ['btnStartBatch', 'click', startOrContinueBatch],
      ['btnPauseBatch', 'click', pauseBatch],
      ['btnManualNext', 'click', manualNextAfterSubmit],
      ['btnStopBatch', 'click', stopBatch],
      ['btnPrev', 'click', function () { moveCurrent(-1); }],
      ['btnNext', 'click', function () { moveCurrent(1); }],
      ['btnRefillCurrent', 'click', refillCurrentRow],
      ['btnClearLog', 'click', clearLogs],
    ];
    for (const [id, evt, fn] of handlers) {
      try {
        const el = $(id);
        if (!el) {
          const msg = 'bindEvents 找不到 DOM：#' + id;
          window.__bootError && window.__bootError(msg);
          logLine(msg, 'error');
          continue;
        }
        el.addEventListener(evt, fn);
      } catch (e) {
        const msg = 'bindEvents 失败：#' + id + ' ' + evt + ' → ' + (e && (e.message || e));
        window.__bootError && window.__bootError(msg);
        logLine(msg, 'error');
      }
    }
  }

  function onRuntimeMessage(msg) {
    if (msg?.type !== 'VA_SUBMIT_SUCCESS') return false;
    handleSubmitSuccess(msg);
    return false;
  }

  async function onFileSelected(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    logLine('⚡ onFileSelected 已触发：' + file.name, 'info');
    await runBusy('导入中...', async function () {
      logLine(`[1/4] 开始导入：${file.name} (${(file.size / 1024).toFixed(1)}KB, type=${file.type || '-'})`, 'info');
      const table = await VehicleParser.parseFile(file);
      logLine(`[2/4] 解析完成：${table.headers.length} 列，${table.records.length} 行数据，来源 ${table.sourceType}`, 'info');
      const mapped = VehicleMapper.mapTable(table);
      logLine(`[3/4] 映射完成：${mapped.rows.length} 条数据，写入本地存储...`, 'info');
      state = await VehicleStore.save({
        fileName: file.name,
        importedAt: new Date().toLocaleString(),
        headers: mapped.headers,
        headerMap: mapped.headerMap,
        rows: mapped.rows,
        currentIndex: 0,
        missingReport: [],
        batch: resetBatch('idle', '已导入新数据，等待开始批量录入'),
      });
      $('fileName').textContent = file.name;
      logLine(`[4/4] 存储完成：${mapped.rows.length} 行，原始表头：${table.headers.join(' | ')}`, 'ok');
      renderAll();
    });
  }

  async function loadDemo() {
    await runBusy('加载录制流程示例...', async function () {
      const table = VehicleParser.parseCsvText(recordedFlowCsv());
      const mapped = VehicleMapper.mapTable(table);
      state = await VehicleStore.save({
        fileName: 'matched-truck-recorded-flow.csv',
        importedAt: new Date().toLocaleString(),
        headers: mapped.headers,
        headerMap: mapped.headerMap,
        rows: mapped.rows,
        currentIndex: 0,
        missingReport: [],
        batch: resetBatch('idle', '已加载录制流程示例，等待开始批量录入'),
      });
      $('fileName').textContent = 'matched-truck-recorded-flow.csv';
      logLine('录制流程示例数据已加载', 'ok');
      renderAll();
    });
  }

  function downloadTemplate() {
    const blob = new Blob(['﻿' + recordedFlowCsv()], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'matched-truck-recorded-flow.csv';
    a.click();
    URL.revokeObjectURL(url);
    logLine('录制流程测试表已下载', 'ok');
  }

  async function clearAll() {
    if (!confirm('确定清空导入数据和当前进度？')) return;
    await stopSubmitWatchQuietly();
    state = await VehicleStore.clear();
    $('dataFile').value = '';
    $('fileName').textContent = '选择 CSV / Excel 文件';
    applyStateToUI();
    renderAll();
    logLine('已清空数据', 'warn');
  }

  async function startOrContinueBatch() {
    if (!state.rows.length) return warn('请先导入数据');
    await runBusy('开始批量录入...', async () => {
      state = await VehicleStore.setConfig(readConfigFromUI());
      state = await VehicleStore.setBatch({
        running: true,
        paused: false,
        phase: 'filling',
        startedAt: state.batch?.startedAt || new Date().toLocaleString(),
        lastMessage: '正在打开新增页并填充当前行',
      });
      renderAll();
      await fillCurrentWithNavigation();
    });
  }

  async function fillCurrentWithNavigation() {
    if (state.batch?.paused) return;
    if (!state.rows.length) throw new Error('请先导入数据');
    if (state.currentIndex >= state.rows.length) {
      await markBatchDone();
      return;
    }

    const row = state.rows[state.currentIndex];
    if (!row) throw new Error('当前行不存在');

    await stopSubmitWatchQuietly();
    state = await VehicleStore.setBatch({ phase: 'opening', lastMessage: `正在打开新增页：第 ${row.rowNumber} 行` });
    renderAll();
    await openAddPageCore();
    await waitForPageReady();
    await waitForContentReady();

    state = await VehicleStore.setBatch({ phase: 'filling', lastMessage: `正在填充第 ${row.rowNumber} 行` });
    renderAll();
    const report = await fillCurrentRowCore();

    if (report.fail || report.miss) {
      state = await VehicleStore.setBatch({
        phase: 'waitingManualSubmit',
        waitingRowId: row.id,
        waitingRowNumber: row.rowNumber,
        lastMessage: `第 ${row.rowNumber} 行部分字段未自动完成，请人工处理后提交`,
      });
    } else {
      state = await VehicleStore.setBatch({
        phase: 'waitingManualSubmit',
        waitingRowId: row.id,
        waitingRowNumber: row.rowNumber,
        lastMessage: `第 ${row.rowNumber} 行基础信息已填完，等待人工上传图片、填写价格并提交`,
      });
    }
    await startSubmitWatchForRow(row);
    renderAll();
  }

  async function openAddPageCore() {
    const targetUrl = getAddPageUrl();
    logLine(`openAddPageCore：委托 background 跳转 → ${targetUrl}`, 'info');

    const resp = await new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({ type: 'VA_OPEN_ADD_PAGE', targetUrl }, (response) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message || '跳转消息发送失败'));
          resolve(response);
        });
      } catch (e) { reject(e); }
    });
    if (!resp?.ok) throw new Error(resp?.error || '跳转失败');
    const { tabId, finalUrl, hit } = resp.result || {};
    logLine(`跳转完成：tabId=${tabId} finalUrl=${finalUrl || '-'} hit=${hit ? '是' : '否'}`, hit ? 'ok' : 'warn');
    if (!hit) logLine(`目标 URL 未命中 ${targetUrl}，仍将尝试在当前 tab 上填表；若后续报错请手动打开该 URL`, 'warn');
    state = await VehicleStore.setBatch({ lastAddPageUrl: targetUrl });
    return { status: 'navigated', href: targetUrl, tabId, finalUrl };
  }

  async function refillCurrentRow() {
    if (!state.rows.length) return warn('请先导入数据');
    await runBusy('重填当前行...', async () => {
      // 强制跳一次目标页（不管当前在哪），避免 sidepanel 拿错 tab 判断失误
      state = await VehicleStore.setBatch({ phase: 'opening', lastMessage: '正在打开新增页并重填当前行' });
      renderAll();
      await openAddPageCore();
      await waitForPageReady();
      await waitForContentReady();
      await fillCurrentRowCore();
      const row = state.rows[state.currentIndex];
      state = await VehicleStore.setBatch({
        running: true,
        paused: false,
        phase: 'waitingManualSubmit',
        waitingRowId: row?.id || '',
        waitingRowNumber: row?.rowNumber || '',
        lastMessage: '当前行已重填，等待人工上传图片、填写价格并提交',
      });
      if (row) await startSubmitWatchForRow(row);
      renderAll();
    });
  }

  async function fillCurrentRowCore() {
    const row = state.rows[state.currentIndex];
    if (!row) throw new Error('当前行不存在');
    const payload = VehicleMapper.toFillPayload(row);
    const resp = await sendToActiveTab({ type: 'VA_FILL_ROW', row: payload });
    if (!resp?.ok) throw new Error(resp?.error || '填表失败');
    const report = resp.report;
    const rows = [...state.rows];
    rows[state.currentIndex] = {
      ...rows[state.currentIndex],
      status: report.fail || report.miss ? 'waiting-manual-partial' : 'waiting-manual',
      fillReport: report,
      lastFilledAt: new Date().toLocaleString(),
    };
    state = await VehicleStore.save({ rows });
    logLine(`第 ${row.rowNumber} 行按录制流程填充完成：自动 ${report.hit}，人工 ${report.manual || 0}，未命中 ${report.miss}，失败 ${report.fail}`, report.miss || report.fail ? 'warn' : 'ok');
    renderAll();
    return report;
  }

  async function startSubmitWatchForRow(row) {
    const payload = VehicleMapper.toFillPayload(row);
    const resp = await sendToActiveTab({ type: 'VA_START_SUBMIT_WATCH', row: payload });
    if (!resp?.ok) throw new Error(resp?.error || '提交成功监听启动失败');
    const watchHref = resp.result?.href || '';
    state = await VehicleStore.setBatch({ lastAddPageUrl: watchHref });
    logLine(`已开始监听第 ${row.rowNumber} 行人工提交结果` + (watchHref ? `（新增页：${watchHref}）` : ''), 'ok');
  }

  async function stopSubmitWatchQuietly() {
    try {
      await sendToActiveTab({ type: 'VA_STOP_SUBMIT_WATCH' });
    } catch (e) {}
  }

  async function handleSubmitSuccess(msg) {
    if (!state) state = await VehicleStore.load();
    const batch = state.batch || {};
    if (!batch.running || batch.paused) return;
    if (batch.phase !== 'waitingManualSubmit') return;
    const row = state.rows[state.currentIndex];
    if (!row) return;
    if (batch.waitingRowId && row.id !== batch.waitingRowId) return;

    if (tabFallbackTimer) { clearTimeout(tabFallbackTimer); tabFallbackTimer = null; }
    await completeCurrentAndAdvance(msg.message || '提交成功');
  }

  function onTabUpdated(tabId, info, tab) {
    if (!state || !state.batch) return;
    if (state.batch.phase !== 'waitingManualSubmit') return;
    if (!state.batch.running || state.batch.paused) return;
    if (info.status !== 'complete') return;

    const watchUrl = state.batch.lastAddPageUrl;
    if (!watchUrl) return;
    const currentUrl = tab?.url || '';
    if (!currentUrl) return;

    // 必须是同一管理端域名内的跳转，避免其他 tab 误触发
    try {
      const watchOrigin = new URL(watchUrl, location.href).origin;
      const currentOrigin = new URL(currentUrl, location.href).origin;
      if (watchOrigin !== currentOrigin) return;
    } catch (e) { return; }

    // 还在新增页（URL 仍带 showPageModel=1 或与 watchUrl 同源同路径），不推进
    if (/showPageModel=1/.test(currentUrl)) return;
    if (sameLocation(currentUrl, watchUrl)) return;

    // 启动延迟确认，避免误判（如用户手动点取消返回列表）
    if (tabFallbackTimer) clearTimeout(tabFallbackTimer);
    tabFallbackTimer = setTimeout(async () => {
      tabFallbackTimer = null;
      if (!state || !state.batch) return;
      if (state.batch.phase !== 'waitingManualSubmit') return;
      if (!state.batch.running || state.batch.paused) return;
      logLine('检测到提交后页面跳转（URL 兜底），自动推进到下一行', 'warn');
      await completeCurrentAndAdvance('检测到页面跳转，自动推进（URL 兜底）');
    }, 1500);
  }

  async function manualNextAfterSubmit() {
    if (!state.rows.length) return warn('请先导入数据');
    if (!confirm('确认当前行已经人工提交成功，并继续下一条？')) return;
    await runBusy('继续下一条...', async () => {
      await stopSubmitWatchQuietly();
      await completeCurrentAndAdvance('人工确认已提交');
    });
  }

  async function completeCurrentAndAdvance(message) {
    const rows = [...state.rows];
    const current = rows[state.currentIndex];
    if (!current) return;

    if (tabFallbackTimer) { clearTimeout(tabFallbackTimer); tabFallbackTimer = null; }

    rows[state.currentIndex] = {
      ...current,
      status: 'submitted',
      submittedAt: new Date().toLocaleString(),
    };

    const nextIndex = state.currentIndex + 1;
    const completed = rows.filter(r => r.status === 'submitted').length;
    state = await VehicleStore.save({
      rows,
      currentIndex: nextIndex,
      batch: {
        ...state.batch,
        completed,
        phase: nextIndex >= rows.length ? 'done' : 'nextRow',
        waitingRowId: '',
        waitingRowNumber: '',
        lastAddPageUrl: '',
        lastMessage: nextIndex >= rows.length ? '全部录入完成' : `${message}，准备录入下一条`,
      },
    });
    logLine(`第 ${current.rowNumber} 行已提交完成：${message}`, 'ok');
    renderAll();

    if (nextIndex >= rows.length) {
      await markBatchDone();
      return;
    }

    if (state.batch?.running && !state.batch?.paused) {
      setTimeout(() => {
        runBusy('自动进入下一条...', async () => {
          let lastErr = null;
          for (let attempt = 1; attempt <= 2; attempt++) {
            try {
              await fillCurrentWithNavigation();
              return;
            } catch (e) {
              lastErr = e;
              logLine(`自动进入下一条失败（第${attempt}次）：${e.message || e}`, 'error');
              if (attempt < 2) {
                state = await VehicleStore.setBatch({
                  phase: 'nextRow',
                  lastMessage: `准备重试进入下一条：${e.message || e}`,
                });
                renderAll();
                await sleep(1500);
              }
            }
          }
          state = await VehicleStore.setBatch({
            running: false,
            paused: true,
            phase: 'paused',
            lastMessage: `自动进入下一条连续失败，已暂停。请手动处理后点击"开始/继续"：${lastErr?.message || lastErr || ''}`,
          });
          renderAll();
        });
      }, 800);
    }
  }

  async function markBatchDone() {
    state = await VehicleStore.setBatch({
      running: false,
      paused: false,
      phase: 'done',
      waitingRowId: '',
      waitingRowNumber: '',
      completed: state.rows.filter(r => r.status === 'submitted').length,
      lastMessage: '全部车源录入完成',
    });
    logLine('全部车源录入完成', 'ok');
    renderAll();
  }

  async function pauseBatch() {
    if (!state.rows.length) return warn('请先导入数据');
    if (tabFallbackTimer) { clearTimeout(tabFallbackTimer); tabFallbackTimer = null; }
    await stopSubmitWatchQuietly();
    state = await VehicleStore.setBatch({
      running: false,
      paused: true,
      phase: 'paused',
      lastMessage: '已暂停批量录入',
    });
    logLine('已暂停批量录入', 'warn');
    renderAll();
  }

  async function stopBatch() {
    if (!confirm('确定停止当前批量录入？已提交的行不会回退。')) return;
    if (tabFallbackTimer) { clearTimeout(tabFallbackTimer); tabFallbackTimer = null; }
    await stopSubmitWatchQuietly();
    state = await VehicleStore.setBatch(resetBatch('idle', '批量录入已停止'));
    logLine('批量录入已停止', 'warn');
    renderAll();
  }

  async function moveCurrent(delta) {
    if (!state.rows.length) return warn('请先导入数据');
    const next = Math.max(0, Math.min(state.rows.length - 1, state.currentIndex + delta));
    state = await VehicleStore.save({ currentIndex: next });
    renderAll();
  }

  async function clearLogs() {
    state = await VehicleStore.clearLogs();
    renderLogs();
  }

  async function getTargetTabId() {
    // 通过 background 找用户可见的管理后台 tab，避免 sidepanel 自己的 currentWindow 错拿
    const origin = (() => { try { return new URL(getAddPageUrl()).origin; } catch { return null; } })();
    const resp = await new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({ type: 'VA_GET_TARGET_TAB_ID', origin }, (r) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          resolve(r);
        });
      } catch (e) { reject(e); }
    });
    if (!resp?.ok || !resp.tabId) throw new Error(resp?.error || '无法找到目标 tab');
    return resp.tabId;
  }

  async function sendToActiveTab(message) {
    const tabId = await getTargetTabId();

    const trySend = async () => {
      try { return await chrome.tabs.sendMessage(tabId, message); } catch { return null; }
    };

    // 第一次尝试
    let resp = await trySend();
    if (resp !== null) return resp;

    // content script 失联：先清除页面上的注入标记，再强制重新注入
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => { delete window.__vehicleUploadAssistantInjected; },
      });
    } catch {}

    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['src/content-admin.js'] });
    } catch (e) {
      throw new Error(`强制注入 content script 失败：${e.message}`);
    }

    // 等待注入完成 + 消息监听器注册
    for (let i = 0; i < 10; i++) {
      await sleep(300);
      resp = await trySend();
      if (resp !== null) return resp;
    }

    throw new Error('无法连接当前页面。请确认页面不是 chrome:// 或扩展商店页面。已尝试强制注入并多次重试。');
  }

  function readConfigFromUI() {
    return {
      addPageUrl: $('addPageUrl').value.trim(),
    };
  }

  function applyStateToUI() {
    const cfg = state.config || {};
    $('addPageUrl').value = cfg.addPageUrl || 'http://test.forjtruck.com/vehicle-source/approval?showPageModel=1';
    if (state.fileName) $('fileName').textContent = state.fileName;
  }

  function renderAll() {
    renderSummary();
    renderPreview();
    renderBatch();
    renderLogs();
    updateButtons();
  }

  function renderSummary() {
    const rows = state.rows || [];
    const imported = rows.length;
    $('statusBadge').textContent = imported ? `${Math.min(state.currentIndex + 1, imported)}/${imported}` : '待导入';
  }

  function renderHeaderMapSummary() {
    const map = state.headerMap || {};
    const entries = Object.entries(VehicleMapper.FIELD_LABELS)
      .filter(([field]) => map[field])
      .map(([field, label]) => `${label}←${map[field]}`);
    return entries.length ? escapeHtml(entries.join('，')) : '未识别到标准字段，请检查表头';
  }

  function renderPreview() {
    const rows = state.rows || [];
    const originalHeaders = state.headers || [];
    const el = $('tablePreview');
    if (!rows.length) {
      el.innerHTML = '';
      return;
    }
    // 预览表头：第 1 列是行号 + 状态，然后是原文件原始表头（原汁原味）
    const previewHeaders = ['#行号', '状态', ...originalHeaders];
    const headerHtml = previewHeaders.map(h => `<th title="${escapeHtml(h)}">${escapeHtml(h)}</th>`).join('');
    const statusBadge = row => {
      if (row.status === 'submitted') return '<span class="tag good">已提交</span>';
      if (/^waiting-manual/.test(row.status || '')) return '<span class="tag warn">待人工</span>';
      if (row.status === 'failed') return '<span class="tag bad">失败</span>';
      if (row.status === 'filled') return '<span class="tag warn">已填待提交</span>';
      return '<span class="tag">未处理</span>';
    };
    const body = rows.map((row, i) => {
      const source = row.sourceRow || {};
      const cells = originalHeaders.map(h => {
        const v = source[h] == null ? '' : String(source[h]);
        return `<td title="${escapeHtml(v)}">${escapeHtml(v) || '<span style="color:#6b7e92">—</span>'}</td>`;
      }).join('');
      return `<tr class="${i === state.currentIndex ? 'active' : ''}" data-row-index="${i}"><td><strong style="color:#ffc857">#${escapeHtml(String(row.rowNumber))}</strong></td><td>${statusBadge(row)}</td>${cells}</tr>`;
    }).join('');
    const footer = `<tfoot><tr><th colspan="${previewHeaders.length}">共 ${rows.length} 行 · 原始表头 ${originalHeaders.length} 列 · <span style="color:#ffc857">黄色高亮</span> 为当前正在处理的行 · 滚动查看完整内容</th></tr></tfoot>`;
    el.innerHTML = `<table><thead><tr>${headerHtml}</tr></thead><tbody>${body}</tbody>${footer}</table>`;
    // 滚动到当前行
    requestAnimationFrame(() => {
      const active = el.querySelector('tr.active');
      if (active) active.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }

  function renderBatch() {
    const rows = state.rows || [];
    const batch = state.batch || {};
    const submitted = rows.filter(r => r.status === 'submitted').length;
    const phaseLabel = {
      idle: '未开始',
      opening: '正在打开新增页',
      filling: '正在填充当前行',
      waitingManualSubmit: '等待人工上传图片、填写价格并提交',
      nextRow: '准备下一条',
      paused: '已暂停',
      done: '全部完成',
    }[batch.phase || 'idle'] || batch.phase || '未开始';

    $('batchSummary').innerHTML = rows.length
      ? [
          `状态：${escapeHtml(phaseLabel)}；进度：${submitted}/${rows.length}`,
          `当前行：${state.currentIndex < rows.length ? `${state.currentIndex + 1}/${rows.length}` : '已完成'}`,
          batch.lastMessage ? `说明：${escapeHtml(batch.lastMessage)}` : '',
        ].filter(Boolean).join('<br>')
      : '批量录入未开始';

    const row = rows[state.currentIndex];
    const waiting = batch.phase === 'waitingManualSubmit' && row;
    $('manualHint').className = waiting ? 'manual-hint' : 'manual-hint hidden';
    $('manualHint').innerHTML = waiting
      ? [
          `<strong>请人工处理第 ${escapeHtml(row.rowNumber)} 行</strong>`,
          `1. 上传图片`,
          `2. 填写/确认售价：${escapeHtml(row.referenceQuotedPrice || '-')}（底价已自动填入：${escapeHtml(row.referenceReservePrice || '-')}，如需调整请修改）`,
          `3. 人工点击提交；提交成功后插件会自动进入下一条`,
        ].join('<br>')
      : '';
  }

  function renderCurrent() {
    const row = state.rows?.[state.currentIndex];
    if (!row) {
      $('currentRow').textContent = state.rows?.length ? '当前行：全部完成' : '当前行：无';
      return;
    }
    $('currentRow').innerHTML = [
      `当前行：第 ${row.rowNumber} 行 / ${state.currentIndex + 1}/${state.rows.length}`,
      escapeHtml(row.displayName || ''),
      `车辆类型：${escapeHtml(row.vehicleType || '-')}；是否带挂：${escapeHtml(row.withTrailer || '-')}`,
      `手机号：${escapeHtml(row.ownerPhone || '-')}；VIN：${escapeHtml(row.vin || '-')}`,
      `颜色：${escapeHtml(row.color || '-')}；表显里程：${escapeHtml(row.mileage || '-')}；上牌日期：${escapeHtml(row.registerDate || '-')}`,
      `车籍：${escapeHtml(row.registeredAddr || '-')}；停放：${escapeHtml(row.parkAddr || '-')}；过户：${escapeHtml(row.transferInfo || '-')}`,
      `参考底价：${escapeHtml(row.referenceReservePrice || '-')}（已自动填入）；参考售价：${escapeHtml(row.referenceQuotedPrice || '-')}（人工填写）`,
      `状态：${escapeHtml(row.status || '-')}`,
    ].join('<br>');
  }

  function renderSourceRow() {
    const el = $('sourceRowPreview');
    if (!el) return;
    const row = state.rows?.[state.currentIndex];
    const headers = state.headers || [];
    const headerMap = state.headerMap || {};
    if (!row || !headers.length) {
      el.className = 'source-row-preview empty';
      el.textContent = row ? '原表格表头未记录，无法展示原值' : (state.rows?.length ? '当前行：全部完成' : '未导入');
      return;
    }
    const source = row.sourceRow || {};
    // 构建：原始表头 → （如有）映射到的标准字段 + 标准化后的值
    const reverseMap = {};
    Object.entries(headerMap).forEach(([field, h]) => { if (h) reverseMap[h] = (reverseMap[h] || []).concat(field); });
    const fieldLabels = VehicleMapper.FIELD_LABELS || {};

    let emptyCount = 0;
    const rows = headers.map(h => {
      const rawVal = source[h] == null ? '' : String(source[h]);
      const mappedFields = reverseMap[h] || [];
      const mappedParts = mappedFields.map(field => {
        const normalized = row[field];
        const label = fieldLabels[field] || field;
        const valueText = normalized == null || normalized === '' ? '' : String(normalized);
        return { field, label, valueText };
      });
      const hasMismatch = mappedParts.some(p => p.valueText && rawVal && p.valueText !== rawVal);
      if (!rawVal) emptyCount++;
      const valueCls = rawVal ? 'value' : 'value empty';
      const mappedHtml = !mappedParts.length
        ? '<span class="mapped empty">未映射到标准字段</span>'
        : mappedParts.map(p => {
            const vText = p.valueText || '<span class="mapped empty">空</span>';
            return `<div><strong class="tag ${p.valueText ? 'good' : 'warn'}">${escapeHtml(p.label)}</strong> ${escapeHtml(p.valueText || '') || vText}</div>`;
          }).join('');
      return `<tr class="${hasMismatch ? 'mismatch' : ''}"><td class="header">${escapeHtml(h)}</td><td class="${valueCls}">${rawVal ? escapeHtml(rawVal) : '<span class="value empty">空</span>'}</td><td class="mapped">${mappedHtml}</td></tr>`;
    }).join('');

    const footer = `<tfoot><tr><td colspan="3">当前行：第 ${escapeHtml(String(row.rowNumber))} 行（原表格列 ${headers.length} 个，空值 ${emptyCount} 个）；<span style="color:#ff9f9f">红底</span> = 标准化值与原值不一致（通常是手机号位数/VIN/日期等清洗），需重点核对。</td></tr></tfoot>`;

    el.className = 'source-row-preview';
    el.innerHTML = `<table><thead><tr><th class="col-header">原表格表头</th><th class="col-value">当前行 原始值</th><th class="col-mapped">映射标准字段 · 清洗后值</th></tr></thead><tbody>${rows}</tbody>${footer}</table>`;
  }

  function renderFillReport() {
    const row = state.rows?.[state.currentIndex] || state.rows?.[Math.max(0, state.currentIndex - 1)];
    const fillReport = row?.fillReport;
    const report = fillReport?.report || [];
    const el = $('fillReport');
    if (!report.length) {
      el.className = 'list empty';
      el.textContent = '暂无填表报告';
      return;
    }
    el.className = 'list';
    const safety = fillReport?.safety ? `<div class="item warn"><strong>安全提示</strong>：${escapeHtml(fillReport.safety)}<br>${escapeHtml(fillReport.nextAction || '')}</div>` : '';
    el.innerHTML = safety + report.map(r => {
      const cls = r.status === 'hit' ? 'good' : (r.status === 'fail' ? 'bad' : 'warn');
      const tag = r.status === 'hit' ? '已填写' : (r.status === 'manual' ? '人工' : (r.status === 'fail' ? '失败' : '未命中'));
      return `<div class="item ${cls}"><span class="tag ${cls}">${tag}</span><strong>${escapeHtml(r.label)}</strong>：${escapeHtml(r.value)}<br>${escapeHtml(r.message || '')}</div>`;
    }).join('');
  }

  function renderLogs() {
    const logs = state.logs || [];
    $('log').innerHTML = logs.map(item => `<div class="${escapeHtml(item.level || 'info')}">[${escapeHtml(item.ts || '')}] ${escapeHtml(item.message || '')}</div>`).join('');
    $('log').scrollTop = $('log').scrollHeight;
  }

  function updateButtons() {
    const hasRows = !!state.rows?.length;
    const batch = state.batch || {};
    const waiting = batch.phase === 'waitingManualSubmit';
    $('btnAnalyze').disabled = busy || !hasRows;
    $('btnBuildMissing').disabled = busy || !hasRows || !state.probe;
    $('btnStartBatch').disabled = busy || !hasRows || waiting || batch.phase === 'done';
    $('btnPauseBatch').disabled = busy || !batch.running;
    $('btnManualNext').disabled = busy || !hasRows || !waiting;
    $('btnStopBatch').disabled = busy || (!batch.running && batch.phase !== 'waitingManualSubmit' && batch.phase !== 'paused');
    $('btnRefillCurrent').disabled = busy || !hasRows || state.currentIndex >= state.rows.length;
    $('btnPrev').disabled = busy || !hasRows || state.currentIndex <= 0;
    $('btnNext').disabled = busy || !hasRows || state.currentIndex >= state.rows.length - 1;
    $('btnProbePage').disabled = busy;
    $('btnTestAI').disabled = busy;
    $('btnSaveConfig').disabled = busy;
    $('btnLoadDemo').disabled = busy;
    $('btnDownloadTemplate').disabled = busy;
    $('btnClear').disabled = busy;
  }

  async function runBusy(label, fn) {
    if (busy) return;
    busy = true;
    setStatus(label);
    updateButtons();
    // 最后兜底：任何 runBusy 超过 60 秒，无论 fn 是否 resolve/reject，都强制释放 busy 并写一条错误日志
    const safetyTimer = setTimeout(() => {
      if (!busy) return;
      busy = false;
      const err = new Error(`操作超时（60 秒）仍未完成，已强制重置状态：${label}`);
      warn(err.message);
      logLine(err.message, 'error');
      setStatus(state.rows?.length ? `${Math.min(state.currentIndex + 1, state.rows.length)}/${state.rows.length}` : '待导入');
      updateButtons();
    }, 60000);
    try {
      await fn();
    } catch (e) {
      warn(e.message || String(e));
      logLine(e.message || String(e), 'error');
    } finally {
      clearTimeout(safetyTimer);
      busy = false;
      setStatus(state.rows?.length ? `${Math.min(state.currentIndex + 1, state.rows.length)}/${state.rows.length}` : '待导入');
      updateButtons();
    }
  }

  async function logLine(message, level = 'info', persist = true) {
    const line = document.createElement('div');
    line.className = level;
    line.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
    $('log').appendChild(line);
    $('log').scrollTop = $('log').scrollHeight;
    if (persist) state = await VehicleStore.addLog(message, level);
  }

  function resetBatch(phase, message) {
    return {
      running: false,
      paused: false,
      phase,
      waitingRowId: '',
      waitingRowNumber: '',
      completed: 0,
      failed: 0,
      startedAt: '',
      lastMessage: message || '',
    };
  }

  function getAddPageUrl() {
    return $('addPageUrl').value.trim() || 'http://test.forjtruck.com/vehicle-source/approval?showPageModel=1';
  }

  function sameLocation(left, right) {
    try {
      const a = new URL(left, location.href);
      const b = new URL(right, location.href);
      return a.origin === b.origin && a.pathname === b.pathname && a.search === b.search;
    } catch (e) {
      return String(left || '').trim() === String(right || '').trim();
    }
  }

  function waitForTabComplete(tabId, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('等待新增页加载超时'));
      }, timeoutMs);

      const listener = (updatedTabId, info) => {
        if (updatedTabId === tabId && info.status === 'complete') {
          cleanup();
          resolve();
        }
      };

      function cleanup() {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
      }

      chrome.tabs.onUpdated.addListener(listener);
    });
  }

  async function waitForPageReady() {
    const targetUrl = getAddPageUrl();
    const tabId = await getTargetTabId();

    const startTime = Date.now();
    const timeout = 22000;
    let lastMsg = '';
    while (Date.now() - startTime < timeout) {
      const current = await chrome.tabs.get(tabId);
      const urlOk = !!current?.url && (sameLocation(current.url, targetUrl) || /showPageModel=1/.test(current.url));
      if (!urlOk) {
        lastMsg = `URL 未命中新增页，当前：${current?.url || ''}`;
        await sleep(350);
        continue;
      }

      let domReady = false;
      try {
        const [probeResult] = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            if (!document) return false;
            const rs = document.readyState || '';
            if (rs !== 'complete' && rs !== 'interactive') return false;
            const hasMyForm = !!document.querySelector('#myForm')
              || !!document.querySelector('[id*="myForm"]')
              || !!document.querySelector('.ant-form')
              || !!document.querySelector('.ant-picker, .ant-select');
            return hasMyForm;
          },
        });
        domReady = !!(probeResult?.result);
      } catch {}

      if (domReady) return;
      lastMsg = 'URL 已命中但页面尚未渲染新增表单节点，等待...';
      await sleep(350);
    }
    logLine(`waitForPageReady 超时：${lastMsg || ''}，后续仍会走 content-ready 重试`, 'warn');
  }

  async function waitForContentReady() {
    const resp = await sendToActiveTab({ type: 'VA_WAIT_READY', timeout: 18000 });
    if (!resp?.ok) throw new Error(resp?.error || '等待新增表单失败');
    if (resp.result?.status === 'timeout') logLine(resp.result.message || '等待新增表单超时，继续尝试填表', 'warn');
  }

  function warn(message) {
    $('statusBadge').textContent = '需要处理';
    $('statusBadge').title = message;
  }

  function setStatus(text) {
    $('statusBadge').textContent = text;
  }

  function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  }

  function recordedFlowCsv() {
    return [
      '车辆类型,是否带挂,车主手机号,VIN,车身颜色,表显里程,上牌日期,车籍所在地,停放地区,停放详细地址,车籍性质,过户信息,品牌,车系,车型,车辆描述,参考底价,参考售价',
      '牵引车,否,19719222568,LFV3A24K0L3000001,咖金,7654,2026-08,内蒙古自治区/赤峰市,北京市/北京市,北京市朝阳区测试停车场,公户,可提档过户,一汽解放,解放J6P,解放 J6P重卡 350马力 6X4 牵引车(CA4250P66K2T1AE),测试车辆：一汽解放J6P牵引车，已有车型数据，用于录制流程插件测试。,10000,100000',
      '牵引车,否,19719222569,LFV3A24K0L3000002,咖金,8120,2026-08,内蒙古自治区/赤峰市,北京市/北京市,北京市朝阳区测试停车场,公户,可提档过户,一汽解放,解放J6P,解放 J6P重卡 350马力 6X4 牵引车(CA4250P66K2T1AE),测试车辆：一汽解放J6P牵引车第二条。,10000,100000',
      '牵引车,否,19719222570,LFV3A24K0L3000003,咖金,9440,2026-08,内蒙古自治区/赤峰市,北京市/北京市,北京市朝阳区测试停车场,公户,可提档过户,一汽解放,解放J6P,解放 J6P重卡 350马力 6X4 牵引车(CA4250P66K2T1AE),测试车辆：一汽解放J6P牵引车第三条。,10000,100000',
    ].join('\n');
  }
})();
