// ─── Session Feedback Loop ───────────────────────────────────────────────────
// Validates zone quality by analyzing actual user session results.
// If users in a zone consistently get poor fix rates → flag for adjustment.
// If users at zone boundaries have quality drops → increase overlap.
//
// This closes the loop:
// Zone Generator → Caster Config → User Sessions → Session Feedback → Zone Generator
//
// Runs every 4h as part of the quality pipeline.

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ZoneFeedback {
  zone_id: string;
  zone_name: string;
  session_count: number;
  unique_users: number;
  mean_fix_rate: number;
  p10_fix_rate: number;      // 10th percentile (worst 10% of sessions)
  quality_grade: "A" | "B" | "C" | "D" | "F";
  issues: string[];
  recommendation: "keep" | "adjust_priority" | "expand_overlap" | "shrink" | "disable" | "investigate";
}

export interface FeedbackReport {
  zones: ZoneFeedback[];
  overall: {
    mean_fix_rate: number;
    zones_flagged: number;
    zones_healthy: number;
  };
  generated_at: string;
}

// ─── Thresholds ──────────────────────────────────────────────────────────────

const MIN_SESSIONS_FOR_FEEDBACK = 5;
const GOOD_FIX_RATE = 75;
const POOR_FIX_RATE = 50;
const CRITICAL_FIX_RATE = 30;
const BOUNDARY_FIX_DROP_THRESHOLD = 20; // % drop at edges vs center

// ─── Core Function ──────────────────────────────────────────────────────────

