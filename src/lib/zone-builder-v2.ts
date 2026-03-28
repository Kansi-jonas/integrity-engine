// ─── Zone Builder V3 — Survey-Grade Only, Data-Driven ─────────────────────────
//
// Architecture:
//
// 1. ONE global GEODNET zone (no geofence = worldwide, priority 10)
//    → Every user gets GEODNET as default, AUTO/NRBY_ADV finds nearest station
//
// 2. ONOCOY overlay circles ONLY where:
//    a) GEODNET has a gap (quality < 55% or absent > 40km) — MANDATORY
//    b) ONOCOY station is Survey-Grade (confidence ≥ 0.70) → Primary (priority 5)
//    c) ONOCOY station is Professional/Consumer + confirmed → Failover (priority 30)
//
// 3. Individual circles per station (max 45km) — NO mega-polygons
//    → Dedup only at < 5km (same physical location)
//
// 4. Data-driven expansion: Session feedback confirms/rejects stations over time
//
// Result: ~200-400 precise circles in GEODNET gaps only.

import Database from "better-sqlite3";
import * as h3 from "h3-js";
import fs from "fs";
import path from "path";
import { haversineKm } from "./spatial/variogram";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface OverlayZone {
  id: string;
  name: string;
  type: "onocoy_primary" | "onocoy_failover";
  reason: "geodnet_poor" | "geodnet_absent" | "onocoy_better" | "gap_fill";
  priority: number;          // 5 = ONOCOY primary, 30 = ONOCOY failover
  geofence_type: "circle" | "polygon";
  lat: number;
  lon: number;
  radius_m: number;
  polygon_points?: [number, number][];  // For merged polygon geofences
  onocoy_station: string;
  hardware_class: string;
  geodnet_quality: number;   // 0-1, nearest GEODNET quality
  onocoy_confidence: number; // 0-1, how confident we are in ONOCOY
  validation_status: string;
  enabled: boolean;
}

export interface ZoneBuildV2Result {
  global_geodnet: {
    enabled: boolean;
    priority: number;
    mountpoint: string;
  };
  overlays: OverlayZone[];
  stats: {
    total_overlays: number;
    onocoy_primary: number;
    onocoy_failover: number;
    geodnet_poor_regions: number;
    geodnet_absent_regions: number;
    onocoy_confirmed: number;
    estimated_config_lines: number;
  };
  computed_at: string;
}

// ─── Configuration ───────────────────────────────────────────────────────────

const GEODNET_POOR_THRESHOLD = 0.55;     // Quality below this = "poor"
const GEODNET_ABSENT_KM = 40;            // No GEODNET within this = "absent"
const MAX_OVERLAYS = 500;                // Practical limit for config performance
const DEFAULT_OVERLAY_RADIUS_M = 35000;  // 35km default radius
const MIN_OVERLAY_RADIUS_M = 15000;      // 15km minimum
const MAX_OVERLAY_RADIUS_M = 45000;      // 45km max (RTK-physikalisch korrekt)
const DEDUP_DISTANCE_KM = 5;            // Stations closer than this = same location

// Hardware confidence thresholds
const SURVEY_GRADE_MIN_CONFIDENCE = 0.70;  // survey_grade + inferred (0.75) pass this
const PROFESSIONAL_MIN_CONFIDENCE = 0.65;  // professional_inferred (0.65) passes
const CONSUMER_MIN_CONFIDENCE = 0.50;      // only confirmed consumers

// Gap thresholds for non-survey-grade
const PROFESSIONAL_MIN_GAP_KM = 60;       // Professional only in large gaps
const CONSUMER_MIN_GAP_KM = 80;           // Consumer only in very large gaps + confirmed

// Priorities (Alberding: lower number = higher priority = matched first)
const PRI_ONOCOY_PRIMARY = 5;    // ONOCOY is PRIMARY (matched before GEODNET global)
const PRI_GEODNET_GLOBAL = 10;   // GEODNET global fallback
const PRI_ONOCOY_FAILOVER = 30;  // ONOCOY as backup only

// Survey-grade hardware brands
const SURVEY_GRADE = ["LEICA", "TRIMBLE", "SEPT", "SEPTENTRIO", "NOVATEL", "JAVAD", "TOPCON", "SOKKIA", "CHCNAV", "CHC", "GEOPP", "GEO++"];

