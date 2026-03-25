"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import {
  Settings, MapPin, Radio, Users, Upload, FileCode, RefreshCw,
  ArrowLeft, Loader2, Check, X, Plus, Trash2, ChevronDown, ChevronUp,
  Shield, Wifi, Globe, Zap,
} from "lucide-react";

const ZoneMap = dynamic(
  () => import("@/components/wizard/zone-map").then(m => m.ZoneMap),
  { ssr: false, loading: () => <div className="w-full h-[500px] rounded-lg border bg-gray-50 flex items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-gray-400" /></div> }
);

// ─── Types ───────────────────────────────────────────────────────────────────

interface Zone {
  id: string; name: string; network_id: string; enabled: boolean;
  geofence: any; color: string; priority: number;
}

interface Network {
  id: string; name: string; host: string; port: number; protocol: string;
}

interface Mountpoint {
  id: string; name: string; enabled: boolean; backends: any[];
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function WizardPage() {
  const [zones, setZones] = useState<Zone[]>([]);
  const [networks, setNetworks] = useState<Network[]>([]);
  const [mountpoints, setMountpoints] = useState<Mountpoint[]>([]);
  const [stations, setStations] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedZone, setSelectedZone] = useState<Zone | null>(null);
  const [configPreview, setConfigPreview] = useState<string | null>(null);
  const [showConfig, setShowConfig] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [deployResult, setDeployResult] = useState<any>(null);
  const [activeTab, setActiveTab] = useState<"zones" | "networks" | "mountpoints">("zones");

  const fetchAll = async () => {
    setLoading(true);
    try {
      const [zData, nData, mData, sData] = await Promise.all([
        fetch("/api/wizard/data/zones").then(r => r.json()).catch(() => ({})),
        fetch("/api/wizard/data/networks").then(r => r.json()).catch(() => ({})),
        fetch("/api/wizard/data/mountpoints").then(r => r.json()).catch(() => ({})),
        fetch("/api/map").then(r => r.json()).catch(() => ({ stations: [] })),
      ]);
      setZones(Object.values(zData));
      setNetworks(Object.values(nData));
      setMountpoints(Object.values(mData));
      setStations(sData.stations || []);
    } catch {}
    setLoading(false);
  };

  useEffect(() => { fetchAll(); }, []);

  const generateConfig = async () => {
    try {
      const res = await fetch("/api/wizard/config");
      const data = await res.json();
      setConfigPreview(data.config || "# Empty config");
      setShowConfig(true);
    } catch {}
  };

  const handleDeploy = async () => {
    if (!confirm("Deploy config to Alberding Caster via SSH?")) return;
    setDeploying(true);
    try {
      const res = await fetch("/api/wizard/deploy", { method: "POST" });
      setDeployResult(await res.json());
    } catch (err) {
      setDeployResult({ error: String(err) });
    }
    setDeploying(false);
  };

