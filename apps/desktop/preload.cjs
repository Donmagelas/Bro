const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("bro", {
  request: (path, method, body) =>
    ipcRenderer.invoke("bro:request", path, method, body),
  stopHost: () => ipcRenderer.invoke("bro:stopHost"),
  loginItem: (enabled) => ipcRenderer.invoke("bro:loginItem", enabled),
  directory: () => ipcRenderer.invoke("bro:directory"),
  attachments: () => ipcRenderer.invoke("bro:attachments"),
  open: (target) => ipcRenderer.invoke("bro:open", target),
  desktopPermissions: (action = "check") =>
    ipcRenderer.invoke("bro:desktopPermissions", action),
  onEvent: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("bro:event", handler);
    return () => ipcRenderer.removeListener("bro:event", handler);
  },
});
