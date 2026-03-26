// ─── Audit Export API ────────────────────────────────────────────────────────
// GET /api/audit/export?since=2026-03-01&format=json
// GET /api/audit/export?since=2026-03-01&format=csv
//
// Exports audit log for compliance reporting.

import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { exportAudit } from "@/lib/audit/audit-logger";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const since = searchParams.get("since") || new Date(Date.now() - 30 * 86400000).toISOString();
  const until = searchParams.get("until") || undefined;
  const format = searchParams.get("format") || "json";

  try {
    const db = getDb();
    const entries = exportAudit(db, since, until);

    if (format === "csv") {
      const header = "id,timestamp,event_type,actor,entity_type,entity_id,action,metadata\n";
      const rows = entries.map(e =>
        `${e.id},"${e.timestamp}","${e.event_type}","${e.actor}","${e.entity_type}","${e.entity_id}","${e.action}","${(e.metadata || "").replace(/"/g, '""')}"`
      ).join("\n");

      return new Response(header + rows, {
        headers: {
          "Content-Type": "text/csv",
          "Content-Disposition": `attachment; filename="audit-log-${since.slice(0, 10)}.csv"`,
        },
      });
    }

    return NextResponse.json({ entries, count: entries.length, since, until: until || "now" });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
