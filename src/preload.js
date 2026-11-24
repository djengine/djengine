'use strict';

const { contextBridge, ipcRenderer } = require('electron');

async function call(name, ...args) {
  const r = await ipcRenderer.invoke(name, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

contextBridge.exposeInMainWorld('api', {
  state: () => call('state'),
  login: (username, password) => call('account:login', { username, password }),
  removeAccount: (id) => call('account:remove', id),
  media: (id) => call('account:media', id),
  saveRule: (rule) => call('rule:save', rule),
  removeRule: (id) => call('rule:remove', id),
  updateSettings: (patch) => call('settings:update', patch),
  checkNow: () => call('check:now'),
  clearLog: () => call('log:clear'),
  openExternal: (url) => call('open:external', url),
  onState: (fn) => {
    const h = (_e, s) => fn(s);
    ipcRenderer.on('state', h);
    return () => ipcRenderer.removeListener('state', h);
  },
});
