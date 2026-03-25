// ─── Fence Generator ─────────────────────────────────────────────────────────
// Takes SENTINEL anomalies + TRUST scores and generates zone updates for the
// GNSS Wizard. The Wizard then pushes the updated config to the Alberding Caster.
//
// Flow: rtkbi Agents → fence-generator → Wizard API → SSH → Caster
//
// Actions:
// 1. DOWNGRADE: Station/region has low trust or active anomaly → lower cascade priority
// 2. EXCLUDE: Station is untrusted or has critical anomaly → disable zone
// 3. RESTORE: Station recovered → re-enable zone, restore priority
// 4. NEW_FENCE: Jamming/interference detected → create exclusion zone
//
// Output: fence-actions.json (log) + pushes to Wizard API if WIZARD_URL is set

import fs from "fs";
import path from "path";
import type { SentinelAnomaly } from "./sentinel";
import type { StationTrust } from "./trust";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface FenceAction {
  id: string;
  action: "downgrade" | "exclude" | "restore" | "new_fence";
  zone_id: string | null;
  station: string | null;
  reason: string;
  priority_before: number | null;
  priority_after: number | null;
  geofence: { type: "circle" | "polygon"; lat?: number; lon?: number; radius?: number; points?: number[][] } | null;
  pushed: boolean;
  pushed_at: string | null;
  created_at: string;
}

interface WizardZone {
  id: string;
  name: string;
  network_id: string;
  enabled: boolean;
  geofence: any;
  color: string;
  priority: number;
}

// ─── Config ──────────────────────────────────────────────────────────────────

const WIZARD_URL = process.env.WIZARD_URL || "";          // e.g. https://gnss-wizard.onrender.com
const WIZARD_API_KEY = process.env.WIZARD_API_KEY || "";   // X-API-Key for Wizard auth
const AUTO_PUSH = process.env.FENCE_AUTO_PUSH === "true";  // Only push if explicitly enabled

// Priority thresholds
const DOWNGRADE_TRUST_THRESHOLD = 0.5;   // Trust < 0.5 → increase priority number (lower priority)
const EXCLUDE_TRUST_THRESHOLD = 0.3;     // Trust < 0.3 → disable zone entirely
const RESTORE_TRUST_THRESHOLD = 0.7;     // Trust recovers above 0.7 → restore

// ─── Core Function ──────────────────────────────────────────────────────────

export async function generateFenceActions(
  anomalies: SentinelAnomaly[],
  trustScores: StationTrust[],
  dataDir: string,
): Promise<FenceAction[]> {
  const now = new Date();
  const actions: FenceAction[] = [];

  // Build lookup maps
  const trustMap = new Map<string, StationTrust>();
  for (const t of trustScores) {
    trustMap.set(t.station, t);
  }

  const anomalyByStation = new Map<string, SentinelAnomaly[]>();
  for (const a of anomalies) {
    if (a.station) {
      if (!anomalyByStation.has(a.station)) anomalyByStation.set(a.station, []);
      anomalyByStation.get(a.station)!.push(a);
    }
  }

  // Load current Wizard zones (if available)
  const currentZones = await fetchWizardZones();

  // ── 1. Trust-based actions ────────────────────────────────────────────────

  for (const trust of trustScores) {
    if (trust.flag === "new") continue; // Not enough data yet

    const existingZone = findZoneForStation(currentZones, trust.station);

    if (trust.combined_score < EXCLUDE_TRUST_THRESHOLD && trust.flag === "untrusted") {
      actions.push({
        id: `fence_exclude_${trust.station}_${now.getTime()}`,
        action: "exclude",
        zone_id: existingZone?.id || null,
        station: trust.station,
        reason: `Trust score ${trust.combined_score.toFixed(3)} below exclusion threshold (${EXCLUDE_TRUST_THRESHOLD}). Beta(${trust.alpha.toFixed(1)},${trust.beta.toFixed(1)}). Flag: ${trust.flag}.`,
        priority_before: existingZone?.priority || null,
        priority_after: null,
        geofence: null,
        pushed: false,
        pushed_at: null,
        created_at: now.toISOString(),
      });
    } else if (trust.combined_score < DOWNGRADE_TRUST_THRESHOLD && trust.flag === "probation") {
      const newPriority = existingZone ? Math.min(99, existingZone.priority + 20) : 80;
      actions.push({
        id: `fence_downgrade_${trust.station}_${now.getTime()}`,
        action: "downgrade",
        zone_id: existingZone?.id || null,
        station: trust.station,
        reason: `Trust score ${trust.combined_score.toFixed(3)} in probation range. Lowering cascade priority.`,
        priority_before: existingZone?.priority || null,
        priority_after: newPriority,
        geofence: null,
        pushed: false,
        pushed_at: null,
        created_at: now.toISOString(),
      });
    }
  }

  // ── 2. Anomaly-based actions ──────────────────────────────────────────────

  for (const anomaly of anomalies) {
    if (anomaly.severity !== "critical") continue; // Only act on critical anomalies

    if (anomaly.type === "mass_disconnect" || anomaly.type === "jamming_suspect") {
      // Create exclusion geofence around affected area
      if (anomaly.region) {
        actions.push({
          id: `fence_jamming_${anomaly.id}`,
          action: "new_fence",
          zone_id: null,
          station: anomaly.station,
          reason: `${anomaly.type}: ${anomaly.affected_users} users affected. ${anomaly.recommended_action}`,
          priority_before: null,
          priority_after: 99, // Lowest priority
          geofence: {
            type: "circle",
            lat: anomaly.region.lat,
            lon: anomaly.region.lon,
            radius: anomaly.region.radius_km * 1000, // Convert to meters
          },
          pushed: false,
          pushed_at: null,
          created_at: now.toISOString(),
        });
      }
    }

    if (anomaly.station && (anomaly.type === "cusum_fix_drift" || anomaly.type === "ewma_fix_drop")) {
      const existingZone = findZoneForStation(currentZones, anomaly.station);
      actions.push({
        id: `fence_anomaly_${anomaly.id}`,
        action: "downgrade",
        zone_id: existingZone?.id || null,
        station: anomaly.station,
        reason: `${anomaly.type}: fix rate ${anomaly.current_value}% vs baseline ${anomaly.baseline_value}% (${anomaly.method} detected).`,
        priority_before: existingZone?.priority || null,
        priority_after: existingZone ? Math.min(99, existingZone.priority + 30) : 90,
        geofence: null,
        pushed: false,
        pushed_at: null,
        created_at: now.toISOString(),
      });
    }
  }

  // ── 3. Restore actions (stations that recovered) ──────────────────────────

  for (const trust of trustScores) {
    if (trust.combined_score >= RESTORE_TRUST_THRESHOLD && trust.flag === "trusted") {
      const existingZone = findZoneForStation(currentZones, trust.station);
      // Only restore if it was previously downgraded (priority > 50)
      if (existingZone && existingZone.priority > 50) {
        actions.push({
          id: `fence_restore_${trust.station}_${now.getTime()}`,
          action: "restore",
          zone_id: existingZone.id,
          station: trust.station,
          reason: `Trust recovered to ${trust.combined_score.toFixed(3)}. Restoring normal priority.`,
          priority_before: existingZone.priority,
          priority_after: 10, // Default normal priority
          geofence: null,
          pushed: false,
          pushed_at: null,
          created_at: now.toISOString(),
        });
      }
    }
  }

  // ── 4. Push to Wizard (if enabled) ────────────────────────────────────────

  if (AUTO_PUSH && WIZARD_URL && actions.length > 0) {
    for (const action of actions) {
      try {
        await pushActionToWizard(action);
        action.pushed = true;
        action.pushed_at = new Date().toISOString();
      } catch (err) {
        console.error(`[FENCE] Failed to push action ${action.id}:`, err);
      }
    }
  }

  // ── 5. Log actions ────────────────────────────────────────────────────────

  const logPath = path.join(dataDir, "fence-actions.json");
  let existingLog: FenceAction[] = [];
  try {
    if (fs.existsSync(logPath)) {
      existingLog = JSON.parse(fs.readFileSync(logPath, "utf-8")).actions || [];
    }
  } catch {}

  // Keep last 500 actions
  const allActions = [...actions, ...existingLog].slice(0, 500);
  const tmp = logPath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({
    actions: allActions,
    last_run: now.toISOString(),
    summary: {
      total_actions: actions.length,
      downgrades: actions.filter(a => a.action === "downgrade").length,
      excludes: actions.filter(a => a.action === "exclude").length,
      restores: actions.filter(a => a.action === "restore").length,
      new_fences: actions.filter(a => a.action === "new_fence").length,
      auto_push: AUTO_PUSH,
    },
  }));
  fs.renameSync(tmp, logPath);

  return actions;
}

