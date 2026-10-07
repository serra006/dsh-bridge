// DSH Bridge - Electron 主进程：托盘应用
//
// 启动流程：准备 OpenCode → 启动隔离的 opencode serve → 启动 OpenAI 兼容代理
// → 扫描免费模型。控制面板展示模型列表，一键导入 DeepSeek Harness 配置。
// 退出时默认清理本应用导入的模型条目，用户手动配置不受影响。
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const paths = require('./core/paths');
const store = require('./core/store');
const oc = require('./core/opencode');
const discovery = require('./core/discovery');
const { createProxy } = require('./core/proxy');
const importer = require('./core/importer');

const SERVE_PORT = 4188;
const PROXY_PORT = 5180;

let tray = null;
let win = null;
let serveCtl = null;
let proxyCtl = null;
let quitting = false;

const state = {
  stage: 'starting', // starting | ready | error
  message: '正在启动…',
  models: [], // [{ providerID, modelID, name, latencyMs }]
  proxyUrl: null,
  imported: false,
  settingsPath: paths.dshSettingsPath(),
};

function publicState() {
  return { ...state, cleanupOnQuit: store.load().cleanupOnQuit !== false };
}

function sendState() {
  if (win && !win.isDestroyed()) win.webContents.send('state', publicState());
  buildTrayMenu();
}

function setStatus(stage, message) {
  state.stage = stage;
  state.message = message;
  sendState();
}

async function rescan(announce = true) {
  if (!serveCtl) return;
  if (announce) setStatus('starting', '正在重新扫描免费模型…');
  const baseUrl = `http://${oc.SERVE_HOST}:${SERVE_PORT}`;
  const found = await discovery.discover(baseUrl, {
    onProgress: (m) => { if (announce) setStatus('starting', m); },
  });
  state.models = found;
  state.stage = 'ready';
  state.message = found.length
    ? `就绪：在 ${state.proxyUrl} 提供 ${found.length} 个免费模型`
    : '就绪，但没有发现可用免费模型（可稍后重新扫描）';
  sendState();
}

async function doImport() {
  if (!state.models.length) throw new Error('没有可用模型，请先扫描');
  const r = await importer.importModels(state.settingsPath, state.proxyUrl, state.models);
  state.imported = true;
  setStatus('ready', `已导入 ${r.added} 个模型到 DeepSeek Harness${r.backup ? '（原配置已备份）' : ''}`);
  return r;
}

async function startup() {
  try {
    setStatus('starting', '正在准备 OpenCode…');
    const { bin, source } = await oc.ensureBinary((m) => setStatus('starting', m));
    setStatus('starting', `正在启动隔离的 OpenCode 服务…（来源：${source}）`);
    serveCtl = await oc.startServe(bin, SERVE_PORT);
    setStatus('starting', '正在启动本地代理…');
    proxyCtl = createProxy({
      getBaseUrl: () => `http://${oc.SERVE_HOST}:${SERVE_PORT}`,
      getModels: () => state.models,
      port: PROXY_PORT,
    });
    state.proxyUrl = await proxyCtl.listen();
    state.imported = importer.isImported(state.settingsPath);
    await rescan(false);
  } catch (e) {
    setStatus('error', `启动失败：${e.message}`);
  }
}

function iconPath() {
  const candidates = [
    path.join(__dirname, '..', 'build', 'icon.png'),
    path.join(process.resourcesPath, 'build', 'icon.png'),
  ];
  return candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
}

function buildTrayMenu() {
  if (!tray) return;
  const ready = state.stage === 'ready';
  const cleanup = store.load().cleanupOnQuit !== false;
  const menu = Menu.buildFromTemplate([
    { label: '打开控制面板', click: () => { if (win) { win.show(); win.focus(); } } },
    { label: '重新扫描模型', enabled: ready && !!serveCtl, click: () => rescan() },
    {
      label: state.imported ? '已导入 DeepSeek Harness（点击重新导入）' : '一键导入到 DeepSeek Harness',
      enabled: ready,
      click: async () => { try { await doImport(); } catch (e) { setStatus('error', `导入失败：${e.message}`); } },
    },
    { type: 'separator' },
    {
      label: `退出时清理导入的配置：${cleanup ? '开' : '关'}`,
      click: () => { store.save({ cleanupOnQuit: !cleanup }); sendState(); },
    },
    { label: '退出', click: () => quitApp() },
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip(`DSH Bridge - ${state.message}`);
}

function createWindow() {
  win = new BrowserWindow({
    width: 760,
    height: 600,
    title: 'DSH Bridge',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide(); // 关闭窗口只隐藏到托盘
    }
  });
}

async function quitApp() {
  if (quitting) return;
  quitting = true;
  try {
    if (store.load().cleanupOnQuit !== false) importer.removeImported(state.settingsPath);
  } catch { /* 清理失败不阻塞退出 */ }
  try { proxyCtl && await proxyCtl.close(); } catch { /* 忽略 */ }
  try { serveCtl && serveCtl.stop(); } catch { /* 忽略 */ }
  app.quit();
}

app.whenReady().then(() => {
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  const ip = iconPath();
  tray = new Tray(ip ? nativeImage.createFromPath(ip) : nativeImage.createEmpty());
  tray.setToolTip('DSH Bridge');
  tray.on('click', () => { if (win) { win.show(); win.focus(); } });
  buildTrayMenu();
  createWindow();

  ipcMain.handle('get-state', () => publicState());
  ipcMain.handle('rescan', async () => { await rescan(); return publicState(); });
  ipcMain.handle('import', async () => {
    const result = await doImport();
    return { ...publicState(), result };
  });

  startup();
});

app.on('window-all-closed', () => { /* 关闭窗口后托盘常驻，不退出 */ });

app.on('before-quit', (e) => {
  if (quitting) return;
  e.preventDefault();
  quitApp();
});
