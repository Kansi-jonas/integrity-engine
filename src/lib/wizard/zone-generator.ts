// ─── Intelligent Zone Generator ──────────────────────────────────────────────
// Creates optimal zones from GEODNET + ONOCOY stations using integrity data.
//
// Logic:
// 1. Start with ALL qualified stations (from Config Generator)
// 2. GEODNET is primary network — zones for all GEODNET coverage areas
// 3. ONOCOY zones ONLY where:
//    a. No GEODNET station within 40km (gap fill)
//    b. ONOCOY station has higher trust than nearest GEODNET (quality upgrade)
// 4. Cascade priorities from TRUST V2 composite scores
// 5. Exclude areas with active SHIELD interference events
// 6. Zone boundaries from station clustering (DBSCAN-based)
//
// Output: zones.json ready for config-engine to generate ntrips.cfg

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { WIZARD_DATA_DIR } from "./data-dir";

// ─── Types ───────────────────────────────────────────────────────────────────

interface StationForZoning {
  name: string;
  lat: number;
  lon: number;
  network: string;
  trust: number;
  uq: number;
  tier: "platinum" | "gold" | "silver";
  cascadePriority: number;
}

interface GeneratedZone {
  id: string;
  name: string;
  network_id: string;
  enabled: boolean;
  geofence: {
    type: "circle" | "polygon";
    radius?: number;
    lat?: number;
    lon?: number;
    points?: [number, number][];
  };
  color: string;
  priority: number;
  stations: string[];
  zone_type: "geodnet_primary" | "onocoy_gap" | "onocoy_upgrade" | "overlap_prefer_geodnet" | "overlap_prefer_onocoy";
  integrity_score: number;
}

// ─── Config ──────────────────────────────────────────────────────────────────

const GEODNET_GAP_KM = 40;          // ONOCOY zone only if no GEODNET within this range
const ONOCOY_UPGRADE_TRUST_DIFF = 0.15; // ONOCOY must be 0.15+ better trust to upgrade
const CLUSTER_RANGE_KM = 200;       // Max range for station clustering
const BUFFER_KM = 50;               // Buffer around station clusters for zone polygons
const MAX_POLYGON_POINTS = 40;      // Alberding limit

// Network IDs (must match wizard networks.json)
const GEODNET_NETWORK_ID = "net_geodnet";
const ONOCOY_NETWORK_ID = "net_onocoy";

// ─── Haversine ───────────────────────────────────────────────────────────────

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── Convex Hull (Graham Scan) ──────────────────────────────────────────────

function convexHull(points: [number, number][]): [number, number][] {
  if (points.length <= 3) return points;

  // Find bottom-most (then left-most) point
  let lowest = 0;
  for (let i = 1; i < points.length; i++) {
    if (points[i][0] < points[lowest][0] || (points[i][0] === points[lowest][0] && points[i][1] < points[lowest][1])) {
      lowest = i;
    }
  }
  [points[0], points[lowest]] = [points[lowest], points[0]];

  const pivot = points[0];
  const sorted = points.slice(1).sort((a, b) => {
    const angleA = Math.atan2(a[0] - pivot[0], a[1] - pivot[1]);
    const angleB = Math.atan2(b[0] - pivot[0], b[1] - pivot[1]);
    return angleA - angleB;
  });

  const stack: [number, number][] = [pivot, sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    while (stack.length > 1) {
      const top = stack[stack.length - 1];
      const below = stack[stack.length - 2];
      const cross = (top[1] - below[1]) * (sorted[i][0] - below[0]) - (top[0] - below[0]) * (sorted[i][1] - below[1]);
      if (cross <= 0) stack.pop();
      else break;
    }
    stack.push(sorted[i]);
  }

  return stack;
}

// ─── Buffer Polygon (expand by km) ──────────────────────────────────────────

function bufferPoints(points: [number, number][], bufferKm: number): [number, number][] {
  // Simple approach: expand each point outward from centroid
  const centLat = points.reduce((s, p) => s + p[0], 0) / points.length;
  const centLon = points.reduce((s, p) => s + p[1], 0) / points.length;

  return points.map(([lat, lon]) => {
    const dLat = lat - centLat;
    const dLon = lon - centLon;
    const dist = Math.sqrt(dLat * dLat + dLon * dLon);
    if (dist === 0) return [lat + bufferKm / 111, lon] as [number, number];
    const scale = 1 + (bufferKm / 111) / dist;
    return [centLat + dLat * scale, centLon + dLon * scale] as [number, number];
  });
}

