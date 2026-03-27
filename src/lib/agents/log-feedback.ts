// ─── Alberding Log Feedback Loop ─────────────────────────────────────────────
// Takes parsed Alberding caster logs and feeds them back into the quality system.
//
// This is the GROUND TRUTH loop:
// Alberding Log → Station Performance → Trust Update → Config Update → Better Network
//
// What we learn from logs:
// 1. Which station actually served each user (backend_source)
// 2. How long the session lasted (duration = stability indicator)
// 3. Whether smarker switched (failover = station problem)
// 4. Data volume (bytes = stream health)
//
// What we CAN'T see from logs:
// - Fix rate (only the rover knows)
// - Position accuracy (only the rover knows)
//
// But: long session + high bytes = likely good fix
//       short session + switchover = likely bad station

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface StationPerformance {
  station: string;
  total_sessions: number;
  avg_duration_s: number;
  median_duration_s: number;
  total_bytes: number;
  failover_count: number;      // How often smarker switched AWAY from this station
  reconnect_count: number;     // How often smarker switched TO this station (as failover target)
  stability_score: number;     // 0-1: long sessions + no failovers = high
  data_rate_score: number;     // 0-1: consistent data rate = high
  overall_score: number;       // Combined log-based quality score
}

// ─── Core Function ──────────────────────────────────────────────────────────

export function computeLogFeedback(
  sessions: Array<{
    backend_source: string | null;
    duration_s: number;
    bytes_transferred: number;
    failover_count: number;
  }>,
  dataDir: string
): StationPerformance[] {
  // Group by station
  const stationData = new Map<string, {
    durations: number[];
    bytes: number[];
    failovers: number;
    reconnects: number;
  }>();

  for (const s of sessions) {
    if (!s.backend_source) continue;

    if (!stationData.has(s.backend_source)) {
      stationData.set(s.backend_source, { durations: [], bytes: [], failovers: 0, reconnects: 0 });
    }
    const data = stationData.get(s.backend_source)!;
    data.durations.push(s.duration_s);
    data.bytes.push(s.bytes_transferred);
    data.failovers += s.failover_count;
  }

  const performances: StationPerformance[] = [];

  for (const [station, data] of stationData) {
    if (data.durations.length === 0) continue;

    // Sort durations for median
    const sorted = [...data.durations].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const avg = data.durations.reduce((s, d) => s + d, 0) / data.durations.length;
    const totalBytes = data.bytes.reduce((s, b) => s + b, 0);

    // Stability: long sessions + few failovers = stable
    // Score: 1.0 = avg duration > 30min + no failovers
    //        0.5 = avg duration 5-30min or some failovers
    //        0.0 = avg duration < 1min or many failovers
    const durationScore = Math.min(1, avg / 1800); // 30min = 1.0
    const failoverPenalty = Math.min(1, data.failovers / Math.max(1, data.durations.length));
    const stabilityScore = Math.max(0, durationScore * (1 - failoverPenalty * 0.5));

    // Data rate: consistent bytes per second = healthy stream
    // RTK stream should be ~200-1000 bytes/s
    const avgBytesPerSession = totalBytes / data.durations.length;
    const avgDuration = Math.max(1, avg);
    const avgDataRate = avgBytesPerSession / avgDuration; // bytes/s
    // Continuous scoring: 0 at 0 b/s, ~0.5 at 200 b/s, ~1.0 at 500+ b/s (no discontinuity)
    const dataRateScore = Math.min(1, avgDataRate / 500);

    // Overall: stability weighted more than data rate
    const overallScore = stabilityScore * 0.7 + dataRateScore * 0.3;

    performances.push({
      station,
      total_sessions: data.durations.length,
      avg_duration_s: Math.round(avg),
      median_duration_s: Math.round(median),
      total_bytes: totalBytes,
      failover_count: data.failovers,
      reconnect_count: data.reconnects,
      stability_score: Math.round(stabilityScore * 100) / 100,
      data_rate_score: Math.round(dataRateScore * 100) / 100,
      overall_score: Math.round(overallScore * 100) / 100,
    });
  }

  // Sort by overall score descending
  performances.sort((a, b) => b.overall_score - a.overall_score);

  // Persist
  try {
    const filePath = path.join(dataDir, "log-feedback.json");
    const tmp = filePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({
      stations: performances,
      total_sessions: sessions.length,
      stations_analyzed: performances.length,
      computed_at: new Date().toISOString(),
    }, null, 2));
    fs.renameSync(tmp, filePath);
  } catch {}

  return performances;
}

/**
 * Update Trust scores based on log feedback.
 * This integrates caster log data into the Bayesian trust model.
 *
 * Logic:
 * - Station with high stability_score (long sessions, no failovers) → increase alpha
 * - Station with low stability_score (short sessions, many failovers) → increase beta
 * - Weight by session count (more data = stronger signal)
 */
/**
 * Update Trust scores based on log feedback.
 * IMPORTANT: This updates trust-state.json which is the SAME file that trust-v2 reads.
 * To prevent double-counting, log feedback uses a LOWER weight (0.3) than session feedback (0.5).
 * Circuit breaker: if >50% of stations would be penalized, something is wrong — skip update.
 */
export function updateTrustFromLogs(
  performances: StationPerformance[],
  dataDir: string
) {
  // Circuit breaker: if majority of stations have low stability, it's probably
  // a systemic issue (iono storm, network problem) not individual station problems
  const lowStabilityCount = performances.filter(p => p.stability_score < 0.3).length;
  if (performances.length > 10 && lowStabilityCount / performances.length > 0.5) {
    console.warn(`[LOG-FEEDBACK] Circuit breaker: ${lowStabilityCount}/${performances.length} stations have low stability — skipping trust update (likely systemic issue)`);
    return;
  }
  const trustPath = path.join(dataDir, "trust-state.json");
  let trustState: Record<string, { alpha: number; beta: number; last_decay: number }> = {};

  try {
    if (fs.existsSync(trustPath)) {
      const data = JSON.parse(fs.readFileSync(trustPath, "utf-8"));
      trustState = data.stations || {};
    }
  } catch {}

  for (const perf of performances) {
    if (perf.total_sessions < 3) continue; // Need minimum data

    const existing = trustState[perf.station] || { alpha: 1, beta: 1, last_decay: Date.now() };

    // Stability > 0.7 = "success" sessions → increase alpha
    // Stability < 0.3 = "failure" sessions → increase beta
    // Scale by log10(sessions) with lower weight (0.3) to prevent double-counting
    // with trust-v2 session feedback which uses weight 0.5
    const weight = Math.log10(Math.max(1, perf.total_sessions)) * 0.3;

    if (perf.stability_score > 0.7) {
      existing.alpha += weight;
    } else if (perf.stability_score < 0.3) {
      existing.beta += weight;
    }
    // 0.3-0.7 = neutral, no update

    trustState[perf.station] = existing;
  }

  // Save updated trust state
  try {
    const tmp = trustPath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({
      stations: trustState,
      updated_from_logs: new Date().toISOString(),
    }, null, 2));
    fs.renameSync(tmp, trustPath);
  } catch {}
}
