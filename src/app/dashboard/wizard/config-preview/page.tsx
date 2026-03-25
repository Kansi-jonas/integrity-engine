'use client'
import { useState, useCallback, useMemo } from 'react'
import {
  Download,
  Copy,
  Check,
  RefreshCw,
  FileText,
  Split,
  AlertCircle,
  MapPin,
} from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import Header from '@/components/layout/Header'
import PageWrapper from '@/components/layout/PageWrapper'
import {
  useConfigStore,
  selectGeneratedConfig,
  selectShowBackendDetails,
  selectMountpoints,
  selectNetworks,
  selectNetworkMountpoints,
  selectZones,
  selectGroups,
} from '@/store/config-store'
import { generateMountpointPinputLines } from '@/lib/config-engine'

// Syntax highlighting for Alberding config
// .config-block has dark background (#1e293b) — all colors must be readable on dark.
function highlightConfig(text: string): React.ReactNode[] {
  return text.split('\n').map((line, i) => {
    // Default: light slate (readable on dark background)
    let className = 'text-slate-300'
    let content: React.ReactNode = line

    if (line.startsWith('#')) {
      if (line.startsWith('# =') || line.startsWith('# -')) {
        // Section dividers — muted
        className = 'text-slate-500'
      } else if (line.startsWith('# Zone:') || line.startsWith('# WARNING:') || line.startsWith('# ERROR:')) {
        // Zone/warning comments — amber, visible on dark
        className = 'text-amber-400'
      } else {
        // Regular comments — muted italic
        className = 'text-slate-500 italic'
      }
    } else if (line.startsWith('--')) {
      // Directive line — colorize parts
      const eqIdx = line.indexOf(' = ')
      if (eqIdx !== -1) {
        const directive = line.slice(0, eqIdx)
        const value = line.slice(eqIdx + 3)

        content = (
          <>
            <span className="text-blue-400 font-medium">{directive}</span>
            <span className="text-slate-500"> = </span>
            {directive.includes('pinput') || directive.includes('input') || directive.includes('marker') ? (
              <ConfigValueLine value={value} />
            ) : (
              <span className="text-amber-300">{value}</span>
            )}
          </>
        )
        className = ''
      } else {
        // Directives without value (e.g. --sourcetable, --dynamicsourcetable)
        className = 'text-blue-400 font-medium'
      }
    } else if (line.startsWith('STR;') || line.startsWith('CAS;') || line.startsWith('NET;')) {
      // Sourcetable entries — brand blue, readable on dark (#0067ff is ~45% lightness, fine on #1e293b)
      className = 'text-[#60a5fa]'
    }

    return (
      <div key={i} className={`whitespace-pre ${className}`}>
        {content}
      </div>
    )
  })
}

