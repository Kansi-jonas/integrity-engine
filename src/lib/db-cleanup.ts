// ─── Database Cleanup ────────────────────────────────────────────────────────
// Prevents disk from filling up by enforcing retention policies:
// - station_status_log: keep 14 days (15min snapshots = ~135K rows/day)
// - rtk_sessions: keep 6 months
// - sync_log: keep 30 days
// - audit_log: keep 90 days (compliance minimum)
//
// Runs daily at 04:00 (after ML retrain at 03:00)
// Also runs VACUUM to reclaim space after large deletes.

import Database from "better-sqlite3";

export interface CleanupResult {
  status_log_deleted: number;
  sessions_deleted: number;
  sync_log_deleted: number;
  audit_log_deleted: number;
  vacuum_done: boolean;
  space_before_mb: number;
  space_after_mb: number;
  space_freed_mb: number;
  duration_ms: number;
}

const RETENTION = {
  status_log_days: 14,
  sessions_days: 180,     // 6 months
  sync_log_days: 30,
  audit_log_days: 90,
};

export function runCleanup(db: Database.Database): CleanupResult {
  const start = Date.now();
  const now = Date.now();

  // Get DB size before
  let sizeBefore = 0;
  try {
    const row = db.prepare(`SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()`).get() as any;
    sizeBefore = row?.size || 0;
  } catch {}

  let statusDeleted = 0;
  let sessionsDeleted = 0;
  let syncDeleted = 0;
  let auditDeleted = 0;

  // 1. Station Status Log (14 days)
  try {
    const cutoff = now - RETENTION.status_log_days * 86400000;
    const result = db.prepare(`DELETE FROM station_status_log WHERE recorded_at < ?`).run(cutoff);
    statusDeleted = result.changes;
    if (statusDeleted > 0) {
      console.log(`[CLEANUP] station_status_log: ${statusDeleted.toLocaleString()} rows deleted (>${RETENTION.status_log_days}d)`);
    }
  } catch {}

  // 2. RTK Sessions (6 months)
  try {
    const cutoff = now - RETENTION.sessions_days * 86400000;
    const result = db.prepare(`DELETE FROM rtk_sessions WHERE login_time < ?`).run(cutoff);
    sessionsDeleted = result.changes;
    if (sessionsDeleted > 0) {
      console.log(`[CLEANUP] rtk_sessions: ${sessionsDeleted.toLocaleString()} rows deleted (>${RETENTION.sessions_days}d)`);
    }
  } catch {}

  // 3. Sync Log (30 days)
  try {
    const cutoff = now - RETENTION.sync_log_days * 86400000;
    const result = db.prepare(`DELETE FROM sync_log WHERE completed_at < ?`).run(cutoff);
    syncDeleted = result.changes;
  } catch {}

  // 4. Audit Log (90 days)
  try {
    const cutoff = new Date(now - RETENTION.audit_log_days * 86400000).toISOString();
    const result = db.prepare(`DELETE FROM audit_log WHERE timestamp < ?`).run(cutoff);
    auditDeleted = result.changes;
  } catch {}

  // 5. VACUUM to reclaim space (only if significant deletes)
  let vacuumDone = false;
  if (statusDeleted + sessionsDeleted > 10000) {
    try {
      db.exec("VACUUM");
      vacuumDone = true;
      console.log("[CLEANUP] VACUUM completed");
    } catch (err) {
      console.error("[CLEANUP] VACUUM failed:", err);
    }
  }

  // Get DB size after
  let sizeAfter = 0;
  try {
    const row = db.prepare(`SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()`).get() as any;
    sizeAfter = row?.size || 0;
  } catch {}

  const result: CleanupResult = {
    status_log_deleted: statusDeleted,
    sessions_deleted: sessionsDeleted,
    sync_log_deleted: syncDeleted,
    audit_log_deleted: auditDeleted,
    vacuum_done: vacuumDone,
    space_before_mb: Math.round(sizeBefore / 1024 / 1024 * 10) / 10,
    space_after_mb: Math.round(sizeAfter / 1024 / 1024 * 10) / 10,
    space_freed_mb: Math.round((sizeBefore - sizeAfter) / 1024 / 1024 * 10) / 10,
    duration_ms: Date.now() - start,
  };

  console.log(`[CLEANUP] Done in ${result.duration_ms}ms — freed ${result.space_freed_mb}MB (${result.space_before_mb}MB → ${result.space_after_mb}MB)`);

  return result;
}
