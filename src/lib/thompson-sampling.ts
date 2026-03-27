// ─── Thompson Sampling for Station Routing ───────────────────────────────────
// Converts the existing Bayesian Beta trust model into an explore-exploit algorithm.
//
// Standard routing: always pick highest-trust station → never discovers better options
// Thompson Sampling: sample from Beta(alpha, beta) → naturally balances
//   exploitation (high-trust stations) with exploration (uncertain stations)
//
// This is a ONE-LINE change to the routing decision:
//   BEFORE: priority = compositeScore (deterministic)
//   AFTER:  priority = sample from Beta(alpha, beta) (stochastic)
//
// Properties:
// - Stations with high alpha (many successes) → samples cluster near 1.0
// - Stations with low data → wide distribution → occasionally samples high
// - Over time: converges to optimal while exploring alternatives
// - Zero tuning parameters (unlike epsilon-greedy or UCB)
//
// Reference: Thompson (1933), Chapelle & Li (2011), Agrawal & Goyal (2012)

import fs from "fs";
import path from "path";

// ─── Beta Distribution Sampling ─────────────────────────────────────────────
// Uses the Jöhnk algorithm for generating Beta(a,b) random variates.

function sampleBeta(alpha: number, beta: number): number {
  // Handle edge cases
  if (alpha <= 0) alpha = 0.01;
  if (beta <= 0) beta = 0.01;

  // For alpha, beta >= 1: use Cheng's algorithm (more stable)
  if (alpha >= 1 && beta >= 1) {
    return sampleBetaCheng(alpha, beta);
  }

  // For small alpha or beta: use Jöhnk's algorithm
  while (true) {
    const u1 = Math.random();
    const u2 = Math.random();
    const x = Math.pow(u1, 1 / alpha);
    const y = Math.pow(u2, 1 / beta);
    if (x + y <= 1) {
      return x / (x + y);
    }
  }
}

function sampleBetaCheng(alpha: number, beta: number): number {
  // Cheng's BC algorithm for Beta(a,b) where a,b >= 1
  const a = Math.min(alpha, beta);
  const b = Math.max(alpha, beta);
  const swap = alpha < beta;

  const lambda = a + b;
  const mu = a;
  const sigma = 0.5 * lambda;

  while (true) {
    const u1 = Math.random();
    const u2 = Math.random();
    const v = sigma * Math.log(u1 / (1 - u1));
    const w = mu * Math.exp(v);
    const z = u1 * u1 * u2;
    const r = sigma * v - Math.log(4);
    const s = mu + sigma - w;

    if (s + 2.609 >= 5 * z) {
      const x = w / lambda;
      return swap ? 1 - x : x;
    }

    if (r >= Math.log(z)) {
      const x = w / lambda;
      return swap ? 1 - x : x;
    }
  }
}

// ─── Thompson Sampling Priority ─────────────────────────────────────────────

export interface ThompsonStation {
  name: string;
  alpha: number;         // Bayesian successes
  beta: number;          // Bayesian failures
  sampled_score: number; // Thompson sample from Beta(alpha, beta)
  deterministic_score: number; // E[Beta] = alpha/(alpha+beta) for comparison
  exploration_bonus: boolean;  // True if sampled_score > deterministic_score significantly
}

/**
 * Generate Thompson Sampling priorities for a list of stations.
 * Returns stations sorted by sampled priority (highest first).
 *
 * @param trustState Map of station → {alpha, beta}
 * @param explorationWeight 1.0 = full Thompson Sampling, 0.0 = deterministic
 */
/**
 * @param trustState Beta distribution parameters per station
 * @param explorationWeight Blend ratio (0.7 recommended after PhD review — pure 0.8 was too aggressive)
 * @param excludedStations Stations flagged as "excluded" by TRUST V2 — NEVER route to these
 */
export function thompsonSamplePriorities(
  trustState: Record<string, { alpha: number; beta: number }>,
  explorationWeight = 0.7, // Reduced from 0.8 per PhD optimization review
  excludedStations?: Set<string>
): ThompsonStation[] {
  const results: ThompsonStation[] = [];

  for (const [name, state] of Object.entries(trustState)) {
    // SAFETY: Never route to excluded stations regardless of Thompson sample
    if (excludedStations?.has(name)) continue;
    const alpha = state.alpha || 1;
    const beta = state.beta || 1;

    // Deterministic score (expected value)
    const deterministicScore = alpha / (alpha + beta);

    // Thompson sample
    const sample = sampleBeta(alpha, beta);

    // Blend: mostly Thompson but with some deterministic stability
    // Safety clamp: Thompson sample can never exceed deterministic + 0.15
    // This prevents a station with no data from getting a lucky sample
    // and becoming primary for all users in a zone for 4 hours
    const clampedSample = Math.min(sample, deterministicScore + 0.15);
    const blendedScore = explorationWeight * clampedSample + (1 - explorationWeight) * deterministicScore;

    results.push({
      name,
      alpha,
      beta,
      sampled_score: Math.round(blendedScore * 1000) / 1000,
      deterministic_score: Math.round(deterministicScore * 1000) / 1000,
      exploration_bonus: sample > deterministicScore + 0.1,
    });
  }

  // Sort by sampled score descending
  results.sort((a, b) => b.sampled_score - a.sampled_score);

  return results;
}

/**
 * Compute Thompson-based cascade priority for config generation.
 * Higher sampled_score → lower priority number (1 = best).
 *
 * This replaces the static composite_score-based priority with a
 * stochastic one that naturally explores undersampled stations.
 */
export function computeThompsonPriority(
  alpha: number,
  beta: number,
  baseNetworkPriority: number // GEODNET = 1, ONOCOY = 20
): number {
  const sample = sampleBeta(alpha || 1, beta || 1);

  // Map sample [0,1] to priority offset [0, 10]
  // High sample (good station) → low offset → high priority
  const offset = Math.round((1 - sample) * 10);

  return baseNetworkPriority + offset;
}

/**
 * Log Thompson Sampling decisions for debugging/auditing.
 */
export function logThompsonDecisions(
  stations: ThompsonStation[],
  dataDir: string
) {
  const exploredCount = stations.filter(s => s.exploration_bonus).length;

  const report = {
    total_stations: stations.length,
    explored: exploredCount,
    exploration_rate: stations.length > 0 ? Math.round(exploredCount / stations.length * 100) : 0,
    top_10: stations.slice(0, 10).map(s => ({
      station: s.name,
      sampled: s.sampled_score,
      deterministic: s.deterministic_score,
      exploring: s.exploration_bonus,
      alpha: s.alpha,
      beta: s.beta,
    })),
    computed_at: new Date().toISOString(),
  };

  try {
    const filePath = path.join(dataDir, "thompson-sampling.json");
    const tmp = filePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(report, null, 2));
    fs.renameSync(tmp, filePath);
  } catch {}

  if (exploredCount > 0) {
    console.log(`[THOMPSON] ${exploredCount}/${stations.length} stations explored (${report.exploration_rate}%)`);
  }
}
