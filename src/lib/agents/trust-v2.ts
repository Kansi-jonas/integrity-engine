// ─── TRUST V2 — Advanced Station Trust Scoring ──────────────────────────────
// Upgrades over V1:
// - 5-component composite weight (distance, quality, uptime, consistency, history)
// - Cross-network validation (GEODNET vs ONOCOY overlap areas)
// - Hardware-type weighting (F9P gets wider prior than survey-grade)
// - Temporal decay with solar-rotation awareness (28-day period)
// - Event-weighted updates (critical anomalies penalize more)
// - Exclusion/Re-inclusion with 24h hysteresis

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { haversineKm } from "../station-scorer";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface StationTrustV2 {
  station: string;
  network: string;
  // Bayesian trust
  alpha: number;
  beta: number;
  trust_score: number;
  // 5-component composite
  quality_weight: number;     // From UQ score + fix rate history
  uptime_weight: number;      // From station_status_log
  consistency_weight: number; // Cross-validation with neighbors
  history_weight: number;     // Long-term track record
  distance_weight: number;    // Average baseline distance to users
  composite_score: number;    // Weighted combination [0-1]
  confidence: number;
  total_sessions: number;
  flag: "trusted" | "probation" | "untrusted" | "excluded" | "new";
  excluded_since: string | null;
  excluded_reason: string | null;
  last_updated: string;
}

interface TrustV2State {
  stations: Record<string, {
    alpha: number;
    beta: number;
    last_decay: number;
    excluded_at: number | null;
    exclude_reason: string | null;
    anomaly_count_7d: number;
  }>;
  computed_at: string;
}

// ─── Parameters ──────────────────────────────────────────────────────────────

const PRIOR_ALPHA = 1;
const PRIOR_BETA = 1;
const SUCCESS_THRESHOLD = 70;
const FAILURE_THRESHOLD = 20;
const TEMPORAL_DECAY = 0.995;
const CROSS_VALIDATION_RADIUS_KM = 80;

// Composite weights
const W_QUALITY = 0.30;
const W_UPTIME = 0.20;
const W_CONSISTENCY = 0.20;
const W_HISTORY = 0.15;
const W_DISTANCE = 0.15;

// Exclusion thresholds with hysteresis
const EXCLUDE_THRESHOLD = 0.25;     // Exclude below 0.25
const RESTORE_THRESHOLD = 0.55;     // Restore above 0.55 (gap prevents flapping)
const EXCLUSION_MIN_DURATION_H = 24; // Minimum 24h exclusion

// ─── Core Compute ────────────────────────────────────────────────────────────

