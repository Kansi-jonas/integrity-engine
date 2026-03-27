"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import { useState, useEffect } from "react";
import {
  Shield, Activity, Map, Eye, Radio, Zap, Settings, Hexagon,
  Globe, Layers, Users, Server, Upload, FileCode, CheckCircle,
  ChevronLeft, ChevronDown, Menu, X, BarChart3, AlertTriangle,
  type LucideIcon,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface NavItemDef {
  href: string;
  label: string;
  icon: LucideIcon;
  exact?: boolean;
}

interface NavSectionDef {
  id: string;
  label: string;
  items: NavItemDef[];
  defaultOpen?: boolean;
  alwaysOpen?: boolean;
}

// ---------------------------------------------------------------------------
// Navigation Structure
// ---------------------------------------------------------------------------

const sections: NavSectionDef[] = [
  {
    id: "monitor",
    label: "Integrity Monitor",
    alwaysOpen: true,
    defaultOpen: true,
    items: [
      { href: "/dashboard", label: "Overview", icon: Shield, exact: true },
      { href: "/dashboard/quality", label: "Coverage Quality", icon: Hexagon },
      { href: "/dashboard/trust", label: "Station Trust", icon: Eye },
      { href: "/dashboard/interference", label: "Interference", icon: AlertTriangle },
      { href: "/dashboard/forecast", label: "Quality Forecast", icon: BarChart3 },
      { href: "/dashboard/config", label: "Config & Gates", icon: Settings },
    ],
  },
  {
    id: "wizard",
    label: "GNSS Wizard",
    defaultOpen: false,
    items: [
      { href: "/dashboard/wizard/zones", label: "Zones", icon: Globe },
      { href: "/dashboard/wizard/networks", label: "Networks", icon: Radio },
      { href: "/dashboard/wizard/network-mountpoints", label: "Network Mounts", icon: Layers },
      { href: "/dashboard/wizard/mountpoints", label: "Mountpoints", icon: Server },
      { href: "/dashboard/wizard/users", label: "Users & Groups", icon: Users },
      { href: "/dashboard/wizard/streams", label: "Streams", icon: Activity },
      { href: "/dashboard/wizard/accounts", label: "Accounts", icon: Users },
      { href: "/dashboard/wizard/config-preview", label: "Config Preview", icon: FileCode },
      { href: "/dashboard/wizard/validation", label: "Validation", icon: CheckCircle },
      { href: "/dashboard/wizard/deploy", label: "Deploy", icon: Upload },
      { href: "/dashboard/wizard/settings", label: "Caster Settings", icon: Settings },
    ],
  },
  {
    id: "system",
    label: "System",
    defaultOpen: false,
    items: [
      { href: "/dashboard/wizard/quality-scans", label: "Quality Scans", icon: Zap },
    ],
  },
];

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function NavItem({
  item, active, collapsed,
}: {
  item: NavItemDef; active: boolean; collapsed: boolean;
}) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      className={`
        group flex items-center gap-3 rounded-md px-3 py-2.5 md:py-2 text-[13px] font-medium
        transition-all duration-150 ease-in-out
        ${active
          ? "border-l-2 border-[#0067ff] bg-[var(--color-gray-50)] text-[var(--color-gray-900)] font-semibold"
          : "border-l-2 border-transparent text-[var(--color-gray-600)] hover:bg-[var(--color-gray-50)] hover:text-[var(--color-gray-900)]"
        }
        ${collapsed ? "justify-center px-2 border-l-0" : ""}
      `}
      title={collapsed ? item.label : undefined}
    >
      <Icon
        className={`h-4 w-4 shrink-0 transition-colors duration-150 ${
          active ? "text-[var(--color-gray-600)]" : "text-[var(--color-gray-400)] group-hover:text-[var(--color-gray-600)]"
        }`}
      />
      {!collapsed && <span className="truncate">{item.label}</span>}
    </Link>
  );
}

