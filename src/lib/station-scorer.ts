// ─── MERIDIAN Station Scoring Engine ──────────────────────────────────────────
// Computes per-station quality (UQ) and reliability scores from session data.
// Runs as part of the 4-hour quality pipeline.

import Database from "better-sqlite3";

interface StationScore {
  stationName: string;
  network: string;
  uqScore: number;
  reliabilityScore: number;
  sessionCount: number;
  uniqueUsers: number;
  avgFixRate: number;
  p10FixRate: number;
  medianCorrectionAge: number;
  p90CorrectionAge: number;
  avgBaselineKm: number;
  maxBaselineKm: number;
  zeroFixRatio: number;
  totalDurationHours: number;
  uptime7d: number;
}

// ─── Network Inference ───────────────────────────────────────────────────────

const ONOCOY_PREFIXES = ["NRBY_", "ONO_", "onocoy_"];
const GEODNET_PATTERN = /^[A-Z0-9]{8,12}$/; // Typical GEODNET station names

export function inferNetwork(stationName: string): string {
  if (!stationName) return "unknown";
  if (ONOCOY_PREFIXES.some(p => stationName.startsWith(p))) return "onocoy";
  if (GEODNET_PATTERN.test(stationName)) return "geodnet";
  // Government CORS stations often have 4-char names
  if (/^[A-Z]{4}$/.test(stationName)) return "cors";
  return "unknown";
}

// ─── Percentile Helper ───────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(p / 100 * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

// ─── Compute All Station Scores ──────────────────────────────────────────────

export function computeStationScores(db: Database.Database, windowMs: number = 14 * 86400000): StationScore[] {
  const cutoff = Date.now() - windowMs;
  const scores: StationScore[] = [];

  // Bulk-load ALL sessions in the window, grouped by station (avoids N+1 queries)
  const allSessions = db.prepare(`
    SELECT station, fix_rate, avg_age, duration, total_gga, login_time, username,
           latitude, longitude
    FROM rtk_sessions
    WHERE station IS NOT NULL AND station != '' AND login_time >= ?
    ORDER BY station, fix_rate ASC
  `).all(cutoff) as any[];

  // Group sessions by station in memory
  const sessionsByStation = new Map<string, any[]>();
  for (const s of allSessions) {
    if (!sessionsByStation.has(s.station)) sessionsByStation.set(s.station, []);
    sessionsByStation.get(s.station)!.push(s);
  }

  // Bulk-load all station coordinates
  const stationCoords = new Map<string, { latitude: number; longitude: number }>();
  const allStations = db.prepare(`SELECT name, latitude, longitude FROM stations`).all() as any[];
  for (const st of allStations) {
    stationCoords.set(st.name, { latitude: st.latitude, longitude: st.longitude });
  }

  // Bulk prefetch uptime data (avoids N+1 queries)
  const uptimeCutoff = Date.now() - 7 * 86400000;
  const uptimeMap = new Map<string, number>();
  try {
    const uptimeRows = db.prepare(`
      SELECT station_name,
             CAST(SUM(CASE WHEN status IN ('ONLINE', 'ACTIVE') THEN 1 ELSE 0 END) AS REAL) / COUNT(*) as uptime
      FROM station_status_log
      WHERE recorded_at >= ?
      GROUP BY station_name
    `).all(uptimeCutoff) as any[];
    for (const r of uptimeRows) {
      uptimeMap.set(r.station_name, Math.round(r.uptime * 100) / 100);
    }
  } catch {}

  for (const [stationName, sessions] of sessionsByStation) {

    if (sessions.length === 0) continue;

    // Basic metrics
    const fixRates = sessions.map((s: any) => s.fix_rate || 0).sort((a: number, b: number) => a - b);
    const corrAges = sessions.map((s: any) => s.avg_age || 0).filter((a: number) => a > 0).sort((a: number, b: number) => a - b);
    const durations = sessions.map((s: any) => Math.max(0, s.duration || 0));
    const usernames = new Set(sessions.map((s: any) => s.username));

    // Duration-weighted fix rate
    const totalDuration = durations.reduce((a: number, b: number) => a + b, 0);
    const weightedFixRate = totalDuration > 0
      ? sessions.reduce((sum: number, s: any) => sum + (s.fix_rate || 0) * Math.max(0, s.duration || 0), 0) / totalDuration
      : fixRates.reduce((a: number, b: number) => a + b, 0) / fixRates.length;

    // Baseline distances (haversine from rover to station)
    const coords = stationCoords.get(stationName);

    let avgBaselineKm = 0;
    let maxBaselineKm = 0;

    if (coords?.latitude && coords?.longitude) {
      const baselines = sessions
        .filter((s: any) => s.latitude && s.longitude && Math.abs(s.latitude) > 0.1)
        .map((s: any) => haversineKm(s.latitude, s.longitude, coords.latitude, coords.longitude));

      if (baselines.length > 0) {
        avgBaselineKm = baselines.reduce((a: number, b: number) => a + b, 0) / baselines.length;
        maxBaselineKm = baselines.reduce((max, v) => v > max ? v : max, 0);
      }
    }

    // Zero fix ratio
    const zeroFixCount = fixRates.filter((f: number) => f === 0).length;
    const zeroFixRatio = zeroFixCount / fixRates.length;

    // Uptime (from status log if available)
    // Use bulk-prefetched uptime data (no individual DB query)
    const uptime7d = uptimeMap.get(stationName) ?? computeStationUptime(db, stationName, 7);

    // Compute UQ Score [0,1]
    const fixComponent = Math.min(1, weightedFixRate / 100);
    const ageComponent = corrAges.length > 0 ? Math.max(0, 1 - percentile(corrAges, 50) / 10) : 0.5;
    const uptimeComponent = uptime7d;
    const uqScore = Math.round((0.40 * fixComponent + 0.30 * ageComponent + 0.30 * uptimeComponent) * 100) / 100;

    // Compute Reliability Score [0,1]
    const reliabilityScore = Math.round(
      (uptime7d * (1 - zeroFixRatio) * Math.max(0, 1 - (corrAges.length > 0 ? percentile(corrAges, 90) / 15 : 0.5))) * 100
    ) / 100;

    const network = inferNetwork(stationName);

    scores.push({
      stationName,
      network,
      uqScore,
      reliabilityScore,
      sessionCount: sessions.length,
      uniqueUsers: usernames.size,
      avgFixRate: Math.round(weightedFixRate * 10) / 10,
      p10FixRate: Math.round(percentile(fixRates, 10) * 10) / 10,
      medianCorrectionAge: corrAges.length > 0 ? Math.round(percentile(corrAges, 50) * 10) / 10 : 0,
      p90CorrectionAge: corrAges.length > 0 ? Math.round(percentile(corrAges, 90) * 10) / 10 : 0,
      avgBaselineKm: Math.round(avgBaselineKm * 10) / 10,
      maxBaselineKm: Math.round(maxBaselineKm * 10) / 10,
      zeroFixRatio: Math.round(zeroFixRatio * 1000) / 1000,
      totalDurationHours: Math.round(totalDuration / 3600000 * 10) / 10,
      uptime7d,
    });
  }

  return scores;
}

