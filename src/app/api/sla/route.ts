// ─── SLA Reporting API ───────────────────────────────────────────────────────
// GET /api/sla — SLA metrics for Enterprise customers
// GET /api/sla?period=7d|30d|90d|365d
// GET /api/sla?region=eu|us|apac|global

import { NextRequest, NextResponse } from "next/server";
import { getDb, getDataDir } from "@/lib/db";
import fs from "fs";
import path from "path";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const period = req.nextUrl.searchParams.get("period") || "30d";
  const db = getDb();
  const dataDir = getDataDir();

  const periodDays = period === "7d" ? 7 : period === "90d" ? 90 : period === "365d" ? 365 : 30;
  const since = Date.now() - periodDays * 86400000;

  try {
    const stats = db.prepare(`
      SELECT
        COUNT(*) as total_sessions,
        COUNT(DISTINCT username) as unique_users,
        COUNT(DISTINCT station) as stations_used,
        AVG(CASE WHEN fix_rate > 0 THEN fix_rate END) as avg_fix_rate,
        AVG(CASE WHEN fix_rate >= 80 THEN 1.0 ELSE 0.0 END) * 100 as fix_success_rate,
        AVG(duration) as avg_duration_s,
        SUM(duration) / 3600.0 as total_hours,
        AVG(avg_age) as avg_correction_age,
        COUNT(CASE WHEN fix_rate = 0 AND duration < 60 THEN 1 END) as failed_sessions,
        COUNT(CASE WHEN fix_rate >= 80 THEN 1 END) as good_sessions
      FROM rtk_sessions
      WHERE login_time >= ? AND station IS NOT NULL AND station != ''
    `).get(since) as any || {};

    // Coverage quality
    let greenPct = 0;
    try {
      const cp = path.join(dataDir, "coverage-optimizer.json");
      if (fs.existsSync(cp)) greenPct = JSON.parse(fs.readFileSync(cp, "utf-8")).green_percentage || 0;
    } catch {}

    // Incidents
    let incidents = 0;
    try {
      const ap = path.join(dataDir, "sentinel-anomalies.json");
      if (fs.existsSync(ap)) incidents = (JSON.parse(fs.readFileSync(ap, "utf-8")).anomalies || []).length;
    } catch {}

    const totalHours = periodDays * 24;
    const activeHours = (db.prepare(`SELECT COUNT(DISTINCT CAST(login_time / 3600000 AS INTEGER)) as h FROM rtk_sessions WHERE login_time >= ?`).get(since) as any)?.h || 0;

    return NextResponse.json({
      period: { days: periodDays, since: new Date(since).toISOString() },
      availability: {
        uptime_pct: Math.round(activeHours / Math.max(1, totalHours) * 1000) / 10,
        sla_target: 99.5,
      },
      quality: {
        avg_fix_rate: Math.round((stats.avg_fix_rate || 0) * 10) / 10,
        fix_success_rate: Math.round((stats.fix_success_rate || 0) * 10) / 10,
        avg_correction_age_s: Math.round((stats.avg_correction_age || 0) * 100) / 100,
        coverage_green_pct: greenPct,
      },
      usage: {
        total_sessions: stats.total_sessions || 0,
        good_sessions: stats.good_sessions || 0,
        failed_sessions: stats.failed_sessions || 0,
        unique_users: stats.unique_users || 0,
        stations_used: stats.stations_used || 0,
        total_hours: Math.round((stats.total_hours || 0) * 10) / 10,
      },
      incidents: { total: incidents },
      generated_at: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
