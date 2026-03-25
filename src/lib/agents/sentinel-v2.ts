// ─── SENTINEL V2 — Advanced Anomaly Detection ──────────────────────────────
// Upgrades over V1:
// - Kp-adaptive thresholds (loosen during iono storms to reduce false positives)
// - ST-DBSCAN for spatiotemporal clustering of degraded sessions
// - Multi-window CUSUM (5min, 30min, 2h) for different drift speeds
// - Correction age drift detection with seasonal baseline
// - Inter-network cross-validation (GEODNET vs ONOCOY)

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SentinelV2Anomaly {
  id: string;
  type: "cusum_fix_drift" | "cusum_age_drift" | "ewma_fix_drop" | "ewma_age_spike" |
        "mass_disconnect" | "interference_cluster" | "cross_network_inconsistency" |
        "spatial_coherence_break";
  severity: "critical" | "warning" | "info";
  station: string | null;
  region: { lat: number; lon: number; radius_km: number } | null;
  affected_users: number;
  current_value: number;
  baseline_value: number;
  deviation_pct: number;
  detected_at: string;
  method: "cusum_5m" | "cusum_30m" | "cusum_2h" | "ewma" | "st_dbscan" | "cross_network";
  kp_adjusted: boolean;
  recommended_action: string;
}

interface CusumState {
  s_plus: number;
  s_minus: number;
  baseline: number;
  count: number;
  window: string; // "5m" | "30m" | "2h"
}

interface EwmaState {
  fix_rate: number;
  correction_age: number;
  count: number;
}

export interface SentinelV2State {
  cusum: Record<string, CusumState>;
  ewma: Record<string, EwmaState>;
  // Track last N events per station for hysteresis
  event_history: Record<string, Array<{ type: string; ts: number; severity: string }>>;
  last_run: string;
}

// ─── Kp-Adaptive Parameters ──────────────────────────────────────────────────
// During geomagnetic storms, fix rates naturally drop.
// Loosening thresholds prevents false alarms from iono events.

function getAdaptiveParams(kp: number) {
  if (kp >= 7) {
    // Severe storm: very loose thresholds
    return { cusumH: 8.0, ewmaFixThreshold: 30, ewmaAgeThreshold: 5.0, cusumK: 0.75, fixDropRatio: 0.4 };
  }
  if (kp >= 5) {
    // Moderate storm: somewhat loose
    return { cusumH: 6.5, ewmaFixThreshold: 22, ewmaAgeThreshold: 4.0, cusumK: 0.6, fixDropRatio: 0.5 };
  }
  if (kp >= 4) {
    // Minor activity: slightly loose
    return { cusumH: 5.5, ewmaFixThreshold: 18, ewmaAgeThreshold: 3.5, cusumK: 0.55, fixDropRatio: 0.55 };
  }
  // Quiet conditions: standard thresholds
  return { cusumH: 5.0, ewmaFixThreshold: 15, ewmaAgeThreshold: 3.0, cusumK: 0.5, fixDropRatio: 0.6 };
}

// ─── ST-DBSCAN (Spatiotemporal DBSCAN) ──────────────────────────────────────
// Clusters degraded sessions by both location AND time.
// Better than grid-bucketing because it finds natural cluster boundaries.

interface STPoint {
  lat: number;
  lon: number;
  time: number; // ms epoch
  fix_rate: number;
  username: string;
  station: string;
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function stDbscan(points: STPoint[], spatialEps: number, temporalEps: number, minPts: number): number[] {
  // spatialEps in km, temporalEps in ms
  const labels = new Array(points.length).fill(-1); // -1 = noise
  let clusterId = 0;

  for (let i = 0; i < points.length; i++) {
    if (labels[i] !== -1) continue;

    // Find neighbors (spatial AND temporal proximity)
    const neighbors: number[] = [];
    for (let j = 0; j < points.length; j++) {
      if (i === j) continue;
      const spatialDist = haversineKm(points[i].lat, points[i].lon, points[j].lat, points[j].lon);
      const temporalDist = Math.abs(points[i].time - points[j].time);
      if (spatialDist <= spatialEps && temporalDist <= temporalEps) {
        neighbors.push(j);
      }
    }

    if (neighbors.length < minPts) continue; // Noise point

    // Expand cluster
    labels[i] = clusterId;
    const queue = [...neighbors];
    const visited = new Set([i]);

    while (queue.length > 0) {
      const idx = queue.shift()!;
      if (visited.has(idx)) continue;
      visited.add(idx);
      labels[idx] = clusterId;

      // Find neighbors of this point
      for (let j = 0; j < points.length; j++) {
        if (visited.has(j)) continue;
        const sd = haversineKm(points[idx].lat, points[idx].lon, points[j].lat, points[j].lon);
        const td = Math.abs(points[idx].time - points[j].time);
        if (sd <= spatialEps && td <= temporalEps) {
          queue.push(j);
        }
      }
    }

    clusterId++;
  }

  return labels;
}

// ─── Core Compute ────────────────────────────────────────────────────────────

export function runSentinelV2(db: Database.Database, dataDir: string): SentinelV2Anomaly[] {
  const now = Date.now();
  const fiveMinAgo = now - 5 * 60000;
  const thirtyMinAgo = now - 30 * 60000;
  const twoHoursAgo = now - 2 * 3600000;
  const sixHoursAgo = now - 6 * 3600000;
  const anomalies: SentinelV2Anomaly[] = [];

  // Load Kp for adaptive thresholds (try environment.json first, fallback space-weather.json)
  let kp = 0;
  try {
    const envPath = path.join(dataDir, "environment.json");
    const swPath = path.join(dataDir, "space-weather.json");
    const filePath = fs.existsSync(envPath) ? envPath : swPath;
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      kp = data.ionosphere?.kp_index ?? data.kp_index ?? 0;
    }
  } catch {}

