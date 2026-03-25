'use client'
// ZoneMap — Leaflet map with draw controls + concentric coverage circles
// Must be dynamically imported (SSR disabled) per project setup
import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import {
  MapContainer,
  TileLayer,
  FeatureGroup,
  Circle,
  Polygon,
  Tooltip as MapTooltip,
  useMap,
} from 'react-leaflet'
import L from 'leaflet'
import { EditControl } from 'react-leaflet-draw'
import 'leaflet/dist/leaflet.css'
import 'leaflet-draw/dist/leaflet.draw.css'
import {
  ToggleLeft, ToggleRight, Trash2, Map, Loader2, Pencil, ChevronLeft,
  Satellite, RefreshCw, ChevronDown, ChevronRight, X, Terminal,
  AlertTriangle, CheckCircle2, Download,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useConfigStore, selectZones, selectNetworks } from '@/store/config-store'
import { generateId, zoneToJSON, zoneFromJSON } from '@/lib/utils'
import type { Zone, GeoFence } from '@/lib/types'

const DARK_TILES = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
const DARK_ATTR =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/">CARTO</a>'

const ZONE_COLORS = ['#10B981', '#3B82F6', '#8B5CF6', '#F97316', '#EC4899', '#06B6D4', '#EAB308', '#EF4444']

// Zoom threshold for showing permanent zone name labels (too many labels kill perf + readability)
const ZONE_LABEL_MIN_ZOOM = 8
// Max zone count before we switch to viewport-culled rendering
const ZONE_VIEWPORT_CULL_THRESHOLD = 50

const NETWORK_COLORS: Record<string, string> = {
  geodnet: '#22c55e',
  onocoy:  '#3b82f6',
}

interface Station {
  name: string
  lat: number
  lon: number
  status?: string
  score?: number | null
  cnr?: number | null
  sats?: number | null
  constellations?: string[]
  lastSeen?: string | null
}

type PanelMode = 'list' | 'create' | 'edit'

// ── Station Dot Layer ──────────────────────────────────────────────────────
// Renders station positions as small colored dots, sized+colored by quality score.
// Uses devicePixelRatio for crisp rendering on HiDPI screens.

function scoreToColor(score: number | null | undefined, fallback: string): string {
  if (score == null) return fallback
  if (score >= 70) return '#22c55e'
  if (score >= 50) return '#a3e635'
  if (score >= 30) return '#f59e0b'
  return '#ef4444'
}

function scoreToRadius(score: number | null | undefined, online: boolean): number {
  if (!online) return 2
  if (score == null) return 3
  return 2.5 + (score / 100) * 3  // 2.5–5.5 px
}

function scoreLabel(score: number | null | undefined): string {
  if (score == null) return 'unscored'
  if (score >= 70) return 'excellent'
  if (score >= 50) return 'good'
  if (score >= 30) return 'moderate'
  return 'poor'
}

function ScoreBar({ score, color }: { score: number | null | undefined; color: string }) {
  const pct = score != null ? Math.max(0, Math.min(100, score)) : 0
  return (
    <div className="flex items-center gap-1.5">
      <div className="flex-1 h-1.5 bg-white/20 rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${pct}%`, backgroundColor: score != null ? scoreToColor(score, color) : 'transparent' }}
        />
      </div>
      <span className="text-[10px] font-mono w-6 text-right" style={{ color: scoreToColor(score, '#9ca3af') }}>
        {score != null ? Math.round(score) : '—'}
      </span>
    </div>
  )
}

function StationDotLayer({ stations, color, network, visible, paneSuffix }: {
  stations: Station[]; color: string; network: string; visible: boolean; paneSuffix: string
}) {
  const map = useMap()
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rafRef = useRef<number | null>(null)
  const tooltipRef = useRef<HTMLDivElement | null>(null)
  const paneName = `stationPane_${paneSuffix}`

  useEffect(() => {
    if (!map.getPane(paneName)) {
      const pane = map.createPane(paneName)
      pane.style.zIndex = '400'
      pane.style.pointerEvents = 'none'
    }
    if (!visible || stations.length === 0) return

    const paneEl = map.getPane(paneName)!
    const dpr = window.devicePixelRatio || 1
    const canvas = document.createElement('canvas')
    canvas.style.position = 'absolute'
    canvas.style.pointerEvents = 'none'
    paneEl.appendChild(canvas)
    canvasRef.current = canvas

    // Rich tooltip DOM element
    const tip = document.createElement('div')
    tip.style.cssText = 'position:absolute;z-index:9999;pointer-events:none;display:none;min-width:160px;'
    tip.className = 'station-rich-tooltip'
    map.getContainer().appendChild(tip)
    tooltipRef.current = tip

    const draw = () => {
      const size = map.getSize()
      // HiDPI: set logical canvas size via CSS, actual pixel size scaled by dpr
      canvas.width = size.x * dpr
      canvas.height = size.y * dpr
      canvas.style.width = `${size.x}px`
      canvas.style.height = `${size.y}px`
      const topLeft = map.containerPointToLayerPoint([0, 0])
      L.DomUtil.setPosition(canvas, topLeft)
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, size.x, size.y)
      ctx.imageSmoothingEnabled = true
      const bounds = map.getBounds()
      const pad = 2
      for (const station of stations) {
        if (
          station.lat < bounds.getSouth() - pad || station.lat > bounds.getNorth() + pad ||
          station.lon < bounds.getWest() - pad * 2 || station.lon > bounds.getEast() + pad * 2
        ) continue
        const lp = map.latLngToLayerPoint([station.lat, station.lon])
        const x = lp.x - topLeft.x
        const y = lp.y - topLeft.y
        const online = station.status !== 'offline'
        const r = scoreToRadius(station.score, online)
        const dotColor = scoreToColor(station.score, color)

        ctx.globalAlpha = online ? 0.88 : 0.3
        // Subtle outer glow for high-score stations
        if (online && station.score != null && station.score >= 70) {
          ctx.shadowColor = dotColor
          ctx.shadowBlur = 4
        } else {
          ctx.shadowBlur = 0
        }
        ctx.fillStyle = dotColor
        ctx.beginPath()
        ctx.arc(x, y, r, 0, Math.PI * 2)
        ctx.fill()
        ctx.shadowBlur = 0
      }
      ctx.globalAlpha = 1
    }

    // Rich hover tooltip: score bar + CNR + sats + constellations + network badge
    const onMouseMove = (e: L.LeafletMouseEvent) => {
      const containerPt = map.latLngToContainerPoint(e.latlng)
      const lpMouse = map.latLngToLayerPoint(e.latlng)
      let bestDist = 100  // 10px² threshold
      let bestStation: Station | null = null
      for (const station of stations) {
        const lp = map.latLngToLayerPoint([station.lat, station.lon])
        const dx = lp.x - lpMouse.x
        const dy = lp.y - lpMouse.y
        const d = dx * dx + dy * dy
        if (d < bestDist) { bestDist = d; bestStation = station }
      }
      if (bestStation && tip) {
        const s = bestStation
        const scoreNum = s.score != null ? Math.round(s.score) : null
        const scorePct = scoreNum != null ? Math.max(0, Math.min(100, scoreNum)) : 0
        const scoreColor = scoreToColor(s.score, '#9ca3af')
        const label = scoreLabel(s.score)
        const cnrStr = s.cnr != null ? `${s.cnr.toFixed(1)} dBHz` : '—'
        const satsStr = s.sats != null ? String(Math.round(s.sats)) : '—'
        const constStr = s.constellations?.length ? s.constellations.join(' · ') : '—'
        const networkColor = color
        const lastSeenStr = s.lastSeen ? new Date(s.lastSeen).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' }) : null

        tip.innerHTML = `
          <div style="background:rgba(15,23,42,0.97);border:1px solid rgba(99,102,241,0.35);border-radius:9px;
                       padding:10px 13px;color:#e2e8f0;font-size:12px;line-height:1.55;
                       box-shadow:0 6px 24px rgba(0,0,0,0.7);min-width:190px;max-width:220px;">
            <!-- Header: name + network badge -->
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;">
              <span style="width:8px;height:8px;border-radius:50%;background:${networkColor};flex-shrink:0;box-shadow:0 0 5px ${networkColor}88;"></span>
              <span style="font-weight:700;color:#f1f5f9;font-size:12px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${s.name}</span>
              <span style="font-size:9.5px;color:${networkColor};background:${networkColor}22;border:1px solid ${networkColor}44;
                           border-radius:4px;padding:1px 5px;font-weight:600;white-space:nowrap;text-transform:uppercase;">${network}</span>
            </div>
            <!-- Score badge + bar -->
            <div style="background:rgba(255,255,255,0.05);border-radius:6px;padding:7px 9px;margin-bottom:7px;">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:5px;">
                <span style="color:#94a3b8;font-size:10px;font-weight:600;letter-spacing:0.05em;text-transform:uppercase;">Live Quality Score</span>
                ${scoreNum != null
                  ? `<span style="color:${scoreColor};font-size:16px;font-weight:800;font-variant-numeric:tabular-nums;line-height:1;">${scoreNum}</span>`
                  : `<span style="color:#475569;font-size:13px;font-weight:600;">—</span>`
                }
              </div>
              <div style="height:5px;background:rgba(255,255,255,0.1);border-radius:3px;overflow:hidden;">
                <div style="height:100%;width:${scorePct}%;background:${scoreColor};border-radius:3px;"></div>
              </div>
              <div style="margin-top:3px;text-align:right;">
                <span style="color:${scoreColor};font-size:9.5px;font-weight:600;text-transform:capitalize;">${label}</span>
              </div>
            </div>
            <!-- Details grid -->
            <div style="display:grid;grid-template-columns:auto 1fr;gap:2px 10px;font-size:10.5px;">
              <span style="color:#64748b;">CNR</span>
              <span style="color:#cbd5e1;font-variant-numeric:tabular-nums;">${cnrStr}</span>
              <span style="color:#64748b;">Satellites</span>
              <span style="color:#cbd5e1;">${satsStr}</span>
              <span style="color:#64748b;">Systems</span>
              <span style="color:#cbd5e1;font-size:10px;">${constStr}</span>
              ${lastSeenStr ? `<span style="color:#64748b;">Scanned</span><span style="color:#475569;font-size:10px;">${lastSeenStr}</span>` : ''}
            </div>
          </div>`
        tip.style.display = 'block'
        // Flip tooltip if too close to right/bottom edge
        const cw = map.getContainer().clientWidth
        const ch = map.getContainer().clientHeight
        const tipW = 190, tipH = 120
        const left = containerPt.x + 14 + tipW > cw ? containerPt.x - tipW - 8 : containerPt.x + 14
        const top = containerPt.y - 10 + tipH > ch ? containerPt.y - tipH : containerPt.y - 10
        tip.style.left = `${left}px`
        tip.style.top = `${top}px`
      } else if (tip) {
        tip.style.display = 'none'
      }
    }
    const onMouseOut = () => { if (tip) tip.style.display = 'none' }

    const schedule = () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      rafRef.current = requestAnimationFrame(draw)
    }

    map.on('viewreset', draw)
    map.on('move', schedule)
    map.on('zoom', schedule)
    map.on('mousemove', onMouseMove)
    map.on('mouseout', onMouseOut)
    draw()

    return () => {
      map.off('viewreset', draw)
      map.off('move', schedule)
      map.off('zoom', schedule)
      map.off('mousemove', onMouseMove)
      map.off('mouseout', onMouseOut)
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      if (canvas.parentNode) canvas.parentNode.removeChild(canvas)
      if (tip.parentNode) tip.parentNode.removeChild(tip)
      canvasRef.current = null
      tooltipRef.current = null
    }
  }, [map, stations, visible, color, paneName, network])

  return null
}

