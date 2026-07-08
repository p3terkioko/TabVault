// Popup logic. Reads the local snapshot index straight from storage (cheap),
// talks to the service worker for anything that must outlive the popup
// (backups, restores), and only touches Google auth when the user explicitly
// interacts with the Drive section.

import {
  getSettings,
  isClientIdConfigured,
  getOAuthClientId,
  saveOAuthClientId
} from "../lib/config.js";
import { listLocalSnapshots } from "../lib/snapshots.js";
import {
  getBackupFolderHandle,
  clearBackupFolder,
  listFolderSnapshots,
  isFolderAccessible
} from "../lib/folder.js";
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
  install: "first run",
  folder: "from folder"
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
  btn.className = "btn btn-text";
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

async function mergedLocalSnapshots() {
  const index = await listLocalSnapshots();
  const merged = index.map((entry) => ({ ...entry, source: "storage" }));
  const seenAt = new Set(merged.map((e) => e.createdAt));

  if (await isFolderAccessible()) {
    const handle = await getBackupFolderHandle(false);
    if (handle) {
      for (const entry of await listFolderSnapshots(handle)) {
        if (!seenAt.has(entry.createdAt)) {
          merged.push(entry);
          seenAt.add(entry.createdAt);
        }
      }
    }
  }

  merged.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return merged;
}

// Long snapshot histories (up to localKeep/driveKeep entries, plus any
// folder-mirrored ones for local) would otherwise flood the popup. Only the
// most recent VISIBLE_COUNT render by default; the rest sit behind a
// "Show N more" toggle so the window stays scannable at a glance.
const VISIBLE_COUNT = 5;
const listExpanded = { local: false, drive: false };

function renderCollapsibleList(listEl, toggleBtn, key, rows) {
  listEl.replaceChildren();
  const expanded = listExpanded[key];
  const visible = expanded ? rows : rows.slice(0, VISIBLE_COUNT);
  for (const row of visible) listEl.appendChild(row);

  const hiddenCount = rows.length - VISIBLE_COUNT;
  if (hiddenCount <= 0) {
    toggleBtn.hidden = true;
    return;
  }
  toggleBtn.hidden = false;
  toggleBtn.textContent = expanded ? "Show less" : `Show ${hiddenCount} more`;
  toggleBtn.onclick = () => {
    listExpanded[key] = !listExpanded[key];
    renderCollapsibleList(listEl, toggleBtn, key, rows);
  };
}

async function renderLocal() {
  const index = await mergedLocalSnapshots();
  $("localEmpty").hidden = index.length > 0;

  const rows = index.map((entry) =>
    snapshotRow({
      time: entry.createdAt,
      groups: entry.groupCount,
      tabs: entry.tabCount,
      reason: entry.reason,
      onRestore: () =>
        entry.source === "folder"
          ? send({ type: "restoreFolder", filename: entry.filename })
          : send({ type: "restoreLocal", id: entry.id })
    })
  );
  renderCollapsibleList($("localList"), $("localShowMore"), "local", rows);
}

async function updateFolderUI() {
  const { backupFolderName } = await chrome.storage.local.get("backupFolderName");
  const accessible = await isFolderAccessible();
  const nameEl = $("folderName");
  const clearBtn = $("clearFolder");

  if (backupFolderName && accessible) {
    nameEl.textContent = backupFolderName;
    clearBtn.hidden = false;
  } else if (backupFolderName && !accessible) {
    nameEl.textContent = `${backupFolderName} (permission needed — choose again)`;
    clearBtn.hidden = false;
  } else {
    nameEl.textContent = "Not set";
    clearBtn.hidden = true;
  }
}

async function renderDrive(files) {
  $("driveEmpty").hidden = files.length > 0;

  const rows = files.map((file) => {
    const props = file.appProperties || {};
    return snapshotRow({
      time: props.createdAt || file.createdTime,
      groups: Number(props.groupCount || 0),
      tabs: Number(props.tabCount || 0),
      reason: "auto",
      onRestore: () => send({ type: "restoreDrive", fileId: file.id })
    });
  });
  renderCollapsibleList($("driveList"), $("driveShowMore"), "drive", rows);
}

// Drive section states: no client id / not connected / connected.
// Sign-in UI only ever appears from an explicit click, never on popup open —
// if we're marked connected we try a *silent* token first, and fall back to
// the connect button if that fails.
const DRIVE_AREAS = ["driveNoClientId", "driveDisconnected", "driveConnectedArea"];
const showDriveArea = (id) => DRIVE_AREAS.forEach((a) => ($(a).hidden = a !== id));

async function initDriveSection() {
  if (!(await isClientIdConfigured())) {
    showDriveArea("driveNoClientId");
    return;
  }
  if (!(await isConnected())) {
    showDriveArea("driveDisconnected");
    return;
  }
  showDriveArea("driveConnectedArea");
  try {
    const files = await listDriveSnapshots(false);
    await renderDrive(files);
  } catch (e) {
    if (e instanceof AuthRequiredError) {
      showDriveArea("driveDisconnected");
      showStatus("Google session expired — reconnect to see Drive backups", true);
    } else {
      showStatus("Couldn't reach Drive: " + e.message, true);
    }
  }
}

