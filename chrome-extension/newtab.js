const DASHBOARD_URL = "https://basevm-clean-20260724.tail5ea051.ts.net:8899/";
const RETRY_INTERVAL_MS = 30_000;
const CONNECT_TIMEOUT_MS = 8_000;
const FRAME_TIMEOUT_MS = 12_000;

const dashboard = document.querySelector("#dashboard");
const message = document.querySelector("#message");
const retry = document.querySelector("#retry");
let retryTimer;
let frameTimer;
let attempt = 0;

function setState(state, text) {
  document.body.dataset.state = state;
  message.textContent = text;
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

connect();
