'use client';
import { Linkedin } from '@/components/ui/linkedin-icon';

import React, { useState, useMemo, useCallback, useEffect } from 'react';
import {
  SlidersHorizontal,
  Download,
  Bookmark,
  ChevronDown,
  ChevronUp,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Eye,
  Lock,
  Unlock,
  Phone,
  Mail,
  Globe,
  Sparkles,
  ShieldCheck,
  Check,
  X,
  RotateCcw,
  Sliders,
  Share2,
  ExternalLink,
  MessageCircle,
  AlertCircle,
  Building2,
  FileSpreadsheet,
  ArrowUpDown,
  ArrowDownAZ,
  ArrowUpAZ,
  TrendingUp,
  Clock
} from 'lucide-react';
import { Business } from '@/lib/types';
import { GlobalSearchBar } from '@/components/discover/global-search-bar';
import { QuickFilterChips } from '@/components/discover/quick-filter-chips';
import {
  DiscoverFilters,
  DiscoverFilterState,
  initialFilterState,
} from '@/components/discover/discover-filters';
import { BusinessDrawer } from '@/components/discover/business-drawer';
import { UnlockLeadModal } from '@/components/discover/unlock-lead-modal';
import { SaveSearchModal } from '@/components/discover/save-search-modal';
import { useAuth } from '@/lib/auth-context';
import { apiClient } from '@/lib/api-client';
import { toast } from 'sonner';
import { applySavedFilters } from '@/lib/saved-search-summary';

import { usePublishedBusinesses } from '@/lib/published-businesses-store';
import {
  addUnlockedLeadId,
  addUnlockedLeadIds,
  applyUnlockedStatusToBusinesses,
  isLeadUnlocked,
  useUnlockedLeads,
} from '@/lib/unlocked-leads-store';

type SortOption = 
  | 'newest'
  | 'oldest'
  | 'highest_orion_score'
  | 'recently_updated'
  | 'name_asc'
  | 'name_desc';

