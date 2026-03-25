// ─── rtkbi Historical Session Sync ───────────────────────────────────────────
// Pulls historical session data from rtkbi (last 6 months).
// Runs once on startup (initial backfill) then incrementally every 2 hours.

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

const RTKBI_URL = process.env.RTKBI_URL || "";
const RTKBI_API_KEY = process.env.RTKBI_API_KEY || "";

interface SyncState {
  last_synced_timestamp: number; // ms epoch — fetch sessions newer than this
  total_imported: number;
  last_run: string;
}

async function fetchWithAuth(url: string, timeout = 30000): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      headers: {
        "X-API-Key": RTKBI_API_KEY,
      },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function syncFromRtkbi(db: Database.Database, dataDir: string): Promise<number> {
  if (!RTKBI_URL) {
    console.log("[RTKBI-SYNC] RTKBI_URL not set, skipping");
    return 0;
  }

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

  // Load sync state
  const statePath = path.join(dataDir, "rtkbi-sync-state.json");
  let state: SyncState = {
    last_synced_timestamp: Date.now() - 180 * 86400000, // Default: 6 months ago
    total_imported: 0,
    last_run: "",
  };
  try {
    if (fs.existsSync(statePath)) {
      state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    }
  } catch {}

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO rtk_sessions
    (id, username, mountpoint, station, status, fix_rate, total_gga, rtk_fixed, rtk_float,
     duration, avg_age, max_age, latitude, longitude, ip, login_time, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let totalImported = 0;
  let offset = 0;
  const pageSize = 10000;
  const now = Date.now();

  console.log(`[RTKBI-SYNC] Starting from ${new Date(state.last_synced_timestamp).toISOString()}`);

  while (true) {
    try {
      const url = `${RTKBI_URL}/api/export/sessions?since=${state.last_synced_timestamp}&limit=${pageSize}&offset=${offset}`;
      const data = await fetchWithAuth(url);

      if (!data?.sessions?.length) break;

      const tx = db.transaction(() => {
        for (const s of data.sessions) {
          stmt.run(
            s.id, s.username, s.mountpoint || "", s.station || "", s.status ?? 0,
            s.fix_rate ?? 0, s.total_gga ?? 0, s.rtk_fixed ?? 0, s.rtk_float ?? 0,
            s.duration ?? 0, s.avg_age ?? 0, s.max_age ?? 0,
            s.latitude ?? 0, s.longitude ?? 0, s.ip || "",
            s.login_time || 0, now
          );
        }
      });
      tx();

      totalImported += data.sessions.length;
      offset = data.next_offset;

      // Update high-water mark
      const maxLoginTime = Math.max(...data.sessions.map((s: any) => s.login_time || 0));
      if (maxLoginTime > state.last_synced_timestamp) {
        state.last_synced_timestamp = maxLoginTime;
      }

      console.log(`[RTKBI-SYNC] Page ${Math.floor(offset / pageSize)}: ${data.sessions.length} sessions (total: ${totalImported}, remaining: ${data.total - offset})`);

      if (!data.has_more) break;

      // Safety: max 100 pages per sync run (1M sessions)
      if (offset >= pageSize * 100) {
        console.log("[RTKBI-SYNC] Reached page limit, will continue next cycle");
        break;
      }
    } catch (err) {
      console.error("[RTKBI-SYNC] Page failed:", err);
      break;
    }
  }

  // Save state
  state.total_imported += totalImported;
  state.last_run = new Date().toISOString();
  try {
    const tmp = statePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, statePath);
  } catch {}

  return totalImported;
}
