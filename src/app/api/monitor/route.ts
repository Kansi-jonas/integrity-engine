// ─── Monitor API ─────────────────────────────────────────────────────────────
// GET /api/monitor — all operational metrics in one call
// GET /api/monitor?section=db — only database stats
// GET /api/monitor?section=pipeline — only pipeline status
// GET /api/monitor?section=onocoy — only ONOCOY stats
// GET /api/monitor?section=sessions — session analytics
// GET /api/monitor?section=quality — quality distribution
// GET /api/monitor?section=agents — agent run history
// GET /api/monitor?section=sync — sync status (rtkbi, geodnet, onocoy)
// GET /api/monitor?section=errors — recent errors from all agents

import { NextRequest, NextResponse } from "next/server";
import { getDb, getDataDir } from "@/lib/db";
import fs from "fs";
import path from "path";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const section = req.nextUrl.searchParams.get("section") || "all";
  const db = getDb();
  const dataDir = getDataDir();

  const result: Record<string, any> = { timestamp: new Date().toISOString() };

  try {
    // ── Database Stats ──────────────────────────────────────────────────
    if (section === "all" || section === "db") {
      const dbPath = path.join(dataDir, "integrity.db");
      const dbSize = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0;

      const tables: Record<string, number> = {};
      for (const t of ["rtk_sessions", "stations", "station_scores", "quality_cells", "zone_definitions", "audit_log", "interference_events", "station_status_log"]) {
        try { tables[t] = (db.prepare(`SELECT COUNT(*) as c FROM ${t}`).get() as any)?.c || 0; } catch { tables[t] = -1; }
      }

      result.db = {
        size_mb: Math.round(dbSize / 1024 / 1024 * 10) / 10,
        tables,
        disk_total_mb: Math.round(getDirSize(dataDir) / 1024 / 1024 * 10) / 10,
      };
    }

    // ── Session Analytics ────────────────────────────────────────────────
    if (section === "all" || section === "sessions") {
      try {
        const total = (db.prepare(`SELECT COUNT(*) as c FROM rtk_sessions`).get() as any)?.c || 0;
        const last24h = (db.prepare(`SELECT COUNT(*) as c FROM rtk_sessions WHERE login_time >= ?`).get(Date.now() - 86400000) as any)?.c || 0;
        const last7d = (db.prepare(`SELECT COUNT(*) as c FROM rtk_sessions WHERE login_time >= ?`).get(Date.now() - 7 * 86400000) as any)?.c || 0;
        const avgFix = (db.prepare(`SELECT AVG(fix_rate) as avg FROM rtk_sessions WHERE login_time >= ? AND fix_rate > 0`).get(Date.now() - 86400000) as any)?.avg || 0;
        const uniqueStations24h = (db.prepare(`SELECT COUNT(DISTINCT station) as c FROM rtk_sessions WHERE login_time >= ? AND station IS NOT NULL AND station != ''`).get(Date.now() - 86400000) as any)?.c || 0;
        const uniqueUsers24h = (db.prepare(`SELECT COUNT(DISTINCT username) as c FROM rtk_sessions WHERE login_time >= ?`).get(Date.now() - 86400000) as any)?.c || 0;
        const oldest = (db.prepare(`SELECT MIN(login_time) as t FROM rtk_sessions`).get() as any)?.t || 0;
        const newest = (db.prepare(`SELECT MAX(login_time) as t FROM rtk_sessions`).get() as any)?.t || 0;

        result.sessions = {
          total, last_24h: last24h, last_7d: last7d,
          avg_fix_rate_24h: Math.round(avgFix * 10) / 10,
          unique_stations_24h: uniqueStations24h,
          unique_users_24h: uniqueUsers24h,
          oldest_session: oldest > 0 ? new Date(oldest).toISOString() : null,
          newest_session: newest > 0 ? new Date(newest).toISOString() : null,
          time_span_days: oldest > 0 && newest > 0 ? Math.round((newest - oldest) / 86400000) : 0,
        };
      } catch (e) { result.sessions = { error: String(e) }; }
    }

    // ── Quality Distribution ────────────────────────────────────────────
    if (section === "all" || section === "quality") {
      try {
        const tiers = db.prepare(`SELECT zone_tier, COUNT(*) as cnt, AVG(quality_score) as avg_q FROM quality_cells GROUP BY zone_tier`).all() as any[];
        const total = (db.prepare(`SELECT COUNT(*) as c FROM quality_cells`).get() as any)?.c || 0;
        const greenPct = total > 0 ? Math.round(((tiers.find((t: any) => t.zone_tier === "full_rtk")?.cnt || 0) / total) * 1000) / 10 : 0;

        result.quality = {
          total_cells: total,
          green_percentage: greenPct,
          tiers: Object.fromEntries(tiers.map((t: any) => [t.zone_tier, { count: t.cnt, avg_quality: Math.round(t.avg_q * 100) / 100 }])),
        };
      } catch (e) { result.quality = { error: String(e) }; }
    }

    // ── ONOCOY Stats ────────────────────────────────────────────────────
    if (section === "all" || section === "onocoy") {
      try {
        const total = (db.prepare(`SELECT COUNT(*) as c FROM stations WHERE network = 'onocoy'`).get() as any)?.c || 0;
        const probed = (db.prepare(`SELECT COUNT(*) as c FROM stations WHERE network = 'onocoy' AND receiver_type IS NOT NULL AND receiver_type != '' AND receiver_type NOT LIKE '%INFERRED%'`).get() as any)?.c || 0;
        const hwBreakdown = db.prepare(`
          SELECT receiver_type, COUNT(*) as cnt FROM stations
          WHERE network = 'onocoy' AND receiver_type IS NOT NULL AND receiver_type != ''
          GROUP BY receiver_type ORDER BY cnt DESC LIMIT 20
        `).all() as any[];

        // Load probe progress
        let probeProgress = null;
        try {
          const probePath = path.join(dataDir, "probe-summary.json");
          if (fs.existsSync(probePath)) probeProgress = JSON.parse(fs.readFileSync(probePath, "utf-8"));
        } catch {}

        // Load validation state
        let validation: Record<string, number> = {};
        try {
          const valPath = path.join(dataDir, "onocoy-validation.json");
          if (fs.existsSync(valPath)) {
            const valData = JSON.parse(fs.readFileSync(valPath, "utf-8"));
            for (const v of Object.values(valData) as any[]) {
              validation[v.status] = (validation[v.status] || 0) + 1;
            }
          }
        } catch {}

        // Load gap-fill stats
        let gapFill = null;
        try {
          const gfPath = path.join(dataDir, "onocoy-gapfill.json");
          if (fs.existsSync(gfPath)) {
            const gf = JSON.parse(fs.readFileSync(gfPath, "utf-8"));
            gapFill = gf.stats;
          }
        } catch {}

        result.onocoy = {
          total_stations: total,
          probed_exact: probed,
          unprobed: total - probed,
          hardware_breakdown: hwBreakdown,
          probe_progress: probeProgress,
          validation_status: validation,
          gap_fill: gapFill,
        };
      } catch (e) { result.onocoy = { error: String(e) }; }
    }

    // ── Pipeline / Agent Status ──────────────────────────────────────────
    if (section === "all" || section === "pipeline" || section === "agents") {
      const agents: Record<string, { exists: boolean; age_min: number; size_kb: number }> = {};
      const files = [
        "trust-scores.json", "sentinel-anomalies.json", "shield-events.json",
        "environment.json", "quality-surface.json", "zone-build-v2.json",
        "onocoy-gapfill.json", "coverage-optimizer.json", "session-feedback.json",
        "cross-validation.json", "adversarial-report.json", "thompson-sampling.json",
        "log-feedback.json", "ntrips.cfg", "last-deploy.json",
      ];
      for (const f of files) {
        const fp = path.join(dataDir, f);
        if (fs.existsSync(fp)) {
          const stat = fs.statSync(fp);
          agents[f.replace(".json", "").replace(".cfg", "")] = {
            exists: true,
            age_min: Math.round((Date.now() - stat.mtimeMs) / 60000),
            size_kb: Math.round(stat.size / 1024 * 10) / 10,
          };
        } else {
          agents[f.replace(".json", "").replace(".cfg", "")] = { exists: false, age_min: -1, size_kb: 0 };
        }
      }
      result.pipeline = agents;
    }

    // ── Sync Status ─────────────────────────────────────────────────────
    if (section === "all" || section === "sync") {
      // rtkbi sync state
      let rtkbiSync = null;
      try {
        const syncPath = path.join(dataDir, "rtkbi-sync-state.json");
        if (fs.existsSync(syncPath)) rtkbiSync = JSON.parse(fs.readFileSync(syncPath, "utf-8"));
      } catch {}

      // Last GEODNET sync
      let lastGeoSync = null;
      try {
        const row = db.prepare(`SELECT MAX(completed_at) as t FROM sync_log WHERE source = 'geodnet'`).get() as any;
        lastGeoSync = row?.t ? new Date(row.t).toISOString() : null;
      } catch {}

      // Last ONOCOY sync
      let lastOnoSync = null;
      try {
        const row = db.prepare(`SELECT MAX(completed_at) as t FROM sync_log WHERE source = 'onocoy'`).get() as any;
        lastOnoSync = row?.t ? new Date(row.t).toISOString() : null;
      } catch {}

      result.sync = {
        rtkbi: rtkbiSync ? {
          last_run: rtkbiSync.last_run,
          total_imported: rtkbiSync.total_imported,
          last_timestamp: rtkbiSync.last_synced_timestamp ? new Date(rtkbiSync.last_synced_timestamp).toISOString() : null,
        } : null,
        geodnet_last_sync: lastGeoSync,
        onocoy_last_sync: lastOnoSync,
      };
    }

    // ── Trust Overview ───────────────────────────────────────────────────
    if (section === "all" || section === "trust") {
      try {
        const trustPath = path.join(dataDir, "trust-scores.json");
        if (fs.existsSync(trustPath)) {
          const data = JSON.parse(fs.readFileSync(trustPath, "utf-8"));
          result.trust = data.summary || {};
          result.trust.computed_at = data.computed_at;
        }
      } catch {}
    }

    // ── Environment / Space Weather ─────────────────────────────────────
    if (section === "all" || section === "environment") {
      try {
        const envPath = path.join(dataDir, "environment.json");
        if (fs.existsSync(envPath)) {
          const env = JSON.parse(fs.readFileSync(envPath, "utf-8"));
          result.environment = {
            kp: env.ionosphere?.kp_index,
            dst: env.ionosphere?.dst_index,
            bz: env.ionosphere?.bz_component,
            storm: env.ionosphere?.storm_level,
            flare: env.ionosphere?.flare_class,
            wind_speed: env.ionosphere?.solar_wind_speed,
            sats_healthy: env.constellation?.total_healthy,
            sats_unhealthy: env.constellation?.total_unhealthy,
            sources: env.sources?.length || 0,
            errors: env.errors?.length || 0,
            fetched_at: env.fetched_at,
          };
        }
      } catch {}
    }

    // ── Config Status ───────────────────────────────────────────────────
    if (section === "all" || section === "config") {
      const configPath = path.join(dataDir, "ntrips.cfg");
      const configExists = fs.existsSync(configPath);
      let configLines = 0;
      let configSize = 0;
      if (configExists) {
        const content = fs.readFileSync(configPath, "utf-8");
        configLines = content.split("\n").length;
        configSize = content.length;
      }

      // Zone V2 stats
      let zoneStats = null;
      try {
        const zbPath = path.join(dataDir, "zone-build-v2.json");
        if (fs.existsSync(zbPath)) {
          const zb = JSON.parse(fs.readFileSync(zbPath, "utf-8"));
          zoneStats = zb.stats;
        }
      } catch {}

      // Rollback count
      let rollbacks = 0;
      try {
        const rbDir = path.join(dataDir, "config-rollback");
        if (fs.existsSync(rbDir)) rollbacks = fs.readdirSync(rbDir).filter(f => f.endsWith(".cfg")).length;
      } catch {}

      result.config = {
        exists: configExists,
        lines: configLines,
        size_kb: Math.round(configSize / 1024 * 10) / 10,
        zone_stats: zoneStats,
        rollbacks_available: rollbacks,
        auto_push: process.env.FENCE_AUTO_PUSH === "true",
        auto_deploy: process.env.FENCE_AUTO_DEPLOY === "true",
      };
    }

    // ── Env Vars Configured ─────────────────────────────────────────────
    if (section === "all" || section === "env") {
      result.env = {
        GEODNET_APP_KEY: !!process.env.GEODNET_APP_KEY,
        GEODNET_PPK_USER: !!process.env.GEODNET_PPK_USER,
        ONOCOY_USER: !!process.env.ONOCOY_USER,
        RTKBI_URL: !!process.env.RTKBI_URL,
        RTKBI_API_KEY: !!process.env.RTKBI_API_KEY,
        WIZARD_URL: !!process.env.WIZARD_URL,
        CASTER_EU_HOST: !!process.env.CASTER_EU_HOST,
        CASTER_US_HOST: !!process.env.CASTER_US_HOST,
        CASTER_AP_HOST: !!process.env.CASTER_AP_HOST,
        API_KEY: !!process.env.API_KEY,
        AUTH_USER: !!process.env.AUTH_USER,
        FENCE_AUTO_PUSH: process.env.FENCE_AUTO_PUSH === "true",
        FENCE_AUTO_DEPLOY: process.env.FENCE_AUTO_DEPLOY === "true",
      };
    }

    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

function getDirSize(dir: string): number {
  let size = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      const fp = path.join(dir, f);
      try {
        const stat = fs.statSync(fp);
        if (stat.isFile()) size += stat.size;
        else if (stat.isDirectory()) size += getDirSize(fp);
      } catch {}
    }
  } catch {}
  return size;
}
