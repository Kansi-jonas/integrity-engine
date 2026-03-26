// ─── ENVIRONMENT Agent ───────────────────────────────────────────────────────
// Replaces the simple space-weather agent with a comprehensive environment
// monitoring system that pulls from 7+ free external data sources.
//
// Sources:
// 1. NOAA SWPC Kp Index (existing)
// 2. NOAA SWPC Solar Wind Bz (existing)
// 3. Dst Index (Kyoto/NOAA) — magnetic storm severity
// 4. DSCOVR Real-Time Solar Wind — 30-60min storm early warning
// 5. GOES X-Ray Flux — solar flare detection
// 6. CelesTrak — GNSS constellation health (GPS, GLONASS, Galileo, BeiDou)
// 7. NASA DONKI — CME predictions (1-3 day forecast)
// 8. Open-Meteo — tropospheric weather (temperature, humidity, pressure)
// 9. NOAA Tides — for maritime RTK users
//
// Runs every hour. Output: environment.json (replaces space-weather.json)

import fs from "fs";
import path from "path";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface EnvironmentData {
  // Space Weather (Ionosphere)
  ionosphere: {
    kp_index: number;
    kp_forecast_3h: number;
    dst_index: number;              // nT, more negative = stronger storm
    bz_component: number;           // nT, negative = geo coupling
    bt_total: number;               // nT, total IMF
    solar_wind_speed: number;       // km/s
    solar_wind_density: number;     // p/cm³
    xray_flux: number;              // W/m², >1e-5 = M-class flare
    flare_class: string | null;     // "C1.2", "M3.4", "X1.0" etc
    proton_flux: number;            // pfu, >10 = radiation storm
    storm_level: "quiet" | "minor" | "moderate" | "strong" | "severe" | "extreme";
    storm_phase: "quiet" | "initial" | "main" | "recovery";
    expected_fix_impact_pct: number;
    affected_regions: string[];
  };

  // CME Predictions (1-3 day forecast)
  cme_forecast: Array<{
    id: string;
    type: string;            // "C" (coronal), "S" (solar)
    speed_km_s: number;
    expected_arrival: string | null;  // ISO date
    expected_kp: number;
    source: string;
  }>;

  // Constellation Health
  constellation: {
    gps: { healthy: number; unhealthy: number; total: number; alerts: string[] };
    glonass: { healthy: number; unhealthy: number; total: number; alerts: string[] };
    galileo: { healthy: number; unhealthy: number; total: number; alerts: string[] };
    beidou: { healthy: number; unhealthy: number; total: number; alerts: string[] };
    total_healthy: number;
    total_unhealthy: number;
  };

  // Troposphere (regional weather)
  troposphere: {
    regions: Array<{
      name: string;
      lat: number;
      lon: number;
      temperature_c: number;
      humidity_pct: number;
      pressure_hpa: number;
      cloud_cover_pct: number;
      precipitation_mm: number;
      tropo_delay_risk: "low" | "medium" | "high";
    }>;
  };

  // Tides (for maritime zones)
  tides: Array<{
    station: string;
    location: string;
    current_level_m: number;
    prediction_6h: Array<{ time: string; level_m: number }>;
  }>;

  // Ionospheric TEC (from IGS GIM)
  vtec?: {
    grid: Array<{ lat: number; lon: number; vtec: number; gradient: number; quality: string }>;
    scintillation_risks: Array<{ lat: number; lon: number; s4_proxy: number; risk: string; type: string }>;
    epoch: string;
    source: string;
  };

  fetched_at: string;
  sources: string[];
  errors: string[];
}

// ─── Fetch Helper ────────────────────────────────────────────────────────────

async function fetchJson(url: string, timeout = 10000): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url: string, timeout = 10000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// ─── 1. NOAA Kp Index ───────────────────────────────────────────────────────

async function fetchKp(): Promise<{ current: number; forecast: number }> {
  try {
    const data = await fetchJson("https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json");
    const latest = data[data.length - 1];
    const currentKp = parseFloat(latest[1]) || 0;

    let forecastKp = currentKp;
    try {
      const forecast = await fetchJson("https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json");
      const now = new Date();
      for (const row of forecast.slice(1)) {
        if (new Date(row[0]) > now) { forecastKp = parseFloat(row[1]) || currentKp; break; }
      }
    } catch {}

    return { current: currentKp, forecast: forecastKp };
  } catch { return { current: 0, forecast: 0 }; }
}

