// Google Drive backup via the hidden appDataFolder.
//
// Auth uses chrome.identity.launchWebAuthFlow with Google's OAuth endpoint
// directly (implicit flow, response_type=token). This is deliberate:
// chrome.identity.getAuthToken relies on the Google-account plumbing built
// into Chrome itself and does NOT work in Brave or Edge, while
// launchWebAuthFlow works identically in all Chromium browsers.
//
// Scope is drive.appdata only — TabVault can see nothing in the user's Drive
// except its own hidden app folder.

import { OAUTH_CLIENT_ID, DRIVE_SCOPE, isClientIdConfigured } from "./config.js";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const FILES_API = "https://www.googleapis.com/drive/v3/files";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3/files";

export class AuthRequiredError extends Error {
  constructor() {
    super("Google sign-in required");
    this.name = "AuthRequiredError";
  }
}

function buildAuthUrl(interactive) {
  const params = new URLSearchParams({
    client_id: OAUTH_CLIENT_ID,
    response_type: "token",
    redirect_uri: chrome.identity.getRedirectURL(),
    scope: DRIVE_SCOPE
  });
  // Silent mode: succeed only if the user already has a Google session and
  // has previously consented; never show UI from a background alarm.
  if (!interactive) params.set("prompt", "none");
  return `${AUTH_ENDPOINT}?${params}`;
}

// Access tokens live ~1 hour; cache in storage.session (in-memory, shared by
// the service worker and popup, cleared when the browser exits).
async function getCachedToken() {
  const { driveToken } = await chrome.storage.session.get("driveToken");
  if (driveToken && driveToken.expiresAt > Date.now() + 60_000) {
    return driveToken.token;
  }
  return null;
}

export async function getToken(interactive) {
  if (!isClientIdConfigured()) {
    throw new Error("OAuth client ID not configured — see README.md");
  }
  const cached = await getCachedToken();
  if (cached) return cached;

  let redirect;
  try {
    redirect = await chrome.identity.launchWebAuthFlow({
      url: buildAuthUrl(interactive),
      interactive
    });
  } catch (e) {
    if (!interactive) throw new AuthRequiredError();
    throw e;
  }
  if (!redirect) throw new AuthRequiredError();

  const fragment = new URLSearchParams(new URL(redirect).hash.slice(1));
  const token = fragment.get("access_token");
  const expiresIn = Number(fragment.get("expires_in") || 3600);
  if (!token) {
    // prompt=none denials come back as an error in the fragment
    if (!interactive) throw new AuthRequiredError();
    throw new Error("Google sign-in failed: " + (fragment.get("error") || "no token"));
  }

  await chrome.storage.session.set({
    driveToken: { token, expiresAt: Date.now() + expiresIn * 1000 }
  });
  await chrome.storage.local.set({ driveConnected: true });
  return token;
}

export async function isConnected() {
  const { driveConnected } = await chrome.storage.local.get("driveConnected");
  return !!driveConnected;
}

export async function disconnect() {
  const cached = await getCachedToken();
  await chrome.storage.session.remove("driveToken");
  await chrome.storage.local.set({ driveConnected: false });
  if (cached) {
    // Best effort — revoke TabVault's grant so reconnecting re-consents.
    try {
      await fetch("https://oauth2.googleapis.com/revoke?token=" + cached, {
        method: "POST"
      });
    } catch {
      /* offline is fine; the token expires within the hour anyway */
    }
  }
}

async function driveFetch(interactive, url, init = {}) {
  let token = await getToken(interactive);
  let res = await fetch(url, {
    ...init,
    headers: { ...(init.headers || {}), Authorization: "Bearer " + token }
  });
  if (res.status === 401) {
    // Token was revoked or expired early — drop the cache and retry once.
    await chrome.storage.session.remove("driveToken");
    token = await getToken(interactive);
    res = await fetch(url, {
      ...init,
      headers: { ...(init.headers || {}), Authorization: "Bearer " + token }
    });
  }
  if (!res.ok) {
    throw new Error(`Drive API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return res;
}

// Returns [{ id, name, createdTime, appProperties: {groupCount, tabCount} }]
// newest first. Counts ride along in appProperties so the popup can show
// them without downloading each backup.
export async function listDriveSnapshots(interactive) {
  const params = new URLSearchParams({
    spaces: "appDataFolder",
    orderBy: "createdTime desc",
    pageSize: "100",
    fields: "files(id,name,createdTime,appProperties)"
  });
  const res = await driveFetch(interactive, `${FILES_API}?${params}`);
  return (await res.json()).files || [];
}

export async function uploadSnapshot(snapshot, interactive) {
  const metadata = {
    name: `tabvault-${snapshot.createdAt.replace(/[:.]/g, "-")}.json`,
    parents: ["appDataFolder"],
    appProperties: {
      groupCount: String(snapshot.groupCount),
      tabCount: String(snapshot.tabCount),
      createdAt: snapshot.createdAt
    }
  };
  const boundary = "tabvault" + Date.now().toString(36);
  const body =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify(metadata) +
    `\r\n--${boundary}\r\n` +
    `Content-Type: application/json\r\n\r\n` +
    JSON.stringify(snapshot) +
    `\r\n--${boundary}--`;

  const res = await driveFetch(
    interactive,
    `${UPLOAD_API}?uploadType=multipart&fields=id`,
    {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body
    }
  );
  return (await res.json()).id;
}

export async function downloadSnapshot(fileId, interactive) {
  const res = await driveFetch(
    interactive,
    `${FILES_API}/${fileId}?alt=media`
  );
  return await res.json();
}

// appDataFolder files can't be trashed, only permanently deleted.
export async function pruneDriveSnapshots(keep, interactive) {
  const files = await listDriveSnapshots(interactive);
  for (const file of files.slice(keep)) {
    await driveFetch(interactive, `${FILES_API}/${file.id}`, {
      method: "DELETE"
    });
  }
}