// ─── Core Function ──────────────────────────────────────────────────────────

export function buildZonesV2(db: Database.Database, dataDir: string): ZoneBuildV2Result {
  const geodnetStations = loadGeonetWithQuality(db);
  const onocoyStations = loadOnocoyWithHardware(db);
  const validationState = loadValidationState(dataDir);
  const qualityCells = loadQualityCells(db);

  const overlays: OverlayZone[] = [];
  let overlayIdx = 0;

  // ── Strategy 1: Survey-Grade ONOCOY in GEODNET gaps ────────────────
  // ONLY where GEODNET is poor (<55%) or absent (>40km)
  for (const ono of onocoyStations) {
    if (ono.hardware_confidence < SURVEY_GRADE_MIN_CONFIDENCE) continue;
    if (!ono.hardware_class.includes("survey_grade")) continue;

    const nearestGeo = findNearestGeonet(ono.latitude, ono.longitude, geodnetStations);
    const geoQuality = nearestGeo ? getRegionalQuality(ono.latitude, ono.longitude, qualityCells) : 0;
    const geoDist = nearestGeo ? nearestGeo.dist : 999;

    const validation = validationState.get(ono.name);
    if (validation?.status === "rejected") continue;

    // ── KEY FILTER: GEODNET must be truly ABSENT (>40km) ──────────
    // "Poor quality" is not enough — GEODNET within 40km still works.
    // Only create ONOCOY overlay where there is NO GEODNET at all.
    let reason: OverlayZone["reason"] | null = null;
    let priority = PRI_ONOCOY_FAILOVER;

    if (geoDist > GEODNET_ABSENT_KM) {
      reason = "geodnet_absent";
      priority = PRI_ONOCOY_PRIMARY;
    } else if (validation?.status === "confirmed" && (validation.fix_rate || 0) > 75) {
      // Live-validated: ONOCOY proven better than nearby GEODNET
      reason = "onocoy_better";
      priority = PRI_ONOCOY_PRIMARY;
    } else {
      // GEODNET is within 40km — skip
      continue;
    }

    let confidence = ono.hardware_confidence;
    if (validation?.status === "confirmed") confidence = Math.max(confidence, 0.9);

    // Radius: max 45km, scaled by gap size
    const radiusM = Math.round(Math.min(MAX_OVERLAY_RADIUS_M, Math.max(MIN_OVERLAY_RADIUS_M, geoDist * 600)));

    overlayIdx++;
    overlays.push({
      id: `ono_${overlayIdx}`,
      name: `ONOCOY ${getRegionName(ono.latitude, ono.longitude)} #${overlayIdx}`,
      type: priority === PRI_ONOCOY_PRIMARY ? "onocoy_primary" : "onocoy_failover",
      reason: reason!,
      priority,
      geofence_type: "circle",
      lat: Math.round(ono.latitude * 1e6) / 1e6,
      lon: Math.round(ono.longitude * 1e6) / 1e6,
      radius_m: radiusM,
      onocoy_station: ono.name,
      hardware_class: ono.hardware_class,
      geodnet_quality: Math.round(geoQuality * 100) / 100,
      onocoy_confidence: Math.round(confidence * 100) / 100,
      validation_status: validation?.status || "untested",
      enabled: true,
    });
  }

  const surveyCount = overlays.length;

  // ── Strategy 2: Professional in large GEODNET gaps (>60km) ─────────
  for (const ono of onocoyStations) {
    if (ono.hardware_class === "survey_grade" || ono.hardware_class.includes("survey_grade")) continue;
    if (ono.hardware_confidence < PROFESSIONAL_MIN_CONFIDENCE) continue;

    const nearestGeo = findNearestGeonet(ono.latitude, ono.longitude, geodnetStations);
    const geoDist = nearestGeo ? nearestGeo.dist : 999;
    if (geoDist <= PROFESSIONAL_MIN_GAP_KM) continue;

    const validation = validationState.get(ono.name);
    if (validation?.status === "rejected") continue;

    overlayIdx++;
    overlays.push({
      id: `ono_${overlayIdx}`,
      name: `ONOCOY Pro ${getRegionName(ono.latitude, ono.longitude)} #${overlayIdx}`,
      type: "onocoy_failover",
      reason: "geodnet_absent",
      priority: validation?.status === "confirmed" ? PRI_ONOCOY_PRIMARY : PRI_ONOCOY_FAILOVER,
      geofence_type: "circle",
      lat: Math.round(ono.latitude * 1e6) / 1e6,
      lon: Math.round(ono.longitude * 1e6) / 1e6,
      radius_m: Math.round(Math.min(MAX_OVERLAY_RADIUS_M, Math.max(MIN_OVERLAY_RADIUS_M, geoDist * 400))),
      onocoy_station: ono.name,
      hardware_class: ono.hardware_class,
      geodnet_quality: 0,
      onocoy_confidence: Math.round(ono.hardware_confidence * 100) / 100,
      validation_status: validation?.status || "untested",
      enabled: true,
    });
  }

  // ── Strategy 3: Consumer ONLY if confirmed + very large gap (>80km) ─
  for (const ono of onocoyStations) {
    if (ono.hardware_class.includes("survey_grade") || ono.hardware_class === "professional") continue;
    if (ono.hardware_confidence < CONSUMER_MIN_CONFIDENCE) continue;

    const nearestGeo = findNearestGeonet(ono.latitude, ono.longitude, geodnetStations);
    const geoDist = nearestGeo ? nearestGeo.dist : 999;
    if (geoDist <= CONSUMER_MIN_GAP_KM) continue;

    const validation = validationState.get(ono.name);
    if (!validation || validation.status !== "confirmed") continue; // Consumer must be confirmed

    overlayIdx++;
    overlays.push({
      id: `ono_${overlayIdx}`,
      name: `ONOCOY Consumer ${getRegionName(ono.latitude, ono.longitude)} #${overlayIdx}`,
      type: "onocoy_failover",
      reason: "geodnet_absent",
      priority: PRI_ONOCOY_FAILOVER,
      geofence_type: "circle",
      lat: Math.round(ono.latitude * 1e6) / 1e6,
      lon: Math.round(ono.longitude * 1e6) / 1e6,
      radius_m: Math.min(25000, Math.max(MIN_OVERLAY_RADIUS_M, geoDist * 300)), // Consumer capped at 25km
      onocoy_station: ono.name,
      hardware_class: ono.hardware_class,
      geodnet_quality: 0,
      onocoy_confidence: 0.6,
      validation_status: "confirmed",
      enabled: true,
    });
  }

  console.log(`[ZONE-V3] Generated ${overlays.length} overlays (${surveyCount} survey-grade, ${overlays.length - surveyCount} professional/consumer)`);

  // ── Dedup: remove stations at same location (<5km) ────────────────
  const deduped = deduplicateNearby(overlays);
  if (deduped.length < overlays.length) {
    console.log(`[ZONE-V3] Dedup: ${overlays.length} → ${deduped.length} (${overlays.length - deduped.length} duplicates removed)`);
  }

  // ── Overlap Merge: overlapping circles → convex hull polygon ──────
  // PhD rationale: NRBY_ADV auto-selects best station — geofence is just
  // an activation zone. Dense areas (AU, NA) get 1 polygon instead of 400 circles.
  // Isolated stations in small gaps keep their individual circles.
  const merged = mergeOverlappingCircles(deduped);
  console.log(`[ZONE-V3] Overlap merge: ${deduped.length} → ${merged.length} zones`);

  // ── Safety cap ────────────────────────────────────────────────────
  let finalOverlays = merged;
  if (finalOverlays.length > MAX_OVERLAYS) {
    finalOverlays.sort((a, b) => a.priority - b.priority || b.onocoy_confidence - a.onocoy_confidence);
    finalOverlays = finalOverlays.slice(0, MAX_OVERLAYS);
    console.log(`[ZONE-V3] Capped at ${MAX_OVERLAYS} overlays`);
  }

  // Sort by priority then confidence
  finalOverlays.sort((a, b) => a.priority - b.priority || b.onocoy_confidence - a.onocoy_confidence);

  const result: ZoneBuildV2Result = {
    global_geodnet: {
      enabled: true,
      priority: PRI_GEODNET_GLOBAL,
      mountpoint: "AUTO",
    },
    overlays: finalOverlays,
    stats: {
      total_overlays: finalOverlays.length,
      onocoy_primary: finalOverlays.filter(z => z.type === "onocoy_primary").length,
      onocoy_failover: finalOverlays.filter(z => z.type === "onocoy_failover").length,
      geodnet_poor_regions: finalOverlays.filter(z => z.reason === "geodnet_poor").length,
      geodnet_absent_regions: finalOverlays.filter(z => z.reason === "geodnet_absent").length,
      onocoy_confirmed: finalOverlays.filter(z => z.validation_status === "confirmed").length,
      estimated_config_lines: 20 + finalOverlays.length * 3,
    },
    computed_at: new Date().toISOString(),
  };

  // Persist
  try {
    const filePath = path.join(dataDir, "zone-build-v2.json");
    const tmp = filePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(result, null, 2));
    fs.renameSync(tmp, filePath);
  } catch {}

  return result;
}

