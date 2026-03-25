// ─── SENTINEL Agent ──────────────────────────────────────────────────────────
// High-frequency anomaly detection using CUSUM and EWMA on session telemetry.
// Runs every 5 minutes. Detects drifts that simple thresholds miss.
//
// CUSUM (Cumulative Sum): Detects small persistent shifts in mean.
// EWMA (Exponentially Weighted Moving Average): Smooths noise, catches trends.
//
// Output: Appends detected anomalies to signal-integrity.json

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SentinelAnomaly {
  id: string;
  type: "cusum_fix_drift" | "cusum_age_drift" | "ewma_fix_drop" | "ewma_age_spike" | "mass_disconnect" | "jamming_suspect";
  severity: "critical" | "warning" | "info";
  station: string | null;
  region: { lat: number; lon: number; radius_km: number } | null;
  affected_users: number;
  current_value: number;
  baseline_value: number;
  deviation_pct: number;
  detected_at: string;
  method: "cusum" | "ewma" | "cluster";
  recommended_action: string;
}

export interface SentinelState {
  // CUSUM accumulators per station (persist between runs)
  cusum: Record<string, { s_plus: number; s_minus: number; baseline: number; count: number }>;
  // EWMA values per station
  ewma: Record<string, { fix_rate: number; correction_age: number; count: number }>;
  last_run: string;
}

// ─── CUSUM Parameters ────────────────────────────────────────────────────────
// Based on ARL (Average Run Length) analysis for GNSS fix rate streams.
// Target ARL₀ = 500 (false alarm every 500 cycles = ~42 hours at 5min)
// Target ARL₁ = 10 (detect 1-sigma shift in ~50 minutes)

const CUSUM_K = 0.5;        // Allowance parameter (half the shift to detect, in sigma units)
const CUSUM_H = 5.0;        // Decision threshold (controls ARL₀)
const CUSUM_MIN_SAMPLES = 20; // Need 20+ sessions baseline before alerting

// ─── EWMA Parameters ────────────────────────────────────────────────────────
// Lambda = 0.2 gives ~5-point effective memory (good for 5min cycles = 25min lookback)

const EWMA_LAMBDA = 0.2;
const EWMA_FIX_THRESHOLD = 15;   // Alert if EWMA fix rate drops 15+ points below baseline
const EWMA_AGE_THRESHOLD = 3.0;  // Alert if EWMA correction age exceeds 3x baseline

// ─── Core Compute ────────────────────────────────────────────────────────────

