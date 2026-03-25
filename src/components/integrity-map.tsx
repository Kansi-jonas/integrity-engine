"use client";

import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

interface MapData {
  sessions: Array<{ lat: number; lon: number; fix: number; age: number; station: string; live: boolean }>;
  stations: Array<{ name: string; lat: number; lon: number; status: string; network: string; trust: number | null; flag: string | null }>;
  anomalies: Array<{ type: string; severity: string; lat: number; lon: number; radius_km: number; affected_users: number }>;
  space_weather: { kp: number; storm: string; affected_regions: string[] } | null;
}

// ─── Iono Impact Regions (approximate boundaries for Kp-based shading) ──────

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

function fixColor(fix: number): string {
  if (fix >= 80) return "#059669";  // emerald
  if (fix >= 50) return "#d97706";  // amber
  if (fix >= 20) return "#ea580c";  // orange
  return "#dc2626";                 // red
}

function trustColor(trust: number | null, flag: string | null): string {
  if (flag === "untrusted") return "#dc2626";
  if (flag === "probation") return "#d97706";
  if (trust !== null && trust >= 0.7) return "#059669";
  return "#6b7280"; // gray for new/unknown
}

export function IntegrityMap({ data }: { data: MapData }) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstance = useRef<L.Map | null>(null);

  useEffect(() => {
    if (!mapRef.current) return;
    if (mapInstance.current) {
      mapInstance.current.remove();
    }

    const map = L.map(mapRef.current, {
      center: [30, 0],
      zoom: 2,
      zoomControl: true,
      attributionControl: false,
    });

    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
      maxZoom: 18,
    }).addTo(map);

    // ── Iono Impact Overlay (purple shading for affected regions) ─────────
    if (data.space_weather && data.space_weather.kp >= 4) {
      const affected = data.space_weather.affected_regions;
      for (const region of affected) {
        const def = IONO_REGIONS[region];
        if (def) {
          const opacity = Math.min(0.3, (data.space_weather.kp - 3) * 0.05);
          L.circle([def.lat, def.lon], {
            radius: def.radius,
            color: "#7c3aed",
            fillColor: "#7c3aed",
            fillOpacity: opacity,
            weight: 1,
            opacity: 0.3,
          }).addTo(map).bindTooltip(
            `Iono Impact: ${region}<br>Kp: ${data.space_weather.kp} (${data.space_weather.storm})`,
            { direction: "top" }
          );
        }
      }
    }

    // ── Anomaly Clusters (red pulsing circles) ───────────────────────────
    for (const a of data.anomalies) {
      const color = a.severity === "critical" ? "#dc2626" : "#d97706";
      L.circle([a.lat, a.lon], {
        radius: a.radius_km * 1000,
        color,
        fillColor: color,
        fillOpacity: 0.15,
        weight: 2,
        dashArray: "5 5",
      }).addTo(map).bindTooltip(
        `${a.type.replace(/_/g, " ")}<br>${a.affected_users} users affected`,
        { direction: "top" }
      );
    }

    // ── Station dots (small, trust-colored) ──────────────────────────────
    // Use canvas for performance (5000+ stations)
    const stationCanvas = L.canvas({ padding: 0.5 });
    for (const s of data.stations) {
      if (!s.lat || !s.lon) continue;
      L.circleMarker([s.lat, s.lon], {
        radius: 2,
        color: trustColor(s.trust, s.flag),
        fillColor: trustColor(s.trust, s.flag),
        fillOpacity: 0.4,
        weight: 0,
        renderer: stationCanvas,
      }).addTo(map);
    }

    // ── Session dots (larger, fix-rate colored) ──────────────────────────
    for (const s of data.sessions) {
      if (!s.lat || !s.lon) continue;
      const color = fixColor(s.fix);
      L.circleMarker([s.lat, s.lon], {
        radius: s.live ? 5 : 3,
        color,
        fillColor: color,
        fillOpacity: 0.8,
        weight: s.live ? 2 : 1,
      }).addTo(map).bindTooltip(
        `Fix: ${s.fix}% | Age: ${s.age}ms<br>Station: ${s.station}${s.live ? "<br><b>LIVE</b>" : ""}`,
        { direction: "top" }
      );
    }

    mapInstance.current = map;

    return () => {
      map.remove();
      mapInstance.current = null;
    };
  }, [data]);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4 text-xs text-gray-500">
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-600 inline-block" /> Fix &gt;80%</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-600 inline-block" /> Fix 50-80%</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-600 inline-block" /> Fix &lt;50%</span>
          {data.space_weather && data.space_weather.kp >= 4 && (
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-purple-600 inline-block opacity-50" /> Iono Impact</span>
          )}
        </div>
        <span className="text-xs text-gray-400">{data.sessions.length} sessions, {data.stations.length} stations</span>
      </div>
      <div ref={mapRef} className="w-full h-[500px] rounded-lg border border-gray-200 overflow-hidden" />
    </div>
  );
}
