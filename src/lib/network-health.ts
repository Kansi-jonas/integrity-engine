// ─── Network Health Score ─────────────────────────────────────────────────────
// Single composite metric that captures overall network quality.
// Used for: executive dashboard, SLA reporting, investor updates.
//
// NHS = 0.40 × Quality + 0.25 × Reliability + 0.20 × Coverage + 0.15 × Freshness
//
// Quality: weighted average fix rate from sessions (last 24h)
// Reliability: station uptime + failover success rate
// Coverage: percentage of H3 cells at full_rtk tier
// Freshness: average correction age (lower = better)
//
// Score: 0-100
// 90+ = Excellent
// 80-89 = Good
// 70-79 = Acceptable
// 60-69 = Degraded
// <60 = Critical

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

export interface NetworkHealthScore {
  score: number;
  grade: "excellent" | "good" | "acceptable" | "degraded" | "critical";
  components: {
    quality: { score: number; weight: number; detail: string };
    reliability: { score: number; weight: number; detail: string };
    coverage: { score: number; weight: number; detail: string };
    freshness: { score: number; weight: number; detail: string };
  };
  trend: {
    score_1h_ago: number | null;
    score_24h_ago: number | null;
    direction: "improving" | "stable" | "declining";
  };
  computed_at: string;
}

export function computeNetworkHealth(db: Database.Database, dataDir: string): NetworkHealthScore {
  const now = Date.now();

  // ── Quality Component (40%) ────────────────────────────────────────────
  let qualityScore = 0;
  let qualityDetail = "";
  try {
    const row = db.prepare(`
      SELECT AVG(fix_rate) as avg_fix, COUNT(*) as cnt
      FROM rtk_sessions
      WHERE login_time >= ? AND fix_rate > 0 AND station IS NOT NULL
    `).get(now - 86400000) as any;

    const avgFix = row?.avg_fix || 0;
    qualityScore = Math.min(100, avgFix);
    qualityDetail = `Avg fix rate: ${Math.round(avgFix * 10) / 10}% (${(row?.cnt || 0).toLocaleString()} sessions)`;
  } catch {}

  // ── Reliability Component (25%) ────────────────────────────────────────
  let reliabilityScore = 0;
  let reliabilityDetail = "";
  try {
    const row = db.prepare(`
      SELECT AVG(uptime_7d) as avg_uptime, COUNT(*) as cnt
      FROM station_scores WHERE uptime_7d IS NOT NULL
    `).get() as any;

    const avgUptime = (row?.avg_uptime || 0) * 100;
    reliabilityScore = Math.min(100, avgUptime);
    reliabilityDetail = `Avg uptime: ${Math.round(avgUptime * 10) / 10}% (${row?.cnt || 0} stations)`;
  } catch {}

  // ── Coverage Component (20%) ──────────────────────────────────────────
  let coverageScore = 0;
  let coverageDetail = "";
  try {
    const total = (db.prepare(`SELECT COUNT(*) as c FROM quality_cells`).get() as any)?.c || 0;
    const green = (db.prepare(`SELECT COUNT(*) as c FROM quality_cells WHERE zone_tier = 'full_rtk'`).get() as any)?.c || 0;
    const greenPct = total > 0 ? (green / total) * 100 : 0;
    coverageScore = Math.min(100, greenPct * 1.5); // Scale: 66% green = 100 score
    coverageDetail = `${Math.round(greenPct * 10) / 10}% full RTK coverage (${green.toLocaleString()}/${total.toLocaleString()} cells)`;
  } catch {}

  // ── Freshness Component (15%) ─────────────────────────────────────────
  let freshnessScore = 0;
  let freshnessDetail = "";
  try {
    const row = db.prepare(`
      SELECT AVG(median_correction_age) as avg_age
      FROM station_scores WHERE median_correction_age IS NOT NULL AND median_correction_age > 0
    `).get() as any;

    const avgAge = row?.avg_age || 5;
    freshnessScore = Math.max(0, Math.min(100, (1 - avgAge / 10) * 100));
    freshnessDetail = `Avg correction age: ${Math.round(avgAge * 100) / 100}s`;
  } catch {}

  // ── Composite Score ───────────────────────────────────────────────────
  const score = Math.round(
    qualityScore * 0.40 +
    reliabilityScore * 0.25 +
    coverageScore * 0.20 +
    freshnessScore * 0.15
  );

  let grade: NetworkHealthScore["grade"];
  if (score >= 90) grade = "excellent";
  else if (score >= 80) grade = "good";
  else if (score >= 70) grade = "acceptable";
  else if (score >= 60) grade = "degraded";
  else grade = "critical";

  // ── Trend ─────────────────────────────────────────────────────────────
  let score1hAgo: number | null = null;
  let score24hAgo: number | null = null;
  try {
    const trendPath = path.join(dataDir, "health-trend.json");
    let trendData: any = { history: [] };
    if (fs.existsSync(trendPath)) {
      trendData = JSON.parse(fs.readFileSync(trendPath, "utf-8"));
    }

    // Find scores from 1h and 24h ago
    const h1 = trendData.history.find((h: any) => Math.abs(h.timestamp - (now - 3600000)) < 1800000);
    const h24 = trendData.history.find((h: any) => Math.abs(h.timestamp - (now - 86400000)) < 3600000);
    score1hAgo = h1?.score ?? null;
    score24hAgo = h24?.score ?? null;

    // Save current
    trendData.history.push({ timestamp: now, score });
    // Keep last 7 days
    trendData.history = trendData.history.filter((h: any) => h.timestamp > now - 7 * 86400000);
    fs.writeFileSync(trendPath + ".tmp", JSON.stringify(trendData));
    fs.renameSync(trendPath + ".tmp", trendPath);
  } catch {}

  let direction: "improving" | "stable" | "declining" = "stable";
  if (score1hAgo !== null) {
    if (score > score1hAgo + 2) direction = "improving";
    else if (score < score1hAgo - 2) direction = "declining";
  }

  const result: NetworkHealthScore = {
    score,
    grade,
    components: {
      quality: { score: Math.round(qualityScore), weight: 0.40, detail: qualityDetail },
      reliability: { score: Math.round(reliabilityScore), weight: 0.25, detail: reliabilityDetail },
      coverage: { score: Math.round(coverageScore), weight: 0.20, detail: coverageDetail },
      freshness: { score: Math.round(freshnessScore), weight: 0.15, detail: freshnessDetail },
    },
    trend: { score_1h_ago: score1hAgo, score_24h_ago: score24hAgo, direction },
    computed_at: new Date().toISOString(),
  };

  // Persist
  try {
    const fp = path.join(dataDir, "network-health.json");
    fs.writeFileSync(fp + ".tmp", JSON.stringify(result, null, 2));
    fs.renameSync(fp + ".tmp", fp);
  } catch {}

  return result;
}
