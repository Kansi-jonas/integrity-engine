// ─── Public Customer Dashboard API ───────────────────────────────────────────
// GET /api/public/dashboard — sanitized integrity data for RTKdata customers
//
// NO station names, NO network names, NO internal metrics.
// Only: regional quality scores, space weather, constellation health.
//
// Auth: separate API key (PUBLIC_API_KEY) or no auth (public endpoint)

import { NextRequest, NextResponse } from "next/server";
import { getDb, getDataDir } from "@/lib/db";
import fs from "fs";
import path from "path";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  // Public API key check (optional — can be fully public)
  const publicKey = process.env.PUBLIC_API_KEY;
  if (publicKey) {
    const keyHeader = req.headers.get("x-api-key");
    if (keyHeader !== publicKey) {
      return NextResponse.json({ error: "Invalid API key" }, { status: 401 });
    }
  }

  const db = getDb();
  const dataDir = getDataDir();

  try {
    // ── Regional Integrity Scores ─────────────────────────────────────────
    const regions = [
      { name: "Europe", lat: 50, lon: 10, radius: 20 },
      { name: "North America", lat: 40, lon: -95, radius: 25 },
      { name: "Asia Pacific", lat: -25, lon: 135, radius: 20 },
      { name: "South America", lat: -15, lon: -50, radius: 20 },
      { name: "Middle East", lat: 25, lon: 50, radius: 15 },
    ];

    const regionScores: Array<{ name: string; integrity_score: number; status: string }> = [];

    for (const region of regions) {
      try {
        const cells = db.prepare(`
          SELECT AVG(quality_score) as avg_q, COUNT(*) as cnt
          FROM quality_cells
          WHERE quality_score > 0
        `).get() as any;

        // Simplified: use global average for now
        const score = Math.round((cells?.avg_q || 0) * 100);
        regionScores.push({
          name: region.name,
          integrity_score: score,
          status: score >= 80 ? "operational" : score >= 60 ? "degraded" : "issues",
        });
      } catch {
        regionScores.push({ name: region.name, integrity_score: 0, status: "unknown" });
      }
    }

    // ── Space Weather (safe to expose) ────────────────────────────────────
    let spaceWeather: any = null;
    try {
      const envPath = path.join(dataDir, "environment.json");
      if (fs.existsSync(envPath)) {
        const env = JSON.parse(fs.readFileSync(envPath, "utf-8"));
        spaceWeather = {
          geomagnetic_activity: env.ionosphere?.storm_level || "quiet",
          kp_index: env.ionosphere?.kp_index || 0,
          solar_flare: env.ionosphere?.flare_class || null,
          constellation_health: {
            gps: env.constellation?.gps?.healthy || 0,
            glonass: env.constellation?.glonass?.healthy || 0,
            galileo: env.constellation?.galileo?.healthy || 0,
            beidou: env.constellation?.beidou?.healthy || 0,
          },
          impact: env.ionosphere?.storm_level !== "quiet"
            ? `Geomagnetic activity may affect RTK quality in high-latitude regions`
            : "No impact on RTK quality expected",
          updated_at: env.fetched_at,
        };
      }
    } catch {}

    // ── Global Stats (anonymized) ────────────────────────────────────────
    const globalStats = {
      stations_online: 0,
      countries_covered: 0,
      avg_fix_rate_24h: 0,
    };

    try {
      const stationCount = (db.prepare(`SELECT COUNT(*) as c FROM stations WHERE status IN ('ONLINE','ACTIVE')`).get() as any)?.c || 0;
      const countryCount = (db.prepare(`SELECT COUNT(DISTINCT country) as c FROM stations WHERE country IS NOT NULL AND country != ''`).get() as any)?.c || 0;
      const avgFix = (db.prepare(`SELECT AVG(fix_rate) as avg FROM rtk_sessions WHERE login_time >= ? AND fix_rate > 0`).get(Date.now() - 86400000) as any)?.avg || 0;

      globalStats.stations_online = stationCount;
      globalStats.countries_covered = countryCount;
      globalStats.avg_fix_rate_24h = Math.round(avgFix * 10) / 10;
    } catch {}

    // ── Quality Forecast (next 6h) ───────────────────────────────────────
    let forecast = null;
    try {
      if (spaceWeather) {
        const kp = spaceWeather.kp_index;
        forecast = {
          next_6h: kp <= 3 ? "stable" : kp <= 5 ? "minor_degradation" : "significant_degradation",
          description: kp <= 3
            ? "RTK quality expected to remain stable"
            : kp <= 5
            ? "Minor quality degradation possible in northern latitudes"
            : "Significant quality degradation expected — consider shorter baselines",
        };
      }
    } catch {}

    return NextResponse.json({
      status: "operational",
      global: globalStats,
      regions: regionScores,
      space_weather: spaceWeather,
      forecast,
      updated_at: new Date().toISOString(),
      // No station names, no network names, no internal data
    });
  } catch (error) {
    return NextResponse.json({ error: "Service unavailable" }, { status: 500 });
  }
}
