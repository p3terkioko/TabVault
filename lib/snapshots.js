// Local snapshot store on top of chrome.storage.local.
//
// Layout:
//   localIndex        -> [{ id, createdAt, reason, groupCount, tabCount, hash }]
//                        newest first — cheap to read for the popup list
//   snap_<id>         -> full snapshot payload
//
// chrome.storage.local quota is 10 MB; snapshots are JSON of URLs/titles, so
// 20 retained snapshots of even a heavy session stay far below that.

import { stateHash } from "./capture.js";
import { getSettings } from "./config.js";

export async function listLocalSnapshots() {
  const { localIndex } = await chrome.storage.local.get("localIndex");
  return localIndex || [];
}

export async function getLocalSnapshot(id) {
  const key = "snap_" + id;
  const data = await chrome.storage.local.get(key);
  return data[key] || null;
}

// Saves a snapshot unless it is structurally identical to the newest one.
// Returns { saved, entry } — saved=false means state hadn't changed.
export async function saveLocalSnapshot(snapshot) {
  if (snapshot.tabCount === 0) return { saved: false, entry: null };

  const index = await listLocalSnapshots();
  const hash = stateHash(snapshot);
  if (index.length > 0 && index[0].hash === hash) {
    return { saved: false, entry: index[0] };
  }

  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const entry = {
    id,
    createdAt: snapshot.createdAt,
    reason: snapshot.reason,
    groupCount: snapshot.groupCount,
    tabCount: snapshot.tabCount,
    hash
  };
  const newIndex = [entry, ...index];

  const { localKeep } = await getSettings();
  const kept = newIndex.slice(0, localKeep);
  const pruned = newIndex.slice(localKeep);

  await chrome.storage.local.set({ ["snap_" + id]: snapshot, localIndex: kept });
  if (pruned.length > 0) {
    await chrome.storage.local.remove(pruned.map((e) => "snap_" + e.id));
  }
  return { saved: true, entry };
}
