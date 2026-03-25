// ─── TRUST Agent ─────────────────────────────────────────────────────────────
// Bayesian Beta-Distribution trust scoring for DePIN stations.
// Every station starts with Beta(1,1) = uniform prior (no opinion).
// Each successful session (fix_rate > 70%) adds to alpha (trust).
// Each failed session (fix_rate < 20%) adds to beta (distrust).
// Trust score = E[Beta(α,β)] = α/(α+β), credible interval width shows confidence.
//
// Runs every 4 hours as part of the quality pipeline.
// Also performs cross-validation: stations covering the same area should produce
// similar fix rates. Inconsistent stations get trust penalties.
//
// Output: trust-scores.json + updates station_scores table

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { haversineKm } from "../station-scorer";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface StationTrust {
  station: string;
  network: string;
  alpha: number;          // Beta distribution α (successes)
  beta: number;           // Beta distribution β (failures)
  trust_score: number;    // E[Beta] = α/(α+β)
  confidence: number;     // 1 - credible interval width (higher = more data)
  consistency: number;    // Cross-validation score [0,1]
  combined_score: number; // 0.7 * trust + 0.3 * consistency
  total_sessions: number;
  flag: "trusted" | "probation" | "untrusted" | "new";
  last_updated: string;
}

export interface TrustState {
  stations: Record<string, { alpha: number; beta: number; last_decay: number }>;
  computed_at: string;
}

// ─── Parameters ──────────────────────────────────────────────────────────────

const PRIOR_ALPHA = 1;          // Uninformative prior
const PRIOR_BETA = 1;
const SUCCESS_THRESHOLD = 70;   // fix_rate > 70% = success
const FAILURE_THRESHOLD = 20;   // fix_rate < 20% = failure
const TEMPORAL_DECAY = 0.995;   // Per-cycle decay (halves trust every ~139 cycles = ~23 days at 4h)
const CROSS_VALIDATION_RADIUS_KM = 80; // Stations within 80km should agree
const MIN_SESSIONS_FOR_TRUST = 10;
const MIN_OVERLAP_SESSIONS = 5; // Need 5+ concurrent sessions for cross-validation

// Trust flags
const TRUSTED_THRESHOLD = 0.7;
const PROBATION_THRESHOLD = 0.4;

// ─── Core Compute ────────────────────────────────────────────────────────────

