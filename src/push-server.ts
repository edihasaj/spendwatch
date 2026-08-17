import { resolve, sep } from "node:path";
import webpush from "web-push";
import { NOTIFICATION_BADGE, NOTIFICATION_ICON } from "./branding";
import { loadCapacityDashboard } from "./capacity-dashboard";
import { PushStore, type PendingPushDelivery, type StoredPushSubscription } from "./push-store";
import { SERVICE_WORKER_SOURCE } from "./service-worker";
import { reportOperationalError } from "./telemetry";

export interface DashboardServerOptions {
  host: string;
  port: number;
  publicDir: string;
  capacityPath: string;
  databasePath: string;
  vapidSubject: string;
  pollMs?: number;
}

function validSubscription(value: unknown): value is StoredPushSubscription {
  if (!value || typeof value !== "object") return false;
  const subscription = value as Record<string, unknown>;
  const keys = subscription.keys as Record<string, unknown> | undefined;
  return typeof subscription.endpoint === "string" && subscription.endpoint.startsWith("https://") && subscription.endpoint.length < 4096 &&
    Boolean(keys) && typeof keys!.p256dh === "string" && keys!.p256dh.length < 1024 &&
    typeof keys!.auth === "string" && keys!.auth.length < 1024;
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}

function postAllowed(request: Request): boolean {
  if (request.method !== "POST") return true;
  if (request.headers.get("content-type")?.split(";", 1)[0] !== "application/json") return false;
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin") return false;
  const origin = request.headers.get("origin");
  return !origin || new URL(origin).host === new URL(request.url).host;
}

function notificationPayload(delivery: PendingPushDelivery): string {
  const provider = delivery.provider.charAt(0).toUpperCase() + delivery.provider.slice(1);
  const budgetAlert = delivery.provider === "copilot";
  const title = delivery.threshold === 0
    ? budgetAlert ? "Monthly Copilot budget spent" : "Weekly capacity gone"
    : `${delivery.threshold}% ${budgetAlert ? "Copilot budget" : "weekly capacity"} left`;
  return JSON.stringify({
    title,
    body: `${provider} · ${delivery.account}`,
    tag: `spendwatch:${delivery.provider}:${delivery.account.toLowerCase()}:${delivery.resetKey}:${delivery.threshold}`,
    url: "/",
    icon: NOTIFICATION_ICON,
    badge: NOTIFICATION_BADGE,
    requireInteraction: delivery.threshold <= 5,
  });
}

export interface PushTestResult {
  sent: number;
  failed: number;
  disabled: number;
}

function configureVapid(store: PushStore, subject: string): { publicKey: string; privateKey: string } {
  let publicKey = store.config("vapid_public_key");
  let privateKey = store.config("vapid_private_key");
  if (!publicKey || !privateKey) {
    const generated = webpush.generateVAPIDKeys();
    publicKey = generated.publicKey;
    privateKey = generated.privateKey;
    store.setConfig("vapid_public_key", publicKey);
    store.setConfig("vapid_private_key", privateKey);
  }
  webpush.setVapidDetails(subject, publicKey, privateKey);
  return { publicKey, privateKey };
}

export async function testBackgroundPush(databasePath: string, vapidSubject: string): Promise<PushTestResult> {
  const store = new PushStore(databasePath);
  const result: PushTestResult = { sent: 0, failed: 0, disabled: 0 };
  try {
    configureVapid(store, vapidSubject);
    await Promise.all(store.enabledSubscriptions().map(async (subscription) => {
      try {
        await webpush.sendNotification(subscription, JSON.stringify({
          title: "Spendwatch background test",
          body: "This arrived without the dashboard being open.",
          tag: "spendwatch:background-test",
          url: "/",
          icon: NOTIFICATION_ICON,
          badge: NOTIFICATION_BADGE,
        }), { TTL: 60, urgency: "normal" });
        result.sent++;
      } catch (error) {
        result.failed++;
        const statusCode = Number((error as { statusCode?: unknown }).statusCode);
        if (statusCode === 404 || statusCode === 410) {
          store.disableSubscription(subscription.endpoint, Date.now());
          result.disabled++;
        }
      }
    }));
    return result;
  } finally {
    store.close();
  }
}

