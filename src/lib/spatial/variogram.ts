// ─── Variogram Analysis ──────────────────────────────────────────────────────
// Computes empirical variogram from spatial observations and fits a parametric model.
// The variogram γ(h) describes how spatial correlation decays with distance.
//
// Used by Kriging to determine optimal interpolation weights.
//
// γ(h) = (1/2N(h)) × Σ [Z(x_i) - Z(x_j)]²
//   where N(h) = number of pairs at distance h
//
// Models:
//   Spherical:   γ(h) = c₀ + c₁ × [1.5(h/a) - 0.5(h/a)³]  for h ≤ a, else c₀+c₁
//   Exponential: γ(h) = c₀ + c₁ × [1 - exp(-3h/a)]
//   Gaussian:    γ(h) = c₀ + c₁ × [1 - exp(-3(h/a)²)]
//
// Parameters: c₀ = nugget, c₁ = partial sill, a = range

export interface SpatialPoint {
  lat: number;
  lon: number;
  value: number;
}

export interface VariogramBin {
  distance: number;     // Center of distance bin (km)
  semivariance: number; // γ(h) for this bin
  count: number;        // Number of pairs in bin
}

export interface VariogramModel {
  type: "spherical" | "exponential" | "gaussian";
  nugget: number;       // c₀ — random variation at zero distance
  sill: number;         // c₀ + c₁ — total variance
  range: number;        // a — distance where correlation drops to ~5%
  bins: VariogramBin[];
  r_squared: number;    // Goodness of fit
}

/**
 * Haversine distance between two points in kilometers.
 */
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Compute empirical variogram from spatial observations.
 * @param points Array of {lat, lon, value}
 * @param nBins Number of distance bins (default 15)
 * @param maxDist Maximum distance to consider in km (default: auto)
 */
export function computeEmpiricalVariogram(
  points: SpatialPoint[],
  nBins = 15,
  maxDist?: number
): VariogramBin[] {
  if (points.length < 3) return [];

  // Compute all pairwise distances and squared differences
  const pairs: Array<{ dist: number; sqDiff: number }> = [];
  const n = Math.min(points.length, 500); // Cap at 500 to keep O(n²) manageable

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dist = haversineKm(points[i].lat, points[i].lon, points[j].lat, points[j].lon);
      const sqDiff = (points[i].value - points[j].value) ** 2;
      pairs.push({ dist, sqDiff });
    }
  }

  if (pairs.length === 0) return [];

  // Determine max distance
  const actualMax = maxDist || Math.max(...pairs.map(p => p.dist)) * 0.5; // Use half of max distance
  const binWidth = actualMax / nBins;

  // Bin pairs
  const bins: VariogramBin[] = [];
  for (let b = 0; b < nBins; b++) {
    const lo = b * binWidth;
    const hi = (b + 1) * binWidth;
    const binPairs = pairs.filter(p => p.dist >= lo && p.dist < hi);

    if (binPairs.length >= 3) { // Need at least 3 pairs per bin
      const semivariance = binPairs.reduce((s, p) => s + p.sqDiff, 0) / (2 * binPairs.length);
      bins.push({
        distance: (lo + hi) / 2,
        semivariance,
        count: binPairs.length,
      });
    }
  }

  return bins;
}

/**
 * Fit a variogram model to empirical bins using weighted least squares.
 */
export function fitVariogram(
  bins: VariogramBin[],
  modelType: "spherical" | "exponential" | "gaussian" = "exponential"
): VariogramModel {
  if (bins.length < 3) {
    return { type: modelType, nugget: 0, sill: 1, range: 100, bins, r_squared: 0 };
  }

  // Initial estimates
  const maxSV = Math.max(...bins.map(b => b.semivariance));
  const minSV = Math.min(...bins.map(b => b.semivariance));
  const maxDist = Math.max(...bins.map(b => b.distance));

  let bestNugget = minSV * 0.5;
  let bestSill = maxSV;
  let bestRange = maxDist * 0.4;
  let bestR2 = -Infinity;

  // Grid search for best parameters
  const nuggetRange = [0, minSV * 0.25, minSV * 0.5, minSV * 0.75, minSV];
  const sillRange = [maxSV * 0.5, maxSV * 0.75, maxSV, maxSV * 1.25, maxSV * 1.5];
  const rangeRange = [maxDist * 0.15, maxDist * 0.25, maxDist * 0.35, maxDist * 0.5, maxDist * 0.7];

  for (const n of nuggetRange) {
    for (const s of sillRange) {
      for (const r of rangeRange) {
        if (s <= n) continue; // sill must be > nugget

        const r2 = computeR2(bins, modelType, n, s, r);
        if (r2 > bestR2) {
          bestR2 = r2;
          bestNugget = n;
          bestSill = s;
          bestRange = r;
        }
      }
    }
  }

  return {
    type: modelType,
    nugget: Math.round(bestNugget * 1000) / 1000,
    sill: Math.round(bestSill * 1000) / 1000,
    range: Math.round(bestRange * 10) / 10,
    bins,
    r_squared: Math.round(bestR2 * 1000) / 1000,
  };
}

function computeR2(
  bins: VariogramBin[],
  model: string,
  nugget: number,
  sill: number,
  range: number
): number {
  const mean = bins.reduce((s, b) => s + b.semivariance, 0) / bins.length;
  let ssRes = 0, ssTot = 0;

  for (const bin of bins) {
    const predicted = evaluateModel(model, bin.distance, nugget, sill, range);
    ssRes += (bin.semivariance - predicted) ** 2;
    ssTot += (bin.semivariance - mean) ** 2;
  }

  return ssTot === 0 ? 0 : 1 - ssRes / ssTot;
}

/**
 * Evaluate variogram model at distance h.
 */
export function evaluateModel(
  model: string,
  h: number,
  nugget: number,
  sill: number,
  range: number
): number {
  if (h === 0) return 0; // By convention

  const c1 = sill - nugget; // Partial sill

  switch (model) {
    case "spherical":
      if (h >= range) return sill;
      const hr = h / range;
      return nugget + c1 * (1.5 * hr - 0.5 * hr ** 3);

    case "exponential":
      return nugget + c1 * (1 - Math.exp(-3 * h / range));

    case "gaussian":
      return nugget + c1 * (1 - Math.exp(-3 * (h / range) ** 2));

    default:
      return nugget + c1 * (1 - Math.exp(-3 * h / range));
  }
}