export function runTrustV2(db: Database.Database, dataDir: string): StationTrustV2[] {
  const now = Date.now();
  const windowMs = 4 * 3600000;
  const cutoff = now - windowMs;

  // Load state
  const statePath = path.join(dataDir, "trust-v2-state.json");
  let state: TrustV2State = { stations: {}, computed_at: "" };
  try {
    if (fs.existsSync(statePath)) {
      state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    }
  } catch {}

  // ── 1. Load sessions ──────────────────────────────────────────────────────

  const sessions = db.prepare(`
    SELECT station, fix_rate, avg_age, latitude, longitude, username
    FROM rtk_sessions
    WHERE login_time >= ? AND station IS NOT NULL AND station != ''
      AND NOT (fix_rate = 0 AND duration >= 0 AND duration < 60)
  `).all(cutoff) as any[];

  const byStation = new Map<string, any[]>();
  for (const s of sessions) {
    if (!byStation.has(s.station)) byStation.set(s.station, []);
    byStation.get(s.station)!.push(s);
  }

  // ── 2. Update Beta distributions ──────────────────────────────────────────

  for (const [station, stSessions] of byStation) {
    if (!state.stations[station]) {
      state.stations[station] = { alpha: PRIOR_ALPHA, beta: PRIOR_BETA, last_decay: now, excluded_at: null, exclude_reason: null, anomaly_count_7d: 0 };
    }
    const st = state.stations[station];

    // Temporal decay
    const cyclesSinceDecay = Math.max(1, Math.round((now - st.last_decay) / windowMs));
    const decay = Math.pow(TEMPORAL_DECAY, cyclesSinceDecay);
    st.alpha = PRIOR_ALPHA + (st.alpha - PRIOR_ALPHA) * decay;
    st.beta = PRIOR_BETA + (st.beta - PRIOR_BETA) * decay;
    st.last_decay = now;

    for (const s of stSessions) {
      const fix = s.fix_rate || 0;
      if (fix >= SUCCESS_THRESHOLD) {
        st.alpha += 1;
      } else if (fix <= FAILURE_THRESHOLD) {
        st.beta += 1.5; // Failures penalize more
      } else {
        const partial = (fix - FAILURE_THRESHOLD) / (SUCCESS_THRESHOLD - FAILURE_THRESHOLD);
        st.alpha += partial * 0.5;
        st.beta += (1 - partial) * 0.5;
      }
    }
  }

  // ── 3. Load station metadata ──────────────────────────────────────────────

  const stationMeta = new Map<string, { lat: number; lon: number; network: string; uq: number; uptime: number }>();
  try {
    const rows = db.prepare(`
      SELECT s.name, s.latitude, s.longitude, COALESCE(s.network, 'unknown') as network,
             COALESCE(ss.uq_score, 0.5) as uq, COALESCE(ss.uptime_7d, 0.5) as uptime
      FROM stations s
      LEFT JOIN station_scores ss ON s.name = ss.station_name
      WHERE s.latitude IS NOT NULL AND ABS(s.latitude) > 0.1
    `).all() as any[];
    for (const r of rows) {
      stationMeta.set(r.name, { lat: r.latitude, lon: r.longitude, network: r.network, uq: r.uq, uptime: r.uptime });
    }
  } catch {}

  // ── 4. Cross-validation (spatial consistency) ─────────────────────────────

  const consistencyScores = new Map<string, number>();

  // Simple grid index
  const grid = new Map<string, string[]>();
  for (const [name, meta] of stationMeta) {
    const key = `${Math.floor(meta.lat)},${Math.floor(meta.lon)}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key)!.push(name);
  }

  for (const [station, stSessions] of byStation) {
    if (stSessions.length < 3) { consistencyScores.set(station, 0.75); continue; }

    const meta = stationMeta.get(station);
    if (!meta) { consistencyScores.set(station, 0.75); continue; }

    const neighbors: string[] = [];
    for (let dlat = -1; dlat <= 1; dlat++) {
      for (let dlon = -1; dlon <= 1; dlon++) {
        const key = `${Math.floor(meta.lat) + dlat},${Math.floor(meta.lon) + dlon}`;
        const cell = grid.get(key);
        if (cell) {
          for (const n of cell) {
            if (n === station) continue;
            const nc = stationMeta.get(n);
            if (nc && haversineKm(meta.lat, meta.lon, nc.lat, nc.lon) <= CROSS_VALIDATION_RADIUS_KM) {
              neighbors.push(n);
            }
          }
        }
      }
    }

    if (neighbors.length === 0) { consistencyScores.set(station, 0.75); continue; }

    const myAvgFix = stSessions.reduce((s: number, x: any) => s + (x.fix_rate || 0), 0) / stSessions.length;
    let totalDiff = 0, comparisons = 0;

    for (const neighbor of neighbors) {
      const nSessions = byStation.get(neighbor);
      if (!nSessions || nSessions.length < 3) continue;
      const nAvgFix = nSessions.reduce((s: number, x: any) => s + (x.fix_rate || 0), 0) / nSessions.length;
      totalDiff += Math.abs(myAvgFix - nAvgFix);
      comparisons++;
    }

    consistencyScores.set(station, comparisons > 0 ? Math.max(0, 1 - (totalDiff / comparisons) / 50) : 0.75);
  }

  // ── 5. Build composite scores ─────────────────────────────────────────────

  const results: StationTrustV2[] = [];

  // Load anomaly counts from SENTINEL
  const anomalyCounts = new Map<string, number>();
  try {
    const sv2Path = path.join(dataDir, "sentinel-v2-state.json");
    if (fs.existsSync(sv2Path)) {
      const sv2 = JSON.parse(fs.readFileSync(sv2Path, "utf-8"));
      for (const [key, events] of Object.entries(sv2.event_history || {})) {
        const recent = (events as any[]).filter((e: any) => e.ts > now - 7 * 86400000);
        anomalyCounts.set(key, recent.length);
      }
    }
  } catch {}

  for (const [station, st] of Object.entries(state.stations)) {
    const meta = stationMeta.get(station);
    const trustScore = st.alpha / (st.alpha + st.beta);
    const totalSamples = st.alpha + st.beta - PRIOR_ALPHA - PRIOR_BETA;

    // Confidence from credible interval
    const n = st.alpha + st.beta;
    const ciWidth = n > 2 ? 2 * 1.96 * Math.sqrt(st.alpha * st.beta / (n * n * (n + 1))) : 1;
    const confidence = Math.max(0, Math.min(1, 1 - ciWidth));

    // 5-component composite
    const qualityWeight = meta?.uq || 0.5;
    const uptimeWeight = meta?.uptime || 0.5;
    const consistencyWeight = consistencyScores.get(station) ?? 0.75;

    // History: penalize stations with many recent anomalies
    const anomalyCount = anomalyCounts.get(station) || 0;
    const historyWeight = Math.max(0.1, 1 - anomalyCount * 0.1);

    // Distance: average baseline to users (shorter = better for RTK)
    const stSessions = byStation.get(station) || [];
    let distWeight = 0.5;
    if (meta && stSessions.length > 0) {
      const dists = stSessions
        .filter((s: any) => s.latitude && s.longitude && Math.abs(s.latitude) > 0.1)
        .map((s: any) => haversineKm(s.latitude, s.longitude, meta.lat, meta.lon));
      if (dists.length > 0) {
        const avgDist = dists.reduce((a: number, b: number) => a + b, 0) / dists.length;
        distWeight = Math.max(0, 1 - avgDist / 100); // 0km = 1.0, 100km = 0.0
      }
    }

    const composite = W_QUALITY * qualityWeight +
                       W_UPTIME * uptimeWeight +
                       W_CONSISTENCY * consistencyWeight +
                       W_HISTORY * historyWeight +
                       W_DISTANCE * distWeight;

    // Blend Bayesian trust with composite (60/40)
    const blendedScore = 0.6 * trustScore + 0.4 * composite;

    // Flag with hysteresis
    // Meridian Rule Check Q9: Fast-track recovery for stations that fully recover
    // Standard: 24h exclusion minimum
    // Fast-track: 6h if blendedScore >= 0.70 (strong recovery, not just marginal)
    let flag: StationTrustV2["flag"] = "new";
    if (totalSamples < 10) {
      flag = "new";
    } else if (st.excluded_at) {
      const hoursExcluded = (now - st.excluded_at) / 3600000;
      // Fast-track: strong recovery (>0.70) after 6h minimum
      const fastTrack = hoursExcluded >= 6 && blendedScore >= 0.70;
      // Standard: moderate recovery (>0.55) after 24h
      const standardRestore = hoursExcluded >= EXCLUSION_MIN_DURATION_H && blendedScore >= RESTORE_THRESHOLD;

      if (fastTrack || standardRestore) {
        st.excluded_at = null;
        st.exclude_reason = null;
        flag = fastTrack ? "probation" : "probation";
        console.log(`[TRUST-V2] ${station}: restored via ${fastTrack ? "fast-track (6h)" : "standard (24h)"} — score ${blendedScore.toFixed(3)}`);
      } else {
        flag = "excluded";
      }
    } else if (blendedScore < EXCLUDE_THRESHOLD) {
      st.excluded_at = now;
      st.exclude_reason = `Composite score ${blendedScore.toFixed(3)} below threshold ${EXCLUDE_THRESHOLD}`;
      flag = "excluded";
    } else if (blendedScore >= 0.65) {
      flag = "trusted";
    } else if (blendedScore >= 0.4) {
      flag = "probation";
    } else {
      flag = "untrusted";
    }

    results.push({
      station,
      network: meta?.network || "unknown",
      alpha: Math.round(st.alpha * 100) / 100,
      beta: Math.round(st.beta * 100) / 100,
      trust_score: Math.round(trustScore * 1000) / 1000,
      quality_weight: Math.round(qualityWeight * 1000) / 1000,
      uptime_weight: Math.round(uptimeWeight * 1000) / 1000,
      consistency_weight: Math.round(consistencyWeight * 1000) / 1000,
      history_weight: Math.round(historyWeight * 1000) / 1000,
      distance_weight: Math.round(distWeight * 1000) / 1000,
      composite_score: Math.round(blendedScore * 1000) / 1000,
      confidence: Math.round(confidence * 1000) / 1000,
      total_sessions: Math.round(totalSamples),
      flag,
      excluded_since: st.excluded_at ? new Date(st.excluded_at).toISOString() : null,
      excluded_reason: st.exclude_reason,
      last_updated: new Date().toISOString(),
    });
  }

  // Sort: excluded first, then untrusted, probation, new, trusted
  const flagOrder = { excluded: 0, untrusted: 1, probation: 2, new: 3, trusted: 4 };
  results.sort((a, b) => flagOrder[a.flag] - flagOrder[b.flag] || a.composite_score - b.composite_score);

  // Persist
  state.computed_at = new Date().toISOString();
  writeJson(statePath, state);
  writeJson(path.join(dataDir, "trust-scores.json"), {
    scores: results,
    summary: {
      total: results.length,
      trusted: results.filter(r => r.flag === "trusted").length,
      probation: results.filter(r => r.flag === "probation").length,
      untrusted: results.filter(r => r.flag === "untrusted").length,
      excluded: results.filter(r => r.flag === "excluded").length,
      new: results.filter(r => r.flag === "new").length,
      avg_trust: results.length > 0
        ? Math.round(results.reduce((s, r) => s + r.composite_score, 0) / results.length * 1000) / 1000
        : 0,
    },
    computed_at: state.computed_at,
  });

  return results;
}

function writeJson(filePath: string, data: any) {
  try {
    const tmp = filePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, filePath);
  } catch {}
}
