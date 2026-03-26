// ─── Multipath Detector ──────────────────────────────────────────────────────
// Detects multipath from Code-Minus-Carrier (CMC) divergence.
//
// CMC = C1 - L1 (pseudorange minus carrier phase in meters)
// Multipath appears as systematic bias that varies with satellite elevation.
// High CMC at HIGH elevation = bad antenna installation (near reflectors).
// High CMC at LOW elevation only = normal (ground reflection).
//
// Thresholds (from research_depin_integrity_filter.md):
//   <0.3m: excellent (survey-grade level)
//   0.3-0.5m: good
//   0.5-1.0m: acceptable (typical good F9P)
//   1.0-2.0m: poor (bad installation)
//   >2.0m: unusable

import { RinexEpoch } from "./rinex-parser";

const C = 299792458;
const GPS_L1 = 1575.42e6;

export interface MultipathResult {
  mp1_rms: number;          // L1 multipath RMS in meters
  mp2_rms: number;          // L2 multipath RMS in meters
  quality: "excellent" | "good" | "acceptable" | "poor" | "unusable";
  elevation_profile: ElevationBin[];
  satellites_analyzed: number;
  epochs_analyzed: number;
  high_elevation_multipath: boolean;  // TRUE = bad antenna siting
}

interface ElevationBin {
  elevation_min: number;
  elevation_max: number;
  cmc_rms: number;
  samples: number;
}

/**
 * Detect multipath from Code-Minus-Carrier analysis.
 * Note: Without elevation data in RINEX observations, we estimate from SNR.
 * Higher SNR generally correlates with higher elevation.
 */
export function detectMultipath(epochs: RinexEpoch[]): MultipathResult {
  if (epochs.length < 10) {
    return emptyResult();
  }

  // Collect CMC values per satellite
  const cmcBySat = new Map<string, { cmc: number; snr: number }[]>();

  for (const epoch of epochs) {
    for (const sat of epoch.satellites) {
      // Get C1 (pseudorange) and L1 (carrier phase)
      const C1 = sat.observations["C1C"] || sat.observations["C1W"] || sat.observations["C1X"];
      const L1 = sat.observations["L1C"] || sat.observations["L1W"] || sat.observations["L1X"];
      const S1 = sat.observations["S1C"] || sat.observations["S1W"] || sat.observations["S1X"];

      if (!C1 || !L1) continue;

      // Convert L1 from cycles to meters
      const lambda1 = C / GPS_L1;
      const L1m = L1 * lambda1;

      // CMC = C1 - L1 (meters) — note: includes ambiguity, but RMS removes constant
      const cmc = C1 - L1m;
      const snr = S1 || 30; // Default SNR if missing

      if (!cmcBySat.has(sat.prn)) cmcBySat.set(sat.prn, []);
      cmcBySat.get(sat.prn)!.push({ cmc, snr });
    }
  }

  if (cmcBySat.size === 0) return emptyResult();

  // Compute MP1 per satellite (remove mean to eliminate ambiguity)
  const allResiduals: { residual: number; snr: number }[] = [];

  for (const [prn, values] of cmcBySat) {
    if (values.length < 5) continue;

    const mean = values.reduce((s, v) => s + v.cmc, 0) / values.length;
    for (const v of values) {
      const residual = v.cmc - mean;
      allResiduals.push({ residual, snr: v.snr });
    }
  }

  if (allResiduals.length === 0) return emptyResult();

  // Overall MP1 RMS
  const mp1_rms = Math.sqrt(allResiduals.reduce((s, r) => s + r.residual ** 2, 0) / allResiduals.length);

  // MP2: try L2 if available
  let mp2_rms = mp1_rms; // Approximate if L2 not available
  const cmcL2BySat = new Map<string, number[]>();

  for (const epoch of epochs) {
    for (const sat of epoch.satellites) {
      const C2 = sat.observations["C2W"] || sat.observations["C2C"] || sat.observations["C2X"] || sat.observations["C5Q"];
      const L2 = sat.observations["L2W"] || sat.observations["L2C"] || sat.observations["L2X"] || sat.observations["L5Q"];
      if (!C2 || !L2) continue;

      const lambda2 = C / 1227.60e6;
      const cmc2 = C2 - L2 * lambda2;

      if (!cmcL2BySat.has(sat.prn)) cmcL2BySat.set(sat.prn, []);
      cmcL2BySat.get(sat.prn)!.push(cmc2);
    }
  }

  if (cmcL2BySat.size > 0) {
    const l2Residuals: number[] = [];
    for (const values of cmcL2BySat.values()) {
      if (values.length < 5) continue;
      const mean = values.reduce((s, v) => s + v, 0) / values.length;
      for (const v of values) l2Residuals.push(v - mean);
    }
    if (l2Residuals.length > 0) {
      mp2_rms = Math.sqrt(l2Residuals.reduce((s, r) => s + r ** 2, 0) / l2Residuals.length);
    }
  }

  // Elevation bins using SNR as proxy (higher SNR ≈ higher elevation)
  // SNR bins: <25 (low elev), 25-35, 35-45, >45 (high elev)
  const bins: ElevationBin[] = [
    { elevation_min: 5, elevation_max: 20, cmc_rms: 0, samples: 0 },
    { elevation_min: 20, elevation_max: 40, cmc_rms: 0, samples: 0 },
    { elevation_min: 40, elevation_max: 60, cmc_rms: 0, samples: 0 },
    { elevation_min: 60, elevation_max: 90, cmc_rms: 0, samples: 0 },
  ];

  const binResiduals: number[][] = [[], [], [], []];

  for (const r of allResiduals) {
    let binIdx: number;
    if (r.snr < 25) binIdx = 0;
    else if (r.snr < 35) binIdx = 1;
    else if (r.snr < 45) binIdx = 2;
    else binIdx = 3;
    binResiduals[binIdx].push(r.residual);
  }

  for (let i = 0; i < bins.length; i++) {
    bins[i].samples = binResiduals[i].length;
    if (binResiduals[i].length > 0) {
      bins[i].cmc_rms = Math.round(
        Math.sqrt(binResiduals[i].reduce((s, r) => s + r ** 2, 0) / binResiduals[i].length) * 1000
      ) / 1000;
    }
  }

  // High-elevation multipath = bad antenna siting
  const highElevMP = bins[3].cmc_rms;
  const lowElevMP = bins[0].cmc_rms;
  const highElevMultipath = highElevMP > 0.5 && (lowElevMP === 0 || highElevMP / Math.max(lowElevMP, 0.01) > 0.5);

  // Quality classification
  let quality: MultipathResult["quality"];
  if (mp1_rms < 0.3) quality = "excellent";
  else if (mp1_rms < 0.5) quality = "good";
  else if (mp1_rms < 1.0) quality = "acceptable";
  else if (mp1_rms < 2.0) quality = "poor";
  else quality = "unusable";

  return {
    mp1_rms: Math.round(mp1_rms * 1000) / 1000,
    mp2_rms: Math.round(mp2_rms * 1000) / 1000,
    quality,
    elevation_profile: bins,
    satellites_analyzed: cmcBySat.size,
    epochs_analyzed: epochs.length,
    high_elevation_multipath: highElevMultipath,
  };
}

function emptyResult(): MultipathResult {
  return {
    mp1_rms: 0, mp2_rms: 0, quality: "excellent",
    elevation_profile: [], satellites_analyzed: 0, epochs_analyzed: 0,
    high_elevation_multipath: false,
  };
}
