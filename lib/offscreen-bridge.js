// Ensures the offscreen document exists for folder I/O from the service worker.

const OFFSCREEN_URL = "offscreen/offscreen.html";
const OFFSCREEN_DOC = chrome.runtime.getURL(OFFSCREEN_URL);

let offscreenReady = false;

async function hasOffscreenDocument() {
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [OFFSCREEN_DOC]
    });
    return contexts.length > 0;
  }
  return offscreenReady;
}

export async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["BLOB_PARSER"],
    justification: "Write tab snapshots to the user-chosen backup folder"
  });
  offscreenReady = true;
}

export async function sendToOffscreen(msg) {
  await ensureOffscreenDocument();
  return chrome.runtime.sendMessage({ target: "offscreen", ...msg });
}

export async function mirrorToFolder(snapshot) {
  const { backupFolderName } = await chrome.storage.local.get("backupFolderName");
  if (!backupFolderName) return;

  try {
    await sendToOffscreen({ type: "writeSnapshot", snapshot });
  } catch (e) {
    console.warn("TabVault: folder mirror failed:", e.message);
  }
}

export async function readSnapshotFromFolder(filename) {
  return sendToOffscreen({ type: "readSnapshot", filename });
}
