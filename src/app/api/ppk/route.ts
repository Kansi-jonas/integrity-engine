// ─── PPK Status API ──────────────────────────────────────────────────────────
// GET /api/ppk — PPK analysis status and results
// GET /api/ppk?action=analyze&station=STATIONNAME — trigger analysis for one station

import { NextRequest, NextResponse } from "next/server";
import { getDb, getDataDir } from "@/lib/db";
import fs from "fs";
import path from "path";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const action = req.nextUrl.searchParams.get("action");
  const station = req.nextUrl.searchParams.get("station");
  const dataDir = getDataDir();
  const db = getDb();

  // Status
  if (!action) {
    const ppkConfigured = !!process.env.GEODNET_PPK_USER && !!process.env.GEODNET_PPK_PASS;

    // Count stations with PPK analysis results
    let analyzed = 0;
    let withCycleSlips = 0;
    let withMultipath = 0;
    try {
      const ppkResultsPath = path.join(dataDir, "ppk-results.json");
      if (fs.existsSync(ppkResultsPath)) {
        const data = JSON.parse(fs.readFileSync(ppkResultsPath, "utf-8"));
        const results = data.results || [];
        analyzed = results.length;
        withCycleSlips = results.filter((r: any) => r.cycle_slip_rate > 0).length;
        withMultipath = results.filter((r: any) => r.multipath_l1 > 0).length;
      }
    } catch {}

    // Count GEODNET stations
    let totalGeonet = 0;
    try {
      totalGeonet = (db.prepare(`SELECT COUNT(*) as c FROM stations WHERE network = 'geodnet' OR (network IS NULL AND name GLOB '[A-Z0-9]*')`).get() as any)?.c || 0;
    } catch {}

    return NextResponse.json({
      configured: ppkConfigured,
      ppk_user_set: !!process.env.GEODNET_PPK_USER,
      total_geodnet_stations: totalGeonet,
      analyzed: analyzed,
      with_cycle_slips: withCycleSlips,
      with_multipath: withMultipath,
      unanalyzed: totalGeonet - analyzed,
      status: ppkConfigured ? "ready" : "not_configured",
      message: ppkConfigured
        ? `PPK API ready. ${analyzed} stations analyzed, ${totalGeonet - analyzed} remaining.`
        : "Set GEODNET_PPK_USER and GEODNET_PPK_PASS to enable PPK analysis.",
    });
  }

  // Analyze single station
  if (action === "analyze" && station) {
    if (!process.env.GEODNET_PPK_USER) {
      return NextResponse.json({ error: "GEODNET_PPK_USER not configured" }, { status: 400 });
    }

    try {
      const { downloadAndAnalyzeStation } = require("@/lib/agents/ppk-downloader");
      const result = await downloadAndAnalyzeStation(station, db, dataDir);
      return NextResponse.json(result);
    } catch (err) {
      return NextResponse.json({ error: String(err) }, { status: 500 });
    }
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
