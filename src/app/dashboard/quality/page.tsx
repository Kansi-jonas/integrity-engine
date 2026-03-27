"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import {
  Map as MapIcon, Loader2, RefreshCw, Hexagon, Shield, AlertTriangle,
  CheckCircle2, XCircle, Radio, ArrowLeft,
} from "lucide-react";
import Link from "next/link";

const QualityMap = dynamic(() => import("./quality-map"), {
  ssr: false,
  loading: () => (
    <div className="w-full h-[600px] rounded-xl border border-[var(--color-border)] bg-white flex items-center justify-center">
      <div className="text-center">
        <MapIcon className="w-10 h-10 text-[var(--color-gray-300)] mb-3 mx-auto animate-pulse" />
        <p className="text-[13px] text-[var(--color-text-secondary)]">Loading quality map...</p>
      </div>
    </div>
  ),
});

// ─── Types ───────────────────────────────────────────────────────────────────

interface QualityData {
  version: string;
  architecture?: string;
  cells: any[];
  totalCells: number;
  tierCounts: Array<{ zone_tier: string; count: number; avg_quality: number }>;
  zones: any[];
  overlays?: any[];
  global_geodnet?: { enabled: boolean; priority: number; mountpoint: string };
  overlay_stats?: any;
  stations: { total: number; good: number; poor: number; avgUQ: number; avgUptime: number };
  computed_at: string | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const TIER_CONFIG: Record<string, { label: string; color: string; bg: string; icon: any }> = {
  full_rtk: { label: "Full RTK", color: "text-emerald-700", bg: "bg-emerald-50 border-emerald-200", icon: CheckCircle2 },
  degraded_rtk: { label: "Degraded RTK", color: "text-amber-700", bg: "bg-amber-50 border-amber-200", icon: AlertTriangle },
  float_dgps: { label: "Float/DGPS", color: "text-orange-700", bg: "bg-orange-50 border-orange-200", icon: Radio },
  no_coverage: { label: "No Coverage", color: "text-red-700", bg: "bg-red-50 border-red-200", icon: XCircle },
};

function KpiCard({ label, value, sub, icon: Icon, accent }: { label: string; value: string | number; sub?: string; icon: any; accent?: string }) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-white p-4 md:p-5 shadow-[var(--shadow-xs)]">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[11px] font-semibold text-[var(--color-text-tertiary)] uppercase tracking-wider">{label}</span>
        <div className="w-8 h-8 rounded-lg bg-[var(--color-gray-50)] flex items-center justify-center">
          <Icon className={`h-4 w-4 ${accent || "text-[var(--color-gray-400)]"}`} />
        </div>
      </div>
      <div className="text-[22px] font-semibold text-[var(--color-text-primary)] tabular-nums">{value}</div>
      {sub && <div className="text-[12px] text-[var(--color-text-tertiary)] mt-1">{sub}</div>}
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function QualityPage() {
  const [data, setData] = useState<QualityData | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = () => {
    setLoading(true);
    fetch("/api/quality")
      .then(r => r.json())
      .then(d => setData(d))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchData(); }, []);

  if (loading && !data) {
    return <div className="flex items-center justify-center h-screen"><Loader2 className="h-8 w-8 animate-spin text-[var(--color-gray-300)]" /></div>;
  }

  const tiers = data?.tierCounts || [];
  const getTier = (name: string) => tiers.find(t => t.zone_tier === name);

