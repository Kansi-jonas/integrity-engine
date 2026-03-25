'use client'
import { useState } from 'react'
import { Plus, Pencil, Trash2, Layers } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import Header from '@/components/layout/Header'
import PageWrapper from '@/components/layout/PageWrapper'
import { useConfigStore, selectNetworks, selectNetworkMountpoints } from '@/store/config-store'
import { useNetworkLabel } from '@/hooks/useNetworkLabel'
import { networkMountpointToJSON, generateId } from '@/lib/utils'
import type { NetworkMountpoint } from '@/lib/types'

// Presets reference network names — user must have the network created first
const NM_PRESETS: { label: string; networkName: string; mountpoint: string; passNmea: boolean }[] = [
  { label: 'GEODNET AUTO', networkName: 'GEODNET', mountpoint: 'AUTO', passNmea: true },
  { label: 'GEODNET AUTO_WGS84', networkName: 'GEODNET', mountpoint: 'AUTO_WGS84', passNmea: true },
  { label: 'GEODNET AUTO_ITRF2020', networkName: 'GEODNET', mountpoint: 'AUTO_ITRF2020', passNmea: true },
  { label: 'GEODNET AUTO_ITRF2014', networkName: 'GEODNET', mountpoint: 'AUTO_ITRF2014', passNmea: true },
  { label: 'Onocoy NRBY_ADV', networkName: 'Onocoy', mountpoint: 'NRBY_ADV', passNmea: true },
]

function NMCard({ nm, networkName, networkId, onEdit, onDelete }: {
  nm: NetworkMountpoint
  networkName: string
  networkId: string
  onEdit: (nm: NetworkMountpoint) => void
  onDelete: (id: string) => void
}) {
  const label = useNetworkLabel(networkId, networkName)
  return (
    <Card className="hover:border-gray-300 transition-colors">
      <CardContent className="p-4">
        <div className="flex items-start justify-between mb-2">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-violet-500/10 flex items-center justify-center">
              <Layers className="w-4 h-4 text-violet-400" />
            </div>
            <div>
              <p className="font-semibold text-gray-800 text-sm">{label} / {nm.mountpoint}</p>
              <p className="text-xs text-gray-400">Network Mountpoint</p>
            </div>
          </div>
          <div className="flex gap-1">
            <Button size="icon" variant="ghost" onClick={() => onEdit(nm)}>
              <Pencil className="w-3.5 h-3.5" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              onClick={() => onDelete(nm.id)}
              className="text-red-400 hover:text-red-600 hover:bg-red-50"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs text-gray-400">Forward NMEA</span>
          <div className={`w-1.5 h-1.5 rounded-full ${nm.passNmea ? 'bg-emerald-400' : 'bg-slate-600'}`} />
        </div>
      </CardContent>
    </Card>
  )
}

const emptyForm = (): Partial<NetworkMountpoint> => ({
  networkId: '', mountpoint: '', passNmea: true,
})

