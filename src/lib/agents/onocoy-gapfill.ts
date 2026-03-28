// ─── ONOCOY Gap-Fill Engine ───────────────────────────────────────────────────
// Automatically identifies where GEODNET is weak or absent and evaluates
// ONOCOY stations as potential gap-fills.
//
// 3-Phase Approach:
// Phase 1: Passive Intelligence (hardware filter + neighbor inference)
// Phase 2: Active Probing (RTCM stream test, $0.12/h per station)
// Phase 3: Live Validation (deploy via caster, measure real user fix rates)
//
// Result: Self-optimizing network that converges to the best station
// per region regardless of source network.

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { haversineKm } from "../spatial/variogram";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface OnocoyStation {
  name: string;
  latitude: number;
  longitude: number;
  receiver: string;
  antenna: string;
  hardware_class: "survey_grade" | "professional" | "consumer" | "unknown";
  hardware_confidence: number; // 0-1
}

export interface GapRegion {
  lat: number;
  lon: number;
  radius_km: number;
  reason: "no_geodnet" | "geodnet_poor" | "geodnet_untrusted";
  geodnet_nearest_km: number;
  geodnet_quality: number; // 0-1, quality of nearest GEODNET (0 = none)
  onocoy_candidates: OnocoyCandid[];
}

export interface OnocoyCandid {
  station: string;
  distance_km: number;
  hardware_class: string;
  hardware_confidence: number;
  gap_fill_score: number;     // 0-1, combined score for gap-filling suitability
  validation_status: "untested" | "probed" | "live_testing" | "confirmed" | "rejected";
  recommended_priority: number;
}

export interface GapFillResult {
  gaps: GapRegion[];
  gap_fill_zones: GapFillZone[];
  stats: {
    total_gaps: number;
    gaps_fillable: number;
    onocoy_survey_grade: number;
    onocoy_consumer: number;
    zones_created: number;
  };
  computed_at: string;
}

export interface GapFillZone {
  id: string;
  name: string;
  onocoy_station: string;
  hardware_class: string;
  gap_reason: string;
  lat: number;
  lon: number;
  radius_m: number;
  priority: number;          // 10-40 depending on confidence
  gap_fill_score: number;
  validation_status: string;
  enabled: boolean;
}

// ─── Hardware Classification ─────────────────────────────────────────────────
// From ONOCOY Sourcetable receiver/antenna fields

const SURVEY_GRADE = [
  "LEICA", "TRIMBLE", "SEPT", "SEPTENTRIO", "NOVATEL", "JAVAD",
  "TOPCON", "SOKKIA", "GEO++", "GEOPP", "CHCNAV", "CHC",
];

const PROFESSIONAL = [
  "STONEX", "SOUTH", "KOLIDA", "FOIF",
  "RUIDE", "SANDING", "TERSUS", "UNICORE",
];

const CONSUMER = [
  "U-BLOX", "UBLOX", "F9P", "ZED-F9P", "SPARKFUN", "ARDUSIMPLE",
];

function classifyHardware(receiver: string, antenna: string): { class: OnocoyStation["hardware_class"]; confidence: number } {
  const combined = `${receiver} ${antenna}`.toUpperCase();

  // Explicit brand names
  for (const brand of SURVEY_GRADE) {
    if (combined.includes(brand)) return { class: "survey_grade", confidence: 0.95 };
  }
  for (const brand of PROFESSIONAL) {
    if (combined.includes(brand)) return { class: "professional", confidence: 0.80 };
  }
  for (const brand of CONSUMER) {
    if (combined.includes(brand)) return { class: "consumer", confidence: 0.50 };
  }

  // Inferred from RTCM capabilities (ONOCOY sourcetable has no receiver field)
  if (combined.includes("SURVEY_GRADE_INFERRED")) return { class: "survey_grade", confidence: 0.75 };
  if (combined.includes("PROFESSIONAL_INFERRED")) return { class: "professional", confidence: 0.65 };
  if (combined.includes("CONSUMER_GOOD_INFERRED")) return { class: "consumer", confidence: 0.50 };
  if (combined.includes("CONSUMER_BASIC_INFERRED")) return { class: "consumer", confidence: 0.30 };

  return { class: "unknown", confidence: 0.20 };
}