// "Change client ID…" reuses the same form regardless of connection state —
// editing it while connected just means the next sign-in will use the new
// value (existing tokens/session are untouched until then).
async function showClientIdForm() {
  showDriveArea("driveNoClientId");
  $("clientIdInput").value = await getOAuthClientId();
  $("clientIdInput").focus();
}
$("changeClientId1").addEventListener("click", showClientIdForm);
$("changeClientId2").addEventListener("click", showClientIdForm);

$("saveClientId").addEventListener("click", async () => {
  const value = $("clientIdInput").value.trim();
  if (!value) {
    showStatus("Enter a client ID first", true);
    return;
  }
  await saveOAuthClientId(value);
  showStatus("Client ID saved ✓");
  await initDriveSection();
});

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

// ---------- theme toggle ----------
// Dark is the CSS default; light applies either because the system prefers
// it (until the user overrides) or because data-theme is set explicitly,
// which always wins. The toggle only ever writes an explicit override.
const THEME_KEY = "uiTheme";
const themeToggle = $("themeToggle");
const systemPrefersLight = () =>
  window.matchMedia("(prefers-color-scheme: light)").matches;

function applyTheme(theme) {
  if (theme) document.documentElement.setAttribute("data-theme", theme);
  else document.documentElement.removeAttribute("data-theme");
  const isLight = theme ? theme === "light" : systemPrefersLight();
  themeToggle.setAttribute("aria-pressed", String(isLight));
}

themeToggle.addEventListener("click", async () => {
  const current = document.documentElement.getAttribute("data-theme");
  const currentlyLight = current ? current === "light" : systemPrefersLight();
  const next = currentlyLight ? "dark" : "light";
  applyTheme(next);
  await chrome.storage.local.set({ [THEME_KEY]: next });
});

// "Automatic Drive backups" is an M3 switch (role="switch" button), not a
// checkbox — state lives in aria-checked.
const driveAutoSwitch = $("driveAuto");
driveAutoSwitch.addEventListener("click", () => {
  const on = driveAutoSwitch.getAttribute("aria-checked") === "true";
  driveAutoSwitch.setAttribute("aria-checked", String(!on));
});
const isDriveAutoOn = () =>
  driveAutoSwitch.getAttribute("aria-checked") === "true";

// Presets cover the common cases; "Custom…" reveals a plain minutes input so
// any interval is reachable, not just the hardcoded dropdown values.
function wireIntervalControl(selectId, customId) {
  const select = $(selectId);
  const custom = $(customId);
  select.addEventListener("change", () => {
    custom.hidden = select.value !== "custom";
    if (select.value === "custom") custom.focus();
  });
}
wireIntervalControl("localInterval", "localIntervalCustom");
wireIntervalControl("driveInterval", "driveIntervalCustom");

// Selects the matching preset, or falls back to "Custom…" with the actual
// value filled in if it doesn't match any preset option.
function applyIntervalToControl(selectId, customId, minutes) {
  const select = $(selectId);
  const custom = $(customId);
  const hasPreset = [...select.options].some(
    (o) => o.value !== "custom" && Number(o.value) === minutes
  );
  if (hasPreset) {
    select.value = String(minutes);
    custom.hidden = true;
  } else {
    select.value = "custom";
    custom.value = String(minutes);
    custom.hidden = false;
  }
}

function readIntervalFromControl(selectId, customId, fallback) {
  const select = $(selectId);
  if (select.value !== "custom") return Number(select.value);
  const value = Math.round(Number($(customId).value));
  return Number.isFinite(value) && value >= 1 ? value : fallback;
}

$("saveSettings").addEventListener("click", async () => {
  const current = await getSettings();
  const settings = {
    localIntervalMin: readIntervalFromControl(
      "localInterval", "localIntervalCustom", current.localIntervalMin
    ),
    driveIntervalMin: readIntervalFromControl(
      "driveInterval", "driveIntervalCustom", current.driveIntervalMin
    ),
    driveAutoBackup: isDriveAutoOn()
  };
  await send({ type: "settingsChanged", settings });
  $("emptyInterval").textContent = settings.localIntervalMin;
  showStatus("Settings saved ✓");
});

$("pickFolder").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("picker/picker.html") });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.backupFolderName) return;
  updateFolderUI();
  renderLocal();
  if (changes.backupFolderName.newValue) {
    showStatus(`Backup folder set: ${changes.backupFolderName.newValue} ✓`);
  }
});

$("clearFolder").addEventListener("click", async () => {
  await clearBackupFolder();
  await chrome.storage.local.remove("backupFolderName");
  await updateFolderUI();
  await renderLocal();
  showStatus("Backup folder cleared");
});

// ---------- init ----------

(async function init() {
  const { uiTheme } = await chrome.storage.local.get(THEME_KEY);
  applyTheme(uiTheme || null);

  const settings = await getSettings();
  applyIntervalToControl("localInterval", "localIntervalCustom", settings.localIntervalMin);
  applyIntervalToControl("driveInterval", "driveIntervalCustom", settings.driveIntervalMin);
  driveAutoSwitch.setAttribute("aria-checked", String(settings.driveAutoBackup));
  $("emptyInterval").textContent = settings.localIntervalMin;

  await renderLocal();
  await updateFolderUI();
  await initDriveSection();
})();
