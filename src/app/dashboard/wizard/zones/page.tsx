'use client'
// Zones page — full-width Leaflet map with zone management
// Leaflet is dynamically imported (no SSR) per DEVELOPMENT.md gotcha #1
import dynamic from 'next/dynamic'
import Header from '@/components/layout/Header'
import { Map as MapIcon } from 'lucide-react'

// Dynamic import: SSR disabled for Leaflet
const ZoneMap = dynamic(() => import('@/components/zones/ZoneMap'), {
  ssr: false,
  loading: () => (
    <div className="flex-1 flex items-center justify-center bg-white">
      <div className="text-center">
        <MapIcon className="w-12 h-12 text-slate-600 mb-3 mx-auto animate-pulse" />
        <p className="text-slate-500">Loading map…</p>
      </div>
    </div>
  ),
})

export default function ZonesPage() {
  return (
    <div className="flex flex-col h-full">
      <Header />
      <div className="flex-1 flex overflow-hidden">
        <ZoneMap />
      </div>
    </div>
  )
}
