// ─── Protection Level Engine ─────────────────────────────────────────────────
// Computes Horizontal/Vertical Protection Levels (HPL/VPL) and integrity risk
// for any (lat, lon) coordinate based on:
// - Station geometry (HDOP-like computation from nearby stations)
// - Station trust scores (weighted by reliability)
// - Historical fix rate at this location
// - Current space weather conditions
// - Correction age expectations
//
// Based on Stanford Integrity Diagram methodology and ARAIM concepts
// adapted for network RTK.
//
// Reference: research_gnss_integrity.md (Protection Level formulas)

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ProtectionLevel {
  lat: number;
  lon: number;
  hpl_m: number;           // Horizontal Protection Level (meters)
  vpl_m: number;           // Vertical Protection Level (meters)
  integrity_risk: number;  // Probability of exceeding PL without detection [0-1]
  alert_limit_h: number;   // Horizontal Alert Limit (meters)
  alert_limit_v: number;   // Vertical Alert Limit (meters)
  available: boolean;      // Is integrity service available at this location?
  // Components
  station_count: number;
  nearest_station_km: number;
  mean_trust: number;
  expected_fix_rate: number;
  kp_factor: number;
  confidence: "high" | "medium" | "low" | "insufficient";
  // Context
  stations_used: Array<{ name: string; distance_km: number; trust: number; weight: number }>;
  computed_at: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const MAX_STATION_RANGE_KM = 100;    // Stations beyond 100km don't contribute
const MIN_STATIONS_FOR_PL = 1;       // Need at least 1 station
const SIGMA_0 = 0.02;                // Base observation sigma (meters) for RTK
const K_FACTOR = 5.33;               // Multiplier for 10^-7 integrity risk (normal distribution)
const STATION_SIGMA_SCALE = 0.001;   // Sigma increase per km baseline (m/km)

// Alert Limits by application tier
const ALERT_LIMITS = {
  survey: { h: 0.05, v: 0.10 },      // 5cm H, 10cm V
  machine_control: { h: 0.10, v: 0.15 },
  agriculture: { h: 0.15, v: 0.20 },
  fleet: { h: 0.50, v: 1.00 },
  consumer: { h: 1.00, v: 2.00 },
};

// ─── Haversine ───────────────────────────────────────────────────────────────

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── Core Computation ────────────────────────────────────────────────────────

export function computeProtectionLevel(
  db: Database.Database,
  lat: number,
  lon: number,
  dataDir: string,
  tier: keyof typeof ALERT_LIMITS = "machine_control"
): ProtectionLevel {
  const now = Date.now();
  const sixHoursAgo = now - 6 * 3600000;

  // ── 1. Find nearby stations ───────────────────────────────────────────────

  const allStations = db.prepare(`
    SELECT s.name, s.latitude, s.longitude, s.status,
           COALESCE(ss.uq_score, 0.5) as uq_score,
           COALESCE(ss.uptime_7d, 0.5) as uptime,
           COALESCE(ss.avg_fix_rate, 50) as avg_fix_rate
    FROM stations s
    LEFT JOIN station_scores ss ON s.name = ss.station_name
    WHERE s.latitude IS NOT NULL AND ABS(s.latitude) > 0.1
  `).all() as any[];

  // Load trust scores
  const trustMap = new Map<string, number>();
  try {
    const trustPath = path.join(dataDir, "trust-scores.json");
    if (fs.existsSync(trustPath)) {
      const td = JSON.parse(fs.readFileSync(trustPath, "utf-8"));
      for (const t of (td.scores || [])) {
        trustMap.set(t.station, t.composite_score ?? t.combined_score ?? 0.5);
      }
    }
  } catch {}

  // Find stations within range, sorted by distance
  const nearbyStations = allStations
    .map((s: any) => ({
      name: s.name,
      lat: s.latitude,
      lon: s.longitude,
      distance_km: haversineKm(lat, lon, s.latitude, s.longitude),
      trust: trustMap.get(s.name) ?? 0.5,
      uq: s.uq_score,
      uptime: s.uptime,
      fix_rate: s.avg_fix_rate,
      online: s.status === "ONLINE" || s.status === "ACTIVE",
    }))
    .filter((s: any) => s.distance_km <= MAX_STATION_RANGE_KM && s.online)
    .sort((a: any, b: any) => a.distance_km - b.distance_km)
    .slice(0, 20); // Use top 20 nearest

  // ── 2. Load space weather ─────────────────────────────────────────────────

  let kp = 0;
  try {
    const swPath = path.join(dataDir, "space-weather.json");
    if (fs.existsSync(swPath)) {
      const sw = JSON.parse(fs.readFileSync(swPath, "utf-8"));
      kp = sw.kp_index || 0;
    }
  } catch {}

  // Kp degradation factor (higher Kp = worse positioning)
  const kpFactor = kp >= 7 ? 3.0 : kp >= 5 ? 2.0 : kp >= 4 ? 1.3 : 1.0;

  // ── 3. Check availability ─────────────────────────────────────────────────

  if (nearbyStations.length < MIN_STATIONS_FOR_PL) {
    return {
      lat, lon,
      hpl_m: Infinity, vpl_m: Infinity,
      integrity_risk: 1.0,
      alert_limit_h: ALERT_LIMITS[tier].h,
      alert_limit_v: ALERT_LIMITS[tier].v,
      available: false,
      station_count: 0,
      nearest_station_km: allStations.length > 0
        ? Math.min(...allStations.map((s: any) => haversineKm(lat, lon, s.latitude, s.longitude)))
        : Infinity,
      mean_trust: 0,
      expected_fix_rate: 0,
      kp_factor: kpFactor,
      confidence: "insufficient",
      stations_used: [],
      computed_at: new Date().toISOString(),
    };
  }

  // ── 4. Compute weighted position error estimate ───────────────────────────
  // Based on station geometry and individual station quality.
  // Each station contributes to the position solution with weight inversely
  // proportional to its expected error (distance + trust + quality).

  const stationsUsed: ProtectionLevel["stations_used"] = [];
  let totalWeight = 0;
  let weightedSigmaH2 = 0; // Sum of weighted horizontal sigma squared
  let weightedSigmaV2 = 0;

  for (const s of nearbyStations) {
    // Station weight = trust × quality × distance_decay
    const distDecay = Math.exp(-s.distance_km / 50); // Exponential decay, sigma=50km
    const qualityFactor = s.uq * s.uptime;
    const weight = s.trust * qualityFactor * distDecay;

    if (weight < 0.01) continue; // Skip negligible stations

    // Per-station horizontal sigma (meters)
    // Base sigma + distance-dependent + trust-dependent
    const sigmaH = (SIGMA_0 + STATION_SIGMA_SCALE * s.distance_km) / Math.max(0.1, s.trust);
    const sigmaV = sigmaH * 1.5; // Vertical is typically 1.5x worse than horizontal

    weightedSigmaH2 += weight * sigmaH * sigmaH;
    weightedSigmaV2 += weight * sigmaV * sigmaV;
    totalWeight += weight;

    stationsUsed.push({
      name: s.name,
      distance_km: Math.round(s.distance_km * 10) / 10,
      trust: Math.round(s.trust * 1000) / 1000,
      weight: Math.round(weight * 1000) / 1000,
    });
  }

  if (totalWeight === 0) {
    return {
      lat, lon, hpl_m: Infinity, vpl_m: Infinity, integrity_risk: 1.0,
      alert_limit_h: ALERT_LIMITS[tier].h, alert_limit_v: ALERT_LIMITS[tier].v,
      available: false, station_count: nearbyStations.length,
      nearest_station_km: nearbyStations[0]?.distance_km || Infinity,
      mean_trust: 0, expected_fix_rate: 0, kp_factor: kpFactor,
      confidence: "insufficient", stations_used: [], computed_at: new Date().toISOString(),
    };
  }

  // Weighted RMS sigma
  const sigmaH = Math.sqrt(weightedSigmaH2 / totalWeight) * kpFactor;
  const sigmaV = Math.sqrt(weightedSigmaV2 / totalWeight) * kpFactor;

  // Protection Level = K × sigma
  // K = 5.33 for integrity risk 10^-7 per hour (safety-of-life)
  const hpl = K_FACTOR * sigmaH;
  const vpl = K_FACTOR * sigmaV;

  // ── 5. Integrity risk ─────────────────────────────────────────────────────
  // P(position_error > alert_limit | no_alert)
  // Simplified: if PL < AL, integrity is available with risk based on PL/AL ratio

  const alertH = ALERT_LIMITS[tier].h;
  const alertV = ALERT_LIMITS[tier].v;
  const available = hpl < alertH && vpl < alertV;

  // Integrity risk approximation
  let integrityRisk: number;
  if (available) {
    // Risk decreases exponentially as PL decreases relative to AL
    const marginH = (alertH - hpl) / alertH;
    const marginV = (alertV - vpl) / alertV;
    const margin = Math.min(marginH, marginV);
    integrityRisk = Math.max(1e-9, Math.exp(-10 * margin)); // Very low risk when margin is large
  } else {
    integrityRisk = 1.0; // Not available = risk is 1
  }

  // ── 6. Historical fix rate at this location ───────────────────────────────

  let expectedFixRate = 0;
  try {
    const nearby = db.prepare(`
      SELECT AVG(fix_rate) as avg_fix
      FROM rtk_sessions
      WHERE login_time >= ? AND fix_rate > 0
        AND latitude BETWEEN ? AND ?
        AND longitude BETWEEN ? AND ?
        AND NOT (fix_rate = 0 AND duration >= 0 AND duration < 60)
      LIMIT 1000
    `).get(sixHoursAgo, lat - 0.5, lat + 0.5, lon - 0.5, lon + 0.5) as any;
    expectedFixRate = nearby?.avg_fix || 0;
  } catch {}

  // If no local data, estimate from station quality
  if (expectedFixRate === 0 && nearbyStations.length > 0) {
    expectedFixRate = nearbyStations.slice(0, 5)
      .reduce((s: number, st: any) => s + st.fix_rate, 0) / Math.min(5, nearbyStations.length);
  }

  // ── 7. Confidence classification ──────────────────────────────────────────

  const meanTrust = stationsUsed.reduce((s, st) => s + st.trust, 0) / Math.max(1, stationsUsed.length);
  let confidence: ProtectionLevel["confidence"] = "low";
  if (stationsUsed.length >= 5 && meanTrust >= 0.7 && expectedFixRate >= 80) {
    confidence = "high";
  } else if (stationsUsed.length >= 3 && meanTrust >= 0.5 && expectedFixRate >= 60) {
    confidence = "medium";
  } else if (stationsUsed.length >= 1) {
    confidence = "low";
  } else {
    confidence = "insufficient";
  }

  return {
    lat, lon,
    hpl_m: Math.round(hpl * 1000) / 1000,
    vpl_m: Math.round(vpl * 1000) / 1000,
    integrity_risk: Number(integrityRisk.toExponential(2)),
    alert_limit_h: alertH,
    alert_limit_v: alertV,
    available,
    station_count: stationsUsed.length,
    nearest_station_km: nearbyStations[0]?.distance_km || Infinity,
    mean_trust: Math.round(meanTrust * 1000) / 1000,
    expected_fix_rate: Math.round(expectedFixRate * 10) / 10,
    kp_factor: kpFactor,
    confidence,
    stations_used: stationsUsed.slice(0, 10), // Top 10
    computed_at: new Date().toISOString(),
  };
}
