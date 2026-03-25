'use client'
// DataProvider — fetches all data from API on mount and hydrates the Zustand store.
// Auto-imports MERIDIAN zones when zones are empty and MERIDIAN is configured.
import { useEffect } from 'react'
import { useConfigStore } from '@/store/config-store'
import {
  networkFromJSON,
  networkMountpointFromJSON,
  mountpointFromJSON,
  userFromJSON,
  groupFromJSON,
  zoneFromJSON,
  streamFromJSON,
  settingsFromJSON,
  accountFromJSON,
  aliasFromJSON,
} from '@/lib/utils'

// ── MERIDIAN auto-import ──────────────────────────────────────────────────────
// Runs in background after initial load. Shows a toast-style notification.

async function triggerMeridianAutoImport(
  zonesRecord: Record<string, unknown>,
  setZones: (zones: Record<string, ReturnType<typeof zoneFromJSON>>) => void,
): Promise<void> {
  // Only import when zones store is empty
  if (Object.keys(zonesRecord).length > 0) return

  try {
    // Check if MERIDIAN is configured + enabled
    const meridianCheck = await fetch('/api/meridian/status').then((r) => r.json()).catch(() => null)
    if (!meridianCheck || !meridianCheck.enabled) return

    // Trigger import
    const res = await fetch('/api/meridian/import-zones', { method: 'POST' })
    if (!res.ok) return
    const result = await res.json() as { imported?: number; skipped?: number; networks_missing?: string[] }

    if (!result.imported || result.imported === 0) return

    // Re-fetch zones and update store
    const freshZonesRaw = await fetch('/api/data/zones').then((r) => r.json()).catch(() => ({}))
    const freshZones: Record<string, ReturnType<typeof zoneFromJSON>> = {}
    for (const [k, v] of Object.entries(freshZonesRaw as Record<string, unknown>)) {
      freshZones[k] = zoneFromJSON(v as Parameters<typeof zoneFromJSON>[0])
    }
    setZones(freshZones)

    // Emit a simple browser notification (non-blocking)
    if (typeof window !== 'undefined') {
      const msg = `MERIDIAN-Zonen automatisch importiert: ${result.imported} Zonen`
      console.info('[MERIDIAN auto-import]', msg)
      // Show a transient DOM toast if there is no toast system available
      const toast = document.createElement('div')
      toast.textContent = msg
      toast.style.cssText = [
        'position:fixed',
        'bottom:24px',
        'right:24px',
        'z-index:99999',
        'background:#1e293b',
        'color:#e2e8f0',
        'font-size:13px',
        'font-family:inherit',
        'padding:10px 16px',
        'border-radius:8px',
        'border:1px solid #334155',
        'box-shadow:0 4px 24px rgba(0,0,0,0.4)',
        'max-width:320px',
        'pointer-events:none',
      ].join(';')
      document.body.appendChild(toast)
      setTimeout(() => toast.remove(), 5000)
    }
  } catch {
    // Auto-import is best-effort — never block the UI
  }
}

