// Extension popups don't expose showDirectoryPicker — this full extension
// page does. Opened from the popup when the user chooses a backup folder.

import { getDirHandle, saveDirHandle } from "../lib/fs-handles.js";
import { migrateLocalSnapshotsToFolder } from "../lib/migrate-folder.js";

const $ = (id) => document.getElementById(id);

function showError(text) {
  const el = $("error");
  el.textContent = text;
  el.hidden = false;
  $("pickBtn").disabled = true;
}

async function finishWithHandle(handle, migrated) {
  await saveDirHandle(handle);
  await chrome.storage.local.set({ backupFolderName: handle.name });
  if (migrated) await migrateLocalSnapshotsToFolder(handle);

  $("status").hidden = false;
  $("status").textContent = migrated
    ? `Saved to ${handle.name}. Existing snapshots copied. Closing…`
    : `Access restored for ${handle.name}. Closing…`;

  setTimeout(() => window.close(), 900);
}

$("cancelBtn").addEventListener("click", () => window.close());

$("pickBtn").addEventListener("click", async () => {
  const btn = $("pickBtn");
  btn.disabled = true;
  $("error").hidden = true;

  try {
    const existing = await getDirHandle();
    if (existing) {
      const perm = await existing.requestPermission({ mode: "readwrite" });
      if (perm === "granted") {
        await finishWithHandle(existing, false);
        return;
      }
    }

    const handle = await window.showDirectoryPicker({ mode: "readwrite" });
    await finishWithHandle(handle, true);
  } catch (e) {
    btn.disabled = false;
    if (e.name === "AbortError") return;
    showError(e.message || "Couldn't access the folder");
  }
});

if (typeof window.showDirectoryPicker !== "function") {
  showError(
    "This browser doesn't expose folder access to extensions. " +
      "The folder mirror needs Chrome, Brave, or Edge with File System Access enabled."
  );
} else {
  $("pickBtn").focus();
}
