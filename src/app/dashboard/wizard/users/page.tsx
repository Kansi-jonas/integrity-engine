'use client'
import { useState, useMemo } from 'react'
import {
  Plus,
  Pencil,
  Trash2,
  Eye,
  EyeOff,
  ShieldCheck,
  Clock,
  User,
  Users,
  X,
  Check,
  Search,
  ChevronLeft,
  ChevronRight,
  KeyRound,
} from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import Header from '@/components/layout/Header'
import PageWrapper from '@/components/layout/PageWrapper'
import { useConfigStore, selectUsers, selectGroups, selectNetworks } from '@/store/config-store'
import { userToJSON, groupToJSON } from '@/lib/utils'
import type { User as UserType, Group, GroupCredential } from '@/lib/types'

function generatePassword(length = 16): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$'
  return Array.from({ length }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
}

// ── User Row ───────────────────────────────────────────────────────────────

function UserRow({
  user,
  memberOf,
  onEdit,
  onDelete,
}: {
  user: UserType
  memberOf: string[]
  onEdit: (u: UserType) => void
  onDelete: (name: string) => void
}) {
  const [showPassword, setShowPassword] = useState(false)

  return (
    <tr className="border-b border-gray-200 hover:bg-gray-50 transition-colors">
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-full bg-gray-100 flex items-center justify-center">
            <User className="w-3.5 h-3.5 text-gray-500" />
          </div>
          <span className="text-sm font-medium text-gray-800 font-mono">{user.name}</span>
        </div>
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-xs text-gray-500">
            {showPassword ? user.password : '•'.repeat(Math.min(user.password.length, 12))}
          </span>
          <button
            onClick={() => setShowPassword(!showPassword)}
            className="text-gray-400 hover:text-gray-700"
          >
            {showPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
          </button>
        </div>
      </td>
      <td className="px-4 py-3">
        <span className="text-sm text-gray-500 font-mono">
          {user.maxStreams === 0 ? '∞' : user.maxStreams}
        </span>
      </td>
      <td className="px-4 py-3">
        <div className="flex flex-wrap gap-1">
          {user.isAdmin && (
            <Badge variant="default" className="text-xs gap-1">
              <ShieldCheck className="w-2.5 h-2.5" /> Admin
            </Badge>
          )}
          {user.noLog && <Badge variant="secondary" className="text-xs">NoLog</Badge>}
          {(user.timeStart || user.timeEnd) && (
            <Badge variant="warning" className="text-xs gap-1">
              <Clock className="w-2.5 h-2.5" /> Time-limited
            </Badge>
          )}
          {memberOf.map((g) => (
            <Badge key={g} variant="outline" className="text-xs">{g}</Badge>
          ))}
        </div>
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-1 justify-end">
          <Button size="icon" variant="ghost" onClick={() => onEdit(user)}>
            <Pencil className="w-3.5 h-3.5" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            onClick={() => onDelete(user.name)}
            className="text-red-400 hover:text-red-600 hover:bg-red-50"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </Button>
        </div>
      </td>
    </tr>
  )
}

// ── Group Form ─────────────────────────────────────────────────────────────

function GroupForm({
  initial,
  users,
  groups,
  networks,
  onSave,
  onCancel,
}: {
  initial: Partial<Group> | null
  users: Record<string, UserType>
  groups: Record<string, Group>
  networks: Record<string, { id: string; name: string }>
  onSave: (g: Group) => void
  onCancel: () => void
}) {
  const isEditing = !!initial?.name
  const [name, setName] = useState(initial?.name ?? '')
  const [members, setMembers] = useState<string[]>(initial?.users ?? [])
  const [credentials, setCredentials] = useState<GroupCredential[]>(initial?.credentials ?? [])
  const [error, setError] = useState<string | null>(null)

  const availableUsers = Object.keys(users)
  const availableGroups = Object.keys(groups).filter((g) => g !== initial?.name)
  const allAvailable = [...availableUsers, ...availableGroups]

  const networkList = Object.values(networks)
  const availableNetworksForCred = networkList.filter(
    (n) => !credentials.some((c) => c.networkId === n.id),
  )

  const toggleMember = (m: string) => {
    setMembers((prev) =>
      prev.includes(m) ? prev.filter((x) => x !== m) : [...prev, m],
    )
  }

  const addCredential = (networkId: string) => {
    setCredentials([...credentials, { networkId, username: '', password: '' }])
  }

  const updateCredential = (index: number, field: keyof GroupCredential, value: string) => {
    const updated = [...credentials]
    updated[index] = { ...updated[index], [field]: value }
    setCredentials(updated)
  }

  const removeCredential = (index: number) => {
    setCredentials(credentials.filter((_, i) => i !== index))
  }

  const handleSave = () => {
    setError(null)
    if (!name.trim()) { setError('Group name is required'); return }
    if (!/^[A-Za-z0-9_]+$/.test(name)) {
      setError('Group name: only letters, digits, underscore')
      return
    }
    if (!isEditing && name.trim() in groups) {
      setError(`Group "${name.trim()}" already exists`)
      return
    }
    onSave({ name: name.trim(), users: members, geofences: initial?.geofences ?? [], credentials })
  }

  return (
    <Card className="border-[#0067ff]/30">
      <CardHeader className="pb-4">
        <CardTitle className="text-sm">{isEditing ? `Edit Group: ${initial?.name}` : 'New Group'}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <p className="text-xs text-red-600 bg-red-50 border border-red-200 p-2 rounded">{error}</p>
        )}

        <div className="space-y-1.5">
          <Label>Group Name</Label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="NewCustomers"
            disabled={isEditing}
            className="font-mono w-56"
          />
          {!isEditing && <p className="text-[10px] text-gray-400">Letters, digits, underscore only. Cannot be changed after creation.</p>}
        </div>

        <div className="space-y-1.5">
          <Label>Members <span className="text-gray-400 font-normal">({members.length} selected)</span></Label>
          {allAvailable.length === 0 ? (
            <p className="text-xs text-gray-400 italic">No users or groups defined yet.</p>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5 max-h-48 overflow-y-auto p-1">
              {allAvailable.map((m) => {
                const isUser = m in users
                const selected = members.includes(m)
                return (
                  <button
                    key={m}
                    onClick={() => toggleMember(m)}
                    className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-mono text-left border transition-colors ${
                      selected
                        ? 'bg-[#e8f0fe] border-[#0067ff]/40 text-[#0067ff]'
                        : 'bg-gray-50 border-gray-200 text-gray-500 hover:border-slate-500'
                    }`}
                  >
                    {selected ? (
                      <Check className="w-3 h-3 flex-shrink-0" />
                    ) : (
                      <div className="w-3 h-3 flex-shrink-0" />
                    )}
                    <span className="truncate">{m}</span>
                    {!isUser && (
                      <span className="text-[9px] text-gray-400 ml-auto flex-shrink-0">grp</span>
                    )}
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {/* Network Credentials */}
        <div className="space-y-2">
          <Label className="flex items-center gap-1.5">
            <KeyRound className="w-3.5 h-3.5 text-gray-400" />
            Network Credentials
          </Label>
          <p className="text-[10px] text-gray-400">
            Username/password for upstream NTRIP networks. Each group can have different credentials (floating license model).
          </p>

          {credentials.length > 0 && (
            <div className="space-y-2">
              {credentials.map((cred, i) => {
                const netName = networks[cred.networkId]?.name ?? cred.networkId
                return (
                  <div key={i} className="flex items-center gap-2 p-2 border border-gray-200 rounded-lg bg-gray-50">
                    <span className="text-xs font-semibold text-gray-700 w-24 truncate">{netName}</span>
                    <Input
                      value={cred.username}
                      onChange={(e) => updateCredential(i, 'username', e.target.value)}
                      placeholder="Username"
                      className="h-7 text-xs font-mono flex-1"
                    />
                    <Input
                      value={cred.password}
                      onChange={(e) => updateCredential(i, 'password', e.target.value)}
                      placeholder="Password"
                      className="h-7 text-xs font-mono flex-1"
                    />
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6 text-red-400 hover:text-red-600 flex-shrink-0"
                      onClick={() => removeCredential(i)}
                    >
                      <X className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                )
              })}
            </div>
          )}

          {availableNetworksForCred.length > 0 && (
            <Select onValueChange={addCredential}>
              <SelectTrigger className="w-56 h-8 text-xs">
                <SelectValue placeholder="Add credentials for network..." />
              </SelectTrigger>
              <SelectContent>
                {availableNetworksForCred.map((n) => (
                  <SelectItem key={n.id} value={n.id}>{n.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          {networkList.length === 0 && (
            <p className="text-xs text-amber-500">No networks defined yet. Create them on the Networks page first.</p>
          )}
        </div>

        {(initial?.geofences?.length ?? 0) > 0 && (
          <p className="text-xs text-gray-400">
            {initial!.geofences!.length} geo-fence(s) attached (managed via Zone map)
          </p>
        )}

        <div className="flex gap-2 justify-end pt-2">
          <Button variant="outline" size="sm" onClick={onCancel}>Cancel</Button>
          <Button size="sm" onClick={handleSave}>
            {isEditing ? 'Save Changes' : 'Add Group'}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

// ── Group Card ─────────────────────────────────────────────────────────────

const GROUP_MEMBERS_PER_PAGE = 50

function GroupCard({
  group,
  users,
  networks,
  onEdit,
  onDelete,
}: {
  group: Group
  users: Record<string, UserType>
  networks: Record<string, { name: string }>
  onEdit: (g: Group) => void
  onDelete: (name: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [membersPage, setMembersPage] = useState(1)

  const totalPages = Math.ceil(group.users.length / GROUP_MEMBERS_PER_PAGE)
  const pagedMembers = group.users.slice(
    (membersPage - 1) * GROUP_MEMBERS_PER_PAGE,
    membersPage * GROUP_MEMBERS_PER_PAGE,
  )

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-2 mb-3">
          <button
            className="flex items-center gap-1.5 text-left hover:opacity-80 transition-opacity"
            onClick={() => { setExpanded(!expanded); setMembersPage(1) }}
          >
            <Users className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
            <span className="font-semibold text-gray-800 font-mono text-sm">{group.name}</span>
          </button>
          <div className="flex items-center gap-0.5">
            <Button size="icon" variant="ghost" onClick={() => onEdit(group)} className="h-7 w-7">
              <Pencil className="w-3 h-3" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              onClick={() => onDelete(group.name)}
              className="h-7 w-7 text-red-400 hover:text-red-600 hover:bg-red-50"
            >
              <Trash2 className="w-3 h-3" />
            </Button>
          </div>
        </div>

        {/* Metadata row */}
        <div className="flex items-center gap-3 text-xs text-gray-400">
          <button
            className="hover:text-gray-700 transition-colors underline-offset-2 hover:underline"
            onClick={() => { setExpanded(!expanded); setMembersPage(1) }}
          >
            {group.users.length === 0
              ? 'No members'
              : `${group.users.length} member${group.users.length !== 1 ? 's' : ''}`}
          </button>
          {group.geofences.length > 0 && (
            <span>{group.geofences.length} geo-fence{group.geofences.length !== 1 ? 's' : ''}</span>
          )}
          {group.credentials.length > 0 && (
            <span className="flex items-center gap-1">
              <KeyRound className="w-3 h-3" />
              {group.credentials.length} credential{group.credentials.length !== 1 ? 's' : ''}
            </span>
          )}
        </div>

        {/* Credential badges */}
        {group.credentials.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2">
            {group.credentials.map((cred) => (
              <Badge key={cred.networkId} variant="secondary" className="text-xs gap-1">
                <KeyRound className="w-2.5 h-2.5" />
                {networks[cred.networkId]?.name ?? cred.networkId}
              </Badge>
            ))}
          </div>
        )}

        {/* Expandable member list */}
        {expanded && group.users.length > 0 && (
          <div className="mt-3 border-t border-gray-100 pt-3">
            <div className="flex flex-wrap gap-1 mb-2">
              {pagedMembers.map((u) => {
                const isUser = u in users
                return (
                  <Badge key={u} variant={isUser ? 'outline' : 'secondary'} className="text-xs font-mono">
                    {u}
                    {!isUser && <span className="text-gray-400 ml-1 text-[9px]">grp</span>}
                  </Badge>
                )
              })}
            </div>
            {totalPages > 1 && (
              <div className="flex items-center gap-1 mt-2">
                <button
                  onClick={() => setMembersPage((p) => Math.max(1, p - 1))}
                  disabled={membersPage === 1}
                  className="p-0.5 rounded text-gray-400 hover:text-gray-700 disabled:opacity-30"
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                </button>
                <span className="text-[10px] text-gray-400">
                  {membersPage}/{totalPages}
                </span>
                <button
                  onClick={() => setMembersPage((p) => Math.min(totalPages, p + 1))}
                  disabled={membersPage === totalPages}
                  className="p-0.5 rounded text-gray-400 hover:text-gray-700 disabled:opacity-30"
                >
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ── Main Page ──────────────────────────────────────────────────────────────

const USERS_PER_PAGE = 50

export default function UsersPage() {
  const users = useConfigStore(selectUsers)
  const groups = useConfigStore(selectGroups)
  const networks = useConfigStore(selectNetworks)
  const addUser = useConfigStore((s) => s.addUser)
  const updateUser = useConfigStore((s) => s.updateUser)
  const deleteUser = useConfigStore((s) => s.deleteUser)
  const addGroup = useConfigStore((s) => s.addGroup)
  const updateGroup = useConfigStore((s) => s.updateGroup)
  const deleteGroup = useConfigStore((s) => s.deleteGroup)

  // ── User form state ──
  const [showUserForm, setShowUserForm] = useState(false)
  const [editingUser, setEditingUser] = useState<UserType | null>(null)
  const [userForm, setUserForm] = useState<Partial<UserType>>({
    name: '', password: '', maxStreams: 1, isAdmin: false, noLog: false,
    timeStart: null, timeEnd: null,
  })
  const [userError, setUserError] = useState<string | null>(null)

  // ── Group form state ──
  const [showGroupForm, setShowGroupForm] = useState(false)
  const [editingGroup, setEditingGroup] = useState<Group | null>(null)

  // ── Search & pagination ──
  const [searchQuery, setSearchQuery] = useState('')
  const [currentPage, setCurrentPage] = useState(1)

  const allUsers = Object.values(users)

  const filteredUsers = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return allUsers
    return allUsers.filter((u) => u.name.toLowerCase().includes(q))
  }, [allUsers, searchQuery])

  const filteredGroups = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return Object.values(groups)
    return Object.values(groups).filter(
      (g) =>
        g.name.toLowerCase().includes(q) ||
        g.users.some((m) => m.toLowerCase().includes(q)),
    )
  }, [groups, searchQuery])

  const totalPages = Math.max(1, Math.ceil(filteredUsers.length / USERS_PER_PAGE))
  const pagedUsers = filteredUsers.slice((currentPage - 1) * USERS_PER_PAGE, currentPage * USERS_PER_PAGE)

  const handleSearch = (q: string) => {
    setSearchQuery(q)
    setCurrentPage(1)
  }

  const userList = allUsers

  const userMemberOf = (name: string) =>
    Object.values(groups)
      .filter((g) => g.users.includes(name))
      .map((g) => g.name)

  // ── User handlers ──

  const handleEditUser = (user: UserType) => {
    setEditingUser(user)
    setUserForm({ ...user })
    setShowUserForm(true)
  }

  const handleDeleteUser = async (name: string) => {
    if (!confirm(`Delete user "${name}"?`)) return
    deleteUser(name)
    await fetch(`/api/wizard/data/users?key=${encodeURIComponent(name)}`, { method: 'DELETE' })
  }

  const handleSubmitUser = async () => {
    setUserError(null)
    if (!userForm.name?.trim()) { setUserError('Username is required'); return }
    if (!userForm.password?.trim()) { setUserError('Password is required'); return }
    if (!/^[A-Za-z0-9_\-\.]+$/.test(userForm.name)) {
      setUserError('Username: only letters, digits, underscore, hyphen, dot')
      return
    }
    if (!editingUser && users[userForm.name.trim()]) {
      setUserError(`User "${userForm.name.trim()}" already exists`)
      return
    }

    const user: UserType = {
      name: userForm.name.trim(),
      password: userForm.password.trim(),
      maxStreams: userForm.maxStreams ?? 1,
      isAdmin: userForm.isAdmin ?? false,
      noLog: userForm.noLog ?? false,
      timeStart: userForm.timeStart || null,
      timeEnd: userForm.timeEnd || null,
    }

    if (editingUser) {
      updateUser(editingUser.name, user)
    } else {
      addUser(user)
    }

    await fetch('/api/wizard/data/users', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: user.name, value: userToJSON(user) }),
    })

    setShowUserForm(false)
    setEditingUser(null)
    setUserForm({ name: '', password: '', maxStreams: 1, isAdmin: false, noLog: false, timeStart: null, timeEnd: null })
  }

  // ── Group handlers ──

  const handleEditGroup = (group: Group) => {
    setEditingGroup(group)
    setShowGroupForm(true)
  }

  const handleDeleteGroup = async (name: string) => {
    if (!confirm(`Delete group "${name}"? This will not delete its members.`)) return
    deleteGroup(name)
    await fetch(`/api/wizard/data/groups?key=${encodeURIComponent(name)}`, { method: 'DELETE' })
  }

  const handleSaveGroup = async (group: Group) => {
    if (editingGroup) {
      updateGroup(editingGroup.name, group)
    } else {
      addGroup(group)
    }

    await fetch('/api/wizard/data/groups', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: group.name, value: groupToJSON(group) }),
    })

    setShowGroupForm(false)
    setEditingGroup(null)
  }

  return (
    <>
      <Header />
      <PageWrapper>
        {/* ── Users section ── */}
        <div className="flex items-center justify-between mb-2">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Users & Groups</h2>
            <p className="text-sm text-gray-400">
              Only defined users can download or upload data streams. &middot;&nbsp;
              {userList.length} user{userList.length !== 1 ? 's' : ''} &middot; {Object.keys(groups).length} group{Object.keys(groups).length !== 1 ? 's' : ''}
            </p>
          </div>
          <Button
            size="sm"
            onClick={() => { setShowUserForm(true); setEditingUser(null) }}
            className="gap-1.5"
          >
            <Plus className="w-4 h-4" />
            Add User
          </Button>
        </div>

        {/* User form */}
        {showUserForm && (
          <Card className="border-[#0067ff]/30">
            <CardHeader className="pb-4">
              <CardTitle className="text-sm">{editingUser ? 'Edit User' : 'New User'}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {userError && (
                <p className="text-xs text-red-600 bg-red-50 border border-red-200 p-2 rounded">{userError}</p>
              )}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label>Username</Label>
                  <Input
                    value={userForm.name ?? ''}
                    onChange={(e) => setUserForm({ ...userForm, name: e.target.value })}
                    placeholder="customer1"
                    disabled={!!editingUser}
                    className="font-mono"
                  />
                  {!editingUser && (
                    <p className="text-[10px] text-gray-400">Letters, digits, underscore, hyphen, dot. Cannot be changed after saving.</p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label>Password</Label>
                  <div className="flex gap-1.5">
                    <Input
                      value={userForm.password ?? ''}
                      onChange={(e) => setUserForm({ ...userForm, password: e.target.value })}
                      placeholder="Secure password"
                      className="font-mono"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setUserForm({ ...userForm, password: generatePassword() })}
                    >
                      Random
                    </Button>
                  </div>
                  <p className="text-[10px] text-gray-400">Plaintext or hashed value (starts with <span className="font-mono">$</span>). Hash via <span className="font-mono">ntrips --getpwdhash</span>.</p>
                </div>
                <div className="space-y-1.5">
                  <Label>Max Streams (0 = unlimited)</Label>
                  <Input
                    type="number"
                    min={0}
                    value={userForm.maxStreams ?? 1}
                    onChange={(e) => setUserForm({ ...userForm, maxStreams: parseInt(e.target.value) || 0 })}
                    className="w-24"
                  />
                  <p className="text-[10px] text-gray-400">Typical: 1 for customers, 0 for monitoring users.</p>
                </div>
              </div>

              <div className="flex items-center gap-6">
                <div className="flex items-center gap-2">
                  <Switch
                    checked={userForm.isAdmin ?? false}
                    onCheckedChange={(v) => setUserForm({ ...userForm, isAdmin: v })}
                  />
                  <div>
                    <Label>Admin Access</Label>
                    <p className="text-[10px] text-gray-400">Access to <span className="font-mono">/status.html</span> and <span className="font-mono">/prometheus.txt</span></p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Switch
                    checked={userForm.noLog ?? false}
                    onCheckedChange={(v) => setUserForm({ ...userForm, noLog: v })}
                  />
                  <div>
                    <Label>Suppress Logging</Label>
                    <p className="text-[10px] text-gray-400">For monitoring scripts that should not fill log files</p>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label>Access from (optional)</Label>
                  <Input
                    type="datetime-local"
                    value={userForm.timeStart?.slice(0, 16) ?? ''}
                    onChange={(e) => setUserForm({ ...userForm, timeStart: e.target.value ? e.target.value + ':00' : null })}
                  />
                  <p className="text-[10px] text-gray-400">Before this date the access is inactive (delayed start)</p>
                </div>
                <div className="space-y-1.5">
                  <Label>Access until (optional)</Label>
                  <Input
                    type="datetime-local"
                    value={userForm.timeEnd?.slice(0, 16) ?? ''}
                    onChange={(e) => setUserForm({ ...userForm, timeEnd: e.target.value ? e.target.value + ':00' : null })}
                  />
                  <p className="text-[10px] text-gray-400">After this date the account is locked (e.g. for trial accounts)</p>
                </div>
              </div>

              <div className="flex gap-2 justify-end pt-2">
                <Button variant="outline" size="sm" onClick={() => { setShowUserForm(false); setEditingUser(null) }}>
                  Cancel
                </Button>
                <Button size="sm" onClick={handleSubmitUser}>
                  {editingUser ? 'Save Changes' : 'Add User'}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Search bar */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => handleSearch(e.target.value)}
            placeholder="Search users or groups..."
            className="w-full pl-9 pr-4 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#0067ff] focus:ring-1 focus:ring-[#0067ff]/20"
          />
          {searchQuery && (
            <button
              onClick={() => handleSearch('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-700"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* Users table */}
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-gray-200">
                  <th className="px-4 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wider">User</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wider">Password</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wider">Max Streams</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wider">Roles & Groups</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wider text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredUsers.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-12 text-center text-gray-400 text-sm">
                      {searchQuery
                        ? `No users found for "${searchQuery}"`
                        : 'No users created yet. Click "Add User" to get started.'}
                    </td>
                  </tr>
                ) : (
                  pagedUsers.map((user) => (
                    <UserRow
                      key={user.name}
                      user={user}
                      memberOf={userMemberOf(user.name)}
                      onEdit={handleEditUser}
                      onDelete={handleDeleteUser}
                    />
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200">
              <span className="text-xs text-gray-400">
                {filteredUsers.length} user{filteredUsers.length !== 1 ? 's' : ''} · Page {currentPage} of {totalPages}
              </span>
              <div className="flex items-center gap-1">
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                  disabled={currentPage === 1}
                  className="h-7 w-7"
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                </Button>
                {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
                  const page = i + 1
                  return (
                    <button
                      key={page}
                      onClick={() => setCurrentPage(page)}
                      className={`w-7 h-7 rounded text-xs font-medium transition-colors ${
                        page === currentPage
                          ? 'bg-[#0067ff] text-white'
                          : 'text-gray-500 hover:bg-gray-100'
                      }`}
                    >
                      {page}
                    </button>
                  )
                })}
                {totalPages > 7 && <span className="text-gray-400 text-xs px-1">…</span>}
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                  disabled={currentPage === totalPages}
                  className="h-7 w-7"
                >
                  <ChevronRight className="w-3.5 h-3.5" />
                </Button>
              </div>
            </div>
          )}
        </Card>

        {/* ── Groups section ── */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <div>
              <h3 className="text-base font-semibold text-gray-900">Groups</h3>
              <p className="text-xs text-gray-400 mb-2">
                Groups simplify access management. A group name can be used wherever a user name is expected. Groups can contain other groups.
                Network credentials are managed per group.
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => { setShowGroupForm(true); setEditingGroup(null) }}
              className="gap-1.5"
            >
              <Plus className="w-3.5 h-3.5" />
              Add Group
            </Button>
          </div>

          {/* Group form */}
          {showGroupForm && (
            <div className="mb-4">
              <GroupForm
                initial={editingGroup}
                users={users}
                groups={groups}
                networks={networks}
                onSave={handleSaveGroup}
                onCancel={() => { setShowGroupForm(false); setEditingGroup(null) }}
              />
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredGroups.map((group) => (
              <GroupCard
                key={group.name}
                group={group}
                users={users}
                networks={networks}
                onEdit={handleEditGroup}
                onDelete={handleDeleteGroup}
              />
            ))}
            {filteredGroups.length === 0 && !showGroupForm && (
              <Card>
                <CardContent className="p-4 text-center text-gray-400 text-sm">
                  {searchQuery
                    ? `No groups found for "${searchQuery}"`
                    : <>No groups defined yet. Groups are used as download users for streams and zones — e.g. <span className="font-mono text-xs">--pinput = SMART:&apos;ntrip:..&apos;:NewCustomers:passnmea</span></>
                  }
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </PageWrapper>
    </>
  )
}
