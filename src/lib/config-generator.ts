// ─── Alberding Config Generator ──────────────────────────────────────────────
// Takes TRUST V2 scores + SHIELD events + Protection Levels and generates
// a filtered, quality-assured station config for the Alberding NTRIP Caster.
//
// ONLY stations that pass ALL quality gates get into the config:
// 1. Trust composite >= 0.55 (above probation)
// 2. Not excluded by hysteresis
// 3. No active critical SHIELD events
// 4. Uptime >= 0.5 (50% in last 7d)
// 5. UQ Score >= 0.3
//
// Output: Ranked station list with cascade priorities per zone.
// This feeds into the GNSS Wizard which generates the actual ntrips.cfg.

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface QualifiedStation {
  name: string;
  network: string;
  latitude: number;
  longitude: number;
  composite_score: number;
  trust_score: number;
  uq_score: number;
  uptime: number;
  consistency: number;
  cascade_priority: number;  // Lower = higher priority (used in Alberding --pinput order)
  quality_tier: "platinum" | "gold" | "silver";  // For customer-facing labels
  disqualified: boolean;
  disqualify_reason: string | null;
}

export interface ConfigOutput {
  qualified: QualifiedStation[];
  disqualified: QualifiedStation[];
  stats: {
    total_evaluated: number;
    qualified_count: number;
    disqualified_count: number;
    platinum: number;
    gold: number;
    silver: number;
    avg_composite: number;
    networks: Record<string, number>;
  };
  quality_gates: {
    min_trust: number;
    min_uptime: number;
    min_uq: number;
    exclude_critical_shield: boolean;
  };
  generated_at: string;
}

// ─── Quality Gates ───────────────────────────────────────────────────────────

const GATES = {
  MIN_TRUST_COMPOSITE: 0.55,
  MIN_UPTIME: 0.50,
  MIN_UQ_SCORE: 0.30,
  MIN_SESSIONS: 5,            // Need at least 5 sessions in scoring window
  EXCLUDE_CRITICAL_SHIELD: true,
};

// Tier thresholds
const TIER_PLATINUM = 0.85;   // Top tier: highest cascade priority
const TIER_GOLD = 0.70;
// Below gold = silver (still qualified, but lower priority)

// ─── Core Function ──────────────────────────────────────────────────────────

