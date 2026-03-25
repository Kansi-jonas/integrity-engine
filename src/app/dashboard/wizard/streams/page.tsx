'use client'
import { useState } from 'react'
import { Plus, Radio, Trash2, AlertCircle, Check } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import Header from '@/components/layout/Header'
import PageWrapper from '@/components/layout/PageWrapper'
import {
  useConfigStore,
  selectStreams,
  selectNetworks,
  selectNetworkMountpoints,
  selectUsers,
  selectGroups,
} from '@/store/config-store'
import { generateId, streamToJSON } from '@/lib/utils'
import type { Stream, StreamType } from '@/lib/types'

// ── Constants ──────────────────────────────────────────────────────────────

const STREAM_TYPE_COLORS: Record<StreamType, string> = {
  pinput:  'text-[#0067ff] border-[#0067ff]/30 bg-[#e8f0fe]',
  input:   'text-blue-400 border-blue-500/30 bg-blue-500/10',
  dinput:  'text-indigo-400 border-indigo-500/30 bg-indigo-500/10',
  marker:  'text-violet-400 border-violet-500/30 bg-violet-500/10',
  dmarker: 'text-pink-400 border-pink-500/30 bg-pink-500/10',
  smarker: 'text-amber-400 border-amber-500/30 bg-amber-500/10',
}

const STREAM_TYPE_DESCRIPTIONS: Record<StreamType, string> = {
  pinput:  'Pass-through proxy — each client gets its own upstream connection (recommended for NTRIP)',
  input:   'Rebroadcast — one upstream connection shared by all clients',
  dinput:  'VRS rebroadcast — like input, but for virtual reference stations',
  marker:  'Upload receiver for local base stations',
  dmarker: 'VRS upload receiver',
  smarker: 'Selection stream — automatically selects the nearest/best child station',
}

// ── Helpers ────────────────────────────────────────────────────────────────

