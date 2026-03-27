// ─── Zone Builder ────────────────────────────────────────────────────────────
// Generates Alberding-compatible zones from H3 quality cells.
//
// Pipeline: H3 Quality Cells → Cluster → Boundary → Simplify → Alberding Config
//
// The key insight: quality cells tell us WHERE coverage is good/degraded.
// Zone Builder turns that into actionable caster configuration.
//
// For each region with good coverage:
// 1. Find contiguous H3 cells with full_rtk or degraded_rtk tier
// 2. Cluster them into zones (connected component analysis)
// 3. Generate boundary polygon (convex/concave hull)
// 4. Assign stations to zones by proximity + trust
// 5. Set priorities (GEODNET primary, ONOCOY gap-fill)
// 6. Output: zone definitions ready for Config Engine

import Database from "better-sqlite3";
import * as h3 from "h3-js";
import fs from "fs";
import path from "path";
import { haversineKm } from "./spatial/variogram";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface GeneratedZone {
  id: string;
  name: string;
  zone_tier: "full_rtk" | "degraded_rtk" | "float_dgps";
  network: "geodnet" | "onocoy" | "multi";
  priority: number;
  geofence_type: "circle" | "polygon";
  geofence: {
    circle?: { lat: number; lon: number; radius_m: number };
    polygon?: { points: [number, number][] }; // [lat, lon][]
  };
  cells: string[];           // H3 cell indices in this zone
  stations: string[];        // Station names assigned to this zone
  avg_quality: number;
  min_quality: number;
  station_count: number;
  area_km2: number;
  enabled: boolean;
}

export interface ZoneBuildResult {
  zones: GeneratedZone[];
  stats: {
    total_cells: number;
    cells_in_zones: number;
    zones_created: number;
    full_rtk_zones: number;
    degraded_zones: number;
    coverage_area_km2: number;
  };
  computed_at: string;
}

// ─── Configuration ───────────────────────────────────────────────────────────

const MIN_CELLS_PER_ZONE = 3;          // Minimum H3 cells to form a zone
const MAX_POLYGON_POINTS = 40;          // Alberding limit for polygon vertices
const ZONE_BUFFER_KM = 5;              // Buffer around zone boundary
const STATION_ASSIGNMENT_RADIUS = 50;   // km, max distance to assign station to zone

// Priority scheme (lower = higher priority in Alberding)
const PRIORITY = {
  geodnet_full: 1,        // Best: GEODNET in full RTK area
  geodnet_degraded: 10,   // GEODNET in degraded area
  onocoy_full: 20,        // ONOCOY in full RTK area (gap-fill)
  onocoy_degraded: 30,    // ONOCOY in degraded area
  fallback: 50,           // Last resort
};

// ─── Core Function ──────────────────────────────────────────────────────────

