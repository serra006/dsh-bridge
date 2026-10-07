// 读取 Windows 系统代理设置（对标 ow-bridge 的"使用系统代理"）
//
// 位置：HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings
//   ProxyEnable (REG_DWORD)：1 表示启用
//   ProxyServer (REG_SZ)：如 "http=127.0.0.1:7890;https=127.0.0.1:7890"
//                         或 "127.0.0.1:7890"（对所有协议生效）
const { execFile } = require('child_process');

const REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

function regQuery(valueName) {
  return new Promise((resolve) => {
    execFile('reg', ['query', REG_KEY, '/v', valueName], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(stdout);
    });
  });
}

// 解析 ProxyServer 字符串，返回 https 用的代理 URL（无则返回 null）
function parseProxyServer(s) {
  if (!s) return null;
  const text = s.trim();
  if (!text) return null;
  const parts = text.split(';').map((p) => p.trim()).filter(Boolean);
  let httpsProxy = null;
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq > 0 && p.slice(0, eq).trim().toLowerCase() === 'https') {
      httpsProxy = p.slice(eq + 1).trim();
      break;
    }
  }
  if (!httpsProxy) {
    const first = parts[0];
    const eq = first.indexOf('=');
    httpsProxy = eq > 0 ? first.slice(eq + 1).trim() : first;
  }
  if (!httpsProxy) return null;
  if (!/^https?:\/\//i.test(httpsProxy)) httpsProxy = `http://${httpsProxy}`;
  return httpsProxy;
}

// 返回系统代理 URL（如 "http://127.0.0.1:7890"），未启用/非 Windows 返回 null
async function getSystemProxy() {
  if (process.platform !== 'win32') return null;
  try {
    const enableOut = await regQuery('ProxyEnable');
    const m = enableOut && enableOut.match(/ProxyEnable\s+REG_DWORD\s+0x([0-9a-fA-F]+)/);
    if (!m || parseInt(m[1], 16) === 0) return null;
    const serverOut = await regQuery('ProxyServer');
    const m2 = serverOut && serverOut.match(/ProxyServer\s+REG_(?:SZ|EXPAND_SZ)\s+(.+)/);
    if (!m2) return null;
    return parseProxyServer(m2[1]);
  } catch {
    return null;
  }
}

// 把代理 URL 展开成环境变量键值对（供子进程使用）
function proxyEnv(proxyUrl) {
  if (!proxyUrl) return {};
  return {
    HTTPS_PROXY: proxyUrl,
    HTTP_PROXY: proxyUrl,
    https_proxy: proxyUrl,
    http_proxy: proxyUrl,
  };
}

module.exports = { getSystemProxy, parseProxyServer, proxyEnv };