// ─── Simplify Polygon ───────────────────────────────────────────────────────

function simplifyPolygon(points: [number, number][], maxPoints: number): [number, number][] {
  if (points.length <= maxPoints) return points;
  const step = Math.ceil(points.length / maxPoints);
  const result: [number, number][] = [];
  for (let i = 0; i < points.length; i += step) {
    result.push(points[i]);
  }
  return result;
}

// ─── DBSCAN Clustering ──────────────────────────────────────────────────────

function clusterStations(stations: StationForZoning[], rangeKm: number, minPts: number): number[] {
  const labels = new Array(stations.length).fill(-1);
  let clusterId = 0;

  for (let i = 0; i < stations.length; i++) {
    if (labels[i] !== -1) continue;
    const neighbors: number[] = [];
    for (let j = 0; j < stations.length; j++) {
      if (i === j) continue;
      if (haversineKm(stations[i].lat, stations[i].lon, stations[j].lat, stations[j].lon) <= rangeKm) {
        neighbors.push(j);
      }
    }
    if (neighbors.length < minPts) continue;

    labels[i] = clusterId;
    const queue = [...neighbors];
    const visited = new Set([i]);

    while (queue.length > 0) {
      const idx = queue.shift()!;
      if (visited.has(idx)) continue;
      visited.add(idx);
      labels[idx] = clusterId;
      for (let j = 0; j < stations.length; j++) {
        if (visited.has(j)) continue;
        if (haversineKm(stations[idx].lat, stations[idx].lon, stations[j].lat, stations[j].lon) <= rangeKm) {
          queue.push(j);
        }
      }
    }
    clusterId++;
  }

  return labels;
}

// ─── Region Name ─────────────────────────────────────────────────────────────

function regionName(lat: number, lon: number): string {
  if (lat > 55 && lon > -10 && lon < 35) return "Northern Europe";
  if (lat > 35 && lat <= 55 && lon > -10 && lon < 25) return "Central Europe";
  if (lat > 35 && lat <= 55 && lon >= 25 && lon < 45) return "Eastern Europe";
  if (lat > 35 && lon > -25 && lon <= -10) return "Western Europe";
  if (lat > 25 && lat <= 50 && lon > -130 && lon < -60) return "North America";
  if (lat > -60 && lat <= 10 && lon > -85 && lon < -30) return "South America";
  if (lat > -50 && lat <= -10 && lon > 110 && lon < 180) return "Australia";
  if (lat > 0 && lat <= 60 && lon > 60 && lon < 150) return "Asia";
  if (lat > -40 && lat <= 35 && lon > -20 && lon < 55) return "Africa";
  return "Global";
}

// ─── Main Zone Generation ────────────────────────────────────────────────────

