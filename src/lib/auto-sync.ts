// ─── Integrity Engine Auto-Sync ──────────────────────────────────────────────
// Orchestrates all cron jobs for the standalone integrity service.

import cron from "node-cron";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), "data", "integrity.db");
let initialized = false;

function getDataDir() {
  return path.dirname(DB_PATH);
}

function openDb(): Database.Database {
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
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

  // ── SENTINEL — every 5 minutes (CUSUM/EWMA) ──────────────────────────────
  cron.schedule("*/5 * * * *", () => {
    try {
      const db = openDb();
      const { runSentinel } = require("./agents/sentinel");
      const anomalies = runSentinel(db, dataDir);
      db.close();
      if (anomalies.length > 0) {
        console.log(`[SENTINEL] ${anomalies.length} anomalies (${anomalies.filter((a: any) => a.severity === "critical").length} critical)`);
      }
    } catch (err) {
      console.error("[SENTINEL] Failed:", err);
    }
  });

  // ── SPACE WEATHER — every hour (:10) ──────────────────────────────────────
  cron.schedule("10 * * * *", async () => {
    try {
      const { fetchSpaceWeather } = require("./agents/space-weather");
      const weather = await fetchSpaceWeather(dataDir);
      if (weather.kp_index >= 4) {
        console.log(`[SPACE-WEATHER] Storm: Kp=${weather.kp_index} (${weather.storm_level})`);
      }
    } catch (err) {
      console.error("[SPACE-WEATHER] Failed:", err);
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

      // Step 3: TRUST Agent (Bayesian scoring)
      let trustScores: any[] = [];
      try {
        const { runTrust } = require("./agents/trust");
        trustScores = runTrust(db, dataDir);
        const untrusted = trustScores.filter((t: any) => t.flag === "untrusted").length;
        const probation = trustScores.filter((t: any) => t.flag === "probation").length;
        console.log(`[TRUST] ${trustScores.length} scored — ${untrusted} untrusted, ${probation} probation`);
      } catch (err) {
        console.error("[TRUST] Failed:", err);
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

      // Step 5: Fence Generator
      try {
        const { generateFenceActions } = require("./agents/fence-generator");
        const actions = await generateFenceActions(integrityAnomalies, trustScores, dataDir);
        if (actions.length > 0) {
          console.log(`[FENCE] ${actions.length} actions (${actions.filter((a: any) => a.pushed).length} pushed)`);
        }
      } catch (err) {
        console.error("[FENCE] Failed:", err);
      }

      db.close();
      console.log(`[QUALITY-PIPELINE] Complete in ${Math.round((Date.now() - startTime) / 1000)}s`);
    } catch (err) {
      console.error("[QUALITY-PIPELINE] Failed:", err);
    }
  });

  // ── Initial sync on startup (after 10s delay) ────────────────────────────
  setTimeout(async () => {
    try {
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

      // Initial space weather fetch
      const { fetchSpaceWeather } = require("./agents/space-weather");
      await fetchSpaceWeather(dataDir);

      db.close();
    } catch (err) {
      console.error("[STARTUP] Initial sync failed:", err);
    }
  }, 10000);

  console.log("[INTEGRITY-ENGINE] All cron jobs registered.");
}