// ─── Dedup: stations at same physical location ──────────────────────────────

function deduplicateNearby(overlays: OverlayZone[]): OverlayZone[] {
  // Sort by confidence descending — keep the best at each location
  const sorted = [...overlays].sort((a, b) => b.onocoy_confidence - a.onocoy_confidence);
  const kept: OverlayZone[] = [];
  for (const o of sorted) {
    const tooClose = kept.some(k => haversineKm(k.lat, k.lon, o.lat, o.lon) < DEDUP_DISTANCE_KM);
    if (!tooClose) kept.push(o);
  }
  return kept;
}

// ─── Data Loading ────────────────────────────────────────────────────────────

interface GeoStation { name: string; latitude: number; longitude: number; uq_score: number; dist?: number }
interface OnoStation { name: string; latitude: number; longitude: number; hardware_class: string; hardware_confidence: number }

function loadGeonetWithQuality(db: Database.Database): GeoStation[] {
  try {
    return db.prepare(`
      SELECT s.name, s.latitude, s.longitude, COALESCE(sc.uq_score, 0.5) as uq_score
      FROM stations s
      LEFT JOIN station_scores sc ON s.name = sc.station_name
      WHERE s.latitude IS NOT NULL AND s.longitude IS NOT NULL
        AND s.status IN ('ONLINE', 'ACTIVE')
        AND (s.network IS NULL OR s.network = '' OR s.network = 'geodnet')
    `).all() as GeoStation[];
  } catch { return []; }
}