// ─── 2. DSCOVR Real-Time Solar Wind ─────────────────────────────────────────

async function fetchDSCOVR(): Promise<{ bz: number; bt: number; speed: number; density: number }> {
  try {
    const mag = await fetchJson("https://services.swpc.noaa.gov/products/summary/solar-wind-mag-field.json");
    const plasma = await fetchJson("https://services.swpc.noaa.gov/products/summary/solar-wind-speed.json");
    return {
      bz: parseFloat(mag.Bz) || 0,
      bt: parseFloat(mag.Bt) || 0,
      speed: parseFloat(plasma.WindSpeed) || 0,
      density: parseFloat(plasma.Density) || 0,
    };
  } catch { return { bz: 0, bt: 0, speed: 0, density: 0 }; }
}

// ─── 3. Dst Index ────────────────────────────────────────────────────────────

async function fetchDst(): Promise<number> {
  try {
    // NOAA provides Dst-like data via the planetary K index
    // Alternative: use Kyoto WDC or GFZ
    const data = await fetchJson("https://services.swpc.noaa.gov/products/kyoto-dst.json");
    if (Array.isArray(data) && data.length > 1) {
      const latest = data[data.length - 1];
      return parseFloat(latest[1]) || 0;
    }
    return 0;
  } catch { return 0; }
}

// ─── 4. GOES X-Ray Flux ─────────────────────────────────────────────────────

async function fetchXRay(): Promise<{ flux: number; flareClass: string | null }> {
  try {
    const data = await fetchJson("https://services.swpc.noaa.gov/json/goes/primary/xrays-1-day.json");
    if (Array.isArray(data) && data.length > 0) {
      const latest = data[data.length - 1];
      const flux = latest.flux || 0;
      let flareClass: string | null = null;
      if (flux >= 1e-4) flareClass = `X${(flux / 1e-4).toFixed(1)}`;
      else if (flux >= 1e-5) flareClass = `M${(flux / 1e-5).toFixed(1)}`;
      else if (flux >= 1e-6) flareClass = `C${(flux / 1e-6).toFixed(1)}`;
      return { flux, flareClass };
    }
    return { flux: 0, flareClass: null };
  } catch { return { flux: 0, flareClass: null }; }
}

// ─── 5. Proton Flux ──────────────────────────────────────────────────────────

async function fetchProtons(): Promise<number> {
  try {
    const data = await fetchJson("https://services.swpc.noaa.gov/products/summary/10mev-proton-flux.json");
    return parseFloat(data.Flux) || 0;
  } catch { return 0; }
}

// ─── 6. CelesTrak Constellation Health ───────────────────────────────────────

interface ConstellationHealth {
  healthy: number; unhealthy: number; total: number; alerts: string[];
}

async function fetchConstellationHealth(): Promise<Record<string, ConstellationHealth>> {
  const result: Record<string, ConstellationHealth> = {
    gps: { healthy: 0, unhealthy: 0, total: 0, alerts: [] },
    glonass: { healthy: 0, unhealthy: 0, total: 0, alerts: [] },
    galileo: { healthy: 0, unhealthy: 0, total: 0, alerts: [] },
    beidou: { healthy: 0, unhealthy: 0, total: 0, alerts: [] },
  };

  const groups = [
    { key: "gps", group: "GPS-OPS" },
    { key: "glonass", group: "GLO-OPS" },
    { key: "galileo", group: "GALILEO" },
    { key: "beidou", group: "BEIDOU" },
  ];

  for (const g of groups) {
    try {
      const data = await fetchJson(`https://celestrak.org/NORAD/elements/gp.php?GROUP=${g.group}&FORMAT=JSON`);
      if (Array.isArray(data)) {
        result[g.key].total = data.length;
        // Satellites with eccentricity > 0.02 or mean motion anomalies may be unhealthy
        for (const sat of data) {
          const ecc = sat.ECCENTRICITY || 0;
          const mm = sat.MEAN_MOTION || 0;
          // GPS nominal: ~2.0 rev/day, GLONASS: ~2.13, Galileo: ~1.7, BeiDou MEO: ~1.86
          const isHealthy = ecc < 0.02 && mm > 1.0;
          if (isHealthy) result[g.key].healthy++;
          else {
            result[g.key].unhealthy++;
            result[g.key].alerts.push(`${sat.OBJECT_NAME}: anomalous orbit (e=${ecc.toFixed(4)}, n=${mm.toFixed(2)})`);
          }
        }
      }
    } catch {
      result[g.key].alerts.push("Data fetch failed");
    }
  }

  return result;
}

