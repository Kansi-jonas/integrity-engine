// ─── Quality Surface Generator ───────────────────────────────────────────────
// Orchestrates the spatial statistics pipeline:
// 1. Extract station quality observations
// 2. Compute empirical variogram
// 3. Fit variogram model
// 4. Run Kriging interpolation on grid
// 5. Compute Moran's I for spatial clustering
// 6. Generate GeoJSON for map visualization
//
// Output: quality-surface.json with grid predictions, variogram, Moran's I

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { SpatialPoint, computeEmpiricalVariogram, fitVariogram, VariogramModel } from "./variogram";
import { krigingGrid, KrigingResult } from "./kriging";
import { computeMoranI, MoranResult } from "./moran";

export interface QualitySurface {
  grid: KrigingResult[];
  variogram: VariogramModel;
  moran: MoranResult;
  stats: {
    n_stations: number;
    mean_quality: number;
    std_quality: number;
    coverage_area_km2: number;
  };
  regions: RegionSummary[];
  computed_at: string;
}

interface RegionSummary {
  name: string;
  lat_center: number;
  lon_center: number;
  mean_predicted: number;
  mean_variance: number;
  moran_type: string;
  n_points: number;
}

const REGIONS: Record<string, { lat: number; lon: number; radius: number }> = {
  "EU Central": { lat: 50, lon: 10, radius: 15 },
  "EU West": { lat: 48, lon: -2, radius: 12 },
  "EU North": { lat: 60, lon: 15, radius: 12 },
  "US East": { lat: 38, lon: -78, radius: 15 },
  "US West": { lat: 38, lon: -118, radius: 15 },
  "US Central": { lat: 40, lon: -95, radius: 12 },
  "Australia": { lat: -28, lon: 135, radius: 20 },
  "South America": { lat: -15, lon: -50, radius: 20 },
};

/**
 * Run the full spatial quality pipeline.
 */
export function computeQualitySurface(db: Database.Database, dataDir: string): QualitySurface {
  // 1. Extract station quality observations
  const points = extractStationQuality(db);

  if (points.length < 10) {
    const empty: QualitySurface = {
      grid: [],
      variogram: { type: "exponential", nugget: 0, sill: 1, range: 100, bins: [], r_squared: 0 },
      moran: { global_I: 0, expected_I: 0, z_score: 0, p_value: 1, interpretation: "random", local: [] },
      stats: { n_stations: points.length, mean_quality: 0, std_quality: 0, coverage_area_km2: 0 },
      regions: [],
      computed_at: new Date().toISOString(),
    };
    persist(empty, dataDir);
    return empty;
  }

  // 2. Compute variogram per region (for scalability)
  // Use all points for global variogram
  const globalPoints = points.slice(0, 500); // Cap for variogram
  const bins = computeEmpiricalVariogram(globalPoints, 15, 500); // max 500km
  const variogram = fitVariogram(bins, "exponential");

  // 3. Kriging grid (2° resolution globally, 1° where data is dense)
  const grid = krigingGrid(points, variogram, 2);

  // 4. Moran's I
  const moran = computeMoranI(points, 100);

  // 5. Region summaries
  const regions: RegionSummary[] = [];
  for (const [name, def] of Object.entries(REGIONS)) {
    const regionPoints = grid.filter(g =>
      Math.abs(g.lat - def.lat) < def.radius && Math.abs(g.lon - def.lon) < def.radius
    );
    if (regionPoints.length > 0) {
      const localMoran = moran.local.filter(l =>
        Math.abs(l.lat - def.lat) < def.radius && Math.abs(l.lon - def.lon) < def.radius
      );
      const dominantType = localMoran.length > 0
        ? mode(localMoran.map(l => l.cluster_type))
        : "not-significant";

      regions.push({
        name,
        lat_center: def.lat,
        lon_center: def.lon,
        mean_predicted: Math.round(regionPoints.reduce((s, p) => s + p.predicted, 0) / regionPoints.length * 10) / 10,
        mean_variance: Math.round(regionPoints.reduce((s, p) => s + p.variance, 0) / regionPoints.length * 1000) / 1000,
        moran_type: dominantType,
        n_points: regionPoints.length,
      });
    }
  }

  // 6. Stats
  const mean = points.reduce((s, p) => s + p.value, 0) / points.length;
  const std = Math.sqrt(points.reduce((s, p) => s + (p.value - mean) ** 2, 0) / points.length);

  const result: QualitySurface = {
    grid,
    variogram,
    moran: { ...moran, local: moran.local.slice(0, 50) }, // Cap local results for JSON size
    stats: {
      n_stations: points.length,
      mean_quality: Math.round(mean * 10) / 10,
      std_quality: Math.round(std * 10) / 10,
      coverage_area_km2: grid.length * 200 * 200, // Rough estimate based on grid cells
    },
    regions,
    computed_at: new Date().toISOString(),
  };

  persist(result, dataDir);
  return result;
}

function extractStationQuality(db: Database.Database): SpatialPoint[] {
  try {
    const rows = db.prepare(`
      SELECT s.name, s.latitude, s.longitude,
             COALESCE(sc.avg_fix_rate, 0) as fix_rate,
             COALESCE(sc.uq_score, 0) as uq
      FROM stations s
      LEFT JOIN station_scores sc ON s.name = sc.station_name
      WHERE s.latitude IS NOT NULL AND s.longitude IS NOT NULL
        AND s.latitude != 0 AND s.longitude != 0
        AND COALESCE(sc.avg_fix_rate, 0) > 0
    `).all() as any[];

    return rows.map(r => ({
      lat: r.latitude,
      lon: r.longitude,
      value: r.fix_rate,
    }));
  } catch {
    return [];
  }
}

function persist(surface: QualitySurface, dataDir: string) {
  try {
    const filePath = path.join(dataDir, "quality-surface.json");
    const tmp = filePath + ".tmp";
    // Reduce grid size for JSON (only include non-trivial predictions)
    const trimmed = {
      ...surface,
      grid: surface.grid.filter(g => g.confidence !== "low" || g.n_stations >= 3),
    };
    fs.writeFileSync(tmp, JSON.stringify(trimmed, null, 2));
    fs.renameSync(tmp, filePath);
  } catch {}
}

function mode(arr: string[]): string {
  const counts = new Map<string, number>();
  for (const v of arr) counts.set(v, (counts.get(v) || 0) + 1);
  let maxV = "", maxC = 0;
  for (const [v, c] of counts) { if (c > maxC) { maxV = v; maxC = c; } }
  return maxV;
}
