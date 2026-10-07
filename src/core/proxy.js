// OpenAI 兼容代理：把 /v1/chat/completions 转成 opencode 一次性会话调用
//
//  - 每个外部请求开一个临时 session，结束后删除，无状态；
//  - tools 固定禁用，模型只做纯文本回复，不执行任何本地动作；
//  - 多轮对话拼成单条 prompt（带角色前缀），system 拼在最前；
//  - 支持 stream:true（文本切块合成 SSE，不是逐 token 真流式）。
const http = require('http');
const { randomUUID } = require('crypto');

const REQUEST_TIMEOUT_MS = 180000;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 8 * 1024 * 1024) { req.destroy(); reject(new Error('请求体过大')); }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function openaiError(res, status, message) {
  sendJson(res, status, { error: { message, type: 'dsh_bridge_error' } });
}

// 把 OpenAI messages 拼成 opencode 的单条 prompt
function buildPrompt(messages) {
  const systems = [];
  const turns = [];
  for (const m of messages || []) {
    const text = typeof m.content === 'string'
      ? m.content
      : (m.content || []).filter((p) => p.type === 'text').map((p) => p.text || '').join('\n');
    if (m.role === 'system' || m.role === 'developer') systems.push(text);
    else if (m.role === 'assistant') turns.push(`assistant: ${text}`);
    else turns.push(`user: ${text}`);
  }
  return [...systems, ...turns].join('\n\n').trim();
}

function extractText(msg) {
  const parts = msg.parts || [];
  return parts.filter((p) => p.type === 'text').map((p) => p.text || '').join('');
}

async function callOpencode(baseUrl, model, prompt) {
  let sessionId = null;
  try {
    const sRes = await fetch(`${baseUrl}/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'dsh-bridge chat' }),
      signal: AbortSignal.timeout(15000),
    });
    if (!sRes.ok) throw new Error(`建会话失败: HTTP ${sRes.status}`);
    const s = await sRes.json();
    sessionId = s.id || (s.info && s.info.id);
    if (!sessionId) throw new Error('建会话没有返回 id');

    const mRes = await fetch(`${baseUrl}/session/${sessionId}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: { providerID: model.providerID, modelID: model.modelID },
        tools: {}, // 禁用工具：纯文本对话
        parts: [{ type: 'text', text: prompt }],
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!mRes.ok) {
      const t = await mRes.text().catch(() => '');
      throw new Error(`上游返回 HTTP ${mRes.status}: ${t.slice(0, 300)}`);
    }
    const msg = await mRes.json();
    const text = extractText(msg);
    if (!text) throw new Error('上游没有返回文本');
    return text;
  } finally {
    if (sessionId) {
      try { await fetch(`${baseUrl}/session/${sessionId}`, { method: 'DELETE', signal: AbortSignal.timeout(5000) }); } catch { /* 忽略清理失败 */ }
    }
  }
}

function resolveModel(requested, models) {
  if (!models.length) return null;
  if (!requested) return models[0];
  return models.find((m) => m.modelID === requested || m.name === requested) || models[0];
}

function sseChunk(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

function createProxy({ getBaseUrl, getModels, port }) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const path = url.pathname.replace(/\/+$/, '') || '/';

      if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) {
        const models = getModels();
        return sendJson(res, 200, {
          object: 'list',
          data: models.map((m) => ({ id: m.modelID, object: 'model', created: 0, owned_by: 'dsh-bridge' })),
        });
      }

      if (req.method === 'GET' && (path === '/health' || path === '/v1/health')) {
        return sendJson(res, 200, { ok: true, models: getModels().length });
      }

      if (req.method === 'POST' && (path === '/v1/chat/completions' || path === '/chat/completions')) {
        const raw = await readBody(req);
        let body;
        try { body = JSON.parse(raw); } catch { return openaiError(res, 400, '请求体不是合法 JSON'); }

        const models = getModels();
        const model = resolveModel(body.model, models);
        if (!model) return openaiError(res, 503, '当前没有可用模型，请先扫描');

        const prompt = buildPrompt(body.messages);
        if (!prompt) return openaiError(res, 400, '消息为空');

        const text = await callOpencode(getBaseUrl(), model, prompt);
        const id = `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 24)}`;
        const created = Math.floor(Date.now() / 1000);

        if (body.stream) {
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          });
          sseChunk(res, { id, object: 'chat.completion.chunk', created, model: model.modelID, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
          // 文本切块合成 SSE（非逐 token 真流式）
          const chunks = text.match(/[\s\S]{1,60}/g) || [];
          for (const c of chunks) {
            sseChunk(res, { id, object: 'chat.completion.chunk', created, model: model.modelID, choices: [{ index: 0, delta: { content: c }, finish_reason: null }] });
          }
          sseChunk(res, { id, object: 'chat.completion.chunk', created, model: model.modelID, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
          res.write('data: [DONE]\n\n');
          return res.end();
        }

        return sendJson(res, 200, {
          id,
          object: 'chat.completion',
          created,
          model: model.modelID,
          choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        });
      }

      return openaiError(res, 404, `未知路径 ${path}`);
    } catch (e) {
      if (!res.headersSent) openaiError(res, 502, e.message);
      else try { res.end(); } catch { /* 忽略 */ }
    }
  });

  function listen() {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => resolve(`http://127.0.0.1:${port}`));
    });
  }

  return { server, listen, close: () => new Promise((r) => server.close(r)) };
}

module.exports = { createProxy, buildPrompt, extractText };