export default function DiscoverPage() {
  const { user, wallet, setWalletBalance } = useAuth();
  const { publishedBusinesses } = usePublishedBusinesses();
  const { unlockedIds } = useUnlockedLeads();

  // Main Data
  const [data, setData] = useState<Business[]>(() => applyUnlockedStatusToBusinesses(publishedBusinesses));
  const [totalRecords, setTotalRecords] = useState(publishedBusinesses.length);
  const [isLoading, setIsLoading] = useState(true);

  // Sync unlocked leads whenever unlockedIds changes
  useEffect(() => {
    setData((prev) => applyUnlockedStatusToBusinesses(prev));
  }, [unlockedIds]);
  
  // Search & Filter State
  const [searchQuery, setSearchQuery] = useState('');
  const [activeChips, setActiveChips] = useState<string[]>([]);
  const [filters, setFilters] = useState<DiscoverFilterState>(initialFilterState);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  // "Run Search" on the dashboard and on Saved Searches opens /discover?savedSearchId=<id>: load that saved search and apply its filters
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const savedSearchId = new URLSearchParams(window.location.search).get('savedSearchId');
    if (!savedSearchId) return;
    let active = true;
    apiClient.savedSearches
      .get(savedSearchId)
      .then((saved: any) => {
        if (!active || !saved?.filters) return;
        setFilters(applySavedFilters(initialFilterState as unknown as Record<string, unknown>, saved.filters) as unknown as DiscoverFilterState);
        toast.success(`Applied saved search "${saved.name}".`);
      })
      .catch(() => {
        if (active) toast.error('That saved search could not be loaded.');
      });
    return () => {
      active = false;
    };
  }, []);
  
  // Table Sorting, Selection & Pagination State
  const [sortOption, setSortOption] = useState<SortOption>('highest_orion_score');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [pageSize, setPageSize] = useState(25);
  const [pageIndex, setPageIndex] = useState(0);

  // Drawer & Modals State
  const [previewBusiness, setPreviewBusiness] = useState<Business | null>(null);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [unlockModalState, setUnlockModalState] = useState<{
    isOpen: boolean;
    business: Business | null;
    isBulk: boolean;
  }>({
    isOpen: false,
    business: null,
    isBulk: false,
  });
  const [isSaveSearchOpen, setIsSaveSearchOpen] = useState(false);
  const userCredits = wallet?.balance ?? 0;

  // Real-time synchronization when Admin publishes or updates businesses
  useEffect(() => {
    if (publishedBusinesses && publishedBusinesses.length > 0) {
      setData(applyUnlockedStatusToBusinesses(publishedBusinesses));
      setTotalRecords(publishedBusinesses.length);
    }
  }, [publishedBusinesses]);

  // Live Backend Search Fetching
  useEffect(() => {
    let isCancelled = false;
    async function fetchSearch() {
      setIsLoading(true);
      try {
        const res = await apiClient.discover.search({
          q: searchQuery || undefined,
          state: filters.state || undefined,
          city: filters.cities?.[0] || undefined,
          cities: filters.cities?.length ? filters.cities.join(',') : undefined,
          district: filters.districts?.[0] || undefined,
          districts: filters.districts?.length ? filters.districts.join(',') : undefined,
          pincode: filters.pincode || undefined,
          industries: filters.industries?.length ? filters.industries.join(',') : undefined,
          subIndustries: filters.subIndustries?.length ? filters.subIndustries.join(',') : undefined,
          businessCategories: filters.businessCategories?.length ? filters.businessCategories.join(',') : undefined,
          businessTypes: filters.businessTypes?.length ? filters.businessTypes.join(',') : undefined,
          msmeCategories: filters.msmeCategories?.length ? filters.msmeCategories.join(',') : undefined,
          hasWebsite: activeChips.includes('has_website') ? true : activeChips.includes('no_website') ? false : (filters.contactAvailability.hasWebsite ? true : filters.contactAvailability.noWebsite ? false : undefined),
          hasPhone: activeChips.includes('has_phone') || filters.contactAvailability.hasPhone ? true : undefined,
          hasEmail: activeChips.includes('has_email') || filters.contactAvailability.hasEmail ? true : undefined,
          hasWhatsApp: filters.contactAvailability.hasWhatsApp ? true : undefined,
          hasLinkedIn: filters.contactAvailability.hasLinkedIn ? true : undefined,
          verified: activeChips.includes('verified') || filters.businessStatus.verified ? true : undefined,
          // People layer: active only if an admin has enabled chips with these values.
          hasDecisionMaker: activeChips.includes('has_decision_maker') ? true : undefined,
          hasVerifiedDecisionMaker: activeChips.includes('verified_decision_maker') ? true : undefined,
          hasDecisionMakerContact: activeChips.includes('decision_maker_contact') ? true : undefined,
          minOrionScore: activeChips.includes('high_orion_score') ? 80 : (filters.orionScoreRange?.[0] || 0),
          maxOrionScore: filters.orionScoreRange?.[1] || 100,
          sort: sortOption,
          page: pageIndex + 1,
          limit: pageSize,
        });

        if (!isCancelled && res) {
          const rawItems = Array.isArray(res)
            ? res
            : Array.isArray(res.items)
            ? res.items
            : Array.isArray(res.data?.items)
            ? res.data.items
            : Array.isArray(res.data)
            ? res.data
            : [];

          const totalCount =
            typeof res.total === 'number'
              ? res.total
              : typeof res.data?.total === 'number'
              ? res.data.total
              : rawItems.length;

          const rawMapped: Business[] = rawItems.map((hit: any) => ({
            id: hit.id,
            name: hit.name,
            legalName: hit.legalName || hit.name,
            industry: hit.industry || hit.industryName || 'Commercial Services',
            city: hit.city || hit.location?.city || 'India',
            district: hit.district || hit.location?.district || '',
            state: hit.state || hit.location?.state || 'India',
            zipCode: hit.pincode || hit.zipCode || hit.location?.pincode,
            businessAge: hit.businessAge || (hit.foundingYear ? `${new Date().getFullYear() - hit.foundingYear} yrs` : 'Established'),
            registrationDate: hit.registrationDate || (hit.foundingYear ? `${hit.foundingYear}-04-01` : undefined),
            entityType: hit.entityType || hit.businessType || 'Private Limited',
            msmeCategory: hit.msmeCategory,
            opportunityScore: hit.opportunityScore ?? hit.orionScore ?? 75,
            phone: hit.phone || (hit.contactAvailability?.hasPhone ? 'Contact Available (Unlock to view)' : null),
            email: hit.email || (hit.contactAvailability?.hasEmail ? 'Email Available (Unlock to view)' : null),
            linkedin: hit.linkedin || hit.linkedInUrl || null,
            linkedInUrl: hit.linkedin || hit.linkedInUrl || null,
            hasLinkedIn: Boolean(hit.linkedin || hit.linkedInUrl || hit.hasLinkedIn),
            phoneStatus: (hit.phone || hit.contactAvailability?.hasPhone) ? 'available' : 'not_available',
            emailStatus: (hit.email || hit.contactAvailability?.hasEmail) ? 'available' : 'not_available',
            website: hit.website || (hit.contactAvailability?.hasWebsite ? 'https://' : null),
            verified: hit.verified ?? hit.isVerified,
            isUnlocked: hit.isUnlocked,
            creditsRequired: 1,
            status: 'active',
          }));

          const mappedItems = applyUnlockedStatusToBusinesses(rawMapped);

          setData(mappedItems);
          setTotalRecords(totalCount);
        }
      } catch (err) {
        console.warn('Live search error:', err);
        setData([]);
        setTotalRecords(0);
      } finally {
        if (!isCancelled) setIsLoading(false);
      }
    }

    const timer = setTimeout(fetchSearch, 150);
    return () => {
      isCancelled = true;
      clearTimeout(timer);
    };
  }, [searchQuery, filters, activeChips, sortOption, pageIndex, pageSize, publishedBusinesses]);

  // Active Filter Count calculation
  const activeFiltersCount = useMemo(() => {
    let count = 0;
    if (filters.state) count += 1;
    if (filters.districts?.length > 0) count += filters.districts.length;
    if (filters.cities?.length > 0) count += filters.cities.length;
    if (filters.pincode) count += 1;
    if (filters.industries?.length > 0) count += filters.industries.length;
    if (filters.subIndustries?.length > 0) count += filters.subIndustries.length;
    if (filters.businessCategories?.length > 0) count += filters.businessCategories.length;
    if (filters.businessTypes?.length > 0) count += filters.businessTypes.length;
    if (filters.msmeCategories?.length > 0) count += filters.msmeCategories.length;
    if (filters.customAdminFilters) {
      Object.values(filters.customAdminFilters).forEach((selected) => {
        if (Array.isArray(selected)) count += selected.length;
      });
    }
    if (filters.agePreset !== 'all') count += 1;
    
    // Contact Availability
    if (filters.contactAvailability.hasWebsite) count += 1;
    if (filters.contactAvailability.noWebsite) count += 1;
    if (filters.contactAvailability.hasEmail) count += 1;
    if (filters.contactAvailability.hasPhone) count += 1;
    if (filters.contactAvailability.hasWhatsApp) count += 1;
    if (filters.contactAvailability.hasLinkedIn) count += 1;

    // Digital Presence
    if (filters.digitalPresence.googleBusinessProfile !== 'all') count += 1;
    if (filters.digitalPresence.websiteAvailable) count += 1;
    if (filters.digitalPresence.websiteMissing) count += 1;
    if (filters.digitalPresence.socialMediaAvailable) count += 1;

    // Business Status
    if (filters.businessStatus.active) count += 1;
    if (filters.businessStatus.verified) count += 1;
    if (filters.businessStatus.completeProfile) count += 1;
    if (filters.businessStatus.recentlyUpdated) count += 1;

    // Orion Score
    if (filters.orionScoreTier !== 'all' || filters.orionScoreRange[0] > 0 || filters.orionScoreRange[1] < 100) count += 1;
    if (activeChips.length > 0) count += activeChips.length;

    return count;
  }, [filters, activeChips]);

  // Handle Quick Filter Chip toggling
  const handleToggleChip = (chipId: string) => {
    setActiveChips((prev) => {
      const next = prev.includes(chipId)
        ? prev.filter((id) => id !== chipId)
        : [...prev, chipId];
      return next;
    });
    setPageIndex(0);
  };

  // Reset all filters
  const handleResetFilters = () => {
    setFilters(initialFilterState);
    setActiveChips([]);
    setSearchQuery('');
    setPageIndex(0);
  };

  // Server-driven data & pagination: data is retrieved directly from PostgreSQL
  const filteredData = data;
  const sortedData = data;
  const totalPages = Math.ceil(totalRecords / pageSize) || 1;
  const paginatedData = data;

  // Row Selection helpers
  const isAllPageSelected = paginatedData.length > 0 && paginatedData.every((b) => selectedIds.has(b.id));
  
  const handleToggleSelectAllPage = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (isAllPageSelected) {
        paginatedData.forEach((b) => next.delete(b.id));
      } else {
        paginatedData.forEach((b) => next.add(b.id));
      }
      return next;
    });
  };

  const handleToggleSelectRow = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const selectedRows = useMemo(() => {
    return data.filter((b) => selectedIds.has(b.id));
  }, [data, selectedIds]);

  const unlockedFilteredData = useMemo(
    () => filteredData.filter((business) => business.isUnlocked || unlockedIds.has(String(business.id))),
    [filteredData, unlockedIds]
  );

  const selectedUnlockedRows = useMemo(
    () => selectedRows.filter((business) => business.isUnlocked || unlockedIds.has(String(business.id))),
    [selectedRows, unlockedIds]
  );

  // Unlock handlers
  const handleOpenUnlock = (business: Business) => {
    setUnlockModalState({
      isOpen: true,
      business,
      isBulk: false,
    });
  };

  const handleBulkUnlockOpen = () => {
    setUnlockModalState({
      isOpen: true,
      business: null,
      isBulk: true,
    });
  };

  const handleConfirmUnlock = async () => {
    if (unlockModalState.isBulk) {
      const idsToUnlock = Array.from(selectedRows.map((b) => b.id));
      let successCount = 0;
      for (const id of idsToUnlock) {
        try {
          const res = await apiClient.unlock.unlockBusiness(id);
          if (res?.balance !== undefined) setWalletBalance(res.balance, res.dailyCredits, res.purchasedCredits);
          successCount++;
        } catch (err: any) {
          console.warn(`Unlock error for ${id}:`, err);
        }
      }
      addUnlockedLeadIds(idsToUnlock);
      setData((prev) => applyUnlockedStatusToBusinesses(prev));
      setSelectedIds(new Set());
      toast.success(`Successfully unlocked ${successCount} verified leads!`);
    } else if (unlockModalState.business) {
      const bId = unlockModalState.business.id;
      try {
        const res = await apiClient.unlock.unlockBusiness(bId);
        addUnlockedLeadId(bId);
        setData((prev) => applyUnlockedStatusToBusinesses(prev));
        if (previewBusiness && previewBusiness.id === bId) {
          setPreviewBusiness({ ...previewBusiness, isUnlocked: true });
        }
        // Refetch the unlocked profile so the list row and the open drawer show the real
        // contact values instead of the "Unlock to view" placeholders from the search list.
        try {
          const full: any = await apiClient.discover.getBusinessBySlug(bId);
          const contact = full?.contacts?.find((c: any) => c.isPrimary) || full?.contacts?.[0];
          const cin = full?.identifiers?.find((i: any) => i.type === 'CIN')?.value;
          const revealed: Partial<Business> = {
            isUnlocked: true,
            phone: contact?.phone ?? null,
            email: contact?.email ?? null,
            linkedin: contact?.linkedinUrl ?? null,
            linkedInUrl: contact?.linkedinUrl ?? null,
            registrationNumber: cin || undefined,
            employeeCount: full?.employeeCountRange || undefined,
            revenue: full?.annualRevenueRange || undefined,
          };
          setData((prev) => prev.map((b) => (b.id === bId ? { ...b, ...revealed } : b)));
          setPreviewBusiness((prev) => (prev && prev.id === bId ? { ...prev, ...revealed } : prev));
        } catch (refetchErr) {
          console.warn('Could not refresh unlocked profile:', refetchErr);
        }
        if (res?.balance !== undefined) {
          setWalletBalance(res.balance, res.dailyCredits, res.purchasedCredits);
        }
        toast.success(res.message || 'Business unlocked successfully! Full contacts are now accessible.');
      } catch (err: any) {
        toast.error(err.message || 'Failed to unlock business. Please check credit balance.');
      }
    }
    setUnlockModalState({ isOpen: false, business: null, isBulk: false });
  };

  // Excel/CSV Export - Only records unlocked by the current user are eligible.
  const handleExportCSV = useCallback(async (itemsToExport: Business[]) => {
    const requestedItems = itemsToExport && itemsToExport.length > 0 ? itemsToExport : filteredData;
    const exportItems = requestedItems.filter(
      (business) => business.isUnlocked || unlockedIds.has(String(business.id))
    );

    if (!exportItems || exportItems.length === 0) {
      toast.error('Only unlocked business records can be exported.');
      return;
    }

    const exportIds = exportItems.map((b) => b.id).filter(Boolean);
    const exportDate = new Date().toISOString().slice(0, 10);
    const filename = `orion-unlocked-leads-${exportDate}.csv`;

    // Try backend export first for high-fidelity database values (includes all contacts aggregated)
    try {
      const token = typeof window !== 'undefined' ? (localStorage.getItem('orion_access_token') || localStorage.getItem('orion_admin_token')) : null;
      
      const res = await fetch('/api/v1/discover/export?format=csv', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ ids: exportIds }),
      });

      if (res.ok) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.setAttribute('download', filename);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        toast.success(`Exported ${exportItems.length} unlocked lead(s) to Excel/CSV.`);
        return;
      }
    } catch (apiErr) {
      console.warn('Backend POST export failed, trying GET fallback:', apiErr);
    }

    // Try GET fallback if POST had an issue
    try {
      const token = typeof window !== 'undefined' ? (localStorage.getItem('orion_access_token') || localStorage.getItem('orion_admin_token')) : null;
      const queryParam = exportIds.length > 0 ? `?ids=${exportIds.join(',')}&format=csv` : '?format=csv';
      const res = await fetch(`/api/v1/discover/export${queryParam}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (res.ok) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.setAttribute('download', filename);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        toast.success(`Exported ${exportItems.length} unlocked lead(s) to Excel/CSV.`);
        return;
      }
    } catch (getErr) {
      console.warn('Backend GET export failed, falling back to client-side CSV:', getErr);
    }

    // Client-side fallback CSV — uses data already in memory
    const headers = [
      'Business Name',
      'Phone Number',
      'Email',
      'Website',
      'LinkedIn URL',
      'Business Type',
      'Address',
      'City',
      'District',
      'State',
      'Export Date',
    ];

    const isPlaceholder = (val?: string | null) =>
      !val || val.includes('Unlock') || val === 'https://' || val.trim() === '';

    const esc = (val: string) => `"${String(val ?? '').replace(/"/g, '""')}"`;

    const csvRows = [headers.join(',')];
    exportItems.forEach((item) => {
      const bType = item.entityType || (item as any).businessType
        ? String((item as any).businessType || item.entityType).replace(/_/g, ' ')
        : 'Private Limited';
      const fullAddr = (item as any).address || [item.city, item.state].filter(Boolean).join(', ') || '';
      const unlockDate = (item as any).unlockedAt
        ? new Date((item as any).unlockedAt).toISOString().split('T')[0]
        : exportDate;

      const cleanPhone = isPlaceholder(item.phone) ? '' : String(item.phone).trim();
      const cleanEmail = isPlaceholder(item.email) ? '' : String(item.email).trim();
      const cleanWebsite = isPlaceholder(item.website) ? '' : String(item.website).trim();
      const cleanLinkedin = isPlaceholder(item.linkedin || item.linkedInUrl) ? '' : String(item.linkedin || item.linkedInUrl).trim();

      const row = [
        esc(item.name || ''),
        esc(cleanPhone),
        esc(cleanEmail),
        esc(cleanWebsite),
        esc(cleanLinkedin),
        esc(bType || ''),
        esc(fullAddr || ''),
        esc(item.city || ''),
        esc(item.district || item.city || ''),
        esc(item.state || ''),
        esc(unlockDate),
      ];
      csvRows.push(row.join(','));
    });

    // UTF-8 BOM ensures Excel opens the file correctly (correct encoding + text column format)
    const BOM = '\uFEFF';
    const blob = new Blob([BOM + csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    toast.success(`Exported ${exportItems.length} unlocked lead(s) to Excel/CSV.`);
  }, [filteredData, unlockedIds]);


  return (
    <div className="min-h-[calc(100vh-3.5rem)] bg-zinc-50 dark:bg-black text-zinc-900 dark:text-zinc-100 flex">
      <aside
        className={`fixed top-14 left-0 bottom-0 z-30 border-r border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 transition-all duration-300 flex flex-col ${
          sidebarOpen ? 'w-72 sm:w-80' : 'w-0 -translate-x-full'
        }`}
      >
        <div className="h-full w-full flex flex-col">
          <DiscoverFilters
            filters={filters}
            onChange={(f) => {
              setFilters(f);
              setPageIndex(0);
            }}
            onReset={handleResetFilters}
            onSavePreset={() => setIsSaveSearchOpen(true)}
            onToggleSidebar={() => setSidebarOpen(false)}
            totalActiveFiltersCount={activeFiltersCount}
          />
        </div>
      </aside>

      {/* 2. Main Data Workspace (Right of the Filter Sidebar) */}
      <div
        className={`flex-1 flex flex-col min-w-0 transition-all duration-300 p-4 sm:p-6 space-y-4 ${
          sidebarOpen ? 'ml-72 sm:ml-80' : 'ml-0'
        }`}
      >
        
        {/* Top Header / Discovery Bar */}
        <header className="bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl px-5 py-3 shadow-xs">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
            
            {/* Left: Title & Live Counter */}
            <div className="flex items-center gap-3">
              <div>
                <h1 className="text-base font-bold text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
                  Business Discovery & Intelligence
                  <span className="text-xs px-2 py-0.5 rounded-full font-mono font-medium bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 border border-zinc-200 dark:border-zinc-700">
                    {totalRecords} records
                  </span>
                </h1>
                <p className="text-[11px] text-zinc-500">
                  Universal B2B discovery for manufacturers, suppliers, distributors, contractors, CAs & service firms
                </p>
              </div>
            </div>

            {/* Center: Global Search Bar */}
            <div className="flex-1 max-w-xl mx-auto w-full">
              <GlobalSearchBar
                value={searchQuery}
                onChange={setSearchQuery}
                businesses={data}
                onSelectSuggestion={(type, val) => setSearchQuery(val)}
              />
            </div>

            {/* Right: Actions */}
            <div className="flex items-center gap-2 shrink-0">
              {/* Credits Counter */}
              <div className="px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 text-xs flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-zinc-900 dark:text-zinc-100" />
                <span className="text-zinc-500">Credits:</span>
                <span className="font-bold text-zinc-900 dark:text-zinc-100">{userCredits}</span>
              </div>

              {/* Save Search */}
              <button
                onClick={() => setIsSaveSearchOpen(true)}
                className="px-3 py-1.5 text-xs font-medium border border-zinc-200 dark:border-zinc-800 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-lg transition-colors flex items-center gap-1.5 cursor-pointer"
              >
                <Bookmark className="w-3.5 h-3.5" />
                Save Alert
              </button>

              {/* Export Unlocked Filtered CSV */}
              <button
                onClick={() => handleExportCSV(unlockedFilteredData)}
                disabled={unlockedFilteredData.length === 0}
                className="px-3 py-1.5 text-xs font-medium bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 hover:opacity-90 rounded-lg shadow-2xs transition-opacity flex items-center gap-1.5 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Download className="w-3.5 h-3.5" />
                Export Unlocked ({unlockedFilteredData.length})
              </button>
            </div>

          </div>
        </header>

        {/* Content Table Area */}
        <main className="flex-1 min-w-0 flex flex-col space-y-3.5">
          
          {/* Quick Filter Chips Bar + Sidebar Toggle & Sort Selector */}
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2.5">
            
            <div className="flex items-center gap-2 flex-1 min-w-0">
              <button
                onClick={() => setSidebarOpen(!sidebarOpen)}
                className={`p-2 rounded-lg border text-xs font-medium flex items-center gap-1.5 transition-colors shrink-0 cursor-pointer ${
                  sidebarOpen
                    ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-white border-zinc-300 dark:border-zinc-700'
                    : 'bg-white dark:bg-zinc-900 text-zinc-600 dark:text-zinc-400 border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50'
                }`}
                title="Toggle Filters Sidebar"
              >
                <SlidersHorizontal className="w-3.5 h-3.5" />
                <span>Filters</span>
                {activeFiltersCount > 0 && (
                  <span className="px-1.5 py-0.2 text-[10px] font-bold rounded-full bg-zinc-900 text-white dark:bg-white dark:text-zinc-900">
                    {activeFiltersCount}
                  </span>
                )}
              </button>

              {/* Quick Filter Chips */}
              <div className="flex-1 min-w-0">
                <QuickFilterChips
                  activeChips={activeChips}
                  onToggleChip={handleToggleChip}
                />
              </div>
            </div>

            {/* Universal Sort Dropdown */}
            <div className="flex items-center gap-1.5 shrink-0 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 px-2.5 py-1.5 rounded-lg text-xs">
              <ArrowUpDown className="w-3.5 h-3.5 text-zinc-500" />
              <span className="text-zinc-500 text-[11px]">Sort:</span>
              <select
                value={sortOption}
                onChange={(e) => setSortOption(e.target.value as SortOption)}
                className="bg-transparent font-medium text-zinc-900 dark:text-zinc-100 focus:outline-hidden cursor-pointer"
              >
                <option value="highest_orion_score">Highest Orion Score</option>
                <option value="newest">Newest Established</option>
                <option value="oldest">Oldest Established</option>
                <option value="recently_updated">Recently Updated</option>
                <option value="name_asc">Business Name (A - Z)</option>
                <option value="name_desc">Business Name (Z - A)</option>
              </select>
            </div>

            {/* Save Search Button */}
            <button
              onClick={() => setIsSaveSearchOpen(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-xs font-semibold text-zinc-900 dark:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer shrink-0"
              title="Save current search criteria as an alert"
            >
              <Bookmark className="w-3.5 h-3.5" />
              <span>Save Search</span>
            </button>

          </div>

          {/* Active Filter Tags Row */}
          {activeFiltersCount > 0 && (
            <div className="flex items-center gap-2 flex-wrap text-xs bg-white dark:bg-zinc-950 p-2.5 rounded-lg border border-zinc-200 dark:border-zinc-800">
              <span className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">Active:</span>
              
              {filters.state && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-zinc-100 dark:bg-zinc-900 text-zinc-800 dark:text-zinc-200 text-xs border border-zinc-200 dark:border-zinc-800 font-medium">
                  State: {filters.state}
                  <button onClick={() => setFilters({ ...filters, state: '', districts: [], cities: [], states: [] })}>
                    <X className="w-3 h-3 text-zinc-400 hover:text-zinc-700 dark:hover:text-white cursor-pointer" />
                  </button>
                </span>
              )}

              {filters.districts?.map((d) => (
                <span key={d} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-zinc-100 dark:bg-zinc-900 text-zinc-800 dark:text-zinc-200 text-xs border border-zinc-200 dark:border-zinc-800">
                  Dist: {d}
                  <button onClick={() => setFilters({ ...filters, districts: filters.districts.filter((x) => x !== d) })}>
                    <X className="w-3 h-3 text-zinc-400 hover:text-zinc-700 dark:hover:text-white cursor-pointer" />
                  </button>
                </span>
              ))}

              {filters.cities?.map((c) => (
                <span key={c} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-zinc-100 dark:bg-zinc-900 text-zinc-800 dark:text-zinc-200 text-xs border border-zinc-200 dark:border-zinc-800">
                  City: {c}
                  <button onClick={() => setFilters({ ...filters, cities: filters.cities.filter((x) => x !== c) })}>
                    <X className="w-3 h-3 text-zinc-400 hover:text-zinc-700 dark:hover:text-white cursor-pointer" />
                  </button>
                </span>
              ))}

              {filters.pincode && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-zinc-100 dark:bg-zinc-900 text-zinc-800 dark:text-zinc-200 text-xs border border-zinc-200 dark:border-zinc-800 font-mono">
                  PIN: {filters.pincode}
                  <button onClick={() => setFilters({ ...filters, pincode: '' })}>
                    <X className="w-3 h-3 text-zinc-400 hover:text-zinc-700 dark:hover:text-white cursor-pointer" />
                  </button>
                </span>
              )}

              {filters.industries.map((ind) => (
                <span key={ind} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-zinc-100 dark:bg-zinc-900 text-zinc-800 dark:text-zinc-200 text-xs border border-zinc-200 dark:border-zinc-800">
                  {ind}
                  <button onClick={() => setFilters({ ...filters, industries: filters.industries.filter((i) => i !== ind) })}>
                    <X className="w-3 h-3 text-zinc-400 hover:text-zinc-700 dark:hover:text-white cursor-pointer" />
                  </button>
                </span>
              ))}

              {filters.contactAvailability.noWebsite && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-zinc-100 dark:bg-zinc-900 text-zinc-800 dark:text-zinc-200 text-xs border border-zinc-200 dark:border-zinc-800">
                  No Website
                  <button onClick={() => setFilters({ ...filters, contactAvailability: { ...filters.contactAvailability, noWebsite: false } })}>
                    <X className="w-3 h-3" />
                  </button>
                </span>
              )}

              {activeChips.map((chipId) => (
                <span key={chipId} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-zinc-900 text-white dark:bg-white dark:text-zinc-900 text-xs">
                  {chipId.replace(/_/g, ' ')}
                  <button onClick={() => handleToggleChip(chipId)}>
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}

              <button
                onClick={handleResetFilters}
                className="text-[11px] text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white hover:underline font-medium ml-auto flex items-center gap-1 cursor-pointer"
              >
                <RotateCcw className="w-3 h-3" />
                Clear All
              </button>
            </div>
          )}

          {/* Table Card Container */}
          <div className="bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl shadow-xs overflow-hidden flex flex-col">
            
            {/* Table */}
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                
                {/* Table Header */}
                <thead>
                  <tr className="border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50/80 dark:bg-zinc-900/60 text-zinc-600 dark:text-zinc-400 font-semibold select-none">
                    {/* Checkbox */}
                    <th className="py-3 px-3.5 w-10">
                      <input
                        type="checkbox"
                        checked={isAllPageSelected}
                        onChange={handleToggleSelectAllPage}
                        className="rounded border-zinc-300 dark:border-zinc-700 text-zinc-900 focus:ring-0 w-3.5 h-3.5 cursor-pointer"
                      />
                    </th>

                    {/* Business Name */}
                    <th className="py-3 px-3.5">Business Name & Type</th>

                    {/* Industry */}
                    <th className="py-3 px-3.5">Industry & Category</th>

                    {/* Location */}
                    <th className="py-3 px-3.5">Location</th>

                    {/* Business Age */}
                    <th className="py-3 px-3.5">Age / Reg</th>

                    {/* Contacts */}
                    <th className="py-3 px-3.5">Contacts</th>

                    {/* Digital Status */}
                    <th className="py-3 px-3.5">Digital Footprint</th>

                    {/* Actions */}
                    <th className="py-3 px-3.5 text-right">Action</th>
                  </tr>
                </thead>

                {/* Table Body */}
                <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                  {paginatedData.length > 0 ? (
                    paginatedData.map((item) => {
                      const isSelected = selectedIds.has(item.id);
                      const hasPhone = !!item.phone || item.phoneStatus === 'available';
                      const hasEmail = !!item.email || item.emailStatus === 'available';

                      return (
                        <tr
                          key={item.id}
                          onClick={() => {
                            setPreviewBusiness(item);
                            setIsDrawerOpen(true);
                          }}
                          className={`hover:bg-zinc-50/80 dark:hover:bg-zinc-900/50 cursor-pointer transition-colors ${
                            isSelected ? 'bg-zinc-100/60 dark:bg-zinc-900/80' : ''
                          }`}
                        >
                          {/* Checkbox */}
                          <td className="py-3 px-3.5" onClick={(e) => e.stopPropagation()}>
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => handleToggleSelectRow(item.id)}
                              className="rounded border-zinc-300 dark:border-zinc-700 text-zinc-900 focus:ring-0 w-3.5 h-3.5 cursor-pointer"
                            />
                          </td>

                          {/* Business Name */}
                          <td className="py-3 px-3.5">
                            <div className="flex flex-col">
                              <span className="font-semibold text-zinc-900 dark:text-zinc-100 hover:underline">
                                {item.name}
                              </span>
                              <div className="flex items-center gap-1.5 text-[11px] text-zinc-500 mt-0.5">
                                {item.entityType && (
                                  <span className="px-1.5 py-0.2 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 rounded text-[10px] font-medium">
                                    {item.entityType}
                                  </span>
                                )}
                              </div>
                            </div>
                          </td>

                          {/* Industry */}
                          <td className="py-3 px-3.5">
                            <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-medium bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 border border-zinc-200/50 dark:border-zinc-700/50">
                              {item.industry}
                            </span>
                          </td>

                          {/* Location */}
                          <td className="py-3 px-3.5">
                            <div className="text-xs text-zinc-700 dark:text-zinc-300 font-medium">
                              {item.city}, <span className="text-zinc-500 font-normal">{item.state}</span>
                            </div>
                          </td>

                          {/* Business Age */}
                          <td className="py-3 px-3.5">
                            <span className="text-xs font-mono text-zinc-600 dark:text-zinc-400">
                              {item.businessAge}
                            </span>
                          </td>

                          {/* Contacts */}
                          <td className="py-3 px-3.5">
                            <div className="flex items-center gap-1.5">
                              <div
                                title={hasPhone ? 'Phone Available' : 'No Phone'}
                                className={`w-6 h-6 rounded-md flex items-center justify-center border ${
                                  hasPhone
                                    ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 border-zinc-200 dark:border-zinc-700'
                                    : 'bg-zinc-50 dark:bg-zinc-900/50 text-zinc-300 dark:text-zinc-700 border-zinc-100 dark:border-zinc-800/40'
                                }`}
                              >
                                <Phone className="w-3 h-3" />
                              </div>

                              <div
                                title={hasEmail ? 'Email Available' : 'No Email'}
                                className={`w-6 h-6 rounded-md flex items-center justify-center border ${
                                  hasEmail
                                    ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 border-zinc-200 dark:border-zinc-700'
                                    : 'bg-zinc-50 dark:bg-zinc-900/50 text-zinc-300 dark:text-zinc-700 border-zinc-100 dark:border-zinc-800/40'
                                }`}
                              >
                                <Mail className="w-3 h-3" />
                              </div>

                              <div
                                title={hasPhone ? 'WhatsApp Capable' : 'No WhatsApp'}
                                className={`w-6 h-6 rounded-md flex items-center justify-center border ${
                                  hasPhone
                                    ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 border-zinc-200 dark:border-zinc-700'
                                    : 'bg-zinc-50 dark:bg-zinc-900/50 text-zinc-300 dark:text-zinc-700 border-zinc-100 dark:border-zinc-800/40'
                                }`}
                              >
                                <MessageCircle className="w-3 h-3" />
                              </div>

                              <div
                                title={(item.linkedin || item.linkedInUrl || item.hasLinkedIn) ? ((item.isUnlocked || String(item.linkedin || item.linkedInUrl).startsWith('http')) ? `LinkedIn: ${item.linkedin || item.linkedInUrl}` : 'LinkedIn Available') : 'No LinkedIn'}
                                className={`w-6 h-6 rounded-md flex items-center justify-center border ${
                                  (item.linkedin || item.linkedInUrl || item.hasLinkedIn)
                                    ? 'bg-blue-50 dark:bg-blue-950/40 text-[#0A66C2] border-blue-200 dark:border-blue-900/50'
                                    : 'bg-zinc-50 dark:bg-zinc-900/50 text-zinc-300 dark:text-zinc-700 border-zinc-100 dark:border-zinc-800/40'
                                }`}
                              >
                                <Linkedin className="w-3 h-3" />
                              </div>
                            </div>
                          </td>

                          {/* Digital Footprint */}
                          <td className="py-3 px-3.5">
                            <div className="flex items-center gap-1.5">
                              {item.website ? (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300">
                                  <Globe className="w-3 h-3 text-zinc-500" />
                                  Website
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 border border-zinc-200 dark:border-zinc-700">
                                  <AlertCircle className="w-3 h-3 text-zinc-400" />
                                  No Website
                                </span>
                              )}
                            </div>
                          </td>

                          {/* Action */}
                          <td className="py-3 px-3.5 text-right" onClick={(e) => e.stopPropagation()}>
                            <div className="flex items-center gap-1.5 justify-end">
                              <button
                                onClick={() => {
                                  setPreviewBusiness(item);
                                  setIsDrawerOpen(true);
                                }}
                                title="Quick Preview"
                                className="p-1.5 text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-md transition-colors cursor-pointer"
                              >
                                <Eye className="w-3.5 h-3.5" />
                              </button>

                              {item.isUnlocked ? (
                                <span className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-semibold text-zinc-900 dark:text-zinc-100 bg-zinc-100 dark:bg-zinc-800 rounded-md border border-zinc-200 dark:border-zinc-700 font-mono">
                                  <Unlock className="w-3 h-3 text-zinc-600 dark:text-zinc-400" />
                                  Unlocked
                                </span>
                              ) : (
                                <button
                                  onClick={() => handleOpenUnlock(item)}
                                  className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 rounded-md hover:opacity-90 transition-opacity shadow-2xs cursor-pointer"
                                >
                                  <Lock className="w-3 h-3" />
                                  Unlock
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  ) : (
                    <tr>
                      <td colSpan={9} className="py-16 text-center text-zinc-500">
                        <div className="max-w-md mx-auto space-y-3">
                          <div className="w-12 h-12 rounded-xl bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center mx-auto text-zinc-400">
                            <Building2 className="w-6 h-6 stroke-1.5" />
                          </div>
                          <h3 className="font-semibold text-zinc-900 dark:text-zinc-100 text-sm">
                            No business records found.
                          </h3>
                          <p className="text-xs text-zinc-500 max-w-sm mx-auto">
                            {searchQuery || activeFiltersCount > 0
                              ? 'Try adjusting your filters or search criteria to find relevant businesses.'
                              : 'No verified business records published in directory yet.'}
                          </p>
                          <div className="flex items-center justify-center gap-2 pt-1">
                            {(searchQuery || activeFiltersCount > 0) && (
                              <button
                                onClick={handleResetFilters}
                                className="px-3 py-1.5 text-xs font-medium border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 hover:bg-zinc-50 rounded-lg transition-colors cursor-pointer"
                              >
                                Reset Filters
                              </button>
                            )}
                            {(user?.role === 'Admin' || user?.role === 'SUPER_ADMIN') && (
                              <a
                                href="/admin/monarch"
                                className="px-3 py-1.5 text-xs font-medium bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 hover:opacity-90 rounded-lg transition-opacity cursor-pointer inline-flex items-center gap-1.5"
                              >
                                <FileSpreadsheet className="w-3.5 h-3.5" />
                                Admin → Import Businesses
                              </a>
                            )}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* Table Pagination Bar */}
            <div className="p-3 border-t border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-900/40 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-zinc-500">
              <div className="flex items-center gap-2">
                <span>
                  Showing{' '}
                  <span className="font-semibold text-zinc-900 dark:text-zinc-100">
                    {data.length > 0 ? pageIndex * pageSize + 1 : 0}
                  </span>{' '}
                  to{' '}
                  <span className="font-semibold text-zinc-900 dark:text-zinc-100">
                    {Math.min((pageIndex + 1) * pageSize, totalRecords)}
                  </span>{' '}
                  of{' '}
                  <span className="font-semibold text-zinc-900 dark:text-zinc-100">
                    {totalRecords}
                  </span>{' '}
                  businesses
                </span>

                <select
                  value={pageSize}
                  onChange={(e) => {
                    setPageSize(Number(e.target.value));
                    setPageIndex(0);
                  }}
                  className="ml-2 px-2 py-1 text-xs bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-md font-medium text-zinc-700 dark:text-zinc-300 cursor-pointer"
                >
                  {[10, 25, 50, 100].map((size) => (
                    <option key={size} value={size}>
                      {size} / page
                    </option>
                  ))}
                </select>
              </div>

              {/* Navigation Pagination Buttons */}
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setPageIndex(0)}
                  disabled={pageIndex === 0}
                  className="p-1.5 rounded-md hover:bg-zinc-200 dark:hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
                >
                  <ChevronsLeft className="w-4 h-4" />
                </button>
                <button
                  onClick={() => setPageIndex((p) => Math.max(0, p - 1))}
                  disabled={pageIndex === 0}
                  className="p-1.5 rounded-md hover:bg-zinc-200 dark:hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>

                <span className="px-2 font-medium">
                  Page {pageIndex + 1} of {totalPages}
                </span>

                <button
                  onClick={() => setPageIndex((p) => Math.min(totalPages - 1, p + 1))}
                  disabled={pageIndex >= totalPages - 1}
                  className="p-1.5 rounded-md hover:bg-zinc-200 dark:hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
                <button
                  onClick={() => setPageIndex(totalPages - 1)}
                  disabled={pageIndex >= totalPages - 1}
                  className="p-1.5 rounded-md hover:bg-zinc-200 dark:hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
                >
                  <ChevronsRight className="w-4 h-4" />
                </button>
              </div>
            </div>

          </div>

        </main>
      </div>

      {/* Floating Multi-Row Bulk Action Bar */}
      {selectedRows.length > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 px-5 py-3 rounded-2xl shadow-2xl flex items-center gap-4 animate-in slide-in-from-bottom-5 duration-200 text-xs border border-zinc-800 dark:border-zinc-200">
          <div className="font-semibold flex items-center gap-2">
            <span className="w-5 h-5 rounded-full bg-white dark:bg-zinc-900 text-zinc-900 dark:text-white flex items-center justify-center font-bold text-[11px]">
              {selectedRows.length}
            </span>
            <span>selected</span>
          </div>

          <div className="h-4 w-px bg-zinc-700 dark:bg-zinc-300" />

          {/* Bulk Unlock */}
          <button
            onClick={handleBulkUnlockOpen}
            className="px-3 py-1.5 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-white hover:opacity-90 font-semibold rounded-lg flex items-center gap-1.5 transition-opacity cursor-pointer border border-zinc-300 dark:border-zinc-700"
          >
            <Lock className="w-3.5 h-3.5" />
            Unlock ({selectedRows.length} Credits)
          </button>

          {/* Bulk Export */}
          <button
            onClick={() => handleExportCSV(selectedUnlockedRows)}
            disabled={selectedUnlockedRows.length === 0}
            className="px-3 py-1.5 bg-zinc-800 dark:bg-zinc-100 hover:bg-zinc-700 dark:hover:bg-zinc-200 text-white dark:text-zinc-900 font-semibold rounded-lg flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Download className="w-3.5 h-3.5" />
            Export Unlocked CSV ({selectedUnlockedRows.length})
          </button>

          {/* Deselect All */}
          <button
            onClick={() => setSelectedIds(new Set())}
            className="p-1.5 hover:bg-zinc-800 dark:hover:bg-zinc-200 rounded-lg text-zinc-400 hover:text-white dark:text-zinc-600 dark:hover:text-zinc-900 transition-colors cursor-pointer"
            title="Clear Selection"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Slide-over Preview Drawer */}
      <BusinessDrawer
        business={previewBusiness}
        isOpen={isDrawerOpen}
        onClose={() => setIsDrawerOpen(false)}
        onUnlock={(b) => handleOpenUnlock(b)}
        onSaveToList={async (b) => {
          try {
            await apiClient.savedLeads.save({ businessId: b.id, stage: 'new' });
            toast.success(`Saved "${b.name}" to your pipeline leads!`);
          } catch (err: any) {
            toast.error(err.message || 'Failed to save lead');
          }
        }}
      />

      {/* Unlock Confirmation Modal */}
      <UnlockLeadModal
        isOpen={unlockModalState.isOpen}
        onClose={() => setUnlockModalState({ isOpen: false, business: null, isBulk: false })}
        onConfirm={handleConfirmUnlock}
        business={unlockModalState.business}
        bulkCount={selectedRows.length}
        availableCredits={userCredits}
      />

      {/* Save Search Modal */}
      <SaveSearchModal
        isOpen={isSaveSearchOpen}
        onClose={() => setIsSaveSearchOpen(false)}
        onSave={async (name, freq, emailAlert) => {
          try {
            await apiClient.savedSearches.create({
              name,
              filters: (filters || {}) as any,
              alertFrequency: freq.toUpperCase(),
              alertEnabled: emailAlert,
            });
            toast.success(`Search "${name}" saved! Alerts set to ${freq}.`);
          } catch (err: any) {
            toast.error(err.message || 'Failed to save search preset');
          }
        }}
        currentFilterSummary={`Filters: ${activeFiltersCount > 0 ? `${activeFiltersCount} active criteria` : 'All Leads'}`}
      />

    </div>
  );
}
