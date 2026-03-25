// src/lib/validators.ts
// Zod schemas for all entities — constraints from ALBERDING_SYNTAX.md
import { z } from 'zod'

// ── Mountpoint name validation ─────────────────────────────────────────────
// Only alphanumeric + underscore (per Alberding docs)
export const mountpointSchema = z
  .string()
  .min(1, 'Mountpoint name is required')
  .max(32, 'Mountpoint name must be ≤ 32 characters')
  .regex(/^[A-Za-z0-9_]+$/, 'Mountpoint name: only letters, digits, and underscores allowed')

// ── Geo-fence schemas ──────────────────────────────────────────────────────

export const circleGeoFenceSchema = z.object({
  type: z.literal('circle'),
  radius: z.number().int().min(1, 'Radius must be > 0').max(20000000, 'Radius too large'),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
})

export const polygonGeoFenceSchema = z.object({
  type: z.literal('polygon'),
  points: z
    .array(z.tuple([z.number().min(-90).max(90), z.number().min(-180).max(180)]))
    .min(3, 'Polygon requires at least 3 points'),
})

export const geoFenceSchema = z.discriminatedUnion('type', [
  circleGeoFenceSchema,
  polygonGeoFenceSchema,
])

// ── Network schema (Tier 1) ─────────────────────────────────────────────

export const networkSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1, 'Network name is required').max(64),
  host: z.string().min(1, 'Host is required').max(253),
  port: z.number().int().min(1, 'Port must be 1–65535').max(65535),
  protocol: z.enum(['ntrip', 'ntrip1', 'ntrips', 'ntripu']).default('ntrip'),
})

// ── Network Mountpoint schema (Tier 2) ──────────────────────────────────

export const networkMountpointSchema = z.object({
  id: z.string().min(1),
  networkId: z.string().min(1, 'Network is required'),
  mountpoint: mountpointSchema,
  passNmea: z.boolean(),
  markerName: z.string().regex(/^[A-Za-z0-9_]+$/).optional(),
})

// ── Mountpoint (RTKdata, Tier 3) schema ─────────────────────────────────

export const mountpointBackendRefSchema = z.object({
  networkMountpointId: z.string().min(1, 'Network mountpoint is required'),
  priority: z.number().int().min(1),
})

export const rtkdataMountpointSchema = z.object({
  id: z.string().min(1),
  name: mountpointSchema,
  backends: z.array(mountpointBackendRefSchema).min(1, 'At least one network mountpoint is required'),
  enabled: z.boolean(),
  overlap: z.number().int().min(1).optional(),
})

// ── Group Credential schema ─────────────────────────────────────────────

export const groupCredentialSchema = z.object({
  networkId: z.string().min(1, 'Network is required'),
  username: z.string().max(64).default(''),
  password: z.string().max(128).default(''),
})

// ── User schema ────────────────────────────────────────────────────────────

// ISO datetime format: 2024-12-21T13:24:25
const isoDatetimeRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/

// URL prefix for upload('...') — must start with ntripv: or ntrip1v: per Alberding docs §3.8
const uploadUrlPrefixRegex = /^(ntripv:|ntrip1v:)/

