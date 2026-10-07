// 免费模型发现：从 opencode serve 列出 `-free` 模型并逐个探测可用性
//
// 免费模型名单经常变动，所以不硬编码：每次启动都重新拉取 + 探测。
// 探测用一次性 session，发一条极短消息，能正常回文本才算可用。

async function listFreeModels(baseUrl) {
  const res = await fetch(`${baseUrl}/config/providers`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`拉取 provider 列表失败: HTTP ${res.status}`);
  const data = await res.json();
  const providers = data.providers || data.all || [];
  const oc = providers.find((p) => p.id === 'opencode' || p.name === 'opencode');
  if (!oc) throw new Error('serve 没有暴露 opencode provider');
  // models 可能是数组，也可能是 { id: model } 的字典（实测 v1.18 是字典）
  const raw = oc.models || {};
  const models = Array.isArray(raw) ? raw : Object.values(raw);
  return models
    .filter((m) => {
      const id = m.id || m.modelID || '';
      // 免费信号：cost 全 0，或 id 带 -free 后缀
      const zeroCost = m.cost && Number(m.cost.input) === 0 && Number(m.cost.output) === 0;
      return zeroCost || /free/i.test(id);
    })
    .map((m) => ({
      providerID: 'opencode',
      modelID: m.id || m.modelID,
      name: m.name || m.id || m.modelID,
      // 有就带上，导入 dsh 时写入 contextWindow / maxTokens
      contextWindow: m.limit && Number(m.limit.context) > 0 ? Number(m.limit.context) : undefined,
      maxTokens: m.limit && Number(m.limit.output) > 0 ? Number(m.limit.output) : undefined,
    }));
}

// 探测单个模型是否真的可用；返回 { ok, latencyMs, sample?, reason? }
async function probeModel(baseUrl, model, timeoutMs = 90000) {
  const t0 = Date.now();
  let sessionId = null;
  try {
    const sRes = await fetch(`${baseUrl}/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'dsh-bridge probe' }),
      signal: AbortSignal.timeout(15000),
    });
    if (!sRes.ok) return { ok: false, reason: `建会话失败: HTTP ${sRes.status}` };
    const s = await sRes.json();
    sessionId = s.id || (s.info && s.info.id);
    if (!sessionId) return { ok: false, reason: '建会话没有返回 id' };

    const mRes = await fetch(`${baseUrl}/session/${sessionId}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: { providerID: model.providerID, modelID: model.modelID },
        // 禁用工具：只做纯文本对话，不让模型执行任何本地动作
        tools: {},
        parts: [{ type: 'text', text: 'hi' }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!mRes.ok) {
      const errText = await mRes.text().catch(() => '');
      return { ok: false, reason: `HTTP ${mRes.status} ${errText.slice(0, 200)}` };
    }
    const msg = await mRes.json();
    const parts = msg.parts || [];
    const text = parts.filter((p) => p.type === 'text').map((p) => p.text || '').join('');
    if (!text.trim()) return { ok: false, reason: '无文本回复' };
    return { ok: true, latencyMs: Date.now() - t0, sample: text.slice(0, 120) };
  } catch (e) {
    return { ok: false, reason: e.name === 'TimeoutError' ? '探测超时' : e.message };
  } finally {
    if (sessionId) {
      try { await fetch(`${baseUrl}/session/${sessionId}`, { method: 'DELETE', signal: AbortSignal.timeout(5000) }); } catch { /* 清理失败不影响结果 */ }
    }
  }
}

// 拉取 + 并发探测，返回可用模型列表（附带延迟）
async function discover(baseUrl, { concurrency = 3, onProgress } = {}) {
  const candidates = await listFreeModels(baseUrl);
  onProgress && onProgress(`发现 ${candidates.length} 个免费模型，开始探测…`);
  const results = [];
  const queue = [...candidates];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const m = queue.shift();
      onProgress && onProgress(`探测 ${m.modelID}…`);
      const r = await probeModel(baseUrl, m);
      results.push({ ...m, ...r });
      onProgress && onProgress(`${m.modelID}: ${r.ok ? `可用 (${r.latencyMs}ms)` : `不可用 (${r.reason})`}`);
    }
  });
  await Promise.all(workers);
  return results.filter((r) => r.ok).sort((a, b) => a.latencyMs - b.latencyMs);
}

module.exports = { listFreeModels, probeModel, discover };
