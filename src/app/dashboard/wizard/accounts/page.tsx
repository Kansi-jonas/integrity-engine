'use client'
import { useState } from 'react'
import { Plus, Pencil, Trash2, Eye, EyeOff, KeyRound, Users, Hash } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import Header from '@/components/layout/Header'
import PageWrapper from '@/components/layout/PageWrapper'
import { useConfigStore, selectAccounts, selectGroups } from '@/store/config-store'
import type { Account } from '@/lib/types'

// ── Account Form ──────────────────────────────────────────────────────────────

function AccountForm({
  initial,
  onSave,
  onCancel,
}: {
  initial?: Account
  onSave: (a: Account) => void
  onCancel: () => void
}) {
  const groups = useConfigStore(selectGroups)
  const groupNames = Object.keys(groups)

  const [users, setUsers] = useState(initial?.users ?? '')
  const [remoteUser, setRemoteUser] = useState(initial?.remoteUser ?? '')
  const [remotePassword, setRemotePassword] = useState(initial?.remotePassword ?? '')
  const [mountpoints, setMountpoints] = useState(initial?.mountpoints ?? 'AUTO')
  const [count, setCount] = useState<string>(initial?.count?.toString() ?? '')
  const [showPass, setShowPass] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})

  function validate() {
    const e: Record<string, string> = {}
    if (!users.trim()) e.users = 'Required'
    if (!remoteUser.trim()) e.remoteUser = 'Required'
    if (!remotePassword.trim()) e.remotePassword = 'Required'
    if (!mountpoints.trim()) e.mountpoints = 'Required'
    if (count && (isNaN(Number(count)) || Number(count) < 1)) e.count = 'Must be a positive integer'
    return e
  }

  function handleSave() {
    const e = validate()
    if (Object.keys(e).length > 0) { setErrors(e); return }
    onSave({
      id: initial?.id ?? `account_${Date.now()}`,
      users: users.trim(),
      remoteUser: remoteUser.trim(),
      remotePassword: remotePassword.trim(),
      mountpoints: mountpoints.trim(),
      count: count ? Number(count) : undefined,
    })
  }

  // Preview of the generated --account line
  const quoteIfNeeded = (s: string) => s.includes(':') ? `'${s}'` : s
  const preview = users && remoteUser && remotePassword && mountpoints
    ? `--account = ${users}:${quoteIfNeeded(remoteUser)}:${quoteIfNeeded(remotePassword)}:${mountpoints}${count ? `:${count}` : ''}`
    : ''

  return (
    <div className="space-y-4">
      {/* users */}
      <div className="space-y-1">
        <Label htmlFor="acc-users">Users / Groups</Label>
        <div className="flex gap-2">
          <Input
            id="acc-users"
            value={users}
            onChange={(e) => { setUsers(e.target.value); setErrors((prev) => ({ ...prev, users: '' })) }}
            placeholder="e.g. NewCustomers or user1,user2"
            className={errors.users ? 'border-red-400' : ''}
          />
          {groupNames.length > 0 && (
            <select
              className="text-xs border border-gray-200 rounded px-2 bg-white text-gray-600"
              defaultValue=""
              onChange={(e) => { if (e.target.value) setUsers(e.target.value) }}
            >
              <option value="">Pick group…</option>
              {groupNames.map((g) => <option key={g} value={g}>{g}</option>)}
            </select>
          )}
        </div>
        {errors.users && <p className="text-xs text-red-500">{errors.users}</p>}
        <p className="text-xs text-gray-400">Comma-separated user or group names that get this upstream credential</p>
      </div>

      {/* remote user */}
      <div className="space-y-1">
        <Label htmlFor="acc-ruser">Remote Username</Label>
        <Input
          id="acc-ruser"
          value={remoteUser}
          onChange={(e) => { setRemoteUser(e.target.value); setErrors((prev) => ({ ...prev, remoteUser: '' })) }}
          placeholder="e.g. rtkokc438"
          className={errors.remoteUser ? 'border-red-400' : ''}
        />
        {errors.remoteUser && <p className="text-xs text-red-500">{errors.remoteUser}</p>}
      </div>

      {/* remote password */}
      <div className="space-y-1">
        <Label htmlFor="acc-rpass">Remote Password</Label>
        <div className="relative">
          <Input
            id="acc-rpass"
            type={showPass ? 'text' : 'password'}
            value={remotePassword}
            onChange={(e) => { setRemotePassword(e.target.value); setErrors((prev) => ({ ...prev, remotePassword: '' })) }}
            placeholder="Upstream password"
            className={`pr-9 ${errors.remotePassword ? 'border-red-400' : ''}`}
          />
          <button
            type="button"
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
            onClick={() => setShowPass((v) => !v)}
          >
            {showPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          </button>
        </div>
        {errors.remotePassword && <p className="text-xs text-red-500">{errors.remotePassword}</p>}
        <p className="text-xs text-gray-400">Credentials are sent to the upstream NTRIP caster per connection</p>
      </div>

      {/* mountpoints */}
      <div className="space-y-1">
        <Label htmlFor="acc-mounts">Mountpoints</Label>
        <Input
          id="acc-mounts"
          value={mountpoints}
          onChange={(e) => { setMountpoints(e.target.value); setErrors((prev) => ({ ...prev, mountpoints: '' })) }}
          placeholder="e.g. AUTO or AUTO,AUTO_ITRF2020"
          className={errors.mountpoints ? 'border-red-400' : ''}
        />
        {errors.mountpoints && <p className="text-xs text-red-500">{errors.mountpoints}</p>}
        <p className="text-xs text-gray-400">Comma-separated upstream mountpoint names this credential applies to</p>
      </div>

      {/* count (optional) */}
      <div className="space-y-1">
        <Label htmlFor="acc-count">Max Concurrent Streams <span className="text-gray-400 font-normal">(optional)</span></Label>
        <Input
          id="acc-count"
          type="number"
          min={1}
          value={count}
          onChange={(e) => { setCount(e.target.value); setErrors((prev) => ({ ...prev, count: '' })) }}
          placeholder="e.g. 100 — blank = unlimited"
          className={`w-40 ${errors.count ? 'border-red-400' : ''}`}
        />
        {errors.count && <p className="text-xs text-red-500">{errors.count}</p>}
        <p className="text-xs text-gray-400">Floating license pool size — limits simultaneous upstream connections</p>
      </div>

      {/* Preview */}
      {preview && (
        <div className="bg-slate-900 rounded p-3">
          <p className="text-[10px] text-slate-500 mb-1 uppercase tracking-wider">Generated directive</p>
          <code className="text-xs text-green-400 font-mono break-all">{preview}</code>
        </div>
      )}

      <div className="flex gap-2 pt-2">
        <Button onClick={handleSave} size="sm" className="bg-[#0067ff] hover:bg-[#0052cc] text-white">
          {initial ? 'Save Changes' : 'Add Account'}
        </Button>
        <Button onClick={onCancel} variant="outline" size="sm">Cancel</Button>
      </div>
    </div>
  )
}

