// ─── Audit Logger ────────────────────────────────────────────────────────────
// Append-only audit trail for compliance and forensics.
// Logs every zone change, config deployment, trust score change, fence action,
// and interference event with full context.
//
// Used for: ISO 17123-8 compliance, Enterprise SLA reporting, forensic analysis.

import Database from "better-sqlite3";

export interface AuditEntry {
  event_type: string;
  actor: string;          // Agent name or "user"
  entity_type: string;    // "zone", "station", "config", "fence", "interference"
  entity_id: string;
  action: string;         // "create", "update", "delete", "exclude", "restore", "deploy"
  before_state?: string;  // JSON
  after_state?: string;   // JSON
  metadata?: string;      // JSON — extra context
}

/**
 * Initialize audit log table.
 */
export function initAuditTable(db: Database.Database) {
  db.exec(`
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
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_type ON audit_log(event_type)`);
}

/**
 * Log an audit entry. Fire-and-forget — never throws.
 */
export function logAudit(db: Database.Database, entry: AuditEntry) {
  try {
    db.prepare(`
      INSERT INTO audit_log (event_type, actor, entity_type, entity_id, action, before_state, after_state, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.event_type,
      entry.actor,
      entry.entity_type,
      entry.entity_id,
      entry.action,
      entry.before_state || null,
      entry.after_state || null,
      entry.metadata || null,
    );
  } catch {
    // Audit logging must never crash the system
  }
}

/**
 * Query audit log with filters.
 */
export function queryAudit(
  db: Database.Database,
  opts: {
    event_type?: string;
    entity_type?: string;
    entity_id?: string;
    actor?: string;
    since?: string;  // ISO date
    limit?: number;
  }
): any[] {
  const conditions: string[] = [];
  const params: any[] = [];

  if (opts.event_type) { conditions.push("event_type = ?"); params.push(opts.event_type); }
  if (opts.entity_type) { conditions.push("entity_type = ?"); params.push(opts.entity_type); }
  if (opts.entity_id) { conditions.push("entity_id = ?"); params.push(opts.entity_id); }
  if (opts.actor) { conditions.push("actor = ?"); params.push(opts.actor); }
  if (opts.since) { conditions.push("timestamp >= ?"); params.push(opts.since); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = opts.limit || 100;

  try {
    return db.prepare(`SELECT * FROM audit_log ${where} ORDER BY timestamp DESC LIMIT ?`).all(...params, limit) as any[];
  } catch {
    return [];
  }
}

/**
 * Export audit log as array (for CSV/JSON download).
 */
export function exportAudit(
  db: Database.Database,
  since: string,
  until?: string
): any[] {
  try {
    if (until) {
      return db.prepare(`SELECT * FROM audit_log WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp`).all(since, until) as any[];
    }
    return db.prepare(`SELECT * FROM audit_log WHERE timestamp >= ? ORDER BY timestamp`).all(since) as any[];
  } catch {
    return [];
  }
}
