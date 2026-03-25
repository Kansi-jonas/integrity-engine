"use client";

import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

// ─── Types ───────────────────────────────────────────────────────────────────

interface MapData {
  sessions: Array<{ lat: number; lon: number; fix: number; age: number; station: string; live: boolean }>;
  stations: Array<{ name: string; lat: number; lon: number; status: string; network: string; trust: number | null; flag: string | null }>;
  anomalies: Array<{ type: string; severity: string; lat: number; lon: number; radius_km: number; affected_users: number; station: string | null }>;
  interference: Array<{ classification: string; confidence: number; severity: string; lat: number; lon: number; radius_km: number; affected_users: number; description: string }>;
  environment: {
    ionosphere: { kp: number; dst: number; bz: number; wind_speed: number; storm: string; phase: string; flare: string | null; fix_impact: number; affected_regions: string[] };
    troposphere: Array<{ name: string; lat: number; lon: number; humidity: number; temp: number; precip: number; risk: string }>;
    constellation: { gps: number; gps_total: number; glonass: number; glonass_total: number; galileo: number; galileo_total: number; beidou: number; beidou_total: number; alerts: string[] };
    cme: Array<{ speed: number; arrival: string | null; kp: number }>;
  } | null;
  probes: Array<{ station: string; lat: number; lon: number; success: boolean; type: string; latency: number; bytes: number }>;
  coverage_gaps: Array<{ lat: number; lon: number; count: number }>;
}

// ─── Region Definitions ──────────────────────────────────────────────────────

const IONO_REGIONS: Record<string, { lat: number; lon: number; radius: number }> = {
  "EU North": { lat: 62, lon: 15, radius: 800000 },
  "EU Central": { lat: 50, lon: 10, radius: 600000 },
  "EU West": { lat: 48, lon: -2, radius: 500000 },
  "Canada": { lat: 55, lon: -100, radius: 1200000 },
  "US East": { lat: 38, lon: -78, radius: 800000 },
  "US Central": { lat: 40, lon: -95, radius: 800000 },
  "US West": { lat: 37, lon: -120, radius: 800000 },
  "South America": { lat: -10, lon: -55, radius: 1500000 },
  "Australia": { lat: -28, lon: 135, radius: 1200000 },
  "Asia Pacific": { lat: 25, lon: 120, radius: 1500000 },
};

// ─── Color Helpers ───────────────────────────────────────────────────────────

function fixColor(fix: number): string {
  if (fix >= 80) return "#059669";
  if (fix >= 50) return "#d97706";
  if (fix >= 20) return "#ea580c";
  return "#dc2626";
}

function trustColor(trust: number | null, flag: string | null): string {
  if (flag === "excluded") return "#991b1b";
  if (flag === "untrusted") return "#dc2626";
  if (flag === "probation") return "#d97706";
  if (trust !== null && trust >= 0.7) return "#059669";
  return "#6b7280";
}

const INTERFERENCE_COLORS: Record<string, string> = {
  jamming: "#dc2626",
  spoofing: "#7c3aed",
  iono: "#6366f1",
  station_fault: "#ea580c",
  multipath: "#06b6d4",
  network: "#3b82f6",
  unknown: "#6b7280",
};

function tropoColor(risk: string): string {
  if (risk === "high") return "#dc2626";
  if (risk === "medium") return "#d97706";
  return "#059669";
}

// ─── Map Component ───────────────────────────────────────────────────────────