// ─── Gap Detection ──────────────────────────────────────────────────────────

const GAP_THRESHOLD_KM = 40;          // No GEODNET within 40km = gap
const POOR_QUALITY_THRESHOLD = 0.55;   // GEODNET quality below 55% = poor (unified with zone-builder-v2)
const UNTRUSTED_THRESHOLD = 0.40;      // GEODNET trust below 40% = untrusted

export function runOnocoyGapFill(db: Database.Database, dataDir: string): GapFillResult {
  // Load GEODNET stations with quality
  const geodnetStations = loadGeonetStations(db);
  // Load ONOCOY stations from sourcetable data
  const onocoyStations = loadOnocoyStations(db);
  // Load trust scores
  const trustScores = loadTrustScores(dataDir);
  // Load existing validation state
  const validationState = loadValidationState(dataDir);

  if (onocoyStations.length === 0) {
    return emptyResult();
  }

  const gaps: GapRegion[] = [];
  const gapFillZones: GapFillZone[] = [];

  // Strategy 1: Find areas with NO GEODNET coverage
  // Use ONOCOY stations as seeds — check if GEODNET exists nearby
  for (const ono of onocoyStations) {
    // Skip consumer hardware unless nothing else available
    if (ono.hardware_class === "unknown") continue;

    // Find nearest GEODNET station
    let nearestGeodnet: { name: string; dist: number; quality: number; trust: number } | null = null;
    for (const geo of geodnetStations) {
      const dist = haversineKm(ono.latitude, ono.longitude, geo.latitude, geo.longitude);
      if (!nearestGeodnet || dist < nearestGeodnet.dist) {
        nearestGeodnet = {
          name: geo.name,
          dist,
          quality: geo.uq_score,
          trust: trustScores.get(geo.name) || 0.5,
        };
      }
    }

    // Determine gap reason
    let reason: GapRegion["reason"] | null = null;
    const geodnetDist = nearestGeodnet?.dist || 999;
    const geodnetQuality = nearestGeodnet?.quality || 0;
    const geodnetTrust = nearestGeodnet?.trust || 0;

    if (geodnetDist > GAP_THRESHOLD_KM) {
      reason = "no_geodnet";
    } else if (geodnetQuality < POOR_QUALITY_THRESHOLD && geodnetDist > 15) {
      reason = "geodnet_poor";
    } else if (geodnetTrust < UNTRUSTED_THRESHOLD && geodnetDist > 15) {
      reason = "geodnet_untrusted";
    }

    if (!reason) continue; // GEODNET covers this area well

    // Calculate gap-fill score for this ONOCOY station
    const gapFillScore = computeGapFillScore(ono, geodnetDist, geodnetQuality, validationState.get(ono.name));

    // Determine validation status
    const existingValidation = validationState.get(ono.name);
    const validationStatus = (existingValidation?.status || "untested") as OnocoyCandid["validation_status"];

    // Skip rejected stations
    if (validationStatus === "rejected") continue;

    // Priority based on hardware + validation
    let priority = 40; // Default: low priority
    if (ono.hardware_class === "survey_grade") {
      priority = validationStatus === "confirmed" ? 10 : validationStatus === "live_testing" ? 20 : 15;
    } else if (ono.hardware_class === "professional") {
      priority = validationStatus === "confirmed" ? 15 : validationStatus === "live_testing" ? 25 : 25;
    } else if (ono.hardware_class === "consumer") {
      priority = validationStatus === "confirmed" ? 20 : 35;
    }

    const candidate: OnocoyCandid = {
      station: ono.name,
      distance_km: Math.round(geodnetDist * 10) / 10,
      hardware_class: ono.hardware_class,
      hardware_confidence: ono.hardware_confidence,
      gap_fill_score: gapFillScore,
      validation_status: validationStatus,
      recommended_priority: priority,
    };

    // Add to gap region
    const existingGap = gaps.find(g =>
      haversineKm(g.lat, g.lon, ono.latitude, ono.longitude) < 30
    );

    if (existingGap) {
      existingGap.onocoy_candidates.push(candidate);
    } else {
      gaps.push({
        lat: ono.latitude,
        lon: ono.longitude,
        radius_km: Math.min(40, geodnetDist * 0.6),
        reason,
        geodnet_nearest_km: Math.round(geodnetDist * 10) / 10,
        geodnet_quality: Math.round(geodnetQuality * 100) / 100,
        onocoy_candidates: [candidate],
      });
    }

    // Create zone if confidence is high enough
    if (gapFillScore >= 0.5 || ono.hardware_class === "survey_grade") {
      gapFillZones.push({
        id: `onocoy_gap_${gapFillZones.length + 1}`,
        name: `ONOCOY Gap-Fill ${getRegionName(ono.latitude, ono.longitude)} (${ono.hardware_class})`,
        onocoy_station: ono.name,
        hardware_class: ono.hardware_class,
        gap_reason: reason,
        lat: ono.latitude,
        lon: ono.longitude,
        radius_m: Math.round(Math.min(35000, geodnetDist * 500)),
        priority,
        gap_fill_score: gapFillScore,
        validation_status: validationStatus,
        enabled: gapFillScore >= 0.6 || ono.hardware_class === "survey_grade",
      });
    }
  }

  const result: GapFillResult = {
    gaps,
    gap_fill_zones: gapFillZones,
    stats: {
      total_gaps: gaps.length,
      gaps_fillable: gaps.filter(g => g.onocoy_candidates.some(c => c.gap_fill_score >= 0.5)).length,
      onocoy_survey_grade: onocoyStations.filter(s => s.hardware_class === "survey_grade").length,
      onocoy_consumer: onocoyStations.filter(s => s.hardware_class === "consumer").length,
      zones_created: gapFillZones.filter(z => z.enabled).length,
    },
    computed_at: new Date().toISOString(),
  };

  // Persist
  try {
    const filePath = path.join(dataDir, "onocoy-gapfill.json");
    const tmp = filePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(result, null, 2));
    fs.renameSync(tmp, filePath);
  } catch {}

  return result;
}