export async function serveDashboard(options: DashboardServerOptions): Promise<never> {
  const store = new PushStore(options.databasePath);
  const { publicKey } = configureVapid(store, options.vapidSubject);
  let monitoring = false;

  const send = async (delivery: PendingPushDelivery): Promise<void> => {
    try {
      await webpush.sendNotification(
        { endpoint: delivery.endpoint, keys: delivery.keys },
        notificationPayload(delivery),
        { TTL: 3600, urgency: delivery.threshold <= 5 ? "high" : "normal" },
      );
      store.markSent(delivery.eventId, delivery.endpoint, Date.now());
    } catch (error) {
      const statusCode = Number((error as { statusCode?: unknown }).statusCode);
      if (statusCode !== 404 && statusCode !== 410) {
        void reportOperationalError("spendwatch.push.delivery-failure", error, {
          component: "push",
          status: Number.isFinite(statusCode) ? String(statusCode) : "unknown",
        });
      }
      store.markFailed(delivery.eventId, delivery.endpoint, String(error), statusCode === 404 || statusCode === 410, Date.now());
    }
  };

  const monitor = async (): Promise<void> => {
    if (monitoring) return;
    monitoring = true;
    try {
      store.observe(loadCapacityDashboard([options.capacityPath]).accounts, Date.now());
      await Promise.allSettled(store.pendingDeliveries().map(send));
    } catch (error) {
      void reportOperationalError("spendwatch.monitor.failure", error, {
        component: "capacity",
      });
      process.stderr.write(`push monitor: ${String(error)}\n`);
    } finally {
      monitoring = false;
    }
  };

  const publicRoot = resolve(options.publicDir);
  Bun.serve({
    hostname: options.host,
    port: options.port,
    async fetch(request) {
      try {
      const url = new URL(request.url);
      if (url.pathname === "/api/push/config" && request.method === "GET") {
        return json({ publicKey, thresholds: [30, 15, 10, 5, 0] });
      }
      if (["/api/push/status", "/api/push/subscribe", "/api/push/unsubscribe"].includes(url.pathname) && request.method === "POST") {
        if (!postAllowed(request)) return json({ error: "same-origin JSON required" }, 403);
        if (Number(request.headers.get("content-length") ?? 0) > 8192) return json({ error: "request too large" }, 413);
        const body = await request.json().catch(() => undefined) as { subscription?: unknown } | undefined;
        if (!validSubscription(body?.subscription)) return json({ error: "invalid push subscription" }, 400);
        if (url.pathname.endsWith("status")) {
          const status = store.subscriptionStatus(body.subscription.endpoint);
          return json({ subscribed: Boolean(status?.enabled), verified: Boolean(status?.enabled && status.verified) });
        }
        if (url.pathname.endsWith("unsubscribe")) {
          store.disableSubscription(body.subscription.endpoint, Date.now());
          return json({ ok: true });
        }
        store.upsertSubscription(body.subscription, request.headers.get("user-agent") ?? undefined, Date.now());
        try {
          await webpush.sendNotification(body.subscription, JSON.stringify({
            title: "Spendwatch alerts ready",
            body: "Background alerts work even while the dashboard is closed.",
            tag: "spendwatch:ready",
            url: "/",
            icon: NOTIFICATION_ICON,
            badge: NOTIFICATION_BADGE,
          }), { TTL: 60, urgency: "normal" });
          store.markSubscriptionVerified(body.subscription.endpoint, Date.now());
          return json({ ok: true, testSent: true });
        } catch (error) {
          void reportOperationalError("spendwatch.push.test-failure", error, {
            component: "push",
          });
          return json({ error: `subscription saved, test failed: ${String(error)}` }, 502);
        }
      }
      if (url.pathname === "/sw.js") {
        return new Response(SERVICE_WORKER_SOURCE, {
          headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache, no-store" },
        });
      }
      if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
      let pathname: string;
      try { pathname = decodeURIComponent(url.pathname); } catch { return new Response("Bad path", { status: 400 }); }
      const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
      const filePath = resolve(publicRoot, relativePath);
      if (filePath !== publicRoot && !filePath.startsWith(publicRoot + sep)) return new Response("Forbidden", { status: 403 });
      const file = Bun.file(filePath);
      if (!await file.exists()) return new Response("Not found", { status: 404 });
      return new Response(request.method === "HEAD" ? null : file, {
        headers: { "Cache-Control": relativePath.endsWith(".html") ? "no-cache" : "public, max-age=300" },
      });
      } catch (error) {
        void reportOperationalError("spendwatch.http.failure", error, {
          method: request.method.toLowerCase(),
        });
        return json({ error: "internal error" }, 500);
      }
    },
  });
  process.stdout.write(`Spendwatch server listening on http://${options.host}:${options.port}\n`);
  await monitor();
  setInterval(() => void monitor(), options.pollMs ?? 15_000);
  return await new Promise<never>(() => {});
}
