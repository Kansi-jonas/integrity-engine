// ─── GEODNET Data Sync ───────────────────────────────────────────────────────
// Fetches RTK sessions and station data from GEODNET API.
// Lightweight sync — only what the integrity agents need.

import Database from "better-sqlite3";
import crypto from "crypto";

const APP_ID = process.env.GEODNET_APP_ID || "kansi";
const APP_KEY = process.env.GEODNET_APP_KEY || "";
const BASE_URL = "https://api.geodnet.com";

async function fetchGeoApi(endpoint: string, params: Record<string, string> = {}): Promise<any> {
  const url = new URL(`${BASE_URL}${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("appId", APP_ID);
  url.searchParams.set("appKey", APP_KEY);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(url.toString(), { signal: controller.signal });
    if (!res.ok) throw new Error(`GEODNET API ${res.status}: ${endpoint}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function syncSessions(db: Database.Database): Promise<number> {
  const now = Date.now();
  const sixHoursAgo = now - 6 * 3600000;

  try {
    const data = await fetchGeoApi("/rtkLog/queryList", {
      startTime: String(sixHoursAgo),
      endTime: String(now),
      pageNo: "1",
      pageSize: "500",
    });

    const logs = data?.data?.data || data?.data || [];
    if (!Array.isArray(logs) || logs.length === 0) return 0;

    const stmt = db.prepare(`
      INSERT OR IGNORE INTO rtk_sessions
      (id, username, mountpoint, station, status, fix_rate, total_gga, rtk_fixed, rtk_float,
       duration, avg_age, max_age, latitude, longitude, ip, login_time, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let count = 0;
    const tx = db.transaction(() => {
      for (const log of logs) {
        const id = log.id || crypto.randomUUID();
        const loginTime = log.loginTime || log.login_time || now;
        stmt.run(
          id, log.username || "", log.mountpoint || "", log.station || "",
          log.status ?? 0, log.fixRate ?? log.fix_rate ?? 0,
          log.totalGGA ?? log.total_gga ?? 0,
          log.rtkFixed ?? log.rtk_fixed ?? 0,
          log.rtkFloat ?? log.rtk_float ?? 0,
          log.duration ?? 0, log.avgAge ?? log.avg_age ?? 0,
          log.maxAge ?? log.max_age ?? 0,
          log.latitude ?? 0, log.longitude ?? 0,
          log.ip || "", loginTime, now
        );
        count++;
      }
    });
    tx();

    return count;
  } catch (err) {
    console.error("[GEODNET-SYNC] Sessions failed:", err);
    return 0;
  }
}

export async function syncStations(db: Database.Database): Promise<number> {
  try {
    const data = await fetchGeoApi("/station/queryList", {
      pageNo: "1",
      pageSize: "5000",
    });

    const stations = data?.data?.data || data?.data || [];
    if (!Array.isArray(stations) || stations.length === 0) return 0;

    const stmt = db.prepare(`
      INSERT OR REPLACE INTO stations (name, latitude, longitude, height, status, last_synced)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const now = Date.now();
    let count = 0;
    const tx = db.transaction(() => {
      for (const s of stations) {
        const name = s.name || s.stationName || "";
        if (!name) continue;
        stmt.run(
          name, s.latitude ?? 0, s.longitude ?? 0, s.height ?? 0,
          s.status || "UNKNOWN", now
        );
        count++;
      }
    });
    tx();

    return count;
  } catch (err) {
    console.error("[GEODNET-SYNC] Stations failed:", err);
    return 0;
  }
}

export function snapshotStationStatus(db: Database.Database): void {
  const now = Date.now();
  try {
    const stations = db.prepare(`SELECT name, status FROM stations WHERE status IS NOT NULL`).all() as any[];
    const stmt = db.prepare(`INSERT OR IGNORE INTO station_status_log (station_name, status, recorded_at) VALUES (?, ?, ?)`);
    const tx = db.transaction(() => {
      for (const s of stations) stmt.run(s.name, s.status, now);
    });
    tx();
    // Prune old logs (keep 14 days)
    db.prepare(`DELETE FROM station_status_log WHERE recorded_at < ?`).run(now - 14 * 86400000);
  } catch (err) {
    console.error("[GEODNET-SYNC] Status snapshot failed:", err);
  }
}