// ─── 7. NASA DONKI CME Predictions ───────────────────────────────────────────

async function fetchCME(): Promise<EnvironmentData["cme_forecast"]> {
  try {
    const startDate = new Date().toISOString().substring(0, 10);
    const endDate = new Date(Date.now() + 7 * 86400000).toISOString().substring(0, 10);
    const data = await fetchJson(
      `https://api.nasa.gov/DONKI/CMEAnalysis?startDate=${startDate}&endDate=${endDate}&mostAccurateOnly=true&speed=500&halfAngle=30&catalog=ALL&api_key=DEMO_KEY`,
      15000
    );

    if (!Array.isArray(data)) return [];

    return data.slice(0, 5).map((cme: any) => ({
      id: cme.associatedCMEID || cme.time21_5 || "unknown",
      type: cme.type || "C",
      speed_km_s: cme.speed || 0,
      expected_arrival: cme.arrivalTime || null,
      expected_kp: estimateKpFromCMESpeed(cme.speed || 0),
      source: "NASA DONKI",
    }));
  } catch { return []; }
}

function estimateKpFromCMESpeed(speed: number): number {
  // Empirical relationship: faster CME = stronger storm
  if (speed >= 2000) return 9;
  if (speed >= 1500) return 8;
  if (speed >= 1000) return 7;
  if (speed >= 800) return 6;
  if (speed >= 600) return 5;
  if (speed >= 400) return 4;
  return 3;
}

// ─── 8. Open-Meteo Tropospheric Weather ──────────────────────────────────────

const WEATHER_POINTS = [
  { name: "EU Central", lat: 50.0, lon: 10.0 },
  { name: "EU West", lat: 48.0, lon: -2.0 },
  { name: "EU North", lat: 60.0, lon: 15.0 },
  { name: "US East", lat: 38.0, lon: -78.0 },
  { name: "US West", lat: 37.0, lon: -120.0 },
  { name: "Australia", lat: -28.0, lon: 135.0 },
];

async function fetchTroposphere(): Promise<EnvironmentData["troposphere"]> {
  const regions: EnvironmentData["troposphere"]["regions"] = [];

  // Batch all points in one call
  const lats = WEATHER_POINTS.map(p => p.lat).join(",");
  const lons = WEATHER_POINTS.map(p => p.lon).join(",");

  try {
    const data = await fetchJson(
      `https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lons}&current=temperature_2m,relative_humidity_2m,surface_pressure,cloud_cover,precipitation&timezone=auto`,
      10000
    );

    // Open-Meteo returns array for multiple locations
    const results = Array.isArray(data) ? data : [data];

    for (let i = 0; i < Math.min(results.length, WEATHER_POINTS.length); i++) {
      const current = results[i]?.current;
      if (!current) continue;

      const temp = current.temperature_2m ?? 0;
      const humidity = current.relative_humidity_2m ?? 0;
      const pressure = current.surface_pressure ?? 1013;
      const cloud = current.cloud_cover ?? 0;
      const precip = current.precipitation ?? 0;

      // Tropospheric delay risk:
      // High humidity + low pressure + precipitation = higher ZTD error
      let risk: "low" | "medium" | "high" = "low";
      if (humidity > 85 && precip > 2) risk = "high";
      else if (humidity > 70 || precip > 0.5) risk = "medium";

      regions.push({
        name: WEATHER_POINTS[i].name,
        lat: WEATHER_POINTS[i].lat,
        lon: WEATHER_POINTS[i].lon,
        temperature_c: Math.round(temp * 10) / 10,
        humidity_pct: Math.round(humidity),
        pressure_hpa: Math.round(pressure * 10) / 10,
        cloud_cover_pct: Math.round(cloud),
        precipitation_mm: Math.round(precip * 10) / 10,
        tropo_delay_risk: risk,
      });
    }
  } catch {}

  return { regions };
}

// ─── 9. NOAA Tides (maritime) ────────────────────────────────────────────────