export function runSessionFeedback(db: Database.Database, dataDir: string): FeedbackReport {
  const sixHoursAgo = Date.now() - 6 * 3600000;
  const feedback: ZoneFeedback[] = [];

  // Load zones with their station lists
  let zones: any[] = [];
  try {
    const zgPath = path.join(dataDir, "zone-generation.json");
    if (fs.existsSync(zgPath)) {
      zones = JSON.parse(fs.readFileSync(zgPath, "utf-8")).zones || [];
    }
  } catch {}

  if (zones.length === 0) {
    return { zones: [], overall: { mean_fix_rate: 0, zones_flagged: 0, zones_healthy: 0 }, generated_at: new Date().toISOString() };
  }

  // Load all recent sessions grouped by station
  const sessionsByStation = new Map<string, any[]>();
  try {
    const rows = db.prepare(`
      SELECT station, fix_rate, latitude, longitude, username
      FROM rtk_sessions
      WHERE login_time >= ? AND station IS NOT NULL AND station != ''
        AND NOT (fix_rate = 0 AND duration >= 0 AND duration < 60)
    `).all(sixHoursAgo) as any[];

    for (const r of rows) {
      if (!sessionsByStation.has(r.station)) sessionsByStation.set(r.station, []);
      sessionsByStation.get(r.station)!.push(r);
    }
  } catch {}

  // Analyze each zone
  for (const zone of zones) {
    const stationNames = zone.stations || [];
    if (stationNames.length === 0) continue;

    // Collect all sessions for this zone's stations
    const zoneSessions: any[] = [];
    for (const stName of stationNames) {
      const stSessions = sessionsByStation.get(stName);
      if (stSessions) zoneSessions.push(...stSessions);
    }

    if (zoneSessions.length < MIN_SESSIONS_FOR_FEEDBACK) continue;

    // Compute metrics
    const fixRates = zoneSessions.map((s: any) => s.fix_rate || 0).sort((a: number, b: number) => a - b);
    const meanFix = fixRates.reduce((a: number, b: number) => a + b, 0) / fixRates.length;
    const p10Fix = fixRates[Math.floor(fixRates.length * 0.1)] || 0;
    const uniqueUsers = new Set(zoneSessions.map((s: any) => s.username)).size;

    // Grade
    let grade: ZoneFeedback["quality_grade"];
    if (meanFix >= 85) grade = "A";
    else if (meanFix >= 70) grade = "B";
    else if (meanFix >= 50) grade = "C";
    else if (meanFix >= 30) grade = "D";
    else grade = "F";

    // Detect issues
    const issues: string[] = [];
    let recommendation: ZoneFeedback["recommendation"] = "keep";

    if (meanFix < CRITICAL_FIX_RATE) {
      issues.push(`Critical: mean fix rate ${meanFix.toFixed(1)}% below ${CRITICAL_FIX_RATE}%`);
      recommendation = "disable";
    } else if (meanFix < POOR_FIX_RATE) {
      issues.push(`Poor: mean fix rate ${meanFix.toFixed(1)}% below ${POOR_FIX_RATE}%`);
      recommendation = "adjust_priority";
    }

    if (p10Fix < 10) {
      issues.push(`Worst 10% of sessions have fix rate <10% (possible station issues)`);
      if (recommendation === "keep") recommendation = "investigate";
    }

    // Check if fix rate drops at zone edges (stations far from center)
    if (stationNames.length >= 3 && zoneSessions.length >= 20) {
      // Simple check: stations with fewer sessions tend to be at edges
      const stationFixRates = new Map<string, number[]>();
      for (const s of zoneSessions) {
        if (!stationFixRates.has(s.station)) stationFixRates.set(s.station, []);
        stationFixRates.get(s.station)!.push(s.fix_rate || 0);
      }

      const stationAvgs = [...stationFixRates.entries()]
        .map(([name, rates]) => ({ name, avg: rates.reduce((a, b) => a + b, 0) / rates.length, count: rates.length }))
        .sort((a, b) => b.count - a.count);

      if (stationAvgs.length >= 3) {
        const coreMean = stationAvgs.slice(0, Math.ceil(stationAvgs.length / 2))
          .reduce((s, st) => s + st.avg, 0) / Math.ceil(stationAvgs.length / 2);
        const edgeMean = stationAvgs.slice(Math.ceil(stationAvgs.length / 2))
          .reduce((s, st) => s + st.avg, 0) / Math.floor(stationAvgs.length / 2);

        if (coreMean - edgeMean > BOUNDARY_FIX_DROP_THRESHOLD) {
          issues.push(`Boundary quality drop: core ${coreMean.toFixed(0)}% vs edge ${edgeMean.toFixed(0)}%. Consider expanding overlap.`);
          if (recommendation === "keep") recommendation = "expand_overlap";
        }
      }
    }

    feedback.push({
      zone_id: zone.id,
      zone_name: zone.name,
      session_count: zoneSessions.length,
      unique_users: uniqueUsers,
      mean_fix_rate: Math.round(meanFix * 10) / 10,
      p10_fix_rate: Math.round(p10Fix * 10) / 10,
      quality_grade: grade,
      issues,
      recommendation,
    });
  }

  const report: FeedbackReport = {
    zones: feedback,
    overall: {
      mean_fix_rate: feedback.length > 0
        ? Math.round(feedback.reduce((s, z) => s + z.mean_fix_rate, 0) / feedback.length * 10) / 10
        : 0,
      zones_flagged: feedback.filter(z => z.recommendation !== "keep").length,
      zones_healthy: feedback.filter(z => z.recommendation === "keep").length,
    },
    generated_at: new Date().toISOString(),
  };

  // Persist
  try {
    const filePath = path.join(dataDir, "session-feedback.json");
    const tmp = filePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(report, null, 2));
    fs.renameSync(tmp, filePath);
  } catch {}

  // ── ONOCOY Validation Loop ──────────────────────────────────────────────
  // When sessions use ONOCOY stations, update validation state
  try {
    const { updateOnocoyValidation } = require("./onocoy-gapfill");

    // Find all ONOCOY stations that had sessions
    const onocoyStations = new Map<string, { fixRates: number[]; count: number }>();

    for (const [stName, sessions] of sessionsByStation) {
      // Check if station is ONOCOY
      try {
        const stRow = db.prepare(`SELECT network FROM stations WHERE name = ?`).get(stName) as any;
        if (stRow?.network === "onocoy") {
          const fixRates = sessions.map((s: any) => s.fix_rate || 0);
          const meanFix = fixRates.reduce((a: number, b: number) => a + b, 0) / fixRates.length;
          updateOnocoyValidation(stName, meanFix, fixRates.length, dataDir);
        }
      } catch {}
    }
  } catch {}

  return report;
}