// ─── Station Uptime from Status Log ──────────────────────────────────────────

function computeStationUptime(db: Database.Database, stationName: string, days: number): number {
  const cutoff = Date.now() - days * 86400000;
  try {
    const logs = db.prepare(`
      SELECT status, recorded_at FROM station_status_log
      WHERE station_name = ? AND recorded_at >= ?
      ORDER BY recorded_at ASC
    `).all(stationName, cutoff) as any[];

    if (logs.length === 0) {
      // No log data — check current status from stations table
      const current = db.prepare(`SELECT status FROM stations WHERE name = ?`).get(stationName) as any;
      return current?.status === "ONLINE" || current?.status === "ACTIVE" ? 0.9 : 0.5; // Default estimate
    }

    const onlineCount = logs.filter((l: any) => l.status === "ONLINE" || l.status === "ACTIVE").length;
    return Math.round(onlineCount / logs.length * 100) / 100;
  } catch {
    return 0.5; // Default if table doesn't exist yet
  }
}

// ─── Write Scores to DB ──────────────────────────────────────────────────────

export function writeStationScores(db: Database.Database, scores: StationScore[]) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO station_scores
    (station_name, network, uq_score, reliability_score, session_count, unique_users,
     avg_fix_rate, p10_fix_rate, median_correction_age, p90_correction_age,
     avg_baseline_km, max_baseline_km, zero_fix_ratio, total_duration_hours, uptime_7d, computed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const now = Date.now();
  const tx = db.transaction(() => {
    for (const s of scores) {
      stmt.run(
        s.stationName, s.network, s.uqScore, s.reliabilityScore,
        s.sessionCount, s.uniqueUsers, s.avgFixRate, s.p10FixRate,
        s.medianCorrectionAge, s.p90CorrectionAge, s.avgBaselineKm, s.maxBaselineKm,
        s.zeroFixRatio, s.totalDurationHours, s.uptime7d, now
      );
    }
  });
  tx();

  // Also update network column on stations table
  const updateNetwork = db.prepare(`UPDATE stations SET network = ? WHERE name = ?`);
  const txNet = db.transaction(() => {
    for (const s of scores) {
      if (s.network !== "unknown") {
        updateNetwork.run(s.network, s.stationName);
      }
    }
  });
  txNet();
}

// ─── Snapshot Station Status ─────────────────────────────────────────────────

export function snapshotStationStatus(db: Database.Database) {
  const now = Date.now();
  try {
    const stations = db.prepare(`
      SELECT name, status FROM stations WHERE status IS NOT NULL
    `).all() as any[];

    const stmt = db.prepare(`
      INSERT OR IGNORE INTO station_status_log (station_name, status, recorded_at)
      VALUES (?, ?, ?)
    `);

    const tx = db.transaction(() => {
      for (const s of stations) {
        stmt.run(s.name, s.status, now);
      }
    });
    tx();

    // Prune old logs (keep last 14 days)
    db.prepare(`DELETE FROM station_status_log WHERE recorded_at < ?`).run(now - 14 * 86400000);
  } catch (err) {
    console.error("[MERIDIAN] Station status snapshot failed:", err);
  }
}

// ─── Haversine Distance ──────────────────────────────────────────────────────

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