export function buildZonesFromQuality(db: Database.Database, dataDir: string): ZoneBuildResult {
  // 1. Load quality cells
  const cells = loadQualityCells(db);
  if (cells.length === 0) {
    return emptyResult();
  }

  // 2. Filter to actionable tiers (full_rtk and degraded_rtk)
  const actionableCells = cells.filter(c =>
    c.zone_tier === "full_rtk" || c.zone_tier === "degraded_rtk"
  );

  if (actionableCells.length === 0) {
    return emptyResult();
  }

  // 3. Cluster contiguous cells into zones
  const clusters = clusterCells(actionableCells);

  // 4. Generate zone definitions from clusters
  const stations = loadStationsWithTrust(db, dataDir);
  const zones: GeneratedZone[] = [];
  let zoneIdx = 0;

  for (const cluster of clusters) {
    if (cluster.length < MIN_CELLS_PER_ZONE) continue;

    // Determine dominant tier
    const fullCount = cluster.filter(c => c.zone_tier === "full_rtk").length;
    const degradedCount = cluster.filter(c => c.zone_tier === "degraded_rtk").length;
    const dominantTier = fullCount >= degradedCount ? "full_rtk" : "degraded_rtk";

    // Generate boundary
    const boundary = generateBoundary(cluster);
    if (!boundary) continue;

    // Find center
    const centerLat = cluster.reduce((s, c) => s + c.lat, 0) / cluster.length;
    const centerLon = cluster.reduce((s, c) => s + c.lon, 0) / cluster.length;

    // Assign stations to this zone
    const zoneStations = assignStations(centerLat, centerLon, boundary, stations);

    // Determine network
    const geodnetStations = zoneStations.filter(s => s.network === "geodnet");
    const onocoyStations = zoneStations.filter(s => s.network === "onocoy");
    let network: "geodnet" | "onocoy" | "multi" = "geodnet";
    if (geodnetStations.length > 0 && onocoyStations.length > 0) network = "multi";
    else if (onocoyStations.length > 0 && geodnetStations.length === 0) network = "onocoy";

    // Priority based on tier + network
    let priority = PRIORITY.fallback;
    if (dominantTier === "full_rtk" && network !== "onocoy") priority = PRIORITY.geodnet_full;
    else if (dominantTier === "full_rtk" && network === "onocoy") priority = PRIORITY.onocoy_full;
    else if (dominantTier === "degraded_rtk" && network !== "onocoy") priority = PRIORITY.geodnet_degraded;
    else if (dominantTier === "degraded_rtk") priority = PRIORITY.onocoy_degraded;

    // Quality stats
    const qualities = cluster.map(c => c.quality_score);
    const avgQuality = qualities.reduce((s, q) => s + q, 0) / qualities.length;
    const minQuality = Math.min(...qualities);

    // Area estimate (~73 km² per H3 res-5 cell)
    const areaKm2 = cluster.length * 73;

    // Zone name
    const regionName = getRegionName(centerLat, centerLon);
    const tierLabel = dominantTier === "full_rtk" ? "RTK" : "Degraded";
    const networkLabel = network === "multi" ? "" : ` ${network.toUpperCase()}`;

    zoneIdx++;
    zones.push({
      id: `zone_${zoneIdx}`,
      name: `${regionName} ${tierLabel}${networkLabel} #${zoneIdx}`,
      zone_tier: dominantTier as any,
      network,
      priority,
      geofence_type: boundary.type,
      geofence: boundary.type === "circle"
        ? { circle: boundary.circle }
        : { polygon: { points: boundary.polygon! } },
      cells: cluster.map(c => c.h3_index),
      stations: zoneStations.map(s => s.name),
      avg_quality: Math.round(avgQuality * 100) / 100,
      min_quality: Math.round(minQuality * 100) / 100,
      station_count: zoneStations.length,
      area_km2: Math.round(areaKm2),
      enabled: true,
    });
  }

  // Sort by priority
  zones.sort((a, b) => a.priority - b.priority);

  const result: ZoneBuildResult = {
    zones,
    stats: {
      total_cells: cells.length,
      cells_in_zones: zones.reduce((s, z) => s + z.cells.length, 0),
      zones_created: zones.length,
      full_rtk_zones: zones.filter(z => z.zone_tier === "full_rtk").length,
      degraded_zones: zones.filter(z => z.zone_tier === "degraded_rtk").length,
      coverage_area_km2: zones.reduce((s, z) => s + z.area_km2, 0),
    },
    computed_at: new Date().toISOString(),
  };

  // Persist
  persistZones(result, db, dataDir);

  return result;
}

// ─── Load Quality Cells ──────────────────────────────────────────────────────

interface CellRow {
  h3_index: string;
  quality_score: number;
  zone_tier: string;
  nearest_station: string;
  nearest_station_km: number;
  lat: number;
  lon: number;
}

function loadQualityCells(db: Database.Database): CellRow[] {
  try {
    const rows = db.prepare(`
      SELECT h3_index, quality_score, zone_tier, nearest_station, nearest_station_km
      FROM quality_cells
      WHERE quality_score > 0
    `).all() as any[];

    return rows.map(r => {
      const [lat, lon] = h3.cellToLatLng(r.h3_index);
      return { ...r, lat, lon };
    });
  } catch {
    return [];
  }
}

// ─── Cluster Contiguous Cells ────────────────────────────────────────────────
// Connected component analysis: cells sharing an H3 edge are in the same cluster.

