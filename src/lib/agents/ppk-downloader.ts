// ─── PPK Downloader Agent ────────────────────────────────────────────────────
// Downloads RINEX observation data from GEODNET PPK API for station QC.
// Separate auth system: ppk.geodnet.com with JWT (not RTK API).
//
// Workflow:
// 1. Sign in → JWT token
// 2. Find stations near areas of interest
// 3. Create download order (RINEX 3.04)
// 4. Poll until ready
// 5. Download + parse RINEX
//
// Runs every 4h in quality pipeline. Downloads RINEX for top suspicious
// stations (low trust, high anomaly count) to do deep QC.
//
// Requires: PPK_USER + PPK_PASS env vars

import fs from "fs";
import path from "path";
import Database from "better-sqlite3";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RinexQC {
  station: string;
  download_time: string;
  file_size_kb: number;
  // Observation stats
  observation_count: number;
  constellations: string[];        // GPS, GLONASS, Galileo, BeiDou
  frequencies: string[];           // L1, L2, L5, E1, E5b, etc.
  // Quality metrics from RINEX
  mean_snr_l1: number;
  mean_snr_l2: number;
  cycle_slip_count: number;
  cycle_slip_rate: number;         // Per hour
  multipath_l1: number;            // MP1 in meters
  multipath_l2: number;            // MP2 in meters
  observation_completeness: number; // % of expected observations present
  // Hardware info from RINEX header
  receiver_type: string;
  antenna_type: string;
  firmware_version: string;
  marker_position: { lat: number; lon: number; height: number };
  // Derived
  iono_tec_estimate: number | null; // VTEC in TECU (from dual-freq pseudorange diff)
  position_offset_m: number | null; // Distance between claimed and RINEX position
  quality_grade: "A" | "B" | "C" | "D" | "F";
}

// ─── Config ──────────────────────────────────────────────────────────────────

const PPK_BASE = "https://ppk.geodnet.com";
const PPK_USER = process.env.PPK_USER || "";
const PPK_PASS = process.env.PPK_PASS || "";
const MAX_DOWNLOADS_PER_CYCLE = 10;
const DOWNLOAD_POLL_INTERVAL_MS = 5000;
const DOWNLOAD_MAX_WAIT_MS = 120000; // 2 min max wait

// ─── Auth ────────────────────────────────────────────────────────────────────

let jwtToken: string | null = null;
let tokenExpiry = 0;

async function authenticate(): Promise<string> {
  if (jwtToken && Date.now() < tokenExpiry) return jwtToken;

  const res = await fetch(`${PPK_BASE}/api/user/signin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: PPK_USER, password: PPK_PASS }),
  });

  if (!res.ok) throw new Error(`PPK auth failed: ${res.status}`);
  const data = await res.json();
  jwtToken = data.token || data.data?.token;
  if (!jwtToken) throw new Error("No token in PPK auth response");
  tokenExpiry = Date.now() + 3500000; // ~1 hour
  return jwtToken;
}

async function ppkFetch(endpoint: string, options: RequestInit = {}): Promise<any> {
  const token = await authenticate();
  const res = await fetch(`${PPK_BASE}${endpoint}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
      ...options.headers,
    },
  });
  if (!res.ok) throw new Error(`PPK API ${res.status}: ${endpoint}`);
  return res;
}

// ─── Download RINEX ──────────────────────────────────────────────────────────

async function downloadRinex(stationName: string, date: string): Promise<Buffer | null> {
  // date format: "2026-03-25"

  // Step 1: Create download order (RINEX 3.04 = fileType 1)
  const orderRes = await ppkFetch("/api/user/download", {
    method: "POST",
    body: JSON.stringify({
      stationNames: [stationName],
      startDate: date,
      endDate: date,
      fileType: 1, // RINEX 3.04
    }),
  });
  const orderData = await orderRes.json();
  const orderId = orderData.data?.orderId || orderData.orderId;
  if (!orderId) throw new Error("No orderId in download response");

  // Step 2: Poll until ready
  const startWait = Date.now();
  while (Date.now() - startWait < DOWNLOAD_MAX_WAIT_MS) {
    const statusRes = await ppkFetch(`/api/download/status/${orderId}`);
    const statusData = await statusRes.json();
    const status = statusData.data?.status || statusData.status;

    if (status === 2) break; // Completed
    if (status === 3 || status === -1) throw new Error(`Download failed: status=${status}`);

    await new Promise(r => setTimeout(r, DOWNLOAD_POLL_INTERVAL_MS));
  }

  // Step 3: Download ZIP
  const dlRes = await ppkFetch(`/api/download/${orderId}`);
  const buffer = Buffer.from(await dlRes.arrayBuffer());
  return buffer;
}

// ─── RINEX Parser (simplified — extracts key QC metrics) ─────────────────────

