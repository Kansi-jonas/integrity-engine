// ─── ONOCOY Prober Agent ─────────────────────────────────────────────────────
// Selectively probes ONOCOY stations via NTRIP to validate quality.
// Only probes stations where:
// 1. No GEODNET overlap exists (GEODNET gap)
// 2. ONOCOY might have better quality than local GEODNET stations
//
// Sends GGA position to ONOCOY NTRIP, measures:
// - Connection latency
// - RTCM data rate / stability
// - Stream continuity (no drops)
//
// Results feed into TRUST V2 scoring for ONOCOY stations.
// Runs every 2 hours, max 50 probes per cycle to control costs.

import Database from "better-sqlite3";
import net from "net";
import fs from "fs";
import path from "path";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ProbeResult {
  station: string;
  probe_type: "gap_fill" | "quality_compare";
  success: boolean;
  connect_latency_ms: number;
  first_data_ms: number;         // Time to first RTCM byte
  bytes_received: number;
  duration_ms: number;
  error: string | null;
  probed_at: string;
}

interface ProbeTarget {
  station: string;
  lat: number;
  lon: number;
  reason: "geodnet_gap" | "potential_upgrade";
  nearest_geodnet_km: number;
  nearest_geodnet_uq: number;
}

// ─── Config ──────────────────────────────────────────────────────────────────

const ONO_HOST = "clients.onocoy.com";
const ONO_PORT = 2101;
const ONO_USER = process.env.ONOCOY_USER || "";
const ONO_PASS = process.env.ONOCOY_PASS || "";
const MAX_PROBES_PER_CYCLE = 50;
const PROBE_TIMEOUT_MS = 10000;   // 10s per probe
const PROBE_DURATION_MS = 5000;   // Collect data for 5s

// ─── Find Probe Targets ─────────────────────────────────────────────────────

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function findProbeTargets(db: Database.Database): ProbeTarget[] {
  // Load all GEODNET stations with scores
  const geodnetStations = db.prepare(`
    SELECT s.name, s.latitude, s.longitude,
           COALESCE(ss.uq_score, 0.5) as uq_score
    FROM stations s
    LEFT JOIN station_scores ss ON s.name = ss.station_name
    WHERE s.network = 'geodnet' AND s.latitude IS NOT NULL AND ABS(s.latitude) > 0.1
  `).all() as any[];

  // Load all ONOCOY stations
  const onocoyStations = db.prepare(`
    SELECT name, latitude, longitude
    FROM stations
    WHERE network = 'onocoy' AND latitude IS NOT NULL AND ABS(latitude) > 0.1
  `).all() as any[];

  if (onocoyStations.length === 0) return [];

  const targets: ProbeTarget[] = [];

  for (const ono of onocoyStations) {
    // Find nearest GEODNET station
    let nearestDist = Infinity;
    let nearestUQ = 0;

    for (const geo of geodnetStations) {
      const dist = haversineKm(ono.latitude, ono.longitude, geo.latitude, geo.longitude);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearestUQ = geo.uq_score;
      }
    }

    // Case 1: GEODNET gap (no GEODNET station within 40km)
    if (nearestDist > 40) {
      targets.push({
        station: ono.name,
        lat: ono.latitude,
        lon: ono.longitude,
        reason: "geodnet_gap",
        nearest_geodnet_km: Math.round(nearestDist * 10) / 10,
        nearest_geodnet_uq: nearestUQ,
      });
    }
    // Case 2: Nearby GEODNET station has low quality
    else if (nearestUQ < 0.4 && nearestDist < 80) {
      targets.push({
        station: ono.name,
        lat: ono.latitude,
        lon: ono.longitude,
        reason: "potential_upgrade",
        nearest_geodnet_km: Math.round(nearestDist * 10) / 10,
        nearest_geodnet_uq: nearestUQ,
      });
    }
  }

  // Sort: gaps first, then upgrades, limit to MAX_PROBES
  targets.sort((a, b) => {
    if (a.reason !== b.reason) return a.reason === "geodnet_gap" ? -1 : 1;
    return b.nearest_geodnet_km - a.nearest_geodnet_km; // Furthest from GEODNET first
  });

  return targets.slice(0, MAX_PROBES_PER_CYCLE);
}

// ─── NTRIP Probe ─────────────────────────────────────────────────────────────
// Connect to ONOCOY NTRIP, send GGA, measure response.

function generateGGA(lat: number, lon: number): string {
  const latDeg = Math.floor(Math.abs(lat));
  const latMin = (Math.abs(lat) - latDeg) * 60;
  const lonDeg = Math.floor(Math.abs(lon));
  const lonMin = (Math.abs(lon) - lonDeg) * 60;
  const ns = lat >= 0 ? "N" : "S";
  const ew = lon >= 0 ? "E" : "W";

  const time = new Date();
  const hhmmss = `${String(time.getUTCHours()).padStart(2, "0")}${String(time.getUTCMinutes()).padStart(2, "0")}${String(time.getUTCSeconds()).padStart(2, "0")}.00`;

  const body = `GPGGA,${hhmmss},${latDeg}${latMin.toFixed(4)},${ns},${lonDeg.toString().padStart(3, "0")}${lonMin.toFixed(4)},${ew},4,12,0.9,100.0,M,0.0,M,,`;
  // Compute checksum
  let cksum = 0;
  for (let i = 0; i < body.length; i++) cksum ^= body.charCodeAt(i);
  return `$${body}*${cksum.toString(16).toUpperCase().padStart(2, "0")}\r\n`;
}

