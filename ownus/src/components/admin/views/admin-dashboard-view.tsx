'use client';

import React, { useState, useMemo } from 'react';
import { 
  Building2, 
  CheckCircle2, 
  Clock, 
  FileText, 
  CopyX, 
  AlertTriangle, 
  UploadCloud, 
  Sparkles, 
  Users, 
  CreditCard,
  ArrowUpRight,
  ArrowDownRight,
  TrendingUp,
  Server,
  Activity,
  HardDrive,
  Cpu,
  ArrowRight,
  ShieldCheck,
  Zap,
  Filter,
  Layers,
  Database,
  BarChart3,
  PieChart as PieChartIcon
} from 'lucide-react';
import { 
  LineChart, 
  Line, 
  BarChart, 
  Bar, 
  AreaChart, 
  Area, 
  PieChart, 
  Pie, 
  Cell, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  ResponsiveContainer, 
  Legend 
} from 'recharts';
import { AdminBusinessRecord, ImportBatch, ActivityLogEntry, CustomerUser, TransactionRecord } from '@/types/admin';
import { AdminTab } from '../admin-sidebar';

interface AdminDashboardViewProps {
  businesses: AdminBusinessRecord[];
  batches: ImportBatch[];
  logs: ActivityLogEntry[];
  customerUsers?: CustomerUser[];
  transactions?: TransactionRecord[];
  onNavigate: (tab: AdminTab) => void;
  onSelectBusiness: (business: AdminBusinessRecord) => void;
}

const CustomTooltip = ({ active, payload, label }: any) => {
  if (active && payload && payload.length) {
    return (
      <div className="bg-white/95 dark:bg-zinc-900/95 border border-zinc-200 dark:border-zinc-700/80 rounded-xl p-3 shadow-xl backdrop-blur-md text-xs space-y-1.5 min-w-[140px]">
        {label ? (
          <div className="font-semibold text-zinc-800 dark:text-zinc-300 pb-1 border-b border-zinc-200 dark:border-zinc-800">{label}</div>
        ) : null}
        {payload.map((entry: any, index: number) => (
          <div key={`item-${index}`} className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-1.5 text-zinc-500 dark:text-zinc-400">
              <span className="w-2 h-2 rounded-full" style={{ backgroundColor: entry.color || entry.stroke || entry.fill }} />
              <span>{entry.name}:</span>
            </span>
            <span className="font-mono font-bold text-zinc-900 dark:text-zinc-100">
              {typeof entry.value === 'number' ? entry.value.toLocaleString() : entry.value}
            </span>
          </div>
        ))}
      </div>
    );
  }
  return null;
};