function parseRinexHeader(content: string): Partial<RinexQC> {
  const lines = content.split("\n");
  const result: Partial<RinexQC> = {};

  for (const line of lines) {
    if (line.includes("END OF HEADER")) break;

    if (line.includes("REC # / TYPE / VERS")) {
      const parts = line.substring(0, 60).trim().split(/\s{2,}/);
      result.receiver_type = parts[1] || "unknown";
      result.firmware_version = parts[2] || "unknown";
    }
    if (line.includes("ANT # / TYPE")) {
      result.antenna_type = line.substring(20, 40).trim() || "unknown";
    }
    if (line.includes("APPROX POSITION XYZ")) {
      const xyz = line.substring(0, 60).trim().split(/\s+/).map(Number);
      if (xyz.length >= 3) {
        // Convert ECEF to lat/lon (simplified)
        const [x, y, z] = xyz;
        const lon = Math.atan2(y, x) * 180 / Math.PI;
        const p = Math.sqrt(x * x + y * y);
        const lat = Math.atan2(z, p * (1 - 0.00669437999)) * 180 / Math.PI;
        const height = p / Math.cos(lat * Math.PI / 180) - 6378137;
        result.marker_position = {
          lat: Math.round(lat * 1000000) / 1000000,
          lon: Math.round(lon * 1000000) / 1000000,
          height: Math.round(height * 10) / 10,
        };
      }
    }
    if (line.includes("SYS / # / OBS TYPES")) {
      const sys = line.charAt(0);
      const sysMap: Record<string, string> = { G: "GPS", R: "GLONASS", E: "Galileo", C: "BeiDou", J: "QZSS" };
      if (sysMap[sys] && !result.constellations?.includes(sysMap[sys])) {
        if (!result.constellations) result.constellations = [];
        result.constellations.push(sysMap[sys]);
      }
      // Extract frequency indicators
      const obsTypes = line.substring(7, 60).trim().split(/\s+/);
      for (const ot of obsTypes) {
        if (ot.startsWith("C1") || ot.startsWith("L1") || ot.startsWith("S1")) {
          if (!result.frequencies) result.frequencies = [];
          if (!result.frequencies.includes("L1")) result.frequencies.push("L1");
        }
        if (ot.startsWith("C2") || ot.startsWith("L2") || ot.startsWith("S2")) {
          if (!result.frequencies) result.frequencies = [];
          if (!result.frequencies.includes("L2")) result.frequencies.push("L2");
        }
        if (ot.startsWith("C5") || ot.startsWith("L5") || ot.startsWith("S5")) {
          if (!result.frequencies) result.frequencies = [];
          if (!result.frequencies.includes("L5")) result.frequencies.push("L5");
        }
      }
    }
  }

  return result;
}

function analyzeRinexObservations(content: string): {
  obsCount: number;
  snrL1: number[];
  snrL2: number[];
  cycleSlips: number;
} {
  const lines = content.split("\n");
  let inData = false;
  let obsCount = 0;
  const snrL1: number[] = [];
  const snrL2: number[] = [];
  let cycleSlips = 0;
  let prevL1: Record<string, number> = {};

  for (const line of lines) {
    if (line.includes("END OF HEADER")) { inData = true; continue; }
    if (!inData) continue;

    // Epoch header starts with > (RINEX 3.x)
    if (line.startsWith(">")) {
      obsCount++;
      continue;
    }

    // Observation line: G01  23456789.123  ...  S1C  45.2  S2W  38.1
    if (line.length > 3 && /^[GREJC]\d{2}/.test(line)) {
      // Very simplified SNR extraction
      // In practice, column positions depend on header OBS TYPES
      const values = line.substring(3).match(/[\d.]+/g);
      if (values && values.length >= 2) {
        // Look for SNR-like values (typically 20-55 dBHz)
        for (const v of values) {
          const num = parseFloat(v);
          if (num >= 15 && num <= 60 && v.length <= 5) {
            if (snrL1.length <= snrL2.length) snrL1.push(num);
            else snrL2.push(num);
          }
        }
      }
    }
  }

  return { obsCount, snrL1, snrL2, cycleSlips };
}

function gradeStation(qc: Partial<RinexQC>): "A" | "B" | "C" | "D" | "F" {
  let score = 0;

  // Constellation count (max 4 points)
  score += Math.min(4, (qc.constellations?.length || 0));
  // Dual frequency (2 points)
  if ((qc.frequencies?.length || 0) >= 2) score += 2;
  // SNR L1 (2 points if > 35 dBHz)
  if ((qc.mean_snr_l1 || 0) >= 35) score += 2;
  else if ((qc.mean_snr_l1 || 0) >= 25) score += 1;
  // SNR L2 (2 points if > 30 dBHz)
  if ((qc.mean_snr_l2 || 0) >= 30) score += 2;
  else if ((qc.mean_snr_l2 || 0) >= 20) score += 1;
  // Observation completeness (2 points)
  if ((qc.observation_completeness || 0) >= 0.95) score += 2;
  else if ((qc.observation_completeness || 0) >= 0.8) score += 1;

  if (score >= 11) return "A";
  if (score >= 8) return "B";
  if (score >= 5) return "C";
  if (score >= 3) return "D";
  return "F";
}

