'use client'
import React, { useState } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  LayoutDashboard,
  Users,
  Globe,
  Map,
  Radio,
  Settings,
  FileText,
  ShieldCheck,
  Rocket,
  ChevronLeft,
  ChevronRight,
  Wifi,
  Layers,
  KeyRound,
  FlaskConical,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useConfigStore } from '@/store/config-store'
import { useShallow } from 'zustand/react/shallow'

const NAV_ITEMS = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/users', label: 'Users & Groups', icon: Users },
  { href: '/networks', label: 'Networks', icon: Wifi },
  { href: '/network-mountpoints', label: 'Network Mountpoints', icon: Layers },
  { href: '/mountpoints', label: 'RTKdata Mountpoints', icon: Globe },
  { href: '/zones', label: 'MERIDIAN Zones', icon: Map },
  { href: '/streams', label: 'Streams', icon: Radio },
  { href: '/accounts', label: 'Accounts', icon: KeyRound },
  { href: '/quality-scans', label: 'Quality Scans', icon: FlaskConical },
  { href: '/settings', label: 'Settings', icon: Settings },
  { href: '/config', label: 'Config Preview', icon: FileText },
  { href: '/validation', label: 'Validation', icon: ShieldCheck },
  { href: '/deploy', label: 'Deploy', icon: Rocket },
] as const

export default function Sidebar() {
  const [collapsed, setCollapsed] = useState(false)
  const pathname = usePathname()
  const stats = useConfigStore(
    useShallow((s) => ({
      userCount: Object.keys(s.users).length,
      networkCount: Object.keys(s.networks).length,
      mountpointCount: Object.keys(s.mountpoints).length,
      zoneCount: Object.values(s.zones).filter((z) => z.enabled).length,
      hasErrors: s.validationResults.some((r) => r.severity === 'error'),
    })),
  )

  return (
    <aside
      className={cn(
        'relative flex flex-col bg-[#f4f4f4] border-r border-gray-200',
        'transition-all duration-300 ease-in-out',
        collapsed ? 'w-16' : 'w-56',
      )}
    >
      {/* Logo */}
      <div className={cn(
        'flex items-center border-b border-gray-200',
        collapsed ? 'justify-center px-2 py-4' : 'px-4 py-4',
      )}>
        {collapsed ? (
          <div className="w-8 h-8 relative flex-shrink-0">
            <Image src="/logo.png" alt="RTKdata" fill style={{ objectFit: 'contain' }} />
          </div>
        ) : (
          <div className="relative h-8 w-36">
            <Image src="/logo.png" alt="RTKdata" fill style={{ objectFit: 'contain', objectPosition: 'left' }} priority />
          </div>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-2 py-3 space-y-0.5 overflow-y-auto">
        {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
          const isActive = pathname === href
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                'flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium',
                'transition-all duration-150',
                isActive
                  ? 'bg-[#0067ff] text-white shadow-sm'
                  : 'text-gray-600 hover:bg-white hover:text-gray-900 hover:shadow-sm',
              )}
              title={collapsed ? label : undefined}
            >
              <Icon className={cn('flex-shrink-0', collapsed ? 'w-5 h-5' : 'w-4 h-4')} />
              {!collapsed && <span className="truncate">{label}</span>}
              {href === '/validation' && stats.hasErrors && !collapsed && (
                <span className="ml-auto w-2 h-2 rounded-full bg-red-500 flex-shrink-0" />
              )}
            </Link>
          )
        })}
      </nav>

      {/* Stats footer */}
      {!collapsed && (
        <div className="px-4 py-3 border-t border-gray-200 space-y-1">
          <div className="flex justify-between text-xs text-gray-400">
            <span>Users</span>
            <span className="font-mono text-gray-600">{stats.userCount}</span>
          </div>
          <div className="flex justify-between text-xs text-gray-400">
            <span>Networks</span>
            <span className="font-mono text-gray-600">{stats.networkCount}</span>
          </div>
          <div className="flex justify-between text-xs text-gray-400">
            <span>Mountpoints</span>
            <span className="font-mono text-gray-600">{stats.mountpointCount}</span>
          </div>
          <div className="flex justify-between text-xs text-gray-400">
            <span>Zones</span>
            <span className="font-mono text-gray-600">{stats.zoneCount}</span>
          </div>
        </div>
      )}

      {/* Collapse toggle */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        className={cn(
          'absolute -right-3 top-1/2 -translate-y-1/2 z-10',
          'w-6 h-6 rounded-full bg-white border border-gray-300',
          'flex items-center justify-center text-gray-500',
          'hover:bg-gray-50 hover:text-gray-700',
          'transition-colors shadow-sm',
        )}
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      >
        {collapsed ? <ChevronRight className="w-3 h-3" /> : <ChevronLeft className="w-3 h-3" />}
      </button>
    </aside>
  )
}
