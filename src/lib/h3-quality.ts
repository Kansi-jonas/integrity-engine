// ─── MERIDIAN H3 Coverage Quality Engine (v2) ────────────────────────────────
// Physics-informed deterministic model for RTK coverage quality.
//
// Core insight: We KNOW where the stations are. Quality is primarily a
// deterministic function of station geometry, not a random field to interpolate.
// Session data calibrates and validates, but station positions are the source of truth.
//
// Based on PhD review feedback:
// - H3 resolution 5 (~8.5km) instead of 4 (~22km)
// - Baseline distance as primary component (0.35 weight, sigmoidal decay)
// - Fix rate as validation signal only (0.10 weight)
// - 4 tiers instead of 7 (Full RTK / Degraded / Float / No Coverage)
// - No Kriging — deterministic model from station positions
// - Temporal decay 28 days (1 solar rotation) instead of 14

import Database from "better-sqlite3";
import * as h3 from "h3-js";
import { haversineKm } from "./spatial/variogram";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface QualityCell {
  h3Index: string;
  resolution: number;
  qualityScore: number;
  baselineComponent: number;
  geometryComponent: number;
  uptimeComponent: number;
  freshnessComponent: number;
  fixRateComponent: number;
  sessionCount: number;
  uniqueUsers: number;
  confidence: number;
  dataSource: "observed" | "modeled" | "hybrid";
  zoneTier: string;
  redundancy: number;
  nearestStation: string;
  nearestStationKm: number;
  stationsInRange: number;
}

interface StationInfo {
  name: string;
  latitude: number;
  longitude: number;
  status: string;
  network: string;
  uqScore: number;
  uptime7d: number;
}

// ─── Configuration ───────────────────────────────────────────────────────────

const H3_RESOLUTION = 5;             // ~8.5km edge (PhD recommendation)
const STATION_RANGE = 50;            // km, max range for station influence
const MIN_SESSIONS_OBSERVED = 20;    // Need 20+ sessions for "observed" quality
const MIN_SESSIONS_HYBRID = 3;       // 3+ sessions for "hybrid" (model + observations)
const TEMPORAL_DECAY_DAYS = 28;      // 1 solar rotation period
const MAX_SESSION_AGE_DAYS = 180;    // 6 month window

// Quality score weights (PhD-recommended, sum = 1.0)
// Baseline is dominant because it's the #1 predictor of RTK quality
const W_BASELINE = 0.35;    // Distance to nearest station (sigmoidal)
const W_GEOMETRY = 0.20;    // Station geometry (redundancy, angular spread)
const W_UPTIME = 0.20;      // Station reliability
const W_FRESHNESS = 0.15;   // Correction age (network latency)
const W_FIXRATE = 0.10;     // Observed fix rate (validation signal only)

// Zone tier thresholds (4 tiers, quality-only, no network provenance)
const TIERS = {
  full_rtk: 0.75,       // Reliable fixed solution, <2cm
  degraded_rtk: 0.50,   // Fixed likely but not guaranteed, 2-5cm
  float_dgps: 0.25,     // Decimeter-level only
  // Below 0.25 = no_coverage
};

// ─── Gaussian Baseline Decay ─────────────────────────────────────────────────
// RTK quality: nearly constant to ~5km, rapid degradation 10-30km, near-zero at ~40km
// Gaussian: exp(-(d/sigma)^2) — goes to near-zero by 35-40km (matches empirical RTK data)
// PhD review: Cauchy (1/(1+(d/d)^2)) had heavy tails overstating quality at 35km+
// Gaussian with sigma=20km: at 35km returns 0.047, at 40km returns 0.018, at 50km returns 0.002

const BASELINE_SIGMA = 20; // km, Gaussian sigma for baseline decay

function baselineDecay(distKm: number): number {
  return Math.exp(-Math.pow(distKm / BASELINE_SIGMA, 2));
}

// ─── Station Geometry Score ──────────────────────────────────────────────────
// Measures how well the surrounding stations are distributed geometrically.
// Similar to PDOP: good geometry = stations spread in all directions.
// Returns [0,1] where 1 = excellent geometry.