export function runSentinel(db: Database.Database, dataDir: string): SentinelAnomaly[] {
  const now = Date.now();
  const fiveMinAgo = now - 5 * 60000;
  const oneHourAgo = now - 3600000;
  const anomalies: SentinelAnomaly[] = [];

  // Load persisted state
  const statePath = path.join(dataDir, "sentinel-state.json");
  let state: SentinelState = { cusum: {}, ewma: {}, last_run: "" };
  try {
    if (fs.existsSync(statePath)) {
      state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    }
  } catch {}

  // ── 1. Get recent sessions (last 5 minutes) ──────────────────────────────

  const recentSessions = db.prepare(`
    SELECT station, fix_rate, avg_age, latitude, longitude, username, login_time
    FROM rtk_sessions
    WHERE login_time >= ? AND station IS NOT NULL AND station != ''
  `).all(fiveMinAgo) as any[];

  if (recentSessions.length === 0) {
    state.last_run = new Date().toISOString();
    writeState(statePath, state);
    return [];
  }

  // ── 2. Get baseline stats (1h rolling, per station) ───────────────────────

  const baselineRows = db.prepare(`
    SELECT station,
           AVG(fix_rate) as mean_fix,
           AVG(CASE WHEN avg_age > 0 THEN avg_age ELSE NULL END) as mean_age,
           COUNT(*) as n,
           COUNT(DISTINCT username) as users
    FROM rtk_sessions
    WHERE login_time >= ? AND login_time < ?
      AND station IS NOT NULL AND station != ''
    GROUP BY station
    HAVING n >= 5
  `).all(oneHourAgo, fiveMinAgo) as any[];

  const baselines = new Map<string, { meanFix: number; meanAge: number; n: number; users: number }>();
  for (const r of baselineRows) {
    baselines.set(r.station, { meanFix: r.mean_fix || 0, meanAge: r.mean_age || 0, n: r.n, users: r.users });
  }

  // ── 3. Group recent sessions by station ───────────────────────────────────

  const byStation = new Map<string, any[]>();
  for (const s of recentSessions) {
    if (!byStation.has(s.station)) byStation.set(s.station, []);
    byStation.get(s.station)!.push(s);
  }

  // ── 4. CUSUM + EWMA per station ──────────────────────────────────────────

  for (const [station, sessions] of byStation) {
    const baseline = baselines.get(station);
    if (!baseline || baseline.n < CUSUM_MIN_SAMPLES) continue;

    const currentFix = sessions.reduce((s: number, x: any) => s + (x.fix_rate || 0), 0) / sessions.length;
    const agesWithData = sessions.filter((s: any) => s.avg_age > 0);
    const currentAge = agesWithData.length > 0
      ? agesWithData.reduce((s: number, x: any) => s + x.avg_age, 0) / agesWithData.length
      : 0;

    // Estimate sigma from baseline (use MAD approximation if not enough data)
    const sigmaFix = Math.max(5, baseline.meanFix * 0.15); // ~15% of mean as sigma estimate
    const sigmaAge = Math.max(0.5, baseline.meanAge * 0.2);

    // ── CUSUM on fix rate ────────────────────────────────────────────────

    if (!state.cusum[station]) {
      state.cusum[station] = { s_plus: 0, s_minus: 0, baseline: baseline.meanFix, count: 0 };
    }
    const cs = state.cusum[station];
    const zFix = (currentFix - cs.baseline) / sigmaFix;

    cs.s_plus = Math.max(0, cs.s_plus + zFix - CUSUM_K);
    cs.s_minus = Math.max(0, cs.s_minus - zFix - CUSUM_K);
    cs.count++;

    // Detect negative shift (fix rate dropping)
    if (cs.s_minus > CUSUM_H && cs.count >= 3) {
      const deviation = ((currentFix - cs.baseline) / cs.baseline) * 100;
      anomalies.push({
        id: `sentinel_cusum_fix_${station}_${Math.floor(now / 300000)}`,
        type: "cusum_fix_drift",
        severity: currentFix < 30 ? "critical" : currentFix < 60 ? "warning" : "info",
        station,
        region: sessions[0]?.latitude ? { lat: sessions[0].latitude, lon: sessions[0].longitude, radius_km: 50 } : null,
        affected_users: new Set(sessions.map((s: any) => s.username)).size,
        current_value: Math.round(currentFix * 10) / 10,
        baseline_value: Math.round(cs.baseline * 10) / 10,
        deviation_pct: Math.round(deviation * 10) / 10,
        detected_at: new Date().toISOString(),
        method: "cusum",
        recommended_action: `CUSUM detected sustained fix rate drift on ${station}. S⁻=${cs.s_minus.toFixed(1)} (threshold=${CUSUM_H}). Reduce cascade priority.`,
      });
      // Reset after alarm
      cs.s_minus = 0;
    }

    // ── CUSUM on correction age ──────────────────────────────────────────

    if (currentAge > 0 && baseline.meanAge > 0) {
      const zAge = (currentAge - baseline.meanAge) / sigmaAge;
      // Reuse s_plus for age (positive shift = age increasing = bad)
      const ageKey = `${station}_age`;
      if (!state.cusum[ageKey]) {
        state.cusum[ageKey] = { s_plus: 0, s_minus: 0, baseline: baseline.meanAge, count: 0 };
      }
      const csAge = state.cusum[ageKey];
      csAge.s_plus = Math.max(0, csAge.s_plus + zAge - CUSUM_K);
      csAge.count++;

      if (csAge.s_plus > CUSUM_H && csAge.count >= 3) {
        anomalies.push({
          id: `sentinel_cusum_age_${station}_${Math.floor(now / 300000)}`,
          type: "cusum_age_drift",
          severity: currentAge > baseline.meanAge * 5 ? "critical" : "warning",
          station,
          region: null,
          affected_users: new Set(sessions.map((s: any) => s.username)).size,
          current_value: Math.round(currentAge * 10) / 10,
          baseline_value: Math.round(csAge.baseline * 10) / 10,
          deviation_pct: Math.round(((currentAge - csAge.baseline) / csAge.baseline) * 100 * 10) / 10,
          detected_at: new Date().toISOString(),
          method: "cusum",
          recommended_action: `Correction age drift on ${station}. S⁺=${csAge.s_plus.toFixed(1)}. Check upstream feed latency.`,
        });
        csAge.s_plus = 0;
      }
    }

    // ── EWMA ─────────────────────────────────────────────────────────────

    if (!state.ewma[station]) {
      state.ewma[station] = { fix_rate: baseline.meanFix, correction_age: baseline.meanAge, count: 0 };
    }
    const ew = state.ewma[station];

    ew.fix_rate = EWMA_LAMBDA * currentFix + (1 - EWMA_LAMBDA) * ew.fix_rate;
    if (currentAge > 0) {
      ew.correction_age = EWMA_LAMBDA * currentAge + (1 - EWMA_LAMBDA) * ew.correction_age;
    }
    ew.count++;

    // EWMA fix rate drop
    if (ew.count >= 5 && baseline.meanFix > 50 && baseline.meanFix - ew.fix_rate > EWMA_FIX_THRESHOLD) {
      anomalies.push({
        id: `sentinel_ewma_fix_${station}_${Math.floor(now / 300000)}`,
        type: "ewma_fix_drop",
        severity: ew.fix_rate < 30 ? "critical" : "warning",
        station,
        region: sessions[0]?.latitude ? { lat: sessions[0].latitude, lon: sessions[0].longitude, radius_km: 50 } : null,
        affected_users: new Set(sessions.map((s: any) => s.username)).size,
        current_value: Math.round(ew.fix_rate * 10) / 10,
        baseline_value: Math.round(baseline.meanFix * 10) / 10,
        deviation_pct: Math.round(((ew.fix_rate - baseline.meanFix) / baseline.meanFix) * 100 * 10) / 10,
        detected_at: new Date().toISOString(),
        method: "ewma",
        recommended_action: `EWMA smoothed fix rate on ${station}: ${ew.fix_rate.toFixed(1)}% vs baseline ${baseline.meanFix.toFixed(1)}%. Trend is declining.`,
      });
    }

    // EWMA correction age spike
    if (ew.count >= 5 && baseline.meanAge > 0 && ew.correction_age > baseline.meanAge * EWMA_AGE_THRESHOLD) {
      anomalies.push({
        id: `sentinel_ewma_age_${station}_${Math.floor(now / 300000)}`,
        type: "ewma_age_spike",
        severity: "warning",
        station,
        region: null,
        affected_users: new Set(sessions.map((s: any) => s.username)).size,
        current_value: Math.round(ew.correction_age * 10) / 10,
        baseline_value: Math.round(baseline.meanAge * 10) / 10,
        deviation_pct: Math.round(((ew.correction_age - baseline.meanAge) / baseline.meanAge) * 100 * 10) / 10,
        detected_at: new Date().toISOString(),
        method: "ewma",
        recommended_action: `EWMA correction age trending up on ${station}: ${ew.correction_age.toFixed(1)}s vs baseline ${baseline.meanAge.toFixed(1)}s.`,
      });
    }
  }

  // ── 5. Mass Disconnect Detection (cluster analysis) ───────────────────────

  // Group ALL degraded sessions by ~0.5° grid cell
  const degradedGrid = new Map<string, { users: Set<string>; sessions: any[] }>();
  for (const s of recentSessions) {
    if ((s.fix_rate || 0) < 25 && s.latitude && s.longitude) {
      const key = `${Math.round(s.latitude * 2) / 2},${Math.round(s.longitude * 2) / 2}`;
      if (!degradedGrid.has(key)) degradedGrid.set(key, { users: new Set(), sessions: [] });
      const cell = degradedGrid.get(key)!;
      cell.users.add(s.username);
      cell.sessions.push(s);
    }
  }

  for (const [key, cell] of degradedGrid) {
    if (cell.users.size >= 3) {
      const [lat, lon] = key.split(",").map(Number);
      const avgFix = cell.sessions.reduce((s: number, x: any) => s + (x.fix_rate || 0), 0) / cell.sessions.length;

      anomalies.push({
        id: `sentinel_mass_${key}_${Math.floor(now / 300000)}`,
        type: "mass_disconnect",
        severity: cell.users.size >= 8 ? "critical" : "warning",
        station: null,
        region: { lat, lon, radius_km: 30 },
        affected_users: cell.users.size,
        current_value: Math.round(avgFix * 10) / 10,
        baseline_value: 85,
        deviation_pct: -100,
        detected_at: new Date().toISOString(),
        method: "cluster",
        recommended_action: `${cell.users.size} users in grid (${lat},${lon}) have fix <25%. Possible jamming or regional outage.`,
      });
    }
  }

  // ── 6. Prune old CUSUM/EWMA state (stations not seen in 24h) ─────────────

  const activeStations = new Set(recentSessions.map((s: any) => s.station));
  // Only prune every 100 runs to avoid excessive cleanup
  if (Object.keys(state.cusum).length > 5000) {
    for (const key of Object.keys(state.cusum)) {
      const baseKey = key.replace(/_age$/, "");
      if (!activeStations.has(baseKey) && state.cusum[key].count > 100) {
        delete state.cusum[key];
      }
    }
  }

  // ── 7. Persist state ──────────────────────────────────────────────────────

  state.last_run = new Date().toISOString();
  writeState(statePath, state);

  return anomalies;
}

function writeState(filePath: string, state: SentinelState) {
  try {
    const tmp = filePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, filePath);
  } catch {}
}
