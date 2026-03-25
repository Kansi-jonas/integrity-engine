'use client'
import { useState } from 'react'
import { Plus, Pencil, Trash2, Wifi } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import Header from '@/components/layout/Header'
import PageWrapper from '@/components/layout/PageWrapper'
import { useConfigStore, selectNetworks, selectShowBackendDetails } from '@/store/config-store'
import { useNetworkLabel } from '@/hooks/useNetworkLabel'
import { networkToJSON, generateId } from '@/lib/utils'
import type { Network } from '@/lib/types'

// Known network presets
const NETWORK_PRESETS: Omit<Network, 'id'>[] = [
  { name: 'GEODNET', host: 'rtk.geodnet.com', port: 2101, protocol: 'ntrip' },
  { name: 'Onocoy', host: 'clients.onocoy.com', port: 2101, protocol: 'ntrip' },
]

function NetworkCard({ network, onEdit, onDelete, showDetails }: {
  network: Network
  onEdit: (n: Network) => void
  onDelete: (id: string) => void
  showDetails: boolean
}) {
  const label = useNetworkLabel(network.id)
  return (
    <Card className="hover:border-gray-300 transition-colors">
      <CardContent className="p-4">
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center">
              <Wifi className="w-4 h-4 text-blue-400" />
            </div>
            <div>
              <p className="font-semibold text-gray-800 text-sm">{label}</p>
              {showDetails ? (
                <p className="text-xs text-gray-400 font-mono">{network.host}:{network.port}</p>
              ) : (
                <p className="text-xs text-gray-400 font-mono">***:***</p>
              )}
            </div>
          </div>
          <div className="flex gap-1">
            <Button size="icon" variant="ghost" onClick={() => onEdit(network)}>
              <Pencil className="w-3.5 h-3.5" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              onClick={() => onDelete(network.id)}
              className="text-red-400 hover:text-red-600 hover:bg-red-50"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

const emptyForm = (): Partial<Network> => ({
  name: '', host: '', port: 2101,
})

export default function NetworksPage() {
  const networks = useConfigStore(selectNetworks)
  const showDetails = useConfigStore(selectShowBackendDetails)
  const addNetwork = useConfigStore((s) => s.addNetwork)
  const updateNetwork = useConfigStore((s) => s.updateNetwork)
  const deleteNetwork = useConfigStore((s) => s.deleteNetwork)

  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<Partial<Network>>(emptyForm())
  const [error, setError] = useState<string | null>(null)

  const networkList = Object.values(networks)

  const handleEdit = (n: Network) => {
    setEditingId(n.id)
    setForm({ ...n })
    setShowForm(true)
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Delete network? All network mountpoints and zones using this network will need updating.')) return
    deleteNetwork(id)
    await fetch(`/api/data/networks?key=${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  const handlePreset = (preset: Omit<Network, 'id'>) => {
    setEditingId(null)
    setForm({ ...preset, id: generateId() })
    setShowForm(true)
  }

  const handleSubmit = async () => {
    setError(null)
    if (!form.name?.trim()) { setError('Name is required'); return }
    if (!form.host?.trim()) { setError('Host is required'); return }

    const id = editingId ?? (form.id || generateId())
    const network: Network = {
      id,
      name: form.name!.trim(),
      host: form.host!.trim(),
      port: form.port ?? 2101,
      protocol: form.protocol ?? 'ntrip',
    }

    if (editingId) {
      updateNetwork(editingId, network)
    } else {
      addNetwork(network)
    }

    await fetch('/api/data/networks', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: id, value: networkToJSON(network) }),
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
            <h2 className="text-lg font-semibold text-gray-900">Networks</h2>
            <p className="text-sm text-gray-400">
              {networkList.length} network{networkList.length !== 1 ? 's' : ''} configured
            </p>
          </div>
          <Button size="sm" onClick={() => { setShowForm(true); setEditingId(null); setForm(emptyForm()) }} className="gap-1.5">
            <Plus className="w-4 h-4" />
            Add Network
          </Button>
        </div>

        {/* Section intro */}
        <div className="text-sm text-gray-500 bg-gray-50 border border-gray-200 rounded-lg p-3">
          <p>
            A <strong className="text-gray-700">Network</strong> is an upstream NTRIP caster endpoint (e.g. GEODNET or Onocoy).
            Only the connection details (host + port) are defined here. Mountpoints and credentials are managed separately.
          </p>
        </div>

        {/* Presets */}
        <div>
          <p className="text-xs text-gray-400 uppercase tracking-wider mb-2">Quick Add — Known Networks</p>
          <div className="flex flex-wrap gap-2">
            {NETWORK_PRESETS.map((preset) => (
              <Button
                key={preset.name}
                variant="outline"
                size="sm"
                onClick={() => handlePreset(preset)}
                className="gap-1.5 text-xs"
              >
                <Wifi className="w-3 h-3" />
                {preset.name}
              </Button>
            ))}
          </div>
        </div>

        {/* Form */}
        {showForm && (
          <Card className="border-blue-600/30">
            <CardHeader className="pb-4">
              <CardTitle className="text-sm">{editingId ? 'Edit Network' : 'New Network'}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {error && <p className="text-xs text-red-600 bg-red-50 p-2 rounded border border-red-200">{error}</p>}

              <div className="grid grid-cols-3 gap-4">
                <div className="space-y-1.5">
                  <Label>Name</Label>
                  <Input value={form.name ?? ''} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="GEODNET" />
                  <p className="text-xs text-gray-400">Display name for this network</p>
                </div>
                <div className="space-y-1.5">
                  <Label>Host</Label>
                  <Input value={form.host ?? ''} onChange={(e) => setForm({ ...form, host: e.target.value })} placeholder="rtk.geodnet.com" className="font-mono text-xs" />
                  <p className="text-xs text-gray-400">Hostname or IP of upstream caster</p>
                </div>
                <div className="space-y-1.5">
                  <Label>Port</Label>
                  <Input type="number" min={1} max={65535} value={form.port ?? 2101} onChange={(e) => setForm({ ...form, port: parseInt(e.target.value) })} className="w-28 font-mono" />
                  <p className="text-xs text-gray-400">Default: <span className="font-mono">2101</span></p>
                </div>
              </div>

              <div className="flex gap-2 justify-end">
                <Button variant="outline" size="sm" onClick={() => { setShowForm(false); setEditingId(null) }}>Cancel</Button>
                <Button size="sm" onClick={handleSubmit}>{editingId ? 'Save Changes' : 'Add Network'}</Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Network cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {networkList.map((n) => (
            <NetworkCard key={n.id} network={n} onEdit={handleEdit} onDelete={handleDelete} showDetails={showDetails} />
          ))}
          {networkList.length === 0 && (
            <div className="col-span-3 text-center py-12 text-gray-400 text-sm">
              <Wifi className="w-8 h-8 mx-auto mb-3 text-gray-300" />
              <p className="font-medium text-gray-500 mb-1">No networks configured yet</p>
              <p>Use the quick-add buttons above or click &ldquo;Add Network&rdquo;.</p>
            </div>
          )}
        </div>
      </PageWrapper>
    </>
  )
}
