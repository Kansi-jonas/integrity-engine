// ─── Zone Builder V2 — Global + Overlay Architecture ─────────────────────────
//
// NEW ARCHITECTURE (from PhD caster config research):
//
// 1. ONE global GEODNET zone (no geofence = worldwide, priority 10)
//    → Every user gets GEODNET as default, AUTO/NRBY_ADV finds nearest station
//
// 2. ONOCOY overlay zones ONLY where:
//    a) GEODNET quality < 60% AND ONOCOY has survey-grade station → ONOCOY Primary (priority 5)
//    b) GEODNET absent (>40km gap) AND ONOCOY available → ONOCOY Primary (priority 5)
//    c) GEODNET OK but ONOCOY confirmed better (live validation) → ONOCOY Primary (priority 5)
//    d) ONOCOY available as failover → ONOCOY Failover (priority 30)
//
// Result: ~30-80 overlay zones instead of thousands. Config size: ~400 lines / 15KB.
// Alberding parses in <0.1s. Zero performance issues.
//
// The Global GEODNET zone is the ULTIMATE FALLBACK — it always matches.

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
  geofence_type: "circle";
  lat: number;
  lon: number;
  radius_m: number;
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

const GEODNET_POOR_THRESHOLD = 0.60;     // Quality below this = "poor"
const GEODNET_ABSENT_KM = 40;            // No GEODNET within this = "absent"
const ONOCOY_MIN_CONFIDENCE = 0.50;      // Minimum confidence to create overlay
const MAX_OVERLAYS = 200;                // Hard limit (well under Alberding 500)
const DEFAULT_OVERLAY_RADIUS_M = 35000;  // 35km default radius
const MIN_OVERLAY_RADIUS_M = 15000;      // 15km minimum
const MAX_OVERLAY_RADIUS_M = 80000;      // 80km maximum

// Priorities (Alberding: lower number = higher priority = matched first)
const PRI_ONOCOY_PRIMARY = 5;    // ONOCOY is PRIMARY (matched before GEODNET global)
const PRI_GEODNET_GLOBAL = 10;   // GEODNET global fallback
const PRI_ONOCOY_FAILOVER = 30;  // ONOCOY as backup only

// Survey-grade hardware brands (from onocoy-gapfill.ts)
const SURVEY_GRADE = ["LEICA", "TRIMBLE", "SEPT", "SEPTENTRIO", "NOVATEL", "JAVAD", "TOPCON", "SOKKIA", "CHCNAV", "CHC"];

// ─── Core Function ──────────────────────────────────────────────────────────

