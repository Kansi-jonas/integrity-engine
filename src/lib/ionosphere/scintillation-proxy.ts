// ─── Scintillation Proxy ─────────────────────────────────────────────────────
// Derives S4-like scintillation index from TEC temporal variability.
// Real S4 requires 50Hz signal amplitude data (we don't have this).
// But TEC rate of change (ROT) correlates strongly with scintillation.
//
// ROT = dTEC/dt in TECU/min
// High ROT in equatorial regions (±20° magnetic lat) → likely scintillation
// High ROT in auroral regions (>60° lat) during storms → polar scintillation
//
// Reference: Basu et al. 1999, Pi et al. 1997

import { IonexMap } from "./ionex-parser";
import { interpolateTec } from "./tec-interpolator";

export interface ScintillationRisk {
  lat: number;
  lon: number;
  rot: number;           // Rate of TEC change (TECU/min)
  s4_proxy: number;      // Estimated S4 index [0-1]
  risk: "none" | "low" | "moderate" | "high" | "severe";
  type: "equatorial" | "auroral" | "mid-latitude";
}

/**
 * Compute scintillation risk from two consecutive TEC maps.
 * The Rate of TEC (ROT) between epochs indicates ionospheric turbulence.
 */
export function computeScintillationRisk(
  mapPrev: IonexMap,
  mapCurr: IonexMap,
  kpIndex: number,
  samplePoints?: Array<{ lat: number; lon: number }>
): ScintillationRisk[] {
  const results: ScintillationRisk[] = [];
  const dtMinutes = (mapCurr.epoch.getTime() - mapPrev.epoch.getTime()) / 60000;
  if (dtMinutes <= 0) return results;

  // Default sample points: global grid at 10° resolution
  const points = samplePoints || generateSampleGrid(10);

  for (const p of points) {
    const tecPrev = interpolateTec(mapPrev, p.lat, p.lon);
    const tecCurr = interpolateTec(mapCurr, p.lat, p.lon);

    const rot = Math.abs(tecCurr.vtec - tecPrev.vtec) / dtMinutes;

    // Determine geomagnetic region
    const magLat = approximateMagneticLat(p.lat, p.lon);
    let type: ScintillationRisk["type"];
    if (Math.abs(magLat) <= 20) type = "equatorial";
    else if (Math.abs(magLat) >= 60) type = "auroral";
    else type = "mid-latitude";

    // S4 proxy estimation
    // Equatorial: S4 correlates with ROT more strongly
    // Auroral: S4 correlates with Kp and ROT
    let s4_proxy: number;
    if (type === "equatorial") {
      s4_proxy = Math.min(1, rot * 0.15); // Higher sensitivity
    } else if (type === "auroral") {
      s4_proxy = Math.min(1, rot * 0.1 + (kpIndex > 5 ? 0.2 : 0));
    } else {
      s4_proxy = Math.min(1, rot * 0.05); // Mid-lat: low risk unless extreme
    }

    // Risk classification
    let risk: ScintillationRisk["risk"];
    if (s4_proxy < 0.1) risk = "none";
    else if (s4_proxy < 0.3) risk = "low";
    else if (s4_proxy < 0.5) risk = "moderate";
    else if (s4_proxy < 0.7) risk = "high";
    else risk = "severe";

    // Only report non-trivial risks
    if (risk !== "none") {
      results.push({
        lat: p.lat,
        lon: p.lon,
        rot: Math.round(rot * 1000) / 1000,
        s4_proxy: Math.round(s4_proxy * 100) / 100,
        risk,
        type,
      });
    }
  }

  return results;
}

/**
 * Approximate magnetic latitude from geographic coordinates.
 * Uses tilted dipole approximation (IGRF simplified).
 * North magnetic pole ~86.5°N, 164°W (2025 approximate).
 */
function approximateMagneticLat(geoLat: number, geoLon: number): number {
  const poleLat = 86.5 * Math.PI / 180;
  const poleLon = -164 * Math.PI / 180;
  const lat = geoLat * Math.PI / 180;
  const lon = geoLon * Math.PI / 180;

  const sinMagLat = Math.sin(lat) * Math.sin(poleLat) +
                    Math.cos(lat) * Math.cos(poleLat) * Math.cos(lon - poleLon);

  return Math.asin(Math.max(-1, Math.min(1, sinMagLat))) * 180 / Math.PI;
}

function generateSampleGrid(resolution: number): Array<{ lat: number; lon: number }> {
  const points: Array<{ lat: number; lon: number }> = [];
  for (let lat = -80; lat <= 80; lat += resolution) {
    for (let lon = -180; lon <= 175; lon += resolution) {
      points.push({ lat, lon });
    }
  }
  return points;
}