export function generateIntegrityZones(db: Database.Database, dataDir: string): GeneratedZone[] {
  // ── 1. Load qualified stations ────────────────────────────────────────────

  let qualifiedStations: StationForZoning[] = [];
  try {
    const qPath = path.join(dataDir, "qualified-stations.json");
    if (fs.existsSync(qPath)) {
      const qd = JSON.parse(fs.readFileSync(qPath, "utf-8"));
      qualifiedStations = (qd.qualified || []).map((s: any) => ({
        name: s.name,
        lat: s.latitude,
        lon: s.longitude,
        network: s.network,
        trust: s.composite_score || 0,
        uq: s.uq_score || 0,
        tier: s.quality_tier || "silver",
        cascadePriority: s.cascade_priority || 50,
      }));
    }
  } catch {}

  if (qualifiedStations.length === 0) {
    // Fallback: load from DB directly
    const rows = db.prepare(`
      SELECT s.name, s.latitude, s.longitude, COALESCE(s.network, 'unknown') as network,
             COALESCE(ss.uq_score, 0.5) as uq
      FROM stations s
      LEFT JOIN station_scores ss ON s.name = ss.station_name
      WHERE s.latitude IS NOT NULL AND ABS(s.latitude) > 0.1
    `).all() as any[];
    qualifiedStations = rows.map((r: any) => ({
      name: r.name, lat: r.latitude, lon: r.longitude,
      network: r.network, trust: 0.5, uq: r.uq,
      tier: "silver" as const, cascadePriority: 50,
    }));
  }

  // ── 2. Separate by network ────────────────────────────────────────────────

  const geodnet = qualifiedStations.filter(s => s.network === "geodnet");
  const onocoy = qualifiedStations.filter(s => s.network === "onocoy");

  // ── 3. Load active interference zones (SHIELD) ────────────────────────────

  const interferenceZones: Array<{ lat: number; lon: number; radius_km: number }> = [];
  try {
    const shPath = path.join(dataDir, "shield-events.json");
    if (fs.existsSync(shPath)) {
      const sh = JSON.parse(fs.readFileSync(shPath, "utf-8"));
      const recent = (sh.events || []).filter((e: any) => {
        const age = Date.now() - new Date(e.start_time).getTime();
        return age < 2 * 3600000 && e.severity === "critical" && e.region;
      });
      for (const e of recent) {
        interferenceZones.push({ lat: e.region.lat, lon: e.region.lon, radius_km: e.region.radius_km });
      }
    }
  } catch {}

  // ── 4. Check if station is in interference zone ───────────────────────────

  function isInInterference(lat: number, lon: number): boolean {
    for (const iz of interferenceZones) {
      if (haversineKm(lat, lon, iz.lat, iz.lon) <= iz.radius_km) return true;
    }
    return false;
  }

  // ── 5. Classify ONOCOY stations ───────────────────────────────────────────

  const onocoyClassified: Array<StationForZoning & { zoneType: "onocoy_gap" | "onocoy_upgrade" | "skip" }> = [];

  for (const ono of onocoy) {
    if (isInInterference(ono.lat, ono.lon)) continue;

    // Find nearest GEODNET station
    let nearestDist = Infinity;
    let nearestTrust = 0;
    for (const geo of geodnet) {
      const dist = haversineKm(ono.lat, ono.lon, geo.lat, geo.lon);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearestTrust = geo.trust;
      }
    }

    if (nearestDist > GEODNET_GAP_KM) {
      // Gap fill: no GEODNET coverage here
      onocoyClassified.push({ ...ono, zoneType: "onocoy_gap" });
    } else if (ono.trust > nearestTrust + ONOCOY_UPGRADE_TRUST_DIFF) {
      // Quality upgrade: ONOCOY has significantly better trust
      onocoyClassified.push({ ...ono, zoneType: "onocoy_upgrade" });
    } else {
      onocoyClassified.push({ ...ono, zoneType: "skip" });
    }
  }

  const onocoyForZoning = onocoyClassified.filter(o => o.zoneType !== "skip");

  // ── 6. Cluster ONOCOY stations into zones ─────────────────────────────────

  const zones: GeneratedZone[] = [];

  if (onocoyForZoning.length > 0) {
    const labels = clusterStations(onocoyForZoning, CLUSTER_RANGE_KM, 1);

    const clusters = new Map<number, typeof onocoyForZoning>();
    for (let i = 0; i < labels.length; i++) {
      const label = labels[i] === -1 ? 1000 + i : labels[i]; // Treat noise as single-station clusters
      if (!clusters.has(label)) clusters.set(label, []);
      clusters.get(label)!.push(onocoyForZoning[i]);
    }

    for (const [clusterId, stations] of clusters) {
      if (stations.length === 0) continue;

      // Determine zone type (majority vote)
      const gapCount = stations.filter(s => s.zoneType === "onocoy_gap").length;
      const zoneType = gapCount > stations.length / 2 ? "onocoy_gap" : "onocoy_upgrade";

      // Centroid
      const centLat = stations.reduce((s, st) => s + st.lat, 0) / stations.length;
      const centLon = stations.reduce((s, st) => s + st.lon, 0) / stations.length;
      const region = regionName(centLat, centLon);

      // Average trust for priority
      const avgTrust = stations.reduce((s, st) => s + st.trust, 0) / stations.length;
      const priority = zoneType === "onocoy_gap" ? 10 : 30; // Gap fills get higher priority

      // Geofence
      let geofence: GeneratedZone["geofence"];
      if (stations.length === 1) {
        // Single station → circle
        geofence = {
          type: "circle",
          lat: stations[0].lat,
          lon: stations[0].lon,
          radius: BUFFER_KM * 1000,
        };
      } else {
        // Multiple stations → convex hull + buffer
        const points = stations.map(s => [s.lat, s.lon] as [number, number]);
        const hull = convexHull(points);
        const buffered = bufferPoints(hull, BUFFER_KM);
        const simplified = simplifyPolygon(buffered, MAX_POLYGON_POINTS);
        geofence = { type: "polygon", points: simplified };
      }

      const zoneId = `integrity_ono_${clusterId}`;
      zones.push({
        id: zoneId,
        name: `${region} — ONOCOY ${zoneType === "onocoy_gap" ? "Gap Fill" : "Upgrade"} (${stations.length} stations)`,
        network_id: ONOCOY_NETWORK_ID,
        enabled: true,
        geofence,
        color: zoneType === "onocoy_gap" ? "#3b82f6" : "#8b5cf6",
        priority,
        stations: stations.map(s => s.name),
        zone_type: zoneType,
        integrity_score: Math.round(avgTrust * 100),
      });
    }
  }

  // ── 7. GEODNET global zone (always-on, highest priority) ──────────────────
  // GEODNET doesn't need geofenced zones — it's the primary network with global AUTO mountpoint
  // But we add a virtual "global" zone for tracking purposes

  if (geodnet.length > 0) {
    const avgGeoTrust = geodnet.reduce((s, st) => s + st.trust, 0) / geodnet.length;
    zones.unshift({
      id: "integrity_geodnet_global",
      name: `GEODNET Global (${geodnet.length} qualified stations)`,
      network_id: GEODNET_NETWORK_ID,
      enabled: true,
      geofence: { type: "circle", lat: 0, lon: 0, radius: 20000000 }, // Global
      color: "#22c55e",
      priority: 1, // Highest priority
      stations: geodnet.map(s => s.name),
      zone_type: "geodnet_primary",
      integrity_score: Math.round(avgGeoTrust * 100),
    });
  }

  // ── 8. Write to wizard data dir ───────────────────────────────────────────

  try {
    if (!fs.existsSync(WIZARD_DATA_DIR)) fs.mkdirSync(WIZARD_DATA_DIR, { recursive: true });

    // Convert to wizard zones.json format
    const wizardZones: Record<string, any> = {};
    for (const z of zones) {
      wizardZones[z.id] = {
        id: z.id,
        name: z.name,
        network_id: z.network_id,
        enabled: z.enabled,
        geofence: z.geofence,
        color: z.color,
        priority: z.priority,
      };
    }

    const zonesPath = path.join(WIZARD_DATA_DIR, "zones.json");
    // Merge with existing zones (keep manual zones, update integrity zones)
    let existing: Record<string, any> = {};
    try {
      if (fs.existsSync(zonesPath)) {
        existing = JSON.parse(fs.readFileSync(zonesPath, "utf-8"));
      }
    } catch {}

    // Remove old integrity zones, keep manual ones
    const merged: Record<string, any> = {};
    for (const [k, v] of Object.entries(existing)) {
      if (!k.startsWith("integrity_")) merged[k] = v;
    }
    // Add new integrity zones
    for (const [k, v] of Object.entries(wizardZones)) {
      merged[k] = v;
    }

    const tmp = zonesPath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2));
    fs.renameSync(tmp, zonesPath);
  } catch (err) {
    console.error("[ZONE-GEN] Failed to write zones:", err);
  }

  // Also persist the full zone report
  try {
    const reportPath = path.join(dataDir, "zone-generation.json");
    const tmp = reportPath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({
      zones,
      stats: {
        total_zones: zones.length,
        geodnet_zones: zones.filter(z => z.zone_type === "geodnet_primary").length,
        onocoy_gap_zones: zones.filter(z => z.zone_type === "onocoy_gap").length,
        onocoy_upgrade_zones: zones.filter(z => z.zone_type === "onocoy_upgrade").length,
        total_stations: qualifiedStations.length,
        geodnet_stations: geodnet.length,
        onocoy_stations: onocoyForZoning.length,
        onocoy_skipped: onocoy.length - onocoyForZoning.length,
        interference_zones_active: interferenceZones.length,
      },
      generated_at: new Date().toISOString(),
    }));
    fs.renameSync(tmp, reportPath);
  } catch {}

  return zones;
}
