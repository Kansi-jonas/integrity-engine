import Database from "better-sqlite3";
import path from "path";

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), "data", "integrity.db");

export function getDataDir(): string {
  return path.dirname(DB_PATH);
}

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma("journal_mode = WAL");
    _db.pragma("synchronous = NORMAL");
    initSchema(_db);
  }
  return _db;
}

function initSchema(db: Database.Database) {
  db.exec(`
    -- RTK Sessions (synced from GEODNET)
    CREATE TABLE IF NOT EXISTS rtk_sessions (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      mountpoint TEXT,
      station TEXT,
      status INTEGER,
      fix_rate REAL DEFAULT 0,
      total_gga INTEGER DEFAULT 0,
      rtk_fixed INTEGER DEFAULT 0,
      rtk_float INTEGER DEFAULT 0,
      duration INTEGER DEFAULT 0,
      avg_age REAL DEFAULT 0,
      max_age REAL DEFAULT 0,
      latitude REAL DEFAULT 0,
      longitude REAL DEFAULT 0,
      ip TEXT,
      login_time INTEGER NOT NULL,
      synced_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_station ON rtk_sessions(station);
    CREATE INDEX IF NOT EXISTS idx_sessions_login_time ON rtk_sessions(login_time);
    CREATE INDEX IF NOT EXISTS idx_sessions_username ON rtk_sessions(username);

    -- Stations snapshot
    CREATE TABLE IF NOT EXISTS stations (
      name TEXT PRIMARY KEY,
      latitude REAL,
      longitude REAL,
      height REAL,
      status TEXT DEFAULT 'UNKNOWN',
      network TEXT DEFAULT 'unknown',
      last_synced INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    );

    -- Station status log (15-min snapshots for uptime tracking)
    CREATE TABLE IF NOT EXISTS station_status_log (
      station_name TEXT NOT NULL,
      status TEXT NOT NULL,
      recorded_at INTEGER NOT NULL,
      PRIMARY KEY (station_name, recorded_at)
    );

    -- Station quality scores (computed every 4h)
    CREATE TABLE IF NOT EXISTS station_scores (
      station_name TEXT PRIMARY KEY,
      network TEXT,
      uq_score REAL,
      reliability_score REAL,
      session_count INTEGER,
      unique_users INTEGER,
      avg_fix_rate REAL,
      p10_fix_rate REAL,
      median_correction_age REAL,
      p90_correction_age REAL,
      avg_baseline_km REAL,
      max_baseline_km REAL,
      zero_fix_ratio REAL,
      total_duration_hours REAL,
      uptime_7d REAL,
      computed_at INTEGER
    );

    -- Sync log
    CREATE TABLE IF NOT EXISTS sync_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      type TEXT NOT NULL,
      records_synced INTEGER DEFAULT 0,
      started_at INTEGER,
      completed_at INTEGER
    );

    -- Audit log (append-only, compliance)
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      event_type TEXT NOT NULL,
      actor TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      action TEXT NOT NULL,
      before_state TEXT,
      after_state TEXT,
      metadata TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);
    CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id);

    -- Interference events (persistent, for historical queries)
    CREATE TABLE IF NOT EXISTS interference_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      classification TEXT NOT NULL,
      severity TEXT NOT NULL,
      confidence REAL,
      lat REAL,
      lon REAL,
      radius_km REAL,
      affected_users INTEGER,
      affected_stations TEXT,
      features TEXT,
      description TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_interference_time ON interference_events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_interference_class ON interference_events(classification);
  `);
}