export function buildZonesV2(db: Database.Database, dataDir: string): ZoneBuildV2Result {
  // Load GEODNET stations with quality
  const geodnetStations = loadGeonetWithQuality(db);
  // Load ONOCOY stations with hardware info
  const onocoyStations = loadOnocoyWithHardware(db);
  // Load validation state (confirmed/rejected from live testing)
  const validationState = loadValidationState(dataDir);
  // Load trust scores
  const trustScores = loadTrustScores(dataDir);
  // Load H3 quality cells for regional quality assessment
  const qualityCells = loadQualityCells(db);

  const overlays: OverlayZone[] = [];
  let overlayIdx = 0;

  // ── Strategy 1: GEODNET Poor → ONOCOY Survey-Grade Primary ──────────
  for (const ono of onocoyStations) {
    if (ono.hardware_class !== "survey_grade") continue;

    // Find nearest GEODNET quality
    const nearestGeo = findNearestGeonet(ono.latitude, ono.longitude, geodnetStations);
    const geoQuality = nearestGeo ? getRegionalQuality(ono.latitude, ono.longitude, qualityCells) : 0;
    const geoDist = nearestGeo ? nearestGeo.dist : 999;

    let reason: OverlayZone["reason"] | null = null;
    let priority = PRI_ONOCOY_FAILOVER;

    // Check validation status
    const validation = validationState.get(ono.name);
    if (validation?.status === "rejected") continue;

    if (geoDist > GEODNET_ABSENT_KM) {
      // No GEODNET nearby — ONOCOY is primary
      reason = "geodnet_absent";
      priority = PRI_ONOCOY_PRIMARY;
    } else if (geoQuality < GEODNET_POOR_THRESHOLD && geoQuality > 0) {
      // GEODNET is poor — ONOCOY should be tried first
      reason = "geodnet_poor";
      priority = PRI_ONOCOY_PRIMARY;
    } else if (validation?.status === "confirmed" && (validation.fix_rate || 0) > 75) {
      // Live validation confirmed ONOCOY is better
      reason = "onocoy_better";
      priority = PRI_ONOCOY_PRIMARY;
    } else {
      // GEODNET is OK, ONOCOY as failover only
      reason = "gap_fill";
      priority = PRI_ONOCOY_FAILOVER;
    }

    // Compute confidence
    let confidence = ono.hardware_confidence;
    if (validation?.status === "confirmed") confidence = Math.max(confidence, 0.9);
    if (validation?.status === "live_testing") confidence = Math.max(confidence, 0.7);

    if (confidence < ONOCOY_MIN_CONFIDENCE) continue;

    // Compute radius based on gap size
    let radiusM = DEFAULT_OVERLAY_RADIUS_M;
    if (geoDist > 60) radiusM = MAX_OVERLAY_RADIUS_M;
    else if (geoDist > 30) radiusM = 50000;
    else if (geoDist < 20) radiusM = MIN_OVERLAY_RADIUS_M;

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

  // ── Strategy 2: Consumer ONOCOY only where GEODNET completely absent ──
  for (const ono of onocoyStations) {
    if (ono.hardware_class === "survey_grade") continue; // Already handled
    if (ono.hardware_class === "unknown") continue; // Skip unknown

    const nearestGeo = findNearestGeonet(ono.latitude, ono.longitude, geodnetStations);
    const geoDist = nearestGeo ? nearestGeo.dist : 999;

    if (geoDist <= GEODNET_ABSENT_KM) continue; // GEODNET covers this area

    const validation = validationState.get(ono.name);
    if (validation?.status === "rejected") continue;

    // Consumer hardware only if confirmed by live testing OR very large gap
    if (validation?.status !== "confirmed" && geoDist < 80) continue;

    overlayIdx++;
    overlays.push({
      id: `ono_${overlayIdx}`,
      name: `ONOCOY Consumer ${getRegionName(ono.latitude, ono.longitude)} #${overlayIdx}`,
      type: "onocoy_failover",
      reason: "geodnet_absent",
      priority: validation?.status === "confirmed" ? PRI_ONOCOY_PRIMARY : PRI_ONOCOY_FAILOVER,
      geofence_type: "circle",
      lat: Math.round(ono.latitude * 1e6) / 1e6,
      lon: Math.round(ono.longitude * 1e6) / 1e6,
      radius_m: Math.min(MAX_OVERLAY_RADIUS_M, geoDist * 600),
      onocoy_station: ono.name,
      hardware_class: ono.hardware_class,
      geodnet_quality: 0,
      onocoy_confidence: validation?.status === "confirmed" ? 0.8 : 0.4,
      validation_status: validation?.status || "untested",
      enabled: validation?.status === "confirmed" || geoDist > 80,
    });
  }

  // ── Smart Clustering: merge nearby overlays into regional fences ─────
  // Instead of 100 individual circles in Australia, create 3-5 regional circles
  const clustered = clusterNearbyOverlays(overlays, 50); // 50km cluster radius
  if (clustered.length < overlays.length) {
    console.log(`[ZONE-V2] Clustered ${overlays.length} overlays → ${clustered.length} regional fences`);
  }
  overlays.length = 0;
  overlays.push(...clustered);

  // ── Overlay Limit ──────────────────────────────────────────────────────
  if (overlays.length > MAX_OVERLAYS) {
    overlays.sort((a, b) => b.onocoy_confidence - a.onocoy_confidence);
    overlays.length = MAX_OVERLAYS;
    console.log(`[ZONE-V2] Trimmed to ${MAX_OVERLAYS} overlays`);
  }

  // Sort by priority then confidence
  overlays.sort((a, b) => a.priority - b.priority || b.onocoy_confidence - a.onocoy_confidence);

  const result: ZoneBuildV2Result = {
    global_geodnet: {
      enabled: true,
      priority: PRI_GEODNET_GLOBAL,
      mountpoint: "AUTO",
    },
    overlays,
    stats: {
      total_overlays: overlays.length,
      onocoy_primary: overlays.filter(z => z.type === "onocoy_primary").length,
      onocoy_failover: overlays.filter(z => z.type === "onocoy_failover").length,
      geodnet_poor_regions: overlays.filter(z => z.reason === "geodnet_poor").length,
      geodnet_absent_regions: overlays.filter(z => z.reason === "geodnet_absent").length,
      onocoy_confirmed: overlays.filter(z => z.validation_status === "confirmed").length,
      estimated_config_lines: 20 + overlays.length * 3, // ~3 lines per overlay
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

      for (const brand of SURVEY_GRADE) {
        if (recv.includes(brand)) { hwClass = "survey_grade"; confidence = 0.95; break; }
      }
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
  // Average quality of cells within 30km
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

function loadTrustScores(dataDir: string): Map<string, number> {
  const map = new Map();
  try {
    const data = JSON.parse(fs.readFileSync(path.join(dataDir, "trust-scores.json"), "utf-8"));
    for (const s of (data.scores || [])) map.set(s.station, s.composite_score ?? s.combined_score ?? 0.5);
  } catch {}
  return map;
}

// ─── Smart Overlay Clustering ────────────────────────────────────────────────
// Merges nearby overlays into regional fences.
// Instead of 100 circles in Australia → 3-5 regional circles.

function clusterNearbyOverlays(overlays: OverlayZone[], clusterRadiusKm: number): OverlayZone[] {
  if (overlays.length <= 10) return overlays; // Don't cluster small sets

  const used = new Set<number>();
  const clustered: OverlayZone[] = [];

  // Sort by confidence descending — best stations anchor clusters
  const sorted = overlays.map((o, i) => ({ ...o, _idx: i })).sort((a, b) => b.onocoy_confidence - a.onocoy_confidence);

  for (const anchor of sorted) {
    if (used.has(anchor._idx)) continue;
    used.add(anchor._idx);

    // Find all overlays within cluster radius
    const members: typeof sorted = [anchor];
    for (const candidate of sorted) {
      if (used.has(candidate._idx)) continue;
      const dist = haversineKm(anchor.lat, anchor.lon, candidate.lat, candidate.lon);
      if (dist <= clusterRadiusKm) {
        members.push(candidate);
        used.add(candidate._idx);
      }
    }

    if (members.length === 1) {
      // Single station — keep as individual overlay
      const { _idx, ...overlay } = anchor;
      clustered.push(overlay);
    } else {
      // Multiple stations — merge into regional fence
      const centerLat = members.reduce((s, m) => s + m.lat, 0) / members.length;
      const centerLon = members.reduce((s, m) => s + m.lon, 0) / members.length;

      // Radius: cover all member stations + buffer
      const maxDist = Math.max(...members.map(m => haversineKm(centerLat, centerLon, m.lat, m.lon)));
      const radius = Math.round(Math.min(MAX_OVERLAY_RADIUS_M, (maxDist + 15) * 1000)); // +15km buffer

      // Best confidence and priority from members
      const bestConfidence = Math.max(...members.map(m => m.onocoy_confidence));
      const bestPriority = Math.min(...members.map(m => m.priority));
      const bestHardware = members.find(m => m.hardware_class === "survey_grade")?.hardware_class || members[0].hardware_class;
      const stationNames = members.map(m => m.onocoy_station).join(", ");

      // Best validation status
      const hasConfirmed = members.some(m => m.validation_status === "confirmed");
      const hasTesting = members.some(m => m.validation_status === "live_testing");
      const validationStatus = hasConfirmed ? "confirmed" : hasTesting ? "live_testing" : "untested";

      clustered.push({
        id: `ono_region_${clustered.length + 1}`,
        name: `ONOCOY ${getRegionName(centerLat, centerLon)} (${members.length} stations)`,
        type: bestPriority <= 10 ? "onocoy_primary" : "onocoy_failover",
        reason: members[0].reason,
        priority: bestPriority,
        geofence_type: "circle",
        lat: Math.round(centerLat * 1e6) / 1e6,
        lon: Math.round(centerLon * 1e6) / 1e6,
        radius_m: radius,
        onocoy_station: stationNames.length > 50 ? `${members.length} stations` : stationNames,
        hardware_class: bestHardware,
        geodnet_quality: Math.round(members.reduce((s, m) => s + m.geodnet_quality, 0) / members.length * 100) / 100,
        onocoy_confidence: Math.round(bestConfidence * 100) / 100,
        validation_status: validationStatus,
        enabled: true,
      });
    }
  }

  return clustered;
}

function getRegionName(lat: number, lon: number): string {
  if (lat > 55 && lon > -10 && lon < 30) return "N-EU";
  if (lat > 45 && lat <= 55 && lon > -10 && lon < 20) return "C-EU";
  if (lat > 35 && lat <= 45 && lon > -10 && lon < 20) return "S-EU";
  if (lat > 25 && lat <= 50 && lon > -130 && lon < -60) return "N-AM";
  if (lat > -45 && lat <= -10 && lon > 110 && lon < 180) return "AU";
  if (lat > 20 && lat <= 50 && lon > 60 && lon < 140) return "Asia";
  return `${Math.round(lat)}N${Math.round(lon)}E`;
}
