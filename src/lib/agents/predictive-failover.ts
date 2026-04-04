// ─── Predictive Failover ─────────────────────────────────────────────────────
// Predicts station degradation BEFORE it happens and pre-adjusts config.
//
// Leading indicators (detect problems before user experiences them):
// 1. Correction Age trending up → station network issues
// 2. Fix Rate trending down → station hardware degradation
// 3. Uptime trend declining → station becoming unreliable
// 4. Kp rising → iono storm coming → pre-route to closer stations
// 5. Session duration shortening → users disconnecting more
// 6. Zero-fix ratio increasing → station producing bad corrections
//
// Action: adjust station priority in NEXT config generation
// (don't wait for TRUST V2 to catch up — it's too slow for sudden changes)

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

export interface PredictiveAlert {
  station: string;
  indicator: string;
  trend: "degrading" | "improving" | "critical";
  current_value: number;
  previous_value: number;  // 6h ago
  change_pct: number;
  recommended_action: "pre_downgrade" | "pre_exclude" | "pre_promote" | "monitor" | "investigate_systemic";
  confidence: number;
  description: string;
}

export interface PredictiveResult {
  alerts: PredictiveAlert[];
  kp_forecast: {
    current: number;
    forecast_3h: number;
    pre_route_needed: boolean;
    affected_regions: string[];
  };
  stations_at_risk: number;
  stations_improving: number;
  computed_at: string;
}

