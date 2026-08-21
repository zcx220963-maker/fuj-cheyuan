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
    { field: 'vehicleType', label: '车辆类型', selector: '#myForm_vehicleType', kind: 'dropdown', required: true, waitAfter: 800 },
    { field: 'withTrailer', label: '是否带挂', selector: '#myForm_withTrailer', kind: 'dropdown', required: false, waitAfter: 450 },
    { field: 'referenceReservePrice', label: '参考底价', selector: '#myForm_reservePrice', kind: 'input', required: false, waitAfter: 220 },
    { field: 'referenceQuotedPrice', label: '参考售价', selector: '#myForm_quotedPrice', kind: 'manual', manualMessage: '售价按要求人工填写，插件不自动写入。' },
    { field: 'ownerPhone', label: '车主手机号', selector: '#myForm_otherInfo_ownerPhone', kind: 'input', required: true, waitAfter: 220 },
    { field: 'vin', label: 'VIN', selector: '#myForm_licenseInfo_vinCode', kind: 'input', required: true, waitAfter: 260 },
    { field: 'color', label: '车身颜色', selector: '#myForm_baseInfo_carColor', kind: 'dropdown', required: true, waitAfter: 450 },
    { field: 'mileage', label: '表显里程', selector: '#myForm_baseInfo_mileage', kind: 'input', required: true, waitAfter: 220 },
    { field: 'registerDate', label: '上牌日期', selector: '#myForm_baseInfo_spTime', kind: 'month', required: true, waitAfter: 450 },
    { field: 'registeredAddr', label: '车籍所在地', selector: '#myForm_baseInfo_registeredAddr', kind: 'cascader', required: true, waitAfter: 520 },
    { field: 'parkAddr', label: '停放地区', selector: '#myForm_baseInfo_parkAddr', kind: 'cascader', required: true, waitAfter: 520 },
    { field: 'parkAddrDetail', label: '停放详细地址', selector: '#myForm_baseInfo_parkAddrDetail', kind: 'input', required: false, waitAfter: 220 },
    { field: 'registeredType', label: '车籍性质', selector: '#myForm_baseInfo_registeredType', kind: 'dropdown', required: true, waitAfter: 450 },
    { field: 'transferInfo', label: '过户信息', selector: '#myForm_baseInfo_ghinfo', kind: 'dropdown', required: true, waitAfter: 450 },
    { field: 'brandName', label: '品牌', selector: '#myForm_specInfo_brandId', kind: 'dropdown', required: true, waitAfter: 900 },
    { field: 'seriesName', label: '车系', selector: '#myForm_specInfo_seriesId', kind: 'dropdown', required: true, waitAfter: 900 },
    { field: 'modelName', label: '车型', selector: '#myForm_specInfo_modelId', kind: 'dropdown', required: true, waitAfter: 900 },
    { field: 'description', label: '车辆描述', selector: '', kind: 'textarea', required: false, aliases: ['车辆描述', '车况描述', '补充信息', '描述'], waitAfter: 220 },
  ];

  const SUCCESS_TEXT = /操作成功|提交成功|保存成功|发布成功|新增成功|录入成功/;
  const ERROR_TEXT = /VIN码格式错误|VIN格式错误|请输入正确的手机号|手机号格式错误|校验失败|提交失败|保存失败|不能为空|请选择|错误/;
  let submitWatch = null;
  let submitObserver = null;
  let submitTimer = null;
  let submitClickHandler = null;
  let submitHideHandler = null;

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
        if (msg.type === 'VA_PING') return sendResponse({ ok: true, href: location.href, title: document.title });
        if (msg.type === 'VA_OPEN_ADD_FORM') return sendResponse({ ok: true, result: await openAddForm() });
        if (msg.type === 'VA_WAIT_READY') return sendResponse({ ok: true, result: await waitForReady(msg.timeout || 15000) });
        if (msg.type === 'VA_PROBE_PAGE') return sendResponse({ ok: true, probe: probePage() });
        if (msg.type === 'VA_FILL_ROW') return sendResponse({ ok: true, report: await fillRecordedRow(msg.row || {}) });
        if (msg.type === 'VA_START_SUBMIT_WATCH') return sendResponse({ ok: true, result: startSubmitWatch(msg.row || {}) });
        if (msg.type === 'VA_STOP_SUBMIT_WATCH') return sendResponse({ ok: true, result: stopSubmitWatch('manual-stop') });
        sendResponse({ error: '未知消息: ' + msg.type });
      } catch (e) {
        sendResponse({ error: e?.message || String(e) });
      }
    })();
    return true;
  };
  window.__vaMsgListener = msgListener;
  chrome.runtime.onMessage.addListener(msgListener);

  async function openAddForm() {
    const before = location.href;
    if (looksLikeAddForm()) {
      return { status: 'already-open', href: location.href, message: '已在新增车源表单页' };
    }

    const button = findAddButton();
    if (!button) {
      return { status: 'not-found', href: location.href, message: '当前页未找到"新增库存车/新增车源"按钮，已停留当前页' };
    }

    robustClick(button);
    await sleep(900);
    return {
      status: looksLikeAddForm() || location.href !== before ? 'opened' : 'clicked',
      href: location.href,
      message: '已点击新增库存车入口',
    };
  }

  function looksLikeAddForm() {
    return !!document.querySelector('#myForm_vehicleType, #myForm_specInfo_brandId, #myForm_licenseInfo_vinCode')
      || /showPageModel=1|add|create|publish|approval/.test(location.href)
      && /车辆类型|品牌|车系|车型|VIN|售价|底价|车主手机号|车籍所在地|停放地区|过户信息/.test(document.body.innerText || '');
  }

  function findAddButton() {
    const candidates = [...document.querySelectorAll('button, a, [role="button"], .ant-btn')]
      .filter(isVisible)
      .map(el => ({ el, text: cleanText(el.innerText || el.textContent || el.getAttribute('aria-label') || '') }))
      .filter(item => /新增库存车|新增车源|新增车辆|新增/.test(item.text));
    candidates.sort((a, b) => scoreAddText(b.text) - scoreAddText(a.text));
    return candidates[0]?.el || null;
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

  async function fillRecordedRow(row) {
    const report = [];
    clearHighlights();

    for (const spec of RECORDED_FLOW_FIELDS) {
      const value = valueForSpec(row, spec);

      if (spec.kind === 'manual') {
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
          continue;
        }
        target = fallback;
        score = 40;
      }

      try {
        const result = await setRecordedControlValue(target, value, spec) || { ok: false, message: '控件填充没有返回结果' };
        markControl(target, result.ok ? 'ok' : 'bad');
        report.push(buildFieldReport(spec, value, result, target, score));
        await sleep(result.ok ? (spec.waitAfter || 260) : 220);
      } catch (e) {
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
      message: result.message,
      selector: spec.selector,
      elementKey: elementKey(control),
      target: describeControl(control, Number(control.dataset.vaIndex || 0)),
      score,
    };
  }

  function findRecordedControl(spec) {
    if (!spec.selector) return null;
    const el = document.querySelector(spec.selector);
    if (!el) return null;
    const target = controlRoot(el) || el;
    if (!isVisible(target)) return null;
    if (!target.dataset.vaIndex) target.dataset.vaIndex = String(getControls().indexOf(target) + 1 || 1);
    return target;
  }

  function findFallbackControl(spec) {
    if (!spec.aliases?.length) return null;
    const controls = getControls();
    let best = null;
    controls.forEach((el, index) => {
      const hay = norm([el.id, nestedAttr(el, 'id'), el.getAttribute('name'), nestedAttr(el, 'name'), labelText(el), contextText(el)].join(' '));
      const score = spec.aliases.reduce((sum, alias) => sum + (hay.includes(norm(alias)) ? 50 : 0), 0);
      if (score > 0 && (!best || score > best.score)) best = { el, index, score };
    });
    return best?.el || null;
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

  async function setDropdownValue(control, value, spec) {
    const root = controlRoot(control) || control;
    const before = readControlValue(root);
    if (norm(before) === norm(value)) return { ok: true, message: '当前已选择匹配项' };

    root.scrollIntoView?.({ block: 'center', inline: 'nearest' });

    // 依次尝试多个点击目标，确保 Ant Design 下拉框能打开
    const clickTargets = [];
    if (control !== root) clickTargets.push(control);
    clickTargets.push(dropdownClickTarget(root));
    clickTargets.push(root);

    let opened = false;
    for (const target of clickTargets) {
      if (!target) continue;
      robustClick(target);
      await sleep(260);
      if (isDropdownOpen()) { opened = true; break; }
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

    let option = findDropdownOption(value, spec);
    if (!option) {
      await sleep(400);
      option = findDropdownOption(value, spec);
    }
    if (!option) return { ok: false, message: '下拉框未找到匹配选项"' + value + '"，请人工选择' };
    return clickDropdownOption(option, root, value);
  }

  function clickDropdownOption(option, root, value) {
    const optionText = cleanText(option.getAttribute('title') || option.innerText || option.textContent || '');
    // 点击内层 div（与录制流程一致：.ant-select-item-option > div）
    const innerDiv = option.querySelector?.('div') || option;
    robustClick(innerDiv);
    sleep(300).then(() => { dispatch(root, 'change'); });
    return { ok: true, message: '已选择: ' + (optionText || value) };
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
    return { ok: true, message: '已选择: ' + selected.join(' / ') };
  }

  function findDropdownOption(value, spec) {
    const key = norm(value);
    const aliases = dropdownValueAliases(value, spec).map(norm);
    const options = [...document.querySelectorAll([
      '.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option:not(.ant-select-item-option-disabled)',
      '.ant-select-dropdown:not(.ant-select-dropdown-hidden) [role="option"]:not([aria-disabled="true"])',
      '[role="listbox"] [role="option"]:not([aria-disabled="true"])',
    ].join(','))].filter(isVisible);

    const scored = options.map(option => {
      const text = cleanText(option.getAttribute('title') || option.innerText || option.textContent || '');
      const optKey = norm(text);
      let score = 0;
      if (optKey === key || aliases.includes(optKey)) score = 120;
      else if (aliases.some(alias => optKey === alias)) score = 110;
      else if (optKey.includes(key)) score = 80;
      else if (aliases.some(alias => optKey.includes(alias))) score = 78;
      else if (key.includes(optKey) && optKey.length >= 2) score = 45;
      return { option, score, text };
    }).filter(item => item.score > 0);

    scored.sort((a, b) => b.score - a.score || a.text.length - b.text.length);
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

    const scored = options.map(option => {
      const text = cleanText(option.getAttribute('title') || option.innerText || option.textContent || '');
      const optKey = norm(text);
      let score = 0;
      if (optKey === key || aliases.includes(optKey)) score = 220; // 命中指定列 + 精确匹配 = 最高分
      else if (aliases.some(alias => optKey === alias)) score = 210;
      else if (optKey.includes(key)) score = 180;
      else if (aliases.some(alias => optKey.includes(alias))) score = 178;
      else if (key.includes(optKey) && optKey.length >= 2) score = 145;
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
    return [...new Set(out.filter(Boolean))];
  }

  function normalizeDropdownSearchValue(value, spec) {
    if (spec.field === 'withTrailer') return dropdownValueAliases(value, spec)[0];
    return String(value || '').trim();
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
    };

    submitClickHandler = event => {
      const button = event.target?.closest?.('button, [role="button"], .ant-btn');
      if (!button) return;
      const text = cleanText(button.innerText || button.textContent || button.getAttribute('aria-label') || '');
      if (/提交/.test(text) && !/取消提交|取消/.test(text)) submitWatch.sawSubmitClick = true;
    };
    document.addEventListener('click', submitClickHandler, true);

    submitObserver = new MutationObserver(checkSubmitState);
    submitObserver.observe(document.body || document.documentElement, { childList: true, subtree: true, characterData: true });
    submitTimer = window.setInterval(checkSubmitState, 700);

    submitHideHandler = () => {
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
        message: '提交后页面已跳转（pagehide 兜底）',
        submittedAt: new Date().toLocaleString(),
        source: 'pagehide',
      };
      stopSubmitWatch('pagehide');
      try { chrome.runtime.sendMessage(payload).catch(() => {}); } catch {}
    };
    window.addEventListener('pagehide', submitHideHandler, { capture: true });
    window.addEventListener('beforeunload', submitHideHandler, { capture: true });

    return { status: 'watching', rowNumber: submitWatch.rowNumber, href: location.href };
  }

  function stopSubmitWatch(reason) {
    if (submitObserver) submitObserver.disconnect();
    if (submitTimer) window.clearInterval(submitTimer);
    if (submitClickHandler) document.removeEventListener('click', submitClickHandler, true);
    if (submitHideHandler) {
      window.removeEventListener('pagehide', submitHideHandler, { capture: true });
      window.removeEventListener('beforeunload', submitHideHandler, { capture: true });
    }
    submitObserver = null;
    submitTimer = null;
    submitClickHandler = null;
    submitHideHandler = null;
    const previous = submitWatch;
    submitWatch = null;
    return { status: 'stopped', reason, previousRowNumber: previous?.rowNumber || '' };
  }

  function checkSubmitState() {
    if (!submitWatch || submitWatch.sent) return;
    const error = visibleErrorText();
    if (error) return;

    const success = visibleSuccessText();
    const formGoneAfterSubmit = submitWatch.sawSubmitClick && location.href !== submitWatch.startHref && !looksLikeAddForm();
    if (!success && !formGoneAfterSubmit) return;

    submitWatch.sent = true;
    const payload = {
      type: 'VA_SUBMIT_SUCCESS',
      rowId: submitWatch.rowId,
      rowNumber: submitWatch.rowNumber,
      displayName: submitWatch.displayName,
      href: location.href,
      message: success || '提交后页面已离开新增表单',
      submittedAt: new Date().toLocaleString(),
    };
    stopSubmitWatch('success');
    chrome.runtime.sendMessage(payload).catch(() => {});
  }

  function visibleSuccessText() {
    const text = toastText('.ant-message-success, .ant-notification-notice-success, .el-message--success, .el-notification.success, .ant-message-notice-content');
    const match = text.match(SUCCESS_TEXT);
    return match ? match[0] : '';
  }

  function visibleErrorText() {
    const text = toastText('.ant-message-error, .ant-notification-notice-error, .el-message--error, .ant-form-item-explain-error');
    const match = text.match(ERROR_TEXT);
    return match ? match[0] : '';
  }

  function toastText(selector) {
    return [...document.querySelectorAll(selector)].filter(isVisible).map(el => cleanText(el.innerText || el.textContent || '')).join(' ');
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

  function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
})();
