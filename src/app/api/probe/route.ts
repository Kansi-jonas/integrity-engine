// ─── RTCM Probe API ──────────────────────────────────────────────────────────
// GET /api/probe/status — show probe progress
// GET /api/probe?action=start — start probing all unprobed ONOCOY stations
// GET /api/probe?action=stop — stop probing
// GET /api/probe?station=STATIONNAME — probe single station

import { NextRequest, NextResponse } from "next/server";
import { getDb, getDataDir } from "@/lib/db";
import fs from "fs";
import path from "path";

export const dynamic = "force-dynamic";

let probing = false;
let probeProgress = { total: 0, done: 0, found_survey: 0, running: false, started_at: "" };

export async function GET(req: NextRequest) {
  const action = req.nextUrl.searchParams.get("action") || "status";
  const station = req.nextUrl.searchParams.get("station");
  const db = getDb();
  const dataDir = getDataDir();

  if (action === "status") {
    // Count probed vs unprobed
    let stats = { total_onocoy: 0, probed: 0, unprobed: 0, survey_grade: 0, professional: 0, consumer: 0, unknown: 0 };
    try {
      const total = db.prepare(`SELECT COUNT(*) as cnt FROM stations WHERE network = 'onocoy'`).get() as any;
      const probed = db.prepare(`SELECT COUNT(*) as cnt FROM stations WHERE network = 'onocoy' AND receiver_type IS NOT NULL AND receiver_type != '' AND receiver_type NOT LIKE '%INFERRED%'`).get() as any;
      const survey = db.prepare(`SELECT COUNT(*) as cnt FROM stations WHERE network = 'onocoy' AND (receiver_type LIKE '%LEICA%' OR receiver_type LIKE '%TRIMBLE%' OR receiver_type LIKE '%SEPT%' OR receiver_type LIKE '%NOVATEL%' OR receiver_type LIKE '%CHC%' OR receiver_type LIKE '%SURVEY_GRADE_PROBED%')`).get() as any;
      stats = {
        total_onocoy: total?.cnt || 0,
        probed: probed?.cnt || 0,
        unprobed: (total?.cnt || 0) - (probed?.cnt || 0),
        survey_grade: survey?.cnt || 0,
        professional: 0,
        consumer: 0,
        unknown: (total?.cnt || 0) - (probed?.cnt || 0),
      };
    } catch {}

    return NextResponse.json({ ...stats, progress: probeProgress });
  }

  if (station) {
    // Probe single station
    try {
      const { probeOnocoyStation, saveProbeResult } = require("@/lib/agents/rtcm-probe");
      console.log(`[PROBE] Probing single station: ${station}`);
      const result = await probeOnocoyStation(station);
      if (result.success) {
        saveProbeResult(db, result);
        console.log(`[PROBE] ${station}: receiver=${result.receiver_descriptor || "unknown"}, messages=${result.message_types.length}, constellations=${result.constellations.join("+")}`);
      }
      return NextResponse.json(result);
    } catch (err) {
      return NextResponse.json({ error: String(err) }, { status: 500 });
    }
  }

  if (action === "start") {
    if (probing) {
      return NextResponse.json({ message: "Already probing", progress: probeProgress });
    }

    // Start background probing
    probing = true;
    probeProgress = { total: 0, done: 0, found_survey: 0, running: true, started_at: new Date().toISOString() };

    // Run in background (don't await)
    runDiscoveryScan(db, dataDir).catch(err => {
      console.error("[PROBE] Discovery scan failed:", err);
    }).finally(() => {
      probing = false;
      probeProgress.running = false;
    });

    return NextResponse.json({ message: "Discovery scan started", progress: probeProgress });
  }

  if (action === "stop") {
    probing = false;
    probeProgress.running = false;
    return NextResponse.json({ message: "Stopping after current batch" });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}

async function runDiscoveryScan(db: ReturnType<typeof getDb>, dataDir: string) {
  const { probeOnocoyStation, saveProbeResult } = require("@/lib/agents/rtcm-probe");

  // Get all unprobed ONOCOY stations
  const unprobed = db.prepare(`
    SELECT name FROM stations
    WHERE network = 'onocoy' AND status IN ('ONLINE', 'ACTIVE')
      AND (receiver_type IS NULL OR receiver_type = '' OR receiver_type LIKE '%INFERRED%')
    ORDER BY name
  `).all() as any[];

  probeProgress.total = unprobed.length;
  console.log(`[PROBE] Discovery scan: ${unprobed.length} stations to probe`);

  // Probe in batches of 5 (parallel)
  const BATCH_SIZE = 5;
  const DELAY_BETWEEN_BATCHES = 2000; // 2s between batches

  for (let i = 0; i < unprobed.length; i += BATCH_SIZE) {
    if (!probing) {
      console.log(`[PROBE] Stopped at ${i}/${unprobed.length}`);
      break;
    }

    const batch = unprobed.slice(i, i + BATCH_SIZE);

    const results = await Promise.all(
      batch.map((s: any) => probeOnocoyStation(s.name).catch(() => null))
    );

    for (const result of results) {
      if (!result) continue;
      probeProgress.done++;

      if (result.success) {
        saveProbeResult(db, result);

        if (result.receiver_descriptor) {
          const recv = result.receiver_descriptor.toUpperCase();
          if (/LEICA|TRIMBLE|SEPT|NOVATEL|CHC|TOPCON|JAVAD/.test(recv)) {
            probeProgress.found_survey++;
          }
          console.log(`[PROBE] ${result.station}: ${result.receiver_descriptor} (${result.antenna_descriptor || "?"})`);
        }
      }
    }

    // Log progress every 50 stations
    if (probeProgress.done % 50 === 0) {
      console.log(`[PROBE] Progress: ${probeProgress.done}/${probeProgress.total} (${probeProgress.found_survey} survey-grade found)`);
    }

    // Delay between batches
    await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_BATCHES));
  }

  console.log(`[PROBE] Discovery scan complete: ${probeProgress.done}/${probeProgress.total} probed, ${probeProgress.found_survey} survey-grade found`);

  // Persist results summary
  try {
    const summaryPath = path.join(dataDir, "probe-summary.json");
    fs.writeFileSync(summaryPath, JSON.stringify(probeProgress, null, 2));
  } catch {}
}
