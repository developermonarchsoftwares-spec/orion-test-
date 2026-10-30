'use client';

import React, { useState } from 'react';
import { 
  Search, 
  UploadCloud, 
  Download, 
  RefreshCw, 
  Bell,
  CheckCircle2,
  AlertCircle,
  CreditCard,
  UserPlus,
  LifeBuoy,
  FileCheck2,
  LogOut,
  X,
  Sun,
  Moon
} from 'lucide-react';
import { AdminTab } from './admin-sidebar';

interface AdminHeaderProps {
  activeTab: AdminTab;
  onOpenSearch: () => void;
  onNavigateTab: (tab: AdminTab) => void;
  onRefreshData?: () => void;
  isRefreshing?: boolean;
  adminEmail?: string;
  onSignOut?: () => void;
  isDark?: boolean;
  onToggleTheme?: () => void;
}

const TAB_TITLES: Record<AdminTab, { title: string; subtitle: string }> = {
  dashboard: {
    title: 'Operations Dashboard',
    subtitle: 'System-wide ingest rates, data quality scores & operational pipeline'
  },
  records: {
    title: 'Business Records Master',
    subtitle: 'Explore, filter and edit 1.2M+ validated and draft business records'
  },
  import: {
    title: 'Import & Ingestion Wizard',
    subtitle: 'Upload CSV/Excel, map 20+ columns and run real-time schema validation'
  },
  history: {
    title: 'Import History & Batches',
    subtitle: 'Audit log of historical ingestion jobs, error logs, and retry handlers'
  },
  validation: {
    title: 'Data Quality & Validation Rules',
    subtitle: 'Catch missing business names, invalid contact details and format violations'
  },
  duplicates: {
    title: 'Deduplication & Merge Engine',
    subtitle: 'Resolve similarity conflicts across phone numbers, emails, domains and addresses'
  },
  publish_queue: {
    title: 'Publish Queue & Approval Pipeline',
    subtitle: 'Final verification gate: approve, publish, reject or draft businesses for Discover'
  },
  data_quality: {
    title: 'Data Quality & Pipeline Metrics',
    subtitle: 'Factual counts over uploads, People, review, verification, conflicts and pipeline health'
  },
  upload_ops: {
    title: 'Upload Operations',
    subtitle: 'Batch status, row outcomes and People results of manual uploads: counts and reason codes only'
  },
  people_import: {
    title: 'People Import',
    subtitle: 'Import a People Pipeline export (CSV or JSON): dry run, background progress and history, with counts and reason codes only'
  },
  people_review: {
    title: 'People Review & Publishing',
    subtitle: 'Review decision makers found by ingestion: approve roles one by one, correct data, quarantine or suppress'
  },
  rights_queue: {
    title: 'Privacy Requests',
    subtitle: 'Data-rights requests under the DPDP Act: access, correction, erasure, withdrawal, grievance and nomination'
  },
  enrichment: {
    title: 'Data Enrichment Pipeline',
    subtitle: 'Queue workers for automated web scraping, GST lookup, and social intelligence'
  },
  published: {
    title: 'Published Businesses (Live Directory)',
    subtitle: 'Live verified businesses visible to Orion subscribers in Discover'
  },
  users: {
    title: 'Customer & User Management',
    subtitle: 'Manage Orion subscribers, account statuses, credit allocations, and usage history'
  },
  credits: {
    title: 'Credits Economy & Transactions',
    subtitle: 'Track platform credit purchases, consumption rates, invoices, and refund requests'
  },
  roles: {
    title: 'Roles & Granular Permissions',
    subtitle: 'Define role matrices (Super Admin, Reviewer, Support, Finance) across 12 modules'
  },
  reports: {
    title: 'Executive Reports & Platform Analytics',
    subtitle: '12 KPI cards, growth curves, geographic distributions, and master data exports'
  },
  settings: {
    title: 'System & Application Settings',
    subtitle: 'Configure taxonomies, credit packages, subscription tiers, validation & email templates'
  },
  logs: {
    title: 'Immutable Platform Activity Logs',
    subtitle: 'Audit every user registration, authentication, data update, and ledger transaction'
  },
  support: {
    title: 'Customer Support Center',
    subtitle: 'Manage support tickets, SLAs, resolution timelines, and customer inquiries'
  },
  data_intelligence: {
    title: 'Data Intelligence & AI Orchestration',
    subtitle: 'Holistic data quality metrics, enrichment pipeline throughput, and automated scoring'
  },
  sources: {
    title: 'Government & External Data Sources',
    subtitle: 'Manage 8 multi-channel ingestion connectors (MSME, MCA, GST, FSSAI, Startup India)'
  },
  enrichment_queue: {
    title: 'Async Data Enrichment Queue',
    subtitle: 'Real-time job queue for website detection, phone verification, social and AI summaries'
  },
  ai_processing: {
    title: 'AI Processing & Deep Inference Engine',
    subtitle: 'Transformer classification, neural deduplication, opportunity scoring & lookalike graphs'
  },
  automation: {
    title: 'Automation & Rule Builder',
    subtitle: 'Trigger-condition-action workflow engine for auto-publishing, categorization & quarantine'
  },
  sync_center: {
    title: 'Search Index & Sync Center',
    subtitle: 'Monitor 1.12M+ Elasticsearch index documents, shard distribution & reindex sync'
  },
  system_health: {
    title: 'Platform Infrastructure Health',
    subtitle: 'Observability across ingestion, validation, database, and AI GPU workers'
  }
};

