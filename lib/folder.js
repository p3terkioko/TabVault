// Mirror local snapshots to a user-chosen folder via the File System Access
// API. The directory handle lives in IndexedDB; chrome.storage.local keeps
// the display name and the fast in-browser snapshot index.

import { clearDirHandle, getDirHandle } from "./fs-handles.js";
import { getSettings } from "./config.js";

const FILE_PREFIX = "tabvault-";
const FILE_SUFFIX = ".json";

export function snapshotFilename(snapshot) {
  return `${FILE_PREFIX}${snapshot.createdAt.replace(/[:.]/g, "-")}.json`;
}

function isTabvaultFile(name) {
  return name.startsWith(FILE_PREFIX) && name.endsWith(FILE_SUFFIX);
}

async function verifyHandle(handle, requestIfNeeded) {
  if (!handle) return null;
  let perm = await handle.queryPermission({ mode: "readwrite" });
  if (perm === "granted") return handle;
  if (!requestIfNeeded) return null;
  perm = await handle.requestPermission({ mode: "readwrite" });
  return perm === "granted" ? handle : null;
}

export async function getBackupFolderHandle(requestIfNeeded = false) {
  return verifyHandle(await getDirHandle(), requestIfNeeded);
}

export async function clearBackupFolder() {
  await clearDirHandle();
}

export async function writeSnapshotToFolder(handle, snapshot) {
  const filename = snapshotFilename(snapshot);
  const fileHandle = await handle.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(JSON.stringify(snapshot, null, 2));
  await writable.close();
  return filename;
}

export async function listFolderSnapshots(handle) {
  const entries = [];
  for await (const [name, entry] of handle.entries()) {
    if (entry.kind !== "file" || !isTabvaultFile(name)) continue;
    try {
      const file = await entry.getFile();
      const snapshot = JSON.parse(await file.text());
      entries.push({
        id: name,
        source: "folder",
        filename: name,
        createdAt: snapshot.createdAt || new Date(file.lastModified).toISOString(),
        reason: snapshot.reason || "unknown",
        groupCount: snapshot.groupCount ?? 0,
        tabCount: snapshot.tabCount ?? 0
      });
    } catch {
      /* skip unreadable files */
    }
  }
  entries.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return entries;
}

export async function readFolderSnapshot(handle, filename) {
  const fileHandle = await handle.getFileHandle(filename);
  const file = await fileHandle.getFile();
  return JSON.parse(await file.text());
}

export async function pruneFolderSnapshots(handle, keep) {
  const entries = await listFolderSnapshots(handle);
  for (const entry of entries.slice(keep)) {
    try {
      await handle.removeEntry(entry.filename);
    } catch {
      /* file may already be gone */
    }
  }
}

export async function isFolderAccessible() {
  const handle = await getDirHandle();
  if (!handle) return false;
  return (await handle.queryPermission({ mode: "readwrite" })) === "granted";
}

export async function mirrorSnapshot(snapshot) {
  const handle = await getBackupFolderHandle(false);
  if (!handle) return { ok: false, reason: "no-folder" };

  const filename = await writeSnapshotToFolder(handle, snapshot);
  const { localKeep } = await getSettings();
  await pruneFolderSnapshots(handle, localKeep);
  return { ok: true, filename };
}
