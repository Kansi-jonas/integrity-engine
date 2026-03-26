// ─── Tropospheric Delay Model ────────────────────────────────────────────────
// Estimates Zenith Tropospheric Delay (ZTD) from weather data.
// Uses Saastamoinen model for ZHD (hydrostatic) + Hopfield for ZWD (wet).
//
// ZTD = ZHD + ZWD
// ZHD dominates (~2.3m at sea level) and is well-modeled from pressure.
// ZWD (~0.05-0.35m) is variable and depends on humidity.
//
// For RTK, the tropospheric error is the DIFFERENCE between base and rover.
// At short baselines (<20km), tropo cancels mostly.
// At longer baselines (50-100km), tropo can add 5-15mm error.
//
// Formula (Saastamoinen 1972):
//   ZHD = 0.0022768 × P / (1 - 0.00266×cos(2φ) - 0.00028×h)
//   ZWD ≈ 0.002277 × (1255/T + 0.05) × e
//   where P = pressure (hPa), T = temperature (K), e = water vapor pressure (hPa)

export interface TropoResult {
  zhd_m: number;          // Zenith hydrostatic delay (meters)
  zwd_m: number;          // Zenith wet delay (meters)
  ztd_m: number;          // Total zenith delay (meters)
  mapping_factor: number; // Mapping factor at typical 10° elevation
  slant_delay_m: number;  // Delay at 10° elevation (worst case)
  baseline_error_mm: number; // Estimated error contribution for 50km baseline
  risk: "low" | "medium" | "high";
}

/**
 * Compute tropospheric delay from weather observations.
 * @param pressure_hpa Surface pressure in hPa
 * @param temperature_c Surface temperature in °C
 * @param humidity_pct Relative humidity (0-100)
 * @param latitude_deg Station latitude in degrees
 * @param height_m Station height above sea level in meters
 */
export function computeTropoDelay(
  pressure_hpa: number,
  temperature_c: number,
  humidity_pct: number,
  latitude_deg: number,
  height_m: number = 0
): TropoResult {
  const T = temperature_c + 273.15; // Kelvin
  const phi = latitude_deg * Math.PI / 180;

  // Saastamoinen ZHD
  const zhd = 0.0022768 * pressure_hpa /
    (1 - 0.00266 * Math.cos(2 * phi) - 0.00028 * height_m / 1000);

  // Water vapor pressure (Magnus formula)
  const es = 6.1078 * Math.pow(10, (7.5 * temperature_c) / (237.3 + temperature_c));
  const e = (humidity_pct / 100) * es;

  // Saastamoinen ZWD (simplified)
  const zwd = 0.002277 * (1255 / T + 0.05) * e;

  const ztd = zhd + zwd;

  // Niell mapping function at 10° elevation (approximate)
  // At low elevation, delay is ~5-6x the zenith delay
  const elevationRad = 10 * Math.PI / 180;
  const mappingFactor = 1 / (Math.sin(elevationRad) +
    0.00143 / (Math.tan(elevationRad) + 0.0445));

  const slantDelay = ztd * mappingFactor;

  // Estimated baseline error for 50km baseline
  // Rule of thumb: differential tropo error ≈ ZWD_variation × baseline_km / decorrelation_distance
  // Decorrelation distance for wet delay: ~50-100km
  const baselineErrorMm = (zwd * 1000) * (50 / 75) * 0.1; // ~10% of ZWD difference at 50km

  // Risk classification
  let risk: TropoResult["risk"];
  if (zwd < 0.1 && humidity_pct < 60) risk = "low";
  else if (zwd < 0.2 || humidity_pct < 80) risk = "medium";
  else risk = "high";

  return {
    zhd_m: Math.round(zhd * 10000) / 10000,
    zwd_m: Math.round(zwd * 10000) / 10000,
    ztd_m: Math.round(ztd * 10000) / 10000,
    mapping_factor: Math.round(mappingFactor * 100) / 100,
    slant_delay_m: Math.round(slantDelay * 1000) / 1000,
    baseline_error_mm: Math.round(baselineErrorMm * 10) / 10,
    risk,
  };
}

/**
 * Compute tropospheric delay for an array of weather points.
 * Returns delay estimates for each region.
 */
export function computeRegionalTropo(
  regions: Array<{
    name: string;
    lat: number;
    lon: number;
    temperature_c: number;
    humidity_pct: number;
    pressure_hpa: number;
  }>
): Array<{
  name: string;
  lat: number;
  lon: number;
  tropo: TropoResult;
}> {
  return regions.map(r => ({
    name: r.name,
    lat: r.lat,
    lon: r.lon,
    tropo: computeTropoDelay(r.pressure_hpa, r.temperature_c, r.humidity_pct, r.lat),
  }));
}