function stationGeometryScore(
  cellLat: number, cellLon: number,
  nearbyStations: Array<StationInfo & { dist: number }>
): number {
  if (nearbyStations.length === 0) return 0;
  if (nearbyStations.length === 1) return 0.3;

  // Only consider stations within effective range (weighted by proximity)
  // PhD review: far stations should not inflate geometry score
  const effectiveStations = nearbyStations.filter(st => st.dist <= 35); // 35km max for geometry
  if (effectiveStations.length === 0) return 0.1;
  if (effectiveStations.length === 1) return 0.3;

  // Compute distance-weighted bearings from cell to each station
  const bearings = effectiveStations.map(st => {
    const dLon = (st.longitude - cellLon) * Math.PI / 180;
    const lat1 = cellLat * Math.PI / 180;
    const lat2 = st.latitude * Math.PI / 180;
    const y = Math.sin(dLon) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
    return Math.atan2(y, x) * 180 / Math.PI;
  }).sort((a, b) => a - b);

  // Compute max gap between consecutive bearings
  let maxGap = 0;
  for (let i = 0; i < bearings.length - 1; i++) {
    maxGap = Math.max(maxGap, bearings[i + 1] - bearings[i]);
  }
  // Gap wrapping around 360
  const wrapGap = 360 - bearings[bearings.length - 1] + bearings[0];
  maxGap = Math.max(maxGap, wrapGap);

  // Perfect geometry = 360/n gap (evenly spread)
  // Score degrades as max gap increases
  const idealGap = 360 / effectiveStations.length;
  const gapRatio = maxGap / idealGap; // 1.0 = perfect, higher = worse

  // Factor in effective station count (closer stations count more, saturating at 4)
  const countFactor = Math.min(1, effectiveStations.length / 4);

  // Combine: geometry quality from gap analysis + count
  const geometryFromGap = Math.max(0, 1 - (gapRatio - 1) / 3); // Degrades as gap exceeds ideal
  return Math.round(Math.min(1, geometryFromGap * 0.6 + countFactor * 0.4) * 100) / 100;
}

// ─── Compute Quality: Deterministic Model ────────────────────────────────────
// Q_det(x) = weighted combination of station-derived components
// Session data used only for validation (fixRateComponent)

