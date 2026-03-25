// src/lib/types.ts
// TypeScript interfaces for all entities in the GNSS Wizard
// 3-Tier Architecture: Network → NetworkMountpoint → RTKdata Mountpoint

// ── Network (Tier 1 — upstream NTRIP caster endpoint) ────────────────────────
// A Network is a pure connection endpoint (e.g. GEODNET, Onocoy).
// No credentials, no mountpoint name — just host and port.

export type NtripProtocol = 'ntrip' | 'ntrip1' | 'ntrips' | 'ntripu'

export interface Network {
  id: string
  name: string         // display name, e.g. "GEODNET"
  host: string         // e.g. "rtk.geodnet.com"
  port: number         // default 2101
  protocol: NtripProtocol  // default "ntrip" — used in URL generation
}

// ── Network Mountpoint (Tier 2 — specific mountpoint at a network) ───────────
// Combines a Network with a mountpoint name. These are the "assets" available
// for assignment to RTKdata Mountpoints.

export interface NetworkMountpoint {
  id: string
  networkId: string    // references a Network
  mountpoint: string   // upstream mountpoint name, e.g. "AUTO", "NRBY_ADV"
  passNmea: boolean    // forward GGA position to upstream (required for AUTO mounts)
  markerName?: string  // override pinput marker name, e.g. "GEOD_AUTO", "ONOCOY"
}

// ── RTKdata Mountpoint (Tier 3 — customer-facing) ────────────────────────────
// What RTKdata customers connect to (e.g. "SMART", "SMART_WGS84").
// References an ordered list of NetworkMountpoints — cascade order determines
// which --pinput line matches first (top-down, first geo-fence match wins).

export interface MountpointBackendRef {
  networkMountpointId: string
  priority: number     // lower = higher priority = listed first in config
}

export interface Mountpoint {
  id: string
  name: string         // customer-facing mountpoint name, e.g. "SMART"
  backends: MountpointBackendRef[]
  enabled: boolean
  overlap?: number     // smarker overlap(meters) — auto-switch when rover is N meters closer to another station
}

// ── Geo-Fencing ──────────────────────────────────────────────────────────────

export interface CircleGeoFence {
  type: 'circle'
  radius: number // meters
  lat: number
  lon: number
}

export interface PolygonGeoFence {
  type: 'polygon'
  points: [number, number][] // [lat, lon] pairs, minimum 3
}

export type GeoFence = CircleGeoFence | PolygonGeoFence

// ── User ──────────────────────────────────────────────────────────────────────

export interface User {
  name: string             // alphanumeric, no spaces
  password: string         // plain text or hash (starts with $)
  maxStreams: number        // 0 = unlimited
  isAdmin: boolean
  timeStart: string | null // ISO format: 2024-12-21T13:24:25
  timeEnd: string | null
  noLog: boolean           // exclude from logging
  // Per ALBERDING_SYNTAX.md §3: upload('url') — forward incoming stream to target
  // Requires maxStreams = 1. URL must start with ntripv: or ntrip1v:
  uploadUrl?: string | null
  // Per ALBERDING_SYNTAX.md §3 + §13: geo-fences on user level (multiple allowed)
  geofences?: GeoFence[]
}

// ── Group Credential ─────────────────────────────────────────────────────────
// Credentials for upstream networks live at the GROUP level.
// Each group can have different credentials per network (floating license model).

export interface GroupCredential {
  networkId: string      // references a Network
  username: string
  password: string
}

// ── Group ─────────────────────────────────────────────────────────────────────

export interface Group {
  name: string
  users: string[]          // user names or group names (nesting allowed)
  geofences: GeoFence[]    // applied at group level
  credentials: GroupCredential[]  // per-network credentials
}

// ── Zone ──────────────────────────────────────────────────────────────────────
// A Zone is a geographic area with a geo-fence that references a Network.
// Zones operate independently of mountpoints — they define which network
// serves a geographic region. The config engine generates --pinput lines
// per Mountpoint × Zone × Group combination.

export interface Zone {
  id: string
  name: string         // internal display name, e.g. "Europa GEODNET"
  networkId: string    // references a Network (Tier 1)
  enabled: boolean
  geofence: GeoFence | null
  color: string        // hex color for map display
  priority: number     // ordering within a mountpoint's pinput cascade (lower = first)
}

// ── Stream (advanced manual configuration) ────────────────────────────────────

