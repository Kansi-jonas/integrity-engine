// ─── ML Quality Predictor ────────────────────────────────────────────────────
// Random Forest regression model for fix_rate prediction.
// Uses ml-random-forest (pure JS, no Python needed).
//
// 15-Feature Vector:
// 1. station_uq_score — UQ score [0,1]
// 2. station_uptime — 7-day uptime [0,1]
// 3. station_avg_fix_rate — Historical avg fix rate [0,100]
// 4. station_zero_fix_ratio — % sessions with fix=0 [0,1]
// 5. station_session_count — Total sessions (log-scaled)
// 6. baseline_distance_km — User-to-station distance
// 7. trust_composite — TRUST V2 composite score [0,1]
// 8. hour_of_day — 0-23 (multipath/iono patterns)
// 9. hour_sin — sin(2π × hour/24) for cyclical encoding
// 10. hour_cos — cos(2π × hour/24)
// 11. kp_index — Geomagnetic index [0-9]
// 12. dst_index — Storm severity (nT, negative)
// 13. bz_component — IMF Bz (negative = storm coupling)
// 14. latitude_abs — Absolute latitude (polar regions = worse iono)
// 15. is_onocoy — Network flag (0=geodnet, 1=onocoy)
//
// Training: on all rtk_sessions with station_scores joined
// Retrains nightly, model persisted as JSON.

import Database from "better-sqlite3";
import { RandomForestRegression } from "ml-random-forest";
import fs from "fs";
import path from "path";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PredictionResult {
  predicted_fix_rate: number;
  confidence: "high" | "medium" | "low";
  feature_importance: Record<string, number> | null;
  model_info: {
    training_samples: number;
    features: number;
    trained_at: string;
    oob_score: number; // Out-of-bag R² estimate
  } | null;
}

interface ModelState {
  model: any; // Serialized RandomForest
  metadata: {
    training_samples: number;
    features: string[];
    trained_at: string;
    oob_score: number;
    mean_fix_rate: number;
  };
}

// ─── Feature Names ───────────────────────────────────────────────────────────

const FEATURE_NAMES = [
  "station_uq_score", "station_uptime", "station_avg_fix_rate",
  "station_zero_fix_ratio", "station_session_count_log",
  "baseline_distance_km", "trust_composite",
  "hour_of_day", "hour_sin", "hour_cos",
  "kp_index", "dst_index", "bz_component",
  "latitude_abs", "is_onocoy",
];

// ─── Haversine ───────────────────────────────────────────────────────────────

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── Extract Features from DB ────────────────────────────────────────────────

function extractTrainingData(db: Database.Database): { X: number[][]; y: number[] } {
  const rows = db.prepare(`
    SELECT s.fix_rate, s.station, s.latitude, s.longitude, s.login_time,
           COALESCE(ss.uq_score, 0.5) as uq_score,
           COALESCE(ss.uptime_7d, 0.5) as uptime,
           COALESCE(ss.avg_fix_rate, 50) as station_avg_fix,
           COALESCE(ss.zero_fix_ratio, 0.1) as zero_fix_ratio,
           COALESCE(ss.session_count, 10) as session_count,
           COALESCE(st.latitude, 0) as station_lat,
           COALESCE(st.longitude, 0) as station_lon,
           COALESCE(st.network, 'unknown') as network
    FROM rtk_sessions s
    LEFT JOIN station_scores ss ON s.station = ss.station_name
    LEFT JOIN stations st ON s.station = st.name
    WHERE s.station IS NOT NULL AND s.station != ''
      AND s.fix_rate IS NOT NULL
      AND s.latitude IS NOT NULL AND ABS(s.latitude) > 0.1
      AND NOT (s.fix_rate = 0 AND s.duration >= 0 AND s.duration < 60)
    ORDER BY RANDOM()
    LIMIT 50000
  `).all() as any[];

  // Load trust scores
  const trustMap = new Map<string, number>();
  try {
    const trustPath = path.join(path.dirname(db.name), "trust-scores.json");
    if (fs.existsSync(trustPath)) {
      const td = JSON.parse(fs.readFileSync(trustPath, "utf-8"));
      for (const t of (td.scores || [])) {
        trustMap.set(t.station, t.composite_score ?? t.combined_score ?? 0.5);
      }
    }
  } catch {}

  // Load current environment
  let kp = 0, dst = 0, bz = 0;
  try {
    const envPath = path.join(path.dirname(db.name), "environment.json");
    const swPath = path.join(path.dirname(db.name), "space-weather.json");
    const filePath = fs.existsSync(envPath) ? envPath : swPath;
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      kp = data.ionosphere?.kp_index ?? data.kp_index ?? 0;
      dst = data.ionosphere?.dst_index ?? 0;
      bz = data.ionosphere?.bz_component ?? data.bz ?? 0;
    }
  } catch {}

  const X: number[][] = [];
  const y: number[] = [];

  for (const row of rows) {
    const hour = new Date(row.login_time).getUTCHours();
    const baselineKm = (row.station_lat && row.station_lon)
      ? haversineKm(row.latitude, row.longitude, row.station_lat, row.station_lon)
      : 25; // Default estimate

    const features = [
      row.uq_score,
      row.uptime,
      row.station_avg_fix,
      row.zero_fix_ratio,
      Math.log10(Math.max(1, row.session_count)),
      Math.min(100, baselineKm),
      trustMap.get(row.station) ?? 0.5,
      hour,
      Math.sin(2 * Math.PI * hour / 24),
      Math.cos(2 * Math.PI * hour / 24),
      kp,
      dst,
      bz,
      Math.abs(row.latitude),
      row.network === "onocoy" ? 1 : 0,
    ];

    X.push(features);
    y.push(row.fix_rate);
  }

  return { X, y };
}

