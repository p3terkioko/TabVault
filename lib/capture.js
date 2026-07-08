// Captures the current browser state: every tab group (title, color,
// collapsed state) with its tabs in order, plus ungrouped tabs, per window.
//
// Deliberately captures ONLY structure: URL, title, pinned state, order.
// No cookies, session, or authentication data — that is a scope boundary.

const TAB_GROUP_ID_NONE = -1; // chrome.tabGroups.TAB_GROUP_ID_NONE

export async function captureState(reason) {
  const [tabs, groups] = await Promise.all([
    chrome.tabs.query({ windowType: "normal" }),
    chrome.tabGroups.query({})
  ]);

  const groupById = new Map(groups.map((g) => [g.id, g]));
  const windows = new Map(); // windowId -> { groups: Map, ungrouped: [] }

  for (const tab of tabs.sort((a, b) => a.index - b.index)) {
    if (!windows.has(tab.windowId)) {
      windows.set(tab.windowId, { groups: new Map(), ungrouped: [] });
    }
    const win = windows.get(tab.windowId);
    const entry = {
      url: tab.url || tab.pendingUrl || "",
      title: tab.title || "",
      pinned: !!tab.pinned
    };
    if (!entry.url) continue;

    if (tab.groupId !== undefined && tab.groupId !== TAB_GROUP_ID_NONE) {
      const meta = groupById.get(tab.groupId);
      if (!win.groups.has(tab.groupId)) {
        win.groups.set(tab.groupId, {
          title: meta?.title || "",
          color: meta?.color || "grey",
          collapsed: !!meta?.collapsed,
          tabs: []
        });
      }
      win.groups.get(tab.groupId).tabs.push(entry);
    } else {
      win.ungrouped.push(entry);
    }
  }

  const snapshotWindows = [...windows.values()].map((w) => ({
    groups: [...w.groups.values()],
    ungrouped: w.ungrouped
  }));

  const groupCount = snapshotWindows.reduce((n, w) => n + w.groups.length, 0);
  const tabCount = snapshotWindows.reduce(
    (n, w) =>
      n + w.ungrouped.length + w.groups.reduce((m, g) => m + g.tabs.length, 0),
    0
  );

  return {
    v: 1,
    createdAt: new Date().toISOString(),
    reason,
    groupCount,
    tabCount,
    windows: snapshotWindows
  };
}

// Cheap content hash of the structural state (ignores createdAt/reason) so
// back-to-back identical snapshots can be skipped instead of stored twice.
export function stateHash(snapshot) {
  const str = JSON.stringify(snapshot.windows);
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  }
  return String(h);
}
