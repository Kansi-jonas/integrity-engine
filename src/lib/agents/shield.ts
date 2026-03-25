// ─── SHIELD Agent — Interference Classification ─────────────────────────────
// Classifies detected anomaly clusters into root causes:
// - JAMMING: broadband/narrowband interference
// - SPOOFING: coordinated false signals
// - IONO: ionospheric storm / scintillation
// - STATION_FAULT: single station hardware/software failure
// - MULTIPATH: environmental multipath (time-of-day pattern)
// - NETWORK: upstream network issue (caster, internet)
//
// Uses a rule-based classifier (16 features) until ML model is trained.
// Runs every 5 minutes on SENTINEL V2 output.

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

// ─── Types ───────────────────────────────────────────────────────────────────

export type InterferenceType = "jamming" | "spoofing" | "iono" | "station_fault" | "multipath" | "network" | "unknown";

export interface InterferenceEvent {
  id: string;
  classification: InterferenceType;
  confidence: number; // 0-1
  features: FeatureVector;
  region: { lat: number; lon: number; radius_km: number } | null;
  affected_users: number;
  affected_stations: string[];
  start_time: string;
  duration_min: number;
  severity: "critical" | "warning" | "info";
  description: string;
}

interface FeatureVector {
  // Spatial features
  cluster_radius_km: number;
  cluster_user_count: number;
  cluster_station_count: number;
  networks_affected: number;

  // Temporal features
  onset_speed_min: number;        // How fast did quality drop? (instant = jamming, gradual = iono)
  time_of_day_hour: number;
  is_commute_hour: boolean;       // 7-9am or 5-7pm (PPD jamming pattern)

  // Quality features
  mean_fix_rate: number;
  fix_rate_variance: number;
  mean_correction_age: number;
  age_spike_ratio: number;        // correction age vs baseline

  // Context features
  kp_index: number;
  is_iono_storm: boolean;
  station_trust_avg: number;
  single_station: boolean;        // Only 1 station affected?
  cross_network_consistent: boolean; // Both networks affected equally?
}

// ─── Rule-Based Classifier ──────────────────────────────────────────────────
// Until we have enough labeled data for ML, use expert rules.
// These rules are based on the PhD-level research from:
// - research_interference_detection.md
// - research_depin_integrity_filter.md