export function runPredictiveFailover(db: Database.Database, dataDir: string): PredictiveResult {
  const alerts: PredictiveAlert[] = [];
  const now = Date.now();
  const sixHoursAgo = now - 6 * 3600000;
  const oneHourAgo = now - 3600000;

  // ── 1. Compare station metrics: now vs 6h ago ──────────────────────────
  try {
    // Get stations with recent sessions in two time windows
    const recentStats = db.prepare(`
      SELECT station,
        AVG(fix_rate) as fix_rate,
        AVG(avg_age) as correction_age,
        AVG(CASE WHEN fix_rate = 0 THEN 1.0 ELSE 0.0 END) as zero_fix_ratio,
        AVG(duration) as avg_duration,
        COUNT(*) as session_count
      FROM rtk_sessions
      WHERE login_time >= ? AND station IS NOT NULL AND station != ''
      GROUP BY station HAVING session_count >= 3
    `).all(oneHourAgo) as any[];

    const olderStats = db.prepare(`
      SELECT station,
        AVG(fix_rate) as fix_rate,
        AVG(avg_age) as correction_age,
        AVG(CASE WHEN fix_rate = 0 THEN 1.0 ELSE 0.0 END) as zero_fix_ratio,
        AVG(duration) as avg_duration,
        COUNT(*) as session_count
      FROM rtk_sessions
      WHERE login_time >= ? AND login_time < ? AND station IS NOT NULL AND station != ''
      GROUP BY station HAVING session_count >= 3
    `).all(sixHoursAgo, oneHourAgo) as any[];

    const olderMap = new Map(olderStats.map((s: any) => [s.station, s]));

    for (const recent of recentStats) {
      const older = olderMap.get(recent.station);
      if (!older) continue;

      // Fix Rate dropping
      if (older.fix_rate > 50 && recent.fix_rate < older.fix_rate * 0.7) {
        const change = ((recent.fix_rate - older.fix_rate) / older.fix_rate) * 100;
        alerts.push({
          station: recent.station,
          indicator: "fix_rate_declining",
          trend: recent.fix_rate < 30 ? "critical" : "degrading",
          current_value: Math.round(recent.fix_rate * 10) / 10,
          previous_value: Math.round(older.fix_rate * 10) / 10,
          change_pct: Math.round(change * 10) / 10,
          recommended_action: recent.fix_rate < 30 ? "pre_exclude" : "pre_downgrade",
          confidence: Math.min(0.9, recent.session_count / 20),
          description: `Fix rate dropped ${Math.abs(Math.round(change))}% in 6h (${Math.round(older.fix_rate)}% → ${Math.round(recent.fix_rate)}%)`,
        });
      }

      // Correction Age spiking
      if (older.correction_age < 5 && recent.correction_age > older.correction_age * 2) {
        const change = ((recent.correction_age - older.correction_age) / Math.max(0.1, older.correction_age)) * 100;
        alerts.push({
          station: recent.station,
          indicator: "correction_age_rising",
          trend: recent.correction_age > 10 ? "critical" : "degrading",
          current_value: Math.round(recent.correction_age * 100) / 100,
          previous_value: Math.round(older.correction_age * 100) / 100,
          change_pct: Math.round(change),
          recommended_action: recent.correction_age > 10 ? "pre_downgrade" : "monitor",
          confidence: Math.min(0.8, recent.session_count / 15),
          description: `Correction age doubled in 6h (${older.correction_age.toFixed(1)}s → ${recent.correction_age.toFixed(1)}s)`,
        });
      }

      // Zero-fix ratio increasing
      if (older.zero_fix_ratio < 0.1 && recent.zero_fix_ratio > 0.3) {
        alerts.push({
          station: recent.station,
          indicator: "zero_fix_increasing",
          trend: recent.zero_fix_ratio > 0.5 ? "critical" : "degrading",
          current_value: Math.round(recent.zero_fix_ratio * 100),
          previous_value: Math.round(older.zero_fix_ratio * 100),
          change_pct: Math.round((recent.zero_fix_ratio - older.zero_fix_ratio) * 100),
          recommended_action: recent.zero_fix_ratio > 0.5 ? "pre_exclude" : "pre_downgrade",
          confidence: Math.min(0.85, recent.session_count / 10),
          description: `Zero-fix sessions jumped from ${Math.round(older.zero_fix_ratio * 100)}% to ${Math.round(recent.zero_fix_ratio * 100)}%`,
        });
      }

      // Fix Rate improving (for promotion)
      if (older.fix_rate < 60 && recent.fix_rate > older.fix_rate * 1.3 && recent.fix_rate > 70) {
        alerts.push({
          station: recent.station,
          indicator: "fix_rate_improving",
          trend: "improving",
          current_value: Math.round(recent.fix_rate * 10) / 10,
          previous_value: Math.round(older.fix_rate * 10) / 10,
          change_pct: Math.round(((recent.fix_rate - older.fix_rate) / older.fix_rate) * 100),
          recommended_action: "pre_promote",
          confidence: Math.min(0.7, recent.session_count / 20),
          description: `Fix rate recovered from ${Math.round(older.fix_rate)}% to ${Math.round(recent.fix_rate)}%`,
        });
      }
    }
  } catch {}

  // ── 2. Kp Forecast → Pre-routing ──────────────────────────────────────
  let kpForecast = { current: 0, forecast_3h: 0, pre_route_needed: false, affected_regions: [] as string[] };
  try {
    const envPath = path.join(dataDir, "environment.json");
    if (fs.existsSync(envPath)) {
      const env = JSON.parse(fs.readFileSync(envPath, "utf-8"));
      const kpNow = env.ionosphere?.kp_index || 0;
      const kp3h = env.ionosphere?.kp_forecast_3h || 0;

      kpForecast.current = kpNow;
      kpForecast.forecast_3h = kp3h;

      if (kp3h >= 5 && kp3h > kpNow + 1) {
        kpForecast.pre_route_needed = true;
        kpForecast.affected_regions = env.ionosphere?.affected_regions || ["Northern Europe", "Canada", "Scandinavia"];

        alerts.push({
          station: "SYSTEM",
          indicator: "kp_forecast_rising",
          trend: kp3h >= 7 ? "critical" : "degrading",
          current_value: kpNow,
          previous_value: kpNow,
          change_pct: 0,
          recommended_action: "pre_downgrade",
          confidence: 0.7,
          description: `Kp forecast rising ${kpNow} → ${kp3h} in 3h. Pre-route high-latitude users to closer stations.`,
        });
      }
    }
  } catch {}

  // ── 3. Meridian: Cascade-Exhaustion detection ──────────────────────────
  // If >30% of monitored stations are degrading simultaneously, this is
  // likely a systemic issue (space weather, infrastructure), not individual failures.
  const degradingCount = alerts.filter(a => a.trend === "degrading" || a.trend === "critical").length;
  const improvingCount = alerts.filter(a => a.trend === "improving").length;
  if (degradingCount > 10 && degradingCount > improvingCount * 3) {
    alerts.unshift({
      station: "SYSTEM",
      indicator: "cascade_exhaustion_warning",
      trend: "critical",
      current_value: degradingCount,
      previous_value: improvingCount,
      change_pct: 0,
      recommended_action: "investigate_systemic",
      confidence: 0.9,
      description: `Cascade warning: ${degradingCount} stations degrading vs ${improvingCount} improving. Possible systemic issue — hold individual exclusions.`,
    });
  }

  // Sort by confidence descending
  alerts.sort((a, b) => b.confidence - a.confidence);

  const result: PredictiveResult = {
    alerts: alerts.slice(0, 50),
    kp_forecast: kpForecast,
    stations_at_risk: degradingCount,
    stations_improving: improvingCount,
    computed_at: new Date().toISOString(),
  };

  // Persist
  try {
    const fp = path.join(dataDir, "predictive-failover.json");
    fs.writeFileSync(fp + ".tmp", JSON.stringify(result, null, 2));
    fs.renameSync(fp + ".tmp", fp);
  } catch {}

  return result;
}
