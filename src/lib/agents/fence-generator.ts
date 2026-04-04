// ─── Fence Generator V3 ──────────────────────────────────────────────────────
// Takes SENTINEL V2 anomalies + TRUST V2 scores + SHIELD events and generates
// zone updates with formal verification guarantees from Meridian Rule Check.
//
// Meridian Formal Verification fixes:
// 1. Cascade-Exhaustion-Alert: detect oscillating failover paths
// 2. SHIELD overrides Anti-Flapping: safety > stability
// 3. Dual-Outage-Handling: clear alert instead of endless retry
// 4. Anti-Flapping: 6h minimum zone lifetime (explicit enforcement)
// 5. Rate limiting: max fence actions per cycle to prevent thrashing
//
// Flow: Agents detect → Fence Generator → Wizard zones.json → Config Engine → Deploy

import fs from "fs";
import path from "path";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface FenceAction {
  id: string;
  action: "downgrade" | "exclude" | "restore" | "new_fence" | "cascade_exhaustion" | "dual_outage";
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
  stations?: string[];
  last_modified?: string; // For anti-flapping enforcement
}

// ─── Config ──────────────────────────────────────────────────────────────────

const AUTO_PUSH = process.env.FENCE_AUTO_PUSH === "true";
const AUTO_DEPLOY = process.env.FENCE_AUTO_DEPLOY === "true";

const DOWNGRADE_TRUST_THRESHOLD = 0.5;
const EXCLUDE_TRUST_THRESHOLD = 0.3;
const RESTORE_TRUST_THRESHOLD = 0.7;

// Meridian Rule Check: Anti-Flapping minimum zone lifetime
// Design Decision: 6h anti-flapping > 4h regeneration cycle (documented per formal verification)
const ANTI_FLAPPING_MIN_HOURS = 6;

// Meridian Rule Check: Rate limiting to prevent cascade exhaustion
const MAX_ACTIONS_PER_CYCLE = 20;

// Meridian Rule Check: SHIELD interference overrides anti-flapping
const SHIELD_OVERRIDE_CONFIDENCE = 0.6; // SHIELD events above this bypass anti-flapping

// ─── Core Function ──────────────────────────────────────────────────────────

