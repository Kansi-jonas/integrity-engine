"use client";

import { useEffect, useState } from "react";
import {
  Settings, Shield, ShieldCheck, ShieldX, Radio, Loader2, RefreshCw,
  ArrowLeft, Check, X, MapPin, Zap, Upload, FileCode, ChevronDown, ChevronUp,
} from "lucide-react";
import Link from "next/link";

// ─── Types ───────────────────────────────────────────────────────────────────

interface QualifiedStation {
  name: string; network: string; latitude: number; longitude: number;
  composite_score: number; trust_score: number; uq_score: number;
  uptime: number; consistency: number; cascade_priority: number;
  quality_tier: "platinum" | "gold" | "silver";
  disqualified: boolean; disqualify_reason: string | null;
}

interface ConfigData {
  qualified: QualifiedStation[];
  disqualified: QualifiedStation[];
  stats: {
    total_evaluated: number; qualified_count: number; disqualified_count: number;
    platinum: number; gold: number; silver: number;
    avg_composite: number; networks: Record<string, number>;
  };
  quality_gates: { min_trust: number; min_uptime: number; min_uq: number; exclude_critical_shield: boolean };
  generated_at: string;
}

interface ZoneData {
  zones: Array<{
    id: string; name: string; network_id: string; zone_type: string;
    integrity_score: number; expected_fix_rate: number;
    stations: string[]; priority: number; enabled: boolean;
  }>;
  stats: {
    total_zones: number; geodnet_zones: number; onocoy_gap_zones: number; onocoy_upgrade_zones: number;
    total_qualified: number; geodnet_qualified: number; onocoy_qualified: number; onocoy_skipped: number;
    kp_current: number; effective_gap_km: number; gaussian_sigma_km: number;
  };
  generated_at: string;
}

