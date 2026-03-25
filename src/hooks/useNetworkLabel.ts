'use client'
import { useConfigStore, selectShowBackendDetails } from '@/store/config-store'
import { useShallow } from 'zustand/react/shallow'

/**
 * Returns a display-safe network label.
 * When backend details are hidden (eye off), replaces real network names
 * with "Network 1", "Network 2", etc. — ordered by insertion order.
 *
 * Usage:
 *   const label = useNetworkLabel(network.id)          // by ID
 *   const label = useNetworkLabel(undefined, 'GEODNET') // by name string
 */
export function useNetworkLabel(networkId?: string, fallbackName?: string): string {
  const show = useConfigStore(selectShowBackendDetails)
  const networks = useConfigStore(useShallow((s) => s.networks))

  if (show) {
    // Show real name
    if (networkId && networks[networkId]) return networks[networkId].name
    return fallbackName ?? networkId ?? ''
  }

  // Anonymize: find position in ordered network list
  const ids = Object.keys(networks)
  const idx = networkId ? ids.indexOf(networkId) : -1

  if (idx >= 0) return `Network ${idx + 1}`

  // Fallback: if we only have a name string, match by name
  if (fallbackName) {
    const byName = Object.values(networks).findIndex(
      (n) => n.name.toLowerCase() === fallbackName.toLowerCase()
    )
    if (byName >= 0) return `Network ${byName + 1}`
  }

  return fallbackName ? 'Network' : ''
}

/**
 * Returns a map of networkId → anonymized label for bulk use.
 * Useful in tables/lists where you need to label many networks at once.
 */
export function useNetworkLabels(): Record<string, string> {
  const show = useConfigStore(selectShowBackendDetails)
  const networks = useConfigStore(useShallow((s) => s.networks))

  const entries = Object.entries(networks)
  return Object.fromEntries(
    entries.map(([id, net], i) => [id, show ? net.name : `Network ${i + 1}`])
  )
}