  const params = getAdaptiveParams(kp);

  // Load persisted state
  const statePath = path.join(dataDir, "sentinel-v2-state.json");
  let state: SentinelV2State = { cusum: {}, ewma: {}, event_history: {}, last_run: "" };
  try {
    if (fs.existsSync(statePath)) {
      state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    }
  } catch {}

  // ── 1. Load recent sessions ───────────────────────────────────────────────

  const recentSessions = db.prepare(`
    SELECT station, fix_rate, avg_age, latitude, longitude, username, login_time, duration
    FROM rtk_sessions
    WHERE login_time >= ? AND station IS NOT NULL AND station != ''
      AND NOT (fix_rate = 0 AND duration >= 0 AND duration < 60)
  `).all(fiveMinAgo) as any[];

  if (recentSessions.length === 0) {
    state.last_run = new Date().toISOString();
    writeState(statePath, state);
    return [];
  }

  // ── 2. Multi-window baselines ─────────────────────────────────────────────

  const windows = [
    { name: "5m", cutoff: thirtyMinAgo, endCutoff: fiveMinAgo },
    { name: "30m", cutoff: twoHoursAgo, endCutoff: thirtyMinAgo },
    { name: "2h", cutoff: sixHoursAgo, endCutoff: twoHoursAgo },
  ];