// ─── Gap Fill Score ──────────────────────────────────────────────────────────

function computeGapFillScore(
  station: OnocoyStation,
  geodnetDistKm: number,
  geodnetQuality: number,
  validation?: { status: string; fix_rate?: number }
): number {
  let score = 0;

  // Hardware (40% weight)
  score += station.hardware_confidence * 0.40;

  // Gap severity (30% weight) — bigger gap = more valuable fill
  const gapSeverity = geodnetDistKm > 100 ? 1.0 :
    geodnetDistKm > 60 ? 0.8 :
    geodnetDistKm > 40 ? 0.6 :
    geodnetDistKm > 20 ? 0.3 : 0.1;
  score += gapSeverity * 0.30;

  // GEODNET weakness (20% weight) — weaker GEODNET = more need for fill
  score += (1 - geodnetQuality) * 0.20;

  // Validation bonus (10% weight)
  if (validation?.status === "confirmed" && validation.fix_rate) {
    score += (validation.fix_rate / 100) * 0.10;
  } else if (validation?.status === "live_testing") {
    score += 0.05;
  }

  return Math.round(Math.min(1, score) * 100) / 100;
}

// ─── Data Loading ────────────────────────────────────────────────────────────

function loadGeonetStations(db: Database.Database): Array<{ name: string; latitude: number; longitude: number; uq_score: number }> {
  try {
    return db.prepare(`
      SELECT s.name, s.latitude, s.longitude, COALESCE(sc.uq_score, 0.5) as uq_score
      FROM stations s
      LEFT JOIN station_scores sc ON s.name = sc.station_name
      WHERE s.latitude IS NOT NULL AND s.longitude IS NOT NULL
        AND s.status IN ('ONLINE', 'ACTIVE')
        AND (s.network = 'geodnet' OR s.network IS NULL OR s.network = '')
    `).all() as any[];
  } catch { return []; }
}

function loadOnocoyStations(db: Database.Database): OnocoyStation[] {
  try {
    const rows = db.prepare(`
      SELECT name, latitude, longitude,
             COALESCE(receiver_type, '') as receiver,
             COALESCE(antenna_type, '') as antenna
      FROM stations
      WHERE network = 'onocoy'
        AND latitude IS NOT NULL AND longitude IS NOT NULL
        AND status IN ('ONLINE', 'ACTIVE')
    `).all() as any[];

    return rows.map(r => {
      const hw = classifyHardware(r.receiver || r.name, r.antenna || "");
      return {
        name: r.name,
        latitude: r.latitude,
        longitude: r.longitude,
        receiver: r.receiver,
        antenna: r.antenna,
        hardware_class: hw.class,
        hardware_confidence: hw.confidence,
      };
    });
  } catch { return []; }
}