function classify(f: FeatureVector): { type: InterferenceType; confidence: number; reason: string } {
  const scores: Record<InterferenceType, { score: number; reasons: string[] }> = {
    jamming: { score: 0, reasons: [] },
    spoofing: { score: 0, reasons: [] },
    iono: { score: 0, reasons: [] },
    station_fault: { score: 0, reasons: [] },
    multipath: { score: 0, reasons: [] },
    network: { score: 0, reasons: [] },
    unknown: { score: 0, reasons: [] },
  };

  // ── JAMMING indicators ─────────────────────────────────────────────────
  if (f.onset_speed_min < 2) {
    scores.jamming.score += 3;
    scores.jamming.reasons.push("instant onset (<2min)");
  }
  if (f.mean_fix_rate < 10) {
    scores.jamming.score += 2;
    scores.jamming.reasons.push("near-zero fix rate");
  }
  if (f.cluster_radius_km < 30 && f.cluster_user_count >= 3) {
    scores.jamming.score += 2;
    scores.jamming.reasons.push("tight geographic cluster");
  }
  if (f.age_spike_ratio > 3) {
    scores.jamming.score += 1;
    scores.jamming.reasons.push("correction age spike (station also affected)");
  }
  if (f.is_commute_hour) {
    scores.jamming.score += 1;
    scores.jamming.reasons.push("commute hour (PPD pattern)");
  }
  if (!f.is_iono_storm) {
    scores.jamming.score += 1;
    scores.jamming.reasons.push("no iono storm active");
  }

  // ── SPOOFING indicators ────────────────────────────────────────────────
  if (f.mean_fix_rate > 50 && f.fix_rate_variance < 100) {
    scores.spoofing.score += 2;
    scores.spoofing.reasons.push("fix rate appears normal (spoofed signals maintain lock)");
  }
  if (f.age_spike_ratio < 1.5) {
    scores.spoofing.score += 1;
    scores.spoofing.reasons.push("correction age normal (station not affected)");
  }
  if (f.cluster_radius_km < 10) {
    scores.spoofing.score += 1;
    scores.spoofing.reasons.push("very tight cluster (spoofing is localized)");
  }

  // ── IONO indicators ────────────────────────────────────────────────────
  if (f.is_iono_storm) {
    scores.iono.score += 4;
    scores.iono.reasons.push(`Kp=${f.kp_index} storm active`);
  }
  if (f.cluster_radius_km > 200) {
    scores.iono.score += 2;
    scores.iono.reasons.push("large affected area (>200km)");
  }
  if (f.onset_speed_min > 30) {
    scores.iono.score += 1;
    scores.iono.reasons.push("gradual onset (>30min)");
  }
  if (f.cross_network_consistent) {
    scores.iono.score += 2;
    scores.iono.reasons.push("both networks affected equally");
  }
  if (f.networks_affected > 1) {
    scores.iono.score += 1;
    scores.iono.reasons.push("multiple networks affected");
  }

  // ── STATION_FAULT indicators ───────────────────────────────────────────
  if (f.single_station) {
    scores.station_fault.score += 4;
    scores.station_fault.reasons.push("only 1 station affected");
  }
  if (f.station_trust_avg < 0.4) {
    scores.station_fault.score += 2;
    scores.station_fault.reasons.push("low station trust score");
  }
  if (!f.cross_network_consistent && f.networks_affected === 1) {
    scores.station_fault.score += 1;
    scores.station_fault.reasons.push("only one network affected");
  }

  // ── MULTIPATH indicators ───────────────────────────────────────────────
  const hour = f.time_of_day_hour;
  if (f.single_station && (hour >= 6 && hour <= 8 || hour >= 16 && hour <= 18)) {
    scores.multipath.score += 2;
    scores.multipath.reasons.push("single station + low sun angle hours");
  }
  if (f.fix_rate_variance > 400 && f.single_station) {
    scores.multipath.score += 1;
    scores.multipath.reasons.push("high fix rate variance (intermittent)");
  }

  // ── NETWORK indicators ─────────────────────────────────────────────────
  if (f.age_spike_ratio > 5 && f.mean_fix_rate > 30) {
    scores.network.score += 3;
    scores.network.reasons.push("extreme correction age but fix still works (latency issue)");
  }
  if (f.cluster_station_count > 10 && f.networks_affected === 1) {
    scores.network.score += 2;
    scores.network.reasons.push("many stations on one network affected (upstream issue)");
  }

  // Find winner
  let best: InterferenceType = "unknown";
  let bestScore = 0;
  let totalScore = 0;
  for (const [type, data] of Object.entries(scores)) {
    totalScore += data.score;
    if (data.score > bestScore) {
      bestScore = data.score;
      best = type as InterferenceType;
    }
  }

  const confidence = totalScore > 0 ? Math.min(0.95, bestScore / totalScore) : 0;
  const reason = scores[best].reasons.join("; ");

  return { type: best, confidence: Math.round(confidence * 100) / 100, reason };
}

// ─── Main Function ──────────────────────────────────────────────────────────

