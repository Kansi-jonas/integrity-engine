'use client'
import { useState, useRef } from 'react'
import { Terminal, Upload, TestTube2, RefreshCw, Rocket, AlertTriangle, Shield } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import Header from '@/components/layout/Header'
import PageWrapper from '@/components/layout/PageWrapper'

interface SSHConfig {
  host: string
  port: number
  username: string
  authMethod: 'password' | 'key'
  password: string
  keyPath: string
}

function TerminalOutput({ lines }: { lines: string[] }) {
  return (
    <div className="config-block min-h-48 max-h-96 overflow-y-auto">
      {lines.length === 0 ? (
        <span className="text-gray-400">$ _</span>
      ) : (
        lines.map((line, i) => (
          <div key={i} className={
            line.startsWith('ERROR') || line.startsWith('✗') ? 'text-red-400' :
            line.startsWith('SUCCESS') || line.startsWith('✓') ? 'text-[#0067ff]' :
            line.startsWith('$') || line.startsWith('#') ? 'text-gray-400' :
            'text-gray-700'
          }>
            {line}
          </div>
        ))
      )}
    </div>
  )
}

export default function DeployPage() {
  const [ssh, setSsh] = useState<SSHConfig>({
    host: '',
    port: 22,
    username: 'root',
    authMethod: 'key',
    password: '',
    keyPath: '~/.ssh/id_rsa',
  })
  const [output, setOutput] = useState<string[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [confirmed, setConfirmed] = useState(false)

  const addLine = (line: string) => setOutput((prev) => [...prev, line])

  const clearOutput = () => setOutput([])

  const handleTestConnection = async () => {
    clearOutput()
    setIsLoading(true)
    addLine(`$ Connecting to ${ssh.username}@${ssh.host}:${ssh.port}…`)
    try {
      const res = await fetch('/api/deploy/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ssh),
      })
      const data = await res.json()
      if (data.ok) {
        addLine('✓ SSH connection successful')
        addLine(`  Server: ${data.info ?? 'connected'}`)
      } else {
        addLine(`✗ Connection failed: ${data.error}`)
      }
    } catch (e) {
      addLine(`ERROR: ${String(e)}`)
    } finally {
      setIsLoading(false)
    }
  }

  const handleUpload = async () => {
    if (!confirmed) {
      addLine('ERROR: Please confirm the action by checking the confirmation box.')
      return
    }
    clearOutput()
    setIsLoading(true)
    addLine(`$ Generating config…`)
    addLine(`$ Uploading to ${ssh.host}:/etc/euronav/ntrips.cfg…`)
    addLine('# (Creating backup at /etc/euronav/ntrips.cfg~)')
    try {
      const res = await fetch('/api/deploy/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ssh),
      })
      const data = await res.json()
      if (data.ok) {
        addLine('✓ Config uploaded successfully')
      } else {
        addLine(`✗ Upload failed: ${data.error}`)
      }
    } catch (e) {
      addLine(`ERROR: ${String(e)}`)
    } finally {
      setIsLoading(false)
    }
  }

  const handleVerify = async () => {
    clearOutput()
    setIsLoading(true)
    addLine(`$ ntrips --verify -c /etc/euronav/ntrips.cfg`)
    try {
      const res = await fetch('/api/deploy/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ssh),
      })
      const data = await res.json()
      addLine(data.output ?? `Exit code: ${data.exitCode}`)
      if (data.exitCode === 0) {
        addLine('✓ Configuration is valid')
      } else {
        addLine('✗ Verification failed')
      }
    } catch (e) {
      addLine(`ERROR: ${String(e)}`)
    } finally {
      setIsLoading(false)
    }
  }

  const handleReload = async () => {
    if (!confirmed) {
      addLine('ERROR: Please confirm the action by checking the confirmation box.')
      return
    }
    clearOutput()
    setIsLoading(true)
    addLine('$ Sending HUP signal to ntrips…')
    try {
      const res = await fetch('/api/deploy/reload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ssh),
      })
      const data = await res.json()
      if (data.ok) {
        addLine('✓ Caster reloaded successfully')
      } else {
        addLine(`✗ Reload failed: ${data.error}`)
      }
    } catch (e) {
      addLine(`ERROR: ${String(e)}`)
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <>
      <Header />
      <PageWrapper>
        <div className="flex items-center gap-3 mb-2">
          <h2 className="text-lg font-semibold text-gray-900">Deploy</h2>
          <div className="flex items-center gap-1.5 text-xs text-amber-700 bg-amber-50 border border-amber-200 px-2 py-1 rounded-full">
            <Shield className="w-3 h-3" />
            SSH credentials are not stored
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* SSH Config */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">SSH Connection</CardTitle>
              <CardDescription>Credentials are session-only and are not stored</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2 space-y-1.5">
                  <Label>Host</Label>
                  <Input value={ssh.host} onChange={(e) => setSsh({ ...ssh, host: e.target.value })} placeholder="caster.rtkdata.com" className="font-mono text-xs" />
                </div>
                <div className="space-y-1.5">
                  <Label>Port</Label>
                  <Input type="number" value={ssh.port} onChange={(e) => setSsh({ ...ssh, port: parseInt(e.target.value) || 22 })} className="font-mono" />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label>Username</Label>
                <Input value={ssh.username} onChange={(e) => setSsh({ ...ssh, username: e.target.value })} className="font-mono" />
              </div>

              <div className="space-y-1.5">
                <Label>Authentication Method</Label>
                <Select value={ssh.authMethod} onValueChange={(v) => setSsh({ ...ssh, authMethod: v as 'password' | 'key' })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="key">SSH Key File</SelectItem>
                    <SelectItem value="password">Password</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {ssh.authMethod === 'password' ? (
                <div className="space-y-1.5">
                  <Label>Password</Label>
                  <Input type="password" value={ssh.password} onChange={(e) => setSsh({ ...ssh, password: e.target.value })} />
                </div>
              ) : (
                <div className="space-y-1.5">
                  <Label>Key File Path</Label>
                  <Input value={ssh.keyPath} onChange={(e) => setSsh({ ...ssh, keyPath: e.target.value })} className="font-mono text-xs" />
                </div>
              )}

              <Button size="sm" variant="outline" onClick={handleTestConnection} disabled={isLoading} className="gap-1.5">
                <TestTube2 className="w-3.5 h-3.5" />
                Test Connection
              </Button>
            </CardContent>
          </Card>

          {/* Actions */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Deployment Actions</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="p-3 rounded-lg bg-amber-50 border border-amber-200">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
                  <p className="text-xs text-amber-700">
                    Uploading will overwrite the current configuration. A backup is automatically created at <code className="font-mono">/etc/euronav/ntrips.cfg~</code>.
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <Switch checked={confirmed} onCheckedChange={setConfirmed} />
                <Label className="cursor-pointer">I understand this will modify the production caster</Label>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <Button
                  onClick={handleUpload}
                  disabled={isLoading || !ssh.host}
                  variant={confirmed ? 'default' : 'secondary'}
                  className="gap-1.5"
                >
                  <Upload className="w-3.5 h-3.5" />
                  Upload Config
                </Button>
                <Button
                  onClick={handleVerify}
                  disabled={isLoading || !ssh.host}
                  variant="outline"
                  className="gap-1.5"
                >
                  <TestTube2 className="w-3.5 h-3.5" />
                  Verify Remote
                </Button>
                <Button
                  onClick={handleReload}
                  disabled={isLoading || !ssh.host}
                  variant={confirmed ? 'destructive' : 'secondary'}
                  className="gap-1.5"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  Reload Caster
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Terminal output */}
          <Card className="lg:col-span-2">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Terminal className="w-4 h-4 text-gray-500" />
                  Output
                </CardTitle>
                <Button size="sm" variant="ghost" onClick={clearOutput} className="text-xs">Clear</Button>
              </div>
            </CardHeader>
            <CardContent>
              <TerminalOutput lines={output} />
            </CardContent>
          </Card>
        </div>
      </PageWrapper>
    </>
  )
}