  return (
    <div className="min-h-screen p-4 sm:p-6 lg:p-8">
      <div className="max-w-[1600px] mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <Link href="/dashboard" className="text-[13px] text-[var(--color-brand)] hover:underline flex items-center gap-1 mb-1">
              <ArrowLeft className="h-3 w-3" /> Dashboard
            </Link>
            <div className="flex items-center gap-3">
              <h1 className="text-[18px] sm:text-[20px] font-semibold text-[var(--color-text-primary)]">Coverage Quality</h1>
              <span className="text-[11px] px-2 py-0.5 rounded-full bg-[var(--color-info-muted)] text-[var(--color-info)] font-medium">
                H3 Resolution 5
              </span>
            </div>
            <p className="text-[13px] text-[var(--color-text-secondary)] mt-0.5">
              {data?.architecture || "Physics-based coverage quality"} — {data?.totalCells?.toLocaleString() || 0} cells, {(data as any)?.overlays?.length || 0} ONOCOY overlays
            </p>
          </div>
          <button onClick={fetchData} disabled={loading} className="p-2 rounded-lg hover:bg-white border border-[var(--color-border)] transition shadow-[var(--shadow-xs)]">
            <RefreshCw className={`h-4 w-4 text-[var(--color-text-secondary)] ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>

        {/* KPI Cards */}
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          <KpiCard
            label="Total Cells"
            value={data?.totalCells?.toLocaleString() || 0}
            icon={Hexagon}
            accent="text-[var(--color-brand)]"
          />
          <KpiCard
            label="Full RTK"
            value={getTier("full_rtk")?.count?.toLocaleString() || 0}
            sub={`Avg quality: ${((getTier("full_rtk")?.avg_quality || 0) * 100).toFixed(0)}%`}
            icon={CheckCircle2}
            accent="text-emerald-500"
          />
          <KpiCard
            label="Degraded"
            value={getTier("degraded_rtk")?.count?.toLocaleString() || 0}
            sub={`Avg quality: ${((getTier("degraded_rtk")?.avg_quality || 0) * 100).toFixed(0)}%`}
            icon={AlertTriangle}
            accent="text-amber-500"
          />
          <KpiCard
            label="Zones Created"
            value={data?.zones?.length || 0}
            sub={`${data?.zones?.filter((z: any) => z.zone_tier === "full_rtk").length || 0} full RTK`}
            icon={MapIcon}
            accent="text-[var(--color-brand)]"
          />
          <KpiCard
            label="Stations"
            value={data?.stations?.total || 0}
            sub={`${data?.stations?.good || 0} good, ${data?.stations?.poor || 0} poor`}
            icon={Radio}
            accent="text-[var(--color-gray-500)]"
          />
        </div>

        {/* Quality Map */}
        <div className="rounded-xl border border-[var(--color-border)] bg-white shadow-[var(--shadow-xs)] overflow-hidden">
          <div className="px-5 py-4 border-b border-[var(--color-border-light)]">
            <h2 className="text-[15px] font-semibold text-[var(--color-text-primary)]">Coverage Quality Map</h2>
            <p className="text-[13px] text-[var(--color-text-secondary)] mt-0.5">
              H3 hexagons colored by quality tier — green = Full RTK, yellow = Degraded, orange = Float, red = No Coverage
            </p>
          </div>
          <QualityMap cells={data?.cells || []} zones={(data as any)?.overlays || data?.zones || []} />
        </div>

        {/* Global GEODNET Banner */}
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-5 shadow-[var(--shadow-xs)]">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-emerald-100 flex items-center justify-center">
              <Shield className="h-5 w-5 text-emerald-600" />
            </div>
            <div>
              <h3 className="text-[15px] font-semibold text-emerald-900">Global GEODNET — Priority {(data as any)?.global_geodnet?.priority || 10}</h3>
              <p className="text-[13px] text-emerald-700">Worldwide fallback via AUTO mountpoint — 25K+ stations, always available</p>
            </div>
          </div>
        </div>

        {/* ONOCOY Overlay List */}
        {((data as any)?.overlays || data?.zones || []).length > 0 && (
          <div className="rounded-xl border border-[var(--color-border)] bg-white shadow-[var(--shadow-xs)]">
            <div className="px-5 py-4 border-b border-[var(--color-border-light)]">
              <h2 className="text-[15px] font-semibold text-[var(--color-text-primary)]">ONOCOY Overlay Zones</h2>
              <p className="text-[13px] text-[var(--color-text-secondary)] mt-0.5">
                Targeted overlays where ONOCOY improves or fills gaps in GEODNET coverage
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-[var(--color-border-light)]">
                    <th className="px-5 py-3 text-left text-[11px] font-semibold text-[var(--color-text-tertiary)] uppercase tracking-wider">Zone</th>
                    <th className="px-5 py-3 text-left text-[11px] font-semibold text-[var(--color-text-tertiary)] uppercase tracking-wider">Type</th>
                    <th className="px-5 py-3 text-left text-[11px] font-semibold text-[var(--color-text-tertiary)] uppercase tracking-wider">Hardware</th>
                    <th className="px-5 py-3 text-left text-[11px] font-semibold text-[var(--color-text-tertiary)] uppercase tracking-wider">Reason</th>
                    <th className="px-5 py-3 text-right text-[11px] font-semibold text-[var(--color-text-tertiary)] uppercase tracking-wider">Priority</th>
                    <th className="px-5 py-3 text-right text-[11px] font-semibold text-[var(--color-text-tertiary)] uppercase tracking-wider">Confidence</th>
                    <th className="px-5 py-3 text-right text-[11px] font-semibold text-[var(--color-text-tertiary)] uppercase tracking-wider">Validation</th>
                  </tr>
                </thead>
                <tbody>
                  {((data as any)?.overlays || data?.zones || []).map((z: any, i: number) => {
                    const isPrimary = z.type === "onocoy_primary" || z.priority <= 10;
                    const validationColor = z.validation_status === "confirmed" ? "text-emerald-700 bg-emerald-50"
                      : z.validation_status === "live_testing" ? "text-amber-700 bg-amber-50"
                      : z.validation_status === "rejected" ? "text-red-700 bg-red-50"
                      : "text-[var(--color-text-tertiary)] bg-[var(--color-gray-50)]";
                    return (
                      <tr key={z.id || i} className="border-b border-[var(--color-border-light)] last:border-0 hover:bg-[var(--color-gray-25)] transition-colors">
                        <td className="px-5 py-3 font-medium text-[var(--color-text-primary)]">{z.name || z.onocoy_station}</td>
                        <td className="px-5 py-3">
                          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border ${isPrimary ? "bg-blue-50 border-blue-200 text-blue-700" : "bg-[var(--color-gray-50)] border-[var(--color-border)] text-[var(--color-text-secondary)]"}`}>
                            {isPrimary ? "Primary" : "Failover"}
                          </span>
                        </td>
                        <td className="px-5 py-3 text-[var(--color-text-secondary)]">{z.hardware_class || "—"}</td>
                        <td className="px-5 py-3 text-[var(--color-text-secondary)] text-[12px]">{(z.reason || "").replace(/_/g, " ")}</td>
                        <td className="px-5 py-3 text-right tabular-nums text-[var(--color-text-secondary)]">{z.priority}</td>
                        <td className="px-5 py-3 text-right tabular-nums font-medium">{((z.onocoy_confidence || z.avg_quality || 0) * 100).toFixed(0)}%</td>
                        <td className="px-5 py-3 text-right">
                          <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${validationColor}`}>
                            {z.validation_status || "untested"}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Footer */}
        <p className="text-[11px] text-[var(--color-text-tertiary)] text-center">
          {data?.computed_at ? `Last computed: ${new Date(data.computed_at).toLocaleString("de-DE")}` : "Quality pipeline has not run yet"}
        </p>
      </div>
    </div>
  );
}
