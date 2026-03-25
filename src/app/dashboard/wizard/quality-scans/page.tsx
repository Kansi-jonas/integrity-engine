'use client'
import { useState } from 'react'
import {
  Plus, Pencil, Trash2, Eye, EyeOff, FlaskConical,
  Play, Copy, Check, Clock, Wifi, Settings2,
} from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import Header from '@/components/layout/Header'
import PageWrapper from '@/components/layout/PageWrapper'
import type { QualityScan, NetworkPreset, ScheduleType } from '@/lib/types'

// ── Defaults ──────────────────────────────────────────────────────────────────

const NETWORK_PRESETS: Record<NetworkPreset, { host: string; port: number; mountpoint: string; label: string }> = {
  geodnet: { host: 'rtk.geodnet.com', port: 2101, mountpoint: 'AUTO', label: 'GEODNET' },
  onocoy:  { host: 'clients.onocoy.com', port: 2101, mountpoint: 'NRBY_ADV', label: 'Onocoy' },
  custom:  { host: '', port: 2101, mountpoint: '', label: 'Custom' },
}

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

function blankScan(): Omit<QualityScan, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    name: '',
    enabled: true,
    networkPreset: 'geodnet',
    host: 'rtk.geodnet.com',
    port: 2101,
    mountpoint: 'AUTO',
    username: '',
    password: '',
    durationSeconds: 30,
    parallelWorkers: 30,
    batchSize: 500,
    scheduleType: 'manual',
    scheduleTime: '02:00',
    scheduleDays: [0, 1, 2, 3, 4],
    regionLat: null,
    regionLon: null,
    regionRadiusKm: null,
  }
}

// ── CLI command generator ─────────────────────────────────────────────────────

function buildCommand(scan: QualityScan): string {
  const py = `"C:/Users/Jonas Becker/MetaGPT/venv/Scripts/python.exe"`
  const script = scan.networkPreset === 'geodnet'
    ? 'scan_geodnet_live.py'
    : 'scan_stations.py'

  const parts = [
    `PYTHONIOENCODING=utf-8 ${py} atlas/${script}`,
    `--batch ${scan.batchSize}`,
    `--workers ${scan.parallelWorkers}`,
    `--duration ${scan.durationSeconds}`,
  ]

  if (scan.username) parts.push(`--user "${scan.username}"`)
  if (scan.host && scan.host !== NETWORK_PRESETS[scan.networkPreset]?.host) {
    parts.push(`--host "${scan.host}" --port ${scan.port}`)
  }
  if (scan.regionLat != null && scan.regionLon != null) {
    parts.push(`--lat ${scan.regionLat} --lon ${scan.regionLon}`)
    if (scan.regionRadiusKm != null) parts.push(`--radius-km ${scan.regionRadiusKm}`)
  }

  return parts.join(' ')
}

function buildScheduleLabel(scan: QualityScan): string {
  if (scan.scheduleType === 'manual') return 'Manual'
  if (scan.scheduleType === 'daily') return `Daily at ${scan.scheduleTime ?? '02:00'} UTC`
  const dayNames = scan.scheduleDays.map((d) => DAYS[d]).join(', ')
  return `Weekly (${dayNames}) at ${scan.scheduleTime ?? '02:00'} UTC`
}

// ── Form ──────────────────────────────────────────────────────────────────────

