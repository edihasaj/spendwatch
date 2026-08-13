import {
  hasDashboardAccess,
  loadDashboardUrl,
  saveDashboardUrl,
} from "./dashboard-config.js";

const RETRY_INTERVAL_MS = 30_000;
const CONNECT_TIMEOUT_MS = 8_000;
const FRAME_TIMEOUT_MS = 12_000;
const TAB_GROUP_SNAPSHOTS_KEY = "tabGroupSnapshots";
const MAX_VISIBLE_TAB_GROUPS = 3;

const dashboard = document.querySelector("#dashboard");
const message = document.querySelector("#message");
const retry = document.querySelector("#retry");
const settings = document.querySelector("#settings");
const bookmarkBar = document.querySelector("#bookmark-bar");
const bookmarkItems = document.querySelector("#bookmark-items");
const bookmarkOverflow = document.querySelector("#bookmark-overflow");
const bookmarkOverflowMenu = document.querySelector("#bookmark-overflow-menu");
const tabGroups = document.querySelector("#tab-groups");
const tabGroupOverflow = document.querySelector("#tab-group-overflow");
const tabGroupMenu = document.querySelector("#tab-group-menu");
const allBookmarks = document.querySelector("#all-bookmarks");
const configure = document.querySelector("#configure");
const dashboardUrlInput = document.querySelector("#dashboard-url");
const host = document.querySelector("#host");
let retryTimer;
let frameTimer;
let attempt = 0;
let dashboardUrl;
let topLevelBookmarks = [];
let bookmarkLayoutAttempt = 0;

function setState(state, text) {
  document.body.dataset.state = state;
  message.textContent = text;
  configure.hidden = state !== "setup";
}

function showSetup(text = "Enter the URL of your Spendwatch dashboard") {
  setState("setup", text);
  dashboardUrlInput.value = dashboardUrl ?? "";
  host.textContent = "Stored only in Chrome sync";
  dashboardUrlInput.focus();
}

