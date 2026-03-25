// ─── MERIDIAN Zone Sync ──────────────────────────────────────────────────────
// Pulls zone definitions and quality data from the GNSS Wizard or rtkbi.
// Stores locally so the Integrity Engine can compute per-zone integrity scores.

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

const WIZARD_URL = process.env.WIZARD_URL || "";
const WIZARD_API_KEY = process.env.WIZARD_API_KEY || "";
const RTKBI_URL = process.env.RTKBI_URL || "";
const RTKBI_API_KEY = process.env.RTKBI_API_KEY || "";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface MeridianZone {
  id: string;
  name: string;
  network_id: string;
  enabled: boolean;
  priority: number;
  geofence: {
    type: "circle" | "polygon";
    lat?: number;
    lon?: number;
    radius?: number;
    points?: number[][];
  } | null;
  color: string;
}

export interface ZoneIntegrity {
  zone_id: string;
  zone_name: string;
  integrity_score: number;
  mean_fix_rate: number;
  active_sessions: number;
  active_users: number;
  anomaly_count: number;
  trust_avg: number;
  trend: "improving" | "stable" | "declining";
}

// ─── Fetch Zones from Wizard ─────────────────────────────────────────────────

async function fetchWithTimeout(url: string, headers: Record<string, string>, timeout = 10000): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function syncMeridianZones(dataDir: string): Promise<MeridianZone[]> {
  let zones: MeridianZone[] = [];

  // Try Wizard first
  if (WIZARD_URL) {
    try {
      const data = await fetchWithTimeout(
        `${WIZARD_URL}/api/data/zones`,
        { "X-API-Key": WIZARD_API_KEY }
      );
      // Wizard returns Record<string, ZoneJSON>
      zones = Object.values(data).map((z: any) => ({
        id: z.id,
        name: z.name,
        network_id: z.network_id,
        enabled: z.enabled,
        priority: z.priority,
        geofence: z.geofence,
        color: z.color,
      }));
      console.log(`[MERIDIAN-SYNC] ${zones.length} zones from Wizard`);
    } catch (err) {
      console.error("[MERIDIAN-SYNC] Wizard fetch failed:", err);
    }
  }

  // Fallback: try rtkbi MERIDIAN API
  if (zones.length === 0 && RTKBI_URL) {
    try {
      const data = await fetchWithTimeout(
        `${RTKBI_URL}/api/meridian/zones`,
        { "X-API-Key": RTKBI_API_KEY }
      );
      if (data?.zones) {
        zones = data.zones.map((z: any) => ({
          id: z.id || z.zone_id,
          name: z.name || z.zone_name,
          network_id: z.network_id || "",
          enabled: z.enabled !== false,
          priority: z.priority || 10,
          geofence: z.geofence || null,
          color: z.color || "#6b7280",
        }));
        console.log(`[MERIDIAN-SYNC] ${zones.length} zones from rtkbi`);
      }
    } catch (err) {
      console.error("[MERIDIAN-SYNC] rtkbi fetch failed:", err);
    }
  }

  // Persist
  if (zones.length > 0) {
    try {
      const filePath = path.join(dataDir, "meridian-zones.json");
      const tmp = filePath + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(zones));
      fs.renameSync(tmp, filePath);
    } catch {}
  }

  return zones;
}

// ─── Compute Per-Zone Integrity ──────────────────────────────────────────────
// Uses session data to compute integrity scores per MERIDIAN zone.

