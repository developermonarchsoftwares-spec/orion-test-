'use client';

import React from 'react';
import { cn } from '@/lib/utils';
import {
  LayoutDashboard,
  Database,
  UploadCloud,
  History,
  ShieldAlert,
  CopyX,
  Layers,
  Sparkles,
  CheckCircle2,
  UserCheck,
  Users,
  CreditCard,
  BarChart3,
  Settings,
  ScrollText,
  ChevronLeft,
  ChevronRight,
  Server,
  ShieldCheck,
  LifeBuoy,
  BrainCircuit,
  Radio,
  Cpu,
  Workflow,
  RefreshCw,
  HeartPulse
} from 'lucide-react';
import { AdminTab } from '@/types/admin';

export { type AdminTab };

interface AdminSidebarProps {
  activeTab: AdminTab;
  onSelectTab: (tab: AdminTab) => void;
  badgeCounts: {
    pendingReviews: number;
    duplicates: number;
    validationErrors: number;
    failedImports: number;
    openTickets?: number;
    enrichmentQueue?: number;
  };
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  /** Only a Super Admin sees "Roles & Permissions". Defaults to false, so the entry stays hidden unless this is passed as true. */
  isSuperAdmin?: boolean;
}

interface NavItem {
  id: AdminTab;
  label: string;
  icon: React.ElementType;
  badge?: string;
  alertCount?: number;
  tag?: string;
}

interface NavSection {
  group: string;
  items: NavItem[];
}

