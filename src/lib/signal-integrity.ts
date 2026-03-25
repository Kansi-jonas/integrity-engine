// ─── Signal Integrity Engine ─────────────────────────────────────────────────
// Pre-computes anomaly detection from session data, station scores, and status logs.
// Runs as part of the 4-hour quality pipeline. Output: data/signal-integrity.json
// Also callable on-demand via API for near-real-time anomaly detection (6h window).

import Database from "better-sqlite3";
import { haversineKm } from "./station-scorer";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Anomaly {
  id: string;
  type: "fix_rate_drop" | "mass_disconnect" | "age_spike" | "station_outage" | "regional_degradation";
  severity: "critical" | "warning" | "info";
  station: string | null;
  region: { lat: number; lon: number; radius_km: number } | null;
  affected_users: number;
  current_value: number;
  baseline_value: number;
  deviation_pct: number;
  detected_at: string;
  duration_min: number;
  recommended_action: string;
}

export interface RegionScore {
  name: string;
  score: number;
  trend: "improving" | "stable" | "declining";
  stations: number;
  sessions_6h: number;
}

export interface StationTimeline {
  station: string;
  network: string;
  data: Array<{
    hour: string;
    fix_rate: number;
    correction_age: number;
    sessions: number;
    baseline_fix_rate: number;
  }>;
  status: "normal" | "degraded" | "outage";
  uq_score: number;
}

export interface SignalIntegrityData {
  anomalies: Anomaly[];
  integrity_scores: {
    global: number;
    regions: RegionScore[];
  };
  stats: {
    stations_monitored: number;
    active_sessions: number;
    anomalies_24h: number;
    mean_fix_rate: number;
  };
  station_timelines: StationTimeline[];
  computed_at: string;
}

// ─── Region Definitions ──────────────────────────────────────────────────────

const REGIONS: Array<{ name: string; lat: number; lon: number; radius_km: number }> = [
  { name: "EU Central", lat: 50.0, lon: 10.0, radius_km: 1500 },
  { name: "EU West", lat: 48.0, lon: -2.0, radius_km: 1000 },
  { name: "EU North", lat: 60.0, lon: 15.0, radius_km: 1200 },
  { name: "US East", lat: 38.0, lon: -78.0, radius_km: 1500 },
  { name: "US West", lat: 37.0, lon: -120.0, radius_km: 1500 },
  { name: "US Central", lat: 40.0, lon: -95.0, radius_km: 1500 },
  { name: "Canada", lat: 50.0, lon: -100.0, radius_km: 2000 },
  { name: "Australia", lat: -28.0, lon: 135.0, radius_km: 2000 },
  { name: "South America", lat: -15.0, lon: -55.0, radius_km: 3000 },
  { name: "Asia Pacific", lat: 25.0, lon: 120.0, radius_km: 3000 },
];

function findRegion(lat: number, lon: number): string {
  let bestRegion = "Other";
  let bestDist = Infinity;
  for (const r of REGIONS) {
    const d = haversineKm(lat, lon, r.lat, r.lon);
    if (d < r.radius_km && d < bestDist) {
      bestDist = d;
      bestRegion = r.name;
    }
  }
  return bestRegion;
}

// ─── Anomaly Detection Helpers ───────────────────────────────────────────────

function generateAnomalyId(type: string, station: string | null, ts: number): string {
  const hash = `${type}_${station || "global"}_${Math.floor(ts / 300000)}`;
  // Simple deterministic ID so duplicates are avoided
  let h = 0;
  for (let i = 0; i < hash.length; i++) {
    h = ((h << 5) - h + hash.charCodeAt(i)) | 0;
  }
  return `anom_${Math.abs(h).toString(36)}`;
}

// ─── Core Compute Function ──────────────────────────────────────────────────

