// ─── Audit Trail API ─────────────────────────────────────────────────────────
// GET /api/audit?since=<iso_date>&type=<event_type>
// Returns timestamped log of all integrity decisions (exclusions, restores,
// fence actions, interference events) for compliance and SLA verification.

import { NextRequest, NextResponse } from "next/server";
import { getDataDir } from "@/lib/db";
import fs from "fs";
import path from "path";

export const dynamic = "force-dynamic";

interface AuditEntry {
  timestamp: string;
  type: "exclusion" | "restore" | "fence_action" | "interference" | "trust_update" | "config_generation";
  severity: "critical" | "warning" | "info";
  station: string | null;
  details: string;
  source: string; // Which agent generated this
}

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const since = url.searchParams.get("since") || new Date(Date.now() - 24 * 3600000).toISOString();
    const typeFilter = url.searchParams.get("type");
    const limit = Math.min(1000, parseInt(url.searchParams.get("limit") || "100"));
    const dataDir = getDataDir();

    const entries: AuditEntry[] = [];
    const sinceTs = new Date(since).getTime();

    // Collect from trust scores (exclusions/restores)
    try {
      const trustPath = path.join(dataDir, "trust-scores.json");
      if (fs.existsSync(trustPath)) {
        const td = JSON.parse(fs.readFileSync(trustPath, "utf-8"));
        for (const t of (td.scores || [])) {
          if (t.flag === "excluded" && t.excluded_since) {
            const ts = new Date(t.excluded_since).getTime();
            if (ts >= sinceTs) {
              entries.push({
                timestamp: t.excluded_since,
                type: "exclusion",
                severity: "warning",
                station: t.station,
                details: t.excluded_reason || `Composite score ${t.composite_score} below threshold`,
                source: "TRUST-V2",
              });
            }
          }
        }
      }
    } catch {}

    // Collect from fence actions
    try {
      const fencePath = path.join(dataDir, "fence-actions.json");
      if (fs.existsSync(fencePath)) {
        const fd = JSON.parse(fs.readFileSync(fencePath, "utf-8"));
        for (const a of (fd.actions || [])) {
          const ts = new Date(a.created_at).getTime();
          if (ts >= sinceTs) {
            entries.push({
              timestamp: a.created_at,
              type: "fence_action",
              severity: a.action === "exclude" ? "warning" : a.action === "downgrade" ? "info" : "info",
              station: a.station,
              details: `${a.action}: ${a.reason}`,
              source: "FENCE-GENERATOR",
            });
          }
        }
      }
    } catch {}

    // Collect from SHIELD events
    try {
      const shieldPath = path.join(dataDir, "shield-events.json");
      if (fs.existsSync(shieldPath)) {
        const sd = JSON.parse(fs.readFileSync(shieldPath, "utf-8"));
        for (const e of (sd.events || [])) {
          const ts = new Date(e.start_time).getTime();
          if (ts >= sinceTs) {
            entries.push({
              timestamp: e.start_time,
              type: "interference",
              severity: e.severity,
              station: e.affected_stations?.[0] || null,
              details: `${e.classification} (${Math.round(e.confidence * 100)}%): ${e.description}`,
              source: "SHIELD",
            });
          }
        }
      }
    } catch {}

    // Collect from config generation
    try {
      const configPath = path.join(dataDir, "qualified-stations.json");
      if (fs.existsSync(configPath)) {
        const cd = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        if (cd.generated_at && new Date(cd.generated_at).getTime() >= sinceTs) {
          entries.push({
            timestamp: cd.generated_at,
            type: "config_generation",
            severity: "info",
            station: null,
            details: `Config generated: ${cd.stats.qualified_count} qualified, ${cd.stats.disqualified_count} disqualified (${cd.stats.platinum} platinum, ${cd.stats.gold} gold, ${cd.stats.silver} silver)`,
            source: "CONFIG-GENERATOR",
          });
        }
      }
    } catch {}

    // Filter and sort
    let filtered = entries;
    if (typeFilter) {
      filtered = filtered.filter(e => e.type === typeFilter);
    }
    filtered.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    filtered = filtered.slice(0, limit);

    return NextResponse.json({
      entries: filtered,
      total: filtered.length,
      since,
      generated_at: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