export function computeZoneIntegrity(
  db: Database.Database,
  zones: MeridianZone[],
  trustScores: any[]
): ZoneIntegrity[] {
  const sixHoursAgo = Date.now() - 6 * 3600000;
  const twentyFourHoursAgo = Date.now() - 24 * 3600000;
  const results: ZoneIntegrity[] = [];

  // Build trust lookup
  const trustMap = new Map<string, number>();
  for (const t of trustScores) {
    trustMap.set(t.station, t.combined_score || 0);
  }

  // Load all recent sessions with coordinates
  const sessions = db.prepare(`
    SELECT station, fix_rate, avg_age, latitude, longitude, username, login_time
    FROM rtk_sessions
    WHERE login_time >= ? AND station IS NOT NULL AND station != ''
      AND latitude IS NOT NULL AND ABS(latitude) > 0.1
      AND NOT (fix_rate = 0 AND duration >= 0 AND duration < 60)
  `).all(sixHoursAgo) as any[];

  // Also load 24h sessions for trend
  const sessions24h = db.prepare(`
    SELECT station, fix_rate, latitude, longitude
    FROM rtk_sessions
    WHERE login_time >= ? AND login_time < ?
      AND station IS NOT NULL AND station != ''
      AND latitude IS NOT NULL AND ABS(latitude) > 0.1
      AND NOT (fix_rate = 0 AND duration >= 0 AND duration < 60)
    ORDER BY RANDOM() LIMIT 20000
  `).all(twentyFourHoursAgo, sixHoursAgo) as any[];

  for (const zone of zones) {
    if (!zone.enabled || !zone.geofence) continue;

    // Filter sessions inside this zone's geofence
    const inside = sessions.filter(s => isInsideGeofence(s.latitude, s.longitude, zone.geofence!));
    const inside24h = sessions24h.filter(s => isInsideGeofence(s.latitude, s.longitude, zone.geofence!));

    if (inside.length === 0) continue;

    const meanFix = inside.reduce((sum: number, s: any) => sum + (s.fix_rate || 0), 0) / inside.length;
    const users = new Set(inside.map((s: any) => s.username));
    const stations = new Set(inside.map((s: any) => s.station));

    // Trust average for stations in this zone
    const stationTrusts = [...stations].map(s => trustMap.get(s) ?? 0.5);
    const trustAvg = stationTrusts.length > 0
      ? stationTrusts.reduce((a, b) => a + b, 0) / stationTrusts.length
      : 0.5;

    // Integrity score (weighted)
    const fixComponent = Math.min(1, meanFix / 100) * 40;
    const trustComponent = trustAvg * 30;
    const availComponent = Math.min(1, stations.size / 5) * 20; // More stations = better
    const coherenceComponent = computeCoherence(inside) * 10;
    const score = Math.round(fixComponent + trustComponent + availComponent + coherenceComponent);

    // Trend vs 24h baseline
    let trend: "improving" | "stable" | "declining" = "stable";
    if (inside24h.length >= 10) {
      const baseline = inside24h.reduce((s: number, x: any) => s + (x.fix_rate || 0), 0) / inside24h.length;
      if (meanFix > baseline * 1.05) trend = "improving";
      else if (meanFix < baseline * 0.95) trend = "declining";
    }

    results.push({
      zone_id: zone.id,
      zone_name: zone.name,
      integrity_score: Math.min(100, Math.max(0, score)),
      mean_fix_rate: Math.round(meanFix * 10) / 10,
      active_sessions: inside.length,
      active_users: users.size,
      anomaly_count: 0, // Filled by caller
      trust_avg: Math.round(trustAvg * 1000) / 1000,
      trend,
    });
  }

  return results.sort((a, b) => b.active_sessions - a.active_sessions);
}

// ─── Geofence Point-in-Polygon ───────────────────────────────────────────────

function isInsideGeofence(lat: number, lon: number, fence: MeridianZone["geofence"]): boolean {
  if (!fence) return false;

  if (fence.type === "circle" && fence.lat != null && fence.lon != null && fence.radius) {
    const R = 6371000; // Earth radius in meters
    const dLat = (lat - fence.lat) * Math.PI / 180;
    const dLon = (lon - fence.lon) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(fence.lat * Math.PI / 180) * Math.cos(lat * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    const dist = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return dist <= fence.radius;
  }

  if (fence.type === "polygon" && fence.points && fence.points.length >= 3) {
    return pointInPolygon(lat, lon, fence.points);
  }

  return false;
}

function pointInPolygon(lat: number, lon: number, points: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [yi, xi] = points[i];
    const [yj, xj] = points[j];
    if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

function computeCoherence(sessions: any[]): number {
  if (sessions.length < 5) return 0.75;
  const fixRates = sessions.map((s: any) => s.fix_rate || 0);
  const mean = fixRates.reduce((a: number, b: number) => a + b, 0) / fixRates.length;
  const variance = fixRates.reduce((s: number, f: number) => s + (f - mean) ** 2, 0) / fixRates.length;
  return Math.max(0, 1 - Math.sqrt(variance) / 50);
}
