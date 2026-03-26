// ─── Shared Feature Engineering ──────────────────────────────────────────────
// Extracts the same 18-feature vector used by both Random Forest and LightGBM.
// CRITICAL: Feature order and computation must match train-lightgbm.py exactly.

import { haversineKm } from "../spatial/variogram";

export const FEATURE_NAMES = [
  "station_uq_score", "station_uptime", "station_avg_fix_rate",
  "station_zero_fix_ratio", "station_session_count_log", "baseline_distance_km",
  "hour_of_day", "hour_sin", "hour_cos", "latitude_abs", "is_onocoy",
  "reliability_score", "correction_age", "duration", "day_of_week",
  "month", "month_sin", "month_cos",
];

export interface FeatureInput {
  // Station metrics
  uq_score: number;
  uptime_7d: number;
  avg_fix_rate: number;
  zero_fix_ratio: number;
  session_count: number;
  reliability_score: number;
  network: string;
  station_lat: number;
  station_lon: number;

  // Query context
  user_lat: number;
  user_lon: number;
  correction_age?: number;
  duration?: number;
  timestamp?: number; // epoch ms
}

/**
 * Extract feature vector from input. Returns Float32Array of length 18.
 * Order MUST match FEATURE_NAMES and Python training script.
 */
export function extractFeatures(input: FeatureInput): Float32Array {
  const now = input.timestamp ? new Date(input.timestamp) : new Date();
  const hour = now.getUTCHours();
  const dayOfWeek = now.getUTCDay();
  const month = now.getUTCMonth() + 1;

  const baselineKm = haversineKm(
    input.user_lat, input.user_lon,
    input.station_lat, input.station_lon
  );

  return new Float32Array([
    input.uq_score,                                          // 0
    input.uptime_7d,                                         // 1
    input.avg_fix_rate,                                      // 2
    input.zero_fix_ratio,                                    // 3
    Math.log1p(input.session_count),                         // 4
    Math.min(baselineKm, 200),                               // 5
    hour,                                                    // 6
    Math.sin(2 * Math.PI * hour / 24),                       // 7
    Math.cos(2 * Math.PI * hour / 24),                       // 8
    Math.abs(input.user_lat),                                // 9
    input.network.toLowerCase() === "onocoy" ? 1 : 0,       // 10
    input.reliability_score,                                 // 11
    input.correction_age || 0,                               // 12
    Math.min(input.duration || 300, 3600),                   // 13
    dayOfWeek,                                               // 14
    month,                                                   // 15
    Math.sin(2 * Math.PI * month / 12),                      // 16
    Math.cos(2 * Math.PI * month / 12),                      // 17
  ]);
}
