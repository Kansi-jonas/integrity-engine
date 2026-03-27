// ─── Coverage Optimizer ──────────────────────────────────────────────────────
// Analyzes H3 quality cells and identifies actions to maximize green hexagons.
//
// Goal: Convert red/orange/yellow cells to green by:
// 1. Finding ONOCOY stations that could cover degraded areas
// 2. Recommending ONOCOY overlays for automatic deployment
// 3. Identifying regions that need new network partners
// 4. Tracking progress over time (% green trend)
//
// This is the "brain" that drives the self-optimizing network.

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { haversineKm } from "../spatial/variogram";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CoverageReport {
  // Overall health
  total_cells: number;
  green_cells: number;       // full_rtk
  yellow_cells: number;      // degraded_rtk
  orange_cells: number;      // float_dgps
  red_cells: number;         // no_coverage
  green_percentage: number;

  // Actionable items
  improvement_actions: ImprovementAction[];

  // Trend
  trend: {
    green_pct_7d_ago: number | null;
    green_pct_now: number;
    improving: boolean;
  };

  computed_at: string;
}

export interface ImprovementAction {
  type: "deploy_onocoy" | "validate_onocoy" | "find_partner" | "investigate";
  priority: "high" | "medium" | "low";
  region: string;
  lat: number;
  lon: number;
  current_quality: number;
  target_quality: number;
  description: string;
  onocoy_station?: string;
  onocoy_hardware?: string;
  estimated_impact_cells: number; // How many cells would improve
}

// ─── Core Function ──────────────────────────────────────────────────────────

