"use client";

import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

// ─── Color Config ────────────────────────────────────────────────────────────

const TIER_COLORS: Record<string, string> = {
  full_rtk: "#22c55e",
  degraded_rtk: "#eab308",
  float_dgps: "#f97316",
  no_coverage: "#ef4444",
};

// ─── Component ──────────────────────────────────────────────────────────────

export default function QualityMap({
  cells,
  zones,
}: {
  cells: any[];
  zones: any[];
}) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstance = useRef<L.Map | null>(null);

  useEffect(() => {
    if (!mapRef.current) return;
    if (mapInstance.current) mapInstance.current.remove();

    const map = L.map(mapRef.current, {
      center: [30, 0],
      zoom: 3,
      zoomControl: true,
      attributionControl: false,
    });

    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
      maxZoom: 18,
    }).addTo(map);

    mapInstance.current = map;

    // ── Render H3 Hexagons ──────────────────────────────────────────────
    if (cells.length > 0) {
      for (const cell of cells) {
        if (!cell.boundary || cell.boundary.length < 3) continue;

        const color = TIER_COLORS[cell.zone_tier] || "#6b7280";
        const isModeled = cell.is_interpolated === 1;

        // Opacity based on confidence + tier
        const baseOpacity = isModeled ? 0.15 : 0.35;
        const opacity = baseOpacity + (cell.confidence || 0) * 0.2;

        try {
          const polygon = L.polygon(
            cell.boundary.map((p: number[]) => [p[0], p[1]]),
            {
              color: color,
              fillColor: color,
              fillOpacity: Math.min(0.6, opacity),
              weight: 0.5,
              opacity: 0.4,
            }
          ).addTo(map);

          polygon.bindTooltip(
            `<div style="font-size:12px;line-height:1.5">` +
            `<b>Quality: ${(cell.quality_score * 100).toFixed(0)}%</b> — ${cell.zone_tier.replace(/_/g, " ")}<br>` +
            `<span style="color:#94a3b8">Baseline:</span> ${(cell.baseline_component * 100).toFixed(0)}% ` +
            `<span style="color:#94a3b8">Geometry:</span> ${(cell.density_component * 100).toFixed(0)}%<br>` +
            `<span style="color:#94a3b8">Uptime:</span> ${(cell.uptime_component * 100).toFixed(0)}% ` +
            `<span style="color:#94a3b8">Freshness:</span> ${(cell.age_component * 100).toFixed(0)}%<br>` +
            `Sessions: ${cell.session_count} | Station: ${cell.nearest_station || "—"} (${cell.nearest_station_km?.toFixed(1) || "?"}km)<br>` +
            `<span style="color:#94a3b8">Source: ${cell.is_interpolated ? "modeled" : cell.session_count >= 20 ? "observed" : "hybrid"}</span>` +
            `</div>`,
            { direction: "top", className: "custom-tooltip" }
          );
        } catch {}
      }
    }

    // ── Render Zone Boundaries ──────────────────────────────────────────
    if (zones.length > 0) {
      for (const zone of zones) {
        if (!zone.geofence) continue;

        try {
          const color = TIER_COLORS[zone.zone_tier] || "#6b7280";

          if (zone.geofence_type === "circle" && zone.geofence.circle) {
            const c = zone.geofence.circle;
            L.circle([c.lat, c.lon], {
              radius: c.radius_m,
              color: "#ffffff",
              fillColor: color,
              fillOpacity: 0.05,
              weight: 2,
              dashArray: "6 4",
              opacity: 0.6,
            }).addTo(map).bindTooltip(
              `<b>${zone.name}</b><br>` +
              `Quality: ${(zone.avg_quality * 100).toFixed(0)}% | Stations: ${zone.station_count}<br>` +
              `Priority: ${zone.priority} | Area: ${zone.area_km2?.toLocaleString()} km²`,
              { direction: "top", className: "custom-tooltip" }
            );
          } else if (zone.geofence_type === "polygon" && zone.geofence.polygon?.points) {
            L.polygon(
              zone.geofence.polygon.points.map((p: number[]) => [p[0], p[1]]),
              {
                color: "#ffffff",
                fillColor: color,
                fillOpacity: 0.05,
                weight: 2,
                dashArray: "6 4",
                opacity: 0.6,
              }
            ).addTo(map).bindTooltip(
              `<b>${zone.name}</b><br>` +
              `Quality: ${(zone.avg_quality * 100).toFixed(0)}% | Stations: ${zone.station_count}<br>` +
              `Priority: ${zone.priority} | Area: ${zone.area_km2?.toLocaleString()} km²`,
              { direction: "top", className: "custom-tooltip" }
            );
          }
        } catch {}
      }
    }

    // ── Legend ────────────────────────────────────────────────────────────
    const legend = new L.Control({ position: "bottomright" });
    legend.onAdd = () => {
      const div = L.DomUtil.create("div", "");
      div.style.cssText = "background:rgba(15,23,42,0.9);padding:10px 14px;border-radius:8px;color:#e2e8f0;font-size:12px;line-height:1.8;border:1px solid rgba(99,102,241,0.3)";
      div.innerHTML = `
        <div style="font-weight:600;margin-bottom:4px">Coverage Quality</div>
        <div><span style="display:inline-block;width:12px;height:12px;border-radius:2px;background:#22c55e;margin-right:6px;vertical-align:middle"></span>Full RTK (&lt;2cm)</div>
        <div><span style="display:inline-block;width:12px;height:12px;border-radius:2px;background:#eab308;margin-right:6px;vertical-align:middle"></span>Degraded (2-5cm)</div>
        <div><span style="display:inline-block;width:12px;height:12px;border-radius:2px;background:#f97316;margin-right:6px;vertical-align:middle"></span>Float/DGPS</div>
        <div><span style="display:inline-block;width:12px;height:12px;border-radius:2px;background:#ef4444;margin-right:6px;vertical-align:middle"></span>No Coverage</div>
        <div style="margin-top:4px;color:#94a3b8;font-size:11px">${cells.length.toLocaleString()} cells | ${zones.length} zones</div>
      `;
      return div;
    };
    legend.addTo(map);

    // Auto-fit bounds to cells
    if (cells.length > 0) {
      const validCells = cells.filter(c => c.lat && c.lon);
      if (validCells.length > 0) {
        const lats = validCells.map(c => c.lat);
        const lons = validCells.map(c => c.lon);
        map.fitBounds([
          [Math.min(...lats) - 2, Math.min(...lons) - 2],
          [Math.max(...lats) + 2, Math.max(...lons) + 2],
        ]);
      }
    }

    return () => { map.remove(); };
  }, [cells, zones]);

  return <div ref={mapRef} className="w-full h-[600px]" />;
}
