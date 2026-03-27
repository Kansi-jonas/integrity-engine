// ─── Integrity Engine Auto-Sync ──────────────────────────────────────────────
// Orchestrates all cron jobs for the standalone integrity service.

import cron from "node-cron";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { eventBus, IntegrityEvent } from "./event-bus";

function emitEvent(type: IntegrityEvent["type"], severity: IntegrityEvent["severity"], title: string, detail: string, data?: any) {
  eventBus.emit("integrity", { type, severity, title, detail, data, timestamp: new Date().toISOString() });
}

import crypto from "crypto";

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), "data", "integrity.db");
let initialized = false;
let pipelineRunning = false; // Mutex: prevent overlapping 4h pipeline runs

function getDataDir() {
  return path.dirname(DB_PATH);
}

function openDb(): Database.Database {
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000"); // Wait up to 5s for locks instead of failing
  return db;
}

export function startAutoSync() {
  if (initialized) return;
  initialized = true;
  console.log("[INTEGRITY-ENGINE] Starting auto-sync pipeline...");

  const dataDir = getDataDir();
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  // ── GEODNET Session Sync — every 5 minutes ────────────────────────────────
  cron.schedule("*/5 * * * *", async () => {
    try {
      const db = openDb();
      const { syncSessions } = require("./geodnet-sync");
      const count = await syncSessions(db);
      if (count > 0) console.log(`[GEODNET-SYNC] ${count} sessions synced`);
      db.close();
    } catch (err) {
      console.error("[GEODNET-SYNC] Failed:", err);
    }
  });

  // ── rtkbi Historical Sync — every 2 hours ───────────────────────────────
  cron.schedule("15 */2 * * *", async () => {
    try {
      const db = openDb();
      const { syncFromRtkbi } = require("./rtkbi-sync");
      const count = await syncFromRtkbi(db, dataDir);
      if (count > 0) console.log(`[RTKBI-SYNC] ${count} historical sessions imported`);
      db.close();
    } catch (err) {
      console.error("[RTKBI-SYNC] Failed:", err);
    }
  });

  // ── Station Sync — every 2 hours (GEODNET + ONOCOY) ─────────────────────
  cron.schedule("0 */2 * * *", async () => {
    try {
      const db = openDb();
      const { syncStations, syncOnocoyStations } = require("./geodnet-sync");
      const geodnetCount = await syncStations(db);
      const onocoyCount = await syncOnocoyStations(db);
      console.log(`[STATION-SYNC] ${geodnetCount} GEODNET + ${onocoyCount} ONOCOY stations`);
      db.close();
    } catch (err) {
      console.error("[STATION-SYNC] Failed:", err);
    }
  });

  // ── Station Status Snapshot — every 15 minutes ────────────────────────────
  cron.schedule("5,20,35,50 * * * *", () => {
    try {
      const db = openDb();
      const { snapshotStationStatus } = require("./geodnet-sync");
      snapshotStationStatus(db);
      db.close();
    } catch (err) {
      console.error("[STATUS-SNAPSHOT] Failed:", err);
    }
  });

  // ── SENTINEL V2 — every 5 minutes at :00 (CUSUM/EWMA + ST-DBSCAN + cross-network) ──
  cron.schedule("*/5 * * * *", () => {
    try {
      const db = openDb();
      const { runSentinelV2 } = require("./agents/sentinel-v2");
      const anomalies = runSentinelV2(db, dataDir);
      db.close();

      // Save SENTINEL anomalies for Fence Generator (FIX: was disconnected)
      if (anomalies.length > 0) {
        try {
          const sentinelPath = path.join(dataDir, "sentinel-anomalies.json");
          const tmp = sentinelPath + ".tmp";
          fs.writeFileSync(tmp, JSON.stringify({ anomalies, computed_at: new Date().toISOString() }));
          fs.renameSync(tmp, sentinelPath);
        } catch {}
        const critical = anomalies.filter((a: any) => a.severity === "critical").length;
        const kpAdj = anomalies.filter((a: any) => a.kp_adjusted).length;
        console.log(`[SENTINEL-V2] ${anomalies.length} anomalies (${critical} critical${kpAdj > 0 ? `, ${kpAdj} Kp-adjusted` : ""})`);
        if (critical > 0) {
          emitEvent("anomaly", "critical", `${critical} critical anomalies detected`, `SENTINEL V2 found ${anomalies.length} anomalies (${critical} critical)`, { count: anomalies.length, critical });
        } else if (anomalies.length > 0) {
          emitEvent("anomaly", "warning", `${anomalies.length} anomalies detected`, `SENTINEL V2 detected ${anomalies.length} anomalies`, { count: anomalies.length });
        }
      }
    } catch (err) {
      console.error("[SENTINEL-V2] Failed:", err);
    }
  });

  // ── SHIELD — every 5 minutes at :02 (staggered to avoid race condition) ───
  cron.schedule("2-57/5 * * * *", () => {
    try {
      const db = openDb();
      const { runShield } = require("./agents/shield");
      const events = runShield(db, dataDir);
      db.close();
      if (events.length > 0) {
        const types = events.map((e: any) => e.classification).join(", ");
        console.log(`[SHIELD] ${events.length} interference events classified: ${types}`);
        for (const evt of events) {
          const sev = evt.classification === "jamming" || evt.classification === "spoofing" ? "critical" : "warning";
          emitEvent("interference", sev, `${evt.classification} detected`, `SHIELD classified interference: ${evt.classification}`, evt);
        }
      }
    } catch (err) {
      console.error("[SHIELD] Failed:", err);
    }
  });

  // ── ENVIRONMENT — every hour (:10) ──────────────────────────────────────────
  // Replaces simple space-weather with comprehensive 9-source environment monitoring
  cron.schedule("10 * * * *", async () => {
    try {
      const { fetchEnvironment } = require("./agents/environment");
      const env = await fetchEnvironment(dataDir);
      const iono = env.ionosphere;
      const parts = [`Kp=${iono.kp_index}`, `Dst=${iono.dst_index}nT`, `Bz=${iono.bz_component}nT`];
      if (iono.flare_class) parts.push(`Flare:${iono.flare_class}`);
      if (iono.storm_level !== "quiet") parts.push(`Storm:${iono.storm_level}(${iono.storm_phase})`);
      parts.push(`Sats:${env.constellation.total_healthy}/${env.constellation.total_healthy + env.constellation.total_unhealthy}`);
      if (env.cme_forecast.length > 0) parts.push(`CME:${env.cme_forecast.length} incoming`);
      parts.push(`Sources:${env.sources.length}${env.errors.length > 0 ? ` (${env.errors.length} errors)` : ""}`);
      console.log(`[ENVIRONMENT] ${parts.join(" | ")}`);
      // Emit events for significant environment changes
      if (iono.storm_level !== "quiet") {
        emitEvent("environment", "warning", `Geomagnetic storm: ${iono.storm_level}`, `Kp ${iono.kp} | Dst ${iono.dst}nT | ${iono.affected_regions.length} regions affected`, iono);
      }
      if (iono.flare_class && (iono.flare_class.startsWith("M") || iono.flare_class.startsWith("X"))) {
        emitEvent("environment", "critical", `Solar Flare ${iono.flare_class}`, `${iono.flare_class} flare detected — potential GNSS degradation`, { flare: iono.flare_class });
      }
      if (env.cme_forecast.length > 0) {
        emitEvent("environment", "warning", `${env.cme_forecast.length} CME incoming`, `Coronal Mass Ejection forecast — storm expected`, env.cme_forecast);
      }
    } catch (err) {
      console.error("[ENVIRONMENT] Failed:", err);
    }
  });

  // ── ML Model Retrain — daily at 03:00 ──────────────────────────────────
  cron.schedule("0 3 * * *", () => {
    try {
      console.log("[ML] Starting nightly retrain...");
      const db = openDb();
      const { trainModel, invalidateModelCache } = require("./ml/quality-predictor");
      invalidateModelCache();
      const state = trainModel(db, dataDir);
      db.close();
      if (state) {
        console.log(`[ML] Retrain complete: ${state.metadata.training_samples} samples, R²=${state.metadata.oob_score}`);
      }
    } catch (err) {
      console.error("[ML] Retrain failed:", err);
    }
  });

  // ── MERIDIAN Zone Sync — every 2 hours ──────────────────────────────────
  cron.schedule("5 */2 * * *", async () => {
    try {
      const { syncMeridianZones } = require("./meridian-sync");
      await syncMeridianZones(dataDir);
    } catch (err) {
      console.error("[MERIDIAN-SYNC] Failed:", err);
    }
  });

  // ── Quality Pipeline — every 4 hours (:30) ───────────────────────────────
  // TRUST + Signal Integrity + Fence Generator + Zone Integrity
  cron.schedule("30 */4 * * *", async () => {
    if (pipelineRunning) {
      console.log("[QUALITY-PIPELINE] Skipped — previous run still in progress");
      return;
    }
    pipelineRunning = true;
    try {
      console.log("[QUALITY-PIPELINE] Starting...");
      const startTime = Date.now();
      const db = openDb();

      // Step 1: Station scoring
      const { computeStationScores, writeStationScores } = require("./station-scorer");
      const stationScores = computeStationScores(db);
      writeStationScores(db, stationScores);
      console.log(`[QUALITY-PIPELINE] ${stationScores.length} stations scored`);

      // Step 2: Signal integrity (threshold-based)
      let integrityAnomalies: any[] = [];
      try {
        const { computeSignalIntegrity } = require("./signal-integrity");
        const integrityData = computeSignalIntegrity(db);
        integrityAnomalies = integrityData.anomalies || [];
        const integrityPath = path.join(dataDir, "signal-integrity.json");
        const tmp = integrityPath + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(integrityData));
        fs.renameSync(tmp, integrityPath);
        console.log(`[SIGNAL-INTEGRITY] ${integrityAnomalies.length} anomalies, global: ${integrityData.integrity_scores.global}`);
      } catch (err) {
        console.error("[SIGNAL-INTEGRITY] Failed:", err);
      }

      // Step 3: TRUST V2 (5-component composite + cross-network + hysteresis)
      let trustScores: any[] = [];
      try {
        const { runTrustV2 } = require("./agents/trust-v2");
        trustScores = runTrustV2(db, dataDir);
        const excluded = trustScores.filter((t: any) => t.flag === "excluded").length;
        const untrusted = trustScores.filter((t: any) => t.flag === "untrusted").length;
        const probation = trustScores.filter((t: any) => t.flag === "probation").length;
        console.log(`[TRUST-V2] ${trustScores.length} scored — ${excluded} excluded, ${untrusted} untrusted, ${probation} probation`);
        if (excluded > 0) {
          emitEvent("trust_change", "warning", `${excluded} stations excluded`, `TRUST V2: ${excluded} excluded, ${untrusted} untrusted, ${probation} probation`, { excluded, untrusted, probation });
        }
      } catch (err) {
        console.error("[TRUST-V2] Failed:", err);
      }

      // Step 3a: H3 Quality Cells (MERIDIAN physics-based coverage quality)
      try {
        const { computeCellQualities, writeQualityCells } = require("./h3-quality");
        const cells = computeCellQualities(db);
        writeQualityCells(db, cells);
        const tiers: Record<string, number> = {};
        for (const c of cells) tiers[c.zoneTier] = (tiers[c.zoneTier] || 0) + 1;
        console.log(`[H3-QUALITY] ${cells.length} cells — full:${tiers.full_rtk || 0} degraded:${tiers.degraded_rtk || 0} float:${tiers.float_dgps || 0} none:${tiers.no_coverage || 0}`);
      } catch (err) {
        console.error("[H3-QUALITY] Failed:", err);
      }

      // Step 3b: Spatial Quality Surface (Kriging + Moran's I)
      try {
        const { computeQualitySurface } = require("./spatial/quality-surface");
        const surface = computeQualitySurface(db, dataDir);
        console.log(`[SPATIAL] Variogram R²=${surface.variogram.r_squared} | Moran I=${surface.moran.global_I} (${surface.moran.interpretation}) | ${surface.grid.length} grid points | ${surface.regions.length} regions`);
      } catch (err) {
        console.error("[SPATIAL] Failed:", err);
      }

      // Step 4: Zone Integrity (if MERIDIAN zones available)
      try {
        const zonesPath = path.join(dataDir, "meridian-zones.json");
        if (fs.existsSync(zonesPath)) {
          const { computeZoneIntegrity } = require("./meridian-sync");
          const zones = JSON.parse(fs.readFileSync(zonesPath, "utf-8"));
          const zoneIntegrity = computeZoneIntegrity(db, zones, trustScores);
          const ziPath = path.join(dataDir, "zone-integrity.json");
          const tmp = ziPath + ".tmp";
          fs.writeFileSync(tmp, JSON.stringify({ zones: zoneIntegrity, computed_at: new Date().toISOString() }));
          fs.renameSync(tmp, ziPath);
          console.log(`[ZONE-INTEGRITY] ${zoneIntegrity.length} zones scored`);
        }
      } catch (err) {
        console.error("[ZONE-INTEGRITY] Failed:", err);
      }

      // Step 5: Fence Generator (FIX: now uses SENTINEL V2 + signal-integrity anomalies)
      try {
        const { generateFenceActions } = require("./agents/fence-generator");
        let allAnomalies: any[] = [...integrityAnomalies];
        // Add SENTINEL V2 anomalies (CUSUM/EWMA/ST-DBSCAN)
        try {
          const sentinelPath = path.join(dataDir, "sentinel-anomalies.json");
          if (fs.existsSync(sentinelPath)) {
            const sd = JSON.parse(fs.readFileSync(sentinelPath, "utf-8"));
            allAnomalies.push(...(sd.anomalies || []));
          }
        } catch {}
        // Deduplicate by station + type
        const seen = new Set<string>();
        allAnomalies = allAnomalies.filter(a => {
          const key = `${a.station || "global"}_${a.type}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        const actions = await generateFenceActions(allAnomalies, trustScores, dataDir);
        if (actions.length > 0) {
          console.log(`[FENCE] ${actions.length} actions — ${actions.filter((a: any) => a.action === "exclude").length} excludes, ${actions.filter((a: any) => a.action === "downgrade").length} downgrades`);
        }
      } catch (err) {
        console.error("[FENCE] Failed:", err);
      }

      // Step 6: Generate qualified station config for Alberding
      try {
        const { generateQualifiedConfig } = require("./config-generator");
        const config = generateQualifiedConfig(db, dataDir);
        console.log(`[CONFIG-GEN] ${config.stats.qualified_count} qualified (${config.stats.platinum} platinum, ${config.stats.gold} gold, ${config.stats.silver} silver), ${config.stats.disqualified_count} disqualified`);
      } catch (err) {
        console.error("[CONFIG-GEN] Failed:", err);
      }

      // Step 6b: Build zones from H3 quality cells
      try {
        const { buildZonesFromQuality } = require("./zone-builder");
        const zoneResult = buildZonesFromQuality(db, dataDir);
        console.log(`[ZONE-BUILDER] ${zoneResult.stats.zones_created} zones (${zoneResult.stats.full_rtk_zones} full RTK, ${zoneResult.stats.degraded_zones} degraded) — ${zoneResult.stats.coverage_area_km2} km² coverage`);

        // Convert to Wizard format for Config Engine
        const { convertZonesToWizard, summarizeZoneChanges } = require("./zone-to-config");
        const wizardZones = convertZonesToWizard(zoneResult, dataDir);
        const changes = summarizeZoneChanges(zoneResult, dataDir);
        const changeCount = changes.added.length + changes.removed.length + changes.updated.length;
        if (changeCount > 0) {
          console.log(`[ZONE-CONFIG] ${Object.keys(wizardZones).length} wizard zones — ${changes.added.length} added, ${changes.removed.length} removed, ${changes.updated.length} updated`);
          emitEvent("zone_update", "info", `${changeCount} zone changes`, `Added: ${changes.added.length}, Removed: ${changes.removed.length}, Updated: ${changes.updated.length}`, changes);
        } else {
          console.log(`[ZONE-CONFIG] ${Object.keys(wizardZones).length} wizard zones (no changes)`);
        }
        // ONOCOY Gap-Fill: find gaps and create ONOCOY zones
        try {
          const { runOnocoyGapFill } = require("./agents/onocoy-gapfill");
          const gapFill = runOnocoyGapFill(db, dataDir);
          if (gapFill.stats.zones_created > 0) {
            console.log(`[ONOCOY-GAPFILL] ${gapFill.stats.total_gaps} gaps found, ${gapFill.stats.zones_created} zones created (${gapFill.stats.onocoy_survey_grade} survey-grade, ${gapFill.stats.onocoy_consumer} consumer)`);
            emitEvent("zone_update", "info", `${gapFill.stats.zones_created} ONOCOY gap-fill zones`, `Survey-grade: ${gapFill.stats.onocoy_survey_grade}, Gaps: ${gapFill.stats.total_gaps}`, gapFill.stats);
          }
        } catch (err) {
          console.error("[ONOCOY-GAPFILL] Failed:", err);
        }
      } catch (err) {
        console.error("[ZONE-BUILDER] Failed:", err);
      }

      // Step 6c: Cross-Network Validation (GEODNET vs ONOCOY)
      try {
        const { runCrossValidator } = require("./agents/cross-validator");
        const cv = runCrossValidator(db, dataDir);
        if (cv.regions.length > 0) {
          console.log(`[CROSS-VALIDATOR] ${cv.regions.length} overlapping regions, agreement=${cv.overall_agreement}, ${cv.station_flags.length} flagged`);
          if (cv.station_flags.length > 0) {
            emitEvent("trust_change", "warning", `${cv.station_flags.length} cross-network flags`, `Cross-validation found ${cv.station_flags.length} stations underperforming vs other network`, { flags: cv.station_flags.length });
          }
        }
      } catch (err) {
        console.error("[CROSS-VALIDATOR] Failed:", err);
      }

      // Step 6d: Adversarial Station Detection (DePIN gaming)
      try {
        const { runAdversarialDetector } = require("./agents/adversarial-detector");
        const adv = runAdversarialDetector(db, dataDir);
        if (adv.total_flagged > 0) {
          console.log(`[ADVERSARIAL] ${adv.total_flagged} suspicious (${adv.clone_clusters.length} clones, ${adv.zombie_stations.length} zombies)`);
          emitEvent("trust_change", "critical", `${adv.total_flagged} adversarial stations detected`, `Clone: ${adv.clone_clusters.length}, Zombie: ${adv.zombie_stations.length}`, { total: adv.total_flagged });
        }
      } catch (err) {
        console.error("[ADVERSARIAL] Failed:", err);
      }

      // Step 6e: Session Feedback Loop (validate zones against actual user results)
      try {
        const { runSessionFeedback } = require("./agents/session-feedback");
        const feedback = runSessionFeedback(db, dataDir);
        if (feedback.zones.length > 0) {
          console.log(`[SESSION-FEEDBACK] ${feedback.zones.length} zones analyzed — ${feedback.overall.zones_flagged} flagged, mean fix ${feedback.overall.mean_fix_rate}%`);
        }
      } catch (err) {
        console.error("[SESSION-FEEDBACK] Failed:", err);
      }

      // Step 7: ONOCOY Prober (gap-fill + quality compare)
      try {
        const { runOnocoyProber } = require("./agents/onocoy-prober");
        await runOnocoyProber(db, dataDir);
      } catch (err) {
        console.error("[ONOCOY-PROBER] Failed:", err);
      }

      // Step 8: PPK Downloader (RINEX deep QC for suspicious stations)
      try {
        const { runPPKDownloader } = require("./agents/ppk-downloader");
        await runPPKDownloader(db, dataDir);
      } catch (err) {
        console.error("[PPK] Failed:", err);
      }

      db.close();
      console.log(`[QUALITY-PIPELINE] Complete in ${Math.round((Date.now() - startTime) / 1000)}s`);
    } catch (err) {
      console.error("[QUALITY-PIPELINE] Failed:", err);
    } finally {
      pipelineRunning = false;
    }
  });

  // ── Initial sync on startup (after 10s delay) ────────────────────────────
  setTimeout(async () => {
    try {
      // Ensure Wizard base configuration exists
      try {
        const { ensureWizardSetup } = require("./wizard/auto-setup");
        ensureWizardSetup(dataDir);
      } catch (err) {
        console.error("[WIZARD-SETUP] Failed:", err);
      }

      console.log("[STARTUP] Running initial data sync...");
      const db = openDb();
      const { syncSessions, syncStations, syncOnocoyStations } = require("./geodnet-sync");
      const stationCount = await syncStations(db);
      const onocoyCount = await syncOnocoyStations(db);
      const sessionCount = await syncSessions(db);
      console.log(`[STARTUP] Initial sync: ${stationCount} GEODNET + ${onocoyCount} ONOCOY stations, ${sessionCount} sessions`);

      // Historical backfill from rtkbi (6 months)
      try {
        const { syncFromRtkbi } = require("./rtkbi-sync");
        const histCount = await syncFromRtkbi(db, dataDir);
        console.log(`[STARTUP] Historical backfill: ${histCount} sessions from rtkbi`);
      } catch (err) {
        console.log("[STARTUP] rtkbi sync skipped (RTKBI_URL not set or unavailable)");
      }

      // Initial environment fetch (9 sources)
      const { fetchEnvironment } = require("./agents/environment");
      const env = await fetchEnvironment(dataDir);
      console.log(`[STARTUP] Environment: Kp=${env.ionosphere.kp_index}, ${env.sources.length} sources`);

      db.close();
    } catch (err) {
      console.error("[STARTUP] Initial sync failed:", err);
    }
  }, 10000);

  console.log("[INTEGRITY-ENGINE] All cron jobs registered.");
}
