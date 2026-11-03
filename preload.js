'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  briefGet: () => ipcRenderer.invoke('brief:get'),
  briefSave: (brief) => ipcRenderer.invoke('brief:save', brief),
  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsSave: (settings) => ipcRenderer.invoke('settings:save', settings),
  liveStart: () => ipcRenderer.invoke('live:start'),
  liveAudio: (pcmArrayBuffer) => ipcRenderer.send('live:audio', pcmArrayBuffer),
  liveStop: () => ipcRenderer.invoke('live:stop'),
  answer: (payload) => ipcRenderer.invoke('answer', payload),
  closeApp: () => ipcRenderer.send('app:quit'),
  closeSetup: () => ipcRenderer.send('setup:close'),
  onCmd: (fn) => ipcRenderer.on('cmd', (_event, cmd, arg) => fn(cmd, arg)),
});