// ─── Wizard API Helpers ──────────────────────────────────────────────────────

async function fetchWizardZones(): Promise<WizardZone[]> {
  if (!WIZARD_URL) return [];
  try {
    const res = await fetch(`${WIZARD_URL}/api/data/zones`, {
      headers: { "X-API-Key": WIZARD_API_KEY },
    });
    if (!res.ok) return [];
    const data = await res.json();
    // Wizard returns Record<string, ZoneJSON>
    return Object.values(data).map((z: any) => ({
      id: z.id,
      name: z.name,
      network_id: z.network_id,
      enabled: z.enabled,
      geofence: z.geofence,
      color: z.color,
      priority: z.priority,
    }));
  } catch {
    return [];
  }
}

function findZoneForStation(zones: WizardZone[], station: string): WizardZone | null {
  // Try to find a zone that references this station (by name match in zone name)
  return zones.find(z => z.name.includes(station)) || null;
}

async function pushActionToWizard(action: FenceAction): Promise<void> {
  if (!WIZARD_URL) return;

  if (action.action === "exclude" && action.zone_id) {
    // Disable the zone
    await fetch(`${WIZARD_URL}/api/data/zones`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": WIZARD_API_KEY,
      },
      body: JSON.stringify({
        key: action.zone_id,
        value: { enabled: false },
      }),
    });
  } else if (action.action === "downgrade" && action.zone_id && action.priority_after) {
    // Lower priority
    await fetch(`${WIZARD_URL}/api/data/zones`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": WIZARD_API_KEY,
      },
      body: JSON.stringify({
        key: action.zone_id,
        value: { priority: action.priority_after },
      }),
    });
  } else if (action.action === "restore" && action.zone_id) {
    // Re-enable + restore priority
    await fetch(`${WIZARD_URL}/api/data/zones`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": WIZARD_API_KEY,
      },
      body: JSON.stringify({
        key: action.zone_id,
        value: { enabled: true, priority: action.priority_after || 10 },
      }),
    });
  } else if (action.action === "new_fence" && action.geofence) {
    // Create new exclusion zone
    const zoneId = `integrity_${Date.now()}`;
    await fetch(`${WIZARD_URL}/api/data/zones`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": WIZARD_API_KEY,
      },
      body: JSON.stringify({
        key: zoneId,
        value: {
          id: zoneId,
          name: `Integrity Exclusion — ${action.reason.substring(0, 50)}`,
          network_id: "", // Applies to all networks
          enabled: true,
          geofence: action.geofence,
          color: "#ef4444", // Red
          priority: 99,
        },
      }),
    });
  }
}
