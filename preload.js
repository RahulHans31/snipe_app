const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('snipe', {
  getState: () => ipcRenderer.invoke('state:get'),
  saveState: (state) => ipcRenderer.invoke('state:save', state),
  captureCurrentAccount: () => ipcRenderer.invoke('account:capture-current'),
  parseAccountCookies: (raw) => ipcRenderer.invoke('account:parse-cookies', raw),
  sendLoginOtp: (phone) => ipcRenderer.invoke('login:send-otp', phone),
  verifyLoginOtp: (payload) => ipcRenderer.invoke('login:verify-otp', payload),
  cancelLogin: () => ipcRenderer.invoke('login:cancel'),
  importExtensionData: () => ipcRenderer.invoke('data:import-extension'),
  exportDesktopData: () => ipcRenderer.invoke('data:export-desktop'),
  openSession: () => ipcRenderer.invoke('session:open'),
  launch: (payload) => ipcRenderer.invoke('targets:launch', payload),
  stop: () => ipcRenderer.invoke('targets:close'),
  onEvent: (callback) => {
    const handler = (_, event) => callback(event);
    ipcRenderer.on('snipe:event', handler);
    return () => ipcRenderer.removeListener('snipe:event', handler);
  },
  onLanes: (callback) => {
    const handler = (_, lanes) => callback(lanes);
    ipcRenderer.on('snipe:lanes', handler);
    return () => ipcRenderer.removeListener('snipe:lanes', handler);
  },
  onUpiStatus: (callback) => {
    const handler = (_, payload) => callback(payload);
    ipcRenderer.on('snipe:upi-status', handler);
    return () => ipcRenderer.removeListener('snipe:upi-status', handler);
  },
  stopLane: (laneId) => ipcRenderer.invoke('lanes:stop', laneId),
  pushAddressToAll: (addressData) => ipcRenderer.invoke('address:push-all', addressData),
  batchSendOtp: (items) => ipcRenderer.invoke('login:batch-send', items),
  batchVerifyOtp: (verifications) => ipcRenderer.invoke('login:batch-verify', verifications),
  testTelegram: () => ipcRenderer.invoke('telegram:test'),
  onMenuAction: (callback) => {
    const handler = (_, action) => callback(action);
    ipcRenderer.on('snipe:menu', handler);
    return () => ipcRenderer.removeListener('snipe:menu', handler);
  },
  onOrders: (callback) => {
    const handler = (_, orders) => callback(orders);
    ipcRenderer.on('snipe:orders', handler);
    return () => ipcRenderer.removeListener('snipe:orders', handler);
  },
  onMetrics: (callback) => {
    const handler = (_, metrics) => callback(metrics);
    ipcRenderer.on('snipe:metrics', handler);
    return () => ipcRenderer.removeListener('snipe:metrics', handler);
  }
});