async function fetchTides(): Promise<EnvironmentData["tides"]> {
  const tideStations = [
    { id: "9440910", location: "Antwerp approaches" }, // Nearest NOAA station
  ];

  const tides: EnvironmentData["tides"] = [];

  for (const station of tideStations) {
    try {
      const now = new Date();
      const begin = now.toISOString().replace(/[-:]/g, "").substring(0, 8);
      const end = new Date(now.getTime() + 6 * 3600000).toISOString().replace(/[-:]/g, "").substring(0, 8);

      const data = await fetchJson(
        `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?begin_date=${begin}&end_date=${end}&station=${station.id}&product=predictions&datum=MLLW&time_zone=gmt&units=metric&format=json`,
        10000
      );

      if (data?.predictions?.length > 0) {
        tides.push({
          station: station.id,
          location: station.location,
          current_level_m: parseFloat(data.predictions[0].v) || 0,
          prediction_6h: data.predictions.slice(0, 6).map((p: any) => ({
            time: p.t,
            level_m: parseFloat(p.v) || 0,
          })),
        });
      }
    } catch {}
  }

  return tides;
}

// ─── Impact Model ────────────────────────────────────────────────────────────

function computeImpact(kp: number, dst: number, bz: number, xrayFlux: number): {
  level: EnvironmentData["ionosphere"]["storm_level"];
  phase: EnvironmentData["ionosphere"]["storm_phase"];
  fixImpact: number;
  regions: string[];
} {
  // Storm level from multiple indicators
  let level: EnvironmentData["ionosphere"]["storm_level"] = "quiet";
  if (kp >= 8 || dst < -200 || xrayFlux >= 1e-4) level = "extreme";
  else if (kp >= 7 || dst < -100) level = "severe";
  else if (kp >= 6 || dst < -50) level = "strong";
  else if (kp >= 5 || dst < -30) level = "moderate";
  else if (kp >= 4 || dst < -20) level = "minor";

  // Storm phase from Dst trend
  let phase: EnvironmentData["ionosphere"]["storm_phase"] = "quiet";
  if (dst < -30 && bz < -5) phase = "main";      // Active storm, southward Bz
  else if (dst < -20 && bz > 0) phase = "recovery"; // Recovering
  else if (bz < -10) phase = "initial";             // Bz turning south, storm developing

  // Fix rate impact
  let fixImpact = 0;
  if (level === "extreme") fixImpact = -50;
  else if (level === "severe") fixImpact = -35;
  else if (level === "strong") fixImpact = -25;
  else if (level === "moderate") fixImpact = -12;
  else if (level === "minor") fixImpact = -5;

  // Solar flare additional impact
  if (xrayFlux >= 1e-4) fixImpact -= 15; // X-class flare
  else if (xrayFlux >= 1e-5) fixImpact -= 5; // M-class

  // Affected regions (expand based on storm severity)
  const regions: string[] = [];
  if (level !== "quiet") {
    regions.push("EU North", "Canada"); // Always affected first (auroral zone)
    if (level !== "minor") regions.push("EU Central", "US East", "South America");
    if (level === "strong" || level === "severe" || level === "extreme") {
      regions.push("EU West", "US Central", "US West", "Australia", "Asia Pacific");
    }
  }

  return { level, phase, fixImpact, regions };
}

// ─── Main Function ──────────────────────────────────────────────────────────