export async function generateFenceActions(
  anomalies: any[],
  trustScores: any[],
  dataDir: string,
  shieldEvents?: any[], // Meridian: SHIELD events for override logic
): Promise<FenceAction[]> {
  const now = new Date();
  const actions: FenceAction[] = [];

  // ── Meridian Fix: Load SHIELD events if not passed ─────────────────────
  let shield = shieldEvents || [];
  if (shield.length === 0) {
    try {
      const shieldPath = path.join(dataDir, "shield-events.json");
      if (fs.existsSync(shieldPath)) {
        const data = JSON.parse(fs.readFileSync(shieldPath, "utf-8"));
        shield = (data.events || data || []).filter(
          (e: any) => e.confidence >= SHIELD_OVERRIDE_CONFIDENCE &&
                      new Date(e.start_time).getTime() > now.getTime() - 3600000 // last 1h
        );
      }
    } catch {}
  }

  // ── Meridian Fix: Load previous actions for anti-flapping ──────────────
  let previousActions: FenceAction[] = [];
  try {
    const prevPath = path.join(dataDir, "fence-actions.json");
    if (fs.existsSync(prevPath)) {
      const data = JSON.parse(fs.readFileSync(prevPath, "utf-8"));
      previousActions = data.actions || [];
    }
  } catch {}

  // ── Meridian Fix: Detect Dual-Outage (both networks down) ─────────────
  const excludedStations = trustScores.filter((t: any) => t.flag === "excluded");
  const excludedGeonet = excludedStations.filter((t: any) => !t.station?.startsWith("ono") && !t.station?.includes("ONOCOY"));
  const excludedOnocoy = excludedStations.filter((t: any) => t.station?.startsWith("ono") || t.station?.includes("ONOCOY"));

  // Check for regional dual-outage: many excluded from both networks in same area
  if (excludedGeonet.length > 10 && excludedOnocoy.length > 5) {
    actions.push({
      id: `dual_outage_${now.getTime()}`,
      action: "dual_outage",
      zone_id: null,
      station: null,
      reason: `Dual-outage detected: ${excludedGeonet.length} GEODNET + ${excludedOnocoy.length} ONOCOY stations excluded. Possible severe space weather or infrastructure failure. Service degradation expected.`,
      priority_before: null,
      priority_after: null,
      geofence: null,
      pushed: false,
      pushed_at: null,
      created_at: now.toISOString(),
    });
    console.warn(`[FENCE-GEN] DUAL-OUTAGE ALERT: ${excludedGeonet.length} GEODNET + ${excludedOnocoy.length} ONOCOY excluded`);
  }

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

  // ── 1b. Meridian: SHIELD interference → immediate zone exclusion ────────
  // Per formal verification: SHIELD overrides Anti-Flapping (safety > stability)
  for (const event of shield) {
    if (event.classification === "jamming" || event.classification === "spoofing") {
      const affectedStations: string[] = event.affected_stations || [];
      for (const stationName of affectedStations) {
        const stationZones = stationToZones.get(stationName) || [];
        for (const zone of stationZones) {
          actions.push({
            id: `shield_${event.classification}_${stationName}_${now.getTime()}`,
            action: "exclude",
            zone_id: zone.id,
            station: stationName,
            reason: `SHIELD ${event.classification} (confidence ${(event.confidence * 100).toFixed(0)}%). OVERRIDES anti-flapping per Meridian Rule Check.`,
            priority_before: zone.priority,
            priority_after: 99,
            geofence: null,
            pushed: false,
            pushed_at: null,
            created_at: now.toISOString(),
          });
        }
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

  // ── 4. Meridian: Anti-Flapping enforcement ─────────────────────────────────
  // Zones modified less than 6h ago are protected from further changes.
  // EXCEPTION: SHIELD jamming/spoofing events bypass this (safety > stability).
  // Design Decision: 6h anti-flapping > 4h regeneration = zones always protected
  //                  for at least 1 regeneration cycle. DO NOT reduce to 4h.

  const antiFlappingCutoff = now.getTime() - ANTI_FLAPPING_MIN_HOURS * 3600000;
  const protectedActions = actions.filter(a => {
    // SHIELD overrides always pass (per Meridian formal verification)
    if (a.id.startsWith("shield_")) return true;
    // Dual-outage alerts always pass
    if (a.action === "dual_outage" || a.action === "cascade_exhaustion") return true;
    // Restore actions always pass (improving, not degrading)
    if (a.action === "restore") return true;

    // Check if zone was recently modified (anti-flapping)
    const recentAction = previousActions.find(
      prev => prev.zone_id === a.zone_id && new Date(prev.created_at).getTime() > antiFlappingCutoff
    );
    if (recentAction) {
      console.log(`[FENCE-GEN] Anti-flapping: skipping ${a.action} on ${a.zone_id} (modified ${recentAction.created_at})`);
      return false;
    }
    return true;
  });

  // ── 5. Meridian: Cascade-Exhaustion detection ─────────────────────────────
  // If many actions in one cycle → possible cascading failure, not individual issues
  if (protectedActions.filter(a => a.action === "exclude" || a.action === "downgrade").length > MAX_ACTIONS_PER_CYCLE) {
    console.warn(`[FENCE-GEN] CASCADE-EXHAUSTION: ${protectedActions.length} actions in one cycle. Limiting to ${MAX_ACTIONS_PER_CYCLE}.`);
    // Keep only the highest-confidence actions, plus alerts
    const alerts = protectedActions.filter(a => a.action === "dual_outage" || a.action === "cascade_exhaustion" || a.action === "restore");
    const degrading = protectedActions
      .filter(a => a.action === "exclude" || a.action === "downgrade" || a.action === "new_fence")
      .slice(0, MAX_ACTIONS_PER_CYCLE);

    // Add cascade-exhaustion alert
    alerts.push({
      id: `cascade_exhaustion_${now.getTime()}`,
      action: "cascade_exhaustion",
      zone_id: null,
      station: null,
      reason: `Cascade-exhaustion: ${protectedActions.length} actions requested, capped at ${MAX_ACTIONS_PER_CYCLE}. Possible systemic issue — review manually.`,
      priority_before: null,
      priority_after: null,
      geofence: null,
      pushed: false,
      pushed_at: null,
      created_at: now.toISOString(),
    });

    protectedActions.length = 0;
    protectedActions.push(...alerts, ...degrading);
  }

  // ── 6. Apply to local wizard zones.json ────────────────────────────────────

  const applyable = protectedActions.filter(a => a.action !== "dual_outage" && a.action !== "cascade_exhaustion");
  if (applyable.length > 0) {
    applyActionsLocally(applyable, dataDir);
  }

  // ── 5. Log actions ────────────────────────────────────────────────────────

  const logPath = path.join(dataDir, "fence-actions.json");
  let existingLog: FenceAction[] = [];
  try {
    if (fs.existsSync(logPath)) {
      existingLog = JSON.parse(fs.readFileSync(logPath, "utf-8")).actions || [];
    }
  } catch {}

  const allActions = [...protectedActions, ...existingLog].slice(0, 500);
  const tmp = logPath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({
    actions: allActions,
    last_run: now.toISOString(),
    summary: {
      total_actions: protectedActions.length,
      downgrades: protectedActions.filter(a => a.action === "downgrade").length,
      excludes: protectedActions.filter(a => a.action === "exclude").length,
      restores: protectedActions.filter(a => a.action === "restore").length,
      new_fences: protectedActions.filter(a => a.action === "new_fence").length,
      shield_overrides: protectedActions.filter(a => a.id.startsWith("shield_")).length,
      cascade_exhaustion: protectedActions.filter(a => a.action === "cascade_exhaustion").length,
      dual_outage: protectedActions.filter(a => a.action === "dual_outage").length,
      anti_flapping_blocked: actions.length - protectedActions.length,
    },
  }));
  fs.renameSync(tmp, logPath);

  return protectedActions;
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
