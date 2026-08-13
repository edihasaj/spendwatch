const SNAPSHOTS_KEY = "tabGroupSnapshots";
const BINDINGS_KEY = "tabGroupSnapshotBindings";
let refreshTimer;

function usableTabs(tabs) {
  return tabs
    .filter(({ url }) => typeof url === "string" && /^(https?|file):/u.test(url))
    .map(({ title, url }) => ({ title: title || url, url }));
}

async function readSnapshots() {
  const value = (await chrome.storage.local.get(SNAPSHOTS_KEY))[SNAPSHOTS_KEY];
  return Array.isArray(value) ? value : [];
}

async function refreshSnapshots() {
  const [groups, snapshots, session] = await Promise.all([
    chrome.tabGroups.query({}),
    readSnapshots(),
    chrome.storage.session.get(BINDINGS_KEY),
  ]);
  const bindings = session[BINDINGS_KEY] || {};
  const byId = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
  const nextBindings = {};

  for (const group of groups) {
    const tabs = usableTabs(await chrome.tabs.query({ groupId: group.id }));
    if (!tabs.length) continue;
    const existing = byId.get(bindings[group.id])
      || snapshots.find((snapshot) => (
        snapshot.title === (group.title?.trim() || "Tab group")
        && snapshot.color === group.color
      ));
    const id = existing?.id || crypto.randomUUID();
    byId.set(id, {
      id,
      title: group.title?.trim() || "Tab group",
      color: group.color,
      tabs,
      updatedAt: Date.now(),
    });
    nextBindings[group.id] = id;
  }

  await Promise.all([
    chrome.storage.local.set({ [SNAPSHOTS_KEY]: [...byId.values()] }),
    chrome.storage.session.set({ [BINDINGS_KEY]: nextBindings }),
  ]);
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refreshSnapshots().catch(() => {}), 250);
}

chrome.runtime.onInstalled.addListener(scheduleRefresh);
chrome.runtime.onStartup.addListener(scheduleRefresh);
for (const event of [
  chrome.tabGroups.onCreated,
  chrome.tabGroups.onUpdated,
  chrome.tabGroups.onMoved,
  chrome.tabGroups.onRemoved,
  chrome.tabs.onCreated,
  chrome.tabs.onUpdated,
  chrome.tabs.onMoved,
  chrome.tabs.onRemoved,
]) event.addListener(scheduleRefresh);

scheduleRefresh();