// ─── IGS Global Ionosphere Map (VTEC) ────────────────────────────────────────
async function fetchIgsVtec(dataDir: string, kpIndex: number): Promise<EnvironmentData["vtec"]> {
  try {
    // Try CODE rapid product (1-day latency, most reliable free source)
    // Format: CODG{DOY}0.{YY}I — e.g., CODG0850.26I for DOY 85 of 2026
    // Use yesterday's date for rapid product availability
    const yesterday = new Date(Date.now() - 86400000);
    const year = yesterday.getUTCFullYear();
    const doy = getDayOfYear(yesterday);
    const yy = String(year).slice(-2);

    // Try CDDIS first (NASA, most reliable)
    const ionexUrl = `https://cddis.nasa.gov/archive/gnss/products/ionex/${year}/${String(doy).padStart(3, "0")}/codg${String(doy).padStart(3, "0")}0.${yy}i.Z`;

    // Alternative: uncompressed from CODE direct
    const codeUrl = `https://ftp.aiub.unibe.ch/CODE/CODG${String(doy).padStart(3, "0")}0.${yy}I`;

    // Try fetching (CDDIS requires Earthdata auth, so try CODE first)
    const text = await fetchText(codeUrl, 15000);

    if (text && text.includes("END OF HEADER")) {
      const { parseIonex } = require("../ionosphere/ionex-parser");
      const { generateTecGrid } = require("../ionosphere/tec-interpolator");
      const { computeScintillationRisk } = require("../ionosphere/scintillation-proxy");

      const ionexFile = parseIonex(text);
      if (ionexFile.maps.length > 0) {
        // Use the latest map
        const latestMap = ionexFile.maps[ionexFile.maps.length - 1];
        const grid = generateTecGrid(latestMap, 10); // 10° resolution for manageable size

        // Compute scintillation if we have 2+ maps
        let scintillationRisks: any[] = [];
        if (ionexFile.maps.length >= 2) {
          const prevMap = ionexFile.maps[ionexFile.maps.length - 2];
          scintillationRisks = computeScintillationRisk(prevMap, latestMap, kpIndex);
        }

        return {
          grid: grid.slice(0, 500), // Cap for JSON size
          scintillation_risks: scintillationRisks.slice(0, 100),
          epoch: latestMap.epoch.toISOString(),
          source: "CODE/AIUB IGS GIM",
        };
      }
    }
  } catch (e) {
    // IGS GIM is a nice-to-have, not critical
  }
  return undefined;
}

function getDayOfYear(date: Date): number {
  const start = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.floor((date.getTime() - start.getTime()) / 86400000) + 1;
}

