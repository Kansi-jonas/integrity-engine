'use client'
import { useState, useEffect } from 'react'
import { CheckCircle2, AlertCircle, AlertTriangle, Info, RefreshCw, ShieldCheck } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import Header from '@/components/layout/Header'
import PageWrapper from '@/components/layout/PageWrapper'
import { useConfigStore, selectValidationResults } from '@/store/config-store'
import type { ValidationResult } from '@/lib/types'

const SEVERITY_CONFIG = {
  error: { icon: AlertCircle, color: 'text-red-500', bg: 'bg-red-50 border-red-200', badge: 'destructive' as const },
  warning: { icon: AlertTriangle, color: 'text-amber-500', bg: 'bg-amber-50 border-amber-200', badge: 'warning' as const },
  success: { icon: CheckCircle2, color: 'text-[#0067ff]', bg: 'bg-[#e8f0fe] border-blue-200', badge: 'default' as const },
  info: { icon: Info, color: 'text-blue-500', bg: 'bg-blue-50 border-blue-200', badge: 'secondary' as const },
}

function ResultItem({ result }: { result: ValidationResult }) {
  const config = SEVERITY_CONFIG[result.severity]
  const Icon = config.icon
  return (
    <div className={`flex items-start gap-3 p-3 rounded-lg border ${config.bg}`}>
      <Icon className={`w-4 h-4 mt-0.5 flex-shrink-0 ${config.color}`} />
      <div className="flex-1 min-w-0">
        <p className="text-sm text-gray-800">{result.message}</p>
        {result.field && (
          <p className="text-xs text-gray-400 font-mono mt-0.5">{result.field}</p>
        )}
      </div>
    </div>
  )
}

export default function ValidationPage() {
  const results = useConfigStore(selectValidationResults)
  const runValidation = useConfigStore((s) => s.runValidation)
  const [isRunning, setIsRunning] = useState(false)
  const [lastRun, setLastRun] = useState<Date | null>(null)

  const errorCount = results.filter((r) => r.severity === 'error').length
  const warningCount = results.filter((r) => r.severity === 'warning').length
  const successCount = results.filter((r) => r.severity === 'success').length

  const handleRun = () => {
    setIsRunning(true)
    // Run client-side validation against current store state
    setTimeout(() => {
      runValidation()
      setLastRun(new Date())
      setIsRunning(false)
    }, 80) // brief visual feedback
  }

  // Auto-run on mount if no results yet
  useEffect(() => {
    if (results.length === 0) handleRun()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const byType: Record<string, ValidationResult[]> = {
    error: results.filter((r) => r.severity === 'error'),
    warning: results.filter((r) => r.severity === 'warning'),
    success: results.filter((r) => r.severity === 'success'),
    info: results.filter((r) => r.severity === 'info'),
  }

  return (
    <>
      <Header />
      <PageWrapper>
        <div className="flex items-center justify-between mb-2">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Configuration Validation</h2>
            <p className="text-sm text-gray-400">
              {lastRun
                ? `Last checked: ${lastRun.toLocaleTimeString('en-US')}`
                : 'Check configuration for errors before deployment'}
            </p>
          </div>
          <Button size="sm" onClick={handleRun} disabled={isRunning} className="gap-1.5">
            <RefreshCw className={`w-4 h-4 ${isRunning ? 'animate-spin' : ''}`} />
            {isRunning ? 'Checking...' : 'Run Validation'}
          </Button>
        </div>

        {/* Summary */}
        {results.length > 0 && (
          <div className="grid grid-cols-3 gap-4">
            <Card className={errorCount > 0 ? 'border-red-500/30' : 'border-gray-200'}>
              <CardContent className="p-4 flex items-center gap-3">
                <AlertCircle className={`w-8 h-8 ${errorCount > 0 ? 'text-red-400' : 'text-gray-400'}`} />
                <div>
                  <p className="text-2xl font-bold font-mono text-gray-900">{errorCount}</p>
                  <p className="text-xs text-gray-400">Errors</p>
                </div>
              </CardContent>
            </Card>
            <Card className={warningCount > 0 ? 'border-amber-500/30' : 'border-gray-200'}>
              <CardContent className="p-4 flex items-center gap-3">
                <AlertTriangle className={`w-8 h-8 ${warningCount > 0 ? 'text-amber-400' : 'text-gray-400'}`} />
                <div>
                  <p className="text-2xl font-bold font-mono text-gray-900">{warningCount}</p>
                  <p className="text-xs text-gray-400">Warnings</p>
                </div>
              </CardContent>
            </Card>
            <Card className={successCount > 0 ? 'border-[#0067ff]/30' : 'border-gray-200'}>
              <CardContent className="p-4 flex items-center gap-3">
                <CheckCircle2 className={`w-8 h-8 ${successCount > 0 ? 'text-[#0067ff]' : 'text-gray-400'}`} />
                <div>
                  <p className="text-2xl font-bold font-mono text-gray-900">{successCount > 0 ? '✓' : '—'}</p>
                  <p className="text-xs text-gray-400">Status</p>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Results */}
        {results.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-20">
              <ShieldCheck className="w-12 h-12 text-gray-400 mb-4" />
              <p className="text-gray-500 font-medium">No validation performed yet</p>
              <p className="text-gray-400 text-sm mt-1 mb-6">Click &ldquo;Run Validation&rdquo; to check the configuration</p>
              <Button onClick={handleRun} disabled={isRunning}>
                <RefreshCw className={`w-4 h-4 mr-2 ${isRunning ? 'animate-spin' : ''}`} />
                Run Validation
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            {byType.error.length > 0 && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm flex items-center gap-2 text-red-600">
                    <AlertCircle className="w-4 h-4" />
                    Errors ({byType.error.length})
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {byType.error.map((r, i) => <ResultItem key={i} result={r} />)}
                </CardContent>
              </Card>
            )}
            {byType.warning.length > 0 && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm flex items-center gap-2 text-amber-600">
                    <AlertTriangle className="w-4 h-4" />
                    Warnings ({byType.warning.length})
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {byType.warning.map((r, i) => <ResultItem key={i} result={r} />)}
                </CardContent>
              </Card>
            )}
            {byType.success.length > 0 && (
              <div className="space-y-2">
                {byType.success.map((r, i) => <ResultItem key={i} result={r} />)}
              </div>
            )}
          </div>
        )}
      </PageWrapper>
    </>
  )
}
