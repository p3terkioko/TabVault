# TabVault
Backs up your tab groups and tabs — locally for instant crash recovery, and to
your own Google Drive for recovery after a reinstall or on a new machine.
One codebase, no browser-specific branches: works identically in **Chrome,
Brave, and Microsoft Edge** (Manifest V3).

What it saves: tab group names, colors, collapsed state, and each tab's URL,
title, pin state, and order — per window. **Deliberately never saved:**
cookies, sessions, logins, form data, or history.

## Install (Load unpacked)

The steps are the same in all three browsers; only the URL of the extensions
page differs:

| Browser | Extensions page |
|---|---|
| Brave | `brave://extensions` |
| Chrome | `chrome://extensions` |
| Edge | `edge://extensions` |

1. Open the extensions page and enable **Developer mode** (toggle top-right;
   in Edge it's in the left sidebar).
2. Click **Load unpacked** and select this folder.
3. Pin the TabVault icon to the toolbar.

Local snapshots work immediately — no account, no setup. A snapshot is taken
every 5 minutes (configurable via the ⚙ in the popup), whenever a window
closes, and whenever you click **Back up now**.

Because `manifest.json` contains a `key` field, the extension ID is the same
on every machine and in every browser:

```
pblgmlmoikfndpgpgndmjhldbodlojeo
```

## Enable Google Drive backup (one-time, ~5 minutes)

Drive backups go into Drive's hidden **appDataFolder** — an app-private space
that never appears among your visible Drive files, and that only TabVault's
OAuth client can read. The OAuth scope is `drive.appdata` only; TabVault
cannot see the rest of your Drive.

> **Why not `chrome.identity.getAuthToken`?** That API depends on the Google
> account machinery built into Chrome itself and does not work in Brave or
> Edge. TabVault instead uses `chrome.identity.launchWebAuthFlow` against
> Google's standard OAuth endpoint, which behaves identically in all
> Chromium browsers.

1. Go to [Google Cloud Console](https://console.cloud.google.com/) and create
   a project (any name, e.g. "TabVault").
2. **APIs & Services → Library** → enable **Google Drive API**.
3. **APIs & Services → OAuth consent screen**: choose **External**, fill in
   the app name and your email, and add your own Google account under
   **Test users**. (Test mode is fine for personal use; no verification
   needed.)
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application** (not "Chrome extension" — that
     type only works with `getAuthToken`, which Brave/Edge lack).
   - Authorized redirect URI:
     `https://pblgmlmoikfndpgpgndmjhldbodlojeo.chromiumapp.org/`
5. Copy the client ID, open the TabVault popup, and paste it into the
   **Drive** section's client ID field, then click **Save**. Nothing to edit
   in code — it's kept in `chrome.storage.sync`, so if you have browser
   profile sync on it propagates to your other devices automatically. Use the
   **Change client ID…** link if you need to update it later.
6. Click **Connect Google Drive** in the Drive section. Sign-in happens only
   when you use the Drive section — never on ordinary popup use or in the
   background.

Note: Google OAuth "test mode" grants expire after 7 days of inactivity per
token, but TabVault silently refreshes while your browser has an active
Google session; if the silent refresh ever fails, the popup simply shows the
**Connect** button again.

### Restoring on another device

This is what the Drive tier is for. Drive backups live in a hidden folder
tied to your **Google account**, not to any one machine, so on a new device:

1. Load TabVault (its extension ID is fixed, so the same OAuth client works).
2. Enter the **same client ID** — or, with browser sync on, it's already
   there.
3. Click **Connect Google Drive** and sign in with the **same Google
   account**.
4. Every Drive backup from your other devices appears in the list with its
   timestamp and group/tab counts — click **Restore** on any of them.

## How it works

| | This device (local) | Google Drive |
|---|---|---|
| Storage | `chrome.storage.local` (10 MB quota) | Drive `appDataFolder` (hidden) |
| Frequency | every 5 min (default) + window close + manual | every 60 min (default, if connected) + manual |
| Retention | last 20 snapshots | last 30 backups |
| Auth | none | Google sign-in, `drive.appdata` scope only |
| Survives | browser crash, restart | reinstall, wiped profile, new machine |

Implementation notes:

- **MV3 service worker**: all listeners registered at top level, all state in
  `chrome.storage`, scheduling via `chrome.alarms` (a service worker is
  killed after ~30 s idle, so `setInterval` is unreliable by design).
- **Deduplication**: consecutive identical states are hashed and skipped, so
  the snapshot list only advances when your tabs actually change.
- **Background Drive backups are silent-only**: the alarm path uses a
  non-interactive token request and simply skips the backup if it would have
  required showing UI.
- **Throttled restore**: tabs are recreated sequentially with a pause every
  8 tabs — no burst of dozens of simultaneous `tabs.create` calls. Restores
  run in the service worker, so they finish even though the popup closes
  when the new window takes focus.
- **Restore fidelity**: each captured window becomes a new window; groups are
  rebuilt with original name/color/collapsed state and tab order; pinned
  tabs are re-pinned. Browser-internal pages (`chrome://`, `brave://`,
  `edge://`, extension pages) can't be reopened by extensions and are
  skipped, with a count shown after restore.

## Versioning

`manifest.json`'s `version` bumps automatically on commit, based on the
commit message's [Conventional Commits](https://www.conventionalcommits.org/)
prefix:

| Commit message | Bump |
|---|---|
| `feat!: ...` or a `BREAKING CHANGE:` footer | major (`1.2.3` → `2.0.0`) |
| `feat: ...` | minor (`1.2.3` → `1.3.0`) |
| anything else (`fix:`, `chore:`, `docs:`, unprefixed, ...) | patch (`1.2.3` → `1.2.4`) |
| a merge commit (`Merge ...`) | skipped — never double-bumps a branch's own bumps |

This is a git hook (`.githooks/commit-msg`), not a background service, so it
only runs on your machine when you commit — enable it once per clone:

```
git config core.hooksPath .githooks
```

To commit without bumping the version (e.g. editing this README), use
`git commit --no-verify`.

## Browser compatibility notes

- **Brave** supports Chrome Web Store extensions unmodified. The one known
  gap — `identity.getAuthToken`
  ([brave/brave-browser#7693](https://github.com/brave/brave-browser/issues/7693)) —
  is avoided entirely by using `launchWebAuthFlow`. Brave Shields apply to
  websites, not to extension background requests, so Drive API calls are
  unaffected.
- **Edge** documents Chrome extension code-compatibility; the only porting
  step Microsoft lists (removing `update_url`) doesn't apply since this
  manifest has none.
- The manifest `key` keeps the extension ID — and therefore the OAuth
  redirect URI — identical everywhere, so one OAuth client covers all three
  browsers and every machine.

## Publishing later (not required now)

The code already meets Chrome Web Store MV3 requirements (narrow permissions,
no remote code, minimal scope). To publish you would additionally need: a
hosted privacy policy, store listing assets, and moving the OAuth consent
screen out of test mode (Google verification for the `drive.appdata` scope).
Keep the `key` in the manifest when first uploading to preserve the extension
ID, or update the OAuth redirect URI to the store-assigned ID.

## File map

```
manifest.json      MV3 manifest (permissions: tabs, tabGroups, storage, alarms, identity)
background.js      service worker: alarms, window-close trigger, popup RPC, restores
lib/config.js      OAuth client ID + defaults (intervals, retention)
lib/capture.js     reads tabs + tabGroups into a snapshot
lib/snapshots.js   local snapshot store + retention pruning
lib/drive.js       launchWebAuthFlow OAuth + Drive appDataFolder REST calls
lib/restore.js     throttled recreation of windows, groups, tabs
popup/             toolbar UI: local list, Drive list, settings
```
