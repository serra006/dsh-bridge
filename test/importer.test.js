// importer + proxy 纯函数单元测试（不依赖网络）
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const importer = require('../src/core/importer');
const { buildPrompt, extractText } = require('../src/core/proxy');

function tmpSettings(initial) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-'));
  const p = path.join(dir, 'settings.yaml');
  if (initial !== undefined) fs.writeFileSync(p, initial, 'utf8');
  return p;
}

const MODELS = [
  { providerID: 'opencode', modelID: 'muse-spark-1.3-contributor-free', name: 'Muse Spark 1.3 Free', contextWindow: 1048576, maxTokens: 131072 },
];

test('导入会合并进现有配置且不破坏用户已有 provider', () => {
  const p = tmpSettings('llm-pi-ai:\n  providers:\n    myown:\n      displayName: mine\n      baseURL: https://x/v1\n');
  const r = importer.importModels(p, 'http://127.0.0.1:5180', MODELS);
  assert.equal(r.added, 1);
  assert.ok(r.backup && fs.existsSync(r.backup));
  const content = fs.readFileSync(p, 'utf8');
  assert.ok(content.includes('myown'));
  assert.ok(content.includes('dsh-bridge'));
  assert.ok(content.includes('muse-spark-1.3-contributor-free'));
  assert.ok(importer.isImported(p));
});

test('没有模型时导入应抛错', () => {
  const p = tmpSettings();
  assert.throws(() => importer.importModels(p, 'http://127.0.0.1:5180', []), /没有可用模型/);
});

test('退出清理只删除本应用的 provider', () => {
  const p = tmpSettings('llm-pi-ai:\n  providers:\n    myown:\n      displayName: mine\n');
  importer.importModels(p, 'http://127.0.0.1:5180', MODELS);
  assert.equal(importer.removeImported(p), true);
  const content = fs.readFileSync(p, 'utf8');
  assert.ok(content.includes('myown'));
  assert.ok(!content.includes('dsh-bridge'));
  assert.equal(importer.isImported(p), false);
  assert.equal(importer.removeImported(p), false); // 重复清理返回 false
});

test('导入会写入 contextWindow / maxTokens', () => {
  const p = tmpSettings();
  importer.importModels(p, 'http://127.0.0.1:5180', MODELS);
  const content = fs.readFileSync(p, 'utf8');
  assert.ok(content.includes('contextWindow: 1048576'));
  assert.ok(content.includes('maxTokens: 131072'));
});

test('buildPrompt 拼接 system 与多轮对话', () => {
  const prompt = buildPrompt([
    { role: 'system', content: '你是助手' },
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '您好' },
    { role: 'user', content: '1+1=?' },
  ]);
  assert.ok(prompt.startsWith('你是助手'));
  assert.ok(prompt.includes('user: 你好'));
  assert.ok(prompt.includes('assistant: 您好'));
});

test('extractText 只取 text 类型的 part', () => {
  const t = extractText({ parts: [{ type: 'text', text: 'hello' }, { type: 'tool_call', text: 'x' }] });
  assert.equal(t, 'hello');
});