export function computeCellQualities(db: Database.Database): QualityCell[] {
  const now = Date.now();
  const maxAge = now - MAX_SESSION_AGE_DAYS * 86400000;

  // Load all online stations with scores
  const stations = db.prepare(`
    SELECT s.name, s.latitude, s.longitude, s.status, COALESCE(s.network, 'unknown') as network,
           COALESCE(ss.uq_score, 0.5) as uq_score, COALESCE(ss.uptime_7d, 0.5) as uptime_7d,
           COALESCE(ss.median_correction_age, 2.0) as median_age
    FROM stations s
    LEFT JOIN station_scores ss ON s.name = ss.station_name
    WHERE s.latitude IS NOT NULL AND s.longitude IS NOT NULL
      AND ABS(s.latitude) > 0.1
      AND s.status IN ('ONLINE', 'ACTIVE')
  `).all() as any[];

  if (stations.length === 0) return [];

  // Build spatial index: group stations into 1-degree grid for fast lookup
  const stationGrid = new Map<string, any[]>();
  for (const st of stations) {
    const key = `${Math.floor(st.latitude)}:${Math.floor(st.longitude)}`;
    if (!stationGrid.has(key)) stationGrid.set(key, []);
    stationGrid.get(key)!.push(st);
  }

  function getNearbyStationCandidates(lat: number, lon: number): any[] {
    const candidates: any[] = [];
    const gridRadius = Math.ceil(STATION_RANGE / 111); // degrees needed for range
    for (let dlat = -gridRadius; dlat <= gridRadius; dlat++) {
      for (let dlon = -gridRadius; dlon <= gridRadius; dlon++) {
        const key = `${Math.floor(lat) + dlat}:${Math.floor(lon) + dlon}`;
        const bucket = stationGrid.get(key);
        if (bucket) candidates.push(...bucket);
      }
    }
    return candidates;
  }

  // Pre-aggregate session data by approximate grid cell in SQL (prevents OOM)
  // We use 0.1-degree grid (~11km) to approximate H3 res-5 cells
  // Then map to actual H3 cells. This limits memory to ~50K aggregated rows instead of millions of raw sessions.
  const sessionAggregates = db.prepare(`
    SELECT
      ROUND(latitude, 1) as grid_lat,
      ROUND(longitude, 1) as grid_lon,
      COUNT(*) as session_count,
      COUNT(DISTINCT username) as unique_users,
      SUM(fix_rate * CASE WHEN duration > 0 THEN duration ELSE 1 END) as weighted_fix_sum,
      SUM(CASE WHEN duration > 0 THEN duration ELSE 1 END) as total_duration,
      AVG(CASE WHEN avg_age > 0 THEN avg_age END) as median_age,
      MIN(login_time) as first_session,
      MAX(login_time) as last_session
    FROM rtk_sessions
    WHERE latitude IS NOT NULL AND longitude IS NOT NULL
      AND ABS(latitude) > 0.1 AND ABS(longitude) > 0.1
      AND login_time >= ?
    GROUP BY grid_lat, grid_lon
  `).all(maxAge) as any[];

  // Map aggregated grid cells to H3 cells
  const cellSessions = new Map<string, { count: number; users: number; weightedFixRate: number; totalDuration: number; ageSum: number; ageCount: number }>();
  for (const agg of sessionAggregates) {
    try {
      const h3Index = h3.latLngToCell(agg.grid_lat, agg.grid_lon, H3_RESOLUTION);
      const existing = cellSessions.get(h3Index);
      if (existing) {
        existing.count += agg.session_count;
        existing.users += agg.unique_users;
        existing.weightedFixRate += agg.weighted_fix_sum || 0;
        existing.totalDuration += agg.total_duration || 0;
        if (agg.median_age > 0) {
          existing.ageSum += agg.median_age * agg.session_count;
          existing.ageCount += agg.session_count;
        }
      } else {
        cellSessions.set(h3Index, {
          count: agg.session_count,
          users: agg.unique_users,
          weightedFixRate: agg.weighted_fix_sum || 0,
          totalDuration: agg.total_duration || 0,
          ageSum: (agg.median_age || 0) * agg.session_count,
          ageCount: agg.median_age > 0 ? agg.session_count : 0,
        });
      }
    } catch {}
  }

  // Determine which H3 cells to compute
  // Strategy: all cells that contain a station OR have sessions
  const cellsToCompute = new Set<string>();

  // Add cells for all stations + their neighbors (k-ring 2 = covers ~25km around each station)
  for (const st of stations) {
    try {
      const centerCell = h3.latLngToCell(st.latitude, st.longitude, H3_RESOLUTION);
      const ring = h3.gridDisk(centerCell, 2); // ~17km coverage radius (19 cells per station)
      for (const cell of ring) cellsToCompute.add(cell);
    } catch {}
  }

  // Add cells with sessions
  for (const h3Index of cellSessions.keys()) {
    cellsToCompute.add(h3Index);
  }

  // Compute quality for each cell
  const cells: QualityCell[] = [];

  for (const h3Index of cellsToCompute) {
    const [cellLat, cellLon] = h3.cellToLatLng(h3Index);

    // Find stations within range using spatial index
    const nearbyStations = getNearbyStationCandidates(cellLat, cellLon)
      .map(st => ({
        ...st,
        dist: haversineKm(cellLat, cellLon, st.latitude, st.longitude),
      }))
      .filter(st => st.dist <= STATION_RANGE)
      .sort((a, b) => a.dist - b.dist);

    // Nearest station
    const nearest = nearbyStations[0];
    const nearestStationKm = nearest ? Math.round(nearest.dist * 10) / 10 : 999;
    const nearestStation = nearest?.name || "";

    // ── DETERMINISTIC COMPONENTS ──────────────────────────────────

    // Baseline: sigmoidal decay from nearest station
    const baselineComponent = nearest ? baselineDecay(nearest.dist) : 0;

    // Geometry: angular spread + count of stations
    const geometryComponent = stationGeometryScore(cellLat, cellLon, nearbyStations);

    // Uptime: weighted average of nearby station uptimes (closer = more weight)
    let uptimeComponent = 0;
    if (nearbyStations.length > 0) {
      let totalWeight = 0;
      for (const st of nearbyStations) {
        const w = baselineDecay(st.dist); // Weight by proximity
        uptimeComponent += st.uptime_7d * w;
        totalWeight += w;
      }
      uptimeComponent = totalWeight > 0 ? uptimeComponent / totalWeight : 0;
    }

    // Freshness: correction age from station scores (closer stations matter more)
    let freshnessComponent = 0.5;
    if (nearbyStations.length > 0) {
      const bestAge = Math.min(...nearbyStations.slice(0, 3).map(st => st.median_age || 5));
      freshnessComponent = Math.max(0, 1 - bestAge / 10);
    }

    // ── OBSERVED COMPONENT (from pre-aggregated session data) ────

    const cellData = cellSessions.get(h3Index);
    let fixRateComponent = 0.5;
    let dataSource: "observed" | "modeled" | "hybrid" = "modeled";
    let confidence = 0;
    let sessionCount = 0;
    let uniqueUsers = 0;

    if (cellData && cellData.count >= MIN_SESSIONS_OBSERVED) {
      fixRateComponent = cellData.totalDuration > 0
        ? (cellData.weightedFixRate / cellData.totalDuration) / 100
        : 0.5;
      const avgAge = cellData.ageCount > 0 ? cellData.ageSum / cellData.ageCount : 0;
      if (avgAge > 0) {
        freshnessComponent = Math.max(0, 1 - avgAge / 10);
      }
      dataSource = "observed";
      confidence = Math.min(1, cellData.count / 50);
      sessionCount = cellData.count;
      uniqueUsers = cellData.users;
    } else if (cellData && cellData.count >= MIN_SESSIONS_HYBRID) {
      fixRateComponent = cellData.totalDuration > 0
        ? (cellData.weightedFixRate / cellData.totalDuration) / 100
        : 0.5;
      dataSource = "hybrid";
      confidence = cellData.count / 50;
      sessionCount = cellData.count;
      uniqueUsers = cellData.users;
    } else {
      fixRateComponent = baselineComponent;
      dataSource = "modeled";
      confidence = 0;
      sessionCount = cellData?.count || 0;
      uniqueUsers = cellData?.users || 0;
    }

    // ── QUALITY SCORE ─────────────────────────────────────────────
    const qualityScore = Math.round(
      (W_BASELINE * baselineComponent +
       W_GEOMETRY * geometryComponent +
       W_UPTIME * uptimeComponent +
       W_FRESHNESS * freshnessComponent +
       W_FIXRATE * fixRateComponent) * 100
    ) / 100;

    // ── ZONE TIER (4 tiers, quality-only) ─────────────────────────
    let zoneTier = "no_coverage";
    if (qualityScore >= TIERS.full_rtk) zoneTier = "full_rtk";
    else if (qualityScore >= TIERS.degraded_rtk) zoneTier = "degraded_rtk";
    else if (qualityScore >= TIERS.float_dgps) zoneTier = "float_dgps";

    // Redundancy: how many independent networks serve this cell
    const networks = new Set(nearbyStations.map(st => st.network).filter(n => n !== "unknown"));
    const redundancy = networks.size;

    cells.push({
      h3Index,
      resolution: H3_RESOLUTION,
      qualityScore,
      baselineComponent: Math.round(baselineComponent * 100) / 100,
      geometryComponent,
      uptimeComponent: Math.round(uptimeComponent * 100) / 100,
      freshnessComponent: Math.round(freshnessComponent * 100) / 100,
      fixRateComponent: Math.round(fixRateComponent * 100) / 100,
      sessionCount,
      uniqueUsers,
      confidence: Math.round(confidence * 100) / 100,
      dataSource,
      zoneTier,
      redundancy,
      nearestStation,
      nearestStationKm,
      stationsInRange: nearbyStations.length,
    });
  }

  return cells;
}

