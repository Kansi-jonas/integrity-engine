"use client";

import { useEffect, useState } from "react";
import {
  ShieldAlert, ShieldCheck, ShieldX, Radio, Users, Activity,
  AlertTriangle, AlertCircle, CheckCircle2, Info, Loader2, RefreshCw,
  ChevronDown, ChevronUp, Sun, CloudLightning, Zap, Shield, Lock, Unlock,
} from "lucide-react";
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer,
  BarChart, Bar, Cell,
} from "recharts";

// ─── Types ───────────────────────────────────────────────────────────────────

interface Anomaly {
  id: string; type: string; severity: "critical" | "warning" | "info";
  station: string | null; region: any; affected_users: number;
  current_value: number; baseline_value: number; deviation_pct: number;
  detected_at: string; duration_min: number; recommended_action: string;
  method?: string;
}

interface RegionScore { name: string; score: number; trend: "improving" | "stable" | "declining"; stations: number; sessions_6h: number; }
interface StationTimeline { station: string; network: string; data: any[]; status: "normal" | "degraded" | "outage"; uq_score: number; }

interface SignalData {
  anomalies: Anomaly[];
  integrity_scores: { global: number; regions: RegionScore[] };
  stats: { stations_monitored: number; active_sessions: number; anomalies_24h: number; mean_fix_rate: number };
  station_timelines: StationTimeline[];
  computed_at: string;
}

interface TrustData {
  scores: Array<{ station: string; trust_score: number; confidence: number; consistency: number; combined_score: number; flag: string; total_sessions: number }>;
  summary: { total: number; trusted: number; probation: number; untrusted: number; new: number; avg_trust: number };
  computed_at: string;
}

interface SpaceWeather {
  kp_index: number; kp_forecast_3h: number; storm_level: string;
  btotal: number; bz: number; proton_flux: number;
  expected_impact: { fix_rate_impact_pct: number; affected_regions: string[]; description: string };
  fetched_at: string;
}

