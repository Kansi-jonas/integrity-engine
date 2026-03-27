// ─── Daily Network Report ────────────────────────────────────────────────────
// Generates a daily summary of network performance.
// Sent via webhook (Slack/Discord) at 06:00 UTC.
//
// Includes:
// - Network Health Score + trend
// - Session stats (total, fix rate, users)
// - Coverage progress (green % change)
// - Top issues (stations degraded, anomalies)
// - ONOCOY Gap-Fill progress
// - Config changes

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

export interface DailyReport {
  date: string;
  health: { score: number; grade: string; trend: string };
  sessions: { total_24h: number; avg_fix: number; unique_users: number; unique_stations: number };
  coverage: { green_pct: number; change_7d: number | null; total_cells: number };
  trust: { trusted: number; probation: number; untrusted: number; excluded: number; new_stations: number };
  onocoy: { probed: number; survey_grade: number; overlays: number };
  anomalies: { total_24h: number; critical: number };
  highlights: string[];
}

export function generateDailyReport(db: Database.Database, dataDir: string): DailyReport {
  const now = Date.now();
  const yesterday = now - 86400000;
  const highlights: string[] = [];

  // Health
  let health = { score: 0, grade: "unknown", trend: "stable" };
  try {
    const hp = path.join(dataDir, "network-health.json");
    if (fs.existsSync(hp)) {
      const h = JSON.parse(fs.readFileSync(hp, "utf-8"));
      health = { score: h.score, grade: h.grade, trend: h.trend?.direction || "stable" };
    }
  } catch {}

  // Sessions
  let sessions = { total_24h: 0, avg_fix: 0, unique_users: 0, unique_stations: 0 };
  try {
    const row = db.prepare(`
      SELECT COUNT(*) as cnt, AVG(fix_rate) as avg_fix,
             COUNT(DISTINCT username) as users, COUNT(DISTINCT station) as stations
      FROM rtk_sessions WHERE login_time >= ? AND fix_rate > 0
    `).get(yesterday) as any;
    sessions = {
      total_24h: row?.cnt || 0,
      avg_fix: Math.round((row?.avg_fix || 0) * 10) / 10,
      unique_users: row?.users || 0,
      unique_stations: row?.stations || 0,
    };
  } catch {}

  // Coverage
  let coverage = { green_pct: 0, change_7d: null as number | null, total_cells: 0 };
  try {
    const cp = path.join(dataDir, "coverage-optimizer.json");
    if (fs.existsSync(cp)) {
      const c = JSON.parse(fs.readFileSync(cp, "utf-8"));
      coverage.green_pct = c.green_percentage || 0;
      coverage.total_cells = c.total_cells || 0;
      coverage.change_7d = c.trend?.green_pct_7d_ago !== null
        ? Math.round((c.trend.green_pct_now - c.trend.green_pct_7d_ago) * 10) / 10
        : null;
    }
  } catch {}

  // Trust
  let trust = { trusted: 0, probation: 0, untrusted: 0, excluded: 0, new_stations: 0 };
  try {
    const tp = path.join(dataDir, "trust-scores.json");
    if (fs.existsSync(tp)) {
      const t = JSON.parse(fs.readFileSync(tp, "utf-8"));
      const s = t.summary || {};
      trust = { trusted: s.trusted || 0, probation: s.probation || 0, untrusted: s.untrusted || 0, excluded: s.excluded || 0, new_stations: s.new || 0 };
    }
  } catch {}

  // ONOCOY
  let onocoy = { probed: 0, survey_grade: 0, overlays: 0 };
  try {
    const probed = (db.prepare(`SELECT COUNT(*) as c FROM stations WHERE network = 'onocoy' AND receiver_type IS NOT NULL AND receiver_type != '' AND receiver_type NOT LIKE '%INFERRED%'`).get() as any)?.c || 0;
    const survey = (db.prepare(`SELECT COUNT(*) as c FROM stations WHERE network = 'onocoy' AND (receiver_type LIKE '%LEICA%' OR receiver_type LIKE '%TRIMBLE%' OR receiver_type LIKE '%SEPT%' OR receiver_type LIKE '%NOVATEL%' OR receiver_type LIKE '%CHC%' OR receiver_type LIKE '%SURVEY_GRADE_PROBED%')`).get() as any)?.c || 0;
    onocoy.probed = probed;
    onocoy.survey_grade = survey;

    const zv2 = path.join(dataDir, "zone-build-v2.json");
    if (fs.existsSync(zv2)) {
      const z = JSON.parse(fs.readFileSync(zv2, "utf-8"));
      onocoy.overlays = z.stats?.total_overlays || 0;
    }
  } catch {}

  // Anomalies
  let anomalies = { total_24h: 0, critical: 0 };
  try {
    const ap = path.join(dataDir, "sentinel-anomalies.json");
    if (fs.existsSync(ap)) {
      const a = JSON.parse(fs.readFileSync(ap, "utf-8"));
      anomalies.total_24h = (a.anomalies || []).length;
      anomalies.critical = (a.anomalies || []).filter((x: any) => x.severity === "critical").length;
    }
  } catch {}

  // Generate highlights
  if (health.score >= 90) highlights.push(`🟢 Network Health: ${health.score}/100 (${health.grade})`);
  else if (health.score >= 70) highlights.push(`🟡 Network Health: ${health.score}/100 (${health.grade})`);
  else highlights.push(`🔴 Network Health: ${health.score}/100 (${health.grade}) — needs attention`);

  if (sessions.avg_fix >= 95) highlights.push(`✅ Avg Fix Rate: ${sessions.avg_fix}% (excellent)`);
  else if (sessions.avg_fix < 80) highlights.push(`⚠️ Avg Fix Rate: ${sessions.avg_fix}% (below target)`);

  if (coverage.change_7d !== null) {
    if (coverage.change_7d > 0) highlights.push(`📈 Coverage improving: +${coverage.change_7d}pp in 7 days`);
    else if (coverage.change_7d < -1) highlights.push(`📉 Coverage declining: ${coverage.change_7d}pp in 7 days`);
  }

  if (anomalies.critical > 0) highlights.push(`🚨 ${anomalies.critical} critical anomalies in last 24h`);
  if (trust.excluded > 0) highlights.push(`❌ ${trust.excluded} stations excluded from config`);
  if (onocoy.survey_grade > 0) highlights.push(`🛰️ ${onocoy.survey_grade} ONOCOY survey-grade stations identified`);

  const report: DailyReport = {
    date: new Date().toISOString().split("T")[0],
    health, sessions, coverage, trust, onocoy, anomalies, highlights,
  };

  // Persist
  try {
    const fp = path.join(dataDir, "daily-report.json");
    fs.writeFileSync(fp + ".tmp", JSON.stringify(report, null, 2));
    fs.renameSync(fp + ".tmp", fp);
  } catch {}

  return report;
}

/**
 * Format report as Slack message
 */
export function formatSlackReport(report: DailyReport): string {
  return [
    `*📊 RTKdata Daily Network Report — ${report.date}*`,
    "",
    report.highlights.join("\n"),
    "",
    `*Sessions (24h):* ${report.sessions.total_24h.toLocaleString()} | Fix: ${report.sessions.avg_fix}% | Users: ${report.sessions.unique_users} | Stations: ${report.sessions.unique_stations}`,
    `*Coverage:* ${report.coverage.green_pct}% green (${report.coverage.total_cells.toLocaleString()} cells)${report.coverage.change_7d !== null ? ` | 7d: ${report.coverage.change_7d > 0 ? "+" : ""}${report.coverage.change_7d}pp` : ""}`,
    `*Trust:* ${report.trust.trusted} trusted | ${report.trust.probation} probation | ${report.trust.untrusted} untrusted | ${report.trust.new_stations} new`,
    `*ONOCOY:* ${report.onocoy.probed} probed | ${report.onocoy.survey_grade} survey-grade | ${report.onocoy.overlays} overlays`,
    `*Anomalies:* ${report.anomalies.total_24h} total | ${report.anomalies.critical} critical`,
  ].join("\n");
}