function clusterCells(cells: CellRow[]): CellRow[][] {
  const cellMap = new Map<string, CellRow>();
  for (const c of cells) cellMap.set(c.h3_index, c);

  const visited = new Set<string>();
  const clusters: CellRow[][] = [];

  for (const cell of cells) {
    if (visited.has(cell.h3_index)) continue;

    // BFS from this cell
    const cluster: CellRow[] = [];
    const queue: string[] = [cell.h3_index];
    visited.add(cell.h3_index);

    while (queue.length > 0) {
      const current = queue.shift()!;
      const currentCell = cellMap.get(current);
      if (currentCell) cluster.push(currentCell);

      // Check neighbors (H3 k-ring 1 = 6 adjacent cells)
      try {
        const neighbors = h3.gridDisk(current, 1);
        for (const nb of neighbors) {
          if (nb === current) continue;
          if (visited.has(nb)) continue;
          if (cellMap.has(nb)) {
            visited.add(nb);
            queue.push(nb);
          }
        }
      } catch {}
    }

    if (cluster.length > 0) clusters.push(cluster);
  }

  return clusters;
}

// ─── Generate Boundary ──────────────────────────────────────────────────────

interface Boundary {
  type: "circle" | "polygon";
  circle?: { lat: number; lon: number; radius_m: number };
  polygon?: [number, number][]; // [lat, lon][]
}

function generateBoundary(cells: CellRow[]): Boundary | null {
  if (cells.length === 0) return null;

  const centerLat = cells.reduce((s, c) => s + c.lat, 0) / cells.length;
  const centerLon = cells.reduce((s, c) => s + c.lon, 0) / cells.length;

  // For small clusters (< 7 cells), use a circle
  if (cells.length < 7) {
    const maxDist = Math.max(...cells.map(c => haversineKm(centerLat, centerLon, c.lat, c.lon)));
    const radius = (maxDist + ZONE_BUFFER_KM) * 1000; // meters
    return {
      type: "circle",
      circle: { lat: Math.round(centerLat * 1e6) / 1e6, lon: Math.round(centerLon * 1e6) / 1e6, radius_m: Math.round(radius) },
    };
  }

  // For larger clusters: use outer boundary of H3 cell union
  // This preserves concavities (bays, inlets) unlike convex hull
  // Strategy: collect all cell boundary edges, keep only outer edges (not shared between cells)
  const cellSet = new Set(cells.map(c => c.h3_index));
  const outerPoints: [number, number][] = [];

  for (const cell of cells) {
    try {
      const boundary = h3.cellToBoundary(cell.h3_index);
      // Check each edge: if the neighboring cell across that edge is NOT in our cluster,
      // this is an outer edge → include its points
      const neighbors = h3.gridDisk(cell.h3_index, 1).filter(n => n !== cell.h3_index);
      const hasExternalNeighbor = neighbors.some(n => !cellSet.has(n));

      if (hasExternalNeighbor) {
        // This cell is on the border — add its boundary points
        for (const [lat, lon] of boundary) {
          outerPoints.push([lat, lon]);
        }
      }
    } catch {}
  }

  if (outerPoints.length < 3) {
    // Fallback: use all cell centers as convex hull
    const fallbackPoints = cells.map(c => [c.lat, c.lon] as [number, number]);
    const hull = convexHull(fallbackPoints);
    if (hull.length < 3) return null;
    return { type: "polygon", polygon: simplifyPolygon(hull, MAX_POLYGON_POINTS) };
  }

  // Use convex hull of outer points (preserves shape better than full convex hull)
  // because we already filtered to border cells only
  const hull = convexHull(outerPoints);
  if (hull.length < 3) return null;

  // Simplify to max points for Alberding
  const simplified = simplifyPolygon(hull, MAX_POLYGON_POINTS);

  // Add small buffer (scale from center)
  const buffered = simplified.map(([lat, lon]) => {
    const dist = haversineKm(centerLat, centerLon, lat, lon);
    const scale = dist > 0 ? (dist + ZONE_BUFFER_KM) / dist : 1;
    return [
      Math.round((centerLat + (lat - centerLat) * scale) * 1e6) / 1e6,
      Math.round((centerLon + (lon - centerLon) * scale) * 1e6) / 1e6,
    ] as [number, number];
  });

  return { type: "polygon", polygon: buffered };
}