interface NotificationItem {
  id: string;
  type: 'import' | 'validation' | 'publish' | 'payment' | 'user' | 'support';
  title: string;
  description: string;
  time: string;
  read: boolean;
  actionTab?: AdminTab;
}

const INITIAL_NOTIFICATIONS: NotificationItem[] = [
  {
    id: 'notif-1',
    type: 'payment',
    title: 'Payment Received',
    description: 'Aarav Singhania purchased Scale Credit Pack (₹44,999)',
    time: '5 mins ago',
    read: false,
    actionTab: 'credits'
  },
  {
    id: 'notif-2',
    type: 'support',
    title: 'Support Ticket Created',
    description: 'Critical Ticket TCK-404 created: Suspension notice inquiry',
    time: '25 mins ago',
    read: false,
    actionTab: 'support'
  },
  {
    id: 'notif-3',
    type: 'publish',
    title: 'Businesses Published',
    description: '142 verified records from Maharashtra published to Discover',
    time: '1 hour ago',
    read: false,
    actionTab: 'published'
  },
  {
    id: 'notif-4',
    type: 'user',
    title: 'New User Registered',
    description: 'Ananya Roy (Bengal Analytics) created a new Starter account',
    time: '2 hours ago',
    read: true,
    actionTab: 'users'
  },
  {
    id: 'notif-5',
    type: 'import',
    title: 'Import Completed',
    description: 'Batch IMP-4829 successfully ingested 14,200 records',
    time: '4 hours ago',
    read: true,
    actionTab: 'history'
  },
  {
    id: 'notif-6',
    type: 'validation',
    title: 'Validation Completed',
    description: 'Automated verification check completed for Karnataka batch',
    time: '6 hours ago',
    read: true,
    actionTab: 'validation'
  }
];