function loadOnocoyWithHardware(db: Database.Database): OnoStation[] {
  try {
    const rows = db.prepare(`
      SELECT name, latitude, longitude, COALESCE(receiver_type, '') as receiver
      FROM stations
      WHERE network = 'onocoy' AND latitude IS NOT NULL AND longitude IS NOT NULL
        AND status IN ('ONLINE', 'ACTIVE')
    `).all() as any[];

    return rows.map(r => {
      const recv = (r.receiver || r.name || "").toUpperCase();
      let hwClass: OnoStation["hardware_class"] = "unknown";
      let confidence = 0.2;

      // Exact brand match (from RTCM 1033 probe or name)
      for (const brand of SURVEY_GRADE) {
        if (recv.includes(brand)) { hwClass = "survey_grade"; confidence = 0.95; break; }
      }
      // Inferred from RTCM message types
      if (hwClass === "unknown") {
        if (recv.includes("SURVEY_GRADE_INFERRED")) { hwClass = "survey_grade"; confidence = 0.75; }
        else if (recv.includes("PROFESSIONAL_INFERRED")) { hwClass = "professional"; confidence = 0.65; }
        else if (recv.includes("CONSUMER_GOOD_INFERRED") || recv.includes("U-BLOX") || recv.includes("UBLOX") || recv.includes("F9P")) {
          hwClass = "consumer"; confidence = 0.5;
        }
        else if (recv.includes("CONSUMER_BASIC_INFERRED")) { hwClass = "consumer"; confidence = 0.3; }
      }

      return { name: r.name, latitude: r.latitude, longitude: r.longitude, hardware_class: hwClass, hardware_confidence: confidence };
    });
  } catch { return []; }
}

