// 预加载脚本：向控制面板暴露安全的 IPC 接口
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  getState: () => ipcRenderer.invoke('get-state'),
  rescan: () => ipcRenderer.invoke('rescan'),
  setProxyUse: (use) => ipcRenderer.invoke('set-proxy-use', use),
  doImport: () => ipcRenderer.invoke('import'),
  onState: (cb) => ipcRenderer.on('state', (_event, s) => cb(s)),
});
