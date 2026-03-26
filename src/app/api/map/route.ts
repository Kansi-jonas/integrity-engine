// ─── Map Data API V2 ─────────────────────────────────────────────────────────
// Returns EVERYTHING the map needs: sessions, stations, anomalies, interference,
// ionosphere, troposphere, constellation, coverage gaps, probes.

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

    // ── Sessions ──────────────────────────────────────────────────────────
    const sessions = db.prepare(`
      SELECT station, fix_rate, avg_age, latitude, longitude, username, duration
      FROM rtk_sessions
      WHERE login_time >= ? AND station IS NOT NULL AND station != ''
        AND latitude IS NOT NULL AND ABS(latitude) > 0.1
        AND NOT (fix_rate = 0 AND duration >= 0 AND duration < 60)
      ORDER BY login_time DESC LIMIT 2000
    `).all(sixHoursAgo) as any[];

    // ── Stations with trust ───────────────────────────────────────────────
    let trustMap: Record<string, any> = {};
    try {
      const trustPath = path.join(dataDir, "trust-scores.json");
      if (fs.existsSync(trustPath)) {
        const td = JSON.parse(fs.readFileSync(trustPath, "utf-8"));
        for (const t of (td.scores || [])) {
          trustMap[t.station] = {
            trust: t.composite_score ?? t.combined_score ?? null,
            flag: t.flag,
            tier: t.quality_tier,
          };
        }
      }
    } catch {}

    const stations = db.prepare(`
      SELECT name, latitude, longitude, status, network
      FROM stations WHERE latitude IS NOT NULL AND ABS(latitude) > 0.1
      LIMIT 5000
    `).all() as any[];

    // ── Anomalies (from Signal Integrity) ─────────────────────────────────
    let anomalies: any[] = [];
    try {
      const siPath = path.join(dataDir, "signal-integrity.json");
      if (fs.existsSync(siPath)) {
        const si = JSON.parse(fs.readFileSync(siPath, "utf-8"));
        anomalies = (si.anomalies || []).filter((a: any) => a.region).map((a: any) => ({
          type: a.type, severity: a.severity,
          lat: a.region.lat, lon: a.region.lon, radius_km: a.region.radius_km,
          affected_users: a.affected_users, station: a.station,
        }));
      }
    } catch {}

    // ── SHIELD Interference Events ────────────────────────────────────────
    let interference: any[] = [];
    try {
      const shPath = path.join(dataDir, "shield-events.json");
      if (fs.existsSync(shPath)) {
        const sh = JSON.parse(fs.readFileSync(shPath, "utf-8"));
        interference = (sh.events || []).slice(0, 20)
          .filter((e: any) => e.region)
          .map((e: any) => ({
            classification: e.classification,
            confidence: e.confidence,
            severity: e.severity,
            lat: e.region.lat, lon: e.region.lon, radius_km: e.region.radius_km,
            affected_users: e.affected_users,
            description: e.description,
          }));
      }
    } catch {}

    // ── Full Environment Data ─────────────────────────────────────────────
    let environment: any = null;
    try {
      const envPath = path.join(dataDir, "environment.json");
      if (fs.existsSync(envPath)) {
        const env = JSON.parse(fs.readFileSync(envPath, "utf-8"));
        environment = {
          ionosphere: {
            kp: env.ionosphere?.kp_index ?? 0,
            dst: env.ionosphere?.dst_index ?? 0,
            bz: env.ionosphere?.bz_component ?? 0,
            wind_speed: env.ionosphere?.solar_wind_speed ?? 0,
            storm: env.ionosphere?.storm_level ?? "quiet",
            phase: env.ionosphere?.storm_phase ?? "quiet",
            flare: env.ionosphere?.flare_class ?? null,
            fix_impact: env.ionosphere?.expected_fix_impact_pct ?? 0,
            affected_regions: env.ionosphere?.affected_regions ?? [],
          },
          troposphere: (env.troposphere?.regions || []).map((r: any) => ({
            name: r.name, lat: r.lat, lon: r.lon,
            humidity: r.humidity_pct, temp: r.temperature_c,
            precip: r.precipitation_mm, risk: r.tropo_delay_risk,
          })),
          constellation: {
            gps: env.constellation?.gps?.healthy ?? 0,
            gps_total: env.constellation?.gps?.total ?? 0,
            glonass: env.constellation?.glonass?.healthy ?? 0,
            glonass_total: env.constellation?.glonass?.total ?? 0,
            galileo: env.constellation?.galileo?.healthy ?? 0,
            galileo_total: env.constellation?.galileo?.total ?? 0,
            beidou: env.constellation?.beidou?.healthy ?? 0,
            beidou_total: env.constellation?.beidou?.total ?? 0,
            alerts: [
              ...(env.constellation?.gps?.alerts || []),
              ...(env.constellation?.glonass?.alerts || []),
              ...(env.constellation?.galileo?.alerts || []),
              ...(env.constellation?.beidou?.alerts || []),
            ].slice(0, 5),
          },
          cme: (env.cme_forecast || []).slice(0, 3).map((c: any) => ({
            speed: c.speed_km_s, arrival: c.expected_arrival, kp: c.expected_kp,
          })),
        };
      }
    } catch {}

    // ── ONOCOY Probe Results ──────────────────────────────────────────────
    let probes: any[] = [];
    try {
      const probePath = path.join(dataDir, "onocoy-probes.json");
      if (fs.existsSync(probePath)) {
        const pd = JSON.parse(fs.readFileSync(probePath, "utf-8"));
        // Get station coords for probed stations
        const probeStations = new Set((pd.results || []).slice(0, 50).map((r: any) => r.station));
        const stationCoords = new Map<string, { lat: number; lon: number }>();
        try {
          const rows = db.prepare(`SELECT name, latitude, longitude FROM stations WHERE name IN (${[...probeStations].map(() => "?").join(",")})`)
            .all(...probeStations) as any[];
          for (const r of rows) stationCoords.set(r.name, { lat: r.latitude, lon: r.longitude });
        } catch {}

        probes = (pd.results || []).slice(0, 50)
          .filter((r: any) => stationCoords.has(r.station))
          .map((r: any) => {
            const coords = stationCoords.get(r.station)!;
            return {
              station: r.station, lat: coords.lat, lon: coords.lon,
              success: r.success, type: r.probe_type,
              latency: r.connect_latency_ms, bytes: r.bytes_received,
            };
          });
      }
    } catch {}

    // ── Coverage Gaps (areas with no station within 40km) ─────────────────
    // Simplified: find regions where sessions exist but nearest station is far
    let coverageGaps: any[] = [];
    try {
      const gapSessions = sessions.filter((s: any) => {
        // Check if any station is within 40km
        let minDist = Infinity;
        for (const st of stations.slice(0, 2000)) {
          const d = Math.sqrt(Math.pow((s.latitude - st.latitude) * 111, 2) + Math.pow((s.longitude - st.longitude) * 111 * Math.cos(s.latitude * Math.PI / 180), 2));
          if (d < minDist) minDist = d;
          if (d < 40) break;
        }
        return minDist > 40;
      });

      // Cluster gap sessions
      const gapGrid = new Map<string, { lat: number; lon: number; count: number }>();
      for (const s of gapSessions) {
        const key = `${Math.round(s.latitude)},${Math.round(s.longitude)}`;
        if (!gapGrid.has(key)) gapGrid.set(key, { lat: s.latitude, lon: s.longitude, count: 0 });
        gapGrid.get(key)!.count++;
      }
      coverageGaps = [...gapGrid.values()].filter(g => g.count >= 2);
    } catch {}

    return NextResponse.json({
      sessions: sessions.map((s: any) => ({
        lat: s.latitude, lon: s.longitude,
        fix: Math.round(s.fix_rate * 10) / 10,
        age: Math.round((s.avg_age || 0) * 10) / 10,
        station: s.station, live: s.duration === -1,
      })),
      stations: stations.map((s: any) => ({
        name: s.name, lat: s.latitude, lon: s.longitude,
        status: s.status, network: s.network,
        trust: trustMap[s.name]?.trust ?? null,
        flag: trustMap[s.name]?.flag ?? null,
      })),
      anomalies,
      interference,
      environment,
      probes,
      coverage_gaps: coverageGaps,
      // TEC Heatmap from IGS GIM
      vtec_grid: (() => {
        try {
          const envData = JSON.parse(fs.readFileSync(path.join(dataDir, "environment.json"), "utf-8"));
          return envData.vtec?.grid || [];
        } catch { return []; }
      })(),
      // Quality Surface from Kriging
      quality_surface: (() => {
        try {
          const surface = JSON.parse(fs.readFileSync(path.join(dataDir, "quality-surface.json"), "utf-8"));
          return (surface.grid || []).map((g: any) => ({
            lat: g.lat, lon: g.lon,
            predicted: g.predicted, variance: g.variance,
            confidence: g.confidence, n_stations: g.n_stations,
          }));
        } catch { return []; }
      })(),
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
