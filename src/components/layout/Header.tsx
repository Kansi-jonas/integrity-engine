'use client'
import React from 'react'
import { usePathname } from 'next/navigation'
import { RefreshCw, CheckCircle2, Clock, Eye, EyeOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useConfigStore, selectIsDirty, selectShowBackendDetails } from '@/store/config-store'
import { cn } from '@/lib/utils'

const PAGE_TITLES: Record<string, { title: string; description: string }> = {
  '/dashboard': { title: 'Integrity Overview', description: 'Signal integrity monitoring and anomaly detection' },
  '/dashboard/trust': { title: 'Station Trust', description: 'Bayesian trust scoring with Beta distributions' },
  '/dashboard/interference': { title: 'Interference Detection', description: 'SHIELD agent — jamming, spoofing, ionospheric classification' },
  '/dashboard/config': { title: 'Quality Gates', description: 'Qualified stations and caster configuration' },
  '/dashboard/wizard': { title: 'GNSS Wizard', description: 'Zone management, networks, and caster deployment' },
  '/dashboard/wizard/users': { title: 'Users & Groups', description: 'Manage NTRIP caster users and access groups' },
  '/dashboard/wizard/networks': { title: 'Networks', description: 'Upstream NTRIP network endpoints (GEODNET, Onocoy, ...)' },
  '/dashboard/wizard/network-mountpoints': { title: 'Network Mountpoints', description: 'Available mountpoints at each network' },
  '/dashboard/wizard/mountpoints': { title: 'RTKdata Mountpoints', description: 'Customer-facing mountpoints with backend cascade' },
  '/dashboard/wizard/zones': { title: 'MERIDIAN Zones', description: 'Geographic coverage zones with interactive map' },
  '/dashboard/wizard/streams': { title: 'Streams', description: 'Advanced stream configuration' },
  '/dashboard/wizard/accounts': { title: 'Accounts', description: 'Upstream credential mapping for networks' },
  '/dashboard/wizard/settings': { title: 'Settings', description: 'Caster-wide configuration options' },
  '/dashboard/wizard/quality-scans': { title: 'Quality Scans', description: 'NTRIP quality testing and scheduling' },
  '/dashboard/wizard/config-preview': { title: 'Config Preview', description: 'Generated ntrips.cfg output' },
  '/dashboard/wizard/validation': { title: 'Validation', description: 'Configuration check results' },
  '/dashboard/wizard/deploy': { title: 'Deploy', description: 'Upload and activate configuration on the caster' },
}

interface HeaderProps {
  onSave?: () => Promise<void>
  isSaving?: boolean
}

export default function Header({ onSave, isSaving }: HeaderProps) {
  const pathname = usePathname()
  const isDirty = useConfigStore(selectIsDirty)
  const lastSaved = useConfigStore((s) => s.lastSaved)
  const showBackendDetails = useConfigStore(selectShowBackendDetails)
  const toggleBackendDetails = useConfigStore((s) => s.toggleBackendDetails)

  const pageInfo = PAGE_TITLES[pathname] ?? { title: 'GNSS Wizard', description: '' }

  return (
    <header className="flex items-center justify-between px-6 py-3 border-b border-gray-200 bg-white">
      <div>
        <h1 className="text-base font-semibold text-gray-900">{pageInfo.title}</h1>
        <p className="text-xs text-gray-400 mt-0.5">{pageInfo.description}</p>
      </div>

      <div className="flex items-center gap-3">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              onClick={toggleBackendDetails}
              className="h-8 w-8"
            >
              {showBackendDetails ? (
                <Eye className="w-4 h-4 text-gray-500" />
              ) : (
                <EyeOff className="w-4 h-4 text-amber-500" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent className="text-xs">
            {showBackendDetails ? 'Hide network names & credentials' : 'Show network names & credentials'}
          </TooltipContent>
        </Tooltip>

        {isDirty ? (
          <Badge variant="warning" className="gap-1.5">
            <Clock className="w-3 h-3" />
            Unsaved changes
          </Badge>
        ) : lastSaved ? (
          <Badge variant="default" className="gap-1.5">
            <CheckCircle2 className="w-3 h-3" />
            Saved
          </Badge>
        ) : null}

        {onSave && (
          <Button
            size="sm"
            variant={isDirty ? 'default' : 'outline'}
            onClick={onSave}
            disabled={isSaving || !isDirty}
            className="gap-1.5"
          >
            <RefreshCw className={cn('w-3.5 h-3.5', isSaving && 'animate-spin')} />
            {isSaving ? 'Saving…' : 'Save'}
          </Button>
        )}
      </div>
    </header>
  )
}
