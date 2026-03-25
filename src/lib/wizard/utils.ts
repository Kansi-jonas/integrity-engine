// src/lib/utils.ts
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import type {
  Network,
  NetworkMountpoint,
  Mountpoint,
  User,
  Group,
  Zone,
  Stream,
  CasterSettings,
  GeoFence,
  Account,
  Alias,
  NetworkJSON,
  NetworkMountpointJSON,
  MountpointJSON,
  UserJSON,
  GroupJSON,
  ZoneJSON,
  StreamJSON,
  SettingsJSON,
  GeoFenceJSON,
  AccountJSON,
  AliasJSON,
} from './types'
import { DEFAULT_SETTINGS } from './types'

// ── Tailwind class helper ──────────────────────────────────────────────────

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// ── Random ID generator ────────────────────────────────────────────────────

export function generateId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID().replace(/-/g, '').slice(0, 16)
  }
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
}

// ── Mountpoint validation ──────────────────────────────────────────────────

export function isValidMountpoint(name: string): boolean {
  return /^[A-Za-z0-9_]+$/.test(name) && name.length > 0 && name.length <= 32
}

// ── snake_case ↔ camelCase adapters ───────────────────────────────────────
// Read both formats, always write snake_case for Python backward-compat

/** Safely read a field from a JSON object that may be in snake_case or camelCase. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function pick(data: Record<string, any>, snakeKey: string, camelKey: string, fallback?: any) {
  return data[snakeKey] ?? data[camelKey] ?? fallback
}

// ── Network (Tier 1) ──────────────────────────────────────────────────────

export function networkFromJSON(data: NetworkJSON): Network {
  return {
    id: data.id,
    name: data.name,
    host: data.host,
    port: data.port ?? 2101,
    protocol: (data.protocol as Network['protocol']) ?? 'ntrip',
  }
}

export function networkToJSON(n: Network): NetworkJSON {
  return {
    id: n.id,
    name: n.name,
    host: n.host,
    port: n.port,
    protocol: n.protocol,
  }
}

// ── Network Mountpoint (Tier 2) ───────────────────────────────────────────

export function networkMountpointFromJSON(data: NetworkMountpointJSON): NetworkMountpoint {
  const markerName = (data as any).marker_name ?? (data as any).markerName ?? undefined
  return {
    id: data.id,
    networkId: (data as any).network_id ?? (data as any).networkId ?? '',
    mountpoint: data.mountpoint,
    passNmea: (data as any).pass_nmea ?? (data as any).passNmea ?? true,
    ...(markerName ? { markerName } : {}),
  }
}

export function networkMountpointToJSON(nm: NetworkMountpoint): NetworkMountpointJSON {
  return {
    id: nm.id,
    network_id: nm.networkId,
    mountpoint: nm.mountpoint,
    pass_nmea: nm.passNmea,
    ...(nm.markerName ? { marker_name: nm.markerName } : {}),
  }
}

// ── Mountpoint (Tier 3) ───────────────────────────────────────────────────

export function mountpointFromJSON(data: MountpointJSON): Mountpoint {
  return {
    id: data.id,
    name: data.name,
    backends: (data.backends ?? []).map((ref: any) => ({
      // Accept new field name, old field name, and camelCase variants
      networkMountpointId: ref.network_mountpoint_id ?? ref.networkMountpointId ?? ref.backend_id ?? ref.backendId ?? '',
      priority: ref.priority ?? 1,
    })),
    enabled: data.enabled ?? true,
    ...(data.overlap ? { overlap: data.overlap } : {}),
  }
}

export function mountpointToJSON(m: Mountpoint): MountpointJSON {
  return {
    id: m.id,
    name: m.name,
    backends: m.backends.map((ref) => ({
      network_mountpoint_id: ref.networkMountpointId,
      priority: ref.priority,
    })),
    enabled: m.enabled,
    ...(m.overlap ? { overlap: m.overlap } : {}),
  }
}

// ── User ──────────────────────────────────────────────────────────────────

export function userFromJSON(data: UserJSON): User {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = data as Record<string, any>
  return {
    name: data.name,
    password: data.password,
    maxStreams: pick(d, 'max_streams', 'maxStreams', 1),
    isAdmin: pick(d, 'is_admin', 'isAdmin', false),
    timeStart: pick(d, 'time_start', 'timeStart', null),
    timeEnd: pick(d, 'time_end', 'timeEnd', null),
    noLog: pick(d, 'no_log', 'noLog', false),
    uploadUrl: pick(d, 'upload_url', 'uploadUrl', null),
    geofences: (d.geofences ?? []).map(geoFenceFromJSON),
  }
}

export function userToJSON(u: User): UserJSON {
  return {
    name: u.name,
    password: u.password,
    max_streams: u.maxStreams,
    is_admin: u.isAdmin,
    time_start: u.timeStart,
    time_end: u.timeEnd,
    no_log: u.noLog,
    upload_url: u.uploadUrl ?? null,
    geofences: (u.geofences ?? []).map(geoFenceToJSON),
  }
}

// ── GeoFence ──────────────────────────────────────────────────────────────

function geoFenceFromJSON(data: GeoFenceJSON): GeoFence {
  return data as GeoFence
}

function geoFenceToJSON(gf: GeoFence): GeoFenceJSON {
  return gf as GeoFenceJSON
}

// ── Group ─────────────────────────────────────────────────────────────────

export function groupFromJSON(data: GroupJSON): Group {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = data as Record<string, any>
  return {
    name: data.name,
    users: data.users ?? [],
    geofences: (data.geofences ?? []).map(geoFenceFromJSON),
    credentials: (d.credentials ?? []).map((c: Record<string, string>) => ({
      networkId: c.network_id ?? c.networkId ?? '',
      username: c.username ?? '',
      password: c.password ?? '',
    })),
  }
}

export function groupToJSON(g: Group): GroupJSON {
  return {
    name: g.name,
    users: g.users,
    geofences: g.geofences.map(geoFenceToJSON),
    credentials: (g.credentials ?? []).map((c) => ({
      network_id: c.networkId,
      username: c.username,
      password: c.password,
    })),
  }
}

// ── Zone ──────────────────────────────────────────────────────────────────

export function zoneFromJSON(data: ZoneJSON): Zone {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = data as Record<string, any>
  return {
    id: data.id,
    name: data.name,
    // Accept new network_id, old backend_id, and legacy provider_id for backward compat
    networkId: d.network_id ?? d.networkId ?? d.backend_id ?? d.backendId ?? d.provider_id ?? d.providerId ?? '',
    enabled: data.enabled ?? true,
    geofence: data.geofence ? geoFenceFromJSON(data.geofence) : null,
    color: data.color ?? '#3B82F6',
    priority: data.priority ?? 1,
  }
}

export function zoneToJSON(z: Zone): ZoneJSON {
  return {
    id: z.id,
    name: z.name,
    network_id: z.networkId,
    enabled: z.enabled,
    geofence: z.geofence ? geoFenceToJSON(z.geofence) : null,
    color: z.color,
    priority: z.priority,
  }
}

// ── Stream ────────────────────────────────────────────────────────────────

export function streamFromJSON(data: StreamJSON): Stream {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = data as Record<string, any>
  const sOpts = d.smarker_options ?? d.smarkerOptions
  return {
    id: data.id,
    type: data.type,
    name: data.name,
    networkMountpointId: d.network_mountpoint_id ?? d.networkMountpointId ?? d.backend_id ?? d.backendId ?? d.provider_id ?? d.providerId,
    url: data.url,
    uploadUsers: pick(d, 'upload_users', 'uploadUsers'),
    childMarkers: pick(d, 'child_markers', 'childMarkers'),
    smarkerOptions: sOpts
      ? {
          overlap: sOpts.overlap,
          checkPermissions: sOpts.check_permissions ?? sOpts.checkPermissions,
          positionless: sOpts.positionless,
          noBalancing: sOpts.no_balancing ?? sOpts.noBalancing,
          tryRestart: sOpts.try_restart ?? sOpts.tryRestart,
        }
      : undefined,
    downloadUsers: pick(d, 'download_users', 'downloadUsers'),
    geofence: data.geofence ? geoFenceFromJSON(data.geofence) : null,
    passNmea: pick(d, 'pass_nmea', 'passNmea'),
    keepSource: pick(d, 'keep_source', 'keepSource'),
    enabled: data.enabled ?? true,
  }
}

export function streamToJSON(s: Stream): StreamJSON {
  return {
    id: s.id,
    type: s.type,
    name: s.name,
    network_mountpoint_id: s.networkMountpointId,
    url: s.url,
    upload_users: s.uploadUsers,
    child_markers: s.childMarkers,
    smarker_options: s.smarkerOptions
      ? {
          overlap: s.smarkerOptions.overlap,
          check_permissions: s.smarkerOptions.checkPermissions,
          positionless: s.smarkerOptions.positionless,
          no_balancing: s.smarkerOptions.noBalancing,
          try_restart: s.smarkerOptions.tryRestart,
        }
      : undefined,
    download_users: s.downloadUsers,
    geofence: s.geofence ? geoFenceToJSON(s.geofence) : null,
    pass_nmea: s.passNmea,
    keep_source: s.keepSource,
    enabled: s.enabled,
  }
}

// ── Settings ──────────────────────────────────────────────────────────────

export function settingsFromJSON(data: SettingsJSON): CasterSettings {
  return {
    logfile: data.logfile ?? DEFAULT_SETTINGS.logfile,
    loglevel: data.loglevel ?? DEFAULT_SETTINGS.loglevel,
    runtimecheck: data.runtimecheck ?? DEFAULT_SETTINGS.runtimecheck,
    logalberding: data.logalberding ?? DEFAULT_SETTINGS.logalberding,
    lognmea: data.lognmea ?? DEFAULT_SETTINGS.lognmea,
    logxheader: data.logxheader ?? DEFAULT_SETTINGS.logxheader,
    ports: data.ports ?? DEFAULT_SETTINGS.ports,
    udpports: data.udpports ?? DEFAULT_SETTINGS.udpports,
    tlsports: data.tlsports,
    certificate: data.certificate,
    capath: data.capath,
    cafile: data.cafile,
    ciphers: data.ciphers,
    detecttls: data.detecttls,
    tcptimeout: data.tcptimeout ?? DEFAULT_SETTINGS.tcptimeout,
    nmealosstimeout: data.nmealosstimeout ?? DEFAULT_SETTINGS.nmealosstimeout,
    inputtimeout: data.inputtimeout,
    connectionlimit: data.connectionlimit ?? DEFAULT_SETTINGS.connectionlimit,
    maxclients: data.maxclients,
    maxclientspersource: data.maxclientspersource,
    minbandwidth: data.minbandwidth,
    kickonlimit: data.kickonlimit ?? DEFAULT_SETTINGS.kickonlimit,
    httpcompatibility: data.httpcompatibility,
    dynamicSourcetable: data.dynamic_sourcetable ?? false,
    casterHost: data.caster_host ?? DEFAULT_SETTINGS.casterHost,
    casterIdentifier: data.caster_identifier ?? DEFAULT_SETTINGS.casterIdentifier,
    casterOperator: data.caster_operator ?? DEFAULT_SETTINGS.casterOperator,
    casterCountry: data.caster_country ?? DEFAULT_SETTINGS.casterCountry,
    casterLat: data.caster_lat ?? DEFAULT_SETTINGS.casterLat,
    casterLon: data.caster_lon ?? DEFAULT_SETTINGS.casterLon,
    casterUrl: data.caster_url ?? DEFAULT_SETTINGS.casterUrl,
  }
}

export function settingsToJSON(s: CasterSettings): SettingsJSON {
  return {
    logfile: s.logfile,
    loglevel: s.loglevel,
    ports: s.ports,
    udpports: s.udpports,
    runtimecheck: s.runtimecheck,
    tcptimeout: s.tcptimeout,
    nmealosstimeout: s.nmealosstimeout,
    connectionlimit: s.connectionlimit,
    kickonlimit: s.kickonlimit,
    caster_host: s.casterHost,
    caster_identifier: s.casterIdentifier,
    caster_operator: s.casterOperator,
    caster_country: s.casterCountry,
    logalberding: s.logalberding,
    lognmea: s.lognmea,
    logxheader: s.logxheader,
    tlsports: s.tlsports,
    certificate: s.certificate,
    capath: s.capath,
    cafile: s.cafile,
    ciphers: s.ciphers,
    detecttls: s.detecttls,
    inputtimeout: s.inputtimeout,
    maxclients: s.maxclients,
    maxclientspersource: s.maxclientspersource,
    minbandwidth: s.minbandwidth,
    httpcompatibility: s.httpcompatibility,
    dynamic_sourcetable: s.dynamicSourcetable,
    caster_lat: s.casterLat,
    caster_lon: s.casterLon,
    caster_url: s.casterUrl,
  }
}

// ── Account ────────────────────────────────────────────────────────────────

export function accountFromJSON(data: AccountJSON): Account {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = data as Record<string, any>
  return {
    id: data.id,
    users: d.users ?? '',
    remoteUser: pick(d, 'remote_user', 'remoteUser', ''),
    remotePassword: pick(d, 'remote_password', 'remotePassword', ''),
    mountpoints: d.mountpoints ?? '',
    count: d.count,
  }
}

export function accountToJSON(a: Account): AccountJSON {
  return {
    id: a.id,
    users: a.users,
    remote_user: a.remoteUser,
    remote_password: a.remotePassword,
    mountpoints: a.mountpoints,
    count: a.count,
  }
}

// ── Alias ──────────────────────────────────────────────────────────────────

export function aliasFromJSON(data: AliasJSON): Alias {
  return {
    id: data.id,
    alias: data.alias,
    target: data.target,
    host: data.host,
    port: data.port,
  }
}

export function aliasToJSON(a: Alias): AliasJSON {
  return {
    id: a.id,
    alias: a.alias,
    target: a.target,
    host: a.host,
    port: a.port,
  }
}