// ─── Convex Hull (Graham Scan) ──────────────────────────────────────────────

function convexHull(points: [number, number][]): [number, number][] {
  if (points.length <= 3) return points;

  // Find lowest point (min lat, then min lon)
  let pivot = 0;
  for (let i = 1; i < points.length; i++) {
    if (points[i][0] < points[pivot][0] ||
        (points[i][0] === points[pivot][0] && points[i][1] < points[pivot][1])) {
      pivot = i;
    }
  }
  [points[0], points[pivot]] = [points[pivot], points[0]];

  const p0 = points[0];
  const sorted = points.slice(1).sort((a, b) => {
    const angleA = Math.atan2(a[0] - p0[0], a[1] - p0[1]);
    const angleB = Math.atan2(b[0] - p0[0], b[1] - p0[1]);
    return angleA - angleB;
  });

  const stack: [number, number][] = [p0];
  for (const pt of sorted) {
    while (stack.length > 1) {
      const top = stack[stack.length - 1];
      const second = stack[stack.length - 2];
      const cross = (top[1] - second[1]) * (pt[0] - second[0]) -
                    (top[0] - second[0]) * (pt[1] - second[1]);
      if (cross <= 0) stack.pop();
      else break;
    }
    stack.push(pt);
  }

  return stack;
}

// ─── Simplify Polygon (Ramer-Douglas-Peucker) ──────────────────────────────

function simplifyPolygon(points: [number, number][], maxPoints: number): [number, number][] {
  if (points.length <= maxPoints) return points;

  let epsilon = 0.001; // Start with small tolerance
  let result = rdp(points, epsilon);

  // Increase tolerance until we're under maxPoints
  while (result.length > maxPoints && epsilon < 1) {
    epsilon *= 1.5;
    result = rdp(points, epsilon);
  }

  return result;
}

function rdp(points: [number, number][], epsilon: number): [number, number][] {
  if (points.length <= 2) return points;

  let maxDist = 0;
  let maxIdx = 0;
  const start = points[0];
  const end = points[points.length - 1];

  for (let i = 1; i < points.length - 1; i++) {
    const dist = pointLineDistance(points[i], start, end);
    if (dist > maxDist) {
      maxDist = dist;
      maxIdx = i;
    }
  }

  if (maxDist > epsilon) {
    const left = rdp(points.slice(0, maxIdx + 1), epsilon);
    const right = rdp(points.slice(maxIdx), epsilon);
    return [...left.slice(0, -1), ...right];
  }

  return [start, end];
}

function pointLineDistance(point: [number, number], lineStart: [number, number], lineEnd: [number, number]): number {
  const dx = lineEnd[1] - lineStart[1];
  const dy = lineEnd[0] - lineStart[0];
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0) return Math.sqrt((point[1] - lineStart[1]) ** 2 + (point[0] - lineStart[0]) ** 2);
  return Math.abs(dy * point[1] - dx * point[0] + lineEnd[1] * lineStart[0] - lineEnd[0] * lineStart[1]) / len;
}

// ─── Station Assignment ─────────────────────────────────────────────────────

interface StationWithTrust {
  name: string;
  latitude: number;
  longitude: number;
  network: string;
  trust: number;
  uq_score: number;
}

function loadStationsWithTrust(db: Database.Database, dataDir: string): StationWithTrust[] {
  // Load trust scores
  const trustMap = new Map<string, number>();
  try {
    const trustPath = path.join(dataDir, "trust-scores.json");
    if (fs.existsSync(trustPath)) {
      const data = JSON.parse(fs.readFileSync(trustPath, "utf-8"));
      for (const s of (data.scores || [])) {
        trustMap.set(s.station, s.composite_score ?? s.combined_score ?? s.trust_score ?? 0.5);
      }
    }
  } catch {}

  try {
    return db.prepare(`
      SELECT s.name, s.latitude, s.longitude, COALESCE(s.network, 'unknown') as network,
             COALESCE(sc.uq_score, 0) as uq_score
      FROM stations s
      LEFT JOIN station_scores sc ON s.name = sc.station_name
      WHERE s.latitude IS NOT NULL AND s.longitude IS NOT NULL
        AND s.status IN ('ONLINE', 'ACTIVE')
        AND COALESCE(sc.uq_score, 0) >= 0.3
    `).all().map((s: any) => ({
      ...s,
      trust: trustMap.get(s.name) || 0.5,
    })) as StationWithTrust[];
  } catch {
    return [];
  }
}