function faviconUrl(url) {
  return chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(url)}&size=16`);
}

function bookmarkLink(bookmark) {
  const link = document.createElement("a");
  link.className = "bookmark-link";
  link.href = bookmark.url;
  link.title = bookmark.title || bookmark.url;

  const icon = document.createElement("img");
  icon.src = faviconUrl(bookmark.url);
  icon.alt = "";
  const label = document.createElement("span");
  label.textContent = bookmark.title || new URL(bookmark.url).hostname;
  link.append(icon, label);
  return link;
}

function updateToolbarVisibility() {
  bookmarkBar.hidden = topLevelBookmarks.length === 0 && tabGroups.childElementCount === 0;
}

function tabGroupChip(group, tabs, saved = false) {
  const button = document.createElement("button");
  const title = group.title?.trim() || "Tab group";
  button.className = `tab-group color-${group.color}${saved ? " saved" : ""}`;
  button.type = "button";
  button.title = `${title} · ${tabs.length} tab${tabs.length === 1 ? "" : "s"}${saved ? " · saved mirror" : group.collapsed ? " · collapsed" : ""}`;
  button.setAttribute("aria-label", `Open ${title} tab group`);

  const dot = document.createElement("span");
  dot.className = "tab-group-dot";
  dot.setAttribute("aria-hidden", "true");
  const label = document.createElement("span");
  label.textContent = title;
  button.append(dot, label);
  if (group.shared) {
    const shared = document.createElement("span");
    shared.className = "tab-group-shared";
    shared.textContent = "◉";
    shared.title = "Shared group";
    button.append(shared);
  }
  button.addEventListener("click", async () => {
    if (saved) {
      const created = [];
      for (const tab of tabs) {
        try {
          created.push(await chrome.tabs.create({ active: false, url: tab.url }));
        } catch {}
      }
      const tabIds = created.map(({ id }) => id).filter(Number.isInteger);
      if (!tabIds.length) return;
      const groupId = await chrome.tabs.group({ tabIds });
      await chrome.tabGroups.update(groupId, { color: group.color, title });
      await chrome.tabs.update(tabIds[0], { active: true });
      return;
    }
    const first = tabs[0];
    if (!first?.id) return;
    try {
      if (group.collapsed) await chrome.tabGroups.update(group.id, { collapsed: false });
      await chrome.tabs.update(first.id, { active: true });
      await chrome.windows.update(group.windowId, { focused: true });
    } catch {
      await loadTabGroups();
    }
  });
  if (saved) {
    button.addEventListener("contextmenu", async (event) => {
      event.preventDefault();
      const stored = (await chrome.storage.local.get(TAB_GROUP_SNAPSHOTS_KEY))[TAB_GROUP_SNAPSHOTS_KEY];
      await chrome.storage.local.set({
        [TAB_GROUP_SNAPSHOTS_KEY]: (Array.isArray(stored) ? stored : []).filter(({ id }) => id !== group.id),
      });
    });
  }
  return button;
}

function renderTabGroups(entries) {
  const visible = entries.slice(0, MAX_VISIBLE_TAB_GROUPS);
  const overflow = entries.slice(MAX_VISIBLE_TAB_GROUPS);
  tabGroups.replaceChildren(...visible.map(
    ({ group, tabs, saved }) => tabGroupChip(group, tabs, saved),
  ));
  tabGroupMenu.replaceChildren(...overflow.map(
    ({ group, tabs, saved }) => tabGroupChip(group, tabs, saved),
  ));
  const summary = tabGroupOverflow.querySelector(":scope > summary");
  summary.textContent = `+${overflow.length}`;
  summary.title = `${overflow.length} more tab group${overflow.length === 1 ? "" : "s"}`;
  tabGroupOverflow.hidden = overflow.length === 0;
}

async function loadTabGroups() {
  try {
    const [groups, stored] = await Promise.all([
      chrome.tabGroups.query({}),
      chrome.storage.local.get(TAB_GROUP_SNAPSHOTS_KEY),
    ]);
    const populated = await Promise.all(groups.map(async (group) => ({
      group,
      tabs: (await chrome.tabs.query({ groupId: group.id })).sort((a, b) => a.index - b.index),
    })));
    populated.sort((a, b) => (
      a.group.windowId - b.group.windowId
      || (a.tabs[0]?.index ?? Infinity) - (b.tabs[0]?.index ?? Infinity)
    ));
    const openTitles = new Set(populated.map(({ group }) => `${group.title?.trim() || "Tab group"}\n${group.color}`));
    const snapshots = Array.isArray(stored[TAB_GROUP_SNAPSHOTS_KEY])
      ? stored[TAB_GROUP_SNAPSHOTS_KEY].filter((snapshot) => (
        snapshot?.id
        && snapshot?.title
        && Array.isArray(snapshot.tabs)
        && snapshot.tabs.length
        && !openTitles.has(`${snapshot.title}\n${snapshot.color}`)
      ))
      : [];
    snapshots.sort((a, b) => b.updatedAt - a.updatedAt);
    renderTabGroups([
      ...populated.filter(({ tabs }) => tabs.length).map(({ group, tabs }) => ({ group, tabs, saved: false })),
      ...snapshots.map((snapshot) => ({ group: snapshot, tabs: snapshot.tabs, saved: true })),
    ]);
  } catch {
    tabGroups.replaceChildren();
    tabGroupMenu.replaceChildren();
    tabGroupOverflow.hidden = true;
  }
  updateToolbarVisibility();
  await layoutBookmarks();
}

function folderIcon() {
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.classList.add("folder-icon");
  icon.setAttribute("viewBox", "0 0 16 16");
  icon.setAttribute("aria-hidden", "true");
  const outline = document.createElementNS("http://www.w3.org/2000/svg", "path");
  outline.setAttribute("d", "M1.75 3.5h4.5l1.5 1.75h6.5v7.25H1.75z");
  outline.setAttribute("fill", "none");
  outline.setAttribute("stroke", "currentColor");
  outline.setAttribute("stroke-width", "1.25");
  outline.setAttribute("stroke-linejoin", "round");
  icon.append(outline);
  return icon;
}

function positionMenu(summary, menu, nested) {
  const anchor = summary.getBoundingClientRect();
  const bounds = menu.getBoundingClientRect();
  const margin = 8;
  const opensLeft = nested && anchor.right + bounds.width > window.innerWidth - margin;
  const preferredX = nested
    ? (opensLeft ? anchor.left - bounds.width + 2 : anchor.right - 2)
    : anchor.left;
  const preferredY = nested ? anchor.top - 5 : anchor.bottom + 3;
  const x = Math.min(preferredX, window.innerWidth - bounds.width - margin);
  const y = Math.min(preferredY, window.innerHeight - bounds.height - margin);
  menu.style.setProperty("--menu-x", `${Math.max(margin, x)}px`);
  menu.style.setProperty("--menu-y", `${Math.max(margin, y)}px`);
  menu.dataset.positioned = "true";
}

function setupBarMenu(details, menu) {
  const summary = details.querySelector(":scope > summary");
  details.addEventListener("toggle", () => {
    if (!details.open) {
      menu.removeAttribute("data-positioned");
      return;
    }
    for (const sibling of bookmarkBar.querySelectorAll(":scope > details[open]")) {
      if (sibling !== details) sibling.removeAttribute("open");
    }
    positionMenu(summary, menu, false);
  });
}

function bookmarkFolder(folder, nested = false) {
  const details = document.createElement("details");
  details.className = `bookmark-folder${nested ? " nested" : ""}`;
  const summary = document.createElement("summary");
  summary.title = folder.title;
  const icon = folderIcon();
  const label = document.createElement("span");
  label.textContent = folder.title;
  summary.append(icon, label);

  const menu = document.createElement("div");
  menu.className = "bookmark-menu";
  const children = folder.children || [];
  for (const child of children) {
    if (child.url) menu.append(bookmarkLink(child));
    else menu.append(bookmarkFolder(child, true));
  }
  if (!children.length) {
    const empty = document.createElement("div");
    empty.className = "bookmark-empty";
    empty.textContent = "(empty)";
    menu.append(empty);
  }
  details.append(summary, menu);
  let closeTimer;
  const openFolder = () => {
    clearTimeout(closeTimer);
    menu.removeAttribute("data-positioned");
    details.open = true;
    positionMenu(summary, menu, nested);
  };
  details.addEventListener("pointerenter", openFolder);
  details.addEventListener("pointerleave", () => {
    closeTimer = setTimeout(() => details.removeAttribute("open"), 140);
  });
  summary.addEventListener("click", (event) => {
    event.preventDefault();
    openFolder();
  });
  details.addEventListener("toggle", () => {
    if (!details.open) {
      menu.removeAttribute("data-positioned");
      return;
    }
    const siblings = details.parentElement?.querySelectorAll(":scope > details[open]") || [];
    for (const sibling of siblings) {
      if (sibling !== details) sibling.removeAttribute("open");
    }
    if (!menu.hasAttribute("data-positioned")) positionMenu(summary, menu, nested);
  });
  return details;
}

function bookmarkNode(bookmark, nested = false) {
  return bookmark.url ? bookmarkLink(bookmark) : bookmarkFolder(bookmark, nested);
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

async function layoutBookmarks() {
  const layoutAttempt = ++bookmarkLayoutAttempt;
  bookmarkOverflow.hidden = true;
  bookmarkOverflowMenu.replaceChildren();
  bookmarkItems.replaceChildren(...topLevelBookmarks.map((bookmark) => bookmarkNode(bookmark)));
  if (bookmarkBar.hidden || topLevelBookmarks.length === 0) return;
  await nextFrame();
  if (layoutAttempt !== bookmarkLayoutAttempt) return;

  const widths = [...bookmarkItems.children].map((child) => child.getBoundingClientRect().width);
  const totalWidth = widths.reduce((total, width) => total + width, 0) + Math.max(0, widths.length - 1);
  if (totalWidth <= bookmarkItems.clientWidth) return;

  bookmarkOverflow.hidden = false;
  await nextFrame();
  if (layoutAttempt !== bookmarkLayoutAttempt) return;

  let usedWidth = 0;
  let visibleCount = 0;
  for (const width of widths) {
    const nextWidth = usedWidth + width + (visibleCount ? 1 : 0);
    if (nextWidth > bookmarkItems.clientWidth) break;
    usedWidth = nextWidth;
    visibleCount += 1;
  }
  bookmarkItems.replaceChildren(...topLevelBookmarks.slice(0, visibleCount).map((bookmark) => bookmarkNode(bookmark)));
  bookmarkOverflowMenu.replaceChildren(...topLevelBookmarks.slice(visibleCount).map((bookmark) => bookmarkNode(bookmark, true)));
}

async function loadBookmarks() {
  try {
    const [tree] = await chrome.bookmarks.getTree();
    const roots = tree?.children || [];
    const bar = roots.find((node) => node.id === "1") || roots[0];
    topLevelBookmarks = bar?.children || [];
  } catch {
    topLevelBookmarks = [];
  }
  updateToolbarVisibility();
  await layoutBookmarks();
}

async function openChromePage(url) {
  try {
    await chrome.tabs.update({ url });
  } catch {
    await chrome.tabs.create({ url });
  }
}

async function connect() {
  if (!dashboardUrl) {
    showSetup();
    return;
  }
  if (!await hasDashboardAccess(dashboardUrl)) {
    showSetup("Allow access to this dashboard to connect");
    return;
  }
  const currentAttempt = ++attempt;
  clearTimeout(retryTimer);
  clearTimeout(frameTimer);
  setState("loading", "Connecting to your metrics");
  const controller = new AbortController();
  const connectTimer = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);

  try {
    const response = await fetch(dashboardUrl, {
      method: "HEAD",
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Dashboard returned ${response.status}`);
    if (currentAttempt !== attempt) return;

    dashboard.onload = () => {
      if (currentAttempt !== attempt) return;
      clearTimeout(frameTimer);
      setState("ready", "Metrics ready");
    };
    dashboard.src = dashboardUrl;
    frameTimer = setTimeout(() => {
      if (currentAttempt !== attempt) return;
      dashboard.onload = null;
      setState("offline", "Dashboard unavailable. Reconnecting automatically.");
      retryTimer = setTimeout(connect, RETRY_INTERVAL_MS);
    }, FRAME_TIMEOUT_MS);
  } catch {
    if (currentAttempt !== attempt) return;
    setState("offline", "Dashboard unavailable. Reconnecting automatically.");
    retryTimer = setTimeout(connect, RETRY_INTERVAL_MS);
  } finally {
    clearTimeout(connectTimer);
  }
}