function findNearestGeonet(lat: number, lon: number, stations: GeoStation[]): (GeoStation & { dist: number }) | null {
  let nearest: (GeoStation & { dist: number }) | null = null;
  for (const s of stations) {
    const dist = haversineKm(lat, lon, s.latitude, s.longitude);
    if (!nearest || dist < nearest.dist) {
      nearest = { ...s, dist };
    }
  }
  return nearest;
}

function getRegionalQuality(lat: number, lon: number, cells: Array<{ lat: number; lon: number; quality: number }>): number {
  let sum = 0, count = 0;
  for (const c of cells) {
    if (haversineKm(lat, lon, c.lat, c.lon) <= 30) {
      sum += c.quality;
      count++;
    }
  }
  return count > 0 ? sum / count : 0;
}

function loadQualityCells(db: Database.Database): Array<{ lat: number; lon: number; quality: number }> {
  try {
    const rows = db.prepare(`SELECT h3_index, quality_score FROM quality_cells WHERE quality_score > 0 LIMIT 10000`).all() as any[];
    return rows.map(r => {
      try {
        const [lat, lon] = h3.cellToLatLng(r.h3_index);
        return { lat, lon, quality: r.quality_score };
      } catch { return { lat: 0, lon: 0, quality: 0 }; }
    }).filter(c => c.lat !== 0);
  } catch { return []; }
}

function loadValidationState(dataDir: string): Map<string, { status: string; fix_rate?: number }> {
  const map = new Map();
  try {
    const data = JSON.parse(fs.readFileSync(path.join(dataDir, "onocoy-validation.json"), "utf-8"));
    for (const [k, v] of Object.entries(data)) map.set(k, v);
  } catch {}
  return map;
}

function getRegionName(lat: number, lon: number): string {
  if (lat > 55 && lon > -10 && lon < 30) return "N-EU";
  if (lat > 45 && lat <= 55 && lon > -10 && lon < 20) return "C-EU";
  if (lat > 35 && lat <= 45 && lon > -10 && lon < 20) return "S-EU";
  if (lat > 25 && lat <= 55 && lon > -130 && lon < -60) return "N-AM";
  if (lat > -45 && lat <= -10 && lon > 110 && lon < 180) return "AU";
  if (lat > 20 && lat <= 50 && lon > 60 && lon < 140) return "Asia";
  return `${Math.round(lat)}N${Math.round(lon)}E`;
}

// ─── Overlap-Based Circle Merging ────────────────────────────────────────────
// Union-Find on overlapping circles → convex hull polygon for dense clusters.
// Isolated circles stay as-is. Applied AFTER GEODNET-gap filter.