export function generateQualifiedConfig(db: Database.Database, dataDir: string): ConfigOutput {
  // ── 1. Load trust scores ──────────────────────────────────────────────────

  const trustMap = new Map<string, any>();
  try {
    const trustPath = path.join(dataDir, "trust-scores.json");
    if (fs.existsSync(trustPath)) {
      const td = JSON.parse(fs.readFileSync(trustPath, "utf-8"));
      for (const t of (td.scores || [])) {
        trustMap.set(t.station, t);
      }
    }
  } catch {}

  // ── 2. Load SHIELD events (active critical events) ────────────────────────

  const criticalStations = new Set<string>();
  try {
    const shieldPath = path.join(dataDir, "shield-events.json");
    if (fs.existsSync(shieldPath)) {
      const sd = JSON.parse(fs.readFileSync(shieldPath, "utf-8"));
      const recentEvents = (sd.events || []).filter((e: any) => {
        const age = Date.now() - new Date(e.start_time).getTime();
        return age < 30 * 60000 && e.severity === "critical"; // Last 30 min critical events
      });
      for (const e of recentEvents) {
        for (const st of (e.affected_stations || [])) {
          criticalStations.add(st);
        }
      }
    }
  } catch {}

  // ── 3. Load all stations with scores ──────────────────────────────────────

  const stations = db.prepare(`
    SELECT s.name, s.latitude, s.longitude, COALESCE(s.network, 'unknown') as network,
           COALESCE(ss.uq_score, 0) as uq_score,
           COALESCE(ss.uptime_7d, 0) as uptime,
           COALESCE(ss.session_count, 0) as session_count,
           COALESCE(ss.avg_fix_rate, 0) as avg_fix_rate
    FROM stations s
    LEFT JOIN station_scores ss ON s.name = ss.station_name
    WHERE s.latitude IS NOT NULL AND ABS(s.latitude) > 0.1
  `).all() as any[];

  // ── 4. Evaluate each station ──────────────────────────────────────────────

  const qualified: QualifiedStation[] = [];
  const disqualified: QualifiedStation[] = [];

  for (const s of stations) {
    const trust = trustMap.get(s.name);
    // New stations default to 0.6 (neutral) — prevents chicken-and-egg permanent exclusion
    const compositeScore = trust?.composite_score ?? trust?.combined_score ?? 0.6;
    const trustScore = trust?.trust_score ?? 0.5;
    const flag = trust?.flag ?? "new";
    const consistency = trust?.consistency_weight ?? trust?.consistency ?? 0.5;

    // Run quality gates
    let dq = false;
    let dqReason: string | null = null;

    if (flag === "excluded") {
      dq = true;
      dqReason = `Excluded by TRUST V2 hysteresis (${trust?.excluded_reason || "composite below threshold"})`;
    } else if (compositeScore < GATES.MIN_TRUST_COMPOSITE) {
      dq = true;
      dqReason = `Trust composite ${compositeScore.toFixed(3)} < ${GATES.MIN_TRUST_COMPOSITE}`;
    } else if (s.uptime < GATES.MIN_UPTIME) {
      dq = true;
      dqReason = `Uptime ${(s.uptime * 100).toFixed(1)}% < ${GATES.MIN_UPTIME * 100}%`;
    } else if (s.uq_score < GATES.MIN_UQ_SCORE) {
      dq = true;
      dqReason = `UQ score ${s.uq_score.toFixed(3)} < ${GATES.MIN_UQ_SCORE}`;
    } else if (GATES.EXCLUDE_CRITICAL_SHIELD && criticalStations.has(s.name)) {
      dq = true;
      dqReason = "Active critical SHIELD event (interference/jamming)";
    } else if (s.session_count < GATES.MIN_SESSIONS && flag === "new") {
      dq = true;
      dqReason = `Insufficient data (${s.session_count} sessions < ${GATES.MIN_SESSIONS})`;
    }

    // Quality tier
    let tier: QualifiedStation["quality_tier"] = "silver";
    if (compositeScore >= TIER_PLATINUM) tier = "platinum";
    else if (compositeScore >= TIER_GOLD) tier = "gold";

    // Cascade priority (lower = higher priority in Alberding)
    // Platinum: 1-10, Gold: 11-30, Silver: 31-50
    let cascadePriority: number;
    if (tier === "platinum") {
      cascadePriority = Math.round(1 + (1 - compositeScore) * 20);
    } else if (tier === "gold") {
      cascadePriority = Math.round(11 + (TIER_PLATINUM - compositeScore) * 60);
    } else {
      cascadePriority = Math.round(31 + (TIER_GOLD - compositeScore) * 60);
    }
    cascadePriority = Math.min(99, Math.max(1, cascadePriority));

    const entry: QualifiedStation = {
      name: s.name,
      network: s.network,
      latitude: s.latitude,
      longitude: s.longitude,
      composite_score: Math.round(compositeScore * 1000) / 1000,
      trust_score: Math.round(trustScore * 1000) / 1000,
      uq_score: Math.round(s.uq_score * 1000) / 1000,
      uptime: Math.round(s.uptime * 1000) / 1000,
      consistency: Math.round(consistency * 1000) / 1000,
      cascade_priority: cascadePriority,
      quality_tier: tier,
      disqualified: dq,
      disqualify_reason: dqReason,
    };

    if (dq) {
      disqualified.push(entry);
    } else {
      qualified.push(entry);
    }
  }

  // Sort qualified by composite score (best first)
  qualified.sort((a, b) => b.composite_score - a.composite_score);
  disqualified.sort((a, b) => a.composite_score - b.composite_score);

  // Network breakdown
  const networks: Record<string, number> = {};
  for (const s of qualified) {
    networks[s.network] = (networks[s.network] || 0) + 1;
  }

  const output: ConfigOutput = {
    qualified,
    disqualified,
    stats: {
      total_evaluated: stations.length,
      qualified_count: qualified.length,
      disqualified_count: disqualified.length,
      platinum: qualified.filter(s => s.quality_tier === "platinum").length,
      gold: qualified.filter(s => s.quality_tier === "gold").length,
      silver: qualified.filter(s => s.quality_tier === "silver").length,
      avg_composite: qualified.length > 0
        ? Math.round(qualified.reduce((s, q) => s + q.composite_score, 0) / qualified.length * 1000) / 1000
        : 0,
      networks,
    },
    quality_gates: {
      min_trust: GATES.MIN_TRUST_COMPOSITE,
      min_uptime: GATES.MIN_UPTIME,
      min_uq: GATES.MIN_UQ_SCORE,
      exclude_critical_shield: GATES.EXCLUDE_CRITICAL_SHIELD,
    },
    generated_at: new Date().toISOString(),
  };

  // Persist
  try {
    const filePath = path.join(dataDir, "qualified-stations.json");
    const tmp = filePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(output));
    fs.renameSync(tmp, filePath);
  } catch {}

  return output;
}
