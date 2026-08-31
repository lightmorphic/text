'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// The renderer gets exactly these calls and nothing else: no filesystem, no
// child processes, no Node at all.
contextBridge.exposeInMainWorld('lightmorphicText', {
  appInfo: () => ipcRenderer.invoke('app-info'),

  describeEnvironment: () => ipcRenderer.invoke('env-describe'),
  installEspanso: () => ipcRenderer.invoke('espanso-install'),
  addToInputGroup: () => ipcRenderer.invoke('espanso-input-group'),
  service: (action) => ipcRenderer.invoke('espanso-service', action),
  diagnoseService: () => ipcRenderer.invoke('espanso-service-diagnose'),
  retryService: () => ipcRenderer.invoke('espanso-service-retry'),
  ensureConfig: () => ipcRenderer.invoke('config-ensure'),

  readMatches: () => ipcRenderer.invoke('matches-read'),
  createMatch: (relPath, fields) => ipcRenderer.invoke('match-create', relPath, fields),
  updateMatch: (id, fields) => ipcRenderer.invoke('match-update', id, fields),
  deleteMatch: (id) => ipcRenderer.invoke('match-delete', id),
  createFile: (name) => ipcRenderer.invoke('file-create', name),

  exportSnippets: () => ipcRenderer.invoke('snippets-export'),
  importSnippets: () => ipcRenderer.invoke('snippets-import'),
  openConfigDir: () => ipcRenderer.invoke('open-config-dir'),
  copyText: (text) => ipcRenderer.invoke('copy-text', text),

  updateCheck: () => ipcRenderer.invoke('update-check'),
  updateDownload: () => ipcRenderer.invoke('update-download'),
  updateInstall: () => ipcRenderer.invoke('update-install'),

  onInstallProgress: (callback) => ipcRenderer.on('install-progress', (event, state) => callback(state)),
  onMatchesChanged: (callback) => ipcRenderer.on('matches-changed', () => callback()),
  onUpdateState: (callback) => ipcRenderer.on('update-state', (event, state) => callback(state)),
});
