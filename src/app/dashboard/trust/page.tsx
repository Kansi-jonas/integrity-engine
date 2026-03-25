"use client";

import { useEffect, useState } from "react";
import {
  Shield, ShieldCheck, ShieldAlert, ShieldX, AlertTriangle,
  Loader2, RefreshCw, Search, ArrowLeft, ChevronDown, ChevronUp,
} from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
  AreaChart, Area, CartesianGrid,
} from "recharts";
import Link from "next/link";

// ─── Types ───────────────────────────────────────────────────────────────────

interface TrustScore {
  station: string;
  network: string;
  alpha: number;
  beta: number;
  trust_score: number;
  confidence: number;
  consistency: number;
  combined_score: number;
  total_sessions: number;
  flag: "trusted" | "probation" | "untrusted" | "new";
  last_updated: string;
}

interface TrustData {
  scores: TrustScore[];
  summary: {
    total: number;
    trusted: number;
    probation: number;
    untrusted: number;
    new: number;
    avg_trust: number;
  };
  computed_at: string;
}

// ─── Beta Distribution PDF (for visualization) ──────────────────────────────

function betaPdf(x: number, alpha: number, beta: number): number {
  if (x <= 0 || x >= 1) return 0;
  // Log-space to avoid overflow
  const logB = logGamma(alpha) + logGamma(beta) - logGamma(alpha + beta);
  const logPdf = (alpha - 1) * Math.log(x) + (beta - 1) * Math.log(1 - x) - logB;
  return Math.exp(logPdf);
}

function logGamma(z: number): number {
  // Stirling's approximation for log(Gamma(z))
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  z -= 1;
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.001208650973866179, -0.000005395239384953];
  let x = 0.99999999999980993;
  for (let i = 0; i < c.length; i++) x += c[i] / (z + i + 1);
  const t = z + c.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

