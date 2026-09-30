const { contextBridge, ipcRenderer } = require("electron");

const agentApi = {
  getLaunchState: () => ipcRenderer.invoke("get-launch-state"),
  exportIrisInspection: () => ipcRenderer.invoke("export-iris-inspection"),
  openPortalLogin: () => ipcRenderer.invoke("open-portal-login"),
  captureAndUpload: (input) => ipcRenderer.invoke("capture-and-upload", input),
  setAccountReference: (value) =>
    ipcRenderer.invoke("set-account-reference", value),
  openExternal: (value) => ipcRenderer.invoke("open-external", value),
  getLocalBridgeUrl: () => ipcRenderer.invoke("get-local-bridge-url"),
  onLaunchState: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("launch-state", handler);
    return () => ipcRenderer.removeListener("launch-state", handler);
  },
  onStatusUpdate: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("status-update", handler);
    return () => ipcRenderer.removeListener("status-update", handler);
  },
};

contextBridge.exposeInMainWorld("taxRocketAgent", agentApi);
