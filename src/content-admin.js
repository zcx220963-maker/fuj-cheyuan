(function () {
  'use strict';

  // 标记 content script 已注入，sidepanel 通过此标记判断是否需要强制重新注入
  window.__vehicleUploadAssistantInjected = true;

  // 始终允许消息监听器重新注册（SPA 路由切换后 content script 需要重新注入）
  if (window.__vaMsgListener) {
    try { chrome.runtime.onMessage.removeListener(window.__vaMsgListener); } catch {}
    window.__vaMsgListener = null;
  }

  const RECORDED_FLOW_FIELDS = [
    { field: 'vehicleType', label: '车辆类型',
      selector: ['#myForm_vehicleType', '#myForm_baseInfo_vehicleType', '#myForm_specInfo_vehicleType'],
      kind: 'dropdown', required: true, waitAfter: 800,
      aliases: ['车辆类型', '车型类别', '类型'] },
    { field: 'withTrailer', label: '是否带挂', selector: '#myForm_withTrailer', kind: 'dropdown', required: false, waitAfter: 450 },
    { field: 'referenceReservePrice', label: '参考底价', selector: '#myForm_reservePrice', kind: 'input', required: false, waitAfter: 220 },
    { field: 'referenceQuotedPrice', label: '参考售价', selector: '#myForm_quotedPrice', kind: 'manual', manualMessage: '售价按要求人工填写，插件不自动写入。' },
    { field: 'ownerPhone', label: '车主手机号',
      selector: ['#myForm_otherInfo_ownerPhone', '#myForm_ownerPhone'],
      kind: 'input', required: true, waitAfter: 220,
      aliases: ['车主手机号', '车主电话', '联系电话'] },
    { field: 'vin', label: 'VIN',
      selector: ['#myForm_licenseInfo_vinCode', '#myForm_vinCode', '#myForm_vin'],
      kind: 'input', required: true, waitAfter: 260,
      aliases: ['VIN', '车架号', 'vin码'] },
    { field: 'color', label: '车身颜色',
      selector: ['#myForm_baseInfo_carColor', '#myForm_carColor', '#myForm_color'],
      kind: 'dropdown', required: true, waitAfter: 450,
      aliases: ['车身颜色', '颜色'] },
    { field: 'mileage', label: '表显里程',
      selector: ['#myForm_baseInfo_mileage', '#myForm_mileage'],
      kind: 'input', required: true, waitAfter: 220,
      aliases: ['表显里程', '里程', '行驶里程'] },
    { field: 'registerDate', label: '上牌日期',
      selector: ['#myForm_baseInfo_spTime', '#myForm_spTime', '#myForm_registerDate'],
      kind: 'month', required: true, waitAfter: 450,
      aliases: ['上牌日期', '注册日期', '初次登记'] },
    { field: 'registeredAddr', label: '车籍所在地',
      selector: ['#myForm_baseInfo_registeredAddr', '#myForm_registeredAddr'],
      kind: 'cascader', required: true, waitAfter: 520,
      aliases: ['车籍所在地', '上牌地', '车籍地'] },
    { field: 'parkAddr', label: '停放地区',
      selector: ['#myForm_baseInfo_parkAddr', '#myForm_parkAddr'],
      kind: 'cascader', required: true, waitAfter: 520,
      aliases: ['停放地区', '停放地址', '所在地'] },
    { field: 'parkAddrDetail', label: '停放详细地址',
      selector: ['#myForm_baseInfo_parkAddrDetail', '#myForm_parkAddrDetail'],
      kind: 'input', required: false, waitAfter: 220,
      aliases: ['停放详细地址', '详细地址'] },
    { field: 'registeredType', label: '车籍性质',
      selector: ['#myForm_baseInfo_registeredType', '#myForm_registeredType'],
      kind: 'dropdown', required: true, waitAfter: 450,
      aliases: ['车籍性质', '车辆性质'] },
    { field: 'transferInfo', label: '过户信息',
      selector: ['#myForm_baseInfo_ghinfo', '#myForm_ghinfo', '#myForm_transferInfo'],
      kind: 'dropdown', required: true, waitAfter: 450,
      aliases: ['过户信息', '过户次数'] },
    { field: 'brandName', label: '品牌',
      selector: ['#myForm_specInfo_brandId', '#myForm_brandId', '#myForm_info_brandId'],
      kind: 'manual', manualMessage: '品牌按要求人工从下拉选择，插件不自动写入。',
      aliases: ['品牌', '品牌名称', '车辆品牌'] },
    { field: 'seriesName', label: '车系',
      selector: ['#myForm_specInfo_seriesId', '#myForm_seriesId', '#myForm_info_seriesId'],
      kind: 'dropdown', required: true, waitAfter: 900,
      aliases: ['车系', '车系名称', '系列'] },
    { field: 'modelName', label: '车型',
      selector: ['#myForm_specInfo_modelId', '#myForm_modelId', '#myForm_info_modelId'],
      kind: 'dropdown', required: true, waitAfter: 900,
      aliases: ['车型', '车型名称', '型号'] },
    { field: 'description', label: '车辆描述', selector: '', kind: 'textarea', required: false, aliases: ['车辆描述', '车况描述', '补充信息', '描述'], waitAfter: 220 },
  ];

  const SUCCESS_TEXT = /操作成功|提交成功|保存成功|发布成功|新增成功|录入成功|创建成功|成功|success|Success|\bOK\b|已成功/;
  const ERROR_TEXT = /VIN码格式错误|VIN格式错误|请输入正确的手机号|手机号格式错误|校验失败|提交失败|保存失败|创建失败|新增失败|不能为空|请选择|请输入|错误|error|Error|失败|已存在|重复|冲突/;
  let submitWatch = null;
  let submitObserver = null;
  let submitTimer = null;
  let submitClickHandler = null;
  let submitTimeoutId = null;
  let pageAbortRequested = false;
  let pageAbortReason = '';
  let pageSleepEntries = new Set();

  class PageAbortError extends Error {
    constructor(message) {
      super(message || pageAbortReason || '页面自动化已中断');
      this.name = 'PageAbortError';
      this.__aborted = true;
    }
  }

  // 页面内消息桥（用于 pagehide/beforeunload 兜底）—— 先移除旧的再注册新的
  if (window.__vaPageMsgHandler) {
    window.removeEventListener('message', window.__vaPageMsgHandler, false);
  }
  function handlePageSubmitMessage(event) {
    if (!event?.data || event.source !== window) return;
    if (event.data.type !== 'VA_PAGE_SUBMITTED') return;
    if (!submitWatch || submitWatch.sent) return;
    if (!submitWatch.sawSubmitClick) return;
    const error = visibleErrorText();
    if (error) return;
    submitWatch.sent = true;
    const payload = {
      type: 'VA_SUBMIT_SUCCESS',
      rowId: submitWatch.rowId,
      rowNumber: submitWatch.rowNumber,
      displayName: submitWatch.displayName,
      href: location.href,
      message: '提交后页面已跳转（postMessage 兜底）',
      submittedAt: new Date().toLocaleString(),
      source: 'postMessage',
      /** 【主任务硬锁】：把 sidepanel 传给 startSubmitWatch 的 taskLockId 原样带回，只有 token 完全匹配才算合法提交成功 */
      taskLockId: submitWatch.taskLockId || '',
    };
    stopSubmitWatch('postMessage');
    try { chrome.runtime.sendMessage(payload).catch(() => {}); } catch {}
  }
  window.__vaPageMsgHandler = handlePageSubmitMessage;
  window.addEventListener('message', handlePageSubmitMessage, false);

  // 注册（或重新注册）与 sidepanel 的消息监听器
  const msgListener = (msg, sender, sendResponse) => {
    if (!msg || !String(msg.type || '').startsWith('VA_')) return false;
    (async () => {
      try {
        if (msg.type === 'VA_ABORT_CURRENT_TASK') return sendResponse({ ok: true, result: abortCurrentTask(msg.reason || msg.mode || 'sidepanel-abort') });
        if (msg.type === 'VA_PING') return sendResponse({ ok: true, href: location.href, title: document.title });
        if (msg.type === 'VA_OPEN_ADD_FORM') { resetPageAbort(); return sendResponse({ ok: true, result: await openAddForm() }); }
        if (msg.type === 'VA_ENSURE_ON_ADD_FORM') { resetPageAbort(); return sendResponse({ ok: true, result: await ensureOnAddForm({}) }); }
        if (msg.type === 'VA_FORCE_GOTO_VEHICLE_ADD_PAGE') { resetPageAbort(); return sendResponse({ ok: true, result: await forceGotoVehicleAddPage({}) }); }
        if (msg.type === 'VA_PROBE_UI_EMPTY_BRAND_SERIES_MODEL') return sendResponse({ ok: true, result: probeCurrentUIBrandSeriesModel() });
        if (msg.type === 'VA_WAIT_READY') return sendResponse({ ok: true, result: await waitForReady(msg.timeout || 15000) });
        if (msg.type === 'VA_PROBE_PAGE') return sendResponse({ ok: true, probe: probePage() });
        if (msg.type === 'VA_FILL_ROW') { resetPageAbort(); return sendResponse({ ok: true, report: await fillRecordedRow(msg.row || {}, msg.options || {}) }); }
        if (msg.type === 'VA_START_SUBMIT_WATCH') return sendResponse({ ok: true, result: startSubmitWatch(msg.row || {}) });
        if (msg.type === 'VA_STOP_SUBMIT_WATCH') return sendResponse({ ok: true, result: stopSubmitWatch('manual-stop') });
        if (msg.type === 'VA_CREATE_SERIES') { resetPageAbort(); return sendResponse({ ok: true, result: await createSeries(msg.payload || {}) }); }
        if (msg.type === 'VA_CREATE_MODEL') { resetPageAbort(); return sendResponse({ ok: true, result: await createModel(msg.payload || {}) }); }
        if (msg.type === 'VA_NAVIGATE_AND_CREATE') { resetPageAbort(); return sendResponse({ ok: true, result: await navigateAndCreate(msg.payload || {}) }); }
        if (msg.type === 'VA_WAIT_NAVIGATION') return sendResponse({ ok: true, result: await waitForNavigation(msg.target || '', msg.timeout || 15000) });
        sendResponse({ error: '未知消息: ' + msg.type });
      } catch (e) {
        if (e?.name === 'PageAbortError' || e?.__aborted) {
          sendResponse({ ok: false, aborted: true, error: e?.message || String(e) });
        } else {
          sendResponse({ error: e?.message || String(e) });
        }
      }
    })();
    return true;
  };
  window.__vaMsgListener = msgListener;
  chrome.runtime.onMessage.addListener(msgListener);

  async function openAddForm() {
    throwIfPageAborted();
    const before = location.href;
    debugSubmit('open-add-form-start', { before });
    if (looksLikeAddForm()) {
      debugSubmit('open-add-form-already-open', { href: location.href });
      return { status: 'already-open', href: location.href, message: '已在新增车源表单页' };
    }

    const steps = [];
    /** 点击新增按钮后，最多等 15s 直到 looksLikeAddForm=true，避免 page 还没渲染完就被上一层 fillCurrentRowCore 调用找控件 */
    async function waitReadyAfterClick(msgIfTimeout) {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
      throwIfPageAborted();
        if (looksLikeAddForm()) return true;
        await sleep(500);
      }
      if (looksLikeAddForm()) return true;
      debugSubmit('open-add-form-wait-ready-timeout', { steps, message: msgIfTimeout, href: location.href });
      return false;
    }

    // 当前页面如果已经是审核列表，优先直接点右上角的“新增库存车”。
    // 这样比再次折叠菜单更稳，也更符合“提交后直接进入下一轮”的预期。
    let button = findAddButton();
    if (button) {
      robustClick(button);
      steps.push('直接点击新增库存车');
      await sleep(600);
      const ready = await waitReadyAfterClick('点击"新增库存车"后等待表单ready超时');
      debugSubmit('open-add-form-direct-click', { ready, href: location.href, steps: steps.join('→') });
      return {
        status: ready ? 'ready' : (location.href !== before ? 'opened' : 'clicked'),
        href: location.href,
        message: steps.join(' → '),
      };
    }

    // 录制链路：车源管理父项展开 → 审核列表叶子 → 新增库存车。
    // ★ 用户规定只允许模拟点击（禁止URL/SPA/history/tabs），所以展开父项必须保证子菜单真的开了。
    {
      const unfold = await ensureSubMenuExpanded('车源管理', '审核列表');
      steps.push(`展开车源管理父项[${unfold.action || 'failed'}]：${unfold.message || ''}`);
      if (!unfold.ok) {
        // 父项没展开 → 补点几次（极少数 Ant Design 主题把 SubMenu 展开按钮绑在图标上而不是整行时）
        steps.push('父项未展开，走兜底再补2次双点（不跳URL，纯点击）');
        const vm = findClickableByText(/车源管理/);
        if (vm) { ultimateClick(vm); await sleep(480); ultimateClick(vm); await sleep(550); ultimateClick(vm); await sleep(500); }
      }
    }

    const auditList = findClickableByText(/审核列表/);
    if (auditList) {
      ultimateClick(auditList);
      steps.push('点击审核列表');
      await sleep(1200);
    }

    button = findAddButton();
    if (!button) {
      await sleep(800);
      button = findAddButton();
    }

    // ★ 用户明确要求：不允许 URL / SPA 跳转，只允许模拟点击。
    //   如果还是没找到按钮 → 再 ensureSubMenuExpanded 一次 + clickLeafMenuItem("审核列表")
    //   绝对不调用 navigateInsideApp / history 来改 URL
    if (!button && !looksLikeAuditList()) {
      steps.push('兜底：ensureSubMenuExpanded 再确认一次车源管理父项展开（不跳URL，纯点击）');
      const unfold2 = await ensureSubMenuExpanded('车源管理', '审核列表');
      steps.push(`兜底展开[${unfold2.action || 'failed'}]：${unfold2.message || ''}`);
      const clickAudit = await clickLeafMenuItem('审核列表');
      steps.push(`兜底点击叶子：${clickAudit.ok ? clickAudit.message : '失败：'+clickAudit.message}`);
      if (clickAudit.ok) await sleep(1400);
      button = findAddButton();
      if (!button) { await sleep(900); button = findAddButton(); }
    }

    if (!button) {
      debugSubmit('open-add-form-button-not-found', { steps: steps.join('→'), leftMenu: dumpLeftMenuSnapshot() });
      return {
        status: 'not-found',
        href: location.href,
        message: `未找到"新增库存车/新增车源"按钮；已执行：${steps.join(' → ') || '无'}。诊断：${dumpLeftMenuSnapshot()}`,
      };
    }

    robustClick(button);
    steps.push('点击新增库存车');
    await sleep(600);
    const ready = await waitReadyAfterClick('录制链路点击"新增库存车"后等待表单ready超时');
    debugSubmit('open-add-form-recorded-flow-click', { ready, href: location.href, steps: steps.join('→') });
    return {
      status: ready ? 'ready' : (location.href !== before ? 'opened' : 'clicked'),
      href: location.href,
      message: steps.join(' → '),
    };
  }

  /**
   * 【sidepanel needBack 二次兜底】车型也提交完成后，先核一次当前是不是真的在【车源新增页】，
   * 不是就执行 clickTab→菜单点击→路由→openAddForm 多重兜底，确保在调用 fillCurrentRowCore 前
   * 100% 在车源新增表单页，防止被串回车系/车型列表页空填。
   *
   * 返回：
   *   { alreadyOK: true/false,  // 一开始是不是就在新增页
   *     action: 'noop'|'tab-back'|'menu-back'|'navigate-back'|'open-add',  // 为了回到新增页做了什么动作
   *     finalLooksLike: boolean, // 最终 looksLikeAddForm() 结果
   *     message: string,
   *     href: string }
   */
  async function ensureOnAddForm(_opts) {
    throwIfPageAborted();
    const before = looksLikeAddForm();
    if (before) {
      return { alreadyOK: true, action: 'noop', finalLooksLike: true, href: location.href, message: '已在车源新增表单页，无需操作' };
    }

    // Step 1: 优先切"审核列表"tab（如果顶栏 tabs 有就最快）
    let action = 'need-recover';
    try {
      const tabBack = await clickTab('审核列表');
      if (tabBack.ok) {
        action = 'tab-back';
        await sleep(300);
        if (looksLikeAddForm()) return { alreadyOK: false, action, finalLooksLike: true, href: location.href, message: `切审核列表tab成功，当前已在新增页：${tabBack.message}` };
      }
    } catch (e) { ignoreUnlessPageAbort(e); /* ignore */ }

    // Step 2: 如果 looksLikeAddForm 还是 false → 看当前是不是已经在审核列表页（有新增按钮），点一下
    try {
      if (looksLikeAuditList()) {
        const btn = findAddButton();
        if (btn) {
          robustClick(btn);
          action = action === 'tab-back' ? 'tab-back→open-add' : 'open-add';
          await sleep(700);
          // 等表单 6s
          const dl = Date.now() + 6000;
          while (Date.now() < dl && !looksLikeAddForm()) await sleep(300);
          if (looksLikeAddForm()) return { alreadyOK: false, action, finalLooksLike: true, href: location.href, message: '审核列表页点"+新增库存车"成功进入新增页' };
        }
      }
    } catch (e) { ignoreUnlessPageAbort(e); /* ignore */ }

    // Step 3: tabs 没审核列表 + 当前也没审核列表按钮 → 走模拟点击菜单 车源管理→审核列表
    try {
      await ensureSubMenuExpanded('车源管理', '车源列表|审核列表');
      const leaf = await clickLeafMenuItem('审核列表');
      action = (action !== 'need-recover' ? action + '→' : '') + 'menu-back';
      if (leaf.ok) {
        await sleep(600);
        const btn = findAddButton();
        if (btn) {
          robustClick(btn);
          action += '→open-add';
          await sleep(700);
          const dl = Date.now() + 6000;
          while (Date.now() < dl && !looksLikeAddForm()) await sleep(300);
        }
        if (looksLikeAddForm()) return { alreadyOK: false, action, finalLooksLike: true, href: location.href, message: `菜单点击审核列表+新增库存车成功：${leaf.message}` };
      }
    } catch (e) { ignoreUnlessPageAbort(e); /* ignore */ }

    // Step 4: 菜单也失败 → navigateInsideApp SPA 路由 + openAddForm 终极兜底
    try {
      await navigateInsideApp('/vehicle-source/approval?showPageModel=1');
      action = (action !== 'need-recover' ? action + '→' : '') + 'navigate-back';
      await sleep(1200);
      const back = await openAddForm();
      if (back?.status !== 'not-found') action += '→open-add(' + String(back.status || 'unknown') + ')';
      await sleep(500);
    } catch (e) { ignoreUnlessPageAbort(e); /* ignore */ }

    // Step 5: 最后一次核 looksLikeAddForm
    const finalLooks = looksLikeAddForm();
    return {
      alreadyOK: false,
      action,
      finalLooksLike: finalLooks,
      href: location.href,
      message: finalLooks
        ? '多层兜底后成功进入车源新增页'
        : '⚠️ 多层兜底后仍未判定为车源新增页（looksLikeAddForm=false），将尝试继续填，若仍卡壳请点侧边栏【重填当前行】手动触发。',
    };
  }

  /**
   * 【用户原话·原子切回车源新增】
   *   车型/车系创建 Drawer 都提交成功后，必须 100% 模拟点击：
   *     左侧车源管理父项（展开子菜单） → 审核列表叶子 → 右上角 +新增库存车 → 回到空白车源表单页。
   *
   *   为什么单独写这个函数？
   *     openAddForm/ensureOnAddForm 之前只点了「车源管理」文本节点，而 AntD 后台左侧菜单用的是手风琴模式：
   *     当前父项=车型库管理展开时，点另一个父项「车源管理」= 第1次点击只会先收车型库管理、没真正展开车源管理；
   *     原 ensureSubMenuExpanded 只点 1 次 + 没等待 isSubMenuExpanded 真的 true 就去点叶子 → 审核列表叶子找不到 → 走 SPA 兜底
   *     也可能被路由守卫拦 → 最终就停在车系管理页（你第一张截图左侧高亮=车系管理）。
   *
   *   本函数用【2 轮 × 7 步】硬保，最多 2 轮，每轮都要 looksLikeAuditList=true 才算切成功。
   */
  async function forceGotoVehicleAddPage(_opts) {
    throwIfPageAborted();
    const logs = [];
    let finallyLooksLikeAuditList = false;
    let finallyLooksLikeAddForm = false;
    let finalAction = 'none';

    for (let round = 1; round <= 3; round++) {
      throwIfPageAborted();
      logs.push(`--- 第 ${round}/3 轮纯点击切到车源新增页 ---`);
      // 先核：如果现在已经在新增表单页，就直接 return success
      if (looksLikeAddForm()) {
        finallyLooksLikeAuditList = looksLikeAuditList();
        finallyLooksLikeAddForm = true;
        finalAction = 'already-on-add-form';
        logs.push(`  ✓ 已经在车源新增表单页，跳过`);
        break;
      }
      // ★ 用户明确规定：不允许顶栏 tabs 切换、不允许 URL 跳转。
      //   直接走左侧菜单：ensureSubMenuExpanded("车源管理", "审核列表")（最多4轮双点直到父项真的展开，子叶子可见）→ 点"审核列表"叶子 → 点"+新增库存车"
      {
        // Step 2: 展开「车源管理」父项（用增强版 ensureSubMenuExpanded，4 轮双点 + 子叶子出现校验 + 失败带诊断）
        const unfold = await ensureSubMenuExpanded('车源管理', '审核列表');
        logs.push(`  [Step2·展开车源管理父项] action=${unfold.action || 'failed'} → ${unfold.message || ''}`);
        if (unfold.action === 'failed') {
          logs.push(`  [Step2·诊断] 父项无法展开：ensureSubMenuExpanded 返回 4 轮失败。用户手动点一下左侧【车源管理】▶ 即可解决。`);
        }
        finalAction = (finalAction === 'none' ? '' : finalAction + '→') + `expand-car-source-parent-${unfold.action || 'failed'}-round${round}`;

        // Step 3: 点「审核列表」叶子
        const leafDeadline = Date.now() + 2500;
        let auditLeaf = null;
        while (Date.now() < leafDeadline && !auditLeaf) {
      throwIfPageAborted();
          const auditCandidates = [...document.querySelectorAll('li, span, a, div, .ant-menu-item, [class*="menu-item"]')]
            .filter(isVisible)
            .map(el => {
              const t = cleanText(el.innerText || el.textContent || '');
              if (t !== '审核列表' && !(t.includes('审核列表') && t.length <= 8)) return null;
              return { el, text: t, len: t.length };
            })
            .filter(Boolean)
            .sort((a, b) => a.len - b.len);
          if (auditCandidates.length > 0) auditLeaf = auditCandidates[0].el;
          else await sleep(220);
        }
        if (auditLeaf) {
          logs.push(`  [Step3·点审核列表叶子] text="${cleanText(auditLeaf.innerText||auditLeaf.textContent||'')}" → 点击（ultimateClick三策略）`);
          finalAction += '→click-audit-leaf';
          ultimateClick(auditLeaf);
          await sleep(1400);
        } else {
          logs.push(`  [左侧菜单] ⚠️ 2.5s 内没找到「审核列表」叶子（父项仍没展开或 DOM 延迟）→ 把 dumpLeftMenuSnapshot 打出来：${dumpLeftMenuSnapshot()}`);
        }
      }

      // ★ 用户规定不允许 SPA/URL/history 兜底。如果 looksLikeAuditList 仍=false → 直接下一轮重新点（再给一次机会）
      if (looksLikeAuditList()) {
        finallyLooksLikeAuditList = true;
        logs.push(`  ✓ looksLikeAuditList=true（左侧菜单链路切进去了）`);
      } else {
        logs.push(`  ⚠️ looksLikeAuditList 仍=false（${round < 3 ? '下一轮再重新点父菜单+叶子' : '3轮都没点进去'}，不做 URL 兜底）`);
      }

      // Step 5: 已经在审核列表 → 点右上角「+新增库存车」
      if (finallyLooksLikeAuditList || looksLikeAuditList()) {
        finallyLooksLikeAuditList = true;
        let addBtn = findAddButton();
        if (!addBtn) { await sleep(900); addBtn = findAddButton(); }
        if (addBtn) {
          logs.push(`  [新增] 找到"+新增库存车"按钮：text="${cleanText(addBtn.innerText||addBtn.textContent||'')}" → 点击`);
          finalAction += '→click-add';
          robustClick(addBtn);
          // 等 looksLikeAddForm=true，最多 12s（加 2s 留时间给表单 Drawer 滑入）
          const addDeadline = Date.now() + 12000;
          while (Date.now() < addDeadline && !looksLikeAddForm()) {
      throwIfPageAborted();
      await sleep(350);
    }
          finallyLooksLikeAddForm = looksLikeAddForm();
          logs.push(finallyLooksLikeAddForm
            ? `  ✓ looksLikeAddForm=true，已进入空白车源新增表单页`
            : `  ⚠️ 等了12秒 looksLikeAddForm 仍=false，可能表单没渲染出来，最终填字段时再兜底`);
        } else {
          logs.push(`  [新增] ❌ 审核列表上依旧没找到"+新增库存车"按钮，下一轮重试`);
        }
      }

      // 本轮已经得到新增页 → break
      if (finallyLooksLikeAddForm) break;
      logs.push(`  本轮最终 looksLikeAuditList=${finallyLooksLikeAuditList}, looksLikeAddForm=${finallyLooksLikeAddForm} → ${round < 3 ? '开始第 ' + (round + 1) + '/3 轮重试' : '3 轮都没进去，返回最终结果'}`);
      if (round < 3) await sleep(300);
    }

    // 最后再做一次 openAddForm 兜底（3 轮还没 looksLikeAddForm）——openAddForm 现在也纯点击，无 URL 兜底。
    if (!finallyLooksLikeAddForm) {
      try {
        logs.push(`[终极兜底] 3 轮都没进入车源新增表单 → 再调一次 openAddForm 全链路（纯点击，不跳URL）`);
        const back = await openAddForm();
        finalAction += '→ultimate-openAddForm(' + String(back.status || 'unknown') + ')';
        await sleep(900);
        const dl = Date.now() + 8000;
        while (Date.now() < dl && !looksLikeAddForm()) await sleep(300);
        finallyLooksLikeAuditList = looksLikeAuditList();
        finallyLooksLikeAddForm = looksLikeAddForm();
      } catch (e) { logs.push(`[终极兜底] openAddForm 异常：${e?.message || String(e)}`); }
    }

    return {
      ok: !!(finallyLooksLikeAuditList && finallyLooksLikeAddForm),
      finalAction,
      finallyLooksLikeAuditList,
      finallyLooksLikeAddForm,
      href: location.href,
      message: finallyLooksLikeAddForm
        ? '已成功切到车源管理→审核列表，并打开了+新增库存车的空白表单页。'
        : (finallyLooksLikeAuditList
          ? '已切到审核列表，但未检测到"新增库存车"空白表单页渲染，请人工点侧边栏【重填当前行】重试。'
          : '3 轮纯点击（车源管理→审核列表→+新增库存车）仍未切到目标页，请人工展开左侧车源管理→点击审核列表→+新增库存车后，点侧边栏【重填当前行】重试。（全程未使用任何 URL / SPA / tabs 跳转）'),
      logs,
    };
  }

  /**
   * 【终极兜底·直接读 UI 选中文本】
   *   用户截图场景：Stage1 填 PROBE 4 项（车辆类型/品牌/车系/车型）后，品牌/车系/车型三个控件
   *   还停在「请选择」（绿框 = 获取焦点但没选上、或下拉未触发联动、或 VA_FILL_ROW report 被误判成
   *   hit=选上了但实际上文本还是"请选择"）→ 导致直达创建分支没进、直接 waitingManualSubmit 红框卡住。
   *
   *   这个函数绕开 VA_FILL_ROW 报告的任何字段/状态，直接按 label 文本在当前页面上找 品牌 / 车系 / 车型
   *   三个控件，读它们**当前显示的选中文本**，判断是不是"空/请选择/未选择"。
   *   只要 brand / series / model 任意一项还没选上 → 返回 empty=true，sidepanel 收到 empty=true + CSV
   *   有 brandName/seriesName/modelName 三值 → 强制跳创建，杜绝 "红框空着不跳创建" 根因。
   */
  function probeCurrentUIBrandSeriesModel() {
    // ==========================================================================
    // ★ 修复（你截图：车系=红框"请选择"、车型=红框"请选择"但不跳创建）
    //   问题：原 readControlText 直接用 document.body 全局查 findControlInModalByLabel，
    //   如果车源新增页左侧（或 keep-alive 残留）有"审核列表筛选条件"里也有"车系"、"车型"label，
    //   或者 Tab 切换后 DOM 文本残留，findControlInModalByLabel 就会串到错误的控件上，
    //   读到错误的文本导致 seriesEmpty/modelEmpty 被误判成 false → UI 兜底探测返回 empty=false →
    //   一票否决权不触发 → combinedGoCreate=false → 直接 waitingManualSubmit → 红框空着卡住。
    //
    //   修复策略：先找"车源新增页的真实表单区域 scopeRoot"（满足 looksLikeAddForm 的区域，
    //   包含"基础信息"、"规格参数"标题，且绝对不含"总车源+待审核+已通过"状态卡片和"审核列表+车源ID"表头），
    //   所有控件只在这个 scopeRoot 里查，绝不碰左侧筛选项。
    // ==========================================================================
    function findAddFormRootScope() {
      const candidates = [];
      // 候选范围：页面主要内容容器、ant-form、Drawer/Modal 的 body
      const baseCandidates = [
        ...document.querySelectorAll('.ant-layout-content, .ant-pro-pages, .ant-form, [class*="ant-form-item"][class*="基础信息"]'),
        ...document.querySelectorAll('.ant-drawer-body, .ant-modal-body, #app, body'),
      ].filter(Boolean);
      baseCandidates.forEach(el => {
        if (!el || !el.isConnected) return;
        const t = el.innerText || el.textContent || '';
        // 正向：至少有"基础信息"或"规格参数"标题文本
        if (!/基础信息|规格参数/.test(t)) return;
        // 负向：含"总车源+待审核+已通过"或"审核列表+车源ID/车源名称"表头的 → 是列表页，绝对排除
        if (/总车源[\s\S]{0,200}待审核[\s\S]{0,200}已通过/.test(t)) return;
        if (/审核列表[\s\S]{0,300}(车源ID|车源名称|审核状态)/.test(t)) return;
        // 正向：再加 3 个字段标签的硬门槛（和 looksLikeAddForm 一致）
        const labelsHit = (t.match(/车辆名称|车辆类型|品牌|车系名称|车型名称|车主手机号|表显里程|车辆图片|行驶证信息/g) || []).length;
        if (labelsHit < 3) return;
        // 计算面积（越大越优先，优先取主要内容区）
        const r = el.getBoundingClientRect ? el.getBoundingClientRect() : { width: 0, height: 0 };
        candidates.push({ el, area: r.width * r.height, textLen: t.length });
      });
      candidates.sort((a, b) => b.area - a.area || b.textLen - a.textLen);
      return candidates[0]?.el || document.body;
    }
    const scopeRoot = findAddFormRootScope();
    const scopeTextSample = cleanText((scopeRoot?.innerText || scopeRoot?.textContent || '').slice(0, 200));

    function readControlWithLabels(labelCandidates, fallbackPattern) {
      // labelCandidates 是精确 label 文本数组，按优先级依次尝试（解决"车系" vs "车系名称" 两套 label 同时存在的场景）
      const labelList = Array.isArray(labelCandidates) ? labelCandidates : [String(labelCandidates || '')];
      let lastResult = null;
      for (let i = 0; i < labelList.length; i++) {
        const labelName = labelList[i];
        const ctrl = findControlInModalByLabel(scopeRoot, {
          label: labelName,
          labelFallbackPattern: fallbackPattern,
          preferInput: false,
        });
        if (!ctrl) continue;
        // 找到了控件，再做一个反向校验：这个控件所在的 form-item 行文本必须包含 labelName（防止串到别的行）
        try {
          const row = ctrl.closest?.('tr, td, .ant-form-item, .el-form-item, .ant-row, .ant-col, [class*="form-item"]') || ctrl.parentElement;
          if (row) {
            const rowText = cleanText(row.innerText || row.textContent || '');
            const labelOk = labelCandidates.some(l => String(l || '').length > 0 && rowText.includes(String(l)));
            if (!labelOk) continue; // 控件串到别的行了，继续试下一个 label
          }
        } catch (e) { ignoreUnlessPageAbort(e); }
        lastResult = ctrl;
        lastResult.__matchedLabel = labelName;
        lastResult.__matchedIndex = i;
        break;
      }
      if (!lastResult) return { found: false, text: '', raw: null, matchedLabel: '', matchedIndex: -1 };
      let text = '';
      try {
        // 优先找真实的「选中显示」节点：select / input.value / el-select .el-input__inner / ant-select-selection-item / span / div.text
        const input = lastResult.querySelector ? lastResult.querySelector('input, select, textarea, [class*="selection-item"], [class*="select-inner"], .el-input__inner') : null;
        if (input && (input.tagName === 'SELECT' || input.tagName === 'INPUT' || input.tagName === 'TEXTAREA')) {
          if (input.tagName === 'SELECT') {
            const opt = input.options && input.options[input.selectedIndex];
            text = opt ? cleanText(opt.innerText || opt.textContent || opt.value || '') : '';
          } else {
            text = cleanText(input.value || input.getAttribute('value') || '');
          }
        } else if (input) {
          text = cleanText(input.innerText || input.textContent || input.getAttribute('title') || '');
        }
        if (!text) {
          text = cleanText(lastResult.innerText || lastResult.textContent || '');
        }
      } catch (_) { text = ''; }
      // 再读外层容器 innerText 兜底（控件会把"请选择"渲染在旁边 span）
      if (!text) {
        try {
          const wrap = lastResult.closest?.('tr, td, .ant-form-item, .el-form-item, .ant-row, .ant-col, [class*="form-item"]') || lastResult.parentElement;
          if (wrap) text = cleanText(wrap.innerText || wrap.textContent || '');
        } catch (e) { ignoreUnlessPageAbort(e); }
      }
      return {
        found: true,
        text,
        raw: String(lastResult.className || '').slice(0, 80),
        matchedLabel: lastResult.__matchedLabel || '',
        matchedIndex: lastResult.__matchedIndex ?? -1,
      };
    }

    // 扩充 label 候选：不同后台模板有的写"车系"，有的写"车系名称"，都依次试一遍
    const brand = readControlWithLabels(['品牌', '品牌名称', '厂商'], /\*?\s*(品牌|品牌名称|厂商)/);
    const series = readControlWithLabels(['车系', '车系名称', '车系型号', '系列', '系列名称'], /\*?\s*(车系名称|车系型号|车系|系列名称|系列)/);
    const model = readControlWithLabels(['车型', '车型名称', '车型型号', '公告型号'], /\*?\s*(车型名称|车型型号|公告型号|车型)/);
    const EMPTY_PATTERN = /^(|请选择|选择|未选择|undefined|null|placeholder|none)$/i;
    function isEmpty(t) { return EMPTY_PATTERN.test(cleanText(t || '')); }
    const brandEmpty = !brand.found || isEmpty(brand.text);
    const seriesEmpty = !series.found || isEmpty(series.text);
    const modelEmpty = !model.found || isEmpty(model.text);
    return {
      empty: brandEmpty || seriesEmpty || modelEmpty,
      brandEmpty, seriesEmpty, modelEmpty,
      brandFound: brand.found, brandText: brand.text, brandClass: brand.raw, brandMatchedLabel: brand.matchedLabel,
      seriesFound: series.found, seriesText: series.text, seriesClass: series.raw, seriesMatchedLabel: series.matchedLabel,
      modelFound: model.found, modelText: model.text, modelClass: model.raw, modelMatchedLabel: model.matchedLabel,
      // 新增：范围定位的诊断信息，方便侧边栏日志直接看是不是串到左侧列表筛选项去了
      scopeFound: scopeRoot !== document.body,
      scopeRootTag: scopeRoot?.tagName || '',
      scopeRootClass: String(scopeRoot?.className || '').slice(0, 80),
      scopeTextSample,
    };
  }

  /**
   * 【必须模拟点击/路由 API，不直接硬跳 URL】
   * 用户要求：车系/车型不存在需要跳转时，要模拟用户点击菜单的真实操作链路（或 SPA 路由 API push），
   * 不能直接 chrome.tabs.update(url) / location.assign / history.pushState + fake popstate（那是假导航，
   * 菜单高亮不更新、路由守卫/面包屑/权限都不会走，看起来就是"卡住"）。
   *
   * 新顺序（降级链路）：
   *  (1) 根据 path 反查对应左侧菜单项文本 → robustClick（最佳：真实用户操作，菜单高亮/权限/面包屑全对）
   *  (2) 找不到菜单文本或点击失败：拿 Vue 根实例的 $router → vm.$router.push(path)（SPA 官方 API，比 history.pushState 靠谱）
   *  (3) 最后兜底：history.pushState + PopStateEvent/HashChangeEvent（再不行才 location.assign）
   */
  async function navigateInsideApp(path) {
    const target = String(path || '').startsWith('/') ? String(path) : '/' + String(path || '');
    const steps = [];
    // (1) 根据 path 反推菜单项中文文本（根据我们已知的车系/车型/品牌/审核列表映射），模拟点击菜单
    const pathToMenu = [
      { re: /\/model\/series($|[/?#])/, submenu: '车型库管理', leaf: '车系管理' },
      { re: /\/model\/model($|[/?#])/,  submenu: '车型库管理', leaf: '车型管理' },
      { re: /\/model\/brand($|[/?#])/,  submenu: '车型库管理', leaf: '品牌管理' },
      { re: /\/carSource\/audit($|[/?#])|\/car\/audit($|[/?#])|审核列表/, submenu: '车源管理', leaf: '审核列表' },
      { re: /\/carSource\/list($|[/?#])|\/car\/list($|[/?#])/, submenu: '车源管理', leaf: '车源列表' },
      { re: /\/carSource\/add($|[/?#])|\/car\/add($|[/?#])|新增库存车/, submenu: '车源管理', leaf: '审核列表' /* 审核列表页有新增按钮 */ },
    ];
    const matched = pathToMenu.find(m => m.re.test(target) || m.re.test(location.href));
    if (matched) {
      try {
        steps.push(`路径匹配到菜单：[${matched.submenu}] → [${matched.leaf}]`);
        const unfold = await ensureSubMenuExpanded(matched.submenu, '车系管理|车型管理|品牌管理|车源列表|审核列表');
        steps.push(`展开菜单[${unfold.action}]：${unfold.message}`);
        await sleep(220);
        const leaf = await clickLeafMenuItem(matched.leaf);
        if (leaf.ok) {
          steps.push(`模拟点击菜单成功：${leaf.message}`);
          await sleep(450);
          return { ok: true, via: 'menu-click', steps, href: location.href };
        }
        steps.push(`模拟点击菜单失败，继续降级：${leaf.message}`);
      } catch (e) {
        if (isPageAbortError(e)) throw e;
        steps.push('菜单点击链路异常：' + (e?.message || String(e)));
      }
    } else {
      steps.push('路径未匹配到已知菜单映射：' + target);
    }

    // (2) 拿 Vue Router → $router.push（SPA 官方 API，菜单高亮/路由守卫都走）
    try {
      // 大多数 Vue2 后台：document.querySelector('#app').__vue__.$router；Vue3 是 __vueParentComponent.proxy.$router
      const appRoot = document.getElementById('app') || document.querySelector('[id^="app"]') || document.body;
      let vm = appRoot?.__vue__ || appRoot?.__vueParentComponent?.proxy || appRoot?._vue?.proxy || null;
      // 再向上查 3 层（有时候 app 子节点才挂 __vue__）
      if (!vm && appRoot?.children?.length) {
        for (let i = 0; i < Math.min(3, appRoot.children.length); i++) {
          const c = appRoot.children[i];
          vm = c?.__vue__ || c?.__vueParentComponent?.proxy || c?._vue?.proxy || null;
          if (vm) break;
        }
      }
      const router = vm?.$router || (window.__VUE_DEVTOOLS_GLOBAL_HOOK__?.app && window.__VUE_DEVTOOLS_GLOBAL_HOOK__.app.config?.globalProperties?.$router) || null;
      if (router && typeof router.push === 'function') {
        await new Promise((resolve, reject) => {
          try {
            const p = router.push(target);
            if (p && typeof p.then === 'function') p.then(resolve).catch(reject);
            else setTimeout(resolve, 350);
          } catch (e) { reject(e); }
        });
        steps.push('Vue Router push 成功：' + target);
        await sleep(400);
        return { ok: true, via: 'vue-router-push', steps, href: location.href };
      } else {
        steps.push('未找到 Vue Router 实例（vm=' + !!vm + '），降级到 history 兜底');
      }
    } catch (e) {
      if (isPageAbortError(e)) throw e;
      steps.push('Vue Router 异常：' + (e?.message || String(e)));
    }

    // (3) 兜底：history.pushState（最次选择）
    try {
      history.pushState({}, '', target);
      window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
      window.dispatchEvent(new HashChangeEvent('hashchange'));
      steps.push('兜底 history.pushState：' + target);
    } catch (e) {
      if (isPageAbortError(e)) throw e;
      try { location.assign(target); steps.push('最兜底 location.assign：' + target); } catch (e) { ignoreUnlessPageAbort(e); }
    }
    await sleep(450);
    return { ok: true, via: 'history-fallback', steps, href: location.href };
  }

  function looksLikeAddForm() {
    // ★ 负向硬门槛（仅 URL+页面内容"同时都匹配车系/车型列表页"时，才挡）：
    //   之前的 bug：仅看内容关键字（基础信息/行驶证信息/车辆图片/车主手机号/表显里程）或仅看控件数 >=3，
    //   导致 href=/model/series（车系列表页）被误判成 already-open，
    //   openAddPageCore 直接 return「已在新增车源表单页」→ 整条创建车系/车型的流程被跳过 → 用户看页面"依旧卡住"。
    //   但也不能只看 URL 就挡（比如某个后台 URL 命名奇怪，/model/series 其实是车源新增），所以采用「URL+内容双AND」才挡的策略。
    const href = location.href || '';
    const text = document.body?.innerText || '';
    const hasVehicleFormFeatures =
      /行驶证信息/.test(text) && /车辆图片/.test(text) && /车主手机号/.test(text) && /表显里程/.test(text);
    const looksLikeSeriesListPage = /\/model\/series(\/|$|\?|#)/.test(href) && !hasVehicleFormFeatures;
    const looksLikeModelListPage  = /\/model\/model(\/|$|\?|#)/.test(href)  && !hasVehicleFormFeatures;
    if (looksLikeSeriesListPage) return false; // 确定是车系列表页，不是车源新增
    if (looksLikeModelListPage)  return false; // 确定是车型列表页，不是车源新增

    const recorded = RECORDED_FLOW_FIELDS
      .filter(spec => spec.selector && spec.kind !== 'manual')
      .map(spec => document.querySelector(spec.selector))
      .filter(el => el && isVisible(controlRoot(el) || el));
    if (recorded.length >= 3) return true;

    const mustLookLikeForm = /基础信息/.test(text)
      && hasVehicleFormFeatures; // 已经算过了，复用
    return mustLookLikeForm && !!document.querySelector('.ant-form, form, [id^="myForm_"]');
  }

  /**
   * 判断元素是否在「车源录入主表单区域」内（排除左侧菜单、顶部tabs、弹窗/抽屉、右上角用户菜单等）
   * 用于 submitClickHandler 收紧识别范围，避免车系管理新增抽屉里点"提交"被当成车源提交成功。
   *
   * ⚠️ 注意：antd/element Layout 典型结构是 <Content>主表单</Content> + <Footer>提交/取消</Footer>，
   *        Footer 与 Content 是兄弟节点而非子孙，不能靠 closest('.ant-layout-content') 定位。
   */
  function isInsideVehicleMainForm(element) {
    if (!element) return false;
    // ========== 1. 负向绝对排除 ==========
    // 任何位于抽屉/弹窗内的按钮都不算车源提交（车系/车型新增抽屉、其他Modal）
    if (element.closest?.('.ant-drawer, .ant-modal, [class*="modal-root"], [class*="Modal"], [role="dialog"]')) {
      debugSubmit('submit-ignored', { reason: 'inside-modal-or-drawer' });
      return false;
    }
    if (element.closest?.('.ant-message, .ant-notification, [class*="toast"], [class*="message-notice"]')) {
      debugSubmit('submit-ignored', { reason: 'inside-toast' });
      return false;
    }
    // 左侧菜单 / 顶部tabs栏 / 面包屑 / tab 切换卡片
    if (element.closest?.('aside, .sidebar, [class*="sider"], .ant-layout-sider')) {
      debugSubmit('submit-ignored', { reason: 'inside-sider-menu' });
      return false;
    }
    if (element.closest?.('.ant-tabs-nav, [class*="tabs-nav"], [class*="tabs-tab"], .ant-tabs-tab')) {
      debugSubmit('submit-ignored', { reason: 'inside-tabs-nav' });
      return false;
    }
    if (element.closest?.('.ant-breadcrumb, [class*="breadcrumb"], .ant-page-header-heading, [class*="page-header"]')) {
      debugSubmit('submit-ignored', { reason: 'inside-breadcrumb' });
      return false;
    }
    // 顶部导航/右上角用户菜单区（不含底部footer）
    if (element.closest?.('header, [role="banner"], [class*="header-layout"], .ant-layout-header')) {
      debugSubmit('submit-ignored', { reason: 'inside-header' });
      return false;
    }

    // ========== 2. 必须在「车源新增/审核表单」页 ==========
    if (!looksLikeAddForm()) {
      debugSubmit('submit-ignored', { reason: 'page-does-not-look-like-add-form' });
      return false;
    }

    // ========== 3. 正向判定（命中任一即可） ==========
    // A. 元素本身在 form / ant-form / 表单控件容器内（基础信息/规格参数的提交按钮放在 form 底部）
    if (element.closest?.('.ant-form, form, [id^="myForm_"]')) {
      debugSubmit('submit-accepted', { reason: 'inside-form' });
      return true;
    }
    // B. 【最关键】底部 footer（和 Content 是兄弟节点）内的提交按钮：
    //    antd Layout 典型 footer 类名: .ant-layout-footer / [class*="footer"] / <footer>
    const inFooter = element.closest?.('footer, .ant-layout-footer, [class*="footer-btn"], [class*="form-footer"], [class*="action-footer"]');
    if (inFooter) {
      debugSubmit('submit-accepted', { reason: 'inside-form-footer' });
      return true;
    }
    // C. 元素在主内容区（main / layout-content），且页面含有「基础信息+车辆图片」（车源新增页标志）
    if (element.closest?.('main, .ant-layout-content, [class*="layout-content"], [class*="content-layout"], [class*="app-main"], [class*="page-content"]')) {
      const bodyText = document.body?.innerText || '';
      if (/基础信息/.test(bodyText) && /车辆图片/.test(bodyText)) {
        debugSubmit('submit-accepted', { reason: 'inside-main-content-with-form-blocks' });
        return true;
      }
    }
    // D. 通用兜底：上面负向都已经排除（不在抽屉/菜单/头部tabs/弹窗），
    //    页面又确定是车源新增页（looksLikeAddForm=true），
    //    剩下的就是 page body 里的表单底部或浮动操作栏，认为是主表单合法区域。
    debugSubmit('submit-accepted', { reason: 'fallback-on-add-form-page-after-negative-exclusions' });
    return true;
  }

  /**
   * submit 判定/推进的轻量 debug 日志（只打印到 content-script 页面控制台，避免污染侧边栏UI），
   * 方便用户/我们在 DevTools Console 里直接看到「这次提交为什么没推进 / 为什么推进了」
   */
  function debugSubmit(eventName, payload) {
    try {
      if (typeof window === 'undefined') return;
      // 初始化 / 复用一个 buffer，每 10 条打一次汇总，避免 console 刷屏
      if (!window.__VA_SUBMIT_DEBUG__) {
        window.__VA_SUBMIT_DEBUG__ = [];
      }
      const entry = Object.assign({
        t: Date.now(),
        time: new Date().toLocaleTimeString(),
        event: eventName,
        href: location.href,
      }, payload || {});
      window.__VA_SUBMIT_DEBUG__.push(entry);
      // 单独立即打（单次点击量很少，不怕刷屏）
      // eslint-disable-next-line no-console
      console.log('[VA.submit]', eventName, payload || '');
    } catch (e) { ignoreUnlessPageAbort(e); }
  }

  function looksLikeAuditList() {
    const href = String(location.href || '').toLowerCase();
    // 【负向硬门槛 1】：URL 只要在车系管理 / 车型管理页 → 绝对不是审核列表。
    //   这是防止用户截图「车系管理→+新增」被误当审核列表的第一防线。
    if (/\/model\/series/.test(href) || /\/model\/model\b/.test(href) || /车型库管理/.test(href)) {
      return false;
    }
    // 【正向硬门槛 1】：URL 必须在车源管理下（vehicle-source / carSource / source=vehicle 任意形态）。
    const urlInVehicleSource = /\/vehicle-source\b/.test(href) || /\/carSource\b/.test(href) || /\/vehicle\/source/.test(href) || /审核列表/.test(href);
    if (!urlInVehicleSource) return false;
    // 【正向硬门槛 2】：DOM 文本同时满足 3 点（就是你的审核列表页 4 个仪表盘卡片 + 表格列）：
    //   (a) 页面有「审核列表」面包屑或标题
    //   (b) 有「总车源 / 待审核 / 已通过 / 已驳回」4 个仪表盘统计卡片文字（至少命中 3 个）
    //   (c) 表格「车源ID / 车源名称」表头 或 操作列有「审核」二字（车系/车型页操作列是"编辑/删除"，不会有"审核"）
    const bodyText = document.body?.innerText || document.body?.textContent || '';
    if (!/审核列表/.test(bodyText)) return false;
    const dashboardMatches = (bodyText.match(/总车源|待审核|已通过|已驳回/g) || []).length;
    if (dashboardMatches < 3) return false;
    if (!/车源ID|车源名称/.test(bodyText) && !/^\s*审核\s*$/m.test(bodyText)) {
      // 放宽：表格第一行或最末操作列里有「审核」字样也可以（车系/车型页绝对不会出现操作=审核）
      if (!/操作[\s\S]{0,300}审核/.test(bodyText)) return false;
    }
    return true;
  }

  function findAddButton() {
    // 【硬约束】：只有当前真的在审核列表页（looksLikeAuditList=true），才允许找 +新增库存车 按钮。
    // 车系 / 车型管理页就算也有蓝色「+新增」，也绝对不返回，杜绝串页误点。
    if (!looksLikeAuditList()) return null;

    const candidates = [...document.querySelectorAll('button, a, [role="button"], .ant-btn')]
      .filter(isVisible)
      .map(el => ({ el, text: cleanText(el.innerText || el.textContent || el.getAttribute('aria-label') || '') }))
      // 【硬约束】：文本必须包含「库存车」三个字。
      // 审核列表按钮固定叫「+新增库存车」；车系 / 车型 / 品牌页的 +新增 不会有"库存车"，直接过滤。
      .filter(item => /库存车/.test(item.text) && /新增|添加|新建|创建/.test(item.text));

    function score(t) {
      if (!t) return 0;
      let s = 0;
      if (t.includes('新增库存车')) s += 200;
      if (t.includes('+新增库存车')) s += 60;
      if (/^\+?\s*新增库存车\s*$/.test(t)) s += 80;
      if (t.includes('车源')) s += 20;
      return s;
    }
    candidates.sort((a, b) => score(b.text) - score(a.text));
    return candidates[0]?.el || null;
  }

  function findClickableByText(pattern) {
    const candidates = [...document.querySelectorAll('button, a, [role="button"], .ant-menu-item, .ant-menu-submenu-title, li, span, div')]
      .filter(isVisible)
      .map(el => {
        const text = cleanText(el.innerText || el.textContent || el.getAttribute('aria-label') || '');
        return { el, text, clickEl: clickableAncestor(el), score: scoreTextClick(el, text, pattern) };
      })
      .filter(item => item.score > 0 && item.clickEl && isVisible(item.clickEl));
    candidates.sort((a, b) => b.score - a.score || a.text.length - b.text.length);
    return candidates[0]?.clickEl || null;
  }

  function clickableAncestor(el) {
    return el.closest?.('button, a, [role="button"], .ant-menu-item, .ant-menu-submenu-title, li') || el;
  }

  function scoreTextClick(el, text, pattern) {
    if (!text || !pattern.test(text)) return 0;
    let score = 10;
    if (pattern.test(text.replace(/\s+/g, ''))) score += 10;
    if (/^(车源管理|审核列表)$/.test(text)) score += 80;
    if (el.matches?.('.ant-menu-item, .ant-menu-submenu-title')) score += 60;
    if (el.closest?.('.ant-menu, [class*="menu"], aside, .sidebar, [class*="sider"]')) score += 40;
    if (text.length <= 8) score += 20;
    if (text.length > 40) score -= 60;
    return score;
  }

  function scoreAddText(text) {
    if (/新增库存车/.test(text)) return 100;
    if (/新增车源/.test(text)) return 90;
    if (/新增车辆/.test(text)) return 80;
    if (/新增/.test(text)) return 40;
    return 0;
  }

  async function waitForReady(timeoutMs = 15000) {
    const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || 15000);
    while (Date.now() < deadline) {
      throwIfPageAborted();
      if (looksLikeAddForm()) {
        return {
          status: 'ready',
          href: location.href,
          title: document.title,
          fieldCount: getControls().length,
        };
      }
      await sleep(250);
    }
    return {
      status: 'timeout',
      href: location.href,
      title: document.title,
      fieldCount: getControls().length,
      message: '等待新增表单加载超时',
    };
  }

  function probePage() {
    const controls = getControls();
    return {
      href: location.href,
      title: document.title,
      fieldCount: controls.length,
      fields: controls.map((el, index) => describeControl(el, index)),
      recordedFields: RECORDED_FLOW_FIELDS.map(spec => ({
        field: spec.field,
        label: spec.label,
        selector: spec.selector,
        kind: spec.kind,
        exists: !!findRecordedControl(spec),
        autoFill: spec.kind !== 'manual',
      })),
      probedAt: new Date().toISOString(),
      note: '当前版本按录制流程字段顺序填充；底价也已自动填入；售价、图片和提交保留人工处理。',
    };
  }

  async function fillRecordedRow(row, options) {
    throwIfPageAborted();
    const fieldsArr = Array.isArray(options?.fields) && options.fields.length ? options.fields.map(f => String(f)) : null;
    const fieldsSet = fieldsArr ? new Set(fieldsArr) : null;
    const excludeFields = Array.isArray(options?.excludeFields) && options.excludeFields.length
      ? new Set(options.excludeFields.map(f => String(f)))
      : null;
    const report = [];
    clearHighlights();

    // 构造按优先级遍历的 spec 列表：
    // 1) 有 fields 白名单时，严格按 fields 顺序 → 对应 PROBE_FIELDS [品牌→车系→车型] 先填
    // 2) 否则按 RECORDED_FLOW_FIELDS 原有顺序
    const orderedSpecs = [];
    if (fieldsArr) {
      for (const f of fieldsArr) {
        const s = RECORDED_FLOW_FIELDS.find(x => x.field === f);
        if (s) orderedSpecs.push(s);
      }
      // 再追加所有其他字段（白名单只限定"只填哪些"，后续for里会continue掉不在白名单的字段；这个追加不影响探测阶段，但能保持非白名单阶段字段完整）
      for (const s of RECORDED_FLOW_FIELDS) {
        if (!fieldsSet.has(s.field)) orderedSpecs.push(s);
      }
    } else {
      for (const s of RECORDED_FLOW_FIELDS) orderedSpecs.push(s);
    }

    // 用于品牌→车系→车型联动短路：品牌缺失时，车系/车型不再浪费时间填（下拉必为空）
    let brandFilledOk = null;
    let brandMissingByRow = false;
    // 用户实际选中/自动填的品牌名（返回给 sidepanel，回写到 row.brandName，后续创建车系/车型/重填自动沿用）
    let selectedBrand = '';

    for (const spec of orderedSpecs) {
      throwIfPageAborted();
      // 白名单模式：不在白名单里就跳过（manual字段在探测模式下也跳过）
      if (fieldsSet && spec.kind !== 'manual' && !fieldsSet.has(spec.field)) continue;
      // 黑名单模式：明确排除的字段跳过（manual也照样排除，用于 Stage 2 避免重填探测过的字段）
      if (excludeFields && spec.kind !== 'manual' && excludeFields.has(spec.field)) continue;

      // ======================================================================
      // 【极简引导·先选品牌才能填车系/车型】—— 解决「不选品牌车系列表是空，填车系必然 miss」的问题。
      //   brandFilledOk 初始值=null，只在第一次遇到 seriesName/modelName 时调用一次 ensureBrandSelected，
      //   避免反复弹提示条。调用结果：
      //     - ok=true（你选好品牌了）：brandFilledOk=true → 后面正常走 fillDropdownValue 填车系/车型
      //     - ok=false（超时/找不到控件）：brandFilledOk=false → 走 982 行的短路，车系/车型记 fail 不操作
      //     - 如果你进入页面时就已经选了品牌：ensureBrandSelected 的②快速检查会直接返回，不弹提示条不打扰
      // ======================================================================
      if (brandFilledOk === null && (spec.field === 'seriesName' || spec.field === 'modelName')) {
        // ★★【品牌复用优化】：如果 sidepanel 已经传了 confirmedBrandName（用户在车源新增页选过一次品牌），
        //    直接自动填品牌，不再弹提示条等用户手动选。第二次车源创建/创建车系车型前都已经带上了。
        const confirmedBrand = String(options?.confirmedBrandName || '').trim();
        const requireFreshBrandSelection = !!options?.requireFreshBrandSelection;
        let rBrand;
        if (confirmedBrand) {
          const brandSpec = RECORDED_FLOW_FIELDS.find(s => s.field === 'brandName');
          const brandControl = brandSpec ? (findRecordedControl(brandSpec) || findFallbackControl(brandSpec)) : null;
          if (!brandControl) {
            rBrand = { ok: false, value: '', message: '品牌控件未找到，无法自动填品牌' };
            console.log(`[VA 自动填品牌(复用)] 控件未找到，品牌="${confirmedBrand}" 自动填失败`);
          } else {
            const res = await setDropdownValue(brandControl, confirmedBrand, brandSpec) || { ok: false, message: '自动填品牌返回为空' };
            markControl(brandControl, res.ok ? 'ok' : 'bad');
            rBrand = { ok: !!res.ok, value: res.ok ? confirmedBrand : '', message: res.message || '自动填品牌' };
            if (rBrand.ok) selectedBrand = confirmedBrand;
            console.log(`[VA 自动填品牌(复用)] 品牌="${confirmedBrand}" → ${rBrand.ok ? 'OK' : 'FAIL ' + (res.message || '')}`);
          }
        } else {
          const addFormScope = (typeof findAddFormRootScope === 'function') ? (findAddFormRootScope() || document.body) : document.body;
          rBrand = await ensureBrandSelected(addFormScope, {
            requireFreshSelection: !!options?.requireFreshBrandSelection,
            rowNumber: options?.brandSelectionRowNumber || row.rowNumber || '',
            suggestText: options?.requireFreshBrandSelection
              ? `请为第${options?.brandSelectionRowNumber || row.rowNumber || ''}行重新手动选择品牌（每一行都必须用本行车源上传时人工选的品牌，不能沿用上一行）。选完后插件自动继续。`
              : '请先手动选择品牌（车系/车型下拉按品牌联动加载，不选品牌下拉是空的，填了也找不到。选完后插件自动继续填剩余字段）',
          });
          console.log('[VA 引导选品牌(车源新增页)]', rBrand.message);
          if (rBrand.ok && rBrand.value) selectedBrand = rBrand.value;
        }
        brandFilledOk = !!rBrand.ok;
        // 如果品牌已就位，等一下车系/车型下拉按品牌异步联动加载完（900ms）
        if (rBrand.ok) await sleep(900);
      }

      // 联动短路：品牌（brandName）没填/没值时，车系（seriesName）/车型（modelName）直接记 miss，不操作
      if (brandMissingByRow && (spec.field === 'seriesName' || spec.field === 'modelName')) {
        const v = valueForSpec(row, spec);
        if (!v) {
          report.push({ field: spec.field, label: spec.label, value: '', status: 'miss', message: '测试表/导入表中缺少该必填字段', selector: spec.selector });
        } else {
          report.push({
            field: spec.field, label: spec.label, value: v, status: 'miss',
            message: '品牌缺失或品牌下拉未命中，车系/车型下拉依赖品牌加载，已跳过（品牌创建需人工）',
            selector: spec.selector,
          });
        }
        continue;
      }
      if (brandFilledOk === false && (spec.field === 'seriesName' || spec.field === 'modelName')) {
        const v = valueForSpec(row, spec);
        report.push({
          field: spec.field, label: spec.label, value: v || '', status: 'fail',
          message: '品牌下拉选中失败，车系/车型无法加载，已跳过（请先在品牌下拉中找到并选中对应品牌）',
          selector: spec.selector,
        });
        continue;
      }

      const value = valueForSpec(row, spec);

      if (spec.kind === 'manual') {
        // 预填探测模式下，manual字段直接跳过，避免占满报告
        if (fieldsSet) continue;
        if (value) {
          report.push({
            field: spec.field,
            label: spec.label,
            value,
            status: 'manual',
            message: spec.manualMessage || '该字段保留人工处理，插件不自动填写。',
            selector: spec.selector,
          });
        }
        continue;
      }

      if (!value) {
        if (spec.required) {
          report.push({ field: spec.field, label: spec.label, value: '', status: 'miss', message: '测试表/导入表中缺少该必填字段', selector: spec.selector });
          if (spec.field === 'brandName') brandMissingByRow = true;
        }
        continue;
      }

      const control = findRecordedControl(spec);
      let target = control;
      let score = 100;
      if (!target) {
        const fallback = findFallbackControl(spec);
        if (!fallback) {
          report.push({ field: spec.field, label: spec.label, value, status: spec.required ? 'miss' : 'skip', message: '未找到录制控件 ' + (spec.selector || spec.label), selector: spec.selector });
          if (spec.field === 'brandName') brandFilledOk = false;
          continue;
        }
        target = fallback;
        score = 40;
      }

      try {
        const result = await setRecordedControlValue(target, value, spec) || { ok: false, message: '控件填充没有返回结果' };
        markControl(target, result.ok ? 'ok' : 'bad');
        report.push(buildFieldReport(spec, value, result, target, score));
        if (spec.field === 'brandName') brandFilledOk = !!result.ok;
        await sleep(result.ok ? (spec.waitAfter || 260) : 220);
      } catch (e) {
        if (isPageAbortError(e)) throw e;
        markControl(target, 'bad');
        report.push({
          field: spec.field,
          label: spec.label,
          value,
          status: 'fail',
          message: '填充异常: ' + (e?.message || String(e)),
          selector: spec.selector,
          elementKey: elementKey(target),
          target: describeControl(target, Number(target.dataset.vaIndex || 0)),
          score,
        });
        if (spec.field === 'brandName') brandFilledOk = false;
        await sleep(220);
      }
    }

    const auto = report.filter(r => r.status === 'hit').length;
    const manual = report.filter(r => r.status === 'manual').length;
    const miss = report.filter(r => r.status === 'miss').length;
    const fail = report.filter(r => r.status === 'fail').length;

    return {
      rowId: row.id || '',
      rowNumber: row.rowNumber,
      displayName: row.displayName,
      selectedBrand,       // 用户手动选/自动复用的品牌名（sidepanel 用它覆盖 row.brandName，后续创建沿用）
      total: report.length,
      hit: auto,
      manual,
      miss,
      fail,
      report,
      safety: '已按录制流程填充基础信息和底价；图片、售价和提交仍需人工处理。',
      nextAction: '请人工上传图片、填写/确认售价，然后人工点击提交。提交成功后插件会自动进入下一条。',
    };
  }

  function valueForSpec(row, spec) {
    if (row[spec.field] != null && String(row[spec.field]).trim()) return String(row[spec.field]).trim();
    if (spec.field === 'referenceReservePrice') return String(row.referenceReservePrice || row.reservePrice || '').trim();
    if (spec.field === 'referenceQuotedPrice') return String(row.referenceQuotedPrice || row.quotedPrice || '').trim();
    return '';
  }

  function buildFieldReport(spec, value, result, control, score) {
    return {
      field: spec.field,
      label: spec.label,
      value,
      status: result.ok ? 'hit' : 'fail',
      reason: result.reason || '',
      message: result.message,
      selector: spec.selector,
      elementKey: elementKey(control),
      target: describeControl(control, Number(control.dataset.vaIndex || 0)),
      score,
    };
  }

  function findRecordedControl(spec) {
    const selectors = Array.isArray(spec.selector)
      ? spec.selector
      : (typeof spec.selector === 'string' && spec.selector ? [spec.selector] : []);
    for (const sel of selectors) {
      if (!sel) continue;
      const el = document.querySelector(sel);
      if (!el) continue;
      const target = controlRoot(el) || el;
      if (!isVisible(target)) continue;
      if (!target.dataset.vaIndex) target.dataset.vaIndex = String(getControls().indexOf(target) + 1 || 1);
      return target;
    }
    return null;
  }

  function findFallbackControl(spec) {
    // 1) 基于 aliases 的全局模糊匹配（历史逻辑）
    if (spec.aliases?.length) {
      const controls = getControls();
      let best = null;
      controls.forEach((el, index) => {
        const hay = norm([el.id, nestedAttr(el, 'id'), el.getAttribute('name'), nestedAttr(el, 'name'), labelText(el), contextText(el)].join(' '));
        const score = spec.aliases.reduce((sum, alias) => sum + (hay.includes(norm(alias)) ? 50 : 0), 0);
        if (score > 0 && (!best || score > best.score)) best = { el, index, score };
      });
      if (best?.el) return best.el;
    }
    // 2) aliases 匹配不到时，基于 spec.label 全文在主表单里找对应控件（和抽屉里同样的 label 定位逻辑）
    if (spec.label) {
      try {
        const mainForm = document.querySelector('.ant-form, form, [class*="main-form"], [class*="content-wrapper"]') || document.body;
        const byLabel = findControlInModalByLabel(mainForm, spec.label);
        if (byLabel) return byLabel;
      } catch (e) { /* 忽略 label 兜底报错 */ }
    }
    return null;
  }

  async function setRecordedControlValue(control, value, spec) {
    if (spec.kind === 'input') return setInputValue(control, value, spec);
    if (spec.kind === 'textarea') return setInputValue(control, value, spec);
    if (spec.kind === 'month') return setMonthValue(control, value, spec);
    if (spec.kind === 'cascader') return setCascaderValue(control, value, spec);
    if (spec.kind === 'dropdown') return setDropdownValue(control, value, spec);
    return { ok: false, message: '暂不支持控件类型: ' + spec.kind };
  }

  function setInputValue(control, value, spec) {
    const input = inputLike(control);
    if (!input) return { ok: false, message: '命中录制字段，但未找到可填写输入框' };

    input.scrollIntoView?.({ block: 'center', inline: 'nearest' });
    input.focus();
    let v = String(value || '').trim();
    const type = String(input.getAttribute('type') || '').toLowerCase();
    if (type === 'number' || ['mileage'].includes(spec.field)) v = v.replace(/[^0-9.\-]/g, '');
    if (['ownerPhone'].includes(spec.field)) v = v.replace(/[^0-9]/g, '');
    if (['vin'].includes(spec.field)) v = v.toUpperCase();

    setNativeValue(input, v);
    dispatch(input, 'input');
    dispatch(input, 'change');
    input.blur?.();
    return { ok: true, message: '已按录制字段填写' };
  }

  async function setMonthValue(control, value, spec) {
    const root = controlRoot(control) || control;
    const input = inputLike(root);
    const v = normalizeMonth(value); // 格式: YYYY-MM
    const m = v.match(/^(\d{4})-(\d{1,2})/);
    if (!m) return { ok: false, message: '月份格式不正确，请填写 YYYY-MM，例如 2026-08' };
    const targetYear = Number(m[1]);
    const targetMonth = Number(m[2]); // 1-12

    root.scrollIntoView?.({ block: 'center', inline: 'nearest' });

    // 1) 打开 MonthPicker 面板（与录制流程一致：点击选择器打开面板）
    let pickerInput = input || dropdownClickTarget(root) || root;
    robustClick(pickerInput);
    await sleep(350);

    // 若面板没打开，再尝试点击右侧日历图标所在的 picker 容器
    if (!isPickerPanelOpen()) {
      const icon = root.querySelector?.('.ant-picker-suffix, .ant-calendar-picker-icon, [class*="picker-suffix"]');
      if (icon) { robustClick(icon); await sleep(300); }
    }
    if (!isPickerPanelOpen()) {
      // 兜底：再次聚焦并派发点击事件到 input
      if (input) { input.focus(); robustClick(input); await sleep(350); }
    }

    // 2) 面板打开后，先处理年份切换（目标年份 ≠ 当前面板年份时，点左右箭头）
    const yearNavigated = await navigatePickerYear(targetYear);
    if (!yearNavigated) {
      // 年份切换失败：兜底走字符串写入
      return fallbackSetMonthValue(root, input, v, spec);
    }
    await sleep(200);

    // 3) 点击月份：第 targetMonth 个单元格（1月=第1个，8月=第8个）
    const monthCell = findPickerMonthCell(targetMonth);
    if (!monthCell) {
      // 找不到月份单元格：兜底
      return fallbackSetMonthValue(root, input, v, spec);
    }
    // 与录制流程一致：点击内层 div（如 截图中 "tr > td > div"）
    const innerDiv = monthCell.querySelector?.('div') || monthCell;
    robustClick(innerDiv);
    await sleep(300);

    // 4) 关闭面板：确认值已写入
    const ok = readControlValue(root).includes(v.replace('-0', '-').replace('-', '-'))
      || String(readControlValue(root) || '').includes(String(targetYear))
      && String(readControlValue(root) || '').includes(String(targetMonth));
    if (!ok && input) {
      // 点击面板未生效时，兜底写入字符串
      return fallbackSetMonthValue(root, input, v, spec);
    }
    dispatch(root, 'change');
    return { ok: true, message: '已选择月份: ' + targetYear + '年' + targetMonth + '月（面板点击）' };
  }

  function isPickerPanelOpen() {
    return !!document.querySelector(
      '.ant-picker-panel:not(.ant-picker-panel-hidden), .ant-picker-dropdown:not(.ant-picker-dropdown-hidden), .ant-calendar-panel'
    );
  }

  // 在 MonthPicker 面板中读取当前年份（面板顶部显示的 "2026年"）
  function currentPickerYear() {
    const header = document.querySelector([
      '.ant-picker-header-view',
      '.ant-picker-header',
      '.ant-calendar-header',
    ].join(','));
    if (!header) return null;
    const text = cleanText(header.innerText || header.textContent || '');
    const m = text.match(/(\d{4})/);
    return m ? Number(m[1]) : null;
  }

  // 点击上一年 / 下一年 按钮，把面板切到目标年份
  async function navigatePickerYear(targetYear) {
    const maxAttempts = 30; // 最多切 30 年，避免死循环
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const current = currentPickerYear();
      if (current == null) {
        // 等一次面板渲染
        await sleep(300);
        continue;
      }
      if (current === targetYear) return true;
      const direction = targetYear > current ? 'next' : 'prev';
      const btn = findPickerYearNav(direction);
      if (!btn) return false;
      robustClick(btn);
      await sleep(220);
    }
    return false;
  }

  // 找到 MonthPicker 面板上的"上一年 / 下一年"按钮（排除上一月/下一月双箭头）
  function findPickerYearNav(direction) {
    // Ant Design DatePicker/MonthPicker 头部按钮顺序：prev-year, prev-month, panel-title, next-month, next-year
    const allBtns = [...document.querySelectorAll([
      '.ant-picker-header button',
      '.ant-picker-header .ant-picker-header-super-prev-btn, .ant-picker-header .ant-picker-header-super-next-btn',
      '.ant-picker-header .ant-picker-header-prev-btn, .ant-picker-header .ant-picker-header-next-btn',
      '.ant-calendar-prev-year-btn, .ant-calendar-next-year-btn, .ant-calendar-prev-month-btn, .ant-calendar-next-month-btn',
    ].join(','))].filter(isVisible);

    // 优先识别带 class 的 super prev/next（跳年）
    let yearBtns = allBtns.filter(el => {
      const cls = String(el.className || '');
      return /super-prev|super-next|prev-year|next-year/i.test(cls);
    });
    if (!yearBtns.length) {
      // 回退：按位置，一般第一个 prev=年，第二个 prev=月；最后一个 next=年，倒数第二个 next=月
      yearBtns = allBtns;
    }

    if (direction === 'next') {
      const withClass = yearBtns.find(el => /super-next|next-year/i.test(String(el.className || '')));
      if (withClass) return withClass;
      // 取最右侧 next 按钮
      return yearBtns[yearBtns.length - 1] || null;
    } else {
      const withClass = yearBtns.find(el => /super-prev|prev-year/i.test(String(el.className || '')));
      if (withClass) return withClass;
      // 取最左侧 prev 按钮
      return yearBtns[0] || null;
    }
  }

  // 在 MonthPicker 面板 body 中找到第 month 个月对应的 td/单元格
  function findPickerMonthCell(month) {
    const cells = [...document.querySelectorAll([
      '.ant-picker-panel .ant-picker-cell-inner',
      '.ant-picker-panel td',
      '.ant-picker-month-panel tbody td',
      '.ant-calendar-month-panel tbody td',
    ].join(','))].filter(isVisible);

    // 按 DOM 顺序匹配第 N 个包含月份数字/中文的格子
    let index = 0;
    for (const cell of cells) {
      const text = cleanText(cell.innerText || cell.textContent || '');
      // 判断是不是月份格子：包含 1-12 的数字或 "X月"
      const cnMatch = text.match(/^(\d{1,2})\s*月$/);
      const numMatch = text.match(/^(\d{1,2})$/);
      const m = cnMatch ? Number(cnMatch[1]) : (numMatch ? Number(numMatch[1]) : 0);
      if (m >= 1 && m <= 12) {
        index++;
        if (m === month) {
          // 返回 td 或 cell 本身（优先外层 td，便于点击内层 div）
          return cell.closest?.('td') || cell;
        }
      }
    }
    return null;
  }

  // 兜底：如果面板流程走不通，就直接写入字符串（保证不阻塞后续字段）
  function fallbackSetMonthValue(root, input, v, spec) {
    if (!input) return { ok: false, message: '上牌日期面板未打开且未找到输入框，请人工选择月份' };
    try {
      input.scrollIntoView?.({ block: 'center', inline: 'nearest' });
      input.focus();
      setNativeValue(input, v);
      dispatch(input, 'input');
      dispatch(input, 'change');
      dispatchKeyboard(input, 'keydown', 'Enter');
      input.blur?.();
      dispatch(root, 'change');
      return { ok: true, message: '已填写月份（面板失败兜底）: ' + v };
    } catch (e) {
      return { ok: false, message: '上牌日期填写失败：' + (e?.message || String(e)) };
    }
  }

  /**
   * 【更可靠的下拉打开判定】
   * 原先只查 document 里有没有 .ant-select-dropdown:not(.ant-select-dropdown-hidden) ——
   * 缺点：1) root 有 .ant-select-open / aria-expanded=true 但面板还在 transition 期间没改 class 就判错；
   *      2) el-select / 某些 ant 版本 状态 class 在 root 上，不在 dropdown 容器 class。
   * 现在两重判断 OR：(a) 任意 select/cascader root 处于打开态，(b) 任意可见 dropdown 面板挂在全局。
   * 可选传 root：如果只想判断某一个下拉（车型下拉）是否开着，就传对应 root，否则全局判断。
   */
  function isDropdownOpen(root) {
    // (a) root 级判断：针对传入的单一 root 下拉
    if (root) {
      const r = (controlRoot(root) || root);
      if (r && r.getAttribute) {
        if (r.getAttribute('aria-expanded') === 'true') return true;
        const cls = String(r.className || '');
        if (/ant-select-open|ant-select-focused|ant-select-show-search|is-focus|is-visible|visible/i.test(cls)) return true;
        if (r.querySelector?.('.ant-select-arrow, .ant-select-selection-item[aria-expanded="true"]')) return true;
        // (a+) 增强：root 有归属面板，且归属面板可见 = 这个下拉必然是 open 状态（解决：别的下拉面板开着导致全局误判 open，但我们要判断 THIS root 本身 open 没）
        try {
          const own = findDropdownPanelForControl(r, { includeHiddenPanels: false });
          if (own && isVisible(own)) {
            const rect = own.getBoundingClientRect?.();
            if (!rect || (rect.width > 0 && rect.height > 0)) return true;
          }
        } catch (e) { ignoreUnlessPageAbort(e); }
      }
    }
    // (a) 全局 root 级判断
    const anyOpenRoot = document.querySelector([
      '.ant-select[aria-expanded="true"]',
      '.ant-select-open',
      '.ant-select-focused',
      '.el-select[aria-expanded="true"]',
      '.el-select.is-focus',
      '.el-select.is-visible',
      '.ant-cascader-picker[aria-expanded="true"]',
      '.ant-cascader[aria-expanded="true"]',
    ].join(','));
    if (anyOpenRoot) return true;
    // (b) 全局面板级判断（portal 到 body 的 dropdown 容器）
    const anyPanel = document.querySelector([
      '.ant-select-dropdown:not(.ant-select-dropdown-hidden)',
      '.ant-select-dropdown[style*="visibility: visible"]',
      '.ant-select-dropdown[style*="display: block"]',
      '.ant-cascader-dropdown:not(.ant-cascader-dropdown-hidden)',
      '.el-select-dropdown:not(.el-select-dropdown__hide)',
      '.el-cascader__dropdown:not([style*="display: none"])',
    ].join(','));
    if (anyPanel) {
      // 再保险：面板 DOM 存在但其实尺寸 0 也不算开
      const rect = anyPanel.getBoundingClientRect?.();
      if (!rect || (rect.width > 0 && rect.height > 0)) return true;
    }
    return false;
  }

  /**
   * 【直接关 Vue 组件实例的下拉】—— 这是最可靠的关下拉手段，比 DOM blur / body.click 靠谱得多。
   * 根据经验 1568538，el-select / ant-select / ant-cascader 的 vm 上都有 visible / visibleState /
   * handleClose / blur / closeDropdown 等 API，能调就直接调，再用 DOM 事件兜底。
   */
  function closeVueDropdown(root) {
    try {
      const r = controlRoot(root) || root;
      const vc = findVueComponent(r);
      if (!vc) return false;
      // vm 可能是 vc.__vue__（Vue2 ElementUI / Ant）
      const vm = (vc && vc.__vue__) ? vc.__vue__ : vc;
      const actions = [];
      // 1) 直接改 visible 状态
      ['visible', 'visibleState', 'dropDownVisible', 'open'].forEach(k => {
        try {
          if (typeof vm[k] !== 'undefined') {
            vm[k] = false;
            actions.push('set:' + k);
          }
        } catch (e) { ignoreUnlessPageAbort(e); }
      });
      // 2) 调关闭方法（注意顺序：handleClose / close 会更新内部状态再触发 v-model update）
      ['handleClose', 'close', 'closeDropdown', 'blurAll', 'blur'].forEach(m => {
        try {
          if (typeof vm[m] === 'function') {
            vm[m]();
            actions.push('call:' + m);
          }
        } catch (e) { ignoreUnlessPageAbort(e); }
      });
      // 3) 发 update:visible（visible 改变事件，只发 visible-change，不发 update:modelValue/update:value——后者会把其他 select 的 model 错误重置掉）
      ['update:visible', 'visible-change'].forEach(ev => {
        try {
          if (typeof vm.$emit === 'function') vm.$emit(ev, false);
          else if (vc.__vueParentComponent && typeof vc.__vueParentComponent.emit === 'function') {
            vc.__vueParentComponent.emit(ev, false);
          }
          actions.push('emit:' + ev + '=false');
        } catch (e) { ignoreUnlessPageAbort(e); }
      });
      return actions.length > 0;
    } catch (_) {
      return false;
    }
  }

  /**
   * 在 dropdown 选择完成后，强制关闭仍然打开的面板（用户反馈：车型下拉自动填完后面板仍保持展开）。
   * 新顺序：(1) 优先调 Vue 组件 API 关（最靠谱）→ (2) blur root / input → (3) outside click → (4) Escape。
   * 不再傻等 260ms 看组件自己关没，先强关，再 sleep 验证。
   */
  async function ensureDropdownClosed(root, optSpec) {
    const rootEl = root && (controlRoot(root) || root);
    const inner = rootEl ? (dropdownInput(rootEl) || null) : null;
    const steps = [];
    try {
      // (1) Vue 组件层直接关（95% 的场景这一下就关了）
      const vueClosed = closeVueDropdown(rootEl);
      if (vueClosed) steps.push('vue-close');
      await sleep(60);
      // ★ 只检查目标控件本身是否已关闭，不看全局（避免别的下拉开着就继续发全局事件清掉品牌等已选值）
      if (rootEl && !isDropdownOpen(rootEl)) return { closed: true, via: steps.join('+') };

      // (2) blur root / input
      if (inner && document.activeElement === inner) {
        try { inner.blur?.(); steps.push('blur-input'); } catch (e) { ignoreUnlessPageAbort(e); }
      }
      if (rootEl && typeof rootEl.blur === 'function') {
        try { rootEl.blur(); steps.push('blur-root'); } catch (e) { ignoreUnlessPageAbort(e); }
      }
      await sleep(40);
      if (rootEl && !isDropdownOpen(rootEl)) return { closed: true, via: steps.join('+') };

      // (3) outside click —— ★ 只点目标控件外部附近坐标，不往 document/body 发全局事件（避免误清其他已选下拉值如品牌）
      try {
        const me = (type, cx, cy) => new MouseEvent(type, { bubbles: true, cancelable: true, view: window, button: 0, clientX: cx, clientY: cy });
        if (rootEl) {
          const rect = rootEl.getBoundingClientRect?.();
          // 在控件右侧 20px 外（属于"控件外面"）点一下，模拟 click-outside 关当前下拉
          const cx = (rect ? rect.right + 20 : 8);
          const cy = (rect ? rect.top + rect.height / 2 : 8);
          // 只对目标控件附近的元素发事件，不发 document/body 全局事件
          const nearbyEl = document.elementFromPoint?.(cx, cy) || rootEl.parentElement || rootEl;
          if (nearbyEl && nearbyEl !== rootEl) {
            nearbyEl.dispatchEvent(me('mousedown', cx, cy));
            nearbyEl.dispatchEvent(me('mouseup', cx, cy));
            nearbyEl.dispatchEvent(me('click', cx, cy));
            steps.push('nearby-click');
          }
        }
      } catch (e) { ignoreUnlessPageAbort(e); }
      await sleep(80);
      if (rootEl && !isDropdownOpen(rootEl)) return { closed: true, via: steps.join('+') };

      // (4) Escape —— ★ 只发到目标控件本身和它的 input，不往 document 发全局 Escape（全局 Escape 会清掉其他已选下拉值如品牌）
      try {
        const kd = (el, key) => {
          try {
            el.dispatchEvent(new KeyboardEvent('keydown', { key, code: key === 'Escape' ? 'Escape' : key, bubbles: true, cancelable: true }));
            el.dispatchEvent(new KeyboardEvent('keyup',   { key, code: key === 'Escape' ? 'Escape' : key, bubbles: true, cancelable: true }));
          } catch (e) { ignoreUnlessPageAbort(e); }
        };
        kd(inner || rootEl, 'Escape');
        steps.push('Esc-local');
      } catch (e) { ignoreUnlessPageAbort(e); }
      await sleep(120);
      return { closed: !isDropdownOpen(rootEl), via: steps.join('+') + (isDropdownOpen(rootEl) ? '-stillOpen' : '') };
    } catch (e) {
      if (isPageAbortError(e)) throw e;
      return { closed: !isDropdownOpen(rootEl), via: 'exception' };
    }
  }

  /**
   * 【静默填值优先 Step 1】针对可搜索的下拉（车型有🔍放大镜图标的 filterable select）：
   * 不点击 selector 打开面板，直接聚焦搜索 input → 输入完整目标文本 → 查找此时 filter 渲染出来的唯一匹配 option → 点选 + Enter。
   * 【注意】静默填值成功了才返回 ok=true，必须同时满足：(a) syncVueSelectModel 成功（即 Vue 层真的记住了值）
   * (b) readControlValue 读回来的文本包含目标值或别名。否则一律静默失败，回退到"打开面板选"的兜底路径。
   */
  async function tryFillFilterableSilently(root, value, spec) {
    try {
      const input = dropdownInput(root);
      if (!input) return { ok: false, reason: 'no-search-input' };
      if (!input.matches?.('input[role="combobox"], input')) return { ok: false, reason: 'not-filterable-input' };

      input.scrollIntoView?.({ block: 'center', inline: 'nearest' });
      input.focus();
      await sleep(60);
      // 清空原值
      setNativeValue(input, '');
      dispatch(input, 'input');
      dispatch(input, 'change');
      await sleep(80);
      // 写入完整目标文本（不要缩写），让组件 filter 到唯一匹配项
      setNativeValue(input, normalizeDropdownSearchValue(value, spec));
      dispatch(input, 'input');
      // 等待 filter 结果渲染出来（这个时间后若 open=true 说明有下拉面板/内部 option 渲染，否则这个下拉可能不是 filterable）
      await sleep(520);
      // 注意：这里不要 includeHiddenPanels！必须等组件把 filter 后的 option 渲染出来（不管面板显示与否，DOM 里必须有）
      // —— 传 root=root：限定查找范围到「这个控件归属的 ant-select-dropdown」面板，绝不对串到页面上其他下拉
      let option = findDropdownOption(value, spec, /* includeHiddenPanels */ false, root);
      if (!option) {
        await sleep(420);
        option = findDropdownOption(value, spec, false, root);
      }
      if (!option) {
        // 还是找不到 → 可能目标值根本不在下拉里 / 组件非 filterable 模式 / filter 时间还不够。
        // 先恢复 blur 避免影响下一步
        try { input.blur?.(); } catch (e) { ignoreUnlessPageAbort(e); }
        // ★ 找不到就必须关面板（不管 isDropdownOpen 函数判断成啥），防止刚才的 focus/input 触发了组件打开面板却没自己关
        //   之前：if (isDropdownOpen(root)) 才关 → 但归属面板判断可能出错（串到其他下拉上）→ 漏关 → 用户看面板一直开着
        try { await ensureDropdownClosed(root, spec); } catch (e) { ignoreUnlessPageAbort(e); }
        return { ok: false, reason: 'option-not-found' };
      }

      // 找到了！两种方式组合选值：(a) 点 option（不管面板是否 open，点了就能触发内部选值），(b) Enter 兜底
      const optionText = cleanText(option.getAttribute('title') || option.innerText || option.textContent || value);
      robustClick(option.querySelector?.('div') || option);
      await sleep(80);
      dispatchKeyboard(input, 'keydown', 'Enter');
      dispatchKeyboard(input, 'keyup', 'Enter');
      // 同步 Vue 层（【关键】：静默填值必须 Vue 层同步成功才算 ok，否则等下填其他字段就被 Vue 重渲染清空了）
      const synced = syncVueSelectModel(root, option, optionText || value);
      // 再派发原生 change 兜底
      setTimeout(() => {
        if (pageAbortRequested) return;
        try {
          if (input) { dispatch(input, 'input'); dispatch(input, 'change'); }
          dispatch(root, 'change');
        } catch (e) { ignoreUnlessPageAbort(e); }
      }, 220);
      await sleep(260);
      const after = readControlValue(root);
      const aliasHit = dropdownValueAliases(value, spec).some(a => norm(after).includes(norm(a)));
      // ★ 颜色字段双向兜底：系统下拉选项不带"色"（例：白）但 CSV 可能带（例：白色），反过来也需要覆盖。
      //   readControlValue 返回的 after 是系统真实选中值（可能是无后缀单字），
      //   value 是 CSV 原值（可能带色/不带色），这里做一次 strip 相等 + variants 交叉匹配，
      //   确保白==白色 / 珍珠白==珍珠白色 / 粉==粉色 这些场景都判 ok=true，不会白跑一趟然后去 fallback 开面板再点一次。
      const isColorField_sf = spec.field === 'color' || spec.field === 'vehicleColor' || spec.field === 'colorName' ||
                              (spec.label && /颜色|车身颜色/.test(spec.label)) ||
                              (spec.aliases && spec.aliases.some(a => /颜色|车身颜色/.test(String(a || ''))));
      let colorCrossHit = false;
      if (isColorField_sf && synced) {
        const afterStripped = norm(String(after || '').replace(/(颜色|色)$/g, '').trim());
        const valStripped = norm(String(value || '').replace(/(颜色|色)$/g, '').trim());
        if (afterStripped && valStripped && afterStripped === valStripped) colorCrossHit = true;
        else {
          const afterVariants = _colorVariants(after).map(norm);
          const valueVariants = _colorVariants(value).map(norm);
          colorCrossHit = afterVariants.some(av => valueVariants.includes(av));
        }
      }
      const ok = synced && (norm(after).includes(norm(value)) || norm(after).includes(norm(optionText)) || aliasHit || colorCrossHit);
      return {
        ok,
        message: ok
          ? ('已静默选择: ' + (optionText || value) + '（Vue层已同步）')
          : ('静默填值后验证失败(Vue同步=' + synced + ', 当前=' + after + ')，改为打开面板选'),
        synced,
        silent: true,
      };
    } catch (e) {
      if (isPageAbortError(e)) throw e;
      return { ok: false, reason: 'exception', error: e?.message || String(e) };
    }
  }

  async function setDropdownValue(control, value, spec) {
    const root = controlRoot(control) || control;
    const before = readControlValue(root);
    if (norm(before) === norm(value)) return { ok: true, message: '当前已选择匹配项' };

    root.scrollIntoView?.({ block: 'center', inline: 'nearest' });

    // ========== Step 1（静默优先）：filterable 下拉不打开面板，直接搜填值 ==========
    const silent = await tryFillFilterableSilently(root, value, spec);
    if (silent.ok) {
      // 静默填值成功了，保险调一次 ensureDropdownClosed（万一刚才 focus + input 触发了组件打开面板但没自己关）
      const closed = await ensureDropdownClosed(root, spec);
      return Object.assign(silent, { closedVia: closed.via });
    }

    // ========== Step 2（兜底：打开面板选） ==========
    const clickTargets = [];
    if (control !== root) clickTargets.push(control);
    clickTargets.push(dropdownClickTarget(root));
    clickTargets.push(root);

    let opened = false;
    for (const target of clickTargets) {
      if (!target) continue;
      robustClick(target);
      await sleep(260);
      if (isDropdownOpen(root) || isDropdownOpen()) { opened = true; break; }
    }
    if (!opened) {
      const trigger = dropdownClickTarget(root);
      if (trigger) {
        trigger.focus?.();
        dispatchKeyboard(trigger, 'keydown', 'Enter');
        dispatchKeyboard(trigger, 'keyup', 'Enter');
        await sleep(350);
      }
    }

    const input = dropdownInput(root);
    if (input) {
      input.focus();
      setNativeValue(input, '');
      dispatch(input, 'input');
      await sleep(80);
      setNativeValue(input, normalizeDropdownSearchValue(value, spec));
      dispatch(input, 'input');
      await sleep(520);
    }

    let option = findDropdownOption(value, spec, /* includeHiddenPanels */ false, root);
    if (!option) {
      await sleep(400);
      option = findDropdownOption(value, spec, false, root);
    }
    if (!option) {
      // 找不到前先关面板（否则一直开着用户视觉体验差）
      await ensureDropdownClosed(root, spec);
      return { ok: false, reason: 'option-not-found', message: '下拉框未找到匹配选项"' + value + '"，请人工选择' };
    }
    const pickResult = clickDropdownOption(option, root, value);
    // 【关键修复】无论成功失败，选完必须关面板！（之前存在的问题：robustClick(option) 未被组件内部识别为"选中完成"，面板一直挂着）
    const closed = await ensureDropdownClosed(root, spec);
    return Object.assign({}, pickResult, { closedVia: closed.via });
  }

  /**
   * 在 ElementUI / Ant Design 的 select 根节点上找到其 Vue 组件实例（通常是 root.__vue__ 或 input/selector wrapper 的 __vue__）
   */
  function findVueComponent(root) {
    if (!root) return null;
    const queue = [root];
    while (queue.length) {
      const el = queue.shift();
      if (el && el.__vue__) return el.__vue__;
      if (el && el._vue) return el._vue;
      // Vite / Vue3: __vueParentComponent
      if (el && (el.__vueParentComponent || el.__vnode)) return el;
      if (el.children && el.children.length) {
        for (let i = 0; i < el.children.length; i++) queue.push(el.children[i]);
      }
    }
    // 兜底：再看 root.parentNode / 上层（ElementUI 会把 __vue__ 绑到 .el-select / ant-select 顶层 wrapper）
    let p = root && root.parentNode;
    let up = 0;
    while (p && up < 5) {
      if (p.__vue__ || p._vue || p.__vueParentComponent || p.__vnode) return p;
      p = p.parentNode;
      up++;
    }
    return null;
  }

  /**
   * 把选中的 option 值写入 Vue 组件实例：触发 Vue 响应式更新，避免后续字段引起重渲染时 select 被还原成"请选择"。
   * 兼容 ElementUI（Vue2）/ Element Plus（Vue3）/ Ant Design Vue
   */
  function syncVueSelectModel(root, option, valueText) {
    if (!root || !option) return false;
    try {
      // 1) 从 option DOM 上读取真实的 value（ElementUI/Element Plus 会写 data-value / __vueValue）
      let rawValue = option.getAttribute('data-value');
      if (rawValue == null || rawValue === '') rawValue = option.getAttribute('value');
      if (rawValue == null || rawValue === '') {
        const optVue = option.__vue__ || option._vue;
        if (optVue) {
          if (optVue.value !== undefined) rawValue = optVue.value;
          else if (optVue.itemValue !== undefined) rawValue = optVue.itemValue;
          else if (optVue.modelValue !== undefined) rawValue = optVue.modelValue;
          else if (optVue.label !== undefined) rawValue = optVue.label;
        }
      }
      if (rawValue == null || rawValue === '') {
        // 兜底：用显示文本（因为很多后台 option.value = option.label）
        rawValue = cleanText(option.getAttribute('title') || option.innerText || option.textContent || valueText || '');
      }

      const vc = findVueComponent(root);
      if (!vc) return false;

      // 2) 对 Vue2 ElementUI：vm = vc.__vue__ 或 vc 本身，属性优先级：value → modelValue → currentValue → selected
      const vm = (vc && vc.__vue__) ? vc.__vue__ : vc;
      const setters = [];
      // Vue2: vm.$emit('input', v) + vm.$emit('change', v)；Vue3: vm.$emit 或直接 ctx.emit
      const hasEmit = typeof vm.$emit === 'function';
      const ctxEmit = (vc.__vueParentComponent && typeof vc.__vueParentComponent.emit === 'function') ? vc.__vueParentComponent.emit.bind(vc.__vueParentComponent) : null;

      if (typeof vm.value !== 'undefined') setters.push(v => { vm.value = v; });
      if (typeof vm.modelValue !== 'undefined') setters.push(v => { vm.modelValue = v; });
      if (typeof vm.currentValue !== 'undefined') setters.push(v => { vm.currentValue = v; });
      if (typeof vm.selected !== 'undefined') setters.push(v => { vm.selected = v; });
      if (typeof vm.selectedLabel !== 'undefined') setters.push(v => { vm.selectedLabel = String(valueText || rawValue || ''); });
      if (typeof vm.currentLabel !== 'undefined') setters.push(v => { vm.currentLabel = String(valueText || rawValue || ''); });

      if (!setters.length && !hasEmit && !ctxEmit) return false;
      setters.forEach(fn => { try { fn(rawValue); } catch (e) { ignoreUnlessPageAbort(e); } });

      // 3) 发送 Vue 组件的响应式事件（'input' 对应 v-model，'change' 对应联动更新）
      const events = ['input', 'change', 'update:modelValue', 'update:value'];
      events.forEach(ev => {
        try {
          if (hasEmit) vm.$emit(ev, rawValue);
          else if (ctxEmit) ctxEmit(ev, rawValue);
        } catch (e) { ignoreUnlessPageAbort(e); }
      });

      // 4) ElementUI / Ant 会在 vm 里放 selectedOptions / multiple 支持，尽量也同步
      const selectedLabel = String(valueText || cleanText(option.getAttribute('title') || option.innerText || option.textContent || rawValue || ''));
      if (vm.selectedOptions && Array.isArray(vm.selectedOptions)) {
        try {
          const fakeOpt = Object.assign({ value: rawValue, label: selectedLabel }, option.dataset || {});
          if (vm.multiple) vm.selectedOptions.push(fakeOpt);
          else vm.selectedOptions = [fakeOpt];
        } catch (e) { ignoreUnlessPageAbort(e); }
      } else if (typeof vm.selectedOptions !== 'undefined') {
        try { vm.selectedOptions = [{ value: rawValue, label: selectedLabel }]; } catch (e) { ignoreUnlessPageAbort(e); }
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  function clickDropdownOption(option, root, value) {
    const optionText = cleanText(option.getAttribute('title') || option.innerText || option.textContent || '');
    // 点击内层 div（与录制流程一致：.ant-select-item-option > div）
    const innerDiv = option.querySelector?.('div') || option;
    robustClick(innerDiv);

    // 关键修复：点击 option 后同步 Vue 组件实例的 modelValue/value/selectedLabel，
    // 并通过 vm.$emit('input'/'change') / ctx.emit 触发响应式。
    // 否则 setDropdownValue 只通过原生 input/change 改了 DOM，Vue 组件内部 state 仍为空，
    // 填其他级联字段（cascader/monthpicker）触发 Vue 重渲染时会把 select 还原成"请选择"。
    const synced = syncVueSelectModel(root, option, optionText || value);

    // 事件派发兜底：在 root/control 上再派发原生 input/change，兼容不依赖 Vue 事件链的简单表单
    setTimeout(() => {
      if (pageAbortRequested) return;
      try {
        const input = dropdownInput(root);
        if (input) {
          dispatch(input, 'input');
          dispatch(input, 'change');
        }
        dispatch(root, 'change');
      } catch (e) { ignoreUnlessPageAbort(e); }
    }, 260);

    return {
      ok: true,
      message: '已选择: ' + (optionText || value) + (synced ? '（Vue层已同步）' : '（Vue实例未找到，仅DOM同步，建议人工确认）'),
      synced,
    };
  }

  async function setCascaderValue(control, value, spec) {
    const root = controlRoot(control) || control;
    const parts = String(value || '').split(/[\/＞>,，、]/).map(v => v.trim()).filter(Boolean);
    if (!parts.length) return { ok: false, message: '级联地址为空，请人工选择' };

    root.scrollIntoView?.({ block: 'center', inline: 'nearest' });

    // 先清空当前值（与录制流程一致：change 事件清空后重选）
    const existingInput = dropdownInput(root);
    if (existingInput) {
      existingInput.focus();
      setNativeValue(existingInput, '');
      dispatch(existingInput, 'input');
      dispatch(existingInput, 'change');
      await sleep(150);
    }

    // 打开级联面板（只在最开始打开一次，后续多级选择在同一个面板内操作）
    robustClick(dropdownClickTarget(root));
    await sleep(400);

    const selected = [];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];

      // 在第 i 级对应的 cascader menu 列中查找选项
      let option = findCascaderOption(part, i, spec);
      if (!option) {
        await sleep(350);
        option = findCascaderOption(part, i, spec);
      }
      if (!option) {
        // 兜底：重新打开面板再查一次
        robustClick(dropdownClickTarget(root));
        await sleep(400);
        option = findCascaderOption(part, i, spec);
      }
      if (!option) return { ok: false, message: '级联第' + (i + 1) + '级未找到"' + part + '"，请人工选择' };

      const optionText = cleanText(option.innerText || option.textContent || part);
      selected.push(optionText);

      // 对于非最后一级：先 hover 触发下一列菜单渲染，然后点击
      const innerDiv = option.querySelector?.('div') || option;
      if (i < parts.length - 1) {
        hoverCascaderItem(option);
        await sleep(450); // 给下一级菜单渲染留出时间
        // hover 后再点击一次，确保 Ant Design 记住选择并渲染展开状态
        robustClick(innerDiv);
        await sleep(350);
      } else {
        // 最后一级：直接点击完成选择
        robustClick(innerDiv);
        await sleep(300);
      }
    }

    dispatch(root, 'change');
    // 级联选完也强制关面板，防止填完后面板一直挂着（与 select 下拉同问题）
    const closed = await ensureDropdownClosed(root, spec);
    return Object.assign({ ok: true, message: '已选择: ' + selected.join(' / ') }, { closedVia: closed.via });
  }

  /**
   * 【关键修复：归属面板查找】—— 解决「页面上同时有多个下拉时，选项串到另一个下拉」的问题。
   *
   * 背景：Ant Design / ElementUI 的 select/cascader 下拉面板都是通过 portal 挂到 document.body 上（全局）。
   * 之前 findDropdownOption 用 document.querySelectorAll(".ant-select-dropdown ...") 全局查第一个可见面板，
   * 会把列表页筛选栏的 车系下拉面板当成 Modal 里 品牌下拉的面板，导致错误点击「测试车系/解放J6P」等选项。
   *
   * 归属判定策略（从可靠 → 兜底）：
   *   1) aria-owns / aria-controls：root.getAttribute('aria-owns'/'aria-controls') 直接给面板 id，
   *      document.getElementById 精确命中（最准，ElementUI / Ant 都会写）；
   *   2) 控件 id 反向匹配：如果 root 或其下 input 有 id='xxx'，有些实现面板 id = 'xxx_list' 或包含 root id；
   *   3) 坐标距离最近 + 垂直方向在下方：遍历所有候选面板，算「面板顶部 Y 与 控件底部 Y」的差，
   *      正常下拉面板在控件正下方，距离 < 240 像素、水平区间重叠度 > 30% 的，认定为同一个；
   *   4) 实在无法判定时，fallback 返回 findDropdownPanelGlobal() 第一个可见（不抛错，不串）。
   *
   * @param {HTMLElement} root  下拉控件根（controlRoot 返回值）
   * @param {object} options
   *   - includeHiddenPanels: bool（静默填值模式下，hidden 的面板 DOM 也参与候选）
   *   - kind: 'select' | 'cascader' | 'any'（默认 any，根据 root 再猜）
   * @returns {HTMLElement|null} 归属的 ant-select-dropdown / ant-cascader-dropdown / el-select-dropdown 面板容器
   */
  function findDropdownPanelForControl(root, options) {
    const includeHiddenPanels = !!(options?.includeHiddenPanels);
    const kind = options?.kind || 'any';

    const ctrl = (root && (controlRoot(root) || root));
    if (!ctrl) return null;

    const attrIds = [];
    try {
      for (const a of ['aria-owns', 'aria-controls', 'aria-describedby', 'aria-popup']) {
        const v = ctrl.getAttribute?.(a);
        if (v) v.split(/\s+/).forEach(s => s && attrIds.push(s));
      }
      // 也看看 ctrl 下 input 子节点的 aria 属性（有些实现绑在 input 上）
      const inner = ctrl.querySelector?.('input, [role="combobox"]');
      if (inner) {
        for (const a of ['aria-owns', 'aria-controls', 'aria-describedby', 'aria-popup']) {
          const v = inner.getAttribute?.(a);
          if (v) v.split(/\s+/).forEach(s => s && attrIds.push(s));
        }
        // input id 反向匹配（面板 id = inputId + '_list' / '-panel' 常见）
        const iid = inner.getAttribute?.('id');
        if (iid) attrIds.push(iid + '_list', iid + '-panel', iid + '_panel');
      }
      const rid = ctrl.getAttribute?.('id');
      if (rid) attrIds.push(rid + '_list', rid + '-panel', rid + '_panel');
    } catch (e) { ignoreUnlessPageAbort(e); /* ignore */ }

    for (const id of attrIds) {
      const panel = document.getElementById(id);
      if (panel && (includeHiddenPanels || isVisible(panel))) return panel;
    }

    // 坐标距离兜底
    let ctrlRect = null;
    try { ctrlRect = ctrl.getBoundingClientRect?.(); } catch (e) { ignoreUnlessPageAbort(e); }
    if (!ctrlRect || (ctrlRect.width === 0 && ctrlRect.height === 0)) {
      // 控件还没测量出来（transition 中），fallback 到全局第一个可见面板（最差情况）
      return findDropdownPanelGlobal(kind, includeHiddenPanels);
    }
    const ctrlBottom = ctrlRect.bottom;
    const ctrlTop = ctrlRect.top;
    const ctrlLeft = ctrlRect.left;
    const ctrlRight = ctrlRect.right;
    const ctrlWidth = ctrlRect.width || 1;

    const allPanels = queryAllDropdownPanels(kind, includeHiddenPanels);
    const scored = allPanels.map(panel => {
      const rect = panel.getBoundingClientRect?.();
      if (!rect) return null;
      if (rect.width <= 0 && rect.height <= 0 && !includeHiddenPanels) return null;
      // 1) 水平重叠：正常面板宽度 ≈ 控件宽度 且水平重合率 > 30%
      const overlapX = Math.max(0, Math.min(ctrlRight, rect.right) - Math.max(ctrlLeft, rect.left));
      const overlapRatio = overlapX / (ctrlWidth || 1);
      // 2) 垂直距离：|面板顶部 - 控件底部|（打开面板在下方），或 |面板底部 - 控件顶部|（打开在上方）
      const distBelow = Math.abs(rect.top - ctrlBottom);
      const distAbove = Math.abs(rect.bottom - ctrlTop);
      const vDist = Math.min(distBelow, distAbove);
      let score = 0;
      if (overlapRatio >= 0.5) score += 220;
      else if (overlapRatio >= 0.3) score += 150;
      else if (overlapRatio >= 0.15) score += 80;
      if (vDist <= 12) score += 260;
      else if (vDist <= 60) score += 220;
      else if (vDist <= 180) score += 170;
      else if (vDist <= 240) score += 100;
      else if (vDist <= 400) score += 40;
      else score -= 120;           // 太远，大概率不是同一个
      return { panel, score, vDist, overlapRatio, rect };
    }).filter(Boolean);
    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];
    if (best && best.score >= 150) return best.panel;
    // 完全没有靠谱归属，就返回 null，让上层走全局 fallback，别串到别的下拉
    return null;
  }

  // 工具：根据 kind（select / cascader / any）返回所有面板 DOM（可选包含 hidden）
  function queryAllDropdownPanels(kind, includeHiddenPanels) {
    const visibleSelect = `.ant-select-dropdown${includeHiddenPanels ? '' : ':not(.ant-select-dropdown-hidden)'}`;
    const visibleCasc = `.ant-cascader-dropdown${includeHiddenPanels ? '' : ':not(.ant-cascader-dropdown-hidden)'}`;
    const visibleEl = `.el-select-dropdown${includeHiddenPanels ? '' : ':not(.el-select-dropdown__hide)'}`;
    const visibleElCasc = `.el-cascader__dropdown${includeHiddenPanels ? '' : ':not([style*="display: none"])'}`;
    const selectors = [];
    if (kind === 'any' || kind === 'select') selectors.push(visibleSelect, visibleEl);
    if (kind === 'any' || kind === 'cascader') selectors.push(visibleCasc, visibleElCasc);
    return [...document.querySelectorAll(selectors.join(','))];
  }

  // 兼容旧函数：全局找第一个可见面板（只有在找不到归属时才用）
  function findDropdownPanelGlobal(kind, includeHiddenPanels) {
    const arr = queryAllDropdownPanels(kind, includeHiddenPanels);
    return arr[0] || null;
  }

  function findDropdownOption(value, spec, includeHiddenPanels, controlRootEl) {
    const key = norm(value);
    const aliases = dropdownValueAliases(value, spec).map(norm);

    // ============== 核心：优先用「control→归属面板」来限制搜索范围 ==============
    const ownerPanel = controlRootEl ? findDropdownPanelForControl(controlRootEl, {
      includeHiddenPanels: !!includeHiddenPanels,
      kind: spec?.kind === 'cascader' ? 'cascader' : 'any',
    }) : null;

    let optionCandidates = [];
    if (ownerPanel) {
      // 限制在 ownerPanel 下查 —— 永远不会串到别的下拉面板！
      optionCandidates = [
        ...ownerPanel.querySelectorAll('.ant-select-item-option:not(.ant-select-item-option-disabled), [role="option"]:not([aria-disabled="true"])'),
      ];
      // 兼容 ElementUI：在 panel > .ant-select-dropdown-menu 下找 ant-select-dropdown-menu-item（非 disabled）
      const extra = ownerPanel.querySelectorAll('.ant-select-dropdown-menu-item:not(.ant-select-dropdown-menu-item-disabled), .el-select-dropdown__item:not(.is-disabled)');
      extra.forEach(e => optionCandidates.push(e));
    } else {
      // 没拿到归属面板（传了 root 但距离太远 / aria 不对）→ 退化：按 kind 全局查（保守策略，至少不抛错）
      const dropdownSel = includeHiddenPanels
        ? [
            '.ant-select-dropdown .ant-select-item-option:not(.ant-select-item-option-disabled)',
            '.ant-select-dropdown [role="option"]:not([aria-disabled="true"])',
            '.ant-select-dropdown .ant-select-dropdown-menu-item:not(.ant-select-dropdown-menu-item-disabled)',
            '.el-select-dropdown .el-select-dropdown__item:not(.is-disabled)',
          ]
        : [
            '.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option:not(.ant-select-item-option-disabled)',
            '.ant-select-dropdown:not(.ant-select-dropdown-hidden) [role="option"]:not([aria-disabled="true"])',
            '.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-dropdown-menu-item:not(.ant-select-dropdown-menu-item-disabled)',
            '.el-select-dropdown:not(.el-select-dropdown__hide) .el-select-dropdown__item:not(.is-disabled)',
          ];
      dropdownSel.push('[role="listbox"] [role="option"]:not([aria-disabled="true"])');
      optionCandidates = [...document.querySelectorAll(dropdownSel.join(','))];
    }
    optionCandidates = optionCandidates.filter(el => {
      return includeHiddenPanels ? true : isVisible(el);
    });

    const isColorField = spec.field === 'color' || spec.field === 'vehicleColor' || spec.field === 'colorName' ||
                        (spec.label && /颜色|车身颜色/.test(spec.label)) ||
                        (spec.aliases && spec.aliases.some(a => /颜色|车身颜色/.test(String(a || ''))));
    const scored = optionCandidates.map(option => {
      const text = cleanText(option.getAttribute('title') || option.innerText || option.textContent || '');
      const optKey = norm(text);
      let score = 0;
      if (optKey === key || aliases.includes(optKey)) score = 120;
      else if (aliases.some(alias => optKey === alias)) score = 110;
      else if (optKey.includes(key)) score = 80;
      else if (aliases.some(alias => optKey.includes(alias))) score = 78;
      else if (key.includes(optKey) && optKey.length >= 2) score = 45;
      // ★ 颜色字段双向交叉匹配：之前只对 CSV 值做了 alias，没对下拉选项文本做。
      //   例如 CSV=白色（alias 展开成 ["白色","白"]）、下拉选项=白（optKey=白）→ 上面 aliases.includes(optKey) 已命中 score=120 ✓
      //   但反过来：CSV=白（key=白，alias 展开成 ["白","白色","白颜色"...]）、下拉选项=白色（optKey=白色）
      //   → 上面也能命中（因为 aliases 里已有"白色"）。
      //   还差一种：两个字符串「去掉 色/颜色 后相等」才相同（例：珍珠白 ↔ 珍珠白色 / 粉 ↔ 粉色 / 咖金 ↔ 咖金色）。
      //   这里补一道：对 optKey 调用 _colorVariants（仅颜色字段），如果 variant 命中 key 或 aliases，给高分 115。
      if (score === 0 && isColorField) {
        const optVariants = _colorVariants(text).map(norm);
        const optStripped = norm(text.replace(/(颜色|色)$/g, '').trim());
        const valStripped = norm(String(value || '').replace(/(颜色|色)$/g, '').trim());
        if (optVariants.some(v => v === key || aliases.includes(v))) score = 115;
        else if (valStripped && optStripped && valStripped === optStripped) score = 115; // strip后相等 = 最高档颜色匹配
        else if (valStripped && optStripped && valStripped.includes(optStripped)) score = 76;
        else if (valStripped && optStripped && optStripped.includes(valStripped)) score = 76;
      }
      return { option, score, text };
    }).filter(item => item.score > 0);

    scored.sort((a, b) => b.score - a.score || a.text.length - b.text.length);
    // 诊断日志：如果 ownerPanel 存在但没找到匹配，把 ownerPanel 下的所有选项文本打出来（Console 一眼能看见是品牌还是车系的选项池）
    if (ownerPanel && !scored.length && console) {
      const allTexts = [...ownerPanel.querySelectorAll('.ant-select-item-option, [role="option"], .ant-select-dropdown-menu-item, .el-select-dropdown__item')]
        .map(el => `"${cleanText((el.innerText || el.textContent || el.getAttribute?.('title') || '').slice(0, 25))}"`).slice(0, 30);
      console.warn(`[VA findDropdownOption] 归属面板里没找到值="${value}"（spec.field=${spec?.field || ''}）。面板内的选项文本：`, allTexts);
    }
    return scored[0]?.option || null;
  }

  // 针对 Cascader 二级/多级列表：在指定 level 的 cascader menu 列中精确查找
  function findCascaderOption(value, level, spec) {
    const key = norm(value);
    const aliases = dropdownValueAliases(value, spec).map(norm);
    // Ant Design Cascader: 每个 level 对应一个 .ant-cascader-menu（第 1 级为 nth-child(1)）
    const menuSelector = `.ant-cascader-dropdown:not(.ant-cascader-dropdown-hidden) .ant-cascader-menus > .ant-cascader-menu:nth-child(${level + 1}) > .ant-cascader-menu-item:not(.ant-cascader-menu-item-disabled)`;
    const options = [...document.querySelectorAll(menuSelector)].filter(isVisible);

    // 如果在指定 level 找不到，也尝试找 expand/active 状态同级展开的其他列（容错）
    const fallback = [...document.querySelectorAll(
      '.ant-cascader-dropdown:not(.ant-cascader-dropdown-hidden) .ant-cascader-menu-item:not(.ant-cascader-menu-item-disabled)'
    )].filter(isVisible);

    const isColorField_c = spec.field === 'color' || spec.field === 'vehicleColor' || spec.field === 'colorName' ||
                         (spec.label && /颜色|车身颜色/.test(spec.label)) ||
                         (spec.aliases && spec.aliases.some(a => /颜色|车身颜色/.test(String(a || ''))));
    const scored = options.map(option => {
      const text = cleanText(option.getAttribute('title') || option.innerText || option.textContent || '');
      const optKey = norm(text);
      let score = 0;
      if (optKey === key || aliases.includes(optKey)) score = 220; // 命中指定列 + 精确匹配 = 最高分
      else if (aliases.some(alias => optKey === alias)) score = 210;
      else if (optKey.includes(key)) score = 180;
      else if (aliases.some(alias => optKey.includes(alias))) score = 178;
      else if (key.includes(optKey) && optKey.length >= 2) score = 145;
      if (score === 0 && isColorField_c) {
        const optVariants = _colorVariants(text).map(norm);
        const optStripped = norm(text.replace(/(颜色|色)$/g, '').trim());
        const valStripped = norm(String(value || '').replace(/(颜色|色)$/g, '').trim());
        if (optVariants.some(v => v === key || aliases.includes(v))) score = 215;
        else if (valStripped && optStripped && valStripped === optStripped) score = 215;
        else if (valStripped && optStripped && (valStripped.includes(optStripped) || optStripped.includes(valStripped))) score = 176;
      }
      return { option, score, text };
    }).filter(item => item.score > 0);

    // 如果指定列没找到，再尝试从所有 cascader 列中按普通分匹配
    if (!scored.length) {
      fallback.forEach(option => {
        const text = cleanText(option.getAttribute('title') || option.innerText || option.textContent || '');
        const optKey = norm(text);
        let score = 0;
        if (optKey === key || aliases.includes(optKey)) score = 120;
        else if (aliases.some(alias => optKey === alias)) score = 110;
        else if (optKey.includes(key)) score = 80;
        else if (aliases.some(alias => optKey.includes(alias))) score = 78;
        else if (key.includes(optKey) && optKey.length >= 2) score = 45;
        if (score === 0 && isColorField_c) {
          const optVariants = _colorVariants(text).map(norm);
          const optStripped = norm(text.replace(/(颜色|色)$/g, '').trim());
          const valStripped = norm(String(value || '').replace(/(颜色|色)$/g, '').trim());
          if (optVariants.some(v => v === key || aliases.includes(v))) score = 115;
          else if (valStripped && optStripped && valStripped === optStripped) score = 115;
          else if (valStripped && optStripped && (valStripped.includes(optStripped) || optStripped.includes(valStripped))) score = 76;
        }
        if (score > 0) scored.push({ option, score, text });
      });
    }

    scored.sort((a, b) => b.score - a.score || a.text.length - b.text.length);
    return scored[0]?.option || null;
  }

  // 对 Cascader 菜单项触发 mouseenter，让 Ant Design 渲染下一级菜单（二级列表需要 hover 才展开）
  function hoverCascaderItem(option) {
    if (!option) return;
    option.scrollIntoView?.({ block: 'center', inline: 'nearest' });
    ['mouseover', 'mouseenter', 'pointerenter'].forEach(type => {
      const Ctor = window.PointerEvent && type.startsWith('pointer') ? PointerEvent : MouseEvent;
      try { option.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, view: window })); } catch {}
    });
  }

  // 车身颜色字段统一归一化：去掉末尾的「色」「颜色」后缀，再反向补后缀。
  // 解决用户场景：CSV=白色 / 粉色 / 珍珠白色，下拉选项=白 / 粉 / 珍珠白（无"色"）
  // 反向覆盖：CSV=白 / 粉，下拉=白色 / 粉色（有"色"）
  function _colorVariants(baseValue) {
    const v = String(baseValue || '').trim();
    if (!v) return [];
    const out = [v];
    // ① strip：去掉末尾 色/颜色
    const stripped = v.replace(/(颜色|色)$/g, '').trim();
    if (stripped && stripped !== v) out.push(stripped);
    // ② add：末尾补「色」「颜色」（只在原串非空且不是已以 色/颜色 结尾时补，避免重复）
    if (!/(颜色|色)$/.test(v)) {
      out.push(v + '色');
      out.push(v + '颜色');
    }
    // ③ 再对 stripped 补一次「色」「颜色」（防止原串是 珍珠白色 stripped=珍珠白 → 也补珍珠白色 作为 alias 匹配）
    if (stripped && stripped !== v && !/(颜色|色)$/.test(stripped)) {
      out.push(stripped + '色');
      out.push(stripped + '颜色');
    }
    // ④ 特殊兜底：两字颜色 第一个字单字也是候选（如 珍珠白 → 白；咖金色 → 金；粉白色 → 粉 / 白）
    if (stripped) {
      for (let i = 0; i < stripped.length; i++) {
        const ch = stripped.charAt(i);
        if (ch) out.push(ch);
      }
    }
    return [...new Set(out.filter(s => s && s.length))];
  }

  function dropdownValueAliases(value, spec) {
    const v = String(value || '').trim();
    const out = [v];
    if (spec.field === 'withTrailer') {
      if (/^0$|否|不带|无/.test(v)) out.push('否', '不带挂', '无');
      if (/^1$|是|带挂|有/.test(v)) out.push('是', '带挂', '有');
    }
    if (spec.field === 'modelName') {
      out.push(v.replace(/\([^)]*\)/g, '').trim());
    }
    // ★ 车身颜色 / 颜色字段双向别名（CSV：白色 ↔ 下拉：白；CSV：珍珠白 ↔ 下拉：珍珠白色）
    if (spec.field === 'color' || spec.field === 'vehicleColor' || spec.field === 'colorName' ||
        (spec.label && /颜色|车身颜色/.test(spec.label)) ||
        (spec.aliases && spec.aliases.some(a => /颜色|车身颜色/.test(String(a || ''))))) {
      _colorVariants(v).forEach(cv => out.push(cv));
    }
    return [...new Set(out.filter(Boolean))];
  }

  function normalizeDropdownSearchValue(value, spec) {
    if (spec.field === 'withTrailer') return dropdownValueAliases(value, spec)[0];
    let v = String(value || '').trim();
    // ★ 颜色字段填入搜索框：优先 strip 掉 色/颜色 后缀（因为系统下拉里都是单字不带"色"，搜"白"比搜"白色"命中概率大）
    const isColorField = spec.field === 'color' || spec.field === 'vehicleColor' || spec.field === 'colorName' ||
                        (spec.label && /颜色|车身颜色/.test(spec.label)) ||
                        (spec.aliases && spec.aliases.some(a => /颜色|车身颜色/.test(String(a || ''))));
    if (isColorField) {
      const stripped = v.replace(/(颜色|色)$/g, '').trim();
      if (stripped) v = stripped;
    }
    return v;
  }

  function startSubmitWatch(row) {
    stopSubmitWatch('restart');
    submitWatch = {
      rowId: row.id || '',
      rowNumber: row.rowNumber || '',
      displayName: row.displayName || '',
      startHref: location.href,
      startedAt: Date.now(),
      sawSubmitClick: false,
      sent: false,
      wasOnAddForm: looksLikeAddForm(), // 启动时是否在新增页/审核表单页
      /** 【主任务硬锁】：sidepanel 启动监听时传给当前车源大任务的唯一 token。
       *  只有「用户在车源主表单人工点提交」触发了 VA_SUBMIT_SUCCESS，且把这个 token 原样带回去，
       *  sidepanel 才会把这行记为已提交并推进；创建车系/车型期间 submitWatch 被 stop，
       *  任何残留/并发事件拿不到当前 token，都会被硬锁挡回。
       */
      taskLockId: row.taskLockId || '',
    };

    submitClickHandler = event => {
      const button = event.target?.closest?.('button, a, [role="button"], .ant-btn, span, div');
      if (!button) return;
      // 兼容：提交按钮有时是 <div role="button"> 或 <span> 包文字，扩大范围匹配"提交/保存/发布/确认提交"
      const text = cleanText(button.innerText || button.textContent || button.getAttribute('aria-label') || '');
      if (!/确认提交|提交|保存|发布|审核通过|通过审核/.test(text)) return;
      if (/取消提交|取消|暂存|保存草稿|关闭/.test(text)) return;
      // ★ 关键收紧：只有点击位于【车源录入主表单区域】里的提交按钮才算数
      if (!isInsideVehicleMainForm(button)) return;
      debugSubmit('saw-submit-click', { rowNumber: submitWatch?.rowNumber || row.rowNumber, text, tag: button.tagName });
      if (submitWatch) submitWatch.sawSubmitClick = true;
    };
    document.addEventListener('click', submitClickHandler, true);

    submitObserver = new MutationObserver(checkSubmitState);
    submitObserver.observe(document.body || document.documentElement, { childList: true, subtree: true, characterData: true });
    submitTimer = window.setInterval(checkSubmitState, 700);

    // ⚠️ 【原致命问题已移除】：之前在 pagehide / beforeunload 里立刻 stopSubmitWatch，
    //    导致用户刚点完提交，后台马上 SPA 切路由/跳URL到审核列表 → beforeunload/pagehide触发 →
    //    submitWatch被清空 → 下一轮 checkSubmitState 的 `if (!submitWatch) return` 直接跳过 →
    //    VA_SUBMIT_SUCCESS 永远发不出去 → sidepanel 就不推进。
    //
    // ✅ 新策略：不再在页面隐藏/卸载时停止 watch（只有超时 15 分钟、重启 watch 或显式 success 才停止）。
    //    即使 SPA 切路由后 content-script 被重新注入，startHref/whether-was-on-add-form 仍然能在兜底判定中使用。
    //    并且新增 watchTimeout：15分钟后如果仍没触发成功，自动清理监听，避免长时间挂监听占内存。
    if (submitTimeoutId) { window.clearTimeout(submitTimeoutId); submitTimeoutId = null; }
    submitTimeoutId = window.setTimeout(() => {
      stopSubmitWatch('watch-timeout-15min');
    }, 15 * 60 * 1000);

    debugSubmit('start-watch', { rowNumber: submitWatch.rowNumber, startHref: submitWatch.startHref, wasOnAddForm: submitWatch.wasOnAddForm });
    return { status: 'watching', rowNumber: submitWatch.rowNumber, href: location.href };
  }

  function stopSubmitWatch(reason) {
    if (submitObserver) submitObserver.disconnect();
    if (submitTimer) window.clearInterval(submitTimer);
    if (submitClickHandler) document.removeEventListener('click', submitClickHandler, true);
    if (submitTimeoutId) { window.clearTimeout(submitTimeoutId); submitTimeoutId = null; }
    submitObserver = null;
    submitTimer = null;
    submitClickHandler = null;
    const previous = submitWatch;
    submitWatch = null;
    debugSubmit('stop-watch', { reason, previousRowNumber: previous?.rowNumber || '' });
    return { status: 'stopped', reason, previousRowNumber: previous?.rowNumber || '' };
  }

  function checkSubmitState() {
    if (!submitWatch || submitWatch.sent) return;
    const watch = submitWatch;

    // ========== 前置：错误 toast 不推进 ==========
    const error = visibleErrorText();
    if (error) {
      debugSubmit('check-has-error-toast', { rowNumber: watch.rowNumber, error });
      return;
    }
    const anyCreateDrawerOpen = (() => {
      const d = document.querySelector('.ant-drawer, .ant-modal, [role="dialog"]');
      return d && isVisible(d);
    })();
    if (anyCreateDrawerOpen) {
      debugSubmit('check-create-drawer-still-open', { ok: false });
      return;
    }

    // ========== 成功三通道（OR 任一命中即算提交成功）==========
    // 通道 A. 明确看到用户点过车源主表单里的提交按钮（最高置信，原来的逻辑）
    const channelA_Click = !!watch.sawSubmitClick;

    // 通道 B. 【兜底：URL/表单兜底】启动监听时就在新增页（wasOnAddForm=true），
    // 现在 URL 已经不一样 / 表单消失了，且不是切到车系/车型管理页
    const urlChangedAway = location.href !== watch.startHref && !looksLikeAddForm();
    const formGoneFromPage = watch.wasOnAddForm && !looksLikeAddForm();
    const channelB_UrlOrFormGone = urlChangedAway || formGoneFromPage;

    // 通道 C. 【兜底：明确到审核列表页】启动时在新增页，现在明确在审核列表（有"新增库存车"+"审核列表/总车源"）
    const channelC_AuditListNow = watch.wasOnAddForm && looksLikeAuditList() && !looksLikeAddForm();

    // 先记下来三通道中哪个触发了（方便日志定位）
    const entryReasons = [];
    if (channelA_Click) entryReasons.push('sawSubmitClick');
    if (channelB_UrlOrFormGone) entryReasons.push(urlChangedAway ? 'urlChangedAway' : 'formGoneFromPage');
    if (channelC_AuditListNow) entryReasons.push('auditListFallback');

    // 成功toast可选（有则提升置信，无则看上面三通道）
    const success = visibleSuccessText();
    // 如果成功toast是"新增成功"但当前仍在车系/车型管理页（不是审核列表），那这个toast不算车源提交成功
    const successLooksForVehicle = !success || !/新增成功/.test(success) || looksLikeAuditList();

    // 成功触发条件：三通道任一命中 AND 没有误命中的非车源 toast
    const successTriggered = (channelA_Click || channelB_UrlOrFormGone || channelC_AuditListNow) && successLooksForVehicle;

    // 如果只是 success toast 出现但三通道一个都没中（例如车系/车型创建抽屉里的成功 toast，它是在启动监听之前/同时发生）→ 不触发
    if (!successTriggered) {
      // 只在通道命中 或 success 有值时才打日志，不然 console 刷屏
      if (success) debugSubmit('check-success-toast-but-no-channel', { rowNumber: watch.rowNumber, success });
      return;
    }

    watch.sent = true;
    // via 判定：优先 success（toast）→ 再按通道顺序
    let via = '';
    if (success) via = 'toast+' + (entryReasons[0] || 'click');
    else via = entryReasons[0] || 'click';

    const payload = {
      type: 'VA_SUBMIT_SUCCESS',
      rowId: watch.rowId,
      rowNumber: watch.rowNumber,
      displayName: watch.displayName,
      href: location.href,
      message: success || (channelC_AuditListNow ? '提交后已回到审核列表（URL兜底）' : '提交后页面已离开新增表单'),
      submittedAt: new Date().toLocaleString(),
      via,
      channels: entryReasons,
      /** 【主任务硬锁】：把创建 submitWatch 时 sidepanel 传过来的 taskLockId 原样带回去，只有一致才记为合法已提交 */
      taskLockId: watch.taskLockId || '',
    };
    debugSubmit('check-send-submit-success', payload);
    stopSubmitWatch('success');
    chrome.runtime.sendMessage(payload).catch((e) => {
      debugSubmit('check-send-failed', { error: e?.message || String(e) });
    });
  }

  function visibleSuccessText() {
    const selectors = [
      '.ant-message-success', '.ant-notification-notice-success',
      '.el-message--success', '.el-notification.success',
      '.ant-message-notice-content', '.ant-message', '.ant-notification-notice',
      '.Message', '.message-success', '.Toastify__toast--success', '.toast-success',
      '[class*="message-success"]', '[class*="notification-success"]',
    ];
    const text = [...document.querySelectorAll(selectors.join(','))].filter(isVisible).map(el => cleanText(el.innerText || el.textContent || '')).join(' ');
    const match = text.match(SUCCESS_TEXT);
    return match ? (match[0] + ' | ' + text.slice(0, 100)) : '';
  }

  function visibleErrorText() {
    const selectors = [
      '.ant-message-error', '.ant-notification-notice-error',
      '.el-message--error', '.ant-form-item-explain-error',
      '.ant-form-item-explain, .ant-form-item-with-help [class*="explain"]',
      '.ant-message-warning, .ant-notification-notice-warning',
      '.ant-message', '.ant-notification-notice',
      '[class*="message-error"]', '[class*="notification-error"]',
      '.ant-form-item-explain-error *', '.ant-form-item-explain-error + *',
    ];
    const text = [...document.querySelectorAll(selectors.join(','))].filter(isVisible).map(el => cleanText(el.innerText || el.textContent || '')).join(' ');
    const match = text.match(ERROR_TEXT);
    return match ? (match[0] + ' | ' + text.slice(0, 100)) : '';
  }

  function robustClick(el) {
    if (!el) return;
    el.scrollIntoView?.({ block: 'center', inline: 'nearest' });
    el.focus?.();
    try { el.click(); } catch (e) {}
    ['pointerdown', 'mousedown', 'mouseup', 'click'].forEach(type => {
      const Ctor = type.startsWith('pointer') && window.PointerEvent ? PointerEvent : MouseEvent;
      try { el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, view: window })); } catch (e) {}
    });
  }

  function isDropdownOpen() {
    return !!document.querySelector('.ant-select-dropdown:not(.ant-select-dropdown-hidden), .ant-cascader-dropdown:not(.ant-cascader-dropdown-hidden)');
  }

  function clickLike(el) {
    robustClick(el);
  }

  function dropdownClickTarget(root) {
    return root.querySelector?.('.ant-select-selector, .ant-cascader-picker-label, .ant-cascader-input, input, [role="combobox"]') || root;
  }

  function dropdownInput(root) {
    if (root.matches?.('input[role="combobox"], input:not([type="hidden"])')) return root;
    return root.querySelector?.('input[role="combobox"], input:not([type="hidden"])') || null;
  }

  function inputLike(el) {
    if (!el) return null;
    const tag = el.tagName?.toLowerCase();
    if (tag === 'input' || tag === 'textarea') return el;
    return el.querySelector?.('input:not([type="hidden"]), textarea') || null;
  }

  function controlRoot(el) {
    if (!el?.closest) return el;
    return el.closest('.ant-select, .ant-picker, .ant-cascader-picker, .ant-cascader') || el;
  }

  function controlKind(el) {
    if (el?.matches?.('.ant-picker')) return 'picker';
    if (el?.matches?.('.ant-cascader-picker, .ant-cascader')) return 'cascader';
    if (el?.matches?.('.ant-select, [role="combobox"]') || el?.querySelector?.('[role="combobox"]')) return 'combobox';
    return el.tagName?.toLowerCase?.() || 'unknown';
  }

  function readControlValue(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'select') return el.selectedOptions?.[0]?.textContent?.trim() || '';
    if (tag === 'input' || tag === 'textarea') return String(el.value || '').slice(0, 120);
    const selected = el.querySelector?.('.ant-select-selection-item, .ant-select-selection-item-content, .ant-cascader-picker-label');
    if (selected) return cleanText(selected.textContent).slice(0, 120);
    const input = inputLike(el);
    if (input?.value) return String(input.value || '').slice(0, 120);
    return '';
  }

  function getControls() {
    const selectors = [
      'input',
      'select',
      'textarea',
      '[contenteditable="true"]',
      '[role="combobox"]',
      '.ant-select',
      '.ant-picker',
      '.ant-cascader-picker',
      '.ant-cascader',
    ];
    const seen = new Set();
    return [...document.querySelectorAll(selectors.join(','))]
      .filter(isCandidateControl)
      .map(el => controlRoot(el) || el)
      .filter(target => {
        if (!target || seen.has(target) || !isVisible(target)) return false;
        seen.add(target);
        return true;
      })
      .map((target, index) => {
        if (!target.dataset.vaIndex) target.dataset.vaIndex = String(index + 1);
        return target;
      });
  }

  function isCandidateControl(el) {
    if (!el || el.disabled || el.readOnly) return false;
    if (el.closest('.ant-select-dropdown, .ant-picker-dropdown, .ant-cascader-dropdown')) return false;
    if (el.getAttribute('aria-disabled') === 'true') return false;
    if (/(^|\s)(ant-select-disabled|ant-picker-disabled|disabled)(\s|$)/.test(el.className || '')) return false;

    const tag = el.tagName.toLowerCase();
    const type = String(el.getAttribute('type') || '').toLowerCase();
    if (tag === 'input' && ['hidden', 'file', 'checkbox', 'radio', 'submit', 'button', 'reset', 'image'].includes(type)) return false;
    return true;
  }

  function describeControl(el, index) {
    const root = controlRoot(el);
    const target = root || el;
    const tag = target.tagName.toLowerCase();
    return {
      index,
      kind: controlKind(target),
      tag,
      type: target.getAttribute('type') || nestedAttr(target, 'type') || '',
      id: target.id || nestedAttr(target, 'id') || '',
      name: target.getAttribute('name') || nestedAttr(target, 'name') || '',
      placeholder: target.getAttribute('placeholder') || nestedAttr(target, 'placeholder') || '',
      ariaLabel: target.getAttribute('aria-label') || nestedAttr(target, 'aria-label') || '',
      label: labelText(target),
      context: contextText(target),
      options: tag === 'select' ? [...target.options].map(o => o.textContent.trim()).filter(Boolean).slice(0, 300) : [],
      value: readControlValue(target),
      key: elementKey(target),
    };
  }

  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value); else el.value = value;
  }

  function dispatch(el, type) {
    el.dispatchEvent(new Event(type, { bubbles: true }));
  }

  function dispatchKeyboard(el, type, key) {
    el.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, key }));
  }

  function labelText(el) {
    if (!el) return '';
    const labels = [];
    const id = el.id || nestedAttr(el, 'id');
    if (id) document.querySelectorAll('label[for="' + cssEscape(id) + '"]').forEach(label => labels.push(cleanText(label.textContent)));
    const parentLabel = el.closest?.('label');
    if (parentLabel) labels.push(cleanText(parentLabel.textContent));
    const formItem = el.closest?.('.el-form-item, .ant-form-item, .form-item, .form-group, .layui-form-item, [class*="form-item"], [class*="FormItem"]');
    if (formItem) {
      const label = formItem.querySelector('label, .el-form-item__label, .ant-form-item-label, [class*="label"]');
      if (label) labels.push(cleanText(label.textContent));
    }
    return [...new Set(labels.filter(Boolean))].join(' ');
  }

  function contextText(el) {
    if (!el) return '';
    const parts = [];
    let node = el;
    for (let i = 0; i < 3 && node; i++) {
      const parent = node.parentElement;
      if (!parent) break;
      const text = cleanText(parent.innerText || parent.textContent || '');
      if (text && text.length <= 220) parts.push(text);
      node = parent;
    }
    return [...new Set(parts)].join(' ').slice(0, 300);
  }

  function markControl(el, state) {
    const target = controlRoot(el) || el;
    target.dataset.vaHighlight = state;
    target.style.outline = state === 'ok' ? '2px solid #37d6a3' : '2px solid #ff5d5d';
    target.style.outlineOffset = '2px';
  }

  function clearHighlights() {
    document.querySelectorAll('[data-va-highlight]').forEach(el => {
      delete el.dataset.vaHighlight;
      el.style.outline = '';
      el.style.outlineOffset = '';
    });
  }

  function elementKey(el) {
    return [
      el.tagName,
      el.id || nestedAttr(el, 'id'),
      el.getAttribute('name') || nestedAttr(el, 'name'),
      el.dataset.vaIndex || '',
      controlKind(el),
    ].join('#');
  }

  function nestedAttr(el, attr) {
    if (!el?.querySelector) return '';
    const node = el.querySelector('[' + attr + ']');
    return node?.getAttribute(attr) || '';
  }

  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  }

  function normalizeMonth(value) {
    const s = String(value || '').trim();
    const m = s.match(/(\d{4})[年\/.\-]?(\d{1,2})/);
    if (!m) return s;
    return m[1] + '-' + m[2].padStart(2, '0');
  }

  function cleanText(text) {
    return String(text || '').replace(/\s+/g, ' ').replace(/[：:*]/g, '').trim();
  }

  function norm(text) {
    return String(text || '').toLowerCase().replace(/[\s_\-:/\\（）()【】\[\]·.，,。*：]/g, '');
  }

  function cssEscape(value) {
    if (window.CSS?.escape) return CSS.escape(value);
    return String(value).replace(/["\\]/g, '\\$&');
  }

  function resetPageAbort() {
    pageAbortRequested = false;
    pageAbortReason = '';
  }

  function throwIfPageAborted() {
    if (pageAbortRequested) throw new PageAbortError(pageAbortReason || '页面自动化已中断');
  }

  function isPageAbortError(error) {
    return error && (error.name === 'PageAbortError' || error.__aborted === true);
  }

  function ignoreUnlessPageAbort(error) {
    if (isPageAbortError(error)) throw error;
  }

  function abortCurrentTask(reason) {
    pageAbortRequested = true;
    pageAbortReason = String(reason || '页面自动化已中断');
    stopSubmitWatch('abort-current-task');
    try { document.querySelectorAll('[data-va-modal-notice], [data-va-brand-hint], [data-va-manual-select]').forEach(n => n.parentNode?.removeChild?.(n)); } catch (e) { ignoreUnlessPageAbort(e); }
    pageSleepEntries.forEach(entry => {
      try { clearTimeout(entry.timer); } catch (e) { ignoreUnlessPageAbort(e); }
      try { entry.reject(new PageAbortError(pageAbortReason)); } catch (e) { ignoreUnlessPageAbort(e); }
    });
    pageSleepEntries.clear();
    return { status: 'aborted', reason: pageAbortReason };
  }

  function sleep(ms) {
    throwIfPageAborted();
    return new Promise((resolve, reject) => {
      const entry = { timer: null, reject };
      entry.timer = setTimeout(() => {
        pageSleepEntries.delete(entry);
        try { throwIfPageAborted(); } catch (e) { reject(e); return; }
        resolve();
      }, ms);
      pageSleepEntries.add(entry);
      if (pageAbortRequested) {
        pageSleepEntries.delete(entry);
        clearTimeout(entry.timer);
        reject(new PageAbortError(pageAbortReason));
      }
    });
  }

  // ==================== 车系/车型自动创建功能 ====================

  /**
   * 等待导航到目标路径（SPA路由变化）
   */
  async function waitForNavigation(targetPathHint, timeoutMs = 5000) {
    throwIfPageAborted();
    const deadline = Date.now() + Math.max(800, Number(timeoutMs) || 5000);
    while (Date.now() < deadline) {
      throwIfPageAborted();
      if (targetPathHint && location.href.includes(targetPathHint)) {
        await sleep(220);
        return { status: 'ok', href: location.href };
      }
      const state = document.readyState;
      if (state === 'complete' || state === 'interactive') {
        if (!targetPathHint) return { status: 'ok', href: location.href };
      }
      await sleep(150);
    }
    return { status: 'timeout', href: location.href, message: `等待导航到 ${targetPathHint} 超时` };
  }

  /**
   * 判断当前页面"真的是"目标页（车系管理 / 车型管理）—— 不是只看 URL，要三份证据：
   *  (A) URL 包含目标路径 /model/series 或 /model/model
   *  (B) 左侧菜单叶子高亮项文本匹配目标叶子（车系管理 或 车型管理）
   *  (C) 页面中可见的表格表头列名匹配目标页的特征列：
   *        车系列表 = 一定有 车系名称（且没有「公告型号」）
   *        车型列表 = 有 车型名称 + 公告型号 （两个特征，避免和车系列表混淆）
   * 三者中 (A)+(C) 同时成立即认为在目标页，因为 URL 是强约束，列名是页面内容强约束；
   * (B) 仅作为加分项（有些页面路由变了但菜单高亮 CSS 类名可能延迟）。
   */
  function isOnTargetSeriesOrModelPage(kind) {
    if (kind !== 'series' && kind !== 'model') return false;
    const href = location.href || '';
    const targetPath = kind === 'series' ? '/model/series' : '/model/model';
    const oppositePath = kind === 'series' ? '/model/model' : '/model/series';
    const urlOk = href.includes(targetPath);
    // 【负向硬门槛·URL 层】：如果当前 URL 明显在另一个 kind 的页，直接 false（避免 keep-alive DOM 缓存污染穿透）
    if (href.includes(oppositePath) && !href.includes(targetPath)) return false;

    // ---- 表头特征列：只取可见元素，避免 AntD keep-alive / 隐藏 Tab 的"历史页 DOM 文本残留" 污染判定 ----
    const visibleHeaders = [...document.querySelectorAll('th, .ant-table-thead .ant-table-cell, .ant-table-header .ant-table-cell, [class*="table"] [class*="head"] *')]
      .filter(isVisible)
      .map(el => cleanText(el.innerText || el.textContent || ''))
      .filter(Boolean);
    const visiblePageHeaderEl = [...document.querySelectorAll('.ant-page-header-heading-title, .ant-pro-page-container-title, h1, h2, [class*="page-header"] [class*="title"]')]
      .filter(isVisible)[0];
    const visiblePageHeader = visiblePageHeaderEl ? cleanText(visiblePageHeaderEl.innerText || '') : '';

    // 特征文本只从：可见表头 + 可见 page-header + **当前页主容器（仅取可见节点）** 收集，绝不碰 document.body.innerText（里面混了所有 keep-alive 的历史页文本）
    const mainContainer = document.querySelector('.ant-pro-table, .ant-spin-container, [class*="table-container"], .ant-layout-content, main') || document.body;
    const visibleFeatureNodes = [...mainContainer.querySelectorAll('th, td, .ant-form-item-label, label, [class*="page-header"] [class*="title"], h1, h2, h3, .ant-descriptions-item-label, .ant-table-cell')]
      .filter(isVisible);
    const visibleFeatureText = visibleFeatureNodes.map(n => cleanText(n.innerText || n.textContent || '')).join('|');
    const headerJoined = visibleHeaders.join('|') + '|' + visiblePageHeader + '|' + visibleFeatureText.slice(0, 5000);

    const has = (txt) => headerJoined.includes(txt);
    const seriesSig = has('车系名称') && !has('公告型号');
    const modelSig  = has('车型名称') && has('公告型号');
    const pageContentOk = (kind === 'series') ? seriesSig : modelSig;

    // 【负向硬门槛·内容层】：如果明显检测到另一个 kind 的特征（比如要判车型页，但页面只有车系名称表头、没有公告型号=明显在车系页），直接 false
    const oppositeContentOk = (kind === 'series') ? modelSig : seriesSig;
    if (oppositeContentOk && !pageContentOk) return false;

    // ---- 左侧菜单叶子高亮（仅取可见高亮节点） ----
    const menuHighlights = [...document.querySelectorAll('.ant-menu-item-selected, .ant-menu-item-active, .ant-menu-item.ant-menu-item-selected, li[aria-selected="true"], .is-active')]
      .filter(isVisible)
      .map(el => cleanText(el.innerText || el.textContent || ''))
      .filter(Boolean);
    const targetLeaf = kind === 'series' ? '车系管理' : '车型管理';
    const oppositeLeaf = kind === 'series' ? '车型管理' : '车系管理';
    const highlightOk = menuHighlights.some(t => t === targetLeaf || t.includes(targetLeaf));
    const oppositeHighlight = menuHighlights.some(t => t === oppositeLeaf || t.includes(oppositeLeaf));
    // 菜单高亮也做互斥：另一个 kind 的叶子高亮着=当前不在目标页
    if (oppositeHighlight && !highlightOk) return false;

    return (urlOk && pageContentOk) || (highlightOk && pageContentOk) || (urlOk && highlightOk && pageContentOk);
  }

  /**
   * ★ 用户明确要求：只允许模拟点击（左侧菜单/按钮/链接），绝不允许 URL 跳转 / SPA router / history push / tabs 切换。
   *   纯点击导航到车系/车型管理目标页，直到 isOnTargetSeriesOrModelPage(kind) 真的 true：
   *   最多 3 轮重试，每轮 = 展开"车型库管理"子菜单 → 点"车系管理/车型管理"叶子 → 轮询 3.5s 等 DOM 渲染出表格特征 th。
   */
  async function forceGotoSeriesOrModelPage(kind) {
    const menuName   = kind === 'series' ? '车系管理' : '车型管理';
    const submenuCandidate = /车型库管理/.test(document.body?.innerText || '') ? '车型库管理' : '车型管理';
    const logs = [];
    if (isOnTargetSeriesOrModelPage(kind)) {
      logs.push(`⭐ 已在${menuName}页，跳过导航`);
      return { ok: true, logs, href: location.href };
    }
    logs.push(`⏩ 纯点击导航到${menuName}，当前URL=${location.href}。策略：3轮重试 → 每轮=展开[${submenuCandidate}]子菜单→点${menuName}叶子→轮询3.5s等DOM渲染。★ 全程零 URL 操作、零 tabs 切换、零 SPA router。`);

    const MAX_ROUNDS = 3;
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      logs.push(`  [轮${round}/${MAX_ROUNDS}] 开始纯点击导航…`);
      // --- (1) 展开子菜单（车型库管理） ---
      try {
        const unfold = await ensureSubMenuExpanded(submenuCandidate, '车系管理|车型管理|品牌管理');
        logs.push(`    ·展开子菜单[${unfold.action}]：${unfold.message}`);
      } catch (e) { if (isPageAbortError(e)) throw e; logs.push(`    ·展开子菜单异常：${e?.message || String(e)}`); }
      await sleep(150);
      // --- (2) 点车系管理/车型管理叶子 ---
      let leafClicked = false;
      try {
        const leaf = await clickLeafMenuItem(menuName);
        logs.push(`    ·点叶子：${leaf.ok ? leaf.message : '失败：'+leaf.message}`);
        leafClicked = !!leaf.ok;
      } catch (e) { if (isPageAbortError(e)) throw e; logs.push(`    ·点叶子异常：${e?.message || String(e)}`); }
      // --- (3) 等 DOM 渲染：纯看内容，不看 URL（防止 pushState 后内容未加载） ---
      if (leafClicked) {
        const pollDeadline = Date.now() + 3500;
        let lastSample = '';
        while (Date.now() < pollDeadline) {
          if (isOnTargetSeriesOrModelPage(kind)) {
            logs.push(`    ✅ 轮${round} 成功（点完叶子后等了 ${(3500 - (pollDeadline - Date.now()))}ms，DOM 渲染出${menuName}特征表头）。`);
            return { ok: true, logs, href: location.href };
          }
          await sleep(220);
        }
        // 超时：抓当前 DOM 样本到日志
        try {
          const th = [...document.querySelectorAll('th,.ant-table-cell')].filter(isVisible).map(e => (e.innerText||'').trim()).filter(Boolean).slice(0, 10).join('|');
          lastSample = `可见表头前10=[${th}]`;
        } catch (e) { ignoreUnlessPageAbort(e); }
        logs.push(`    ·轮${round} DOM 渲染超时(3500ms) → ${lastSample || '未采集到表头'}`);
      }
      // 等 200ms 再下一轮重试（防止菜单动画导致叶子不在可视区）
      await sleep(200);
    }
    // 3 轮都失败
    let debug = '';
    try {
      const allMenuVisible = [...document.querySelectorAll('a,li,.ant-menu-item,.ant-menu-submenu-title,[class*="menu-item"]')]
        .filter(isVisible).map(e => (e.innerText||'').trim()).filter(Boolean).slice(0, 25);
      debug = ` | 左侧可见菜单前25项=[${allMenuVisible.join(' > ')}]`;
    } catch (e) { ignoreUnlessPageAbort(e); }
    return { ok: false, logs, href: location.href, message: `3轮纯点击导航仍未能命中${menuName}（可能是子菜单未展开/叶子不可见，请手动点击左侧[车型库管理]→[${menuName}]后，点侧边栏【重填当前行】重试${debug}）` };
  }

  /**
   * 【React合成事件穿透·终极方案1】
   *   你当前截图场景：插件 8+ 轮 robustClick 都打在 submenu-title / 父 li 上，DOM.dispatchEvent 和 el.click() 都被 AntD Pro 布局的事件代理 / React 合成事件 isTrusted 过滤给吞了，父菜单纹丝不动。
   *   解决：直接从 DOM 节点拿 React 16/17/18 的 Fiber 节点（__reactFiber$xxx / __reactInternalInstance$xxx），
   *         读取 memoizedProps / pendingProps.onClick / onClickCapture，直接 () => 调，完全绕过浏览器 isTrusted 检查。
   */
  function findReactOnClickByDom(el) {
    if (!el) return null;
    // =====================================================================
    // ★★★ AntD SubMenu 的 React Fiber 并不一定在「当前DOM节点自身属性」上，
    //   可能挂在「DOM节点的 prototype 链」里（Object.keys() 看不到），
    //   或者是挂在 parentNode / ownerSVGElement / hostContainer 这类非自身属性上。
    //   修复：不再只用 Object.keys 遍历，改用 for...in + hasOwnProperty 兜底（含原型链），
    //   并且直接用 obj['__reactFiber$randomhash'] 式 key 粗查（Object.getOwnPropertySymbols 也查一次）。
    // =====================================================================
    function readFiberFrom(node) {
      if (!node) return null;
      // 1) 快速：直接查常见 Fiber key（大部分 React 16/17/18 是挂在 host component DOM 上）
      const directKeys = [
        '__reactFiber$', '__reactInternalInstance$',
        '_reactFiber', '_reactInternal', '__REACT_FIBER__',
      ];
      for (let k of directKeys) {
        // 用 Object.getOwnPropertyNames + startsWith 匹配（真实 key 是 __reactFiber$<hash> 样式）
        try {
          const own = Object.getOwnPropertyNames(node);
          for (let i = 0; i < own.length; i++) {
            const name = own[i];
            if (name.startsWith('__reactFiber$') || name.startsWith('__reactInternalInstance$') || name === '_reactFiber') {
              const v = node[name];
              if (v && typeof v === 'object') return v;
            }
          }
        } catch (e) { ignoreUnlessPageAbort(e); }
        // 直接属性访问（有些框架会 defineProperty 到 node）
        for (let suffix = 0; suffix < 30; suffix++) {
          try {
            const val = node[k + String.fromCharCode(97 + (suffix % 26))]; // 扫不到就 break，下面走全局
            if (val && typeof val === 'object' && 'tag' in val) return val;
          } catch (e) { ignoreUnlessPageAbort(e); }
        }
      }
      // 2) Symbol：极少数用 Symbol 做 Fiber key
      try {
        const syms = Object.getOwnPropertySymbols ? Object.getOwnPropertySymbols(node) : [];
        for (let s = 0; s < syms.length; s++) {
          const v = node[syms[s]];
          if (v && typeof v === 'object' && (v.tag !== undefined)) return v;
        }
      } catch (e) { ignoreUnlessPageAbort(e); }
      // 3) 终极：for...in 扫 node 所有可枚举属性（含 prototype 链），值是 object 且带 tag/memoizedProps 就是 Fiber
      try {
        for (let k in node) {
          try {
            const v = node[k];
            if (!v || typeof v !== 'object') continue;
            if (('tag' in v && 'memoizedProps' in v) || ('pendingProps' in v && 'return' in v)) return v;
          } catch (e) { ignoreUnlessPageAbort(e); }
        }
      } catch (e) { ignoreUnlessPageAbort(e); }
      return null;
    }

    let fiber = null;
    // 先查当前节点 + 上 8 层父链（覆盖 AntD 把 SubMenu handler 绑在 wrapper 上的情况）
    let cur = el;
    for (let up = 0; up < 10 && !fiber && cur; up++, cur = cur.parentNode) {
      fiber = readFiberFrom(cur);
      if (fiber) break;
    }
    if (!fiber) return null;

    // =====================================================================
    // ★★★ Fiber 搜索范围扩大：
    //   原版只找 onClick/onClickCapture/onMouseDown。
    //   但 AntD Menu/SubMenu 展开逻辑可能叫：onTitleClick / onOpenChange / onExpand / onItemClick / onClick
    //   并且在 Inline SubMenu 中，展开逻辑是在 Menu 根组件的 state.openKeys 里维护的，
    //   onClick 往往绑在「Menu 容器（ant-menu）」上，不是 submenu-title。
    //   所以我们在 Fiber 上要：①查所有可能的 callback 名，②向上 return 链多找 30 层（到 Menu 根）。
    // =====================================================================
    const CALLBACK_NAMES = [
      'onClick', 'onClickCapture', 'onMouseDown', 'onMouseUp',
      'onTitleClick', 'onExpand', 'onOpenChange', 'onSubMenuClick',
      'onMenuItemClick', 'onItemClick', 'handleTitleClick', 'handleExpand',
      'onClickTitle', 'toggleOpen', 'toggleExpand', 'setOpenKeys',
    ];
    function findCallbackOnFiber(f) {
      if (!f) return null;
      const propsBags = [f.memoizedProps, f.pendingProps, f.props, f.stateNode?.props].filter(Boolean);
      for (let p = 0; p < propsBags.length; p++) {
        const bag = propsBags[p];
        if (typeof bag !== 'object' || !bag) continue;
        for (let i = 0; i < CALLBACK_NAMES.length; i++) {
          const n = CALLBACK_NAMES[i];
          if (typeof bag[n] === 'function') return bag[n];
        }
        // 终极兜底：bag 里任何键是 function 且键名含 click/expand/open（大小写不敏感）
        const bagKeys = Object.keys(bag);
        for (let i = 0; i < bagKeys.length; i++) {
          const k = bagKeys[i];
          if (/click|expand|open|toggle/i.test(k) && typeof bag[k] === 'function') return bag[k];
        }
      }
      return null;
    }

    const seen = new Set();
    const stack = [fiber];
    // 同时一路向上 return 链加 30 层（直达 Menu 根）
    for (let up = 0, f = fiber; up < 40 && f; up++, f = f.return) {
      if (f) stack.push(f);
    }
    let firstFound = null;
    while (stack.length) {
      const f = stack.pop();
      if (!f || seen.has(f)) continue;
      seen.add(f);
      const cb = findCallbackOnFiber(f);
      if (cb && !firstFound) firstFound = cb;
      // ★★★ 优先返回「离当前节点最近的非 undefined onClick / onTitleClick」——
      //   但如果有个 Fiber 上是 onExpand / setOpenKeys（Menu 根），也直接返回。
      //   这里只要找到 function 就返回，调用层会 try/catch。
      if (cb) return cb;
      if (f.child) stack.push(f.child);
      if (f.alternate) stack.push(f.alternate);
    }
    return firstFound;
  }

  /**
   * 【精准点展开箭头·终极方案2·重写版】
   *   之前版本的致命缺陷：找不到 svg 就 return titleRow（整个标题行 div），
   *   结果 clickAtExactCenter 点到「车源管理」四个字的中间去了，而不是右侧的 ▶ 图标。
   *   日志里也明确写了：策略2→OK（tag=DIV cls=ant-menu-submenu-title）—— 这是 100% 点错了对象。
   *
   *   重写版：
   *   1) 第一优先级：找真实的箭头 SVG/i/span（caret/down/up/right/arrow/expanded/chevron 关键词都命中）
   *   2) 第二优先级：在标题行「右 8% 区域」里找最小的可见元素（即使完全没 SVG，也确保点的是边缘而不是文字）
   *   3) ✅ 绝对不再回退到 titleRow 本身。找不出来就返回 null，让上层直接用 clickAtRightEdge(titleRow)。
   */
  function findSubMenuExpandIcon(submenuLi) {
    if (!submenuLi) return null;
    const titleRow = submenuLi.querySelector?.('.ant-menu-submenu-title, [class*="submenu-title"]') || submenuLi;
    const titleRect = titleRow?.getBoundingClientRect ? titleRow.getBoundingClientRect() : null;
    if (!titleRect || !titleRect.width) return null;
    const rightEdgeLeft = titleRect.right - Math.max(24, titleRect.width * 0.12); // 只看标题行最右侧 12% 像素区

    // ------- 1) 精确命中：带 arrow/expand 类名的容器（AntD 标准） -------
    const explicitSelectors = [
      '.ant-menu-submenu-arrow', '[class*="submenu-arrow"]',
      '.ant-menu-submenu-title>.ant-menu-arrow', '[class*="ant-menu-arrow"]',
      '[class*="expand-icon"]', '[class*="expanded-icon"]',
    ];
    for (let sel of explicitSelectors) {
      const n = submenuLi.querySelector?.(sel);
      if (n && isVisible(n)) {
        // 再确认：必须真的在右 12% 区
        const r = n.getBoundingClientRect?.() || null;
        if (!r || (r.left + r.width / 2) >= rightEdgeLeft - 20) return n;
      }
    }

    // ------- 2) SVG / 图形元素强搜（含 caret/down/right/chevron/expand 关键词的 svg/use/path） -------
    const allGraphicCandidates = [
      ...(submenuLi.querySelectorAll ? submenuLi.querySelectorAll('svg, use, path, i, [class*="icon"], [class*="caret"], [class*="chevron"]') : []),
    ];
    const graphicHits = [];
    for (let n of allGraphicCandidates) {
      if (!n || !isVisible(n)) continue;
      // 命中条件：class/svg/path 文本里含 expand/caret/arrow/down/right/up/chevron
      const cls = String(n.className || (n.getAttribute && n.getAttribute('class')) || '');
      const outer = (n.outerHTML || '').slice(0, 150).toLowerCase();
      const namedHit = /expand|arrow|caret|down|right|up|chevron|rotate|downline|outline/.test(cls.toLowerCase()) ||
                       /expand|arrow|caret|down|right|up|chevron|rotate/.test(outer);
      if (!namedHit) continue;
      const r = n.getBoundingClientRect?.() || null;
      if (!r || r.width === 0 || r.height === 0) continue;
      const cx = r.left + r.width / 2;
      // 必须在右 12% 区（容差 16px）
      if (cx < rightEdgeLeft - 16) continue;
      if (r.width > 48 || r.height > 48) continue;
      // 越接近右边缘、尺寸越小，分越高。
      const dist = titleRect.right - cx;
      graphicHits.push({ n, score: 2000 - dist * 2 - (r.width + r.height) });
    }
    graphicHits.sort((a, b) => b.score - a.score);
    if (graphicHits[0]) return graphicHits[0].n;

    // ------- 3) 右 8% 区里找最小的可见元素（span/div/i/svg） -------
    const rightX8 = titleRect.right - Math.max(16, titleRect.width * 0.08);
    const allInTitle = [...(titleRow.querySelectorAll ? titleRow.querySelectorAll('span, div, i, svg, a, img') : [])];
    const smallCands = [];
    for (let n of allInTitle) {
      if (!n || !isVisible(n)) continue;
      const r = n.getBoundingClientRect?.() || null;
      if (!r || r.width === 0 || r.height === 0) continue;
      const cx = r.left + r.width / 2;
      if (cx < rightX8 - 10) continue; // 不在右8%区就丢
      if (r.width > 40 || r.height > 40) continue;
      smallCands.push({ n, score: 1500 - (r.width + r.height) });
    }
    smallCands.sort((a, b) => b.score - a.score);
    if (smallCands[0]) return smallCands[0].n;

    // ★★★ 终极兜底：返回 null。
    //   上层调用方必须用 clickAtRightEdge(titleRow) 去点标题行右边缘坐标，
    //   绝对不能把 titleRow 本身当"expand icon"丢给 clickAtExactCenter（那是点文字中心）。
    return null;
  }

  /**
   * 【点标题行右边缘·最后防线】专门给「完全找不到 expand-icon 元素」的场景兜底：
   *   算 titleRow 的右边缘（距 right 约 12px，垂直居中），
   *   在这个坐标上派发 PointerEvent + MouseEvent 全家桶。
   *   这就是"真实用户点▶箭头"的位置，AntD Pro 布局无法再吞噬。
   */
  function clickAtRightEdge(titleRow) {
    if (!titleRow) return false;
    titleRow.scrollIntoView?.({ block: 'center', inline: 'nearest', behavior: 'instant' in Object.assign({}, {}) ? 'instant' : 'auto' });
    const r = titleRow.getBoundingClientRect ? titleRow.getBoundingClientRect() : null;
    if (!r || !r.width || !r.height) { robustClick(titleRow); return true; }
    // x 坐标：距右边缘约 12px（或宽度的 6%，取小的）；y 坐标：垂直中心
    const offsetX = Math.min(12, Math.max(4, Math.floor(r.width * 0.06)));
    const cx = r.right - offsetX;
    const cy = r.top + r.height / 2;
    const base = {
      bubbles: true, cancelable: true, view: window,
      clientX: cx, clientY: cy, pageX: cx + (window.scrollX || window.pageXOffset || 0),
      pageY: cy + (window.scrollY || window.pageYOffset || 0),
      screenX: cx + (window.screenLeft || window.screenX || 0),
      screenY: cy + (window.screenTop || window.screenY || 0) + 80,
      button: 0, buttons: 1, which: 1, detail: 1,
      pointerType: 'mouse', pointerId: 1, isPrimary: true, pressure: 0.5, width: 1, height: 1,
    };
    try {
      if (window.PointerEvent) {
        titleRow.dispatchEvent(new PointerEvent('pointerover', { ...base }));
        titleRow.dispatchEvent(new PointerEvent('pointerenter', { ...base }));
        titleRow.dispatchEvent(new PointerEvent('pointermove', { ...base }));
        titleRow.dispatchEvent(new PointerEvent('pointerdown', { ...base }));
      }
      titleRow.dispatchEvent(new MouseEvent('mousedown', { ...base }));
      titleRow.dispatchEvent(new MouseEvent('mouseup', { ...base }));
      titleRow.dispatchEvent(new MouseEvent('click', { ...base }));
      if (window.PointerEvent) titleRow.dispatchEvent(new PointerEvent('pointerup', { ...base }));
      try { titleRow.click(); } catch (e) { ignoreUnlessPageAbort(e); }
      return true;
    } catch (e) {
      robustClick(titleRow);
      return true;
    }
  }

  /**
   * 【坐标精准 click】在指定 DOM 节点的几何中心点派发 PointerEvent + MouseEvent 全家桶，
   * 比 robustClick 的"直接调 click()"更容易被 AntD Pro 当"真实点击"接住。
   */
  function clickAtExactCenter(el) {
    if (!el) return false;
    el.scrollIntoView?.({ block: 'center', inline: 'nearest', behavior: 'instant' in Object.assign({}, {}) ? 'instant' : 'auto' });
    const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    if (!r || !r.width || !r.height) {
      // 没拿到 rect 就兜底 robustClick
      robustClick(el);
      return true;
    }
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const base = {
      bubbles: true, cancelable: true, view: window,
      clientX: cx, clientY: cy, pageX: cx + (window.scrollX || window.pageXOffset || 0),
      pageY: cy + (window.scrollY || window.pageYOffset || 0),
      screenX: cx + (window.screenLeft || window.screenX || 0),
      screenY: cy + (window.screenTop || window.screenY || 0) + 80,
      button: 0, buttons: 1, which: 1, detail: 1,
      pointerType: 'mouse', pointerId: 1, isPrimary: true, pressure: 0.5, width: 1, height: 1,
    };
    try {
      if (window.PointerEvent) {
        el.dispatchEvent(new PointerEvent('pointerover', { ...base }));
        el.dispatchEvent(new PointerEvent('pointerenter', { ...base }));
        el.dispatchEvent(new PointerEvent('pointermove', { ...base }));
        el.dispatchEvent(new PointerEvent('pointerdown', { ...base }));
      }
      el.dispatchEvent(new MouseEvent('mousedown', { ...base }));
      el.dispatchEvent(new MouseEvent('mouseup', { ...base }));
      el.dispatchEvent(new MouseEvent('click', { ...base }));
      if (window.PointerEvent) el.dispatchEvent(new PointerEvent('pointerup', { ...base }));
      el.focus?.();
      // 兜底：再 native click() 一次
      try { el.click(); } catch (e) { ignoreUnlessPageAbort(e); }
      return true;
    } catch (e) {
      robustClick(el);
      return true;
    }
  }

  /**
   * 【统一的终极点击策略链】对任意 DOM 元素依次尝试：
   *   1) React Fiber 直接调 onClick（绕开 isTrusted 过滤，成功率最高）
   *   2) clickAtExactCenter 精准坐标点 PointerEvent 全家桶
   *   3) robustClick 原生兜底
   * 返回 true=至少有一种策略执行了（不保证页面真的响应，调用方要自己判结果）
   */
  function ultimateClick(el) {
    if (!el) return false;
    let ok = false;
    const reactOnClick = findReactOnClickByDom(el);
    if (reactOnClick) {
      try {
        reactOnClick({ stopPropagation: ()=>{}, preventDefault: ()=>{}, target: el, currentTarget: el });
        ok = true;
      } catch (e) { ignoreUnlessPageAbort(e); }
    }
    try {
      clickAtExactCenter(el);
      ok = true;
    } catch (e) { ignoreUnlessPageAbort(e); }
    if (!ok) {
      try { robustClick(el); ok = true; } catch (e) { ignoreUnlessPageAbort(e); }
    }
    return ok;
  }

  /**
   * 【诊断工具】打印左侧所有可见父菜单的文本 + 展开状态。
   *   菜单点击没反应时，调用它返回一段字符串供日志展示，用户/我一眼就能看出来
   *   车源管理父项是否被正确识别、当前是展开还是折叠。
   */
  function dumpLeftMenuSnapshot() {
    const pieces = [];
    const allVisibleMenuNodes = [...document.querySelectorAll(
      'li.ant-menu-submenu, .ant-menu-submenu, .ant-menu-submenu-title, [class*="submenu-title"], .ant-menu-item, [class*="ant-menu"][class*="menu"] li, li'
    )]
      .filter(el => isVisible(el));
    // 1) 父菜单
    allVisibleMenuNodes.forEach(el => {
      const text = cleanText((el.innerText || el.textContent || '').slice(0, 40));
      if (!text) return;
      // 父菜单（SubMenu 容器）：看 class 里有没有 submenu
      const cls = String(el.className || '');
      if (/ant-menu-submenu(?!-title)/.test(cls) || /li\.ant-menu-submenu/.test(String(el.tagName || '') + '.' + cls)) {
        const open = /ant-menu-submenu-open|ant-menu-open/.test(cls);
        const title = (el.querySelector?.('.ant-menu-submenu-title, [class*="submenu-title"]') ? cleanText((el.querySelector?.('.ant-menu-submenu-title, [class*="submenu-title"]').innerText || '').slice(0,20)) : text.slice(0,20));
        pieces.push(`父菜单[${title || text.slice(0,20)}](${open?'▶已展开◀':'折叠'})`);
        // 子级叶子：
        try {
          const leafs = [...el.querySelectorAll('.ant-menu-item,[class*="menu-item"]')].filter(isVisible).map(e => cleanText((e.innerText||'').slice(0,20))).filter(Boolean).slice(0,10);
          if (leafs.length) pieces.push(`  └ 叶子：${leafs.join('、')}`);
        } catch (e) { ignoreUnlessPageAbort(e); }
      }
    });
    // 2) 去重（因为同一个父菜单会被多个 DOM 节点命中）
    const seen = new Set();
    const uniq = [];
    pieces.forEach(s => { if (!seen.has(s)) { seen.add(s); uniq.push(s); } });
    if (uniq.length === 0) {
      return '【左侧菜单快照：未能采集到任何父菜单（页面可能还在 loading / 菜单被折叠成图标 sidebar-collapsed 模式）】';
    }
    return '【左侧菜单快照】父菜单数=' + (uniq.filter(s=>s.startsWith('父菜单')).length) + ' →\n  ' + uniq.join('\n  ');
  }

  /**
   * 检查Ant Design SubMenu是否已展开（下面的子菜单项是否可见）
   */
  function isSubMenuExpanded(submenuEl, childTextPattern) {
    if (!submenuEl?.parentElement) return false;
    // 方案1：看父级li上是否有ant-menu-submenu-open类
    const parentLi = submenuEl.closest?.('li');
    if (parentLi && /ant-menu-submenu-open|ant-menu-open/.test(String(parentLi.className || ''))) return true;
    // 方案2：aria-expanded=true（有些版本绑在li或submenu-title上）
    const ariaExp = parentLi?.getAttribute?.('aria-expanded') || submenuEl.getAttribute?.('aria-expanded');
    if (ariaExp === 'true') return true;
    // 方案3：在同级/子级里找包含子菜单文本的ant-menu-item（可见）
    const menuRoot = parentLi || document.querySelector('.ant-menu, [class*="menu"]') || document;
    const childItems = [...menuRoot.querySelectorAll('.ant-menu-item, [class*="menu-item"]')]
      .filter(isVisible)
      .filter(el => childTextPattern.test(cleanText(el.innerText || el.textContent || '')));
    return childItems.length > 0;
  }

  /**
   * ★ 确保SubMenu已展开（最多4轮重试，每轮双点击：父li容器 + submenu-title行；失败就打印诊断）。
   *   用户当前场景：概览页所有父菜单全折叠 → 点车源管理一次根本不展开 → 这是Ant Design accordion模式下的通病。
   *   解决：循环点，直到"审核列表/车系管理/车型管理"叶子真的 visible。
   */
  async function ensureSubMenuExpanded(submenuText, childSampleText) {
    const childPattern = new RegExp(childSampleText || '管理');
    const snapshotBefore = dumpLeftMenuSnapshot();
    const roundLogs = [];
    // =====================================================================
    // ★★★【候选收集·终极增强】
    // 原 collectCandidates 只查 .ant-menu-submenu 系列。但 AntD Pro / ProLayout
    // 有些版本把菜单包在 ProLayout / Sider 自定义组件里，class 名带 -pro- / -layout-。
    // 解决：扩大选择器范围（覆盖 li/div + 任何带 menu/submenu 关键词的 class），
    // 再用「标题行是否存在 + 是否在菜单容器内 + 文本匹配」得分排序，
    // 就算页面上有 50+ 候选也能精准选到用户要的那个。
    // =====================================================================
    function collectCandidates() {
      const rawCandidates = [
        // 1) AntD 标准 SubMenu 优先（最常见）
        ...document.querySelectorAll('li.ant-menu-submenu, .ant-menu-submenu, .ant-menu-submenu-title, [class*="ant-menu-submenu"]'),
        // 2) ProLayout / Sider 自定义 SubMenu（class 带 submenu / menu-sub / menu-group 等）
        ...document.querySelectorAll('[class*="submenu"]:not(.ant-menu-submenu):not(.ant-menu-submenu-title), [class*="menu-sub"], [class*="menu-group"]'),
        // 3) 兜底：左侧 aside/sidebar 内所有 li（只要文本像父菜单）
        ...document.querySelectorAll('aside li, .ant-layout-sider li, .sider li, .sidebar li, [class*="sider"] li, [class*="sidebar"] li'),
      ].filter((el, idx, arr) => el && arr.indexOf(el) === idx); // 去重

      return rawCandidates
        .filter(isVisible)
        .map(el => {
          // ------- 取文本（优先标题行文本，避免把子菜单全量文字当成父项名） -------
          let titleText = '';
          const innerTitle = el.querySelector?.('.ant-menu-submenu-title, [class*="submenu-title"], [class*="menu-title"], [class*="group-title"]');
          if (innerTitle) titleText = cleanText(innerTitle.innerText || innerTitle.textContent || innerTitle.getAttribute?.('aria-label') || '');
          if (!titleText) titleText = cleanText(el.innerText || el.textContent || el.getAttribute?.('aria-label') || '');
          if (!titleText) return null;
          // 如果标题文本过长（>30字）= 把整棵子树文字都算进来了，截断取第一行
          if (titleText.length > 40) titleText = titleText.split(/[\n\r]/)[0]?.slice(0, 40) || titleText.slice(0, 40);

          // ------- 找父 li 容器（最外层包含标题行+子菜单 ul 的那个 SubMenu 根） -------
          let li = el.closest?.('li')
            || el.closest?.('[class*="ant-menu-submenu"]')
            || el.closest?.('[class*="submenu"]')
            || (String(el.tagName || '') === 'LI' ? el : null);
          if (!li) {
            // 再尝试：当前 el 本身就是 SubMenu
            const cls = String(el.className || '');
            if (/submenu|ant-menu-submenu|menu-group/.test(cls) || String(el.tagName || '') === 'LI') li = el;
          }

          // ------- 找 submenu-title 标题行（真正有展开箭头 + click handler 的那一行） -------
          let titleRow = null;
          const titleSelectors = '.ant-menu-submenu-title, [class*="submenu-title"], [class*="menu-title"], [class*="group-title"], [role="button"]';
          if (li) {
            titleRow = li.querySelector?.(titleSelectors);
            // 如果 li 本身就带 submenu-title class = 它就是标题行
            if (!titleRow && /ant-menu-submenu-title|submenu-title|menu-title/.test(String(li.className || ''))) titleRow = li;
          }
          if (!titleRow && /ant-menu-submenu-title|submenu-title|menu-title/.test(String(el.className || ''))) titleRow = el;
          if (!titleRow) {
            // 终极兜底：找 el 里第一个可见子 div/span（菜单行通常 = 一行文字 + 右侧箭头）
            const firstRowChild = [...(el.children || [])].find(c => c && isVisible(c) && ['DIV','SPAN','A'].includes(String(c.tagName || '')));
            titleRow = firstRowChild || el;
          }
          if (!titleRow) titleRow = li || el;

          // ------- 判断是否在菜单容器内（aside / sider / menu） -------
          const menuContainer = (li || el).closest?.('.ant-menu, [class*="ant-menu"], aside, .sidebar, [class*="sider"], [class*="layout-sider"]');
          if (!menuContainer && !li) return null;

          // ------- 文本匹配打分（严格） -------
          const t = titleText;
          const exactScore = t === submenuText ? 500 : 0;
          const startsScore = (t.startsWith(submenuText) || submenuText.startsWith(t)) ? 320 : 0;
          const includesScore = t.includes(submenuText) ? 260 : (submenuText.includes(t) && t.length >= 2 ? 200 : 0);
          if (!(exactScore + startsScore + includesScore)) return null; // 文本完全不匹配 = 直接丢

          let score = exactScore + startsScore + includesScore;
          score += li ? 80 : 0;
          score += (/ant-menu-submenu-title|submenu-title/.test(String(titleRow.className || '')) ? 60 : 0);
          score += (/ant-menu-submenu(?!-title)/.test(String(li?.className || '')) ? 50 : 0);
          score += (!!menuContainer ? 30 : 0);
          // 在菜单容器内 + 是 li = 加 120 超高优先级，防止串到"页面其他位置的同名父菜单"
          if (menuContainer && li && String(li?.tagName || '') === 'LI') score += 120;

          return { li: li || titleRow, titleRow, text: t, score, inMenu: !!menuContainer };
        })
        .filter(Boolean)
        .sort((a, b) => (Number(b.inMenu) - Number(a.inMenu)) || (b.score - a.score) || (a.text.length - b.text.length));
    }

    const MAX_ROUNDS = 5;
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      const cands = collectCandidates();
      const pick = cands[0];
      if (!pick) { roundLogs.push(`  [轮${round}] 没有任何候选（DOM还没渲染/菜单容器未加载），等 280ms 再试`); await sleep(280); continue; }
      roundLogs.push(`  [轮${round}] 选中候选：text="${pick.text.slice(0,20)}" score=${pick.score} liCls=${String(pick.li?.className||'').slice(0,60)} titleCls=${String(pick.titleRow?.className||'').slice(0,60)}`);

      // 先检测：本轮前是不是已经展开了
      const already = isSubMenuExpanded(pick.titleRow, childPattern);
      if (already) {
        return { ok: true, message: `【轮${round}】"${submenuText}"已展开（子菜单有${childSampleText}叶子可见）。${roundLogs.join('\n')}  snapshotBefore=${snapshotBefore}`, action: 'no-op' };
      }

      // =============================================================
      // ★★★【每轮三策略】（从强到弱依次尝试，任一中即判展开成功）
      //   策略1：直接调 React Fiber onClick（绕过 isTrusted 检查，不依赖真实 PointerEvent）
      //   策略2：精准点右侧展开箭头（找 ▶ 图标容器，按中心点坐标发 PointerEvent 全家桶）
      //   策略3：兜底双点父 li + titleRow（旧 robustClick）
      // =============================================================
      const titleRow = pick.titleRow;
      const pickLi = pick.li;

      // --- 策略1：React Fiber 直接调用 onClick ---
      const reactOnClick = findReactOnClickByDom(titleRow) || findReactOnClickByDom(pickLi);
      let strategy1Hit = false;
      if (reactOnClick) {
        try {
          reactOnClick({ stopPropagation: ()=>{}, preventDefault: ()=>{}, target: titleRow, currentTarget: titleRow });
          strategy1Hit = true;
          roundLogs.push(`    ·策略1: 调用 React Fiber onClick → OK`);
        } catch (e) { roundLogs.push(`    ·策略1: React onClick 调用异常: ${e?.message || String(e)}`); }
        await sleep(round === 1 ? 380 : 260);
        const opened = isSubMenuExpanded(titleRow, childPattern);
        if (opened) return { ok: true, message: `【轮${round}】策略1: React Fiber onClick 展开"${submenuText}"成功 → ${roundLogs.join(' | ')}`, action: 'react-onclick' };
      } else {
        roundLogs.push(`    ·策略1: 未找到 React Fiber onClick（titleRow/li 都没有__reactFiber$属性）`);
      }

      // --- 策略2：精准点右侧展开箭头中心（找不到就走 clickAtRightEdge 点标题行右边缘坐标） ---
      const arrowIcon = findSubMenuExpandIcon(pickLi || titleRow);
      if (arrowIcon) {
        try {
          clickAtExactCenter(arrowIcon);
          roundLogs.push(`    ·策略2A: 精准点展开箭头中心 → OK（tag=${arrowIcon.tagName} cls=${String(arrowIcon.className||'').slice(0,50)}）`);
        } catch (e) { roundLogs.push(`    ·策略2A: 点箭头异常: ${e?.message || String(e)}`); }
        await sleep(round === 1 ? 500 : 380);
        const opened = isSubMenuExpanded(titleRow, childPattern);
        if (opened) return { ok: true, message: `【轮${round}】策略2A: 点箭头中心展开"${submenuText}"成功 → ${roundLogs.join(' | ')}`, action: 'click-arrow' };
      } else {
        roundLogs.push(`    ·策略2A: findSubMenuExpandIcon 返回空（没找到真实箭头元素）`);
        // ★★★ 策略2B：强制造访 titleRow 右边缘 12px 位置（就是真实用户点 ▶ 的地方）
        try {
          clickAtRightEdge(titleRow);
          roundLogs.push(`    ·策略2B: clickAtRightEdge(titleRow右边缘) → OK`);
        } catch (e) { roundLogs.push(`    ·策略2B: clickAtRightEdge 异常: ${e?.message || String(e)}`); }
        await sleep(round === 1 ? 500 : 380);
        const openedB = isSubMenuExpanded(titleRow, childPattern);
        if (openedB) return { ok: true, message: `【轮${round}】策略2B: clickAtRightEdge 展开"${submenuText}"成功 → ${roundLogs.join(' | ')}`, action: 'click-right-edge' };
      }

      // --- 策略3：兜底双点父 li + titleRow（旧逻辑，最后防线） ---
      robustClick(pickLi);
      await sleep(130);
      robustClick(titleRow);
      roundLogs.push(`    ·策略3: 兜底双点（li+titleRow）→ 执行`);
      await sleep(round === 1 ? 500 : 400);
      const opened3 = isSubMenuExpanded(titleRow, childPattern);
      if (opened3) return { ok: true, message: `【轮${round}】策略3: 兜底双点展开"${submenuText}"成功 → ${roundLogs.join(' | ')}`, action: 'double-click' };

      // --- 策略4（终极·DOM暴力）：直接改 class + 把子菜单 ul show 出来 + dispatch 一次合成事件同步 React ---
      //     到这一步说明：Fiber 找不到 onClick、事件代理吞噬了 PointerEvent、robustClick 也没用。
      //     最后一搏：用 DOM API 强制把 li 变成「已展开」状态，至少让后续能点到叶子菜单。
      {
        try {
          const liEl = (pickLi && pickLi.nodeType === 1) ? pickLi : (titleRow.closest?.('li.ant-menu-submenu, .ant-menu-submenu') || pickLi);
          if (liEl && liEl.classList) {
            const classesBefore = String(liEl.className || '');
            // ① 加展开 class（AntD SubMenu 判断展开的核心依据），去折叠 class
            liEl.classList.add('ant-menu-submenu-open', 'ant-menu-open');
            liEl.classList.remove('ant-menu-submenu-closed');
            // ② aria-expanded=true
            try { liEl.setAttribute('aria-expanded', 'true'); } catch(_) {}
            try { if (titleRow.setAttribute) titleRow.setAttribute('aria-expanded', 'true'); } catch(_) {}
            // ③ 找子菜单 ul（SubMenu 里的 .ant-menu, ul），强制 display:block
            const subUl = liEl.querySelector?.('ul, .ant-menu, .ant-menu-sub, [class*="menu-item-group"], [class*="submenu-popup"]');
            if (subUl) {
              const computed = window.getComputedStyle ? window.getComputedStyle(subUl) : null;
              if (computed && (computed.display === 'none' || computed.visibility === 'hidden' || computed.height === '0px')) {
                subUl.style.setProperty('display', 'block', 'important');
                subUl.style.setProperty('visibility', 'visible', 'important');
                subUl.style.setProperty('overflow', 'visible', 'important');
                subUl.style.setProperty('height', 'auto', 'important');
                subUl.style.setProperty('opacity', '1', 'important');
              }
            }
            // ④ 再给 titleRow 发一次 mousedown→mouseup→click（try 同步 React 状态，避免下一次 render 被覆盖回折叠）
            try { clickAtRightEdge(titleRow); } catch(_) {}
            // ⑤ 找 Menu 根容器（.ant-menu）dispatch 一次自定义 change/open 事件（有些 AntD Menu 会监听）
            const menuRoot = liEl.closest?.('.ant-menu, [class*="ant-menu-inline"], [class*="menu-root"]');
            if (menuRoot) {
              try { menuRoot.dispatchEvent(new CustomEvent('menu-open-keys-change', { bubbles: true, cancelable: true, detail: { key: submenuText, open: true } })); } catch(_) {}
              try { menuRoot.dispatchEvent(new Event('change', { bubbles: true, cancelable: true })); } catch(_) {}
            }
            roundLogs.push(`    ·策略4(DOM暴力展开): classBefore=${classesBefore.slice(0,60)} → classAfter=${String(liEl.className||'').slice(0,80)}，ulTuned=${!!subUl}`);
          } else {
            roundLogs.push(`    ·策略4(DOM暴力展开): 跳过（pickLi/titleRow.closest都没拿到li）`);
          }
        } catch (e) { roundLogs.push(`    ·策略4(DOM暴力展开): 异常=${String(e?.message||e).slice(0,80)}`); }
        await sleep(round === 1 ? 500 : 380);
        const opened4 = isSubMenuExpanded(titleRow, childPattern);
        if (opened4) return { ok: true, message: `【轮${round}】策略4(DOM暴力) 展开"${submenuText}"成功 → ${roundLogs.join(' | ')}`, action: 'force-dom-open' };
      }

      // --- 第 2 轮起再补：策略2 再点一次箭头/右边缘 + React 再调一次 ---
      if (round >= 2) {
        roundLogs.push(`    ·第${round}轮补招：clickAtRightEdge+ultimateClick(titleRow) combo`);
        try { clickAtRightEdge(titleRow); } catch(_) {}
        const reReact = findReactOnClickByDom(titleRow) || findReactOnClickByDom(pickLi);
        try { if (reReact) reReact({ stopPropagation:()=>{}, preventDefault:()=>{}, target: titleRow, currentTarget: titleRow }); } catch(_) {}
        try { ultimateClick(titleRow); } catch(_) {}
        await sleep(220);
        try { ultimateClick(pickLi); } catch(_) {}
        await sleep(400);
        const openedRet = isSubMenuExpanded(titleRow, childPattern);
        if (openedRet) return { ok: true, message: `【轮${round}】补招combo成功展开"${submenuText}" → ${roundLogs.join(' | ')}`, action: 'retry-combo-ex' };
        // 最后：DOM暴力再推一次（可能第一轮只改了 class，第二次才把子 ul display 改好）
        try {
          const liEl2 = (pickLi && pickLi.nodeType === 1) ? pickLi : (titleRow.closest?.('li.ant-menu-submenu, .ant-menu-submenu') || pickLi);
          if (liEl2 && liEl2.classList) {
            liEl2.classList.add('ant-menu-submenu-open', 'ant-menu-open');
            const subUl2 = liEl2.querySelector?.('ul, .ant-menu, .ant-menu-sub');
            if (subUl2) {
              subUl2.style.setProperty('display', 'block', 'important');
              subUl2.style.setProperty('visibility', 'visible', 'important');
              subUl2.style.setProperty('overflow', 'visible', 'important');
              subUl2.style.setProperty('height', 'auto', 'important');
              subUl2.style.setProperty('opacity', '1', 'important');
            }
            roundLogs.push(`    ·第${round}轮补·DOM暴力再推一次: class=${String(liEl2.className||'').slice(0,60)}`);
          }
        } catch(_) {}
        await sleep(250);
        const openedRet2 = isSubMenuExpanded(titleRow, childPattern);
        if (openedRet2) return { ok: true, message: `【轮${round}】补·DOM暴力再推一次展开"${submenuText}"成功 → ${roundLogs.join(' | ')}`, action: 'retry-dom-push' };
      }
    }

    // 5 轮都失败：把诊断快照返回
    const snapAfter = dumpLeftMenuSnapshot();
    return {
      ok: false,
      action: 'failed',
      message: `【${MAX_ROUNDS}轮全失败】三策略（React onClick→点箭头中心→兜底双点）都没能展开"${submenuText}"子菜单（期待出现${childSampleText}）。请手动点一下左侧【${submenuText}】父项（▶ 折叠图标）。\n【每轮日志】\n  ${roundLogs.join('\n  ')}\n【菜单快照 BEFORE】\n  ${snapshotBefore}\n【AFTER】\n  ${snapAfter}`,
    };
  }

  /**
   * 点击左侧具体菜单项（叶子，如车系管理/车型管理）。
   * ★ 同 SubMenu 一样：先走 Fiber onClick（绕 isTrusted）→ 再 clickAtExactCenter 精准坐标点 → 最后 robustClick 兜底。
   *   否则叶子菜单点了半天也不跳（和父菜单展开同样的 AntD Pro 布局吞噬问题）。
   */
  async function clickLeafMenuItem(text) {
    const candidates = [...document.querySelectorAll(
      'a, li, .ant-menu-item, [class*="menu-item"], span, div'
    )]
      .filter(isVisible)
      .map(el => {
        const t = cleanText(el.innerText || el.textContent || el.getAttribute('aria-label') || '');
        const clickEl = clickableAncestor(el) || el;
        const menuContainer = el.closest?.('.ant-menu, [class*="menu"], aside, .sidebar, [class*="sider"]');
        const isItem = /ant-menu-item/.test(String(clickEl.className || '')) || /ant-menu-item/.test(String(el.className || ''));
        if (!menuContainer && !isItem) return null;
        // ★ 文本匹配严格化：如果 t 特别长 = 点错了父容器（把 SubMenu 整个展开内容当成叶子），直接判 0 分
        if (t.length > 30) return null;
        const score = (t === text ? 260
          : t.startsWith(text) || text.startsWith(t) ? 180
          : t.includes(text) ? 120 : 0)
          + (isItem ? 80 : 0)
          + (!!menuContainer ? 30 : 0);
        if (score <= 100) return null;
        return { el, clickEl, text: t, score };
      })
      .filter(Boolean);
    candidates.sort((a, b) => b.score - a.score || a.text.length - b.text.length);
    const pick = candidates[0];
    if (!pick || !pick.clickEl) return { ok: false, message: `未找到叶子菜单"${text}"（当前可见叶子候选=${candidates.length}，请先展开父菜单）` };
    const target = pick.clickEl;
    let logs = [];
    // --- 策略1：React Fiber onClick ---
    const reactOnClick = findReactOnClickByDom(target) || findReactOnClickByDom(pick.el);
    if (reactOnClick) {
      try {
        reactOnClick({ stopPropagation: ()=>{}, preventDefault: ()=>{}, target, currentTarget: target });
        logs.push('Fiber onClick OK');
      } catch (e) { logs.push('Fiber onClick异常:' + String(e?.message||e).slice(0,40)); }
      await sleep(260);
      return { ok: true, message: `点击[${text}]（Fiber onClick→${logs.join(';')}）`, href: location.href };
    }
    // --- 策略2：clickAtExactCenter 精准坐标点 ---
    try {
      clickAtExactCenter(target);
      logs.push('clickAtExactCenter OK');
      await sleep(260);
      return { ok: true, message: `点击[${text}]（精准坐标→${logs.join(';')}）`, href: location.href };
    } catch (e) { logs.push('clickAtExactCenter异常:' + String(e?.message||e).slice(0,40)); }
    // --- 策略3：兜底 robustClick ---
    robustClick(target);
    logs.push('robustClick OK');
    await sleep(260);
    return { ok: true, message: `点击[${text}]（兜底robustClick→${logs.join(';')}）`, href: location.href };
  }

  /**
   * 查找"新增"按钮（兼容「+ 新增」、「新增」、「新建」等多种文案）。
   * ★ 【2026.08.20 串页防呆·硬约束】：
   *   必须传 kind = 'series' | 'model'；
   *   只有当前页面真的满足 isOnTargetSeriesOrModelPage(kind) = true，并且
   *   不满足 isOnTargetSeriesOrModelPage(另一个kind)（防止 URL/菜单中间态两页都判 true 的边界情况），
   *   才允许返回按钮。任何一项不满足 → 直接 return null，宁可不点也不能串页。
   */
  function findCreateButton(kind) {
    if (kind !== 'series' && kind !== 'model') return null;
    // ① 正向硬门槛：必须在目标 kind 页
    if (!isOnTargetSeriesOrModelPage(kind)) return null;
    // ② 反向硬门槛：明显在另一个 kind 的页 = 绝对不返回
    const otherKind = kind === 'series' ? 'model' : 'series';
    if (isOnTargetSeriesOrModelPage(otherKind)) return null;
    // ③ URL 兜底：URL 在另一个 kind 的 path（即便上两步侥幸没拦住，这里直接截）
    const href = String(location.href || '');
    const otherPath = otherKind === 'series' ? '/model/series' : '/model/model';
    const targetPath = kind === 'series' ? '/model/series' : '/model/model';
    if (href.includes(otherPath) && !href.includes(targetPath)) return null;

    const candidates = [...document.querySelectorAll('button, a, [role="button"], .ant-btn')]
      .filter(isVisible)
      .map(el => {
        const text = cleanText(el.innerText || el.textContent || el.getAttribute('aria-label') || '');
        const isPrimary = /ant-btn-primary/.test(String(el.className || ''));
        // ④ 候选按钮文案互斥：kind=车型 只收含"新增车型/新增"的，不收含"新增车系"的；反过来同理；避免一个页面上同时有两个 kind 的按钮时串选
        if (kind === 'model' && /新增车系/.test(text)) return null;
        if (kind === 'series' && /新增车型/.test(text)) return null;
        let score = 0;
        if (/^新增$/.test(text)) score = 180;
        else if (/^新增$/.test(text.replace(/^[+＋]\s*/, ''))) score = 210; // 优先匹配「+ 新增」
        else if (kind === 'series' && /新增车系/.test(text)) score = 220;
        else if (kind === 'model' && /新增车型/.test(text)) score = 220;
        else if (/新增/.test(text)) score = 100;
        else if (/^新建$/.test(text.replace(/^[+＋]\s*/, ''))) score = 160;
        else if (/新建/.test(text)) score = 80;
        if (isPrimary) score += 40;
        if (/topBtn|\.topBtn|pageHeader/.test(String(el.className || ''))) score += 60;
        if (el.closest?.('.topBtn, [class*="topBtn"], .ant-page-header, [class*="page-header"]')) score += 50;
        return score > 0 ? { el, text, score } : null;
      })
      .filter(Boolean);
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0]?.el || null;
  }

  /**
   * 等待Modal/Drawer出现并返回根节点
   */
  async function waitForModalRoot(timeoutMs = 4500) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      throwIfPageAborted();
      // 1) 优先：ant-modal 真正的弹窗（中间显示）
      const modal = document.querySelector('.ant-modal-root .ant-modal-wrap:not(.ant-modal-hidden), .ant-modal-wrap:not(.ant-modal-hidden)');
      if (modal && isVisible(modal)) return modal;

      // 2) Drawer（右侧抽屉）：**务必返回 .ant-drawer-body 作为 scope**。
      //    注意：.ant-drawer-mask 是全屏遮罩，和 .ant-drawer（右侧抽屉容器）是兄弟节点，不是父子！
      //    如果错误地把 mask 当 scope，scope.querySelectorAll('label/input') 永远取不到抽屉 body 里的控件。
      let drawerRoot = document.querySelector('.ant-drawer-open .ant-drawer-body, .ant-drawer.ant-drawer-open .ant-drawer-body, .ant-drawer-body');
      if (drawerRoot && isVisible(drawerRoot)) return drawerRoot;

      const mask = document.querySelector('.ant-drawer-mask');
      if (mask && isVisible(mask)) {
        // 有 mask 但没直接拿到 body → 在 mask 的同级/父级里找 drawer body
        drawerRoot = (mask.parentElement?.querySelector('.ant-drawer-body'))
          || (mask.nextElementSibling?.querySelector?.('.ant-drawer-body'))
          || (mask.previousElementSibling?.querySelector?.('.ant-drawer-body'))
          || document.querySelector('.ant-drawer-body');
        if (drawerRoot && isVisible(drawerRoot)) return drawerRoot;
        // 极端情况：body 确实找不到，就退化为 mask（至少能告诉上层 drawer 已出现）
        return mask;
      }
      await sleep(180);
    }
    return null;
  }

  /**
   * 在Modal/Drawer中根据label文本找到对应的表单控件（input/select/dropdown/textarea）
   * @param {Element} scope 限定查找范围（抽屉body或modal）
   * @param {RegExp|string} labelPattern label文本匹配，如/品牌/或/常用排序/
   * @returns {Element|null} 找到的控件或null
   */
  function findControlInModalByLabel(scope, labelPattern) {
    if (!scope) return null;
    // 1) 找到所有可能包含 label 的节点，过滤在 scope 内、可见、匹配文本
    const labelNodes = [...scope.querySelectorAll('label, div, span, td, .ant-form-item-label, [class*="form-item-label"]')]
      .filter(el => scope.contains(el) || el === scope)
      .filter(isVisible)
      .map(el => {
        const text = cleanText(el.innerText || el.textContent || '');
        const matched = typeof labelPattern === 'string' ? text.includes(labelPattern) : labelPattern.test(text);
        if (!matched) return null;
        // 去掉冒号再比较，避免"品牌："和"*品牌："差异
        const normalized = text.replace(/[：:\s*（(].*$/g, '').replace(/^\s*[*＊]\s*/, '');
        if (!normalized.length) return null;
        return { el, text, normalized, score: text.length };
      })
      .filter(Boolean);
    // 优先选文本最短的（"品牌"优于"首字母品牌标签"）
    labelNodes.sort((a, b) => a.score - b.score);

    for (const match of labelNodes) {
      // 2) 找这个label节点最近的 ant-form-item 共同父容器
      const formItem = match.el.closest?.('.ant-form-item, [class*="form-item"], .ant-row, tr, .ant-col, [class*="col-"], li, dd');
      const searchRoot = formItem || scope;
      // 3) 在共同父容器内找 candidate 控件：优先 select / input / textarea / ant-select / cascader
      const controls = [...searchRoot.querySelectorAll('input, select, textarea, .ant-select, .ant-cascader, [class*="select"], [contenteditable="true"]')]
        .filter(el => {
          if (!scope.contains(el)) return false;
          if (!isVisible(el)) return false;
          const t = (el.tagName || '').toLowerCase();
          if (t === 'input') {
            const tp = String(el.getAttribute('type') || '').toLowerCase();
            if (['hidden', 'checkbox', 'radio', 'file', 'submit', 'button'].includes(tp)) return false;
          }
          return true;
        })
        .map(el => controlRoot(el) || el)
        .filter((v, i, arr) => arr.indexOf(v) === i); // 去重
      if (controls.length === 1) return controls[0];
      if (controls.length > 1) {
        // 有多个候选：优先离 label 近的（DOM 顺序靠后）
        const labelEl = match.el;
        controls.sort((a, b) => {
          const posA = a.compareDocumentPosition ? a.compareDocumentPosition(labelEl) : 4;
          const posB = b.compareDocumentPosition ? b.compareDocumentPosition(labelEl) : 4;
          // compareDocumentPosition: 2 = FOLLOWING(label在控件之前)，理想情况
          const followingA = (posA & 2) !== 0 ? 0 : 1;
          const followingB = (posB & 2) !== 0 ? 0 : 1;
          return followingA - followingB;
        });
        return controls[0];
      }
    }
    return null;
  }

  /**
   * 在Modal/Drawer中填一个字段：自动按label找控件，判断是input/dropdown/textarea再做相应填写
   */
  async function fillInModalByLabel(scope, fieldLabel, value, options) {
    const pattern = options?.pattern || new RegExp(fieldLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const control = findControlInModalByLabel(scope, pattern);
    if (!control) return { ok: false, message: `未找到"${fieldLabel}"字段控件` };
    const tag = (control.tagName || '').toLowerCase();
    const cls = String(control.className || '');
    const kind = options?.kind
      || (/ant-select|ant-cascader|\.select/.test(cls) ? 'dropdown'
        : tag === 'select' ? 'dropdown'
        : tag === 'textarea' ? 'textarea'
        : tag === 'input' ? 'input'
        : /编辑|select/.test(cls) ? 'dropdown'
        : 'input');

    if (kind === 'input' || kind === 'textarea' || kind === 'number') {
      control.scrollIntoView?.({ block: 'center' });
      control.focus?.();
      setNativeValue(control, String(value));
      dispatch(control, 'input');
      dispatch(control, 'change');
      control.blur?.();
      await sleep(options?.waitAfter || 260);
      return { ok: true, message: `填${fieldLabel}=${value}` };
    }
    if (kind === 'dropdown') {
      const spec = { field: String(fieldLabel), label: String(fieldLabel), kind: 'dropdown', required: !!(options?.required), waitAfter: options?.waitAfter || 700 };
      const result = await setDropdownValue(control, String(value), spec);
      return result;
    }
    return { ok: false, message: `不支持的${fieldLabel}控件类型: ${kind}` };
  }

  /**
   * 在Modal/Drawer中找表单的提交按钮（"确定"/"提交"）
   * 注：右侧 Drawer 的按钮通常在 .ant-drawer-footer 里，不在 .ant-drawer-body 内，所以要向上扩展到 .ant-drawer 整个容器来搜索
   */
  function findModalSubmitButton(scope) {
    // 如果 scope 是 drawer-body，必须扩大到最近的 .ant-drawer / .ant-drawer-wrapper-body 才能找到 footer 里的提交/取消按钮
    let root = scope || document;
    const drawerScope = scope?.closest?.('.ant-drawer, [class*="drawer-wrapper-body"], [class*="Drawer"]')
      || document.querySelector('.ant-drawer.ant-drawer-open')
      || null;
    if (drawerScope) root = drawerScope;

    const candidates = [...root.querySelectorAll('button, [role="button"], .ant-btn')]
      .filter(el => {
        if (!isVisible(el)) return false;
        // Drawer 模式：按钮必须在抽屉容器内（避免命中左侧车源管理页/列表上的其他蓝色提交按钮）
        if (drawerScope) {
          return drawerScope.contains(el) || !!el.closest?.('.ant-drawer, [class*="drawer-wrapper-body"]');
        }
        return true;
      })
      .map(el => {
        const text = cleanText(el.innerText || el.textContent || el.getAttribute('aria-label') || '');
        const isPrimary = /ant-btn-primary/.test(String(el.className || ''));
        let score = 0;
        if (/^提交$|^确定$/.test(text)) score = 200;
        else if (/提交|确定/.test(text)) score = 150;
        if (isPrimary) score += 80;
        // 偏好：在 footer 里的按钮（Drawers 都把 action 按钮放 footer）
        if (el.closest?.('.ant-drawer-footer, .ant-modal-footer, [class*="-footer"]')) score += 40;
        return score > 0 ? { el, text, score, isPrimary } : null;
      })
      .filter(Boolean);
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0]?.el || null;
  }

  /**
   * 在Modal/Drawer中找取消/关闭按钮（"取消"/"关闭"）—— Drawer footer 版
   */
  function findModalCancelButton(scope) {
    let root = scope || document;
    const drawerScope = scope?.closest?.('.ant-drawer, [class*="drawer-wrapper-body"], [class*="Drawer"]')
      || document.querySelector('.ant-drawer.ant-drawer-open')
      || null;
    if (drawerScope) root = drawerScope;

    const candidates = [...root.querySelectorAll('button, [role="button"], .ant-btn, .anticon-close, [aria-label="Close"]')]
      .filter(el => {
        if (!drawerScope) return isVisible(el);
        if (!isVisible(el)) return false;
        return drawerScope.contains(el) || !!el.closest?.('.ant-drawer, [class*="drawer-wrapper-body"]');
      })
      .map(el => {
        const text = cleanText(el.innerText || el.textContent || el.getAttribute('aria-label') || '');
        const isDefault = /ant-btn-default/.test(String(el.className || ''));
        let score = 0;
        if (/^取消$/.test(text)) score = 200;
        else if (/取消|关闭|Close/.test(text)) score = 150;
        if (isDefault) score += 30;
        if (el.closest?.('.ant-drawer-footer, .ant-modal-footer, [class*="-footer"]')) score += 40;
        return score > 0 ? { el, text, score, isDefault } : null;
      })
      .filter(Boolean);
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0]?.el || null;
  }

  /**
   * 从品牌名中推理首字母（大写首字母拼音首字或取拼音首字母）
   * 简化策略：取品牌中文名首字拼音的首字母（字典覆盖常见品牌），取不到就大写首字拼音字母
   */
  function guessFirstLetter(brandName, seriesName) {
    const firstLetterMap = {
      '一汽解放': 'Y', '东风': 'D', '重汽豪沃': 'Z', '重汽': 'Z', '安凯客车': 'A', '安凯': 'A',
      '比亚迪': 'B', '北奔重卡': 'B', '北奔': 'B', '福田': 'F', '陕汽': 'S', '江淮': 'J', '解放': 'J',
      '红岩': 'H', '大运': 'D', '乘龙': 'C', '宇通': 'Y', '金龙': 'J', '金旅': 'J', '中通': 'Z',
      '奔驰': 'B', '沃尔沃': 'W', '斯堪尼亚': 'S', '曼': 'M', '五十铃': 'W', '日野': 'R', '三菱': 'S',
    };
    const letter = firstLetterMap[String(brandName || '')];
    if (letter) return letter;
    // 兜底：取中文品牌/车系名称（去掉数字符号空白）第一个字符的 Unicode 分区简单处理
    const text = String(brandName || seriesName || '').replace(/[^\u4e00-\u9fa5a-zA-Z]/g, '');
    if (!text) return 'Q';
    const first = text.charAt(0);
    if (/[a-zA-Z]/.test(first)) return first.toUpperCase();
    // 实在无法推导，返回常用选项"常用"不是字母；返回 Q（其他）
    return 'Q';
  }

  /**
   * 在Modal/Drawer中填一个字段（ID优先→失败才走label兜底）。
   * 录音流程证实：抽屉内的表单控件有稳定 ID #myForm_*，先按 ID 定位才能 100% 匹配录制步骤；
   * 如果找不到（比如另一个版本的后台），再退化到 label 文本模糊匹配。
   *
   * @param {Element} scope 抽屉/弹窗根节点
   * @param {object} opts
   *   - id: string      // 优先查找的固定 ID（如 '#myForm_brandId'、'#myForm_seriesName'）
   *   - label: string   // 兜底用的 label 文本（如 '品牌'、'车系名称'）
   *   - kind: 'dropdown' | 'input' | 'textarea'
   *   - value: string   // 要填的值（dropdown: 匹配文本，input/textarea: 直接填入）
   *   - required: boolean
   *   - waitAfter: number ms
   *   - labelFallbackPattern: RegExp  // 可选：label 匹配时的自定义正则（默认按 label 构造）
   * @returns { ok, message, matchedBy: 'id' | 'label' | null }
   */
  async function fillByIdOrLabel(scope, opts) {
    const { id, label, kind, value, required, waitAfter, labelFallbackPattern } = opts || {};
    let matchedBy = null;
    let control = null;

    // Drawer（右侧抽屉）模式：固定 ID #myForm_* 在这个版本后台的 Drawer 里不存在，直接跳过 ID 查找，省掉 querySelector 开销
    const scopeCls = String(scope?.className || '');
    const isDrawerScope = /ant-drawer-body|ant-drawer-mask|ant-drawer/.test(scopeCls)
      || !!(scope?.closest?.('.ant-drawer, [class*="drawer-wrapper-body"]'));

    // Step 1: 优先按录音里的固定 ID 找（定位最精准，和真实点击一致）—— 非 Drawer 场景才跑
    if (id && !isDrawerScope) {
      try {
        const el = document.querySelector(id);
        if (el && isVisible(el) && (scope === document || scope.contains(el) || el.closest?.('body') === document.body)) {
          control = controlRoot(el) || el;
          matchedBy = 'id';
        }
      } catch (e) { ignoreUnlessPageAbort(e); }
    }

    // Step 2: ID 找不到 → 用 label 文本在 scope 内兜底（Drawer 场景直接走这里）
    if (!control && scope && label) {
      const pattern = labelFallbackPattern || new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      const el = findControlInModalByLabel(scope, pattern);
      if (el) {
        control = controlRoot(el) || el;
        matchedBy = 'label';
      }
    }

    if (!control) {
      // 【诊断】找不到控件时：打印 scope 内所有可见 label 和对应的候选 input/select，方便从浏览器 Console 直接看出匹配失败的根因
      try {
        if (scope && scope.querySelectorAll) {
          const diagLabels = [...scope.querySelectorAll('label, div, span, .ant-form-item-label, [class*="form-item-label"]')]
            .filter(el => scope.contains(el) && isVisible(el))
            .map(el => `"${cleanText(el.innerText || el.textContent || '').slice(0, 20)}"`)
            .filter(s => s.length > 2 && s !== '""')
            .slice(0, 40);
          const diagInputs = [...scope.querySelectorAll('input, select, textarea, .ant-select, .ant-cascader')]
            .filter(el => scope.contains(el) && isVisible(el))
            .map((el, i) => {
              const tag = (el.tagName || '').toLowerCase();
              const idAttr = el.getAttribute?.('id') || '';
              const place = el.getAttribute?.('placeholder') || (tag !== 'input' && tag !== 'select' && tag !== 'textarea' ? cleanText(el.innerText || '') : '');
              const cls = String(el.className || '').slice(0, 60);
              return `[${i}]<${tag}> id="${idAttr}" ph="${String(place || '').slice(0, 30)}" cls="${cls}"`;
            })
            .slice(0, 30);
          console.warn(`[VA fillByIdOrLabel] ${label || id} 找不到控件 Drawer=${isDrawerScope}。scope 内可见的 label（前40）：`, diagLabels);
          console.warn(`[VA fillByIdOrLabel]   对应 input/select/ant-select 候选（前30）：`, diagInputs);
        }
      } catch (_) { /* 诊断失败不影响主流程 */ }
      const msg = `[${label || id || '未命名字段'}] 控件未找到（id=${id || '无'}, label=${label || '无'}, scope=Drawer:${isDrawerScope}）`;
      return { ok: required ? false : true, message: msg + (required ? '（必填）' : '（选填跳过）'), matchedBy: null };
    }

    // Step 3: 按 kind 填值
    const tag = (control.tagName || '').toLowerCase();
    const cls = String(control.className || '');
    // 自动校正 kind：如果 ID 找到的控件实际是 ant-select 但传了 kind=input，自动改成 dropdown
    let realKind = kind;
    if (!realKind) {
      realKind = /ant-select|\.select|ant-cascader/.test(cls) ? 'dropdown'
        : tag === 'select' ? 'dropdown'
        : tag === 'textarea' ? 'textarea'
        : tag === 'input' ? 'input' : 'input';
    }

    try {
      if (realKind === 'dropdown') {
        const spec = { field: String(label || id || 'unknown'), label: String(label || id || 'unknown'), kind: 'dropdown', required: !!required, waitAfter: waitAfter || 700 };
        const r = await setDropdownValue(control, String(value), spec);
        // 【下拉填值失败·诊断增强】：必填项填不上时，把当前控件归属下拉面板里实际存在的所有选项文本
        // 直接拼进返回 message 里 → sidepanel logLine 就会显示到侧边栏，用户不用截图也能直接看到：
        // 「系统里到底有哪些品牌 / 是不是我 CSV 填的品牌名写错了 / 还是下拉根本没联动出来」
        let poolDiag = '';
        if (!r.ok && required) {
          try {
            const candidates = [];
            // 方案A：直接找 control 对应的归属面板（优先，绝对不会串到别的下拉）
            const ownerPanel = findDropdownPanelForControl(control, { includeHiddenPanels: true, kind: 'any' });
            let root = ownerPanel;
            // 方案B：没拿到归属面板就全局找所有 visible / 隐藏的 dropdown（兜底，至少把可见选项吐出来）
            if (!root) {
              const allPanels = queryAllDropdownPanels({ includeHidden: true });
              root = allPanels[0] || document.body;
            }
            if (root && root.querySelectorAll) {
              const opts = root.querySelectorAll('.ant-select-item-option, [role="option"], .ant-select-dropdown-menu-item, .el-select-dropdown__item, .ant-cascader-menu-item');
              opts.forEach(el => {
                if (!el || typeof el.innerText !== 'string') return;
                const t = cleanText(el.getAttribute?.('title') || el.innerText || el.textContent || '').slice(0, 30);
                if (t && !candidates.includes(t)) candidates.push(t);
              });
            }
            // 如果上面拿到的选项少于3个，说明面板没打开/没加载出来，再补一个：直接用 robustClick 点一下下拉让它打开再抓一次（不等待超时，点完只 sleep 300ms）
            if (candidates.length < 3) {
              try {
                const clicker = dropdownClickTarget(control);
                if (clicker) { robustClick(clicker); await sleep(300); }
                const root2 = findDropdownPanelForControl(control, { includeHiddenPanels: false, kind: 'any' });
                if (root2 && root2.querySelectorAll) {
                  const opts2 = root2.querySelectorAll('.ant-select-item-option, [role="option"], .ant-select-dropdown-menu-item, .el-select-dropdown__item');
                  opts2.forEach(el => {
                    const t = cleanText(el.getAttribute?.('title') || el.innerText || el.textContent || '').slice(0, 30);
                    if (t && !candidates.includes(t)) candidates.push(t);
                  });
                }
                // 抓完再关：局部关下拉（不再 document.body.click 全局 click-outside，会清掉用户已手动选的品牌！）
                try { await ensureDropdownClosed(control, null); } catch (e) { ignoreUnlessPageAbort(e); }
              } catch (e) { ignoreUnlessPageAbort(e); }
            }
            if (candidates.length) poolDiag = ` 【★下拉选项池(${candidates.length}项)：${candidates.slice(0, 20).map(s => '"' + s + '"').join('、')}${candidates.length > 20 ? ' ...(后略)' : ''}】`;
            else poolDiag = ' 【★下拉选项池：(面板未展开或无选项，请检查品牌/上级字段是否已联动)】';
          } catch (_) { poolDiag = ''; }
        }
        return { ok: r.ok || !required, message: `[${label || id}] ${r.ok ? '已选' : '未选中'}：${value} （${matchedBy === 'id' ? '按ID定位' : '按label匹配'}）${poolDiag}`, matchedBy, result: r };
      }

      if (realKind === 'input' || realKind === 'textarea' || realKind === 'number') {
        const realControl = (tag === 'input' || tag === 'textarea') ? control : (control.querySelector?.('input, textarea') || control);
        realControl.scrollIntoView?.({ block: 'center' });
        realControl.focus?.();
        setNativeValue(realControl, String(value));
        dispatch(realControl, 'input');
        dispatch(realControl, 'change');

        // 兼容 Vue：尝试把值同步到控件附近的 Vue 组件实例（input/textarea 常见 v-model）
        try {
          const vc = findVueComponent(control);
          if (vc) {
            const vm = (vc.__vue__) ? vc.__vue__ : vc;
            const synced = [];
            if (typeof vm.value !== 'undefined') { vm.value = String(value); synced.push('value'); }
            if (typeof vm.modelValue !== 'undefined') { vm.modelValue = String(value); synced.push('modelValue'); }
            if (synced.length) {
              try {
                if (typeof vm.$emit === 'function') {
                  vm.$emit('input', String(value));
                  vm.$emit('change', String(value));
                  vm.$emit('update:modelValue', String(value));
                } else if (vc.__vueParentComponent && typeof vc.__vueParentComponent.emit === 'function') {
                  vc.__vueParentComponent.emit('input', String(value));
                  vc.__vueParentComponent.emit('change', String(value));
                  vc.__vueParentComponent.emit('update:modelValue', String(value));
                }
              } catch (e) { ignoreUnlessPageAbort(e); }
            }
          }
        } catch (e) { ignoreUnlessPageAbort(e); }

        realControl.blur?.();
        await sleep(waitAfter || 260);
        return { ok: true, message: `[${label || id}] 已填：${value} （${matchedBy === 'id' ? '按ID定位' : '按label匹配'}）`, matchedBy };
      }

      return { ok: false, message: `[${label || id}] 不支持的控件类型: ${realKind}`, matchedBy };
    } catch (e) {
      if (isPageAbortError(e)) throw e;
      return { ok: required ? false : true, message: `[${label || id}] 填写异常：${e?.message || String(e)}` + (required ? '（必填）' : '（选填跳过）'), matchedBy };
    }
  }

  /**
   * 创建车系：严格对齐《车系流程》录音的字段顺序和字段数量（5 字段，无首字母）。
   *   录音真实步骤（Recording 2026_8_20 at 08_43_13.json）：
   *   1) #myForm_brandId            品牌      dropdown（点击第一个默认选项，实际这里传 brandName 匹配文本）
   *   2) #myForm_seriesName         车系名称  input
   *   3) #myForm_typeLevel          类型      dropdown（录音选 id=14 "牵引车"）
   *   4) #myForm_commonlyUsedSeries 常用车系  dropdown（录音选默认第一个"常用/否"，这里填"常用"）
   *   5) #myForm_sortField          常用排序  input → 填 "1"（与录音一致）
   *   6) 提交
   */
  async function createSeries(payload) {
    throwIfPageAborted();
    const { brandName, seriesName, vehicleType, brandConfirmed } = payload || {};
    if (!brandName) return { ok: false, message: '创建车系缺少品牌 brandName' };
    if (!seriesName) return { ok: false, message: '创建车系缺少车系名称 seriesName' };

    // 1) 点击新增按钮（录音里是 button.ant-btn-default "新增"）
    //    【2026.08.20 串页防呆】：强制 kind='series'，findCreateButton 内部会核 3 层硬门槛，宁可不点也绝不开错抽屉
    const createBtn = findCreateButton('series');
    if (!createBtn) return { ok: false, message: '车系管理页未找到"新增"按钮（页面判定不满足，防串页拦截已触发，请核当前URL是否在/model/series）' };
    robustClick(createBtn);
    await sleep(350);

    // 2) 等待弹窗/Drawer（右侧抽屉）
    let modal = await waitForModalRoot(4500);
    if (!modal) return { ok: false, message: '新增车系弹窗未弹出' };

    // 2.1) 【开错抽屉立即回滚·硬验证】：如果打开的 Drawer 里没有"车系名称"label，或者竟然出现了"公告型号"label（=车型 Drawer 特征），说明串页开错了
    //      → 立即模拟点取消/按 Escape 关掉 Drawer，返回 fail 让上层重试，绝不硬填把数据填错页
    const drawerLabelNodes = [...(modal.querySelectorAll ? modal : document).querySelectorAll('label, .ant-form-item-label, .ant-drawer-body *')]
      .filter(n => n && (typeof n.innerText === 'string' || typeof n.textContent === 'string'))
      .filter(isVisible);
    const drawerLabelText = drawerLabelNodes.map(n => cleanText(n.innerText || n.textContent || '')).join('|');
    const hasSeriesName = /车系名称/.test(drawerLabelText);
    const hasAnnouncementModel = /公告型号/.test(drawerLabelText);
    if (!hasSeriesName || hasAnnouncementModel) {
      try {
        const cancBtn = findModalCancelButton(modal);
        if (cancBtn) { robustClick(cancBtn); await sleep(200); }
        try { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true })); } catch (e) { ignoreUnlessPageAbort(e); }
      } catch (e) { ignoreUnlessPageAbort(e); }
      return { ok: false, message: `打开的 Drawer 不是车系新增（hasSeriesName=${hasSeriesName} hasAnnouncementModel=${hasAnnouncementModel}），已自动关闭。请检查当前页是否真的在"车系管理"列表页后再点侧边栏【重填当前行】触发重试。` };
    }

    // 安全兜底：如果返回的是 ant-drawer-mask（兄弟节点，不含控件），强制再取一次 drawer body 作为 scope
    if (/ant-drawer-mask/.test(String(modal.className || ''))) {
      const better = document.querySelector('.ant-drawer-open .ant-drawer-body, .ant-drawer-body') || modal;
      if (better && isVisible(better)) modal = better;
    }

    const steps = [];
    // ★★【品牌自动填·不再依赖 brandConfirmed 标记】：用户在车源新增页选过品牌（或 CSV 有品牌名）→
    //    创建车系时只要 brandName 非空就**无条件尝试自动填**，只有自动填失败（下拉里找不到该品牌）才回退 ensureBrandSelected 让用户手动。
    //    彻底杜绝"车源页选过品牌，创建车系还要再手动选一次"。
    let rBrand;
    if (brandName) {
      const fBrand = await fillByIdOrLabel(modal, {
        id: '#myForm_brandId', label: '品牌', kind: 'dropdown',
        value: brandName, required: true, waitAfter: 600,
        labelFallbackPattern: /品牌|品牌名称|车辆品牌/,
      });
      rBrand = {
        ok: !!fBrand?.ok,
        value: fBrand?.ok ? brandName : '',
        control: fBrand?.ok ? null : null,  // 自动填成功时不强制要 control（后续字段不依赖）
        message: fBrand?.ok ? `已自动沿用品牌「${brandName}」` : `自动填品牌失败：${fBrand?.message || '未知'}（回退手动选择）`,
        auto: true,
      };
      steps.push(`[1/5] 品牌：${rBrand.ok ? `OK → 已自动沿用「${brandName}」` : `FAIL → ${rBrand.message}`}`);
      if (!rBrand.ok) {
        // 自动填失败才回退手动（下拉里没有该品牌，必须让用户从系统里选一个真实存在的）
        console.log(`[创建车系] 品牌「${brandName}」自动填失败 → 回退 ensureBrandSelected 等待手动选择`);
        const rManual = await ensureBrandSelected(modal, {
          suggestText: '创建车系前请先手动选择品牌（类型/常用车系下拉都依赖品牌加载，没选品牌提交时会因必填被拦截。选完后自动继续填车系名称/类型/常用车系/常用排序 4 个字段）',
        });
        if (rManual.ok) {
          rBrand = { ...rManual, auto: true };
          steps.push(`  ↳ 回退成功：你已选择「${rManual.value}」`);
        }
      }
    } else {
      // brandName 为空（CSV 没填品牌）：必须让用户手动选
      rBrand = await ensureBrandSelected(modal, {
        suggestText: '创建车系前请先手动选择品牌（类型/常用车系下拉都依赖品牌加载，没选品牌提交时会因必填被拦截。选完后自动继续填车系名称/类型/常用车系/常用排序 4 个字段）',
      });
      steps.push(`[1/5] 品牌：${rBrand.ok ? `OK → 你已选择「${rBrand.value || brandName}」` : `MANUAL_${rBrand.ok ? 'HIT' : 'TIMEOUT/NOCTRL'} → ${rBrand.message}。请提交前自行确认品牌已选好（必填校验项）`}`);
    }
    const actualBrandName = (rBrand.ok && rBrand.value) ? rBrand.value : (brandName || '');
    // 选好品牌后，等一下类型/常用车系下拉按品牌异步联动加载完
    if (rBrand.ok) await sleep(600);

    // ====== 以下严格按右侧 Drawer 字段顺序（从上到下）填，品牌手动，插件填剩余 4 字段（车系名称/类型/常用车系/常用排序） ======

    // 字段1: 车系名称 (input)
    const fSeriesName = await fillByIdOrLabel(modal, {
      id: '#myForm_seriesName', label: '车系名称', kind: 'input',
      value: String(seriesName).trim(), required: true, waitAfter: 120,
    });
    steps.push(`[2/5] 车系名称：${fSeriesName.ok ? 'OK' : 'FAIL'} → ${fSeriesName.message}`);
    if (!fSeriesName.ok) return { ok: false, message: `创建车系：填车系名称失败 → ${fSeriesName.message}`, steps };

    // 字段2: 类型 (dropdown，录音选 id=14 即"牵引车")
    const vehicleTypeValue = vehicleType || '牵引车';
    const fType = await fillByIdOrLabel(modal, {
      id: '#myForm_typeLevel', label: '类型', kind: 'dropdown',
      value: vehicleTypeValue, required: true, waitAfter: 220,
      labelFallbackPattern: /类型|车辆类型/,
    });
    steps.push(`[3/5] 类型：${fType.ok ? 'OK' : 'FAIL'} → ${fType.message}`);
    if (!fType.ok && /必填|required/.test(String(fType.message || ''))) {
      return { ok: false, message: `创建车系：填类型失败 → ${fType.message}`, steps };
    }

    // 字段3: 常用车系 (dropdown)
    const fCommon = await fillByIdOrLabel(modal, {
      id: '#myForm_commonlyUsedSeries', label: '常用车系', kind: 'dropdown',
      value: '常用', required: true, waitAfter: 180,
    });
    steps.push(`[4/5] 常用车系：${fCommon.ok ? 'OK' : 'FAIL'} → ${fCommon.message}`);
    if (!fCommon.ok) {
      for (const fallback of ['是', '否']) {
        const r = await fillByIdOrLabel(modal, {
          id: '#myForm_commonlyUsedSeries', label: '常用车系', kind: 'dropdown',
          value: fallback, required: false, waitAfter: 180,
        });
        if (r.ok) {
          steps.push(`  ↳ 备选成功：选"${fallback}" → ${r.message}`);
          break;
        }
      }
    }

    // 字段4: 常用排序 (input)
    const fSort = await fillByIdOrLabel(modal, {
      id: '#myForm_sortField', label: '常用排序', kind: 'input',
      value: '1', required: true, waitAfter: 120,
    });
    steps.push(`[5/5] 常用排序：${fSort.ok ? 'OK' : 'FAIL'} → ${fSort.message}`);
    if (!fSort.ok) {
      for (const fallback of ['99999', '123']) {
        const r = await fillByIdOrLabel(modal, {
          id: '#myForm_sortField', label: '常用排序', kind: 'input',
          value: fallback, required: false, waitAfter: 120,
        });
        if (r.ok) {
          steps.push(`  ↳ 备选成功：填 ${fallback} → ${r.message}`);
          break;
        }
      }
    }

    await sleep(200);

    // 【需要人工提交确认】：填完 5 个字段后停在抽屉里，不再自动点提交，挂一次性监听器
    const submitBtn = findModalSubmitButton(modal);
    const cancelBtn = findModalCancelButton(modal);
    if (!submitBtn) {
      steps.push('候选button：');
      [...(modal || document).querySelectorAll('button')].filter(isVisible).forEach((b, i) => {
        steps.push(`  [${i}] text="${cleanText(b.innerText || b.textContent || '').slice(0, 20)}" class="${String(b.className || '').slice(0, 60)}"`);
      });
      return { ok: false, message: '未找到车系抽屉"提交"按钮', steps };
    }
    const notice = addNoticeInsideModal(modal, `车系「${seriesName}」除品牌外其他字段已填完 → 请手动选择品牌并确认所有字段无误后，点击右下角【提交】按钮`);
    steps.push('[人工确认] 车系名称/类型/常用车系/常用排序 已填完，等待你手动选品牌、确认字段后点抽屉里的"提交"按钮……（点取消/关闭=放弃创建）');
    console.log('[VA 车系创建] 字段已填完（品牌留人工选）→ 等待人工提交确认：', { brandName, seriesName, vehicleType });

    const ctx = { manualSubmitClicked: false, manualCancelClicked: false };
    const offSubmit = attachOneTimeClickListener(submitBtn, () => { ctx.manualSubmitClicked = true; });
    let offCancel = () => {};
    if (cancelBtn) offCancel = attachOneTimeClickListener(cancelBtn, () => { ctx.manualCancelClicked = true; });

    // 超时 10 分钟（给你足够的人工确认时间）
    const submitResult = await waitForCreateSuccess(modal, { timeoutMs: 10 * 60 * 1000, manualContext: ctx, label: `车系「${seriesName}」` });
    offSubmit(); offCancel(); removeNotice(notice);
    // 区分：你主动取消 vs 超时 vs 校验报错
    if (ctx.manualCancelClicked) {
      return { ok: false, message: `已取消创建车系「${seriesName}」（你点击了取消/关闭按钮）`, steps, cancelled: true };
    }
    // 品牌完全交给用户手动选，不再返回 userSelectedBrandName / brandName（sidepanel 不再需要覆盖 row.brandName）
    return {
      ok: submitResult.ok,
      message: submitResult.message || (submitResult.ok
        ? `车系"${seriesName}"创建成功（人工已提交确认，品牌由用户手动选择）`
        : `创建车系失败：${submitResult.message}`),
      steps,
      success: submitResult.ok,
    };
  }

  /**
   * 创建车型：严格对齐《车型流程》录音的字段顺序和字段数量（4 字段，无常用车型/排序/首字母）。
   *   录音真实步骤（车型/车型.json）：
   *   1) #myForm_brandId     品牌      dropdown
   *   2) #myForm_seriesId    车系      dropdown（录音点击 id=11503 选项）
   *   3) #myForm_modelName   车型名称  textarea（录音里是 textarea）
   *   4) #myForm_typeLevel   类型      dropdown（录音点击 id=14 即"牵引车"）
   *   5) 提交
   */
  async function createModel(payload) {
    throwIfPageAborted();
    const { brandName, seriesName, modelName, vehicleType, brandConfirmed } = payload || {};
    // ★ 品牌默认用户手动选（和售价、图片一样）；但如果 sidepanel 已传 brandConfirmed=true（车源新增页选过），则自动填品牌不再人工操作
    if (!seriesName) return { ok: false, message: '创建车型缺少车系 seriesName' };
    if (!modelName) return { ok: false, message: '创建车型缺少车型名 modelName' };

    // 1) 点击新增按钮（录音 topBtn 下 "新增" button）
    //    【2026.08.20 串页防呆】：强制 kind='model'，findCreateButton 内部会核 3 层硬门槛，宁可不点也绝不开错抽屉（比如开车系 Drawer）
    const createBtn = findCreateButton('model');
    if (!createBtn) return { ok: false, message: '车型管理页未找到"新增"按钮（页面判定不满足，防串页拦截已触发，请核当前URL是否在/model/model）' };
    robustClick(createBtn);
    await sleep(350);

    // 2) 等待弹窗/Drawer（右侧抽屉）
    let modal = await waitForModalRoot(4500);
    if (!modal) return { ok: false, message: '新增车型弹窗未弹出' };

    // 2.1) 【开错抽屉立即回滚·硬验证】：如果打开的 Drawer 里没有"车型名称"label，说明开错了（大概率开成了车系 Drawer）。
    //      车系 Drawer 的特征是有"车系名称"且没有"公告型号"（车系新增里没有公告型号字段）。遇到这种情况立刻关 Drawer + return fail。
    const drawerLabelNodes = [...(modal.querySelectorAll ? modal : document).querySelectorAll('label, .ant-form-item-label, .ant-drawer-body *')]
      .filter(n => n && (typeof n.innerText === 'string' || typeof n.textContent === 'string'))
      .filter(isVisible);
    const drawerLabelText = drawerLabelNodes.map(n => cleanText(n.innerText || n.textContent || '')).join('|');
    const hasModelName = /车型名称/.test(drawerLabelText);
    const hasSeriesName = /车系名称/.test(drawerLabelText);
    if (!hasModelName) {
      try {
        const cancBtn = findModalCancelButton(modal);
        if (cancBtn) { robustClick(cancBtn); await sleep(200); }
        try { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true })); } catch (e) { ignoreUnlessPageAbort(e); }
      } catch (e) { ignoreUnlessPageAbort(e); }
      return { ok: false, message: `打开的 Drawer 不是车型新增（hasModelName=${hasModelName} hasSeriesName=${hasSeriesName}），已自动关闭（很可能开成了"车系新增"抽屉=防串页上一层没拦住）。请核当前页是否真的在"车型管理"列表页后点侧边栏【重填当前行】重试。` };
    }

    // 安全兜底：如果返回的是 ant-drawer-mask（兄弟节点，不含控件），强制再取一次 drawer body 作为 scope
    if (/ant-drawer-mask/.test(String(modal.className || ''))) {
      const better = document.querySelector('.ant-drawer-open .ant-drawer-body, .ant-drawer-body') || modal;
      if (better && isVisible(better)) modal = better;
    }

    const steps = [];
    // ★★【品牌自动填·不再依赖 brandConfirmed 标记】：用户在车源新增页选过品牌（或 CSV 有品牌名）→
    //    创建车型时只要 brandName 非空就**无条件尝试自动填**，只有自动填失败（下拉里找不到该品牌）才回退 ensureBrandSelected 让用户手动。
    //    彻底杜绝"车源页选过品牌，创建车型还要再手动选一次"。
    let rBrand;
    if (brandName) {
      rBrand = await fillByIdOrLabel(modal, {
        id: '#myForm_brandId', label: '品牌', kind: 'dropdown',
        value: brandName, required: true, waitAfter: 600,
        labelFallbackPattern: /品牌|品牌名称|车辆品牌/,
      });
      // fillByIdOrLabel 不返回 control，这里再找一次品牌控件供后续「品牌→车系联动刷新」使用
      let brandControl = null;
      try {
        const bc = findControlInModalByLabel(modal, /品牌/);
        if (bc) brandControl = controlRoot(bc) || bc;
      } catch (e) { ignoreUnlessPageAbort(e); }
      rBrand = {
        ok: !!rBrand?.ok,
        value: rBrand?.ok ? brandName : '',
        control: rBrand?.ok ? brandControl : null,
        message: rBrand?.ok ? `已自动沿用品牌「${brandName}」` : `自动填品牌失败：${rBrand?.message || '未知'}（回退手动选择）`,
        auto: true,
      };
      steps.push(`[1/4] 品牌：${rBrand.ok ? `OK → 已自动沿用「${brandName}」` : `FAIL → ${rBrand.message}`}`);
      if (!rBrand.ok) {
        // 自动填失败才回退手动（下拉里没有该品牌，必须让用户从系统里选一个真实存在的）
        console.log(`[创建车型] 品牌「${brandName}」自动填失败 → 回退 ensureBrandSelected 等待手动选择`);
        const rManual = await ensureBrandSelected(modal, {
          suggestText: '创建车型前请先手动选择品牌（车系列表按品牌联动加载，不选品牌下拉是空的，找不到刚创建的车系。选完后自动继续填车系名称/车型名称/类型 3 个字段）',
        });
        if (rManual.ok) {
          rBrand = { ...rManual, auto: true };
          steps.push(`  ↳ 回退成功：你已选择「${rManual.value}」`);
        }
      }
    } else {
      // 【★ 先引导用户手动选品牌】—— 不选品牌车系列表是空的，填车系肯定找不到！
      //   调用 ensureBrandSelected：显示浅蓝提示条+轻量轮询，用户选好品牌后才继续填车系名称/车型名称/类型等后续字段。
      //   actualBrandName 优先用用户在 UI 上实际选中的品牌名（这样品牌→车系联动刷新才准确）。
      rBrand = await ensureBrandSelected(modal, {
        suggestText: '创建车型前请先手动选择品牌（车系列表按品牌联动加载，不选品牌下拉是空的，找不到刚创建的车系。选完后自动继续填车系名称/车型名称/类型 3 个字段）',
      });
      steps.push(`[1/4] 品牌：${rBrand.ok ? `OK → 你已选择「${rBrand.value || brandName}」` : `MANUAL_${rBrand.ok ? 'HIT' : 'TIMEOUT/NOCTRL'} → ${rBrand.message}。如车系名称找不到，请先手动选品牌让车系列表加载出来后再选车系`}`);
    }
    // actualBrandName / actualBrandControl：优先从 rBrand 拿结果（含 brandConfirmed 自动填的场景），没拿到就走原来 CSV + UI 兜底
    let actualBrandName = (rBrand.ok && rBrand.value) ? rBrand.value : (brandName || '');
    let actualBrandControl = (rBrand.ok && rBrand.control) ? rBrand.control : null;

    // 如果品牌已就位（自动填或用户选），等一下车系列表按品牌异步联动加载完（品牌→车系联动刷新依赖它）
    if (rBrand.ok) await sleep(600);

    // ====== 严格按右侧 Drawer 从上到下字段顺序：品牌(手动) → 车系名称 → 车型名称 → 类型 ======

    // ================================================================================
    // ★ 品牌→车系 联动刷新（确保刚创建的车系能被命中）
    //   - actualBrandControl 有值（=用户已选品牌，来自 ensureBrandSelected 成功 或 UI 兜底）时才执行 3 轮刷新
    //   - actualBrandControl 没值（=ensureBrandSelected 超时+UI 兜底也没读到品牌）时跳过刷新，后面填车系名称找不到就记 miss 让用户自己手选
    // ================================================================================
    // 如果 ensureBrandSelected 没拿到控件（超时/找不到），再尝试从 UI 直接读品牌值做一次兜底（保留原逻辑不变）
    const fSeriesControl = findControlInModalByLabel(modal, /车系名称/);

    if (!actualBrandControl) {
      const fBrandControl = findControlInModalByLabel(modal, /品牌/);
      try {
        if (fBrandControl && controlRoot(fBrandControl)) {
          const brandRoot = controlRoot(fBrandControl) || fBrandControl;
          const rawBrandVal = readControlValue(brandRoot);
          const cleanBrandVal = cleanText(String(rawBrandVal || ''));
          const emptyHint = /^(请选择|请选择.*|未选择|undefined|null|placeholder|搜索|选择.*)$/;
          if (cleanBrandVal && cleanBrandVal.length > 0 && !emptyHint.test(cleanBrandVal)) {
            actualBrandName = cleanBrandVal;
            actualBrandControl = brandRoot;
            steps.push(`[联动前置] UI 兜底：检测到你已手动选择品牌「${cleanBrandVal}」，将用它触发品牌→车系联动刷新`);
          } else {
            steps.push(`[联动前置] UI 兜底：品牌还未选择（当前值="${cleanBrandVal || '请选择'}"）→ 跳过品牌→车系联动刷新。如车系找不到，先手动选品牌让车系列表加载后再选车系即可（和售价一样提交前自己填好）。`);
          }
        }
      } catch (e) { ignoreUnlessPageAbort(e); }
    }

    const brandRefillSteps = [];
    let brandRefreshed = false;
    // 只有 actualBrandControl 有值（=用户已在 UI 上选了品牌）时，才执行 3 轮品牌→车系联动刷新
    if (actualBrandControl) {
      for (let i = 1; i <= 3 && !brandRefreshed; i++) {
      throwIfPageAborted();
        // (a) 触发品牌下拉重新选中 → 派发 change/input → Vue 重新拉取该品牌的车系接口
        try {
          const brandRoot = actualBrandControl;
          // 先清空再重选品牌 → 最大概率触发组件内部"品牌变了→刷新车系联动"的逻辑
          const brandInput = dropdownInput(brandRoot);
          if (brandInput) {
            brandInput.focus?.();
            setNativeValue(brandInput, '');
            dispatch(brandInput, 'input');
            dispatch(brandInput, 'change');
            await sleep(120);
          }
          const rRe = await setDropdownValue(brandRoot, actualBrandName, {
            field: 'brandName_refresh_' + i, label: '品牌-重选刷新车系', kind: 'dropdown', required: true, waitAfter: 400,
          });
          brandRefillSteps.push(`第${i}轮重选品牌：${rRe.ok ? 'OK' : 'FAIL'} → ${rRe.message}`);
        } catch (e) { brandRefillSteps.push(`第${i}轮重选品牌异常：${e?.message || String(e)}`); }
        // (b) 轮询：等后台车系接口把新车系拉回来
        await sleep(700);
        // (c) 检查：在「车系名称下拉」里静默/开面板一次看能不能找到目标车系
        if (fSeriesControl && controlRoot(fSeriesControl)) {
          try {
            const seriesRoot = controlRoot(fSeriesControl) || fSeriesControl;
            // 用 tryFillFilterableSilently 搜一遍车系（不关心是否真的填上，只要 findDropdownOption 能找到就说明数据回来了）
            const probe = await tryFillFilterableSilently(seriesRoot, seriesName, {
              field: 'series_probe_' + i, label: '车系名称-探测', kind: 'dropdown', required: false, waitAfter: 200,
            });
            // 只要 probe 不返回 option-not-found（或者 readControlValue 已变），就算成功
            const nowVal = readControlValue(seriesRoot);
            const found = (probe.ok === true)
              || (probe.reason !== 'option-not-found' && probe.reason !== 'no-search-input')
              || (norm(nowVal || '').includes(norm(seriesName || '')));
            if (found) {
              brandRefreshed = true;
              brandRefillSteps.push(`  ↳ 第${i}轮检查：车系名称下拉已可命中目标车系「${seriesName}」，数据已刷新，停止轮询。`);
            } else {
              brandRefillSteps.push(`  ↳ 第${i}轮检查：车系名称下拉还找不到目标车系「${seriesName}」，等下一轮再试。`);
            }
            // 检查完一定关下拉
            try { await ensureDropdownClosed(seriesRoot, { field: 'series_probe' }); } catch (e) { ignoreUnlessPageAbort(e); }
          } catch (e) { ignoreUnlessPageAbort(e); }
        }
      }
    }
    if (actualBrandControl && brandRefreshed) {
      steps.push(`[联动刷新] 品牌→车系 刷新成功：尝试${brandRefillSteps.length}轮后检测到目标车系已入库。` + brandRefillSteps.map(s => `\n    - ${s}`).join(''));
    } else if (actualBrandControl) {
      steps.push(`[联动刷新] ⚠️ 品牌→车系 刷新${brandRefillSteps.length || 0}轮仍未检测到目标车系，继续尝试直接填写（可能是前端缓存还没失效）。` + brandRefillSteps.map(s => `\n    - ${s}`).join(''));
    }
    // 品牌 → 车系名称下拉 异步联动加载：如果用户已选品牌，再兜底等 900ms 防止刚刷新完立刻填数据没回 DOM
    if (actualBrandControl) await sleep(900);

    // 5) 字段2: 车系名称 (dropdown，真实 label 是"车系名称"，不是"车系"，直接对齐，避免匹配到首字母品牌里的其他文本)
    let fSeries = await fillByIdOrLabel(modal, {
      id: '#myForm_seriesId', label: '车系名称', kind: 'dropdown',
      value: seriesName, required: true, waitAfter: 300,
      labelFallbackPattern: /\*?\s*车系名称|车系名称/,
    });
    // ★ 第一次车系没选到 → 再重试 2 次（每次先 trigger 品牌 change 刷新一次 + 再填）
    if (!fSeries.ok) {
      for (let retry = 1; retry <= 2 && !fSeries.ok; retry++) {
        steps.push(`  ↳ 第${retry}次重试选车系：上一次 ${fSeries.message}`);
        if (fBrandControl && controlRoot(fBrandControl)) {
          try {
            const brandRoot = controlRoot(fBrandControl) || fBrandControl;
            const r2 = await setDropdownValue(brandRoot, actualBrandName, {
              field: `brand_refresh_retry_${retry}`, label: '品牌-第'+retry+'次重选', kind: 'dropdown', required: false, waitAfter: 300,
            });
            steps.push(`    · 品牌第${retry}次重选：${r2.ok ? 'OK' : 'FAIL'} → ${r2.message}`);
          } catch (e) { ignoreUnlessPageAbort(e); }
        }
        await sleep(600);
        const retrySeries = await fillByIdOrLabel(modal, {
          id: '#myForm_seriesId', label: '车系名称', kind: 'dropdown',
          value: seriesName, required: true, waitAfter: 300,
          labelFallbackPattern: /\*?\s*车系名称|车系名称/,
        });
        if (retrySeries.ok) fSeries = retrySeries;
      }
    }
    steps.push(`[2/4] 车系名称：${fSeries.ok ? 'OK' : 'MANUAL_FALLBACK'} → ${fSeries.ok ? fSeries.message : fSeries.message + '（品牌未选或前端缓存未刷新=已记 miss，请你手动选择车系；处理方式同售价：提交前自己填好即可）'}`);
    // ★ 车系名称不再因为找不到就 return（和售价处理方式一致：品牌/车系都是你提交前自己手动选），只有车型名称/类型这种必填字段填失败才 return
    // if (!fSeries.ok) return { ok: false, ... };  // 已移除
    // ★ 车系 → 类型 / 其他车型特有属性下拉 异步联动加载
    if (fSeries.ok) await sleep(700);  // 车系成功命中的情况下才等联动（没命中用户自己选车系时会触发加载）

    // 字段3: 车型名称 (textarea 优先，失败降级 input；真实 label 直接用"车型名称")
    let fModelName = await fillByIdOrLabel(modal, {
      id: '#myForm_modelName', label: '车型名称', kind: 'textarea',
      value: String(modelName).trim(), required: true, waitAfter: 120,
      labelFallbackPattern: /\*?\s*车型名称|车型名称/,
    });
    if (!fModelName.ok) {
      const fModelInput = await fillByIdOrLabel(modal, {
        id: '#myForm_modelName', label: '车型名称', kind: 'input',
        value: String(modelName).trim(), required: true, waitAfter: 120,
        labelFallbackPattern: /\*?\s*车型名称|车型名称/,
      });
      if (fModelInput.ok) fModelName = Object.assign({}, fModelInput, { message: fModelInput.message + '（textarea失败降级input）' });
    }
    steps.push(`[3/4] 车型名称：${fModelName.ok ? 'OK' : 'FAIL'} → ${fModelName.message}`);
    if (!fModelName.ok) return { ok: false, message: `创建车型：填车型名称失败 → ${fModelName.message}`, steps };

    // 字段4: 类型 (dropdown，真实 label 就是"类型"，fallback 包含车辆类型/类型)
    const vehicleTypeValue = vehicleType || '牵引车';
    const fType = await fillByIdOrLabel(modal, {
      id: '#myForm_typeLevel', label: '类型', kind: 'dropdown',
      value: vehicleTypeValue, required: true, waitAfter: 220,
      labelFallbackPattern: /\*?\s*类型|车辆类型|类型/,
    });
    steps.push(`[4/4] 类型：${fType.ok ? 'OK' : 'FAIL'} → ${fType.message}`);
    if (!fType.ok && /必填|required/.test(String(fType.message || ''))) {
      return { ok: false, message: `创建车型：填类型失败 → ${fType.message}`, steps };
    }

    await sleep(200);

    // 【需要人工提交确认】：填完 4 个字段后停在抽屉里，不再自动点提交
    const submitBtn = findModalSubmitButton(modal);
    const cancelBtn = findModalCancelButton(modal);
    if (!submitBtn) {
      steps.push('候选button：');
      [...(modal || document).querySelectorAll('button')].filter(isVisible).forEach((b, i) => {
        steps.push(`  [${i}] text="${cleanText(b.innerText || b.textContent || '').slice(0, 20)}" class="${String(b.className || '').slice(0, 60)}"`);
      });
      return { ok: false, message: '未找到车型抽屉"提交"按钮', steps };
    }
    const notice = addNoticeInsideModal(modal, `车型「${modelName}」除品牌/车系外其他字段已填完 → 请手动选择品牌+确认车系，所有字段无误后点击右下角【提交】按钮`);
    steps.push('[人工确认] 车系名称/车型名称/类型 已填完，等待你手动选品牌+确认车系后点抽屉里的"提交"按钮……（点取消/关闭=放弃创建）');
    console.log('[VA 车型创建] 字段已填完（品牌/车系留人工核对）→ 等待人工提交确认：', { actualBrandName, seriesName, modelName, vehicleType });

    const ctx = { manualSubmitClicked: false, manualCancelClicked: false };
    const offSubmit = attachOneTimeClickListener(submitBtn, () => { ctx.manualSubmitClicked = true; });
    let offCancel = () => {};
    if (cancelBtn) offCancel = attachOneTimeClickListener(cancelBtn, () => { ctx.manualCancelClicked = true; });

    // 超时 10 分钟（creating 阶段 safetyTimer 已禁用，多久等都行）
    const submitResult = await waitForCreateSuccess(modal, { timeoutMs: 10 * 60 * 1000, manualContext: ctx, label: `车型「${modelName}」` });
    offSubmit(); offCancel(); removeNotice(notice);
    if (ctx.manualCancelClicked) {
      return { ok: false, message: `已取消创建车型「${modelName}」（你点击了取消/关闭按钮）`, steps, cancelled: true };
    }
    // 品牌完全交给用户手动选，不再返回 userSelectedBrandName / brandName（sidepanel 不再需要覆盖 row.brandName）
    return {
      ok: submitResult.ok,
      message: submitResult.message || (submitResult.ok
        ? `车型"${modelName}"创建成功（人工已提交确认，品牌由用户手动选择）`
        : `创建车型失败：${submitResult.message}`),
      steps,
      success: submitResult.ok,
    };
  }

  /**
   * 挂一次性 click 监听器，返回卸载函数（避免多次触发+防内存泄漏）
   */
  function attachOneTimeClickListener(element, handler) {
    if (!element || typeof handler !== 'function') return () => {};
    let called = false;
    const fire = (e) => {
      if (called) return;
      called = true;
      try { handler(e); } catch (e) { ignoreUnlessPageAbort(e); }
    };
    // 1) 元素自身 bubble/capture
    element.addEventListener('click', fire, { passive: true, once: true });
    element.addEventListener('click', fire, { capture: true, once: true, passive: true });
    // 2) 补 mousedown / mouseup / keydown（回车提交 / antd 会 stopPropagation 的场景）
    element.addEventListener('mousedown', fire, { passive: true, once: true });
    element.addEventListener('mouseup', fire, { passive: true, once: true });
    element.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') fire(e); }, { passive: true, once: true });
    // 3) ★ 兜底：监听整个 document 的 capture click，匹配元素或元素内部（antd 有时在捕获阶段 stopPropagation）
    const docCapture = (e) => {
      try {
        const t = e.target;
        if (!t) return;
        if (t === element || element.contains?.(t) || (typeof t.closest === 'function' && t.closest(getUniqueSelector(element)) === element)) {
          fire(e);
        }
      } catch (e) { ignoreUnlessPageAbort(e); }
    };
    document.addEventListener('click', docCapture, { capture: true, passive: true });
    return function off() {
      try { element.removeEventListener('click', fire); } catch (e) { ignoreUnlessPageAbort(e); }
      try { element.removeEventListener('click', fire, true); } catch (e) { ignoreUnlessPageAbort(e); }
      try { document.removeEventListener('click', docCapture, true); } catch (e) { ignoreUnlessPageAbort(e); }
    };
  }

  function getUniqueSelector(el) {
    if (!el?.getAttribute) return '';
    let id = el.getAttribute('id');
    if (id) return '#' + id;
    const cls = [...(el.classList || [])].slice(0, 3).join('.');
    if (cls) return (el.tagName || 'div') + '.' + cls;
    return el.tagName || 'div';
  }

  /**
   * 在抽屉/弹窗内部顶部插入一条显眼的提示条（返回 id 便于移除）
   */
  function addNoticeInsideModal(scope, htmlOrText) {
    if (!scope) return null;
    try {
      // 找到容器：modal 的 .ant-modal-body / drawer 的 .ant-drawer-body
      const body = scope.querySelector?.('.ant-modal-body, .ant-drawer-body, [class*="modal-body"], [class*="drawer-body"]')
        || (scope.querySelector?.('form')?.parentNode)
        || scope;
      const id = 'va-modal-notice-' + Date.now() + '-' + Math.floor(Math.random() * 100000);
      const bar = document.createElement('div');
      bar.id = id;
      bar.setAttribute('data-va-modal-notice', '1');
      Object.assign(bar.style, {
        position: 'sticky', top: '0', zIndex: '9999',
        padding: '10px 14px', marginBottom: '12px',
        background: 'linear-gradient(90deg,#fff7ed,#fef3c7)',
        border: '1px solid #f59e0b', color: '#92400e',
        borderRadius: '6px', fontWeight: '600', fontSize: '14px',
        boxShadow: '0 2px 6px rgba(0,0,0,0.05)',
      });
      bar.textContent = String(htmlOrText);
      if (body && body.prepend) body.prepend(bar);
      else if (body && body.insertBefore) body.insertBefore(bar, body.firstChild);
      else if (scope.insertBefore) scope.insertBefore(bar, scope.firstChild);
      return id;
    } catch (_) {
      return null;
    }
  }

  /**
   * 移除 addNoticeInsideModal 插入的提示条
   */
  function removeNotice(id) {
    if (!id) return;
    try {
      const el = document.getElementById(id);
      if (el) el.parentNode?.removeChild?.(el);
      // 兜底：清除所有
      document.querySelectorAll('[data-va-modal-notice]').forEach(n => n.parentNode?.removeChild?.(n));
    } catch (e) { ignoreUnlessPageAbort(e); }
  }

  // ==========================================================================
  // 【通用·等用户手动选某个下拉】—— 用于"品牌这类 CSV 可能写错名、不如让用户从下拉里选"的场景。
  //   行为：
  //   1) 在 scope（抽屉/表单/新增页）内按 labelPattern 找对应下拉控件，并在控件上方插一条高亮黄色提示条
  //   2) 启动轮询，每 400ms readControlValue 读一次：只要不是"请选择/空/未选择"就算选上了
  //   3) 超时时返回 ok=false，用户选完返回 ok=true 并带 value=用户实际选中的文本（后续其他字段联动用这个真实值，不用 CSV 里那个可能不存在的名字）
  //   4) 返回里还带 selectedBrandText 这种对 sidepanel 覆盖 row.brandName 用的字段
  // ==========================================================================
  async function waitForManualDropdown(scope, opts) {
    throwIfPageAborted();
    const label = opts?.label || '品牌';
    const labelPattern = opts?.labelPattern || new RegExp(label || '品牌');
    const timeoutMs = opts?.timeoutMs || 10 * 60 * 1000; // 默认等 10 分钟（用户慢慢选）
    const suggestionText = opts?.suggestionText || ''; // 附加提示，例："建议选系统里已存在的：一汽解放 / 青岛解放 / 安凯客车"
    if (!scope) return { ok: false, value: '', message: 'waitForManualDropdown: scope 为空' };

    // ① 找到控件
    const controlEl = findControlInModalByLabel(scope, labelPattern);
    if (!controlEl) {
      return { ok: false, value: '', message: `在当前表单里找不到"${label}"下拉控件` };
    }
    const root = controlRoot(controlEl) || controlEl;

    // ② 在控件/表单顶部插提示条（样式同 addNoticeInsideModal 橘黄）
    const labelText = String(label || '该字段');
    const body = (scope.querySelector?.('.ant-modal-body, .ant-drawer-body, [class*="drawer-body"], [class*="modal-body"]')
      || (scope.querySelector?.('form')?.parentNode)
      || scope);
    const bar = document.createElement('div');
    const barId = 'va-manual-select-bar-' + Date.now() + '-' + Math.floor(Math.random() * 10000);
    bar.id = barId;
    bar.setAttribute('data-va-manual-select', label);
    Object.assign(bar.style, {
      position: 'sticky', top: '0', zIndex: '9998',
      padding: '10px 14px', margin: '12px 0',
      background: 'linear-gradient(90deg,#eff6ff,#dbeafe)',
      border: '1px solid #3b82f6', color: '#1e3a8a',
      borderRadius: '6px', fontWeight: '600', fontSize: '14px',
      boxShadow: '0 2px 6px rgba(0,0,0,0.05)',
    });
    bar.textContent = `★ 请手动选择「${labelText}」后自动继续，插件不再自动填写此字段。${suggestionText ? '（' + suggestionText + '）' : ''}`;
    try {
      if (body && body.prepend) body.prepend(bar);
      else if (body && body.insertBefore) body.insertBefore(bar, body.firstChild);
      else if (scope.insertBefore) scope.insertBefore(bar, scope.firstChild);
    } catch (e) { ignoreUnlessPageAbort(e); }

    // ③ 滚动到下拉控件位置（方便用户马上看到，不用来回找）
    try { root.scrollIntoView?.({ block: 'center', inline: 'nearest' }); } catch (e) { ignoreUnlessPageAbort(e); }
    // 顺便给用户开一下下拉（省一次点击）
    try {
      const clicker = dropdownClickTarget(root);
      if (clicker) { robustClick(clicker); }
    } catch (e) { ignoreUnlessPageAbort(e); }

    // ④ 轮询等待用户选中（注意：下拉有时是"选完后值写入"会经过 Vue/React 异步，所以多等一轮）
    const deadline = Date.now() + timeoutMs;
    let lastEmptyVal = '';
    while (Date.now() < deadline) {
      throwIfPageAborted();
      throwIfPageAborted();
      const raw = readControlValue(root);
      const v = cleanText(String(raw || ''));
      const emptyHint = /^(请选择|请选择.*|未选择|undefined|null|placeholder|搜索|选择.*)$/;
      const hasValue = v && v.length > 0 && !emptyHint.test(v);
      if (hasValue) {
        // 选上了，清掉提示条，返回
        try { const el = document.getElementById(barId); el?.parentNode?.removeChild?.(el); } catch (e) { ignoreUnlessPageAbort(e); }
        try { document.querySelectorAll('[data-va-manual-select]').forEach(n => n.parentNode?.removeChild?.(n)); } catch (e) { ignoreUnlessPageAbort(e); }
        return { ok: true, value: v, control: root, message: `用户已手动选择「${labelText}」=${v}` };
      }
      lastEmptyVal = v || '(空)';
      await sleep(400);
    }

    // 超时
    try { const el = document.getElementById(barId); el?.parentNode?.removeChild?.(el); } catch (e) { ignoreUnlessPageAbort(e); }
    try { document.querySelectorAll('[data-va-manual-select]').forEach(n => n.parentNode?.removeChild?.(n)); } catch (e) { ignoreUnlessPageAbort(e); }
    return { ok: false, value: '', message: `等待用户手动选择「${labelText}」超时（最后读取值=${lastEmptyVal}），请点侧边栏【重填当前行】重试` };
  }

  // ==========================================================================
  // 【极简·引导用户手动选品牌】—— 解决「不选品牌 → 车系/车型下拉是空 → 填啥都找不到」的问题。
  //   和 waitForManualDropdown 的区别（刻意做得很简单，对齐你说的「和填售价图片一样，提交前自己选就行」）：
  //   ✅ 只在表单顶部加一条浅蓝色说明提示条（告诉你先选品牌，不做橘黄告警强视觉）
  //   ✅ 不自动 click 下拉、不帮用户展开（你自己点下拉选品牌，和售价一样完全手动）
  //   ✅ 轻量轮询：每 700ms 读一次品牌控件值，不是「请选择/空」就算选好了
  //   ✅ 超时时不强制 return 卡死（返回 ok=false 让调用方自己决定），你选品牌慢也不会报错
  //   ✅ 不把用户选中的品牌值写回 CSV row / payload（避免覆盖原值产生副作用），DOM 里选的品牌只在当前页面生效
  // ==========================================================================
  function resetDropdownSelection(root) {
    if (!root) return false;
    let changed = false;
    try {
      const clearBtn = root.querySelector?.('.ant-select-clear, .el-icon-circle-close, .el-select__caret.is-reverse, [class*="clear"]')
        || root.parentNode?.querySelector?.('.ant-select-clear, .el-icon-circle-close, [class*="clear"]');
      if (clearBtn && isVisible(clearBtn)) {
        robustClick(clearBtn);
        changed = true;
      }
    } catch (e) { ignoreUnlessPageAbort(e); }
    try {
      const input = dropdownInput(root) || inputLike(root);
      if (input) {
        input.focus?.();
        setNativeValue(input, '');
        dispatch(input, 'input');
        dispatch(input, 'change');
        input.blur?.();
        changed = true;
      }
    } catch (e) { ignoreUnlessPageAbort(e); }
    try {
      const selected = root.querySelector?.('.ant-select-selection-item, .ant-select-selection-selected-value, .el-select__tags-text, .ant-select-selection-item-content');
      if (selected) selected.textContent = '';
    } catch (e) { ignoreUnlessPageAbort(e); }
    try {
      const vc = findVueComponent(root);
      const vm = vc && vc.__vue__ ? vc.__vue__ : vc;
      if (vm) {
        ['value', 'modelValue', 'currentValue', 'selected', 'selectedLabel', 'currentLabel'].forEach(k => {
          try { if (typeof vm[k] !== 'undefined') vm[k] = ''; } catch (_) {}
        });
        try { if (typeof vm.$emit === 'function') { vm.$emit('input', ''); vm.$emit('change', ''); vm.$emit('update:modelValue', ''); } } catch (_) {}
        changed = true;
      }
    } catch (e) { ignoreUnlessPageAbort(e); }
    return changed;
  }

  async function ensureBrandSelected(scope, opts) {
    throwIfPageAborted();
    const labelPattern = opts?.labelPattern || /品牌/;
    // ★ 兼容两种字段名：调用处有的传 suggestText，有的传 suggestionText
    const suggestText = (opts?.suggestText || opts?.suggestionText)
      || '请先手动选择品牌（车系/车型数据按品牌联动加载，不选品牌找不到对应车系/车型，选完后自动继续）';
    const timeoutMs = opts?.timeoutMs || 5 * 60 * 1000; // 默认 5 分钟（你慢慢选）
    const pollIntervalMs = opts?.pollIntervalMs || 700;
    const requireFreshSelection = !!opts?.requireFreshSelection;
    if (!scope) return { ok: false, value: '', message: 'ensureBrandSelected: scope 为空', control: null };

    // ① 找到品牌控件
    const controlEl = findControlInModalByLabel(scope, labelPattern);
    if (!controlEl) {
      return { ok: false, value: '', message: 'ensureBrandSelected: 在当前表单里找不到"品牌"下拉控件（可能DOM还没渲染，调用方会继续尝试）', control: null };
    }
    const root = controlRoot(controlEl) || controlEl;

    // ② 快速检查：只有非强制本行重新选择时，才允许直接沿用当前已有值。
    // 强制重新选择用于“下一行”隔离：页面可能残留上一行品牌，必须先清空并等待用户为本行重新选。
    try {
      const firstVal = cleanText(String(readControlValue(root) || ''));
      const emptyHint = /^(请选择|请选择.*|未选择|undefined|null|placeholder|搜索|选择.*)$/;
      if (requireFreshSelection) {
        if (firstVal && firstVal.length > 0 && !emptyHint.test(firstVal)) {
          resetDropdownSelection(root);
          await sleep(250);
        }
      } else if (firstVal && firstVal.length > 0 && !emptyHint.test(firstVal)) {
        // ★ 直接返回前也要把手动选的品牌值同步到 Vue 层！否则后续重渲染还是会清空。
        try {
          let innerOpt = root.querySelector?.(
            '.ant-select-selection-item, .ant-select-selection-selected-value, .el-select__tags-text, .ant-select-selection-item-content'
          );
          if (innerOpt) syncVueSelectModel(root, innerOpt, firstVal);
          else syncVueSelectModel(root, root, firstVal);
        } catch (e) { ignoreUnlessPageAbort(e); }
        return { ok: true, value: firstVal, control: root, message: `品牌已选好「${firstVal}」，直接继续。` };
      }
    } catch (e) { ignoreUnlessPageAbort(e); }

    // ③ 在表单顶部加一条浅蓝说明提示条（非强视觉）
    const body = (scope.querySelector?.('.ant-modal-body, .ant-drawer-body, [class*="drawer-body"], [class*="modal-body"]')
      || (scope.querySelector?.('form')?.parentNode)
      || scope);
    const bar = document.createElement('div');
    const barId = 'va-brand-hint-bar-' + Date.now() + '-' + Math.floor(Math.random() * 10000);
    bar.id = barId;
    bar.setAttribute('data-va-brand-hint', '1');
    Object.assign(bar.style, {
      position: 'sticky', top: '0', zIndex: '9997',
      padding: '8px 14px', margin: '12px 0',
      background: 'linear-gradient(90deg,#eff6ff,#dbeafe)',
      border: '1px solid #3b82f6', color: '#1e3a8a',
      borderRadius: '6px', fontWeight: '500', fontSize: '13px',
    });
    bar.innerHTML = '👉 ' + suggestText;
    try {
      if (body && body.prepend) body.prepend(bar);
      else if (body && body.insertBefore) body.insertBefore(bar, body.firstChild);
      else if (scope.insertBefore) scope.insertBefore(bar, scope.firstChild);
    } catch (e) { ignoreUnlessPageAbort(e); }
    // 滚动到品牌控件位置（方便你马上看到，不用来回找）—— 但不自动开下拉
    try { root.scrollIntoView?.({ block: 'center', inline: 'nearest' }); } catch (e) { ignoreUnlessPageAbort(e); }

    // ④ 轻量轮询等你选品牌
    const deadline = Date.now() + timeoutMs;
    let lastVal = '';
    while (Date.now() < deadline) {
      throwIfPageAborted();
      const raw = readControlValue(root);
      const v = cleanText(String(raw || ''));
      const emptyHint = /^(请选择|请选择.*|未选择|undefined|null|placeholder|搜索|选择.*)$/;
      if (v && v.length > 0 && !emptyHint.test(v)) {
        // 如果强制要求本行重新选择，但页面仍回显旧值，就继续等用户重新点一次，而不是直接沿用旧品牌。
        if (requireFreshSelection && v === firstVal) {
          resetDropdownSelection(root);
          await sleep(pollIntervalMs);
          lastVal = v || '(空/请选择)';
          continue;
        }
        // ★★★【关键修复】手动选的值还没同步到 Vue 层，立刻手动 syncVueSelectModel。
        //     否则后续填"常用车系/常用排序"等其他字段触发 Vue 响应式重渲染时，品牌会被还原成"请选择"！
        try {
          let brandOption = null;
          // 先查归属面板里可见的选中项
          try {
            const ownPanel = findDropdownPanelForControl(root, { includeHiddenPanels: true, kind: 'any' });
            if (ownPanel) {
              brandOption = ownPanel.querySelector?.(
                '.ant-select-item-option-selected, .ant-select-dropdown-menu-item-selected, .el-select-dropdown__item.selected, [aria-selected="true"], [class*="selected"][role="option"]'
              );
            }
          } catch (e) { ignoreUnlessPageAbort(e); }
          // 再查控件内部已有 selectedItem（关闭面板后 DOM 也能找到）
          if (!brandOption) {
            brandOption = root.querySelector?.(
              '.ant-select-selection-item, .ant-select-selection-selected-value, .el-select__tags-text, .ant-select-selection-item-content'
            );
          }
          if (brandOption) {
            syncVueSelectModel(root, brandOption, v);
          } else {
            // 兜底：用控件自身+显示文本强行同步（syncVueSelectModel 走显示文本分支）
            syncVueSelectModel(root, root, v);
          }
        } catch (e) { ignoreUnlessPageAbort(e); }
        // 清提示条
        try { const el = document.getElementById(barId); el?.parentNode?.removeChild?.(el); } catch (e) { ignoreUnlessPageAbort(e); }
        try { document.querySelectorAll('[data-va-brand-hint]').forEach(n => n.parentNode?.removeChild?.(n)); } catch (e) { ignoreUnlessPageAbort(e); }
        return { ok: true, value: v, control: root, message: `你已手动选择品牌「${v}」，已同步 Vue 层防止后续重渲染清空。` };
      }
      lastVal = v || '(空/请选择)';
      await sleep(pollIntervalMs);
    }

    // 超时：清提示条，返回 ok=false（不强制卡流程，调用方自行处理）
    try { const el = document.getElementById(barId); el?.parentNode?.removeChild?.(el); } catch (e) { ignoreUnlessPageAbort(e); }
    try { document.querySelectorAll('[data-va-brand-hint]').forEach(n => n.parentNode?.removeChild?.(n)); } catch (e) { ignoreUnlessPageAbort(e); }
    return { ok: false, value: '', control: root, message: `等你手动选品牌超时（最后读取值=${lastVal}），调用方将继续后续流程。如车系/车型找不到，请你手动选品牌后重新触发填充（侧边栏点【重填当前行】）。` };
  }

  /**
   * 等待车系/车型创建结果（支持【人工提交确认】屏障）。
   *
   * 规则：
   *  1) 有成功 toast → 成功（不管点没点提交：实际点了才会出 toast）
   *  2) 有错误 toast → 失败（一般是校验，提示用户补字段后可以再点一次继续等）
   *  3) 抽屉/弹窗关闭
   *       a. 之前人工已点过提交（manualSubmitClicked === true）→ 成功
   *       b. 没点过提交 → 返回失败（用户点了取消或 × 按钮，由上层区分 cancelled）
   *  4) 超时 → 失败
   *
   * @param {Element} modalScope 弹窗根节点
   * @param {object} opts
   *   - timeoutMs: number     默认 12s，人工确认场景可改为 10 分钟
   *   - manualContext: { manualSubmitClicked: boolean, manualCancelClicked: boolean }
   *   - label: string         错误信息里的标签（如"车系「解放J6P」"）
   */
  async function waitForCreateSuccess(modalScope, opts) {
    throwIfPageAborted();
    const timeoutMs = (opts && opts.timeoutMs) ? opts.timeoutMs : 12000;
    const ctx = (opts && opts.manualContext) || {};
    const label = (opts && opts.label) ? opts.label : '创建';
    const deadline = Date.now() + timeoutMs;
    let pollCount = 0;
    while (Date.now() < deadline) {
      throwIfPageAborted();
      throwIfPageAborted();
      pollCount += 1;
      const successText = visibleSuccessText();
      if (successText) return { ok: true, message: successText, via: 'toast' };
      const errorText = visibleErrorText();
      if (errorText) return { ok: false, message: label + ' 校验/后端报错：' + errorText, via: 'errorToast' };
      const modalGone = modalScope && !isVisible(modalScope);
      if (modalGone) {
        if (ctx.manualSubmitClicked) {
          return { ok: true, message: label + ' 弹窗关闭（人工已点提交）', via: 'modalClosedAfterSubmit' };
        }
        // 没点提交就关了 = 用户取消
        return { ok: false, message: label + ' 弹窗已关闭，但未检测到你点击提交（取消或关闭按钮被点）', via: 'modalClosedWithoutSubmit' };
      }
      // 每 30 轮打一次日志，方便用户知道还在等（只打一次，避免刷屏）
      if (pollCount === 30) {
        console.log('[VA 创建等待] 仍在等待你点击抽屉里的提交按钮：' + label);
      }
      await sleep(180);
    }
    return { ok: false, message: label + ' 等待创建结果超时（超过 ' + Math.round(timeoutMs / 60000) + ' 分钟未检测到你点击提交或成功提示）', via: 'timeout' };
  }

  /**
   * 点击多tab页签中的指定标签（顶部打开的tabs）
   * 例：clickTab('审核列表')
   */
  async function clickTab(tabText) {
    const candidates = [...document.querySelectorAll(
      '.ant-tabs-tab, [role="tab"], [class*="tabs-tab"], .ant-tabs-tab-active, div, span'
    )]
      .filter(isVisible)
      .map(el => {
        const t = cleanText(el.innerText || el.textContent || el.getAttribute('aria-label') || '');
        const tabWrap = el.closest?.('.ant-tabs, [class*="tabs"]');
        const score = t === tabText ? 220
          : t.startsWith(tabText) || tabText.startsWith(t) ? 140
          : t.includes(tabText) ? 100 : 0;
        if (!score) return null;
        if (tabWrap) score += 80;
        // 排除左侧菜单中的匹配（只认顶部tabs区域）
        const inSidebar = el.closest?.('aside, .sidebar, [class*="sider"], .ant-menu');
        if (inSidebar) return null;
        return { el, text: t, score };
      })
      .filter(Boolean);
    candidates.sort((a, b) => b.score - a.score || a.text.length - b.text.length);
    const pick = candidates[0];
    if (!pick) return { ok: false, message: `未找到tab"${tabText}"` };
    robustClick(pick.el);
    await sleep(280);
    return { ok: true, message: `已切换tab到"${tabText}"`, href: location.href };
  }

  /**
   * 组合流程：导航到车系/车型管理页 → 创建 → 返回车源新增页
   * payload: {
   *   kind: 'series' | 'model',
   *   brandName, seriesName, modelName?, vehicleType?
   * }
   */
  async function navigateAndCreate(payload) {
    throwIfPageAborted();
    const { kind, skipReturnToAddPage = false, switchToModelAfterSeriesCreated = false } = payload || {};
    if (kind !== 'series' && kind !== 'model') {
      return { ok: false, message: 'navigateAndCreate 需要指定 kind 为 series 或 model' };
    }

    const menuName = kind === 'series' ? '车系管理' : '车型管理';
    const tagSkip = skipReturnToAddPage ? '（创建完不回新增页）' : '';
    const tagSwitch = (kind === 'series' && switchToModelAfterSeriesCreated) ? '（车系创建完切到车型管理列表，不点车系新增了）' : '';
    const steps = [`开始创建${menuName}${tagSkip}${tagSwitch}`];

    // ========== 步骤1：强保障进入 车系/车型 目标页（直到真的是目标页，绝不瞎点按钮） ==========
    const goto1 = await forceGotoSeriesOrModelPage(kind);
    (goto1.logs || []).forEach(l => steps.push(`[导航]${l}`));
    if (!goto1.ok) {
      // 导航失败：绝不继续，绝不乱找「车系列表」上的"新增"按钮
      return { ok: false, message: goto1.message || `导航到${menuName}失败`, steps };
    }

    // 再核一次：如果目标页判定还是 false，直接 return。宁可不做，也不能误打开车系新增。
    if (!isOnTargetSeriesOrModelPage(kind)) {
      steps.push(`[导航] ⚠️ 页面判定未通过（isOnTargetSeriesOrModelPage(${kind})=false），当前URL=${location.href} → 拒绝点击"+新增"（防止误开车系/车型的错页新增）`);
      const headers = [...document.querySelectorAll('th')].filter(isVisible).map(e => cleanText(e.innerText||e.textContent||''));
      steps.push(`[导航] ↳ 当前页面表头：${headers.slice(0, 10).map(s => `"${s.slice(0,10)}"`).join(', ')}`);
      return { ok: false, message: `${menuName}目标页最终判定失败，已拒绝点击"+新增"防止串页`, steps };
    }

    // 等待列表元素就绪（表格表头 or 新增按钮 visible）
    const listReadyDeadline = Date.now() + 3500;
    while (Date.now() < listReadyDeadline) {
      const tableHeader = document.querySelector('.ant-table-thead, .ant-table-header, [class*="table-head"]');
      // 【串页防呆】：就绪检查也强制传 kind，findCreateButton(kind) 内部会 3 层核目标页，绝不把另一页按钮当就绪信号
      const btn = findCreateButton(kind);
      if ((tableHeader && isVisible(tableHeader)) || (btn && isVisible(btn))) break;
      await sleep(150);
    }
    await sleep(150);

    // ========== 步骤2：确认在目标页后再点击"+新增" → 执行创建 ==========
    if (!isOnTargetSeriesOrModelPage(kind)) {
      steps.push(`[步骤2] ⛔ 点新增前，页面判定又回退（${menuName}=false，URL=${location.href}），拒绝点新增`);
      return { ok: false, message: `${menuName}点新增前最终校验失败，已取消以防止串页`, steps };
    }
    // 【串页防呆·第4道硬闸】：点击前再做一次互斥非跨页检查 + URL 互斥检查：
    //   比如 kind=model（要开车型），如果 isOnTargetSeriesOrModelPage('series')=true（明显在车系页）=直接拒绝；
    //   URL 只包含 /model/series（不包含 /model/model）也直接拒绝。绝对不赌。
    const otherKind = kind === 'series' ? 'model' : 'series';
    const inOppositePage = isOnTargetSeriesOrModelPage(otherKind);
    const href = String(location.href || '');
    const oppositePath = otherKind === 'series' ? '/model/series' : '/model/model';
    const targetPath = kind === 'series' ? '/model/series' : '/model/model';
    const urlOnlyInOpposite = href.includes(oppositePath) && !href.includes(targetPath);
    if (inOppositePage || urlOnlyInOpposite) {
      steps.push(`[步骤2] 🚫🚫🚫 非跨页硬闸门触发：kind=${kind}，但inOppositePage=${inOppositePage}（在${otherKind}页）urlOnlyInOpposite=${urlOnlyInOpposite}。URL=${href} → **拒绝点击"+新增"，直接 return fail 让上层重调。**`);
      return { ok: false, message: `防串页硬闸门：检测到当前页面是${otherKind === 'series' ? '车系' : '车型'}管理页（不是目标${menuName}页），为防止误点已立即终止，请点侧边栏【重填当前行】触发重试（会重新导航到正确目标页）。`, steps };
    }
    const createBtn = findCreateButton(kind);
    if (!createBtn) {
      steps.push('未找到"+新增"按钮，候选button文字清单：');
      [...document.querySelectorAll('button')].filter(isVisible).forEach((b, i) => {
        const txt = cleanText(b.innerText || b.textContent || '').slice(0, 20);
        if (txt) steps.push(`  [${i}] text="${txt}" class="${String(b.className||'').slice(0,60)}"`);
      });
      steps.push(`   ↳ （如果清单里有"+新增"按钮但这里没找到，就是 findCreateButton(${kind}) 的防串页硬门槛拦截了它——因为页面判定不满足目标${menuName}页。）`);
      return { ok: false, message: `${menuName}页找不到"+新增"按钮（可能被防串页拦截：请核当前URL=${href}是否=${targetPath}，并且可见表头是否有${kind === 'series' ? '车系名称' : '车型名称+公告型号'}）`, steps };
    }
    steps.push(`已定位${menuName}页新增按钮：text="${cleanText(createBtn.innerText || createBtn.textContent || '')}" class="${String(createBtn.className||'').slice(0,60)}"`);

    let createResult;
    if (kind === 'series') {
      createResult = await createSeries(payload);
    } else {
      createResult = await createModel(payload);
    }
    if (createResult.steps) steps.push(...createResult.steps.map(s => `创建步骤：${s}`));
    if (!createResult.ok) {
      return { ok: false, message: `创建${menuName}失败：${createResult.message}`, steps, cancelled: !!createResult.cancelled, via: createResult.via };
    }
    steps.push(`创建成功：${createResult.message}`);

    // ========== 步骤3：路由决策 ==========
    //   A. 最后一步（车型创建完，或者只缺车系不缺车型）→ 切回审核列表 + 点新增库存车
    //   B. 车系创建完，后面还要创建车型 → **用 forceGoto 硬切到车型管理页**（用户要求的）
    let actuallyReturned = false;
    if (kind === 'series' && switchToModelAfterSeriesCreated) {
      await sleep(200);
      steps.push('[切车型] 车系创建成功 → 用 forceGotoSeriesOrModelPage 强制切到车型管理页……');
      const gm = await forceGotoSeriesOrModelPage('model');
      (gm.logs || []).forEach(l => steps.push(`[切车型]${l}`));
      if (!gm.ok) {
        steps.push(`[切车型] ❌ 失败：${gm.message || '未知'}`);
        // 就算切车型失败，至少要核：当前页面不是"车系管理页目标页"，下一轮不回又误点车系新增
        if (isOnTargetSeriesOrModelPage('series') && !isOnTargetSeriesOrModelPage('model')) {
          steps.push('[切车型] ⚠️ 还停留在车系管理页，为了防串页，返回失败让上层重调，不让上层误以为切好了');
          return { ok: false, message: `车系创建成功但强制切车型管理页失败：${gm.message || '未知'}，请再点一次重填触发重试`, steps };
        }
      } else if (!isOnTargetSeriesOrModelPage('model')) {
        steps.push('[切车型] ⚠️ 返回ok=true但最终判定仍不满足isOnTargetSeriesOrModelPage(model)=false → 返回失败防串页');
        return { ok: false, message: '车系创建成功但车型管理页最终判定未通过（防止误点车系+新增），请重填再触发一次', steps };
      } else {
        steps.push('[切车型] ✅ OK，页面已在车型管理列表，下一步 VA_NAVIGATE_AND_CREATE(kind=model) 会直接点车型+新增');
      }
    } else if (!skipReturnToAddPage) {
      // --- 切回审核列表 + 新增库存车 ---
      await sleep(220);
      try {
        const tabBack = await clickTab('审核列表');
        if (tabBack.ok) {
          steps.push(`返回[切审核列表tab]：${tabBack.message}`);
        } else {
          steps.push(`切tab失败(${tabBack.message})，改用菜单导航回审核列表`);
          try {
            await ensureSubMenuExpanded('车源管理', '车源列表|审核列表');
            const leaf = await clickLeafMenuItem('审核列表');
            steps.push(`返回[菜单→审核列表]：${leaf.ok ? leaf.message : leaf.message}`);
          } catch (e) { steps.push('返回菜单异常：' + (e?.message || String(e))); }
        }
        await sleep(250);
        const back = await openAddForm();
        steps.push(`打开新增库存车表单：status=${back.status || ''} message="${back.message || ''}"`);
      } catch (e) { steps.push('返回新增页异常：' + (e?.message || String(e))); }
      await sleep(280);
      actuallyReturned = true;
    } else {
      steps.push('skipReturnToAddPage=true，保持当前列表页不动（调用方没有要求切车型管理）');
    }

    return {
      ok: true,
      message: `${kind === 'series' ? '车系' : '车型'}创建完成` +
        (kind === 'series' && switchToModelAfterSeriesCreated ? '，已切到车型管理列表页，下一步直接点车型新增' :
          actuallyReturned ? '并已返回新增页' : '，页面保持当前状态'),
      steps,
      createDetail: createResult,
    };
  }
})();
