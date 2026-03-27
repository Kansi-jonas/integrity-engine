"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import { useState, useEffect } from "react";
import {
  LayoutDashboard,
  TrendingUp,
  Users,
  UserMinus,
  Globe,
  Calculator,
  BarChart3,
  UserPlus,
  ChevronLeft,
  ChevronDown,
  Menu,
  X,
  RefreshCw,
  Activity,
  HeartPulse,
  Radio,
  Radar,
  Contact,
  Map,
  Link2,
  ShoppingCart,
  Wifi,
  Rocket,
  Bot,
  Inbox,
  Mail,
  Zap,
  Shield,
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
// Data
// ---------------------------------------------------------------------------

const sections: NavSectionDef[] = [
  {
    id: "core",
    label: "Core",
    alwaysOpen: true,
    defaultOpen: true,
    items: [
      { href: "/dashboard/command-center", label: "Mission Control", icon: Radar, exact: true },
      { href: "/dashboard", label: "Executive Overview", icon: LayoutDashboard, exact: true },
      { href: "/dashboard/revenue", label: "Revenue Deep-Dive", icon: TrendingUp },
      { href: "/dashboard/growth", label: "Growth Cockpit", icon: Rocket, exact: true },
    ],
  },
  {
    id: "analytics",
    label: "Analytics",
    defaultOpen: true,
    items: [
      { href: "/dashboard/cohorts", label: "Cohort Analysis", icon: Users },
      { href: "/dashboard/churn", label: "Churn Analytics", icon: UserMinus },
      { href: "/dashboard/geo", label: "Geographic Intelligence", icon: Globe },
      { href: "/dashboard/unit-economics", label: "Unit Economics", icon: Calculator },
      { href: "/dashboard/monthly-kpis", label: "Monthly KPIs", icon: BarChart3 },
      { href: "/dashboard/forecast", label: "Forecast", icon: BarChart3 },
      { href: "/dashboard/trials", label: "Trial Analytics", icon: UserPlus },
    ],
  },
  {
    id: "customers",
    label: "Customers",
    defaultOpen: false,
    items: [
      { href: "/dashboard/customers", label: "Customers", icon: Contact },
      { href: "/dashboard/orders", label: "Orders", icon: ShoppingCart },
      { href: "/dashboard/rtk-accounts", label: "RTK Accounts", icon: Radio },
    ],
  },
  {
    id: "platform",
    label: "Platform",
    defaultOpen: false,
    items: [
      { href: "/dashboard/usage", label: "Usage", icon: Activity },
      { href: "/dashboard/health", label: "Health Score", icon: HeartPulse },
      { href: "/dashboard/network", label: "Network", icon: Wifi },
      { href: "/dashboard/meridian", label: "Coverage Quality", icon: Map },
      { href: "/dashboard/signal-integrity", label: "Signal Integrity", icon: Shield },
    ],
  },
  {
    id: "alex",
    label: "Alex AI",
    defaultOpen: false,
    items: [
      { href: "/dashboard/ai-inbox", label: "Alex Inbox", icon: Inbox },
      { href: "/dashboard/ai-agent", label: "Alex Engine", icon: Bot },
      { href: "/dashboard/email-flow", label: "Email Flow", icon: Zap },
      { href: "/dashboard/email-preview", label: "Email Templates", icon: Mail },
    ],
  },
  {
    id: "system",
    label: "System",
    defaultOpen: false,
    items: [
      { href: "/dashboard/hubspot", label: "HubSpot Sync", icon: Link2 },
      { href: "/dashboard/status", label: "System Status", icon: Activity },
    ],
  },
];

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function NavItem({
  item,
  active,
  collapsed,
}: {
  item: NavItemDef;
  active: boolean;
  collapsed: boolean;
}) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      className={`
        group flex items-center gap-3 rounded-md px-3 py-2.5 md:py-2 text-[13px] font-medium
        transition-all duration-150 ease-in-out
        ${
          active
            ? "border-l-2 border-[#0067ff] bg-gray-50 text-gray-900 font-semibold"
            : "border-l-2 border-transparent text-gray-600 hover:bg-gray-50 hover:text-gray-900"
        }
        ${collapsed ? "justify-center px-2 border-l-0" : ""}
      `}
      title={collapsed ? item.label : undefined}
    >
      <Icon
        className={`h-4 w-4 shrink-0 transition-colors duration-150 ${
          active ? "text-gray-600" : "text-gray-400 group-hover:text-gray-600"
        }`}
      />
      {!collapsed && <span className="truncate">{item.label}</span>}
    </Link>
  );
}

