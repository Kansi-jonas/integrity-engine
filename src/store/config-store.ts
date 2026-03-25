// src/store/config-store.ts
// Zustand global state — selectors prevent unnecessary re-renders
// 3-Tier Architecture: Networks → NetworkMountpoints → Mountpoints
import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import type {
  Network,
  NetworkMountpoint,
  Mountpoint,
  User,
  Group,
  Zone,
  Stream,
  Account,
  Alias,
  CasterSettings,
  ValidationResult,
} from '@/lib/types'
import { DEFAULT_SETTINGS } from '@/lib/types'
import { generateConfig, validateConfig } from '@/lib/config-engine'

// ── State shape ────────────────────────────────────────────────────────────

interface ConfigState {
  // Data
  networks: Record<string, Network>
  networkMountpoints: Record<string, NetworkMountpoint>
  mountpoints: Record<string, Mountpoint>
  users: Record<string, User>
  groups: Record<string, Group>
  zones: Record<string, Zone>
  streams: Record<string, Stream>
  accounts: Record<string, Account>
  aliases: Record<string, Alias>
  settings: CasterSettings

  // Derived / UI state
  showBackendDetails: boolean
  isLoading: boolean
  isDirty: boolean
  lastSaved: Date | null
  lastGenerated: Date | null
  lastDeployed: Date | null
  generatedConfig: string | null
  validationResults: ValidationResult[]

  // Actions — networks (Tier 1)
  setNetworks: (networks: Record<string, Network>) => void
  addNetwork: (network: Network) => void
  updateNetwork: (id: string, network: Partial<Network>) => void
  deleteNetwork: (id: string) => void

  // Actions — network mountpoints (Tier 2)
  setNetworkMountpoints: (networkMountpoints: Record<string, NetworkMountpoint>) => void
  addNetworkMountpoint: (nm: NetworkMountpoint) => void
  updateNetworkMountpoint: (id: string, nm: Partial<NetworkMountpoint>) => void
  deleteNetworkMountpoint: (id: string) => void

  // Actions — mountpoints (Tier 3)
  setMountpoints: (mountpoints: Record<string, Mountpoint>) => void
  addMountpoint: (mountpoint: Mountpoint) => void
  updateMountpoint: (id: string, mountpoint: Partial<Mountpoint>) => void
  deleteMountpoint: (id: string) => void

  // Actions — users
  setUsers: (users: Record<string, User>) => void
  addUser: (user: User) => void
  updateUser: (name: string, user: Partial<User>) => void
  deleteUser: (name: string) => void

  // Actions — groups
  setGroups: (groups: Record<string, Group>) => void
  addGroup: (group: Group) => void
  updateGroup: (name: string, group: Partial<Group>) => void
  deleteGroup: (name: string) => void

  // Actions — zones
  setZones: (zones: Record<string, Zone>) => void
  addZone: (zone: Zone) => void
  updateZone: (id: string, zone: Partial<Zone>) => void
  deleteZone: (id: string) => void
  toggleZone: (id: string) => void

  // Actions — streams
  setStreams: (streams: Record<string, Stream>) => void
  addStream: (stream: Stream) => void
  updateStream: (id: string, stream: Partial<Stream>) => void
  deleteStream: (id: string) => void

  // Actions — accounts
  setAccounts: (accounts: Record<string, Account>) => void
  addAccount: (account: Account) => void
  updateAccount: (id: string, account: Partial<Account>) => void
  deleteAccount: (id: string) => void

  // Actions — aliases
  setAliases: (aliases: Record<string, Alias>) => void
  addAlias: (alias: Alias) => void
  updateAlias: (id: string, alias: Partial<Alias>) => void
  deleteAlias: (id: string) => void

  // Actions — settings
  updateSettings: (settings: Partial<CasterSettings>) => void
  resetSettings: () => void

  // Actions — UI
  toggleBackendDetails: () => void

  // Actions — config
  generateConfigNow: () => string
  runValidation: () => ValidationResult[]
  setLastDeployed: (date: Date) => void

  // Actions — save tracking
  markClean: () => void

