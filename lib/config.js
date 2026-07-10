// TabVault configuration.
//
// The OAuth client ID is entered by the user in the popup's Drive section
// (not hardcoded here), so "Load unpacked" users never have to edit source.
// It's stored in chrome.storage.sync so that a user with browser profile
// sync enabled only has to enter it once — it then propagates to their other
// devices automatically, where connecting the same Google account surfaces
// the same Drive backups. (Client IDs for public OAuth apps aren't secret,
// and it's a few dozen bytes, well under sync's 8 KB per-item limit.)
//
// It must be a "Web application" OAuth client in Google Cloud Console (NOT a
// "Chrome extension" client — those only work with chrome.identity.
// getAuthToken, which Brave and Edge don't support). Its authorized redirect
// URI must be:
//
//   https://pblgmlmoikfndpgpgndmjhldbodlojeo.chromiumapp.org/
//
// (That hostname is this extension's ID, which is pinned by the "key" field
// in manifest.json, so it is identical on every machine and browser.)
// See README.md for the full step-by-step setup.

export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.appdata";

export const DEFAULT_SETTINGS = {
  localIntervalMin: 5,    // minutes between automatic local snapshots
  driveIntervalMin: 60,   // minutes between automatic Drive backups
  localKeep: 20,          // local snapshots retained before pruning oldest
  driveKeep: 30,          // Drive snapshots retained before pruning oldest
  driveAutoBackup: true   // scheduled Drive backups (only once connected)
};

export const ALARM_LOCAL = "tabvault-local-backup";
export const ALARM_DRIVE = "tabvault-drive-backup";

export async function getOAuthClientId() {
  const { oauthClientId } = await chrome.storage.sync.get("oauthClientId");
  if (oauthClientId) return oauthClientId;

  // Migrate a value saved by an earlier build that used storage.local, so
  // existing users don't have to re-enter it after this upgrade.
  const local = await chrome.storage.local.get("oauthClientId");
  if (local.oauthClientId) {
    await chrome.storage.sync.set({ oauthClientId: local.oauthClientId });
    await chrome.storage.local.remove("oauthClientId");
    return local.oauthClientId;
  }
  return "";
}

export async function saveOAuthClientId(clientId) {
  await chrome.storage.sync.set({ oauthClientId: clientId.trim() });
}

export async function isClientIdConfigured() {
  return !!(await getOAuthClientId());
}

export async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}
