import React from 'react'
import { cn } from '@/lib/utils'

interface PageWrapperProps {
  children: React.ReactNode
  className?: string
  /** Full-height layout without padding (e.g. map page) */
  fullHeight?: boolean
}

export default function PageWrapper({ children, className, fullHeight }: PageWrapperProps) {
  if (fullHeight) {
    return <div className={cn('flex-1 overflow-hidden', className)}>{children}</div>
  }
  return (
    <div className={cn('flex-1 overflow-y-auto p-6', className)}>
      <div className="max-w-6xl mx-auto space-y-6">{children}</div>
    </div>
  )
}
