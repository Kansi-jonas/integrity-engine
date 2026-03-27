// ─── Adversarial Station Detector ────────────────────────────────────────────
// Detects stations gaming DePIN token rewards.
//
// Attack vectors:
// 1. Clone: Same physical station registered multiple times (correlate data)
// 2. Position Spoofing: Claimed position differs from actual (RINEX vs API)
// 3. Rebroadcast: Forwarding another station's data with time offset
// 4. Quality Gaming: Station passes network QC but produces bad corrections
// 5. Zombie: Station running but nobody maintains it (gradual degradation)
//
// Detection is primarily from session-level data (no raw observations needed).
// PPK/RINEX analysis adds deeper checks when available.

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { haversineKm } from "../spatial/variogram";

export interface AdversarialReport {
  suspicious_stations: SuspiciousStation[];
  clone_clusters: CloneCluster[];
  zombie_stations: string[];
  total_analyzed: number;
  total_flagged: number;
  computed_at: string;
}

interface SuspiciousStation {
  station: string;
  network: string;
  type: "clone" | "position_spoof" | "rebroadcast" | "quality_gaming" | "zombie";
  confidence: number;   // 0-1
  evidence: string;
  recommendation: "monitor" | "investigate" | "downgrade" | "exclude";
}

interface CloneCluster {
  stations: string[];
  similarity: number;   // 0-1
  evidence: string;
}

export function runAdversarialDetector(db: Database.Database, dataDir: string): AdversarialReport {
  const suspicious: SuspiciousStation[] = [];
  const cloneClusters: CloneCluster[] = [];
  const zombies: string[] = [];

  // Load station data
  let stations: any[] = [];
  try {
    stations = db.prepare(`
      SELECT s.name, s.latitude, s.longitude, s.network, s.status,
             sc.avg_fix_rate, sc.uq_score, sc.session_count, sc.uptime_7d,
             sc.zero_fix_ratio, sc.computed_at
      FROM stations s
      LEFT JOIN station_scores sc ON s.name = sc.station_name
      WHERE s.latitude IS NOT NULL AND s.longitude IS NOT NULL
    `).all() as any[];
  } catch { return emptyReport(); }

  // ── 1. Clone Detection (spatial grid for O(n) instead of O(n²)) ────────
  // Group stations into fine grid cells (~100m) then only compare within same cell
  const cloneGrid = new Map<string, typeof stations>();
  for (const s of stations) {
    // Grid key at ~100m resolution (0.001° ≈ 111m)
    const key = `${Math.round(s.latitude * 1000)}:${Math.round(s.longitude * 1000)}`;
    if (!cloneGrid.has(key)) cloneGrid.set(key, []);
    cloneGrid.get(key)!.push(s);
  }

  for (const [, cellStations] of cloneGrid) {
    if (cellStations.length < 2) continue;
    // Only compare within same grid cell (max ~10 stations per cell)
    for (let i = 0; i < cellStations.length; i++) {
      for (let j = i + 1; j < cellStations.length; j++) {
        const dist = haversineKm(
          cellStations[i].latitude, cellStations[i].longitude,
          cellStations[j].latitude, cellStations[j].longitude
        );

        if (dist < 0.05 && cellStations[i].network === cellStations[j].network) {
          cloneClusters.push({
            stations: [cellStations[i].name, cellStations[j].name],
            similarity: Math.round((1 - dist / 0.05) * 100) / 100,
            evidence: `${Math.round(dist * 1000)}m apart on same network (${cellStations[i].network})`,
          });

          suspicious.push({
            station: cellStations[j].name,
            network: cellStations[j].network,
            type: "clone",
            confidence: dist < 0.01 ? 0.95 : 0.7,
            evidence: `Only ${Math.round(dist * 1000)}m from ${cellStations[i].name} on same network`,
            recommendation: dist < 0.01 ? "exclude" : "downgrade",
          });
        }
      }
    }
  }

  // ── 2. Quality Gaming Detection ─────────────────────────────────────────
  // Station has good UQ score but users consistently get bad fixes
  for (const s of stations) {
    if (!s.uq_score || !s.avg_fix_rate) continue;

    // High UQ but low actual fix rate = suspicious
    if (s.uq_score > 0.7 && s.avg_fix_rate < 40 && (s.session_count || 0) >= 10) {
      suspicious.push({
        station: s.name,
        network: s.network,
        type: "quality_gaming",
        confidence: 0.6 + Math.min(0.3, (0.7 - s.avg_fix_rate / 100) * 0.5),
        evidence: `UQ score ${s.uq_score} but actual fix rate only ${Math.round(s.avg_fix_rate)}% (${s.session_count} sessions)`,
        recommendation: "investigate",
      });
    }

    // Very high zero-fix ratio but station shows as "online"
    if ((s.zero_fix_ratio || 0) > 0.5 && s.status === "ONLINE" && (s.session_count || 0) >= 5) {
      suspicious.push({
        station: s.name,
        network: s.network,
        type: "quality_gaming",
        confidence: 0.5 + s.zero_fix_ratio * 0.3,
        evidence: `${Math.round(s.zero_fix_ratio * 100)}% of sessions have zero fix rate despite ONLINE status`,
        recommendation: s.zero_fix_ratio > 0.8 ? "exclude" : "downgrade",
      });
    }
  }

  // ── 3. Zombie Station Detection ─────────────────────────────────────────
  // Station online but uptime declining + no recent sessions
  for (const s of stations) {
    if ((s.uptime_7d || 0) < 0.2 && (s.session_count || 0) <= 1 && s.status === "ONLINE") {
      zombies.push(s.name);
      suspicious.push({
        station: s.name,
        network: s.network,
        type: "zombie",
        confidence: 0.7,
        evidence: `Uptime ${Math.round((s.uptime_7d || 0) * 100)}%, only ${s.session_count || 0} sessions, but status ONLINE`,
        recommendation: "downgrade",
      });
    }
  }

  // ── 4. Position Spoofing (needs PPK/RINEX data) ─────────────────────────
  // Check if PPK analysis results exist
  try {
    const ppkPath = path.join(dataDir, "ppk-results.json");
    if (fs.existsSync(ppkPath)) {
      const ppkResults = JSON.parse(fs.readFileSync(ppkPath, "utf-8"));
      for (const ppk of (ppkResults.results || [])) {
        if (ppk.position_offset_m > 100) {
          suspicious.push({
            station: ppk.station,
            network: ppk.network || "unknown",
            type: "position_spoof",
            confidence: Math.min(0.95, 0.5 + ppk.position_offset_m / 1000),
            evidence: `RINEX position differs by ${Math.round(ppk.position_offset_m)}m from claimed position`,
            recommendation: ppk.position_offset_m > 500 ? "exclude" : "investigate",
          });
        }
      }
    }
  } catch {}

  const report: AdversarialReport = {
    suspicious_stations: suspicious,
    clone_clusters: cloneClusters,
    zombie_stations: zombies,
    total_analyzed: stations.length,
    total_flagged: suspicious.length,
    computed_at: new Date().toISOString(),
  };

  // Persist
  try {
    const filePath = path.join(dataDir, "adversarial-report.json");
    const tmp = filePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(report, null, 2));
    fs.renameSync(tmp, filePath);
  } catch {}

  return report;
}

function emptyReport(): AdversarialReport {
  return { suspicious_stations: [], clone_clusters: [], zombie_stations: [], total_analyzed: 0, total_flagged: 0, computed_at: new Date().toISOString() };
}