export function analyzeCoverageAndOptimize(
  db: Database.Database,
  dataDir: string
): CoverageReport {
  // Load H3 quality cells
  let cells: any[] = [];
  try {
    cells = db.prepare(`
      SELECT h3_index, quality_score, zone_tier, nearest_station, nearest_station_km
      FROM quality_cells WHERE quality_score >= 0
    `).all() as any[];
  } catch { return emptyReport(); }

  if (cells.length === 0) return emptyReport();

  // Count by tier
  const green = cells.filter(c => c.zone_tier === "full_rtk").length;
  const yellow = cells.filter(c => c.zone_tier === "degraded_rtk").length;
  const orange = cells.filter(c => c.zone_tier === "float_dgps").length;
  const red = cells.filter(c => c.zone_tier === "no_coverage").length;
  const greenPct = Math.round(green / cells.length * 1000) / 10;

  // Find degraded cells and check if ONOCOY can help
  const actions: ImprovementAction[] = [];

  // Load ONOCOY stations
  let onocoyStations: any[] = [];
  try {
    onocoyStations = db.prepare(`
      SELECT name, latitude, longitude, receiver_type
      FROM stations WHERE network = 'onocoy' AND status IN ('ONLINE', 'ACTIVE')
        AND latitude IS NOT NULL AND longitude IS NOT NULL
    `).all() as any[];
  } catch {}

  // For each non-green cell: can ONOCOY improve it?
  const nonGreenCells = cells.filter(c => c.zone_tier !== "full_rtk");

  // Group non-green cells into clusters (by 1-degree grid to avoid O(n²))
  const cellClusters = new Map<string, any[]>();
  for (const cell of nonGreenCells) {
    try {
      const h3 = require("h3-js");
      const [lat, lon] = h3.cellToLatLng(cell.h3_index);
      const key = `${Math.round(lat)}:${Math.round(lon)}`;
      if (!cellClusters.has(key)) cellClusters.set(key, []);
      cellClusters.get(key)!.push({ ...cell, lat, lon });
    } catch {}
  }

  // For each cluster: find nearest ONOCOY station
  for (const [key, clusterCells] of cellClusters) {
    if (clusterCells.length < 2) continue; // Skip isolated cells

    const centerLat = clusterCells.reduce((s: number, c: any) => s + c.lat, 0) / clusterCells.length;
    const centerLon = clusterCells.reduce((s: number, c: any) => s + c.lon, 0) / clusterCells.length;
    const avgQuality = clusterCells.reduce((s: number, c: any) => s + c.quality_score, 0) / clusterCells.length;

    // Find nearest ONOCOY station
    let nearestOnocoy: any = null;
    let nearestDist = Infinity;
    for (const ono of onocoyStations) {
      const dist = haversineKm(centerLat, centerLon, ono.latitude, ono.longitude);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearestOnocoy = ono;
      }
    }

    const region = getRegionName(centerLat, centerLon);

    if (nearestOnocoy && nearestDist < 50) {
      // ONOCOY station available — recommend deployment
      const recv = (nearestOnocoy.receiver_type || "").toUpperCase();
      const isSurveyGrade = recv.includes("LEICA") || recv.includes("TRIMBLE") || recv.includes("SEPT") ||
        recv.includes("CHCNAV") || recv.includes("SURVEY_GRADE");

      actions.push({
        type: isSurveyGrade ? "deploy_onocoy" : "validate_onocoy",
        priority: avgQuality < 0.25 ? "high" : avgQuality < 0.50 ? "medium" : "low",
        region,
        lat: Math.round(centerLat * 100) / 100,
        lon: Math.round(centerLon * 100) / 100,
        current_quality: Math.round(avgQuality * 100) / 100,
        target_quality: 0.75,
        description: isSurveyGrade
          ? `Deploy ONOCOY ${nearestOnocoy.name} (${recv}) as overlay — ${nearestDist.toFixed(0)}km from degraded area`
          : `Validate ONOCOY ${nearestOnocoy.name} before deployment — consumer hardware, needs live test`,
        onocoy_station: nearestOnocoy.name,
        onocoy_hardware: recv,
        estimated_impact_cells: clusterCells.length,
      });
    } else if (nearestDist >= 50 || !nearestOnocoy) {
      // No ONOCOY available — need new partner
      actions.push({
        type: "find_partner",
        priority: avgQuality < 0.25 ? "high" : "medium",
        region,
        lat: Math.round(centerLat * 100) / 100,
        lon: Math.round(centerLon * 100) / 100,
        current_quality: Math.round(avgQuality * 100) / 100,
        target_quality: 0.75,
        description: `No ONOCOY coverage — nearest ${nearestDist < 999 ? `${nearestDist.toFixed(0)}km away` : "not found"}. Consider CentipedeRTK, SAPOS, or new partner.`,
        estimated_impact_cells: clusterCells.length,
      });
    }
  }

  // Sort by priority and impact
  actions.sort((a, b) => {
    const priOrder = { high: 0, medium: 1, low: 2 };
    if (priOrder[a.priority] !== priOrder[b.priority]) return priOrder[a.priority] - priOrder[b.priority];
    return b.estimated_impact_cells - a.estimated_impact_cells;
  });

  // Load trend (compare with 7 days ago)
  let greenPct7dAgo: number | null = null;
  try {
    const trendPath = path.join(dataDir, "coverage-trend.json");
    if (fs.existsSync(trendPath)) {
      const trendData = JSON.parse(fs.readFileSync(trendPath, "utf-8"));
      const sevenDaysAgo = Date.now() - 7 * 86400000;
      const oldEntry = (trendData.history || []).find((h: any) => h.timestamp > sevenDaysAgo);
      if (oldEntry) greenPct7dAgo = oldEntry.green_pct;
    }
  } catch {}

  // Save trend data
  try {
    const trendPath = path.join(dataDir, "coverage-trend.json");
    let trendData: any = { history: [] };
    try {
      if (fs.existsSync(trendPath)) trendData = JSON.parse(fs.readFileSync(trendPath, "utf-8"));
    } catch {}
    trendData.history.push({ timestamp: Date.now(), green_pct: greenPct, total: cells.length });
    // Keep last 90 days
    const cutoff = Date.now() - 90 * 86400000;
    trendData.history = trendData.history.filter((h: any) => h.timestamp > cutoff);
    fs.writeFileSync(trendPath + ".tmp", JSON.stringify(trendData, null, 2));
    fs.renameSync(trendPath + ".tmp", trendPath);
  } catch {}

  const report: CoverageReport = {
    total_cells: cells.length,
    green_cells: green,
    yellow_cells: yellow,
    orange_cells: orange,
    red_cells: red,
    green_percentage: greenPct,
    improvement_actions: actions.slice(0, 50), // Top 50 actions
    trend: {
      green_pct_7d_ago: greenPct7dAgo,
      green_pct_now: greenPct,
      improving: greenPct7dAgo !== null ? greenPct > greenPct7dAgo : false,
    },
    computed_at: new Date().toISOString(),
  };

  // Persist
  try {
    const filePath = path.join(dataDir, "coverage-optimizer.json");
    fs.writeFileSync(filePath + ".tmp", JSON.stringify(report, null, 2));
    fs.renameSync(filePath + ".tmp", filePath);
  } catch {}

  return report;
}

function getRegionName(lat: number, lon: number): string {
  if (lat > 55 && lon > -10 && lon < 30) return "Northern Europe";
  if (lat > 45 && lat <= 55 && lon > -10 && lon < 20) return "Central Europe";
  if (lat > 35 && lat <= 45 && lon > -10 && lon < 20) return "Southern Europe";
  if (lat > 25 && lat <= 50 && lon > -130 && lon < -60) return "North America";
  if (lat > -45 && lat <= -10 && lon > 110 && lon < 180) return "Australia";
  if (lat > 20 && lat <= 50 && lon > 60 && lon < 140) return "Asia";
  return `${Math.round(lat)}°N ${Math.round(lon)}°E`;
}

function emptyReport(): CoverageReport {
  return {
    total_cells: 0, green_cells: 0, yellow_cells: 0, orange_cells: 0, red_cells: 0,
    green_percentage: 0, improvement_actions: [],
    trend: { green_pct_7d_ago: null, green_pct_now: 0, improving: false },
    computed_at: new Date().toISOString(),
  };
}
