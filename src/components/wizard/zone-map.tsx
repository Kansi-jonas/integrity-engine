"use client";

import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

interface Zone {
  id: string;
  name: string;
  network_id: string;
  enabled: boolean;
  geofence: any;
  color: string;
  priority: number;
}

interface ZoneMapProps {
  zones: Zone[];
  stations: Array<{ name: string; lat: number; lon: number; network: string; trust: number | null }>;
  onZoneClick?: (zone: Zone) => void;
}

const ZONE_TYPE_COLORS: Record<string, string> = {
  integrity_geodnet: "#22c55e",
  integrity_ono: "#3b82f6",
  meridian_: "#a855f7",
};

function getZoneColor(zone: Zone): string {
  for (const [prefix, color] of Object.entries(ZONE_TYPE_COLORS)) {
    if (zone.id.startsWith(prefix)) return color;
  }
  return zone.color || "#6b7280";
}

function getZoneLabel(zone: Zone): string {
  if (zone.id.startsWith("integrity_geodnet")) return "GEODNET";
  if (zone.id.startsWith("integrity_ono")) return "ONOCOY";
  if (zone.id.startsWith("meridian_")) return "MERIDIAN";
  return "Manual";
}

export function ZoneMap({ zones, stations, onZoneClick }: ZoneMapProps) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstance = useRef<L.Map | null>(null);
  const [selectedZone, setSelectedZone] = useState<string | null>(null);

  useEffect(() => {
    if (!mapRef.current) return;
    if (mapInstance.current) mapInstance.current.remove();

    const map = L.map(mapRef.current, {
      center: [30, 0],
      zoom: 2,
      zoomControl: true,
      attributionControl: false,
    });

    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
      maxZoom: 18,
    }).addTo(map);

    // ── Draw stations (canvas for performance) ──────────────────────────
    const stationCanvas = L.canvas({ padding: 0.5 });
    for (const s of stations) {
      if (!s.lat || !s.lon) continue;
      const color = s.network === "geodnet" ? "#22c55e" :
                    s.network === "onocoy" ? "#3b82f6" : "#6b7280";
      L.circleMarker([s.lat, s.lon], {
        radius: 2,
        color,
        fillColor: color,
        fillOpacity: 0.4,
        weight: 0,
        renderer: stationCanvas,
      }).addTo(map);
    }

    // ── Draw zones ──────────────────────────────────────────────────────
    for (const zone of zones) {
      if (!zone.geofence || !zone.enabled) continue;
      // Skip the global GEODNET zone (too big to render)
      if (zone.geofence.type === "circle" && zone.geofence.radius >= 10000000) continue;

      const color = getZoneColor(zone);
      const label = getZoneLabel(zone);

      let layer: L.Layer | null = null;

      if (zone.geofence.type === "circle" && zone.geofence.lat != null) {
        layer = L.circle([zone.geofence.lat, zone.geofence.lon], {
          radius: zone.geofence.radius,
          color,
          fillColor: color,
          fillOpacity: 0.1,
          weight: 2,
          opacity: 0.7,
        });
      } else if (zone.geofence.type === "polygon" && zone.geofence.points?.length >= 3) {
        const latlngs = zone.geofence.points.map((p: number[]) => [p[0], p[1]] as L.LatLngExpression);
        layer = L.polygon(latlngs, {
          color,
          fillColor: color,
          fillOpacity: 0.1,
          weight: 2,
          opacity: 0.7,
        });
      }

      if (layer) {
        layer.addTo(map);
        (layer as any).bindTooltip(
          `<b>${zone.name}</b><br>` +
          `Type: ${label} | Priority: ${zone.priority}<br>` +
          `ID: ${zone.id}`,
          { direction: "top" }
        );
        (layer as any).on("click", () => {
          setSelectedZone(zone.id);
          onZoneClick?.(zone);
        });
      }
    }

    mapInstance.current = map;
    return () => { map.remove(); mapInstance.current = null; };
  }, [zones, stations]);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-4 text-xs text-gray-500">
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-500 inline-block" /> GEODNET</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-blue-500 inline-block" /> ONOCOY</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-purple-500 inline-block" /> MERIDIAN</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-gray-400 inline-block" /> Manual</span>
        <span className="text-gray-400 ml-auto">{zones.filter(z => z.enabled).length} active zones</span>
      </div>
      <div ref={mapRef} className="w-full h-[500px] rounded-lg border border-gray-200 overflow-hidden" />
    </div>
  );
}