export async function fetchEnvironment(dataDir: string): Promise<EnvironmentData> {
  const errors: string[] = [];
  const sources: string[] = [];

  // Fetch all sources in parallel
  const [kp, dscovr, dst, xray, protons, constellation, cme, tropo, tides] = await Promise.all([
    fetchKp().then(r => { sources.push("NOAA Kp"); return r; }).catch(e => { errors.push(`Kp: ${e}`); return { current: 0, forecast: 0 }; }),
    fetchDSCOVR().then(r => { sources.push("DSCOVR Solar Wind"); return r; }).catch(e => { errors.push(`DSCOVR: ${e}`); return { bz: 0, bt: 0, speed: 0, density: 0 }; }),
    fetchDst().then(r => { sources.push("Dst Index"); return r; }).catch(e => { errors.push(`Dst: ${e}`); return 0; }),
    fetchXRay().then(r => { sources.push("GOES X-Ray"); return r; }).catch(e => { errors.push(`X-Ray: ${e}`); return { flux: 0, flareClass: null }; }),
    fetchProtons().then(r => { sources.push("GOES Proton"); return r; }).catch(e => { errors.push(`Proton: ${e}`); return 0; }),
    fetchConstellationHealth().then(r => { sources.push("CelesTrak"); return r; }).catch(e => { errors.push(`CelesTrak: ${e}`); return { gps: { healthy: 0, unhealthy: 0, total: 0, alerts: [] }, glonass: { healthy: 0, unhealthy: 0, total: 0, alerts: [] }, galileo: { healthy: 0, unhealthy: 0, total: 0, alerts: [] }, beidou: { healthy: 0, unhealthy: 0, total: 0, alerts: [] } }; }),
    fetchCME().then(r => { sources.push("NASA DONKI"); return r; }).catch(e => { errors.push(`DONKI: ${e}`); return []; }),
    fetchTroposphere().then(r => { sources.push("Open-Meteo"); return r; }).catch(e => { errors.push(`Open-Meteo: ${e}`); return { regions: [] }; }),
    fetchTides().then(r => { if (r.length > 0) sources.push("NOAA Tides"); return r; }).catch(e => { errors.push(`Tides: ${e}`); return []; }),
  ]);

  // Fetch IGS VTEC (separate, after Kp is available for scintillation context)
  const vtec = await fetchIgsVtec(dataDir, kp.current).catch(() => undefined);
  if (vtec) sources.push("IGS GIM (CODE)");

  const impact = computeImpact(kp.current, dst, dscovr.bz, xray.flux);

  const totalHealthy = Object.values(constellation).reduce((s, c) => s + c.healthy, 0);
  const totalUnhealthy = Object.values(constellation).reduce((s, c) => s + c.unhealthy, 0);

  const result: EnvironmentData = {
    ionosphere: {
      kp_index: kp.current,
      kp_forecast_3h: kp.forecast,
      dst_index: dst,
      bz_component: dscovr.bz,
      bt_total: dscovr.bt,
      solar_wind_speed: dscovr.speed,
      solar_wind_density: dscovr.density,
      xray_flux: xray.flux,
      flare_class: xray.flareClass,
      proton_flux: protons,
      storm_level: impact.level,
      storm_phase: impact.phase,
      expected_fix_impact_pct: impact.fixImpact,
      affected_regions: impact.regions,
    },
    cme_forecast: cme,
    constellation: {
      gps: constellation.gps || { healthy: 0, unhealthy: 0, total: 0, alerts: [] },
      glonass: constellation.glonass || { healthy: 0, unhealthy: 0, total: 0, alerts: [] },
      galileo: constellation.galileo || { healthy: 0, unhealthy: 0, total: 0, alerts: [] },
      beidou: constellation.beidou || { healthy: 0, unhealthy: 0, total: 0, alerts: [] },
      total_healthy: totalHealthy,
      total_unhealthy: totalUnhealthy,
    },
    troposphere: tropo,
    tides,
    vtec: vtec || undefined,
    fetched_at: new Date().toISOString(),
    sources,
    errors,
  };

  // Persist current
  try {
    const filePath = path.join(dataDir, "environment.json");
    const tmp = filePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(result, null, 2));
    fs.renameSync(tmp, filePath);
  } catch {}

  // Also write backwards-compatible space-weather.json
  try {
    const swCompat = {
      kp_index: kp.current,
      kp_forecast_3h: kp.forecast,
      solar_flux: 0,
      storm_level: impact.level,
      btotal: dscovr.bt,
      bz: dscovr.bz,
      proton_flux: protons,
      expected_impact: {
        fix_rate_impact_pct: impact.fixImpact,
        affected_regions: impact.regions,
        description: generateDescription(impact.level, impact.phase, kp.current, dst, xray.flareClass, cme),
      },
      fetched_at: new Date().toISOString(),
      sources,
    };
    const swPath = path.join(dataDir, "space-weather.json");
    const tmp2 = swPath + ".tmp";
    fs.writeFileSync(tmp2, JSON.stringify(swCompat, null, 2));
    fs.renameSync(tmp2, swPath);
  } catch {}

  // Append to history
  try {
    const historyPath = path.join(dataDir, "space-weather-history.json");
    let history: any[] = [];
    try {
      if (fs.existsSync(historyPath)) history = JSON.parse(fs.readFileSync(historyPath, "utf-8"));
    } catch {}
    history.push({
      kp: kp.current, dst, bz: dscovr.bz, speed: dscovr.speed,
      xray: xray.flux, storm: impact.level, phase: impact.phase,
      ts: new Date().toISOString(),
    });
    if (history.length > 336) history = history.slice(-336); // 14 days at hourly
    const tmp3 = historyPath + ".tmp";
    fs.writeFileSync(tmp3, JSON.stringify(history));
    fs.renameSync(tmp3, historyPath);
  } catch {}

  return result;
}

function generateDescription(
  level: string, phase: string, kp: number, dst: number,
  flare: string | null, cme: EnvironmentData["cme_forecast"]
): string {
  const parts: string[] = [];

  if (level === "quiet") {
    parts.push("Quiet geomagnetic conditions. No impact on RTK performance expected.");
  } else {
    parts.push(`${level.charAt(0).toUpperCase() + level.slice(1)} geomagnetic storm (Kp=${kp}, Dst=${dst}nT).`);
    if (phase === "main") parts.push("Storm in main phase — maximum impact.");
    else if (phase === "initial") parts.push("Storm developing — conditions may worsen.");
    else if (phase === "recovery") parts.push("Storm recovering — conditions improving.");
  }

  if (flare) parts.push(`Active solar flare: ${flare}.`);

  if (cme.length > 0) {
    const next = cme[0];
    if (next.expected_arrival) {
      parts.push(`CME expected ${new Date(next.expected_arrival).toLocaleDateString("de-DE")} (${next.speed_km_s} km/s, est. Kp ${next.expected_kp}).`);
    }
  }

  return parts.join(" ");
}