export interface SmarkerOptions {
  overlap?: number // meters
  checkPermissions?: boolean
  positionless?: boolean
  noBalancing?: boolean
  tryRestart?: number
}

export type StreamType = 'pinput' | 'input' | 'dinput' | 'marker' | 'dmarker' | 'smarker'

export interface Stream {
  id: string
  type: StreamType
  name: string // mountpoint name

  // For pinput/input/dinput:
  networkMountpointId?: string   // references a NetworkMountpoint
  url?: string                   // manual URL override (advanced)

  // For marker/dmarker:
  uploadUsers?: string[]

  // For smarker:
  childMarkers?: string[] // list of marker names to select from
  smarkerOptions?: SmarkerOptions

  // Common:
  downloadUsers?: string[] // user/group names (empty = public)
  geofence?: GeoFence | null
  passNmea?: boolean
  keepSource?: boolean
  enabled: boolean
}

// ── Account (per-user upstream credential mapping for --pinput) ───────────────
// Per ALBERDING_SYNTAX.md §8:
// --account = <users>:<remoteuser>:<remotepassword>:<mountpoints>[:<count>]

export interface Account {
  id: string
  users: string          // comma-separated user or group names
  remoteUser: string     // remote username (quoted if contains colon)
  remotePassword: string // remote password (quoted if contains colon)
  mountpoints: string    // comma-separated mountpoint names (e.g. "AUTO,AUTO_ITRF2020")
  count?: number         // optional max usage count
}

// ── Alias ─────────────────────────────────────────────────────────────────────
// Per ALBERDING_SYNTAX.md §9:
// --alias = [alias]:[target][:[host][:port]]

export interface Alias {
  id: string
  alias: string          // alias name (the alternative mountpoint name)
  target: string         // target mountpoint name
  host?: string          // optional: scope to specific host
  port?: number          // optional: scope to specific port
}

// ── Caster Settings ──────────────────────────────────────────────────────────

export interface CasterSettings {
  // Logging
  logfile: string
  loglevel: number // 0-5
  runtimecheck: string
  logalberding: number // 0 or 1
  lognmea: number // 0 or 1
  logxheader: number // 0 or 1

  // Ports
  ports: string // comma-separated port numbers
  udpports: string

  // TLS (optional)
  tlsports?: string
  certificate?: string // cert.pem;cert.key;[chain.pem]
  capath?: string
  cafile?: string
  ciphers?: string
  detecttls?: number // 0 or 1

  // Timeouts
  tcptimeout: number // 30-1800 seconds
  nmealosstimeout: number // 15-1800 seconds
  inputtimeout?: number // >= 60 seconds or unset

  // Limits
  connectionlimit: number
  maxclients?: number
  maxclientspersource?: number
  minbandwidth?: number // bytes per minute

  // Behavior
  kickonlimit: number // 0 or 1
  httpcompatibility?: number // 0 or 1

  // Sourcetable mode: false = --sourcetable, true = --dynamicsourcetable
  // Per ALBERDING_SYNTAX.md §11: dynamic hides inactive mountpoints
  dynamicSourcetable?: boolean

  // Caster identity (for sourcetable)
  casterHost: string
  casterIdentifier: string
  casterOperator: string
  casterCountry: string // ISO 3166 alpha-3
  casterLat: string // sourcetable format: 0050.12
  casterLon: string // sourcetable format: 8.69
  casterUrl: string // http://your-caster.com
}

// ── JSON persistence format (snake_case for Python compatibility) ────────────

export interface NetworkJSON {
  id: string
  name: string
  host: string
  port: number
  protocol?: string  // 'ntrip' | 'ntrip1' | 'ntrips' | 'ntripu'
}

export interface NetworkMountpointJSON {
  id: string
  network_id: string
  mountpoint: string
  pass_nmea: boolean
  marker_name?: string
}

export interface MountpointBackendRefJSON {
  network_mountpoint_id: string
  priority: number
}

export interface MountpointJSON {
  id: string
  name: string
  backends: MountpointBackendRefJSON[]
  enabled: boolean
  overlap?: number
}

export interface UserJSON {
  name: string
  password: string
  max_streams: number
  is_admin: boolean
  time_start: string | null
  time_end: string | null
  no_log?: boolean
  upload_url?: string | null
  geofences?: GeoFenceJSON[]
}

export interface GroupCredentialJSON {
  network_id: string
  username: string
  password: string
}

export interface GroupJSON {
  name: string
  users: string[]
  geofences: GeoFenceJSON[]
  credentials?: GroupCredentialJSON[]
}

