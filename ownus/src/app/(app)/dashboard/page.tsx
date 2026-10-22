"use client";

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import {
  Building2,
  TrendingUp,
  Globe,
  Zap,
  ArrowUpRight,
  ArrowDownRight,
  Search,
  Download,
  FileText,
  Unlock,
  Users,
  CreditCard,
  BookmarkCheck,
  ChevronRight,
  Clock,
  Loader2,
} from 'lucide-react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Legend
} from 'recharts';
import { cn, formatNumber, formatRelativeDate } from '@/lib/utils';
import { apiClient } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';
import { describeSavedFilters } from '@/lib/saved-search-summary';

export default function DashboardPage() {
  const { user, wallet } = useAuth();
  const [dashboardData, setDashboardData] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    async function loadDashboard() {
      setIsLoading(true);
      setLoadFailed(false);
      try {
        const data = await apiClient.dashboard.getSummary();
        if (active) setDashboardData(data);
      } catch (err) {
        // never show invented numbers: say that the data could not be loaded
        if (active) setLoadFailed(true);
        console.warn('Dashboard data could not be loaded:', err);
      } finally {
        if (active) setIsLoading(false);
      }
    }
    loadDashboard();
    return () => {
      active = false;
    };
  }, [reloadKey]);

  const currentDate = new Date().toLocaleDateString('en-US', {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });

  // Every number below comes from the server's summary (the database). While it loads, or if it could not be loaded, a number is shown as "-"
  // rather than 0: a zero would claim something the page does not know.
  const shown = (n: number | undefined | null, fmt: (v: number) => string = String) => (typeof n === 'number' ? fmt(n) : '-');
  const creditBalance = wallet?.balance ?? dashboardData?.wallet?.balance;
  const unlockedCount = dashboardData?.stats?.unlockedLeadsCount;
  const savedLeadsCount = dashboardData?.stats?.savedLeadsCount;
  const savedSearchesCount = dashboardData?.stats?.savedSearchesCount;
  const newBusinessesCount = dashboardData?.stats?.newBusinessesCount;

  // trend = real change against the previous period; null (no badge) when there is nothing to compare
  const trends = dashboardData?.trends ?? {};
  const stats: Array<{ title: string; value: string; trend: number | null; icon: React.ReactNode; iconBg: string }> = [
    { title: 'New Businesses Today', value: shown(newBusinessesCount), trend: trends.newBusinesses ?? null, icon: <Building2 className="h-5 w-5 text-zinc-900 dark:text-zinc-100" />, iconBg: 'bg-zinc-100 dark:bg-zinc-800' },
    { title: 'Unlocked Leads', value: shown(unlockedCount), trend: trends.unlockedLeads ?? null, icon: <Unlock className="h-5 w-5 text-zinc-900 dark:text-zinc-100" />, iconBg: 'bg-zinc-100 dark:bg-zinc-800' },
    { title: 'Saved Leads in Pipeline', value: shown(savedLeadsCount), trend: trends.savedLeads ?? null, icon: <BookmarkCheck className="h-5 w-5 text-zinc-900 dark:text-zinc-100" />, iconBg: 'bg-zinc-100 dark:bg-zinc-800' },
    { title: 'Credits Remaining', value: shown(creditBalance, formatNumber), trend: null, icon: <Zap className="h-5 w-5 text-zinc-900 dark:text-zinc-100" />, iconBg: 'bg-zinc-100 dark:bg-zinc-800' },
  ];

  // month by month this year: businesses published (the catalogue) and this account's unlocks
  const trendData: Array<{ name: string; discovered: number; converted: number }> = (dashboardData?.discoveryTrend ?? []).map((m: any) => ({ name: m.month, discovered: m.discovered, converted: m.converted }));
  const hasTrendData = trendData.some((m) => m.discovered > 0 || m.converted > 0);

  // the largest industries of the published catalogue, as shares
  const industryData: Array<{ name: string; value: number }> = (dashboardData?.industryDistribution ?? []).map((i: any) => ({ name: i.name, value: i.share }));

  const recentActivity = dashboardData?.recentUnlocks?.map((u: any, idx: number) => ({
    id: u.id || `act-${idx}`,
    desc: `Unlocked business "${u.name || u.business?.name || 'a business'}"`,
    time: u.unlockedAt ? formatRelativeDate(u.unlockedAt) : '',
    icon: <Unlock className="h-4 w-4 text-zinc-900 dark:text-zinc-100" />,
    bg: 'bg-zinc-100 dark:bg-zinc-800',
  })) || [];

  const recentUnlocksList = dashboardData?.recentUnlocks ?? [];
  const savedSearchesList = dashboardData?.recentSearches ?? [];

  const COLORS = ['#2563EB', '#059669', '#D97706', '#9333EA', '#06B6D4', '#E11D48', '#EA580C', '#0D9488'];

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6 w-full text-zinc-900 dark:text-zinc-100 overflow-x-hidden">
      {/* Row 1: Page header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 pb-4 border-b border-zinc-200 dark:border-zinc-800">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">Dashboard</h1>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
            Welcome back{user?.name ? `, ${user.name}` : ''}. Here is your enterprise pipeline status.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-zinc-500 dark:text-zinc-400 flex items-center gap-1.5 bg-zinc-100 dark:bg-zinc-900 px-2.5 py-1 rounded-md border border-zinc-200 dark:border-zinc-800">
            <Clock className="w-3.5 h-3.5 text-zinc-400" />
            {currentDate}
          </span>
          <Link
            href="/discover"
            className="inline-flex items-center justify-center rounded-md text-xs font-semibold transition-opacity bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 shadow hover:opacity-90 h-8 px-3.5 cursor-pointer"
          >
            View All Businesses
          </Link>
        </div>
      </div>

      {loadFailed && (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 px-4 py-3 text-xs text-zinc-700 dark:text-zinc-300">
          <span>The dashboard data could not be loaded, so no numbers are shown. Your account and credits are unaffected.</span>
          <button
            type="button"
            onClick={() => setReloadKey((k) => k + 1)}
            className="shrink-0 rounded-md border border-zinc-300 dark:border-zinc-600 px-3 py-1 font-semibold hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            Try again
          </button>
        </div>
      )}

      {/* Row 2: Stats Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {stats.map((stat, i) => (
          <div key={i} className="bg-white dark:bg-zinc-950 rounded-xl border border-zinc-200 dark:border-zinc-800 p-4 shadow-xs flex flex-col justify-between">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400 truncate">{stat.title}</span>
              <div className={cn("p-1.5 rounded-md border border-zinc-200 dark:border-zinc-700", stat.iconBg)}>
                {stat.icon}
              </div>
            </div>
            <div className="flex items-baseline justify-between mt-1">
              <h3 className="text-2xl font-bold font-mono text-zinc-900 dark:text-zinc-100">{stat.value}</h3>
              {stat.trend !== null && (
                <div className="flex items-center text-[11px] font-semibold text-zinc-600 dark:text-zinc-400 font-mono" title="Compared with the previous period">
                  {stat.trend > 0 ? <ArrowUpRight className="h-3.5 w-3.5 mr-0.5 text-zinc-800 dark:text-zinc-200" /> : stat.trend < 0 ? <ArrowDownRight className="h-3.5 w-3.5 mr-0.5 text-zinc-500" /> : null}
                  {stat.trend > 0 ? '+' : ''}{stat.trend}%
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Row 3: Charts (Multi-color graphs preserved, safe min-w-0 wrappers) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left: Line Chart */}
        <div className="bg-white dark:bg-zinc-950 rounded-xl border border-zinc-200 dark:border-zinc-800 p-4 min-w-0 overflow-hidden shadow-xs">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Business Discovery Trends</h3>
            <span className="text-[11px] text-zinc-500">{dashboardData?.year ? `${dashboardData.year} Year-to-Date` : 'Year-to-Date'}</span>
          </div>
          {!hasTrendData ? (
            <div className="h-60 w-full flex items-center justify-center text-center text-xs text-zinc-500 px-6">
              {isLoading ? 'Loading...' : loadFailed ? 'Data unavailable.' : 'No businesses published or unlocked yet this year.'}
            </div>
          ) : (
          <div className="h-60 w-full min-w-0">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={trendData} margin={{ top: 5, right: 15, left: -25, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#52525B26" />
                <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fill: '#71717A', fontSize: 11 }} dy={8} />
                <YAxis axisLine={false} tickLine={false} allowDecimals={false} tick={{ fill: '#71717A', fontSize: 11 }} />
                <Tooltip
                  contentStyle={{ borderRadius: '8px', border: '1px solid #3F3F46', background: '#18181B', color: '#FAFAFA', fontSize: '12px' }}
                />
                <Legend iconType="circle" wrapperStyle={{ paddingTop: '10px', fontSize: '11px' }} />
                <Line type="monotone" name="Businesses Discovered" dataKey="discovered" stroke="#2563EB" strokeWidth={2} dot={false} activeDot={{ r: 5 }} />
                <Line type="monotone" name="Leads Converted" dataKey="converted" stroke="#059669" strokeWidth={2} dot={false} activeDot={{ r: 5 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
          )}
        </div>

        {/* Right: Donut Chart */}
        <div className="bg-white dark:bg-zinc-950 rounded-xl border border-zinc-200 dark:border-zinc-800 p-4 min-w-0 overflow-hidden shadow-xs">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Industry Distribution</h3>
            <span className="text-[11px] text-zinc-500">Top Categories</span>
          </div>
          {industryData.length === 0 ? (
            <div className="h-60 w-full flex items-center justify-center text-center text-xs text-zinc-500 px-6">
              {isLoading ? 'Loading...' : loadFailed ? 'Data unavailable.' : 'No published businesses to chart yet.'}
            </div>
          ) : (
          <div className="h-60 w-full min-w-0">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={industryData}
                  cx="50%"
                  cy="45%"
                  innerRadius={65}
                  outerRadius={92}
                  paddingAngle={2}
                  dataKey="value"
                >
                  {industryData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip
                  formatter={(value: any) => {
                    const numericValue = Array.isArray(value) ? value[0] : value;
                    return [`${numericValue ?? 0}%`, 'Share'];
                  }}
                  contentStyle={{ borderRadius: '8px', border: '1px solid #3F3F46', background: '#18181B', color: '#FAFAFA', fontSize: '12px' }}
                />
                <Legend
                  layout="horizontal"
                  verticalAlign="bottom"
                  align="center"
                  iconType="circle"
                  wrapperStyle={{ fontSize: '11px', paddingTop: '6px' }}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>
          )}
        </div>
      </div>

      {/* Row 4: Two-column layout */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left: Recent Activity */}
        <div className="bg-white dark:bg-zinc-950 rounded-xl border border-zinc-200 dark:border-zinc-800 flex flex-col shadow-xs overflow-hidden">
          <div className="flex items-center justify-between p-4 border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-900/30">
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Recent Activity</h3>
            <Link href="/discover" className="text-xs font-semibold text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white">View All</Link>
          </div>
          <div className="divide-y divide-zinc-100 dark:divide-zinc-800/80 max-h-[340px] overflow-y-auto">
            {recentActivity.length === 0 ? (
              <div className="p-8 text-center text-xs text-zinc-500">
                No recent activity yet. Businesses you unlock will appear here.
              </div>
            ) : (
              recentActivity.map((activity: any) => (
                <div key={activity.id} className="flex items-start gap-3 p-3.5 hover:bg-zinc-50 dark:hover:bg-zinc-900/60 transition-colors">
                  <div className={cn("mt-0.5 p-1.5 rounded-md border border-zinc-200 dark:border-zinc-800", activity.bg)}>
                    {activity.icon}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-zinc-900 dark:text-zinc-100 truncate">{activity.desc}</p>
                    <p className="text-[11px] text-zinc-500 mt-0.5">{activity.time}</p>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Right column (Quick actions + Unlocks) */}
        <div className="space-y-6">
          {/* Quick Actions */}
          <div className="grid grid-cols-2 gap-3">
            <Link href="/discover" className="flex items-center gap-3 bg-white dark:bg-zinc-950 hover:bg-zinc-50 dark:hover:bg-zinc-900 p-3.5 rounded-xl border border-zinc-200 dark:border-zinc-800 transition-colors cursor-pointer shadow-xs">
              <div className="p-2 rounded-lg bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800">
                <Search className="h-4 w-4 text-zinc-900 dark:text-white" />
              </div>
              <div>
                <span className="text-xs font-semibold text-zinc-900 dark:text-zinc-100 block">Discover</span>
                <span className="text-[10px] text-zinc-500">Find new leads</span>
              </div>
            </Link>
            <Link href="/leads" className="flex items-center gap-3 bg-white dark:bg-zinc-950 hover:bg-zinc-50 dark:hover:bg-zinc-900 p-3.5 rounded-xl border border-zinc-200 dark:border-zinc-800 transition-colors cursor-pointer shadow-xs">
              <div className="p-2 rounded-lg bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800">
                <Users className="h-4 w-4 text-zinc-900 dark:text-white" />
              </div>
              <div>
                <span className="text-xs font-semibold text-zinc-900 dark:text-zinc-100 block">My Leads</span>
                <span className="text-[10px] text-zinc-500">{shown(savedLeadsCount)} active</span>
              </div>
            </Link>
            <Link href="/credits" className="flex items-center gap-3 bg-white dark:bg-zinc-950 hover:bg-zinc-50 dark:hover:bg-zinc-900 p-3.5 rounded-xl border border-zinc-200 dark:border-zinc-800 transition-colors cursor-pointer shadow-xs">
              <div className="p-2 rounded-lg bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800">
                <CreditCard className="h-4 w-4 text-zinc-900 dark:text-white" />
              </div>
              <div>
                <span className="text-xs font-semibold text-zinc-900 dark:text-zinc-100 block">Credits</span>
                <span className="text-[10px] text-zinc-500">{shown(creditBalance, formatNumber)} remaining</span>
              </div>
            </Link>
            <Link href="/saved-searches" className="flex items-center gap-3 bg-white dark:bg-zinc-950 hover:bg-zinc-50 dark:hover:bg-zinc-900 p-3.5 rounded-xl border border-zinc-200 dark:border-zinc-800 transition-colors cursor-pointer shadow-xs">
              <div className="p-2 rounded-lg bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800">
                <BookmarkCheck className="h-4 w-4 text-zinc-900 dark:text-white" />
              </div>
              <div>
                <span className="text-xs font-semibold text-zinc-900 dark:text-zinc-100 block">Saved</span>
                <span className="text-[10px] text-zinc-500">{shown(savedSearchesCount)} queries</span>
              </div>
            </Link>
          </div>

          {/* Recent Unlocks */}
          <div className="bg-white dark:bg-zinc-950 rounded-xl border border-zinc-200 dark:border-zinc-800 shadow-xs overflow-hidden">
            <div className="flex items-center justify-between p-4 border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-900/30">
              <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Recent Unlocks</h3>
              <Link href="/leads" className="text-xs font-semibold text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white">View All</Link>
            </div>
            <div className="divide-y divide-zinc-100 dark:divide-zinc-800/80">
              {recentUnlocksList.length === 0 ? (
                <div className="p-6 text-center text-xs text-zinc-500">
                  No unlocked businesses yet. Search the discovery catalog to unlock contacts.
                </div>
              ) : (
                recentUnlocksList.slice(0, 4).map((unlock: any) => (
                  <Link key={unlock.id} href={unlock.slug || unlock.businessId ? `/discover/${unlock.slug || unlock.businessId}` : '/discover'} className="flex items-center justify-between p-3 hover:bg-zinc-50 dark:hover:bg-zinc-900/60 transition-colors group">
                    <div className="min-w-0 pr-2">
                      <h4 className="text-xs font-medium text-zinc-900 dark:text-zinc-100 group-hover:underline transition-colors truncate">{unlock.business?.name || unlock.name || 'Verified Business'}</h4>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="inline-flex items-center rounded bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.2 text-[10px] font-medium text-zinc-700 dark:text-zinc-300 border border-zinc-200 dark:border-zinc-700">
                          {unlock.business?.industry || unlock.industry || 'Unclassified'}
                        </span>
                        <span className="text-[11px] text-zinc-500 truncate">{unlock.business?.locations?.[0]?.city || unlock.city || ''}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-[10px] text-zinc-400">{unlock.unlockedAt ? formatRelativeDate(unlock.unlockedAt) : 'Recent'}</span>
                      <ChevronRight className="h-3.5 w-3.5 text-zinc-400 group-hover:text-zinc-900 dark:group-hover:text-white" />
                    </div>
                  </Link>
                ))
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Row 5: Saved Searches */}
      <div className="bg-white dark:bg-zinc-950 rounded-xl border border-zinc-200 dark:border-zinc-800 shadow-xs overflow-hidden">
        <div className="flex items-center justify-between p-4 border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-900/30">
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Saved Searches</h3>
          <Link href="/saved-searches" className="text-xs font-semibold text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white">Manage</Link>
        </div>
        <div className="divide-y divide-zinc-100 dark:divide-zinc-800/80">
          {savedSearchesList.length === 0 ? (
            <div className="p-6 text-center text-xs text-zinc-500">
              No saved searches yet. Save your favorite search filters from the Discover page.
            </div>
          ) : (
            savedSearchesList.map((search: any) => (
              <div key={search.id} className="flex flex-col sm:flex-row sm:items-center justify-between p-4 hover:bg-zinc-50 dark:hover:bg-zinc-900/60 transition-colors gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <h4 className="text-xs font-medium text-zinc-900 dark:text-zinc-100">{search.name}</h4>
                    <span className="inline-flex items-center rounded bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 text-[10px] font-medium text-zinc-800 dark:text-zinc-200 border border-zinc-200 dark:border-zinc-700 font-mono">
                      {search.alertEnabled ? 'Alerts on' : 'Alerts off'}
                    </span>
                  </div>
                  <p className="text-[11px] text-zinc-500 truncate">{describeSavedFilters(search.filters)}</p>
                </div>
                <Link
                  href={`/discover?savedSearchId=${encodeURIComponent(search.id)}`}
                  className="inline-flex items-center justify-center rounded-md text-xs font-semibold transition-colors border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-900 dark:text-zinc-100 h-7 px-3 shrink-0 cursor-pointer"
                >
                  Run Search
                </Link>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
