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
    chrome.tabs.onActivated.addListener(onTabActivated);
    state = await VehicleStore.load();
    applyStateToUI();
    renderAll();
    logLine('录制流程版插件已就绪：导入表后点击"开始/继续批量录入"', 'ok', false);
  }

  function bindEventsSafe() {
    const handlers = [
      ['dataFile', 'change', onFileSelected],
      ['btnLoadDemo', 'click', loadDemo],
      ['btnDownloadTemplate', 'click', downloadTemplate],
      ['btnClear', 'click', clearAll],
      ['btnStartBatch', 'click', startOrContinueBatch],
      ['btnPauseBatch', 'click', pauseBatch],
      ['btnStopBatch', 'click', stopBatch],
      ['btnPrev', 'click', function () { moveCurrent(-1); }],
      ['btnNext', 'click', function () { moveCurrent(1); }],
      ['btnRefillCurrent', 'click', refillCurrentRow],
      ['btnClearLog', 'click', clearLogs],
    ];
    for (const [id, evt, fn] of handlers) {
      try {
        const el = $(id);
        if (!el) continue;
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
    if (busy) {
      if (tabFallbackTimer) { clearTimeout(tabFallbackTimer); tabFallbackTimer = null; }
      busy = false;
      logLine('检测到上一次操作未正常结束，已强制重置后重新导入', 'warn');
    }
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
      // ======================================================================
      // ★ 用户点"开始/继续批量" = 明确表示要处理当前行。
      //   强行重置 lastCreationFinishedAt=0，消除 creationJustHappened=true 的挡路
      //   （上轮创建时间戳 90s 窗口内过期机制只是防止"创建完 full refill 刚填完立刻又跳创建"的误触发，
      //    用户明确主动点开始/继续/重填，这个机制 100% 应该让路。）
      state = await VehicleStore.setBatch({ lastCreationFinishedAt: 0 });
      // ★★★ 重置当前行品牌确认标记：用户主动点"开始/继续"= 第一次进入车源新增页，
      //      必须让用户手动选品牌（车源新增页品牌不自动填）。
      //      只有创建车系/车型后的 needBack 重填才自动沿用（那里不重置）。
      if (state.rows[state.currentIndex]) {
        const rows = [...state.rows];
        rows[state.currentIndex] = { ...rows[state.currentIndex], brandConfirmed: false, confirmedBrandName: '' };
        state = await VehicleStore.save({ rows });
        logLine(`[品牌一致性锁] 用户主动开始批量 → 清空当前行 confirmedBrandName，必须以本次车源新增页人工实际选择的品牌为准。`, 'info');
      }
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

  function confirmedBrandForRow(row) {
    if (!row || !row.brandConfirmed) return '';
    return String(row.confirmedBrandName || row.brandName || '').trim();
  }

  async function fillCurrentWithNavigation() {
    // ============ 砍屎山：绝对不允许 paused=true 卡死流水线 ============
    // 用户原话："填不填无所谓了，连下一步都不走，一直卡在这里"——
    // 无论之前谁设了 paused=true，这里强制复位 running=true+paused=false，保证流程能往前推。
    if (state.batch?.paused || (state.batch && state.batch.running === false)) {
      logLine(
        `[砍屎山·强制解卡] 检测到之前残留 paused=${state.batch?.paused || false} / running=${state.batch?.running || false}，` +
        `按你要求强制恢复 running=true+paused=false，流水线绝不允许卡死在 waitingManualSubmit/creating。`,
        'warn'
      );
      state = await VehicleStore.setBatch({ running: true, paused: false });
    }
    if (state.batch?.paused) return;    // 理论上上面已经清了，留个保险
    if (!state.rows.length) throw new Error('请先导入数据');
    const logTag = `[fill] row=${state.currentIndex + 1}/${state.rows.length} rowNumber=${state.rows[state.currentIndex]?.rowNumber || '-'} phase=${state.batch?.phase}`;
    console.log(logTag, 'start fillCurrentWithNavigation');

    if (state.currentIndex >= state.rows.length) {
      console.log(logTag, '→ currentIndex >= rows.length, markBatchDone');
      await markBatchDone();
      return;
    }

    // ====== 【主任务锁 Step 1】：开启这行车源大任务前，生成唯一 taskLockId ======
    // 这个 token 会从现在起一直"钉死"在 (batch, row, submitWatch) 三处。
    // 只要后续 completeCurrentAndAdvance 没拿到相同 token，就绝对不会把这行标记为已提交。
    const newLockId = genTaskLockId();
    const rowsClone = [...state.rows];
    const idx = state.currentIndex;
    rowsClone[idx] = {
      ...(rowsClone[idx] || {}),
      taskLockId: newLockId,           // (c) 行本体也写一份
      submittedAt: (rowsClone[idx] && rowsClone[idx].status === 'submitted') ? (rowsClone[idx].submittedAt || '') : '', // 防重入时误带 submittedAt
      status: (rowsClone[idx] && rowsClone[idx].status === 'submitted') ? rowsClone[idx].status : (rowsClone[idx]?.status || 'waiting-manual-partial'),
    };
    state = await VehicleStore.save({
      rows: rowsClone,
      batch: {
        ...(state.batch || {}),
        taskLockId: newLockId,          // (a) batch 层面钉死
      },
    });
    let row = state.rows[state.currentIndex];
    if (!row) throw new Error('当前行不存在');
    logLine(`[主任务硬锁] 第${row.rowNumber}行车源大任务启动，taskLockId=${newLockId}。本 token 未匹配前，任何事件都不会标记该行为已提交。`, 'info');
    console.log(logTag, `taskLockId=${newLockId} 已写入 batch+row`);

    await stopSubmitWatchQuietly();
    state = await VehicleStore.setBatch({ phase: 'opening', lastMessage: `正在打开新增页：第 ${row.rowNumber} 行（taskLockId=${newLockId.slice(-6)}）` });
    renderAll();
    await openAddPageCore();
    await waitForPageReady();
    await waitForContentReady();

    // Stage 1/3: 先填 车辆类型（联动前置）→ 品牌 → 车系 → 车型（规格参数3项）共4字段
    // 先选车辆类型，后台才把规格参数下拉的联动数据加载出来；
    // 如果车系/车型不存在，会在此阶段立刻创建（并跳回新增页），避免其他字段白填一遍。
    logLine(`[流程优化] Stage 1/3：按顺序填 车辆类型→品牌→车系→车型（必须先填车辆类型，后台才能加载规格参数下拉）`, 'info');
    state = await VehicleStore.setBatch({ phase: 'probing', lastMessage: `第 ${row.rowNumber} 行：按顺序填 车辆类型→品牌→车系→车型，探测是否缺失需要创建` });
    renderAll();

    // ==========================================================================
    // ★ 用户硬要求：CSV 里如果品牌、车系、车型 3 个字段都有值（01测试车系/01测试车型 这种新序号），
    //   不管 Stage1 fillCurrentRowCore 填 PROBE_4 项过程中：
    //      (1) 是否抛异常
    //      (2) 某个控件没滚到视口导致填不上（品牌/车辆类型绿框停在那）
    //      (3) 下拉联动缓存没刷新导致返回 miss/fail
    //   → 一律强制走【砍屎山·直达创建】，绝不进 waitingManualSubmit 等死（红框不动）！
    //   只有真正缺少创建参数（CSV 行里 brandName/seriesName/modelName 为空）时，才允许停在 waitingManualSubmit 让你人工处理。
    const hasAllCreationPrerequisites = Boolean(row.brandName && row.seriesName && row.modelName);
    // ==========================================================================
    // ★ 修复（你截图：车系=红框"请选择"、车型=红框"请选择"、品牌=绿框"一汽解放"，还是卡住 waitingManualSubmit 不跳创建）
    //   原来 UI 兜底探测/强兜底/异常保护 全部依赖 hasAllCreationPrerequisites（三值齐全），
    //   但用户真实场景可能：CSV 里 brandName 有值 + seriesName 有值 但 modelName 误写为空（或者反过来），
    //   三值不齐 → hasAllCreationPrerequisites=false → 所有四层兜底+一票否决权 全部不触发 →
    //   sMiss/mMiss 仅靠 Stage1 PROBE 报告，若报告误判 hit → combinedGoCreate=false → 直接 waitingManualSubmit → 红框空着卡住。
    //
    //   修复策略（对齐 Experience 988355：下拉找不到必须走创建，不能等三值齐全）：
    //   新增 hasMinCreationPrerequisites：只要 CSV 里有【要创建的目标名称】（seriesName 或 modelName 至少一个有值，且最好 brandName 也有），
    //   就触发所有的兜底逻辑（强兜底、异常保护、UI 探测、一票否决权）。因为用户说"下拉找不到"的时候，
    //   至少车系或车型的名称肯定写在 CSV 里了，我们就应该去创建，不能因为其中一个空就全部兜底失效。
    const hasBrandForCreate = Boolean(row.brandName);
    const hasSeriesForCreate = Boolean(row.seriesName);
    const hasModelForCreate = Boolean(row.modelName);
    const hasMinCreationPrerequisites =
      // 场景A：品牌+车系有值（车型可以稍后再决定，先去创车系）
      (hasBrandForCreate && hasSeriesForCreate) ||
      // 场景B：车系+车型有值（缺品牌那就让创建抽屉里报给用户补）
      (hasSeriesForCreate && hasModelForCreate) ||
      // 场景C：三值齐全（最强兜底，永远触发）
      hasAllCreationPrerequisites;

    let probeReport;
    let probeStatusMap = { vehicleType: 'unknown', brandName: 'unknown', seriesName: 'unknown', modelName: 'unknown' };
    try {
      // ★ skipCreation=true 是关键：禁止 fillCurrentRowCore 内部的旧 tryCreateMissingSeriesOrModel 跑。
      // 因为现在已经有"砍屎山·直达创建"分支（下面 sMiss||mMiss 那段）来处理车系/车型缺失，
      // 两套逻辑并行 = 旧逻辑返回 needRefill → didCreationJustHappened=true → 直达创建被 creationJustHappened=true 挡掉 → 车系/车型还空着就直接 waitingManualSubmit → 卡住（你截图现象）。
      probeReport = await fillCurrentRowCore({
        fields: PROBE_FIELDS,          // 白名单: [vehicleType, brandName, seriesName, modelName]
        excludeFields: null,
        skipCreation: true,            // ✅ 旧创建逻辑本轮不跑。探测完毕后直接走下方【砍屎山·直达创建】（唯一有效创建入口）
        skipPersistStatus: true,       // 预填结果不写回 fillReport，保持干净
      });
      state = await VehicleStore.load();
      row = state.rows[state.currentIndex];
      if (!row) throw new Error('当前行不存在');
    } catch (probeErr) {
      logLine(`[流程优化] ⚠️ Stage 1 PROBE_4 项填抛出异常：${probeErr?.message || String(probeErr)} → 按用户硬规则：只要CSV有brand/series/model就强行走直达创建。`, 'warn');
      probeReport = { ok: false, hit: 0, miss: PROBE_FIELDS.length, report: PROBE_FIELDS.map(f => ({ field: f, status: 'fail', message: 'Stage1异常：' + (probeErr?.message || String(probeErr)) })) };
      // 异常保护门槛同步降低：hasAllCreationPrerequisites（三值齐全）依然强制标全套；
      //   hasMinCreationPrerequisites（只够创车系 or 只够创车型）也按实际情况分别标，绝不因为三值不齐就跳过。
      if (hasAllCreationPrerequisites) {
        logLine(`[流程优化] ✅ CSV 行 brandName="${row.brandName}" seriesName="${row.seriesName}" modelName="${row.modelName}" 三值齐全 → 强制标记 sMiss=true/mMiss=true，进入直达创建。`, 'info');
        probeStatusMap = { vehicleType: 'fail', brandName: 'fail', seriesName: 'miss', modelName: 'miss' };
      } else if (hasMinCreationPrerequisites) {
        logLine(`[流程优化] ✅ CSV 行 brandName="${row.brandName}" seriesName="${row.seriesName}" modelName="${row.modelName}" 满足最小创建门槛（三值不全，但有 brand+series / series+model）→ 按实际分别标记 sMiss/mMiss，进入直达创建。`, 'warn');
        const sm = { ...probeStatusMap };
        if (hasSeriesForCreate) sm.seriesName = 'miss';
        if (hasModelForCreate) sm.modelName = 'miss';
        sm.vehicleType = sm.vehicleType === 'unknown' ? 'fail' : sm.vehicleType;
        sm.brandName = sm.brandName === 'unknown' ? 'fail' : sm.brandName;
        probeStatusMap = sm;
      }
    }

    if (!probeStatusMap || probeStatusMap.vehicleType === 'unknown' || (probeReport && Array.isArray(probeReport.report))) {
      const items = Array.isArray(probeReport?.report) ? probeReport.report : [];
      PROBE_FIELDS.forEach(f => {
        const item = items.find(x => x.field === f);
        probeStatusMap[f] = item ? (item.status || 'unknown') : (probeStatusMap[f] || 'not-in-report');
      });
    }
    const probeItems = Array.isArray(probeReport?.report) ? probeReport.report : [];
    const seriesProbeItem = probeItems.find(x => x.field === 'seriesName') || null;
    const modelProbeItem = probeItems.find(x => x.field === 'modelName') || null;
    function isExplicitDropdownOptionMissing(item) {
      if (!item) return false;
      const status = item.status || '';
      const reason = item.reason || '';
      const message = String(item.message || '');
      // 只有“目标选项在该下拉里找不到”才代表需要去车型库创建。
      // 控件没找到、品牌没选中、车辆类型没填上等前置问题不能被当成车系/车型不存在。
      return (status === 'fail' || status === 'miss')
        && (reason === 'option-not-found' || /下拉框未找到匹配选项|未找到匹配选项/.test(message));
    }
    let sMiss = hasSeriesForCreate && isExplicitDropdownOptionMissing(seriesProbeItem);
    let mMiss = hasModelForCreate && isExplicitDropdownOptionMissing(modelProbeItem);
    const vMiss = probeStatusMap['vehicleType'] === 'miss' || probeStatusMap['vehicleType'] === 'fail';
    const bMiss = probeStatusMap['brandName'] === 'miss' || probeStatusMap['brandName'] === 'fail';
    const anyProbeMissing = vMiss || bMiss || sMiss || mMiss;

    // 已明确命中的车系/车型绝不允许被兜底改成“缺失”。
    // 是否创建只看上面的 isExplicitDropdownOptionMissing；前置字段异常只进入人工处理/重填，不创建库数据。
    if (probeStatusMap['seriesName'] === 'hit') sMiss = false;
    if (probeStatusMap['modelName'] === 'hit') mMiss = false;

    // ==========================================================================
    // 【终极兜底·第 4 层】：直接发消息读当前 DOM 上品牌/车系/车型 3 个控件的真实选中文本（不依赖 fillRecordedRow 报告），
    //   只要任意一个还停在"请选择/空/未选择"，且 CSV 行 brandName/seriesName/modelName 满足 hasMinCreationPrerequisites（不再要求三值齐全！），
    //   就强制把 combinedGoCreate 改成 true，直达创建分支。
    //
    //   为什么还要这一层？前面三层兜底是：
    //     1) Stage1 抛异常才构造 sMiss/mMiss=true；
    //     2) didCreationJustHappened 加 batch.lastCreationFinishedAt 门槛；
    //     3) hasMinCreationPrerequisites && !sMiss && !mMiss 强标 true；
    //   但你截图场景是：Stage1 fillCurrentRowCore 根本没抛异常（正常 resolve），report 里 brand/series/model 被误判成 status=hit（其实控件绿框没选上），
    //   前面三层就都不触发，直接进 Stage2/3 → 但真正的规格参数 3 项 DOM 上根本还是"请选择"红框空 → 就死等 waitingManualSubmit 不动了。
    //   所以第 4 层兜底绕开所有 report 字段，看一眼 DOM 真文本，空就强制跳创建，100% 不再卡。
    // ==========================================================================
    let goCreateByUIProbe = false;
    // ★ 门槛同步降低：hasAllCreationPrerequisites（三值齐全）→ hasMinCreationPrerequisites（满足即可）
    if (hasMinCreationPrerequisites) {
      try {
        const ui = await sendToActiveTab({ type: 'VA_PROBE_UI_EMPTY_BRAND_SERIES_MODEL', timeout: 8000 });
        const r = ui?.result || {};
        logLine(
          `[流程优化][UI 兜底探测] empty=${!!r.empty} scopeFound=${!!r.scopeFound} scope=${r.scopeRootTag||''}/${(r.scopeRootClass||'').slice(0,40)}（` +
          `brand:${r.brandEmpty ? '空' : r.brandText || '?(notfound)'}[label=${r.brandMatchedLabel||'?'}]，` +
          `车系:${r.seriesEmpty ? '空' : r.seriesText || '?(notfound)'}[label=${r.seriesMatchedLabel||'?'}]，` +
          `车型:${r.modelEmpty ? '空' : r.modelText || '?(notfound)'}[label=${r.modelMatchedLabel||'?'}]` +
          `) brandFound=${!!r.brandFound} seriesFound=${!!r.seriesFound} modelFound=${!!r.modelFound}`,
          r.empty ? 'warn' : 'info'
        );
        if (r.empty) {
          const reason = [
            r.brandEmpty ? `品牌（当前="${r.brandText || '空'}"）` : null,
            r.seriesEmpty ? `车系（当前="${r.seriesText || '空'}"）` : null,
            r.modelEmpty ? `车型（当前="${r.modelText || '空'}"）` : null,
          ].filter(Boolean).join('、');
          logLine(`[流程优化][UI诊断] 当前表单仍有空值：${reason}。这只作为诊断，不再直接触发创建；创建只依据 Stage1 对车系/车型返回的 option-not-found。`, 'warn');
        } else if (!r.scopeFound) {
          logLine(`[流程优化][UI诊断] scopeFound=false（没找到车源新增表单区或页面未稳定）。这不代表车系/车型不存在，不再强制跳创建。`, 'warn');
        }
      } catch (uiErr) {
        logLine(`[流程优化][UI 兜底探测] VA_PROBE_UI_EMPTY_BRAND_SERIES_MODEL 消息异常：${uiErr?.message || String(uiErr)} → 按原流程走。`, 'warn');
      }
    }

    // 如果 needRefill=true（即有创建发生），fillCurrentRowCore 内部已经在新的空白新增页里
    // 全字段填过一遍了（包括车辆类型+所有其他，因为 needRefill 分支传的 fields=null）。
    // 此时跳过 Stage 2/3。
    let creationJustHappened = didCreationJustHappened(probeReport, state.batch);

    // ==========================================================================
    // 【第 4.5 层 · UI 兜底的一票否决权】（对应你截图"应该跳创建又回来了"的根因）
    //   用户现在的真实场景：DOM 上 品牌/车系/车型 三个控件明确显示「请选择」绿框/红框空着
    //   但 Stage1 PROBE 报告可能把 sMiss/mMiss 误判成 false（因为控件绿框停在那，报告当"选上了"）
    //   再加上 creationJustHappened=true（上轮创建时间戳 90s 窗口内没过期）
    //   → 原来 combinedGoCreate 条件第三项 `&& !!(sMiss || mMiss)` 要求 sMiss/mMiss 有一个 true
    //   → 结果第三项也是 false → combinedGoCreate=false → 不跳创建 → 直接"跳回来"停在空表单页。
    //
    //   修复策略（对齐 Experience 1058656：关键分支推进必须以「真实 DOM 观测结果」为准）：
    //     只要 goCreateByUIProbe=true（即 probeCurrentUIBrandSeriesModel 返回 empty=true，
    //     DOM 上真的看到了「请选择/空」文本）→ 这就是【最硬的事实证据】，它拥有最高优先级：
    //     (A) 无视 creationJustHappened 时间戳（把 batch.lastCreationFinishedAt 重置为 0 消除挡路）
    //     (B) 无视 sMiss/mMiss 报告结果（直接强制 sMiss=true / mMiss=true）
    //     (C) 直接把 combinedGoCreate 置 true，不再看其他任何条件。
    //   因为：用户截图里的红框空"请选择"是永远不会撒谎的，它一定意味着"下拉里根本找不到对应选项=必须去创建"。
    // ==========================================================================
    if (goCreateByUIProbe) {
      logLine(`[流程优化][UI诊断] goCreateByUIProbe=true，但创建判定已收紧：不会再因 UI 空值直接强制 sMiss/mMiss。`, 'warn');
      goCreateByUIProbe = false;
    }

    let finalReport = probeReport;

    // ==========================================================================
    // ★ 【调试】分支判定全量快照日志（用户说"依旧不跳"，我们必须看到每一步的变量值）
    //   直接 ERROR 级别，侧边栏红框一眼就能看到。包含所有可能影响 combinedGoCreate 的变量。
    // ==========================================================================
    const snapshotVars = {
      rowNumber: row.rowNumber,
      CSV_brand: row.brandName || '', CSV_series: row.seriesName || '', CSV_model: row.modelName || '', CSV_vehicleType: row.vehicleType || '',
      hasAllCreationPrerequisites, hasMinCreationPrerequisites,
      hasBrandForCreate, hasSeriesForCreate, hasModelForCreate,
      vMiss, bMiss, sMiss, mMiss, anyProbeMissing,
      probeStatusMap,
      probeReport_ok: probeReport?.ok, probeReport_hit: probeReport?.hit, probeReport_miss: probeReport?.miss,
      creationJustHappened,
      lastCreationFinishedAt: state.batch?.lastCreationFinishedAt || 0,
      now: Date.now(),
      creationWindowLeft_ms: state.batch?.lastCreationFinishedAt ? (90000 - (Date.now() - (state.batch.lastCreationFinishedAt || 0))) : null,
      goCreateByUIProbe,
    };
    logLine(`[判定快照·为什么不跳？] ★ 所有变量值如下：\n${JSON.stringify(snapshotVars, null, 2)}\n—— 记住：combinedGoCreate=(sMiss||mMiss)&&!creationJustHappened || goCreateByUIProbe。下面马上给你计算结果。`, 'error');

    // ==========================================================================
    // ★ 【终极·0 门槛拦截】（对齐 Experience 137743：绝不能再原地踏步）
    //   目前已有的兜底链路，还是可能因为下面两种极端情况 combinedGoCreate=false：
    //     Case A：creationJustHappened=true（上一轮创建完 90s 窗口内），sMiss=true/mMiss=true → (sMiss||mMiss)&&!creationJustHappened 直接 false
    //             但此时 goCreateByUIProbe=false（因为 scopeFound=false 或控件没找到文本匹配失败，UI 探测 empty=false）
    //             → combinedGoCreate=false → 死等 waitingManualSubmit。
    //     Case B：Stage1 PROBE 报告全部 hit（sMiss=false/mMiss=false）→ (sMiss||mMiss)=false → creationJustHappened 就算 false 也过不了第一项
    //             但 UI 探测 scopeFound=true 文本读错了（比如控件 value 读成空字符串，findControlInModalByLabel 串了），goCreateByUIProbe=false → 还是不跳。
    //
    //   终极拦截策略：只要满足"CSV 里明确有想创建的 series/model（hasMinCreationPrerequisites=true）"，并且下面任一条件成立 → 直接强制 goCreateByUIProbe=true：
    //     (1) 任何探测 miss/fail（anyProbeMissing=true）
    //     (2) Stage1 PROBE 根本没填成功（probeReport.ok=false 或 miss>0）
    //     (3) CSV 里 seriesName 有值，但 sMiss=false + probeStatusMap.seriesName!=='hit'（报告说不上 miss 也不算 hit，中间态）
    //     (4) CSV 里 modelName 有值，但 mMiss=false + probeStatusMap.modelName!=='hit'（同上）
    //   强制 goCreateByUIProbe=true 后，上面第 4.5 层一票否决权就会立刻把 creationJustHappened 重置为 false（如果之前是 true 挡路的话），
    //   并且强标 sMiss=true/mMiss=true → combinedGoCreate 必为 true，跳创建 100%。
    // ==========================================================================
    const forceCreateTrigger = false;
    if (hasMinCreationPrerequisites && (vMiss || bMiss || probeReport?.ok === false || (probeReport?.miss ?? 0) > 0) && !sMiss && !mMiss) {
      logLine(
        `[判定快照] Stage1 存在前置字段/探测异常，但车系/车型没有明确 option-not-found：` +
        `vMiss=${vMiss} bMiss=${bMiss} probeOk=${probeReport?.ok} probeMiss=${probeReport?.miss ?? 0}。` +
        `按规则不创建车系/车型，后续进入人工处理或重填。`,
        'warn'
      );
    }

    // 如果刚才终极 0 门槛拦截把 goCreateByUIProbe 标成 true，重新走一次 4.5 层一票否决权（重置时间戳+强标 sMiss/mMiss）
    if (goCreateByUIProbe) {
      logLine(`[流程优化][UI诊断] goCreateByUIProbe=true，但创建判定已收紧：不会再因 UI 空值直接强制 sMiss/mMiss。`, 'warn');
      goCreateByUIProbe = false;
    }

    // 计算最终是否要走直达创建：
    //   (1) 原条件 (sMiss || mMiss) && !creationJustHappened
    //   (2) OR 第 4 层 UI 兜底探测出来 goCreateByUIProbe=true（CSV 三值齐全 + DOM 有任一项还是请选择）
    //   (3) OR 第 4.5 层一票否决权强制 goCreateByUIProbe=true
    //   (4) OR 终极 0 门槛拦截强制 goCreateByUIProbe=true
    // 注意：如果 creationJustHappened=true（上一轮刚创建完 full refill 完那一次）且 UI 显示 brand/series/model 都选上了 → 还是跳过直达创建走重填成功流程。
    // 【特别提醒】：上面 goCreateByUIProbe=true 的分支已经把 creationJustHappened 重置为 false，所以 (goCreateByUIProbe && creationJustHappened) 这种组合永远不会再出现，避免被 creationJustHappened=true 再拦一次。
    const bothSpecHit = probeStatusMap['seriesName'] === 'hit' && probeStatusMap['modelName'] === 'hit';
    if (bothSpecHit) {
      sMiss = false;
      mMiss = false;
      goCreateByUIProbe = false;
    }
    const combinedGoCreate = ((sMiss || mMiss) && !creationJustHappened);
    logLine(`[判定快照·最终结果] combinedGoCreate=${combinedGoCreate}。series=${probeStatusMap['seriesName']} model=${probeStatusMap['modelName']} reasonS=${seriesProbeItem?.reason || '-'} reasonM=${modelProbeItem?.reason || '-'}。为 false 就会进 Stage2/3 → waitingManualSubmit；为 true 就立刻跳创建。`, combinedGoCreate ? 'warn' : 'info');

    // ==========================================================================
    // 【砍屎山·直达创建】车系/车型没命中 → 不 waitingManualSubmit 卡死，立刻重新进入 creating 阶段，
    //                   直接调 VA_NAVIGATE_AND_CREATE 跳去创建车系/车型，绝不填其他字段。
    //                   用户原话："车系车型没有，还填其他的做什么，直接跳创建啊"
    // ==========================================================================
    if (combinedGoCreate) {
      const whatMiss = [sMiss && `车系(${row.seriesName || '-'})`, mMiss && `车型(${row.modelName || '-'})`].filter(Boolean).join('、');
      const createBrandName = confirmedBrandForRow(row);
      if (!createBrandName) {
        logLine(
          `[品牌一致性锁] ⛔ 第${row.rowNumber}行需要创建${whatMiss}，但还没有拿到车源新增页人工确认品牌。` +
          `禁止使用导入表推断品牌「${row.brandName || '-'}」去创建，避免车源页品牌和车型库品牌不一致。请在车源新增页选好品牌后点【重填当前行】。`,
          'error'
        );
        state = await VehicleStore.setBatch({
          phase: 'waitingManualSubmit', running: true, paused: false,
          waitingRowId: row.id, waitingRowNumber: row.rowNumber,
          taskLockId: state.batch?.taskLockId || '',
          lastMessage: `第 ${row.rowNumber} 行：缺少人工确认品牌，已阻止自动创建${whatMiss}`,
        });
        renderAll();
        await startSubmitWatchForRow(row);
        return;
      }
      logLine(
        `[砍屎山·直达创建] 🚀 第${row.rowNumber}行：${whatMiss}在下拉里找不到。` +
        `按你要求：**其他字段一概不填，立刻跳去创建**；品牌一致性锁定为「${createBrandName}」。` +
        `跳转到车型库管理 → 新建 → 你在右侧抽屉里填完点"提交"，创建成功后自动回到车源新增页重填。`,
        'warn'
      );
      const snapshot = await enterCreatingPhase(`第${row.rowNumber}行${whatMiss}缺失，直达创建车系/车型...`);
      let needBack = false;
      try {
        // ---- 1) 先创车系 ----
        if (sMiss && createBrandName && row.seriesName) {
          // 车系创建完后面还有"车型也缺失"要创建 → 1)skipReturnToAddPage=true，不在车源管理来回跳；
          //                                2)switchToModelAfterSeriesCreated=true，用户要求的：
          //                                  车系提交成功后必须立刻切到"车型管理"列表页，
          //                                  下一轮点"+新增"才是车型管理新增（图234），不会再误开车系新增（图1）。
          const skipReturn1 = !!(mMiss && row.modelName);
          const switchToModel1 = !!skipReturn1;
          logLine(`[砍屎山] 直达创建车系 → 品牌=${createBrandName}（人工确认锁定） 车系=${row.seriesName} 车辆类型=${row.vehicleType || '(留空，抽屉里选)'} | skipReturn=${skipReturn1 ? '✅是（后面还有车型要创建）' : '否（直接回新增页）'} | switchToModel=${switchToModel1 ? '✅是（建完自动切到车型管理列表/Model/Model页面）' : '否'}`, 'info');
          const r1 = await sendToActiveTab({
            type: 'VA_NAVIGATE_AND_CREATE',
            payload: { kind: 'series', brandName: createBrandName, brandConfirmed: true, seriesName: row.seriesName, vehicleType: row.vehicleType || '', skipReturnToAddPage: skipReturn1, switchToModelAfterSeriesCreated: switchToModel1 },
            timeout: 180000,
          });
          await ensureSnapshot(snapshot, '直达创建车系后');
          (r1?.result?.steps || []).forEach((s, i) => logLine(`  ·S${i + 1}: ${s}`, 'info', false));
          const ok1 = r1?.ok && r1.result?.ok;
          const canc1 = r1?.result?.cancelled || r1?.result?.via === 'modalClosedWithoutSubmit';
          if (canc1) {
            logLine(`[砍屎山] ⏸ 创建车系被你取消。流水线不暂停（防止卡死），回 waitingManualSubmit。请人工补建后点【重填当前行】或手动提交后点【已提交下一步】。`, 'warn');
            if (skipReturn1) {
              // ★ skipReturn=true（后面还有车型要创建）时，取消创建绝不主动切回新增页！
              //   还有一个致命 Bug 要修：**绝对不能调 startSubmitWatchForRow(row)，也不能让 watcherBoundOnAddPage=true**
              //   因为此时页面还在车系/车型管理页（用户还没手动切回车源新增页），watcher 挂上去是空挂，
              //   更关键是用户硬规则"只有下一次进入车源新增页后的人工提交才有效"，现在连页面都不在，提前开闸等于违规。
              logLine(`[砍屎山] ✅ 车系skipReturn=true+取消：保持当前页面不动（不切回审核列表+新增），**不调用startSubmitWatchForRow，watcherBoundOnAddPage保持false**，避免"应该跳创建又跳回来了"和watcher误开闸。`, 'info');
            } else {
              // 只有 skipReturn=false（只有车系缺，后面没有车型要建）才切回新增页并挂 watcher
              try { await openAddPageCore(); } catch (_e) { logLine(`补跳回新增页失败：${_e?.message || String(_e)}`, 'warn'); }
            }
            state = await VehicleStore.setBatch({
              phase: 'waitingManualSubmit', running: true, paused: false,
              waitingRowId: snapshot.waitingRowId, waitingRowNumber: snapshot.waitingRowNumber,
              currentIndex: snapshot.index, taskLockId: state.batch?.taskLockId || '',
              // ★ skipReturn=true 时 watcherBoundOnAddPage 保持 false（因为还没回车源新增页，watcher 不能开闸）
              //   skipReturn=false 时，下一行 startSubmitWatchForRow 会把它改成 true
              watcherBoundOnAddPage: skipReturn1 ? false : (state.batch?.watcherBoundOnAddPage ?? false),
              lastMessage: `第${snapshot.rowNumber}行车系创建被取消，请人工补建后点【重填当前行】`,
            });
            renderAll();
            if (!skipReturn1) {
              // ★ 只有确定已经切到/正要切回车源新增页（skipReturn=false）才挂 watcher
              await startSubmitWatchForRow(row);
            } else {
              logLine(`[Watcher闸] ✅ skipReturn=true → 未调用 startSubmitWatchForRow，watchBound 保持 false（必须重填当前行回车源页时才重新挂 watcher）。`, 'warn');
            }
            return;
          }
          if (!ok1) {
            logLine(`[砍屎山] ❌ 创建车系失败：${r1?.result?.message || r1?.error || '未知'}。流水线不暂停，回 waitingManualSubmit 让你处理后点重填。`, 'error');
            if (skipReturn1) {
              // ★ 同上：失败也一样，保持当前页，不开 watcher 闸
              logLine(`[砍屎山] ✅ 车系skipReturn=true+失败：保持当前页面不动（不切回审核列表+新增），**不调用startSubmitWatchForRow，watcherBoundOnAddPage保持false**，避免"应该跳创建又跳回来了"和watcher误开闸。请点侧边栏【重填当前行】重试。`, 'info');
            } else {
              try { await openAddPageCore(); } catch (_e) { logLine(`补跳回新增页失败：${_e?.message || String(_e)}`, 'warn'); }
            }
            state = await VehicleStore.setBatch({
              phase: 'waitingManualSubmit', running: true, paused: false,
              waitingRowId: snapshot.waitingRowId, waitingRowNumber: snapshot.waitingRowNumber,
              currentIndex: snapshot.index, taskLockId: state.batch?.taskLockId || '',
              watcherBoundOnAddPage: skipReturn1 ? false : (state.batch?.watcherBoundOnAddPage ?? false),
              lastMessage: `第${snapshot.rowNumber}行车系创建失败，请人工解决后点【重填当前行】`,
            });
            renderAll();
            if (!skipReturn1) await startSubmitWatchForRow(row);
            else logLine(`[Watcher闸] ✅ skipReturn=true → 未调用 startSubmitWatchForRow，watchBound 保持 false（必须重填当前行回车源页时才重新挂 watcher）。`, 'warn');
            return;
          }
          logLine(`[砍屎山] ✅ 创建车系成功 → 继续创建车型：${r1.result.message}`, 'ok');
          needBack = true;
        } else if (sMiss && (!createBrandName || !row.seriesName)) {
          logLine(`[砍屎山] ⚠️ 车系未命中但人工确认品牌/车系为空，无法自动创建，停 waitingManualSubmit 请人工处理。`, 'warn');
        }
        // ---- 2) 再创车型 ----
        if (mMiss && createBrandName && row.seriesName && row.modelName) {
          // ★ 车型创建也【必须传 skipReturnToAddPage:true】
          logLine(`[砍屎山] 直达创建车型 → 品牌=${createBrandName}（人工确认锁定） 车系=${row.seriesName} 车型=${row.modelName} 车辆类型=${row.vehicleType || '(留空，抽屉里选)'} | skipReturn=✅是（由sidepanel needBack块统一回车源+重填，防content-admin和sidepanel两次跳打架）`, 'info');
          const r2 = await sendToActiveTab({
            type: 'VA_NAVIGATE_AND_CREATE',
            payload: { kind: 'model', brandName: createBrandName, brandConfirmed: true, seriesName: row.seriesName, modelName: row.modelName, vehicleType: row.vehicleType || '', skipReturnToAddPage: true },
            timeout: 180000,
          });
          await ensureSnapshot(snapshot, '直达创建车型后');
          (r2?.result?.steps || []).forEach((s, i) => logLine(`  ·M${i + 1}: ${s}`, 'info', false));
          const ok2 = r2?.ok && r2.result?.ok;
          const canc2 = r2?.result?.cancelled || r2?.result?.via === 'modalClosedWithoutSubmit';
          if (canc2) {
            logLine(`[砍屎山] ⏸ 创建车型被你取消。流水线不暂停（防止卡死），回 waitingManualSubmit 请人工补建后点【重填当前行】。`, 'warn');
            // 车型创建场景：skipReturn 恒=true（needBack=true 统一由 sidepanel 回车源+重填），所以绝不切回、绝不挂 watcher
            logLine(`[砍屎山] ✅ 车型取消（skipReturn恒=true）：保持当前页面不动，**不调用startSubmitWatchForRow，watcherBoundOnAddPage保持false**。`, 'info');
            state = await VehicleStore.setBatch({
              phase: 'waitingManualSubmit', running: true, paused: false,
              waitingRowId: snapshot.waitingRowId, waitingRowNumber: snapshot.waitingRowNumber,
              currentIndex: snapshot.index, taskLockId: state.batch?.taskLockId || '',
              watcherBoundOnAddPage: false,
              lastMessage: `第${snapshot.rowNumber}行车型创建被取消，请人工补建后点【重填当前行】`,
            });
            renderAll();
            // ★ 不调 startSubmitWatchForRow！车型创建完还没回车源页，watchBound 必须 = false
            logLine(`[Watcher闸] ✅ 车型场景skipReturn恒=true → 未调用 startSubmitWatchForRow，watchBound 保持 false（必须重填当前行回车源页时才重新挂 watcher）。`, 'warn');
            return;
          }
          if (!ok2) {
            logLine(`[砍屎山] ❌ 创建车型失败：${r2?.result?.message || r2?.error || '未知'}。流水线不暂停，回 waitingManualSubmit。`, 'error');
            // 车型创建失败：skipReturn 恒=true，同样保持当前页、不挂 watcher
            logLine(`[砍屎山] ✅ 车型失败（skipReturn恒=true）：保持当前页面不动，**不调用startSubmitWatchForRow，watcherBoundOnAddPage保持false**。`, 'info');
            state = await VehicleStore.setBatch({
              phase: 'waitingManualSubmit', running: true, paused: false,
              waitingRowId: snapshot.waitingRowId, waitingRowNumber: snapshot.waitingRowNumber,
              currentIndex: snapshot.index, taskLockId: state.batch?.taskLockId || '',
              watcherBoundOnAddPage: false,
              lastMessage: `第${snapshot.rowNumber}行车型创建失败，请人工解决后点【重填当前行】`,
            });
            renderAll();
            logLine(`[Watcher闸] ✅ 车型场景skipReturn恒=true → 未调用 startSubmitWatchForRow，watchBound 保持 false（必须重填当前行回车源页时才重新挂 watcher）。`, 'warn');
            return;
          }
          logLine(`[砍屎山] ✅ 创建车型成功：${r2.result.message}`, 'ok');
          needBack = true;
        } else if (mMiss && (!row.brandName || !row.seriesName || !row.modelName)) {
          logLine(`[砍屎山] ⚠️ 车型未命中但测试表缺少品牌/车系/车型字段值，无法自动创建，停 waitingManualSubmit 请人工处理。`, 'warn');
        }
      } catch (e) {
        logLine(`[砍屎山] ❌ 直达创建脚本异常：${e?.message || String(e)}，流水线不暂停，回 waitingManualSubmit。`, 'error');
        await ensureSnapshot(snapshot, '直达创建异常后');
      }

      if (needBack) {
        // ---- 3) 创建成功后，原子切到 车源管理→审核列表→+新增库存车 → 完整重填当前行 ----
        //   用户原话：「车型车系创建完成,怎么还是不模拟点击车源管理然后进入审核列表,然后点击新增库存车重新创建刚才的行?」
        //   直接调 content-admin 的 forceGotoVehicleAddPage（2 轮 × 7 步硬保），100% 切到空白新增页，
        //   不再走 openAddPageCore + ensure 拆分（之前拆分只点文本没点父项展开容器，手风琴模式下切父项漏点，就停在车系管理页面不动）。
        logLine(`[砍屎山] 🔁 车系/车型已补建，强制切到【车源管理→审核列表】并点+新增库存车，重填第${row.rowNumber}行（全字段重填）。`, 'ok');
        await stopSubmitWatchQuietly();
        state = await VehicleStore.setBatch({
          phase: 'opening', running: true, paused: false, taskLockId: state.batch?.taskLockId || '',
          lastMessage: `第${row.rowNumber}行车系/车型已补建，重新打开新增页并重填`,
        });
        renderAll();
        // 【原子切回车源新增页】content-admin 内部 2 轮强制重试：
        //   轮内顺序: tabs切审核列表→点车源管理父项x3(防手风琴漏展开)→等审核列表叶子出现→点叶子→looksLikeAuditList=true→点+新增库存车→等 looksLikeAddForm=true
        //   2 轮失败终极兜底: navigateInsideApp + history.replaceState + openAddForm
        try {
          const fg = await sendToActiveTab({ type: 'VA_FORCE_GOTO_VEHICLE_ADD_PAGE', timeout: 45000 });
          const r = fg?.result || {};
          const logs = Array.isArray(r.logs) ? r.logs : [];
          logLine(`[原子切回车源新增] action="${r.finalAction || '-'}" auditList=${!!r.finallyLooksLikeAuditList} addForm=${!!r.finallyLooksLikeAddForm} ok=${!!r.ok} href=${r.href || '-'} msg="${r.message || ''}"`,
            r.ok ? 'ok' : 'warn');
          if (logs.length > 0) {
            // 把详细链路日志（每一步/tabs/左侧菜单/SPA兜底/click-add 细节）都打出来方便你定位到底哪一步没点进去
            logs.slice(0, 40).forEach(l => logLine(`    [forceGoto] ${l}`, 'info'));
          }
          if (!r.ok) {
            logLine(`[原子切回车源新增] ⚠️ 原子操作返回 ok=false → 再走旧兜底链路（openAddPageCore + VA_ENSURE_ON_ADD_FORM），确保不会卡住`, 'warn');
            try { await openAddPageCore(); } catch (_) {}
            await waitForPageReady();
            await waitForContentReady();
            await sleep(400);
            try {
              const en = await sendToActiveTab({ type: 'VA_ENSURE_ON_ADD_FORM', timeout: 15000 });
              const er = en?.result || {};
              logLine(`[旧兜底] finalLooksLike=${!!er.finalLooksLike} action="${er.action || '-'}" href=${er.href || '-'} msg="${er.message || ''}"`, er.finalLooksLike ? 'ok' : 'error');
            } catch (e2) { logLine(`[旧兜底] VA_ENSURE_ON_ADD_FORM 异常：${e2?.message || String(e2)}`, 'warn'); }
          } else {
            // looksLikeAddForm=true 已经命中，再给 DOM 稳定落地 400ms
            await sleep(400);
          }
        } catch (gotoErr) {
          logLine(`[原子切回车源新增] ❌ 消息异常：${gotoErr?.message || String(gotoErr)}，回退旧兜底链路`, 'error');
          try { await openAddPageCore(); } catch (_) {}
          await waitForPageReady();
          await waitForContentReady();
          await sleep(450);
        }
        await waitForPageReady();
        await waitForContentReady();
        // 全字段重填（跳过创建探测了——车系/车型已经补建好）
        finalReport = await fillCurrentRowCore({ fields: null, excludeFields: null, skipCreation: true, skipPersistStatus: false });
        // ★ didCreationJustHappened 的 batch 级别硬门槛：创建+回车源重填全部顺利完成的这一刻，写时间戳。
        // 后续 Stage1 若因为页面重载/回跳再跑一次，didCreationJustHappened 能在 90 秒内正确返回 true，
        // 避免重复进直达创建；而正常新行首次 Stage1，lastCreationFinishedAt=0 → 永远 false，不会挡创建分支。
        state = await VehicleStore.setBatch({ lastCreationFinishedAt: Date.now() });
        logLine(`[砍屎山] 第${row.rowNumber}行重填完毕：自动${finalReport.hit}，人工${finalReport.manual || 0}，未命中${finalReport.miss}，失败${finalReport.fail}（batch.lastCreationFinishedAt 已写入，用于防重复创建误判）`, finalReport.miss || finalReport.fail ? 'warn' : 'ok');
        // 下面统一走 finalReport 判定 → waitingManualSubmit → submitWatch
      } else {
        // 没走创建（比如取消了/缺字段值），就保持 probeReport 作为 finalReport，下面走 waitingManualSubmit
        finalReport = probeReport;
      }
    }
    // （车系/车型都命中的情况）：其他探测字段（车辆类型/品牌）就算 miss，也只是不阻断 Stage2/3，按原流程走
    else if (anyProbeMissing && !creationJustHappened) {
      const missText = PROBE_FIELDS
        .filter(f => probeStatusMap[f] === 'miss' || probeStatusMap[f] === 'fail')
        .map(f => {
          const label = { vehicleType: '车辆类型', brandName: '品牌', seriesName: '车系', modelName: '车型' }[f] || f;
          return `${label}(${probeStatusMap[f]})`;
        })
        .join(', ');
      logLine(
        `[阻断 Stage 2/3] ⛔ 第${row.rowNumber}行探测阶段仍未命中：${missText}（注意：车系/车型已经命中）。` +
        `按你要求：**不填其他字段**，直接 waitingManualSubmit，请人工处理缺失项后提交或点【重填当前行】。`,
        'warn'
      );
      state = await VehicleStore.setBatch({
        phase: 'waitingManualSubmit', running: true, paused: false,
        waitingRowId: row.id, waitingRowNumber: row.rowNumber,
        taskLockId: state.batch?.taskLockId || '',
        lastMessage: `第 ${row.rowNumber} 行：${missText} 缺失，按要求终止后续字段填充，请人工处理后提交`,
      });
      renderAll();
      await startSubmitWatchForRow(row);
      return;
    }

    if (!creationJustHappened) {
      // Stage 2/3: 填除 PROBE_FIELDS（车辆类型+规格参数3项，共4项）外的所有字段：
      //           带挂、底价、手机号、VIN、颜色、里程、上牌日期、车籍所在地、停放地区...
      logLine(`[流程优化] Stage 2/3：车辆类型/品牌/车系/车型均已命中，填充其余字段（带挂、底价、手机号、VIN、颜色、里程、上牌日期等，这4项暂不操作）`, 'info');
      state = await VehicleStore.setBatch({ phase: 'filling', lastMessage: `正在完整填充第 ${row.rowNumber} 行` });
      renderAll();
      finalReport = await fillCurrentRowCore({
        fields: null,                // 不做白名单
        excludeFields: PROBE_FIELDS, // 先排除 PROBE（车辆类型+规格参数3项），避免 Vue/React 重渲染期间被误改
        skipCreation: true,          // 创建探测已在 Stage 1 做过，不再重复
        skipPersistStatus: true,     // 这次先不写回，等 Stage 3 回填 PROBE 后再一起写
      });

      // Stage 3/3: 最后再把 PROBE 4 项重新"回填"一次（按 vehicleType→品牌→车系→车型的严格顺序）。
      //          解决 cascader/monthpicker 等组件触发 Vue/React 重渲染导致
      //          原来已经填好的车辆类型/联动下拉被还原成"请选择"的问题。
      //          等 Stage 2 所有其他字段填写完毕后再最后一次设 PROBE_FIELDS，
      //          此时后续没有任何操作会再触发表单重渲染，值能稳定保留。
      logLine(`[流程优化] Stage 3/3：最后锁定 车辆类型→品牌→车系→车型（回填锁，防止其他字段填写过程中被Vue/React重渲染清空）`, 'info');
      state = await VehicleStore.setBatch({ phase: 'filling', lastMessage: `第 ${row.rowNumber} 行：最后锁定 车辆类型/品牌/车系/车型` });
      renderAll();
      const reLockReport = await fillCurrentRowCore({
        fields: PROBE_FIELDS,       // 严格按 vehicleType→brand→series→model 顺序
        excludeFields: null,
        skipCreation: true,         // 创建探测已经过了
        skipPersistStatus: false,   // ！这次正式把 fillReport 写回行状态
      });

      // 合并 Stage 2 + Stage 3 报告：以 Stage 3 的 PROBE 状态覆盖 Stage 2 里的 PROBE
      // （Stage 2 的 PROBE 本来就没填，excludeFields 排除了，所以 report 里只有其他字段；
      //  Stage 3 只有 PROBE 4 条，直接拼接即可）
      const s2 = finalReport.report || [];
      const s3 = reLockReport.report || [];
      const merged = [...s2];
      for (const r of s3) {
        const idx = merged.findIndex(x => x.field === r.field);
        if (idx >= 0) merged[idx] = r; else merged.push(r);
      }
      const calcReport = (arr) => ({
        hit:    arr.filter(x => x.status === 'hit').length,
        miss:   arr.filter(x => x.status === 'miss').length,
        fail:   arr.filter(x => x.status === 'fail').length,
        manual: arr.filter(x => x.status === 'manual').length,
      });
      const stats = calcReport(merged);
      finalReport = {
        ...(reLockReport || {}),
        report: merged,
        hit: stats.hit,
        miss: stats.miss,
        fail: stats.fail,
        manual: stats.manual,
        total: merged.length,
      };
    } else {
      // 刚刚已经做了创建+完整重填（含所有字段，包括车辆类型），把重填后的 report 写回行状态
      logLine(`[流程优化] Stage 1 中已发生车系/车型创建并完整重填，跳过 Stage 2/3`, 'ok');
      const rows = [...state.rows];
      rows[state.currentIndex] = {
        ...rows[state.currentIndex],
        status: finalReport.fail || finalReport.miss ? 'waiting-manual-partial' : 'waiting-manual',
        fillReport: finalReport,
        lastFilledAt: new Date().toLocaleString(),
      };
      state = await VehicleStore.save({ rows });
      logLine(`第 ${row.rowNumber} 行创建后重填完成：自动 ${finalReport.hit}，人工 ${finalReport.manual || 0}，未命中 ${finalReport.miss}，失败 ${finalReport.fail}`, finalReport.miss || finalReport.fail ? 'warn' : 'ok');
      renderAll();
    }

    if (finalReport.fail || finalReport.miss) {
      state = await VehicleStore.setBatch({
        phase: 'waitingManualSubmit',
        waitingRowId: row.id,
        waitingRowNumber: row.rowNumber,
        taskLockId: state.batch?.taskLockId || '',
        lastMessage: `第 ${row.rowNumber} 行部分字段未自动完成，请人工处理后提交`,
      });
    } else {
      state = await VehicleStore.setBatch({
        phase: 'waitingManualSubmit',
        waitingRowId: row.id,
        waitingRowNumber: row.rowNumber,
        taskLockId: state.batch?.taskLockId || '',
        lastMessage: `第 ${row.rowNumber} 行基础信息已填完，等待人工上传图片、填写价格并提交`,
      });
    }
    await startSubmitWatchForRow(row);
    renderAll();
  }

  /**
   * 判断上一次 fillCurrentRowCore 是否刚刚发生过创建→重填动作（needRefill）
   * 依据：如果报告里的字段数/命中数明显大于 PROBE_FIELDS 数量，或者报告里出现
   *       非PROBE字段的命中记录，就说明已经在里面完整填过了
   */
  /**
   * 【用户硬规则·强约束】didCreationJustHappened 只能在"车系/车型刚刚走完 creating 阶段 → 回到车源新增页 full refill 完"那一次才返回 true，
   *  其他任何场景（包括第一次进 Stage 1 探测）都必须返回 false，否则会把【砍屎山·直达创建】分支整条挡掉 → 车系/车型红框空着就直接进 waitingManualSubmit 卡住。
   *  所以这里加两道 Batch 级别硬门槛：
   *    (1) 必须 batch.lastCreationFinishedAt 有值，且距现在 < 90 秒（1.5 分钟内刚走完创建流程才可能算"刚刚"）
   *    (2) 原 report 判定（非 PROBE 字段 hit≥2）也得满足（重填确实填了其他字段如手机号/VIN/底价 等）
   *  两道都满足才 true，任一不满足一律 false。
   */
  function didCreationJustHappened(probeReport, batch) {
    // 门槛 1：batch 里有刚走完创建的时间戳 + 90 秒内
    const b = batch || state?.batch || {};
    const finishedAt = Number(b.lastCreationFinishedAt || 0);
    if (!finishedAt) return false;
    if (Date.now() - finishedAt > 90 * 1000) return false;
    // 门槛 2：原 report 结构必须正常，且非 PROBE 字段命中 ≥ 2（证明确实是 full refill 刚填完的那一份）
    if (!probeReport || !Array.isArray(probeReport.report)) return false;
    const probeSet = new Set(PROBE_FIELDS);
    let nonProbeHitCount = 0;
    probeReport.report.forEach(r => {
      if (r.status === 'hit' && !probeSet.has(r.field)) nonProbeHitCount++;
    });
    const coveredFields = new Set(probeReport.report.map(r => r.field).filter(Boolean));
    return nonProbeHitCount >= 2 || (coveredFields.size > PROBE_FIELDS.length + 2);
  }

  async function openAddPageCore() {
    const targetUrl = getAddPageUrl();
    logLine('openAddPageCore：只走录制点击链路，不再硬跳 URL，避免 Chrome 安全连接拦截', 'info');

    let result = null;
    try {
      result = await sendToActiveTab({ type: 'VA_OPEN_ADD_FORM' });
    } catch (recordedError) {
      throw new Error(`录制点击链路失败：${recordedError.message || recordedError}`);
    }

    if (!result?.ok) {
      throw new Error(`录制点击链路返回异常：${result?.error || '无结果'}`);
    }

    const opened = result.result || {};
    logLine(
      `录制点击链路完成：status=${opened.status || '-'} href=${opened.href || '-'} message=${opened.message || '-'}`,
      opened.status === 'not-found' ? 'warn' : 'ok'
    );

    if (opened.status === 'not-found') {
      throw new Error(opened.message || '未找到“新增库存车”按钮，请先保持后台在可见页面并展开车源管理');
    }

    state = await VehicleStore.setBatch({ lastAddPageUrl: opened.href || targetUrl });
    return { status: 'navigated', href: opened.href || targetUrl, via: 'recorded-flow', ...opened };
  }

  async function openAddPageDirect(targetUrl) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('当前窗口没有活动业务页 tab');
    if (String(tab.url || '').startsWith('chrome://') || String(tab.url || '').startsWith('chrome-extension://')) {
      throw new Error('当前活动页不是业务页面');
    }

    await chrome.tabs.update(tab.id, { url: targetUrl, active: true });
    const finalUrl = await waitTabUrlHit(tab.id, targetUrl, 12000);
    return { tabId: tab.id, finalUrl, hit: isTargetUrl(finalUrl, targetUrl) };
  }

  async function openAddPageByBackground(targetUrl) {
    const resp = await new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        reject(new Error('background 跳转 15 秒无响应'));
      }, 15000);
      try {
        chrome.runtime.sendMessage({ type: 'VA_OPEN_ADD_PAGE', targetUrl }, (response) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message || '跳转消息发送失败'));
          resolve(response);
        });
      } catch (e) {
        if (!done) {
          done = true;
          clearTimeout(timer);
          reject(e);
        }
      }
    });
    if (!resp?.ok) throw new Error(resp?.error || '跳转失败');
    return resp.result || {};
  }

  async function refillCurrentRow() {
    if (!state.rows.length) return warn('请先导入数据');
    await runBusy('重填当前行...', async () => {
      // ======================================================================
      // ★ 用户点"重填当前行" = 明确表示要处理当前行。
      //   (1) 强行重置 lastCreationFinishedAt=0，消除 creationJustHappened 挡路
      //   (2) ★★★ 之前的致命 Bug：refillCurrentRow 自己手写了 openAddPageCore + fillCurrentRowCore，
      //       完全绕过了 fillCurrentWithNavigation 里的 Stage1 PROBE → 直达创建 → UI 兜底探测
      //       → 一票否决权 → 终极 0 门槛拦截 所有创建逻辑！
      //       用户重填当前行后车系/车型还是红框"请选择"空着，结果直接就进 waitingManualSubmit 不动了！
      //   ★ 修复：重填当前行最后统一走 fillCurrentWithNavigation()，所有创建判定全部再跑一遍。
      // ======================================================================
      // 【主任务硬锁】：重填当前行 = 重新开启一次大任务，重新生成 taskLockId，并把旧的锁废掉
      const newLockId = genTaskLockId();
      const rows = [...state.rows];
      const idx = state.currentIndex;
      if (rows[idx]) {
        rows[idx] = {
          ...rows[idx],
          taskLockId: newLockId,
          submittedAt: rows[idx].status === 'submitted' ? '' : (rows[idx].submittedAt || ''),
          status: 'waiting-manual-partial',
          // ★★★ 重置品牌确认标记：用户主动点"重填当前行"= 重新第一次进入车源新增页，
          //     必须让用户手动选品牌。只有创建车系/车型后的 needBack 重填才自动沿用（那里不重置）。
          brandConfirmed: false,
        };
      }
      state = await VehicleStore.save({
        rows,
        batch: { ...(state.batch || {}), taskLockId: newLockId, phase: 'opening', lastCreationFinishedAt: 0 },  // ★ 重填时强制清零时间戳
      });
      logLine(`[重填当前行] ★ 新主任务锁=${newLockId.slice(-6)}，已强制 lastCreationFinishedAt=0（creationJustHappened 90s 窗口过期机制让路），现在走 fillCurrentWithNavigation() 跑完整的 Stage1 + 创建探测链路。`, 'warn');
      state = await VehicleStore.setBatch({
        phase: 'filling',
        running: true,
        paused: false,
        lastMessage: '正在重填当前行（走完整的 Stage1 探测+创建判定链路，新主任务锁=' + newLockId.slice(-6) + '）'
      });
      renderAll();
      // ★ 不再自己调 openAddPageCore + fillCurrentRowCore。fillCurrentWithNavigation() 开头会强制解卡 paused，并走完整 Stage1 链路。
      await fillCurrentWithNavigation();
    });
  }

  /**
   * 预填探测 + 回填锁用的 fields 白名单（严格按用户要求：先填车辆类型 → 再填规格参数的3项）。
   * 必须先选车辆类型，后台才会把规格参数（品牌/车系/车型）下拉的联动数据加载出来；
   * 如果先填品牌，后台 vehicleType 为空时品牌下拉可能没数据或与车系不匹配，导致填不上或误跳创建。
   * 顺序严格不可变：vehicleType → brandName → seriesName → modelName。
   */
  const PROBE_FIELDS = ['vehicleType', 'brandName', 'seriesName', 'modelName'];
  /** PROBE_FIELDS 里规格参数相关的 3 项（车系/车型创建探测/排除规则按这 3 项算） */
  const PROBE_SPEC_FIELDS = ['brandName', 'seriesName', 'modelName'];
  /** PROBE_FIELDS 里预填车辆类型的 1 项（填完后作为联动前置，不走"缺失则创建"规则） */
  const PROBE_PRE_FIELDS = ['vehicleType'];

  /**
   * 填充当前行（支持白名单 / 黑名单模式）
   * @param {object} [opts]
   * @param {string[]} [opts.fields] 白名单：只填这些字段（完整填则不传）
   * @param {string[]} [opts.excludeFields] 黑名单：跳过这些字段（用于Stage 2不重填已探测过的品牌/车系/车型）
   * @param {boolean} [opts.skipCreation] 跳过车系/车型创建探测（Stage2用，探测已经在Stage1跑过）
   * @param {boolean} [opts.skipPersistStatus] 不把 fillReport/status 写回 row（Stage1不写回，避免污染正式报告）
   */
  async function fillCurrentRowCore(opts) {
    const fields = Array.isArray(opts?.fields) && opts.fields.length ? opts.fields : null;
    const excludeFields = Array.isArray(opts?.excludeFields) && opts.excludeFields.length ? opts.excludeFields : null;
    const skipCreation = !!opts?.skipCreation;
    const skipPersistStatus = !!opts?.skipPersistStatus;

    const row = state.rows[state.currentIndex];
    if (!row) throw new Error('当前行不存在');
    const payload = VehicleMapper.toFillPayload(row);
    const fillOpts = {};
    if (fields) fillOpts.fields = fields;
    if (excludeFields) fillOpts.excludeFields = excludeFields;
    // ★★【品牌一致性锁】：后续填充/重填只允许沿用车源新增页人工实际确认的品牌，不再回退用导入表推断品牌。
    const confirmedBrandName = confirmedBrandForRow(row);
    if (confirmedBrandName) {
      payload.brandName = confirmedBrandName;
      fillOpts.confirmedBrandName = confirmedBrandName;
    }
    const resp = await sendToActiveTab({
      type: 'VA_FILL_ROW',
      row: payload,
      options: fillOpts,
    });
    if (!resp?.ok) throw new Error(resp?.error || '填表失败');
    let report = resp.report;

    // ★★【品牌确认回写】：content-admin 返回了用户手动选/自动复用的品牌名 → 写回当前行，
    //    后续创建车系/车型、重填当前行时全部自动沿用（用户在车源新增页选一次品牌就够了，其余流程不再人工操作）
    //    ★ 注意：selectedBrand 在 resp.report 里（content-admin 的 VA_FILL_ROW 响应结构是 { ok, report }）
    const selectedBrandFromReport = report && report.selectedBrand ? String(report.selectedBrand).trim() : '';
    if (selectedBrandFromReport) {
      const sb = selectedBrandFromReport;
      if (sb !== row.brandName) {
        const rows = [...state.rows];
        rows[state.currentIndex] = {
          ...rows[state.currentIndex],
          brandName: sb,
          confirmedBrandName: sb,
          brandConfirmed: true,
        };
        state = await VehicleStore.save({ rows });
        logLine(`[品牌一致性锁] 用户已确认品牌「${sb}」，写回当前行 confirmedBrandName → 创建车系/车型及重填只能沿用该品牌`, 'ok');
        row.brandName = sb;
        row.confirmedBrandName = sb;
        row.brandConfirmed = true;
      } else if (sb === row.brandName) {
        // 品牌名一致也标记已确认，确保创建车系/车型时走自动填
        if (!row.brandConfirmed || row.confirmedBrandName !== sb) {
          const rows = [...state.rows];
          rows[state.currentIndex] = { ...rows[state.currentIndex], confirmedBrandName: sb, brandConfirmed: true };
          state = await VehicleStore.save({ rows });
          row.confirmedBrandName = sb;
          row.brandConfirmed = true;
        }
      }
    }

    let needRefillAfterCreation = false;
    if (!skipCreation) {
      // 检测车系/车型缺失并自动创建
      const creationResult = await tryCreateMissingSeriesOrModel(row, report);
      needRefillAfterCreation = !!creationResult.needRefill;
    }

    if (needRefillAfterCreation) {
      // 创建完成后重填当前行（新的空白新增页，所以所有字段都要填，不含 excludeFields）
      logLine('车系/车型已补建，重新完整填充当前行（跳过重填中的二次创建检测）...', 'info');
      await openAddPageCore();
      await waitForPageReady();
      await waitForContentReady();
      const refilled = await fillCurrentRowCore({
        fields: null,            // 全填（新页面，PROBE_FIELDS也要重新填一遍）
        excludeFields: null,
        skipCreation: true,      // 不重复走创建探测
        skipPersistStatus,       // 是否写回状态与外层一致
      });
      report = refilled;
    }

    if (!skipPersistStatus) {
      const rows = [...state.rows];
      rows[state.currentIndex] = {
        ...rows[state.currentIndex],
        status: report.fail || report.miss ? 'waiting-manual-partial' : 'waiting-manual',
        fillReport: report,
        lastFilledAt: new Date().toLocaleString(),
      };
      state = await VehicleStore.save({ rows });
      const scope = fields ? `（只填字段：${fields.join('/')}）` : '';
      logLine(`第 ${row.rowNumber} 行填充完成${scope}：自动 ${report.hit}，人工 ${report.manual || 0}，未命中 ${report.miss}，失败 ${report.fail}`, report.miss || report.fail ? 'warn' : 'ok');
      renderAll();
    } else {
      const scope = fields ? `（只填字段：${fields.join('/')}）` : '';
      logLine(`第 ${row.rowNumber} 行探测填充${scope}：命中 ${report.hit}，未命中 ${report.miss}，失败 ${report.fail}（不写回状态）`, 'info');
    }
    return report;
  }

  /**
   * 切到「创建中」阶段并做好隔离：
   * - 清除 tabFallbackTimer（防止 URL 兜底误把当前行当完成）
   * - 停掉已启动的 submit watch（避免content-admin那边误匹配提交结果）
   * - 把 phase 设为 creating（onTabUpdated / handleSubmitSuccess 只处理 waitingManualSubmit，所以会自动被屏蔽）
   * - 记录当前 currentIndex / waitingRowId，创建过程中若遇到外部事件误改就还原
   */
  async function enterCreatingPhase(reason) {
    // 清除 tab 跳转兜底定时器（创建期间离开新增页是正常行为，不能算提交完成）
    if (tabFallbackTimer) { clearTimeout(tabFallbackTimer); tabFallbackTimer = null; }
    // 停掉提交监听（创建过程中完全不需要监听，避免重填过程中的临时弹窗误触发）
    await stopSubmitWatchQuietly();

    const snapshot = {
      currentIndex: state.currentIndex,
      waitingRowId: state.batch?.waitingRowId || '',
      waitingRowNumber: state.batch?.waitingRowNumber || '',
      rowId: state.rows?.[state.currentIndex]?.id || '',
      rowNumber: state.rows?.[state.currentIndex]?.rowNumber || '',
    };
    state = await VehicleStore.setBatch({
      phase: 'creating',
      waitingRowId: snapshot.waitingRowId,
      waitingRowNumber: snapshot.waitingRowNumber,
      lastMessage: reason || '正在创建缺失的车系/车型数据...',
      // ★ 用户硬规则：缺车系车型去创建时，"必须等下一次再进入车源新增页面后 WATCHER 重新挂上，人工点提交才算成功"
      // 这一步强制把 watcherBoundOnAddPage 打掉为 false —— 创建期间/创建完但还没回车源新增重填，watcher 没挂好，绝不允许任何消息推进
      watcherBoundOnAddPage: false,
    });
    renderAll();
    logLine(`[创建阶段隔离] 已进入 creating 阶段，快照：currentIndex=${snapshot.currentIndex} row=${snapshot.rowNumber}(${snapshot.rowId})，tabFallbackTimer已清，submit watch已停，watcherBoundOnAddPage=false（必须回车源新增重填后才能推进）`, 'info');
    return snapshot;
  }

  /**
   * 校验当前currentIndex / row 没被误改；如果变了就还原快照
   * 返回 true 表示正常，false 表示被外部事件污染过已做还原
   */
  async function ensureSnapshot(snapshot, stageTag) {
    if (!snapshot) return true;
    state = await VehicleStore.load();         // 强制 reload storage 最新值，绝对不信内存里的（很关键：创建期间 content-admin 的跳转 / storage 同步可能延迟，内存 state 会假）
    const cur = state.rows?.[state.currentIndex];
    const nowRowId = cur?.id || '';
    let bad = false;
    const reasons = [];
    if (state.currentIndex !== snapshot.currentIndex) {
      bad = true;
      reasons.push(`currentIndex 被异常推进: ${snapshot.currentIndex} -> ${state.currentIndex}`);
    }
    if (nowRowId !== snapshot.rowId) {
      bad = true;
      reasons.push(`当前行id变化: ${snapshot.rowId} -> ${nowRowId}`);
    }
    // 新增：snapshot 当时对应那一行的 status 如果被改成了任何终态（submitted/done/failed 等），直接回滚（不管 currentIndex 是不是对的）
    let rowManuallyRestored = false;
    let rows = [...state.rows];         // 直接操作这个数组，后面 save 就用它（避免复制两次导致已还原 status 丢失）
    let targetRowIdx = -1;
    if (snapshot.rowId) {
      targetRowIdx = rows.findIndex(r => r.id === snapshot.rowId);
      if (targetRowIdx >= 0) {
        const snapRow = rows[targetRowIdx];
        // 只要 status 不是"未完成态"（waiting-manual / waiting-manual-partial），就认为被异常污染成终态了
        const rowWasAbnormallyMarkedTerminal = !!(
          snapRow.status &&
          snapRow.status !== 'waiting-manual' &&
          snapRow.status !== 'waiting-manual-partial' &&
          snapRow.status !== '' &&
          snapRow.status !== null &&
          typeof snapRow.status !== 'undefined'
        );
        if (rowWasAbnormallyMarkedTerminal) {
          bad = true;
          reasons.push(`行${snapshot.rowNumber}(id=${snapshot.rowId}) status 被异常改成终态 "${snapRow.status}"，需要回滚`);
          rows[targetRowIdx] = {
            ...snapRow,
            status: 'waiting-manual-partial',
            submittedAt: '',
            _ensureSnapshotRestored: stageTag,     // 打标记便于调试
          };
          rowManuallyRestored = true;
          logLine(`[创建阶段隔离][${stageTag}] 回滚 status：第${rows[targetRowIdx].rowNumber}行从 "${snapRow.status}" 还原为 waiting-manual-partial（清除 submittedAt）`, 'error');
        }
      }
    }

    if (bad) {
      logLine(`[创建阶段隔离][${stageTag}] 检测到状态污染：${reasons.join('；')}，立即回滚快照，当前行不会被标记完成`, 'error');
      // 兜底：即便上面没 rowManuallyRestored 分支命中，也再扫一次 submitted 单独还原
      if (snapshot.rowId && !rowManuallyRestored && targetRowIdx >= 0 && rows[targetRowIdx].status === 'submitted') {
        rows[targetRowIdx] = { ...rows[targetRowIdx], status: 'waiting-manual-partial', submittedAt: '' };
        logLine(`[创建阶段隔离][${stageTag}] 回滚（兜底）：第${rows[targetRowIdx].rowNumber}行 status=submitted 改回 waiting-manual-partial`, 'error');
      }
      state = await VehicleStore.save({
        rows,
        currentIndex: snapshot.currentIndex,
        batch: {
          ...state.batch,
          phase: 'creating',
          waitingRowId: snapshot.waitingRowId,
          waitingRowNumber: snapshot.waitingRowNumber,
          completed: rows.filter(r => r.status === 'submitted').length,
          lastMessage: `检测到异常推进已回滚，请人工确认后再继续`,
        },
      });
      renderAll();
      return false;
    }
    return true;
  }

  /**
   * 检测 fillReport 中是否车系/车型缺失，如果缺失则走自动创建流程
   * 返回 { needRefill: boolean } 表示创建完成后是否需要重填当前行
   *
   * 【关键正确性保证】
   * - 创建开始前进入 `phase='creating'` 并清掉 tabFallbackTimer + submitWatch
   * - handleSubmitSuccess / onTabUpdated 只作用于 `waitingManualSubmit` 阶段，创建期间不会被误触发
   * - 任何情况下创建期间 currentIndex 不会被推进，行状态不会变成 submitted
   * - 创建成功后返回重填，仍由人工提交后才 completeCurrentAndAdvance
   */
  async function tryCreateMissingSeriesOrModel(row, report) {
    const out = { needRefill: false };
    if (!row || !report || !Array.isArray(report.report)) return out;

    // =========== 砍屎山：用户明确要求「车系车型填失败就直接去创建，别搞一堆前置废话」 ===========
    // 原逻辑：vehicleType miss/fail → 直接 return，连车系车型的创建都不触发，一直卡死。
    // 新逻辑：不管车辆类型、品牌填成啥，只要 row.seriesName / row.modelName 有值但填失败（miss/fail），
    //        立刻进入 creating 阶段跳去创建，绝不拖延。vehicleType/品牌缺失会在创建车系时
    //        自然报错/提醒用户，由用户在创建抽屉里处理。

    // 车辆类型填失败时留一条日志，但**绝不 return**（之前 return 就是卡死的根源）
    const vehicleItem = report.report.find(r => r.field === 'vehicleType');
    const vehicleMissOrFail = vehicleItem && (vehicleItem.status === 'miss' || vehicleItem.status === 'fail');
    if (vehicleMissOrFail) {
      logLine(
        `[砍屎山·忽略前置] ⚠️ 车辆类型没填成功（${vehicleItem.status || '-'}: ${vehicleItem.message || row.vehicleType || '无值'}），` +
        `但按你的要求：**车系/车型找不到就直接去创建**，不等车辆类型填完。创建抽屉里要选车辆类型时你自己选即可。`,
        'warn'
      );
    }

    // 找到品牌、车系、车型（PROBE_SPEC_FIELDS 规格参数 3 项）的填充结果
    const brandItem = report.report.find(r => r.field === 'brandName');
    const seriesItem = report.report.find(r => r.field === 'seriesName');
    const modelItem = report.report.find(r => r.field === 'modelName');

    const brandMiss = brandItem && (brandItem.status === 'miss' || brandItem.status === 'fail');
    const seriesMiss = seriesItem && (seriesItem.status === 'miss' || seriesItem.status === 'fail');
    const modelMiss = modelItem && (modelItem.status === 'miss' || modelItem.status === 'fail');

    logLine(
      `[砍屎山·直达创建] 车系=${row.seriesName || '-'}(${seriesMiss ? '未命中→去创建' : '命中'}) | ` +
      `车型=${row.modelName || '-'}(${modelMiss ? '未命中→去创建' : '命中'}) | ` +
      `品牌=${row.brandName || '-'}(${brandMiss ? '未命中' : '命中'}) | ` +
      `车辆类型=${row.vehicleType || '-'}(${vehicleMissOrFail ? '未命中' : '命中'})`,
      'info'
    );
    if (seriesItem && seriesMiss) logLine(`  · 车系失败详情：${seriesItem.message || seriesItem.status} → 不管别的，直接去创建`, 'info', false);
    if (modelItem && modelMiss) logLine(`  · 车型失败详情：${modelItem.message || modelItem.status} → 不管别的，直接去创建`, 'info', false);

    // 没有任何缺失，直接返回
    if (!seriesMiss && !modelMiss) return out;

    // 品牌不存在：只留一条 warn，仍然尝试去创建车系（创建车系时抽屉里有品牌下拉，用户在抽屉里可以重新选/看清楚问题）
    // ↓↓↓ 原逻辑：brandMiss → return；砍屎山后：**不 return，继续直达创建流程**
    if (brandMiss) {
      logLine(
        `[砍屎山·忽略前置] 品牌"${row.brandName || '-'}"在下拉中未找到，按你的要求仍然直接跳去创建车系/车型，` +
        `创建车系抽屉里有品牌下拉，你可在抽屉里重新选/填。绝不 return 卡死。`,
        'warn'
      );
    }

    const createBrandName = confirmedBrandForRow(row);
    if (!createBrandName) {
      logLine(
        `[品牌一致性锁] ⛔ 第${row.rowNumber}行需要创建车系/车型，但还没有人工确认品牌。` +
        `禁止使用导入表推断品牌「${row.brandName || '-'}」去创建，请在车源新增页选好品牌后点【重填当前行】。`,
        'error'
      );
      return out;
    }

    // === 创建前隔离（最重要：防止URL变化/监听误触发完成） ===
    const snapshot = await enterCreatingPhase(`车源第${row.rowNumber}行车系/车型缺失，直达创建流程...`);

    // 车系不存在：自动创建
    let seriesCreated = false;
    if (seriesMiss && createBrandName && row.seriesName) {
      // ★ 决定本次车系创建完是否马上回新增页：
      //   如果后面还有"车型也要创建"(modelMiss 且 row.modelName 非空) → 传 skipReturnToAddPage=true，
      //   创建完车系直接留在"车系管理"列表页，下一步创建车型时只需点一下左侧"车型管理"叶子菜单，
      //   不再绕一个大弯（车系→审核列表→新增库存车→再重新跳车型管理→车型），用户也不会被"切走又切回来"干扰。
      //   否则：只创建车系（后面没车型要创建），创建完就返回新增页。
      const skipReturnBecauseModelNext = !!(modelMiss && row.modelName && createBrandName && row.seriesName);
      // 同步：车系创建完若后面还有车型，要切到车型管理列表页（switchToModelAfterSeriesCreated=true）
      const switchToModelNext = !!skipReturnBecauseModelNext;
      logLine(`[创建车系] 开始 → 品牌="${createBrandName}"（人工确认锁定），车系="${row.seriesName}"，车辆类型="${row.vehicleType || '-'}") | skipReturn=${skipReturnBecauseModelNext ? '✅ 是（后面还有车型创建）' : '否（后面没车型，本步创建完直接回新增页）'} | switchToModel=${switchToModelNext ? '✅ 是（车系创建完切到车型管理列表，不再停留车系列表）' : '否'}`, 'warn');
      const t0 = Date.now();
      try {
        const resp = await sendToActiveTab({
          type: 'VA_NAVIGATE_AND_CREATE',
          payload: {
            kind: 'series',
            brandName: createBrandName,
            brandConfirmed: true,
            seriesName: row.seriesName,
            vehicleType: row.vehicleType || '',
            skipReturnToAddPage: skipReturnBecauseModelNext,   // ← 车系创建完先不回，等车型
            switchToModelAfterSeriesCreated: switchToModelNext, // ← 新增：车系创建完切到车型管理列表页，下一轮直接点车型+新增
          },
          timeout: 180000,
        });
        await ensureSnapshot(snapshot, '车系创建后');
        logLine(`[创建车系] content-admin返回耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s，resp.ok=${!!resp?.ok}，result.ok=${!!resp?.result?.ok}`, 'info');
        (resp?.result?.steps || []).forEach((s, i) => logLine(`  ·S${i + 1}: ${s}`, 'info', false));
        if (!resp?.ok || !resp.result?.ok) {
          const errMsg = resp?.result?.message || resp?.error || '未知错误';
          const cancelled = !!resp?.result?.cancelled;
          const via = resp?.result?.via || '';
          if (cancelled || via === 'modalClosedWithoutSubmit') {
            // ↓↓↓ 修复：取消创建不设置 paused=true！否则下一步/重填/手动操作都会被「if (batch.paused) return」卡死。
            //     用户明确说"卡在这里不走"，所以取消后直接回到 waitingManualSubmit，
            //     running=true+paused=false 保持批量流水线不被停掉，并明确提示用户怎么继续。
            logLine(`[创建车系] ⏸ 已取消：${errMsg}。当前行${snapshot.rowNumber}保持未推进，流水线不暂停（避免卡死），请人工处理车系后点【重填当前行】或手动提交后点【已提交下一步】。`, 'warn');
            // ★ 修复（对齐砍屎山流程策略）：skipReturnBecauseModelNext=true 时取消绝不主动切回新增页！
            //   保持在车型库管理当前页面不动（车系管理列表 or 车型管理列表），
            //   侧边栏有"重填当前行"按钮，用户一点就会重新走创建导航流程，100% 正确。
            if (skipReturnBecauseModelNext) {
              logLine(`[创建车系] ✅ skipReturn=true+取消：保持当前页面不动（不切回审核列表+新增），避免"应该跳创建又跳回来了"。请点侧边栏【重填当前行】重试。`, 'info');
            } else {
              try { await openAddPageCore(); } catch (_e) { logLine(`补跳回新增页失败：${_e?.message || String(_e)}`, 'warn'); }
            }
            state = await VehicleStore.setBatch({
              phase: 'waitingManualSubmit',
              running: true,            // 关键：保持运行
              paused: false,            // 关键：绝对不 paused=true，否则卡死下一步
              waitingRowId: snapshot.waitingRowId,
              waitingRowNumber: snapshot.waitingRowNumber,
              currentIndex: snapshot.index,
              lastMessage: `第${snapshot.rowNumber}行车系创建被你取消，请人工补建车系后点【重填当前行】或手动提交后点【已提交下一步】`,
            });
            renderAll();
            await startSubmitWatchForRow(row);
            return out;
          }
          // 其他失败：校验错误 / 后端报错 / 超时 → 也恢复 running=true+paused=false+waitingManualSubmit，绝不卡死
          logLine(`[创建车系] ❌ 失败：${errMsg}。当前行仍保持在第${snapshot.rowNumber}行，流水线不暂停（避免卡死），请人工处理后点【重填当前行】或手动提交。`, 'error');
          logLine(`失败完整详情：${JSON.stringify(resp?.result?.steps || [], null, 2)}`, 'error');
          // ★ 同上：skipReturnBecauseModelNext=true 时失败也不跳回新增页。
          if (skipReturnBecauseModelNext) {
            logLine(`[创建车系] ✅ skipReturn=true+失败：保持当前页面不动（不切回审核列表+新增），避免"应该跳创建又跳回来了"。请点侧边栏【重填当前行】重试。`, 'info');
          } else {
            try { await openAddPageCore(); } catch (_e) { logLine(`补跳回新增页失败：${_e?.message || String(_e)}`, 'warn'); }
          }
          state = await VehicleStore.setBatch({
            phase: 'waitingManualSubmit',
            running: true, paused: false,
            waitingRowId: snapshot.waitingRowId, waitingRowNumber: snapshot.waitingRowNumber,
            currentIndex: snapshot.index,
            lastMessage: `第${snapshot.rowNumber}行车系创建失败，请人工解决后点【重填当前行】`,
          });
          renderAll();
          await startSubmitWatchForRow(row);
        } else {
          seriesCreated = true;
          logLine(`[创建车系] ✅ 成功：${resp.result.message}（当前行${snapshot.rowNumber}仍未推进）`, 'ok');
        }
      } catch (e) {
        logLine(`[创建车系] ❌ 脚本异常：${e?.message || String(e)}。堆栈：${e?.stack || '无堆栈'}，当前行${snapshot.rowNumber}仍保持未完成`, 'error');
        await ensureSnapshot(snapshot, '车系创建异常后');
        // ★ 同上：skipReturnBecauseModelNext=true 时脚本异常也不跳回新增页。
        if (skipReturnBecauseModelNext) {
          logLine(`[创建车系] ✅ skipReturn=true+脚本异常：保持当前页面不动（不切回审核列表+新增），避免"应该跳创建又跳回来了"。请点侧边栏【重填当前行】重试。`, 'info');
        } else {
          try { await openAddPageCore(); } catch (_e) { logLine(`补跳回新增页失败：${_e?.message || String(_e)}`, 'warn'); }
        }
      }
    }

    // 车型不存在：自动创建（前提：车系存在或刚创建成功）
    let modelCreated = false;
    if (modelMiss && createBrandName && row.seriesName && row.modelName) {
      if (!seriesMiss || seriesCreated) {
        logLine(`[创建车型] 开始 → 品牌="${createBrandName}"（人工确认锁定），车系="${row.seriesName}"，车型="${row.modelName}"）`, 'warn');
        const t1 = Date.now();
        try {
          const resp = await sendToActiveTab({
            type: 'VA_NAVIGATE_AND_CREATE',
            payload: {
              kind: 'model',
              brandName: createBrandName,
              brandConfirmed: true,
              seriesName: row.seriesName,
              modelName: row.modelName,
              vehicleType: row.vehicleType || '',
            },
            timeout: 180000,
          });
          await ensureSnapshot(snapshot, '车型创建后');
          logLine(`[创建车型] content-admin返回耗时 ${((Date.now() - t1) / 1000).toFixed(1)}s，resp.ok=${!!resp?.ok}，result.ok=${!!resp?.result?.ok}`, 'info');
          (resp?.result?.steps || []).forEach((s, i) => logLine(`  ·M${i + 1}: ${s}`, 'info', false));
          if (!resp?.ok || !resp.result?.ok) {
            const errMsg = resp?.result?.message || resp?.error || '未知错误';
            const cancelled = !!resp?.result?.cancelled;
            const via = resp?.result?.via || '';
            if (cancelled || via === 'modalClosedWithoutSubmit') {
            // ↓↓↓ 同样修复：车型创建取消/关闭后不设 paused=true
            logLine(`[创建车型] ⏸ 已取消：${errMsg}。当前行${snapshot.rowNumber}保持未推进，流水线不暂停（避免卡死），请人工处理车型后点【重填当前行】或手动提交后点【已提交下一步】。`, 'warn');
            state = await VehicleStore.setBatch({
              phase: 'waitingManualSubmit',
              running: true, paused: false,
              waitingRowId: snapshot.waitingRowId, waitingRowNumber: snapshot.waitingRowNumber,
              currentIndex: snapshot.index,
              lastMessage: `第${snapshot.rowNumber}行车型创建被你取消，请人工补建车型后点【重填当前行】或手动提交后点【已提交下一步】`,
            });
            renderAll();
            return out;
          }
          logLine(`[创建车型] ❌ 失败：${errMsg}。当前行仍保持在第${snapshot.rowNumber}行，流水线不暂停（避免卡死），请人工处理后点【重填当前行】或手动提交。`, 'error');
          logLine(`失败完整详情：${JSON.stringify(resp?.result?.steps || [], null, 2)}`, 'error');
          state = await VehicleStore.setBatch({
            phase: 'waitingManualSubmit',
            running: true, paused: false,
            waitingRowId: snapshot.waitingRowId, waitingRowNumber: snapshot.waitingRowNumber,
            currentIndex: snapshot.index,
            lastMessage: `第${snapshot.rowNumber}行车型创建失败，请人工解决后点【重填当前行】`,
          });
          renderAll();
          } else {
            modelCreated = true;
            logLine(`[创建车型] ✅ 成功：${resp.result.message}（当前行${snapshot.rowNumber}仍未推进）`, 'ok');
          }
        } catch (e) {
          logLine(`[创建车型] ❌ 脚本异常：${e?.message || String(e)}。堆栈：${e?.stack || '无堆栈'}，当前行${snapshot.rowNumber}仍保持未完成`, 'error');
          await ensureSnapshot(snapshot, '车型创建异常后');
        }
      } else {
        logLine(`[创建车型] 跳过：车型"${row.modelName}"缺失，但车系"${row.seriesName}"也缺失且创建失败，无法创建车型。当前行${snapshot.rowNumber}仍保持未完成，请人工处理车系后再点重填。`, 'warn');
      }
    }

    // 最终校验一次：确保currentIndex/rowId没变
    const finalOk = await ensureSnapshot(snapshot, '创建流程结束');
    if (!finalOk) {
      // 被回滚过，不做重填，交给人工处理
      logLine(`[创建阶段隔离] 检测到状态被污染后已回滚，取消自动重填，请人工确认页面状态后点"重填当前行"`, 'error');
      // 回到 waitingManualSubmit 以便用户手动操作时监听有效（手动重填会再次走startSubmitWatch）
      state = await VehicleStore.setBatch({
        phase: 'waitingManualSubmit',
        waitingRowId: snapshot.waitingRowId,
        waitingRowNumber: snapshot.waitingRowNumber,
        lastMessage: `第${snapshot.rowNumber}行车系/车型创建异常，已回滚状态，请人工检查后重填当前行`,
      });
      renderAll();
      return out;
    }

    if (seriesCreated || modelCreated) {
      out.needRefill = true;
      logLine(`车系/车型补建完成[车系=${seriesCreated ? '已创建' : '无'} 车型=${modelCreated ? '已创建' : '无'}]，将重新打开新增页并重填当前行【注意：当前行仍为第${snapshot.rowNumber}行，未推进】`, 'ok');
    } else {
      // 没创建成功：明确停留在当前行，进入waitingManualSubmit状态，交给用户人工处理（如手动创建后点重填）
      logLine(`车系/车型未补建成功，当前行仍停留在第${snapshot.rowNumber}行，不会自动推进到下一行。请人工创建后点【重填当前行】或直接补完表单后提交。`, 'warn');
    }
    return out;
  }

  async function startSubmitWatchForRow(row) {
    const payload = VehicleMapper.toFillPayload(row);
    // ====== 【主任务锁 Step 2】：把当前大任务的 taskLockId 一起传进 content-admin 的 submitWatch ======
    // 这样将来 VA_SUBMIT_SUCCESS 消息会原样把它带回来，和 batch.taskLockId 比对后才推进。
    payload.taskLockId = state.batch?.taskLockId || '';
    const resp = await sendToActiveTab({ type: 'VA_START_SUBMIT_WATCH', row: payload });
    if (!resp?.ok) throw new Error(resp?.error || '提交成功监听启动失败');
    const watchHref = resp.result?.href || '';
    // ★ 用户硬规则：只有 startSubmitWatchForRow 被调用成功（已经回到车源新增页并且监听挂好了），这时候才允许 Watcher 消息触发推进。
    // 创建车系/车型期间 watcherBoundOnAddPage=false，即便有残留 submitWatcher 触发消息，也会被 handleSubmitSuccess + 最终闸 BLOCK。
    state = await VehicleStore.setBatch({
      lastAddPageUrl: watchHref,
      taskLockId: state.batch?.taskLockId || '',
      watcherBoundOnAddPage: true,
    });
    logLine(`已开始监听第 ${row.rowNumber} 行人工提交结果（主任务锁=${(payload.taskLockId || '').slice(-6) || '空'}，watcherBoundOnAddPage=true）` + (watchHref ? `（新增页：${watchHref}）` : ''), 'ok');
  }

  async function stopSubmitWatchQuietly() {
    try {
      await sendToActiveTab({ type: 'VA_STOP_SUBMIT_WATCH' });
    } catch (e) {}
  }

  async function handleSubmitSuccess(msg) {
    state = await VehicleStore.load();     // 强制 reload，避免内存 state 陈旧
    const batch = state.batch || {};
    const row = state.rows[state.currentIndex];
    const logTag = `[advance] row=${state.currentIndex + 1}/${state.rows.length} rowNumber=${row?.rowNumber || '-'} phase=${batch.phase} running=${batch.running} paused=${batch.paused} row.status=${row?.status || '-'} lockMsg=${msg?.taskLockId || '(空)'} lockBatch=${batch.taskLockId || '(空)'}`;
    // eslint-disable-next-line no-console
    console.log(logTag, 'handleSubmitSuccess received:', msg);

    if (!batch.running || batch.paused) {
      console.log(logTag, '→ skip: batch not running or paused');
      return;
    }
    if (batch.phase !== 'waitingManualSubmit') {
      console.log(logTag, `→ skip: phase ${batch.phase} !== waitingManualSubmit (创建期间或非等待提交阶段，忽略车源提交成功消息)`);
      return;
    }
    if (!row) {
      console.log(logTag, '→ skip: no current row at currentIndex');
      return;
    }
    // 【主任务硬锁 Step 3-A】：content-admin 带回来的 token 必须和 batch 上的完全一致
    // 没有 token / token 不相等 → 一定是残留 submitWatcher / 其他行 watcher / 创建期间误触发的，直接 BLOCK
    const msgLock = String(msg?.taskLockId || '');
    const batchLock = String(batch.taskLockId || '');
    if (!batchLock) {
      logLine(`[提交保护] handleSubmitSuccess 收到消息，但当前 batch.taskLockId 为空（未进入合法等待提交状态），拒绝推进`, 'warn');
      console.log(logTag, '→ skip: batch.taskLockId is empty (no active vehicle task)');
      return;
    }
    if (!msgLock || msgLock !== batchLock) {
      logLine(
        `[主任务硬锁] ❌ handleSubmitSuccess 收到的 token=「${msgLock || '空'}」与 batch 主任务锁=「${batchLock}」不匹配 → 拒绝推进。` +
        `这说明可能是残留/其他行 watcher 误触发，已被锁挡回。`,
        'error'
      );
      console.log(logTag, `→ BLOCKED: taskLockId mismatch (msgLock=${msgLock} batchLock=${batchLock})`);
      return;
    }
    // 【主任务硬锁 Step 3-B】：行本体的 token 也要对（防止 storage 里 currentIndex/row 被意外改写）
    const rowLock = String(row.taskLockId || '');
    if (rowLock !== batchLock) {
      logLine(`[主任务硬锁] ❌ 当前行 taskLockId=「${rowLock || '空'}」与 batch 主任务锁=「${batchLock}」不匹配 → 拒绝推进（currentIndex 可能被污染，建议人工核对）`, 'error');
      console.log(logTag, `→ BLOCKED: row.taskLockId mismatch (rowLock=${rowLock} batchLock=${batchLock})`);
      return;
    }
    // 额外：该行的 status 已经是 submitted / 任何终态 → 说明是重复消息，绝不推进
    if (row.status === 'submitted' || row.status === 'done') {
      logLine(`[提交保护] handleSubmitSuccess 收到提交成功消息，但第 ${row.rowNumber} 行 status 已经是 ${row.status}，重复消息保护触发，不推进`, 'warn');
      console.log(logTag, '→ skip: row.status is already terminal; duplicate submit event');
      return;
    }
    if (batch.waitingRowId && row.id !== batch.waitingRowId) {
      console.log(logTag, `→ skip: waitingRowId ${batch.waitingRowId} does not match current row.id ${row.id}`);
      return;
    }
    // ★ 用户硬规则（Watcher通道闸）：只有 watcherBoundOnAddPage===true（要么首次新增已挂watcher，要么缺车系车型创建完后"下一次进入车源新增页"时 startSubmitWatchForRow 已把它重新置true），
    // 才能让 Watcher 的 VA_SUBMIT_SUCCESS 通过。watcherBound=false 还收到消息 → 一定是创建期间残留watcher / 还没回车源新增页的误触发 → 全部挡掉。
    if (batch.watcherBoundOnAddPage !== true) {
      logLine(
        `[用户硬规则] ❌ handleSubmitSuccess：batch.watcherBoundOnAddPage=${JSON.stringify(batch.watcherBoundOnAddPage)} !== true，说明还没重新挂上车源新增页的submitWatcher，就收到了VA_SUBMIT_SUCCESS。` +
        `用户明确要求：缺车系车型时必须等创建完 → 下一次进入车源新增页重填 → startSubmitWatchForRow挂好watcher → 人工点提交Footer成功，才算数。该消息被BLOCK，绝不标记已提交。message="${msg?.message || ''}"。`,
        'error'
      );
      console.log(logTag, '→ BLOCKED: batch.watcherBoundOnAddPage !== true（Watcher通道闸）');
      return;
    }

    if (tabFallbackTimer) { clearTimeout(tabFallbackTimer); tabFallbackTimer = null; }
    // 把合法 token 作为来源标记往下传，completeCurrentAndAdvance 再核对一次（双保险）。加fromWatcher=true标识通道来源
    await completeCurrentAndAdvance(msg.message || '提交成功', { taskLockId: msgLock, fromWatcher: true });
  }

  /**
   * tabs.onActivated：同一 tab 内 SPA 路由切换（showPageModel=1 → 审核列表）有时不触发 onUpdated.status=complete，
   * 但会触发 tab 激活 / 页面加载的 DOM 变化。这里补充兜底：只要 phase=waitingManualSubmit 且当前活动页已经不是新增页，
   * 就按 URL 兜底逻辑推进下一行。
   */
  function onTabActivated(activeInfo) {
    if (!state || !state.batch) return;
    const batch = state.batch;
    if (batch.phase !== 'waitingManualSubmit') return;
    if (!batch.running || batch.paused) return;
    const watchUrl = batch.lastAddPageUrl;
    if (!watchUrl) return;

    const logTagBase = `[advance-onTabActivated] row=${state.currentIndex + 1}/${state.rows.length} rowNumber=${state.rows[state.currentIndex]?.rowNumber || '-'} phase=${batch.phase}`;
    console.log(logTagBase, 'activated tabId=', activeInfo?.tabId);

    // 取当前活动 tab 的 URL
    chrome.tabs.get(activeInfo.tabId).then(tab => {
      const currentUrl = tab?.url || '';
      const logTag = `${logTagBase} url=${currentUrl.slice(0, 100)}`;
      // 只在同源时考虑
      try {
        const watchOrigin = new URL(watchUrl, location.href).origin;
        const currentOrigin = new URL(currentUrl, location.href).origin;
        if (watchOrigin !== currentOrigin) {
          console.log(logTag, '→ skip: origin mismatch');
          return;
        }
      } catch (_) { return; }

      // 还在新增页（showPageModel=1 仍在 URL 中或 URL 仍与 watchUrl 的 SPA 路径一致）→ 不推进
      if (/showPageModel=1/.test(currentUrl)) {
        console.log(logTag, '→ skip: still on add form (showPageModel=1)');
        return;
      }
      if (sameLocation(currentUrl, watchUrl)) {
        console.log(logTag, '→ skip: sameLocation watchUrl');
        return;
      }

      // 已经从新增页切到非新增页（审核列表）→ 1.5s 后兜底推进
      if (tabFallbackTimer) clearTimeout(tabFallbackTimer);
      tabFallbackTimer = setTimeout(async () => {
        tabFallbackTimer = null;
        state = await VehicleStore.load();           // 强制 reload storage 最新值，不怕竞态
        const curBatch = state?.batch || {};
        const curRow = state?.rows?.[state.currentIndex];
        const logTagRecheck = `${logTag} recheck phase=${curBatch.phase} running=${curBatch.running} paused=${curBatch.paused} row.status=${curRow?.status || '-'} lockBatch=${curBatch.taskLockId || '(空)'} lockRow=${curRow?.taskLockId || '(空)'}`;
        if (!state || !state.batch) return;
        if (curBatch.phase !== 'waitingManualSubmit') { console.log(logTagRecheck, '→ BLOCKED: phase 不是 waitingManualSubmit，取消 tab 激活兜底推进'); return; }
        if (!curBatch.running || curBatch.paused) { console.log(logTagRecheck, '→ BLOCKED: paused/running 不满足，取消兜底'); return; }
        if (curRow && (curRow.status === 'submitted' || curRow.status === 'done')) {
          logLine(`[提交保护] onTabActivated 兜底触发前发现第 ${curRow.rowNumber} 行 status=${curRow.status}，说明已经被其他路径记录，取消兜底`, 'warn');
          console.log(logTagRecheck, '→ BLOCKED: row already terminal; abort fallback');
          return;
        }
        // 【主任务硬锁 Step 3-C】tab 激活兜底：也必须 batchLockId == rowLockId（已经进入合法等待提交状态才允许）
        if (!curBatch.taskLockId) { console.log(logTagRecheck, '→ BLOCKED: batch.taskLockId 为空，兜底推进不被允许'); return; }
        if (curRow && String(curRow.taskLockId || '') !== String(curBatch.taskLockId || '')) {
          logLine(`[主任务硬锁] ❌ onTabActivated 兜底：当前行 token 与 batch token 不一致 → 拒绝推进`, 'error');
          return;
        }
        console.log(logTag, '→ fallback fired（tabs.onActivated 兜底：页面已从新增页切走，判定为提交成功）');
        logLine('检测到提交后页面跳转（tab激活兜底），自动推进到下一行', 'warn');
        // fallback 路径：传 fromFallback=true，让 completeCurrentAndAdvance 走「batchLockId == rowLockId」的分支校验（同样安全，因为当前 phase/row 已经检查过）
        await completeCurrentAndAdvance('检测到页面切换（tab激活兜底），自动推进', { fromFallback: true });
      }, 1500);
    }).catch(() => {});
  }

  function onTabUpdated(tabId, info, tab) {
    if (!state || !state.batch) return;
    const batch = state.batch;
    if (batch.phase !== 'waitingManualSubmit') return;
    if (!batch.running || batch.paused) return;
    // 兼容：SPA 路由变化有时只触发 changeInfo.url 而不等到 status=complete，
    // 两者任一（status=complete 或 url 变化）都进入后续判断
    const hasStatusComplete = info.status === 'complete';
    const hasUrlChange = typeof info.url === 'string' && info.url.length > 0;
    if (!hasStatusComplete && !hasUrlChange) return;

    const watchUrl = batch.lastAddPageUrl;
    if (!watchUrl) return;
    const currentUrl = hasUrlChange ? info.url : (tab?.url || '');
    if (!currentUrl) return;

    const row = state.rows[state.currentIndex];
    const logTag = `[advance-onTabUpdated] row=${state.currentIndex + 1}/${state.rows.length} rowNumber=${row?.rowNumber || '-'} phase=${batch.phase}`;
    console.log(logTag, `tab ${tabId} status=${info.status || '-'} urlChange=${hasUrlChange} url=${currentUrl.slice(0, 100)}`);

    // 必须是同一管理端域名内的跳转，避免其他 tab 误触发
    try {
      const watchOrigin = new URL(watchUrl, location.href).origin;
      const currentOrigin = new URL(currentUrl, location.href).origin;
      if (watchOrigin !== currentOrigin) {
        console.log(logTag, `→ skip: origin mismatch watch=${watchOrigin} current=${currentOrigin}`);
        return;
      }
    } catch (e) { return; }

    // 还在新增页（URL 仍带 showPageModel=1）→ 不推进
    if (/showPageModel=1/.test(currentUrl)) {
      console.log(logTag, '→ skip: still on add form (showPageModel=1 present)');
      return;
    }
    // 说明：sameLocation 判断放宽——只要 URL 里 showPageModel 去掉了（后台就是从表单切到审核列表了），
    // 即便和 watchUrl 的路径字符串仍相同（同一个 approval 页面不同 query），也认为已经离开了新增页。
    // （旧 sameLocation 会误判为"仍在同一页"，导致永远不推进）
    // 所以这里不再用 sameLocation 硬卡，只靠 phase=waitingManualSubmit + 同源 + 无 showPageModel 三个条件。

    // 启动延迟确认，避免误判（如用户手动点取消返回列表）
    if (tabFallbackTimer) clearTimeout(tabFallbackTimer);
    tabFallbackTimer = setTimeout(async () => {
      tabFallbackTimer = null;
      state = await VehicleStore.load();             // 强制 reload storage 最新值，不怕竞态
      const curBatch = state?.batch || {};
      const curRow = state?.rows?.[state.currentIndex];
      const logTagRecheck = `${logTag} recheck phase=${curBatch.phase} running=${curBatch.running} paused=${curBatch.paused} row.status=${curRow?.status || '-'} lockBatch=${curBatch.taskLockId || '(空)'} lockRow=${curRow?.taskLockId || '(空)'}`;
      if (!state || !state.batch) return;
      if (curBatch.phase !== 'waitingManualSubmit') { console.log(logTagRecheck, '→ BLOCKED: phase 不是 waitingManualSubmit，取消 URL 兜底推进'); return; }
      if (!curBatch.running || curBatch.paused) { console.log(logTagRecheck, '→ BLOCKED: paused/running 不满足，取消兜底'); return; }
      if (curRow && (curRow.status === 'submitted' || curRow.status === 'done')) {
        logLine(`[提交保护] onTabUpdated URL 兜底触发前发现第 ${curRow.rowNumber} 行 status=${curRow.status}，取消兜底推进`, 'warn');
        console.log(logTagRecheck, '→ BLOCKED: row already terminal; abort URL fallback');
        return;
      }
      // 【主任务硬锁 Step 3-D】URL 变化兜底：也必须 batchLockId == rowLockId
      if (!curBatch.taskLockId) { console.log(logTagRecheck, '→ BLOCKED: batch.taskLockId 为空，URL 兜底推进不被允许'); return; }
      if (curRow && String(curRow.taskLockId || '') !== String(curBatch.taskLockId || '')) {
        logLine(`[主任务硬锁] ❌ onTabUpdated URL 兜底：当前行 token 与 batch token 不一致 → 拒绝推进`, 'error');
        return;
      }
      console.log(logTag, '→ fallback fired: URL 兜底推进下一行（toast 可能被遮挡/太快 content-script 没看到）');
      logLine('检测到提交后页面跳转（URL 兜底），自动推进到下一行', 'warn');
      await completeCurrentAndAdvance('检测到页面跳转，自动推进（URL 兜底）', { fromFallback: true });
    }, 1500);
  }

  async function manualNextAfterSubmit() {
    if (!state.rows.length) return warn('请先导入数据');
    if (!confirm('确认当前行已经人工提交成功，并继续下一条？')) return;
    await runBusy('继续下一条...', async () => {
      await stopSubmitWatchQuietly();
      // 手工点击确认下一步：fromManual=true，让 completeCurrentAndAdvance 用 batchLockId==rowLockId 校验
      await completeCurrentAndAdvance('人工确认已提交', { fromManual: true });
    });
  }

  async function completeCurrentAndAdvance(message, ctx) {
    // ====== 【最终闸·用户硬规则】任何不满足下面 ALL 条件的，一律拒绝标记为已提交，绝不推进 currentIndex ======
    // ★ 用户原话：
    //   允许：(1) 初次新增车源全部成功直接提交 → Watcher监测到人工提交Footer → VA_SUBMIT_SUCCESS（fromWatcher=true，带taskLockId）
    //         (2) 缺车系车型时：创建完 → 下一次进入车源新增页重填 → Watcher监测人工Footer提交 → VA_SUBMIT_SUCCESS（fromWatcher=true，且此时watcherBoundOnAddPage已被startSubmitWatchForRow重设为true）
    //         (3) 侧边栏用户主动点【确认已提交】→ fromManual=true（兜底：Watcher没触发、toast被遮/太快没抓到时人工点）
    //   禁止：其他任何监测逻辑 → fromFallback=true（tabs.onActivated/onUpdated URL变化兜底）→ 一律 BLOCK；未知来源调用→ BLOCK。
    //
    // 同时仍需满足：phase=waitingManualSubmit; running=true;paused=false; status非submitted; waitingRowId一致; taskLock三条一致; fromWatcher要求watcherBoundOnAddPage=true
    const taskLockFromMsg = String(ctx?.taskLockId || '');
    const fromWatcher  = !!ctx?.fromWatcher;
    const fromManual   = !!ctx?.fromManual;
    const fromFallback = !!ctx?.fromFallback;
    state = await VehicleStore.load();            // 从 storage 重新拉最新，不信内存里的缓存
    const batch = state.batch || {};
    const rows = [...state.rows];
    const current = rows[state.currentIndex];
    if (!current) {
      console.log(`[advance] completeCurrentAndAdvance SKIP: no current row at currentIndex=${state.currentIndex}`);
      return;
    }

    const batchLock = String(batch.taskLockId || '');
    const rowLock = String(current.taskLockId || '');
    const channel = fromWatcher ? 'WATCHER' : (fromManual ? 'MANUAL' : (fromFallback ? 'FALLBACK(用户禁用)' : 'UNKNOWN'));
    const logTag = `[advance] completeCurrentAndAdvance row=${state.currentIndex + 1}/${rows.length} rowNumber=${current.rowNumber || '-'} phase=${batch.phase} running=${batch.running} paused=${batch.paused} waitingRowId=${batch.waitingRowId || '-'} cur.status=${current.status} cur.id=${current.id} lockBatch=${batchLock} lockRow=${rowLock} lockMsg=${taskLockFromMsg || '(空)'} watcherBound=${batch.watcherBoundOnAddPage} src=${channel}`;
    console.log(logTag, `message="${message || ''}"`);

    const blockers = [];
    if (batch.phase !== 'waitingManualSubmit') blockers.push(`phase=${batch.phase} 不是 waitingManualSubmit`);
    if (!batch.running) blockers.push('running=false');
    if (batch.paused) blockers.push('paused=true');
    if (current.status === 'submitted') blockers.push('当前行 status 已经是 submitted，重复提交保护触发');
    if (batch.waitingRowId && current.id !== batch.waitingRowId) blockers.push(`waitingRowId(${batch.waitingRowId}) 与当前行id(${current.id}) 不一致`);
    // ====== 用户硬规则·通道合法性 ======
    if (fromFallback) {
      blockers.push('【用户硬规则】tabs/URL变化兜底通道（fromFallback）已被用户明确禁用：不要有其他的监测逻辑。Watcher 没触发请点侧边栏【确认已提交】手动推进');
    }
    if (!fromWatcher && !fromManual) {
      blockers.push('【用户硬规则】调用通道不明（既非Watcher也非Manual点击确认），按用户要求一律拒绝。仅允许：车源Footer提交Watcher触发VA_SUBMIT_SUCCESS / 侧边栏手动点确认已提交');
    }
    // ====== 主任务硬锁 ======
    if (!batchLock) blockers.push('batch.taskLockId 为空（当前没有合法的车源大任务在等待提交）');
    if (!rowLock) blockers.push(`第${current.rowNumber}行 taskLockId 为空（可能未经过 fillCurrentWithNavigation 进入）`);
    if (batchLock && rowLock && batchLock !== rowLock) blockers.push(`batch.taskLockId(${batchLock}) 与行 taskLockId(${rowLock}) 不一致`);
    if (taskLockFromMsg && batchLock && taskLockFromMsg !== batchLock) {
      blockers.push(`VA_SUBMIT_SUCCESS 带回的 taskLockId(${taskLockFromMsg}) 与 batch 当前锁(${batchLock}) 不匹配（可能是残留/并发 watcher）`);
    }
    // ====== 用户硬规则·Watcher必须watcherBoundOnAddPage=true ======
    if (fromWatcher && batch.watcherBoundOnAddPage !== true) {
      blockers.push(`【用户硬规则】Watcher通道要求 watcherBoundOnAddPage=true，当前=${JSON.stringify(batch.watcherBoundOnAddPage)}。还没回到车源新增页并重新调用startSubmitWatchForRow挂好watcher → 绝不允许标记为已提交（防残留/误触发watcher）`);
    }

    if (blockers.length > 0) {
      const blockMsg = blockers.join('；');
      logLine(`[主任务硬锁][最终闸] ❌ 拒绝标记第 ${current.rowNumber} 行为已提交：${blockMsg}。message="${message || ''}"。当前行保持未推进，绝不记录为已提交。`, 'error');
      console.log(`${logTag} → BLOCKED: ${blockMsg}`);
      // ===== 安全兜底：如果已经检测到有人偷偷把这行 status 改成 submitted，这里立刻回滚（防止 ensureSnapshot 之前的漏网） =====
      if (current.status === 'submitted') {
        const rollbackRows = [...state.rows];
        const idx = state.currentIndex;
        rollbackRows[idx] = { ...rollbackRows[idx], status: 'waiting-manual-partial', submittedAt: '', _taskLockRollback: Date.now() };
        await VehicleStore.save({ rows: rollbackRows });
        logLine(`[主任务硬锁][最终闸] ⚠️ 已回滚第${current.rowNumber}行 status：submitted → waiting-manual-partial（清除 submittedAt）`, 'error');
      }
      return;
    }

    if (tabFallbackTimer) { clearTimeout(tabFallbackTimer); tabFallbackTimer = null; }

    rows[state.currentIndex] = {
      ...current,
      status: 'submitted',
      submittedAt: new Date().toLocaleString(),
      // 提交完成后清掉行上的 token（这个大任务圆满结束，下一行会在 fillCurrentWithNavigation 里重新生成）
      taskLockId: '',
    };

    const nextIndex = state.currentIndex + 1;
    const completed = rows.filter(r => r.status === 'submitted').length;
    state = await VehicleStore.save({
      rows,
      currentIndex: nextIndex,
      batch: {
        ...batch,
        completed,
        phase: nextIndex >= rows.length ? 'done' : 'nextRow',
        waitingRowId: '',
        waitingRowNumber: '',
        lastAddPageUrl: '',
        // 【主任务硬锁 Step 5 - 解锁】提交成功后立刻清 batch.taskLockId！下一行重新生成。
        // 这样即便同一个 submitWatcher 因网络延迟又发来一个 VA_SUBMIT_SUCCESS，
        // batch.taskLockId 已经空了，Step 4 第一条就会 BLOCK。
        taskLockId: '',
        running: true,            // 【关键显式保存】：防止推进过程中 batch.running 被中间某个 setBatch 意外改成 false 导致 fillCurrentWithNavigation 不跑
        paused: false,            // 同上：显式 paused=false（用户没手动点暂停就不能卡）
        lastMessage: nextIndex >= rows.length ? '全部录入完成' : `${message}，准备录入下一条`,
      },
    });
    logLine(`第 ${current.rowNumber} 行已提交完成（主任务锁已解锁）：${message}`, 'ok');
    renderAll();

    if (nextIndex >= rows.length) {
      console.log(logTag, '→ nextIndex >= length, markBatchDone');
      await markBatchDone();
      return;
    }

    console.log(logTag, `→ advance prepare nextIndex=${nextIndex + 1}/${rows.length} nextRowNumber=${rows[nextIndex]?.rowNumber || '-'} running=${state.batch?.running} paused=${state.batch?.paused}`);

    if (state.batch?.running && !state.batch?.paused) {
      setTimeout(() => {
        console.log(logTag, `→ setTimeout(800ms) fired → runBusy 调用 fillCurrentWithNavigation 进入下一行`);
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
    renderCurrent();
    renderSourceRow();
    renderFillReport();
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
    setDisabled('btnStartBatch', busy || !hasRows || waiting || batch.phase === 'done');
    setDisabled('btnPauseBatch', busy || !batch.running);
    setDisabled('btnStopBatch', busy || (!batch.running && batch.phase !== 'waitingManualSubmit' && batch.phase !== 'paused'));
    setDisabled('btnRefillCurrent', busy || !hasRows || state.currentIndex >= state.rows.length);
    setDisabled('btnPrev', busy || !hasRows || state.currentIndex <= 0);
    setDisabled('btnNext', busy || !hasRows || state.currentIndex >= state.rows.length - 1);
    setDisabled('btnLoadDemo', busy);
    setDisabled('btnDownloadTemplate', busy);
    setDisabled('btnClear', busy);
  }

  function setDisabled(id, disabled) {
    const el = $(id);
    if (el) el.disabled = !!disabled;
  }

  async function runBusy(label, fn, options) {
    if (busy) return;
    busy = true;
    setStatus(label);
    updateButtons();
    // ======================================================
    // ★ 用户明确要求：创建阶段（creating）需要人工在车系/车型Drawer里点提交，耗时多久都正常，
    //   绝对不能因为「60秒定时器」强制把流水线重置 → 导致创建阶段还没完成就被当超时杀掉、页面还在车源新增页"不跳转"（你截图就是这个根因）。
    //   所以 phase==='creating' 或 batch.phase 变成 creating 时 → 不启动 safetyTimer。
    //   其他阶段（filling / probing / opening / waitingManualSubmit 的短操作）：safetyTimeout 仍保留 90 秒（比之前 60 秒宽一点，避免误杀）
    // ======================================================
    const needSafety = (() => {
      // 如果调用方明确传了 timeoutMs=0 / Infinity / disableSafetyTimer → 不开定时器
      if (options?.disableSafetyTimer) return false;
      if (typeof options?.timeoutMs === 'number' && (options.timeoutMs <= 0 || !isFinite(options.timeoutMs))) return false;
      const currentPhase = state?.batch?.phase || '';
      // creating 阶段 = 等人工提交车系/车型 Drawer → 给无限时间，用户想想 10 分钟都可以，绝对不杀
      if (currentPhase === 'creating') return false;
      return true;
    })();
    const safetyTimeoutMs = needSafety ? (options?.timeoutMs || 90000) : 0;
    let safetyTimer = null;
    if (needSafety && safetyTimeoutMs > 0) {
      safetyTimer = setTimeout(() => {
        if (!busy) return;
        busy = false;
        const err = new Error(`操作超时（${Math.round(safetyTimeoutMs / 1000)} 秒）仍未完成，已强制重置状态：${label}。若正在创建车系/车型需人工等待，请用侧边栏【重填当前行】重新触发（creating阶段超时保护已移除，理论不该在这里被打到）`);
        warn(err.message);
        logLine(err.message, 'error');
        setStatus(state.rows?.length ? `${Math.min(state.currentIndex + 1, state.rows.length)}/${state.rows.length}` : '待导入');
        updateButtons();
      }, safetyTimeoutMs);
    } else {
      console.log(`[runBusy] ${label}：phase=${state?.batch?.phase || 'unknown'} → safetyTimer 已禁用（创建阶段等人工提交给无限时间）`);
    }
    try {
      await fn();
    } catch (e) {
      warn(e.message || String(e));
      logLine(e.message || String(e), 'error');
    } finally {
      if (safetyTimer) clearTimeout(safetyTimer);
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
      /**
       * 【主任务硬锁】taskLockId：每个车源大任务（=CSV里一行）开始批量录入前生成一个唯一的锁 token。
       * 这个 token 会同时存到：
       *   (a) state.batch.taskLockId     → sidepanel 这边推进/回滚的硬闸
       *   (b) submitWatch.taskLockId     → content-admin 那边 VA_SUBMIT_SUCCESS 消息会把它带回来
       *   (c) row.taskLockId             → 行本身也记一份，防 tab 误切/重入
       *
       * 只有"带了相同 token 的 VA_SUBMIT_SUCCESS 消息 / 手工确认下一步"才能完成当前车源大任务
       * （即 completeCurrentAndAdvance 里第 6 项 check 必须 token 相等，否则直接 BLOCK + 回滚 status）。
       * 创建车系/车型期间，phase=creating 且 submitWatch 已被 stopSubmitWatchQuietly 停掉，
       * 任何残留/并发的 submitWatcher 消息拿不到当前 token，都会被锁死。
       */
      taskLockId: '',
      completed: 0,
      failed: 0,
      startedAt: '',
      lastMessage: message || '',
    };
  }

  /** 生成一个不可碰撞、不可猜测的主任务锁 token（短、可读、够用） */
  function genTaskLockId() {
    const rand = Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
    return 'TLK-' + rand.toUpperCase();
  }

  async function waitTabUrlHit(tabId, targetUrl, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 12000);
    let finalUrl = '';
    while (Date.now() < deadline) {
      try {
        const tab = await chrome.tabs.get(tabId);
        finalUrl = tab?.url || '';
        if (isTargetUrl(finalUrl, targetUrl)) return finalUrl;
      } catch (e) {}
      await sleep(250);
    }
    try { finalUrl = (await chrome.tabs.get(tabId))?.url || ''; } catch (e) {}
    return finalUrl;
  }

  function isTargetUrl(url, targetUrl) {
    if (!url) return false;
    if (/showPageModel=1/.test(url)) return true;
    return sameLocation(url, targetUrl);
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
      '牵引车,否,19719222571,LFV3A24K0L3000004,白色,12000,2026-06,河北省/石家庄市,天津市/天津市,天津市西青区测试停车场,公户,可提档过户,一汽解放,鹰腾,CA4253P25K15T1NE6A80 6×4 锡柴CA6SM7-53E61N,测试车辆：车系"鹰腾"和车型均不存在，用于验证插件自动创建车系/车型功能。创建成功后会重填当前行，车系车型应该能被选中。,15000,150000',
    ].join('\n');
  }
})();
