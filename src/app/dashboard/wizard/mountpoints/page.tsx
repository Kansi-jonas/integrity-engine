'use client'
import { useState, useMemo } from 'react'
import { Plus, Pencil, Trash2, Globe, ChevronUp, ChevronDown, X } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import Header from '@/components/layout/Header'
import PageWrapper from '@/components/layout/PageWrapper'
import { useConfigStore, selectMountpoints, selectNetworks, selectNetworkMountpoints } from '@/store/config-store'
import { mountpointToJSON, generateId } from '@/lib/utils'
import type { Mountpoint, MountpointBackendRef } from '@/lib/types'

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

function MountpointCard({
  mountpoint,
  networkMountpoints,
  networks,
  onEdit,
  onDelete,
  onToggle,
}: {
  mountpoint: Mountpoint
  networkMountpoints: Record<string, { networkId: string; mountpoint: string }>
  networks: Record<string, { name: string }>
  onEdit: (m: Mountpoint) => void
  onDelete: (id: string) => void
  onToggle: (id: string) => void
}) {
  const sortedBackends = [...mountpoint.backends].sort((a, b) => a.priority - b.priority)

  return (
    <Card className={`hover:border-gray-300 transition-colors ${!mountpoint.enabled ? 'opacity-60' : ''}`}>
      <CardContent className="p-4">
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-[#0067ff]/10 flex items-center justify-center">
              <Globe className="w-4 h-4 text-[#0067ff]" />
            </div>
            <div>
              <p className="font-semibold text-gray-800 text-sm font-mono">{mountpoint.name}</p>
              <p className="text-xs text-gray-400">{sortedBackends.length} Network Mountpoint{sortedBackends.length !== 1 ? 's' : ''}</p>
            </div>
          </div>
          <div className="flex gap-1 items-center">
            <Switch
              checked={mountpoint.enabled}
              onCheckedChange={() => onToggle(mountpoint.id)}
              className="mr-1"
            />
            <Button size="icon" variant="ghost" onClick={() => onEdit(mountpoint)}>
              <Pencil className="w-3.5 h-3.5" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              onClick={() => onDelete(mountpoint.id)}
              className="text-red-400 hover:text-red-600 hover:bg-red-50"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>

        {/* Network mountpoint cascade list */}
        <div className="space-y-1">
          <p className="text-[10px] text-gray-400 uppercase tracking-wider">Cascade (order = priority)</p>
          {sortedBackends.map((ref, i) => (
            <div key={ref.networkMountpointId} className="flex items-center gap-2 text-xs">
              <span className="w-4 text-right font-mono text-gray-300">{i + 1}.</span>
              <span className="text-gray-600">{nmLabel(ref.networkMountpointId, networkMountpoints, networks)}</span>
            </div>
          ))}
          {sortedBackends.length === 0 && (
            <p className="text-xs text-amber-500">No network mountpoints assigned</p>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

const emptyForm = (): { name: string; backends: MountpointBackendRef[]; enabled: boolean } => ({
  name: '', backends: [], enabled: true,
})

export default function MountpointsPage() {
  const mountpoints = useConfigStore(selectMountpoints)
  const networkMountpoints = useConfigStore(selectNetworkMountpoints)
  const networks = useConfigStore(selectNetworks)
  const addMountpoint = useConfigStore((s) => s.addMountpoint)
  const updateMountpoint = useConfigStore((s) => s.updateMountpoint)
  const deleteMountpoint = useConfigStore((s) => s.deleteMountpoint)

  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState(emptyForm())
  const [error, setError] = useState<string | null>(null)

  const mountpointList = Object.values(mountpoints)
  const nmList = useMemo(() => Object.values(networkMountpoints), [networkMountpoints])

  // Network mountpoints not yet in the form's list
  const availableNMs = useMemo(
    () => nmList.filter((nm) => !form.backends.some((ref) => ref.networkMountpointId === nm.id)),
    [nmList, form.backends],
  )

  const handleEdit = (m: Mountpoint) => {
    setEditingId(m.id)
    setForm({ name: m.name, backends: [...m.backends], enabled: m.enabled })
    setShowForm(true)
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Delete mountpoint? Customers using this mountpoint will lose access.')) return
    deleteMountpoint(id)
    await fetch(`/api/wizard/data/mountpoints?key=${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  const handleToggle = async (id: string) => {
    const mp = mountpoints[id]
    if (!mp) return
    const updated = { ...mp, enabled: !mp.enabled }
    updateMountpoint(id, { enabled: !mp.enabled })
    await fetch('/api/wizard/data/mountpoints', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: id, value: mountpointToJSON(updated) }),
    })
  }

  const addNMToForm = (nmId: string) => {
    const nextPriority = form.backends.length > 0
      ? Math.max(...form.backends.map((r) => r.priority)) + 1
      : 1
    setForm({ ...form, backends: [...form.backends, { networkMountpointId: nmId, priority: nextPriority }] })
  }

  const removeNMFromForm = (nmId: string) => {
    const filtered = form.backends.filter((r) => r.networkMountpointId !== nmId)
    const renumbered = filtered.map((r, i) => ({ ...r, priority: i + 1 }))
    setForm({ ...form, backends: renumbered })
  }

  const moveNM = (nmId: string, direction: 'up' | 'down') => {
    const sorted = [...form.backends].sort((a, b) => a.priority - b.priority)
    const idx = sorted.findIndex((r) => r.networkMountpointId === nmId)
    if (idx === -1) return
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1
    if (swapIdx < 0 || swapIdx >= sorted.length) return
    const temp = sorted[idx].priority
    sorted[idx] = { ...sorted[idx], priority: sorted[swapIdx].priority }
    sorted[swapIdx] = { ...sorted[swapIdx], priority: temp }
    setForm({ ...form, backends: sorted })
  }

  const handleSubmit = async () => {
    setError(null)
    if (!form.name?.trim()) { setError('Mountpoint name is required'); return }
    if (!/^[A-Za-z0-9_]+$/.test(form.name.trim())) {
      setError('Mountpoint name: only letters, digits, underscore')
      return
    }
    if (form.backends.length === 0) { setError('At least one network mountpoint must be assigned'); return }

    const id = editingId ?? generateId()
    const mountpoint: Mountpoint = {
      id,
      name: form.name.trim().toUpperCase(),
      backends: form.backends,
      enabled: form.enabled,
    }

    if (editingId) {
      updateMountpoint(editingId, mountpoint)
    } else {
      addMountpoint(mountpoint)
    }

    await fetch('/api/wizard/data/mountpoints', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: id, value: mountpointToJSON(mountpoint) }),
    })

    setShowForm(false)
    setEditingId(null)
    setForm(emptyForm())
  }

  const sortedFormBackends = [...form.backends].sort((a, b) => a.priority - b.priority)

  return (
    <>
      <Header />
      <PageWrapper>
        <div className="flex items-center justify-between mb-2">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">RTKdata Mountpoints</h2>
            <p className="text-sm text-gray-400">
              {mountpointList.length} mountpoint{mountpointList.length !== 1 ? 's' : ''} configured
            </p>
          </div>
          <Button size="sm" onClick={() => { setShowForm(true); setEditingId(null); setForm(emptyForm()) }} className="gap-1.5">
            <Plus className="w-4 h-4" />
            Add New Mountpoint
          </Button>
        </div>

        {/* Section intro */}
        <div className="text-sm text-gray-500 bg-gray-50 border border-gray-200 rounded-lg p-3">
          <p>
            An <strong className="text-gray-700">RTKdata Mountpoint</strong> is the name under which customers receive correction data
            (e.g. <code className="text-xs font-mono bg-gray-100 px-1 rounded">SMART</code>).
            Each mountpoint references one or more <strong className="text-gray-700">Network Mountpoints</strong> in a
            prioritized order — the <strong className="text-gray-700">Cascade</strong>. The caster
            evaluates <code className="text-xs font-mono bg-gray-100 px-1 rounded">--pinput</code> directives top to bottom;
            the first line whose geo-fence matches the GGA position wins.
          </p>
        </div>

        {/* Form */}
        {showForm && (
          <Card className="border-blue-600/30">
            <CardHeader className="pb-4">
              <CardTitle className="text-sm">{editingId ? 'Edit Mountpoint' : 'New RTKdata Mountpoint'}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {error && <p className="text-xs text-red-600 bg-red-50 p-2 rounded border border-red-200">{error}</p>}

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label>Mountpoint Name</Label>
                  <Input
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value.toUpperCase() })}
                    placeholder="SMART"
                    className="font-mono uppercase"
                  />
                  <p className="text-xs text-gray-400">The name customers connect to (A-Z, 0-9, _ only)</p>
                </div>
                <div className="space-y-1.5">
                  <Label>Status</Label>
                  <div className="flex items-center gap-2 pt-1">
                    <Switch checked={form.enabled} onCheckedChange={(v) => setForm({ ...form, enabled: v })} />
                    <span className="text-sm text-gray-600">{form.enabled ? 'Active' : 'Disabled'}</span>
                  </div>
                </div>
              </div>

              {/* Network mountpoint cascade */}
              <div className="space-y-2">
                <Label>Network Mountpoint Cascade (order = priority)</Label>
                <p className="text-xs text-gray-400">
                  The caster checks network mountpoints top to bottom. The first matching geo-zone wins.
                  Specific regions (e.g. Onocoy polygons) should be at the top, global fallbacks (e.g. GEODNET circle) at the bottom.
                </p>

                {sortedFormBackends.length > 0 && (
                  <div className="border border-gray-200 rounded-lg overflow-hidden">
                    {sortedFormBackends.map((ref, i) => (
                      <div key={ref.networkMountpointId} className="flex items-center gap-2 px-3 py-2 border-b border-gray-100 last:border-0">
                        <span className="w-5 text-right font-mono text-xs text-gray-400">{i + 1}.</span>
                        <span className="flex-1 text-sm text-gray-700">{nmLabel(ref.networkMountpointId, networkMountpoints, networks)}</span>
                        <div className="flex items-center gap-0.5">
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-6 w-6"
                            disabled={i === 0}
                            onClick={() => moveNM(ref.networkMountpointId, 'up')}
                          >
                            <ChevronUp className="w-3.5 h-3.5" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-6 w-6"
                            disabled={i === sortedFormBackends.length - 1}
                            onClick={() => moveNM(ref.networkMountpointId, 'down')}
                          >
                            <ChevronDown className="w-3.5 h-3.5" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-6 w-6 text-red-400 hover:text-red-500"
                            onClick={() => removeNMFromForm(ref.networkMountpointId)}
                          >
                            <X className="w-3.5 h-3.5" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {availableNMs.length > 0 && (
                  <div className="flex items-center gap-2">
                    <Select onValueChange={addNMToForm}>
                      <SelectTrigger className="w-72 h-8 text-sm">
                        <SelectValue placeholder="Add network mountpoint..." />
                      </SelectTrigger>
                      <SelectContent>
                        {availableNMs.map((nm) => (
                          <SelectItem key={nm.id} value={nm.id}>
                            {nmLabel(nm.id, networkMountpoints, networks)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                {nmList.length === 0 && (
                  <p className="text-xs text-amber-500">
                    No network mountpoints available. Please create them under &ldquo;Network Mountpoints&rdquo; first.
                  </p>
                )}
              </div>

              <div className="flex gap-2 justify-end">
                <Button variant="outline" size="sm" onClick={() => { setShowForm(false); setEditingId(null) }}>Cancel</Button>
                <Button size="sm" onClick={handleSubmit}>{editingId ? 'Save Changes' : 'Add Mountpoint'}</Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Mountpoint cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {mountpointList.map((m) => (
            <MountpointCard
              key={m.id}
              mountpoint={m}
              networkMountpoints={networkMountpoints}
              networks={networks}
              onEdit={handleEdit}
              onDelete={handleDelete}
              onToggle={handleToggle}
            />
          ))}
          {mountpointList.length === 0 && (
            <div className="col-span-3 text-center py-12 text-gray-400 text-sm">
              <Globe className="w-8 h-8 mx-auto mb-3 text-gray-300" />
              <p className="font-medium text-gray-500 mb-1">No mountpoints configured yet</p>
              <p>Click &ldquo;Add New Mountpoint&rdquo; to create the first RTKdata mountpoint.</p>
            </div>
          )}
        </div>
      </PageWrapper>
    </>
  )
}