  // Actions — hydration
  hydrate: (data: {
    networks?: Record<string, Network>
    networkMountpoints?: Record<string, NetworkMountpoint>
    mountpoints?: Record<string, Mountpoint>
    users?: Record<string, User>
    groups?: Record<string, Group>
    zones?: Record<string, Zone>
    streams?: Record<string, Stream>
    accounts?: Record<string, Account>
    aliases?: Record<string, Alias>
    settings?: CasterSettings
  }) => void
  setLoading: (loading: boolean) => void
}

// ── Store implementation ───────────────────────────────────────────────────

export const useConfigStore = create<ConfigState>()(
  subscribeWithSelector((set, get) => ({
    // Initial state
    networks: {},
    networkMountpoints: {},
    mountpoints: {},
    users: {},
    groups: {},
    zones: {},
    streams: {},
    accounts: {},
    aliases: {},
    settings: { ...DEFAULT_SETTINGS },

    showBackendDetails: true,
    isLoading: false,
    isDirty: false,
    lastSaved: null,
    lastGenerated: null,
    lastDeployed: null,
    generatedConfig: null,
    validationResults: [],

    // ── Network actions (Tier 1) ──────────────────────────────────────────

    setNetworks: (networks) => set({ networks, isDirty: true }),

    addNetwork: (network) =>
      set((state) => ({
        networks: { ...state.networks, [network.id]: network },
        isDirty: true,
      })),

    updateNetwork: (id, partial) =>
      set((state) => {
        if (!state.networks[id]) return state
        return {
          networks: { ...state.networks, [id]: { ...state.networks[id], ...partial } },
          isDirty: true,
        }
      }),

    deleteNetwork: (id) =>
      set((state) => {
        const { [id]: _, ...rest } = state.networks
        // Cascade: remove NetworkMountpoints referencing this network
        const nms: Record<string, NetworkMountpoint> = {}
        for (const [k, nm] of Object.entries(state.networkMountpoints)) {
          if (nm.networkId !== id) nms[k] = nm
        }
        return { networks: rest, networkMountpoints: nms, isDirty: true }
      }),

    // ── Network Mountpoint actions (Tier 2) ───────────────────────────────

    setNetworkMountpoints: (networkMountpoints) => set({ networkMountpoints, isDirty: true }),

    addNetworkMountpoint: (nm) =>
      set((state) => ({
        networkMountpoints: { ...state.networkMountpoints, [nm.id]: nm },
        isDirty: true,
      })),

    updateNetworkMountpoint: (id, partial) =>
      set((state) => {
        if (!state.networkMountpoints[id]) return state
        return {
          networkMountpoints: { ...state.networkMountpoints, [id]: { ...state.networkMountpoints[id], ...partial } },
          isDirty: true,
        }
      }),

    deleteNetworkMountpoint: (id) =>
      set((state) => {
        const { [id]: _, ...rest } = state.networkMountpoints
        // Cascade: remove backend refs from Mountpoints referencing this NM
        const mps: Record<string, Mountpoint> = {}
        for (const [k, mp] of Object.entries(state.mountpoints)) {
          mps[k] = { ...mp, backends: mp.backends.filter((b) => b.networkMountpointId !== id) }
        }
        return { networkMountpoints: rest, mountpoints: mps, isDirty: true }
      }),

    // ── Mountpoint actions (Tier 3) ───────────────────────────────────────

    setMountpoints: (mountpoints) => set({ mountpoints, isDirty: true }),

    addMountpoint: (mountpoint) =>
      set((state) => ({
        mountpoints: { ...state.mountpoints, [mountpoint.id]: mountpoint },
        isDirty: true,
      })),

    updateMountpoint: (id, partial) =>
      set((state) => {
        if (!state.mountpoints[id]) return state
        return {
          mountpoints: { ...state.mountpoints, [id]: { ...state.mountpoints[id], ...partial } },
          isDirty: true,
        }
      }),

    deleteMountpoint: (id) =>
      set((state) => {
        const { [id]: _, ...rest } = state.mountpoints
        return { mountpoints: rest, isDirty: true }
      }),

    // ── User actions ────────────────────────────────────────────────────────

    setUsers: (users) => set({ users, isDirty: true }),

    addUser: (user) =>
      set((state) => ({
        users: { ...state.users, [user.name]: user },
        isDirty: true,
      })),

    updateUser: (name, partial) =>
      set((state) => {
        if (!state.users[name]) return state
        return {
          users: { ...state.users, [name]: { ...state.users[name], ...partial } },
          isDirty: true,
        }
      }),

    deleteUser: (name) =>
      set((state) => {
        const { [name]: _, ...rest } = state.users
        return { users: rest, isDirty: true }
      }),

    // ── Group actions ───────────────────────────────────────────────────────

    setGroups: (groups) => set({ groups, isDirty: true }),

    addGroup: (group) =>
      set((state) => ({
        groups: { ...state.groups, [group.name]: group },
        isDirty: true,
      })),

    updateGroup: (name, partial) =>
      set((state) => {
        if (!state.groups[name]) return state
        return {
          groups: { ...state.groups, [name]: { ...state.groups[name], ...partial } },
          isDirty: true,
        }
      }),

    deleteGroup: (name) =>
      set((state) => {
        const { [name]: _, ...rest } = state.groups
        return { groups: rest, isDirty: true }
      }),

    // ── Zone actions ────────────────────────────────────────────────────────

    setZones: (zones) => set({ zones, isDirty: true }),

    addZone: (zone) =>
      set((state) => ({
        zones: { ...state.zones, [zone.id]: zone },
        isDirty: true,
      })),

    updateZone: (id, partial) =>
      set((state) => {
        if (!state.zones[id]) return state
        return {
          zones: { ...state.zones, [id]: { ...state.zones[id], ...partial } },
          isDirty: true,
        }
      }),

    deleteZone: (id) =>
      set((state) => {
        const { [id]: _, ...rest } = state.zones
        return { zones: rest, isDirty: true }
      }),

    toggleZone: (id) =>
      set((state) => {
        if (!state.zones[id]) return state
        return {
          zones: { ...state.zones, [id]: { ...state.zones[id], enabled: !state.zones[id].enabled } },
          isDirty: true,
        }
      }),

    // ── Stream actions ──────────────────────────────────────────────────────

    setStreams: (streams) => set({ streams, isDirty: true }),

    addStream: (stream) =>
      set((state) => ({
        streams: { ...state.streams, [stream.id]: stream },
        isDirty: true,
      })),

    updateStream: (id, partial) =>
      set((state) => {
        if (!state.streams[id]) return state
        return {
          streams: { ...state.streams, [id]: { ...state.streams[id], ...partial } },
          isDirty: true,
        }
      }),

    deleteStream: (id) =>
      set((state) => {
        const { [id]: _, ...rest } = state.streams
        return { streams: rest, isDirty: true }
      }),

    // ── Account actions ─────────────────────────────────────────────────────

    setAccounts: (accounts) => set({ accounts, isDirty: true }),

    addAccount: (account) =>
      set((state) => ({
        accounts: { ...state.accounts, [account.id]: account },
        isDirty: true,
      })),

    updateAccount: (id, partial) =>
      set((state) => {
        if (!state.accounts[id]) return state
        return {
          accounts: { ...state.accounts, [id]: { ...state.accounts[id], ...partial } },
          isDirty: true,
        }
      }),

    deleteAccount: (id) =>
      set((state) => {
        const { [id]: _, ...rest } = state.accounts
        return { accounts: rest, isDirty: true }
      }),

    // ── Alias actions ───────────────────────────────────────────────────────

    setAliases: (aliases) => set({ aliases, isDirty: true }),

    addAlias: (alias) =>
      set((state) => ({
        aliases: { ...state.aliases, [alias.id]: alias },
        isDirty: true,
      })),

    updateAlias: (id, partial) =>
      set((state) => {
        if (!state.aliases[id]) return state
        return {
          aliases: { ...state.aliases, [id]: { ...state.aliases[id], ...partial } },
          isDirty: true,
        }
      }),

    deleteAlias: (id) =>
      set((state) => {
        const { [id]: _, ...rest } = state.aliases
        return { aliases: rest, isDirty: true }
      }),

    // ── Settings actions ────────────────────────────────────────────────────

    updateSettings: (partial) =>
      set((state) => ({
        settings: { ...state.settings, ...partial },
        isDirty: true,
      })),

    resetSettings: () => set({ settings: { ...DEFAULT_SETTINGS }, isDirty: true }),

    // ── UI actions ────────────────────────────────────────────────────────
    toggleBackendDetails: () => set((state) => ({ showBackendDetails: !state.showBackendDetails })),

    // ── Config generation ───────────────────────────────────────────────────

    generateConfigNow: () => {
      const state = get()
      const config = generateConfig({
        networks: state.networks,
        networkMountpoints: state.networkMountpoints,
        mountpoints: state.mountpoints,
        users: state.users,
        groups: state.groups,
        zones: state.zones,
        streams: state.streams,
        accounts: state.accounts,
        aliases: state.aliases,
        settings: state.settings,
      })
      set({ generatedConfig: config, lastGenerated: new Date() })
      return config
    },

    runValidation: () => {
      const state = get()
      const results = validateConfig({
        networks: state.networks,
        networkMountpoints: state.networkMountpoints,
        mountpoints: state.mountpoints,
        users: state.users,
        groups: state.groups,
        zones: state.zones,
        streams: state.streams,
        accounts: state.accounts,
        aliases: state.aliases,
        settings: state.settings,
      })
      set({ validationResults: results })
      return results
    },

    markClean: () => set({ isDirty: false, lastSaved: new Date() }),

    setLastDeployed: (date) => set({ lastDeployed: date }),

    // ── Hydration ───────────────────────────────────────────────────────────

    hydrate: (data) =>
      set((state) => ({
        networks: data.networks ?? state.networks,
        networkMountpoints: data.networkMountpoints ?? state.networkMountpoints,
        mountpoints: data.mountpoints ?? state.mountpoints,
        users: data.users ?? state.users,
        groups: data.groups ?? state.groups,
        zones: data.zones ?? state.zones,
        streams: data.streams ?? state.streams,
        accounts: data.accounts ?? state.accounts,
        aliases: data.aliases ?? state.aliases,
        settings: data.settings ?? state.settings,
        isDirty: false,
      })),

    setLoading: (isLoading) => set({ isLoading }),
  })),
)

