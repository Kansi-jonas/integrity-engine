// ─── Alert System ────────────────────────────────────────────────────────────
// Sends alerts to Slack/Discord/Webhook when critical events occur.
//
// Events that trigger alerts:
// - SENTINEL: critical anomaly detected
// - SHIELD: jamming or spoofing classified
// - TRUST: station excluded
// - ENVIRONMENT: Kp >= 5 (geomagnetic storm)
// - ENVIRONMENT: M/X class solar flare
// - CONFIG: deployment failed
// - COVERAGE: green % dropped >5pp in 7 days
// - SYSTEM: disk usage >80%

import { eventBus, IntegrityEvent } from "./event-bus";

const WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL || "";
const SLACK_URL = process.env.SLACK_WEBHOOK_URL || "";
const DISCORD_URL = process.env.DISCORD_WEBHOOK_URL || "";

// Rate limiting: max 1 alert per type per 15 minutes
const lastAlerts = new Map<string, number>();
const RATE_LIMIT_MS = 15 * 60 * 1000;

function shouldAlert(type: string): boolean {
  const last = lastAlerts.get(type) || 0;
  if (Date.now() - last < RATE_LIMIT_MS) return false;
  lastAlerts.set(type, Date.now());
  return true;
}

async function sendWebhook(url: string, payload: any) {
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error("[ALERT] Webhook failed:", err);
  }
}

async function sendSlack(title: string, detail: string, severity: string) {
  if (!SLACK_URL) return;
  const emoji = severity === "critical" ? "🔴" : severity === "warning" ? "🟡" : "🔵";
  await sendWebhook(SLACK_URL, {
    text: `${emoji} *${title}*\n${detail}`,
    username: "RTKdata Integrity Engine",
    icon_emoji: ":satellite:",
  });
}

async function sendDiscord(title: string, detail: string, severity: string) {
  if (!DISCORD_URL) return;
  const color = severity === "critical" ? 0xDC2626 : severity === "warning" ? 0xD97706 : 0x2563EB;
  await sendWebhook(DISCORD_URL, {
    embeds: [{
      title: `🛰️ ${title}`,
      description: detail,
      color,
      timestamp: new Date().toISOString(),
      footer: { text: "RTKdata Integrity Engine" },
    }],
  });
}

async function sendGenericWebhook(title: string, detail: string, severity: string, data: any) {
  if (!WEBHOOK_URL) return;
  await sendWebhook(WEBHOOK_URL, {
    event: "integrity_alert",
    title,
    detail,
    severity,
    data,
    timestamp: new Date().toISOString(),
    source: "integrity-engine",
  });
}

async function sendAlert(title: string, detail: string, severity: string, data?: any) {
  await Promise.all([
    sendSlack(title, detail, severity),
    sendDiscord(title, detail, severity),
    sendGenericWebhook(title, detail, severity, data),
  ]);
}

/**
 * Initialize alert listener on the event bus.
 * Call once at startup.
 */
export function initAlerts() {
  if (!SLACK_URL && !DISCORD_URL && !WEBHOOK_URL) {
    console.log("[ALERTS] No webhook URLs configured — alerts disabled");
    return;
  }

  console.log("[ALERTS] Alert system initialized" +
    (SLACK_URL ? " [Slack]" : "") +
    (DISCORD_URL ? " [Discord]" : "") +
    (WEBHOOK_URL ? " [Webhook]" : "")
  );

  eventBus.on("integrity", (evt: IntegrityEvent) => {
    // Only alert on critical and warning events
    if (evt.severity === "info") return;

    const alertKey = `${evt.type}:${evt.severity}`;
    if (!shouldAlert(alertKey)) return;

    // Filter: only specific event types
    if (evt.type === "anomaly" && evt.severity === "critical") {
      sendAlert(evt.title, evt.detail, evt.severity, evt.data);
    } else if (evt.type === "interference") {
      sendAlert(evt.title, evt.detail, evt.severity, evt.data);
    } else if (evt.type === "environment" && evt.severity === "critical") {
      sendAlert(evt.title, evt.detail, evt.severity, evt.data);
    } else if (evt.type === "trust_change" && evt.severity === "critical") {
      sendAlert(evt.title, evt.detail, evt.severity, evt.data);
    }
  });
}