export function IntegrityMap({ data }: { data: MapData }) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstance = useRef<L.Map | null>(null);
  const [layers, setLayers] = useState({
    sessions: true,
    stations: true,
    ionosphere: true,
    troposphere: true,
    interference: true,
    anomalies: true,
    probes: true,
    gaps: true,
  });

  const toggleLayer = (key: keyof typeof layers) => {
    setLayers(prev => ({ ...prev, [key]: !prev[key] }));
  };

  useEffect(() => {
    if (!mapRef.current) return;
    if (mapInstance.current) mapInstance.current.remove();

    const map = L.map(mapRef.current, {
      center: [30, 0],
      zoom: 2,
      zoomControl: true,
      attributionControl: false,
    });

    // Dark-ish basemap for better contrast
    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
      maxZoom: 18,
    }).addTo(map);

    const env = data.environment;

    // ── Layer 1: Ionosphere Impact (purple/violet zones) ─────────────────
    if (layers.ionosphere && env) {
      const kp = env.ionosphere.kp;
      const affected = env.ionosphere.affected_regions;

      // Always show auroral oval (faint) + intensify with Kp
      for (const [region, def] of Object.entries(IONO_REGIONS)) {
        const isAffected = affected.includes(region);
        const baseOpacity = isAffected ? 0.08 + (kp - 3) * 0.04 : 0.02;
        const color = isAffected ? "#7c3aed" : "#4c1d95";

        if (baseOpacity > 0.01) {
          L.circle([def.lat, def.lon], {
            radius: def.radius,
            color,
            fillColor: color,
            fillOpacity: Math.min(0.35, baseOpacity),
            weight: isAffected ? 1.5 : 0.5,
            opacity: isAffected ? 0.5 : 0.15,
            dashArray: isAffected ? undefined : "3 6",
          }).addTo(map).bindTooltip(
            `<b>${region}</b><br>` +
            `Kp: ${kp} | Dst: ${env.ionosphere.dst}nT | Bz: ${env.ionosphere.bz}nT<br>` +
            `Wind: ${env.ionosphere.wind_speed} km/s<br>` +
            `Phase: ${env.ionosphere.phase}` +
            (env.ionosphere.flare ? `<br>Flare: <b>${env.ionosphere.flare}</b>` : "") +
            (env.ionosphere.fix_impact < 0 ? `<br>Fix Impact: <b>${env.ionosphere.fix_impact}%</b>` : ""),
            { direction: "top", className: "custom-tooltip" }
          );
        }
      }

      // Solar wind direction indicator (arrow from sun-side)
      if (env.ionosphere.wind_speed > 300) {
        const windIntensity = Math.min(1, (env.ionosphere.wind_speed - 300) / 500);
        // Show as a gradient line from the sun direction (east)
        const arrowPoints: L.LatLngExpression[] = [
          [0, 180], [0, 170], [10, 175], [0, 170], [-10, 175], [0, 170],
        ];
        L.polyline(arrowPoints, {
          color: `rgba(251, 191, 36, ${0.2 + windIntensity * 0.5})`,
          weight: 2 + windIntensity * 3,
          dashArray: "8 4",
        }).addTo(map).bindTooltip(
          `Solar Wind: ${env.ionosphere.wind_speed} km/s<br>Bz: ${env.ionosphere.bz}nT`,
          { direction: "center" }
        );
      }
    }

    // ── Layer 2: Troposphere (weather risk zones) ────────────────────────
    if (layers.troposphere && env?.troposphere) {
      for (const t of env.troposphere) {
        const color = tropoColor(t.risk);
        L.circle([t.lat, t.lon], {
          radius: 300000, // 300km radius
          color,
          fillColor: color,
          fillOpacity: t.risk === "high" ? 0.12 : t.risk === "medium" ? 0.06 : 0.02,
          weight: 1,
          opacity: 0.3,
          dashArray: "4 4",
        }).addTo(map).bindTooltip(
          `<b>${t.name} — Troposphere</b><br>` +
          `Temp: ${t.temp}°C | Humidity: ${t.humidity}%<br>` +
          `Precip: ${t.precip}mm | Risk: <b>${t.risk.toUpperCase()}</b>`,
          { direction: "top" }
        );
      }
    }

    // ── Layer 3: Interference Events (SHIELD) ────────────────────────────
    if (layers.interference && data.interference) {
      for (const e of data.interference) {
        const color = INTERFERENCE_COLORS[e.classification] || "#6b7280";
        // Pulsing effect via double circle
        L.circle([e.lat, e.lon], {
          radius: e.radius_km * 1000,
          color,
          fillColor: color,
          fillOpacity: 0.2,
          weight: 2,
        }).addTo(map);
        L.circle([e.lat, e.lon], {
          radius: e.radius_km * 1000 * 0.6,
          color,
          fillColor: color,
          fillOpacity: 0.1,
          weight: 1,
          dashArray: "3 3",
        }).addTo(map).bindTooltip(
          `<b>${e.classification.toUpperCase()}</b> (${Math.round(e.confidence * 100)}%)<br>` +
          `${e.affected_users} users | ${e.severity}<br>` +
          `${e.description}`,
          { direction: "top" }
        );
      }
    }

    // ── Layer 4: Anomaly Clusters ────────────────────────────────────────
    if (layers.anomalies && data.anomalies) {
      for (const a of data.anomalies) {
        const color = a.severity === "critical" ? "#dc2626" : "#d97706";
        L.circle([a.lat, a.lon], {
          radius: a.radius_km * 1000,
          color,
          fillColor: color,
          fillOpacity: 0.12,
          weight: 2,
          dashArray: "5 5",
        }).addTo(map).bindTooltip(
          `<b>${a.type.replace(/_/g, " ")}</b><br>` +
          `${a.affected_users} users | ${a.severity}` +
          (a.station ? `<br>Station: ${a.station}` : ""),
          { direction: "top" }
        );
      }
    }

    // ── Layer 5: Coverage Gaps (orange dashed circles) ───────────────────
    if (layers.gaps && data.coverage_gaps) {
      for (const g of data.coverage_gaps) {
        L.circle([g.lat, g.lon], {
          radius: 40000, // 40km
          color: "#f97316",
          fillColor: "#f97316",
          fillOpacity: 0.06,
          weight: 1.5,
          dashArray: "6 4",
        }).addTo(map).bindTooltip(
          `<b>Coverage Gap</b><br>${g.count} sessions, no station within 40km`,
          { direction: "top" }
        );
      }
    }

    // ── Layer 6: ONOCOY Probes (diamond markers) ─────────────────────────
    if (layers.probes && data.probes) {
      for (const p of data.probes) {
        const color = p.success ? "#059669" : "#dc2626";
        L.circleMarker([p.lat, p.lon], {
          radius: 4,
          color,
          fillColor: color,
          fillOpacity: 0.9,
          weight: 2,
        }).addTo(map).bindTooltip(
          `<b>ONOCOY Probe: ${p.station}</b><br>` +
          `${p.success ? "SUCCESS" : "FAILED"} | ${p.type}<br>` +
          `Latency: ${p.latency}ms | ${Math.round(p.bytes / 1024)}KB`,
          { direction: "top" }
        );
      }
    }

    // ── Layer 7: Stations (canvas for performance) ───────────────────────
    if (layers.stations) {
      const stationCanvas = L.canvas({ padding: 0.5 });
      for (const s of data.stations) {
        if (!s.lat || !s.lon) continue;
        const color = trustColor(s.trust, s.flag);
        L.circleMarker([s.lat, s.lon], {
          radius: 1.5,
          color,
          fillColor: color,
          fillOpacity: 0.3,
          weight: 0,
          renderer: stationCanvas,
        }).addTo(map);
      }
    }

    // ── Layer 8: Sessions (on top of everything) ─────────────────────────
    if (layers.sessions) {
      for (const s of data.sessions) {
        if (!s.lat || !s.lon) continue;
        const color = fixColor(s.fix);
        L.circleMarker([s.lat, s.lon], {
          radius: s.live ? 6 : 3.5,
          color: s.live ? "#ffffff" : color,
          fillColor: color,
          fillOpacity: 0.9,
          weight: s.live ? 2 : 1,
        }).addTo(map).bindTooltip(
          `<b>Fix: ${s.fix}%</b> | Age: ${s.age}ms<br>` +
          `Station: ${s.station}` +
          (s.live ? "<br><b style='color:#059669'>● LIVE</b>" : ""),
          { direction: "top" }
        );
      }
    }

    mapInstance.current = map;
    return () => { map.remove(); mapInstance.current = null; };
  }, [data, layers]);

  // ── Status Bar ─────────────────────────────────────────────────────────
  const env = data.environment;
  const kp = env?.ionosphere.kp ?? 0;
  const dst = env?.ionosphere.dst ?? 0;
  const bz = env?.ionosphere.bz ?? 0;
  const storm = env?.ionosphere.storm ?? "quiet";
  const phase = env?.ionosphere.phase ?? "quiet";
  const wind = env?.ionosphere.wind_speed ?? 0;
  const flare = env?.ionosphere.flare;
  const totalSats = env ? env.constellation.gps + env.constellation.glonass + env.constellation.galileo + env.constellation.beidou : 0;
  const totalSatsMax = env ? env.constellation.gps_total + env.constellation.glonass_total + env.constellation.galileo_total + env.constellation.beidou_total : 0;

  return (
    <div className="space-y-0">
      {/* Solar Wind / Iono Status Bar */}
      <div className="bg-gray-900 rounded-t-lg px-4 py-2 flex items-center gap-4 text-xs overflow-x-auto">
        <span className="text-gray-400 font-medium whitespace-nowrap">ENVIRONMENT</span>
        <span className={`font-mono whitespace-nowrap ${kp >= 5 ? "text-red-400" : kp >= 4 ? "text-amber-400" : "text-emerald-400"}`}>
          Kp {kp}
        </span>
        <span className={`font-mono whitespace-nowrap ${dst < -50 ? "text-red-400" : dst < -20 ? "text-amber-400" : "text-emerald-400"}`}>
          Dst {dst}nT
        </span>
        <span className={`font-mono whitespace-nowrap ${bz < -5 ? "text-red-400" : "text-gray-400"}`}>
          Bz {bz}nT
        </span>
        <span className="font-mono text-gray-400 whitespace-nowrap">{wind} km/s</span>
        {storm !== "quiet" && (
          <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold whitespace-nowrap ${
            storm === "extreme" || storm === "severe" ? "bg-red-900 text-red-300" :
            storm === "strong" ? "bg-red-900/50 text-red-400" :
            storm === "moderate" ? "bg-amber-900/50 text-amber-400" :
            "bg-yellow-900/50 text-yellow-400"
          }`}>
            {storm.toUpperCase()} ({phase})
          </span>
        )}
        {flare && (
          <span className="px-1.5 py-0.5 rounded bg-orange-900/50 text-orange-300 text-[10px] font-bold whitespace-nowrap">
            FLARE {flare}
          </span>
        )}
        <span className="font-mono text-gray-500 whitespace-nowrap ml-auto">
          Sats {totalSats}/{totalSatsMax}
        </span>
        {env?.cme && env.cme.length > 0 && (
          <span className="px-1.5 py-0.5 rounded bg-purple-900/50 text-purple-300 text-[10px] font-bold whitespace-nowrap">
            CME {env.cme[0].speed}km/s → Kp{env.cme[0].kp}
          </span>
        )}
      </div>

      {/* Map */}
      <div ref={mapRef} className="w-full h-[550px] border-x border-gray-200 overflow-hidden" />

      {/* Layer Controls + Legend */}
      <div className="bg-gray-900 rounded-b-lg px-4 py-2 flex items-center gap-3 flex-wrap">
        {([
          { key: "sessions" as const, label: "Sessions", color: "bg-emerald-500" },
          { key: "stations" as const, label: "Stations", color: "bg-gray-400" },
          { key: "ionosphere" as const, label: "Ionosphere", color: "bg-purple-500" },
          { key: "troposphere" as const, label: "Troposphere", color: "bg-cyan-500" },
          { key: "interference" as const, label: "Interference", color: "bg-red-500" },
          { key: "anomalies" as const, label: "Anomalies", color: "bg-amber-500" },
          { key: "probes" as const, label: "Probes", color: "bg-emerald-500" },
          { key: "gaps" as const, label: "Gaps", color: "bg-orange-500" },
        ]).map(({ key, label, color }) => (
          <button
            key={key}
            onClick={() => toggleLayer(key)}
            className={`flex items-center gap-1.5 px-2 py-1 rounded text-[10px] font-medium transition ${
              layers[key]
                ? "bg-gray-800 text-gray-200"
                : "bg-gray-900 text-gray-600 opacity-50"
            }`}
          >
            <span className={`w-2 h-2 rounded-full ${layers[key] ? color : "bg-gray-700"}`} />
            {label}
          </button>
        ))}
        <span className="text-[10px] text-gray-600 ml-auto">
          {data.sessions.length} sessions · {data.stations.length} stations · {data.interference?.length || 0} events
        </span>
      </div>
    </div>
  );
}
