// ─── GEODNET Data Sync ───────────────────────────────────────────────────────
// Fetches RTK sessions and station data from GEODNET API v3.
// Uses MD5-signed POST requests (same auth as rtkbi).

import Database from "better-sqlite3";
import crypto from "crypto";

const APP_ID = process.env.GEODNET_APP_ID || "kansi";
const APP_KEY = process.env.GEODNET_APP_KEY || "";

// ─── GEODNET API Auth ────────────────────────────────────────────────────────

function computeSign(params: Record<string, string | number>): string {
  const sortedKeys = Object.keys(params).sort();
  const valueStr = sortedKeys.map((k) => String(params[k])).join("");
  return crypto.createHash("md5").update(valueStr + APP_KEY).digest("hex");
}

async function gfetch(endpoint: string, extra: Record<string, string | number> = {}): Promise<any> {
  const now = Date.now();
  const params: Record<string, string | number> = { appId: APP_ID, time: now, ...extra };
  const sign = computeSign(params);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(`https://rtk.geodnet.com/api/v3/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...params, sign }),
      signal: controller.signal,
    });
    const data = await res.json();
    if (data.code !== 1000) throw new Error(`GEODNET API code ${data.code}: ${endpoint}`);
    return data.data;
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Session Sync ────────────────────────────────────────────────────────────

export async function syncSessions(db: Database.Database): Promise<number> {
  const now = Date.now();
  const sixHoursAgo = now - 6 * 3600000;

  // Ensure table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS rtk_sessions (
      id TEXT PRIMARY KEY, username TEXT NOT NULL, mountpoint TEXT, station TEXT,
      status INTEGER, fix_rate REAL DEFAULT 0, total_gga INTEGER DEFAULT 0,
      rtk_fixed INTEGER DEFAULT 0, rtk_float INTEGER DEFAULT 0, duration INTEGER DEFAULT 0,
      avg_age REAL DEFAULT 0, max_age REAL DEFAULT 0, latitude REAL DEFAULT 0,
      longitude REAL DEFAULT 0, ip TEXT, login_time INTEGER NOT NULL,
      synced_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_station ON rtk_sessions(station);
    CREATE INDEX IF NOT EXISTS idx_sessions_login_time ON rtk_sessions(login_time);
    CREATE INDEX IF NOT EXISTS idx_sessions_username ON rtk_sessions(username);
  `);

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO rtk_sessions
    (id, username, mountpoint, station, status, fix_rate, total_gga, rtk_fixed, rtk_float,
     duration, avg_age, max_age, latitude, longitude, ip, login_time, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let totalNew = 0;
  let page = 1;
  const pageSize = 100;

  while (true) {
    try {
      const data = await gfetch("user/rtkLogs", {
        startTime: sixHoursAgo,
        endTime: now,
        page,
        pageSize,
      });
      if (!data?.list?.length) break;

      const tx = db.transaction(() => {
        for (const s of data.list) {
          stmt.run(
            s.id, s.username, s.mountpoint, s.station, s.status,
            s.fixRate || 0, s.totalGGA || 0, s.rtkFixed || 0, s.rtkFloat || 0,
            s.duration || 0, s.avgAge || 0, s.maxAge || 0,
            s.latitude || 0, s.longitude || 0, s.ip || "",
            s.loginTime || 0, now
          );
        }
      });
      tx();

      totalNew += data.list.length;
      if (data.list.length < pageSize) break;
      page++;
      if (page > 50) break; // Safety cap
    } catch (err) {
      console.error("[GEODNET-SYNC] Session page failed:", err);
      break;
    }
  }

  return totalNew;
}

// ─── Station Sync ────────────────────────────────────────────────────────────

export async function syncStations(db: Database.Database): Promise<number> {
  // Ensure table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS stations (
      name TEXT PRIMARY KEY, latitude REAL, longitude REAL, height REAL,
      status TEXT DEFAULT 'UNKNOWN', network TEXT DEFAULT 'unknown',
      last_synced INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    );
  `);

  try {
    const data = await gfetch("station/list", {});
    // GEODNET API returns stations as data.list or directly as array
    const stations = data?.list || (Array.isArray(data) ? data : []);
    console.log(`[GEODNET-SYNC] Station response: ${typeof data}, keys: ${data ? Object.keys(data).join(",") : "null"}, count: ${stations.length}`);
    if (!stations.length) return 0;

    const now = Date.now();
    const stmt = db.prepare(`
      INSERT INTO stations (name, latitude, longitude, height, status, last_synced)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        latitude = excluded.latitude, longitude = excluded.longitude,
        height = excluded.height, status = excluded.status,
        last_synced = excluded.last_synced
    `);

    const tx = db.transaction(() => {
      for (const s of stations) {
        stmt.run(s.name, s.latitude, s.longitude, s.height || 0, s.status || "UNKNOWN", now);
      }
    });
    tx();

    return stations.length;
  } catch (err) {
    console.error("[GEODNET-SYNC] Stations failed:", err);
    return 0;
  }
}

// ─── ONOCOY Sourcetable Sync ─────────────────────────────────────────────────
// Fetches station list from ONOCOY NTRIP Sourcetable (no credentials needed).
// Sourcetable format: STR;mountpoint;...;lat;lon;...

export async function syncOnocoyStations(db: Database.Database): Promise<number> {
  // Ensure table has receiver/antenna columns
  db.exec(`
    CREATE TABLE IF NOT EXISTS stations (
      name TEXT PRIMARY KEY, latitude REAL, longitude REAL, height REAL,
      status TEXT DEFAULT 'UNKNOWN', network TEXT DEFAULT 'unknown',
      receiver_type TEXT, antenna_type TEXT, country TEXT, nav_system TEXT,
      last_synced INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    );
  `);
  // Add columns if they don't exist (safe for existing tables)
  try { db.exec(`ALTER TABLE stations ADD COLUMN receiver_type TEXT`); } catch {}
  try { db.exec(`ALTER TABLE stations ADD COLUMN antenna_type TEXT`); } catch {}
  try { db.exec(`ALTER TABLE stations ADD COLUMN country TEXT`); } catch {}
  try { db.exec(`ALTER TABLE stations ADD COLUMN nav_system TEXT`); } catch {}

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const onoUser = process.env.ONOCOY_USER || "";
    const onoPass = process.env.ONOCOY_PASS || "";
    const authHeader = onoUser ? "Basic " + Buffer.from(`${onoUser}:${onoPass}`).toString("base64") : "";

    const res = await fetch("http://clients.onocoy.com:2101/", {
      headers: {
        "User-Agent": "NTRIP RTKdata/1.0",
        "Ntrip-Version": "Ntrip/2.0",
        ...(authHeader ? { "Authorization": authHeader } : {}),
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    const text = await res.text();
    const lines = text.split("\n");

    const now = Date.now();
    const stmt = db.prepare(`
      INSERT INTO stations (name, latitude, longitude, height, status, network, receiver_type, antenna_type, country, nav_system, last_synced)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        latitude = excluded.latitude, longitude = excluded.longitude,
        height = excluded.height, status = excluded.status,
        network = excluded.network, receiver_type = excluded.receiver_type,
        antenna_type = excluded.antenna_type, country = excluded.country,
        nav_system = excluded.nav_system, last_synced = excluded.last_synced
    `);

    let count = 0;
    const tx = db.transaction(() => {
      for (const line of lines) {
        if (!line.startsWith("STR;")) continue;
        // NTRIP Sourcetable STR format (19 fields):
        // STR;mountpoint;identifier;format;formatDetails;carrier;navSystem;network;country;lat;lon;
        //     nmea;solution;generator;comprEncryp;authentication;fee;bitrate;misc
        const parts = line.split(";");
        if (parts.length < 11) continue;

        const name = parts[1];
        const lat = parseFloat(parts[9]);
        const lon = parseFloat(parts[10]);
        const navSystem = parts[6] || "";     // GPS+GLO+GAL+BDS etc
        const country = parts[8] || "";
        // Generator field often contains receiver info: "Leica GR25" or "Trimble NetR9"
        const generator = parts[13] || "";
        // For ONOCOY, the identifier often has receiver info too
        const identifier = parts[2] || "";

        if (!name || isNaN(lat) || isNaN(lon) || (lat === 0 && lon === 0)) continue;

        // Extract receiver and antenna from generator/identifier
        const receiverType = generator || identifier || "";
        const antennaType = ""; // Not reliably in sourcetable

        stmt.run(name, lat, lon, 0, "ONLINE", "onocoy", receiverType, antennaType, country, navSystem, now);
        count++;
      }
    });
    tx();

    console.log(`[ONOCOY-SYNC] ${count} stations from sourcetable`);
    return count;
  } catch (err) {
    console.error("[ONOCOY-SYNC] Sourcetable fetch failed:", err);
    return 0;
  }
}

// ─── Station Status Snapshot ─────────────────────────────────────────────────

export function snapshotStationStatus(db: Database.Database): void {
  const now = Date.now();
  try {
    // Ensure table exists
    db.exec(`
      CREATE TABLE IF NOT EXISTS station_status_log (
        station_name TEXT NOT NULL, status TEXT NOT NULL, recorded_at INTEGER NOT NULL,
        PRIMARY KEY (station_name, recorded_at)
      );
    `);

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
