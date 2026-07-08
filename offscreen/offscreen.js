// Offscreen document: the service worker cannot use the File System Access
// API, so folder writes from alarms/window-close run here instead.

import {
  getBackupFolderHandle,
  mirrorSnapshot,
  readFolderSnapshot
} from "../lib/folder.js";

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== "offscreen") return false;

  (async () => {
    switch (msg.type) {
      case "writeSnapshot":
        return mirrorSnapshot(msg.snapshot);
      case "readSnapshot": {
        const handle = await getBackupFolderHandle(false);
        if (!handle) return { ok: false, error: "No backup folder" };
        const snapshot = await readFolderSnapshot(handle, msg.filename);
        return { ok: true, snapshot };
      }
      default:
        return { ok: false, error: "Unknown offscreen action" };
    }
  })()
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: e.message }));

  return true;
});
