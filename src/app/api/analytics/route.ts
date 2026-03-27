// ─── Customer Behavior Analytics API ─────────────────────────────────────────
// GET /api/analytics — usage patterns, peak hours, geographic distribution
// GET /api/analytics?section=temporal — when do customers connect
// GET /api/analytics?section=geographic — where are customers
// GET /api/analytics?section=stations — most/least used stations
// GET /api/analytics?section=retention — session duration patterns

import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const section = req.nextUrl.searchParams.get("section") || "all";
  const db = getDb();
  const since = Date.now() - 30 * 86400000; // Last 30 days

  const result: Record<string, any> = { timestamp: new Date().toISOString() };

  try {
    // ── Temporal: When do customers connect? ─────────────────────────────
    if (section === "all" || section === "temporal") {
      // By hour of day (UTC)
      const hourly = db.prepare(`
        SELECT CAST((login_time / 3600000) % 24 AS INTEGER) as hour,
               COUNT(*) as sessions, COUNT(DISTINCT username) as users
        FROM rtk_sessions WHERE login_time >= ?
        GROUP BY hour ORDER BY hour
      `).all(since) as any[];

      // By day of week
      const daily = db.prepare(`
        SELECT CAST(((login_time / 86400000) + 4) % 7 AS INTEGER) as dow,
               COUNT(*) as sessions, COUNT(DISTINCT username) as users
        FROM rtk_sessions WHERE login_time >= ?
        GROUP BY dow ORDER BY dow
      `).all(since) as any[];

      const dayNames = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

      result.temporal = {
        by_hour: hourly.map((h: any) => ({ hour: h.hour, sessions: h.sessions, users: h.users })),
        by_day: daily.map((d: any) => ({ day: dayNames[d.dow] || `Day${d.dow}`, sessions: d.sessions, users: d.users })),
        peak_hour: hourly.reduce((max: any, h: any) => h.sessions > (max?.sessions || 0) ? h : max, null)?.hour,
        quiet_hour: hourly.reduce((min: any, h: any) => h.sessions < (min?.sessions || Infinity) ? h : min, null)?.hour,
      };
    }

    // ── Geographic: Where are customers? ─────────────────────────────────
    if (section === "all" || section === "geographic") {
      const geo = db.prepare(`
        SELECT
          CASE
            WHEN latitude > 35 AND latitude < 60 AND longitude > -10 AND longitude < 30 THEN 'Europe'
            WHEN latitude > 25 AND latitude < 50 AND longitude > -130 AND longitude < -60 THEN 'North America'
            WHEN latitude > -45 AND latitude < -10 AND longitude > 110 AND longitude < 180 THEN 'Australia'
            WHEN latitude > 20 AND latitude < 50 AND longitude > 60 AND longitude < 140 THEN 'Asia'
            WHEN latitude > -60 AND latitude < 15 AND longitude > -80 AND longitude < -30 THEN 'South America'
            WHEN latitude > -10 AND latitude < 35 AND longitude > -20 AND longitude < 55 THEN 'Africa/ME'
            ELSE 'Other'
          END as region,
          COUNT(*) as sessions,
          COUNT(DISTINCT username) as users,
          AVG(fix_rate) as avg_fix
        FROM rtk_sessions
        WHERE login_time >= ? AND latitude IS NOT NULL AND ABS(latitude) > 0.1
        GROUP BY region ORDER BY sessions DESC
      `).all(since) as any[];

      result.geographic = {
        regions: geo.map((g: any) => ({
          region: g.region,
          sessions: g.sessions,
          users: g.users,
          avg_fix_rate: Math.round((g.avg_fix || 0) * 10) / 10,
          share_pct: 0, // Calculated below
        })),
      };

      const totalSessions = geo.reduce((s: number, g: any) => s + g.sessions, 0);
      for (const r of result.geographic.regions) {
        r.share_pct = Math.round(r.sessions / Math.max(1, totalSessions) * 1000) / 10;
      }
    }

    // ── Stations: Most/least used ───────────────────────────────────────
    if (section === "all" || section === "stations") {
      const topStations = db.prepare(`
        SELECT station, COUNT(*) as sessions, COUNT(DISTINCT username) as users,
               AVG(fix_rate) as avg_fix, AVG(duration) as avg_duration
        FROM rtk_sessions
        WHERE login_time >= ? AND station IS NOT NULL AND station != ''
        GROUP BY station ORDER BY sessions DESC LIMIT 20
      `).all(since) as any[];

      const worstStations = db.prepare(`
        SELECT station, COUNT(*) as sessions, AVG(fix_rate) as avg_fix,
               AVG(CASE WHEN fix_rate = 0 THEN 1.0 ELSE 0.0 END) as zero_fix_ratio
        FROM rtk_sessions
        WHERE login_time >= ? AND station IS NOT NULL AND station != ''
        GROUP BY station HAVING sessions >= 10
        ORDER BY avg_fix ASC LIMIT 10
      `).all(since) as any[];

      result.stations = {
        most_used: topStations.map((s: any) => ({
          station: s.station, sessions: s.sessions, users: s.users,
          avg_fix: Math.round((s.avg_fix || 0) * 10) / 10,
          avg_duration_min: Math.round((s.avg_duration || 0) / 60),
        })),
        worst_quality: worstStations.map((s: any) => ({
          station: s.station, sessions: s.sessions,
          avg_fix: Math.round((s.avg_fix || 0) * 10) / 10,
          zero_fix_pct: Math.round((s.zero_fix_ratio || 0) * 100),
        })),
      };
    }

    // ── Retention: Session duration patterns ─────────────────────────────
    if (section === "all" || section === "retention") {
      const durations = db.prepare(`
        SELECT
          CASE
            WHEN duration < 60 THEN '<1min'
            WHEN duration < 300 THEN '1-5min'
            WHEN duration < 900 THEN '5-15min'
            WHEN duration < 1800 THEN '15-30min'
            WHEN duration < 3600 THEN '30-60min'
            WHEN duration < 7200 THEN '1-2h'
            ELSE '>2h'
          END as bucket,
          COUNT(*) as sessions,
          AVG(fix_rate) as avg_fix
        FROM rtk_sessions
        WHERE login_time >= ? AND duration > 0
        GROUP BY bucket
      `).all(since) as any[];

      const totalUsers = (db.prepare(`SELECT COUNT(DISTINCT username) as c FROM rtk_sessions WHERE login_time >= ?`).get(since) as any)?.c || 0;
      const returningUsers = (db.prepare(`
        SELECT COUNT(*) as c FROM (
          SELECT username FROM rtk_sessions WHERE login_time >= ?
          GROUP BY username HAVING COUNT(*) >= 2
        )
      `).get(since) as any)?.c || 0;

      result.retention = {
        duration_distribution: durations.map((d: any) => ({
          bucket: d.bucket, sessions: d.sessions,
          avg_fix: Math.round((d.avg_fix || 0) * 10) / 10,
        })),
        total_users: totalUsers,
        returning_users: returningUsers,
        return_rate_pct: totalUsers > 0 ? Math.round(returningUsers / totalUsers * 1000) / 10 : 0,
      };
    }

    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