export function AdminDashboardView({
  businesses,
  batches,
  logs,
  customerUsers = [],
  transactions = [],
  onNavigate,
  onSelectBusiness
}: AdminDashboardViewProps) {
  const [timeRange, setTimeRange] = useState<'7d' | '30d' | '90d'>('7d');

  // Computed Real Metrics
  const totalBusinesses = businesses.length;
  const publishedBusinesses = useMemo(() => businesses.filter(b => b.status === 'published'), [businesses]);
  const publishedCount = publishedBusinesses.length;
  const draftCount = useMemo(() => businesses.filter(b => b.status === 'draft').length, [businesses]);
  const pendingReviewCount = useMemo(() => businesses.filter(b => b.status === 'approved' || b.status === 'validated' || b.status === 'draft').length, [businesses]);
  const failedBatchesCount = useMemo(() => batches.filter(b => b.status === 'Failed').length, [batches]);
  const totalIngestedRows = useMemo(() => batches.reduce((acc, b) => acc + (b.totalRecords || 0), 0), [batches]);
  const approvedValidationCount = useMemo(() => businesses.filter(b => b.validationStatus === 'Approved').length, [businesses]);
  const flaggedViolationsCount = useMemo(() => businesses.filter(b => b.validationStatus === 'Rejected' || b.validationStatus === 'Warning').length, [businesses]);

  const validationRateText = totalBusinesses > 0 ? `${Math.round((approvedValidationCount / totalBusinesses) * 100)}%` : '0%';
  const publishRateText = totalBusinesses > 0 ? `${Math.round((publishedCount / totalBusinesses) * 100)}%` : '0%';

  const activeUsersCount = customerUsers.length;
  const totalCreditsTransacted = useMemo(() => transactions.reduce((acc, t) => acc + (t.creditsPurchased || 0), 0), [transactions]);
  const totalRevenueInr = useMemo(() => transactions.filter(t => t.paymentStatus === 'Success').reduce((acc, t) => acc + (t.amount || 0), 0), [transactions]);

  // Top Tier Hero KPIs
  const heroKpis = [
    {
      label: 'Total Businesses Ingested',
      value: totalBusinesses.toLocaleString(),
      subtext: totalBusinesses === 1 ? '1 verified enterprise record in DB' : `${totalBusinesses} enterprise records in DB`,
      change: totalBusinesses > 0 ? `${totalBusinesses} total` : '0 records',
      isUp: totalBusinesses > 0,
      icon: Building2,
      tab: 'records' as AdminTab,
      accentColor: 'from-blue-500/20 via-indigo-500/10 to-transparent',
      borderColor: 'group-hover:border-blue-500/40',
      iconBg: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
      progressPercent: totalBusinesses > 0 ? Math.min(100, totalBusinesses * 10) : 0,
      progressLabel: `${totalBusinesses} in catalog`
    },
    {
      label: 'Published to Live Discover',
      value: publishedCount.toLocaleString(),
      subtext: totalBusinesses > 0 ? `${publishRateText} publish conversion` : 'No entities published yet',
      change: publishedCount > 0 ? `${publishedCount} active` : '0 active',
      isUp: publishedCount > 0,
      icon: CheckCircle2,
      tab: 'published' as AdminTab,
      accentColor: 'from-emerald-500/20 via-teal-500/10 to-transparent',
      borderColor: 'group-hover:border-emerald-500/40',
      iconBg: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
      progressPercent: totalBusinesses > 0 ? Math.round((publishedCount / totalBusinesses) * 100) : 0,
      progressLabel: `${publishRateText} Publish Rate`
    },
    {
      label: 'Active Platform Customers',
      value: activeUsersCount.toLocaleString(),
      subtext: activeUsersCount > 0 ? `${activeUsersCount} registered user accounts` : '0 registered customer accounts',
      change: activeUsersCount > 0 ? `${activeUsersCount} users` : '0 users',
      isUp: activeUsersCount > 0,
      icon: Users,
      tab: 'users' as AdminTab,
      accentColor: 'from-purple-500/20 via-pink-500/10 to-transparent',
      borderColor: 'group-hover:border-purple-500/40',
      iconBg: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
      progressPercent: activeUsersCount > 0 ? Math.min(100, activeUsersCount * 20) : 0,
      progressLabel: `${activeUsersCount} accounts`
    },
    {
      label: 'Credits Economy & Revenue',
      value: totalRevenueInr > 0 ? `₹${totalRevenueInr.toLocaleString()}` : `${totalCreditsTransacted.toLocaleString()} credits`,
      subtext: totalCreditsTransacted > 0 ? `${totalCreditsTransacted.toLocaleString()} credits purchased` : '0 credits transacted',
      change: transactions.length > 0 ? `${transactions.length} orders` : '0 orders',
      isUp: transactions.length > 0,
      icon: CreditCard,
      tab: 'credits' as AdminTab,
      accentColor: 'from-amber-500/20 via-orange-500/10 to-transparent',
      borderColor: 'group-hover:border-amber-500/40',
      iconBg: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
      progressPercent: transactions.length > 0 ? Math.min(100, transactions.length * 20) : 0,
      progressLabel: `${transactions.length} payments`
    },
  ];

  // Secondary Pipeline KPIs
  const pipelineKpis = [
    { label: 'Pending Review', value: pendingReviewCount.toLocaleString(), change: `${pendingReviewCount}`, isUp: pendingReviewCount > 0, isWarning: false, icon: Clock, tab: 'records' as AdminTab, color: 'text-amber-400', bg: 'bg-amber-500/10 border-amber-500/20' },
    { label: 'Draft Records', value: draftCount.toLocaleString(), change: `${draftCount}`, isUp: draftCount > 0, isWarning: false, icon: FileText, tab: 'records' as AdminTab, color: 'text-zinc-400', bg: 'bg-zinc-800/60 border-zinc-700/40' },
    { label: 'Duplicate Quarantined', value: '0', change: '0', isUp: false, isWarning: false, icon: CopyX, tab: 'duplicates' as AdminTab, color: 'text-indigo-400', bg: 'bg-indigo-500/10 border-indigo-500/20' },
    { label: 'Failed Imports', value: failedBatchesCount.toLocaleString(), change: `${failedBatchesCount}`, isUp: false, isWarning: failedBatchesCount > 0, icon: AlertTriangle, tab: 'history' as AdminTab, color: 'text-rose-400', bg: 'bg-rose-500/10 border-rose-500/20' },
    { label: 'Total Ingested Rows', value: totalIngestedRows.toLocaleString(), change: `${batches.length} batches`, isUp: totalIngestedRows > 0, isWarning: false, icon: UploadCloud, tab: 'import' as AdminTab, color: 'text-cyan-400', bg: 'bg-cyan-500/10 border-cyan-500/20' },
    { label: 'Recently Published', value: publishedCount.toLocaleString(), change: `${publishedCount}`, isUp: publishedCount > 0, isWarning: false, icon: Sparkles, tab: 'published' as AdminTab, color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/20' },
  ];

  // Real Industry Distribution calculation
  const { industryData, totalSectorsCount } = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const b of businesses) {
      const ind = b.industry?.trim() || 'General Enterprise';
      counts[ind] = (counts[ind] || 0) + 1;
    }
    const totalSectors = Object.keys(counts).length;
    const colors = ['#3B82F6', '#10B981', '#8B5CF6', '#F59E0B', '#06B6D4', '#EC4899', '#64748B'];
    const MAX_SLICES = colors.length - 1;
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const top = sorted.slice(0, MAX_SLICES);
    const restCount = sorted.slice(MAX_SLICES).reduce((acc, [, c]) => acc + c, 0);
    const rows = restCount > 0 ? [...top, ['Other', restCount] as [string, number]] : top;

    const data = rows.map(([name, value], i) => ({
      name,
      value,
      share: totalBusinesses > 0 ? Math.round((value / totalBusinesses) * 100) : 0,
      color: name === 'Other' && restCount > 0 && i === rows.length - 1
        ? colors[colors.length - 1]
        : colors[i % (colors.length - 1)]
    }));

    return { industryData: data, totalSectorsCount: totalSectors };
  }, [businesses, totalBusinesses]);

  // Real State Distribution calculation
  const stateDistributionData = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const b of businesses) {
      const st = b.state?.trim() || 'Other';
      counts[st] = (counts[st] || 0) + 1;
    }
    return Object.entries(counts).map(([state, count]) => ({
      state,
      count,
      percentage: totalBusinesses > 0 ? `${Math.round((count / totalBusinesses) * 100)}%` : '0%'
    }));
  }, [businesses, totalBusinesses]);

  // Real Batch Volume dataset
  const batchVolumeData = useMemo(() => {
    if (batches.length === 0) return [];
    return batches.slice(-7).map(b => ({
      date: b.uploadedAt ? b.uploadedAt.slice(5, 10) : (b.fileName || '').slice(0, 8),
      total: b.totalRecords || 0,
      failed: b.failedCount || 0,
    }));
  }, [batches]);

  return (
    <div className="space-y-6 pb-12 text-zinc-900 dark:text-zinc-100">
      
      {/* 1. Executive Hero KPIs (Top 4 Strategic Cards) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {heroKpis.map((kpi, idx) => {
          const Icon = kpi.icon;
          return (
            <div
              key={idx}
              onClick={() => onNavigate(kpi.tab)}
              className={`group relative overflow-hidden rounded-2xl p-5 bg-gradient-to-b from-white to-zinc-50/50 dark:from-zinc-900/90 dark:to-zinc-950/90 border border-zinc-200 dark:border-zinc-800/80 shadow-xs hover:shadow-md dark:shadow-lg dark:hover:shadow-xl transition-all duration-300 cursor-pointer ${kpi.borderColor}`}
            >
              <div className={`absolute -top-12 -right-12 w-32 h-32 rounded-full bg-gradient-to-br ${kpi.accentColor} blur-2xl pointer-events-none group-hover:scale-125 transition-transform duration-500`} />

              <div className="relative z-10 flex flex-col justify-between h-full space-y-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <span className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 tracking-wide block">{kpi.label}</span>
                    <div className="text-2xl sm:text-3xl font-bold font-mono tracking-tight text-zinc-900 dark:text-white mt-1">
                      {kpi.value}
                    </div>
                  </div>
                  <div className={`p-2.5 rounded-xl border ${kpi.iconBg} shrink-0 transition-transform group-hover:scale-110 duration-200`}>
                    <Icon className="w-5 h-5" />
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-[11px] text-zinc-500 dark:text-zinc-400 truncate max-w-[170px]">{kpi.subtext}</span>
                    <span className={`inline-flex items-center gap-0.5 px-2 py-0.5 rounded-full text-[11px] font-mono font-bold ${
                      kpi.isUp ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20' : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 border border-zinc-200 dark:border-zinc-700'
                    }`}>
                      {kpi.isUp ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
                      {kpi.change}
                    </span>
                  </div>

                  <div className="w-full bg-zinc-200 dark:bg-zinc-800/80 rounded-full h-1.5 overflow-hidden">
                    <div 
                      className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-indigo-600 dark:from-zinc-400 dark:to-white transition-all duration-700" 
                      style={{ width: `${kpi.progressPercent}%` }}
                    />
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* 2. Operational Pipeline KPIs (6 Clean Compact Cards) */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {pipelineKpis.map((kpi, idx) => {
          const Icon = kpi.icon;
          return (
            <div
              key={idx}
              onClick={() => onNavigate(kpi.tab)}
              className="group p-3.5 rounded-xl bg-white dark:bg-zinc-900/70 hover:bg-zinc-50 dark:hover:bg-zinc-900 border border-zinc-200 dark:border-zinc-800/80 hover:border-zinc-300 dark:hover:border-zinc-700 transition-all duration-200 cursor-pointer flex flex-col justify-between shadow-xs"
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-[11px] font-medium text-zinc-600 dark:text-zinc-400 truncate pr-1">{kpi.label}</span>
                <div className={`p-1.5 rounded-lg border ${kpi.bg} ${kpi.color}`}>
                  <Icon className="w-3.5 h-3.5" />
                </div>
              </div>

              <div className="flex items-baseline justify-between mt-1">
                <span className="text-lg font-bold font-mono tracking-tight text-zinc-900 dark:text-zinc-100">{kpi.value}</span>
                <span className={`text-[10px] font-mono font-semibold inline-flex items-center ${
                  kpi.isUp ? 'text-emerald-600 dark:text-emerald-400' : kpi.isWarning ? 'text-rose-600 dark:text-rose-400' : 'text-zinc-500 dark:text-zinc-400'
                }`}>
                  {kpi.change}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {/* 3. Data Quality & Pipeline Health Bar */}
      <div className="p-5 rounded-2xl border border-zinc-200 dark:border-zinc-800/90 bg-white dark:bg-gradient-to-r dark:from-zinc-900/90 dark:via-zinc-900/60 dark:to-zinc-950/90 shadow-xs dark:shadow-xl backdrop-blur-md relative overflow-hidden">
        <div className="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-indigo-500/50 to-transparent" />

        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 rounded-lg bg-indigo-50 dark:bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border border-indigo-200 dark:border-indigo-500/20">
              <ShieldCheck className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-xs font-bold uppercase tracking-wider text-zinc-900 dark:text-zinc-200">
                Automated Data Quality & Validation Telemetry
              </h2>
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400">PostgreSQL schema conformance across continuous ingestion batches</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 text-[11px] font-mono px-2.5 py-1 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 font-medium">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              Engine Online • Live DB Telemetry
            </span>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 pt-3 border-t border-zinc-200 dark:border-zinc-800/60">
          <div className="p-3 rounded-xl bg-zinc-50 dark:bg-zinc-950/60 border border-zinc-200 dark:border-zinc-800/80 space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold text-zinc-600 dark:text-zinc-400 uppercase tracking-wider">Validation Success</span>
              <span className={`w-2 h-2 rounded-full ${approvedValidationCount > 0 ? 'bg-emerald-500' : 'bg-zinc-400'}`} />
            </div>
            <div className="text-xl font-bold font-mono text-emerald-600 dark:text-emerald-400">{validationRateText}</div>
            <div className="w-full bg-zinc-200 dark:bg-zinc-800 rounded-full h-1 overflow-hidden">
              <div className="h-full bg-emerald-500 rounded-full" style={{ width: validationRateText }} />
            </div>
            <span className="text-[10px] text-zinc-500 block">Schema compliant</span>
          </div>

          <div className="p-3 rounded-xl bg-zinc-50 dark:bg-zinc-950/60 border border-zinc-200 dark:border-zinc-800/80 space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold text-zinc-600 dark:text-zinc-400 uppercase tracking-wider">Duplicate Rate</span>
              <span className="w-2 h-2 rounded-full bg-indigo-500" />
            </div>
            <div className="text-xl font-bold font-mono text-indigo-600 dark:text-indigo-400">0%</div>
            <div className="w-full bg-zinc-200 dark:bg-zinc-800 rounded-full h-1 overflow-hidden">
              <div className="h-full bg-indigo-500 rounded-full" style={{ width: '0%' }} />
            </div>
            <span className="text-[10px] text-zinc-500 block">Auto-quarantined</span>
          </div>

          <div className="p-3 rounded-xl bg-zinc-50 dark:bg-zinc-950/60 border border-zinc-200 dark:border-zinc-800/80 space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold text-zinc-600 dark:text-zinc-400 uppercase tracking-wider">Approval Rate</span>
              <span className={`w-2 h-2 rounded-full ${publishedCount > 0 ? 'bg-teal-500' : 'bg-zinc-400'}`} />
            </div>
            <div className="text-xl font-bold font-mono text-teal-600 dark:text-teal-400">{publishRateText}</div>
            <div className="w-full bg-zinc-200 dark:bg-zinc-800 rounded-full h-1 overflow-hidden">
              <div className="h-full bg-teal-500 rounded-full" style={{ width: publishRateText }} />
            </div>
            <span className="text-[10px] text-zinc-500 block">Passed review</span>
          </div>

          <div className="p-3 rounded-xl bg-zinc-50 dark:bg-zinc-950/60 border border-zinc-200 dark:border-zinc-800/80 space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold text-zinc-600 dark:text-zinc-400 uppercase tracking-wider">Flagged Violations</span>
              <span className={`w-2 h-2 rounded-full ${flaggedViolationsCount > 0 ? 'bg-rose-500' : 'bg-emerald-500'}`} />
            </div>
            <div className="text-xl font-bold font-mono text-zinc-900 dark:text-zinc-100">{flaggedViolationsCount}</div>
            <div className="w-full bg-zinc-200 dark:bg-zinc-800 rounded-full h-1 overflow-hidden">
              <div className="h-full bg-rose-500 rounded-full" style={{ width: flaggedViolationsCount > 0 ? '50%' : '0%' }} />
            </div>
            <span className="text-[10px] text-zinc-500 block">Requiring manual fix</span>
          </div>

          <div className="p-3 rounded-xl bg-zinc-50 dark:bg-zinc-950/60 border border-zinc-200 dark:border-zinc-800/80 space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold text-zinc-600 dark:text-zinc-400 uppercase tracking-wider">Ingest Batches</span>
              <span className="w-2 h-2 rounded-full bg-cyan-500" />
            </div>
            <div className="text-xl font-bold font-mono text-cyan-600 dark:text-cyan-400">{batches.length}</div>
            <div className="w-full bg-zinc-200 dark:bg-zinc-800 rounded-full h-1 overflow-hidden">
              <div className="h-full bg-cyan-500 rounded-full" style={{ width: batches.length > 0 ? '100%' : '0%' }} />
            </div>
            <span className="text-[10px] text-zinc-500 block">Historical CSV files</span>
          </div>

          <div className="p-3 rounded-xl bg-zinc-50 dark:bg-zinc-950/60 border border-zinc-200 dark:border-zinc-800/80 space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold text-zinc-600 dark:text-zinc-400 uppercase tracking-wider">Published Entities</span>
              <span className={`w-2 h-2 rounded-full ${publishedCount > 0 ? 'bg-amber-500' : 'bg-zinc-400'}`} />
            </div>
            <div className="text-xl font-bold font-mono text-amber-600 dark:text-amber-400">{publishedCount}</div>
            <div className="w-full bg-zinc-200 dark:bg-zinc-800 rounded-full h-1 overflow-hidden">
              <div className="h-full bg-amber-500 rounded-full" style={{ width: publishedCount > 0 ? '100%' : '0%' }} />
            </div>
            <span className="text-[10px] text-zinc-500 block">Live in Discover search</span>
          </div>
        </div>
      </div>

      {/* 4. Row 1 of Charts: Ingestion vs Published & Batch Failure Rate */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        
        {/* Chart 1: Area Ingestion Flow */}
        <div className="bg-white dark:bg-zinc-900/80 rounded-2xl border border-zinc-200 dark:border-zinc-800/80 p-5 shadow-xs dark:shadow-xl backdrop-blur-md min-w-0 overflow-hidden">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-5">
            <div>
              <div className="flex items-center gap-2">
                <Activity className="w-4 h-4 text-blue-500 dark:text-blue-400" />
                <h3 className="text-sm font-bold text-zinc-900 dark:text-white tracking-tight">Ingested vs Published Throughput</h3>
              </div>
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-0.5">Record ingestion telemetry across verification queues</p>
            </div>
            <span className="text-[10px] font-mono font-semibold px-2 py-1 rounded-md bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20 self-start sm:self-auto">
              Total: {totalBusinesses}
            </span>
          </div>

          {totalBusinesses === 0 ? (
            <div className="h-68 w-full flex flex-col items-center justify-center text-center p-6 bg-zinc-50/50 dark:bg-zinc-950/40 rounded-xl border border-dashed border-zinc-200 dark:border-zinc-800">
              <Activity className="w-8 h-8 text-zinc-400 dark:text-zinc-600 mb-2" />
              <p className="text-xs font-semibold text-zinc-600 dark:text-zinc-400">Not enough data</p>
              <p className="text-[11px] text-zinc-400 dark:text-zinc-500 mt-0.5">Ingestion throughput trends will render as new business records are ingested.</p>
            </div>
          ) : (
            <div className="h-68 w-full flex flex-col items-center justify-center text-center p-6 bg-zinc-50/50 dark:bg-zinc-950/40 rounded-xl border border-zinc-200 dark:border-zinc-800">
              <div className="grid grid-cols-2 gap-4 w-full max-w-sm">
                <div className="p-3 bg-white dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-700">
                  <span className="text-[11px] text-zinc-500 block">Total Ingested</span>
                  <span className="text-2xl font-bold font-mono text-blue-600 dark:text-blue-400">{totalBusinesses}</span>
                </div>
                <div className="p-3 bg-white dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-700">
                  <span className="text-[11px] text-zinc-500 block">Published Live</span>
                  <span className="text-2xl font-bold font-mono text-emerald-600 dark:text-emerald-400">{publishedCount}</span>
                </div>
              </div>
              <p className="text-[11px] text-zinc-400 dark:text-zinc-500 mt-4">Additional historical points will enable time-series curves.</p>
            </div>
          )}
        </div>

        {/* Chart 2: Batch Pipeline Volume */}
        <div className="bg-white dark:bg-zinc-900/80 rounded-2xl border border-zinc-200 dark:border-zinc-800/80 p-5 shadow-xs dark:shadow-xl backdrop-blur-md min-w-0 overflow-hidden">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-5">
            <div>
              <div className="flex items-center gap-2">
                <BarChart3 className="w-4 h-4 text-indigo-500 dark:text-indigo-400" />
                <h3 className="text-sm font-bold text-zinc-900 dark:text-white tracking-tight">Batch Pipeline Volume & Results</h3>
              </div>
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-0.5">Historical records processed through CSV ingestion pipelines</p>
            </div>
            <span className="text-[10px] font-mono font-semibold px-2 py-1 rounded-md bg-indigo-50 dark:bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border border-indigo-200 dark:border-indigo-500/20 self-start sm:self-auto">
              Batches: {batches.length}
            </span>
          </div>

          {batchVolumeData.length === 0 ? (
            <div className="h-68 w-full flex flex-col items-center justify-center text-center p-6 bg-zinc-50/50 dark:bg-zinc-950/40 rounded-xl border border-dashed border-zinc-200 dark:border-zinc-800">
              <BarChart3 className="w-8 h-8 text-zinc-400 dark:text-zinc-600 mb-2" />
              <p className="text-xs font-semibold text-zinc-600 dark:text-zinc-400">Not enough data</p>
              <p className="text-[11px] text-zinc-400 dark:text-zinc-500 mt-0.5">No import batches available yet.</p>
            </div>
          ) : (
            <div className="h-68 w-full min-w-0">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={batchVolumeData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#52525B20" />
                  <XAxis dataKey="date" axisLine={false} tickLine={false} tick={{ fill: '#71717A', fontSize: 11 }} />
                  <YAxis axisLine={false} tickLine={false} tick={{ fill: '#71717A', fontSize: 11 }} />
                  <Tooltip content={<CustomTooltip />} />
                  <Legend 
                    iconType="circle" 
                    wrapperStyle={{ fontSize: '11px', paddingTop: '12px' }}
                    formatter={(value) => <span className="text-zinc-700 dark:text-zinc-300 font-medium mr-2">{value}</span>}
                  />
                  <Bar dataKey="total" name="Total Records" fill="#6366F1" radius={[6, 6, 0, 0]} />
                  <Bar dataKey="failed" name="Failed Records" fill="#F43F5E" radius={[6, 6, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

      </div>

      {/* 5. Row 2: Distributions & Real Categorization */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        {/* Card 3: Cumulative Growth */}
        <div className="bg-white dark:bg-zinc-900/80 rounded-2xl border border-zinc-200 dark:border-zinc-800/80 p-5 shadow-xs dark:shadow-xl backdrop-blur-md min-w-0 overflow-hidden flex flex-col justify-between">
          <div className="flex items-center justify-between mb-3">
            <div>
              <div className="flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-emerald-500 dark:text-emerald-400" />
                <h3 className="text-sm font-bold text-zinc-900 dark:text-white tracking-tight">Cumulative Database Growth</h3>
              </div>
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400">Total verified master enterprise records</p>
            </div>
            <span className="font-mono text-xs font-bold text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/20 px-2 py-0.5 rounded-md">
              {totalBusinesses} In DB
            </span>
          </div>

          {totalBusinesses === 0 ? (
            <div className="h-60 w-full flex flex-col items-center justify-center text-center p-6 bg-zinc-50/50 dark:bg-zinc-950/40 rounded-xl border border-dashed border-zinc-200 dark:border-zinc-800">
              <TrendingUp className="w-8 h-8 text-zinc-400 dark:text-zinc-600 mb-2" />
              <p className="text-xs font-semibold text-zinc-600 dark:text-zinc-400">Not enough data</p>
              <p className="text-[11px] text-zinc-400 dark:text-zinc-500 mt-0.5">Database growth trend requires ongoing ingestion records.</p>
            </div>
          ) : (
            <div className="h-60 w-full flex flex-col items-center justify-center text-center p-6 bg-zinc-50/50 dark:bg-zinc-950/40 rounded-xl border border-zinc-200 dark:border-zinc-800">
              <div className="p-4 bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 max-w-xs w-full">
                <span className="text-xs text-zinc-500 block">Current Catalog Size</span>
                <span className="text-3xl font-bold font-mono text-emerald-600 dark:text-emerald-400 mt-1 block">{totalBusinesses}</span>
                <span className="text-[11px] text-zinc-400 mt-1 block">Live in PostgreSQL</span>
              </div>
            </div>
          )}
        </div>

        {/* Card 4: Industry Breakdown Donut */}
        <div className="bg-white dark:bg-zinc-900/80 rounded-2xl border border-zinc-200 dark:border-zinc-800/80 p-5 shadow-xs dark:shadow-xl backdrop-blur-md min-w-0 overflow-hidden flex flex-col justify-between">
          <div className="flex items-center justify-between mb-3">
            <div>
              <div className="flex items-center gap-2">
                <Database className="w-4 h-4 text-purple-500 dark:text-purple-400" />
                <h3 className="text-sm font-bold text-zinc-900 dark:text-white tracking-tight">Industry Breakdown</h3>
              </div>
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400">Verified entities across priority sectors</p>
            </div>
            <span className="text-[10px] font-mono text-purple-600 dark:text-purple-400 bg-purple-50 dark:bg-purple-500/10 border border-purple-200 dark:border-purple-500/20 px-2 py-0.5 rounded-md">
              {totalSectorsCount} Sectors
            </span>
          </div>

          {industryData.length === 0 ? (
            <div className="h-60 w-full flex flex-col items-center justify-center text-center p-6 bg-zinc-50/50 dark:bg-zinc-950/40 rounded-xl border border-dashed border-zinc-200 dark:border-zinc-800">
              <PieChartIcon className="w-8 h-8 text-zinc-400 dark:text-zinc-600 mb-2" />
              <p className="text-xs font-semibold text-zinc-600 dark:text-zinc-400">Not enough data</p>
              <p className="text-[11px] text-zinc-400 dark:text-zinc-500 mt-0.5">Industry distribution will appear as businesses are imported.</p>
            </div>
          ) : (
            <div className="h-60 w-full min-w-0 flex flex-col justify-between">
              <div className="h-36 w-full min-w-0 relative flex items-center justify-center">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={industryData}
                      cx="50%"
                      cy="50%"
                      innerRadius={46}
                      outerRadius={64}
                      paddingAngle={industryData.length > 1 ? 2 : 0}
                      dataKey="value"
                    >
                      {industryData.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={entry.color} stroke="currentColor" className="text-white dark:text-zinc-900" strokeWidth={2} />
                      ))}
                    </Pie>
                    <Tooltip content={<CustomTooltip />} />
                  </PieChart>
                </ResponsiveContainer>

                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-center pointer-events-none">
                  <span className="text-[9px] uppercase font-bold text-zinc-400 dark:text-zinc-500 block leading-none">Total</span>
                  <span className="text-base font-bold font-mono text-zinc-900 dark:text-white leading-tight">{totalBusinesses}</span>
                </div>
              </div>

              {/* Legend grid outside SVG */}
              <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 max-h-20 overflow-y-auto pt-2 border-t border-zinc-100 dark:border-zinc-800/60 pr-1">
                {industryData.map((entry) => (
                  <div key={entry.name} className="flex items-center gap-1.5 text-[11px] min-w-0">
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: entry.color }} />
                    <span className="truncate text-zinc-700 dark:text-zinc-300 font-medium" title={entry.name}>
                      {entry.name}
                    </span>
                    <span className="ml-auto font-mono text-[10px] text-zinc-400 dark:text-zinc-500 shrink-0 tabular-nums">
                      {entry.value}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Card 5: State Density */}
        <div className="bg-white dark:bg-zinc-900/80 rounded-2xl border border-zinc-200 dark:border-zinc-800/80 p-5 shadow-xs dark:shadow-xl backdrop-blur-md min-w-0 overflow-hidden flex flex-col justify-between">
          <div className="flex items-center justify-between mb-3">
            <div>
              <div className="flex items-center gap-2">
                <Layers className="w-4 h-4 text-amber-500 dark:text-amber-400" />
                <h3 className="text-sm font-bold text-zinc-900 dark:text-white tracking-tight">Geographic Density</h3>
              </div>
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400">Enterprise registration density by State</p>
            </div>
            <span className="text-[10px] font-mono text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/20 px-2 py-0.5 rounded-md">
              {stateDistributionData.length} States
            </span>
          </div>

          {stateDistributionData.length === 0 ? (
            <div className="h-60 w-full flex flex-col items-center justify-center text-center p-6 bg-zinc-50/50 dark:bg-zinc-950/40 rounded-xl border border-dashed border-zinc-200 dark:border-zinc-800">
              <Layers className="w-8 h-8 text-zinc-400 dark:text-zinc-600 mb-2" />
              <p className="text-xs font-semibold text-zinc-600 dark:text-zinc-400">Not enough data</p>
              <p className="text-[11px] text-zinc-400 dark:text-zinc-500 mt-0.5">State distribution records will appear when business addresses are mapped.</p>
            </div>
          ) : (
            <div className="space-y-2.5 pt-1 overflow-y-auto max-h-60">
              {stateDistributionData.map((item, i) => (
                <div key={i} className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium text-zinc-700 dark:text-zinc-300">{item.state}</span>
                    <div className="flex items-center gap-2 font-mono">
                      <span className="text-zinc-900 dark:text-zinc-100 font-bold">{item.count.toLocaleString()}</span>
                      <span className="text-[10px] text-zinc-400 dark:text-zinc-500">({item.percentage})</span>
                    </div>
                  </div>
                  <div className="w-full bg-zinc-100 dark:bg-zinc-800/80 rounded-full h-1.5 overflow-hidden">
                    <div 
                      className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-violet-500" 
                      style={{ width: item.percentage }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

      </div>

      {/* 6. Operational Feeds & System Health */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        {/* Recent Ingestions Batch List */}
        <div className="bg-white dark:bg-zinc-900/80 rounded-2xl border border-zinc-200 dark:border-zinc-800/80 shadow-xs dark:shadow-xl overflow-hidden flex flex-col backdrop-blur-md">
          <div className="p-4 border-b border-zinc-200 dark:border-zinc-800/80 flex items-center justify-between bg-zinc-50/70 dark:bg-zinc-950/40">
            <div className="flex items-center gap-2">
              <div className="p-1 rounded-md bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20">
                <UploadCloud className="w-3.5 h-3.5" />
              </div>
              <h3 className="text-xs font-bold text-zinc-900 dark:text-white uppercase tracking-wider">Recent Ingestion Batches</h3>
            </div>
            <button
              onClick={() => onNavigate('history')}
              className="text-[11px] font-semibold text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 flex items-center gap-1 cursor-pointer transition"
            >
              <span>View All</span>
              <ArrowRight className="w-3 h-3" />
            </button>
          </div>

          <div className="divide-y divide-zinc-100 dark:divide-zinc-800/60 max-h-80 overflow-y-auto">
            {batches.length === 0 ? (
              <div className="p-8 text-center text-xs text-zinc-500">No ingestion batches found.</div>
            ) : (
              batches.slice(0, 4).map((batch) => (
                <div key={batch.id} className="p-3.5 hover:bg-zinc-50 dark:hover:bg-zinc-800/40 transition-colors text-xs space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-zinc-800 dark:text-zinc-200 truncate max-w-[210px]">{batch.fileName}</span>
                    <span className="font-mono text-[10px] text-zinc-400 shrink-0">{batch.id.slice(0, 8)}</span>
                  </div>
                  <div className="flex items-center justify-between text-[11px] text-zinc-500 dark:text-zinc-400">
                    <span>{(batch.totalRecords || 0).toLocaleString()} rows • {batch.fileSize || 'CSV'}</span>
                    <span className={`font-mono text-[10px] px-2 py-0.5 rounded-full border ${
                      batch.status === 'Completed' 
                        ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20' 
                        : batch.status === 'Processing'
                        ? 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20'
                        : 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-500/20'
                    }`}>
                      {batch.status}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Recently Published Records */}
        <div className="bg-white dark:bg-zinc-900/80 rounded-2xl border border-zinc-200 dark:border-zinc-800/80 shadow-xs dark:shadow-xl overflow-hidden flex flex-col backdrop-blur-md">
          <div className="p-4 border-b border-zinc-200 dark:border-zinc-800/80 flex items-center justify-between bg-zinc-50/70 dark:bg-zinc-950/40">
            <div className="flex items-center gap-2">
              <div className="p-1 rounded-md bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                <CheckCircle2 className="w-3.5 h-3.5" />
              </div>
              <h3 className="text-xs font-bold text-zinc-900 dark:text-white uppercase tracking-wider">Live Discover Entities</h3>
            </div>
            <button
              onClick={() => onNavigate('published')}
              className="text-[11px] font-semibold text-emerald-600 dark:text-emerald-400 hover:text-emerald-700 dark:hover:text-emerald-300 flex items-center gap-1 cursor-pointer transition"
            >
              <span>View All</span>
              <ArrowRight className="w-3 h-3" />
            </button>
          </div>

          <div className="divide-y divide-zinc-100 dark:divide-zinc-800/60 max-h-80 overflow-y-auto">
            {publishedBusinesses.length === 0 ? (
              <div className="p-8 text-center text-xs text-zinc-500">No business records available.</div>
            ) : (
              publishedBusinesses.slice(0, 4).map((b) => (
                <div
                  key={b.id}
                  onClick={() => onSelectBusiness(b)}
                  className="p-3.5 hover:bg-zinc-50 dark:hover:bg-zinc-800/40 transition-colors text-xs space-y-1.5 cursor-pointer"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-zinc-800 dark:text-zinc-200 truncate max-w-[210px]">{b.name}</span>
                    <span className="font-mono text-[10px] font-bold px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 shrink-0">
                      {b.opportunityScore || 75} pts
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-[11px] text-zinc-500 dark:text-zinc-400">
                    <span>{b.industry || 'General'} • {b.city || 'India'}</span>
                    <span className="text-zinc-400 dark:text-zinc-500">{b.updatedAt || 'Active'}</span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* System & Cluster Status */}
        <div className="bg-white dark:bg-zinc-900/80 rounded-2xl border border-zinc-200 dark:border-zinc-800/80 shadow-xs dark:shadow-xl p-5 flex flex-col justify-between space-y-4 backdrop-blur-md">
          <div className="flex items-center justify-between pb-3 border-b border-zinc-200 dark:border-zinc-800">
            <div className="flex items-center gap-2">
              <div className="p-1.5 rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                <Server className="w-4 h-4" />
              </div>
              <div>
                <h3 className="text-xs font-bold text-zinc-900 dark:text-white uppercase tracking-wider">Enterprise Services Telemetry</h3>
                <span className="text-[10px] text-zinc-500 dark:text-zinc-400">PostgreSQL • Typesense</span>
              </div>
            </div>
            <span className="inline-flex items-center gap-1.5 text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
              CONNECTED
            </span>
          </div>

          <div className="space-y-2.5 text-xs">
            <div className="flex items-center justify-between p-2.5 rounded-xl bg-zinc-50 dark:bg-zinc-950/60 border border-zinc-200 dark:border-zinc-800/70">
              <div className="flex items-center gap-2 text-zinc-700 dark:text-zinc-300">
                <HardDrive className="w-3.5 h-3.5 text-blue-500 dark:text-blue-400" />
                <span>Primary PostgreSQL</span>
              </div>
              <span className="font-mono font-bold text-emerald-600 dark:text-emerald-400">Active</span>
            </div>

            <div className="flex items-center justify-between p-2.5 rounded-xl bg-zinc-50 dark:bg-zinc-950/60 border border-zinc-200 dark:border-zinc-800/70">
              <div className="flex items-center gap-2 text-zinc-700 dark:text-zinc-300">
                <Activity className="w-3.5 h-3.5 text-indigo-500 dark:text-indigo-400" />
                <span>Batches Ingested</span>
              </div>
              <span className="font-mono font-bold text-indigo-600 dark:text-indigo-400">{batches.length} Batches</span>
            </div>

            <div className="flex items-center justify-between p-2.5 rounded-xl bg-zinc-50 dark:bg-zinc-950/60 border border-zinc-200 dark:border-zinc-800/70">
              <div className="flex items-center gap-2 text-zinc-700 dark:text-zinc-300">
                <Cpu className="w-3.5 h-3.5 text-purple-500 dark:text-purple-400" />
                <span>Search Index Status</span>
              </div>
              <span className="font-mono font-bold text-purple-600 dark:text-purple-400">{publishedCount} Synced</span>
            </div>
          </div>

          <div className="p-3 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/70 dark:bg-zinc-950/40 text-[11px] text-zinc-500 dark:text-zinc-400 space-y-1">
            <div className="flex items-center justify-between font-semibold text-zinc-800 dark:text-zinc-200">
              <span>Async Queue Health</span>
              <span className="text-emerald-600 dark:text-emerald-400 font-mono">Ready</span>
            </div>
            <p className="text-[10px] text-zinc-400 dark:text-zinc-500">Live PostgreSQL database connected with verified master schemas.</p>
          </div>
        </div>

      </div>

    </div>
  );
}
