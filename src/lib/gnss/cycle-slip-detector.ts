// ─── Cycle Slip Detector ─────────────────────────────────────────────────────
// Detects cycle slips in GNSS carrier phase observations using:
// 1. Melbourne-Wübbena (MW): Wide-lane combination, detects most slips
// 2. Geometry-Free (GF): L1-L2 difference, detects same-integer slips
//
// Cycle slips = discontinuities in carrier phase tracking.
// High cycle slip rate = poor station quality (bad antenna, multipath, interference).
//
// F9P typical: 0.5-5 slips/satellite/hour
// Survey-grade: <0.1 slips/satellite/hour
// Bad station: >10 slips/satellite/hour

import { RinexEpoch } from "./rinex-parser";

// GNSS frequencies (MHz → Hz for computation)
const FREQ = {
  G: { L1: 1575.42e6, L2: 1227.60e6 },  // GPS
  E: { L1: 1575.42e6, L5: 1176.45e6 },   // Galileo (E1, E5a)
  R: { L1: 1602.00e6, L2: 1246.00e6 },   // GLONASS (approximate)
  C: { L1: 1575.42e6, L2: 1207.14e6 },   // BeiDou (B1C, B2a)
};

const C = 299792458; // Speed of light m/s

export interface CycleSlipResult {
  total_slips: number;
  total_satellite_hours: number;
  slip_rate_per_hour: number;           // Slips per satellite-hour
  quality: "excellent" | "good" | "acceptable" | "poor" | "unusable";
  slips_per_constellation: Record<string, { slips: number; sats: number; rate: number }>;
  slip_events: Array<{ prn: string; epoch: number; type: "MW" | "GF"; jump: number }>;
}

/**
 * Detect cycle slips in a sequence of RINEX epochs.
 * Uses Melbourne-Wübbena and Geometry-Free combinations.
 */
export function detectCycleSlips(
  epochs: RinexEpoch[],
  mwThreshold = 2.0,  // MW cycles (2.0 = conservative for F9P)
  gfThreshold = 0.15  // GF meters (ionospheric rate limit)
): CycleSlipResult {
  if (epochs.length < 2) {
    return { total_slips: 0, total_satellite_hours: 0, slip_rate_per_hour: 0, quality: "excellent", slips_per_constellation: {}, slip_events: [] };
  }

  const slipEvents: CycleSlipResult["slip_events"] = [];
  const constellationStats: Record<string, { slips: number; epochs: number; sats: Set<string> }> = {};

  // Track previous MW and GF values per satellite
  const prevMW = new Map<string, number>();
  const prevGF = new Map<string, number>();

  for (let e = 0; e < epochs.length; e++) {
    const epoch = epochs[e];

    for (const sat of epoch.satellites) {
      const sys = sat.constellation;
      const freq = FREQ[sys as keyof typeof FREQ];
      if (!freq) continue;

      // Initialize constellation stats
      if (!constellationStats[sys]) constellationStats[sys] = { slips: 0, epochs: 0, sats: new Set() };
      constellationStats[sys].epochs++;
      constellationStats[sys].sats.add(sat.prn);

      // Get dual-frequency observations
      // Try standard observation codes
      const C1 = sat.observations["C1C"] || sat.observations["C1W"] || sat.observations["C1X"];
      const C2 = sat.observations["C2W"] || sat.observations["C2C"] || sat.observations["C2X"] || sat.observations["C5Q"] || sat.observations["C5X"];
      const L1 = sat.observations["L1C"] || sat.observations["L1W"] || sat.observations["L1X"];
      const L2 = sat.observations["L2W"] || sat.observations["L2C"] || sat.observations["L2X"] || sat.observations["L5Q"] || sat.observations["L5X"];

      if (!C1 || !C2 || !L1 || !L2) continue;

      // Convert carrier phase from cycles to meters
      const f1 = freq.L1;
      const f2 = (freq as any).L2 || (freq as any).L5 || freq.L1;
      const lambda1 = C / f1;
      const lambda2 = C / f2;
      const L1m = L1 * lambda1;
      const L2m = L2 * lambda2;

      // Melbourne-Wübbena combination (cycles)
      // MW = (f1*L1 - f2*L2)/(f1-f2) - (f1*C1 + f2*C2)/(f1+f2)
      const mw = (f1 * L1m - f2 * L2m) / (f1 - f2) / (C / (f1 - f2)) -
                 (f1 * C1 + f2 * C2) / (f1 + f2) / (C / (f1 - f2));

      // Geometry-Free combination (meters)
      // GF = L1 - L2 (removes geometry, isolates iono + ambiguity)
      const gf = L1m - L2m;

      // Check for jumps from previous epoch
      const prevMWval = prevMW.get(sat.prn);
      const prevGFval = prevGF.get(sat.prn);

      if (prevMWval !== undefined) {
        const mwJump = Math.abs(mw - prevMWval);
        if (mwJump > mwThreshold) {
          slipEvents.push({ prn: sat.prn, epoch: e, type: "MW", jump: Math.round(mwJump * 100) / 100 });
          constellationStats[sys].slips++;
        }
      }

      if (prevGFval !== undefined) {
        const gfJump = Math.abs(gf - prevGFval);
        if (gfJump > gfThreshold) {
          // Only count GF if MW didn't already catch it
          const alreadyCaught = slipEvents.some(s => s.prn === sat.prn && s.epoch === e);
          if (!alreadyCaught) {
            slipEvents.push({ prn: sat.prn, epoch: e, type: "GF", jump: Math.round(gfJump * 1000) / 1000 });
            constellationStats[sys].slips++;
          }
        }
      }

      prevMW.set(sat.prn, mw);
      prevGF.set(sat.prn, gf);
    }
  }

  // Compute rates
  const durationHours = epochs.length > 1
    ? (epochs[epochs.length - 1].time.getTime() - epochs[0].time.getTime()) / 3600000
    : 1;

  let totalSlips = 0;
  let totalSatHours = 0;
  const slipsPerConstellation: CycleSlipResult["slips_per_constellation"] = {};

  for (const [sys, stats] of Object.entries(constellationStats)) {
    const satHours = stats.sats.size * durationHours;
    totalSlips += stats.slips;
    totalSatHours += satHours;
    slipsPerConstellation[sys] = {
      slips: stats.slips,
      sats: stats.sats.size,
      rate: satHours > 0 ? Math.round(stats.slips / satHours * 100) / 100 : 0,
    };
  }

  const slipRate = totalSatHours > 0 ? totalSlips / totalSatHours : 0;

  let quality: CycleSlipResult["quality"];
  if (slipRate < 0.1) quality = "excellent";
  else if (slipRate < 1) quality = "good";
  else if (slipRate < 5) quality = "acceptable";
  else if (slipRate < 15) quality = "poor";
  else quality = "unusable";

  return {
    total_slips: totalSlips,
    total_satellite_hours: Math.round(totalSatHours * 100) / 100,
    slip_rate_per_hour: Math.round(slipRate * 100) / 100,
    quality,
    slips_per_constellation: slipsPerConstellation,
    slip_events: slipEvents.slice(0, 100), // Cap for output size
  };
}
