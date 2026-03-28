/**
 * src/lib/config-engine.ts
 * Core config generation engine — every directive traced to ALBERDING_SYNTAX.md.
 *
 * CRITICAL: No syntax is invented. Every line generated here corresponds to
 * documented Alberding directives. If in doubt, leave it out.
 *
 * 3-Tier Architecture:
 *   Network (host:port) → NetworkMountpoint (network + mountpoint + passNmea)
 *   → RTKdata Mountpoint (customer-facing, references NetworkMountpoints)
 *   Credentials live on Groups, resolved per-network at generation time.
 */

import type {
  Network,
  NetworkMountpoint,
  Mountpoint,
  User,
  Group,
  GroupCredential,
  Zone,
  Stream,
  CasterSettings,
  GeoFence,
  Account,
  Alias,
} from './types'

// ── Geo-fence serialization ────────────────────────────────────────────────
// Alberding syntax: circle(radius,lat,lon) or polygon(lat1,lon1,lat2,lon2,...)
// Per ALBERDING_SYNTAX.md §13

function formatCoord(n: number): string {
  // Use up to 6 decimal places, strip trailing zeros
  return parseFloat(n.toFixed(6)).toString()
}

export function serializeGeoFence(gf: GeoFence): string {
  if (gf.type === 'circle') {
    if (gf.radius === undefined || gf.lat === undefined || gf.lon === undefined) {
      throw new Error('Circle geo-fence missing radius, lat, or lon')
    }
    return `circle(${gf.radius},${formatCoord(gf.lat)},${formatCoord(gf.lon)})`
  } else {
    if (!gf.points || gf.points.length < 3) {
      throw new Error('Polygon geo-fence requires at least 3 points')
    }
    const coords = gf.points.map(([lat, lon]) => `${formatCoord(lat)},${formatCoord(lon)}`).join(',')
    return `polygon(${coords})`
  }
}

// ── URL generation ─────────────────────────────────────────────────────────
// Per ALBERDING_SYNTAX.md §7 URL Formats
// Format: 'protocol:mountpoint[/user[:pass]][@server[:port]]'
// CRITICAL: URL MUST be wrapped in single quotes

export function buildPinputUrl(
  network: Network,
  networkMountpoint: NetworkMountpoint,
  credential: GroupCredential | null,
): string {
  let auth = ''
  if (credential && credential.username && credential.password) {
    assertSafeCredential(credential.username, 'NTRIP username')
    assertSafeCredential(credential.password, 'NTRIP password')
    auth = `/${credential.username}:${credential.password}`
  } else if (credential && credential.username) {
    assertSafeCredential(credential.username, 'NTRIP username')
    auth = `/${credential.username}`
  }
  // Always include port — port 2101 is the NTRIP default but explicit is unambiguous
  const port = `:${network.port}`
  const protocol = network.protocol ?? 'ntrip'
  return `'${protocol}:${networkMountpoint.mountpoint}${auth}@${network.host}${port}'`
}

// Build an --input URL with a static NMEA position embedded.
// Per Alberding docs §3.14: URL;lat,lon,height;resendSec
// Used for smarker child streams that need to be "active" (visible to smarker).
export function buildInputUrlWithNmea(
  network: Network,
  networkMountpoint: NetworkMountpoint,
  credential: GroupCredential | null,
  nmeaLat: number,
  nmeaLon: number,
  resendSec: number = 30,
): string {
  let auth = ''
  if (credential && credential.username && credential.password) {
    assertSafeCredential(credential.username, 'NTRIP username')
    assertSafeCredential(credential.password, 'NTRIP password')
    auth = `/${credential.username}:${credential.password}`
  } else if (credential && credential.username) {
    assertSafeCredential(credential.username, 'NTRIP username')
    auth = `/${credential.username}`
  }
  const port = `:${network.port}`
  const protocol = network.protocol ?? 'ntrip'
  return `'${protocol}:${networkMountpoint.mountpoint}${auth}@${network.host}${port};${nmeaLat.toFixed(6)},${nmeaLon.toFixed(6)},0.0;${resendSec}'`
}

// Compute the centroid of a geofence (polygon → arithmetic mean, circle → center).
function computeGeofenceCentroid(gf: GeoFence): { lat: number; lon: number } {
  if (gf.type === 'circle') {
    return { lat: gf.lat!, lon: gf.lon! }
  }
  const points = gf.points!
  const lat = points.reduce((sum, p) => sum + p[0], 0) / points.length
  const lon = points.reduce((sum, p) => sum + p[1], 0) / points.length
  return { lat, lon }
}

// ── User line generation ───────────────────────────────────────────────────
// Per ALBERDING_SYNTAX.md §3: --user = <name>:<password>[:args]