// ── Selectors ──────────────────────────────────────────────────────────────
// Use these instead of accessing state directly to prevent over-rendering

export const selectNetworks = (s: ConfigState) => s.networks
export const selectNetworkMountpoints = (s: ConfigState) => s.networkMountpoints
export const selectMountpoints = (s: ConfigState) => s.mountpoints
export const selectUsers = (s: ConfigState) => s.users
export const selectGroups = (s: ConfigState) => s.groups
export const selectZones = (s: ConfigState) => s.zones
export const selectStreams = (s: ConfigState) => s.streams
export const selectAccounts = (s: ConfigState) => s.accounts
export const selectAliases = (s: ConfigState) => s.aliases
export const selectSettings = (s: ConfigState) => s.settings
export const selectShowBackendDetails = (s: ConfigState) => s.showBackendDetails
export const selectIsLoading = (s: ConfigState) => s.isLoading
export const selectIsDirty = (s: ConfigState) => s.isDirty
export const selectValidationResults = (s: ConfigState) => s.validationResults
export const selectGeneratedConfig = (s: ConfigState) => s.generatedConfig
export const selectLastGenerated = (s: ConfigState) => s.lastGenerated
export const selectLastDeployed = (s: ConfigState) => s.lastDeployed

// Individual stat selectors — return primitives so Zustand's Object.is equality works.
// Do NOT use a single selectStats that returns a new object (defeats memoization).
export const selectNetworkCount = (s: ConfigState) => Object.keys(s.networks).length
export const selectNetworkMountpointCount = (s: ConfigState) => Object.keys(s.networkMountpoints).length
export const selectMountpointCount = (s: ConfigState) => Object.keys(s.mountpoints).length
export const selectUserCount = (s: ConfigState) => Object.keys(s.users).length
export const selectGroupCount = (s: ConfigState) => Object.keys(s.groups).length
export const selectZoneCount = (s: ConfigState) => Object.values(s.zones).filter((z) => z.enabled).length
export const selectStreamCount = (s: ConfigState) => Object.values(s.streams).filter((st) => st.enabled).length
export const selectAccountCount = (s: ConfigState) => Object.keys(s.accounts).length
export const selectAliasCount = (s: ConfigState) => Object.keys(s.aliases).length
export const selectHasErrors = (s: ConfigState) => s.validationResults.some((r) => r.severity === 'error')