// ── Coverage toggle button ────────────────────────────────────────────────────

function CoverageButton({
  label, color, active, loading, count, onClick,
}: {
  label: string; color: string; active: boolean; loading: boolean; count: number; onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-semibold border transition-all ${
        active ? 'text-white border-transparent' : 'bg-white/80 text-gray-500 border-gray-300 hover:border-gray-500'
      }`}
      style={active ? { backgroundColor: color, borderColor: color } : {}}
    >
      {loading ? <Loader2 className="w-3 h-3 animate-spin" /> :
        <span className="w-2.5 h-2.5 rounded-full border border-white/40 inline-block" style={{ backgroundColor: color }} />}
      {label}
      {active && count > 0 && <span className="opacity-75">({count.toLocaleString()})</span>}
    </button>
  )
}

// ── Zoom tracker — exposes current zoom level to parent via callback ─────────

function ZoomTracker({ onZoomChange }: { onZoomChange: (zoom: number) => void }) {
  const map = useMap()
  useEffect(() => {
    const handler = () => onZoomChange(map.getZoom())
    handler() // initial
    map.on('zoomend', handler)
    return () => { map.off('zoomend', handler) }
  }, [map, onZoomChange])
  return null
}

// ── Viewport-aware zone polygon layer ────────────────────────────────────────
// Renders zone polygons efficiently:
//  - Culls zones outside the visible viewport when there are many zones
//  - Only shows permanent name labels at zoom ≥ ZONE_LABEL_MIN_ZOOM
//  - Uses hover tooltip (not permanent) for low zoom levels

function ViewportZoneLayer({ zones, zoom, editingZoneId, onZoneClick }: {
  zones: Zone[]
  zoom: number
  editingZoneId: string | null
  onZoneClick: (id: string) => void
}) {
  const map = useMap()
  const [bounds, setBounds] = useState<L.LatLngBounds | null>(null)

  useEffect(() => {
    const update = () => setBounds(map.getBounds())
    update()
    map.on('moveend', update)
    map.on('zoomend', update)
    return () => { map.off('moveend', update); map.off('zoomend', update) }
  }, [map])

  const showLabels = zoom >= ZONE_LABEL_MIN_ZOOM
  const shouldCull = zones.length > ZONE_VIEWPORT_CULL_THRESHOLD

  const visibleZones = useMemo(() => {
    if (!shouldCull || !bounds) return zones
    // Fast bounding-box overlap check
    return zones.filter((zone) => {
      if (!zone.geofence) return false
      if (zone.geofence.type === 'circle') {
        return bounds.contains([zone.geofence.lat!, zone.geofence.lon!])
      }
      if (zone.geofence.type === 'polygon' && zone.geofence.points) {
        // Check if any point is in viewport, or if zone bbox overlaps viewport
        const pts = zone.geofence.points
        let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180
        for (const [lat, lon] of pts) {
          if (lat < minLat) minLat = lat
          if (lat > maxLat) maxLat = lat
          if (lon < minLon) minLon = lon
          if (lon > maxLon) maxLon = lon
        }
        return bounds.overlaps(L.latLngBounds([minLat, minLon], [maxLat, maxLon]))
      }
      return true
    })
  }, [zones, bounds, shouldCull])

  return (
    <>
      {visibleZones.map((zone) => {
        if (!zone.geofence) return null
        const isEditing = editingZoneId === zone.id
        const fillOpacity = isEditing ? 0.35 : zone.enabled ? 0.2 : 0.07
        const strokeOpacity = zone.enabled ? 1 : 0.4
        const weight = isEditing ? 3 : 2
        const dashArray = isEditing ? '6 3' : undefined
        const eventHandlers = { click: () => onZoneClick(zone.id) }

        if (zone.geofence.type === 'circle' && zone.geofence.lat !== undefined) {
          return (
            <Circle key={zone.id} center={[zone.geofence.lat, zone.geofence.lon!]} radius={zone.geofence.radius!}
              pathOptions={{ color: zone.color, fillOpacity, opacity: strokeOpacity, weight, dashArray }}
              eventHandlers={eventHandlers}>
              {showLabels ? (
                <MapTooltip permanent direction="center" className="zone-tooltip">
                  <span className="text-xs font-mono font-bold">{zone.name}</span>
                </MapTooltip>
              ) : (
                <MapTooltip sticky direction="top" className="zone-tooltip">
                  <span className="text-xs font-mono font-bold">{zone.name}</span>
                </MapTooltip>
              )}
            </Circle>
          )
        }
        if (zone.geofence.type === 'polygon' && zone.geofence.points) {
          return (
            <Polygon key={zone.id} positions={zone.geofence.points as [number, number][]}
              pathOptions={{ color: zone.color, fillOpacity, opacity: strokeOpacity, weight, dashArray }}
              eventHandlers={eventHandlers}>
              {showLabels ? (
                <MapTooltip permanent direction="center" className="zone-tooltip">
                  <span className="text-xs font-mono font-bold">{zone.name}</span>
                </MapTooltip>
              ) : (
                <MapTooltip sticky direction="top" className="zone-tooltip">
                  <span className="text-xs font-mono font-bold">{zone.name}</span>
                </MapTooltip>
              )}
            </Polygon>
          )
        }
        return null
      })}
    </>
  )
}

// ── MERIDIAN overlay layer ────────────────────────────────────────────────────

const ZONE_STYLE: Record<string, { color: string; fillColor: string }> = {
  overlap:      { color: '#16a34a', fillColor: '#22c55e' },
  geodnet_only: { color: '#15803d', fillColor: '#4ade80' },
  onocoy_only:  { color: '#1e40af', fillColor: '#60a5fa' },
  sparse:       { color: '#4b5563', fillColor: '#9ca3af' },
  transition:   { color: '#d97706', fillColor: '#fbbf24' },
}
const ZONE_STYLE_DEFAULT = { color: '#4b5563', fillColor: '#9ca3af' }

export interface MeridianFeature {
  type: string
  geometry: { type: string; coordinates: number[][][] | number[][][][] }
  properties: {
    zone: string
    network: string
    confidence: string
    avg_ono_eff?: number | null
    avg_geo_eff?: number | null
    avg_ono_uq?: number | null
    avg_geo_uq?: number | null
    cell_count?: number
    cluster_id?: string
    live_geo_quality?: number | null
    live_station_count?: number
    live_geo_uq_ntrip?: number | null
  }
}

interface MeridianOverlayLayerProps {
  features: MeridianFeature[]
  visible: boolean
  hiddenZoneTypes: Set<string>
  hiddenConfidences: Set<string>
  clusterSearch: string
  minLiveScore: number
  onFeatureClick: (f: MeridianFeature['properties']) => void
}

function MeridianOverlayLayer({
  features, visible, hiddenZoneTypes, hiddenConfidences, clusterSearch, minLiveScore, onFeatureClick,
}: MeridianOverlayLayerProps) {
  const map = useMap()
  const layerRef = useRef<L.GeoJSON | null>(null)

  useEffect(() => {
    if (layerRef.current) { map.removeLayer(layerRef.current); layerRef.current = null }
    if (!visible || features.length === 0) return

    const filtered = features.filter((f) => {
      if (hiddenZoneTypes.has(f.properties.zone)) return false
      if (hiddenConfidences.has(f.properties.confidence)) return false
      if (clusterSearch.trim() && !f.properties.cluster_id?.toLowerCase().includes(clusterSearch.trim().toLowerCase())) return false
      if (minLiveScore > 0) {
        const score = f.properties.live_geo_quality
        if (score == null || score < minLiveScore) return false
      }
      return true
    })

    if (filtered.length === 0) return

    const geoLayer = L.geoJSON(
      { type: 'FeatureCollection', features: filtered } as GeoJSON.FeatureCollection,
      {
        style: (feature) => {
          const zone = (feature?.properties?.zone as string) ?? ''
          const s = ZONE_STYLE[zone] ?? ZONE_STYLE_DEFAULT
          const liveScore = feature?.properties?.live_geo_quality as number | null | undefined
          let fillColor = s.fillColor
          let fillOpacity = 0.15
          if (liveScore != null) {
            if (liveScore >= 85) { fillColor = '#22c55e'; fillOpacity = 0.25 }
            else if (liveScore >= 70) { fillColor = '#f59e0b'; fillOpacity = 0.20 }
            else { fillColor = '#ef4444'; fillOpacity = 0.20 }
          }
          return { color: s.color, weight: 1.2, fillColor, fillOpacity, opacity: 0.75 }
        },
        interactive: true,
        onEachFeature: (feature, layer) => {
          const p = feature.properties as MeridianFeature['properties']

          // Score-Bar HTML helper (inline für Leaflet)
          const bar = (val: number | null | undefined, color: string) => {
            const pct = val != null ? Math.round(Math.max(0, Math.min(1, val)) * 100) : 0
            return val != null
              ? `<div style="display:flex;align-items:center;gap:5px;font-size:10.5px;">
                  <div style="flex:1;height:3px;background:rgba(255,255,255,0.12);border-radius:2px;overflow:hidden;">
                    <div style="height:100%;width:${pct}%;background:${color};border-radius:2px;"></div>
                  </div>
                  <span style="color:${color};font-weight:600;font-variant-numeric:tabular-nums;min-width:28px;text-align:right;">${val.toFixed(2)}</span>
                </div>`
              : ''
          }

          const ZONE_DOT_COLORS: Record<string, string> = {
            overlap_geo: '#22c55e', overlap_ono: '#3b82f6', overlap_eq: '#a855f7',
            geodnet_only: '#4ade80', onocoy_only: '#60a5fa', sparse: '#9ca3af', transition: '#fbbf24',
          }

          const zoneColor = ZONE_DOT_COLORS[p.zone ?? ''] ?? '#9ca3af'
          const networkLabel = p.network === 'geodnet' ? 'GEODNET' : p.network === 'onocoy' ? 'onocoy' : (p.network || '—')
          const networkColor = p.network === 'geodnet' ? '#22c55e' : p.network === 'onocoy' ? '#3b82f6' : '#9ca3af'
          const confColor = p.confidence === 'strong' ? '#86efac' : p.confidence === 'moderate' ? '#fde68a' : '#fca5a5'
          const zoneLabel = (p.zone ?? '').replace(/_/g, ' ')

          const geoBar = bar(p.avg_geo_uq, '#22c55e')
          const onoBar = bar(p.avg_ono_uq, '#3b82f6')

          // Live score bar: quality 0-100 scaled to 0-1
          const liveScoreNorm = p.live_geo_quality != null ? p.live_geo_quality / 100 : null
          const liveBar = bar(liveScoreNorm, '#f59e0b')
          const liveLabel = p.live_geo_quality != null
            ? `<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
                <span style="color:#fbbf24;font-size:10px;width:28px;flex-shrink:0;">LIVE</span>${liveBar}
                ${p.live_station_count ? `<span style="color:#64748b;font-size:9.5px;white-space:nowrap;">${p.live_station_count}st</span>` : ''}
               </div>`
            : ''

          const tooltipHtml = `
            <div style="background:rgba(10,17,35,0.97);border:1px solid rgba(99,102,241,0.3);border-radius:8px;
                        padding:9px 12px;min-width:200px;max-width:230px;
                        box-shadow:0 4px 20px rgba(0,0,0,0.7);font-family:DM Sans,system-ui,sans-serif;">
              <div style="display:flex;align-items:center;gap:7px;margin-bottom:7px;">
                <span style="width:9px;height:9px;border-radius:50%;background:${zoneColor};flex-shrink:0;box-shadow:0 0 4px ${zoneColor}88;"></span>
                <span style="font-weight:700;color:#f1f5f9;font-size:12.5px;flex:1;letter-spacing:0.01em;">${zoneLabel}</span>
                <span style="font-size:10px;font-weight:600;color:${networkColor};background:${networkColor}1a;
                             border:1px solid ${networkColor}44;border-radius:4px;padding:1px 6px;white-space:nowrap;">${networkLabel}</span>
              </div>
              ${(geoBar || onoBar || liveLabel) ? `
              <div style="border-top:1px solid rgba(255,255,255,0.07);padding-top:6px;margin-bottom:6px;">
                ${liveLabel}
                ${geoBar ? `<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
                  <span style="color:#94a3b8;font-size:10px;width:28px;flex-shrink:0;">GEO</span>${geoBar}</div>` : ''}
                ${onoBar ? `<div style="display:flex;align-items:center;gap:6px;">
                  <span style="color:#94a3b8;font-size:10px;width:28px;flex-shrink:0;">ONO</span>${onoBar}</div>` : ''}
              </div>` : ''}
              <div style="border-top:1px solid rgba(255,255,255,0.07);padding-top:5px;
                          display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                ${p.confidence ? `<span style="color:${confColor};font-size:10px;font-weight:500;">${p.confidence}</span>` : ''}
                ${p.cell_count ? `<span style="color:#475569;font-size:10px;">·</span>
                  <span style="color:#64748b;font-size:10px;">${p.cell_count} cells</span>` : ''}
              </div>
            </div>`

          layer.bindTooltip(tooltipHtml, {
            sticky: true, opacity: 1, className: 'meridian-tooltip-clean', interactive: false, offset: [14, 0],
          })

          // Hover state: increase opacity
          layer.on('mouseover', function(this: L.Path) {
            this.setStyle({ fillOpacity: 0.35, weight: 2 })
          })
          layer.on('mouseout', function(this: L.Path) {
            this.setStyle({ fillOpacity: 0.15, weight: 1.2 })
          })

          // Click: open side panel
          layer.on('click', () => {
            onFeatureClick(feature.properties as MeridianFeature['properties'])
          })
        },
      },
    )
    geoLayer.addTo(map)
    layerRef.current = geoLayer

    return () => { if (layerRef.current) { map.removeLayer(layerRef.current); layerRef.current = null } }
  }, [map, features, visible, hiddenZoneTypes, hiddenConfidences, clusterSearch, minLiveScore, onFeatureClick])

  return null
}

// ── MERIDIAN status panel ─────────────────────────────────────────────────────

interface MeridianStatus {
  configured: boolean
  enabled: boolean
  atlasDir?: string
  configPath?: string
  fenceCount?: number
  geoCount?: number
  onoCount?: number
  lastModified?: string | null
}

interface ZoneStats {
  byZoneType: Record<string, number>
  byConfidence: Record<string, number>
  total: number
}

// Progress bar for regeneration
function ProgressBar({ percent }: { percent: number }) {
  return (
    <div className="w-full h-1.5 bg-gray-200 rounded-full overflow-hidden">
      <div
        className="h-full bg-[#0067ff] rounded-full transition-all duration-500"
        style={{ width: `${percent}%` }}
      />
    </div>
  )
}

// SSE-based regeneration with live log + progress
function useRegenerate(onDone: () => void) {
  const [active, setActive] = useState(false)
  const [progress, setProgress] = useState(0)
  const [progressMsg, setProgressMsg] = useState('')
  const [logLines, setLogLines] = useState<string[]>([])
  const [result, setResult] = useState<{ ok: boolean; error?: string } | null>(null)

  const start = useCallback(() => {
    setActive(true)
    setProgress(0)
    setProgressMsg('Connecting…')
    setLogLines([])
    setResult(null)

    const es = new EventSource('/api/meridian/regenerate')
    // EventSource only supports GET; we need POST → use fetch + manual SSE parsing
    es.close()

    fetch('/api/meridian/regenerate', { method: 'POST' }).then(async (res) => {
      if (!res.body) throw new Error('No response body')
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const parts = buf.split('\n\n')
        buf = parts.pop() ?? ''
        for (const part of parts) {
          const lines = part.split('\n')
          let event = 'message', data = ''
          for (const ln of lines) {
            if (ln.startsWith('event: ')) event = ln.slice(7).trim()
            if (ln.startsWith('data: ')) data = ln.slice(6).trim()
          }
          if (!data) continue
          try {
            const payload = JSON.parse(data) as Record<string, unknown>
            if (event === 'progress') {
              setProgress(payload.percent as number)
              setProgressMsg(payload.message as string)
            } else if (event === 'log') {
              setLogLines((prev) => [...prev.slice(-200), payload.line as string])
            } else if (event === 'done') {
              const ok = payload.ok as boolean
              setResult({ ok, error: payload.error as string | undefined })
              setActive(false)
              if (ok) onDone()
            }
          } catch { /* ignore malformed SSE */ }
        }
      }
    }).catch((err: unknown) => {
      setResult({ ok: false, error: String(err) })
      setActive(false)
    })
  }, [onDone])

  return { active, progress, progressMsg, logLines, result, start }
}

function MeridianPanel({
  onShowOverlay,
  overlayVisible,
  overlayLoading,
  zoneStats,
  hiddenZoneTypes,
  setHiddenZoneTypes,
  hiddenConfidences,
  setHiddenConfidences,
  clusterSearch,
  setClusterSearch,
  minLiveScore,
  setMinLiveScore,
  totalFeatures,
  scoredFeatures,
  geodnetCount,
  onocoyCount,
  geodnetStations,
  onocoyStations,
  lastStatusCheck,
  onRegenDone,
}: {
  onShowOverlay: () => void
  overlayVisible: boolean
  overlayLoading: boolean
  zoneStats: ZoneStats | null
  hiddenZoneTypes: Set<string>
  setHiddenZoneTypes: (s: Set<string>) => void
  hiddenConfidences: Set<string>
  setHiddenConfidences: (s: Set<string>) => void
  clusterSearch: string
  setClusterSearch: (v: string) => void
  minLiveScore: number
  setMinLiveScore: (v: number) => void
  totalFeatures: number
  scoredFeatures: number
  geodnetCount: number
  onocoyCount: number
  geodnetStations: Station[]
  onocoyStations: Station[]
  lastStatusCheck: number
  onRegenDone: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [status, setStatus] = useState<MeridianStatus | null>(null)
  const [showLog, setShowLog] = useState(false)
  const logEndRef = useRef<HTMLDivElement | null>(null)

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/meridian/status')
      setStatus(await res.json() as MeridianStatus)
    } catch { /* ignore */ }
  }, [])

  // Auto-refresh every 30s
  useEffect(() => { loadStatus() }, [loadStatus, lastStatusCheck])
  useEffect(() => {
    const id = setInterval(loadStatus, 30_000)
    return () => clearInterval(id)
  }, [loadStatus])

  const regenOnDone = useCallback(() => { loadStatus(); onRegenDone() }, [loadStatus, onRegenDone])
  const { active: regenerating, progress, progressMsg, logLines, result, start: startRegen } = useRegenerate(regenOnDone)

  // Auto-scroll log
  useEffect(() => {
    if (logLines.length > 0) logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logLines])

  const toggleInclude = async () => {
    if (!status) return
    await fetch('/api/meridian/status', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !status.enabled }),
    })
    loadStatus()
  }

  const lastMod = status?.lastModified
    ? new Date(status.lastModified).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })
    : null

  // Age warning: > 24h
  const isStale = status?.lastModified
    ? Date.now() - new Date(status.lastModified).getTime() > 24 * 3600 * 1000
    : false

  // Score distribution from station data
  const allStations = [...geodnetStations, ...onocoyStations]
  const scoreDist = useMemo(() => {
    const dist = { excellent: 0, good: 0, moderate: 0, poor: 0, unscored: 0 }
    for (const s of allStations) {
      const lbl = scoreLabel(s.score) as keyof typeof dist
      dist[lbl]++
    }
    return dist
  }, [allStations]) // eslint-disable-line react-hooks/exhaustive-deps

  const ZONE_TYPE_LABELS: Record<string, string> = {
    overlap:      'Overlap (GEODNET)',
    geodnet_only: 'GEODNET only',
    onocoy_only:  'onocoy only',
    sparse:       'Sparse',
    transition:   'Transition',
  }
  const ZONE_TYPE_COLORS: Record<string, string> = {
    overlap:      '#22c55e',
    geodnet_only: '#4ade80',
    onocoy_only:  '#60a5fa',
    sparse:       '#9ca3af',
    transition:   '#fbbf24',
  }
  const CONFIDENCE_COLORS: Record<string, string> = {
    strong: '#86efac',
    moderate: '#fde68a',
    weak: '#fca5a5',
  }

  const toggleZoneType = (zt: string) => {
    const next = new Set(hiddenZoneTypes)
    if (next.has(zt)) { next.delete(zt) } else { next.add(zt) }
    setHiddenZoneTypes(next)
  }
  const toggleConfidence = (c: string) => {
    const next = new Set(hiddenConfidences)
    if (next.has(c)) { next.delete(c) } else { next.add(c) }
    setHiddenConfidences(next)
  }

  const SCORE_COLORS = {
    excellent: '#22c55e', good: '#a3e635', moderate: '#f59e0b', poor: '#ef4444', unscored: '#6b7280',
  }

  return (
    <div className="border-t border-gray-200">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 px-4 py-3 hover:bg-gray-50 transition-colors text-left"
      >
        <Satellite className="w-4 h-4 text-[#0067ff] flex-shrink-0" />
        <span className="text-xs font-semibold text-gray-800 flex-1">MERIDIAN Zones</span>
        {isStale && (
          <span title="Data older than 24h">
            <AlertTriangle className="w-3 h-3 text-amber-400" />
          </span>
        )}
        {totalFeatures > 0 && (
          <span className="text-[9.5px] bg-slate-100 text-slate-500 border border-slate-200 rounded px-1.5 py-0.5 font-mono mr-1 whitespace-nowrap">
            {totalFeatures.toLocaleString()} zones · {scoredFeatures} scored
          </span>
        )}
        {expanded ? <ChevronDown className="w-3 h-3 text-gray-400" /> : <ChevronRight className="w-3 h-3 text-gray-400" />}
      </button>

      {expanded && (
        <div className="px-4 pb-4 space-y-3">
          {/* Status */}
          {status?.fenceCount ? (
            <div className="bg-gray-50 rounded p-2 space-y-0.5">
              <p className="text-[11px] font-medium text-gray-700">
                {status.fenceCount.toLocaleString()} polygons
                <span className="text-[#22c55e] ml-1">· {status.geoCount?.toLocaleString()} GEODNET</span>
                <span className="text-[#3b82f6] ml-1">· {status.onoCount?.toLocaleString()} onocoy</span>
              </p>
              {lastMod && (
                <p className={`text-[10px] ${isStale ? 'text-amber-500' : 'text-gray-400'}`}>
                  {isStale ? '⚠ ' : ''}Last generated: {lastMod}
                </p>
              )}
            </div>
          ) : (
            <p className="text-[11px] text-gray-400">No fence data yet. Run regenerate.</p>
          )}

          {/* Show overlay toggle */}
          <div className="flex items-center justify-between">
            <span className="text-xs text-gray-600">Show overlay on map</span>
            <button
              onClick={onShowOverlay}
              disabled={overlayLoading || !status?.fenceCount}
              className={`p-1 rounded transition-colors ${overlayVisible ? 'text-[#0067ff]' : 'text-gray-400 hover:text-gray-600'} disabled:opacity-40`}
            >
              {overlayLoading
                ? <Loader2 className="w-4 h-4 animate-spin" />
                : overlayVisible ? <ToggleRight className="w-5 h-5" /> : <ToggleLeft className="w-5 h-5" />}
            </button>
          </div>

          {/* Min Live Score slider */}
          {overlayVisible && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Min Live Score</p>
                <span className="text-[10px] font-mono text-gray-600">
                  {minLiveScore === 0 ? 'all' : minLiveScore}
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                value={minLiveScore}
                onChange={(e) => setMinLiveScore(Number(e.target.value))}
                className="w-full h-1.5 rounded-full appearance-none cursor-pointer accent-[#0067ff] bg-gray-200"
              />
              <div className="flex justify-between text-[9px] text-gray-400">
                <span>0</span>
                <span>50</span>
                <span>100</span>
              </div>
            </div>
          )}

          {/* Zone type legend + filter */}
          {overlayVisible && zoneStats && Object.keys(zoneStats.byZoneType).length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Zone Types</p>
              {Object.entries(zoneStats.byZoneType)
                .sort((a, b) => b[1] - a[1])
                .map(([zt, cnt]) => {
                  const hidden = hiddenZoneTypes.has(zt)
                  const col = ZONE_TYPE_COLORS[zt] ?? '#9ca3af'
                  return (
                    <button
                      key={zt}
                      onClick={() => toggleZoneType(zt)}
                      className={`w-full flex items-center gap-2 text-left transition-opacity ${hidden ? 'opacity-40' : 'opacity-100'}`}
                    >
                      <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ backgroundColor: col }} />
                      <span className="text-[10.5px] text-gray-600 flex-1 truncate">
                        {ZONE_TYPE_LABELS[zt] ?? zt}
                      </span>
                      <span className="text-[10px] text-gray-400 font-mono">{cnt}</span>
                    </button>
                  )
                })}
            </div>
          )}

          {/* Confidence filter */}
          {overlayVisible && zoneStats && Object.keys(zoneStats.byConfidence).length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Confidence</p>
              <div className="flex gap-1.5 flex-wrap">
                {(['strong', 'moderate', 'weak'] as const).map((c) => {
                  const cnt = zoneStats.byConfidence[c] ?? 0
                  if (!cnt) return null
                  const hidden = hiddenConfidences.has(c)
                  const col = CONFIDENCE_COLORS[c]
                  return (
                    <button
                      key={c}
                      onClick={() => toggleConfidence(c)}
                      className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium border transition-all ${
                        hidden ? 'opacity-40 border-gray-200 text-gray-400' : 'border-transparent text-white'
                      }`}
                      style={!hidden ? { backgroundColor: `${col}30`, color: col, borderColor: `${col}60` } : {}}
                    >
                      {c} <span className="opacity-70">({cnt})</span>
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {/* Cluster search */}
          {overlayVisible && (
            <div className="relative">
              <input
                type="text"
                value={clusterSearch}
                onChange={(e) => setClusterSearch(e.target.value)}
                placeholder="Search cluster ID…"
                className="w-full h-7 px-2 pr-6 text-[11px] border border-gray-200 rounded bg-white focus:outline-none focus:border-[#0067ff]"
              />
              {clusterSearch && (
                <button onClick={() => setClusterSearch('')} className="absolute right-1.5 top-1 text-gray-400 hover:text-gray-600">
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          )}

          {/* Station quality dashboard */}
          {allStations.length > 0 && (
            <div className="bg-gray-50 rounded p-2 space-y-2">
              <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Station Quality</p>
              <div className="flex gap-3 text-[10.5px]">
                <span className="text-gray-600">
                  <span className="font-semibold text-gray-800">{geodnetCount.toLocaleString()}</span>
                  <span className="text-[#22c55e] ml-0.5"> GEODNET</span>
                </span>
                <span className="text-gray-600">
                  <span className="font-semibold text-gray-800">{onocoyCount.toLocaleString()}</span>
                  <span className="text-[#3b82f6] ml-0.5"> onocoy</span>
                </span>
              </div>
              <div className="space-y-1">
                {(Object.entries(scoreDist) as [keyof typeof scoreDist, number][])
                  .filter(([, c]) => c > 0)
                  .map(([lbl, cnt]) => {
                    const pct = allStations.length > 0 ? (cnt / allStations.length) * 100 : 0
                    const col = SCORE_COLORS[lbl]
                    return (
                      <div key={lbl} className="flex items-center gap-1.5">
                        <span className="text-[10px] w-14 text-gray-500 capitalize">{lbl}</span>
                        <div className="flex-1 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                          <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: col }} />
                        </div>
                        <span className="text-[10px] font-mono text-gray-400 w-6 text-right">{cnt}</span>
                      </div>
                    )
                  })}
              </div>
            </div>
          )}

          {/* Include in config toggle */}
          <div className="flex items-center justify-between">
            <div>
              <span className="text-xs text-gray-600">Include in config</span>
              <p className="text-[10px] text-gray-400">Adds --config = atlas_ntrips_zones.cfg</p>
            </div>
            <button
              onClick={toggleInclude}
              className={`p-1 rounded transition-colors ${status?.enabled ? 'text-[#0067ff]' : 'text-gray-400 hover:text-gray-600'}`}
            >
              {status?.enabled ? <ToggleRight className="w-5 h-5" /> : <ToggleLeft className="w-5 h-5" />}
            </button>
          </div>

          {status?.enabled && status.configPath && (
            <p className="text-[10px] text-gray-400 font-mono break-all bg-gray-50 p-1 rounded">
              {status.configPath}
            </p>
          )}

          {/* Regenerate button + progress */}
          <button
            onClick={() => { startRegen(); setShowLog(true) }}
            disabled={regenerating}
            className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded text-xs font-medium border border-gray-200 hover:border-[#0067ff] hover:text-[#0067ff] transition-colors disabled:opacity-50"
          >
            {regenerating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            {regenerating ? 'Regenerating…' : 'Regenerate Fences'}
          </button>

          {regenerating && (
            <div className="space-y-1">
              <ProgressBar percent={progress} />
              <p className="text-[10px] text-gray-400">{progressMsg}</p>
            </div>
          )}

          {result && !regenerating && (
            <div className={`flex items-center gap-1.5 text-[11px] ${result.ok ? 'text-green-600' : 'text-red-500'}`}>
              {result.ok
                ? <><CheckCircle2 className="w-3.5 h-3.5" /> Fences regenerated</>
                : <><X className="w-3.5 h-3.5" /> {result.error ?? 'Failed'}</>}
            </div>
          )}

          {/* Log toggle */}
          {(logLines.length > 0 || regenerating) && (
            <button
              onClick={() => setShowLog((v) => !v)}
              className="flex items-center gap-1 text-[10px] text-gray-400 hover:text-gray-600 transition-colors"
            >
              <Terminal className="w-3 h-3" />
              {showLog ? 'Hide' : 'Show'} log ({logLines.length} lines)
            </button>
          )}

          {showLog && logLines.length > 0 && (
            <div className="bg-slate-900 rounded p-2 max-h-32 overflow-y-auto font-mono text-[9.5px] text-slate-300 space-y-0.5">
              {logLines.map((line, i) => (
                <p key={i} className={line.includes('[stderr]') ? 'text-amber-400' : 'text-slate-300'}>{line}</p>
              ))}
              <div ref={logEndRef} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Zone Polygon Click Side Panel ─────────────────────────────────────────────

function ZoneFeaturePanel({
  feature,
  onClose,
  networks,
  onUseCluster,
}: {
  feature: MeridianFeature['properties']
  onClose: () => void
  networks: Record<string, { id: string; name: string }>
  onUseCluster: (clusterId: string) => void
}) {
  const fmt = (v: number | null | undefined) => v != null ? (v * 100).toFixed(1) + '%' : '—'
  const fmtRaw = (v: number | null | undefined) => v != null ? v.toFixed(3) : '—'

  const geoEff = feature.avg_geo_eff ?? 0
  const onoEff = feature.avg_ono_eff ?? 0
  const maxEff = Math.max(geoEff, onoEff, 0.01)

  const CONFIDENCE_COLORS: Record<string, string> = {
    strong: '#22c55e', moderate: '#f59e0b', weak: '#ef4444',
  }
  const confColor = CONFIDENCE_COLORS[feature.confidence] ?? '#9ca3af'

  const networkList = Object.values(networks)

  return (
    <div className="w-64 flex-shrink-0 bg-white border-l border-gray-200 flex flex-col max-h-full overflow-y-auto">
      <div className="p-4 border-b border-gray-200 flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 mb-0.5">
            <span
              className="w-2.5 h-2.5 rounded-sm flex-shrink-0"
              style={{ backgroundColor: ZONE_STYLE[feature.zone]?.fillColor ?? '#9ca3af' }}
            />
            <h3 className="font-semibold text-gray-800 text-sm">{feature.zone || 'Unknown zone'}</h3>
          </div>
          <p className="text-[10px] text-gray-400 ml-4">
            {feature.cluster_id ? `Cluster: ${feature.cluster_id}` : 'No cluster ID'}
          </p>
        </div>
        <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600 flex-shrink-0">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="p-4 space-y-4">
        {/* Recommended network + confidence */}
        <div className="bg-gray-50 rounded p-3 space-y-2">
          <div className="flex justify-between items-center">
            <span className="text-xs text-gray-500">Recommended</span>
            <span className="text-xs font-semibold" style={{ color: feature.network === 'geodnet' ? '#22c55e' : '#3b82f6' }}>
              {feature.network || '—'}
            </span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-xs text-gray-500">Confidence</span>
            <span className="text-xs font-semibold px-2 py-0.5 rounded-full" style={{ color: confColor, backgroundColor: `${confColor}20` }}>
              {feature.confidence || '—'}
            </span>
          </div>
          {feature.cell_count ? (
            <div className="flex justify-between items-center">
              <span className="text-xs text-gray-500">Grid cells</span>
              <span className="text-xs text-gray-700 font-mono">{feature.cell_count}</span>
            </div>
          ) : null}
        </div>

        {/* Visual efficiency comparison */}
        <div className="space-y-2">
          <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Network Efficiency</p>

          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="text-[10.5px] text-[#22c55e] w-16">GEODNET</span>
              <div className="flex-1 h-3 bg-gray-100 rounded overflow-hidden">
                <div
                  className="h-full rounded transition-all"
                  style={{ width: `${(geoEff / maxEff) * 100}%`, backgroundColor: '#22c55e' }}
                />
              </div>
              <span className="text-[10.5px] font-mono text-gray-600 w-10 text-right">{fmt(feature.avg_geo_eff)}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10.5px] text-[#3b82f6] w-16">onocoy</span>
              <div className="flex-1 h-3 bg-gray-100 rounded overflow-hidden">
                <div
                  className="h-full rounded transition-all"
                  style={{ width: `${(onoEff / maxEff) * 100}%`, backgroundColor: '#3b82f6' }}
                />
              </div>
              <span className="text-[10.5px] font-mono text-gray-600 w-10 text-right">{fmt(feature.avg_ono_eff)}</span>
            </div>
          </div>

          {/* UQ scores */}
          {(feature.avg_geo_uq != null || feature.avg_ono_uq != null) && (
            <div className="mt-2 pt-2 border-t border-gray-100 grid grid-cols-2 gap-1 text-[10.5px]">
              <span className="text-gray-400">GEODNET UQ</span><span className="font-mono text-gray-600">{fmtRaw(feature.avg_geo_uq)}</span>
              <span className="text-gray-400">onocoy UQ</span><span className="font-mono text-gray-600">{fmtRaw(feature.avg_ono_uq)}</span>
            </div>
          )}
        </div>

        {/* Live GEODNET score */}
        {feature.live_geo_quality != null && (
          <div className="space-y-2">
            <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse inline-block" />
              Live GEODNET Score
            </p>
            <div className="bg-amber-50 rounded p-3 space-y-2">
              <div className="flex items-center gap-2">
                <div className="flex-1 h-2.5 bg-gray-100 rounded overflow-hidden">
                  <div
                    className="h-full rounded transition-all"
                    style={{ width: `${feature.live_geo_quality}%`, backgroundColor: '#f59e0b' }}
                  />
                </div>
                <span className="text-xs font-bold font-mono text-amber-600 w-10 text-right">
                  {feature.live_geo_quality.toFixed(1)}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-1 text-[10.5px]">
                {feature.live_station_count != null && feature.live_station_count > 0 && (
                  <>
                    <span className="text-gray-400">Stations</span>
                    <span className="font-mono text-gray-600">{feature.live_station_count}</span>
                  </>
                )}
                {feature.live_geo_uq_ntrip != null && (
                  <>
                    <span className="text-gray-400">Live UQ</span>
                    <span className="font-mono text-gray-600">{fmtRaw(feature.live_geo_uq_ntrip)}</span>
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Use cluster button */}
        {feature.cluster_id && networkList.length > 0 && (
          <div className="pt-2 border-t border-gray-100">
            <p className="text-[10px] text-gray-400 mb-2">
              Create a pinput stream using this cluster polygon as geo-fence:
            </p>
            <button
              onClick={() => onUseCluster(feature.cluster_id!)}
              className="w-full py-1.5 rounded text-xs font-medium bg-[#0067ff]/10 text-[#0067ff] border border-[#0067ff]/30 hover:bg-[#0067ff]/20 transition-colors"
            >
              Use Cluster in Config
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Map Legend ────────────────────────────────────────────────────────────────

function MapLegend({ showGeodnet, showOnocoy, geodnetCount, onocoyCount }: {
  showGeodnet: boolean; showOnocoy: boolean; geodnetCount: number; onocoyCount: number
}) {
  if (!showGeodnet && !showOnocoy) return null
  return (
    <div className="absolute bottom-6 left-3 z-[1000] bg-white/90 backdrop-blur-sm border border-gray-200 rounded-lg p-3 text-xs shadow-md">
      <p className="font-semibold text-gray-700 mb-2">Station Coverage</p>
      <div className="space-y-1.5">
        {showGeodnet && (
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ background: NETWORK_COLORS.geodnet }} />
            <span className="text-gray-600">GEODNET ({geodnetCount.toLocaleString()} stations)</span>
          </div>
        )}
        {showOnocoy && (
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ background: NETWORK_COLORS.onocoy }} />
            <span className="text-gray-600">Onocoy ({onocoyCount.toLocaleString()} stations)</span>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Loading overlay for MERIDIAN GeoJSON ──────────────────────────────────────

function MeridianLoadingOverlay({ visible }: { visible: boolean }) {
  if (!visible) return null
  return (
    <div className="absolute inset-0 z-[2000] flex items-center justify-center bg-black/30 pointer-events-none">
      <div className="bg-slate-900/90 border border-slate-700 rounded-xl px-6 py-4 flex items-center gap-3 shadow-2xl">
        <Loader2 className="w-5 h-5 text-[#0067ff] animate-spin" />
        <div>
          <p className="text-sm font-semibold text-white">Loading MERIDIAN zones…</p>
          <p className="text-xs text-slate-400">2140+ polygons — may take a few seconds</p>
        </div>
      </div>
    </div>
  )
}

// ── Zone config form (shared for create and edit) ─────────────────────────

function ZoneConfigForm({
  mode, geofence, initialValues, onSave, onCancel,
}: {
  mode: 'create' | 'edit'; geofence: GeoFence | null; initialValues?: Partial<Zone>
  onSave: (data: Omit<Zone, 'id'>) => void; onCancel: () => void
}) {
  const networks = useConfigStore(selectNetworks)
  const networkList = useMemo(() => Object.values(networks), [networks])

  const [name, setName] = useState(initialValues?.name ?? '')
  const [networkId, setNetworkId] = useState(initialValues?.networkId ?? networkList[0]?.id ?? '')
  const [priority, setPriority] = useState(initialValues?.priority ?? 1)
  const [color, setColor] = useState(initialValues?.color ?? ZONE_COLORS[0])
  const [error, setError] = useState<string | null>(null)

  const effectiveGeofence = geofence ?? initialValues?.geofence ?? null

  const geofenceDesc = effectiveGeofence
    ? effectiveGeofence.type === 'circle'
      ? `Circle (${((effectiveGeofence.radius ?? 0) / 1000).toFixed(0)} km radius)`
      : `Polygon (${effectiveGeofence.points?.length ?? 0} points)`
    : 'No geo-fence (global)'

  const handleSave = () => {
    setError(null)
    if (!name.trim()) { setError('Zone name is required'); return }
    if (!networkId) { setError('Network is required'); return }
    onSave({ name: name.trim(), networkId, enabled: initialValues?.enabled ?? true, geofence: effectiveGeofence, color, priority })
  }

  return (
    <div className="w-72 flex-shrink-0 bg-white border-l border-gray-200 flex flex-col">
      <div className="p-4 border-b border-gray-200">
        <button onClick={onCancel} className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600 mb-2 transition-colors">
          <ChevronLeft className="w-3.5 h-3.5" /> Back to list
        </button>
        <h3 className="font-semibold text-gray-800 text-sm">{mode === 'create' ? 'New Zone' : 'Edit Zone'}</h3>
        <p className="text-xs text-gray-400 mt-0.5">{geofenceDesc}</p>
      </div>
      <div className="flex-1 p-4 space-y-3 overflow-y-auto">
        {error && <p className="text-xs text-red-500 bg-red-50 p-2 rounded border border-red-200">{error}</p>}
        <div className="space-y-1.5">
          <Label className="text-xs font-medium">Zone Name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Europe GEODNET" className="h-8 text-sm" />
          <p className="text-[10px] text-gray-400">Internal label, not shown in config</p>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs font-medium">Network</Label>
          <Select value={networkId} onValueChange={setNetworkId}>
            <SelectTrigger className="h-8 text-sm"><SelectValue placeholder="Select network" /></SelectTrigger>
            <SelectContent className="z-[9999]">
              {networkList.map((n) => <SelectItem key={n.id} value={n.id}>{n.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <p className="text-[10px] text-gray-400">Upstream NTRIP network (e.g. GEODNET, Onocoy)</p>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs font-medium">Priority</Label>
          <Input type="number" min={1} value={priority} onChange={(e) => setPriority(parseInt(e.target.value) || 1)} className="h-8 text-sm w-20" />
          <p className="text-[10px] text-gray-400">1 = highest priority in config file</p>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs font-medium">Color (Map)</Label>
          <div className="flex gap-1.5 flex-wrap">
            {ZONE_COLORS.map((c) => (
              <button key={c} className={`w-6 h-6 rounded-full border-2 transition-transform hover:scale-110 ${color === c ? 'border-gray-700 scale-110' : 'border-transparent'}`}
                style={{ backgroundColor: c }} onClick={() => setColor(c)} title={c} />
            ))}
          </div>
        </div>
      </div>
      <div className="p-4 border-t border-gray-200 flex gap-2">
        <Button variant="outline" size="sm" onClick={onCancel} className="flex-1 h-8">Cancel</Button>
        <Button size="sm" onClick={handleSave} className="flex-1 h-8 bg-[#0067ff] hover:bg-[#005ee9] text-white">
          {mode === 'create' ? 'Create Zone' : 'Save'}
        </Button>
      </div>
    </div>
  )
}

// ── Zone list item ────────────────────────────────────────────────────────────

function ZoneListItem({ zone, networkName, onEdit, onToggle, onDelete }: {
  zone: Zone; networkName: string | null; onEdit: () => void; onToggle: () => void; onDelete: () => void
}) {
  const geofenceLabel = zone.geofence?.type === 'circle'
    ? `Circle ${((zone.geofence.radius ?? 0) / 1000).toFixed(0)} km`
    : zone.geofence?.type === 'polygon'
    ? `Polygon ${zone.geofence.points?.length ?? 0} points`
    : 'No geo-fence (global)'

  return (
    <div className="group flex items-start gap-2 p-3 hover:bg-gray-50 transition-colors cursor-default">
      <div className="w-1 self-stretch rounded-full flex-shrink-0 mt-0.5 transition-opacity"
        style={{ backgroundColor: zone.color, opacity: zone.enabled ? 1 : 0.3 }} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 mb-0.5">
          <span className={`text-xs font-semibold truncate ${zone.enabled ? 'text-gray-800' : 'text-gray-400'}`}>{zone.name}</span>
          {!zone.enabled && <span className="text-[9px] bg-gray-100 text-gray-400 px-1 py-0.5 rounded flex-shrink-0 leading-none">OFF</span>}
        </div>
        <p className={`text-[10px] truncate ${networkName ? 'text-gray-400' : 'text-amber-500 font-medium'}`}>{networkName ?? '⚠ Network missing'}</p>
        <p className="text-[10px] text-gray-300">{geofenceLabel}</p>
      </div>
      <div className="flex items-center gap-0.5 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
        <button onClick={onEdit} className="p-1 rounded text-gray-400 hover:text-[#0067ff] hover:bg-blue-50 transition-colors" title="Edit zone"><Pencil className="w-3.5 h-3.5" /></button>
        <button onClick={onToggle} className={`p-1 rounded transition-colors ${zone.enabled ? 'text-[#0067ff] hover:bg-blue-50' : 'text-gray-400 hover:bg-gray-100'}`} title={zone.enabled ? 'Disable' : 'Enable'}>
          {zone.enabled ? <ToggleRight className="w-4 h-4" /> : <ToggleLeft className="w-4 h-4" />}
        </button>
        <button onClick={onDelete} className="p-1 rounded text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors" title="Delete zone"><Trash2 className="w-3.5 h-3.5" /></button>
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function ZoneMap() {
  const zones = useConfigStore(selectZones)
  const networks = useConfigStore(selectNetworks)
  const addZone = useConfigStore((s) => s.addZone)
  const updateZone = useConfigStore((s) => s.updateZone)
  const toggleZone = useConfigStore((s) => s.toggleZone)
  const deleteZone = useConfigStore((s) => s.deleteZone)

  const [panelMode, setPanelMode] = useState<PanelMode>('list')
  const [pendingGeoFence, setPendingGeoFence] = useState<GeoFence | null>(null)
  const [editingZoneId, setEditingZoneId] = useState<string | null>(null)
  const featureGroupRef = useRef<L.FeatureGroup | null>(null)
  const [mapZoom, setMapZoom] = useState(4)
  const handleZoomChange = useCallback((z: number) => setMapZoom(z), [])

  const [geodnetStations, setGeodnetStations] = useState<Station[]>([])
  const [onocoyStations, setOnocoyStations] = useState<Station[]>([])
  const [showGeodnet, setShowGeodnet] = useState(false)
  const [showOnocoy, setShowOnocoy] = useState(false)
  const [loadingGeodnet, setLoadingGeodnet] = useState(false)
  const [loadingOnocoy, setLoadingOnocoy] = useState(false)
  const [coverageError, setCoverageError] = useState<string | null>(null)

  // MERIDIAN overlay state
  const [meridianFeatures, setMeridianFeatures] = useState<MeridianFeature[]>([])
  const [meridianStats, setMeridianStats] = useState<ZoneStats | null>(null)
  const [showMeridian, setShowMeridian] = useState(false)
  const [loadingMeridian, setLoadingMeridian] = useState(false)

  // MERIDIAN filter state
  const [hiddenZoneTypes, setHiddenZoneTypes] = useState<Set<string>>(new Set(['transition']))
  const [hiddenConfidences, setHiddenConfidences] = useState<Set<string>>(new Set())
  const [clusterSearch, setClusterSearch] = useState('')
  const [minLiveScore, setMinLiveScore] = useState(0)

  // Clicked polygon side panel
  const [clickedFeature, setClickedFeature] = useState<MeridianFeature['properties'] | null>(null)

  // Last status refresh trigger (bump to force re-fetch)
  const [lastStatusCheck, setLastStatusCheck] = useState(0)

  // MERIDIAN import state
  const [importingMeridian, setImportingMeridian] = useState(false)
  const [importResult, setImportResult] = useState<{ imported: number; skipped: number; networks_missing: string[]; timestamp: string } | null>(null)
  const [importError, setImportError] = useState<string | null>(null)

  // Manual draw controls visibility (hidden by default — use MERIDIAN import instead)
  const [showManualDraw, setShowManualDraw] = useState(false)

  const setZonesStore = useConfigStore((s) => s.setZones)

  const loadMeridianOverlay = useCallback(async () => {
    if (showMeridian) { setShowMeridian(false); return }
    if (meridianFeatures.length > 0) { setShowMeridian(true); return }
    setLoadingMeridian(true)
    try {
      const res = await fetch('/api/meridian/geojson')
      const data = await res.json() as { features?: MeridianFeature[]; stats?: ZoneStats }
      setMeridianFeatures(data.features ?? [])
      if (data.stats) setMeridianStats(data.stats)
      setShowMeridian(true)
    } catch { /* ignore */ }
    setLoadingMeridian(false)
  }, [showMeridian, meridianFeatures.length])

  // Auto-load all overlays on mount
  useEffect(() => {
    const autoLoad = async () => {
      setLoadingGeodnet(true)
      try {
        const res = await fetch('/api/coverage/geodnet')
        const data = await res.json() as { stations?: Station[]; error?: string }
        setGeodnetStations(data.stations ?? [])
        setShowGeodnet((data.stations?.length ?? 0) > 0)
      } catch { /* ignore */ }
      finally { setLoadingGeodnet(false) }

      setLoadingOnocoy(true)
      try {
        const res = await fetch('/api/coverage/onocoy')
        const data = await res.json() as { stations?: Station[]; error?: string }
        setOnocoyStations(data.stations ?? [])
        setShowOnocoy((data.stations?.length ?? 0) > 0)
      } catch { /* ignore */ }
      finally { setLoadingOnocoy(false) }

      setLoadingMeridian(true)
      try {
        const res = await fetch('/api/meridian/geojson')
        const data = await res.json() as { features?: MeridianFeature[]; stats?: ZoneStats }
        const features = data.features ?? []
        if (features.length > 0) {
          setMeridianFeatures(features)
          if (data.stats) setMeridianStats(data.stats)
          setShowMeridian(true)
        }
      } catch { /* ignore */ }
      finally { setLoadingMeridian(false) }

    }
    autoLoad()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Exclude MERIDIAN-imported zones (id starts with "meridian_") from React rendering.
  // They are visualised by MeridianOverlayLayer (single L.geoJSON layer) — rendering 2000+
  // as individual <Polygon> components would freeze the browser.
  const zoneList = useMemo(
    () => Object.values(zones).filter((z) => !z.id.startsWith('meridian_')).sort((a, b) => a.priority - b.priority),
    [zones],
  )
  const editingZone = editingZoneId ? zones[editingZoneId] : null

  const scoredFeatures = useMemo(
    () => meridianFeatures.filter((f) => f.properties.live_geo_quality != null).length,
    [meridianFeatures],
  )

  const loadCoverage = useCallback(async (network: 'geodnet' | 'onocoy') => {
    const isShowing = network === 'geodnet' ? showGeodnet : showOnocoy
    const setShow = network === 'geodnet' ? setShowGeodnet : setShowOnocoy
    const setLoading = network === 'geodnet' ? setLoadingGeodnet : setLoadingOnocoy
    const setStations = network === 'geodnet' ? setGeodnetStations : setOnocoyStations
    const alreadyLoaded = (network === 'geodnet' ? geodnetStations : onocoyStations).length > 0
    if (isShowing) { setShow(false); return }
    setShow(true); setCoverageError(null)
    if (alreadyLoaded) return
    setLoading(true)
    try {
      const res = await fetch(`/api/coverage/${network}`)
      const data = await res.json() as { stations?: Station[]; error?: string }
      const stations = data.stations ?? []
      setStations(stations)
      if (data.error) setCoverageError(`${network}: ${data.error}`)
      else if (stations.length === 0) setCoverageError(`${network}: No stations found`)
    } catch { setCoverageError(`${network}: Network error`) }
    finally { setLoading(false) }
  }, [showGeodnet, showOnocoy, geodnetStations, onocoyStations])

  const handleCreated = useCallback((e: L.DrawEvents.Created) => {
    const layer = e.layer
    let geofence: GeoFence | null = null
    if (e.layerType === 'circle') {
      const c = layer as L.Circle
      geofence = { type: 'circle', radius: Math.round(c.getRadius()), lat: c.getLatLng().lat, lon: c.getLatLng().lng }
    } else if (e.layerType === 'polygon') {
      const p = layer as L.Polygon
      const latlngs = p.getLatLngs()[0] as L.LatLng[]
      geofence = { type: 'polygon', points: latlngs.map((ll) => [ll.lat, ll.lng]) }
    }
    if (geofence) {
      featureGroupRef.current?.removeLayer(layer)
      setPendingGeoFence(geofence); setEditingZoneId(null); setPanelMode('create')
    }
  }, [])

  const handleSaveCreate = async (zoneData: Omit<Zone, 'id'>) => {
    const id = generateId()
    const zone: Zone = { ...zoneData, id }
    addZone(zone); setPendingGeoFence(null); setPanelMode('list')
    await fetch('/api/data/zones', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: id, value: zoneToJSON(zone) }) })
  }

  const handleSaveEdit = async (zoneData: Omit<Zone, 'id'>) => {
    if (!editingZoneId) return
    updateZone(editingZoneId, zoneData)
    const updated: Zone = { ...zoneData, id: editingZoneId }
    setEditingZoneId(null); setPanelMode('list')
    await fetch('/api/data/zones', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: editingZoneId, value: zoneToJSON(updated) }) })
  }

  const handleEditZone = useCallback((id: string) => { setEditingZoneId(id); setPendingGeoFence(null); setPanelMode('edit') }, [])

  const handleDeleteZone = async (id: string) => {
    if (!confirm('Really delete this zone?')) return
    if (editingZoneId === id) { setEditingZoneId(null); setPanelMode('list') }
    deleteZone(id)
    await fetch(`/api/data/zones?key=${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  const handleToggleZone = async (id: string) => {
    toggleZone(id)
    const zone = zones[id]; if (!zone) return
    const updated = { ...zone, enabled: !zone.enabled }
    await fetch('/api/data/zones', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: id, value: zoneToJSON(updated) }) })
  }

  const handleCancelPanel = useCallback(() => { setPendingGeoFence(null); setEditingZoneId(null); setPanelMode('list') }, [])

  const reloadMeridianGeoJSON = useCallback(() => {
    setLastStatusCheck(Date.now())
    setMeridianFeatures([])
    setMeridianStats(null)
    setShowMeridian(false)
    setTimeout(() => {
      setLoadingMeridian(true)
      fetch('/api/meridian/geojson')
        .then((r) => r.json() as Promise<{ features?: MeridianFeature[]; stats?: ZoneStats }>)
        .then((data) => {
          setMeridianFeatures(data.features ?? [])
          if (data.stats) setMeridianStats(data.stats)
          if ((data.features?.length ?? 0) > 0) setShowMeridian(true)
        })
        .catch(() => { /* ignore */ })
        .finally(() => setLoadingMeridian(false))
    }, 500)
  }, [])

  // MERIDIAN import — calls POST /api/meridian/import-zones, then re-fetches zones
  const handleMeridianImport = useCallback(async () => {
    setImportingMeridian(true)
    setImportError(null)
    setImportResult(null)
    try {
      const res = await fetch('/api/meridian/import-zones', { method: 'POST' })
      const data = await res.json() as { imported?: number; skipped?: number; networks_missing?: string[]; timestamp?: string; error?: string }
      if (!res.ok || data.error) {
        setImportError(data.error ?? 'Import failed')
        return
      }
      setImportResult({
        imported: data.imported ?? 0,
        skipped: data.skipped ?? 0,
        networks_missing: data.networks_missing ?? [],
        timestamp: data.timestamp ?? new Date().toISOString(),
      })
      // Re-fetch zones from server and update store
      const freshRaw = await fetch('/api/data/zones').then((r) => r.json()).catch(() => ({})) as Record<string, unknown>
      const freshZones: Record<string, ReturnType<typeof zoneFromJSON>> = {}
      for (const [k, v] of Object.entries(freshRaw)) {
        freshZones[k] = zoneFromJSON(v as Parameters<typeof zoneFromJSON>[0])
      }
      setZonesStore(freshZones)
      // Reload MERIDIAN overlay to reflect new zones
      reloadMeridianGeoJSON()
    } catch (e) {
      setImportError(e instanceof Error ? e.message : 'Network error')
    } finally {
      setImportingMeridian(false)
    }
  }, [setZonesStore, reloadMeridianGeoJSON])

  // "Use cluster in config" handler — opens create panel with polygon geofence stub
  const handleUseCluster = useCallback((_clusterId: string) => {
    // Navigate user to create zone panel; in a real implementation the cluster polygon
    // would be fetched and pre-filled. For now we open the create panel.
    setPendingGeoFence(null)
    setEditingZoneId(null)
    setPanelMode('create')
    setClickedFeature(null)
  }, [])

  const handleFeatureClick = useCallback((f: MeridianFeature['properties']) => {
    setClickedFeature(f)
    // Close zone create/edit panels
    setPanelMode('list')
    setPendingGeoFence(null)
    setEditingZoneId(null)
  }, [])

  // Determine which side panel to show
  const showZoneCreateEdit = panelMode === 'create' || panelMode === 'edit'
  const showFeaturePanel = !showZoneCreateEdit && clickedFeature != null

  return (
    <div className="flex flex-1 overflow-hidden relative">
      {/* Map area */}
      <div className="flex-1 relative">
        {coverageError && (
          <div className="absolute top-14 right-3 z-[1000] bg-red-900/80 border border-red-500/40 text-red-300 text-[11px] px-3 py-1.5 rounded max-w-xs">
            ⚠ {coverageError}
          </div>
        )}
        <div className="absolute top-3 right-3 z-[1000] flex gap-2">
          <CoverageButton label="GEODNET" color={NETWORK_COLORS.geodnet} active={showGeodnet} loading={loadingGeodnet} count={geodnetStations.length} onClick={() => loadCoverage('geodnet')} />
          <CoverageButton label="Onocoy" color={NETWORK_COLORS.onocoy} active={showOnocoy} loading={loadingOnocoy} count={onocoyStations.length} onClick={() => loadCoverage('onocoy')} />
        </div>

        <MeridianLoadingOverlay visible={loadingMeridian} />

        <MapContainer center={[50, 10]} zoom={4} className="h-full w-full" style={{ background: '#0f172a' }}>
          <ZoomTracker onZoomChange={handleZoomChange} />
          <TileLayer url={DARK_TILES} attribution={DARK_ATTR} />
          <StationDotLayer
            stations={geodnetStations} color={NETWORK_COLORS.geodnet}
            network="GEODNET" visible={showGeodnet} paneSuffix="geodnet"
          />
          <StationDotLayer
            stations={onocoyStations} color={NETWORK_COLORS.onocoy}
            network="onocoy" visible={showOnocoy} paneSuffix="onocoy"
          />
          <MeridianOverlayLayer
            features={meridianFeatures}
            visible={showMeridian}
            hiddenZoneTypes={hiddenZoneTypes}
            hiddenConfidences={hiddenConfidences}
            clusterSearch={clusterSearch}
            minLiveScore={minLiveScore}
            onFeatureClick={handleFeatureClick}
          />
          <FeatureGroup ref={featureGroupRef}>
            <EditControl position="topleft" onCreated={handleCreated}
              draw={{ rectangle: false, polyline: false, marker: false, circlemarker: false,
                polygon: { shapeOptions: { color: '#10B981', weight: 2, fillOpacity: 0.15 } },
                circle: { shapeOptions: { color: '#10B981', weight: 2, fillOpacity: 0.15 } } }}
              edit={{ edit: false, remove: false }} />
          </FeatureGroup>
          <ViewportZoneLayer zones={zoneList} zoom={mapZoom} editingZoneId={editingZoneId} onZoneClick={handleEditZone} />
          <MapLegend showGeodnet={showGeodnet} showOnocoy={showOnocoy} geodnetCount={geodnetStations.length} onocoyCount={onocoyStations.length} />
        </MapContainer>
      </div>

      {/* Right panel — zone create/edit, feature detail, or zone list */}
      {panelMode === 'create' && pendingGeoFence ? (
        <ZoneConfigForm mode="create" geofence={pendingGeoFence} onSave={handleSaveCreate} onCancel={handleCancelPanel} />
      ) : panelMode === 'edit' && editingZone ? (
        <ZoneConfigForm mode="edit" geofence={null} initialValues={editingZone} onSave={handleSaveEdit} onCancel={handleCancelPanel} />
      ) : showFeaturePanel ? (
        <ZoneFeaturePanel
          feature={clickedFeature!}
          onClose={() => setClickedFeature(null)}
          networks={networks}
          onUseCluster={handleUseCluster}
        />
      ) : (
        <div className="w-64 flex-shrink-0 bg-white border-l border-gray-200 flex flex-col">
          <div className="p-4 border-b border-gray-200">
            <h3 className="font-semibold text-gray-800 text-sm flex items-center gap-2">
              <Map className="w-4 h-4 text-[#0067ff]" /> Manual Zones ({zoneList.length})
            </h3>
            {meridianFeatures.length > 0 && (
              <p className="text-xs text-emerald-600 mt-1 font-medium">
                {meridianFeatures.length.toLocaleString()} MERIDIAN zones active (automatic)
              </p>
            )}
            <p className="text-xs text-gray-400 mt-1">
              Draw a polygon or circle on the map to add a manual zone. MERIDIAN zones are managed automatically.
            </p>
          </div>
          <div className="flex-1 overflow-y-auto divide-y divide-gray-100">
            {zoneList.length === 0 ? (
              <div className="p-6 text-center space-y-2">
                <Map className="w-8 h-8 text-gray-200 mx-auto" />
                <p className="text-gray-500 text-xs font-medium">No manual zones</p>
                <p className="text-gray-400 text-[11px]">MERIDIAN zones are active automatically on the map.</p>
                <p className="text-gray-400 text-[11px]">Draw a polygon or circle above to add a custom override zone.</p>
              </div>
            ) : zoneList.map((zone) => (
              <ZoneListItem
                key={zone.id} zone={zone} networkName={networks[zone.networkId]?.name ?? null}
                onEdit={() => handleEditZone(zone.id)} onToggle={() => handleToggleZone(zone.id)} onDelete={() => handleDeleteZone(zone.id)}
              />
            ))}
          </div>
          <MeridianPanel
            onShowOverlay={loadMeridianOverlay}
            overlayVisible={showMeridian}
            overlayLoading={loadingMeridian}
            zoneStats={meridianStats}
            hiddenZoneTypes={hiddenZoneTypes}
            setHiddenZoneTypes={setHiddenZoneTypes}
            hiddenConfidences={hiddenConfidences}
            setHiddenConfidences={setHiddenConfidences}
            clusterSearch={clusterSearch}
            setClusterSearch={setClusterSearch}
            minLiveScore={minLiveScore}
            setMinLiveScore={setMinLiveScore}
            totalFeatures={meridianFeatures.length}
            scoredFeatures={scoredFeatures}
            geodnetCount={geodnetStations.length}
            onocoyCount={onocoyStations.length}
            geodnetStations={geodnetStations}
            onocoyStations={onocoyStations}
            lastStatusCheck={lastStatusCheck}
            onRegenDone={reloadMeridianGeoJSON}
          />
        </div>
      )}
    </div>
  )
}

// Re-export ScoreBar for potential external use
export { ScoreBar }