function NavSection({
  section,
  collapsed,
  isActive,
  expanded,
  onToggle,
}: {
  section: NavSectionDef;
  collapsed: boolean;
  isActive: (item: NavItemDef) => boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const isOpen = section.alwaysOpen || expanded;

  // In collapsed mode, just show a subtle divider then items (no label)
  if (collapsed) {
    return (
      <div className="mt-3">
        {!section.alwaysOpen && (
          <div className="mx-2 border-t border-gray-100 mb-2" />
        )}
        <div className="space-y-0.5">
          {section.items.map((item) => (
            <NavItem
              key={item.href}
              item={item}
              active={isActive(item)}
              collapsed={collapsed}
            />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className={section.alwaysOpen ? "" : "mt-1"}>
      {/* Section header */}
      {!section.alwaysOpen && (
        <button
          onClick={onToggle}
          className="w-full flex items-center justify-between px-3 mt-5 mb-1 group"
        >
          <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">
            {section.label}
          </p>
          <ChevronDown
            className={`h-3 w-3 text-gray-400 transition-transform duration-200 ${
              isOpen ? "" : "-rotate-90"
            }`}
          />
        </button>
      )}

      {/* Items */}
      {isOpen && (
        <div className="space-y-0.5">
          {section.items.map((item) => (
            <NavItem
              key={item.href}
              item={item}
              active={isActive(item)}
              collapsed={collapsed}
            />
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
  const [lastSynced, setLastSynced] = useState<string | null>(null);

  // Section expand/collapse state — keyed by section id
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {};
    for (const s of sections) {
      initial[s.id] = s.defaultOpen ?? false;
    }
    return initial;
  });

  useEffect(() => {
    setLastSynced(
      new Date().toLocaleTimeString("de-DE", {
        hour: "2-digit",
        minute: "2-digit",
      })
    );
  }, [pathname]);

  // Close mobile sidebar on route change
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  function isActive(item: NavItemDef) {
    if (item.exact) return pathname === item.href;
    return pathname.startsWith(item.href);
  }

  function toggleSection(id: string) {
    setExpandedSections((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  const sidebarContent = (
    <div className="flex flex-col h-full">
      {/* Logo / Brand */}
      <div className="h-14 flex items-center px-4 border-b border-gray-100 shrink-0">
        {collapsed ? (
          <img src="/logo.png" alt="RTKdata" className="h-7 mx-auto" />
        ) : (
          <img src="/logo.png" alt="RTKdata" className="h-8" />
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 py-3 px-2 overflow-y-auto">
        {sections.map((section) => (
          <NavSection
            key={section.id}
            section={section}
            collapsed={collapsed}
            isActive={isActive}
            expanded={expandedSections[section.id] ?? false}
            onToggle={() => toggleSection(section.id)}
          />
        ))}
      </nav>

      {/* Footer -- Last Synced */}
      <div className="border-t border-gray-100 px-3 py-3 shrink-0">
        {collapsed ? (
          <div className="flex justify-center" title={`Last synced: ${lastSynced}`}>
            <RefreshCw className="h-3.5 w-3.5 text-gray-400" />
          </div>
        ) : (
          <div className="flex items-center gap-2 text-xs text-gray-400">
            <RefreshCw className="h-3 w-3 shrink-0" />
            <span>Last synced: {lastSynced ?? "..."}</span>
          </div>
        )}
      </div>

      {/* Collapse toggle (desktop only) */}
      <div className="hidden lg:block border-t border-gray-100 p-2">
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="w-full flex items-center justify-center rounded-md py-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-50 transition-colors"
        >
          <ChevronLeft
            className={`h-4 w-4 transition-transform duration-200 ${
              collapsed ? "rotate-180" : ""
            }`}
          />
        </button>
      </div>
    </div>
  );

  return (
    <>
      {/* Mobile hamburger button */}
      <button
        onClick={() => setMobileOpen(true)}
        className="lg:hidden fixed top-3 left-3 z-50 h-11 w-11 p-2.5 flex items-center justify-center rounded-lg bg-white border border-gray-200 text-gray-500 hover:text-gray-900 shadow-sm transition-colors"
        aria-label="Open navigation"
      >
        <Menu className="h-5 w-5" />
      </button>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="lg:hidden fixed inset-0 z-40 bg-black/20 backdrop-blur-sm"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Mobile sidebar */}
      <aside
        className={`
          lg:hidden fixed inset-y-0 left-0 z-50 w-60 bg-white shadow-lg
          transform transition-transform duration-250 ease-in-out
          ${mobileOpen ? "translate-x-0" : "-translate-x-full"}
        `}
      >
        <button
          onClick={() => setMobileOpen(false)}
          className="absolute top-3 right-3 h-10 w-10 p-2 flex items-center justify-center rounded-md text-gray-400 hover:text-gray-600 transition-colors"
          aria-label="Close navigation"
        >
          <X className="h-4 w-4" />
        </button>
        {sidebarContent}
      </aside>

      {/* Desktop sidebar */}
      <aside
        className={`
          hidden lg:flex flex-col shrink-0
          bg-white border-r border-gray-100
          transition-[width] duration-200 ease-in-out
          ${collapsed ? "w-[60px]" : "w-[240px]"}
        `}
      >
        {sidebarContent}
      </aside>
    </>
  );
}
