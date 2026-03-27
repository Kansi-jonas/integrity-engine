// ─── Quality API ─────────────────────────────────────────────────────────────
// Returns H3 quality cells + zone definitions + station scores for the dashboard.
// GET /api/quality — full quality data
// GET /api/quality?format=geojson — GeoJSON for mapping

import { NextRequest, NextResponse } from "next/server";
import { getDb, getDataDir } from "@/lib/db";
import fs from "fs";
import path from "path";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const format = req.nextUrl.searchParams.get("format") || "json";

  try {
    const db = getDb();
    const dataDir = getDataDir();

    // Load H3 quality cells
    const cells = db.prepare(`
      SELECT h3_index, resolution, quality_score, fix_component, age_component,
             density_component, uptime_component, baseline_component,
             session_count, unique_users, confidence, is_interpolated,
             zone_tier, nearest_station, nearest_station_km
      FROM quality_cells
      ORDER BY quality_score DESC
    `).all() as any[];

    // Add lat/lon from H3 index
    let cellsWithCoords: any[] = [];
    try {
      const h3 = require("h3-js");
      cellsWithCoords = cells.map(c => {
        try {
          const [lat, lon] = h3.cellToLatLng(c.h3_index);
          const boundary = h3.cellToBoundary(c.h3_index);
          return { ...c, lat: Math.round(lat * 1e4) / 1e4, lon: Math.round(lon * 1e4) / 1e4, boundary };
        } catch {
          return { ...c, lat: 0, lon: 0, boundary: [] };
        }
      }).filter(c => c.lat !== 0);
    } catch {
      cellsWithCoords = cells;
    }

    // Tier counts
    const tierCounts: Record<string, { count: number; avg_quality: number }> = {};
    for (const c of cells) {
      if (!tierCounts[c.zone_tier]) tierCounts[c.zone_tier] = { count: 0, avg_quality: 0 };
      tierCounts[c.zone_tier].count++;
      tierCounts[c.zone_tier].avg_quality += c.quality_score;
    }
    for (const t of Object.values(tierCounts)) {
      t.avg_quality = t.count > 0 ? Math.round(t.avg_quality / t.count * 100) / 100 : 0;
    }

    // Load zone build result
    let zones: any[] = [];
    try {
      const zbPath = path.join(dataDir, "zone-build.json");
      if (fs.existsSync(zbPath)) {
        const zb = JSON.parse(fs.readFileSync(zbPath, "utf-8"));
        zones = zb.zones || [];
      }
    } catch {}

    // Load station scores summary
    const stationStats = db.prepare(`
      SELECT COUNT(*) as total,
             SUM(CASE WHEN uq_score >= 0.5 THEN 1 ELSE 0 END) as good,
             SUM(CASE WHEN uq_score < 0.3 THEN 1 ELSE 0 END) as poor,
             AVG(uq_score) as avg_uq,
             AVG(uptime_7d) as avg_uptime
      FROM station_scores
    `).get() as any || { total: 0, good: 0, poor: 0, avg_uq: 0, avg_uptime: 0 };

    if (format === "geojson") {
      const features = cellsWithCoords.map(c => ({
        type: "Feature",
        geometry: {
          type: "Polygon",
          coordinates: [c.boundary.map((p: number[]) => [p[1], p[0]]).concat([c.boundary[0] ? [c.boundary[0][1], c.boundary[0][0]] : []])],
        },
        properties: {
          h3_index: c.h3_index,
          quality_score: c.quality_score,
          zone_tier: c.zone_tier,
          confidence: c.confidence,
          session_count: c.session_count,
          nearest_station: c.nearest_station,
          nearest_station_km: c.nearest_station_km,
        },
      }));

      return NextResponse.json({
        type: "FeatureCollection",
        features,
      });
    }

    return NextResponse.json({
      version: "h3",
      cells: cellsWithCoords.slice(0, 5000), // Cap for performance
      totalCells: cells.length,
      tierCounts: Object.entries(tierCounts).map(([tier, data]) => ({ zone_tier: tier, ...data })),
      zones,
      stations: {
        total: stationStats.total || 0,
        good: stationStats.good || 0,
        poor: stationStats.poor || 0,
        avgUQ: Math.round((stationStats.avg_uq || 0) * 100) / 100,
        avgUptime: Math.round((stationStats.avg_uptime || 0) * 100) / 100,
      },
      computed_at: cells[0]?.computed_at ? new Date(cells[0].computed_at).toISOString() : null,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