// ── Account Row ───────────────────────────────────────────────────────────────

function AccountRow({
  account,
  onEdit,
  onDelete,
}: {
  account: Account
  onEdit: () => void
  onDelete: () => void
}) {
  const [showPass, setShowPass] = useState(false)

  return (
    <tr className="border-b border-gray-100 hover:bg-gray-50 transition-colors">
      <td className="py-2.5 px-3">
        <div className="flex items-center gap-1.5">
          <Users className="w-3.5 h-3.5 text-[#0067ff] flex-shrink-0" />
          <span className="text-sm font-medium text-gray-800">{account.users}</span>
        </div>
      </td>
      <td className="py-2.5 px-3">
        <span className="text-sm font-mono text-gray-700">{account.remoteUser}</span>
      </td>
      <td className="py-2.5 px-3">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-mono text-gray-500">
            {showPass ? account.remotePassword : '••••••••'}
          </span>
          <button
            onClick={() => setShowPass((v) => !v)}
            className="text-gray-300 hover:text-gray-500"
          >
            {showPass ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
          </button>
        </div>
      </td>
      <td className="py-2.5 px-3">
        <div className="flex flex-wrap gap-1">
          {account.mountpoints.split(',').map((m) => (
            <Badge key={m} variant="secondary" className="text-[10px] px-1.5 py-0 font-mono">
              {m.trim()}
            </Badge>
          ))}
        </div>
      </td>
      <td className="py-2.5 px-3">
        {account.count != null ? (
          <div className="flex items-center gap-1 text-sm text-gray-700">
            <Hash className="w-3 h-3 text-gray-400" />
            {account.count}
          </div>
        ) : (
          <span className="text-xs text-gray-400">unlimited</span>
        )}
      </td>
      <td className="py-2.5 px-3">
        <div className="flex gap-1">
          <button onClick={onEdit} className="p-1 text-gray-400 hover:text-gray-600 rounded">
            <Pencil className="w-3.5 h-3.5" />
          </button>
          <button onClick={onDelete} className="p-1 text-gray-400 hover:text-red-500 rounded">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </td>
    </tr>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function AccountsPage() {
  const accounts = useConfigStore(selectAccounts)
  const { addAccount, updateAccount, deleteAccount } = useConfigStore()

  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)

  const accountList = Object.values(accounts)

  async function saveToServer(updated: Record<string, Account>) {
    try {
      const payload: Record<string, unknown> = {}
      for (const [k, a] of Object.entries(updated)) {
        payload[k] = {
          id: a.id,
          users: a.users,
          remote_user: a.remoteUser,
          remote_password: a.remotePassword,
          mountpoints: a.mountpoints,
          ...(a.count != null ? { count: a.count } : {}),
        }
      }
      await fetch('/api/wizard/data/accounts', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
    } catch { /* non-critical */ }
  }

  function handleAdd(a: Account) {
    addAccount(a)
    const updated = { ...accounts, [a.id]: a }
    saveToServer(updated)
    setShowForm(false)
  }

  function handleUpdate(a: Account) {
    updateAccount(a.id, a)
    const updated = { ...accounts, [a.id]: a }
    saveToServer(updated)
    setEditingId(null)
  }

  function handleDelete(id: string) {
    deleteAccount(id)
    const { [id]: _, ...rest } = accounts
    saveToServer(rest)
  }

  return (
    <PageWrapper>
      <Header />

      <div className="p-6 space-y-6 max-w-5xl">
        {/* Info banner */}
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 flex gap-3">
          <KeyRound className="w-5 h-5 text-blue-500 flex-shrink-0 mt-0.5" />
          <div className="text-sm text-blue-800 space-y-1">
            <p className="font-semibold">Floating License Model</p>
            <p>
              Each account maps a group of users to a single upstream credential with an optional concurrent stream limit.
              The caster uses <code className="bg-blue-100 px-1 rounded font-mono text-xs">$remoteuser</code> and{' '}
              <code className="bg-blue-100 px-1 rounded font-mono text-xs">$remotepassword</code> variables in{' '}
              <code className="bg-blue-100 px-1 rounded font-mono text-xs">--pinput</code> URLs to inject the right credential per connection.
            </p>
          </div>
        </div>

        {/* Add form */}
        {showForm && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold text-gray-700">New Account Mapping</CardTitle>
            </CardHeader>
            <CardContent>
              <AccountForm onSave={handleAdd} onCancel={() => setShowForm(false)} />
            </CardContent>
          </Card>
        )}

        {/* Table */}
        <Card>
          <CardHeader className="pb-3 flex flex-row items-center justify-between">
            <CardTitle className="text-sm font-semibold text-gray-700 flex items-center gap-2">
              <KeyRound className="w-4 h-4 text-[#0067ff]" />
              Account Mappings
              {accountList.length > 0 && (
                <Badge variant="secondary" className="ml-1">{accountList.length}</Badge>
              )}
            </CardTitle>
            {!showForm && (
              <Button
                size="sm"
                onClick={() => { setShowForm(true); setEditingId(null) }}
                className="bg-[#0067ff] hover:bg-[#0052cc] text-white h-7 text-xs"
              >
                <Plus className="w-3.5 h-3.5 mr-1" /> Add Account
              </Button>
            )}
          </CardHeader>
          <CardContent className="p-0">
            {accountList.length === 0 ? (
              <div className="text-center py-12 text-gray-400">
                <KeyRound className="w-8 h-8 mx-auto mb-2 opacity-30" />
                <p className="text-sm">No account mappings yet</p>
                <p className="text-xs mt-1">Add one to enable floating license pools</p>
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200 bg-gray-50">
                    <th className="text-left py-2 px-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Users / Groups</th>
                    <th className="text-left py-2 px-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Remote User</th>
                    <th className="text-left py-2 px-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Password</th>
                    <th className="text-left py-2 px-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Mountpoints</th>
                    <th className="text-left py-2 px-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Max Streams</th>
                    <th className="py-2 px-3" />
                  </tr>
                </thead>
                <tbody>
                  {accountList.map((account) =>
                    editingId === account.id ? (
                      <tr key={account.id} className="border-b border-gray-100 bg-blue-50/30">
                        <td colSpan={6} className="p-4">
                          <AccountForm
                            initial={account}
                            onSave={handleUpdate}
                            onCancel={() => setEditingId(null)}
                          />
                        </td>
                      </tr>
                    ) : (
                      <AccountRow
                        key={account.id}
                        account={account}
                        onEdit={() => { setEditingId(account.id); setShowForm(false) }}
                        onDelete={() => handleDelete(account.id)}
                      />
                    )
                  )}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      </div>
    </PageWrapper>
  )
}
