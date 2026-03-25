// ─── Fence Generator V2 ──────────────────────────────────────────────────────
// Takes SENTINEL V2 anomalies + TRUST V2 scores and generates zone updates.
//
// Fixed issues from review:
// - Uses V2 types (composite_score, not combined_score)
// - Station→Zone lookup via station list membership, not name substring
// - Handles "excluded" flag from TRUST V2
// - Connects to SENTINEL V2 anomalies (CUSUM/EWMA/ST-DBSCAN)
//
// Flow: Agents detect → Fence Generator → Wizard zones.json → Config Engine → Deploy

import fs from "fs";
import path from "path";

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
  stations?: string[]; // Zone Generator V2 includes station list
}

// ─── Config ──────────────────────────────────────────────────────────────────

const AUTO_PUSH = process.env.FENCE_AUTO_PUSH === "true";
const AUTO_DEPLOY = process.env.FENCE_AUTO_DEPLOY === "true";

const DOWNGRADE_TRUST_THRESHOLD = 0.5;
const EXCLUDE_TRUST_THRESHOLD = 0.3;
const RESTORE_TRUST_THRESHOLD = 0.7;

// ─── Core Function ──────────────────────────────────────────────────────────

export async function generateFenceActions(
  anomalies: any[], // Accepts both V1 and V2 anomaly formats
  trustScores: any[], // Accepts both V1 and V2 trust formats
  dataDir: string,
): Promise<FenceAction[]> {
  const now = new Date();
  const actions: FenceAction[] = [];

  // Build trust lookup (handle both V1 combined_score and V2 composite_score)
  const trustMap = new Map<string, any>();
  for (const t of trustScores) {
    trustMap.set(t.station, t);
  }

  // Build anomaly lookup by station
  const anomalyByStation = new Map<string, any[]>();
  for (const a of anomalies) {
    if (a.station) {
      if (!anomalyByStation.has(a.station)) anomalyByStation.set(a.station, []);
      anomalyByStation.get(a.station)!.push(a);
    }
  }

  // Load current zones (from wizard data or zone-generation.json)
  const currentZones = loadZones(dataDir);

  // Build station→zone index (FIX: proper lookup instead of name substring)
  const stationToZones = new Map<string, WizardZone[]>();
  for (const zone of currentZones) {
    const stationList = zone.stations || [];
    for (const stationName of stationList) {
      if (!stationToZones.has(stationName)) stationToZones.set(stationName, []);
      stationToZones.get(stationName)!.push(zone);
    }
  }

  // ── 1. Trust-based actions ────────────────────────────────────────────────

  for (const trust of trustScores) {
    const compositeScore = trust.composite_score ?? trust.combined_score ?? 0;
    const flag = trust.flag || "new";
    if (flag === "new") continue;

    const stationZones = stationToZones.get(trust.station) || [];

    // Handle TRUST V2 "excluded" flag
    if (flag === "excluded") {
      for (const zone of stationZones) {
        if (zone.enabled) {
          actions.push({
            id: `fence_exclude_${trust.station}_${now.getTime()}`,
            action: "exclude",
            zone_id: zone.id,
            station: trust.station,
            reason: `TRUST V2 excluded: ${trust.excluded_reason || `composite ${compositeScore} below threshold`}`,
            priority_before: zone.priority,
            priority_after: null,
            geofence: null,
            pushed: false,
            pushed_at: null,
            created_at: now.toISOString(),
          });
        }
      }
      continue;
    }

    if (compositeScore < EXCLUDE_TRUST_THRESHOLD && flag === "untrusted") {
      for (const zone of stationZones) {
        if (zone.enabled) {
          actions.push({
            id: `fence_exclude_${trust.station}_${now.getTime()}`,
            action: "exclude",
            zone_id: zone.id,
            station: trust.station,
            reason: `Trust composite ${compositeScore.toFixed(3)} below exclusion threshold (${EXCLUDE_TRUST_THRESHOLD}). Flag: ${flag}.`,
            priority_before: zone.priority,
            priority_after: null,
            geofence: null,
            pushed: false,
            pushed_at: null,
            created_at: now.toISOString(),
          });
        }
      }
    } else if (compositeScore < DOWNGRADE_TRUST_THRESHOLD && flag === "probation") {
      for (const zone of stationZones) {
        const newPriority = Math.min(99, zone.priority + 20);
        actions.push({
          id: `fence_downgrade_${trust.station}_${now.getTime()}`,
          action: "downgrade",
          zone_id: zone.id,
          station: trust.station,
          reason: `Trust composite ${compositeScore.toFixed(3)} in probation. Lowering cascade priority.`,
          priority_before: zone.priority,
          priority_after: newPriority,
          geofence: null,
          pushed: false,
          pushed_at: null,
          created_at: now.toISOString(),
        });
      }
    }
  }

  // ── 2. Anomaly-based actions ──────────────────────────────────────────────

  for (const anomaly of anomalies) {
    if (anomaly.severity !== "critical") continue;

    // Interference clusters → create exclusion geofence
    if ((anomaly.type === "mass_disconnect" || anomaly.type === "interference_cluster" ||
         anomaly.type === "jamming_suspect") && anomaly.region) {
      actions.push({
        id: `fence_interference_${anomaly.id || now.getTime()}`,
        action: "new_fence",
        zone_id: null,
        station: anomaly.station,
        reason: `${anomaly.type}: ${anomaly.affected_users} users affected. ${anomaly.recommended_action || ""}`,
        priority_before: null,
        priority_after: 99,
        geofence: {
          type: "circle",
          lat: anomaly.region.lat,
          lon: anomaly.region.lon,
          radius: anomaly.region.radius_km * 1000,
        },
        pushed: false,
        pushed_at: null,
        created_at: now.toISOString(),
      });
    }

    // Station-specific anomalies (CUSUM/EWMA) → downgrade station's zones
    if (anomaly.station && (anomaly.type === "cusum_fix_drift" || anomaly.type === "ewma_fix_drop" ||
        anomaly.type === "fix_rate_drop")) {
      const stationZones = stationToZones.get(anomaly.station) || [];
      for (const zone of stationZones) {
        actions.push({
          id: `fence_anomaly_${anomaly.id || now.getTime()}`,
          action: "downgrade",
          zone_id: zone.id,
          station: anomaly.station,
          reason: `${anomaly.type}: fix ${anomaly.current_value}% vs baseline ${anomaly.baseline_value}%${anomaly.method ? ` (${anomaly.method})` : ""}.`,
          priority_before: zone.priority,
          priority_after: Math.min(99, zone.priority + 30),
          geofence: null,
          pushed: false,
          pushed_at: null,
          created_at: now.toISOString(),
        });
      }
    }
  }

  // ── 3. Restore actions ────────────────────────────────────────────────────

  for (const trust of trustScores) {
    const compositeScore = trust.composite_score ?? trust.combined_score ?? 0;
    if (compositeScore < RESTORE_TRUST_THRESHOLD || trust.flag !== "trusted") continue;

    const stationZones = stationToZones.get(trust.station) || [];
    for (const zone of stationZones) {
      if (!zone.enabled || zone.priority > 50) {
        actions.push({
          id: `fence_restore_${trust.station}_${now.getTime()}`,
          action: "restore",
          zone_id: zone.id,
          station: trust.station,
          reason: `Trust recovered to ${compositeScore.toFixed(3)}. Restoring normal priority.`,
          priority_before: zone.priority,
          priority_after: 10,
          geofence: null,
          pushed: false,
          pushed_at: null,
          created_at: now.toISOString(),
        });
      }
    }
  }

  // ── 4. Apply to local wizard zones.json ────────────────────────────────────

  if (actions.length > 0) {
    applyActionsLocally(actions, dataDir);
  }

  // ── 5. Log actions ────────────────────────────────────────────────────────

  const logPath = path.join(dataDir, "fence-actions.json");
  let existingLog: FenceAction[] = [];
  try {
    if (fs.existsSync(logPath)) {
      existingLog = JSON.parse(fs.readFileSync(logPath, "utf-8")).actions || [];
    }
  } catch {}

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
    },
  }));
  fs.renameSync(tmp, logPath);

  return actions;
}