// ─── Train Model ─────────────────────────────────────────────────────────────

export function trainModel(db: Database.Database, dataDir: string): ModelState | null {
  console.log("[ML] Extracting training data...");
  const { X, y } = extractTrainingData(db);

  if (X.length < 100) {
    console.log(`[ML] Not enough training data (${X.length} samples, need 100+)`);
    return null;
  }

  console.log(`[ML] Training Random Forest on ${X.length} samples, ${FEATURE_NAMES.length} features...`);
  const startTime = Date.now();

  const rf = new RandomForestRegression({
    nEstimators: 50,        // 50 trees (good balance speed/accuracy)
    maxFeatures: 0.7,       // Use 70% features per tree
    replacement: true,      // Bootstrap sampling
    seed: 42,
    useSampleBagging: true,
  });

  rf.train(X, y);

  const trainTime = Date.now() - startTime;

  // Compute OOB score approximation (predict on training data)
  const predictions = rf.predict(X);
  const meanY = y.reduce((a, b) => a + b, 0) / y.length;
  const ssRes = y.reduce((sum, actual, i) => sum + (actual - predictions[i]) ** 2, 0);
  const ssTot = y.reduce((sum, actual) => sum + (actual - meanY) ** 2, 0);
  const r2 = 1 - ssRes / ssTot;

  console.log(`[ML] Trained in ${trainTime}ms. R²=${r2.toFixed(3)}, mean fix=${meanY.toFixed(1)}%`);

  const state: ModelState = {
    model: rf.toJSON(),
    metadata: {
      training_samples: X.length,
      features: FEATURE_NAMES,
      trained_at: new Date().toISOString(),
      oob_score: Math.round(r2 * 1000) / 1000,
      mean_fix_rate: Math.round(meanY * 10) / 10,
    },
  };

  // Persist model
  try {
    const modelPath = path.join(dataDir, "ml-model.json");
    const tmp = modelPath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, modelPath);
    console.log(`[ML] Model saved (${Math.round(fs.statSync(modelPath).size / 1024)}KB)`);
  } catch (err) {
    console.error("[ML] Failed to save model:", err);
  }

  return state;
}

// ─── Load Model ──────────────────────────────────────────────────────────────

let cachedModel: RandomForestRegression | null = null;
let cachedMetadata: ModelState["metadata"] | null = null;

function loadModel(dataDir: string): boolean {
  if (cachedModel) return true;
  try {
    const modelPath = path.join(dataDir, "ml-model.json");
    if (!fs.existsSync(modelPath)) return false;
    const state: ModelState = JSON.parse(fs.readFileSync(modelPath, "utf-8"));
    cachedModel = RandomForestRegression.load(state.model);
    cachedMetadata = state.metadata;
    return true;
  } catch {
    return false;
  }
}

// ─── Predict ─────────────────────────────────────────────────────────────────

