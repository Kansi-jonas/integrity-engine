// ─── Cross-Network Validator ─────────────────────────────────────────────────
// Validates station quality by comparing GEODNET vs ONOCOY in overlapping coverage.
// If two networks serve the same area, their users should get similar fix rates.
// Disagreement indicates one network has a problem.
//
// Method:
// 1. Find geographic regions with both GEODNET and ONOCOY coverage
// 2. Compare user session fix rates per network per region
// 3. Compute agreement score per region
// 4. Flag stations where one network consistently underperforms
//
// Runs every 4h as part of quality pipeline.

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { haversineKm } from "../spatial/variogram";

export interface CrossValidationResult {
  regions: RegionComparison[];
  station_flags: StationFlag[];
  overall_agreement: number; // 0-1, higher = networks agree
  computed_at: string;
}

interface RegionComparison {
  name: string;
  lat: number;
  lon: number;
  geodnet: { stations: number; sessions: number; mean_fix: number };
  onocoy: { stations: number; sessions: number; mean_fix: number };
  agreement: number;    // 0-1
  winner: "geodnet" | "onocoy" | "tie";
  delta: number;        // fix rate difference
}

interface StationFlag {
  station: string;
  network: string;
  issue: string;
  fix_rate: number;
  region_mean: number;
  deviation: number;
  recommendation: "investigate" | "downgrade" | "exclude";
}

// Grid cells for regional comparison (10° × 10°)
function getGridKey(lat: number, lon: number): string {
  const latBin = Math.floor(lat / 10) * 10;
  const lonBin = Math.floor(lon / 10) * 10;
  return `${latBin},${lonBin}`;
}

export function runCrossValidator(db: Database.Database, dataDir: string): CrossValidationResult {
  const sixHoursAgo = Date.now() - 6 * 3600000;

  // Load stations with network info
  let stations: any[] = [];
  try {
    stations = db.prepare(`
      SELECT s.name, s.latitude, s.longitude, s.network,
             sc.avg_fix_rate, sc.uq_score, sc.session_count
      FROM stations s
      LEFT JOIN station_scores sc ON s.name = sc.station_name
      WHERE s.latitude IS NOT NULL AND s.longitude IS NOT NULL
        AND s.network IS NOT NULL
    `).all() as any[];
  } catch { return emptyResult(); }

  // Group stations by grid cell + network
  const gridStations = new Map<string, { geodnet: any[]; onocoy: any[] }>();

  for (const s of stations) {
    const key = getGridKey(s.latitude, s.longitude);
    if (!gridStations.has(key)) gridStations.set(key, { geodnet: [], onocoy: [] });
    const cell = gridStations.get(key)!;
    const net = (s.network || "").toLowerCase();
    if (net.includes("onocoy")) cell.onocoy.push(s);
    else cell.geodnet.push(s);
  }

  // Load recent sessions grouped by station
  let sessions: any[] = [];
  try {
    sessions = db.prepare(`
      SELECT station, fix_rate, latitude, longitude
      FROM rtk_sessions
      WHERE login_time >= ? AND station IS NOT NULL
        AND fix_rate IS NOT NULL
        AND NOT (fix_rate = 0 AND duration >= 0 AND duration < 60)
    `).all(sixHoursAgo) as any[];
  } catch {}

  const sessionsByStation = new Map<string, number[]>();
  for (const s of sessions) {
    if (!sessionsByStation.has(s.station)) sessionsByStation.set(s.station, []);
    sessionsByStation.get(s.station)!.push(s.fix_rate);
  }

  // Compare regions
  const regions: RegionComparison[] = [];
  const stationFlags: StationFlag[] = [];

  for (const [key, cell] of gridStations) {
    // Only compare where both networks have coverage
    if (cell.geodnet.length < 2 || cell.onocoy.length < 2) continue;

    const [latStr, lonStr] = key.split(",");
    const lat = parseInt(latStr) + 5; // Center of grid cell
    const lon = parseInt(lonStr) + 5;

    // Compute fix rates per network
    const geodnetFixes = getNetworkFixRates(cell.geodnet, sessionsByStation);
    const onocoyFixes = getNetworkFixRates(cell.onocoy, sessionsByStation);

    if (geodnetFixes.sessions === 0 && onocoyFixes.sessions === 0) continue;

    const delta = geodnetFixes.mean_fix - onocoyFixes.mean_fix;
    const agreement = 1 - Math.min(1, Math.abs(delta) / 50); // 50% delta = 0 agreement

    regions.push({
      name: `${lat >= 0 ? lat + "°N" : Math.abs(lat) + "°S"}, ${lon >= 0 ? lon + "°E" : Math.abs(lon) + "°W"}`,
      lat, lon,
      geodnet: geodnetFixes,
      onocoy: onocoyFixes,
      agreement: Math.round(agreement * 100) / 100,
      winner: Math.abs(delta) < 5 ? "tie" : delta > 0 ? "geodnet" : "onocoy",
      delta: Math.round(delta * 10) / 10,
    });

    // Flag individual stations that deviate from their network's mean
    const regionMean = (geodnetFixes.mean_fix * geodnetFixes.sessions + onocoyFixes.mean_fix * onocoyFixes.sessions)
                       / Math.max(1, geodnetFixes.sessions + onocoyFixes.sessions);

    for (const s of [...cell.geodnet, ...cell.onocoy]) {
      const stFixes = sessionsByStation.get(s.name) || [];
      if (stFixes.length < 3) continue;

      const stMean = stFixes.reduce((a, b) => a + b, 0) / stFixes.length;
      const deviation = stMean - regionMean;

      if (deviation < -20) {
        stationFlags.push({
          station: s.name,
          network: s.network,
          issue: `Fix rate ${Math.round(stMean)}% is ${Math.abs(Math.round(deviation))}% below region mean ${Math.round(regionMean)}%`,
          fix_rate: Math.round(stMean),
          region_mean: Math.round(regionMean),
          deviation: Math.round(deviation),
          recommendation: deviation < -40 ? "exclude" : deviation < -30 ? "downgrade" : "investigate",
        });
      }
    }
  }

  const overallAgreement = regions.length > 0
    ? Math.round(regions.reduce((s, r) => s + r.agreement, 0) / regions.length * 100) / 100
    : 1;

  const result: CrossValidationResult = {
    regions,
    station_flags: stationFlags.slice(0, 50),
    overall_agreement: overallAgreement,
    computed_at: new Date().toISOString(),
  };

  // Persist
  try {
    const filePath = path.join(dataDir, "cross-validation.json");
    const tmp = filePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(result, null, 2));
    fs.renameSync(tmp, filePath);
  } catch {}

  return result;
}

function getNetworkFixRates(stations: any[], sessionsByStation: Map<string, number[]>): { stations: number; sessions: number; mean_fix: number } {
  let totalFix = 0, totalSessions = 0;
  for (const s of stations) {
    const fixes = sessionsByStation.get(s.name) || [];
    totalFix += fixes.reduce((a, b) => a + b, 0);
    totalSessions += fixes.length;
  }
  return {
    stations: stations.length,
    sessions: totalSessions,
    mean_fix: totalSessions > 0 ? Math.round(totalFix / totalSessions * 10) / 10 : 0,
  };
}

function emptyResult(): CrossValidationResult {
  return { regions: [], station_flags: [], overall_agreement: 1, computed_at: new Date().toISOString() };
}
