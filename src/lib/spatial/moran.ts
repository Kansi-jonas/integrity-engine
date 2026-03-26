// ─── Moran's I Spatial Autocorrelation ───────────────────────────────────────
// Tests whether nearby stations have similar quality (positive autocorrelation)
// or dissimilar quality (negative autocorrelation).
//
// Global Moran's I:
//   I = (N / W) × Σᵢ Σⱼ wᵢⱼ(xᵢ - x̄)(xⱼ - x̄) / Σᵢ(xᵢ - x̄)²
//   where wᵢⱼ = spatial weight (1/distance or binary threshold)
//
// I > 0: clustered (similar values near each other) — EXPECTED for GNSS quality
// I ≈ 0: random
// I < 0: dispersed (opposite values near each other) — SUSPICIOUS
//
// Local Moran's I (LISA):
//   Iᵢ = (xᵢ - x̄) × Σⱼ wᵢⱼ(xⱼ - x̄) / Σ(xᵢ - x̄)²
//   Identifies specific hot/cold spots

import { SpatialPoint, haversineKm } from "./variogram";

export interface MoranResult {
  global_I: number;        // Global Moran's I [-1, 1]
  expected_I: number;      // Expected I under random (-1/(N-1))
  z_score: number;         // Standardized z-score
  p_value: number;         // Two-sided p-value
  interpretation: "clustered" | "random" | "dispersed";
  local: LocalMoranResult[];
}

export interface LocalMoranResult {
  lat: number;
  lon: number;
  value: number;
  local_I: number;
  z_score: number;
  cluster_type: "high-high" | "low-low" | "high-low" | "low-high" | "not-significant";
}

/**
 * Compute Global and Local Moran's I.
 * @param points Spatial observations
 * @param distThreshold Distance threshold for spatial weights (km). Default: 100km
 */
export function computeMoranI(
  points: SpatialPoint[],
  distThreshold = 100
): MoranResult {
  const n = Math.min(points.length, 500); // Cap for performance
  const pts = points.slice(0, n);

  if (n < 5) {
    return {
      global_I: 0, expected_I: 0, z_score: 0, p_value: 1,
      interpretation: "random", local: [],
    };
  }

  // Compute mean
  const mean = pts.reduce((s, p) => s + p.value, 0) / n;
  const deviations = pts.map(p => p.value - mean);
  const sumSqDev = deviations.reduce((s, d) => s + d * d, 0);

  if (sumSqDev === 0) {
    return {
      global_I: 0, expected_I: -1 / (n - 1), z_score: 0, p_value: 1,
      interpretation: "random", local: [],
    };
  }

  // Build distance-based weight matrix (binary: 1 if within threshold, 0 otherwise)
  // Using inverse distance weighting within threshold
  const weights: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  let totalW = 0;

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dist = haversineKm(pts[i].lat, pts[i].lon, pts[j].lat, pts[j].lon);
      if (dist > 0 && dist <= distThreshold) {
        const w = 1 / dist;
        weights[i][j] = w;
        weights[j][i] = w;
        totalW += 2 * w;
      }
    }
  }

  if (totalW === 0) {
    return {
      global_I: 0, expected_I: -1 / (n - 1), z_score: 0, p_value: 1,
      interpretation: "random", local: [],
    };
  }

  // Global Moran's I
  let numerator = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      numerator += weights[i][j] * deviations[i] * deviations[j];
    }
  }

  const globalI = (n / totalW) * (numerator / sumSqDev);
  const expectedI = -1 / (n - 1);

  // Variance under normality assumption (simplified)
  const s2 = sumSqDev / n;
  const s4 = pts.reduce((s, p) => s + (p.value - mean) ** 4, 0) / n;
  const b2 = s4 / (s2 * s2);

  // Sum of squared row weights
  let S1 = 0, S2 = 0;
  for (let i = 0; i < n; i++) {
    let rowSum = 0;
    for (let j = 0; j < n; j++) {
      S1 += (weights[i][j] + weights[j][i]) ** 2;
      rowSum += weights[i][j];
    }
    const colSum = weights.reduce((s, row) => s + row[i], 0);
    S2 += (rowSum + colSum) ** 2;
  }
  S1 /= 2;

  const W2 = totalW * totalW;
  const varI = (n * ((n * n - 3 * n + 3) * S1 - n * S2 + 3 * W2) -
                b2 * ((n * n - n) * S1 - 2 * n * S2 + 6 * W2)) /
               ((n - 1) * (n - 2) * (n - 3) * W2) - expectedI * expectedI;

  const zScore = varI > 0 ? (globalI - expectedI) / Math.sqrt(varI) : 0;
  const pValue = 2 * (1 - normalCDF(Math.abs(zScore))); // Two-sided

  let interpretation: MoranResult["interpretation"];
  if (pValue > 0.05) interpretation = "random";
  else if (globalI > 0) interpretation = "clustered";
  else interpretation = "dispersed";

  // Local Moran's I (LISA)
  const localResults: LocalMoranResult[] = [];
  for (let i = 0; i < n; i++) {
    let localNum = 0;
    for (let j = 0; j < n; j++) {
      localNum += weights[i][j] * deviations[j];
    }
    const localI = (deviations[i] / (sumSqDev / n)) * localNum;

    // Classify cluster type
    let clusterType: LocalMoranResult["cluster_type"] = "not-significant";
    const localZ = localI / Math.sqrt(Math.max(varI, 1e-10));

    if (Math.abs(localZ) > 1.96) { // 95% significance
      if (deviations[i] > 0 && localNum > 0) clusterType = "high-high";
      else if (deviations[i] < 0 && localNum < 0) clusterType = "low-low";
      else if (deviations[i] > 0 && localNum < 0) clusterType = "high-low";
      else clusterType = "low-high";
    }

    localResults.push({
      lat: pts[i].lat,
      lon: pts[i].lon,
      value: pts[i].value,
      local_I: Math.round(localI * 1000) / 1000,
      z_score: Math.round(localZ * 100) / 100,
      cluster_type: clusterType,
    });
  }

  return {
    global_I: Math.round(globalI * 1000) / 1000,
    expected_I: Math.round(expectedI * 1000) / 1000,
    z_score: Math.round(zScore * 100) / 100,
    p_value: Math.round(pValue * 10000) / 10000,
    interpretation,
    local: localResults.filter(l => l.cluster_type !== "not-significant"),
  };
}

/**
 * Standard normal CDF approximation (Abramowitz & Stegun).
 */
function normalCDF(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327; // 1/sqrt(2π)
  const p = d * Math.exp(-x * x / 2) *
    t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x > 0 ? 1 - p : p;
}
