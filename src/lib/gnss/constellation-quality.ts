// ─── Constellation-Aware Quality ─────────────────────────────────────────────
// Models quality impact per GNSS constellation using CelesTrak health data.
// When satellites are unhealthy, PDOP worsens, which increases protection levels.
//
// GPS:      31 satellites, ~8-12 visible at any location
// GLONASS:  24 satellites, ~7-10 visible
// Galileo:  ~28 satellites, ~6-9 visible
// BeiDou:   ~45 satellites, ~10-15 visible (strongest in Asia-Pacific)
//
// Impact: Missing 1 satellite ≈ 5-10% PDOP increase (depends on geometry)
// Missing entire constellation ≈ 30-50% quality degradation

export interface ConstellationImpact {
  constellation: string;
  nominal_sats: number;
  healthy_sats: number;
  unhealthy_sats: number;
  availability_pct: number;    // healthy / nominal
  pdop_degradation_pct: number; // Estimated PDOP increase
  fix_rate_impact_pct: number;  // Estimated fix rate reduction
  recommendation: string;
}

export interface ConstellationQuality {
  impacts: ConstellationImpact[];
  total_impact_pct: number;     // Combined fix rate impact
  pdop_multiplier: number;      // Combined PDOP multiplier (1.0 = nominal)
  sigma_contribution: number;    // Additional sigma for Protection Level (meters)
}

const NOMINAL_COUNTS: Record<string, number> = {
  gps: 31,
  glonass: 24,
  galileo: 28,
  beidou: 45,
};

/**
 * Compute quality impact from constellation health data.
 * @param constellationHealth From CelesTrak (environment.json)
 * @param latitude User latitude (BeiDou coverage is latitude-dependent)
 */
export function computeConstellationQuality(
  constellationHealth: Record<string, { healthy: number; unhealthy: number; total: number; alerts: string[] }>,
  latitude = 50
): ConstellationQuality {
  const impacts: ConstellationImpact[] = [];
  let totalFixImpact = 0;
  let combinedPdopMultiplier = 1.0;

  for (const [name, health] of Object.entries(constellationHealth)) {
    if (name === "total_healthy" || name === "total_unhealthy") continue;
    if (!health || typeof health.healthy !== "number") continue;

    const nominal = NOMINAL_COUNTS[name] || health.total || 30;
    const healthy = health.healthy;
    const unhealthy = health.unhealthy;
    const availability = nominal > 0 ? healthy / nominal : 1;

    // PDOP degradation model (simplified)
    // Each missing satellite increases PDOP by ~3-8% (geometry-dependent)
    const missingSats = Math.max(0, nominal - healthy);
    const pdopDegradation = missingSats * 5; // ~5% per missing satellite

    // Fix rate impact depends on how many satellites are visible
    // GPS has most impact (primary constellation for most receivers)
    let weight = 1.0;
    if (name === "gps") weight = 1.5;  // GPS outage hurts most
    else if (name === "galileo") weight = 1.0;
    else if (name === "glonass") weight = 0.8;
    else if (name === "beidou") weight = Math.abs(latitude) < 60 ? 0.7 : 0.3; // BeiDou less relevant at high latitudes

    const fixImpact = Math.min(30, pdopDegradation * weight * 0.3);
    totalFixImpact += fixImpact;

    const pdopMult = 1 + pdopDegradation / 100;
    combinedPdopMultiplier *= pdopMult;

    let recommendation = "Nominal";
    if (availability < 0.7) recommendation = `${name.toUpperCase()} degraded — ${unhealthy} satellites unhealthy`;
    else if (availability < 0.9) recommendation = `${name.toUpperCase()} reduced — ${missingSats} satellites unavailable`;
    else if (unhealthy > 0) recommendation = `${name.toUpperCase()} minor — ${unhealthy} unhealthy`;

    impacts.push({
      constellation: name,
      nominal_sats: nominal,
      healthy_sats: healthy,
      unhealthy_sats: unhealthy,
      availability_pct: Math.round(availability * 1000) / 10,
      pdop_degradation_pct: Math.round(pdopDegradation * 10) / 10,
      fix_rate_impact_pct: Math.round(fixImpact * 10) / 10,
      recommendation,
    });
  }

  // Sigma contribution for Protection Level
  // PDOP multiplier directly scales position uncertainty
  // Additional sigma = (PDOP_mult - 1) × base_sigma × 0.5
  const sigmaContribution = Math.max(0, (combinedPdopMultiplier - 1) * 0.02); // meters

  return {
    impacts,
    total_impact_pct: Math.round(Math.min(50, totalFixImpact) * 10) / 10,
    pdop_multiplier: Math.round(combinedPdopMultiplier * 1000) / 1000,
    sigma_contribution: Math.round(sigmaContribution * 10000) / 10000,
  };
}