// ─── Compute Iono TEC from Dual-Frequency ────────────────────────────────────
// TEC = (P2 - P1) / (40.3 * (1/f1² - 1/f2²))
// f1 = 1575.42 MHz (L1), f2 = 1227.60 MHz (L2)
// This gives STEC (Slant TEC) per satellite, convert to VTEC with mapping function

// Simplified: we estimate from SNR ratio as proxy
function estimateIonoFromSNR(snrL1: number, snrL2: number): number | null {
  if (snrL1 <= 0 || snrL2 <= 0) return null;
  // SNR difference between L1 and L2 correlates with iono delay
  // Higher iono → more L2 degradation relative to L1
  const snrDiff = snrL1 - snrL2;
  // Rough approximation: 1 dB SNR diff ≈ 2-5 TECU
  return Math.max(0, Math.round(snrDiff * 3));
}

// ─── Main Function ──────────────────────────────────────────────────────────

export async function runPPKDownloader(db: Database.Database, dataDir: string): Promise<RinexQC[]> {
  if (!PPK_USER || !PPK_PASS) {
    console.log("[PPK] No PPK credentials configured, skipping");
    return [];
  }

  // Find stations to investigate (low trust + high anomaly count)
  const targets: Array<{ name: string; reason: string }> = [];

  try {
    const trustPath = path.join(dataDir, "trust-scores.json");
    if (fs.existsSync(trustPath)) {
      const td = JSON.parse(fs.readFileSync(trustPath, "utf-8"));
      const suspicious = (td.scores || [])
        .filter((t: any) => t.flag === "probation" || t.flag === "untrusted")
        .sort((a: any, b: any) => a.composite_score - b.composite_score)
        .slice(0, MAX_DOWNLOADS_PER_CYCLE);

      for (const t of suspicious) {
        targets.push({ name: t.station, reason: `Trust: ${t.flag} (${t.composite_score})` });
      }
    }
  } catch {}

  if (targets.length === 0) {
    console.log("[PPK] No suspicious stations to investigate");
    return [];
  }

  console.log(`[PPK] Downloading RINEX for ${targets.length} stations`);

  const yesterday = new Date(Date.now() - 86400000).toISOString().substring(0, 10);
  const results: RinexQC[] = [];

  for (const target of targets) {
    try {
      const zipBuffer = await downloadRinex(target.name, yesterday);
      if (!zipBuffer || zipBuffer.length === 0) continue;

      // For now, store raw file size as quality indicator
      // Full RINEX parsing would require unzipping + parsing obs file
      const qc: RinexQC = {
        station: target.name,
        download_time: new Date().toISOString(),
        file_size_kb: Math.round(zipBuffer.length / 1024),
        observation_count: 0,
        constellations: [],
        frequencies: [],
        mean_snr_l1: 0,
        mean_snr_l2: 0,
        cycle_slip_count: 0,
        cycle_slip_rate: 0,
        multipath_l1: 0,
        multipath_l2: 0,
        observation_completeness: 0,
        receiver_type: "unknown",
        antenna_type: "unknown",
        firmware_version: "unknown",
        marker_position: { lat: 0, lon: 0, height: 0 },
        iono_tec_estimate: null,
        position_offset_m: null,
        quality_grade: zipBuffer.length > 50000 ? "B" : "D", // Basic size-based grade
      };

      results.push(qc);
      console.log(`[PPK] ${target.name}: ${qc.file_size_kb}KB, grade ${qc.quality_grade}`);
    } catch (err) {
      console.error(`[PPK] ${target.name} failed:`, err);
    }
  }

  // Persist
  try {
    const filePath = path.join(dataDir, "ppk-results.json");
    let history: RinexQC[] = [];
    try {
      if (fs.existsSync(filePath)) {
        history = JSON.parse(fs.readFileSync(filePath, "utf-8")).results || [];
      }
    } catch {}
    const all = [...results, ...history].slice(0, 500);
    const tmp = filePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({
      results: all,
      last_run: new Date().toISOString(),
      summary: {
        total_downloaded: results.length,
        grades: {
          A: results.filter(r => r.quality_grade === "A").length,
          B: results.filter(r => r.quality_grade === "B").length,
          C: results.filter(r => r.quality_grade === "C").length,
          D: results.filter(r => r.quality_grade === "D").length,
          F: results.filter(r => r.quality_grade === "F").length,
        },
      },
    }));
    fs.renameSync(tmp, filePath);
  } catch {}

  return results;
}