export const userSchema = z
  .object({
    name: z
      .string()
      .min(1, 'Username is required')
      .max(64)
      // Per Alberding docs: examples show only alphanumeric + underscore.
      // We accept hyphens/dots with a warning (validated separately in config-engine).
      .regex(/^[A-Za-z0-9_\-\.]+$/, 'Username: only letters, digits, underscore, hyphen, dot'),
    password: z.string().min(1, 'Password is required').max(256),
    maxStreams: z.number().int().min(0, 'Max streams must be ≥ 0'),
    isAdmin: z.boolean(),
    timeStart: z
      .string()
      .nullable()
      .refine(
        (v) => v === null || isoDatetimeRegex.test(v),
        'Time must be ISO format: YYYY-MM-DDTHH:MM:SS',
      ),
    timeEnd: z
      .string()
      .nullable()
      .refine(
        (v) => v === null || isoDatetimeRegex.test(v),
        'Time must be ISO format: YYYY-MM-DDTHH:MM:SS',
      ),
    noLog: z.boolean(),
    // upload('url') — per ALBERDING_SYNTAX.md §3: must start with ntripv: or ntrip1v:
    uploadUrl: z
      .string()
      .nullable()
      .optional()
      .refine(
        (v) => !v || uploadUrlPrefixRegex.test(v),
        "Upload URL must start with 'ntripv:' or 'ntrip1v:'",
      ),
    // Per ALBERDING_SYNTAX.md §3 + §13: geo-fences on user level (multiple allowed)
    geofences: z.array(geoFenceSchema).optional().default([]),
  })
  .refine(
    (data) => {
      if (data.timeStart && data.timeEnd) {
        return new Date(data.timeStart) < new Date(data.timeEnd)
      }
      return true
    },
    { message: 'Start time must be before end time', path: ['timeStart'] },
  )
  .refine(
    (data) => {
      // upload('url') requires maxstreams(1) per Alberding docs §3.8
      if (data.uploadUrl && data.maxStreams !== 1) {
        return false
      }
      return true
    },
    { message: "upload('url') requires maxStreams = 1", path: ['uploadUrl'] },
  )

// ── Group schema ───────────────────────────────────────────────────────────

export const groupSchema = z.object({
  name: z
    .string()
    .min(1, 'Group name is required')
    .max(64)
    .regex(/^[A-Za-z0-9_\-]+$/, 'Group name: only letters, digits, underscore, hyphen'),
  users: z.array(z.string()),
  geofences: z.array(geoFenceSchema),
  credentials: z.array(groupCredentialSchema),
})

// ── Zone schema ────────────────────────────────────────────────────────────

export const zoneSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1, 'Zone name is required').max(64),
  networkId: z.string().min(1, 'Network is required'),
  enabled: z.boolean(),
  geofence: geoFenceSchema.nullable(),
  color: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/, 'Color must be a hex code like #FF5500')
    .default('#3B82F6'),
  priority: z.number().int().min(1),
})

// ── Stream schemas ─────────────────────────────────────────────────────────

export const smarkerOptionsSchema = z.object({
  overlap: z.number().int().min(1, 'Overlap must be ≥ 1 meter').optional(),
  checkPermissions: z.boolean().optional(),
  positionless: z.boolean().optional(),
  noBalancing: z.boolean().optional(),
  tryRestart: z.number().int().min(1).optional(),
})

export const streamSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['pinput', 'input', 'dinput', 'marker', 'dmarker', 'smarker']),
  name: mountpointSchema,
  networkMountpointId: z.string().optional(),
  url: z.string().optional(),
  uploadUsers: z.array(z.string()).optional(),
  childMarkers: z.array(z.string()).optional(),
  smarkerOptions: smarkerOptionsSchema.optional(),
  downloadUsers: z.array(z.string()).optional(),
  geofence: geoFenceSchema.nullable().optional(),
  passNmea: z.boolean().optional(),
  keepSource: z.boolean().optional(),
  enabled: z.boolean(),
})

// ── Settings schema ────────────────────────────────────────────────────────

