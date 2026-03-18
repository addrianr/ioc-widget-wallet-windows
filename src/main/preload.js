const { contextBridge, ipcRenderer } = require('electron');

function replaceListener(channel, handler) {
  ipcRenderer.removeAllListeners(channel);
  ipcRenderer.on(channel, handler);
}

contextBridge.exposeInMainWorld('ioc', {
  rpc: (method, params = []) => ipcRenderer.invoke('ioc:rpc', { method, params }),
  tryRpc: (method, params = []) => ipcRenderer.invoke('ioc:tryRpc', { method, params }),
  status: () => ipcRenderer.invoke('ioc/status'),
  logHeight: () => ipcRenderer.invoke('ioc/logheight'),
  listAddrs: () => ipcRenderer.invoke('ioc/listaddrs'),
  listTx: (n = 50) => ipcRenderer.invoke('ioc/listtx', n),
  newAddr: (label = '') => ipcRenderer.invoke('ioc/newaddr', label),
  setLabel: (address, label) => ipcRenderer.invoke('ioc/setlabel', address, label),

  getDataDir: () => ipcRenderer.invoke('ioc:getDataDir'),
  isFirstRun: () => ipcRenderer.invoke('ioc:isFirstRun'),
  daemonStatus: () => ipcRenderer.invoke('ioc:daemonStatus'),

  openExternal: (url) => ipcRenderer.invoke('ioc:openExternal', url),

  needsBootstrap: () => ipcRenderer.invoke('ioc:needsBootstrap'),
  getDailyBootstrapMetadata: () => ipcRenderer.invoke('ioc:getDailyBootstrapMetadata'),
  createRebootstrapBackup: (context = {}) => ipcRenderer.invoke('ioc:createRebootstrapBackup', context),
  downloadBootstrap: () => ipcRenderer.invoke('ioc:downloadBootstrap'),
  applyBootstrap: (options = {}) => ipcRenderer.invoke('ioc:applyBootstrap', options),
  bootstrapCleanup: () => ipcRenderer.invoke('ioc:bootstrapCleanup'),

  walletBackup: () => ipcRenderer.invoke('ioc:wallet:backup'),
  walletPath: () => ipcRenderer.invoke('ioc:wallet:getPath'),

  quitApp: (stopDaemon = true) => ipcRenderer.invoke('ioc:quitApp', stopDaemon),
  hideWindow: () => ipcRenderer.invoke('ioc:hideWindow'),
  restartDaemon: () => ipcRenderer.invoke('ioc:restartDaemon'),

  setCompactMode: (isCompact) => ipcRenderer.invoke('ioc:setCompactMode', isCompact),
  setSplashDebugExpanded: (expanded) => ipcRenderer.invoke('ioc:setSplashDebugExpanded', expanded),
  setHelpCenterWindow: (open, context = {}) => ipcRenderer.invoke('ioc:setHelpCenterWindow', { open, context }),

  getVersion: () => ipcRenderer.invoke('ioc:getVersion'),

  onBootstrapProgress: (cb) => {
    replaceListener('bootstrap:progress', (_event, progress) => cb(progress));
  },
  onSystemResume: (cb) => {
    replaceListener('ioc:system-resume', (_event, payload) => cb(payload));
  },
  onCompactModeChanged: (cb) => {
    replaceListener('compact-mode-changed', (_event, isCompact) => cb(isCompact));
  },
  onOpenHelpCenter: (cb) => {
    replaceListener('ioc:open-help-center', () => cb());
  }
});

contextBridge.exposeInMainWorld('sys', {
  openFolder: () => ipcRenderer.send('sys:openFolder')
});

contextBridge.exposeInMainWorld('diag', {
  startTail: () => ipcRenderer.send('diag:start'),
  stopTail: () => ipcRenderer.send('diag:stop'),
  recentTail: (n = 80) => ipcRenderer.invoke('diag:recent', n),
  onData: (cb) => {
    const handler = (_event, line) => cb(line);
    ipcRenderer.on('diag:data', handler);
    return () => ipcRenderer.removeListener('diag:data', handler);
  }
});