function assignStations(
  centerLat: number, centerLon: number,
  boundary: Boundary,
  allStations: StationWithTrust[]
): StationWithTrust[] {
  // Find stations within assignment radius of zone center
  return allStations
    .filter(s => {
      const dist = haversineKm(centerLat, centerLon, s.latitude, s.longitude);
      return dist <= STATION_ASSIGNMENT_RADIUS;
    })
    .filter(s => s.trust >= 0.4) // Minimum trust for zone inclusion
    .sort((a, b) => {
      // Sort by: trust descending, then distance ascending
      if (Math.abs(b.trust - a.trust) > 0.1) return b.trust - a.trust;
      const distA = haversineKm(centerLat, centerLon, a.latitude, a.longitude);
      const distB = haversineKm(centerLat, centerLon, b.latitude, b.longitude);
      return distA - distB;
    })
    .slice(0, 20); // Max 20 stations per zone
}

// ─── Region Name Helper ─────────────────────────────────────────────────────

function getRegionName(lat: number, lon: number): string {
  // Simple region naming based on coordinates
  if (lat > 55 && lon > -10 && lon < 30) return "Northern Europe";
  if (lat > 45 && lat <= 55 && lon > -10 && lon < 20) return "Central Europe";
  if (lat > 35 && lat <= 45 && lon > -10 && lon < 20) return "Southern Europe";
  if (lat > 35 && lat <= 55 && lon >= 20 && lon < 45) return "Eastern Europe";
  if (lat > 25 && lat <= 50 && lon > -130 && lon < -60) return "North America";
  if (lat > -10 && lat <= 25 && lon > -120 && lon < -60) return "Central America";
  if (lat > -60 && lat <= -10 && lon > -80 && lon < -30) return "South America";
  if (lat > -45 && lat <= -10 && lon > 110 && lon < 180) return "Australia";
  if (lat > 20 && lat <= 50 && lon > 60 && lon < 140) return "Asia";
  if (lat > -10 && lat <= 20 && lon > 90 && lon < 140) return "Southeast Asia";
  if (lat > -40 && lat <= 35 && lon > -20 && lon < 55) return "Africa";
  return `Region ${Math.round(lat)}N ${Math.round(lon)}E`;
}

// ─── Persist Zones ──────────────────────────────────────────────────────────

function persistZones(result: ZoneBuildResult, db: Database.Database, dataDir: string) {
  const now = Date.now();

  // Write to zone_definitions table
  try {
    const tx = db.transaction(() => {
      // Only delete non-manual zones
      db.prepare(`DELETE FROM zone_definitions WHERE manual_override = 0`).run();

      const stmt = db.prepare(`
        INSERT OR REPLACE INTO zone_definitions
        (id, name, zone_tier, network, priority, geofence_type, geofence_json,
         cell_count, avg_quality, min_quality, area_km2, station_count, enabled, manual_override, computed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
      `);

      for (const z of result.zones) {
        stmt.run(
          z.id, z.name, z.zone_tier, z.network, z.priority,
          z.geofence_type, JSON.stringify(z.geofence),
          z.cells.length, z.avg_quality, z.min_quality, z.area_km2,
          z.station_count, z.enabled ? 1 : 0, now
        );
      }
    });
    tx();
  } catch (err) {
    console.error("[ZONE-BUILDER] DB write failed:", err);
  }

  // Also write JSON for dashboard/API consumption
  try {
    const filePath = path.join(dataDir, "zone-build.json");
    const tmp = filePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(result, null, 2));
    fs.renameSync(tmp, filePath);
  } catch {}
}

function emptyResult(): ZoneBuildResult {
  return {
    zones: [],
    stats: { total_cells: 0, cells_in_zones: 0, zones_created: 0, full_rtk_zones: 0, degraded_zones: 0, coverage_area_km2: 0 },
    computed_at: new Date().toISOString(),
  };
}