export default function NetworkMountpointsPage() {
  const networks = useConfigStore(selectNetworks)
  const networkMountpoints = useConfigStore(selectNetworkMountpoints)
  const addNetworkMountpoint = useConfigStore((s) => s.addNetworkMountpoint)
  const updateNetworkMountpoint = useConfigStore((s) => s.updateNetworkMountpoint)
  const deleteNetworkMountpoint = useConfigStore((s) => s.deleteNetworkMountpoint)

  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<Partial<NetworkMountpoint>>(emptyForm())
  const [error, setError] = useState<string | null>(null)

  const nmList = Object.values(networkMountpoints)
  const networkList = Object.values(networks)

  const handleEdit = (nm: NetworkMountpoint) => {
    setEditingId(nm.id)
    setForm({ ...nm })
    setShowForm(true)
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Delete network mountpoint? All RTKdata mountpoints referencing it will need updating.')) return
    deleteNetworkMountpoint(id)
    await fetch(`/api/wizard/data/network_mountpoints?key=${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  const handlePreset = (preset: typeof NM_PRESETS[0]) => {
    // Find the network by name
    const net = networkList.find((n) => n.name.toLowerCase() === preset.networkName.toLowerCase())
    if (!net) {
      setError(`Network "${preset.networkName}" not found. Create it first on the Networks page.`)
      return
    }
    setEditingId(null)
    setForm({ id: generateId(), networkId: net.id, mountpoint: preset.mountpoint, passNmea: preset.passNmea })
    setShowForm(true)
    setError(null)
  }

  const handleSubmit = async () => {
    setError(null)
    if (!form.networkId) { setError('Network is required'); return }
    if (!form.mountpoint?.trim()) { setError('Mountpoint is required'); return }
    if (!/^[A-Za-z0-9_]+$/.test(form.mountpoint ?? '')) {
      setError('Mountpoint: only letters, digits, underscore')
      return
    }

    const id = editingId ?? (form.id || generateId())
    const nm: NetworkMountpoint = {
      id,
      networkId: form.networkId!,
      mountpoint: form.mountpoint!.trim().toUpperCase(),
      passNmea: form.passNmea ?? true,
    }

    if (editingId) {
      updateNetworkMountpoint(editingId, nm)
    } else {
      addNetworkMountpoint(nm)
    }

    await fetch('/api/wizard/data/network_mountpoints', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: id, value: networkMountpointToJSON(nm) }),
    })

    setShowForm(false)
    setEditingId(null)
    setForm(emptyForm())
  }

  return (
    <>
      <Header />
      <PageWrapper>
        <div className="flex items-center justify-between mb-2">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Network Mountpoints</h2>
            <p className="text-sm text-gray-400">
              {nmList.length} mountpoint{nmList.length !== 1 ? 's' : ''} configured
            </p>
          </div>
          <Button size="sm" onClick={() => { setShowForm(true); setEditingId(null); setForm(emptyForm()) }} className="gap-1.5">
            <Plus className="w-4 h-4" />
            Add Network Mountpoint
          </Button>
        </div>

        {/* Section intro */}
        <div className="text-sm text-gray-500 bg-gray-50 border border-gray-200 rounded-lg p-3">
          <p>
            A <strong className="text-gray-700">Network Mountpoint</strong> combines a Network with a specific mountpoint name.
            These are the &ldquo;assets&rdquo; available for assignment to RTKdata Mountpoints. No credentials are defined here
            — those are managed per group on the Users &amp; Groups page.
          </p>
        </div>

        {/* Presets */}
        {networkList.length > 0 && (
          <div>
            <p className="text-xs text-gray-400 uppercase tracking-wider mb-2">Quick Add — Common Network Mountpoints</p>
            <div className="flex flex-wrap gap-2">
              {NM_PRESETS.map((preset) => (
                <Button
                  key={preset.label}
                  variant="outline"
                  size="sm"
                  onClick={() => handlePreset(preset)}
                  className="gap-1.5 text-xs"
                >
                  <Layers className="w-3 h-3" />
                  {preset.label}
                </Button>
              ))}
            </div>
          </div>
        )}

        {error && !showForm && <p className="text-xs text-red-600 bg-red-50 p-2 rounded border border-red-200">{error}</p>}

        {/* Form */}
        {showForm && (
          <Card className="border-blue-600/30">
            <CardHeader className="pb-4">
              <CardTitle className="text-sm">{editingId ? 'Edit Network Mountpoint' : 'New Network Mountpoint'}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {error && <p className="text-xs text-red-600 bg-red-50 p-2 rounded border border-red-200">{error}</p>}

              <div className="grid grid-cols-3 gap-4">
                <div className="space-y-1.5">
                  <Label>Network</Label>
                  <Select value={form.networkId ?? ''} onValueChange={(v) => setForm({ ...form, networkId: v })}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select network..." />
                    </SelectTrigger>
                    <SelectContent className="z-[9999]">
                      {networkList.map((n) => (
                        <SelectItem key={n.id} value={n.id}>{n.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-gray-400">Upstream NTRIP network</p>
                </div>
                <div className="space-y-1.5">
                  <Label>Mountpoint Name</Label>
                  <Input
                    value={form.mountpoint ?? ''}
                    onChange={(e) => setForm({ ...form, mountpoint: e.target.value.toUpperCase() })}
                    placeholder="AUTO"
                    className="font-mono uppercase"
                  />
                  <p className="text-xs text-gray-400">e.g. <span className="font-mono">AUTO</span>, <span className="font-mono">NRBY_ADV</span></p>
                </div>
                <div className="space-y-1.5 flex flex-col justify-center">
                  <div className="flex items-center gap-2">
                    <Switch checked={form.passNmea ?? true} onCheckedChange={(v) => setForm({ ...form, passNmea: v })} />
                    <Label>Forward NMEA (<span className="font-mono text-xs">passnmea</span>)</Label>
                  </div>
                  <p className="text-xs text-gray-400">
                    Required for nearest-station selection
                  </p>
                </div>
              </div>

              <div className="flex gap-2 justify-end">
                <Button variant="outline" size="sm" onClick={() => { setShowForm(false); setEditingId(null); setError(null) }}>Cancel</Button>
                <Button size="sm" onClick={handleSubmit}>{editingId ? 'Save Changes' : 'Add Network Mountpoint'}</Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {nmList.map((nm) => (
            <NMCard
              key={nm.id}
              nm={nm}
              networkId={nm.networkId}
              networkName={networks[nm.networkId]?.name ?? 'Unknown'}
              onEdit={handleEdit}
              onDelete={handleDelete}
            />
          ))}
          {nmList.length === 0 && (
            <div className="col-span-3 text-center py-12 text-gray-400 text-sm">
              <Layers className="w-8 h-8 mx-auto mb-3 text-gray-300" />
              <p className="font-medium text-gray-500 mb-1">No network mountpoints configured yet</p>
              <p>{networkList.length === 0
                ? 'Create a network first on the Networks page.'
                : 'Use the quick-add buttons above or click "Add Network Mountpoint".'
              }</p>
            </div>
          )}
        </div>
      </PageWrapper>
    </>
  )
}