export function AdminHeader({
  activeTab,
  onOpenSearch,
  onNavigateTab,
  onRefreshData,
  isRefreshing,
  adminEmail,
  onSignOut,
  isDark = true,
  onToggleTheme,
}: AdminHeaderProps) {
  const current = TAB_TITLES[activeTab] || { title: 'Admin Platform', subtitle: 'Platform Operations' };
  const [notifications, setNotifications] = useState<NotificationItem[]>(INITIAL_NOTIFICATIONS);
  const [showNotifDropdown, setShowNotifDropdown] = useState(false);

  const unreadCount = notifications.filter(n => !n.read).length;

  const handleMarkAllRead = () => {
    setNotifications(prev => prev.map(n => ({ ...n, read: true })));
  };

  const handleNotificationClick = (item: NotificationItem) => {
    setNotifications(prev => prev.map(n => n.id === item.id ? { ...n, read: true } : n));
    if (item.actionTab) {
      onNavigateTab(item.actionTab);
    }
    setShowNotifDropdown(false);
  };

  const getNotificationIcon = (type: NotificationItem['type']) => {
    switch (type) {
      case 'payment':
        return <CreditCard className="w-3.5 h-3.5 text-zinc-700 dark:text-zinc-300" />;
      case 'support':
        return <LifeBuoy className="w-3.5 h-3.5 text-zinc-700 dark:text-zinc-300" />;
      case 'publish':
        return <CheckCircle2 className="w-3.5 h-3.5 text-zinc-700 dark:text-zinc-300" />;
      case 'user':
        return <UserPlus className="w-3.5 h-3.5 text-zinc-700 dark:text-zinc-300" />;
      case 'import':
        return <UploadCloud className="w-3.5 h-3.5 text-zinc-700 dark:text-zinc-300" />;
      case 'validation':
        return <FileCheck2 className="w-3.5 h-3.5 text-zinc-700 dark:text-zinc-300" />;
      default:
        return <AlertCircle className="w-3.5 h-3.5 text-zinc-700 dark:text-zinc-300" />;
    }
  };

  return (
    <header className="h-16 shrink-0 border-b border-zinc-200 dark:border-zinc-800/80 bg-white/90 dark:bg-zinc-950/80 backdrop-blur-xl px-6 flex items-center justify-between sticky top-0 z-20 transition-colors duration-200">
      {/* Title and Breadcrumb */}
      <div className="flex flex-col justify-center">
        <div className="flex items-center gap-2 text-[10px] font-mono tracking-wide leading-none mb-1">
          <span className="text-zinc-500 dark:text-zinc-400 font-semibold flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-indigo-500" />
            ORION ADMIN
          </span>
          <span className="text-zinc-300 dark:text-zinc-600">/</span>
          <span className="uppercase text-indigo-600 dark:text-indigo-400 font-bold bg-indigo-50 dark:bg-indigo-500/10 border border-indigo-200 dark:border-indigo-500/20 px-1.5 py-0.5 rounded leading-none">
            {activeTab}
          </span>
        </div>
        <h1 className="text-lg font-bold text-zinc-900 dark:text-white tracking-tight leading-tight">
          {current.title}
        </h1>
      </div>

      {/* Action Toolbar */}
      <div className="flex items-center gap-2.5">
        {/* Global Admin Search Trigger */}
        <button
          onClick={onOpenSearch}
          type="button"
          className="flex items-center gap-2.5 px-3 h-9 text-xs text-zinc-500 dark:text-zinc-400 bg-zinc-100 dark:bg-zinc-900/90 hover:bg-zinc-200/80 dark:hover:bg-zinc-800 rounded-xl border border-zinc-200 dark:border-zinc-800 hover:border-zinc-300 dark:hover:border-zinc-700 transition-all cursor-pointer w-48 sm:w-60 justify-between shadow-xs"
        >
          <div className="flex items-center gap-2 truncate">
            <Search className="w-3.5 h-3.5 text-zinc-400" />
            <span className="truncate">Search businesses, users...</span>
          </div>
          <kbd className="hidden sm:inline-flex items-center px-1.5 py-0.5 text-[10px] font-mono font-semibold text-zinc-500 dark:text-zinc-400 bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded">
            ⌘K
          </kbd>
        </button>

        {/* Notifications Dropdown Trigger */}
        <div className="relative">
          <button
            onClick={() => setShowNotifDropdown(prev => !prev)}
            title="Platform Notifications"
            className="h-9 w-9 flex items-center justify-center text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white bg-zinc-100 dark:bg-zinc-900 hover:bg-zinc-200/80 dark:hover:bg-zinc-800 border border-zinc-200 dark:border-zinc-800 hover:border-zinc-300 dark:hover:border-zinc-700 rounded-xl transition-all cursor-pointer relative shadow-xs"
          >
            <Bell className="w-4 h-4" />
            {unreadCount > 0 && (
              <span className="absolute -top-1 -right-1 w-4 h-4 bg-indigo-500 text-white text-[9px] font-bold rounded-full flex items-center justify-center ring-2 ring-white dark:ring-zinc-950">
                {unreadCount}
              </span>
            )}
          </button>

          {/* Notifications Dropdown Panel */}
          {showNotifDropdown && (
            <div className="absolute right-0 mt-2 w-80 sm:w-96 bg-white/95 dark:bg-zinc-900/95 border border-zinc-200 dark:border-zinc-800 rounded-2xl shadow-2xl p-4 z-50 text-zinc-900 dark:text-zinc-100 animate-in fade-in backdrop-blur-xl">
              <div className="flex items-center justify-between pb-3 border-b border-zinc-200 dark:border-zinc-800">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold uppercase tracking-wider text-zinc-800 dark:text-zinc-200">Admin Notifications</span>
                  {unreadCount > 0 && (
                    <span className="text-[10px] font-mono font-bold bg-indigo-50 dark:bg-indigo-500/20 text-indigo-600 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-500/30 px-1.5 py-0.5 rounded-full">
                      {unreadCount} new
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {unreadCount > 0 && (
                    <button
                      onClick={handleMarkAllRead}
                      className="text-[11px] text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100 transition"
                    >
                      Mark all read
                    </button>
                  )}
                  <button
                    onClick={() => setShowNotifDropdown(false)}
                    className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 p-0.5 cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              <div className="max-h-80 overflow-y-auto space-y-1.5 py-2 divide-y divide-zinc-100 dark:divide-zinc-800/40 scrollbar-thin">
                {notifications.map(item => (
                  <div
                    key={item.id}
                    onClick={() => handleNotificationClick(item)}
                    className={`p-2.5 rounded-xl flex items-start gap-3 cursor-pointer transition ${
                      item.read 
                        ? 'hover:bg-zinc-100/70 dark:hover:bg-zinc-800/40' 
                        : 'bg-zinc-50 dark:bg-zinc-800/30 hover:bg-zinc-100 dark:hover:bg-zinc-800/70 border border-zinc-200/80 dark:border-zinc-800'
                    }`}
                  >
                    <div className="p-1.5 rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 mt-0.5 shrink-0">
                      {getNotificationIcon(item.type)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-1">
                        <span className="text-xs font-bold text-zinc-900 dark:text-zinc-100 truncate">{item.title}</span>
                        <span className="text-[10px] text-zinc-400 dark:text-zinc-500 shrink-0">{item.time}</span>
                      </div>
                      <p className="text-xs text-zinc-600 dark:text-zinc-400 mt-0.5 leading-relaxed line-clamp-2">
                        {item.description}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Theme Toggle Button */}
        {onToggleTheme && (
          <button
            id="admin-theme-toggle"
            onClick={onToggleTheme}
            title={isDark ? 'Switch to Light theme' : 'Switch to Dark theme'}
            aria-label={isDark ? 'Switch to Light theme' : 'Switch to Dark theme'}
            className="group relative h-9 w-9 flex items-center justify-center bg-zinc-100 dark:bg-zinc-900 hover:bg-zinc-200/80 dark:hover:bg-zinc-800 border border-zinc-200 dark:border-zinc-800 hover:border-zinc-300 dark:hover:border-zinc-700 rounded-xl transition-all duration-200 cursor-pointer shadow-xs overflow-hidden"
          >
            {/* Animated icon swap */}
            <span
              className={`absolute inset-0 flex items-center justify-center transition-all duration-300 ${
                isDark ? 'opacity-100 translate-y-0 scale-100' : 'opacity-0 translate-y-2 scale-75'
              }`}
            >
              <Sun className="w-4 h-4 text-amber-500 group-hover:text-amber-600 dark:text-amber-400 dark:group-hover:text-amber-300" />
            </span>
            <span
              className={`absolute inset-0 flex items-center justify-center transition-all duration-300 ${
                !isDark ? 'opacity-100 translate-y-0 scale-100' : 'opacity-0 -translate-y-2 scale-75'
              }`}
            >
              <Moon className="w-4 h-4 text-indigo-600 group-hover:text-indigo-700 dark:text-indigo-400 dark:group-hover:text-indigo-300" />
            </span>
            {/* Tooltip */}
            <span className="pointer-events-none absolute -bottom-8 left-1/2 -translate-x-1/2 whitespace-nowrap text-[10px] font-medium bg-zinc-900 dark:bg-zinc-800 text-white dark:text-zinc-200 border border-zinc-800 dark:border-zinc-700 px-2 py-0.5 rounded-md opacity-0 group-hover:opacity-100 transition-opacity duration-150 z-50">
              {isDark ? 'Light mode' : 'Dark mode'}
            </span>
          </button>
        )}

        {/* Refresh Button */}
        {onRefreshData && (
          <button
            onClick={onRefreshData}
            title="Refresh current data"
            className="h-9 w-9 flex items-center justify-center text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white bg-zinc-100 dark:bg-zinc-900 hover:bg-zinc-200/80 dark:hover:bg-zinc-800 border border-zinc-200 dark:border-zinc-800 hover:border-zinc-300 dark:hover:border-zinc-700 rounded-xl transition-all cursor-pointer shadow-xs"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
          </button>
        )}

        {/* Admin Identity Badge */}
        {adminEmail && (
          <div className="hidden lg:flex items-center gap-2 px-3 h-9 rounded-xl bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 text-[11px] shadow-xs text-zinc-800 dark:text-zinc-200">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
            </span>
            <span className="font-medium truncate max-w-[170px]">{adminEmail}</span>
            <span className="text-[9px] font-mono font-bold px-1.5 py-0.5 rounded bg-indigo-50 dark:bg-indigo-500/20 text-indigo-600 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-500/30">
              ADMIN
            </span>
          </div>
        )}

        {/* Admin Sign Out */}
        {onSignOut && (
          <button
            onClick={onSignOut}
            title="Sign out of Admin Portal"
            className="inline-flex items-center gap-1.5 px-2.5 h-9 rounded-xl text-xs font-medium text-zinc-600 dark:text-zinc-400 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-rose-50 dark:hover:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 hover:border-rose-300 dark:hover:border-rose-500/30 transition-all cursor-pointer shadow-xs"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Logout</span>
          </button>
        )}

        {/* Quick Ingest Button */}
        <button
          onClick={() => onNavigateTab('import')}
          className="inline-flex items-center gap-2 px-3.5 h-9 rounded-xl text-xs font-semibold bg-gradient-to-r from-blue-600 via-indigo-600 to-violet-600 hover:from-blue-500 hover:via-indigo-500 hover:to-violet-500 text-white shadow-lg shadow-indigo-500/25 hover:shadow-indigo-500/40 border border-white/10 transition-all cursor-pointer shrink-0"
        >
          <UploadCloud className="w-4 h-4" />
          <span>New Import</span>
        </button>
      </div>
    </header>
  );
}
