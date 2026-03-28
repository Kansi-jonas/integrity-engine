// ─── Config Safety Guards ────────────────────────────────────────────────────
// Prevents dangerous config deployments:
// 1. Never deploy empty config (zero streams = all users disconnected)
// 2. Never deploy config with fewer than MIN_STREAMS streams
// 3. Always keep a rollback copy of the last working config
// 4. Validate Alberding syntax before deploying

import fs from "fs";
import path from "path";

const MIN_STREAMS = 5;          // Minimum pinput/smarker lines to deploy
const MIN_ZONES = 1;            // At least one zone must exist
const MAX_CONFIG_SIZE = 10_000_000; // 10MB max config file

export interface SafetyCheckResult {
  safe: boolean;
  checks: Array<{ name: string; passed: boolean; detail: string }>;
  blocked_reason: string | null;
}

/**
 * Validate a generated config before deployment.
 * Returns safe=false if deployment would be dangerous.
 */
export function validateConfigSafety(config: string, dataDir: string): SafetyCheckResult {
  const checks: SafetyCheckResult["checks"] = [];
  let blocked = false;
  let blockedReason: string | null = null;

  // 1. Config not empty
  if (!config || config.trim().length < 100) {
    checks.push({ name: "not_empty", passed: false, detail: "Config is empty or too short" });
    blocked = true;
    blockedReason = "Empty config would disconnect all users";
  } else {
    checks.push({ name: "not_empty", passed: true, detail: `${config.length} characters` });
  }

  // 2. Minimum stream count
  const pinputCount = (config.match(/--pinput/g) || []).length;
  const smarkerCount = (config.match(/--smarker/g) || []).length;
  const totalStreams = pinputCount + smarkerCount;

  if (totalStreams < MIN_STREAMS) {
    checks.push({ name: "min_streams", passed: false, detail: `Only ${totalStreams} streams (need ${MIN_STREAMS}+)` });
    blocked = true;
    blockedReason = `Config has only ${totalStreams} streams — minimum is ${MIN_STREAMS}`;
  } else {
    checks.push({ name: "min_streams", passed: true, detail: `${totalStreams} streams (${pinputCount} pinput, ${smarkerCount} smarker)` });
  }

  // 3. Has at least one user or group
  const hasUsers = config.includes("--user") || config.includes("--group");
  checks.push({ name: "has_users", passed: hasUsers, detail: hasUsers ? "Users/groups defined" : "No users or groups" });

  // 4. Config size reasonable
  if (config.length > MAX_CONFIG_SIZE) {
    checks.push({ name: "size_check", passed: false, detail: `${(config.length / 1_000_000).toFixed(1)}MB exceeds 10MB limit` });
    blocked = true;
    blockedReason = "Config too large";
  } else {
    checks.push({ name: "size_check", passed: true, detail: `${(config.length / 1000).toFixed(1)}KB` });
  }

  // 5. No syntax errors (basic check)
  const lines = config.split("\n").filter(l => l.trim() && !l.trim().startsWith("#"));
  const invalidLines = lines.filter(l => {
    const trimmed = l.trim();
    // Valid lines start with -- directives or are continuations
    return trimmed.length > 0 &&
      !trimmed.startsWith("--") &&
      !trimmed.startsWith("'") && // URL in quotes
      !trimmed.startsWith("circle(") &&
      !trimmed.startsWith("polygon(") &&
      !trimmed.startsWith("overlap(") &&
      !trimmed.startsWith("tryrestart(") &&
      !trimmed.startsWith("CAS;") && // sourcetable CAS entry
      !trimmed.startsWith("STR;") && // sourcetable STR entry
      !trimmed.startsWith("passnmea"); // pinput continuation
  });
  const syntaxOk = invalidLines.length === 0;
  checks.push({ name: "syntax_check", passed: syntaxOk, detail: syntaxOk ? "All lines valid" : `${invalidLines.length} suspicious lines` });

  // 6. Geo-fence syntax validation (balanced parentheses)
  const fenceLines = config.split("\n").filter(l => l.includes("circle(") || l.includes("polygon("));
  const fenceErrors: string[] = [];
  for (const line of fenceLines) {
    const opens = (line.match(/\(/g) || []).length;
    const closes = (line.match(/\)/g) || []).length;
    if (opens !== closes) fenceErrors.push("Unbalanced parentheses in geo-fence");
  }
  const fencesOk = fenceErrors.length === 0;
  checks.push({ name: "geofence_syntax", passed: fencesOk, detail: fencesOk ? `${fenceLines.length} geo-fences valid` : fenceErrors[0] });

  // 7. ONOCOY URLs point to correct host (not geodnet)
  const onocoyPinputs = config.split("\n").filter(l => l.includes("ONO") && l.includes("--pinput"));
  const wrongHost = onocoyPinputs.filter(l => l.includes("rtk.geodnet.com"));
  const onocoyUrlOk = wrongHost.length === 0;
  if (onocoyPinputs.length > 0) {
    checks.push({ name: "onocoy_urls", passed: onocoyUrlOk, detail: onocoyUrlOk ? `${onocoyPinputs.length} ONOCOY streams point to clients.onocoy.com` : `${wrongHost.length} ONOCOY streams incorrectly point to rtk.geodnet.com` });
  }

  return {
    safe: !blocked,
    checks,
    blocked_reason: blockedReason,
  };
}

/**
 * Save a rollback copy of the current config before deploying a new one.
 */
export function saveRollback(currentConfig: string, dataDir: string) {
  try {
    const rollbackDir = path.join(dataDir, "config-rollback");
    if (!fs.existsSync(rollbackDir)) fs.mkdirSync(rollbackDir, { recursive: true });

    // Keep last 5 rollbacks
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const rollbackPath = path.join(rollbackDir, `ntrips_${timestamp}.cfg`);
    fs.writeFileSync(rollbackPath, currentConfig);

    // Clean old rollbacks (keep last 5)
    const files = fs.readdirSync(rollbackDir)
      .filter(f => f.startsWith("ntrips_") && f.endsWith(".cfg"))
      .sort()
      .reverse();

    for (const f of files.slice(5)) {
      try { fs.unlinkSync(path.join(rollbackDir, f)); } catch {}
    }

    console.log(`[CONFIG-SAFETY] Rollback saved: ${rollbackPath}`);
  } catch (err) {
    console.error("[CONFIG-SAFETY] Failed to save rollback:", err);
  }
}

/**
 * Get the latest rollback config for emergency restore.
 */
export function getLatestRollback(dataDir: string): string | null {
  try {
    const rollbackDir = path.join(dataDir, "config-rollback");
    if (!fs.existsSync(rollbackDir)) return null;

    const files = fs.readdirSync(rollbackDir)
      .filter(f => f.startsWith("ntrips_") && f.endsWith(".cfg"))
      .sort()
      .reverse();

    if (files.length === 0) return null;
    return fs.readFileSync(path.join(rollbackDir, files[0]), "utf-8");
  } catch {
    return null;
  }
}