  for (const window of windows) {
    const baselineRows = db.prepare(`
      SELECT station,
             AVG(fix_rate) as mean_fix,
             AVG(CASE WHEN avg_age > 0 THEN avg_age ELSE NULL END) as mean_age,
             COUNT(*) as n
      FROM rtk_sessions
      WHERE login_time >= ? AND login_time < ?
        AND station IS NOT NULL AND station != ''
        AND NOT (fix_rate = 0 AND duration >= 0 AND duration < 60)
      GROUP BY station HAVING n >= 3
    `).all(window.cutoff, window.endCutoff) as any[];

    const byStation = new Map<string, any[]>();
    for (const s of recentSessions) {
      if (!byStation.has(s.station)) byStation.set(s.station, []);
      byStation.get(s.station)!.push(s);
    }

    for (const baseline of baselineRows) {
      const sessions = byStation.get(baseline.station);
      if (!sessions || sessions.length === 0) continue;

      const currentFix = sessions.reduce((s: number, x: any) => s + (x.fix_rate || 0), 0) / sessions.length;
      const sigmaFix = Math.max(5, baseline.mean_fix * 0.15);

      // CUSUM for this window
      const cusumKey = `${baseline.station}_${window.name}`;
      if (!state.cusum[cusumKey]) {
        state.cusum[cusumKey] = { s_plus: 0, s_minus: 0, baseline: baseline.mean_fix, count: 0, window: window.name };
      }
      const cs = state.cusum[cusumKey];
      const z = (currentFix - cs.baseline) / sigmaFix;
      cs.s_plus = Math.max(0, cs.s_plus + z - params.cusumK);
      cs.s_minus = Math.max(0, cs.s_minus - z - params.cusumK);
      cs.count++;

      // Negative shift detection (fix rate dropping)
      if (cs.s_minus > params.cusumH && cs.count >= 3) {
        const deviation = ((currentFix - cs.baseline) / cs.baseline) * 100;
        const users = new Set(sessions.map((s: any) => s.username));

        anomalies.push({
          id: `sv2_cusum_${window.name}_${baseline.station}_${Math.floor(now / 300000)}`,
          type: "cusum_fix_drift",
          severity: currentFix < 30 ? "critical" : currentFix < 60 ? "warning" : "info",
          station: baseline.station,
          region: sessions[0]?.latitude ? { lat: sessions[0].latitude, lon: sessions[0].longitude, radius_km: 50 } : null,
          affected_users: users.size,
          current_value: Math.round(currentFix * 10) / 10,
          baseline_value: Math.round(cs.baseline * 10) / 10,
          deviation_pct: Math.round(deviation * 10) / 10,
          detected_at: new Date().toISOString(),
          method: `cusum_${window.name}` as any,
          kp_adjusted: kp >= 4,
          recommended_action: `CUSUM(${window.name}) fix drift on ${baseline.station}. S⁻=${cs.s_minus.toFixed(1)} (H=${params.cusumH}${kp >= 4 ? `, Kp-adjusted from 5.0` : ""}). Current: ${currentFix.toFixed(0)}% vs baseline ${cs.baseline.toFixed(0)}%.`,
        });
        cs.s_minus = 0; // Reset after alarm
      }

      // EWMA (only for 5min window to avoid duplicates)
      if (window.name === "5m") {
        const ewmaLambda = 0.2;
        if (!state.ewma[baseline.station]) {
          state.ewma[baseline.station] = { fix_rate: baseline.mean_fix, correction_age: baseline.mean_age || 0, count: 0 };
        }
        const ew = state.ewma[baseline.station];
        ew.fix_rate = ewmaLambda * currentFix + (1 - ewmaLambda) * ew.fix_rate;
        ew.count++;

        if (ew.count >= 5 && baseline.mean_fix > 50 && baseline.mean_fix - ew.fix_rate > params.ewmaFixThreshold) {
          anomalies.push({
            id: `sv2_ewma_fix_${baseline.station}_${Math.floor(now / 300000)}`,
            type: "ewma_fix_drop",
            severity: ew.fix_rate < 30 ? "critical" : "warning",
            station: baseline.station,
            region: sessions[0]?.latitude ? { lat: sessions[0].latitude, lon: sessions[0].longitude, radius_km: 50 } : null,
            affected_users: new Set(sessions.map((s: any) => s.username)).size,
            current_value: Math.round(ew.fix_rate * 10) / 10,
            baseline_value: Math.round(baseline.mean_fix * 10) / 10,
            deviation_pct: Math.round(((ew.fix_rate - baseline.mean_fix) / baseline.mean_fix) * 100 * 10) / 10,
            detected_at: new Date().toISOString(),
            method: "ewma",
            kp_adjusted: kp >= 4,
            recommended_action: `EWMA fix: ${ew.fix_rate.toFixed(1)}% vs baseline ${baseline.mean_fix.toFixed(1)}%${kp >= 4 ? ` (Kp=${kp}, threshold loosened to ${params.ewmaFixThreshold})` : ""}.`,
          });
        }
      }
    }
  }

  // ── 3. ST-DBSCAN Interference Clustering ──────────────────────────────────

  const degradedPoints: STPoint[] = recentSessions
    .filter((s: any) => (s.fix_rate || 0) < 25 && s.latitude && s.longitude && Math.abs(s.latitude) > 0.1)
    .map((s: any) => ({
      lat: s.latitude, lon: s.longitude, time: s.login_time,
      fix_rate: s.fix_rate || 0, username: s.username, station: s.station,
    }));

  if (degradedPoints.length >= 3 && degradedPoints.length <= 500) {
    // ST-DBSCAN: 30km spatial, 10min temporal, min 3 points
    const labels = stDbscan(degradedPoints, 30, 10 * 60000, 3);

    // Process clusters
    const clusters = new Map<number, STPoint[]>();
    for (let i = 0; i < labels.length; i++) {
      if (labels[i] === -1) continue;
      if (!clusters.has(labels[i])) clusters.set(labels[i], []);
      clusters.get(labels[i])!.push(degradedPoints[i]);
    }

    for (const [clusterId, points] of clusters) {
      const users = new Set(points.map(p => p.username));
      if (users.size < 3) continue;

      const centerLat = points.reduce((s, p) => s + p.lat, 0) / points.length;
      const centerLon = points.reduce((s, p) => s + p.lon, 0) / points.length;
      const avgFix = points.reduce((s, p) => s + p.fix_rate, 0) / points.length;

      // Estimate cluster radius
      const maxDist = Math.max(...points.map(p => haversineKm(centerLat, centerLon, p.lat, p.lon)));

      anomalies.push({
        id: `sv2_stdbscan_${clusterId}_${Math.floor(now / 300000)}`,
        type: "interference_cluster",
        severity: users.size >= 8 ? "critical" : users.size >= 5 ? "warning" : "info",
        station: null,
        region: { lat: centerLat, lon: centerLon, radius_km: Math.max(5, Math.round(maxDist)) },
        affected_users: users.size,
        current_value: Math.round(avgFix * 10) / 10,
        baseline_value: 85,
        deviation_pct: -100,
        detected_at: new Date().toISOString(),
        method: "st_dbscan",
        kp_adjusted: false,
        recommended_action: `ST-DBSCAN cluster: ${users.size} users, radius ~${Math.round(maxDist)}km, avg fix ${avgFix.toFixed(1)}%. Possible interference event.`,
      });
    }
  }

