// ─── Map Data API ────────────────────────────────────────────────────────────
// Returns session dots, station points, and anomaly clusters for the world map.

import { NextResponse } from "next/server";
import { getDb, getDataDir } from "@/lib/db";
import fs from "fs";
import path from "path";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const db = getDb();
    const dataDir = getDataDir();
    const sixHoursAgo = Date.now() - 6 * 3600000;

    // Active sessions (last 6h) with position
    const sessions = db.prepare(`
      SELECT station, fix_rate, avg_age, latitude, longitude, username, duration
      FROM rtk_sessions
      WHERE login_time >= ? AND station IS NOT NULL AND station != ''
        AND latitude IS NOT NULL AND ABS(latitude) > 0.1
        AND NOT (fix_rate = 0 AND duration >= 0 AND duration < 60)
      ORDER BY login_time DESC
      LIMIT 2000
    `).all(sixHoursAgo) as any[];

    // Station positions with trust scores
    let trustMap: Record<string, any> = {};
    try {
      const trustPath = path.join(dataDir, "trust-scores.json");
      if (fs.existsSync(trustPath)) {
        const trustData = JSON.parse(fs.readFileSync(trustPath, "utf-8"));
        for (const t of (trustData.scores || [])) {
          trustMap[t.station] = { trust: t.combined_score, flag: t.flag };
        }
      }
    } catch {}

    const stations = db.prepare(`
      SELECT name, latitude, longitude, status, network
      FROM stations
      WHERE latitude IS NOT NULL AND ABS(latitude) > 0.1
      LIMIT 5000
    `).all() as any[];

    // Anomaly locations
    let anomalyRegions: any[] = [];
    try {
      const siPath = path.join(dataDir, "signal-integrity.json");
      if (fs.existsSync(siPath)) {
        const si = JSON.parse(fs.readFileSync(siPath, "utf-8"));
        anomalyRegions = (si.anomalies || [])
          .filter((a: any) => a.region)
          .map((a: any) => ({
            type: a.type,
            severity: a.severity,
            lat: a.region.lat,
            lon: a.region.lon,
            radius_km: a.region.radius_km,
            affected_users: a.affected_users,
          }));
      }
    } catch {}

    // Space weather for iono overlay
    let spaceWeather = null;
    try {
      const swPath = path.join(dataDir, "space-weather.json");
      if (fs.existsSync(swPath)) {
        spaceWeather = JSON.parse(fs.readFileSync(swPath, "utf-8"));
      }
    } catch {}

    return NextResponse.json({
      sessions: sessions.map((s: any) => ({
        lat: s.latitude,
        lon: s.longitude,
        fix: Math.round(s.fix_rate * 10) / 10,
        age: Math.round((s.avg_age || 0) * 10) / 10,
        station: s.station,
        live: s.duration === -1,
      })),
      stations: stations.map((s: any) => ({
        name: s.name,
        lat: s.latitude,
        lon: s.longitude,
        status: s.status,
        network: s.network,
        trust: trustMap[s.name]?.trust ?? null,
        flag: trustMap[s.name]?.flag ?? null,
      })),
      anomalies: anomalyRegions,
      space_weather: spaceWeather ? {
        kp: spaceWeather.kp_index,
        storm: spaceWeather.storm_level,
        affected_regions: spaceWeather.expected_impact?.affected_regions || [],
      } : null,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
