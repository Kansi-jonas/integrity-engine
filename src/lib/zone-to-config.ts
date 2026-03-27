// ─── Zone-to-Config Bridge ───────────────────────────────────────────────────
// Converts Zone Builder output (H3-based zones) into Wizard-compatible format
// that the Config Engine can generate ntrips.cfg from.
//
// This is the bridge between:
//   Zone Builder (physics-based H3 zones) → Config Engine (Alberding syntax)
//
// The Zone Builder produces: zone boundaries + station assignments + priorities
// The Config Engine needs: Zone objects + Network/Mountpoint/Group references

import type { Zone, GeoFence } from "./wizard/types";
import type { GeneratedZone, ZoneBuildResult } from "./zone-builder";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

/**
 * Convert Zone Builder zones to Wizard Zone format for Config Engine.
 */
export function convertZonesToWizard(
  result: ZoneBuildResult,
  dataDir: string
): Record<string, Zone> {
  const wizardZones: Record<string, Zone> = {};

  // Load existing manual zones (preserve user-created zones)
  try {
    const wizardDir = path.join(dataDir, "wizard");
    const zonesPath = path.join(wizardDir, "zones.json");
    if (fs.existsSync(zonesPath)) {
      const existing = JSON.parse(fs.readFileSync(zonesPath, "utf-8"));
      // Keep manual zones
      for (const [key, zone] of Object.entries(existing)) {
        const z = zone as any;
        if (z.manual_override || z.source === "manual") {
          wizardZones[key] = z;
        }
      }
    }
  } catch {}

  // Convert each generated zone
  for (const zone of result.zones) {
    const geofence: GeoFence = zone.geofence_type === "circle"
      ? {
          type: "circle",
          radius: zone.geofence.circle!.radius_m,
          lat: zone.geofence.circle!.lat,
          lon: zone.geofence.circle!.lon,
        }
      : {
          type: "polygon",
          points: zone.geofence.polygon!.points,
        };

    // Map network to a network ID (these must match the Wizard's network definitions)
    let networkId = "geodnet"; // default
    if (zone.network === "onocoy") networkId = "onocoy";
    else if (zone.network === "multi") networkId = "geodnet"; // Primary network for multi

    const wizardZone: Zone = {
      id: zone.id,
      name: zone.name,
      networkId,
      enabled: zone.enabled,
      geofence,
      color: zone.zone_tier === "full_rtk" ? "#22c55e" : zone.zone_tier === "degraded_rtk" ? "#eab308" : "#f97316",
      priority: zone.priority,
    };

    wizardZones[zone.id] = wizardZone;
  }

  // Persist merged zones to wizard data directory
  try {
    const wizardDir = path.join(dataDir, "wizard");
    if (!fs.existsSync(wizardDir)) fs.mkdirSync(wizardDir, { recursive: true });
    const zonesPath = path.join(wizardDir, "zones.json");
    const tmp = zonesPath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(wizardZones, null, 2));
    fs.renameSync(tmp, zonesPath);
  } catch {}

  return wizardZones;
}

/**
 * Generate a summary of zone changes for the Fence Generator.
 */
export function summarizeZoneChanges(
  newZones: ZoneBuildResult,
  dataDir: string
): { added: string[]; removed: string[]; updated: string[] } {
  const added: string[] = [];
  const removed: string[] = [];
  const updated: string[] = [];

  try {
    const prevPath = path.join(dataDir, "zone-build-prev.json");
    if (fs.existsSync(prevPath)) {
      const prev: ZoneBuildResult = JSON.parse(fs.readFileSync(prevPath, "utf-8"));
      const prevIds = new Set(prev.zones.map(z => z.id));
      const newIds = new Set(newZones.zones.map(z => z.id));

      for (const z of newZones.zones) {
        if (!prevIds.has(z.id)) added.push(z.name);
      }
      for (const z of prev.zones) {
        if (!newIds.has(z.id)) removed.push(z.name);
      }
      // Updated = zones in both but with different quality
      for (const z of newZones.zones) {
        if (prevIds.has(z.id)) {
          const prevZone = prev.zones.find(p => p.id === z.id);
          if (prevZone && Math.abs(prevZone.avg_quality - z.avg_quality) > 0.05) {
            updated.push(z.name);
          }
        }
      }
    }

    // Save current as prev for next comparison
    const buildPath = path.join(dataDir, "zone-build.json");
    if (fs.existsSync(buildPath)) {
      fs.copyFileSync(buildPath, path.join(dataDir, "zone-build-prev.json"));
    }
  } catch {}

  return { added, removed, updated };
}
