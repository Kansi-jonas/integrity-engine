// ─── Manual Pipeline Trigger ─────────────────────────────────────────────────
// POST /api/trigger?pipeline=quality    — run full 4h quality pipeline
// POST /api/trigger?pipeline=ml         — retrain ML model
// POST /api/trigger?pipeline=environment — refresh environment data
//
// Requires API_KEY auth.

import { NextRequest, NextResponse } from "next/server";
import { getDb, getDataDir } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const pipeline = req.nextUrl.searchParams.get("pipeline") || "quality";

  const db = getDb();
  const dataDir = getDataDir();

  try {
    if (pipeline === "quality") {
      console.log("[TRIGGER] Manual quality pipeline started...");

      // Step 1: Station Scorer
      const { computeStationScores, writeStationScores } = require("@/lib/station-scorer");
      const stationScores = computeStationScores(db);
      writeStationScores(db, stationScores);
      console.log(`[TRIGGER] Station Scorer: ${stationScores.length} stations`);

      // Step 2: TRUST V2
      const { runTrustV2 } = require("@/lib/agents/trust-v2");
      const trustScores = runTrustV2(db, dataDir);
      const excluded = trustScores.filter((t: any) => t.flag === "excluded").length;
      console.log(`[TRIGGER] TRUST V2: ${trustScores.length} scored, ${excluded} excluded`);

      // Step 3: Spatial Quality Surface
      try {
        const { computeQualitySurface } = require("@/lib/spatial/quality-surface");
        const surface = computeQualitySurface(db, dataDir);
        console.log(`[TRIGGER] Spatial: ${surface.grid.length} grid points, R²=${surface.variogram.r_squared}`);
      } catch (e) {
        console.log(`[TRIGGER] Spatial: skipped (${e})`);
      }

      // Step 4: Cross-Validator
      try {
        const { runCrossValidator } = require("@/lib/agents/cross-validator");
        const cv = runCrossValidator(db, dataDir);
        console.log(`[TRIGGER] Cross-Validator: ${cv.regions.length} regions, ${cv.station_flags.length} flagged`);
      } catch (e) {
        console.log(`[TRIGGER] Cross-Validator: skipped (${e})`);
      }

      // Step 5: Adversarial Detector
      try {
        const { runAdversarialDetector } = require("@/lib/agents/adversarial-detector");
        const adv = runAdversarialDetector(db, dataDir);
        console.log(`[TRIGGER] Adversarial: ${adv.total_flagged} flagged`);
      } catch (e) {
        console.log(`[TRIGGER] Adversarial: skipped (${e})`);
      }

      // Step 6: Config Generator
      try {
        const { runConfigGenerator } = require("@/lib/config-generator");
        const config = runConfigGenerator(db, dataDir);
        console.log(`[TRIGGER] Config Generator: ${config.qualified} qualified, ${config.excluded} excluded`);
      } catch (e) {
        console.log(`[TRIGGER] Config Generator: skipped (${e})`);
      }

      // Step 7: Zone Generator
      try {
        const { generateIntegrityZones } = require("@/lib/wizard/zone-generator");
        const zones = generateIntegrityZones(db, dataDir);
        console.log(`[TRIGGER] Zone Generator: ${zones.length} zones`);
      } catch (e) {
        console.log(`[TRIGGER] Zone Generator: skipped (${e})`);
      }

      // Step 8: Session Feedback
      try {
        const { runSessionFeedback } = require("@/lib/agents/session-feedback");
        const feedback = runSessionFeedback(db, dataDir);
        console.log(`[TRIGGER] Session Feedback: ${feedback.zones.length} zones analyzed`);
      } catch (e) {
        console.log(`[TRIGGER] Session Feedback: skipped (${e})`);
      }

      console.log("[TRIGGER] Quality pipeline complete.");
      return NextResponse.json({ status: "ok", pipeline: "quality", stations: stationScores.length, trust: trustScores.length, excluded });

    } else if (pipeline === "ml") {
      console.log("[TRIGGER] Manual ML retrain started...");
      const { trainAndPredict } = require("@/lib/ml/quality-predictor");
      const result = trainAndPredict(db, dataDir);
      console.log(`[TRIGGER] ML retrain complete: ${result?.r2 || "n/a"}`);
      return NextResponse.json({ status: "ok", pipeline: "ml", ...result });

    } else if (pipeline === "environment") {
      console.log("[TRIGGER] Manual environment fetch...");
      const { fetchEnvironment } = require("@/lib/agents/environment");
      const env = await fetchEnvironment(dataDir);
      console.log(`[TRIGGER] Environment: ${env.sources.length} sources`);
      return NextResponse.json({ status: "ok", pipeline: "environment", sources: env.sources.length });

    } else {
      return NextResponse.json({ error: `Unknown pipeline: ${pipeline}` }, { status: 400 });
    }
  } catch (error) {
    console.error("[TRIGGER] Failed:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