function NavSection({
  section, collapsed, isActive, expanded, onToggle,
}: {
  section: NavSectionDef; collapsed: boolean;
  isActive: (item: NavItemDef) => boolean; expanded: boolean; onToggle: () => void;
}) {
  const isOpen = section.alwaysOpen || expanded;

  if (collapsed) {
    return (
      <div className="mt-3">
        {!section.alwaysOpen && <div className="mx-2 border-t border-[var(--color-gray-100)] mb-2" />}
        <div className="space-y-0.5">
          {section.items.map((item) => (
            <NavItem key={item.href} item={item} active={isActive(item)} collapsed={collapsed} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className={section.alwaysOpen ? "" : "mt-1"}>
      {!section.alwaysOpen && (
        <button onClick={onToggle} className="w-full flex items-center justify-between px-3 mt-5 mb-1 group">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-gray-400)]">
            {section.label}
          </p>
          <ChevronDown
            className={`h-3 w-3 text-[var(--color-gray-400)] transition-transform duration-200 ${isOpen ? "" : "-rotate-90"}`}
          />
        </button>
      )}
      {isOpen && (
        <div className="space-y-0.5">
          {section.items.map((item) => (
            <NavItem key={item.href} item={item} active={isActive(item)} collapsed={collapsed} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

export function Sidebar() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {};
    for (const s of sections) initial[s.id] = s.defaultOpen ?? false;
    return initial;
  });

  useEffect(() => { setMobileOpen(false); }, [pathname]);

  // Auto-expand section if current path is in it
  useEffect(() => {
    for (const s of sections) {
      if (s.items.some(i => pathname.startsWith(i.href))) {
        setExpandedSections(prev => ({ ...prev, [s.id]: true }));
      }
    }
  }, [pathname]);

  function isActive(item: NavItemDef) {
    if (item.exact) return pathname === item.href;
    return pathname.startsWith(item.href);
  }

  const sidebarContent = (
    <>
      {/* Logo */}
      <div className={`flex items-center h-14 border-b border-[var(--color-gray-200)] ${collapsed ? "justify-center px-2" : "px-4"}`}>
        {collapsed ? (
          <div className="w-8 h-8 rounded-lg bg-[#0067ff] flex items-center justify-center">
            <span className="text-white font-bold text-sm">R</span>
          </div>
        ) : (
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-[#0067ff] flex items-center justify-center">
              <span className="text-white font-bold text-sm">R</span>
            </div>
            <div>
              <p className="text-[13px] font-semibold text-[var(--color-gray-900)]">RTKdata</p>
              <p className="text-[10px] text-[var(--color-gray-400)]">Integrity Engine</p>
            </div>
          </div>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-2 py-3 space-y-1">
        {sections.map((section) => (
          <NavSection
            key={section.id}
            section={section}
            collapsed={collapsed}
            isActive={isActive}
            expanded={expandedSections[section.id] ?? false}
            onToggle={() => setExpandedSections(prev => ({ ...prev, [section.id]: !prev[section.id] }))}
          />
        ))}
      </nav>

      {/* Footer */}
      {!collapsed && (
        <div className="border-t border-[var(--color-gray-200)] px-4 py-3">
          <p className="text-[11px] text-[var(--color-gray-400)]">
            Integrity Engine v0.2
          </p>
        </div>
      )}

      {/* Collapse Toggle */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="hidden md:flex absolute -right-3 top-20 w-6 h-6 items-center justify-center rounded-full border border-[var(--color-gray-200)] bg-white shadow-sm hover:bg-[var(--color-gray-50)] transition-colors"
      >
        <ChevronLeft className={`h-3 w-3 text-[var(--color-gray-500)] transition-transform duration-200 ${collapsed ? "rotate-180" : ""}`} />
      </button>
    </>
  );

  return (
    <>
      {/* Mobile hamburger */}
      <button
        onClick={() => setMobileOpen(true)}
        className="md:hidden fixed top-3 left-3 z-50 p-2 rounded-lg bg-white border border-[var(--color-gray-200)] shadow-sm"
      >
        <Menu className="h-5 w-5 text-[var(--color-gray-600)]" />
      </button>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div className="md:hidden fixed inset-0 z-40">
          <div className="absolute inset-0 bg-black/20 backdrop-blur-sm" onClick={() => setMobileOpen(false)} />
          <aside className="relative w-60 h-full bg-white border-r border-[var(--color-gray-200)] flex flex-col shadow-lg">
            <button onClick={() => setMobileOpen(false)} className="absolute top-3 right-3 p-1">
              <X className="h-4 w-4 text-[var(--color-gray-500)]" />
            </button>
            {sidebarContent}
          </aside>
        </div>
      )}

      {/* Desktop sidebar */}
      <aside
        className={`hidden md:flex flex-col h-screen bg-white border-r border-[var(--color-gray-200)] relative transition-all duration-200 ease-in-out sticky top-0 ${
          collapsed ? "w-14" : "w-56"
        }`}
      >
        {sidebarContent}
      </aside>
    </>
  );
}