function ScanForm({
  initial,
  onSave,
  onCancel,
}: {
  initial?: QualityScan
  onSave: (s: QualityScan) => void
  onCancel: () => void
}) {
  const blank = blankScan()
  const [name, setName] = useState(initial?.name ?? blank.name)
  const [enabled, setEnabled] = useState(initial?.enabled ?? blank.enabled)
  const [networkPreset, setNetworkPreset] = useState<NetworkPreset>(initial?.networkPreset ?? blank.networkPreset)
  const [host, setHost] = useState(initial?.host ?? blank.host)
  const [port, setPort] = useState(initial?.port ?? blank.port)
  const [mountpoint, setMountpoint] = useState(initial?.mountpoint ?? blank.mountpoint)
  const [username, setUsername] = useState(initial?.username ?? blank.username)
  const [password, setPassword] = useState(initial?.password ?? blank.password)
  const [showPass, setShowPass] = useState(false)
  const [durationSeconds, setDurationSeconds] = useState(initial?.durationSeconds ?? blank.durationSeconds)
  const [parallelWorkers, setParallelWorkers] = useState(initial?.parallelWorkers ?? blank.parallelWorkers)
  const [batchSize, setBatchSize] = useState(initial?.batchSize ?? blank.batchSize)
  const [scheduleType, setScheduleType] = useState<ScheduleType>(initial?.scheduleType ?? blank.scheduleType)
  const [scheduleTime, setScheduleTime] = useState(initial?.scheduleTime ?? blank.scheduleTime)
  const [scheduleDays, setScheduleDays] = useState<number[]>(initial?.scheduleDays ?? blank.scheduleDays)
  const [regionLat, setRegionLat] = useState<string>(initial?.regionLat?.toString() ?? '')
  const [regionLon, setRegionLon] = useState<string>(initial?.regionLon?.toString() ?? '')
  const [regionRadius, setRegionRadius] = useState<string>(initial?.regionRadiusKm?.toString() ?? '')
  const [errors, setErrors] = useState<Record<string, string>>({})

  function applyPreset(preset: NetworkPreset) {
    setNetworkPreset(preset)
    const p = NETWORK_PRESETS[preset]
    if (preset !== 'custom') {
      setHost(p.host)
      setPort(p.port)
      setMountpoint(p.mountpoint)
    }
  }

  function toggleDay(d: number) {
    setScheduleDays((prev) => prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d].sort())
  }

  function validate() {
    const e: Record<string, string> = {}
    if (!name.trim()) e.name = 'Required'
    if (!host.trim()) e.host = 'Required'
    if (!username.trim()) e.username = 'Required'
    if (!password.trim()) e.password = 'Required'
    if (durationSeconds < 5 || durationSeconds > 3600) e.duration = '5–3600 s'
    if (parallelWorkers < 1 || parallelWorkers > 200) e.workers = '1–200'
    if (batchSize < 1 || batchSize > 5000) e.batch = '1–5000'
    return e
  }

  function handleSave() {
    const e = validate()
    if (Object.keys(e).length > 0) { setErrors(e); return }
    const now = new Date().toISOString()
    onSave({
      id: initial?.id ?? `qs_${Date.now()}`,
      name: name.trim(),
      enabled,
      networkPreset,
      host: host.trim(),
      port,
      mountpoint: mountpoint.trim(),
      username: username.trim(),
      password: password.trim(),
      durationSeconds,
      parallelWorkers,
      batchSize,
      scheduleType,
      scheduleTime,
      scheduleDays,
      regionLat: regionLat !== '' ? Number(regionLat) : null,
      regionLon: regionLon !== '' ? Number(regionLon) : null,
      regionRadiusKm: regionRadius !== '' ? Number(regionRadius) : null,
      createdAt: initial?.createdAt ?? now,
      updatedAt: now,
    })
  }

  return (
    <div className="space-y-5">
      {/* Basic */}
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1">
          <Label htmlFor="qs-name">Scan Name</Label>
          <Input
            id="qs-name"
            value={name}
            onChange={(e) => { setName(e.target.value); setErrors((p) => ({ ...p, name: '' })) }}
            placeholder="e.g. GEODNET EU Daily"
            className={errors.name ? 'border-red-400' : ''}
          />
          {errors.name && <p className="text-xs text-red-500">{errors.name}</p>}
        </div>
        <div className="space-y-1 flex flex-col justify-end">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="w-4 h-4 accent-[#0067ff]" />
            <span className="text-sm font-medium text-gray-700">Enabled</span>
          </label>
        </div>
      </div>

      {/* Network Preset */}
      <div className="space-y-2">
        <Label>Network</Label>
        <div className="flex gap-2 flex-wrap">
          {(Object.keys(NETWORK_PRESETS) as NetworkPreset[]).map((preset) => (
            <button
              key={preset}
              type="button"
              onClick={() => applyPreset(preset)}
              className={`px-3 py-1.5 rounded text-xs font-semibold border transition-colors ${
                networkPreset === preset
                  ? 'bg-[#0067ff] text-white border-[#0067ff]'
                  : 'bg-white text-gray-600 border-gray-300 hover:border-[#0067ff]'
              }`}
            >
              {NETWORK_PRESETS[preset].label}
            </button>
          ))}
        </div>
      </div>

      {/* Connection */}
      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-2 space-y-1">
          <Label htmlFor="qs-host">Host</Label>
          <Input id="qs-host" value={host} onChange={(e) => setHost(e.target.value)} placeholder="rtk.geodnet.com" className={errors.host ? 'border-red-400' : ''} />
          {errors.host && <p className="text-xs text-red-500">{errors.host}</p>}
        </div>
        <div className="space-y-1">
          <Label htmlFor="qs-port">Port</Label>
          <Input id="qs-port" type="number" value={port} onChange={(e) => setPort(Number(e.target.value))} />
        </div>
      </div>

      <div className="space-y-1">
        <Label htmlFor="qs-mount">Mountpoint</Label>
        <Input id="qs-mount" value={mountpoint} onChange={(e) => setMountpoint(e.target.value)} placeholder="AUTO" />
        <p className="text-xs text-gray-400">Use AUTO for GEODNET, NRBY_ADV for Onocoy, or a specific station mountpoint</p>
      </div>

      {/* Credentials */}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label htmlFor="qs-user">Username</Label>
          <Input id="qs-user" value={username} onChange={(e) => { setUsername(e.target.value); setErrors((p) => ({ ...p, username: '' })) }} placeholder="e.g. rtkjonasbecker" className={errors.username ? 'border-red-400' : ''} />
          {errors.username && <p className="text-xs text-red-500">{errors.username}</p>}
        </div>
        <div className="space-y-1">
          <Label htmlFor="qs-pass">Password</Label>
          <div className="relative">
            <Input
              id="qs-pass"
              type={showPass ? 'text' : 'password'}
              value={password}
              onChange={(e) => { setPassword(e.target.value); setErrors((p) => ({ ...p, password: '' })) }}
              placeholder="Credential password"
              className={`pr-9 ${errors.password ? 'border-red-400' : ''}`}
            />
            <button type="button" className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600" onClick={() => setShowPass((v) => !v)}>
              {showPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
          {errors.password && <p className="text-xs text-red-500">{errors.password}</p>}
        </div>
      </div>

      {/* Scan Parameters */}
      <div className="border-t border-gray-100 pt-4">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3 flex items-center gap-1.5">
          <Settings2 className="w-3.5 h-3.5" /> Scan Parameters
        </p>
        <div className="grid grid-cols-3 gap-3">
          <div className="space-y-1">
            <Label htmlFor="qs-dur">Duration (s)</Label>
            <Input id="qs-dur" type="number" min={5} max={3600} value={durationSeconds} onChange={(e) => { setDurationSeconds(Number(e.target.value)); setErrors((p) => ({ ...p, duration: '' })) }} className={errors.duration ? 'border-red-400' : ''} />
            {errors.duration && <p className="text-xs text-red-500">{errors.duration}</p>}
            <p className="text-xs text-gray-400">RTCM collect time per station</p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="qs-workers">Parallel Workers</Label>
            <Input id="qs-workers" type="number" min={1} max={200} value={parallelWorkers} onChange={(e) => { setParallelWorkers(Number(e.target.value)); setErrors((p) => ({ ...p, workers: '' })) }} className={errors.workers ? 'border-red-400' : ''} />
            {errors.workers && <p className="text-xs text-red-500">{errors.workers}</p>}
            <p className="text-xs text-gray-400">Concurrent NTRIP connections</p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="qs-batch">Batch Size</Label>
            <Input id="qs-batch" type="number" min={1} max={5000} value={batchSize} onChange={(e) => { setBatchSize(Number(e.target.value)); setErrors((p) => ({ ...p, batch: '' })) }} className={errors.batch ? 'border-red-400' : ''} />
            {errors.batch && <p className="text-xs text-red-500">{errors.batch}</p>}
            <p className="text-xs text-gray-400">Stations per scan pass</p>
          </div>
        </div>
      </div>

      {/* Region Filter (optional) */}
      <div className="border-t border-gray-100 pt-4">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Region Filter <span className="font-normal normal-case text-gray-400">(optional — leave blank to scan all stations)</span></p>
        <div className="grid grid-cols-3 gap-3">
          <div className="space-y-1">
            <Label htmlFor="qs-lat">Center Latitude</Label>
            <Input id="qs-lat" type="number" step="0.001" value={regionLat} onChange={(e) => setRegionLat(e.target.value)} placeholder="e.g. 51.5" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="qs-lon">Center Longitude</Label>
            <Input id="qs-lon" type="number" step="0.001" value={regionLon} onChange={(e) => setRegionLon(e.target.value)} placeholder="e.g. 10.0" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="qs-radius">Radius (km)</Label>
            <Input id="qs-radius" type="number" min={10} max={5000} value={regionRadius} onChange={(e) => setRegionRadius(e.target.value)} placeholder="e.g. 500" />
          </div>
        </div>
      </div>

      {/* Schedule */}
      <div className="border-t border-gray-100 pt-4">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3 flex items-center gap-1.5">
          <Clock className="w-3.5 h-3.5" /> Schedule
        </p>
        <div className="flex gap-2 mb-3">
          {(['manual', 'daily', 'weekly'] as ScheduleType[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setScheduleType(t)}
              className={`px-3 py-1.5 rounded text-xs font-semibold border transition-colors ${
                scheduleType === t ? 'bg-[#0067ff] text-white border-[#0067ff]' : 'bg-white text-gray-600 border-gray-300 hover:border-[#0067ff]'
              }`}
            >
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
        {scheduleType !== 'manual' && (
          <div className="space-y-3">
            <div className="space-y-1 w-32">
              <Label htmlFor="qs-time">Time (UTC)</Label>
              <Input id="qs-time" type="time" value={scheduleTime ?? '02:00'} onChange={(e) => setScheduleTime(e.target.value)} />
            </div>
            {scheduleType === 'weekly' && (
              <div className="space-y-1">
                <Label>Days</Label>
                <div className="flex gap-1.5">
                  {DAYS.map((day, i) => (
                    <button
                      key={day}
                      type="button"
                      onClick={() => toggleDay(i)}
                      className={`w-9 h-9 rounded text-xs font-semibold border transition-colors ${
                        scheduleDays.includes(i) ? 'bg-[#0067ff] text-white border-[#0067ff]' : 'bg-white text-gray-600 border-gray-300 hover:border-[#0067ff]'
                      }`}
                    >
                      {day}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <p className="text-xs text-gray-400 flex items-center gap-1">
              <Clock className="w-3 h-3" />
              Use Windows Task Scheduler or cron to execute the generated CLI command at the configured time
            </p>
          </div>
        )}
      </div>

      <div className="flex gap-2 pt-2">
        <Button onClick={handleSave} size="sm" className="bg-[#0067ff] hover:bg-[#0052cc] text-white">
          {initial ? 'Save Changes' : 'Add Scan Config'}
        </Button>
        <Button onClick={onCancel} variant="outline" size="sm">Cancel</Button>
      </div>
    </div>
  )
}

// ── Scan Row ──────────────────────────────────────────────────────────────────

function ScanRow({
  scan,
  onEdit,
  onDelete,
}: {
  scan: QualityScan
  onEdit: () => void
  onDelete: () => void
}) {
  const [copied, setCopied] = useState(false)
  const cmd = buildCommand(scan)
  const preset = NETWORK_PRESETS[scan.networkPreset]

  function copyCmd() {
    navigator.clipboard.writeText(cmd)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <tr className="border-b border-gray-100 hover:bg-gray-50 transition-colors">
      <td className="py-3 px-3">
        <div className="flex items-center gap-2">
          <FlaskConical className="w-3.5 h-3.5 text-[#0067ff] flex-shrink-0" />
          <div>
            <p className="text-sm font-medium text-gray-800">{scan.name}</p>
            <p className="text-xs text-gray-400">{buildScheduleLabel(scan)}</p>
          </div>
        </div>
      </td>
      <td className="py-3 px-3">
        <div className="flex items-center gap-1.5">
          <Badge variant="secondary" className="text-[10px] px-1.5 py-0 font-mono">{preset.label}</Badge>
          <span className="text-xs text-gray-500 font-mono">{scan.host}:{scan.port}</span>
        </div>
        <p className="text-xs text-gray-400 font-mono mt-0.5">{scan.mountpoint} / {scan.username}</p>
      </td>
      <td className="py-3 px-3">
        <div className="flex flex-wrap gap-1.5 text-xs text-gray-600">
          <span className="bg-gray-100 rounded px-1.5 py-0.5">{scan.durationSeconds}s duration</span>
          <span className="bg-gray-100 rounded px-1.5 py-0.5">{scan.parallelWorkers} workers</span>
          <span className="bg-gray-100 rounded px-1.5 py-0.5">batch {scan.batchSize}</span>
        </div>
      </td>
      <td className="py-3 px-3">
        <Badge variant={scan.enabled ? 'default' : 'secondary'} className={`text-[10px] ${scan.enabled ? 'bg-green-100 text-green-700' : ''}`}>
          {scan.enabled ? 'Active' : 'Disabled'}
        </Badge>
      </td>
      <td className="py-3 px-3">
        <div className="flex gap-1">
          <button
            onClick={copyCmd}
            className="p-1.5 text-gray-400 hover:text-[#0067ff] rounded transition-colors"
            title="Copy CLI command"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
          </button>
          <button onClick={onEdit} className="p-1.5 text-gray-400 hover:text-gray-600 rounded">
            <Pencil className="w-3.5 h-3.5" />
          </button>
          <button onClick={onDelete} className="p-1.5 text-gray-400 hover:text-red-500 rounded">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </td>
    </tr>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function QualityScansPage() {
  const [scans, setScans] = useState<Record<string, QualityScan>>({})
  const [loaded, setLoaded] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [expandedCmd, setExpandedCmd] = useState<string | null>(null)

  // Load from server on mount
  useState(() => {
    fetch('/api/wizard/data/quality_scans')
      .then((r) => r.json())
      .then((data) => { setScans(data ?? {}); setLoaded(true) })
      .catch(() => setLoaded(true))
  })

  async function persist(updated: Record<string, QualityScan>) {
    setScans(updated)
    await fetch('/api/wizard/data/quality_scans', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updated),
    }).catch(() => {})
  }

  function handleAdd(scan: QualityScan) {
    persist({ ...scans, [scan.id]: scan })
    setShowForm(false)
  }

  function handleUpdate(scan: QualityScan) {
    persist({ ...scans, [scan.id]: scan })
    setEditingId(null)
  }

  function handleDelete(id: string) {
    const { [id]: _, ...rest } = scans
    persist(rest)
  }

  const scanList = Object.values(scans)

  return (
    <PageWrapper>
      <Header />

      <div className="p-6 space-y-6 max-w-5xl">
        {/* Info banner */}
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 flex gap-3">
          <FlaskConical className="w-5 h-5 text-blue-500 flex-shrink-0 mt-0.5" />
          <div className="text-sm text-blue-800 space-y-1">
            <p className="font-semibold">How Quality Scans work</p>
            <p>
              Each profile stores credentials and scan parameters for a network. Click the{' '}
              <Copy className="w-3.5 h-3.5 inline" /> icon to copy the generated CLI command,
              then run it in your atlas directory or schedule it via Windows Task Scheduler / cron.
              Results are written to <code className="bg-blue-100 px-1 rounded font-mono text-xs">atlas/geodnet_live_scan.json</code> and automatically picked up by MERIDIAN.
            </p>
          </div>
        </div>

        {/* Add form */}
        {showForm && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold text-gray-700">New Scan Profile</CardTitle>
            </CardHeader>
            <CardContent>
              <ScanForm onSave={handleAdd} onCancel={() => setShowForm(false)} />
            </CardContent>
          </Card>
        )}

        {/* Table */}
        <Card>
          <CardHeader className="pb-3 flex flex-row items-center justify-between">
            <CardTitle className="text-sm font-semibold text-gray-700 flex items-center gap-2">
              <FlaskConical className="w-4 h-4 text-[#0067ff]" />
              Scan Profiles
              {scanList.length > 0 && <Badge variant="secondary" className="ml-1">{scanList.length}</Badge>}
            </CardTitle>
            {!showForm && (
              <Button
                size="sm"
                onClick={() => { setShowForm(true); setEditingId(null) }}
                className="bg-[#0067ff] hover:bg-[#0052cc] text-white h-7 text-xs"
              >
                <Plus className="w-3.5 h-3.5 mr-1" /> Add Profile
              </Button>
            )}
          </CardHeader>
          <CardContent className="p-0">
            {!loaded ? (
              <div className="text-center py-10 text-gray-400 text-sm">Loading…</div>
            ) : scanList.length === 0 ? (
              <div className="text-center py-12 text-gray-400">
                <FlaskConical className="w-8 h-8 mx-auto mb-2 opacity-30" />
                <p className="text-sm">No scan profiles yet</p>
                <p className="text-xs mt-1">Add one to start testing network quality</p>
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200 bg-gray-50">
                    <th className="text-left py-2 px-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Name / Schedule</th>
                    <th className="text-left py-2 px-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Network / Credential</th>
                    <th className="text-left py-2 px-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Parameters</th>
                    <th className="text-left py-2 px-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Status</th>
                    <th className="py-2 px-3" />
                  </tr>
                </thead>
                <tbody>
                  {scanList.map((scan) =>
                    editingId === scan.id ? (
                      <tr key={scan.id} className="border-b border-gray-100 bg-blue-50/30">
                        <td colSpan={5} className="p-4">
                          <ScanForm
                            initial={scan}
                            onSave={handleUpdate}
                            onCancel={() => setEditingId(null)}
                          />
                        </td>
                      </tr>
                    ) : (
                      <>
                        <ScanRow
                          key={scan.id}
                          scan={scan}
                          onEdit={() => { setEditingId(scan.id); setShowForm(false) }}
                          onDelete={() => handleDelete(scan.id)}
                        />
                        {/* Expandable CLI preview */}
                        <tr key={`${scan.id}-cmd`} className="border-b border-gray-100">
                          <td colSpan={5} className="px-3 pb-2">
                            <button
                              className="text-[10px] text-gray-400 hover:text-gray-600 flex items-center gap-1"
                              onClick={() => setExpandedCmd(expandedCmd === scan.id ? null : scan.id)}
                            >
                              <Play className="w-3 h-3" />
                              {expandedCmd === scan.id ? 'Hide command' : 'Show CLI command'}
                            </button>
                            {expandedCmd === scan.id && (
                              <div className="mt-1.5 bg-slate-900 rounded p-3 flex items-start gap-2">
                                <code className="text-[11px] text-green-400 font-mono break-all flex-1">{buildCommand(scan)}</code>
                                <button
                                  onClick={() => { navigator.clipboard.writeText(buildCommand(scan)) }}
                                  className="text-gray-500 hover:text-gray-300 flex-shrink-0 mt-0.5"
                                >
                                  <Copy className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            )}
                          </td>
                        </tr>
                      </>
                    )
                  )}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>

        {/* Schedule hint */}
        {scanList.some((s) => s.scheduleType !== 'manual') && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 flex gap-3">
            <Clock className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
            <div className="text-sm text-amber-800">
              <p className="font-semibold">Scheduling reminder</p>
              <p className="mt-0.5">
                Copy the CLI command and add it to Windows Task Scheduler (Task Scheduler → Create Basic Task → Daily/Weekly → Action: Start Program → paste the command).
                Or add it to crontab on Linux.
              </p>
            </div>
          </div>
        )}
      </div>
    </PageWrapper>
  )
}
