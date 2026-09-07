chrome.runtime.onInstalled.addListener(() => {
  console.log('[vehicle-upload-assistant] installed');
  if (chrome.sidePanel?.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.sidePanel.open({ windowId: tab.windowId });
  } catch (e) {
    console.warn('[vehicle-upload-assistant] open side panel failed:', e?.message || e);
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const type = msg?.type;

  // ============ 核心跳转：强制把任意一个 normal tab 切到目标 URL ============
  // sidepanel 页面调用 chrome.tabs.query({currentWindow:true}) 拿到的是 sidepanel 自己的"窗口"，
  // 不是用户正在操作的那个管理后台窗口 → 完全跳转不动。
  // 所以跳转逻辑必须放在 service worker 里，使用 chrome.windows.getAll() 枚举所有 normal 窗口。
  if (type === 'VA_OPEN_ADD_PAGE') {
    (async () => {
      try {
        const result = await openAddPage(msg.targetUrl);
        sendResponse({ ok: true, result });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (type === 'VA_GET_TARGET_TAB_ID') {
    (async () => {
      try {
        const tabId = await findTargetTabId(msg.origin || null);
        sendResponse({ ok: true, tabId });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (type !== 'VA_AI_REQUEST') return false;
  (async () => {
    try {
      const resp = await fetch(msg.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${msg.apiKey}`,
        },
        body: JSON.stringify(msg.body),
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`API错误 ${resp.status}: ${text || resp.statusText}`);
      }

      const data = await resp.json();
      sendResponse({ ok: true, data });
    } catch (e) {
      sendResponse({ error: e?.message || String(e) });
    }
  })();
  return true;
});

// ---------- openAddPage ----------
async function openAddPage(targetUrl) {
  if (!targetUrl) throw new Error('缺少目标 URL');

  // 1) 找窗口：优先取最后一个 focused=true 的 normal 窗口，没有就取所有 normal 中最后一个
  let targetWindow = null;
  try {
    const windows = await chrome.windows.getAll({ windowTypes: ['normal'], populate: false });
    const normals = (windows || []).filter(w => w && w.type === 'normal' && w.id);
    if (normals.length) {
      targetWindow = normals.find(w => w.focused) || normals[normals.length - 1];
    }
  } catch (e) {
    console.warn('[VA] 枚举窗口失败：', e?.message || e);
  }

  let tabId = null;

  if (targetWindow) {
    try {
      await chrome.windows.update(targetWindow.id, { focused: true });
    } catch {}
    // 2a) 在目标窗口里取一个 tab：优先 active，否则最后一个；然后 update url + scripting executeScript 双保险
    try {
      const tabs = await chrome.tabs.query({ windowId: targetWindow.id, active: true });
      let pick = tabs && tabs[0];
      if (!pick?.id) {
        const all = await chrome.tabs.query({ windowId: targetWindow.id });
        pick = all && all[all.length - 1];
      }
      if (pick && pick.id) {
        tabId = pick.id;
        await forceNavigate(tabId, targetUrl);
      }
    } catch (e) {
      console.warn('[VA] 在目标窗口 update 失败，改为新建 tab：', e?.message || e);
    }
  }

  // 2b) 没拿到窗口或 tab，直接新建一个 tab 到目标 URL
  if (!tabId) {
    const created = await chrome.tabs.create({ url: targetUrl, active: true });
    if (!created?.id) throw new Error('新建 tab 失败');
    tabId = created.id;
    // 新建 tab 时 chrome 已经帮我们跳到了 targetUrl，但仍强制 execute location.replace 保证 query 不丢
    try { await chrome.scripting.executeScript({ target: { tabId }, args: [targetUrl], func: (u) => { try { location.replace(u); } catch { location.href = u; } } }); } catch {}
  }

  // 3) 轮询最多 8s，要求 URL 命中目标（sameLocation 或有 showPageModel=1）
  const isHit = (url) => {
    if (!url) return false;
    if (/showPageModel=1/.test(url)) return true;
    try {
      const a = new URL(url);
      const b = new URL(targetUrl);
      return a.origin === b.origin && a.pathname === b.pathname && a.search === b.search;
    } catch {
      return String(url).trim() === String(targetUrl).trim();
    }
  };

  const deadline = Date.now() + 8000;
  let finalUrl = '';
  while (Date.now() < deadline) {
    try {
      const t = await chrome.tabs.get(tabId);
      finalUrl = t?.url || '';
      if (isHit(finalUrl)) break;
    } catch {}
    await new Promise(r => setTimeout(r, 300));
  }

  // 还没命中 → 再来一次 executeScript + reload 双保险
  if (!isHit(finalUrl)) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        args: [targetUrl],
        func: (u) => { try { location.replace(u); } catch { location.href = u; } },
      });
    } catch {}
    try { await chrome.tabs.reload(tabId); } catch {}
    await new Promise(r => setTimeout(r, 1500));
    try { finalUrl = (await chrome.tabs.get(tabId))?.url || ''; } catch {}
  }

  return { tabId, finalUrl, hit: isHit(finalUrl) };
}

async function forceNavigate(tabId, targetUrl) {
  // 三重跳转，确保命中
  // 1) tabs.update(url)
  try {
    await chrome.tabs.update(tabId, { url: targetUrl, active: true });
  } catch (e) {
    console.warn('[VA] tabs.update 失败：', e?.message || e);
  }
  // 2) scripting.executeScript(location.replace)
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      args: [targetUrl],
      func: (u) => { try { location.replace(u); } catch { location.href = u; } },
    });
  } catch (e) {
    console.warn('[VA] scripting location.replace 失败：', e?.message || e);
  }
  // 3) 再 tabs.update 一次兜底
  try { await chrome.tabs.update(tabId, { url: targetUrl, active: true }); } catch {}
}

async function findTargetTabId(originHint) {
  // 在 normal 窗口里找一个合适的 tabId，供 sidepanel 的 sendToActiveTab 发消息
  // 优先找 originHint 同域的 active tab；退而求其次 active tab；再退最后一个 normal tab；实在没有新建一个
  const normals = (await chrome.windows.getAll({ windowTypes: ['normal'], populate: true })) || [];
  const flat = [];
  for (const w of normals) {
    if (!w || w.type !== 'normal' || !w.tabs) continue;
    for (const t of w.tabs) flat.push({ tab: t, focused: !!w.focused, windowId: w.id });
  }
  if (!flat.length) {
    const created = await chrome.tabs.create({ active: true });
    return created?.id || null;
  }

  const byScore = flat
    .filter(x => x.tab && x.tab.id && !String(x.tab.url || '').startsWith('chrome://'))
    .map(x => {
      let score = 0;
      if (x.focused) score += 100;
      if (x.tab.active) score += 100;
      if (originHint) {
        try {
          if (new URL(x.tab.url).origin === originHint) score += 500;
        } catch {}
      }
      return { ...x, score };
    })
    .sort((a, b) => b.score - a.score);

  const pick = byScore[0] || flat[flat.length - 1];
  // 尝试将窗口置前台
  if (pick.windowId) { try { await chrome.windows.update(pick.windowId, { focused: true }); } catch {} }
  return pick.tab.id;
}