export function AdminSidebar({
  activeTab,
  onSelectTab,
  badgeCounts,
  isCollapsed,
  onToggleCollapse,
  isSuperAdmin = false
}: AdminSidebarProps) {
  const navSections: NavSection[] = [
    {
      group: 'DATA MANAGEMENT',
      items: [
        { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
        { id: 'records', label: 'Business Records', icon: Database, badge: '1.2M+' },
        { id: 'import', label: 'Import Data', icon: UploadCloud },
        { id: 'history', label: 'Import History', icon: History, alertCount: badgeCounts.failedImports },
        { id: 'upload_ops', label: 'Upload Operations', icon: UploadCloud },
        { id: 'people_import', label: 'People Import', icon: UserCheck },
      ]
    },
    {
      group: 'QUALITY & PIPELINE',
      items: [
        { id: 'validation', label: 'Data Validation', icon: ShieldAlert, alertCount: badgeCounts.validationErrors },
        { id: 'duplicates', label: 'Duplicate Manager', icon: CopyX, alertCount: badgeCounts.duplicates },
        { id: 'publish_queue', label: 'Publish Queue', icon: Layers, alertCount: badgeCounts.pendingReviews },
        { id: 'people_review', label: 'People Review', icon: UserCheck },
        { id: 'data_quality', label: 'Data Quality Metrics', icon: ShieldAlert },
        { id: 'enrichment', label: 'Data Enrichment', icon: Sparkles, tag: 'LEGACY' },
        { id: 'published', label: 'Published Businesses', icon: CheckCircle2 },
      ]
    },
    {
      group: 'DATA INTELLIGENCE & AI',
      items: [
        { id: 'data_intelligence', label: 'Data Intelligence', icon: BrainCircuit },
        { id: 'sources', label: 'Data Sources', icon: Radio, badge: '8 APIs' },
        { id: 'enrichment_queue', label: 'Enrichment Queue', icon: Sparkles, alertCount: badgeCounts.enrichmentQueue },
        { id: 'ai_processing', label: 'AI Processing', icon: Cpu },
        { id: 'automation', label: 'Automation & Rules', icon: Workflow },
        { id: 'sync_center', label: 'Sync Center', icon: RefreshCw },
        { id: 'system_health', label: 'System Health', icon: HeartPulse },
      ]
    },
    {
      group: 'PLATFORM ADMINISTRATION',
      items: [
        { id: 'reports', label: 'Reports & Analytics', icon: BarChart3 },
        { id: 'users', label: 'Users & Customers', icon: Users },
        { id: 'credits', label: 'Credits & Transactions', icon: CreditCard },
        { id: 'roles', label: 'Roles & Permissions', icon: ShieldCheck },
        { id: 'settings', label: 'System Settings', icon: Settings },
        { id: 'logs', label: 'Activity Logs', icon: ScrollText },
        { id: 'support', label: 'Support Center', icon: LifeBuoy, alertCount: badgeCounts.openTickets },
      ]
    }
  ];

  return (
    <aside
      className={cn(
        'sticky top-0 h-screen flex flex-col border-r border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 transition-all duration-200 z-30 shrink-0 select-none',
        isCollapsed ? 'w-16' : 'w-64'
      )}
    >
      {/* Header / Environment Badge */}
      <div className="h-16 border-b border-zinc-200 dark:border-zinc-800 px-3.5 flex items-center justify-between shrink-0">
        {!isCollapsed ? (
          <div className="flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
            </span>
            <span className="text-xs font-bold tracking-wider text-zinc-900 dark:text-zinc-100 uppercase">
              DATA PLATFORM
            </span>
            <span className="text-[10px] font-mono bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 px-1.5 py-0.5 rounded border border-zinc-200 dark:border-zinc-700">
              v2.4
            </span>
          </div>
        ) : (
          <span className="relative flex h-2 w-2 mx-auto">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
          </span>
        )}

        <button
          onClick={onToggleCollapse}
          title={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="p-1.5 rounded-md text-zinc-400 hover:text-zinc-900 dark:hover:text-white hover:bg-zinc-100 dark:hover:bg-zinc-900 transition-colors cursor-pointer"
        >
          {isCollapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
        </button>
      </div>

      {/* Nav List */}
      <div className="flex-1 overflow-y-auto p-2 space-y-4 scrollbar-thin">
        {navSections.map((section) => (
          <div key={section.group} className="space-y-0.5">
            {!isCollapsed && (
              <div className="px-2.5 py-1 text-[10px] font-bold text-zinc-400 dark:text-zinc-500 tracking-wider">
                {section.group}
              </div>
            )}
            {section.items.filter((item) => item.id !== 'roles' || isSuperAdmin).map((item) => {
              const isActive = activeTab === item.id;
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  onClick={() => onSelectTab(item.id)}
                  title={isCollapsed ? item.label : undefined}
                  className={cn(
                    'w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-xs font-medium transition-all text-left cursor-pointer group relative',
                    isActive
                      ? 'bg-indigo-50/90 dark:bg-zinc-800/90 text-indigo-700 dark:text-white font-semibold shadow-xs border border-indigo-200/80 dark:border-zinc-700/60'
                      : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-950 dark:hover:text-white hover:bg-zinc-100 dark:hover:bg-zinc-900/60'
                  )}
                >
                  {isActive && (
                    <span className="absolute left-0 top-1.5 bottom-1.5 w-1 rounded-r-full bg-indigo-500" />
                  )}
                  <Icon
                    className={cn(
                      'w-4 h-4 shrink-0 transition-transform group-hover:scale-105',
                      isActive ? 'text-indigo-600 dark:text-indigo-400' : 'text-zinc-400 dark:text-zinc-500'
                    )}
                  />
                  {!isCollapsed && (
                    <>
                      <span className="truncate flex-1">{item.label}</span>
                      {item.badge && (
                        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded-md font-semibold bg-blue-500/15 text-blue-500 dark:text-blue-400 border border-blue-500/20">
                          {item.badge}
                        </span>
                      )}
                      {item.alertCount ? (
                        <span className="text-[10px] font-mono bg-rose-500/20 text-rose-600 dark:text-rose-300 border border-rose-500/30 px-1.5 py-0.5 rounded-full font-bold">
                          {item.alertCount}
                        </span>
                      ) : null}
                      {item.tag && (
                        <span className="text-[9px] font-mono font-bold px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 border border-zinc-200 dark:border-zinc-700">
                          {item.tag}
                        </span>
                      )}
                    </>
                  )}
                  {isCollapsed && item.alertCount ? (
                    <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-rose-500 ring-2 ring-white dark:ring-zinc-950" />
                  ) : null}
                </button>
              );
            })}
          </div>
        ))}
      </div>

      {/* Cluster Footer Health */}
      <div className="p-3 border-t border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-900/40">
        {!isCollapsed ? (
          <div className="flex items-center justify-between text-[11px] text-zinc-500">
            <div className="flex items-center gap-2">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
              </span>
              <span className="font-mono font-medium text-zinc-700 dark:text-zinc-300">Cluster: 99.98%</span>
            </div>
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-semibold">
              Optimal
            </span>
          </div>
        ) : (
          <Server className="w-4 h-4 text-emerald-400 mx-auto" />
        )}
      </div>
    </aside>
  );
}
