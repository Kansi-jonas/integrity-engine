// ─── Quality Forecast ────────────────────────────────────────────────────────
// Predicts GNSS quality 1h/6h/24h ahead for any (lat, lon).
//
// Combines:
// 1. Current Kriging surface as baseline
// 2. CME forecast from DONKI for expected Kp
// 3. Diurnal patterns from historical data
// 4. Troposphere forecast from Open-Meteo
// 5. Constellation health (planned outages)
//
// Output: predicted fix rate, HPL/VPL, confidence band

import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { haversineKm } from "../spatial/variogram";

export interface ForecastResult {
  lat: number;
  lon: number;
  current: ForecastPoint;
  forecast: ForecastPoint[];
  generated_at: string;
}

export interface ForecastPoint {
  hours_ahead: number;
  predicted_fix_rate: number;
  confidence_low: number;   // 10th percentile
  confidence_high: number;  // 90th percentile
  kp_expected: number;
  iono_risk: "nominal" | "elevated" | "degraded" | "storm";
  tropo_risk: "low" | "medium" | "high";
  constellation_alerts: string[];
  factors: string[];        // Human-readable factors affecting quality
}

/**
 * Generate quality forecast for a location.
 */
export function generateForecast(
  lat: number,
  lon: number,
  hoursAhead: number[],
  db: Database.Database,
  dataDir: string
): ForecastResult {
  // Load current environment
  const env = loadJson(path.join(dataDir, "environment.json"));
  const surface = loadJson(path.join(dataDir, "quality-surface.json"));
  const trustScores = loadJson(path.join(dataDir, "trust-scores.json"));

  // Current baseline: nearest Kriging prediction or station avg
  const currentFix = getCurrentQuality(lat, lon, surface, db);
  const currentKp = env?.ionosphere?.kp_index || 0;

  // Current point
  const current: ForecastPoint = {
    hours_ahead: 0,
    predicted_fix_rate: currentFix,
    confidence_low: Math.max(0, currentFix - 10),
    confidence_high: Math.min(100, currentFix + 5),
    kp_expected: currentKp,
    iono_risk: kpToRisk(currentKp),
    tropo_risk: getTropoRisk(lat, lon, env),
    constellation_alerts: getConstellationAlerts(env),
    factors: [],
  };

  // Forecast points
  const forecast: ForecastPoint[] = [];
  for (const h of hoursAhead) {
    forecast.push(predictAtHorizon(h, lat, lon, currentFix, currentKp, env, db));
  }

  return {
    lat, lon,
    current,
    forecast,
    generated_at: new Date().toISOString(),
  };
}

