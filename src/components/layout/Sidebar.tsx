'use client'
import React, { useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  LayoutDashboard, Users, Globe, Map, Radio, Settings, FileText,
  ShieldCheck, Rocket, ChevronLeft, ChevronRight, Wifi, Layers,
  KeyRound, FlaskConical, Shield, Zap, Activity, CloudLightning,
  MapPin, Eye,
} from 'lucide-react'
import { clsx } from 'clsx'

const INTEGRITY_ITEMS = [
  { href: '/dashboard', label: 'Integrity Overview', icon: LayoutDashboard, exact: true },
  { href: '/dashboard/trust', label: 'Station Trust', icon: Shield },
  { href: '/dashboard/interference', label: 'Interference', icon: Zap },
  { href: '/dashboard/config', label: 'Quality Gates', icon: ShieldCheck },
] as const

const WIZARD_ITEMS = [
  { href: '/dashboard/wizard', label: 'Wizard Home', icon: Settings, exact: true },
  { href: '/dashboard/wizard/zones', label: 'MERIDIAN Zones', icon: Map },
  { href: '/dashboard/wizard/networks', label: 'Networks', icon: Wifi },
  { href: '/dashboard/wizard/network-mountpoints', label: 'Network Mounts', icon: Layers },
  { href: '/dashboard/wizard/mountpoints', label: 'RTKdata Mounts', icon: Globe },
  { href: '/dashboard/wizard/users', label: 'Users & Groups', icon: Users },
  { href: '/dashboard/wizard/accounts', label: 'Accounts', icon: KeyRound },
  { href: '/dashboard/wizard/streams', label: 'Streams', icon: Radio },
  { href: '/dashboard/wizard/settings', label: 'Settings', icon: Settings },
  { href: '/dashboard/wizard/quality-scans', label: 'Quality Scans', icon: FlaskConical },
  { href: '/dashboard/wizard/config-preview', label: 'Config Preview', icon: FileText },
  { href: '/dashboard/wizard/validation', label: 'Validation', icon: ShieldCheck },
  { href: '/dashboard/wizard/deploy', label: 'Deploy', icon: Rocket },
] as const

export default function Sidebar() {
  const [collapsed, setCollapsed] = useState(false)
  const pathname = usePathname()

  const isActive = (href: string, exact?: boolean) => {
    if (exact) return pathname === href
    return pathname === href || pathname.startsWith(href + '/')
  }

  const renderSection = (title: string, items: readonly { href: string; label: string; icon: any; exact?: boolean }[]) => (
    <>
      {!collapsed && (
        <div className="px-3 pt-4 pb-1">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">{title}</span>
        </div>
      )}
      {collapsed && <div className="border-t border-gray-200 my-2" />}
      {items.map(({ href, label, icon: Icon, exact }) => {
        const active = isActive(href, exact)
        return (
          <Link
            key={href}
            href={href}
            className={clsx(
              'flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium',
              'transition-all duration-150',
              active
                ? 'bg-[#0067ff] text-white shadow-sm'
                : 'text-gray-600 hover:bg-white hover:text-gray-900 hover:shadow-sm',
            )}
            title={collapsed ? label : undefined}
          >
            <Icon className={clsx('flex-shrink-0', collapsed ? 'w-5 h-5' : 'w-4 h-4')} />
            {!collapsed && <span className="truncate">{label}</span>}
          </Link>
        )
      })}
    </>
  )

  return (
    <aside
      className={clsx(
        'relative flex flex-col bg-[#f4f4f4] border-r border-gray-200 h-screen sticky top-0',
        'transition-all duration-300 ease-in-out',
        collapsed ? 'w-16' : 'w-56',
      )}
    >
      {/* Logo */}
      <div className={clsx(
        'flex items-center border-b border-gray-200',
        collapsed ? 'justify-center px-2 py-4' : 'px-4 py-4',
      )}>
        {collapsed ? (
          <div className="w-8 h-8 rounded-full bg-[#0067ff] flex items-center justify-center text-white font-bold text-sm">R</div>
        ) : (
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-full bg-[#0067ff] flex items-center justify-center text-white font-bold text-xs">R</div>
            <div>
              <div className="text-sm font-semibold text-gray-900">RTKdata</div>
              <div className="text-[10px] text-gray-400">Integrity Engine</div>
            </div>
          </div>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-2 py-1 space-y-0.5 overflow-y-auto">
        {renderSection('Integrity Monitor', INTEGRITY_ITEMS)}
        {renderSection('GNSS Wizard', WIZARD_ITEMS)}
      </nav>

      {/* Collapse toggle */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        className={clsx(
          'absolute -right-3 top-1/2 -translate-y-1/2 z-10',
          'w-6 h-6 rounded-full bg-white border border-gray-300',
          'flex items-center justify-center text-gray-500',
          'hover:bg-gray-50 hover:text-gray-700',
          'transition-colors shadow-sm',
        )}
      >
        {collapsed ? <ChevronRight className="w-3 h-3" /> : <ChevronLeft className="w-3 h-3" />}
      </button>
    </aside>
  )
}