export function runShield(db: Database.Database, dataDir: string): InterferenceEvent[] {
  const now = Date.now();
  const fiveMinAgo = now - 5 * 60000;
  const events: InterferenceEvent[] = [];

  // Load space weather
  let kp = 0;
  let isIonoStorm = false;
  try {
    const swPath = path.join(dataDir, "space-weather.json");
    if (fs.existsSync(swPath)) {
      const sw = JSON.parse(fs.readFileSync(swPath, "utf-8"));
      kp = sw.kp_index || 0;
      isIonoStorm = kp >= 5;
    }
  } catch {}

  // Load trust scores
  const trustMap = new Map<string, number>();
  try {
    const trustPath = path.join(dataDir, "trust-scores.json");
    if (fs.existsSync(trustPath)) {
      const td = JSON.parse(fs.readFileSync(trustPath, "utf-8"));
      for (const t of (td.scores || [])) {
        trustMap.set(t.station, t.combined_score || 0);
      }
    }
  } catch {}

  // Load degraded sessions
  const degraded = db.prepare(`
    SELECT s.station, s.fix_rate, s.avg_age, s.latitude, s.longitude, s.username, s.login_time,
           COALESCE(st.network, 'unknown') as network
    FROM rtk_sessions s
    LEFT JOIN stations st ON s.station = st.name
    WHERE s.login_time >= ? AND s.station IS NOT NULL AND s.station != ''
      AND s.fix_rate < 40
      AND s.latitude IS NOT NULL AND ABS(s.latitude) > 0.1
  `).all(fiveMinAgo) as any[];

  if (degraded.length < 3) return [];

  // Cluster degraded sessions by 0.5° grid
  const gridClusters = new Map<string, any[]>();
  for (const s of degraded) {
    const key = `${Math.round(s.latitude * 2) / 2},${Math.round(s.longitude * 2) / 2}`;
    if (!gridClusters.has(key)) gridClusters.set(key, []);
    gridClusters.get(key)!.push(s);
  }

  // Load baselines for age comparison
  const ageBaseline = db.prepare(`
    SELECT AVG(CASE WHEN avg_age > 0 THEN avg_age ELSE NULL END) as mean_age
    FROM rtk_sessions
    WHERE login_time >= ? AND login_time < ?
      AND station IS NOT NULL AND station != ''
  `).get(now - 6 * 3600000, fiveMinAgo) as any;
  const baselineAge = ageBaseline?.mean_age || 2;

  for (const [gridKey, sessions] of gridClusters) {
    const users = new Set(sessions.map((s: any) => s.username));
    if (users.size < 2) continue;

    const [lat, lon] = gridKey.split(",").map(Number);
    const stations = new Set(sessions.map((s: any) => s.station));
    const networks = new Set(sessions.map((s: any) => s.network).filter((n: string) => n !== "unknown"));
    const fixRates = sessions.map((s: any) => s.fix_rate || 0);
    const meanFix = fixRates.reduce((a: number, b: number) => a + b, 0) / fixRates.length;
    const fixVariance = fixRates.reduce((s: number, f: number) => s + (f - meanFix) ** 2, 0) / fixRates.length;
    const ages = sessions.filter((s: any) => s.avg_age > 0).map((s: any) => s.avg_age);
    const meanAge = ages.length > 0 ? ages.reduce((a: number, b: number) => a + b, 0) / ages.length : 0;

    // Estimate onset speed
    const times = sessions.map((s: any) => s.login_time).sort((a: number, b: number) => a - b);
    const timeSpan = (times[times.length - 1] - times[0]) / 60000;

    // Station trust average
    const trusts = [...stations].map(s => trustMap.get(s) ?? 0.5);
    const trustAvg = trusts.reduce((a, b) => a + b, 0) / Math.max(1, trusts.length);

    // Cross-network consistency (are both networks affected equally?)
    let crossNetConsistent = true;
    if (networks.size >= 2) {
      const netRates = new Map<string, number[]>();
      for (const s of sessions) {
        if (s.network === "unknown") continue;
        if (!netRates.has(s.network)) netRates.set(s.network, []);
        netRates.get(s.network)!.push(s.fix_rate || 0);
      }
      const netMeans = [...netRates.values()].map(r => r.reduce((a, b) => a + b, 0) / r.length);
      if (netMeans.length >= 2) {
        crossNetConsistent = Math.abs(netMeans[0] - netMeans[1]) < 20;
      }
    }

    const hour = new Date().getHours();
    const features: FeatureVector = {
      cluster_radius_km: 30, // Grid-based approximation
      cluster_user_count: users.size,
      cluster_station_count: stations.size,
      networks_affected: networks.size,
      onset_speed_min: Math.max(1, timeSpan),
      time_of_day_hour: hour,
      is_commute_hour: (hour >= 7 && hour <= 9) || (hour >= 17 && hour <= 19),
      mean_fix_rate: meanFix,
      fix_rate_variance: fixVariance,
      mean_correction_age: meanAge,
      age_spike_ratio: baselineAge > 0 ? meanAge / baselineAge : 1,
      kp_index: kp,
      is_iono_storm: isIonoStorm,
      station_trust_avg: trustAvg,
      single_station: stations.size === 1,
      cross_network_consistent: crossNetConsistent,
    };

    const result = classify(features);
    if (result.confidence < 0.2) continue; // Too uncertain

    events.push({
      id: `shield_${gridKey}_${Math.floor(now / 300000)}`,
      classification: result.type,
      confidence: result.confidence,
      features,
      region: { lat, lon, radius_km: 30 },
      affected_users: users.size,
      affected_stations: [...stations],
      start_time: new Date(times[0]).toISOString(),
      duration_min: Math.round(timeSpan),
      severity: users.size >= 8 || result.type === "jamming" ? "critical" : users.size >= 4 ? "warning" : "info",
      description: `${result.type.toUpperCase()} (${Math.round(result.confidence * 100)}%): ${result.reason}`,
    });
  }

  // Persist events
  try {
    const filePath = path.join(dataDir, "shield-events.json");
    let history: InterferenceEvent[] = [];
    try {
      if (fs.existsSync(filePath)) {
        history = JSON.parse(fs.readFileSync(filePath, "utf-8")).events || [];
      }
    } catch {}
    const all = [...events, ...history].slice(0, 500);
    const tmp = filePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({
      events: all,
      last_run: new Date().toISOString(),
      summary: {
        jamming: events.filter(e => e.classification === "jamming").length,
        spoofing: events.filter(e => e.classification === "spoofing").length,
        iono: events.filter(e => e.classification === "iono").length,
        station_fault: events.filter(e => e.classification === "station_fault").length,
        multipath: events.filter(e => e.classification === "multipath").length,
        network: events.filter(e => e.classification === "network").length,
      },
    }));
    fs.renameSync(tmp, filePath);
  } catch {}

  return events;
}