async function probeStation(mountpoint: string, lat: number, lon: number): Promise<ProbeResult> {
  const startTime = Date.now();

  return new Promise((resolve) => {
    const result: ProbeResult = {
      station: mountpoint,
      probe_type: "gap_fill",
      success: false,
      connect_latency_ms: 0,
      first_data_ms: 0,
      bytes_received: 0,
      duration_ms: 0,
      error: null,
      probed_at: new Date().toISOString(),
    };

    const socket = new net.Socket();
    let connectTime = 0;
    let firstDataTime = 0;
    let totalBytes = 0;
    let headerDone = false;

    const timeout = setTimeout(() => {
      result.error = "timeout";
      result.duration_ms = Date.now() - startTime;
      socket.destroy();
      resolve(result);
    }, PROBE_TIMEOUT_MS);

    socket.connect(ONO_PORT, ONO_HOST, () => {
      connectTime = Date.now();
      result.connect_latency_ms = connectTime - startTime;

      // Send NTRIP request
      const auth = Buffer.from(`${ONO_USER}:${ONO_PASS}`).toString("base64");
      socket.write(
        `GET /${mountpoint} HTTP/1.1\r\n` +
        `Host: ${ONO_HOST}\r\n` +
        `Ntrip-Version: Ntrip/2.0\r\n` +
        `Authorization: Basic ${auth}\r\n` +
        `User-Agent: NTRIP RTKdata-Prober/1.0\r\n` +
        `\r\n`
      );
    });

    socket.on("data", (data) => {
      if (!headerDone) {
        const str = data.toString();
        if (str.includes("200 OK") || str.includes("ICY 200")) {
          headerDone = true;
          // Send GGA position
          socket.write(generateGGA(lat, lon));
        } else if (str.includes("401") || str.includes("404")) {
          result.error = `HTTP ${str.substring(0, 50)}`;
          clearTimeout(timeout);
          socket.destroy();
          resolve(result);
          return;
        }
      }

      if (headerDone) {
        if (firstDataTime === 0) {
          firstDataTime = Date.now();
          result.first_data_ms = firstDataTime - connectTime;
        }
        totalBytes += data.length;
      }

      // After collecting enough data, close
      if (totalBytes > 0 && Date.now() - (firstDataTime || startTime) > PROBE_DURATION_MS) {
        result.success = true;
        result.bytes_received = totalBytes;
        result.duration_ms = Date.now() - startTime;
        clearTimeout(timeout);
        socket.destroy();
        resolve(result);
      }
    });

    socket.on("error", (err) => {
      result.error = err.message;
      result.duration_ms = Date.now() - startTime;
      clearTimeout(timeout);
      resolve(result);
    });

    socket.on("close", () => {
      if (!result.success && !result.error) {
        result.error = "connection_closed";
      }
      result.bytes_received = totalBytes;
      result.duration_ms = Date.now() - startTime;
      clearTimeout(timeout);
      resolve(result);
    });
  });
}

// ─── Main Function ──────────────────────────────────────────────────────────

export async function runOnocoyProber(db: Database.Database, dataDir: string): Promise<ProbeResult[]> {
  if (!ONO_USER || !ONO_PASS) {
    console.log("[ONOCOY-PROBER] No credentials configured, skipping");
    return [];
  }

  const targets = findProbeTargets(db);
  if (targets.length === 0) {
    console.log("[ONOCOY-PROBER] No targets found (full GEODNET coverage)");
    return [];
  }

  console.log(`[ONOCOY-PROBER] Probing ${targets.length} stations (${targets.filter(t => t.reason === "geodnet_gap").length} gaps, ${targets.filter(t => t.reason === "potential_upgrade").length} upgrades)`);

  const results: ProbeResult[] = [];

  // Probe sequentially (don't overload ONOCOY)
  for (const target of targets) {
    try {
      const result = await probeStation(target.station, target.lat, target.lon);
      result.probe_type = target.reason === "geodnet_gap" ? "gap_fill" : "quality_compare";
      results.push(result);

      // Small delay between probes
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      results.push({
        station: target.station,
        probe_type: target.reason === "geodnet_gap" ? "gap_fill" : "quality_compare",
        success: false,
        connect_latency_ms: 0,
        first_data_ms: 0,
        bytes_received: 0,
        duration_ms: 0,
        error: String(err),
        probed_at: new Date().toISOString(),
      });
    }
  }

  // Persist results
  try {
    const filePath = path.join(dataDir, "onocoy-probes.json");
    let history: ProbeResult[] = [];
    try {
      if (fs.existsSync(filePath)) {
        history = JSON.parse(fs.readFileSync(filePath, "utf-8")).results || [];
      }
    } catch {}
    const all = [...results, ...history].slice(0, 1000);
    const tmp = filePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({
      results: all,
      last_run: new Date().toISOString(),
      summary: {
        total_probed: results.length,
        successful: results.filter(r => r.success).length,
        failed: results.filter(r => !r.success).length,
        gap_fills: results.filter(r => r.probe_type === "gap_fill").length,
        quality_compares: results.filter(r => r.probe_type === "quality_compare").length,
        avg_latency_ms: results.filter(r => r.success).length > 0
          ? Math.round(results.filter(r => r.success).reduce((s, r) => s + r.connect_latency_ms, 0) / results.filter(r => r.success).length)
          : 0,
      },
    }));
    fs.renameSync(tmp, filePath);
  } catch {}

  const successful = results.filter(r => r.success).length;
  console.log(`[ONOCOY-PROBER] ${successful}/${results.length} probes successful`);

  return results;
}