export default function DataProvider({ children }: { children: React.ReactNode }) {
  const hydrate = useConfigStore((s) => s.hydrate)
  const setLoading = useConfigStore((s) => s.setLoading)
  const setZones = useConfigStore((s) => s.setZones)

  useEffect(() => {
    async function loadAll() {
      setLoading(true)
      try {
        const [networksRes, nmRes, mountpointsRes, usersRes, groupsRes, zonesRes, streamsRes, settingsRes, accountsRes, aliasesRes] =
          await Promise.allSettled([
            fetch('/api/data/networks').then((r) => r.json()),
            fetch('/api/data/network_mountpoints').then((r) => r.json()),
            fetch('/api/data/mountpoints').then((r) => r.json()),
            fetch('/api/data/users').then((r) => r.json()),
            fetch('/api/data/groups').then((r) => r.json()),
            fetch('/api/data/zones').then((r) => r.json()),
            fetch('/api/data/streams').then((r) => r.json()),
            fetch('/api/data/settings').then((r) => r.json()),
            fetch('/api/data/accounts').then((r) => r.json()),
            fetch('/api/data/aliases').then((r) => r.json()),
          ])

        const networks: Record<string, ReturnType<typeof networkFromJSON>> = {}
        if (networksRes.status === 'fulfilled') {
          for (const [k, v] of Object.entries(networksRes.value as Record<string, unknown>)) {
            networks[k] = networkFromJSON(v as Parameters<typeof networkFromJSON>[0])
          }
        }

        const networkMountpoints: Record<string, ReturnType<typeof networkMountpointFromJSON>> = {}
        if (nmRes.status === 'fulfilled') {
          for (const [k, v] of Object.entries(nmRes.value as Record<string, unknown>)) {
            networkMountpoints[k] = networkMountpointFromJSON(v as Parameters<typeof networkMountpointFromJSON>[0])
          }
        }

        const mountpoints: Record<string, ReturnType<typeof mountpointFromJSON>> = {}
        if (mountpointsRes.status === 'fulfilled') {
          for (const [k, v] of Object.entries(mountpointsRes.value as Record<string, unknown>)) {
            mountpoints[k] = mountpointFromJSON(v as Parameters<typeof mountpointFromJSON>[0])
          }
        }

        const users: Record<string, ReturnType<typeof userFromJSON>> = {}
        if (usersRes.status === 'fulfilled') {
          for (const [k, v] of Object.entries(usersRes.value as Record<string, unknown>)) {
            users[k] = userFromJSON(v as Parameters<typeof userFromJSON>[0])
          }
        }

        const groups: Record<string, ReturnType<typeof groupFromJSON>> = {}
        if (groupsRes.status === 'fulfilled') {
          for (const [k, v] of Object.entries(groupsRes.value as Record<string, unknown>)) {
            groups[k] = groupFromJSON(v as Parameters<typeof groupFromJSON>[0])
          }
        }

        const zones: Record<string, ReturnType<typeof zoneFromJSON>> = {}
        if (zonesRes.status === 'fulfilled') {
          for (const [k, v] of Object.entries(zonesRes.value as Record<string, unknown>)) {
            zones[k] = zoneFromJSON(v as Parameters<typeof zoneFromJSON>[0])
          }
        }

        const streams: Record<string, ReturnType<typeof streamFromJSON>> = {}
        if (streamsRes.status === 'fulfilled') {
          const data = streamsRes.value as Record<string, unknown>
          for (const [k, v] of Object.entries(data)) {
            streams[k] = streamFromJSON(v as Parameters<typeof streamFromJSON>[0])
          }
        }

        const settings =
          settingsRes.status === 'fulfilled'
            ? settingsFromJSON(settingsRes.value as Parameters<typeof settingsFromJSON>[0])
            : undefined

        const accounts: Record<string, ReturnType<typeof accountFromJSON>> = {}
        if (accountsRes.status === 'fulfilled') {
          for (const [k, v] of Object.entries(accountsRes.value as Record<string, unknown>)) {
            accounts[k] = accountFromJSON(v as Parameters<typeof accountFromJSON>[0])
          }
        }

        const aliases: Record<string, ReturnType<typeof aliasFromJSON>> = {}
        if (aliasesRes.status === 'fulfilled') {
          for (const [k, v] of Object.entries(aliasesRes.value as Record<string, unknown>)) {
            aliases[k] = aliasFromJSON(v as Parameters<typeof aliasFromJSON>[0])
          }
        }

        hydrate({ networks, networkMountpoints, mountpoints, users, groups, zones, streams, accounts, aliases, settings })

        // Background: auto-import MERIDIAN zones if zones store is empty
        const rawZones = zonesRes.status === 'fulfilled' ? (zonesRes.value as Record<string, unknown>) : {}
        triggerMeridianAutoImport(rawZones, setZones)
      } finally {
        setLoading(false)
      }
    }

    loadAll()
  }, [hydrate, setLoading, setZones])

  return <>{children}</>
}
