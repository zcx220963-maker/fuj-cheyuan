(function () {
  'use strict';

  async function testConfig(config) {
    const res = await normalizeRow({ title: '奥迪A6L 2020款 45 TFSI 臻选动感型', brandName: '奥迪', seriesName: 'A6L', modelName: 'A6L' }, config);
    return res;
  }

  async function normalizeRow(row, config) {
    validateConfig(config);
    const body = {
      model: config.aiModel,
      temperature: 0.1,
      messages: [
        {
          role: 'system',
          content: '你是车辆车型文本标准化助手。只输出 JSON，不要 Markdown，不要解释。字段：brandName, seriesName, modelName, configName, vehicleType, year, confidence, reason。confidence 是 0 到 1 的数字。无法确定时保留空字符串并降低 confidence。'
        },
        {
          role: 'user',
          content: JSON.stringify({
            task: '请把这条车源标准化为车型库字段',
            row: {
              title: row.title || '',
              brandName: row.brandName || '',
              seriesName: row.seriesName || '',
              modelName: row.modelName || '',
              subModelName: row.subModelName || '',
              vehicleType: row.vehicleType || '',
              year: row.year || '',
              sourceRow: row.sourceRow || {},
            }
          })
        }
      ],
    };

    const resp = await chrome.runtime.sendMessage({
      type: 'VA_AI_REQUEST',
      url: config.aiEndpoint,
      apiKey: config.aiKey,
      body,
    });

    if (!resp || resp.error) throw new Error(resp?.error || 'AI 请求失败');
    const content = extractContent(resp.data);
    const parsed = parseJsonLoose(content);
    return normalizeAiShape(parsed);
  }

  function validateConfig(config) {
    if (!config || !config.aiEndpoint) throw new Error('请填写 AI API 地址');
    if (!config.aiKey) throw new Error('请填写 AI API Key');
    if (!config.aiModel) throw new Error('请填写模型名称');
  }

  function extractContent(data) {
    if (!data) throw new Error('AI 返回为空');
    if (typeof data === 'string') return data;
    const content = data.choices?.[0]?.message?.content ?? data.choices?.[0]?.text ?? data.output_text ?? data.content;
    if (!content) throw new Error('AI 返回结构中没有 content');
    return String(content);
  }

  function parseJsonLoose(text) {
    const raw = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
    try { return JSON.parse(raw); } catch (e) {}
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('AI 返回不是有效 JSON');
  }

  function normalizeAiShape(ai) {
    return {
      brandName: stringOf(ai.brandName || ai.brand || ai.品牌),
      seriesName: stringOf(ai.seriesName || ai.series || ai.车系),
      modelName: stringOf(ai.modelName || ai.model || ai.车型),
      configName: stringOf(ai.configName || ai.subModelName || ai.config || ai.配置 || ai.子类),
      vehicleType: stringOf(ai.vehicleType || ai.type || ai.车辆类型),
      year: stringOf(ai.year || ai.年款 || ai.年份),
      confidence: clamp(Number(ai.confidence || ai.置信度 || 0), 0, 1),
      reason: stringOf(ai.reason || ai.原因),
    };
  }

  function stringOf(v) { return v == null ? '' : String(v).trim(); }
  function clamp(n, min, max) { return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : min; }

  window.VehicleAI = { normalizeRow, testConfig };
})();