function mergeOverlappingCircles(overlays: OverlayZone[]): OverlayZone[] {
  if (overlays.length <= 3) return overlays;

  const n = overlays.length;
  const parent = new Int32Array(n);
  const ufRank = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;

  function find(x: number): number {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  }
  function union(a: number, b: number): void {
    const ra = find(a), rb = find(b);
    if (ra === rb) return;
    if (ufRank[ra] < ufRank[rb]) parent[ra] = rb;
    else if (ufRank[ra] > ufRank[rb]) parent[rb] = ra;
    else { parent[rb] = ra; ufRank[ra]++; }
  }

  // Spatial grid for O(n) overlap detection
  const GRID = 1.0; // ~110km cells
  const grid = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const gx = Math.floor(overlays[i].lon / GRID);
    const gy = Math.floor(overlays[i].lat / GRID);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const cell = grid.get(`${gx + dx},${gy + dy}`);
        if (cell) {
          for (const j of cell) {
            const dist = haversineKm(overlays[i].lat, overlays[i].lon, overlays[j].lat, overlays[j].lon);
            if (dist < (overlays[i].radius_m + overlays[j].radius_m) / 1000) union(i, j);
          }
        }
      }
    }
    const key = `${gx},${gy}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key)!.push(i);
  }

  // Group components
  const components = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!components.has(root)) components.set(root, []);
    components.get(root)!.push(i);
  }

  const result: OverlayZone[] = [];
  let mergeIdx = 0;

  for (const [, indices] of components) {
    const members = indices.map(i => overlays[i]);

    if (members.length === 1) {
      result.push(members[0]);
      continue;
    }

    // Check extent: if cluster spans > 300km, too big → keep as individual circles
    const lats = members.map(m => m.lat);
    const lons = members.map(m => m.lon);
    const extent = haversineKm(Math.min(...lats), Math.min(...lons), Math.max(...lats), Math.max(...lons));
    if (extent > 300) {
      // Too spread out — keep individual circles (prevents NL-to-Istanbul monster)
      result.push(...members);
      continue;
    }

    // Merge into convex hull polygon
    mergeIdx++;
    const points: [number, number][] = members.map(m => [m.lat, m.lon]);
    const hull = convexHullSimple(points);
    const cLat = members.reduce((s, m) => s + m.lat, 0) / members.length;
    const cLon = members.reduce((s, m) => s + m.lon, 0) / members.length;

    if (hull.length < 3) {
      // Collinear — circle around centroid
      const maxDist = Math.max(...members.map(m => haversineKm(cLat, cLon, m.lat, m.lon)));
      result.push({
        ...members[0],
        id: `ono_merged_${mergeIdx}`,
        name: `ONOCOY ${getRegionName(cLat, cLon)} (${members.length} stations)`,
        geofence_type: "circle",
        lat: Math.round(cLat * 1e6) / 1e6,
        lon: Math.round(cLon * 1e6) / 1e6,
        radius_m: Math.round(Math.min(MAX_OVERLAY_RADIUS_M, (maxDist + 45) * 1000)),
        polygon_points: undefined,
        onocoy_station: `${members.length} stations`,
        onocoy_confidence: Math.round(Math.max(...members.map(m => m.onocoy_confidence)) * 100) / 100,
        priority: Math.min(...members.map(m => m.priority)),
      });
      continue;
    }

    // Buffer hull outward by 45km (max RTK range from outermost station)
    const bufferedHull = hull.map(([lat, lon]) => {
      const dist = haversineKm(cLat, cLon, lat, lon);
      const scale = dist > 0 ? (dist + 45) / dist : 1;
      return [
        Math.round((cLat + (lat - cLat) * scale) * 1e5) / 1e5,
        Math.round((cLon + (lon - cLon) * scale) * 1e5) / 1e5,
      ] as [number, number];
    });

    result.push({
      id: `ono_merged_${mergeIdx}`,
      name: `ONOCOY ${getRegionName(cLat, cLon)} (${members.length} stations)`,
      type: Math.min(...members.map(m => m.priority)) <= 10 ? "onocoy_primary" : "onocoy_failover",
      reason: members[0].reason,
      priority: Math.min(...members.map(m => m.priority)),
      geofence_type: "polygon",
      lat: Math.round(cLat * 1e6) / 1e6,
      lon: Math.round(cLon * 1e6) / 1e6,
      radius_m: 0,
      polygon_points: bufferedHull,
      onocoy_station: `${members.length} stations`,
      hardware_class: members.find(m => m.hardware_class === "survey_grade")?.hardware_class || members[0].hardware_class,
      geodnet_quality: Math.round(members.reduce((s, m) => s + m.geodnet_quality, 0) / members.length * 100) / 100,
      onocoy_confidence: Math.round(Math.max(...members.map(m => m.onocoy_confidence)) * 100) / 100,
      validation_status: members.some(m => m.validation_status === "confirmed") ? "confirmed" : "untested",
      enabled: true,
    });
  }

  return result;
}

// Graham scan convex hull
function convexHullSimple(points: [number, number][]): [number, number][] {
  if (points.length <= 3) return points;
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const p0 = sorted[0];
  const rest = sorted.slice(1).sort((a, b) => {
    const aA = Math.atan2(a[0] - p0[0], a[1] - p0[1]);
    const aB = Math.atan2(b[0] - p0[0], b[1] - p0[1]);
    return aA - aB;
  });
  const stack: [number, number][] = [p0];
  for (const pt of rest) {
    while (stack.length > 1) {
      const top = stack[stack.length - 1], sec = stack[stack.length - 2];
      const cross = (top[1] - sec[1]) * (pt[0] - sec[0]) - (top[0] - sec[0]) * (pt[1] - sec[1]);
      if (cross <= 0) stack.pop(); else break;
    }
    stack.push(pt);
  }
  return stack;
}
