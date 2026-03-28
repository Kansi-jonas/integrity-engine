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
import type { ZoneBuildV2Result, OverlayZone } from "./zone-builder-v2";
import fs from "fs";
import path from "path";

/**
 * Convert Zone Builder V2 result to Wizard Zone format for Config Engine.
 * Handles both V1 (result.zones) and V2 (result.overlays) formats.
 */
export function convertZonesToWizard(
  result: any, // Accept any format (V1 or V2)
  dataDir: string
): Record<string, Zone> {
  const wizardZones: Record<string, Zone> = {};

  // Load existing manual zones (preserve user-created zones)
  try {
    const wizardDir = path.join(dataDir, "wizard");
    const zonesPath = path.join(wizardDir, "zones.json");
    if (fs.existsSync(zonesPath)) {
      const existing = JSON.parse(fs.readFileSync(zonesPath, "utf-8"));
      for (const [key, zone] of Object.entries(existing)) {
        const z = zone as any;
        if (z.manual_override || z.source === "manual") {
          wizardZones[key] = z;
        }
      }
    }
  } catch {}

  // Detect format: V2 has .overlays, V1 has .zones
  const zones: any[] = result.overlays || result.zones || [];

  // Convert each zone/overlay
  for (const zone of zones) {
    // V2 overlay format: circle geofences with lat/lon/radius_m
    const geofence: GeoFence = zone.geofence_type === "circle" || zone.lat
      ? {
          type: "circle",
          radius: zone.radius_m || zone.geofence?.circle?.radius_m || 35000,
          lat: zone.lat || zone.geofence?.circle?.lat || 0,
          lon: zone.lon || zone.geofence?.circle?.lon || 0,
        }
      : zone.geofence_type === "polygon"
      ? {
          type: "polygon",
          points: zone.geofence?.polygon?.points || [],
        }
      : { type: "circle", radius: 35000, lat: 0, lon: 0 };

    // Map network to a network ID (these must match the Wizard's network definitions)
    // V2 overlays: all overlays ARE ONOCOY (type = onocoy_primary or onocoy_failover)
    // V1 zones: use zone.network field
    let networkId = "geodnet"; // default
    if (zone.network === "onocoy" || zone.type?.startsWith("onocoy") || zone.onocoy_station) {
      networkId = "onocoy";
    } else if (zone.network === "multi") {
      networkId = "geodnet"; // Primary network for multi
    }

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
  newZones: any,
  dataDir: string
): { added: string[]; removed: string[]; updated: string[] } {
  const added: string[] = [];
  const removed: string[] = [];
  const updated: string[] = [];

  try {
    const prevPath = path.join(dataDir, "zone-build-prev.json");
    if (fs.existsSync(prevPath)) {
      const prev: any = JSON.parse(fs.readFileSync(prevPath, "utf-8"));
      const prevList: any[] = prev.overlays || prev.zones || [];
      const newList: any[] = newZones.overlays || newZones.zones || [];
      const prevIds = new Set(prevList.map((z: any) => z.id));
      const newIds = new Set(newList.map((z: any) => z.id));

      for (const z of newList) {
        if (!prevIds.has(z.id)) added.push(z.name || z.onocoy_station);
      }
      for (const z of prevList) {
        if (!newIds.has(z.id)) removed.push(z.name || z.onocoy_station);
      }
      for (const z of newList) {
        if (prevIds.has(z.id)) {
          const prevZone = prevList.find((p: any) => p.id === z.id);
          const prevQ = prevZone?.avg_quality ?? prevZone?.onocoy_confidence ?? 0;
          const newQ = z.avg_quality ?? z.onocoy_confidence ?? 0;
          if (Math.abs(prevQ - newQ) > 0.05) {
            updated.push(z.name || z.onocoy_station);
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