export interface CircleGeoFenceJSON {
  type: 'circle'
  radius: number
  lat: number
  lon: number
}

export interface PolygonGeoFenceJSON {
  type: 'polygon'
  points: [number, number][]
}

export type GeoFenceJSON = CircleGeoFenceJSON | PolygonGeoFenceJSON

export interface ZoneJSON {
  id: string
  name: string
  network_id: string
  enabled: boolean
  geofence: GeoFenceJSON | null
  color: string
  priority: number
}

export interface StreamJSON {
  id: string
  type: StreamType
  name: string
  network_mountpoint_id?: string
  url?: string
  upload_users?: string[]
  child_markers?: string[]
  smarker_options?: {
    overlap?: number
    check_permissions?: boolean
    positionless?: boolean
    no_balancing?: boolean
    try_restart?: number
  }
  download_users?: string[]
  geofence?: GeoFenceJSON | null
  pass_nmea?: boolean
  keep_source?: boolean
  enabled: boolean
}

export interface SettingsJSON {
  logfile: string
  loglevel: number
  ports: string
  udpports: string
  runtimecheck: string
  tcptimeout: number
  nmealosstimeout: number
  connectionlimit: number
  kickonlimit: number
  caster_host: string
  caster_identifier: string
  caster_operator: string
  caster_country: string
  // Optional fields
  logalberding?: number
  lognmea?: number
  logxheader?: number
  tlsports?: string
  certificate?: string
  capath?: string
  cafile?: string
  ciphers?: string
  detecttls?: number
  inputtimeout?: number
  maxclients?: number
  maxclientspersource?: number
  minbandwidth?: number
  httpcompatibility?: number
  dynamic_sourcetable?: boolean
  caster_lat?: string
  caster_lon?: string
  caster_url?: string
}

export interface AccountJSON {
  id: string
  users: string
  remote_user: string
  remote_password: string
  mountpoints: string
  count?: number
}

export interface AliasJSON {
  id: string
  alias: string
  target: string
  host?: string
  port?: number
}

// ── Quality Scan ─────────────────────────────────────────────────────────────
// Stores credentials + parameters for a recurring NTRIP quality test.
// Actual scan execution runs via the atlas Python scanner (scan_geodnet_live.py
// or scan_stations.py). This config generates the CLI command.

export type ScheduleType = 'manual' | 'daily' | 'weekly'
export type NetworkPreset = 'geodnet' | 'onocoy' | 'custom'

export interface QualityScan {
  id: string
  name: string
  enabled: boolean

  // Connection
  networkPreset: NetworkPreset
  host: string
  port: number
  mountpoint: string
  username: string
  password: string

  // Scan parameters
  durationSeconds: number    // how long to collect RTCM per station
  parallelWorkers: number    // concurrent NTRIP connections
  batchSize: number          // stations per batch

  // Schedule
  scheduleType: ScheduleType
  scheduleTime: string | null  // HH:mm UTC, used for daily/weekly
  scheduleDays: number[]       // 0=Mon .. 6=Sun, used for weekly

  // Optional region filter (lat/lon bounding box)
  regionLat: number | null
  regionLon: number | null
  regionRadiusKm: number | null

  createdAt: string
  updatedAt: string
}

// ── Validation types ─────────────────────────────────────────────────────────

export type ValidationSeverity = 'error' | 'warning' | 'success' | 'info'

export interface ValidationResult {
  severity: ValidationSeverity
  message: string
  field?: string
}

// ── App state ────────────────────────────────────────────────────────────────

export interface AppData {
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
}

// ── Default settings ─────────────────────────────────────────────────────────

export const DEFAULT_SETTINGS: CasterSettings = {
  logfile: '/var/euronav/log/ntrips_%Y-%m-%d.log',
  loglevel: 4,
  runtimecheck: '/var/euronav/ntrips.check',
  logalberding: 0,
  lognmea: 0,
  logxheader: 0,
  ports: '2101',
  udpports: '2101',
  tcptimeout: 300,
  nmealosstimeout: 120,
  connectionlimit: 1024,
  kickonlimit: 1,
  dynamicSourcetable: false,
  casterHost: 'caster.rtkdata.com',
  casterIdentifier: 'RTKdata',
  casterOperator: 'RTKdata',
  casterCountry: 'DEU',
  casterLat: '0050.12',
  casterLon: '8.69',
  casterUrl: 'http://www.rtkdata.com',
}