configure.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = configure.querySelector('button[type="submit"]');
  submit.disabled = true;
  setState("setup", "Requesting access to your dashboard");
  try {
    dashboardUrl = await saveDashboardUrl(dashboardUrlInput.value);
    host.textContent = new URL(dashboardUrl).host;
    await connect();
  } catch (error) {
    showSetup(error instanceof Error ? error.message : "Dashboard access was not granted");
  } finally {
    submit.disabled = false;
  }
});
retry.addEventListener("click", connect);
settings.addEventListener("click", () => chrome.runtime.openOptionsPage());
allBookmarks.addEventListener("click", () => openChromePage("chrome://bookmarks/"));
setupBarMenu(tabGroupOverflow, tabGroupMenu);
setupBarMenu(bookmarkOverflow, bookmarkOverflowMenu);
window.addEventListener("online", connect);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && document.body.dataset.state === "offline") connect();
});
document.addEventListener("click", (event) => {
  for (const folder of bookmarkBar.querySelectorAll("details[open]")) {
    if (!folder.contains(event.target)) folder.removeAttribute("open");
  }
});
window.addEventListener("resize", () => {
  for (const folder of bookmarkBar.querySelectorAll("details[open]")) {
    folder.removeAttribute("open");
  }
  layoutBookmarks();
});

loadBookmarks();
loadTabGroups();
for (const event of [
  chrome.bookmarks.onCreated,
  chrome.bookmarks.onRemoved,
  chrome.bookmarks.onChanged,
  chrome.bookmarks.onMoved,
  chrome.bookmarks.onChildrenReordered,
]) event.addListener(loadBookmarks);
for (const event of [
  chrome.tabGroups.onCreated,
  chrome.tabGroups.onUpdated,
  chrome.tabGroups.onMoved,
  chrome.tabGroups.onRemoved,
  chrome.tabs.onCreated,
  chrome.tabs.onUpdated,
  chrome.tabs.onMoved,
  chrome.tabs.onRemoved,
]) event.addListener(loadTabGroups);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[TAB_GROUP_SNAPSHOTS_KEY]) loadTabGroups();
});
for (const event of [
  chrome.windows.onCreated,
  chrome.windows.onRemoved,
  chrome.windows.onFocusChanged,
]) event.addListener(loadTabGroups);

dashboardUrl = await loadDashboardUrl();
if (dashboardUrl) host.textContent = new URL(dashboardUrl).host;
await connect();
