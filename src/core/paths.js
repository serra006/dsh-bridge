// 路径工具：应用数据目录、DeepSeek Harness 配置文件位置
const path = require('path');
const os = require('os');

// 本应用的数据目录（放下载的 opencode、隔离配置、状态文件）
function appDataDir() {
  if (process.env.DSH_BRIDGE_DATA) return process.env.DSH_BRIDGE_DATA;
  const home = os.homedir();
  switch (process.platform) {
    case 'win32':
      return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'dsh-bridge');
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'dsh-bridge');
    default:
      return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'dsh-bridge');
  }
}

// DeepSeek Harness 的模型配置文件：$DSH_HOME/settings.yaml，默认 ~/.dsh/settings.yaml
function dshSettingsPath() {
  if (process.env.DSH_HOME) return path.join(process.env.DSH_HOME, 'settings.yaml');
  return path.join(os.homedir(), '.dsh', 'settings.yaml');
}

module.exports = { appDataDir, dshSettingsPath };
