// Popup logic. Reads the local snapshot index straight from storage (cheap),
// talks to the service worker for anything that must outlive the popup
// (backups, restores), and only touches Google auth when the user explicitly
// interacts with the Drive section.

import { getSettings, isClientIdConfigured } from "../lib/config.js";
import { listLocalSnapshots } from "../lib/snapshots.js";
import {
  listDriveSnapshots,
  isConnected,
  disconnect,
  AuthRequiredError
} from "../lib/drive.js";

const $ = (id) => document.getElementById(id);

function send(msg) {
  return chrome.runtime.sendMessage(msg);
}

// ---------- status line ----------

let statusTimer;
function showStatus(text, isError = false, sticky = false) {
  const el = $("status");
  el.textContent = text;
  el.classList.toggle("error", isError);
  el.hidden = false;
  clearTimeout(statusTimer);
  if (!sticky) statusTimer = setTimeout(() => (el.hidden = true), 4000);
}

// ---------- rendering ----------

function relativeTime(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.round(diff / 60000);
  if (min < 1) return "Just now";
  if (min < 60) return `${min} min ago`;
  const hrs = Math.round(min / 60);
  if (hrs < 24) return `${hrs} hr${hrs > 1 ? "s" : ""} ago`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days} day${days > 1 ? "s" : ""} ago`;
  return new Date(iso).toLocaleDateString();
}

const REASON_LABELS = {
  auto: "",
  manual: "manual",
  "window-close": "window closed",
  install: "first run"
};

function snapshotRow({ time, groups, tabs, reason, onRestore }) {
  const li = document.createElement("li");

  const meta = document.createElement("div");
  meta.className = "snap-meta";

  const timeEl = document.createElement("span");
  timeEl.className = "snap-time";
  timeEl.textContent = relativeTime(time);
  timeEl.title = new Date(time).toLocaleString();
  meta.appendChild(timeEl);

  const reasonLabel = REASON_LABELS[reason] ?? "";
  if (reasonLabel) {
    const tag = document.createElement("span");
    tag.className = "snap-reason";
    tag.textContent = reasonLabel;
    meta.appendChild(tag);
  }

  const detail = document.createElement("div");
  detail.className = "snap-detail";
  detail.textContent = `${groups} group${groups === 1 ? "" : "s"} · ${tabs} tab${tabs === 1 ? "" : "s"}`;
  meta.appendChild(detail);

  const btn = document.createElement("button");
  btn.className = "btn";
  btn.textContent = "Restore";
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = "Restoring…";
    showStatus(`Restoring ${tabs} tabs…`, false, true);
    try {
      const res = await onRestore();
      if (res?.ok) {
        showStatus(
          `Restored ${res.created} tabs` +
            (res.skipped ? ` (${res.skipped} skipped — internal pages)` : ""));
      } else {
        showStatus(res?.error || "Restore failed", true);
      }
    } catch (e) {
      showStatus(e.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = "Restore";
    }
  });

  li.append(meta, btn);
  return li;
}

async function renderLocal() {
  const index = await listLocalSnapshots();
  const list = $("localList");
  list.replaceChildren();
  $("localEmpty").hidden = index.length > 0;

  for (const entry of index) {
    list.appendChild(
      snapshotRow({
        time: entry.createdAt,
        groups: entry.groupCount,
        tabs: entry.tabCount,
        reason: entry.reason,
        onRestore: () => send({ type: "restoreLocal", id: entry.id })
      })
    );
  }
}

async function renderDrive(files) {
  const list = $("driveList");
  list.replaceChildren();
  $("driveEmpty").hidden = files.length > 0;

  for (const file of files) {
    const props = file.appProperties || {};
    list.appendChild(
      snapshotRow({
        time: props.createdAt || file.createdTime,
        groups: Number(props.groupCount || 0),
        tabs: Number(props.tabCount || 0),
        reason: "auto",
        onRestore: () => send({ type: "restoreDrive", fileId: file.id })
      })
    );
  }
}

// Drive section states: no client id / not connected / connected.
// Sign-in UI only ever appears from an explicit click, never on popup open —
// if we're marked connected we try a *silent* token first, and fall back to
// the connect button if that fails.
async function initDriveSection() {
  const areas = ["driveNoClientId", "driveDisconnected", "driveConnectedArea"];
  const show = (id) => areas.forEach((a) => ($(a).hidden = a !== id));

  if (!isClientIdConfigured()) {
    show("driveNoClientId");
    return;
  }
  if (!(await isConnected())) {
    show("driveDisconnected");
    return;
  }
  show("driveConnectedArea");
  try {
    const files = await listDriveSnapshots(false);
    await renderDrive(files);
  } catch (e) {
    if (e instanceof AuthRequiredError) {
      show("driveDisconnected");
      showStatus("Google session expired — reconnect to see Drive backups", true);
    } else {
      showStatus("Couldn't reach Drive: " + e.message, true);
    }
  }
}

// ---------- wire up controls ----------

$("backupNow").addEventListener("click", async () => {
  const res = await send({ type: "backupNow" });
  if (res?.ok && res.saved) {
    showStatus(`Backed up ${res.entry.tabCount} tabs ✓`);
  } else if (res?.ok) {
    showStatus("Nothing changed since the last snapshot");
  } else {
    showStatus(res?.error || "Backup failed", true);
  }
  renderLocal();
});

$("connectDrive").addEventListener("click", async () => {
  const btn = $("connectDrive");
  btn.disabled = true;
  btn.textContent = "Waiting for Google…";
  try {
    // Runs in the service worker: the consent window closes this popup, and
    // the flow must survive that. If the popup dies before the response
    // arrives, the next open shows the connected state anyway.
    const res = await send({ type: "connectDrive" });
    if (res?.ok) {
      showStatus("Google Drive connected ✓");
      await initDriveSection();
    } else {
      showStatus("Sign-in failed: " + (res?.error || "cancelled"), true);
    }
  } catch {
    /* popup was closed by the consent window — expected */
  } finally {
    btn.disabled = false;
    btn.textContent = "Connect Google Drive";
  }
});

$("driveBackupNow").addEventListener("click", async () => {
  const btn = $("driveBackupNow");
  btn.disabled = true;
  showStatus("Uploading to Drive…", false, true);
  const res = await send({ type: "driveBackupNow" });
  btn.disabled = false;
  if (res?.ok && res.uploaded) {
    showStatus(`Backed up ${res.tabCount} tabs to Drive ✓`);
  } else if (res?.ok) {
    showStatus(res.reason === "empty" ? "No tabs to back up" : "Drive backup skipped");
  } else {
    showStatus(res?.error || "Drive backup failed", true);
  }
  initDriveSection();
});

$("disconnectDrive").addEventListener("click", async () => {
  await disconnect();
  showStatus("Disconnected from Google Drive");
  initDriveSection();
});

$("settingsToggle").addEventListener("click", () => {
  $("settingsPanel").hidden = !$("settingsPanel").hidden;
});

$("saveSettings").addEventListener("click", async () => {
  const settings = {
    localIntervalMin: Number($("localInterval").value),
    driveIntervalMin: Number($("driveInterval").value),
    driveAutoBackup: $("driveAuto").checked
  };
  await send({ type: "settingsChanged", settings });
  $("settingsPanel").hidden = true;
  $("emptyInterval").textContent = settings.localIntervalMin;
  showStatus("Settings saved ✓");
});

// ---------- init ----------

(async function init() {
  const settings = await getSettings();
  $("localInterval").value = String(settings.localIntervalMin);
  $("driveInterval").value = String(settings.driveIntervalMin);
  $("driveAuto").checked = settings.driveAutoBackup;
  $("emptyInterval").textContent = settings.localIntervalMin;

  await renderLocal();
  await initDriveSection();
})();
