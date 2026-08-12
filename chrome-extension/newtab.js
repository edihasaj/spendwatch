const DASHBOARD_URL = "https://basevm-clean-20260724.tail5ea051.ts.net:8899/";
const RETRY_INTERVAL_MS = 30_000;
const CONNECT_TIMEOUT_MS = 8_000;
const FRAME_TIMEOUT_MS = 12_000;

const dashboard = document.querySelector("#dashboard");
const message = document.querySelector("#message");
const retry = document.querySelector("#retry");
const bookmarkBar = document.querySelector("#bookmark-bar");
let retryTimer;
let frameTimer;
let attempt = 0;

function setState(state, text) {
  document.body.dataset.state = state;
  message.textContent = text;
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
    details.open = true;
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
    if (!details.open) return;
    const siblings = details.parentElement?.querySelectorAll(":scope > details[open]") || [];
    for (const sibling of siblings) {
      if (sibling !== details) sibling.removeAttribute("open");
    }
    requestAnimationFrame(() => positionMenu(summary, menu, nested));
  });
  return details;
}

async function loadBookmarks() {
  try {
    const [tree] = await chrome.bookmarks.getTree();
    const roots = tree?.children || [];
    const bar = roots.find((node) => node.id === "1") || roots[0];
    const bookmarks = bar?.children || [];
    bookmarkBar.replaceChildren();
    for (const bookmark of bookmarks) {
      bookmarkBar.append(bookmark.url ? bookmarkLink(bookmark) : bookmarkFolder(bookmark));
    }
    bookmarkBar.hidden = bookmarks.length === 0;
  } catch {
    bookmarkBar.hidden = true;
  }
}

async function connect() {
  const currentAttempt = ++attempt;
  clearTimeout(retryTimer);
  clearTimeout(frameTimer);
  setState("loading", "Connecting to your metrics");
  const controller = new AbortController();
  const connectTimer = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);

  try {
    const response = await fetch(DASHBOARD_URL, {
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
    dashboard.src = DASHBOARD_URL;
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

retry.addEventListener("click", connect);
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
});

loadBookmarks();
for (const event of [
  chrome.bookmarks.onCreated,
  chrome.bookmarks.onRemoved,
  chrome.bookmarks.onChanged,
  chrome.bookmarks.onMoved,
  chrome.bookmarks.onChildrenReordered,
]) event.addListener(loadBookmarks);
connect();
