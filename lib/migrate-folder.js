import { listLocalSnapshots, getLocalSnapshot } from "./snapshots.js";
import { writeSnapshotToFolder, pruneFolderSnapshots } from "./folder.js";
import { getSettings } from "./config.js";

export async function migrateLocalSnapshotsToFolder(handle) {
  const index = await listLocalSnapshots();
  for (const entry of [...index].reverse()) {
    const snapshot = await getLocalSnapshot(entry.id);
    if (snapshot) await writeSnapshotToFolder(handle, snapshot);
  }
  const { localKeep } = await getSettings();
  await pruneFolderSnapshots(handle, localKeep);
}