export const settingsSchema = z.object({
  // Logging
  logfile: z
    .string()
    .min(1, 'Log file path is required')
    .startsWith('/', 'Log file path must be absolute'),
  loglevel: z.number().int().min(0).max(5),
  runtimecheck: z.string(),
  logalberding: z.union([z.literal(0), z.literal(1)]),
  lognmea: z.union([z.literal(0), z.literal(1)]),
  logxheader: z.union([z.literal(0), z.literal(1)]),

  // Ports
  ports: z
    .string()
    .regex(/^\d+(,\d+)*$/, 'Ports must be comma-separated numbers like 2101 or 2101,8080')
    .refine(
      (v) => v.split(',').every((p) => { const n = Number(p); return n >= 1 && n <= 65535 }),
      'Each port must be 1–65535',
    ),
  udpports: z
    .string()
    .regex(/^\d+(,\d+)*$/, 'UDP ports must be comma-separated numbers')
    .refine(
      (v) => v.split(',').every((p) => { const n = Number(p); return n >= 1 && n <= 65535 }),
      'Each port must be 1–65535',
    ),

  // TLS (optional)
  tlsports: z.string().optional().or(z.literal('')),
  certificate: z.string().optional().or(z.literal('')),
  capath: z.string().optional().or(z.literal('')),
  cafile: z.string().optional().or(z.literal('')),
  ciphers: z.string().optional().or(z.literal('')),
  detecttls: z.union([z.literal(0), z.literal(1)]).optional(),

  // Timeouts — per Alberding docs
  tcptimeout: z.number().int().min(30, 'TCP timeout min 30s').max(1800, 'TCP timeout max 1800s'),
  nmealosstimeout: z
    .number()
    .int()
    .min(15, 'NMEA loss timeout min 15s')
    .max(1800, 'NMEA loss timeout max 1800s'),
  inputtimeout: z.number().int().min(60, 'Input timeout must be ≥ 60s').optional(),

  // Limits
  connectionlimit: z.number().int().min(1).max(65535),
  maxclients: z.number().int().min(1).optional(),
  maxclientspersource: z.number().int().min(1).optional(),
  minbandwidth: z.number().int().min(0).optional(),

  // Behavior
  kickonlimit: z.union([z.literal(0), z.literal(1)]),
  httpcompatibility: z.union([z.literal(0), z.literal(1)]).optional(),

  // Caster identity
  casterHost: z.string().min(1, 'Caster host is required'),
  casterIdentifier: z.string().min(1, 'Caster identifier is required'),
  casterOperator: z.string().min(1, 'Caster operator is required'),
  casterCountry: z
    .string()
    .length(3, 'Country must be ISO 3166 alpha-3 (e.g. DEU)'),
  casterLat: z.string(),
  casterLon: z.string(),
  casterUrl: z.string().url('Caster URL must be a valid URL'),
})

// ── Account schema ─────────────────────────────────────────────────────────
// Per ALBERDING_SYNTAX.md §8:
// --account = <users>:<remoteuser>:<remotepassword>:<mountpoints>[:<count>]

export const accountSchema = z.object({
  id: z.string().min(1),
  users: z.string().min(1, 'Users field is required (comma-separated user/group names)'),
  remoteUser: z.string().min(1, 'Remote username is required'),
  remotePassword: z.string().min(1, 'Remote password is required'),
  mountpoints: z.string().min(1, 'Mountpoints field is required (comma-separated mountpoint names)'),
  count: z.number().int().min(1).optional(),
})

// ── Alias schema ────────────────────────────────────────────────────────────
// Per ALBERDING_SYNTAX.md §9:
// --alias = [alias]:[target][:[host][:port]]

export const aliasSchema = z.object({
  id: z.string().min(1),
  alias: mountpointSchema,  // alias name must follow mountpoint naming rules
  target: mountpointSchema, // target is an existing mountpoint name
  host: z.string().max(253).optional(),
  port: z.number().int().min(1).max(65535).optional(),
})

// ── Settings schema addition ────────────────────────────────────────────────
// Add dynamicSourcetable to settings — augment existing settingsSchema
export const settingsSchemaWithDynamic = settingsSchema.extend({
  dynamicSourcetable: z.boolean().optional(),
})

// ── Exported types from schemas ────────────────────────────────────────────

export type NetworkFormData = z.infer<typeof networkSchema>
export type NetworkMountpointFormData = z.infer<typeof networkMountpointSchema>
export type MountpointFormData = z.infer<typeof rtkdataMountpointSchema>
export type UserFormData = z.infer<typeof userSchema>
export type GroupFormData = z.infer<typeof groupSchema>
export type ZoneFormData = z.infer<typeof zoneSchema>
export type StreamFormData = z.infer<typeof streamSchema>
export type SettingsFormData = z.infer<typeof settingsSchema>
export type AccountFormData = z.infer<typeof accountSchema>
export type AliasFormData = z.infer<typeof aliasSchema>
