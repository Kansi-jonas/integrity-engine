'use client'
import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import {
  Settings,
  RotateCcw,
  Info,
  Server,
  Clock,
  Shield,
  Terminal,
  Globe,
} from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Separator } from '@/components/ui/separator'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import Header from '@/components/layout/Header'
import PageWrapper from '@/components/layout/PageWrapper'
import { settingsSchema, type SettingsFormData } from '@/lib/validators'
import { useConfigStore, selectSettings } from '@/store/config-store'
import { settingsToJSON } from '@/lib/utils'
import { DEFAULT_SETTINGS } from '@/lib/types'

function FieldTooltip({ content }: { content: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Info className="w-3.5 h-3.5 text-gray-400 hover:text-gray-700 cursor-help flex-shrink-0" />
      </TooltipTrigger>
      <TooltipContent className="max-w-64 text-xs">{content}</TooltipContent>
    </Tooltip>
  )
}

function FormField({
  label,
  tooltip,
  error,
  children,
}: {
  label: string
  tooltip?: string
  error?: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        <Label>{label}</Label>
        {tooltip && <FieldTooltip content={tooltip} />}
      </div>
      {children}
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  )
}

export default function SettingsPage() {
  const settings = useConfigStore(selectSettings)
  const updateSettings = useConfigStore((s) => s.updateSettings)
  const resetSettings = useConfigStore((s) => s.resetSettings)
  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    reset,
    formState: { errors, isDirty },
  } = useForm<SettingsFormData>({
    resolver: zodResolver(settingsSchema),
    defaultValues: settings as SettingsFormData,
  })

  // Sync store → form when store changes externally
  useEffect(() => {
    reset(settings as SettingsFormData)
  }, [settings, reset])

  const onSubmit = async (data: SettingsFormData) => {
    setIsSaving(true)
    setSaveError(null)
    try {
      updateSettings(data)
      const json = settingsToJSON({ ...settings, ...data })
      const res = await fetch('/api/data/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(json),
      })
      if (!res.ok) throw new Error('Save failed')
    } catch (e) {
      setSaveError(String(e))
    } finally {
      setIsSaving(false)
    }
  }

  const handleReset = () => {
    resetSettings()
    reset(DEFAULT_SETTINGS as unknown as SettingsFormData)
  }

  const tlsEnabled = Boolean(watch('tlsports'))

  return (
    <>
      <Header />
      <PageWrapper>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold text-gray-900">Global Settings</h2>
              <p className="text-sm text-gray-400">
                These settings apply to the entire Alberding NTRIP Caster.
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleReset}
                className="gap-1.5"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                Reset to Defaults
              </Button>
              <Button type="submit" size="sm" disabled={isSaving || !isDirty} className="gap-1.5">
                <Settings className="w-3.5 h-3.5" />
                {isSaving ? 'Saving…' : 'Save Settings'}
              </Button>
            </div>
          </div>

          {saveError && (
            <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">
              Error: {saveError}
            </div>
          )}

          <Tabs defaultValue="logging">
            <TabsList className="grid grid-cols-6 w-full">
              <TabsTrigger value="logging" className="gap-1.5 text-xs">
                <Terminal className="w-3.5 h-3.5" />
                Logging
              </TabsTrigger>
              <TabsTrigger value="ports" className="gap-1.5 text-xs">
                <Server className="w-3.5 h-3.5" />
                Ports
              </TabsTrigger>
              <TabsTrigger value="tls" className="gap-1.5 text-xs">
                <Shield className="w-3.5 h-3.5" />
                TLS
              </TabsTrigger>
              <TabsTrigger value="timeouts" className="gap-1.5 text-xs">
                <Clock className="w-3.5 h-3.5" />
                Timeouts
              </TabsTrigger>
              <TabsTrigger value="limits" className="gap-1.5 text-xs">
                <Settings className="w-3.5 h-3.5" />
                Limits
              </TabsTrigger>
              <TabsTrigger value="identity" className="gap-1.5 text-xs">
                <Globe className="w-3.5 h-3.5" />
                Identity
              </TabsTrigger>
            </TabsList>

            {/* ── Logging tab ─────────────────────────────────────────────── */}
            <TabsContent value="logging">
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">Logging Configuration</CardTitle>
                  <CardDescription>Per ALBERDING_SYNTAX.md §1 — Logging</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <FormField
                    label="Log File Path"
                    tooltip="Supports strftime formatting. Example: /var/euronav/log/ntrips_%Y-%m-%d.log"
                    error={errors.logfile?.message}
                  >
                    <Input {...register('logfile')} className="font-mono text-xs" />
                  </FormField>

                  <FormField
                    label="Log Level (0–5)"
                    tooltip="0=None, 1=Fatal, 2=Errors, 3=Warnings, 4=Info (default), 5=Verbose"
                    error={errors.loglevel?.message}
                  >
                    <Input
                      type="number"
                      min={0}
                      max={5}
                      {...register('loglevel', { valueAsNumber: true })}
                      className="w-24"
                    />
                  </FormField>

                  <FormField
                    label="Runtime Check File"
                    tooltip="File continuously updated for external health monitoring (cron watchdog)"
                    error={errors.runtimecheck?.message}
                  >
                    <Input {...register('runtimecheck')} className="font-mono text-xs" />
                  </FormField>

                  <Separator />

                  <div className="grid grid-cols-3 gap-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        <Label htmlFor="logalberding">Log Alberding NMEA</Label>
                        <FieldTooltip content="Log PALB-NMEA lines from data streams (--logalberding)" />
                      </div>
                      <Switch
                        id="logalberding"
                        checked={watch('logalberding') === 1}
                        onCheckedChange={(v) => setValue('logalberding', v ? 1 : 0)}
                      />
                    </div>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        <Label htmlFor="lognmea">Log NMEA Positions</Label>
                        <FieldTooltip content="Log NMEA positions from data streams (--lognmea)" />
                      </div>
                      <Switch
                        id="lognmea"
                        checked={watch('lognmea') === 1}
                        onCheckedChange={(v) => setValue('lognmea', v ? 1 : 0)}
                      />
                    </div>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        <Label htmlFor="logxheader">Log X-Headers</Label>
                        <FieldTooltip content="Log HTTP headers starting with X- (--logxheader)" />
                      </div>
                      <Switch
                        id="logxheader"
                        checked={watch('logxheader') === 1}
                        onCheckedChange={(v) => setValue('logxheader', v ? 1 : 0)}
                      />
                    </div>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            {/* ── Ports tab ───────────────────────────────────────────────── */}
            <TabsContent value="ports">
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">Port Configuration</CardTitle>
                  <CardDescription>Per ALBERDING_SYNTAX.md §2 — Ports</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <FormField
                    label="TCP Ports"
                    tooltip="Comma-separated port numbers. Default: 2101. Example: 2101,8080"
                    error={errors.ports?.message}
                  >
                    <Input {...register('ports')} placeholder="2101" className="w-64 font-mono" />
                  </FormField>

                  <FormField
                    label="UDP Ports"
                    tooltip="UDP ports for data I/O. Same syntax as TCP ports. Default: 2101"
                    error={errors.udpports?.message}
                  >
                    <Input {...register('udpports')} placeholder="2101" className="w-64 font-mono" />
                  </FormField>
                </CardContent>
              </Card>
            </TabsContent>

            {/* ── TLS tab ─────────────────────────────────────────────────── */}
            <TabsContent value="tls">
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">TLS Configuration</CardTitle>
                  <CardDescription>Per ALBERDING_SYNTAX.md §12 — TLS</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <FormField
                    label="TLS Ports"
                    tooltip="TLS-encrypted ports. Leave empty to disable TLS. Example: 2102"
                    error={errors.tlsports?.message}
                  >
                    <Input {...register('tlsports')} placeholder="2102 (leave empty to disable)" className="w-64 font-mono" />
                  </FormField>

                  {tlsEnabled && (
                    <>
                      <FormField
                        label="Certificate"
                        tooltip="Format: cert.pem;cert.key;[chain.pem] — PEM format files"
                        error={errors.certificate?.message}
                      >
                        <Input
                          {...register('certificate')}
                          placeholder="/etc/ssl/certs/cert.pem;/etc/ssl/private/cert.key"
                          className="font-mono text-xs"
                        />
                      </FormField>

                      <FormField
                        label="CA Path"
                        tooltip="Directory with CA certificates for outgoing TLS connections"
                        error={errors.capath?.message}
                      >
                        <Input {...register('capath')} placeholder="/etc/ssl/certs" className="font-mono text-xs" />
                      </FormField>

                      <FormField
                        label="CA File"
                        tooltip="Single CA certificate file for outgoing TLS connections"
                        error={errors.cafile?.message}
                      >
                        <Input {...register('cafile')} placeholder="/etc/ssl/certs/ca.pem" className="font-mono text-xs" />
                      </FormField>

                      <FormField
                        label="Cipher Suites"
                        tooltip="OpenSSL cipher suite string. Leave empty for system defaults."
                        error={errors.ciphers?.message}
                      >
                        <Input {...register('ciphers')} placeholder="HIGH:!aNULL:!MD5" className="font-mono text-xs" />
                      </FormField>

                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5">
                          <Label htmlFor="detecttls">Auto-detect TLS</Label>
                          <FieldTooltip content="Auto-detect TLS on regular (non-TLS) ports (--detecttls)" />
                        </div>
                        <Switch
                          id="detecttls"
                          checked={watch('detecttls') === 1}
                          onCheckedChange={(v) => setValue('detecttls', v ? 1 : 0)}
                        />
                      </div>
                    </>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            {/* ── Timeouts tab ────────────────────────────────────────────── */}
            <TabsContent value="timeouts">
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">Timeout Configuration</CardTitle>
                  <CardDescription>Per ALBERDING_SYNTAX.md §10 — Timeouts</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <FormField
                    label="TCP Timeout (seconds)"
                    tooltip="Idle TCP timeout. Range: 30–1800 seconds. Default: 300 (5 min)"
                    error={errors.tcptimeout?.message}
                  >
                    <div className="flex items-center gap-2">
                      <Input
                        type="number"
                        min={30}
                        max={1800}
                        {...register('tcptimeout', { valueAsNumber: true })}
                        className="w-28"
                      />
                      <span className="text-xs text-gray-400">seconds (30–1800)</span>
                    </div>
                  </FormField>

                  <FormField
                    label="NMEA Loss Timeout (seconds)"
                    tooltip="Disconnect client if no NMEA data received. Range: 15–1800 seconds."
                    error={errors.nmealosstimeout?.message}
                  >
                    <div className="flex items-center gap-2">
                      <Input
                        type="number"
                        min={15}
                        max={1800}
                        {...register('nmealosstimeout', { valueAsNumber: true })}
                        className="w-28"
                      />
                      <span className="text-xs text-gray-400">seconds (15–1800)</span>
                    </div>
                  </FormField>

                  <FormField
                    label="Input Timeout (seconds)"
                    tooltip="On-demand rebroadcast: fetch data only when client connects, stop after disconnect + timeout. Minimum 60s. Leave empty to disable."
                    error={errors.inputtimeout?.message}
                  >
                    <div className="flex items-center gap-2">
                      <Input
                        type="number"
                        min={60}
                        {...register('inputtimeout', { valueAsNumber: true })}
                        className="w-28"
                        placeholder="off"
                      />
                      <span className="text-xs text-gray-400">seconds (≥60) or empty</span>
                    </div>
                  </FormField>
                </CardContent>
              </Card>
            </TabsContent>

            {/* ── Limits tab ──────────────────────────────────────────────── */}
            <TabsContent value="limits">
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">Connection Limits & Behavior</CardTitle>
                  <CardDescription>Per ALBERDING_SYNTAX.md §10 — Connection Limits</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <FormField
                    label="Connection Limit"
                    tooltip="Max concurrent connections (OS-limited). Check with: ulimit -n -H"
                    error={errors.connectionlimit?.message}
                  >
                    <Input
                      type="number"
                      min={1}
                      {...register('connectionlimit', { valueAsNumber: true })}
                      className="w-28"
                    />
                  </FormField>

                  <FormField
                    label="Max Clients (total)"
                    tooltip="Max total downloading clients. Default: unlimited. Leave empty for no limit."
                    error={errors.maxclients?.message}
                  >
                    <Input
                      type="number"
                      min={1}
                      {...register('maxclients', { valueAsNumber: true })}
                      className="w-28"
                      placeholder="unlimited"
                    />
                  </FormField>

                  <FormField
                    label="Max Clients per Source"
                    tooltip="Max concurrent clients per stream mountpoint. Default: unlimited."
                    error={errors.maxclientspersource?.message}
                  >
                    <Input
                      type="number"
                      min={1}
                      {...register('maxclientspersource', { valueAsNumber: true })}
                      className="w-28"
                      placeholder="unlimited"
                    />
                  </FormField>

                  <FormField
                    label="Min Bandwidth (bytes/min)"
                    tooltip="Log warning if stream bandwidth falls below this threshold."
                    error={errors.minbandwidth?.message}
                  >
                    <Input
                      type="number"
                      min={0}
                      {...register('minbandwidth', { valueAsNumber: true })}
                      className="w-28"
                      placeholder="off"
                    />
                  </FormField>

                  <Separator />

                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        <Label htmlFor="kickonlimit">Kick on Limit</Label>
                        <FieldTooltip content="When connection limit reached: kick oldest connection instead of rejecting new one (--kickonlimit)" />
                      </div>
                      <Switch
                        id="kickonlimit"
                        checked={watch('kickonlimit') === 1}
                        onCheckedChange={(v) => setValue('kickonlimit', v ? 1 : 0)}
                      />
                    </div>

                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        <Label htmlFor="httpcompat">HTTP Compatibility Mode</Label>
                        <FieldTooltip content="Workaround for broken NTRIP v1 clients. May conflict with correct clients. (--httpcompatibility)" />
                      </div>
                      <Switch
                        id="httpcompat"
                        checked={watch('httpcompatibility') === 1}
                        onCheckedChange={(v) => setValue('httpcompatibility', v ? 1 : 0)}
                      />
                    </div>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            {/* ── Identity tab ────────────────────────────────────────────── */}
            <TabsContent value="identity">
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">Caster Identity</CardTitle>
                  <CardDescription>
                    These values appear in the NTRIP sourcetable (CAS entry).
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <FormField
                      label="Caster Host"
                      tooltip="Public hostname of the caster (for CAS sourcetable entry)"
                      error={errors.casterHost?.message}
                    >
                      <Input {...register('casterHost')} placeholder="caster.rtkdata.com" className="font-mono text-xs" />
                    </FormField>

                    <FormField
                      label="Identifier"
                      tooltip="Short identifier shown in sourcetable (e.g. RTKdata)"
                      error={errors.casterIdentifier?.message}
                    >
                      <Input {...register('casterIdentifier')} placeholder="RTKdata" />
                    </FormField>

                    <FormField
                      label="Operator"
                      tooltip="Organization operating the caster"
                      error={errors.casterOperator?.message}
                    >
                      <Input {...register('casterOperator')} placeholder="RTKdata" />
                    </FormField>

                    <FormField
                      label="Country (ISO 3166 alpha-3)"
                      tooltip="3-letter ISO country code. Examples: DEU, USA, GBR, AUS"
                      error={errors.casterCountry?.message}
                    >
                      <Input {...register('casterCountry')} placeholder="DEU" className="w-24 uppercase font-mono" maxLength={3} />
                    </FormField>

                    <FormField
                      label="Caster URL"
                      tooltip="Public URL of the caster / operator website"
                      error={errors.casterUrl?.message}
                    >
                      <Input {...register('casterUrl')} placeholder="http://www.rtkdata.com" type="url" className="font-mono text-xs" />
                    </FormField>
                  </div>

                  <Separator />
                  <p className="text-xs text-gray-400">
                    Latitude/Longitude values appear in the BKG-style CAS entry (format: DDMM.mm). Example: 0050.12 (50°12&apos;N), 8.69 (8°41&apos;E).
                  </p>
                  <div className="grid grid-cols-2 gap-4">
                    <FormField label="Sourcetable Latitude" tooltip="DDMM.mm format (e.g. 0050.12 for 50°12'N). Used in CAS entry.">
                      <Input {...register('casterLat')} placeholder="0050.12" className="font-mono" />
                    </FormField>
                    <FormField label="Sourcetable Longitude" tooltip="DDMM.mm format (e.g. 8.69 for 8°41'E). Used in CAS entry.">
                      <Input {...register('casterLon')} placeholder="8.69" className="font-mono" />
                    </FormField>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>

          {/* Footer save */}
          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="ghost" size="sm" onClick={handleReset}>
              Reset to Defaults
            </Button>
            <Button type="submit" disabled={isSaving || !isDirty}>
              {isSaving ? 'Saving…' : 'Save Settings'}
            </Button>
          </div>
        </form>
      </PageWrapper>
    </>
  )
}
