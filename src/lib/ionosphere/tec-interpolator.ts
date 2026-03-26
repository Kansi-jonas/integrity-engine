// ─── TEC Interpolator ────────────────────────────────────────────────────────
// Bilinear interpolation of VTEC at any (lat, lon) from IGS GIM grid.
// Computes spatial TEC gradient (dTEC/dx, dTEC/dy) — the actual driver of RTK degradation.
//
// Key insight: It's not the absolute TEC that matters for RTK, it's the GRADIENT.
// A uniform TEC of 50 TECU is fine (differential corrections cancel it).
// A gradient of >10 TECU/degree means corrections from a station 50km away are wrong.

import { IonexMap } from "./ionex-parser";

export interface TecResult {
  vtec: number;          // VTEC in TECU at the queried point
  gradient_ns: number;   // dTEC/dlat in TECU/degree (North-South gradient)
  gradient_ew: number;   // dTEC/dlon in TECU/degree (East-West gradient)
  gradient_total: number; // sqrt(ns² + ew²) — total gradient magnitude
  quality: "nominal" | "elevated" | "degraded" | "storm";
}

/**
 * Interpolate VTEC at (lat, lon) from an IONEX TEC map using bilinear interpolation.
 */
export function interpolateTec(map: IonexMap, lat: number, lon: number): TecResult {
  const { grid, lat_start, lat_step, lon_start, lon_step } = map;

  if (grid.length === 0 || grid[0].length === 0) {
    return { vtec: 0, gradient_ns: 0, gradient_ew: 0, gradient_total: 0, quality: "nominal" };
  }

  // Clamp coordinates to grid bounds
  const nLat = grid.length;
  const nLon = grid[0].length;

  // Convert lat/lon to fractional grid indices
  const latIdx = (lat - lat_start) / lat_step;
  const lonIdx = (lon - lon_start) / lon_step;

  // Clamp to valid range
  const i0 = Math.max(0, Math.min(nLat - 2, Math.floor(latIdx)));
  const j0 = Math.max(0, Math.min(nLon - 2, Math.floor(lonIdx)));
  const i1 = i0 + 1;
  const j1 = j0 + 1;

  // Fractional parts
  const fi = Math.max(0, Math.min(1, latIdx - i0));
  const fj = Math.max(0, Math.min(1, lonIdx - j0));

  // Bilinear interpolation
  const v00 = grid[i0]?.[j0] ?? 0;
  const v01 = grid[i0]?.[j1] ?? 0;
  const v10 = grid[i1]?.[j0] ?? 0;
  const v11 = grid[i1]?.[j1] ?? 0;

  const vtec = v00 * (1 - fi) * (1 - fj) +
               v01 * (1 - fi) * fj +
               v10 * fi * (1 - fj) +
               v11 * fi * fj;

  // Compute gradients (TECU per degree)
  // North-South gradient: difference along latitude
  const gradient_ns = Math.abs(lat_step) > 0
    ? ((v10 + v11) / 2 - (v00 + v01) / 2) / Math.abs(lat_step)
    : 0;

  // East-West gradient: difference along longitude
  const gradient_ew = Math.abs(lon_step) > 0
    ? ((v01 + v11) / 2 - (v00 + v10) / 2) / Math.abs(lon_step)
    : 0;

  const gradient_total = Math.sqrt(gradient_ns ** 2 + gradient_ew ** 2);

  // Quality classification based on gradient (from research_integrity_compute.md)
  // <2 TECU/deg: nominal, 2-5: elevated, 5-10: degraded, >10: storm
  let quality: TecResult["quality"];
  if (gradient_total < 2) quality = "nominal";
  else if (gradient_total < 5) quality = "elevated";
  else if (gradient_total < 10) quality = "degraded";
  else quality = "storm";

  return {
    vtec: Math.round(vtec * 10) / 10,
    gradient_ns: Math.round(gradient_ns * 100) / 100,
    gradient_ew: Math.round(gradient_ew * 100) / 100,
    gradient_total: Math.round(gradient_total * 100) / 100,
    quality,
  };
}

/**
 * Generate a TEC grid for map visualization.
 * Returns array of {lat, lon, vtec, gradient, quality} for rendering as heatmap.
 */
export function generateTecGrid(map: IonexMap, resolution = 5): Array<{
  lat: number; lon: number; vtec: number; gradient: number; quality: string;
}> {
  const points: Array<{ lat: number; lon: number; vtec: number; gradient: number; quality: string }> = [];

  for (let lat = -85; lat <= 85; lat += resolution) {
    for (let lon = -180; lon <= 180; lon += resolution) {
      const result = interpolateTec(map, lat, lon);
      if (result.vtec > 0) {
        points.push({
          lat, lon,
          vtec: result.vtec,
          gradient: result.gradient_total,
          quality: result.quality,
        });
      }
    }
  }

  return points;
}

/**
 * Compute ionospheric error contribution to positioning sigma.
 * For dual-frequency RTK, the iono error is baseline-dependent:
 *   σ_iono ≈ gradient × baseline_km × 0.001 (meters)
 * For single-frequency: σ_iono ≈ 0.4 × VTEC / f² (much larger)
 */
export function ionoErrorSigma(vtec: number, gradientTecu: number, baselineKm: number, dualFreq = true): number {
  if (dualFreq) {
    // Dual-frequency: residual iono after differencing ≈ gradient × baseline
    return gradientTecu * baselineKm * 0.001; // meters
  } else {
    // Single-frequency: approximate iono delay
    const f1 = 1575.42; // L1 frequency in MHz
    return 0.4 * vtec / (f1 * f1) * 1e6; // meters (rough)
  }
}