function ConfigValueLine({ value }: { value: string }) {
  // URL in single quotes — highlight URL in green (readable on dark background)
  const urlMatch = value.match(/^([^']*)'([^']+)'(.*)$/)
  if (urlMatch) {
    return (
      <>
        <span className="text-slate-400">{urlMatch[1]}</span>
        <span className="text-slate-500">&apos;</span>
        <span className="text-emerald-400">{urlMatch[2]}</span>
        <span className="text-slate-500">&apos;</span>
        <span className="text-slate-300">{urlMatch[3]}</span>
      </>
    )
  }
  return <span className="text-amber-300">{value}</span>
}

export default function ConfigPage() {
  const [splitMode, setSplitMode] = useState(false)
  const [isGenerating, setIsGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // In split mode, mainConfig from API (zones excluded + --config include) overrides store config
  const [splitMainConfig, setSplitMainConfig] = useState<string | null>(null)
  const [zonesConfig, setZonesConfig] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [activeTab, setActiveTab] = useState<'main' | 'zones'>('main')

  const storeConfig = useConfigStore(selectGeneratedConfig)
  const showBackendDetails = useConfigStore(selectShowBackendDetails)
  const generateConfigNow = useConfigStore((s) => s.generateConfigNow)
  const mountpoints = useConfigStore(selectMountpoints)
  const networks = useConfigStore(selectNetworks)
  const networkMountpoints = useConfigStore(selectNetworkMountpoints)
  const zones = useConfigStore(selectZones)
  const groups = useConfigStore(selectGroups)

  // Compute zone streams grouped by mountpoint
  const zoneStreamsByMountpoint = useMemo(() => {
    const enabledMountpoints = Object.values(mountpoints).filter((m) => m.enabled)
    const enabledZones = Object.values(zones).filter((z) => z.enabled)
    const groupList = Object.values(groups)
    if (enabledMountpoints.length === 0) return []

    return enabledMountpoints.map((mp) => ({
      name: mp.name,
      lines: generateMountpointPinputLines(mp, networks, networkMountpoints, enabledZones, groupList),
    })).filter((entry) => entry.lines.length > 0)
  }, [mountpoints, networks, networkMountpoints, zones, groups])

  // When not in split mode, show the store config; in split mode, show the API-generated main config
  const config = splitMode ? splitMainConfig : storeConfig

  const handleGenerate = useCallback(async () => {
    setIsGenerating(true)
    setError(null)
    try {
      if (splitMode) {
        const res = await fetch('/api/config/generate?split=true')
        const data = await res.json()
        if (data.error) throw new Error(data.error)
        // Use server-generated split configs:
        //   mainConfig = ntrips.cfg without zone pinputs + --config = /etc/euronav/zones.cfg
        //   zonesConfig = zones.cfg with all zone pinputs
        setSplitMainConfig(data.mainConfig)
        setZonesConfig(data.zonesConfig)
        // Also update store so validation/deploy use current state
        generateConfigNow()
      } else {
        generateConfigNow()
        setSplitMainConfig(null)
        setZonesConfig(null)
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setIsGenerating(false)
    }
  }, [splitMode, generateConfigNow])

  const handleCopy = useCallback(async () => {
    const text = activeTab === 'zones' ? zonesConfig : config
    if (!text) return
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [activeTab, config, zonesConfig])

  const handleDownload = useCallback(() => {
    if (splitMode && splitMainConfig) {
      // Download ntrips.cfg (zones excluded, with --config include)
      const a = document.createElement('a')
      a.href = URL.createObjectURL(new Blob([splitMainConfig], { type: 'text/plain' }))
      a.download = 'ntrips.cfg'
      a.click()
      // Download zones.cfg
      if (zonesConfig) {
        setTimeout(() => {
          const b = document.createElement('a')
          b.href = URL.createObjectURL(new Blob([zonesConfig], { type: 'text/plain' }))
          b.download = 'zones.cfg'
          b.click()
        }, 100)
      }
    } else {
      window.location.href = '/api/config/download'
    }
  }, [splitMode, splitMainConfig, zonesConfig])

  const rawDisplayConfig = activeTab === 'zones' ? zonesConfig : config  // config already handles split vs non-split
  // Mask backend URLs when details are hidden
  const displayConfig = rawDisplayConfig && !showBackendDetails
    ? rawDisplayConfig.replace(/'ntrip[s1u]?:[^']+'/g, "'ntrip:***@***:***'")
    : rawDisplayConfig
  const lineCount = displayConfig ? displayConfig.split('\n').length : 0

  return (
    <>
      <Header />
      <PageWrapper>
        {/* Toolbar */}
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <Switch
                id="split-mode"
                checked={splitMode}
                onCheckedChange={setSplitMode}
              />
              <Label htmlFor="split-mode" className="flex items-center gap-1.5 cursor-pointer">
                <Split className="w-3.5 h-3.5 text-gray-500" />
                Split Config (zones.cfg)
              </Label>
            </div>
            {splitMode && (
              <div className="flex border border-gray-200 rounded-md overflow-hidden">
                <button
                  className={`px-3 py-1 text-xs font-medium transition-colors ${
                    activeTab === 'main'
                      ? 'bg-gray-100 text-gray-900'
                      : 'text-gray-400 hover:text-gray-700'
                  }`}
                  onClick={() => setActiveTab('main')}
                >
                  ntrips.cfg
                </button>
                <button
                  className={`px-3 py-1 text-xs font-medium transition-colors ${
                    activeTab === 'zones'
                      ? 'bg-gray-100 text-gray-900'
                      : 'text-gray-400 hover:text-gray-700'
                  }`}
                  onClick={() => setActiveTab('zones')}
                >
                  zones.cfg
                </button>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            {displayConfig && (
              <Badge variant="secondary" className="font-mono text-xs">
                {lineCount} lines
              </Badge>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={handleCopy}
              disabled={!displayConfig}
              className="gap-1.5"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-[#0067ff]" /> : <Copy className="w-3.5 h-3.5" />}
              {copied ? 'Copied!' : 'Copy'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={handleDownload}
              disabled={!config}
              className="gap-1.5"
            >
              <Download className="w-3.5 h-3.5" />
              Download
            </Button>
            <Button size="sm" onClick={handleGenerate} disabled={isGenerating} className="gap-1.5">
              <RefreshCw className={`w-3.5 h-3.5 ${isGenerating ? 'animate-spin' : ''}`} />
              {isGenerating ? 'Generating…' : 'Generate'}
            </Button>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">
            <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            {error}
          </div>
        )}

        {/* Config display */}
        {!displayConfig ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-20 text-center">
              <FileText className="w-12 h-12 text-gray-400 mb-4" />
              <p className="text-gray-500 font-medium">No config generated yet</p>
              <p className="text-gray-400 text-sm mt-1 mb-6">
                Click &ldquo;Generate&rdquo; to create the ntrips.cfg from current settings
              </p>
              <Button onClick={handleGenerate} disabled={isGenerating}>
                <RefreshCw className={`w-4 h-4 mr-2 ${isGenerating ? 'animate-spin' : ''}`} />
                Generate Config
              </Button>
            </CardContent>
          </Card>
        ) : (
          <Card className="overflow-hidden">
            <CardHeader className="py-3 px-4 border-b border-gray-200 flex-row items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="flex gap-1.5">
                  <div className="w-2.5 h-2.5 rounded-full bg-red-500/60" />
                  <div className="w-2.5 h-2.5 rounded-full bg-amber-500/60" />
                  <div className="w-2.5 h-2.5 rounded-full bg-emerald-500/60" />
                </div>
                <CardTitle className="text-xs font-mono text-gray-400">
                  {activeTab === 'zones' ? '/etc/euronav/zones.cfg' : '/etc/euronav/ntrips.cfg'}
                </CardTitle>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <div
                className="config-block rounded-none border-0 overflow-auto max-h-[calc(100vh-18rem)]"
                style={{ counterReset: 'line' }}
              >
                {highlightConfig(displayConfig)}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Zone Streams section */}
        {zoneStreamsByMountpoint.length > 0 && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm flex items-center gap-2">
                <MapPin className="w-4 h-4 text-gray-500" />
                Zone Streams
              </CardTitle>
              <p className="text-xs text-gray-400">
                Generated <code className="font-mono bg-gray-100 px-1 rounded">--pinput</code> lines per mountpoint, ordered by backend cascade and zone priority.
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              {zoneStreamsByMountpoint.map((entry) => (
                <div key={entry.name}>
                  <p className="text-xs font-semibold text-gray-700 mb-1.5">
                    Mountpoint: <span className="font-mono text-[#0067ff]">{entry.name}</span>
                    <Badge variant="secondary" className="ml-2 text-[10px]">
                      {entry.lines.filter((l) => l.startsWith('--pinput')).length} pinput{entry.lines.filter((l) => l.startsWith('--pinput')).length !== 1 ? 's' : ''}
                    </Badge>
                  </p>
                  <div className="config-block text-xs overflow-x-auto">
                    {entry.lines.map((line, i) => {
                      const masked = !showBackendDetails
                        ? line.replace(/'ntrip[s1u]?:[^']+'/g, "'ntrip:***@***:***'")
                        : line
                      return (
                        <div
                          key={i}
                          className={
                            masked.startsWith('#') ? 'text-slate-500 italic' :
                            masked.startsWith('--pinput') ? 'text-slate-300' :
                            'text-slate-400'
                          }
                        >
                          {masked}
                        </div>
                      )
                    })}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        )}
      </PageWrapper>
    </>
  )
}
