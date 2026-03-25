// ─── Kp vs Fix Rate Correlation API ──────────────────────────────────────────
// Joins space weather history with hourly session fix rates.
// Returns time-aligned data for the correlation chart.

import { NextResponse } from "next/server";
import { getDb, getDataDir } from "@/lib/db";
import fs from "fs";
import path from "path";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const dataDir = getDataDir();
    const db = getDb();

    // Load space weather history
    const historyPath = path.join(dataDir, "space-weather-history.json");
    let kpHistory: Array<{ kp: number; bz: number; storm: string; ts: string }> = [];
    try {
      if (fs.existsSync(historyPath)) {
        kpHistory = JSON.parse(fs.readFileSync(historyPath, "utf-8"));
      }
    } catch {}

    // Get hourly fix rate averages for last 7 days
    const sevenDaysAgo = Date.now() - 7 * 86400000;
    const hourlyFix = db.prepare(`
      SELECT
        CAST(login_time / 3600000 AS INTEGER) * 3600000 as hour_bucket,
        AVG(fix_rate) as avg_fix_rate,
        COUNT(*) as sessions,
        COUNT(DISTINCT username) as users,
        AVG(CASE WHEN avg_age > 0 THEN avg_age ELSE NULL END) as avg_correction_age
      FROM rtk_sessions
      WHERE login_time >= ? AND station IS NOT NULL AND station != ''
      GROUP BY hour_bucket
      ORDER BY hour_bucket
    `).all(sevenDaysAgo) as any[];

    // Build time-aligned dataset
    // For each hour, find the closest Kp reading
    const kpByHour = new Map<string, { kp: number; bz: number; storm: string }>();
    for (const entry of kpHistory) {
      const hourKey = new Date(entry.ts).toISOString().substring(0, 13); // "2026-03-25T14"
      kpByHour.set(hourKey, { kp: entry.kp, bz: entry.bz, storm: entry.storm });
    }

    const correlationData = hourlyFix.map((row: any) => {
      const hourKey = new Date(row.hour_bucket).toISOString().substring(0, 13);
      const kpData = kpByHour.get(hourKey);
      return {
        time: new Date(row.hour_bucket).toISOString(),
        fix_rate: Math.round(row.avg_fix_rate * 10) / 10,
        correction_age: Math.round((row.avg_correction_age || 0) * 10) / 10,
        sessions: row.sessions,
        users: row.users,
        kp: kpData?.kp ?? null,
        bz: kpData?.bz ?? null,
        storm: kpData?.storm ?? null,
      };
    });

    // Compute correlation coefficient (Pearson) between Kp and fix rate
    const paired = correlationData.filter((d: any) => d.kp !== null && d.fix_rate > 0);
    let correlation = 0;
    if (paired.length >= 5) {
      const meanKp = paired.reduce((s: number, d: any) => s + d.kp, 0) / paired.length;
      const meanFix = paired.reduce((s: number, d: any) => s + d.fix_rate, 0) / paired.length;
      let num = 0, denKp = 0, denFix = 0;
      for (const d of paired) {
        const dKp = (d.kp ?? 0) - meanKp;
        const dFix = d.fix_rate - meanFix;
        num += dKp * dFix;
        denKp += dKp * dKp;
        denFix += dFix * dFix;
      }
      const den = Math.sqrt(denKp * denFix);
      correlation = den > 0 ? Math.round(num / den * 1000) / 1000 : 0;
    }

    return NextResponse.json({
      data: correlationData,
      correlation_kp_fix: correlation, // Negative = higher Kp → lower fix rate (expected)
      data_points: paired.length,
      kp_history_entries: kpHistory.length,
      session_hours: hourlyFix.length,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
