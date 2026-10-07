// DeepSeek Harness 一键导入：把发现的免费模型写进 ~/.dsh/settings.yaml
//
// dsh 的模型配置在 settings.yaml 里按插件 id 分组：
//   llm-pi-ai:
//     providers:
//       <provider-id>:
//         displayName: …
//         api: openai-completions
//         baseURL: http://127.0.0.1:5180/v1
//         apiKeyEnv: DSH_BRIDGE_API_KEY
//         models:
//           - id: opencode/xxx-free
//             name: DSHB · xxx
//
// 导入前先备份原文件；只动属于本应用的 provider（id 固定为 dsh-bridge），
// 退出清理时也只删这一项，用户手动加的配置原样保留。
const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

const PROVIDER_ID = 'dsh-bridge';
const DISPLAY_NAME = 'DSH Bridge（OpenCode 免费模型）';

function loadSettings(settingsPath) {
  try {
    const raw = fs.readFileSync(settingsPath, 'utf8');
    const doc = YAML.parse(raw);
    return doc && typeof doc === 'object' ? doc : {};
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw new Error(`读取 dsh 配置失败: ${e.message}`);
  }
}

function backup(settingsPath) {
  if (!fs.existsSync(settingsPath)) return null;
  const bak = `${settingsPath}.bak.${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(settingsPath, bak);
  return bak;
}

function buildProviderEntry(proxyBaseUrl, models) {
  return {
    displayName: DISPLAY_NAME,
    api: 'openai-completions',
    baseURL: `${proxyBaseUrl.replace(/\/+$/, '')}/v1`,
    // 本地代理不校验 key，但 dsh 要求填一个环境变量名；任意值即可
    apiKeyEnv: 'DSH_BRIDGE_API_KEY',
    models: models.map((m) => {
      const entry = { id: m.modelID, name: `DSHB · ${m.name}` };
      if (m.contextWindow) entry.contextWindow = m.contextWindow;
      if (m.maxTokens) entry.maxTokens = m.maxTokens;
      return entry;
    }),
  };
}

// 导入：返回 { added: 模型数, backup: 备份路径|null }
function importModels(settingsPath, proxyBaseUrl, models) {
  if (!models.length) throw new Error('没有可用模型可导入');
  const bak = backup(settingsPath);
  const doc = loadSettings(settingsPath);
  doc['llm-pi-ai'] = doc['llm-pi-ai'] && typeof doc['llm-pi-ai'] === 'object' ? doc['llm-pi-ai'] : {};
  const pi = doc['llm-pi-ai'];
  pi.providers = pi.providers && typeof pi.providers === 'object' ? pi.providers : {};
  pi.providers[PROVIDER_ID] = buildProviderEntry(proxyBaseUrl, models);
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, YAML.stringify(doc), 'utf8');
  return { added: models.length, backup: bak };
}

// 退出清理：只删除本应用导入的 provider，用户手动配置不动
function removeImported(settingsPath) {
  let doc;
  try { doc = loadSettings(settingsPath); } catch { return false; }
  const pi = doc && doc['llm-pi-ai'];
  if (!pi || !pi.providers || !pi.providers[PROVIDER_ID]) return false;
  delete pi.providers[PROVIDER_ID];
  fs.writeFileSync(settingsPath, YAML.stringify(doc), 'utf8');
  return true;
}

function isImported(settingsPath) {
  try {
    const doc = loadSettings(settingsPath);
    return !!(doc['llm-pi-ai'] && doc['llm-pi-ai'].providers && doc['llm-pi-ai'].providers[PROVIDER_ID]);
  } catch { return false; }
}

module.exports = { importModels, removeImported, isImported, PROVIDER_ID, DISPLAY_NAME };
