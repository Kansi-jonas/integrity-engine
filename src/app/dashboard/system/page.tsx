"use client";

import { useEffect, useState } from "react";
import {
  Loader2, RefreshCw, ArrowLeft, Database, Server, Radio, Shield,
  Activity, Clock, HardDrive, Wifi, CheckCircle2, XCircle, AlertTriangle,
  Zap, Globe, Eye, BarChart3,
} from "lucide-react";
import Link from "next/link";

export default function SystemPage() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [probeStatus, setProbeStatus] = useState<any>(null);

  const fetchAll = () => {
    setLoading(true);
    Promise.all([
      fetch("/api/monitor").then(r => r.json()).catch(() => null),
      fetch("/api/probe?action=status").then(r => r.json()).catch(() => null),
    ]).then(([m, p]) => {
      setData(m);
      setProbeStatus(p);
    }).finally(() => setLoading(false));
  };

  useEffect(() => { fetchAll(); const i = setInterval(fetchAll, 30000); return () => clearInterval(i); }, []);

  if (loading && !data) {
    return <div className="flex items-center justify-center h-screen"><Loader2 className="h-8 w-8 animate-spin text-[var(--color-gray-300)]" /></div>;
  }

  const env = data?.env || {};
  const db = data?.db || {};
  const sessions = data?.sessions || {};
  const quality = data?.quality || {};
  const onocoy = data?.onocoy || {};
  const pipeline = data?.pipeline || {};
  const sync = data?.sync || {};
  const trust = data?.trust || {};
  const environment = data?.environment || {};
  const config = data?.config || {};

  return (
    <div className="min-h-screen p-4 sm:p-6 lg:p-8">
      <div className="max-w-[1600px] mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <Link href="/dashboard" className="text-[13px] text-[var(--color-brand)] hover:underline flex items-center gap-1 mb-1">
              <ArrowLeft className="h-3 w-3" /> Dashboard
            </Link>
            <h1 className="text-[18px] sm:text-[20px] font-semibold text-[var(--color-text-primary)]">System Status</h1>
            <p className="text-[13px] text-[var(--color-text-secondary)] mt-0.5">Complete operational overview</p>
          </div>
          <button onClick={fetchAll} disabled={loading} className="p-2 rounded-lg hover:bg-white border border-[var(--color-border)] transition shadow-[var(--shadow-xs)]">
            <RefreshCw className={`h-4 w-4 text-[var(--color-text-secondary)] ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>

        {/* Top KPIs */}
        <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
          {[
            { label: "Sessions", value: (sessions.total || 0).toLocaleString(), icon: Activity, accent: "text-[var(--color-brand)]" },
            { label: "Stations", value: (db.tables?.stations || 0).toLocaleString(), icon: Radio, accent: "text-emerald-500" },
            { label: "H3 Cells", value: (quality.total_cells || 0).toLocaleString(), icon: Globe, accent: "text-violet-500" },
            { label: "Green %", value: `${quality.green_percentage || 0}%`, icon: Shield, accent: quality.green_percentage > 50 ? "text-emerald-500" : "text-amber-500" },
            { label: "DB Size", value: `${db.size_mb || 0} MB`, icon: Database, accent: db.size_mb > 4000 ? "text-red-500" : "text-[var(--color-gray-500)]" },
            { label: "Kp Index", value: environment.kp ?? "?", icon: Zap, accent: (environment.kp || 0) >= 5 ? "text-red-500" : "text-emerald-500" },
          ].map(kpi => (
            <div key={kpi.label} className="rounded-xl border border-[var(--color-border)] bg-white p-4 shadow-[var(--shadow-xs)]">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[11px] font-semibold text-[var(--color-text-tertiary)] uppercase tracking-wider">{kpi.label}</span>
                <kpi.icon className={`h-4 w-4 ${kpi.accent}`} />
              </div>
              <div className="text-[22px] font-semibold text-[var(--color-text-primary)] tabular-nums">{kpi.value}</div>
            </div>
          ))}
        </div>

        {/* Env Vars + Pipeline Status */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Env Vars */}
          <div className="rounded-xl border border-[var(--color-border)] bg-white shadow-[var(--shadow-xs)]">
            <div className="px-5 py-4 border-b border-[var(--color-border-light)]">
              <h2 className="text-[15px] font-semibold text-[var(--color-text-primary)]">Environment Variables</h2>
            </div>
            <div className="p-5 space-y-2">
              {Object.entries(env).map(([key, val]) => (
                <div key={key} className="flex items-center justify-between text-[13px]">
                  <span className="font-mono text-[var(--color-text-secondary)]">{key}</span>
                  {val ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : <XCircle className="h-4 w-4 text-red-400" />}
                </div>
              ))}
            </div>
          </div>

          {/* Pipeline Status */}
          <div className="rounded-xl border border-[var(--color-border)] bg-white shadow-[var(--shadow-xs)]">
            <div className="px-5 py-4 border-b border-[var(--color-border-light)]">
              <h2 className="text-[15px] font-semibold text-[var(--color-text-primary)]">Agent Pipeline</h2>
            </div>
            <div className="p-5 space-y-2">
              {Object.entries(pipeline).map(([name, info]: [string, any]) => (
                <div key={name} className="flex items-center justify-between text-[13px]">
                  <span className="text-[var(--color-text-primary)]">{name.replace(/-/g, " ")}</span>
                  <div className="flex items-center gap-2">
                    {info.exists ? (
                      <>
                        <span className="text-[var(--color-text-tertiary)] tabular-nums">{info.age_min}m ago</span>
                        <span className="text-[var(--color-text-tertiary)] tabular-nums">{info.size_kb}KB</span>
                        <span className={`w-2 h-2 rounded-full ${info.age_min < 300 ? "bg-emerald-500" : info.age_min < 600 ? "bg-amber-500" : "bg-red-500"}`} />
                      </>
                    ) : (
                      <span className="text-[var(--color-text-tertiary)]">not run</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ONOCOY Probe + Sync Status */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* ONOCOY Probe */}
          <div className="rounded-xl border border-[var(--color-border)] bg-white shadow-[var(--shadow-xs)]">
            <div className="px-5 py-4 border-b border-[var(--color-border-light)]">
              <h2 className="text-[15px] font-semibold text-[var(--color-text-primary)]">ONOCOY Discovery Probe</h2>
            </div>
            <div className="p-5 space-y-3">
              <div className="flex items-center justify-between text-[13px]">
                <span>Total ONOCOY</span>
                <span className="font-semibold tabular-nums">{(onocoy.total_stations || probeStatus?.total_onocoy || 0).toLocaleString()}</span>
              </div>
              <div className="flex items-center justify-between text-[13px]">
                <span>Probed (exact hardware)</span>
                <span className="font-semibold tabular-nums">{(onocoy.probed_exact || probeStatus?.probed || 0).toLocaleString()}</span>
              </div>
              <div className="flex items-center justify-between text-[13px]">
                <span>Survey-Grade Found</span>
                <span className="font-semibold tabular-nums text-emerald-600">{probeStatus?.progress?.found_survey || probeStatus?.survey_grade || 0}</span>
              </div>
              {probeStatus?.progress?.running && (
                <div className="mt-3">
                  <div className="flex items-center justify-between text-[12px] text-[var(--color-text-tertiary)] mb-1">
                    <span>Scanning...</span>
                    <span>{probeStatus.progress.done}/{probeStatus.progress.total} ({Math.round(probeStatus.progress.done / Math.max(1, probeStatus.progress.total) * 100)}%)</span>
                  </div>
                  <div className="w-full h-2 bg-[var(--color-gray-100)] rounded-full overflow-hidden">
                    <div className="h-full bg-[var(--color-brand)] rounded-full transition-all" style={{ width: `${Math.round(probeStatus.progress.done / Math.max(1, probeStatus.progress.total) * 100)}%` }} />
                  </div>
                </div>
              )}
              {(onocoy.hardware_breakdown || []).slice(0, 8).map((hw: any) => (
                <div key={hw.receiver_type} className="flex items-center justify-between text-[12px] text-[var(--color-text-secondary)]">
                  <span className="font-mono truncate max-w-[200px]">{hw.receiver_type}</span>
                  <span className="tabular-nums">{hw.cnt}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Sync Status */}
          <div className="rounded-xl border border-[var(--color-border)] bg-white shadow-[var(--shadow-xs)]">
            <div className="px-5 py-4 border-b border-[var(--color-border-light)]">
              <h2 className="text-[15px] font-semibold text-[var(--color-text-primary)]">Data Sync</h2>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <div className="text-[11px] font-semibold text-[var(--color-text-tertiary)] uppercase tracking-wider mb-1">rtkbi Historical Sync</div>
                <div className="text-[13px]">
                  <span className="font-semibold">{(sync.rtkbi?.total_imported || 0).toLocaleString()}</span>
                  <span className="text-[var(--color-text-secondary)]"> sessions imported</span>
                </div>
                {sync.rtkbi?.last_run && <div className="text-[12px] text-[var(--color-text-tertiary)]">Last: {new Date(sync.rtkbi.last_run).toLocaleString("de-DE")}</div>}
              </div>
              <div>
                <div className="text-[11px] font-semibold text-[var(--color-text-tertiary)] uppercase tracking-wider mb-1">Sessions</div>
                <div className="text-[13px]">
                  <span className="font-semibold">{(sessions.total || 0).toLocaleString()}</span> total,{" "}
                  <span className="font-semibold">{(sessions.last_24h || 0).toLocaleString()}</span> last 24h
                </div>
                <div className="text-[12px] text-[var(--color-text-tertiary)]">Span: {sessions.time_span_days || 0} days</div>
              </div>
              <div>
                <div className="text-[11px] font-semibold text-[var(--color-text-tertiary)] uppercase tracking-wider mb-1">Trust</div>
                <div className="text-[13px]">
                  <span className="text-emerald-600 font-semibold">{trust.trusted || 0}</span> trusted,{" "}
                  <span className="text-amber-600 font-semibold">{trust.probation || 0}</span> probation,{" "}
                  <span className="text-red-600 font-semibold">{trust.untrusted || 0}</span> untrusted,{" "}
                  <span className="text-[var(--color-text-tertiary)]">{trust.new || 0} new</span>
                </div>
              </div>
              <div>
                <div className="text-[11px] font-semibold text-[var(--color-text-tertiary)] uppercase tracking-wider mb-1">Config</div>
                <div className="text-[13px]">
                  {config.exists ? (
                    <><span className="font-semibold">{config.lines}</span> lines, <span className="font-semibold">{config.size_kb}</span> KB, <span className="font-semibold">{config.rollbacks_available}</span> rollbacks</>
                  ) : (
                    <span className="text-[var(--color-text-tertiary)]">No config generated yet</span>
                  )}
                </div>
              </div>
              <div>
                <div className="text-[11px] font-semibold text-[var(--color-text-tertiary)] uppercase tracking-wider mb-1">Environment</div>
                <div className="text-[13px]">
                  Kp {environment.kp ?? "?"} | Dst {environment.dst ?? "?"}nT | {environment.storm ?? "?"} | Sats {environment.sats_healthy ?? "?"}/{((environment.sats_healthy || 0) + (environment.sats_unhealthy || 0))}
                  {environment.flare && <span className="ml-2 px-1.5 py-0.5 rounded text-[11px] font-medium bg-red-100 text-red-700">Flare {environment.flare}</span>}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* DB Tables */}
        <div className="rounded-xl border border-[var(--color-border)] bg-white shadow-[var(--shadow-xs)]">
          <div className="px-5 py-4 border-b border-[var(--color-border-light)]">
            <h2 className="text-[15px] font-semibold text-[var(--color-text-primary)]">Database Tables</h2>
            <p className="text-[13px] text-[var(--color-text-secondary)]">{db.size_mb || 0} MB total, {db.disk_total_mb || 0} MB disk used</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-[var(--color-border-light)]">
                  <th className="px-5 py-3 text-left text-[11px] font-semibold text-[var(--color-text-tertiary)] uppercase tracking-wider">Table</th>
                  <th className="px-5 py-3 text-right text-[11px] font-semibold text-[var(--color-text-tertiary)] uppercase tracking-wider">Rows</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(db.tables || {}).sort(([, a]: any, [, b]: any) => b - a).map(([table, count]: [string, any]) => (
                  <tr key={table} className="border-b border-[var(--color-border-light)] last:border-0 hover:bg-[var(--color-gray-25)]">
                    <td className="px-5 py-3 font-mono text-[var(--color-text-primary)]">{table}</td>
                    <td className="px-5 py-3 text-right tabular-nums text-[var(--color-text-secondary)]">{(count as number).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <p className="text-[11px] text-[var(--color-text-tertiary)] text-center">
          Uptime: {data?.uptime?.human || "?"} | {data?.timestamp ? new Date(data.timestamp).toLocaleString("de-DE") : ""}
        </p>
      </div>
    </div>
  );
}