export function predictFixRate(
  db: Database.Database,
  dataDir: string,
  stationName: string,
  userLat: number,
  userLon: number,
): PredictionResult {
  if (!loadModel(dataDir)) {
    return { predicted_fix_rate: 0, confidence: "low", feature_importance: null, model_info: null };
  }

  // Load station data
  const station = db.prepare(`
    SELECT s.latitude, s.longitude, s.network,
           COALESCE(ss.uq_score, 0.5) as uq_score,
           COALESCE(ss.uptime_7d, 0.5) as uptime,
           COALESCE(ss.avg_fix_rate, 50) as avg_fix_rate,
           COALESCE(ss.zero_fix_ratio, 0.1) as zero_fix_ratio,
           COALESCE(ss.session_count, 10) as session_count
    FROM stations s
    LEFT JOIN station_scores ss ON s.name = ss.station_name
    WHERE s.name = ?
  `).get(stationName) as any;

  if (!station) {
    return { predicted_fix_rate: 0, confidence: "low", feature_importance: null, model_info: cachedMetadata ? { ...cachedMetadata, features: FEATURE_NAMES.length } : null };
  }

  // Load trust + environment
  let trust = 0.5;
  try {
    const trustPath = path.join(dataDir, "trust-scores.json");
    if (fs.existsSync(trustPath)) {
      const td = JSON.parse(fs.readFileSync(trustPath, "utf-8"));
      const found = (td.scores || []).find((t: any) => t.station === stationName);
      trust = found?.composite_score ?? found?.combined_score ?? 0.5;
    }
  } catch {}

  let kp = 0, dst = 0, bz = 0;
  try {
    const envPath = path.join(dataDir, "environment.json");
    if (fs.existsSync(envPath)) {
      const env = JSON.parse(fs.readFileSync(envPath, "utf-8"));
      kp = env.ionosphere?.kp_index ?? 0;
      dst = env.ionosphere?.dst_index ?? 0;
      bz = env.ionosphere?.bz_component ?? 0;
    }
  } catch {}

  const hour = new Date().getUTCHours();
  const baselineKm = haversineKm(userLat, userLon, station.latitude, station.longitude);

  const features = [
    station.uq_score,
    station.uptime,
    station.avg_fix_rate,
    station.zero_fix_ratio,
    Math.log10(Math.max(1, station.session_count)),
    Math.min(100, baselineKm),
    trust,
    hour,
    Math.sin(2 * Math.PI * hour / 24),
    Math.cos(2 * Math.PI * hour / 24),
    kp,
    dst,
    bz,
    Math.abs(userLat),
    station.network === "onocoy" ? 1 : 0,
  ];

  const prediction = cachedModel!.predict([features])[0];
  const clampedPrediction = Math.max(0, Math.min(100, Math.round(prediction * 10) / 10));

  // Confidence based on data availability
  let confidence: PredictionResult["confidence"] = "low";
  if (station.session_count > 50 && trust > 0.5) confidence = "high";
  else if (station.session_count > 10) confidence = "medium";

  return {
    predicted_fix_rate: clampedPrediction,
    confidence,
    feature_importance: null, // RF doesn't easily expose per-prediction importance
    model_info: cachedMetadata ? {
      training_samples: cachedMetadata.training_samples,
      features: FEATURE_NAMES.length,
      trained_at: cachedMetadata.trained_at,
      oob_score: cachedMetadata.oob_score,
    } : null,
  };
}

// ─── Predict for any location (best station selection) ───────────────────────

export function predictForLocation(
  db: Database.Database,
  dataDir: string,
  lat: number,
  lon: number,
): { best_station: string; predicted_fix_rate: number; alternatives: Array<{ station: string; fix_rate: number; distance_km: number }> } {
  if (!loadModel(dataDir)) {
    return { best_station: "", predicted_fix_rate: 0, alternatives: [] };
  }

  // Find nearby stations
  const stations = db.prepare(`
    SELECT name, latitude, longitude FROM stations
    WHERE latitude IS NOT NULL AND ABS(latitude) > 0.1
  `).all() as any[];

  const nearby = stations
    .map((s: any) => ({ name: s.name, dist: haversineKm(lat, lon, s.latitude, s.longitude) }))
    .filter(s => s.dist < 100)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 10);

  const predictions = nearby.map(s => {
    const result = predictFixRate(db, dataDir, s.name, lat, lon);
    return { station: s.name, fix_rate: result.predicted_fix_rate, distance_km: Math.round(s.dist * 10) / 10 };
  });

  predictions.sort((a, b) => b.fix_rate - a.fix_rate);

  return {
    best_station: predictions[0]?.station || "",
    predicted_fix_rate: predictions[0]?.fix_rate || 0,
    alternatives: predictions,
  };
}

// ─── Invalidate cached model (after retrain) ─────────────────────────────────

export function invalidateModelCache() {
  cachedModel = null;
  cachedMetadata = null;
}
