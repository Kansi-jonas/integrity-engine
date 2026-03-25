// ─── SLA Monitoring API ──────────────────────────────────────────────────────
// GET /api/sla
// Returns uptime, availability, and quality metrics for SLA verification.

import { NextResponse } from "next/server";
import { getDb, getDataDir } from "@/lib/db";
import fs from "fs";
import path from "path";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const db = getDb();
    const dataDir = getDataDir();
    const now = Date.now();

    // ── Uptime metrics ──────────────────────────────────────────────────────

    // Session availability (% of time fix_rate > 70%)
    const periods = [
      { label: "1h", ms: 3600000 },
      { label: "24h", ms: 86400000 },
      { label: "7d", ms: 7 * 86400000 },
      { label: "30d", ms: 30 * 86400000 },
    ];

    const availability: Record<string, any> = {};
    for (const p of periods) {
      try {
        const stats = db.prepare(`
          SELECT COUNT(*) as total,
                 SUM(CASE WHEN fix_rate >= 70 THEN 1 ELSE 0 END) as good,
                 AVG(fix_rate) as mean_fix,
                 AVG(CASE WHEN avg_age > 0 THEN avg_age ELSE NULL END) as mean_age
          FROM rtk_sessions
          WHERE login_time >= ? AND station IS NOT NULL AND station != ''
            AND NOT (fix_rate = 0 AND duration >= 0 AND duration < 60)
        `).get(now - p.ms) as any;

        availability[p.label] = {
          total_sessions: stats?.total || 0,
          fix_availability_pct: stats?.total > 0 ? Math.round((stats.good / stats.total) * 1000) / 10 : 0,
          mean_fix_rate: Math.round((stats?.mean_fix || 0) * 10) / 10,
          mean_correction_age: Math.round((stats?.mean_age || 0) * 10) / 10,
        };
      } catch {
        availability[p.label] = { total_sessions: 0, fix_availability_pct: 0, mean_fix_rate: 0, mean_correction_age: 0 };
      }
    }

    // ── Station health ──────────────────────────────────────────────────────

    let stationHealth = { total: 0, online: 0, qualified: 0, excluded: 0 };
    try {
      const total = db.prepare(`SELECT COUNT(*) as cnt FROM stations`).get() as any;
      const online = db.prepare(`SELECT COUNT(*) as cnt FROM stations WHERE status IN ('ONLINE', 'ACTIVE')`).get() as any;
      stationHealth.total = total?.cnt || 0;
      stationHealth.online = online?.cnt || 0;

      const configPath = path.join(dataDir, "qualified-stations.json");
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        stationHealth.qualified = config.stats?.qualified_count || 0;
        stationHealth.excluded = config.stats?.disqualified_count || 0;
      }
    } catch {}

    // ── Anomaly count ───────────────────────────────────────────────────────

    let anomalyCounts: Record<string, number> = {};
    for (const p of periods) {
      try {
        const siPath = path.join(dataDir, "signal-integrity.json");
        if (fs.existsSync(siPath)) {
          const si = JSON.parse(fs.readFileSync(siPath, "utf-8"));
          anomalyCounts[p.label] = (si.anomalies || []).length;
        }
      } catch {}
    }

    // ── Space weather impact ────────────────────────────────────────────────

    let spaceWeather = null;
    try {
      const swPath = path.join(dataDir, "space-weather.json");
      if (fs.existsSync(swPath)) {
        const sw = JSON.parse(fs.readFileSync(swPath, "utf-8"));
        spaceWeather = {
          kp_index: sw.kp_index,
          storm_level: sw.storm_level,
          expected_impact: sw.expected_impact?.fix_rate_impact_pct || 0,
        };
      }
    } catch {}

    // ── Agent health ────────────────────────────────────────────────────────

    const agentFiles = [
      { name: "SENTINEL-V2", file: "sentinel-v2-state.json", max_age_min: 10 },
      { name: "SHIELD", file: "shield-events.json", max_age_min: 10 },
      { name: "TRUST-V2", file: "trust-scores.json", max_age_min: 300 },
      { name: "SPACE-WEATHER", file: "space-weather.json", max_age_min: 120 },
      { name: "SIGNAL-INTEGRITY", file: "signal-integrity.json", max_age_min: 300 },
    ];

    const agents: Record<string, any> = {};
    for (const a of agentFiles) {
      try {
        const p = path.join(dataDir, a.file);
        if (fs.existsSync(p)) {
          const stat = fs.statSync(p);
          const ageMin = Math.round((now - stat.mtimeMs) / 60000);
          agents[a.name] = {
            status: ageMin <= a.max_age_min ? "healthy" : "stale",
            last_update_min_ago: ageMin,
            max_expected_age_min: a.max_age_min,
          };
        } else {
          agents[a.name] = { status: "missing", last_update_min_ago: null };
        }
      } catch {
        agents[a.name] = { status: "error" };
      }
    }

    return NextResponse.json({
      availability,
      station_health: stationHealth,
      anomaly_counts: anomalyCounts,
      space_weather: spaceWeather,
      agents,
      generated_at: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
