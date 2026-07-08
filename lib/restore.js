// Recreates a snapshot: one new browser window per captured window, groups
// rebuilt with their original title/color/collapsed state, tabs in order.
//
// Tabs are created sequentially with a breather pause every few tabs rather
// than firing dozens of chrome.tabs.create calls at once — creation doesn't
// wait for pages to load, so a large session still restores in seconds
// without spiking the browser.

const RESTORABLE = /^(https?:|about:blank$)/i;
const BATCH = 8;
const BATCH_PAUSE_MS = 250;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function restoreSnapshot(snapshot) {
  // Auto-backup alarms check this flag so a half-restored session is never
  // captured as if it were the user's real state.
  await chrome.storage.session.set({ restoring: true });
  let created = 0;
  let skipped = 0;

  try {
    for (const win of snapshot.windows || []) {
      const result = await restoreWindow(win);
      created += result.created;
      skipped += result.skipped;
    }
  } finally {
    await chrome.storage.session.remove("restoring");
  }
  return { created, skipped };
}

async function restoreWindow(win) {
  let created = 0;
  let skipped = 0;
  let sinceBreather = 0;

  const newWin = await chrome.windows.create({ focused: true });
  const placeholderId = newWin.tabs?.[0]?.id;

  const createTab = async (tab, pinned) => {
    if (!RESTORABLE.test(tab.url)) {
      skipped++; // chrome://, file://, extension pages etc. can't be reopened
      return null;
    }
    try {
      const t = await chrome.tabs.create({
        windowId: newWin.id,
        url: tab.url,
        pinned,
        active: false
      });
      created++;
      if (++sinceBreather >= BATCH) {
        sinceBreather = 0;
        await sleep(BATCH_PAUSE_MS);
      }
      return t.id;
    } catch {
      skipped++;
      return null;
    }
  };

  // Pinned tabs first so they take their natural leftmost positions.
  const allLoose = win.ungrouped || [];
  for (const tab of allLoose.filter((t) => t.pinned)) {
    await createTab(tab, true);
  }

  const collapseLater = [];
  for (const group of win.groups || []) {
    const tabIds = [];
    for (const tab of group.tabs || []) {
      const id = await createTab(tab, false);
      if (id !== null) tabIds.push(id);
    }
    if (tabIds.length === 0) continue;

    const groupId = await chrome.tabs.group({
      tabIds,
      createProperties: { windowId: newWin.id }
    });
    await chrome.tabGroups.update(groupId, {
      title: group.title,
      color: group.color
    });
    if (group.collapsed) collapseLater.push(groupId);
  }

  for (const tab of allLoose.filter((t) => !t.pinned)) {
    await createTab(tab, false);
  }

  // Collapse at the end so group geometry is settled before folding.
  for (const groupId of collapseLater) {
    try {
      await chrome.tabGroups.update(groupId, { collapsed: true });
    } catch {
      /* group may have been touched by the user mid-restore */
    }
  }

  // Drop the initial New Tab placeholder once real tabs exist.
  if (placeholderId !== undefined && created > 0) {
    try {
      await chrome.tabs.remove(placeholderId);
    } catch {
      /* user may have closed it already */
    }
  }

  return { created, skipped };
}