export function runTrust(db: Database.Database, dataDir: string): StationTrust[] {
  const now = Date.now();
  const windowMs = 4 * 3600000; // Last 4 hours (since last run)
  const cutoff = now - windowMs;

  // Load persisted state
  const statePath = path.join(dataDir, "trust-state.json");
  let state: TrustState = { stations: {}, computed_at: "" };
  try {
    if (fs.existsSync(statePath)) {
      state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    }
  } catch {}

  // ── 1. Load new sessions since last run ───────────────────────────────────

  const sessions = db.prepare(`
    SELECT station, fix_rate, avg_age, latitude, longitude, username
    FROM rtk_sessions
    WHERE login_time >= ? AND station IS NOT NULL AND station != ''
      AND fix_rate IS NOT NULL
  `).all(cutoff) as any[];

  // ── 2. Update Beta distributions ──────────────────────────────────────────

  const sessionsByStation = new Map<string, any[]>();
  for (const s of sessions) {
    if (!sessionsByStation.has(s.station)) sessionsByStation.set(s.station, []);
    sessionsByStation.get(s.station)!.push(s);
  }

  for (const [station, stSessions] of sessionsByStation) {
    if (!state.stations[station]) {
      state.stations[station] = { alpha: PRIOR_ALPHA, beta: PRIOR_BETA, last_decay: now };
    }
    const st = state.stations[station];

    // Apply temporal decay first (shrink towards prior)
    const cyclesSinceDecay = Math.max(1, Math.round((now - st.last_decay) / (4 * 3600000)));
    const decay = Math.pow(TEMPORAL_DECAY, cyclesSinceDecay);
    st.alpha = PRIOR_ALPHA + (st.alpha - PRIOR_ALPHA) * decay;
    st.beta = PRIOR_BETA + (st.beta - PRIOR_BETA) * decay;
    st.last_decay = now;

    // Update with new observations
    for (const s of stSessions) {
      const fixRate = s.fix_rate || 0;
      if (fixRate >= SUCCESS_THRESHOLD) {
        st.alpha += 1;
      } else if (fixRate <= FAILURE_THRESHOLD) {
        st.beta += 1;
      } else {
        // Partial update for middle-range fix rates
        const partial = (fixRate - FAILURE_THRESHOLD) / (SUCCESS_THRESHOLD - FAILURE_THRESHOLD);
        st.alpha += partial * 0.5;
        st.beta += (1 - partial) * 0.5;
      }
    }
  }

  // ── 3. Load station coordinates for cross-validation ──────────────────────

  const stationCoords = new Map<string, { lat: number; lon: number }>();
  const stationNetworks = new Map<string, string>();

  try {
    const rows = db.prepare(`
      SELECT s.name, s.latitude, s.longitude, COALESCE(s.network, ss.network, 'unknown') as network
      FROM stations s
      LEFT JOIN station_scores ss ON s.name = ss.station_name
      WHERE s.latitude IS NOT NULL AND ABS(s.latitude) > 0.1
    `).all() as any[];
    for (const r of rows) {
      stationCoords.set(r.name, { lat: r.latitude, lon: r.longitude });
      stationNetworks.set(r.name, r.network);
    }
  } catch {}

  // ── 4. Cross-validation ───────────────────────────────────────────────────
  // Stations within 80km should produce similar fix rates for their users.
  // If Station A's users get 90% fix but Station B (nearby) gets 30%, B is suspect.

  const consistencyScores = new Map<string, number>();

  // Build spatial index (simple grid for performance)
  const grid = new Map<string, string[]>();
  for (const [name, coords] of stationCoords) {
    const key = `${Math.floor(coords.lat)},${Math.floor(coords.lon)}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key)!.push(name);
  }

  for (const [station, stSessions] of sessionsByStation) {
    if (stSessions.length < MIN_OVERLAP_SESSIONS) {
      consistencyScores.set(station, 0.75); // Default for low-data stations
      continue;
    }

    const coords = stationCoords.get(station);
    if (!coords) {
      consistencyScores.set(station, 0.75);
      continue;
    }

    // Find neighbors in adjacent grid cells
    const neighbors: string[] = [];
    for (let dlat = -1; dlat <= 1; dlat++) {
      for (let dlon = -1; dlon <= 1; dlon++) {
        const key = `${Math.floor(coords.lat) + dlat},${Math.floor(coords.lon) + dlon}`;
        const cell = grid.get(key);
        if (cell) {
          for (const n of cell) {
            if (n === station) continue;
            const nc = stationCoords.get(n);
            if (nc && haversineKm(coords.lat, coords.lon, nc.lat, nc.lon) <= CROSS_VALIDATION_RADIUS_KM) {
              neighbors.push(n);
            }
          }
        }
      }
    }

    if (neighbors.length === 0) {
      consistencyScores.set(station, 0.75); // No neighbors to compare
      continue;
    }

    // Compare fix rates with neighbors
    const myAvgFix = stSessions.reduce((s: number, x: any) => s + (x.fix_rate || 0), 0) / stSessions.length;
    let totalDiff = 0;
    let comparisons = 0;

    for (const neighbor of neighbors) {
      const nSessions = sessionsByStation.get(neighbor);
      if (!nSessions || nSessions.length < MIN_OVERLAP_SESSIONS) continue;
      const nAvgFix = nSessions.reduce((s: number, x: any) => s + (x.fix_rate || 0), 0) / nSessions.length;
      totalDiff += Math.abs(myAvgFix - nAvgFix);
      comparisons++;
    }

    if (comparisons > 0) {
      const avgDiff = totalDiff / comparisons;
      // Consistency = 1 when fix rates match, 0 when they differ by 100%
      consistencyScores.set(station, Math.max(0, 1 - avgDiff / 50));
    } else {
      consistencyScores.set(station, 0.75);
    }
  }

  // ── 5. Build final trust scores ───────────────────────────────────────────

  const results: StationTrust[] = [];

  for (const [station, st] of Object.entries(state.stations)) {
    const trustScore = st.alpha / (st.alpha + st.beta);
    const totalSamples = st.alpha + st.beta - PRIOR_ALPHA - PRIOR_BETA;

    // 95% credible interval width (Beta distribution approximation)
    const n = st.alpha + st.beta;
    const ciWidth = n > 2 ? 2 * 1.96 * Math.sqrt(st.alpha * st.beta / (n * n * (n + 1))) : 1;
    const confidence = Math.max(0, Math.min(1, 1 - ciWidth));

    const consistency = consistencyScores.get(station) ?? 0.75;
    const combinedScore = 0.7 * trustScore + 0.3 * consistency;

    let flag: "trusted" | "probation" | "untrusted" | "new" = "new";
    if (totalSamples < MIN_SESSIONS_FOR_TRUST) {
      flag = "new";
    } else if (combinedScore >= TRUSTED_THRESHOLD) {
      flag = "trusted";
    } else if (combinedScore >= PROBATION_THRESHOLD) {
      flag = "probation";
    } else {
      flag = "untrusted";
    }

    results.push({
      station,
      network: stationNetworks.get(station) || "unknown",
      alpha: Math.round(st.alpha * 100) / 100,
      beta: Math.round(st.beta * 100) / 100,
      trust_score: Math.round(trustScore * 1000) / 1000,
      confidence: Math.round(confidence * 1000) / 1000,
      consistency: Math.round(consistency * 1000) / 1000,
      combined_score: Math.round(combinedScore * 1000) / 1000,
      total_sessions: Math.round(totalSamples),
      flag,
      last_updated: new Date().toISOString(),
    });
  }

  // Sort: untrusted first (for quick review), then probation, new, trusted
  const flagOrder = { untrusted: 0, probation: 1, new: 2, trusted: 3 };
  results.sort((a, b) => flagOrder[a.flag] - flagOrder[b.flag] || a.combined_score - b.combined_score);

  // ── 6. Persist state + output ─────────────────────────────────────────────

  state.computed_at = new Date().toISOString();
  writeJson(statePath, state);
  writeJson(path.join(dataDir, "trust-scores.json"), {
    scores: results,
    summary: {
      total: results.length,
      trusted: results.filter(r => r.flag === "trusted").length,
      probation: results.filter(r => r.flag === "probation").length,
      untrusted: results.filter(r => r.flag === "untrusted").length,
      new: results.filter(r => r.flag === "new").length,
      avg_trust: results.length > 0
        ? Math.round(results.reduce((s, r) => s + r.trust_score, 0) / results.length * 1000) / 1000
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
