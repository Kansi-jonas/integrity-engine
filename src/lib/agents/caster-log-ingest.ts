// ─── Alberding Caster Log Ingestion ──────────────────────────────────────────
// Parses Alberding access logs and feeds data back into the Integrity Engine.
//
// Alberding log format (access-yymmdd.log, CSV):
//   timestamp,client_ip,username,mountpoint,duration_s,bytes,user_agent,backend_source
//
// At loglevel 2+:
//   - Which backend pinput actually served the client
//   - Failover/switchover events
//   - GGA positions (if passNmea enabled)
//   - Routing/geofence decisions
//
// Architecture:
//   SSH tail -f on each caster → parse lines → update station scores
//   Or: periodic log download → batch parse → update

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CasterSession {
  timestamp: string;
  client_ip: string;
  username: string;
  mountpoint: string;
  duration_s: number;
  bytes_transferred: number;
  user_agent: string;
  backend_source: string | null;   // Which pinput/station served this client
  gga_lat: number | null;
  gga_lon: number | null;
  failover_count: number;
  disconnect_reason: string | null;
}

export interface LogIngestResult {
  sessions_parsed: number;
  failover_events: number;
  unique_users: number;
  unique_stations: number;
  stations_used: Record<string, number>; // station → session count
  computed_at: string;
}

// ─── Access Log Parser ──────────────────────────────────────────────────────

/**
 * Parse Alberding access log lines.
 * Format varies by loglevel — we handle common patterns.
 */
export function parseAccessLog(logContent: string): CasterSession[] {
  const sessions: CasterSession[] = [];
  const lines = logContent.split("\n");

  for (const line of lines) {
    if (!line.trim() || line.startsWith("#")) continue;

    try {
      // Try CSV format first (most common for access logs)
      const parts = line.split(",");
      if (parts.length >= 6) {
        sessions.push({
          timestamp: parts[0]?.trim() || "",
          client_ip: parts[1]?.trim() || "",
          username: parts[2]?.trim() || "",
          mountpoint: parts[3]?.trim() || "",
          duration_s: parseFloat(parts[4]?.trim() || "0") || 0,
          bytes_transferred: parseInt(parts[5]?.trim() || "0") || 0,
          user_agent: parts[6]?.trim() || "",
          backend_source: parts[7]?.trim() || null,
          gga_lat: parts[8] ? parseFloat(parts[8]) || null : null,
          gga_lon: parts[9] ? parseFloat(parts[9]) || null : null,
          failover_count: parseInt(parts[10]?.trim() || "0") || 0,
          disconnect_reason: parts[11]?.trim() || null,
        });
        continue;
      }

      // Try space-separated format (ntripcaster log)
      const match = line.match(
        /(\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}:\d{2})\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(\d+)/
      );
      if (match) {
        sessions.push({
          timestamp: match[1],
          client_ip: match[2],
          username: match[3],
          mountpoint: match[4],
          duration_s: parseInt(match[5]) || 0,
          bytes_transferred: parseInt(match[6]) || 0,
          user_agent: "",
          backend_source: null,
          gga_lat: null,
          gga_lon: null,
          failover_count: 0,
          disconnect_reason: null,
        });
      }
    } catch {}
  }

  return sessions;
}

/**
 * Parse failover events from operational log (ntripcaster-yymmdd.log).
 */
export function parseFailoverEvents(logContent: string): Array<{
  timestamp: string;
  mountpoint: string;
  from_source: string;
  to_source: string;
  reason: string;
}> {
  const events: Array<{ timestamp: string; mountpoint: string; from_source: string; to_source: string; reason: string }> = [];
  const lines = logContent.split("\n");

  for (const line of lines) {
    // Look for switchover/failover patterns
    // Common patterns: "switchover", "failover", "source lost", "trying next"
    const switchMatch = line.match(
      /(\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}:\d{2}).*(?:switchover|failover|trying next).*?(\S+)\s*(?:->|to)\s*(\S+)/i
    );
    if (switchMatch) {
      events.push({
        timestamp: switchMatch[1],
        mountpoint: "",
        from_source: switchMatch[2],
        to_source: switchMatch[3],
        reason: line.includes("lost") ? "source_lost" : line.includes("timeout") ? "timeout" : "switchover",
      });
    }

    // Source disconnect
    const disconnectMatch = line.match(
      /(\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}:\d{2}).*source\s+(\S+).*(?:disconnect|lost|timeout)/i
    );
    if (disconnectMatch) {
      events.push({
        timestamp: disconnectMatch[1],
        mountpoint: "",
        from_source: disconnectMatch[2],
        to_source: "",
        reason: "source_disconnect",
      });
    }
  }

  return events;
}

/**
 * Ingest parsed caster sessions into the Integrity Engine.
 * Updates station usage counts and quality metrics.
 */
export function ingestCasterSessions(
  sessions: CasterSession[],
  db: Database.Database,
  dataDir: string
): LogIngestResult {
  const stationCounts: Record<string, number> = {};
  const users = new Set<string>();
  const stations = new Set<string>();
  let failoverTotal = 0;

  for (const s of sessions) {
    users.add(s.username);
    failoverTotal += s.failover_count;

    if (s.backend_source) {
      stations.add(s.backend_source);
      stationCounts[s.backend_source] = (stationCounts[s.backend_source] || 0) + 1;
    }
  }

  // Update ONOCOY validation if any ONOCOY sessions detected
  try {
    const { updateOnocoyValidation } = require("./onocoy-gapfill");
    for (const [station, count] of Object.entries(stationCounts)) {
      // Check if this is an ONOCOY station
      const stationRow = db.prepare(`SELECT network FROM stations WHERE name = ?`).get(station) as any;
      if (stationRow?.network === "onocoy") {
        // Estimate fix rate from session duration (longer = better fix)
        const stationSessions = sessions.filter(s => s.backend_source === station);
        const avgDuration = stationSessions.reduce((s, ss) => s + ss.duration_s, 0) / stationSessions.length;
        const estimatedFixRate = Math.min(100, avgDuration > 300 ? 80 : avgDuration > 60 ? 60 : 30);
        updateOnocoyValidation(station, estimatedFixRate, count, dataDir);
      }
    }
  } catch {}

  const result: LogIngestResult = {
    sessions_parsed: sessions.length,
    failover_events: failoverTotal,
    unique_users: users.size,
    unique_stations: stations.size,
    stations_used: stationCounts,
    computed_at: new Date().toISOString(),
  };

  // Persist
  try {
    const filePath = path.join(dataDir, "caster-ingest.json");
    const tmp = filePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(result, null, 2));
    fs.renameSync(tmp, filePath);
  } catch {}

  return result;
}
