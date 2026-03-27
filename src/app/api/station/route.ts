// ─── Station Detail API ──────────────────────────────────────────────────────
// GET /api/station?name=STATIONNAME — complete station profile
// Everything we know about a single station in one call.

import { NextRequest, NextResponse } from "next/server";
import { getDb, getDataDir } from "@/lib/db";
import fs from "fs";
import path from "path";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const name = req.nextUrl.searchParams.get("name");
  if (!name) return NextResponse.json({ error: "Missing ?name= parameter" }, { status: 400 });

  const db = getDb();
  const dataDir = getDataDir();

  try {
    // Basic station info
    const station = db.prepare(`
      SELECT name, latitude, longitude, height, status, network,
             receiver_type, antenna_type, country, nav_system, last_synced
      FROM stations WHERE name = ?
    `).get(name) as any;

    if (!station) return NextResponse.json({ error: `Station ${name} not found` }, { status: 404 });

    // Station scores
    const scores = db.prepare(`
      SELECT uq_score, reliability_score, session_count, unique_users,
             avg_fix_rate, p10_fix_rate, median_correction_age, p90_correction_age,
             avg_baseline_km, max_baseline_km, zero_fix_ratio, total_duration_hours,
             uptime_7d, computed_at
      FROM station_scores WHERE station_name = ?
    `).get(name) as any;

    // Trust score
    let trust = null;
    try {
      const trustPath = path.join(dataDir, "trust-scores.json");
      if (fs.existsSync(trustPath)) {
        const data = JSON.parse(fs.readFileSync(trustPath, "utf-8"));
        trust = (data.scores || []).find((s: any) => s.station === name) || null;
      }
    } catch {}

    // Recent sessions (last 24h)
    const recentSessions = db.prepare(`
      SELECT fix_rate, avg_age, duration, latitude, longitude, username, login_time
      FROM rtk_sessions
      WHERE station = ? AND login_time >= ?
      ORDER BY login_time DESC LIMIT 50
    `).all(name, Date.now() - 86400000) as any[];

    // Session stats (last 7 days)
    const weekStats = db.prepare(`
      SELECT COUNT(*) as sessions, COUNT(DISTINCT username) as users,
             AVG(fix_rate) as avg_fix, AVG(duration) as avg_duration,
             AVG(avg_age) as avg_age
      FROM rtk_sessions WHERE station = ? AND login_time >= ?
    `).get(name, Date.now() - 7 * 86400000) as any;

    // Uptime history (last 7 days, hourly)
    const uptimeHistory = db.prepare(`
      SELECT CAST(recorded_at / 3600000 AS INTEGER) * 3600000 as hour,
             status, COUNT(*) as cnt
      FROM station_status_log
      WHERE station_name = ? AND recorded_at >= ?
      GROUP BY hour, status ORDER BY hour
    `).all(name, Date.now() - 7 * 86400000) as any[];

    // Predictive failover alerts
    let predictions = null;
    try {
      const pfPath = path.join(dataDir, "predictive-failover.json");
      if (fs.existsSync(pfPath)) {
        const pf = JSON.parse(fs.readFileSync(pfPath, "utf-8"));
        predictions = (pf.alerts || []).filter((a: any) => a.station === name);
      }
    } catch {}

    // Adversarial flags
    let adversarial = null;
    try {
      const adPath = path.join(dataDir, "adversarial-report.json");
      if (fs.existsSync(adPath)) {
        const ad = JSON.parse(fs.readFileSync(adPath, "utf-8"));
        adversarial = (ad.suspicious_stations || []).filter((s: any) => s.station === name);
      }
    } catch {}

    return NextResponse.json({
      station: {
        ...station,
        last_synced: station.last_synced ? new Date(station.last_synced).toISOString() : null,
      },
      scores: scores ? {
        ...scores,
        computed_at: scores.computed_at ? new Date(scores.computed_at).toISOString() : null,
      } : null,
      trust,
      recent_sessions: {
        count: recentSessions.length,
        sessions: recentSessions.map((s: any) => ({
          fix_rate: s.fix_rate,
          correction_age: s.avg_age,
          duration_s: s.duration,
          user: s.username?.substring(0, 3) + "***", // Anonymize
          time: new Date(s.login_time).toISOString(),
        })),
      },
      week_stats: weekStats ? {
        sessions: weekStats.sessions,
        users: weekStats.users,
        avg_fix: Math.round((weekStats.avg_fix || 0) * 10) / 10,
        avg_duration_min: Math.round((weekStats.avg_duration || 0) / 60),
        avg_age: Math.round((weekStats.avg_age || 0) * 100) / 100,
      } : null,
      uptime_history: uptimeHistory,
      predictions: predictions && predictions.length > 0 ? predictions : null,
      adversarial: adversarial && adversarial.length > 0 ? adversarial : null,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