  const toggleZone = async (zone: Zone) => {
    try {
      await fetch("/api/wizard/data/zones", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: zone.id, value: { ...zone, enabled: !zone.enabled } }),
      });
      fetchAll();
    } catch {}
  };

  const deleteZone = async (zoneId: string) => {
    if (!confirm(`Delete zone ${zoneId}?`)) return;
    try {
      await fetch(`/api/wizard/data/zones?key=${zoneId}`, { method: "DELETE" });
      fetchAll();
    } catch {}
  };

  if (loading) {
    return <div className="flex items-center justify-center h-screen"><Loader2 className="h-8 w-8 animate-spin text-gray-400" /></div>;
  }

  const integrityZones = zones.filter(z => z.id.startsWith("integrity_"));
  const meridianZones = zones.filter(z => z.id.startsWith("meridian_"));
  const manualZones = zones.filter(z => !z.id.startsWith("integrity_") && !z.id.startsWith("meridian_"));

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <Link href="/dashboard" className="text-sm text-blue-600 hover:underline flex items-center gap-1 mb-1">
              <ArrowLeft className="h-3 w-3" /> Dashboard
            </Link>
            <h1 className="text-xl font-semibold text-gray-900 flex items-center gap-2">
              <Settings className="h-5 w-5" /> GNSS Wizard
            </h1>
            <p className="text-sm text-gray-500">Zone Management, Network Config, Caster Deploy</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={fetchAll} className="p-2 rounded-lg hover:bg-white border">
              <RefreshCw className="h-4 w-4 text-gray-500" />
            </button>
            <button onClick={generateConfig} className="flex items-center gap-1.5 px-3 py-2 border rounded-lg text-sm hover:bg-white">
              <FileCode className="h-4 w-4" /> Generate Config
            </button>
            <button onClick={handleDeploy} disabled={deploying}
              className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 text-sm font-medium">
              {deploying ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              Deploy
            </button>
          </div>
        </div>

        {/* Deploy Result */}
        {deployResult && (
          <div className={`rounded-lg border p-3 ${deployResult.success ? "bg-emerald-50 border-emerald-200" : "bg-red-50 border-red-200"}`}>
            <div className="flex items-center gap-2 text-sm">
              {deployResult.success ? <Check className="h-4 w-4 text-emerald-600" /> : <X className="h-4 w-4 text-red-600" />}
              {deployResult.success ? `Deployed (${deployResult.config_lines} lines)` : deployResult.error || "Deploy failed"}
            </div>
          </div>
        )}

        {/* Zone Map */}
        <div className="rounded-lg border bg-white p-4">
          <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wider mb-3 flex items-center gap-2">
            <MapPin className="h-4 w-4" /> Zone Map
          </h2>
          <ZoneMap zones={zones} stations={stations} onZoneClick={setSelectedZone} />
        </div>

        {/* Selected Zone Detail */}
        {selectedZone && (
          <div className="rounded-lg border bg-blue-50 border-blue-200 p-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-blue-900">{selectedZone.name}</h3>
                <p className="text-xs text-blue-700">ID: {selectedZone.id} | Network: {selectedZone.network_id} | Priority: {selectedZone.priority}</p>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => toggleZone(selectedZone)}
                  className={`px-2 py-1 rounded text-xs font-medium ${selectedZone.enabled ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"}`}>
                  {selectedZone.enabled ? "Enabled" : "Disabled"}
                </button>
                <button onClick={() => setSelectedZone(null)} className="text-gray-400 hover:text-gray-600">
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Tabs */}
        <div className="flex gap-1 border-b">
          {(["zones", "networks", "mountpoints"] as const).map(tab => (
            <button key={tab} onClick={() => setActiveTab(tab)}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition ${activeTab === tab ? "border-blue-500 text-blue-600" : "border-transparent text-gray-500 hover:text-gray-700"}`}>
              {tab === "zones" ? <MapPin className="h-3.5 w-3.5 inline mr-1" /> :
               tab === "networks" ? <Wifi className="h-3.5 w-3.5 inline mr-1" /> :
               <Globe className="h-3.5 w-3.5 inline mr-1" />}
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
              <span className="ml-1 text-xs text-gray-400">
                ({tab === "zones" ? zones.length : tab === "networks" ? networks.length : mountpoints.length})
              </span>
            </button>
          ))}
        </div>

        {/* Zone Tab */}
        {activeTab === "zones" && (
          <div className="space-y-4">
            {/* Zone Type Sections */}
            {[
              { title: "Integrity Zones (Auto-Generated)", zones: integrityZones, icon: Shield, color: "text-blue-600" },
              { title: "MERIDIAN Zones", zones: meridianZones, icon: Zap, color: "text-purple-600" },
              { title: "Manual Zones", zones: manualZones, icon: MapPin, color: "text-gray-600" },
            ].map(section => (
              <div key={section.title} className="space-y-2">
                <h3 className="text-xs font-semibold text-gray-700 uppercase tracking-wider flex items-center gap-1">
                  <section.icon className={`h-3.5 w-3.5 ${section.color}`} />
                  {section.title} ({section.zones.length})
                </h3>
                {section.zones.length === 0 ? (
                  <div className="rounded-lg border bg-white p-3 text-xs text-gray-400 text-center">No zones</div>
                ) : (
                  <div className="rounded-lg border bg-white overflow-hidden">
                    <table className="w-full text-xs">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="text-left px-3 py-2 text-gray-500">Name</th>
                          <th className="text-left px-3 py-2 text-gray-500">Network</th>
                          <th className="text-right px-3 py-2 text-gray-500">Priority</th>
                          <th className="text-center px-3 py-2 text-gray-500">Type</th>
                          <th className="text-center px-3 py-2 text-gray-500">Status</th>
                          <th className="text-right px-3 py-2 text-gray-500">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {section.zones.map(z => (
                          <tr key={z.id} className="border-t hover:bg-gray-50 cursor-pointer" onClick={() => setSelectedZone(z)}>
                            <td className="px-3 py-2 text-gray-700">{z.name}</td>
                            <td className="px-3 py-2 text-gray-500">{z.network_id}</td>
                            <td className="px-3 py-2 text-right font-mono">{z.priority}</td>
                            <td className="px-3 py-2 text-center">
                              <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ backgroundColor: z.color + "20", color: z.color }}>
                                {z.geofence?.type || "—"}
                              </span>
                            </td>
                            <td className="px-3 py-2 text-center">
                              <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${z.enabled ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"}`}>
                                {z.enabled ? "ON" : "OFF"}
                              </span>
                            </td>
                            <td className="px-3 py-2 text-right">
                              <button onClick={(e) => { e.stopPropagation(); toggleZone(z); }}
                                className="text-gray-400 hover:text-blue-600 mr-2">
                                {z.enabled ? <X className="h-3.5 w-3.5 inline" /> : <Check className="h-3.5 w-3.5 inline" />}
                              </button>
                              {!z.id.startsWith("integrity_") && (
                                <button onClick={(e) => { e.stopPropagation(); deleteZone(z.id); }}
                                  className="text-gray-400 hover:text-red-600">
                                  <Trash2 className="h-3.5 w-3.5 inline" />
                                </button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Networks Tab */}
        {activeTab === "networks" && (
          <div className="rounded-lg border bg-white overflow-hidden">
            {networks.length === 0 ? (
              <div className="p-8 text-center text-gray-400 text-sm">
                No networks configured. Add via API: PATCH /api/wizard/data/networks
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="text-left px-4 py-2 text-xs text-gray-500">Name</th>
                    <th className="text-left px-4 py-2 text-xs text-gray-500">Host</th>
                    <th className="text-right px-4 py-2 text-xs text-gray-500">Port</th>
                    <th className="text-left px-4 py-2 text-xs text-gray-500">Protocol</th>
                  </tr>
                </thead>
                <tbody>
                  {networks.map(n => (
                    <tr key={n.id} className="border-t">
                      <td className="px-4 py-2 font-medium">{n.name}</td>
                      <td className="px-4 py-2 font-mono text-gray-600">{n.host}</td>
                      <td className="px-4 py-2 text-right font-mono">{n.port}</td>
                      <td className="px-4 py-2 text-gray-500">{n.protocol}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {/* Mountpoints Tab */}
        {activeTab === "mountpoints" && (
          <div className="rounded-lg border bg-white overflow-hidden">
            {mountpoints.length === 0 ? (
              <div className="p-8 text-center text-gray-400 text-sm">
                No mountpoints configured. Add via API: PATCH /api/wizard/data/mountpoints
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="text-left px-4 py-2 text-xs text-gray-500">Name</th>
                    <th className="text-center px-4 py-2 text-xs text-gray-500">Status</th>
                    <th className="text-right px-4 py-2 text-xs text-gray-500">Backends</th>
                  </tr>
                </thead>
                <tbody>
                  {mountpoints.map(m => (
                    <tr key={m.id} className="border-t">
                      <td className="px-4 py-2 font-mono font-medium">{m.name}</td>
                      <td className="px-4 py-2 text-center">
                        <span className={`text-xs px-2 py-0.5 rounded ${m.enabled ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"}`}>
                          {m.enabled ? "Active" : "Disabled"}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-gray-500">{m.backends?.length || 0}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {/* Config Preview */}
        {showConfig && configPreview && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wider flex items-center gap-2">
                <FileCode className="h-4 w-4" /> ntrips.cfg Preview
              </h2>
              <button onClick={() => setShowConfig(false)} className="text-xs text-gray-400 hover:text-gray-600">Close</button>
            </div>
            <div className="rounded-lg border bg-gray-900 p-4 overflow-auto max-h-[500px]">
              <pre className="text-xs text-green-400 font-mono whitespace-pre">{configPreview}</pre>
            </div>
          </div>
        )}

        <div className="text-center text-xs text-gray-400 pb-4">
          {zones.length} zones | {networks.length} networks | {mountpoints.length} mountpoints
        </div>
      </div>
    </div>
  );
}
