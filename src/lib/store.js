(function () {
  'use strict';

  const KEY = 'vehicleUploadAssistantState';
  const DEFAULT_STATE = {
    version: 2,
    config: {
      aiEndpoint: 'https://api.deepseek.com/v1/chat/completions',
      aiKey: '',
      aiModel: 'deepseek-chat',
      addPageUrl: 'http://test.forjtruck.com/vehicle-source/approval?showPageModel=1',
    },
    batch: {
      running: false,
      paused: false,
      phase: 'idle',
      waitingRowId: '',
      waitingRowNumber: '',
      completed: 0,
      failed: 0,
      startedAt: '',
      lastMessage: '',
      lastAddPageUrl: '',
    },
    rows: [],
    headers: [],
    headerMap: {},
    currentIndex: 0,
    probe: null,
    missingReport: [],
    logs: [],
    fileName: '',
    importedAt: '',
    aiSummary: '',
  };

  let state = structuredCloneSafe(DEFAULT_STATE);

  function structuredCloneSafe(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  async function load() {
    const result = await chrome.storage.local.get(KEY);
    const saved = result[KEY] || {};
    state = { ...structuredCloneSafe(DEFAULT_STATE), ...saved };
    state.config = { ...DEFAULT_STATE.config, ...(saved.config || {}) };
    state.batch = { ...DEFAULT_STATE.batch, ...(saved.batch || {}) };
    state.rows = Array.isArray(state.rows) ? state.rows : [];
    state.logs = Array.isArray(state.logs) ? state.logs : [];
    state.headers = Array.isArray(state.headers) ? state.headers : [];
    state.missingReport = Array.isArray(state.missingReport) ? state.missingReport : [];
    return get();
  }

  async function save(patch) {
    const next = patch || {};
    state = {
      ...state,
      ...next,
      config: next.config ? { ...state.config, ...next.config } : state.config,
      batch: next.batch ? { ...state.batch, ...next.batch } : state.batch,
    };
    await chrome.storage.local.set({ [KEY]: state });
    return get();
  }

  async function clear() {
    state = structuredCloneSafe(DEFAULT_STATE);
    await chrome.storage.local.set({ [KEY]: state });
    return get();
  }

  async function setConfig(config) {
    return save({ config: { ...state.config, ...(config || {}) } });
  }

  async function setBatch(batch) {
    return save({ batch: { ...state.batch, ...(batch || {}) } });
  }

  async function addLog(message, level = 'info') {
    const logs = [...(state.logs || []), {
      ts: new Date().toLocaleTimeString(),
      message: String(message || ''),
      level,
    }].slice(-300);
    return save({ logs });
  }

  async function clearLogs() {
    return save({ logs: [] });
  }

  function get() {
    return structuredCloneSafe(state);
  }

  window.VehicleStore = { load, save, clear, setConfig, setBatch, addLog, clearLogs, get };
})();
