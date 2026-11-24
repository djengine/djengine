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
  aiStatus: () => call('ai:status'),
  aiPull: () => call('ai:pull'),
  aiChat: (accountId, messages) => call('ai:chat', { accountId, messages }),
  aiAutopilot: (accountId, enabled, instructions) => call('ai:autopilot', { accountId, enabled, instructions }),
  exportContacts: () => call('contacts:export'),
  savePersona: (accountId, persona) => call('persona:save', { accountId, persona }),
  learnFromDms: (accountId) => call('persona:learn', { accountId }),
  aiTry: (accountId, text) => call('ai:try', { accountId, text }),
  onAiProgress: (fn) => {
    const h = (_e, p) => fn(p);
    ipcRenderer.on('ai-progress', h);
    return () => ipcRenderer.removeListener('ai-progress', h);
  },
  onState: (fn) => {
    const h = (_e, s) => fn(s);
    ipcRenderer.on('state', h);
    return () => ipcRenderer.removeListener('state', h);
  },
});
