// ─── Ordinary Kriging Interpolation ──────────────────────────────────────────
// Predicts value at unobserved locations using optimal linear interpolation.
// Kriging gives both a prediction AND a prediction variance (uncertainty).
//
// The Kriging system: K × w = k
//   K = variogram matrix between all observation pairs
//   k = variogram vector between query point and all observations
//   w = optimal weights (sum to 1 via Lagrange multiplier)
//
// σ²(x₀) = Σ wᵢ γ(x₀, xᵢ) + μ  (Kriging variance = prediction uncertainty)
//
// Uses ml-matrix for matrix operations. Partitions into regions for scalability.

import { Matrix, solve } from "ml-matrix";
import { SpatialPoint, VariogramModel, evaluateModel, haversineKm } from "./variogram";

export interface KrigingResult {
  lat: number;
  lon: number;
  predicted: number;       // Predicted value
  variance: number;        // Kriging variance (uncertainty)
  confidence: "high" | "medium" | "low";
  n_stations: number;      // Number of stations used
}

/**
 * Ordinary Kriging prediction at a single point.
 * Uses at most `maxNeighbors` nearest stations for computational efficiency.
 */
export function krigingPredict(
  queryLat: number,
  queryLon: number,
  points: SpatialPoint[],
  model: VariogramModel,
  maxNeighbors = 50
): KrigingResult {
  if (points.length === 0) {
    return { lat: queryLat, lon: queryLon, predicted: 0, variance: model.sill, confidence: "low", n_stations: 0 };
  }

  // Find nearest neighbors
  const withDist = points.map(p => ({
    ...p,
    dist: haversineKm(queryLat, queryLon, p.lat, p.lon),
  })).sort((a, b) => a.dist - b.dist);

  const neighbors = withDist.slice(0, Math.min(maxNeighbors, withDist.length));
  const n = neighbors.length;

  if (n === 0) {
    return { lat: queryLat, lon: queryLon, predicted: 0, variance: model.sill, confidence: "low", n_stations: 0 };
  }

  if (n === 1) {
    // Single station: use its value, variance = nugget + model evaluation
    const gamma = evaluateModel(model.type, neighbors[0].dist, model.nugget, model.sill, model.range);
    return {
      lat: queryLat, lon: queryLon,
      predicted: neighbors[0].value,
      variance: gamma,
      confidence: gamma < model.sill * 0.3 ? "high" : "medium",
      n_stations: 1,
    };
  }

  try {
    // Build Kriging system with Lagrange multiplier
    // K is (n+1) × (n+1): variogram between all pairs + Lagrange row/col
    const K = Matrix.zeros(n + 1, n + 1);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dist = haversineKm(neighbors[i].lat, neighbors[i].lon, neighbors[j].lat, neighbors[j].lon);
        const gamma = evaluateModel(model.type, dist, model.nugget, model.sill, model.range);
        K.set(i, j, gamma);
        K.set(j, i, gamma);
      }
      // Diagonal: nugget (measurement error)
      K.set(i, i, 0);
      // Lagrange constraint
      K.set(i, n, 1);
      K.set(n, i, 1);
    }
    K.set(n, n, 0); // Lagrange corner

    // k vector: variogram between query point and each observation
    const k = Matrix.zeros(n + 1, 1);
    for (let i = 0; i < n; i++) {
      const gamma = evaluateModel(model.type, neighbors[i].dist, model.nugget, model.sill, model.range);
      k.set(i, 0, gamma);
    }
    k.set(n, 0, 1); // Lagrange constraint

    // Solve K × w = k
    // Add small ridge for numerical stability
    for (let i = 0; i < n; i++) {
      K.set(i, i, K.get(i, i) + 1e-6);
    }

    const w = solve(K, k);

    // Compute prediction
    let predicted = 0;
    for (let i = 0; i < n; i++) {
      predicted += w.get(i, 0) * neighbors[i].value;
    }

    // Compute Kriging variance
    let variance = 0;
    for (let i = 0; i < n; i++) {
      variance += w.get(i, 0) * k.get(i, 0);
    }
    variance += w.get(n, 0); // Lagrange multiplier contribution
    variance = Math.max(0, variance);

    // Confidence based on variance relative to sill
    const relVar = variance / Math.max(model.sill, 1e-6);
    let confidence: KrigingResult["confidence"];
    if (relVar < 0.3) confidence = "high";
    else if (relVar < 0.7) confidence = "medium";
    else confidence = "low";

    return {
      lat: queryLat,
      lon: queryLon,
      predicted: Math.round(predicted * 100) / 100,
      variance: Math.round(variance * 1000) / 1000,
      confidence,
      n_stations: n,
    };
  } catch {
    // Matrix solve failed (singular) — fall back to inverse-distance weighting
    let sumW = 0, sumWV = 0;
    for (const nb of neighbors) {
      const w = 1 / Math.max(nb.dist, 0.1);
      sumW += w;
      sumWV += w * nb.value;
    }
    return {
      lat: queryLat, lon: queryLon,
      predicted: Math.round((sumWV / sumW) * 100) / 100,
      variance: model.sill * 0.5,
      confidence: "low",
      n_stations: n,
    };
  }
}

/**
 * Kriging on a regular grid. Partitions by region for scalability.
 * @param points All observation points
 * @param model Fitted variogram model
 * @param gridStep Grid resolution in degrees (default 1°)
 * @param bounds Optional bounding box [latMin, latMax, lonMin, lonMax]
 */
export function krigingGrid(
  points: SpatialPoint[],
  model: VariogramModel,
  gridStep = 2,
  bounds?: [number, number, number, number]
): KrigingResult[] {
  if (points.length === 0) return [];

  // Determine bounds from data if not provided
  const latMin = bounds ? bounds[0] : Math.floor(Math.min(...points.map(p => p.lat)) / gridStep) * gridStep;
  const latMax = bounds ? bounds[1] : Math.ceil(Math.max(...points.map(p => p.lat)) / gridStep) * gridStep;
  const lonMin = bounds ? bounds[2] : Math.floor(Math.min(...points.map(p => p.lon)) / gridStep) * gridStep;
  const lonMax = bounds ? bounds[3] : Math.ceil(Math.max(...points.map(p => p.lon)) / gridStep) * gridStep;

  const results: KrigingResult[] = [];

  for (let lat = latMin; lat <= latMax; lat += gridStep) {
    for (let lon = lonMin; lon <= lonMax; lon += gridStep) {
      // Only use nearby points for efficiency (within 2× range)
      const searchRadius = model.range * 2;
      const nearby = points.filter(p => haversineKm(lat, lon, p.lat, p.lon) <= searchRadius);

      if (nearby.length >= 3) {
        const result = krigingPredict(lat, lon, nearby, model, 30);
        results.push(result);
      }
    }
  }

  return results;
}
