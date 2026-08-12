export const DASHBOARD_URL_KEY = "dashboardUrl";

export function normalizeDashboardUrl(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("Enter a dashboard URL");
  const url = new URL(value.trim());
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Dashboard URL must use HTTPS or HTTP");
  }
  if (url.username || url.password) throw new Error("Dashboard URL cannot contain credentials");
  url.hash = "";
  return url.href;
}

export function dashboardOriginPattern(value) {
  return `${new URL(normalizeDashboardUrl(value)).origin}/*`;
}

async function loadBundledDashboardUrl() {
  try {
    const response = await fetch(chrome.runtime.getURL("deployment-config.json"), { cache: "no-store" });
    const config = await response.json();
    return config.dashboardUrl ? normalizeDashboardUrl(config.dashboardUrl) : undefined;
  } catch {
    return undefined;
  }
}

export async function loadDashboardUrl() {
  const stored = await chrome.storage.sync.get(DASHBOARD_URL_KEY);
  if (stored[DASHBOARD_URL_KEY]) {
    try {
      return normalizeDashboardUrl(stored[DASHBOARD_URL_KEY]);
    } catch {
      await chrome.storage.sync.remove(DASHBOARD_URL_KEY);
    }
  }
  return loadBundledDashboardUrl();
}

export async function hasDashboardAccess(value) {
  return chrome.permissions.contains({ origins: [dashboardOriginPattern(value)] });
}

export async function saveDashboardUrl(value) {
  const dashboardUrl = normalizeDashboardUrl(value);
  const granted = await chrome.permissions.request({ origins: [dashboardOriginPattern(dashboardUrl)] });
  if (!granted) throw new Error("Dashboard access was not granted");
  await chrome.storage.sync.set({ [DASHBOARD_URL_KEY]: dashboardUrl });
  return dashboardUrl;
}