interface WizardConfig {
  config: string;
  lines: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const TIER_COLORS: Record<string, { bg: string; text: string; label: string }> = {
  platinum: { bg: "bg-violet-100", text: "text-violet-700", label: "Platinum" },
  gold: { bg: "bg-amber-100", text: "text-amber-700", label: "Gold" },
  silver: { bg: "bg-gray-100", text: "text-gray-600", label: "Silver" },
};

const ZONE_COLORS: Record<string, { bg: string; text: string }> = {
  geodnet_primary: { bg: "bg-emerald-100", text: "text-emerald-700" },
  onocoy_gap: { bg: "bg-blue-100", text: "text-blue-700" },
  onocoy_upgrade: { bg: "bg-purple-100", text: "text-purple-700" },
  failover: { bg: "bg-gray-100", text: "text-gray-600" },
};

// ─── Page ────────────────────────────────────────────────────────────────────

export default function ConfigPage() {
  const [config, setConfig] = useState<ConfigData | null>(null);
  const [zones, setZones] = useState<ZoneData | null>(null);
  const [wizardConfig, setWizardConfig] = useState<WizardConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [showConfig, setShowConfig] = useState(false);
  const [showDisqualified, setShowDisqualified] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [deployResult, setDeployResult] = useState<any>(null);

  const fetchAll = () => {
    setLoading(true);
    Promise.all([
      fetch("/api/qualified-stations").then(r => r.json()).catch(() => null),
      fetch("/api/zones").then(r => r.json()).catch(() => null),
      fetch("/api/wizard/config").then(r => r.json()).catch(() => null),
    ]).then(([c, z, w]) => {
      setConfig(c); setZones(z); setWizardConfig(w);
    }).finally(() => setLoading(false));
  };

  useEffect(() => { fetchAll(); }, []);

  const handleDeploy = async () => {
    if (!confirm("Deploy config to Alberding Caster?")) return;
    setDeploying(true);
    try {
      const res = await fetch("/api/wizard/deploy", { method: "POST" });
      const data = await res.json();
      setDeployResult(data);
    } catch (err) {
      setDeployResult({ error: String(err) });
    }
    setDeploying(false);
  };

  if (loading && !config) {
    return <div className="flex items-center justify-center h-screen"><Loader2 className="h-8 w-8 animate-spin text-gray-400" /></div>;
  }

  return (
    <div className="min-h-screen p-4 sm:p-6 lg:p-8">
      <div className="max-w-[1600px] mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <Link href="/dashboard" className="text-[13px] text-[var(--color-brand)] hover:underline flex items-center gap-1 mb-1">
              <ArrowLeft className="h-3 w-3" /> Dashboard
            </Link>
            <h1 className="text-[18px] sm:text-[20px] font-semibold text-[var(--color-text-primary)]">
              Caster Configuration
            </h1>
            <p className="text-[13px] text-[var(--color-text-secondary)] mt-0.5">Quality-gated station config for Alberding NTRIP Caster</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={fetchAll} disabled={loading} className="p-2 rounded-lg hover:bg-white border border-[var(--color-border)] transition shadow-[var(--shadow-xs)]">
              <RefreshCw className={`h-4 w-4 text-[var(--color-text-secondary)] ${loading ? "animate-spin" : ""}`} />
            </button>
            <button onClick={handleDeploy} disabled={deploying}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 text-sm font-medium">
              {deploying ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              Deploy to Caster
            </button>
          </div>
        </div>

        {/* Deploy Result */}
        {deployResult && (
          <div className={`rounded-lg border p-4 ${deployResult.success ? "bg-emerald-50 border-emerald-200" : "bg-red-50 border-red-200"}`}>
            {deployResult.success ? (
              <div className="flex items-center gap-2">
                <Check className="h-5 w-5 text-emerald-600" />
                <span className="text-sm font-medium text-emerald-800">
                  Deployed successfully ({deployResult.config_lines} lines) — {new Date(deployResult.uploaded_at).toLocaleString("de-DE")}
                </span>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <X className="h-5 w-5 text-red-600" />
                <span className="text-sm text-red-800">{deployResult.error || "Deploy failed"}</span>
              </div>
            )}
          </div>
        )}

        {/* Stats Overview */}
        {config?.stats && (
          <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
            <div className="rounded-lg border bg-white p-4">
              <div className="text-xs text-gray-500 uppercase">Evaluated</div>
              <div className="text-2xl font-bold">{config.stats.total_evaluated.toLocaleString()}</div>
            </div>
            <div className="rounded-lg border bg-emerald-50 border-emerald-200 p-4">
              <div className="text-xs text-emerald-600 uppercase">Qualified</div>
              <div className="text-2xl font-bold text-emerald-700">{config.stats.qualified_count.toLocaleString()}</div>
            </div>
            <div className="rounded-lg border bg-red-50 border-red-200 p-4">
              <div className="text-xs text-red-600 uppercase">Disqualified</div>
              <div className="text-2xl font-bold text-red-700">{config.stats.disqualified_count.toLocaleString()}</div>
            </div>
            <div className="rounded-lg border bg-violet-50 border-violet-200 p-4">
              <div className="text-xs text-violet-600 uppercase">Platinum</div>
              <div className="text-2xl font-bold text-violet-700">{config.stats.platinum}</div>
            </div>
            <div className="rounded-lg border bg-amber-50 border-amber-200 p-4">
              <div className="text-xs text-amber-600 uppercase">Gold</div>
              <div className="text-2xl font-bold text-amber-700">{config.stats.gold}</div>
            </div>
            <div className="rounded-lg border bg-white p-4">
              <div className="text-xs text-gray-500 uppercase">Silver</div>
              <div className="text-2xl font-bold">{config.stats.silver}</div>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Zones */}
          <div className="space-y-3">
            <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wider flex items-center gap-2">
              <MapPin className="h-4 w-4" /> Generated Zones
              {zones?.stats && <span className="text-gray-400 font-normal">({zones.stats.total_zones})</span>}
            </h2>

            {zones?.stats && (
              <div className="rounded-lg border bg-white p-3 grid grid-cols-4 gap-2 text-center text-xs">
                <div><div className="font-bold text-emerald-600">{zones.stats.geodnet_zones}</div>GEODNET</div>
                <div><div className="font-bold text-blue-600">{zones.stats.onocoy_gap_zones}</div>ONO Gap</div>
                <div><div className="font-bold text-purple-600">{zones.stats.onocoy_upgrade_zones}</div>ONO Upgrade</div>
                <div><div className="font-bold text-gray-500">{zones.stats.onocoy_skipped}</div>ONO Skip</div>
              </div>
            )}

            {zones?.stats && zones.stats.kp_current >= 4 && (
              <div className="rounded-lg bg-amber-50 border border-amber-200 p-2 text-xs text-amber-700">
                <Zap className="h-3 w-3 inline mr-1" />
                Kp={zones.stats.kp_current}: Zones using reduced range ({zones.stats.effective_gap_km}km instead of 40km)
              </div>
            )}

            <div className="rounded-lg border bg-white overflow-hidden max-h-[400px] overflow-y-auto">
              {zones?.zones?.map(z => {
                const colors = ZONE_COLORS[z.zone_type] || ZONE_COLORS.failover;
                return (
                  <div key={z.id} className="flex items-center gap-2 px-3 py-2 border-b last:border-0 hover:bg-gray-50">
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${colors.bg} ${colors.text}`}>
                      {z.zone_type.replace("onocoy_", "").replace("geodnet_", "").toUpperCase()}
                    </span>
                    <span className="text-xs text-gray-700 flex-1 truncate">{z.name}</span>
                    <span className="text-[10px] font-mono text-gray-400">P{z.priority}</span>
                    <span className="text-[10px] font-mono text-gray-500">{z.stations.length} stn</span>
                    <span className={`text-[10px] font-mono ${z.integrity_score >= 70 ? "text-emerald-600" : z.integrity_score >= 50 ? "text-amber-600" : "text-red-600"}`}>
                      {z.integrity_score}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Quality Gates + Network Breakdown */}
          <div className="space-y-3">
            <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wider flex items-center gap-2">
              <Shield className="h-4 w-4" /> Quality Gates
            </h2>

            {config?.quality_gates && (
              <div className="rounded-lg border bg-white p-4 space-y-2">
                {[
                  { label: "Trust Composite", value: `≥ ${config.quality_gates.min_trust}`, icon: ShieldCheck },
                  { label: "Uptime (7d)", value: `≥ ${config.quality_gates.min_uptime * 100}%`, icon: Radio },
                  { label: "UQ Score", value: `≥ ${config.quality_gates.min_uq}`, icon: Shield },
                  { label: "SHIELD Events", value: config.quality_gates.exclude_critical_shield ? "Exclude Critical" : "Allow", icon: Zap },
                ].map(gate => (
                  <div key={gate.label} className="flex items-center gap-2 text-xs">
                    <gate.icon className="h-3.5 w-3.5 text-gray-400" />
                    <span className="text-gray-600 flex-1">{gate.label}</span>
                    <span className="font-mono font-medium">{gate.value}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Network Breakdown */}
            {config?.stats?.networks && (
              <div className="space-y-2">
                <h3 className="text-xs font-semibold text-gray-700 uppercase">Networks</h3>
                <div className="rounded-lg border bg-white p-4 space-y-2">
                  {Object.entries(config.stats.networks).sort(([, a], [, b]) => b - a).map(([network, count]) => (
                    <div key={network} className="flex items-center gap-2">
                      <span className="text-xs text-gray-600 w-24">{network}</span>
                      <div className="flex-1 bg-gray-100 rounded-full h-2">
                        <div className="h-full rounded-full bg-blue-500"
                          style={{ width: `${(count / config.stats.qualified_count) * 100}%` }} />
                      </div>
                      <span className="text-xs font-mono w-12 text-right">{count}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Config Preview Toggle */}
            <button onClick={() => setShowConfig(!showConfig)}
              className="flex items-center gap-2 text-sm text-blue-600 hover:underline">
              <FileCode className="h-4 w-4" />
              {showConfig ? "Hide" : "Show"} ntrips.cfg Preview
              {showConfig ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            </button>
          </div>
        </div>

        {/* Config Preview */}
        {showConfig && wizardConfig?.config && (
          <div className="rounded-lg border bg-gray-900 p-4 overflow-auto max-h-[500px]">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-gray-400">ntrips.cfg — {wizardConfig.lines} lines</span>
            </div>
            <pre className="text-xs text-green-400 font-mono whitespace-pre">{wizardConfig.config}</pre>
          </div>
        )}

        {/* Disqualified Stations */}
        <div className="space-y-3">
          <button onClick={() => setShowDisqualified(!showDisqualified)}
            className="flex items-center gap-2 text-sm font-semibold text-gray-700 uppercase tracking-wider">
            <ShieldX className="h-4 w-4 text-red-500" />
            Disqualified Stations ({config?.disqualified?.length || 0})
            {showDisqualified ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </button>

          {showDisqualified && config?.disqualified && (
            <div className="rounded-lg border bg-white overflow-hidden max-h-[400px] overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="bg-gray-50 sticky top-0">
                  <tr>
                    <th className="text-left px-3 py-2 text-gray-500">Station</th>
                    <th className="text-left px-3 py-2 text-gray-500">Network</th>
                    <th className="text-right px-3 py-2 text-gray-500">Score</th>
                    <th className="text-left px-3 py-2 text-gray-500">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {config.disqualified.slice(0, 100).map(s => (
                    <tr key={s.name} className="border-t">
                      <td className="px-3 py-1.5 font-mono">{s.name}</td>
                      <td className="px-3 py-1.5 text-gray-500">{s.network}</td>
                      <td className="px-3 py-1.5 text-right font-mono text-red-600">{s.composite_score}</td>
                      <td className="px-3 py-1.5 text-gray-500 truncate max-w-[300px]">{s.disqualify_reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="text-center text-xs text-gray-400 pb-4">
          Last generated: {config?.generated_at ? new Date(config.generated_at).toLocaleString("de-DE") : "—"}
        </div>
      </div>
    </div>
  );
}