export function computeSignalIntegrity(db: Database.Database): SignalIntegrityData {
  const now = Date.now();
  const sixHoursAgo = now - 6 * 3600000;
  const twentyFourHoursAgo = now - 24 * 3600000;
  const sevenDaysAgo = now - 7 * 86400000;
  const anomalies: Anomaly[] = [];

  // ── 1. Load recent sessions (6h window) ──────────────────────────────────

  const recentSessions = db.prepare(`
    SELECT station, fix_rate, avg_age, latitude, longitude, username, login_time, duration
    FROM rtk_sessions
    WHERE login_time >= ? AND station IS NOT NULL AND station != ''
    ORDER BY login_time DESC
  `).all(sixHoursAgo) as any[];

  // ── 2. Load baseline data (7-day rolling average per station) ─────────────

  const baselineRows = db.prepare(`
    SELECT station,
           AVG(fix_rate) as avg_fix_rate,
           AVG(avg_age) as avg_correction_age,
           COUNT(*) as session_count,
           COUNT(DISTINCT username) as unique_users
    FROM rtk_sessions
    WHERE login_time >= ? AND login_time < ? AND station IS NOT NULL AND station != ''
    GROUP BY station
  `).all(sevenDaysAgo, sixHoursAgo) as any[];

  const baselines = new Map<string, { avgFixRate: number; avgAge: number; sessions: number; users: number }>();
  for (const row of baselineRows) {
    baselines.set(row.station, {
      avgFixRate: row.avg_fix_rate || 0,
      avgAge: row.avg_correction_age || 0,
      sessions: row.session_count,
      users: row.unique_users,
    });
  }

  // ── 3. Load station scores ────────────────────────────────────────────────

  const stationScores = db.prepare(`
    SELECT station_name, uq_score, reliability_score, avg_fix_rate, uptime_7d, network
    FROM station_scores
  `).all() as any[];

  const scoreMap = new Map<string, any>();
  for (const s of stationScores) {
    scoreMap.set(s.station_name, s);
  }

  // ── 4. Group recent sessions by station ───────────────────────────────────

  const sessionsByStation = new Map<string, any[]>();
  for (const s of recentSessions) {
    if (!sessionsByStation.has(s.station)) sessionsByStation.set(s.station, []);
    sessionsByStation.get(s.station)!.push(s);
  }

  // ── 5. Detect fix_rate_drop anomalies ─────────────────────────────────────

  for (const [station, sessions] of sessionsByStation) {
    const baseline = baselines.get(station);
    if (!baseline || baseline.sessions < 10) continue;

    const currentFixRate = sessions.reduce((sum: number, s: any) => sum + (s.fix_rate || 0), 0) / sessions.length;
    const baselineFixRate = baseline.avgFixRate;

    if (baselineFixRate > 50 && currentFixRate < baselineFixRate * 0.6) {
      const deviation = ((currentFixRate - baselineFixRate) / baselineFixRate) * 100;
      const severity = currentFixRate < 30 ? "critical" : currentFixRate < 50 ? "warning" : "info";
      const users = new Set(sessions.map((s: any) => s.username));

      anomalies.push({
        id: generateAnomalyId("fix_rate_drop", station, now),
        type: "fix_rate_drop",
        severity,
        station,
        region: sessions[0]?.latitude ? {
          lat: sessions[0].latitude,
          lon: sessions[0].longitude,
          radius_km: 50,
        } : null,
        affected_users: users.size,
        current_value: Math.round(currentFixRate * 10) / 10,
        baseline_value: Math.round(baselineFixRate * 10) / 10,
        deviation_pct: Math.round(deviation * 10) / 10,
        detected_at: new Date(Math.max(...sessions.map((s: any) => s.login_time))).toISOString(),
        duration_min: Math.round((now - Math.min(...sessions.map((s: any) => s.login_time))) / 60000),
        recommended_action: `Investigate ${station} — fix rate dropped from ${Math.round(baselineFixRate)}% to ${Math.round(currentFixRate)}%. Check cascade priority.`,
      });
    }
  }

  // ── 6. Detect correction age spikes ───────────────────────────────────────

  for (const [station, sessions] of sessionsByStation) {
    const baseline = baselines.get(station);
    if (!baseline || baseline.avgAge <= 0 || baseline.sessions < 10) continue;

    const agesWithData = sessions.filter((s: any) => s.avg_age > 0);
    if (agesWithData.length === 0) continue;
    const currentAge = agesWithData.reduce((sum: number, s: any) => sum + s.avg_age, 0) / agesWithData.length;

    if (currentAge > baseline.avgAge * 3) {
      const deviation = ((currentAge - baseline.avgAge) / baseline.avgAge) * 100;
      const severity = currentAge > baseline.avgAge * 5 ? "critical" : "warning";
      const users = new Set(sessions.map((s: any) => s.username));

      anomalies.push({
        id: generateAnomalyId("age_spike", station, now),
        type: "age_spike",
        severity,
        station,
        region: sessions[0]?.latitude ? {
          lat: sessions[0].latitude,
          lon: sessions[0].longitude,
          radius_km: 50,
        } : null,
        affected_users: users.size,
        current_value: Math.round(currentAge * 10) / 10,
        baseline_value: Math.round(baseline.avgAge * 10) / 10,
        deviation_pct: Math.round(deviation * 10) / 10,
        detected_at: new Date(Math.max(...agesWithData.map((s: any) => s.login_time))).toISOString(),
        duration_min: Math.round((now - Math.min(...agesWithData.map((s: any) => s.login_time))) / 60000),
        recommended_action: `Correction age on ${station} spiked ${Math.round(deviation)}% — check upstream data feed latency.`,
      });
    }
  }

  // ── 7. Detect station outages ─────────────────────────────────────────────

  // Stations that had sessions in baseline but none in last 30 min
  const thirtyMinAgo = now - 30 * 60000;
  const recentActiveStations = new Set<string>();
  for (const s of recentSessions) {
    if (s.login_time >= thirtyMinAgo) recentActiveStations.add(s.station);
  }

  for (const [station, baseline] of baselines) {
    if (baseline.sessions < 20 || baseline.users < 3) continue;
    if (recentActiveStations.has(station)) continue;

    // Check if station was recently active (had sessions in the 6h window at all)
    const hadRecentSessions = sessionsByStation.has(station);
    if (!hadRecentSessions) continue; // Only flag if it was active then went silent

    // Check station_status_log for confirmation
    let confirmed = false;
    try {
      const lastStatus = db.prepare(`
        SELECT status FROM station_status_log
        WHERE station_name = ? ORDER BY recorded_at DESC LIMIT 1
      `).get(station) as any;
      if (lastStatus && lastStatus.status !== "ONLINE" && lastStatus.status !== "ACTIVE") {
        confirmed = true;
      }
    } catch {}

    if (confirmed) {
      anomalies.push({
        id: generateAnomalyId("station_outage", station, now),
        type: "station_outage",
        severity: baseline.users >= 10 ? "critical" : "warning",
        station,
        region: null,
        affected_users: baseline.users,
        current_value: 0,
        baseline_value: baseline.sessions,
        deviation_pct: -100,
        detected_at: new Date(now).toISOString(),
        duration_min: 30,
        recommended_action: `${station} appears offline — no sessions in 30min. Verify station status and check failover config.`,
      });
    }
  }

  // ── 8. Detect mass disconnects (5+ users in same region losing fix) ───────

  // Group recent degraded sessions by H3-ish region (0.5° grid)
  const degradedByRegion = new Map<string, any[]>();
  for (const s of recentSessions) {
    if ((s.fix_rate || 0) < 30 && s.latitude && s.longitude) {
      const gridKey = `${Math.round(s.latitude * 2) / 2},${Math.round(s.longitude * 2) / 2}`;
      if (!degradedByRegion.has(gridKey)) degradedByRegion.set(gridKey, []);
      degradedByRegion.get(gridKey)!.push(s);
    }
  }

  for (const [gridKey, sessions] of degradedByRegion) {
    const users = new Set(sessions.map((s: any) => s.username));
    if (users.size < 5) continue;

    const [lat, lon] = gridKey.split(",").map(Number);
    const regionName = findRegion(lat, lon);

    anomalies.push({
      id: generateAnomalyId("mass_disconnect", null, now),
      type: "mass_disconnect",
      severity: users.size >= 10 ? "critical" : "warning",
      station: null,
      region: { lat, lon, radius_km: 50 },
      affected_users: users.size,
      current_value: Math.round(sessions.reduce((s: number, x: any) => s + (x.fix_rate || 0), 0) / sessions.length * 10) / 10,
      baseline_value: 85,
      deviation_pct: -100,
      detected_at: new Date(Math.max(...sessions.map((s: any) => s.login_time))).toISOString(),
      duration_min: Math.round((now - Math.min(...sessions.map((s: any) => s.login_time))) / 60000),
      recommended_action: `Mass fix degradation in ${regionName} — ${users.size} users affected. Check regional network infrastructure.`,
    });
  }

  // ── 9. Detect regional degradation (H3 cluster quality drop) ──────────────

  // Group sessions by region and compare to baseline
  const regionSessionMap = new Map<string, { recent: any[]; baseline: any }>();
  for (const s of recentSessions) {
    if (!s.latitude || !s.longitude) continue;
    const region = findRegion(s.latitude, s.longitude);
    if (!regionSessionMap.has(region)) {
      regionSessionMap.set(region, { recent: [], baseline: { fixRates: [], ages: [] } });
    }
    regionSessionMap.get(region)!.recent.push(s);
  }

  // Load 24h baseline per region
  const baselineSessions24h = db.prepare(`
    SELECT fix_rate, avg_age, latitude, longitude
    FROM rtk_sessions
    WHERE login_time >= ? AND login_time < ?
      AND latitude IS NOT NULL AND ABS(latitude) > 0.1
      AND station IS NOT NULL AND station != ''
    ORDER BY RANDOM()
    LIMIT 50000
  `).all(twentyFourHoursAgo, sixHoursAgo) as any[];

  const regionBaseline = new Map<string, number[]>();
  for (const s of baselineSessions24h) {
    const region = findRegion(s.latitude, s.longitude);
    if (!regionBaseline.has(region)) regionBaseline.set(region, []);
    regionBaseline.get(region)!.push(s.fix_rate || 0);
  }

  for (const [region, data] of regionSessionMap) {
    if (data.recent.length < 10) continue;
    const baselineRates = regionBaseline.get(region);
    if (!baselineRates || baselineRates.length < 20) continue;

    const currentAvg = data.recent.reduce((s: number, x: any) => s + (x.fix_rate || 0), 0) / data.recent.length;
    const baselineAvg = baselineRates.reduce((a, b) => a + b, 0) / baselineRates.length;

    if (baselineAvg > 60 && currentAvg < baselineAvg * 0.7) {
      const regionDef = REGIONS.find(r => r.name === region);
      anomalies.push({
        id: generateAnomalyId("regional_degradation", region, now),
        type: "regional_degradation",
        severity: currentAvg < 40 ? "critical" : "warning",
        station: null,
        region: regionDef ? { lat: regionDef.lat, lon: regionDef.lon, radius_km: regionDef.radius_km } : null,
        affected_users: new Set(data.recent.map((s: any) => s.username)).size,
        current_value: Math.round(currentAvg * 10) / 10,
        baseline_value: Math.round(baselineAvg * 10) / 10,
        deviation_pct: Math.round(((currentAvg - baselineAvg) / baselineAvg) * 100 * 10) / 10,
        detected_at: new Date(now).toISOString(),
        duration_min: 360,
        recommended_action: `${region} quality degraded from ${Math.round(baselineAvg)}% to ${Math.round(currentAvg)}%. Review station health in region.`,
      });
    }
  }

  // ── 10. Compute Integrity Scores per Region ───────────────────────────────

  const regionScores: RegionScore[] = [];
  for (const regionDef of REGIONS) {
    const sessions = regionSessionMap.get(regionDef.name)?.recent || [];
    if (sessions.length === 0) continue;

    // Fix Rate Stability (40%) — variance vs baseline
    const fixRates = sessions.map((s: any) => s.fix_rate || 0);
    const meanFix = fixRates.reduce((a: number, b: number) => a + b, 0) / fixRates.length;
    const fixVariance = fixRates.reduce((sum: number, f: number) => sum + (f - meanFix) ** 2, 0) / fixRates.length;
    const fixStability = Math.max(0, 1 - Math.sqrt(fixVariance) / 50) * 100;

    // Correction Freshness (25%)
    const ages = sessions.filter((s: any) => s.avg_age > 0).map((s: any) => s.avg_age);
    const freshness = ages.length > 0
      ? Math.max(0, 1 - (ages.reduce((a: number, b: number) => a + b, 0) / ages.length) / 10) * 100
      : 50;

    // Station Availability (20%)
    const stationNames = [...new Set(sessions.map((s: any) => s.station))];
    const uptimes = stationNames.map(name => scoreMap.get(name)?.uptime_7d ?? 0.5);
    const availability = (uptimes.reduce((a, b) => a + b, 0) / Math.max(1, uptimes.length)) * 100;

    // Spatial Coherence (15%) — how similar are fix rates of nearby sessions
    const sortedByLat = [...sessions].sort((a: any, b: any) => a.latitude - b.latitude);
    let coherenceSum = 0;
    let coherenceCount = 0;
    for (let i = 1; i < Math.min(sortedByLat.length, 200); i++) {
      const dist = haversineKm(
        sortedByLat[i - 1].latitude, sortedByLat[i - 1].longitude,
        sortedByLat[i].latitude, sortedByLat[i].longitude
      );
      if (dist < 100) {
        coherenceSum += Math.max(0, 1 - Math.abs((sortedByLat[i].fix_rate || 0) - (sortedByLat[i - 1].fix_rate || 0)) / 50);
        coherenceCount++;
      }
    }
    const coherence = coherenceCount > 0 ? (coherenceSum / coherenceCount) * 100 : 75;

    const score = Math.round(0.40 * fixStability + 0.25 * freshness + 0.20 * availability + 0.15 * coherence);

    // Trend: compare to 24h baseline
    const baselineFixRates = regionBaseline.get(regionDef.name);
    let trend: "improving" | "stable" | "declining" = "stable";
    if (baselineFixRates && baselineFixRates.length > 10) {
      const baselineMean = baselineFixRates.reduce((a, b) => a + b, 0) / baselineFixRates.length;
      if (meanFix > baselineMean * 1.05) trend = "improving";
      else if (meanFix < baselineMean * 0.95) trend = "declining";
    }

    regionScores.push({
      name: regionDef.name,
      score: Math.min(100, Math.max(0, score)),
      trend,
      stations: stationNames.length,
      sessions_6h: sessions.length,
    });
  }

  // Global integrity score (weighted average by session count)
  const totalSessions = regionScores.reduce((s, r) => s + r.sessions_6h, 0);
  const globalScore = totalSessions > 0
    ? Math.round(regionScores.reduce((s, r) => s + r.score * r.sessions_6h, 0) / totalSessions)
    : 0;

  // ── 11. Station Timelines (top 50 stations by session count, 24h) ─────────

  const timelineRows = db.prepare(`
    SELECT station,
           CAST(login_time / 3600000 AS INTEGER) * 3600000 as hour_bucket,
           AVG(fix_rate) as avg_fix_rate,
           AVG(CASE WHEN avg_age > 0 THEN avg_age ELSE NULL END) as avg_correction_age,
           COUNT(*) as session_count
    FROM rtk_sessions
    WHERE login_time >= ? AND station IS NOT NULL AND station != ''
    GROUP BY station, hour_bucket
    ORDER BY station, hour_bucket
  `).all(twentyFourHoursAgo) as any[];

  const timelineByStation = new Map<string, Array<{ hour: string; fix_rate: number; correction_age: number; sessions: number }>>();
  for (const row of timelineRows) {
    if (!timelineByStation.has(row.station)) timelineByStation.set(row.station, []);
    timelineByStation.get(row.station)!.push({
      hour: new Date(row.hour_bucket).toISOString(),
      fix_rate: Math.round((row.avg_fix_rate || 0) * 10) / 10,
      correction_age: Math.round((row.avg_correction_age || 0) * 10) / 10,
      sessions: row.session_count,
    });
  }

  // Pick top 50 stations by total sessions
  const stationSessionCounts = [...timelineByStation.entries()]
    .map(([station, data]) => ({ station, total: data.reduce((s, d) => s + d.sessions, 0) }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 50);

  const stationTimelines: StationTimeline[] = stationSessionCounts.map(({ station }) => {
    const data = timelineByStation.get(station)!;
    const baseline = baselines.get(station);
    const score = scoreMap.get(station);
    const baselineFixRate = baseline?.avgFixRate || 0;

    const latestHours = data.slice(-3);
    const recentAvgFix = latestHours.reduce((s, d) => s + d.fix_rate, 0) / Math.max(1, latestHours.length);

    let status: "normal" | "degraded" | "outage" = "normal";
    if (recentAvgFix === 0 || latestHours.length === 0) status = "outage";
    else if (baselineFixRate > 50 && recentAvgFix < baselineFixRate * 0.6) status = "degraded";

    return {
      station,
      network: score?.network || "unknown",
      data: data.map(d => ({
        ...d,
        baseline_fix_rate: Math.round(baselineFixRate * 10) / 10,
      })),
      status,
      uq_score: score?.uq_score || 0,
    };
  });

  // ── 12. Aggregate stats ───────────────────────────────────────────────────

  const allFixRates = recentSessions.map((s: any) => s.fix_rate || 0);
  const meanFixRate = allFixRates.length > 0
    ? Math.round(allFixRates.reduce((a: number, b: number) => a + b, 0) / allFixRates.length * 10) / 10
    : 0;

  // Count live sessions (duration === -1)
  let activeSessions = 0;
  try {
    const live = db.prepare(`
      SELECT COUNT(*) as cnt FROM rtk_sessions WHERE duration = -1 AND login_time >= ?
    `).get(sixHoursAgo) as any;
    activeSessions = live?.cnt || 0;
  } catch {}

  // Total stations monitored
  let stationsMonitored = 0;
  try {
    const stCount = db.prepare(`SELECT COUNT(*) as cnt FROM stations`).get() as any;
    stationsMonitored = stCount?.cnt || 0;
  } catch {}

  // Sort anomalies: critical first, then warning, then info
  const severityOrder = { critical: 0, warning: 1, info: 2 };
  anomalies.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  return {
    anomalies,
    integrity_scores: {
      global: globalScore,
      regions: regionScores.sort((a, b) => b.sessions_6h - a.sessions_6h),
    },
    stats: {
      stations_monitored: stationsMonitored,
      active_sessions: activeSessions,
      anomalies_24h: anomalies.length,
      mean_fix_rate: meanFixRate,
    },
    station_timelines: stationTimelines,
    computed_at: new Date().toISOString(),
  };
}
