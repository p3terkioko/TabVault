// TabVault service worker (Manifest V3).
//
// MV3 discipline observed throughout: every listener is registered at the
// top level (async registration is not guaranteed to fire), all state lives
// in chrome.storage (the worker is killed after ~30s idle), and scheduling
// uses chrome.alarms (setInterval dies with the worker).

import {
  ALARM_LOCAL,
  ALARM_DRIVE,
  getSettings,
  saveSettings
} from "./lib/config.js";
import { captureState, stateHash } from "./lib/capture.js";
import { saveLocalSnapshot, getLocalSnapshot } from "./lib/snapshots.js";
import { restoreSnapshot } from "./lib/restore.js";
import {
  uploadSnapshot,
  downloadSnapshot,
  pruneDriveSnapshots,
  isConnected,
  getToken,
  AuthRequiredError
} from "./lib/drive.js";

// ---------- alarm scheduling ----------

async function ensureAlarms() {
  const settings = await getSettings();

  const local = await chrome.alarms.get(ALARM_LOCAL);
  if (!local || local.periodInMinutes !== settings.localIntervalMin) {
    await chrome.alarms.create(ALARM_LOCAL, {
      periodInMinutes: settings.localIntervalMin
    });
  }

  const drive = await chrome.alarms.get(ALARM_DRIVE);
  if (settings.driveAutoBackup) {
    if (!drive || drive.periodInMinutes !== settings.driveIntervalMin) {
      await chrome.alarms.create(ALARM_DRIVE, {
        periodInMinutes: settings.driveIntervalMin
      });
    }
  } else if (drive) {
    await chrome.alarms.clear(ALARM_DRIVE);
  }
}

// ---------- backup actions ----------

async function isRestoring() {
  const { restoring } = await chrome.storage.session.get("restoring");
  return !!restoring;
}

async function runLocalBackup(reason) {
  if (await isRestoring()) return { saved: false };
  const snapshot = await captureState(reason);
  return saveLocalSnapshot(snapshot);
}

// interactive=false is used by the alarm path: back up only if a token can
// be obtained silently; never pop a sign-in window from the background.
async function runDriveBackup(reason, interactive) {
  if (await isRestoring()) return { uploaded: false, reason: "restoring" };
  const snapshot = await captureState(reason);
  if (snapshot.tabCount === 0) return { uploaded: false, reason: "empty" };

  // Skip the upload when nothing changed since the last one.
  const hash = stateHash(snapshot);
  const { lastDriveHash } = await chrome.storage.local.get("lastDriveHash");
  if (!interactive && lastDriveHash === hash) {
    return { uploaded: false, reason: "unchanged" };
  }

  await uploadSnapshot(snapshot, interactive);
  await chrome.storage.local.set({ lastDriveHash: hash });

  const { driveKeep } = await getSettings();
  await pruneDriveSnapshots(driveKeep, interactive);
  return { uploaded: true, tabCount: snapshot.tabCount };
}

// ---------- event wiring (all top-level) ----------

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarms();
  runLocalBackup("install");
});

chrome.runtime.onStartup.addListener(() => {
  // Alarms usually persist across restarts, but the docs recommend
  // re-asserting critical alarms on startup — cheap insurance.
  ensureAlarms();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_LOCAL) {
    await runLocalBackup("auto");
  } else if (alarm.name === ALARM_DRIVE) {
    if (!(await isConnected())) return;
    try {
      await runDriveBackup("auto", false);
    } catch (e) {
      // AuthRequiredError just means the silent token grab failed (signed
      // out, consent revoked). The popup will offer to reconnect.
      if (!(e instanceof AuthRequiredError)) {
        console.warn("TabVault: scheduled Drive backup failed:", e.message);
      }
    }
  }
});

// A closing window is a meaningful moment: snapshot what remains so the
// most recent state before a full exit is preserved. When the LAST window
// closes there are no tabs left to capture (and the worker is about to
// die), so the periodic snapshot taken minutes earlier is the safety net.
chrome.windows.onRemoved.addListener(async () => {
  await runLocalBackup("window-close");
});

// ---------- popup RPC ----------

const handlers = {
  // Interactive sign-in must run here, not in the popup: the Google consent
  // window steals focus, which closes the popup and would kill the flow.
  async connectDrive() {
    await getToken(true);
    return { ok: true };
  },

  async backupNow() {
    const result = await runLocalBackup("manual");
    return { ok: true, ...result };
  },

  async driveBackupNow() {
    const result = await runDriveBackup("manual", true);
    return { ok: true, ...result };
  },

  async restoreLocal({ id }) {
    const snapshot = await getLocalSnapshot(id);
    if (!snapshot) return { ok: false, error: "Snapshot not found" };
    const result = await restoreSnapshot(snapshot);
    return { ok: true, ...result };
  },

  async restoreDrive({ fileId }) {
    const snapshot = await downloadSnapshot(fileId, true);
    const result = await restoreSnapshot(snapshot);
    return { ok: true, ...result };
  },

  async settingsChanged({ settings }) {
    await saveSettings(settings);
    await ensureAlarms();
    return { ok: true };
  }
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler) return false;
  handler(msg)
    .then(sendResponse)
    .catch((e) =>
      sendResponse({
        ok: false,
        error: e.message,
        needsAuth: e instanceof AuthRequiredError
      })
    );
  return true; // keep the message channel open for the async response
});