// Characters that MUST NOT appear in NTRIP credentials — they break URL structure
// or Alberding config syntax and cannot be safely escaped.
const FORBIDDEN_CREDENTIAL_CHARS = /[':@;]/

/** Validate that a credential value is safe for embedding in NTRIP URLs and config lines. */
function assertSafeCredential(value: string, label: string): void {
  if (FORBIDDEN_CREDENTIAL_CHARS.test(value)) {
    throw new Error(
      `${label} contains forbidden characters (' : @ ;). ` +
        `These break NTRIP URL parsing and Alberding config syntax. ` +
        `Value: "${value.slice(0, 20)}${value.length > 20 ? '...' : ''}"`
    )
  }
}

// Passwords in --user lines are NOT quoted per Alberding docs §3.8.
// Only --account remote credentials support quoting (§3.10).
// Passwords containing ':' or '#' will break --user syntax — those chars
// are inherently unsafe in user passwords (no escape mechanism exists).
function formatUserPassword(pw: string): string {
  if (pw.includes(':')) {
    throw new Error(
      `User password contains ':' which is the Alberding argument separator. ` +
        `This will break the --user directive. Change the password.`
    )
  }
  return pw
}

export function generateUserLine(user: User): string {
  const args: string[] = []

  // Bug 2: only emit maxstreams() when explicitly set (> 0)
  // Default (0) means "use caster default" — emitting maxstreams() triggers
  // license errors on Alberding deployments with maxstreamsperuser = 1
  if (user.maxStreams > 0) {
    args.push(`maxstreams(${user.maxStreams})`)
  }

  // Time restriction — per ALBERDING_SYNTAX.md §3
  if (user.timeStart && user.timeEnd) {
    args.push(`time(${user.timeStart}-${user.timeEnd})`)
  } else if (user.timeEnd && !user.timeStart) {
    // End-only: account expires at this time
    args.push(`time(${user.timeEnd})`)
  } else if (user.timeStart && !user.timeEnd) {
    // Start-only: account active from start, no expiry
    args.push(`time(${user.timeStart}-)`)
  }

  // upload('url') — per ALBERDING_SYNTAX.md §3
  // Requires maxStreams = 1. URL must start with ntripv: or ntrip1v:
  if (user.uploadUrl) {
    const url = user.uploadUrl.startsWith("'") ? user.uploadUrl : `'${user.uploadUrl}'`
    args.push(`upload(${url})`)
  }

  // Geo-fences on user lines — multiple allowed per ALBERDING_SYNTAX.md §13
  for (const gf of user.geofences ?? []) {
    args.push(serializeGeoFence(gf))
  }

  const argStr = args.join(':')
  // Bug 1: always quote password — '#' is a comment char, ':' is a separator
  const pw = formatUserPassword(user.password)
  if (argStr) {
    return `--user = ${user.name}:${pw}:${argStr}`
  }
  return `--user = ${user.name}:${pw}`
}

// ── Account line generation ─────────────────────────────────────────────────
// Per ALBERDING_SYNTAX.md §8:
// --account = <users>:<remoteuser>:<remotepassword>:<mountpoints>[:<count>]
// Remote user/password are quoted with single quotes if they contain colons.

export function generateAccountLine(account: Account): string {
  // Per §3.10: remote user/password CAN be quoted with ' or " if they contain colons
  const remoteUser = `'${account.remoteUser}'`
  const remotePassword = `'${account.remotePassword}'`

  let line = `--account = ${account.users}:${remoteUser}:${remotePassword}:${account.mountpoints}`
  if (account.count !== undefined && account.count > 0) {
    line += `:${account.count}`
  }
  return line
}

// ── Alias line generation ────────────────────────────────────────────────────
// Per ALBERDING_SYNTAX.md §9:
// --alias = [alias]:[target][:[host][:port]]

export function generateAliasLine(aliasEntry: Alias): string {
  let line = `--alias = ${aliasEntry.alias}:${aliasEntry.target}`
  if (aliasEntry.host) {
    line += `:${aliasEntry.host}`
    if (aliasEntry.port !== undefined) {
      line += `:${aliasEntry.port}`
    }
  }
  return line
}

// ── Group line generation ──────────────────────────────────────────────────
// Per ALBERDING_SYNTAX.md §4: --group = <name>[:users][:args]
// Multiple geo-fences allowed on group lines

export function generateGroupLine(group: Group): string {
  let line = `--group = ${group.name}`

  if (group.users.length > 0) {
    line += `:${group.users.join(',')}`
  } else if (group.geofences.length > 0) {
    line += ':'
  }

  for (const gf of group.geofences) {
    line += `:${serializeGeoFence(gf)}`
  }

  return line
}

// ── Marker line generation ─────────────────────────────────────────────────
// Per ALBERDING_SYNTAX.md §6: --marker = <name>:<upload_users>[:download_users][:args]
// ONE geo-fence max per line

export function generateMarkerLine(stream: Stream): string {
  if (stream.type !== 'marker' && stream.type !== 'dmarker') {
    throw new Error(`generateMarkerLine called with stream type: ${stream.type}`)
  }

  const directive = stream.type === 'dmarker' ? '--dmarker' : '--marker'
  const uploadUsers = (stream.uploadUsers ?? []).join(',') || ''
  const downloadUsers = (stream.downloadUsers ?? []).join(',') || ''

  const parts: string[] = [`${directive} = ${stream.name}:${uploadUsers}`]
  parts.push(downloadUsers)

  if (stream.keepSource) {
    parts.push('keepsource')
  }

  // ONE geo-fence per marker line (ALBERDING_SYNTAX.md §13)
  if (stream.geofence) {
    parts.push(serializeGeoFence(stream.geofence))
  }

  return parts.join(':')
}

// ── Pinput line generation (manual streams) ─────────────────────────────────
// Per ALBERDING_SYNTAX.md §7: --pinput = <marker>:<URL>:[:users][:args]
// URL MUST be in single quotes. ONE geo-fence max per line.

export function generatePinputLine(
  stream: Stream,
  networks: Record<string, Network>,
  networkMountpoints: Record<string, NetworkMountpoint>,
): string {
  if (stream.type === 'dinput') {
    throw new Error(`generatePinputLine called with dinput type — use generateInputLine instead`)
  }
  const directive = '--pinput'

  // Resolve URL — prefer manual override, fall back to network mountpoint URL
  let url: string
  if (stream.url) {
    url = stream.url.startsWith("'") ? stream.url : `'${stream.url}'`
  } else if (stream.networkMountpointId) {
    const nm = networkMountpoints[stream.networkMountpointId]
    if (!nm) throw new Error(`Stream "${stream.name}" references unknown network mountpoint "${stream.networkMountpointId}"`)
    const net = networks[nm.networkId]
    if (!net) throw new Error(`Network mountpoint "${nm.mountpoint}" references unknown network "${nm.networkId}"`)
    url = buildPinputUrl(net, nm, null)
  } else {
    throw new Error(`Stream "${stream.name}" has no URL and no network mountpoint`)
  }

  const downloadUsers = (stream.downloadUsers ?? []).join(',') || ''

  const parts: string[] = [`${directive} = ${stream.name}:${url}`]
  parts.push(downloadUsers)

  if (stream.passNmea) {
    parts.push('passnmea')
  }

  // ONE geo-fence per pinput line (ALBERDING_SYNTAX.md §13 — scope rules)
  if (stream.geofence) {
    parts.push(serializeGeoFence(stream.geofence))
  }

  return parts.join(':')
}

// ── Input line generation ──────────────────────────────────────────────────
// Per ALBERDING_SYNTAX.md §7: --input = <marker>:<URL>:[:users][:args]

export function generateInputLine(
  stream: Stream,
  networks: Record<string, Network>,
  networkMountpoints: Record<string, NetworkMountpoint>,
): string {
  const directive = stream.type === 'dinput' ? '--dinput' : '--input'

  let url: string
  if (stream.url) {
    url = stream.url.startsWith("'") ? stream.url : `'${stream.url}'`
  } else if (stream.networkMountpointId) {
    const nm = networkMountpoints[stream.networkMountpointId]
    if (!nm) throw new Error(`Stream "${stream.name}" references unknown network mountpoint "${stream.networkMountpointId}"`)
    const net = networks[nm.networkId]
    if (!net) throw new Error(`Network mountpoint "${nm.mountpoint}" references unknown network "${nm.networkId}"`)
    url = buildPinputUrl(net, nm, null)
  } else {
    throw new Error(`Stream "${stream.name}" has no URL and no network mountpoint`)
  }

  const downloadUsers = (stream.downloadUsers ?? []).join(',') || ''
  const parts: string[] = [`${directive} = ${stream.name}:${url}`]
  parts.push(downloadUsers)

  if (stream.geofence) {
    parts.push(serializeGeoFence(stream.geofence))
  }

  return parts.join(':')
}

// ── Smarker line generation ────────────────────────────────────────────────
// Per ALBERDING_SYNTAX.md §6: --smarker = <name>:<marker>[,marker,...][:download_users][:args]

export function generateSmarkerLine(stream: Stream): string {
  if (stream.type !== 'smarker') {
    throw new Error(`generateSmarkerLine called with stream type: ${stream.type}`)
  }
  if (!stream.childMarkers || stream.childMarkers.length === 0) {
    throw new Error(`smarker "${stream.name}" has no child markers`)
  }

  const markers = stream.childMarkers.join(',')
  const downloadUsers = (stream.downloadUsers ?? []).join(',') || ''

  const parts: string[] = [`--smarker = ${stream.name}:${markers}`]
  parts.push(downloadUsers)

  const opts = stream.smarkerOptions ?? {}
  if (opts.overlap !== undefined) parts.push(`overlap(${opts.overlap})`)
  if (opts.checkPermissions) parts.push('checkpermissions')
  if (opts.positionless) parts.push('positionless')
  if (opts.noBalancing) parts.push('nobalancing')
  if (opts.tryRestart !== undefined) parts.push(`tryrestart(${opts.tryRestart})`)

  if (stream.geofence) {
    parts.push(serializeGeoFence(stream.geofence))
  }

  return parts.join(':')
}

// ── Zone × Mountpoint × Group pinput + smarker generation ────────────────
//
// Single-backend mountpoint  → --pinput uses mp.name directly (no smarker)
// Multi-backend mountpoint   → internal pinput names + auto --smarker
//
// Internal name scheme (multi-backend):
//   ${mp.name}_b${backendIdx}                 (single group)
//   ${mp.name}_${safeGroupName}_b${backendIdx} (multiple groups)
//
// smarker name scheme (multi-backend):
//   ${mp.name}                 (single group — smarker IS the public name)
//   ${mp.name}_${safeGroupName} (multiple groups — one smarker per group)
//
// smarker defaults (from architecture decisions):
//   tryrestart(1), overlap(500)
//
// Cascade order:
//   1. Backend refs sorted by priority (lower = higher priority = listed first)
//   2. Within backend, zones sorted by zone priority
//   3. Each group gets its own credential-embedded URL set

function safeIdent(s: string): string {
  // Replace non-alphanumeric chars with underscore, collapse runs
  return s.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')
}

export function generateMountpointPinputLines(
  mountpoint: Mountpoint,
  networks: Record<string, Network>,
  networkMountpoints: Record<string, NetworkMountpoint>,
  zones: Zone[],
  groups: Group[],
): string[] {
  const lines: string[] = []

  // Sort backend refs by priority (lower = higher priority = listed first)
  const sortedRefs = [...mountpoint.backends].sort((a, b) => a.priority - b.priority)

  // Determine how many distinct networks are in the backends
  const distinctNetworkIds = new Set(
    sortedRefs
      .map((r) => networkMountpoints[r.networkMountpointId]?.networkId)
      .filter(Boolean),
  )
  const multiBackend = distinctNetworkIds.size > 1

  // Collect groups that have at least one credential
  const credGroups = groups.filter((g) => g.credentials && g.credentials.length > 0)
  const multiGroup = credGroups.length > 1

  for (const group of credGroups) {
    const groupLines: string[] = []
    // Collect unique marker names for the smarker.
    // Each zone gets a unique name (e.g. ONOCOY_Z1, ONOCOY_Z2) because
    // Alberding REQUIRES unique marker names — duplicates cause verify FAILURE.
    const smarkerChildNames: string[] = []

    for (let bIdx = 0; bIdx < sortedRefs.length; bIdx++) {
      const ref = sortedRefs[bIdx]
      const nm = networkMountpoints[ref.networkMountpointId]
      if (!nm) {
        groupLines.push(`# WARNING: Network mountpoint '${ref.networkMountpointId}' not found`)
        continue
      }

      const network = networks[nm.networkId]
      if (!network) {
        groupLines.push(`# WARNING: Network '${nm.networkId}' not found`)
        continue
      }

      const credential = group.credentials.find((c) => c.networkId === network.id)
      if (!credential) {
        groupLines.push(`# WARNING: Group '${group.name}' has no credentials for network '${network.name}' — skipping backend ${nm.mountpoint}`)
        continue
      }

      // Marker name logic:
      // - Single-backend: ALWAYS use mountpoint.name — this IS the customer-facing name
      //   and there's no smarker to alias it. Using markerName here would create a
      //   pinput with an internal name that doesn't match the sourcetable entry.
      // - Multi-backend: Use markerName (semantic, e.g. "GEOD_AUTO", "ONOCOY") or
      //   auto-generate. These are internal markers wrapped by an smarker that
      //   carries the customer-facing mountpoint.name.
      let baseStreamName: string
      if (!multiBackend) {
        // Single backend — pinput name IS the public mountpoint name
        baseStreamName = mountpoint.name
      } else if (nm.markerName) {
        baseStreamName = nm.markerName
      } else if (multiGroup) {
        baseStreamName = `${mountpoint.name}_${safeIdent(group.name)}_b${bIdx}`
      } else {
        baseStreamName = `${mountpoint.name}_b${bIdx}`
      }

      const url = buildPinputUrl(network, nm, credential)
      const matchingZones = zones
        .filter((z) => z.enabled && z.networkId === network.id)
        .sort((a, b) => a.priority - b.priority)

      if (matchingZones.length === 0) {
        // No zones configured — single global pinput without geo-fence
        if (multiBackend) smarkerChildNames.push(baseStreamName)
        const parts = [`--pinput = ${baseStreamName}:${url}:${group.name}`]
        if (nm.passNmea) parts.push('passnmea')
        groupLines.push(`# ${network.name} — global (no zone)`)
        groupLines.push(parts.join(':'))
      } else {
        groupLines.push(`# ${network.name} — ${matchingZones.length} zone(s)`)
        for (let zIdx = 0; zIdx < matchingZones.length; zIdx++) {
          const zone = matchingZones[zIdx]
          // Each zone gets a UNIQUE marker name — Alberding rejects duplicate names
          const zoneName = `${baseStreamName}_Z${zIdx + 1}`
          if (multiBackend) smarkerChildNames.push(zoneName)
          const parts = [`--pinput = ${zoneName}:${url}:${group.name}`]
          if (nm.passNmea) parts.push('passnmea')
          if (zone.geofence) parts.push(serializeGeoFence(zone.geofence))
          groupLines.push(`# Zone: ${zone.name}`)
          groupLines.push(parts.join(':'))
        }
      }
    }

    // Smarker lists ALL unique child names (zone names + global backends)
    if (multiBackend && smarkerChildNames.length > 0) {
      const smarkerName = multiGroup
        ? `${mountpoint.name}_${safeIdent(group.name)}`
        : mountpoint.name
      const users = group.name
      const smarkerArgs: string[] = []
      if (mountpoint.overlap) smarkerArgs.push(`overlap(${mountpoint.overlap})`)
      const argsSuffix = smarkerArgs.length > 0 ? `:${smarkerArgs.join(':')}` : ''
      groupLines.push(`--smarker = ${smarkerName}:${smarkerChildNames.join(',')}:${users}${argsSuffix}`)
    }

    if (groupLines.length > 0) {
      lines.push(`# --- Group: ${group.name} ---`)
      lines.push(...groupLines)
    }
  }

  return lines
}

// ── Sourcetable generation ─────────────────────────────────────────────────
// Per ALBERDING_SYNTAX.md §11 and §3.33 (dynamicsourcetable)
// STR entry: 19 semicolon-separated fields
// Coordinate fields (lat/lon) in sourcetable are in DDMM.mm format
// (same format as casterLat/casterLon in settings)

function generateSourcetable(
  mountpoints: Mountpoint[],
  streams: Stream[],
  networks: Record<string, Network>,
  networkMountpoints: Record<string, NetworkMountpoint>,
  settings: CasterSettings,
): string[] {
  const lines: string[] = []
  const host = settings.casterHost
  const port = settings.ports.split(',')[0]
  const ident = settings.casterIdentifier
  const operator = settings.casterOperator
  const country = settings.casterCountry
  const lat = settings.casterLat
  const lon = settings.casterLon
  const url = settings.casterUrl

  // Use --dynamicsourcetable if enabled — hides inactive mountpoints
  // Per ALBERDING_SYNTAX.md §3.33
  const directive = settings.dynamicSourcetable ? '--dynamicsourcetable' : '--sourcetable'
  lines.push(directive)

  // BKG reference CAS entry — always first per CLAUDE.md rule 6
  lines.push('CAS;rtcm-ntrip.org;2101;NtripInfoCaster;BKG;0;DEU;0050.12;8.69;http://www.rtcm-ntrip.org/home')

  // Our caster CAS entry
  lines.push(`CAS;${host};${port};${ident};${operator};0;${country};${lat};${lon};${url}`)

  // STR entries for each active mountpoint
  // STR format (19 fields): mountpoint;identifier;format;format-details;carrier;nav-system;
  //   network;country;lat;lon;nmea;solution;generator;compr-encryp;authentication;fee;bitrate;misc
  const enabledMountpoints = mountpoints
    .filter((m) => m.enabled)
    .sort((a, b) => a.name.localeCompare(b.name))
  for (const mp of enabledMountpoints) {
    // For multi-backend (smarker) mountpoints, use "RTKdata" as network since
    // it aggregates multiple upstream networks. For single-backend, show the actual network.
    const backendNetworkIds = new Set(
      mp.backends.map((r) => networkMountpoints[r.networkMountpointId]?.networkId).filter(Boolean),
    )
    let networkName: string
    if (backendNetworkIds.size === 1) {
      const firstNmId = mp.backends[0]?.networkMountpointId
      const firstNm = firstNmId ? networkMountpoints[firstNmId] : undefined
      // Always brand as RTKdata — white-label, never expose upstream network
      networkName = 'RTKdata'
    } else {
      networkName = 'RTKdata'
    }
    lines.push(
      `STR;${mp.name};${ident};` +
        `RTCM 3.3;1005(10),1074(1),1084(1),1094(1),1124(1),1230(10);` +
        `2;GPS+GLO+GAL+BDS;${networkName};${country};${lat};${lon};` +
        `1;1;sNTRIP;none;B;N;9600;${ident}`,
    )
  }

  // STR entries for manual streams (non-zone-based)
  const manualStreams = streams.filter((s) => s.enabled && ['pinput', 'input', 'marker', 'smarker'].includes(s.type))
  for (const stream of manualStreams) {
    const nm = stream.networkMountpointId ? networkMountpoints[stream.networkMountpointId] : undefined
    // Always brand as RTKdata — white-label
    const networkName = 'RTKdata'
    lines.push(
      `STR;${stream.name};${ident};` +
        `RTCM 3.3;1005(10),1074(1),1084(1),1094(1),1124(1),1230(10);` +
        `2;GPS+GLO+GAL+BDS;${networkName};${country};${lat};${lon};` +
        `1;1;sNTRIP;none;B;N;9600;${ident}`,
    )
  }

  lines.push('--endsourcetable')
  return lines
}

// ── TLS settings generation ────────────────────────────────────────────────
// Per ALBERDING_SYNTAX.md §12

function generateTlsLines(settings: CasterSettings): string[] {
  const lines: string[] = []
  if (!settings.tlsports) return lines

  lines.push('# --- TLS ---')
  lines.push(`--tlsports = ${settings.tlsports}`)
  if (settings.certificate) lines.push(`--certificate = ${settings.certificate}`)
  if (settings.capath) lines.push(`--capath = ${settings.capath}`)
  if (settings.cafile) lines.push(`--cafile = ${settings.cafile}`)
  if (settings.ciphers) lines.push(`--ciphers = ${settings.ciphers}`)
  if (settings.detecttls !== undefined) lines.push(`--detecttls = ${settings.detecttls}`)
  return lines
}

// ── Full config generation ─────────────────────────────────────────────────

export interface ConfigInput {
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

export interface GenerateConfigOptions {
  /** When set, emits `--config = <path>` before the sourcetable (used for split-config mode) */
  configIncludePath?: string
}

export function generateConfig(input: ConfigInput, opts?: GenerateConfigOptions): string {
  const { networks, networkMountpoints, mountpoints, users, groups, zones, streams, accounts, aliases, settings } = input
  const lines: string[] = []

  // ── 1. Header ────────────────────────────────────────────────────────────
  lines.push('# ' + '='.repeat(61))
  lines.push('# RTKdata NTRIP Caster Configuration')
  lines.push('# Generated by Alberding Config Wizard')
  lines.push(`# Generated at: ${new Date().toISOString()}`)
  lines.push('# ' + '='.repeat(61))
  lines.push('')

  // ── 2. Global settings ───────────────────────────────────────────────────
  lines.push('# --- Logging ---')
  lines.push(`--logfile = ${settings.logfile}`)
  lines.push(`--loglevel = ${settings.loglevel}`)
  lines.push(`--runtimecheck = ${settings.runtimecheck}`)
  // Only emit optional logging directives when enabled (=1).
  // Value 0 is the default — omitting is cleaner and avoids warnings.
  if (settings.logalberding) lines.push(`--logalberding = ${settings.logalberding}`)
  if (settings.lognmea) lines.push(`--lognmea = ${settings.lognmea}`)
  if (settings.logxheader) lines.push(`--logxheader = ${settings.logxheader}`)
  lines.push('')

  lines.push('# --- Ports ---')
  lines.push(`--ports = ${settings.ports}`)
  lines.push(`--udpports = ${settings.udpports}`)
  lines.push('')

  lines.push('# --- Timeouts & Limits ---')
  lines.push(`--tcptimeout = ${settings.tcptimeout}`)
  lines.push(`--nmealosstimeout = ${settings.nmealosstimeout}`)
  lines.push(`--connectionlimit = ${settings.connectionlimit}`)
  // kickonlimit and httpcompatibility are bare flags (no arguments per Alberding doc)
  if (settings.kickonlimit) lines.push('--kickonlimit')
  if (settings.httpcompatibility) lines.push('--httpcompatibility')
  if (settings.maxclients !== undefined) lines.push(`--maxclients = ${settings.maxclients}`)
  if (settings.maxclientspersource !== undefined) {
    lines.push(`--maxclientspersource = ${settings.maxclientspersource}`)
  }
  if (settings.minbandwidth !== undefined) lines.push(`--minbandwidth = ${settings.minbandwidth}`)
  if (settings.inputtimeout !== undefined) lines.push(`--inputtimeout = ${settings.inputtimeout}`)
  lines.push('')

  // ── 3. TLS settings ──────────────────────────────────────────────────────
  const tlsLines = generateTlsLines(settings)
  if (tlsLines.length > 0) {
    lines.push(...tlsLines)
    lines.push('')
  }

  // ── 4. Users ─────────────────────────────────────────────────────────────
  const userList = Object.values(users)
  if (userList.length > 0) {
    lines.push('# ' + '='.repeat(61))
    lines.push('# USERS')
    lines.push('# ' + '='.repeat(61))
    for (const user of userList) {
      lines.push(generateUserLine(user))
    }
    lines.push('')
  }

  // ── 5. Groups ─────────────────────────────────────────────────────────────
  const groupList = Object.values(groups)
  if (groupList.length > 0) {
    lines.push('# ' + '='.repeat(61))
    lines.push('# GROUPS')
    lines.push('# ' + '='.repeat(61))
    for (const group of groupList) {
      lines.push(generateGroupLine(group))
    }
    lines.push('')
  }

  // ── 5b. Account mappings (--account for pinput variable substitution) ────
  // Per ALBERDING_SYNTAX.md §8: maps local users to remote caster credentials
  const accountList = Object.values(accounts)
  if (accountList.length > 0) {
    lines.push('# ' + '='.repeat(61))
    lines.push('# ACCOUNT MAPPINGS (--account)')
    lines.push('# ' + '='.repeat(61))
    for (const account of accountList) {
      lines.push(generateAccountLine(account))
    }
    lines.push('')
  }

  // ── 6. Admin users ────────────────────────────────────────────────────────
  const adminUsers = userList.filter((u) => u.isAdmin).map((u) => u.name)
  if (adminUsers.length > 0) {
    lines.push('# ' + '='.repeat(61))
    lines.push('# ADMIN')
    lines.push('# ' + '='.repeat(61))
    lines.push(`--admin = ${adminUsers.join(',')}`)
    lines.push('')
  }

  // ── 7. No-log users ────────────────────────────────────────────────────────
  const noLogUsers = userList.filter((u) => u.noLog).map((u) => u.name)
  if (noLogUsers.length > 0) {
    lines.push(`--nolog = ${noLogUsers.join(',')}`)
    lines.push('')
  }

  // ── 8. Markers (direct base station streams) ──────────────────────────────
  const markerStreams = Object.values(streams).filter(
    (s) => s.enabled && (s.type === 'marker' || s.type === 'dmarker'),
  )
  if (markerStreams.length > 0) {
    lines.push('# ' + '='.repeat(61))
    lines.push('# DIRECT STREAMS (marker)')
    lines.push('# ' + '='.repeat(61))
    for (const stream of markerStreams) {
      lines.push(generateMarkerLine(stream))
    }
    lines.push('')
  }

  // ── 9. Input streams (rebroadcast) ────────────────────────────────────────
  const inputStreams = Object.values(streams).filter(
    (s) => s.enabled && (s.type === 'input' || s.type === 'dinput'),
  )
  if (inputStreams.length > 0) {
    lines.push('# ' + '='.repeat(61))
    lines.push('# REBROADCAST STREAMS (input / dinput)')
    lines.push('# ' + '='.repeat(61))
    for (const stream of inputStreams) {
      try {
        lines.push(generateInputLine(stream, networks, networkMountpoints))
      } catch (e) {
        lines.push(`# ERROR: ${(e as Error).message}`)
      }
    }
    lines.push('')
  }

  // ── 10. Mountpoint × Zone × Group pinput lines ───────────────────────────
  // This is the core of the three-tier architecture:
  // For each enabled RTKdata Mountpoint, generate --pinput lines per
  // zone/network/group combination with credentials resolved from groups.

  const enabledMountpoints = Object.values(mountpoints).filter((m) => m.enabled)
  const enabledZones = Object.values(zones).filter((z) => z.enabled)

  // Manual pinput streams (from Streams page, not zone-based)
  const pinputStreams = Object.values(streams).filter(
    (s) => s.enabled && s.type === 'pinput',
  )

  if (enabledMountpoints.length > 0 || pinputStreams.length > 0) {
    lines.push('# ' + '='.repeat(61))
    lines.push('# PROXIED STREAMS (input/pinput + smarker auto-generated)')
    lines.push('# ' + '='.repeat(61))

    // Mountpoint × Zone × Group generated pinputs
    for (const mp of enabledMountpoints) {
      lines.push(`# --- Mountpoint: ${mp.name} ---`)
      const mpLines = generateMountpointPinputLines(
        mp,
        networks,
        networkMountpoints,
        enabledZones,
        groupList,
      )
      lines.push(...mpLines)
      lines.push('')
    }

    // Manual pinput streams
    for (const stream of pinputStreams) {
      try {
        lines.push(generatePinputLine(stream, networks, networkMountpoints))
      } catch (e) {
        lines.push(`# ERROR: ${(e as Error).message}`)
      }
    }
    if (pinputStreams.length > 0) lines.push('')
  }

  // ── 11. Selection markers (smarker) ───────────────────────────────────────
  const smarkerStreams = Object.values(streams).filter(
    (s) => s.enabled && s.type === 'smarker',
  )
  if (smarkerStreams.length > 0) {
    lines.push('# ' + '='.repeat(61))
    lines.push('# SELECTION STREAMS (smarker)')
    lines.push('# ' + '='.repeat(61))
    for (const stream of smarkerStreams) {
      try {
        lines.push(generateSmarkerLine(stream))
      } catch (e) {
        lines.push(`# ERROR: ${(e as Error).message}`)
      }
    }
    lines.push('')
  }

  // ── 12. Aliases ────────────────────────────────────────────────────────────
  // Per ALBERDING_SYNTAX.md §9: --alias = [alias]:[target][:[host][:port]]
  const aliasList = Object.values(aliases)
  if (aliasList.length > 0) {
    lines.push('# ' + '='.repeat(61))
    lines.push('# ALIASES')
    lines.push('# ' + '='.repeat(61))
    for (const aliasEntry of aliasList) {
      lines.push(generateAliasLine(aliasEntry))
    }
    lines.push('')
  }

  // ── 12b. Config include (split-config mode) ───────────────────────────────
  if (opts?.configIncludePath) {
    const p = opts.configIncludePath
    // Bug 5: reject Windows-style paths — these are local dev artifacts, never valid on caster
    const isWindowsPath = /^[A-Za-z]:[\\\/]/.test(p) || p.includes('\\')
    if (isWindowsPath) {
      lines.push(`# SKIPPED --config: Windows path detected (local dev artifact, not valid on caster): ${p}`)
    } else {
      lines.push('# --- Zone config include ---')
      lines.push(`--config = ${p}`)
      lines.push('')
    }
  }

  // ── 13. Sourcetable ────────────────────────────────────────────────────────
  lines.push('# ' + '='.repeat(61))
  lines.push('# SOURCETABLE')
  lines.push('# ' + '='.repeat(61))
  const sourcetableLines = generateSourcetable(
    Object.values(mountpoints),
    Object.values(streams),
    networks,
    networkMountpoints,
    settings,
  )
  lines.push(...sourcetableLines)
  lines.push('')

  // Bug 7: trim trailing whitespace from every line
  return lines.map((l) => l.trimEnd()).join('\n')
}

// ── Split config generation ────────────────────────────────────────────────
// Per CLAUDE.md: zones → separate zones.cfg, main config includes it

export function generateZonesConfig(input: ConfigInput): string {
  const { networks, networkMountpoints, mountpoints, zones, groups } = input  // accounts/aliases not needed here
  const lines: string[] = []

  lines.push('# ' + '='.repeat(61))
  lines.push('# ZONE CONFIGURATION (auto-generated)')
  lines.push('# Include with: --config = /etc/euronav/zones.cfg')
  lines.push('# ' + '='.repeat(61))
  lines.push('')

  const enabledMountpoints = Object.values(mountpoints).filter((m) => m.enabled)
  const enabledZones = Object.values(zones).filter((z) => z.enabled)
  const groupList = Object.values(groups)

  for (const mp of enabledMountpoints) {
    lines.push(`# --- Mountpoint: ${mp.name} ---`)
    const mpLines = generateMountpointPinputLines(
      mp,
      networks,
      networkMountpoints,
      enabledZones,
      groupList,
    )
    lines.push(...mpLines)
    lines.push('')
  }

  // Bug 7: trim trailing whitespace from every line
  return lines.map((l) => l.trimEnd()).join('\n')
}

// ── Config validation ──────────────────────────────────────────────────────

import type { ValidationResult } from './types'

export function validateConfig(input: ConfigInput): ValidationResult[] {
  const { networks, networkMountpoints, mountpoints, users, groups, zones, streams, accounts, aliases, settings } = input
  const results: ValidationResult[] = []

  const userList = Object.values(users)
  const groupList = Object.values(groups)
  const zoneList = Object.values(zones)
  const streamList = Object.values(streams)
  const mountpointList = Object.values(mountpoints)
  const accountList = Object.values(accounts)
  const aliasList = Object.values(aliases)

  // Check for at least one user
  if (userList.length === 0) {
    results.push({ severity: 'error', message: 'At least one user must be defined' })
  }

  // Check for groups
  if (groupList.length === 0) {
    results.push({ severity: 'warning', message: 'No groups defined. Users cannot be grouped.' })
  }

  // Check group member references
  for (const group of groupList) {
    for (const member of group.users) {
      if (!(member in users) && !(member in groups)) {
        results.push({
          severity: 'error',
          message: `Group "${group.name}" references unknown user/group "${member}"`,
          field: `groups.${group.name}`,
        })
      }
    }
  }

  // Check for circular group references
  const circularCheck = detectCircularGroups(groups)
  for (const cycle of circularCheck) {
    results.push({
      severity: 'error',
      message: `Circular group reference detected: ${cycle}`,
    })
  }

  // Check group credentials reference valid networks
  for (const group of groupList) {
    if (!group.credentials || group.credentials.length === 0) {
      results.push({
        severity: 'warning',
        message: `Group "${group.name}" has no network credentials — no pinput lines will be generated for its members`,
        field: `groups.${group.name}`,
      })
    }
    for (const cred of group.credentials ?? []) {
      if (!(cred.networkId in networks)) {
        results.push({
          severity: 'error',
          message: `Group "${group.name}" has a credential for unknown network "${cred.networkId}"`,
          field: `groups.${group.name}`,
        })
      }
    }
  }

  // Check for duplicate network mountpoints (same network + same mountpoint name)
  const nmDedupKeys = new Set<string>()
  for (const nm of Object.values(networkMountpoints)) {
    const key = `${nm.networkId}:${nm.mountpoint}`
    if (nmDedupKeys.has(key)) {
      results.push({
        severity: 'warning',
        message: `Duplicate network mountpoint: ${nm.mountpoint} on network "${nm.networkId}" (id: ${nm.id}) — consider removing the duplicate`,
        field: `networkMountpoints.${nm.id}`,
      })
    }
    nmDedupKeys.add(key)
  }

  // Check zones
  for (const zone of zoneList) {
    if (!zone.enabled) continue

    if (!(zone.networkId in networks)) {
      results.push({
        severity: 'error',
        message: `Zone "${zone.name}" references unknown network "${zone.networkId}"`,
        field: `zones.${zone.id}`,
      })
    }

    if (!zone.geofence) {
      results.push({
        severity: 'warning',
        message: `Zone "${zone.name}" has no geo-fence — globally accessible`,
        field: `zones.${zone.id}`,
      })
    }

    if (zone.geofence?.type === 'polygon' && (zone.geofence.points?.length ?? 0) < 3) {
      results.push({
        severity: 'error',
        message: `Zone "${zone.name}": Polygon requires at least 3 points`,
        field: `zones.${zone.id}`,
      })
    }
  }

  // Check network mountpoints reference valid networks
  for (const nm of Object.values(networkMountpoints)) {
    if (!(nm.networkId in networks)) {
      results.push({
        severity: 'error',
        message: `Network mountpoint "${nm.mountpoint}" references unknown network "${nm.networkId}"`,
        field: `networkMountpoints.${nm.id}`,
      })
    }
  }

  // Check mountpoints
  const mountpointNamesSeen = new Set<string>()
  for (const mp of mountpointList) {
    if (!mp.enabled) continue

    if (!/^[A-Za-z0-9_]+$/.test(mp.name)) {
      results.push({
        severity: 'error',
        message: `Mountpoint "${mp.name}" contains invalid characters (only letters, digits, underscore allowed)`,
        field: `mountpoints.${mp.id}`,
      })
    }

    if (mountpointNamesSeen.has(mp.name)) {
      results.push({
        severity: 'error',
        message: `Duplicate mountpoint name: "${mp.name}"`,
      })
    }
    mountpointNamesSeen.add(mp.name)

    if (mp.backends.length === 0) {
      results.push({
        severity: 'warning',
        message: `Mountpoint "${mp.name}" has no network mountpoints assigned`,
        field: `mountpoints.${mp.id}`,
      })
    }

    for (const ref of mp.backends) {
      if (!(ref.networkMountpointId in networkMountpoints)) {
        results.push({
          severity: 'error',
          message: `Mountpoint "${mp.name}" references unknown network mountpoint "${ref.networkMountpointId}"`,
          field: `mountpoints.${mp.id}`,
        })
      }
    }

    // Check that at least one zone exists for each network used by the mountpoint
    for (const ref of mp.backends) {
      const nm = networkMountpoints[ref.networkMountpointId]
      if (!nm) continue
      const hasZone = zoneList.some((z) => z.enabled && z.networkId === nm.networkId)
      if (!hasZone) {
        const networkName = networks[nm.networkId]?.name ?? nm.networkId
        results.push({
          severity: 'warning',
          message: `Mountpoint "${mp.name}": Network "${networkName}" has no associated zones — will be generated without geo-fence`,
          field: `mountpoints.${mp.id}`,
        })
      }
    }

    // Check that at least one group has credentials for the networks used
    for (const ref of mp.backends) {
      const nm = networkMountpoints[ref.networkMountpointId]
      if (!nm) continue
      const hasGroupCred = groupList.some(
        (g) => g.credentials?.some((c) => c.networkId === nm.networkId),
      )
      if (!hasGroupCred) {
        const networkName = networks[nm.networkId]?.name ?? nm.networkId
        results.push({
          severity: 'warning',
          message: `Mountpoint "${mp.name}": No group has credentials for network "${networkName}" — no pinput lines will be generated`,
          field: `mountpoints.${mp.id}`,
        })
      }
    }
  }

  // Check streams
  for (const stream of streamList) {
    if (!stream.enabled) continue

    if (!stream.url && !stream.networkMountpointId && ['pinput', 'input', 'dinput'].includes(stream.type)) {
      results.push({
        severity: 'error',
        message: `Stream "${stream.name}" (${stream.type}): no URL or network mountpoint specified`,
        field: `streams.${stream.id}`,
      })
    }

    if (stream.type === 'smarker' && (!stream.childMarkers || stream.childMarkers.length === 0)) {
      results.push({
        severity: 'error',
        message: `smarker "${stream.name}": no child markers specified`,
        field: `streams.${stream.id}`,
      })
    }

    if (mountpointNamesSeen.has(stream.name)) {
      results.push({
        severity: 'error',
        message: `Duplicate mountpoint name: "${stream.name}"`,
      })
    }
    mountpointNamesSeen.add(stream.name)
  }

  // Bug 1: check manual stream names don't collide with auto-generated pinput names
  // Auto-generated names follow pattern: {mp.name}_b{N}_{NNN} or {mp.name}_{group}_b{N}_{NNN}
  for (const mp of mountpointList.filter((m) => m.enabled)) {
    for (let bIdx = 0; bIdx < mp.backends.length; bIdx++) {
      const prefix = `${mp.name}_b${bIdx}_`
      for (const stream of streamList) {
        if (stream.enabled && stream.name.startsWith(prefix)) {
          results.push({
            severity: 'error',
            message: `Stream "${stream.name}" conflicts with auto-generated pinput names for mountpoint "${mp.name}" — rename this stream`,
            field: `streams.${stream.id}`,
          })
        }
      }
    }
  }

  // ── User name validation ──────────────────────────────────────────────────
  // Per ALBERDING_SYNTAX.md §3: username should be alphanumeric + underscore
  // (The PDF examples use simple names; hyphens/dots are not documented)
  for (const user of userList) {
    if (!/^[A-Za-z0-9_]+$/.test(user.name)) {
      results.push({
        severity: 'warning',
        message: `User "${user.name}": name contains characters beyond alphanumeric and underscore — may cause issues`,
        field: `users.${user.name}`,
      })
    }

    // upload('url') requires maxstreams(1) per Alberding docs §3.8
    if (user.uploadUrl && user.maxStreams !== 1) {
      results.push({
        severity: 'error',
        message: `User "${user.name}": upload('url') requires maxstreams(1) — set maxStreams to 1`,
        field: `users.${user.name}`,
      })
    }

    // Warn whenever maxstreams() will be emitted (> 0) — even maxstreams(1) triggers
    // "Permissions for maxstreamsperuser option exceeded" on most Alberding licenses.
    // Leave at 0 (unset) to let the caster use its own default.
    if (user.maxStreams > 0) {
      results.push({
        severity: 'warning',
        message: `User "${user.name}": maxstreams(${user.maxStreams}) — Hinweis: erfordert eine entsprechende Alberding-Lizenz (maxstreamsperuser ≥ ${user.maxStreams}). Leer lassen = Caster-Standard.`,
        field: `users.${user.name}`,
      })
    }
  }

  // ── Mountpoint lowercase warning ──────────────────────────────────────────
  // Convention: mountpoint names should be uppercase for Alberding compatibility
  // (not a hard error but recommended per industry practice)
  for (const mp of mountpointList) {
    if (mp.enabled && mp.name !== mp.name.toUpperCase()) {
      results.push({
        severity: 'warning',
        message: `Mountpoint "${mp.name}": consider using uppercase names (e.g. "${mp.name.toUpperCase()}")`,
        field: `mountpoints.${mp.id}`,
      })
    }
  }
  for (const stream of streamList) {
    if (stream.enabled && stream.name !== stream.name.toUpperCase()) {
      results.push({
        severity: 'warning',
        message: `Stream "${stream.name}": consider using uppercase mountpoint names`,
        field: `streams.${stream.id}`,
      })
    }
  }

  // ── TLS port without certificate warning ─────────────────────────────────
  // Per ALBERDING_SYNTAX.md §12: --tlsports requires --certificate for listening
  if (settings.tlsports && settings.tlsports.trim() !== '' && !settings.certificate) {
    results.push({
      severity: 'warning',
      message: 'TLS ports configured (--tlsports) but no --certificate specified — TLS listening will fail',
      field: 'settings.tlsports',
    })
  }

  // ── smarker positionless without nobalancing warning ─────────────────────
  // Per ALBERDING_SYNTAX.md §6: positionless enables failover/load balancing;
  // if only failover is desired, nobalancing should be set
  for (const stream of streamList) {
    if (
      stream.enabled &&
      stream.type === 'smarker' &&
      stream.smarkerOptions?.positionless &&
      !stream.smarkerOptions?.noBalancing
    ) {
      results.push({
        severity: 'warning',
        message: `smarker "${stream.name}": positionless mode enables load balancing across all child markers — add nobalancing if you want failover-only (use markers in order)`,
        field: `streams.${stream.id}`,
      })
    }
  }

  // ── smarker overlap() < 1000m warning ────────────────────────────────────
  // Per Alberding recommendation (config-validator Level 2):
  // overlap() < 1000m may cause rapid reconnects at zone boundaries
  for (const stream of streamList) {
    if (
      stream.enabled &&
      stream.type === 'smarker' &&
      stream.smarkerOptions?.overlap !== undefined &&
      stream.smarkerOptions.overlap < 1000
    ) {
      results.push({
        severity: 'warning',
        message: `smarker "${stream.name}": overlap(${stream.smarkerOptions.overlap}) is below 1000m — may cause rapid reconnects at zone boundaries (Alberding recommends ≥ 1000m)`,
        field: `streams.${stream.id}`,
      })
    }
  }

  // ── inputtimeout with pinput warning ──────────────────────────────────────
  // Per Alberding docs: --inputtimeout only applies to --input/--dinput.
  // Using it alongside --pinput streams is misleading (pinput uses individual
  // per-client connections, not a shared rebroadcast).
  const hasPinputStreams = streamList.some((s) => s.enabled && s.type === 'pinput')
  const hasInputStreams = streamList.some((s) => s.enabled && (s.type === 'input' || s.type === 'dinput'))
  if (settings.inputtimeout !== undefined && hasPinputStreams && !hasInputStreams) {
    results.push({
      severity: 'warning',
      message: '--inputtimeout is set but no --input/--dinput streams are defined — inputtimeout only applies to rebroadcast streams (--input/--dinput), not to --pinput',
      field: 'settings.inputtimeout',
    })
  }

  // ── Account validation ────────────────────────────────────────────────────
  // Per ALBERDING_SYNTAX.md §8: users/mountpoints must be non-empty
  for (const account of accountList) {
    if (!account.users.trim()) {
      results.push({
        severity: 'error',
        message: `Account entry "${account.id}": users field is empty`,
        field: `accounts.${account.id}`,
      })
    }
    if (!account.mountpoints.trim()) {
      results.push({
        severity: 'error',
        message: `Account entry "${account.id}": mountpoints field is empty`,
        field: `accounts.${account.id}`,
      })
    }
    if (!account.remoteUser.trim()) {
      results.push({
        severity: 'error',
        message: `Account entry "${account.id}": remoteUser is empty`,
        field: `accounts.${account.id}`,
      })
    }
  }

  // ── Alias validation ──────────────────────────────────────────────────────
  // Per ALBERDING_SYNTAX.md §9: each alias must be unique per host+port combination
  const aliasKeys = new Set<string>()
  for (const aliasEntry of aliasList) {
    const key = `${aliasEntry.alias}:${aliasEntry.host ?? ''}:${aliasEntry.port ?? ''}`
    if (aliasKeys.has(key)) {
      results.push({
        severity: 'error',
        message: `Duplicate alias "${aliasEntry.alias}" for same host/port combination`,
        field: `aliases.${aliasEntry.id}`,
      })
    }
    aliasKeys.add(key)
    if (!aliasEntry.alias.trim() || !aliasEntry.target.trim()) {
      results.push({
        severity: 'error',
        message: `Alias entry "${aliasEntry.id}": alias and target must not be empty`,
        field: `aliases.${aliasEntry.id}`,
      })
    }
  }

  // Settings range checks
  const s = settings
  if (s.loglevel < 0 || s.loglevel > 5) {
    results.push({ severity: 'error', message: 'loglevel must be 0–5', field: 'settings.loglevel' })
  }
  if (s.tcptimeout < 30 || s.tcptimeout > 1800) {
    results.push({ severity: 'error', message: 'tcptimeout must be 30–1800 seconds', field: 'settings.tcptimeout' })
  }
  if (s.nmealosstimeout < 15 || s.nmealosstimeout > 1800) {
    results.push({
      severity: 'error',
      message: 'nmealosstimeout must be 15–1800 seconds',
      field: 'settings.nmealosstimeout',
    })
  }
  if (s.inputtimeout !== undefined && s.inputtimeout < 60) {
    results.push({
      severity: 'error',
      message: 'inputtimeout must be ≥ 60 seconds',
      field: 'settings.inputtimeout',
    })
  }

  // Port validation
  const portNums = s.ports.split(',').map((p) => parseInt(p.trim(), 10))
  for (const port of portNums) {
    if (isNaN(port) || port < 1 || port > 65535) {
      results.push({ severity: 'error', message: `Invalid port number: ${port}`, field: 'settings.ports' })
    }
  }

  if (results.length === 0 || results.every((r) => r.severity !== 'error')) {
    results.push({ severity: 'success', message: 'Configuration is valid' })
  }

  return results
}

// ── Circular group detection ───────────────────────────────────────────────

function detectCircularGroups(groups: Record<string, Group>): string[] {
  const cycles: string[] = []

  function dfs(groupName: string, path: string[], visited: Set<string>): void {
    if (path.includes(groupName)) {
      const cycleStart = path.indexOf(groupName)
      cycles.push(path.slice(cycleStart).join(' → ') + ' → ' + groupName)
      return
    }
    if (visited.has(groupName)) return
    visited.add(groupName)

    const group = groups[groupName]
    if (!group) return

    for (const member of group.users) {
      if (member in groups) {
        dfs(member, [...path, groupName], visited)
      }
    }
  }

  for (const groupName of Object.keys(groups)) {
    dfs(groupName, [], new Set())
  }

  return cycles
}
