"use client";

import { useEffect, useState } from "react";
import {
  Radio, Shield, Loader2, RefreshCw, ArrowLeft,
  Zap, CloudLightning, AlertTriangle, Wifi, WifiOff, MapPin,
} from "lucide-react";
import Link from "next/link";

// ─── Types ───────────────────────────────────────────────────────────────────

interface InterferenceEvent {
  id: string;
  classification: string;
  confidence: number;
  features: any;
  region: { lat: number; lon: number; radius_km: number } | null;
  affected_users: number;
  affected_stations: string[];
  start_time: string;
  duration_min: number;
  severity: "critical" | "warning" | "info";
  description: string;
}

interface ShieldData {
  events: InterferenceEvent[];
  summary: Record<string, number>;
  last_run: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const TYPE_CONFIG: Record<string, { icon: any; color: string; bg: string; label: string }> = {
  jamming: { icon: WifiOff, color: "text-red-700", bg: "bg-red-100", label: "Jamming" },
  spoofing: { icon: Shield, color: "text-purple-700", bg: "bg-purple-100", label: "Spoofing" },
  iono: { icon: CloudLightning, color: "text-amber-700", bg: "bg-amber-100", label: "Ionospheric" },
  station_fault: { icon: Radio, color: "text-orange-700", bg: "bg-orange-100", label: "Station Fault" },
  multipath: { icon: MapPin, color: "text-cyan-700", bg: "bg-cyan-100", label: "Multipath" },
  network: { icon: Wifi, color: "text-blue-700", bg: "bg-blue-100", label: "Network" },
  unknown: { icon: AlertTriangle, color: "text-gray-600", bg: "bg-gray-100", label: "Unknown" },
};

// ─── Page ────────────────────────────────────────────────────────────────────

export default function InterferencePage() {
  const [data, setData] = useState<ShieldData | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = () => {
    setLoading(true);
    fetch("/api/interference").then(r => r.json())
      .then(d => setData(d))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchData(); }, []);

  if (loading && !data) {
    return <div className="flex items-center justify-center h-screen"><Loader2 className="h-8 w-8 animate-spin text-gray-400" /></div>;
  }

  const events = data?.events || [];
  const recent = events.slice(0, 50);

  // Count by type
  const typeCounts: Record<string, number> = {};
  for (const e of events) {
    typeCounts[e.classification] = (typeCounts[e.classification] || 0) + 1;
  }

  return (
    <div className="min-h-screen p-4 sm:p-6 lg:p-8">
      <div className="max-w-[1600px] mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <Link href="/dashboard" className="text-[13px] text-[var(--color-brand)] hover:underline flex items-center gap-1 mb-1"><ArrowLeft className="h-3 w-3" /> Dashboard</Link>
            <h1 className="text-[18px] sm:text-[20px] font-semibold text-[var(--color-text-primary)] flex items-center gap-2">
              Interference Detection
            </h1>
            <p className="text-[13px] text-[var(--color-text-secondary)] mt-0.5">SHIELD Agent — Jamming, Spoofing, Ionospheric Events</p>
          </div>
          <button onClick={fetchData} disabled={loading} className="p-2 rounded-lg hover:bg-white border border-[var(--color-border)] transition shadow-[var(--shadow-xs)]">
            <RefreshCw className={`h-4 w-4 text-[var(--color-text-secondary)] ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>

        {/* Type Summary Cards */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          {Object.entries(TYPE_CONFIG).filter(([type]) => type !== "unknown").map(([type, cfg]) => {
            const Icon = cfg.icon;
            const count = typeCounts[type] || 0;
            return (
              <div key={type} className="rounded-xl border border-[var(--color-border)] bg-white p-4 md:p-5 shadow-[var(--shadow-xs)]">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[11px] font-semibold text-[var(--color-text-tertiary)] uppercase tracking-wider">{cfg.label}</span>
                  <div className="w-8 h-8 rounded-lg bg-[var(--color-gray-50)] flex items-center justify-center">
                    <Icon className={`h-4 w-4 ${cfg.color}`} />
                  </div>
                </div>
                <div className="text-[22px] font-semibold text-[var(--color-text-primary)] tabular-nums">{count}</div>
              </div>
            );
          })}
        </div>

        {/* Event List */}
        <div className="space-y-3">
          <h2 className="text-[11px] font-semibold text-[var(--color-text-tertiary)] uppercase tracking-wider">Recent Events</h2>
          {recent.length === 0 ? (
            <div className="rounded-xl border border-[var(--color-border)] bg-white p-12 text-center shadow-[var(--shadow-xs)]">
              <Shield className="h-10 w-10 text-[var(--color-gray-300)] mx-auto mb-3" />
              <p className="text-[14px] text-[var(--color-text-secondary)]">No interference events detected</p>
              <p className="text-[12px] text-[var(--color-text-tertiary)] mt-1">SHIELD is monitoring every 5 minutes</p>
            </div>
          ) : (
            <div className="rounded-xl border border-[var(--color-border)] bg-white shadow-[var(--shadow-xs)] overflow-hidden">
              {recent.map((event, i) => {
                const cfg = TYPE_CONFIG[event.classification] || TYPE_CONFIG.unknown;
                const Icon = cfg.icon;
                return (
                  <div key={event.id} className={`flex items-start gap-3 px-5 py-4 ${i < recent.length - 1 ? "border-b border-[var(--color-border-light)]" : ""} hover:bg-[var(--color-gray-25)] transition-colors`}>
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border ${cfg.bg} ${cfg.color}`}>
                      <Icon className="h-3 w-3" /> {cfg.label}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="text-[13px] text-[var(--color-text-primary)]">{event.description}</div>
                      <div className="flex items-center gap-4 mt-1 text-[12px] text-[var(--color-text-tertiary)]">
                        <span>{event.affected_users} users</span>
                        <span>{event.affected_stations.length} stations</span>
                        <span>Confidence: {Math.round(event.confidence * 100)}%</span>
                        {event.region && <span>({event.region.lat.toFixed(1)}, {event.region.lon.toFixed(1)})</span>}
                        <span>{new Date(event.start_time).toLocaleString("de-DE")}</span>
                      </div>
                    </div>
                    <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full border ${
                      event.severity === "critical" ? "bg-[var(--color-danger-muted)] text-[var(--color-danger)] border-red-200"
                      : event.severity === "warning" ? "bg-[var(--color-warning-muted)] text-[var(--color-warning)] border-amber-200"
                      : "bg-[var(--color-gray-50)] text-[var(--color-text-secondary)] border-[var(--color-border)]"
                    }`}>
                      {event.severity}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <p className="text-[11px] text-[var(--color-text-tertiary)] text-center">
          Last scan: {data?.last_run ? new Date(data.last_run).toLocaleString("de-DE") : "—"}
        </p>
      </div>
    </div>
  );
}
