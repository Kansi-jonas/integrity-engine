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
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <Link href="/dashboard" className="text-sm text-blue-600 hover:underline flex items-center gap-1 mb-1"><ArrowLeft className="h-3 w-3" /> Dashboard</Link>
            <h1 className="text-xl font-semibold text-gray-900 flex items-center gap-2">
              <Zap className="h-5 w-5 text-amber-500" /> Interference Detection
            </h1>
            <p className="text-sm text-gray-500">SHIELD Agent — Jamming, Spoofing, Ionospheric Events</p>
          </div>
          <button onClick={fetchData} disabled={loading} className="p-2 rounded-lg hover:bg-white border">
            <RefreshCw className={`h-4 w-4 text-gray-500 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>

        {/* Type Summary Cards */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          {Object.entries(TYPE_CONFIG).filter(([type]) => type !== "unknown").map(([type, cfg]) => {
            const Icon = cfg.icon;
            const count = typeCounts[type] || 0;
            return (
              <div key={type} className="rounded-lg border bg-white p-4">
                <div className="flex items-center gap-2 mb-1">
                  <Icon className={`h-4 w-4 ${cfg.color}`} />
                  <span className="text-xs font-medium text-gray-500 uppercase">{cfg.label}</span>
                </div>
                <div className="text-2xl font-bold">{count}</div>
              </div>
            );
          })}
        </div>

        {/* Event List */}
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wider">Recent Events</h2>
          {recent.length === 0 ? (
            <div className="rounded-lg border bg-white p-8 text-center text-gray-500">
              No interference events detected. SHIELD is monitoring.
            </div>
          ) : (
            <div className="space-y-2">
              {recent.map(event => {
                const cfg = TYPE_CONFIG[event.classification] || TYPE_CONFIG.unknown;
                const Icon = cfg.icon;
                return (
                  <div key={event.id} className={`rounded-lg border bg-white p-4 ${event.severity === "critical" ? "border-red-200" : event.severity === "warning" ? "border-amber-200" : "border-gray-200"}`}>
                    <div className="flex items-start gap-3">
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${cfg.bg} ${cfg.color}`}>
                        <Icon className="h-3 w-3" /> {cfg.label}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-gray-900">{event.description}</div>
                        <div className="flex items-center gap-4 mt-1 text-xs text-gray-500">
                          <span>{event.affected_users} users</span>
                          <span>{event.affected_stations.length} stations</span>
                          <span>Confidence: {Math.round(event.confidence * 100)}%</span>
                          {event.region && <span>({event.region.lat.toFixed(1)}, {event.region.lon.toFixed(1)})</span>}
                          <span>{new Date(event.start_time).toLocaleString("de-DE")}</span>
                        </div>
                      </div>
                      <span className={`text-xs font-medium px-2 py-0.5 rounded ${event.severity === "critical" ? "bg-red-100 text-red-700" : event.severity === "warning" ? "bg-amber-100 text-amber-700" : "bg-gray-100 text-gray-600"}`}>
                        {event.severity}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="text-center text-xs text-gray-400 pb-4">
          Last scan: {data?.last_run ? new Date(data.last_run).toLocaleString("de-DE") : "—"}
        </div>
      </div>
    </div>
  );
}