function loadTrustScores(dataDir: string): Map<string, number> {
  const map = new Map<string, number>();
  try {
    const data = JSON.parse(fs.readFileSync(path.join(dataDir, "trust-scores.json"), "utf-8"));
    for (const s of (data.scores || [])) {
      map.set(s.station, s.composite_score ?? s.combined_score ?? s.trust_score ?? 0.5);
    }
  } catch {}
  return map;
}

interface ValidationEntry { status: string; fix_rate?: number; sessions?: number; last_updated?: string }

function loadValidationState(dataDir: string): Map<string, ValidationEntry> {
  const map = new Map<string, ValidationEntry>();
  try {
    const data = JSON.parse(fs.readFileSync(path.join(dataDir, "onocoy-validation.json"), "utf-8"));
    for (const [station, entry] of Object.entries(data)) {
      map.set(station, entry as ValidationEntry);
    }
  } catch {}
  return map;
}

// ─── Live Validation Feedback ────────────────────────────────────────────────
// Called by Session Feedback agent: when users connect via ONOCOY gap-fill zones,
// their fix rates update the validation state.

export function updateOnocoyValidation(
  station: string,
  fixRate: number,
  sessionCount: number,
  dataDir: string
) {
  const statePath = path.join(dataDir, "onocoy-validation.json");
  let state: Record<string, ValidationEntry> = {};
  try {
    if (fs.existsSync(statePath)) state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
  } catch {}

  const existing = state[station] || { status: "untested" };

  // Update with new data
  // EMA alpha=0.4 (was 0.3 — faster convergence for degraded stations)
  // Staleness reset: if last update >7 days ago, reset to current value
  const lastUpdated = existing.last_updated ? new Date(existing.last_updated).getTime() : 0;
  const isStale = Date.now() - lastUpdated > 7 * 86400000;
  const newFixRate = (existing.fix_rate && !isStale)
    ? (existing.fix_rate * 0.6 + fixRate * 0.4) // EMA: 60% old, 40% new
    : fixRate; // Fresh start if stale or first time
  const newSessions = (existing.sessions || 0) + sessionCount;

  // Determine status based on accumulated data
  let newStatus = "live_testing";
  if (newSessions >= 50) {
    // Enough data to decide
    if (newFixRate >= 70) newStatus = "confirmed";
    else if (newFixRate < 40) newStatus = "rejected";
    else newStatus = "live_testing"; // Keep testing
  } else if (newSessions >= 10) {
    // Some data — early signal
    if (newFixRate >= 80) newStatus = "confirmed"; // Strong early signal
    else if (newFixRate < 20) newStatus = "rejected"; // Clearly bad
    else newStatus = "live_testing";
  }

  state[station] = {
    status: newStatus,
    fix_rate: Math.round(newFixRate * 10) / 10,
    sessions: newSessions,
    last_updated: new Date().toISOString(),
  };

  try {
    const tmp = statePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, statePath);
  } catch {}
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getRegionName(lat: number, lon: number): string {
  if (lat > 55 && lon > -10 && lon < 30) return "N-Europe";
  if (lat > 45 && lat <= 55 && lon > -10 && lon < 20) return "C-Europe";
  if (lat > 35 && lat <= 45 && lon > -10 && lon < 20) return "S-Europe";
  if (lat > 25 && lat <= 50 && lon > -130 && lon < -60) return "N-America";
  if (lat > -45 && lat <= -10 && lon > 110 && lon < 180) return "Australia";
  if (lat > 20 && lat <= 50 && lon > 60 && lon < 140) return "Asia";
  return `${Math.round(lat)}N-${Math.round(lon)}E`;
}

function emptyResult(): GapFillResult {
  return {
    gaps: [], gap_fill_zones: [],
    stats: { total_gaps: 0, gaps_fillable: 0, onocoy_survey_grade: 0, onocoy_consumer: 0, zones_created: 0 },
    computed_at: new Date().toISOString(),
  };
}
