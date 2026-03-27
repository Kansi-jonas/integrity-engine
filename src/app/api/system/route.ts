// ─── System Status API ───────────────────────────────────────────────────────
// GET /api/system — complete system status including DB sizes, counts, pipeline status

import { NextResponse } from "next/server";
import { getDb, getDataDir } from "@/lib/db";
import fs from "fs";
import path from "path";

export const dynamic = "force-dynamic";

export async function GET() {
  const db = getDb();
  const dataDir = getDataDir();

  try {
    // ── Database Stats ────────────────────────────────────────────────────
    const dbPath = path.join(dataDir, "integrity.db");
    const dbSize = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0;
    const walPath = dbPath + "-wal";
    const walSize = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;

    // Table row counts
    const counts: Record<string, number> = {};
    const tables = ["rtk_sessions", "stations", "station_scores", "station_status_log", "quality_cells", "zone_definitions", "audit_log", "interference_events", "sync_log"];
    for (const table of tables) {
      try {
        const row = db.prepare(`SELECT COUNT(*) as cnt FROM ${table}`).get() as any;
        counts[table] = row?.cnt || 0;
      } catch {
        counts[table] = -1; // Table doesn't exist
      }
    }

    // Network breakdown
    let networkBreakdown: Record<string, number> = {};
    try {
      const rows = db.prepare(`SELECT COALESCE(network, 'unknown') as net, COUNT(*) as cnt FROM stations GROUP BY net`).all() as any[];
      for (const r of rows) networkBreakdown[r.net] = r.cnt;
    } catch {}

    // ONOCOY hardware breakdown
    let onocoyHardware: Record<string, number> = {};
    try {
      const rows = db.prepare(`
        SELECT
          CASE
            WHEN receiver_type LIKE '%LEICA%' OR receiver_type LIKE '%TRIMBLE%' OR receiver_type LIKE '%SEPT%' OR receiver_type LIKE '%NOVATEL%' OR receiver_type LIKE '%CHC%' OR receiver_type LIKE '%TOPCON%' THEN 'survey_grade_exact'
            WHEN receiver_type LIKE '%SURVEY_GRADE_PROBED%' THEN 'survey_grade_probed'
            WHEN receiver_type LIKE '%SURVEY_GRADE_INFERRED%' THEN 'survey_grade_inferred'
            WHEN receiver_type LIKE '%PROFESSIONAL%' THEN 'professional'
            WHEN receiver_type LIKE '%CONSUMER%' OR receiver_type LIKE '%U-BLOX%' OR receiver_type LIKE '%F9P%' THEN 'consumer'
            WHEN receiver_type IS NULL OR receiver_type = '' THEN 'unknown'
            ELSE 'other'
          END as hw_class,
          COUNT(*) as cnt
        FROM stations WHERE network = 'onocoy'
        GROUP BY hw_class
      `).all() as any[];
      for (const r of rows) onocoyHardware[r.hw_class] = r.cnt;
    } catch {}

    // ── Disk Usage ────────────────────────────────────────────────────────
    let diskUsage: Array<{ name: string; size: number; size_human: string }> = [];
    try {
      const files = fs.readdirSync(dataDir);
      for (const f of files) {
        const fullPath = path.join(dataDir, f);
        try {
          const stat = fs.statSync(fullPath);
          if (stat.isFile()) {
            diskUsage.push({ name: f, size: stat.size, size_human: humanSize(stat.size) });
          } else if (stat.isDirectory()) {
            let dirSize = 0;
            try {
              const subFiles = fs.readdirSync(fullPath);
              for (const sf of subFiles) {
                try { dirSize += fs.statSync(path.join(fullPath, sf)).size; } catch {}
              }
            } catch {}
            diskUsage.push({ name: f + "/", size: dirSize, size_human: humanSize(dirSize) });
          }
        } catch {}
      }
      diskUsage.sort((a, b) => b.size - a.size);
    } catch {}

    // ── Pipeline Status ──────────────────────────────────────────────────
    const pipelineFiles: Record<string, { exists: boolean; age_min: number; size: string }> = {};
    const jsonFiles = [
      "trust-scores.json", "sentinel-anomalies.json", "shield-events.json",
      "environment.json", "quality-surface.json", "zone-build-v2.json",
      "onocoy-gapfill.json", "coverage-optimizer.json", "coverage-trend.json",
      "session-feedback.json", "cross-validation.json", "adversarial-report.json",
      "thompson-sampling.json", "log-feedback.json", "probe-summary.json",
      "onocoy-validation.json", "rtkbi-sync-state.json", "ntrips.cfg",
    ];
    for (const f of jsonFiles) {
      const fp = path.join(dataDir, f);
      if (fs.existsSync(fp)) {
        const stat = fs.statSync(fp);
        pipelineFiles[f] = {
          exists: true,
          age_min: Math.round((Date.now() - stat.mtimeMs) / 60000),
          size: humanSize(stat.size),
        };
      } else {
        pipelineFiles[f] = { exists: false, age_min: -1, size: "0" };
      }
    }

    // ── Environment Variables (names only, not values) ────────────────────
    const envStatus: Record<string, boolean> = {
      GEODNET_APP_KEY: !!process.env.GEODNET_APP_KEY,
      GEODNET_PPK_USER: !!process.env.GEODNET_PPK_USER,
      GEODNET_PPK_PASS: !!process.env.GEODNET_PPK_PASS,
      ONOCOY_USER: !!process.env.ONOCOY_USER,
      ONOCOY_PASS: !!process.env.ONOCOY_PASS,
      RTKBI_URL: !!process.env.RTKBI_URL,
      RTKBI_API_KEY: !!process.env.RTKBI_API_KEY,
      WIZARD_URL: !!process.env.WIZARD_URL,
      WIZARD_API_KEY: !!process.env.WIZARD_API_KEY,
      CASTER_EU_HOST: !!process.env.CASTER_EU_HOST,
      CASTER_US_HOST: !!process.env.CASTER_US_HOST,
      CASTER_AP_HOST: !!process.env.CASTER_AP_HOST,
      API_KEY: !!process.env.API_KEY,
      AUTH_USER: !!process.env.AUTH_USER,
      AUTH_PASS: !!process.env.AUTH_PASS,
      FENCE_AUTO_PUSH: process.env.FENCE_AUTO_PUSH === "true",
      FENCE_AUTO_DEPLOY: process.env.FENCE_AUTO_DEPLOY === "true",
    };

    // ── Uptime ────────────────────────────────────────────────────────────
    const uptimeS = process.uptime();

    return NextResponse.json({
      status: "operational",
      uptime: {
        seconds: Math.round(uptimeS),
        human: `${Math.floor(uptimeS / 3600)}h ${Math.floor((uptimeS % 3600) / 60)}m`,
      },
      database: {
        path: dbPath,
        size: humanSize(dbSize),
        size_bytes: dbSize,
        wal_size: humanSize(walSize),
        tables: counts,
      },
      networks: networkBreakdown,
      onocoy_hardware: onocoyHardware,
      disk: {
        total_used: humanSize(diskUsage.reduce((s, f) => s + f.size, 0)),
        files: diskUsage.slice(0, 30),
      },
      pipeline: pipelineFiles,
      env_configured: envStatus,
      version: "v0.2",
      node_version: process.version,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