function MultiSelect({
  label,
  options,
  selected,
  onChange,
  placeholder,
}: {
  label: string
  options: string[]
  selected: string[]
  onChange: (v: string[]) => void
  placeholder?: string
}) {
  const toggle = (opt: string) =>
    onChange(selected.includes(opt) ? selected.filter((x) => x !== opt) : [...selected, opt])

  return (
    <div className="space-y-1.5">
      <Label>{label} <span className="text-gray-400 font-normal">({selected.length} selected)</span></Label>
      {options.length === 0 ? (
        <p className="text-xs text-gray-400 italic">{placeholder ?? 'No entries available'}</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {options.map((opt) => {
            const on = selected.includes(opt)
            return (
              <button
                key={opt}
                onClick={() => toggle(opt)}
                className={`flex items-center gap-1 px-2.5 py-1 rounded text-xs font-mono border transition-colors ${
                  on
                    ? 'bg-[#e8f0fe] border-[#0067ff]/40 text-[#0067ff]'
                    : 'bg-gray-50 border-gray-200 text-gray-500 hover:border-slate-500'
                }`}
              >
                {on && <Check className="w-2.5 h-2.5" />}
                {opt}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** Build a display label like "GEODNET / AUTO" for a network mountpoint */
function nmLabel(
  nmId: string,
  networkMountpoints: Record<string, { networkId: string; mountpoint: string }>,
  networks: Record<string, { name: string }>,
): string {
  const nm = networkMountpoints[nmId]
  if (!nm) return nmId
  const net = networks[nm.networkId]
  return `${net?.name ?? '?'} / ${nm.mountpoint}`
}

// ── Stream Card ────────────────────────────────────────────────────────────

function StreamCard({
  stream,
  nmDisplayName,
  onDelete,
}: {
  stream: Stream
  nmDisplayName?: string
  onDelete: (id: string) => void
}) {
  return (
    <Card className={stream.enabled ? '' : 'opacity-60'}>
      <CardContent className="p-4">
        <div className="flex items-start justify-between mb-2">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="font-mono font-semibold text-gray-800">{stream.name}</span>
              <Badge className={`text-xs border ${STREAM_TYPE_COLORS[stream.type]}`}>
                --{stream.type}
              </Badge>
              {!stream.enabled && <Badge variant="secondary" className="text-xs">Disabled</Badge>}
            </div>
            {nmDisplayName && <p className="text-xs text-gray-400">→ {nmDisplayName}</p>}
            {stream.url && !nmDisplayName && (
              <p className="text-xs text-gray-400 font-mono truncate max-w-xs">{stream.url}</p>
            )}
            {stream.childMarkers && stream.childMarkers.length > 0 && (
              <p className="text-xs text-gray-400">
                Selects from: {stream.childMarkers.join(', ')}
              </p>
            )}
          </div>
          <Button
            size="icon"
            variant="ghost"
            onClick={() => onDelete(stream.id)}
            className="text-red-400 hover:text-red-600 hover:bg-red-50"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </Button>
        </div>

        <div className="flex flex-wrap gap-1 mt-2">
          {stream.passNmea && <Badge variant="secondary" className="text-xs">passnmea</Badge>}
          {stream.keepSource && <Badge variant="secondary" className="text-xs">keepsource</Badge>}
          {stream.geofence && (
            <Badge variant="secondary" className="text-xs">
              {stream.geofence.type === 'circle'
                ? `circle(${stream.geofence.radius}m)`
                : 'polygon'}
            </Badge>
          )}
          {(stream.uploadUsers ?? []).map((u) => (
            <Badge key={u} variant="default" className="text-xs font-mono">↑{u}</Badge>
          ))}
          {(stream.downloadUsers ?? []).map((u) => (
            <Badge key={u} variant="outline" className="text-xs font-mono">{u}</Badge>
          ))}
          {stream.smarkerOptions?.overlap && (
            <Badge variant="secondary" className="text-xs">
              overlap({stream.smarkerOptions.overlap}m)
            </Badge>
          )}
          {stream.smarkerOptions?.positionless && (
            <Badge variant="secondary" className="text-xs">positionless</Badge>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

// ── Stream Builder Form ────────────────────────────────────────────────────

function StreamBuilderForm({
  networkMountpoints,
  networks,
  users,
  groups,
  streams,
  onSave,
  onCancel,
}: {
  networkMountpoints: Record<string, { id: string; networkId: string; mountpoint: string }>
  networks: Record<string, { id: string; name: string }>
  users: Record<string, { name: string }>
  groups: Record<string, { name: string }>
  streams: Record<string, Stream>
  onSave: (stream: Stream) => void
  onCancel: () => void
}) {
  const [type, setType] = useState<StreamType>('pinput')
  const [name, setName] = useState('')
  const [networkMountpointId, setNetworkMountpointId] = useState('')
  const [manualUrl, setManualUrl] = useState('')
  const [useManualUrl, setUseManualUrl] = useState(false)
  const [downloadUsers, setDownloadUsers] = useState<string[]>([])
  const [uploadUsers, setUploadUsers] = useState<string[]>([])
  const [childMarkers, setChildMarkers] = useState<string[]>([])
  const [passNmea, setPassNmea] = useState(true)
  const [keepSource, setKeepSource] = useState(false)
  const [enabled, setEnabled] = useState(true)
  const [overlap, setOverlap] = useState('')
  const [positionless, setPositionless] = useState(false)
  const [noBalancing, setNoBalancing] = useState(false)
  const [tryRestart, setTryRestart] = useState('')
  const [error, setError] = useState<string | null>(null)

  const nmList = Object.values(networkMountpoints)
  const userList = Object.keys(users)
  const groupList = Object.keys(groups)
  const allPrincipals = [...userList, ...groupList]

  // Existing markers/streams available as smarker children
  const markerNames = Object.values(streams)
    .filter((s) => s.type === 'marker' || s.type === 'dmarker' || s.type === 'pinput' || s.type === 'input')
    .map((s) => s.name)

  const isPinputLike = type === 'pinput' || type === 'input' || type === 'dinput'
  const isMarkerLike = type === 'marker' || type === 'dmarker'
  const isSmarker    = type === 'smarker'

  const handleSave = () => {
    setError(null)
    if (!name.trim()) { setError('Mountpoint name is required'); return }
    if (!/^[A-Za-z0-9_]+$/.test(name)) {
      setError('Mountpoint: only letters, digits, underscore allowed')
      return
    }

    if (isPinputLike && !useManualUrl && !networkMountpointId) {
      setError('Please select a network mountpoint or enter a manual URL')
      return
    }
    if (isPinputLike && useManualUrl && !manualUrl.trim()) {
      setError('Manual URL is required')
      return
    }
    if (isSmarker && childMarkers.length < 2) {
      setError('smarker requires at least 2 child streams')
      return
    }

    const stream: Stream = {
      id: generateId(),
      type,
      name: name.toUpperCase().trim(),
      enabled,
      downloadUsers: downloadUsers.length > 0 ? downloadUsers : undefined,
      ...(isPinputLike && {
        networkMountpointId: useManualUrl ? undefined : networkMountpointId || undefined,
        url: useManualUrl ? manualUrl.trim() : undefined,
        passNmea: type === 'pinput' ? passNmea : undefined,
      }),
      ...(isMarkerLike && {
        uploadUsers: uploadUsers.length > 0 ? uploadUsers : undefined,
        keepSource: keepSource || undefined,
      }),
      ...(isSmarker && {
        childMarkers,
        smarkerOptions: {
          overlap: overlap ? parseInt(overlap) : undefined,
          positionless: positionless || undefined,
          noBalancing: noBalancing || undefined,
          tryRestart: tryRestart ? parseInt(tryRestart) : undefined,
        },
      }),
    }

    onSave(stream)
  }

  return (
    <Card className="border-[#0067ff]/30">
      <CardHeader className="pb-4">
        <CardTitle className="text-sm">New Stream</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {error && (
          <p className="text-xs text-red-600 bg-red-50 border border-red-200 p-2 rounded">{error}</p>
        )}

        {/* Type selector */}
        <div className="grid grid-cols-3 gap-2">
          {(['pinput', 'input', 'marker', 'smarker', 'dinput', 'dmarker'] as StreamType[]).map((t) => (
            <button
              key={t}
              onClick={() => setType(t)}
              className={`px-3 py-2 rounded text-xs font-mono border text-left transition-colors ${
                type === t
                  ? `${STREAM_TYPE_COLORS[t]} border-current`
                  : 'bg-gray-50 border-gray-200 text-gray-400 hover:border-slate-500'
              }`}
            >
              <div className="font-semibold">--{t}</div>
            </button>
          ))}
        </div>
        <p className="text-xs text-gray-400 -mt-3">{STREAM_TYPE_DESCRIPTIONS[type]}</p>

        {/* Name */}
        <div className="space-y-1.5">
          <Label>Mountpoint Name</Label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value.toUpperCase())}
            placeholder="SMART"
            className="font-mono uppercase w-56"
          />
          <p className="text-[10px] text-gray-400">Only letters, digits, underscore — automatically converted to uppercase</p>
        </div>

        {/* pinput/input/dinput fields */}
        {isPinputLike && (
          <>
            <div className="flex items-center gap-2">
              <Switch checked={useManualUrl} onCheckedChange={setUseManualUrl} />
              <Label className="cursor-pointer">Enter URL manually (expert mode)</Label>
            </div>

            {useManualUrl ? (
              <div className="space-y-1.5">
                <Label>URL</Label>
                <Input
                  value={manualUrl}
                  onChange={(e) => setManualUrl(e.target.value)}
                  placeholder="ntrip:AUTO/user:pass@host:2101"
                  className="font-mono text-xs"
                />
                <p className="text-[10px] text-gray-400">
                  Without single quotes — these are added automatically in the config.
                </p>
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label>Network Mountpoint (Data Source)</Label>
                <Select value={networkMountpointId} onValueChange={setNetworkMountpointId}>
                  <SelectTrigger className="w-72">
                    <SelectValue placeholder="Select network mountpoint..." />
                  </SelectTrigger>
                  <SelectContent>
                    {nmList.map((nm) => (
                      <SelectItem key={nm.id} value={nm.id}>
                        {nmLabel(nm.id, networkMountpoints, networks)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[10px] text-gray-400">URL is automatically generated from the network mountpoint</p>
              </div>
            )}

            {type === 'pinput' && (
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <Switch checked={passNmea} onCheckedChange={setPassNmea} />
                  <Label className="cursor-pointer">
                    Forward NMEA (<span className="font-mono text-xs">passnmea</span>)
                  </Label>
                </div>
                <p className="text-[10px] text-gray-400 ml-8">
                  Sends receiver position to upstream — required for AUTO mountpoints (nearest station)
                </p>
              </div>
            )}
          </>
        )}

        {/* marker/dmarker fields */}
        {isMarkerLike && (
          <>
            <MultiSelect
              label="Upload Users (allowed to upload data to this marker)"
              options={userList}
              selected={uploadUsers}
              onChange={setUploadUsers}
              placeholder="No users defined yet"
            />
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <Switch checked={keepSource} onCheckedChange={setKeepSource} />
                <Label className="cursor-pointer">
                  <span className="font-mono text-xs">keepsource</span> — keep stream when upload client disconnects
                </Label>
              </div>
            </div>
          </>
        )}

        {/* smarker fields */}
        {isSmarker && (
          <>
            <MultiSelect
              label="Child Streams (automatic selection from these)"
              options={markerNames}
              selected={childMarkers}
              onChange={setChildMarkers}
              placeholder="No marker/pinput/input streams defined yet"
            />
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>Overlap (meters, optional)</Label>
                <Input
                  type="number"
                  min={0}
                  value={overlap}
                  onChange={(e) => setOverlap(e.target.value)}
                  placeholder="0"
                  className="w-28"
                />
                <p className="text-[10px] text-gray-400">Hysteresis when switching stations</p>
              </div>
              <div className="space-y-1.5">
                <Label>Restart Interval (sec, optional)</Label>
                <Input
                  type="number"
                  min={0}
                  value={tryRestart}
                  onChange={(e) => setTryRestart(e.target.value)}
                  placeholder="—"
                  className="w-28"
                />
                <p className="text-[10px] text-gray-400">Retry interrupted streams</p>
              </div>
            </div>
            <div className="flex items-center gap-6">
              <div className="flex items-center gap-2">
                <Switch checked={positionless} onCheckedChange={setPositionless} />
                <Label className="cursor-pointer text-xs font-mono">positionless</Label>
              </div>
              <div className="flex items-center gap-2">
                <Switch checked={noBalancing} onCheckedChange={setNoBalancing} />
                <Label className="cursor-pointer text-xs font-mono">nobalancing</Label>
              </div>
            </div>
          </>
        )}

        {/* Common: download users */}
        <MultiSelect
          label="Download Users / Groups (empty = public)"
          options={allPrincipals}
          selected={downloadUsers}
          onChange={setDownloadUsers}
          placeholder="No users or groups defined yet"
        />

        {/* Common: enabled */}
        <div className="flex items-center gap-2">
          <Switch checked={enabled} onCheckedChange={setEnabled} />
          <Label className="cursor-pointer">Enabled</Label>
        </div>

        <div className="flex gap-2 justify-end pt-2 border-t border-gray-200">
          <Button variant="outline" size="sm" onClick={onCancel}>Cancel</Button>
          <Button size="sm" onClick={handleSave}>Add Stream</Button>
        </div>
      </CardContent>
    </Card>
  )
}

// ── Main Page ──────────────────────────────────────────────────────────────

export default function StreamsPage() {
  const streams = useConfigStore(selectStreams)
  const networks = useConfigStore(selectNetworks)
  const networkMountpoints = useConfigStore(selectNetworkMountpoints)
  const users = useConfigStore(selectUsers)
  const groups = useConfigStore(selectGroups)
  const addStream = useConfigStore((s) => s.addStream)
  const deleteStream = useConfigStore((s) => s.deleteStream)

  const [showForm, setShowForm] = useState(false)

  const streamList = Object.values(streams)

  const handleDelete = async (id: string) => {
    if (!confirm('Delete stream?')) return
    deleteStream(id)
    await fetch(`/api/wizard/data/streams?key=${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  const handleSave = async (stream: Stream) => {
    addStream(stream)
    await fetch('/api/wizard/data/streams', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: stream.id, value: streamToJSON(stream) }),
    })
    setShowForm(false)
  }

  return (
    <>
      <Header />
      <PageWrapper>
        <div className="flex items-center justify-between mb-2">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Streams</h2>
            <p className="text-sm text-gray-400">
              Advanced stream configuration (pinput, input, marker, smarker)
            </p>
          </div>
          {!showForm && (
            <Button size="sm" onClick={() => setShowForm(true)} className="gap-1.5">
              <Plus className="w-4 h-4" />
              Add Stream
            </Button>
          )}
        </div>

        <div className="p-4 rounded-lg bg-amber-50 border border-amber-200 flex items-start gap-3">
          <AlertCircle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
          <p className="text-sm text-gray-600">
            <strong>Note:</strong> For most use cases,{' '}
            <span className="font-mono text-xs bg-gray-100 px-1 rounded">pinput</span> streams are automatically generated from geo-zones.
            This page is for advanced stream types: <span className="font-mono text-xs bg-gray-100 px-1 rounded">marker</span> (local base station),{' '}
            <span className="font-mono text-xs bg-gray-100 px-1 rounded">smarker</span> (station selection/failover),{' '}
            <span className="font-mono text-xs bg-gray-100 px-1 rounded">input</span> with TCP/serial sources.
          </p>
        </div>

        {/* Builder form */}
        {showForm && (
          <StreamBuilderForm
            networkMountpoints={networkMountpoints}
            networks={networks}
            users={users}
            groups={groups}
            streams={streams}
            onSave={handleSave}
            onCancel={() => setShowForm(false)}
          />
        )}

        {/* Stream list */}
        {streamList.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-16">
              <Radio className="w-12 h-12 text-gray-400 mb-4" />
              <p className="text-gray-500 font-medium">No manual streams defined</p>
              <p className="text-gray-400 text-sm mt-1 text-center max-w-sm">
                Streams are automatically generated from geo-zones. Click &ldquo;Add Stream&rdquo; for advanced configuration.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div>
            <h3 className="text-sm font-semibold text-gray-500 mb-3 uppercase tracking-wider">
              {streamList.length} Stream{streamList.length !== 1 ? 's' : ''}
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {streamList.map((s) => (
                <StreamCard
                  key={s.id}
                  stream={s}
                  nmDisplayName={s.networkMountpointId ? nmLabel(s.networkMountpointId, networkMountpoints, networks) : undefined}
                  onDelete={handleDelete}
                />
              ))}
            </div>
          </div>
        )}
      </PageWrapper>
    </>
  )
}