// ─── Write Quality Cells to DB ───────────────────────────────────────────────

export function writeQualityCells(db: Database.Database, cells: QualityCell[]) {
  const now = Date.now();

  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM quality_cells`).run();

    const stmt = db.prepare(`
      INSERT INTO quality_cells
      (h3_index, resolution, quality_score, fix_component, age_component, density_component,
       uptime_component, baseline_component, session_count, unique_users, confidence,
       is_interpolated, zone_tier, best_network, nearest_station, nearest_station_km, computed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const c of cells) {
      stmt.run(
        c.h3Index, c.resolution, c.qualityScore,
        c.fixRateComponent,       // fix_component
        c.freshnessComponent,     // age_component (reused column)
        c.geometryComponent,      // density_component (reused column)
        c.uptimeComponent,
        c.baselineComponent,
        c.sessionCount, c.uniqueUsers, c.confidence,
        c.dataSource === "modeled" ? 1 : 0,  // is_interpolated
        c.zoneTier,
        "",                       // best_network (deprecated, use redundancy)
        c.nearestStation, c.nearestStationKm, now
      );
    }
  });
  tx();

  console.log(`[MERIDIAN] Wrote ${cells.length} quality cells (${cells.filter(c => c.dataSource === "observed").length} observed, ${cells.filter(c => c.dataSource === "modeled").length} modeled)`);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function getCellBoundaries(h3Index: string): [number, number][] {
  return h3.cellToBoundary(h3Index);
}

export function getCellCenter(h3Index: string): [number, number] {
  return h3.cellToLatLng(h3Index);
}

export { H3_RESOLUTION, TIERS };