interface FenceData {
  actions: Array<{ id: string; action: string; station: string | null; reason: string; pushed: boolean; created_at: string }>;
  summary: { total_actions: number; downgrades: number; excludes: number; restores: number; new_fences: number };
  last_run: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const ANOMALY_LABELS: Record<string, string> = {
  fix_rate_drop: "Fix Rate Drop", mass_disconnect: "Mass Disconnect",
  age_spike: "Correction Age Spike", station_outage: "Station Outage",
  regional_degradation: "Regional Degradation", cusum_fix_drift: "CUSUM Fix Drift",
  cusum_age_drift: "CUSUM Age Drift", ewma_fix_drop: "EWMA Fix Drop",
  ewma_age_spike: "EWMA Age Spike", jamming_suspect: "Jamming Suspect",
};

function SeverityBadge({ severity }: { severity: string }) {
  const cfg: Record<string, { bg: string; text: string; Icon: any; label: string }> = {
    critical: { bg: "bg-red-100", text: "text-red-700", Icon: AlertCircle, label: "Critical" },
    warning: { bg: "bg-amber-100", text: "text-amber-700", Icon: AlertTriangle, label: "Warning" },
    info: { bg: "bg-blue-100", text: "text-blue-700", Icon: Info, label: "Info" },
  };
  const c = cfg[severity] || cfg.info;
  return <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${c.bg} ${c.text}`}><c.Icon className="h-3 w-3" /> {c.label}</span>;
}

function KpiCard({ icon: Icon, label, value, sub }: { icon: any; label: string; value: string | number; sub?: string }) {
  return (
    <div className="rounded-lg border bg-white p-4">
      <div className="flex items-center gap-2 mb-1">
        <Icon className="h-4 w-4 text-gray-400" />
        <span className="text-xs font-medium text-gray-500 uppercase tracking-wider">{label}</span>
      </div>
      <div className="text-2xl font-bold text-gray-900">{value}</div>
      {sub && <div className="text-xs text-gray-500 mt-0.5">{sub}</div>}
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const [signal, setSignal] = useState<SignalData | null>(null);
  const [trust, setTrust] = useState<TrustData | null>(null);
  const [weather, setWeather] = useState<SpaceWeather | null>(null);
  const [fences, setFences] = useState<FenceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  const fetchAll = () => {
    setLoading(true);
    Promise.all([
      fetch("/api/anomalies").then(r => r.json()).catch(() => null),
      fetch("/api/trust").then(r => r.json()).catch(() => null),
      fetch("/api/space-weather").then(r => r.json()).catch(() => null),
      fetch("/api/fences").then(r => r.json()).catch(() => null),
    ]).then(([s, t, w, f]) => {
      setSignal(s); setTrust(t); setWeather(w); setFences(f);
    }).finally(() => setLoading(false));
  };

  useEffect(() => { fetchAll(); const i = setInterval(fetchAll, 5 * 60000); return () => clearInterval(i); }, []);

  if (loading && !signal) {
    return <div className="flex items-center justify-center h-screen"><Loader2 className="h-8 w-8 animate-spin text-gray-400" /></div>;
  }

  const kp = weather?.kp_index ?? 0;
  const stormColor = kp >= 7 ? "text-red-600" : kp >= 5 ? "text-amber-600" : kp >= 4 ? "text-yellow-600" : "text-emerald-600";
  const StormIcon = kp >= 5 ? CloudLightning : Sun;

  const criticalCount = signal?.anomalies.filter(a => a.severity === "critical").length || 0;

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-gray-900">Integrity Engine</h1>
            <p className="text-sm text-gray-500">Signal Integrity Monitoring + Anomaly Detection</p>
          </div>
          <button onClick={fetchAll} disabled={loading} className="p-2 rounded-lg hover:bg-white border transition">
            <RefreshCw className={`h-4 w-4 text-gray-500 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>

        {/* Top KPI Strip */}
        <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
          {/* Global Integrity Score */}
          <div className={`rounded-lg border p-4 ${(signal?.integrity_scores.global ?? 0) >= 80 ? "bg-emerald-50 border-emerald-200" : (signal?.integrity_scores.global ?? 0) >= 60 ? "bg-amber-50 border-amber-200" : "bg-red-50 border-red-200"}`}>
            <div className="flex items-center gap-2 mb-1">
              {(signal?.integrity_scores.global ?? 0) >= 80 ? <ShieldCheck className="h-5 w-5 text-emerald-600" /> : <ShieldAlert className="h-5 w-5 text-amber-600" />}
              <span className="text-xs font-medium text-gray-500 uppercase">Integrity</span>
            </div>
            <div className="text-3xl font-bold">{signal?.integrity_scores.global ?? "—"}</div>
          </div>

          {/* Space Weather */}
          <div className={`rounded-lg border bg-white p-4`}>
            <div className="flex items-center gap-2 mb-1">
              <StormIcon className={`h-4 w-4 ${stormColor}`} />
              <span className="text-xs font-medium text-gray-500 uppercase">Kp Index</span>
            </div>
            <div className={`text-2xl font-bold ${stormColor}`}>{kp}</div>
            <div className="text-xs text-gray-500">{weather?.storm_level || "quiet"}</div>
          </div>

          <KpiCard icon={Activity} label="Mean Fix" value={`${signal?.stats.mean_fix_rate ?? 0}%`} />
          <KpiCard icon={Users} label="Active" value={signal?.stats.active_sessions ?? 0} />
          <KpiCard icon={Radio} label="Stations" value={(signal?.stats.stations_monitored ?? 0).toLocaleString()} />
          <KpiCard icon={AlertTriangle} label="Anomalies" value={signal?.stats.anomalies_24h ?? 0} sub={criticalCount > 0 ? `${criticalCount} critical` : undefined} />
        </div>

        {/* Space Weather Impact Banner */}
        {weather && kp >= 4 && (
          <div className={`rounded-lg border p-4 ${kp >= 6 ? "bg-red-50 border-red-200" : "bg-amber-50 border-amber-200"}`}>
            <div className="flex items-center gap-2 mb-1">
              <CloudLightning className={`h-5 w-5 ${kp >= 6 ? "text-red-600" : "text-amber-600"}`} />
              <span className="text-sm font-semibold">Geomagnetic Storm Active</span>
            </div>
            <p className="text-sm text-gray-700">{weather.expected_impact.description}</p>
            {weather.expected_impact.affected_regions.length > 0 && (
              <p className="text-xs text-gray-500 mt-1">Affected: {weather.expected_impact.affected_regions.join(", ")}</p>
            )}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Anomaly Feed */}
          <div className="lg:col-span-2 space-y-3">
            <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wider">Active Anomalies</h2>
            {(!signal?.anomalies.length) ? (
              <div className="rounded-lg border bg-white p-6 text-center">
                <CheckCircle2 className="h-8 w-8 text-emerald-500 mx-auto mb-2" />
                <p className="text-sm text-gray-600">All systems nominal.</p>
              </div>
            ) : (
              <div className="space-y-2">
                {signal.anomalies.slice(0, 20).map(a => (
                  <div key={a.id} className={`rounded-lg border bg-white overflow-hidden ${a.severity === "critical" ? "border-red-200" : a.severity === "warning" ? "border-amber-200" : "border-gray-200"}`}>
                    <button onClick={() => setExpanded(expanded === a.id ? null : a.id)} className="w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-gray-50">
                      <SeverityBadge severity={a.severity} />
                      <span className="text-sm font-medium text-gray-900 flex-1">
                        {ANOMALY_LABELS[a.type] || a.type}
                        {a.station && <span className="text-gray-500 font-normal ml-1">— {a.station}</span>}
                      </span>
                      {a.method && <span className="text-[10px] text-gray-400 font-mono uppercase">{a.method}</span>}
                      <span className="text-xs text-gray-400">{a.affected_users}u</span>
                      {expanded === a.id ? <ChevronUp className="h-4 w-4 text-gray-400" /> : <ChevronDown className="h-4 w-4 text-gray-400" />}
                    </button>
                    {expanded === a.id && (
                      <div className="px-4 pb-3 border-t border-gray-100 pt-3 space-y-2">
                        <div className="grid grid-cols-3 gap-4 text-xs">
                          <div><span className="text-gray-500">Current</span><div className="font-mono font-medium">{a.current_value}</div></div>
                          <div><span className="text-gray-500">Baseline</span><div className="font-mono font-medium">{a.baseline_value}</div></div>
                          <div><span className="text-gray-500">Deviation</span><div className={`font-mono font-medium ${a.deviation_pct < -30 ? "text-red-600" : a.deviation_pct < 0 ? "text-amber-600" : "text-emerald-600"}`}>{a.deviation_pct > 0 ? "+" : ""}{a.deviation_pct}%</div></div>
                        </div>
                        <div className="text-xs bg-gray-50 rounded p-2 text-gray-700">{a.recommended_action}</div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Right Column */}
          <div className="space-y-6">
            {/* Region Integrity */}
            <div className="space-y-3">
              <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wider">Region Integrity</h2>
              <div className="rounded-lg border bg-white p-4 space-y-3">
                {(signal?.integrity_scores.regions || []).map(r => (
                  <div key={r.name} className="flex items-center gap-3">
                    <span className="text-xs text-gray-600 w-24 truncate">{r.name}</span>
                    <div className="flex-1 bg-gray-100 rounded-full h-2 overflow-hidden">
                      <div className={`h-full rounded-full ${r.score >= 80 ? "bg-emerald-500" : r.score >= 60 ? "bg-amber-500" : "bg-red-500"}`} style={{ width: `${r.score}%` }} />
                    </div>
                    <span className="text-xs font-mono w-8 text-right">{r.score}</span>
                    <span className={`text-xs ${r.trend === "improving" ? "text-emerald-600" : r.trend === "declining" ? "text-red-600" : "text-gray-400"}`}>
                      {r.trend === "improving" ? "\u2191" : r.trend === "declining" ? "\u2193" : "\u2192"}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Trust Summary */}
            {trust?.summary && (
              <div className="space-y-3">
                <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wider">Station Trust</h2>
                <div className="rounded-lg border bg-white p-4">
                  <div className="grid grid-cols-2 gap-3 text-center">
                    <div><div className="text-lg font-bold text-emerald-600">{trust.summary.trusted}</div><div className="text-[10px] text-gray-500">Trusted</div></div>
                    <div><div className="text-lg font-bold text-amber-600">{trust.summary.probation}</div><div className="text-[10px] text-gray-500">Probation</div></div>
                    <div><div className="text-lg font-bold text-red-600">{trust.summary.untrusted}</div><div className="text-[10px] text-gray-500">Untrusted</div></div>
                    <div><div className="text-lg font-bold text-gray-400">{trust.summary.new}</div><div className="text-[10px] text-gray-500">New</div></div>
                  </div>
                  <div className="mt-3 pt-3 border-t text-center">
                    <div className="text-xs text-gray-500">Avg Trust Score</div>
                    <div className="text-xl font-bold">{trust.summary.avg_trust}</div>
                  </div>
                </div>
              </div>
            )}

            {/* Fence Actions */}
            {fences?.actions && fences.actions.length > 0 && (
              <div className="space-y-3">
                <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wider">Fence Actions</h2>
                <div className="rounded-lg border bg-white p-4 space-y-2">
                  {fences.actions.slice(0, 5).map(a => (
                    <div key={a.id} className="flex items-center gap-2 text-xs">
                      {a.pushed ? <Lock className="h-3 w-3 text-emerald-500" /> : <Unlock className="h-3 w-3 text-gray-400" />}
                      <span className={`font-medium ${a.action === "exclude" ? "text-red-600" : a.action === "downgrade" ? "text-amber-600" : "text-emerald-600"}`}>{a.action}</span>
                      <span className="text-gray-500 truncate flex-1">{a.station || "regional"}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Station Health Timelines */}
        {signal?.station_timelines && signal.station_timelines.length > 0 && (
          <div className="space-y-3">
            <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wider">Station Health (24h)</h2>
            <div className="rounded-lg border bg-white p-4">
              <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
                {signal.station_timelines.slice(0, 18).map(t => {
                  const color = t.status === "outage" ? "#dc2626" : t.status === "degraded" ? "#d97706" : "#059669";
                  const statusLabel = t.status === "outage" ? "OUTAGE" : t.status === "degraded" ? "DEGRADED" : "OK";
                  return (
                    <div key={t.station} className="space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] font-mono text-gray-600 truncate max-w-[80px]">{t.station}</span>
                        <span className={`text-[10px] font-medium ${t.status === "outage" ? "text-red-600" : t.status === "degraded" ? "text-amber-600" : "text-emerald-600"}`}>{statusLabel}</span>
                      </div>
                      <ResponsiveContainer width="100%" height={40}>
                        <LineChart data={t.data}>
                          <Line type="monotone" dataKey="fix_rate" stroke={color} strokeWidth={1.5} dot={false} />
                          <Line type="monotone" dataKey="baseline_fix_rate" stroke="#d1d5db" strokeWidth={1} strokeDasharray="3 3" dot={false} />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="text-center text-xs text-gray-400 pb-4">
          RTKdata Integrity Engine v0.1 — {signal?.computed_at ? `Last compute: ${new Date(signal.computed_at).toLocaleString("de-DE")}` : "Waiting for first compute..."}
        </div>
      </div>
    </div>
  );
}