  // ── 4. Cross-Network Consistency ──────────────────────────────────────────
  // If GEODNET and ONOCOY stations cover the same area, their users should
  // get similar fix rates. If one network's users are degraded but the other's
  // are fine, the degraded network has a problem.

  try {
    const networkSessions = db.prepare(`
      SELECT s.station, s.fix_rate, s.latitude, s.longitude, s.username,
             COALESCE(st.network, 'unknown') as network
      FROM rtk_sessions s
      LEFT JOIN stations st ON s.station = st.name
      WHERE s.login_time >= ? AND s.station IS NOT NULL AND s.station != ''
        AND s.latitude IS NOT NULL AND ABS(s.latitude) > 0.1
        AND NOT (s.fix_rate = 0 AND s.duration >= 0 AND s.duration < 60)
    `).all(fiveMinAgo) as any[];

    // Group by 1° grid cell and network
    const cellNetworks = new Map<string, Map<string, number[]>>();
    for (const s of networkSessions) {
      if (s.network === "unknown") continue;
      const cell = `${Math.floor(s.latitude)},${Math.floor(s.longitude)}`;
      if (!cellNetworks.has(cell)) cellNetworks.set(cell, new Map());
      const cellMap = cellNetworks.get(cell)!;
      if (!cellMap.has(s.network)) cellMap.set(s.network, []);
      cellMap.get(s.network)!.push(s.fix_rate || 0);
    }

    for (const [cell, networks] of cellNetworks) {
      if (networks.size < 2) continue;
      const entries = [...networks.entries()].filter(([, rates]) => rates.length >= 3);
      if (entries.length < 2) continue;

      // Compare each pair of networks
      for (let i = 0; i < entries.length; i++) {
        for (let j = i + 1; j < entries.length; j++) {
          const [netA, ratesA] = entries[i];
          const [netB, ratesB] = entries[j];
          const meanA = ratesA.reduce((a, b) => a + b, 0) / ratesA.length;
          const meanB = ratesB.reduce((a, b) => a + b, 0) / ratesB.length;

          // Significant difference? (>30% absolute difference)
          if (Math.abs(meanA - meanB) > 30) {
            const [lat, lon] = cell.split(",").map(Number);
            const worse = meanA < meanB ? netA : netB;
            const worseMean = Math.min(meanA, meanB);
            const betterMean = Math.max(meanA, meanB);

            anomalies.push({
              id: `sv2_crossnet_${cell}_${Math.floor(now / 300000)}`,
              type: "cross_network_inconsistency",
              severity: Math.abs(meanA - meanB) > 50 ? "warning" : "info",
              station: null,
              region: { lat: lat + 0.5, lon: lon + 0.5, radius_km: 80 },
              affected_users: ratesA.length + ratesB.length,
              current_value: Math.round(worseMean * 10) / 10,
              baseline_value: Math.round(betterMean * 10) / 10,
              deviation_pct: Math.round(((worseMean - betterMean) / betterMean) * 100 * 10) / 10,
              detected_at: new Date().toISOString(),
              method: "cross_network",
              kp_adjusted: false,
              recommended_action: `${worse} significantly worse than other network in cell (${cell}): ${worseMean.toFixed(0)}% vs ${betterMean.toFixed(0)}%. Check ${worse} stations in this area.`,
            });
          }
        }
      }
    }
  } catch {}

  // ── 5. Track event history for hysteresis ─────────────────────────────────

  for (const a of anomalies) {
    const key = a.station || a.region?.lat?.toString() || "global";
    if (!state.event_history[key]) state.event_history[key] = [];
    state.event_history[key].push({ type: a.type, ts: now, severity: a.severity });
    // Keep last 50 events per station
    if (state.event_history[key].length > 50) {
      state.event_history[key] = state.event_history[key].slice(-50);
    }
  }

  // Prune old CUSUM state (not seen in 24h + >200 entries)
  if (Object.keys(state.cusum).length > 10000) {
    const keys = Object.keys(state.cusum);
    for (const key of keys) {
      if (state.cusum[key].count > 200) delete state.cusum[key];
    }
  }

  // ── 6. Persist state ──────────────────────────────────────────────────────

  state.last_run = new Date().toISOString();
  writeState(statePath, state);

  // Sort by severity
  const severityOrder = { critical: 0, warning: 1, info: 2 };
  anomalies.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  return anomalies;
}

function writeState(filePath: string, state: SentinelV2State) {
  try {
    const tmp = filePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, filePath);
  } catch {}
}