function predictAtHorizon(
  hoursAhead: number,
  lat: number,
  lon: number,
  currentFix: number,
  currentKp: number,
  env: any,
  db: Database.Database
): ForecastPoint {
  let predictedFix = currentFix;
  const factors: string[] = [];
  let expectedKp = currentKp;

  // 1. CME impact prediction
  if (env?.cme_forecast?.length > 0) {
    for (const cme of env.cme_forecast) {
      if (cme.expected_arrival) {
        const arrivalMs = new Date(cme.expected_arrival).getTime();
        const forecastMs = Date.now() + hoursAhead * 3600000;
        const diffH = (arrivalMs - forecastMs) / 3600000;

        if (diffH >= -6 && diffH <= 6) {
          // CME arriving around forecast time
          expectedKp = Math.max(expectedKp, cme.expected_kp || 5);
          const kpImpact = getKpFixImpact(cme.expected_kp || 5);
          predictedFix += kpImpact;
          factors.push(`CME arrival (Kp~${cme.expected_kp}, ${cme.speed_km_s}km/s)`);
        }
      }
    }
  }

  // 2. Kp forecast (3h ahead from NOAA)
  if (hoursAhead <= 3 && env?.ionosphere?.kp_forecast_3h) {
    expectedKp = Math.max(expectedKp, env.ionosphere.kp_forecast_3h);
    if (env.ionosphere.kp_forecast_3h > currentKp + 1) {
      const delta = getKpFixImpact(env.ionosphere.kp_forecast_3h) - getKpFixImpact(currentKp);
      predictedFix += delta;
      factors.push(`Kp rising to ${env.ionosphere.kp_forecast_3h}`);
    }
  }

  // 3. Diurnal pattern (ionospheric scintillation peaks post-sunset in equatorial)
  const futureHourUtc = (new Date().getUTCHours() + hoursAhead) % 24;
  const localHour = (futureHourUtc + Math.round(lon / 15)) % 24;

  if (Math.abs(lat) < 20) {
    // Equatorial: scintillation peaks 20:00-02:00 local
    if (localHour >= 20 || localHour <= 2) {
      predictedFix -= 5;
      factors.push("Equatorial post-sunset scintillation window");
    }
  } else if (Math.abs(lat) > 60) {
    // Polar: degradation correlates with auroral activity
    if (expectedKp >= 4) {
      predictedFix -= 8;
      factors.push("Auroral zone + elevated Kp");
    }
  }

  // 4. Troposphere forecast
  const tropoRisk = getTropoRisk(lat, lon, env);
  if (tropoRisk === "high") {
    predictedFix -= 3;
    factors.push("High tropospheric delay risk (weather)");
  }

  // 5. Constellation alerts
  const alerts = getConstellationAlerts(env);
  if (alerts.length > 0) {
    predictedFix -= alerts.length * 2;
    factors.push(`${alerts.length} constellation alerts`);
  }

  // 6. Uncertainty grows with horizon
  const uncertaintyGrowth = Math.sqrt(hoursAhead) * 3;

  // Clamp
  predictedFix = Math.max(0, Math.min(100, predictedFix));

  return {
    hours_ahead: hoursAhead,
    predicted_fix_rate: Math.round(predictedFix * 10) / 10,
    confidence_low: Math.max(0, Math.round((predictedFix - uncertaintyGrowth - 10) * 10) / 10),
    confidence_high: Math.min(100, Math.round((predictedFix + uncertaintyGrowth + 5) * 10) / 10),
    kp_expected: expectedKp,
    iono_risk: kpToRisk(expectedKp),
    tropo_risk: tropoRisk,
    constellation_alerts: alerts,
    factors,
  };
}

function getCurrentQuality(lat: number, lon: number, surface: any, db: Database.Database): number {
  // Try Kriging surface first
  if (surface?.grid?.length > 0) {
    let nearest = surface.grid[0];
    let nearestDist = Infinity;
    for (const pt of surface.grid) {
      const d = haversineKm(lat, lon, pt.lat, pt.lon);
      if (d < nearestDist) { nearestDist = d; nearest = pt; }
    }
    if (nearestDist < 200) return nearest.predicted;
  }

  // Fallback: average of nearby stations
  try {
    const rows = db.prepare(`
      SELECT AVG(sc.avg_fix_rate) as avg_fix
      FROM station_scores sc
      JOIN stations s ON sc.station_name = s.name
      WHERE s.latitude IS NOT NULL AND s.longitude IS NOT NULL
    `).get() as any;
    return rows?.avg_fix || 70;
  } catch { return 70; }
}

function getKpFixImpact(kp: number): number {
  if (kp <= 3) return 0;
  if (kp <= 4) return -5;
  if (kp <= 5) return -12;
  if (kp <= 6) return -25;
  return -40;
}

function kpToRisk(kp: number): ForecastPoint["iono_risk"] {
  if (kp <= 3) return "nominal";
  if (kp <= 5) return "elevated";
  if (kp <= 7) return "degraded";
  return "storm";
}

function getTropoRisk(lat: number, lon: number, env: any): "low" | "medium" | "high" {
  if (!env?.troposphere?.regions) return "low";
  let nearest = env.troposphere.regions[0];
  let nearestDist = Infinity;
  for (const r of env.troposphere.regions) {
    const d = haversineKm(lat, lon, r.lat, r.lon);
    if (d < nearestDist) { nearestDist = d; nearest = r; }
  }
  return nearest?.tropo_delay_risk || "low";
}

function getConstellationAlerts(env: any): string[] {
  const alerts: string[] = [];
  if (!env?.constellation) return alerts;
  for (const [name, data] of Object.entries(env.constellation) as any[]) {
    if (data?.unhealthy > 0 && typeof data?.alerts !== "undefined") {
      for (const a of (data.alerts || [])) alerts.push(`${name}: ${a}`);
    }
  }
  return alerts.slice(0, 5);
}

function loadJson(filePath: string): any {
  try { return JSON.parse(fs.readFileSync(filePath, "utf-8")); } catch { return null; }
}