function generateBetaCurve(alpha: number, beta: number): Array<{ x: number; y: number }> {
  const points: Array<{ x: number; y: number }> = [];
  for (let i = 1; i <= 99; i++) {
    const x = i / 100;
    points.push({ x: Math.round(x * 100) / 100, y: betaPdf(x, alpha, beta) });
  }
  return points;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const FLAG_CONFIG: Record<string, { color: string; bg: string; icon: any; label: string }> = {
  trusted: { color: "text-emerald-700", bg: "bg-emerald-100", icon: ShieldCheck, label: "Trusted" },
  probation: { color: "text-amber-700", bg: "bg-amber-100", icon: ShieldAlert, label: "Probation" },
  untrusted: { color: "text-red-700", bg: "bg-red-100", icon: ShieldX, label: "Untrusted" },
  new: { color: "text-gray-600", bg: "bg-gray-100", icon: Shield, label: "New" },
};

function FlagBadge({ flag }: { flag: string }) {
  const cfg = FLAG_CONFIG[flag] || FLAG_CONFIG.new;
  const Icon = cfg.icon;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${cfg.bg} ${cfg.color}`}>
      <Icon className="h-3 w-3" /> {cfg.label}
    </span>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function TrustPage() {
  const [data, setData] = useState<TrustData | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filterFlag, setFilterFlag] = useState<string>("all");
  const [selectedStation, setSelectedStation] = useState<TrustScore | null>(null);
  const [sortBy, setSortBy] = useState<"combined_score" | "total_sessions" | "trust_score">("combined_score");
  const [sortAsc, setSortAsc] = useState(false);

  const fetchData = () => {
    setLoading(true);
    fetch("/api/trust").then(r => r.json())
      .then(d => setData(d))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchData(); }, []);

  if (loading && !data) {
    return <div className="flex items-center justify-center h-screen"><Loader2 className="h-8 w-8 animate-spin text-gray-400" /></div>;
  }

  if (!data?.scores?.length) {
    return (
      <div className="min-h-screen bg-gray-50 p-6">
        <div className="max-w-7xl mx-auto">
          <Link href="/dashboard" className="text-sm text-blue-600 hover:underline flex items-center gap-1 mb-4"><ArrowLeft className="h-3 w-3" /> Back</Link>
          <h1 className="text-xl font-semibold mb-4">Station Trust Scores</h1>
          <div className="rounded-lg border bg-white p-8 text-center text-gray-500">
            Trust Agent hasn't run yet. Scores are computed every 4 hours.
          </div>
        </div>
      </div>
    );
  }

  // Filter and sort
  let filtered = data.scores.filter(s => {
    if (filterFlag !== "all" && s.flag !== filterFlag) return false;
    if (search && !s.station.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  filtered.sort((a, b) => {
    const va = a[sortBy], vb = b[sortBy];
    return sortAsc ? (va as number) - (vb as number) : (vb as number) - (va as number);
  });

  // Distribution chart data
  const distributionBuckets = [
    { range: "0-0.2", count: 0, color: "#dc2626" },
    { range: "0.2-0.4", count: 0, color: "#ea580c" },
    { range: "0.4-0.6", count: 0, color: "#d97706" },
    { range: "0.6-0.8", count: 0, color: "#65a30d" },
    { range: "0.8-1.0", count: 0, color: "#059669" },
  ];
  for (const s of data.scores) {
    const idx = Math.min(4, Math.floor(s.combined_score * 5));
    distributionBuckets[idx].count++;
  }

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <Link href="/dashboard" className="text-sm text-blue-600 hover:underline flex items-center gap-1 mb-1"><ArrowLeft className="h-3 w-3" /> Dashboard</Link>
            <h1 className="text-xl font-semibold text-gray-900">Station Trust Scores</h1>
            <p className="text-sm text-gray-500">Bayesian Beta-Distribution Trust Scoring — {data.summary.total} stations</p>
          </div>
          <button onClick={fetchData} disabled={loading} className="p-2 rounded-lg hover:bg-white border">
            <RefreshCw className={`h-4 w-4 text-gray-500 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>

        {/* Summary Cards */}
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          {(["trusted", "probation", "untrusted", "new"] as const).map(flag => {
            const cfg = FLAG_CONFIG[flag];
            const Icon = cfg.icon;
            return (
              <button key={flag} onClick={() => setFilterFlag(filterFlag === flag ? "all" : flag)}
                className={`rounded-lg border p-4 text-left transition ${filterFlag === flag ? "ring-2 ring-blue-500" : "hover:bg-white"}`}>
                <div className="flex items-center gap-2 mb-1">
                  <Icon className={`h-4 w-4 ${cfg.color}`} />
                  <span className="text-xs font-medium text-gray-500 uppercase">{cfg.label}</span>
                </div>
                <div className="text-2xl font-bold">{data.summary[flag]}</div>
              </button>
            );
          })}
          <div className="rounded-lg border bg-white p-4">
            <div className="text-xs font-medium text-gray-500 uppercase mb-1">Avg Trust</div>
            <div className="text-2xl font-bold">{data.summary.avg_trust}</div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Distribution Chart */}
          <div className="rounded-lg border bg-white p-4">
            <h3 className="text-sm font-semibold text-gray-700 mb-3">Trust Distribution</h3>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={distributionBuckets}>
                <XAxis dataKey="range" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} />
                <Tooltip />
                <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                  {distributionBuckets.map((b, i) => (
                    <Cell key={i} fill={b.color} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Selected Station Beta Distribution */}
          <div className="lg:col-span-2 rounded-lg border bg-white p-4">
            <h3 className="text-sm font-semibold text-gray-700 mb-3">
              {selectedStation ? `Beta Distribution — ${selectedStation.station}` : "Select a station to view Beta distribution"}
            </h3>
            {selectedStation ? (
              <div className="space-y-3">
                <ResponsiveContainer width="100%" height={180}>
                  <AreaChart data={generateBetaCurve(selectedStation.alpha, selectedStation.beta)}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="x" tick={{ fontSize: 10 }} tickFormatter={(v: number) => v.toFixed(1)} />
                    <YAxis tick={{ fontSize: 10 }} />
                    <Tooltip formatter={(v: any) => Number(v).toFixed(3)} labelFormatter={(l: any) => `Trust: ${l}`} />
                    <Area type="monotone" dataKey="y" stroke="#3b82f6" fill="#3b82f6" fillOpacity={0.15} />
                  </AreaChart>
                </ResponsiveContainer>
                <div className="grid grid-cols-4 gap-3 text-xs text-center">
                  <div><span className="text-gray-500">Alpha</span><div className="font-mono font-bold">{selectedStation.alpha}</div></div>
                  <div><span className="text-gray-500">Beta</span><div className="font-mono font-bold">{selectedStation.beta}</div></div>
                  <div><span className="text-gray-500">Trust</span><div className="font-mono font-bold">{selectedStation.trust_score}</div></div>
                  <div><span className="text-gray-500">Confidence</span><div className="font-mono font-bold">{selectedStation.confidence}</div></div>
                </div>
              </div>
            ) : (
              <div className="h-[180px] flex items-center justify-center text-gray-400 text-sm">
                Click a station row below
              </div>
            )}
          </div>
        </div>

        {/* Station Table */}
        <div className="rounded-lg border bg-white overflow-hidden">
          <div className="p-4 border-b flex items-center gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
              <input
                type="text"
                placeholder="Search station..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="w-full pl-9 pr-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <span className="text-xs text-gray-400">{filtered.length} stations</span>
          </div>
          <div className="overflow-auto max-h-[500px]">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 sticky top-0">
                <tr>
                  <th className="text-left px-4 py-2 text-xs font-medium text-gray-500">Station</th>
                  <th className="text-left px-4 py-2 text-xs font-medium text-gray-500">Network</th>
                  <th className="text-left px-4 py-2 text-xs font-medium text-gray-500">Flag</th>
                  <th className="text-right px-4 py-2 text-xs font-medium text-gray-500 cursor-pointer hover:text-gray-900"
                    onClick={() => { setSortBy("combined_score"); setSortAsc(!sortAsc); }}>
                    Combined {sortBy === "combined_score" && (sortAsc ? "↑" : "↓")}
                  </th>
                  <th className="text-right px-4 py-2 text-xs font-medium text-gray-500 cursor-pointer hover:text-gray-900"
                    onClick={() => { setSortBy("trust_score"); setSortAsc(!sortAsc); }}>
                    Trust {sortBy === "trust_score" && (sortAsc ? "↑" : "↓")}
                  </th>
                  <th className="text-right px-4 py-2 text-xs font-medium text-gray-500">Consistency</th>
                  <th className="text-right px-4 py-2 text-xs font-medium text-gray-500">Confidence</th>
                  <th className="text-right px-4 py-2 text-xs font-medium text-gray-500 cursor-pointer hover:text-gray-900"
                    onClick={() => { setSortBy("total_sessions"); setSortAsc(!sortAsc); }}>
                    Sessions {sortBy === "total_sessions" && (sortAsc ? "↑" : "↓")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, 200).map(s => (
                  <tr key={s.station}
                    onClick={() => setSelectedStation(s)}
                    className={`border-t cursor-pointer transition hover:bg-blue-50 ${selectedStation?.station === s.station ? "bg-blue-50" : ""}`}>
                    <td className="px-4 py-2 font-mono text-xs">{s.station}</td>
                    <td className="px-4 py-2 text-xs text-gray-500">{s.network}</td>
                    <td className="px-4 py-2"><FlagBadge flag={s.flag} /></td>
                    <td className="px-4 py-2 text-right font-mono text-xs">{s.combined_score}</td>
                    <td className="px-4 py-2 text-right font-mono text-xs">{s.trust_score}</td>
                    <td className="px-4 py-2 text-right font-mono text-xs">{s.consistency}</td>
                    <td className="px-4 py-2 text-right font-mono text-xs">{s.confidence}</td>
                    <td className="px-4 py-2 text-right font-mono text-xs">{s.total_sessions}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Footer */}
        <div className="text-center text-xs text-gray-400 pb-4">
          Last computed: {data.computed_at ? new Date(data.computed_at).toLocaleString("de-DE") : "—"}
        </div>
      </div>
    </div>
  );
}