// ─── Load Zones (from zone-generation.json which has station lists) ──────────

function loadZones(dataDir: string): WizardZone[] {
  // First try zone-generation.json (has station lists)
  try {
    const zgPath = path.join(dataDir, "zone-generation.json");
    if (fs.existsSync(zgPath)) {
      const zg = JSON.parse(fs.readFileSync(zgPath, "utf-8"));
      return (zg.zones || []).map((z: any) => ({
        id: z.id,
        name: z.name,
        network_id: z.network_id,
        enabled: z.enabled,
        geofence: z.geofence,
        color: z.color,
        priority: z.priority,
        stations: z.stations || [],
      }));
    }
  } catch {}

  // Fallback: wizard zones.json (no station lists)
  try {
    const wzPath = path.join(dataDir, "wizard", "zones.json");
    if (fs.existsSync(wzPath)) {
      const wz = JSON.parse(fs.readFileSync(wzPath, "utf-8"));
      return Object.values(wz).map((z: any) => ({
        id: z.id, name: z.name, network_id: z.network_id,
        enabled: z.enabled, geofence: z.geofence, color: z.color,
        priority: z.priority, stations: [],
      }));
    }
  } catch {}

  return [];
}

// ─── Apply Actions to Local Wizard Zones ─────────────────────────────────────

function applyActionsLocally(actions: FenceAction[], dataDir: string) {
  const wzDir = path.join(dataDir, "wizard");
  const zonesPath = path.join(wzDir, "zones.json");
  if (!fs.existsSync(wzDir)) fs.mkdirSync(wzDir, { recursive: true });

  let zones: Record<string, any> = {};
  try {
    if (fs.existsSync(zonesPath)) {
      zones = JSON.parse(fs.readFileSync(zonesPath, "utf-8"));
    }
  } catch {}

  for (const action of actions) {
    if (action.action === "exclude" && action.zone_id && zones[action.zone_id]) {
      zones[action.zone_id].enabled = false;
    } else if (action.action === "downgrade" && action.zone_id && zones[action.zone_id] && action.priority_after) {
      zones[action.zone_id].priority = action.priority_after;
    } else if (action.action === "restore" && action.zone_id && zones[action.zone_id]) {
      zones[action.zone_id].enabled = true;
      zones[action.zone_id].priority = action.priority_after || 10;
    } else if (action.action === "new_fence" && action.geofence) {
      const zoneId = `fence_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      zones[zoneId] = {
        id: zoneId,
        name: `Exclusion — ${action.reason.substring(0, 50)}`,
        network_id: "",
        enabled: true,
        geofence: action.geofence,
        color: "#ef4444",
        priority: 99,
      };
    }
  }

  const tmp = zonesPath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(zones, null, 2));
  fs.renameSync(tmp, zonesPath);
}
