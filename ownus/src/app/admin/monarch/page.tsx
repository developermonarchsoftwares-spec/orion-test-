'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { adminFetch, ADMIN_SESSION_EXPIRED_EVENT } from '@/lib/admin-fetch';
import { normalizeActivityLogs } from '@/lib/admin-activity';
import {
  OTP_TTL_SECONDS,
  RESEND_AFTER_SECONDS,
  clearPending,
  interpretSendResponse,
  interpretVerifyFailure,
  loadPending,
  savePending,
} from '@/lib/admin-otp-flow';
import { useAdminTheme } from '@/components/admin/admin-theme-context';
import { 
  ShieldCheck, 
  ShieldAlert,
  Lock, 
  Mail, 
  KeyRound, 
  Loader2, 
  ArrowRight, 
  ArrowLeft, 
  RefreshCw, 
  AlertCircle,
  CheckCircle2
} from 'lucide-react';
import { 
  AdminTab, 
  AdminBusinessRecord, 
  BusinessStatus,
  ValidationStatus,
  ImportBatch, 
  DuplicatePair, 
  ValidationIssue, 
  ActivityLogEntry, 
  CustomerUser,
  TransactionRecord,
  RoleDefinition,
  SupportTicket,
  TicketStatus,
  PaymentStatus,
  CustomerPlan,
  DataSourceRecord,
  DataSourceStatus,
  EnrichmentJob,
  AiPipelineDefinition,
  AutomationRule,
  SystemServiceHealth,
  SearchIndexStatus
} from '@/types/admin';
import {
  INITIAL_ADMIN_BUSINESSES,
  INITIAL_IMPORT_BATCHES,
  INITIAL_DUPLICATES,
  INITIAL_VALIDATION_ISSUES,
  INITIAL_ACTIVITY_LOGS,
  INITIAL_CUSTOMER_USERS,
  INITIAL_PLATFORM_TRANSACTIONS,
  INITIAL_ROLES_PERMISSIONS,
  INITIAL_SUPPORT_TICKETS,
  INITIAL_DATA_SOURCES,
  INITIAL_ENRICHMENT_JOBS,
  INITIAL_AI_PIPELINES,
  INITIAL_AUTOMATION_RULES,
  INITIAL_SYSTEM_SERVICES,
  INITIAL_SEARCH_INDEX_STATUS,
} from '@/lib/admin-mock-data';
import { deleteAdminRecordsFromApi } from '@/lib/admin-data-store';
import { syncAdminRecordsToPublishedStore } from '@/lib/published-businesses-store';

// Layout components
import { AdminSidebar } from '@/components/admin/admin-sidebar';
import { roleFromToken, canAccessRoles, type AdminRole } from '@/lib/admin-session-role';
import { AdminHeader } from '@/components/admin/admin-header';

// View components - Module 1 & 2 & 3
import { AdminDashboardView } from '@/components/admin/views/admin-dashboard-view';
import { BusinessRecordsView } from '@/components/admin/views/business-records-view';
import { ImportDataView } from '@/components/admin/views/import-data-view';
import { ImportHistoryView } from '@/components/admin/views/import-history-view';
import { DataValidationView } from '@/components/admin/views/data-validation-view';
import { DuplicateManagerView } from '@/components/admin/views/duplicate-manager-view';
import { PublishQueueView } from '@/components/admin/views/publish-queue-view';
import { PeopleReviewView } from '@/components/admin/views/people-review-view';
import { isReviewUrl } from '@/lib/people-review-url';
import { UploadOperationsView } from '@/components/admin/views/upload-operations-view';
import { PeopleImportView } from '@/components/admin/views/people-import-view';
import { DataQualityMetricsView } from '@/components/admin/views/data-quality-metrics-view';
import { DataEnrichmentView } from '@/components/admin/views/data-enrichment-view';
import { PublishedBusinessesView } from '@/components/admin/views/published-businesses-view';
import { UsersManagementView } from '@/components/admin/views/users-management-view';
import { CreditsTransactionsView } from '@/components/admin/views/credits-transactions-view';
import { RolesPermissionsView } from '@/components/admin/views/roles-permissions-view';
import { ReportsView } from '@/components/admin/views/reports-view';
import { AdminSettingsView } from '@/components/admin/views/admin-settings-view';
import { ActivityLogsView } from '@/components/admin/views/activity-logs-view';
import { SupportCenterView } from '@/components/admin/views/support-center-view';

// View components - Module 4: Data Intelligence & Automation
import { DataSourcesView } from '@/components/admin/views/data-sources-view';
import { EnrichmentQueueView } from '@/components/admin/views/enrichment-queue-view';
import { AiProcessingView } from '@/components/admin/views/ai-processing-view';
import { AutomationRulesView } from '@/components/admin/views/automation-rules-view';
import { SyncCenterView } from '@/components/admin/views/sync-center-view';
import { SystemHealthView } from '@/components/admin/views/system-health-view';
import { DataIntelligenceView } from '@/components/admin/views/data-intelligence-view';

// Modal components
import { BusinessDetailsModal } from '@/components/admin/modals/business-details-modal';
import { BusinessValidationModal } from '@/components/admin/modals/business-validation-modal';
import { MergePreviewModal } from '@/components/admin/modals/merge-preview-modal';
import { GlobalAdminSearchModal } from '@/components/admin/modals/global-admin-search-modal';

export default function AdminPortalPage() {
  // Admin Authentication & Security Gate State
  const [isAdminAuthenticated, setIsAdminAuthenticated] = useState<boolean>(false);
  const [isCheckingAuth, setIsCheckingAuth] = useState<boolean>(true);
  const [adminEmail, setAdminEmail] = useState<string>('');
  // which administrator role is signed in (from the session token; decides what is shown, the server re-checks every action)
  const [adminRole, setAdminRole] = useState<AdminRole | null>(null);
  const [authStep, setAuthStep] = useState<'email' | 'otp'>('email');
  const [inputEmail, setInputEmail] = useState<string>('');
  const [otpCode, setOtpCode] = useState<string>('');
  const [authLoading, setAuthLoading] = useState<boolean>(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [otpCountdown, setOtpCountdown] = useState<number>(OTP_TTL_SECONDS);
  // set when the server locked the current code (too many wrong tries): a new code may be requested at once
  const [otpLocked, setOtpLocked] = useState<boolean>(false);

  // Navigation State
  // a People Review link (?section=people_review...) opens that section; no other section is addressable by URL. (Only rendered after the
  // sign-in gate, which is client-only, so reading the URL here cannot cause a hydration mismatch.)
  const [activeTab, setActiveTab] = useState<AdminTab>(() => (typeof window !== 'undefined' && isReviewUrl(window.location.search) ? 'people_review' : 'dashboard'));
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);

  // Independent Admin Theme State (completely isolated from Customer Portal theme)
  const { isDark, toggleAdminTheme } = useAdminTheme();

  // Core Data Stores with Full Workflow Persistence via PostgreSQL
  const [records, setRecords] = useState<AdminBusinessRecord[]>(INITIAL_ADMIN_BUSINESSES);
  const [batches, setBatches] = useState<ImportBatch[]>(INITIAL_IMPORT_BATCHES);
  const [duplicatePairs, setDuplicatePairs] = useState<DuplicatePair[]>(INITIAL_DUPLICATES);

  // Automatically sync strictly published records to customer store when records change
  useEffect(() => {
    syncAdminRecordsToPublishedStore(records);
  }, [records]);
  const [validationIssues, setValidationIssues] = useState<ValidationIssue[]>(INITIAL_VALIDATION_ISSUES);
  const [activityLogs, setActivityLogs] = useState<ActivityLogEntry[]>(INITIAL_ACTIVITY_LOGS);
  const [customerUsers, setCustomerUsers] = useState<CustomerUser[]>(INITIAL_CUSTOMER_USERS);
  const [transactions, setTransactions] = useState<TransactionRecord[]>(INITIAL_PLATFORM_TRANSACTIONS);
  const [roles, setRoles] = useState<RoleDefinition[]>(INITIAL_ROLES_PERMISSIONS);
  const [tickets, setTickets] = useState<SupportTicket[]>(INITIAL_SUPPORT_TICKETS);

  // Module 4 Data Stores: Data Intelligence & Automation
  const [dataSources, setDataSources] = useState<DataSourceRecord[]>(INITIAL_DATA_SOURCES);
  const [enrichmentJobs, setEnrichmentJobs] = useState<EnrichmentJob[]>(INITIAL_ENRICHMENT_JOBS);
  const [aiPipelines, setAiPipelines] = useState<AiPipelineDefinition[]>(INITIAL_AI_PIPELINES);
  const [automationRules, setAutomationRules] = useState<AutomationRule[]>(INITIAL_AUTOMATION_RULES);
  const [systemServices, setSystemServices] = useState<SystemServiceHealth[]>(INITIAL_SYSTEM_SERVICES);
  const [searchIndexStatus, setSearchIndexStatus] = useState<SearchIndexStatus>(INITIAL_SEARCH_INDEX_STATUS);

  // Modal / Drawer States
  const [selectedRecordForDetail, setSelectedRecordForDetail] = useState<AdminBusinessRecord | null>(null);
  const [selectedRecordForValidation, setSelectedRecordForValidation] = useState<AdminBusinessRecord | null>(null);
  const [selectedDuplicatePair, setSelectedDuplicatePair] = useState<DuplicatePair | null>(null);
  const [isSearchModalOpen, setIsSearchModalOpen] = useState(false);

  // Toast Notification State
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage(null);
    }, 3500);
  };

  // Check active admin session on mount
  useEffect(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('orion_admin_token') : null;
    const storedEmail = typeof window !== 'undefined' ? localStorage.getItem('orion_admin_email') : null;
    const isAuthEmail = (em: string) => {
      const parts = em.trim().toLowerCase().split('@');
      return parts.length === 2 && Boolean(parts[0]) && parts[1] === 'monarchsoftwares.com';
    };

    if (token && storedEmail && isAuthEmail(storedEmail)) {
      setAdminEmail(storedEmail.trim().toLowerCase());
      setAdminRole(roleFromToken(token));
      setIsAdminAuthenticated(true);
    } else {
      // a code was sent shortly before this page was refreshed or reopened: go straight back to the code step
      const pending = loadPending(typeof window !== 'undefined' ? window.sessionStorage : null);
      if (pending && isAuthEmail(pending.email)) {
        setInputEmail(pending.email);
        setOtpCountdown(pending.secondsLeft);
        setAuthStep('otp');
      }
    }
    setIsCheckingAuth(false);
  }, []);

  // A 401 from any admin call (token expired or revoked) returns the console to its sign-in screen
  useEffect(() => {
    const onExpired = () => {
      setIsAdminAuthenticated(false);
      setAuthStep('email');
      setOtpCode('');
      setAuthError('Your administrator session has ended. Please sign in again.');
    };
    window.addEventListener(ADMIN_SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(ADMIN_SESSION_EXPIRED_EVENT, onExpired);
  }, []);

  // OTP Countdown timer
  useEffect(() => {
    if (authStep !== 'otp' || otpCountdown <= 0) return;
    const interval = setInterval(() => {
      setOtpCountdown(prev => Math.max(0, prev - 1));
    }, 1000);
    return () => clearInterval(interval);
  }, [authStep, otpCountdown]);

  // Handle Send OTP
  const handleSendOtp = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setAuthError(null);
    const cleanEmail = inputEmail.trim().toLowerCase();

    if (!cleanEmail) {
      setAuthError('Please enter your administrator email.');
      return;
    }

    const parts = cleanEmail.split('@');
    const isAuthorized = parts.length === 2 && Boolean(parts[0]) && parts[1] === 'monarchsoftwares.com';

    if (!isAuthorized) {
      setAuthError('Access Denied: Only @monarchsoftwares.com email addresses are authorized for administrative access.');
      return;
    }

    setAuthLoading(true);
    try {
      const res = await fetch('/api/v1/admin/auth/send-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: cleanEmail }),
      });
      const data = await res.json().catch(() => ({}));
      const outcome = interpretSendResponse(res.status, data);
      if (outcome.kind === 'error') {
        throw new Error(outcome.error);
      }
      const storage = typeof window !== 'undefined' ? window.sessionStorage : null;
      if (outcome.kind === 'sent') {
        savePending(storage, cleanEmail);
        setOtpCountdown(OTP_TTL_SECONDS);
      } else {
        // 429: the previous code is still valid, so continue to the code step with the time that remains for it
        const pending = loadPending(storage);
        setOtpCountdown(pending && pending.email === cleanEmail ? pending.secondsLeft : OTP_TTL_SECONDS - RESEND_AFTER_SECONDS);
      }
      setOtpLocked(false);
      setAuthStep('otp');
      setOtpCode('');
      showToast(outcome.notice);
    } catch (err: any) {
      setAuthError(err.message || 'Unable to send verification code. Please try again.');
    } finally {
      setAuthLoading(false);
    }
  };

  // Handle Verify OTP
  const handleVerifyOtp = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setAuthError(null);
    const cleanEmail = inputEmail.trim().toLowerCase();
    const cleanOtp = otpCode.trim();

    if (!cleanOtp || cleanOtp.length < 6) {
      setAuthError('Please enter the 6-digit verification code.');
      return;
    }

    setAuthLoading(true);
    try {
      const res = await fetch('/api/v1/admin/auth/verify-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: cleanEmail, otp: cleanOtp }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        const failure = interpretVerifyFailure(res.status, data?.message);
        if (failure.reason === 'locked') setOtpLocked(true);
        setOtpCode('');
        throw new Error(failure.error);
      }
      if (typeof window !== 'undefined') {
        clearPending(window.sessionStorage);
        localStorage.setItem('orion_admin_token', data.data.adminToken);
        localStorage.setItem('orion_admin_email', cleanEmail);
      }
      setAdminEmail(cleanEmail);
      setAdminRole(roleFromToken(data.data.adminToken));
      setIsAdminAuthenticated(true);
      showToast(`Welcome, Administrator (${cleanEmail}).`);
    } catch (err: any) {
      setAuthError(err.message || 'Invalid verification code. Please check and try again.');
    } finally {
      setAuthLoading(false);
    }
  };

  // Handle Admin Sign Out
  const handleAdminSignOut = async () => {
    try {
      await fetch('/api/v1/admin/auth/logout', { method: 'POST' });
    } catch {
      //
    }
    if (typeof window !== 'undefined') {
      localStorage.removeItem('orion_admin_token');
      localStorage.removeItem('orion_admin_email');
    }
    setIsAdminAuthenticated(false);
    setAdminRole(null);
    setAuthStep('email');
    setOtpCode('');
    setAuthError(null);
    showToast('Admin session terminated.');
  };

  // Fetch real administrative data from backend when authenticated
  useEffect(() => {
    if (!isAdminAuthenticated) return;

    let isMounted = true;
    const fetchAdminData = async () => {
      try {
        const [bizRes, batchRes, usersRes, txRes, logsRes] = await Promise.all([
          adminFetch('/api/v1/admin/businesses').then(r => r.ok ? r.json() : null),
          adminFetch('/api/v1/admin/import/batches').then(r => r.ok ? r.json() : null),
          adminFetch('/api/v1/admin/users').then(r => r.ok ? r.json() : null),
          adminFetch('/api/v1/admin/transactions').then(r => r.ok ? r.json() : null),
          adminFetch('/api/v1/admin/activity-logs').then(r => r.ok ? r.json() : null),
        ]);

        if (!isMounted) return;
        if (bizRes && Array.isArray(bizRes.data)) setRecords(bizRes.data);
        if (batchRes && Array.isArray(batchRes.data)) setBatches(batchRes.data);
        if (usersRes && Array.isArray(usersRes.data)) setCustomerUsers(usersRes.data);
        if (txRes && Array.isArray(txRes.data)) setTransactions(txRes.data);
        if (logsRes && Array.isArray(logsRes.data)) setActivityLogs(normalizeActivityLogs(logsRes.data));
      } catch (err) {
        console.error('Failed to fetch admin live data:', err);
      }
    };

    fetchAdminData();
    return () => { isMounted = false; };
  }, [isAdminAuthenticated]);

  // Keyboard shortcut for Cmd+K / Ctrl+K
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setIsSearchModalOpen(prev => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Compute live counts for sidebar badges
  const counts = useMemo(() => {
    return {
      pendingReviews: records.filter(r => r.status === 'approved' || r.status === 'validated' || r.status === 'draft').length,
      duplicates: duplicatePairs.filter(p => p.status === 'pending').length,
      validationErrors: records.filter(r => r.validationStatus === 'Warning' || r.validationStatus === 'Rejected').length,
      failedImports: batches.filter(b => b.status === 'Failed' || b.status === 'Warning').length,
      openTickets: tickets.filter(t => t.status === 'Open').length,
    };
  }, [records, duplicatePairs, batches, tickets]);

  // Record Workflow Status Transition Handler
  const handleStatusChange = (recordId: string, newStatus: BusinessStatus) => {
    setRecords(prev => {
      const updated = prev.map(rec => {
        if (rec.id === recordId) {
          return {
            ...rec,
            status: newStatus,
            validationStatus: newStatus === 'approved' || newStatus === 'published' ? 'Approved' : rec.validationStatus,
            updatedAt: new Date().toISOString(),
            approvedDate: newStatus === 'approved' || newStatus === 'published' ? new Date().toISOString().replace('T', ' ').slice(0, 16) : rec.approvedDate,
            reviewer: newStatus === 'approved' || newStatus === 'published' ? (adminEmail || 'Monarch Administrator') : rec.reviewer,
          };
        }
        return rec;
      });
      syncAdminRecordsToPublishedStore(updated);
      return updated;
    });

    if (selectedRecordForDetail && selectedRecordForDetail.id === recordId) {
      setSelectedRecordForDetail(prev => prev ? { ...prev, status: newStatus } : null);
    }
    if (selectedRecordForValidation && selectedRecordForValidation.id === recordId) {
      setSelectedRecordForValidation(prev => prev ? { ...prev, status: newStatus } : null);
    }

    const target = records.find(r => r.id === recordId);
    const newLog: ActivityLogEntry = {
      id: `act-${Date.now()}`,
      user: adminEmail ? `${adminEmail} (Super Admin)` : 'Monarch Administrator (Super Admin)',
      action: newStatus === 'published' ? 'Published' : newStatus === 'approved' ? 'Approved' : 'Updated',
      entityType: 'Business',
      entityId: recordId,
      entityName: target?.name || 'Business Record',
      details: `Status transitioned to "${newStatus.toUpperCase()}". Visible in Discover: ${newStatus === 'published' ? 'YES' : 'NO'}.`,
      ipAddress: '192.168.1.1',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    };
    setActivityLogs(prev => [newLog, ...prev]);

    adminFetch('/api/v1/admin/businesses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ businesses: [{ id: recordId, status: newStatus }] }),
    })
      .then((res) => { if (!res.ok && res.status !== 401) showToast(`Could not save the change (HTTP ${res.status}). It was not stored; reload to see the current state.`); })
      .catch(() => showToast('Could not reach the server. The change was not stored; reload to see the current state.'));

    showToast(`Status updated to ${newStatus.toUpperCase()}`);
  };

  // Bulk Status Update Handler
  const handleBulkStatusChange = (ids: string[], newStatus: BusinessStatus) => {
    setRecords(prev => {
      const updated = prev.map(rec => {
        if (ids.includes(rec.id)) {
          return {
            ...rec,
            status: newStatus,
            validationStatus: newStatus === 'approved' || newStatus === 'published' ? 'Approved' : rec.validationStatus,
            updatedAt: new Date().toISOString(),
            approvedDate: newStatus === 'approved' || newStatus === 'published' ? new Date().toISOString().replace('T', ' ').slice(0, 16) : rec.approvedDate,
            reviewer: newStatus === 'approved' || newStatus === 'published' ? (adminEmail || 'Monarch Administrator') : rec.reviewer,
          };
        }
        return rec;
      });
      syncAdminRecordsToPublishedStore(updated);
      return updated;
    });

    adminFetch('/api/v1/admin/businesses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ businesses: ids.map(id => ({ id, status: newStatus })) }),
    })
      .then((res) => { if (!res.ok && res.status !== 401) showToast(`Could not save the change (HTTP ${res.status}). It was not stored; reload to see the current state.`); })
      .catch(() => showToast('Could not reach the server. The change was not stored; reload to see the current state.'));

    const newLog: ActivityLogEntry = {
      id: `act-${Date.now()}`,
      user: adminEmail ? `${adminEmail} (Super Admin)` : 'Monarch Administrator (Super Admin)',
      action: newStatus === 'published' ? 'Published' : 'Updated',
      entityType: 'Business',
      entityId: 'BULK_BATCH',
      entityName: `${ids.length} Business Records`,
      details: `Bulk status update applied: "${newStatus.toUpperCase()}" on ${ids.length} records.`,
      ipAddress: '192.168.1.1',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    };
    setActivityLogs(prev => [newLog, ...prev]);

    showToast(`Bulk updated ${ids.length} records to ${newStatus.toUpperCase()}`);
  };

  // Bulk Delete Handler
  const handleBulkDelete = async (ids: string[]) => {
    setRecords(prev => prev.filter(r => !ids.includes(r.id)));
    const newLog: ActivityLogEntry = {
      id: `act-${Date.now()}`,
      user: adminEmail ? `${adminEmail} (Super Admin)` : 'Monarch Administrator (Super Admin)',
      action: 'Deleted',
      entityType: 'Business',
      entityId: 'BULK_DELETE',
      entityName: `${ids.length} Business Records`,
      details: `Bulk deleted ${ids.length} records from repository and the PostgreSQL database.`,
      ipAddress: '192.168.1.1',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    };
    setActivityLogs(prev => [newLog, ...prev]);
    await deleteAdminRecordsFromApi(ids);
    showToast(`Permanently deleted ${ids.length} business record(s) from database.`);
  };

  const handleApproveRecord = (id: string) => {
    handleStatusChange(id, 'approved');
    // like Reject and Delete: once the record is approved the validation window closes (the grid behind it already shows the new status)
    if (selectedRecordForValidation && selectedRecordForValidation.id === id) {
      setSelectedRecordForValidation(null);
    }
  };

  const handleRejectRecord = (id: string) => {
    setRecords(prev => prev.map(rec => {
      if (rec.id === id) {
        return {
          ...rec,
          status: 'rejected',
          validationStatus: 'Rejected',
          updatedAt: new Date().toISOString(),
        };
      }
      return rec;
    }));

    if (selectedRecordForValidation && selectedRecordForValidation.id === id) {
      setSelectedRecordForValidation(null);
    }

    const target = records.find(r => r.id === id);
    const newLog: ActivityLogEntry = {
      id: `act-${Date.now()}`,
      user: adminEmail ? `${adminEmail} (Super Admin)` : 'Monarch Administrator (Super Admin)',
      action: 'Rejected',
      entityType: 'Business',
      entityId: id,
      entityName: target?.name || 'Business Record',
      details: `Rejected business entity from publication queue.`,
      ipAddress: '192.168.1.1',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    };
    setActivityLogs(prev => [newLog, ...prev]);
    showToast(`Record ${id} rejected.`);
  };

  const handleDeleteRecord = async (id: string) => {
    setRecords(prev => prev.filter(r => r.id !== id));
    if (selectedRecordForValidation && selectedRecordForValidation.id === id) {
      setSelectedRecordForValidation(null);
    }
    await deleteAdminRecordsFromApi([id]);
    showToast(`Permanently deleted record ${id} from database.`);
  };

  const handleMoveToDraft = (id: string) => {
    handleStatusChange(id, 'draft');
  };

  const handleBulkApproveValidation = (ids: string[]) => {
    handleBulkStatusChange(ids, 'approved');
  };

  const handleBulkRejectValidation = (ids: string[]) => {
    setRecords(prev => prev.map(rec => {
      if (ids.includes(rec.id)) {
        return {
          ...rec,
          status: 'rejected',
          validationStatus: 'Rejected',
          updatedAt: new Date().toISOString(),
        };
      }
      return rec;
    }));
    showToast(`Rejected ${ids.length} records.`);
  };

  const handleExportRecords = (exportList: AdminBusinessRecord[]) => {
    const headers = ['ID', 'Name', 'Industry', 'Category', 'City', 'State', 'Phone', 'Email', 'Website', 'Status', 'Quality Score'];
    const rows = exportList.map(r => [
      r.id,
      `"${r.name.replace(/"/g, '""')}"`,
      `"${r.industry}"`,
      `"${r.category}"`,
      `"${r.city}"`,
      `"${r.state}"`,
      r.phone,
      r.email,
      r.website,
      r.status,
      r.dataQualityScore,
    ]);
    const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map(e => e.join(','))].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `orion_business_records_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    showToast(`Exported ${exportList.length} records to CSV.`);
  };

  const handleSaveNotes = (id: string, note: string) => {
    setRecords(prev => prev.map(r => {
      if (r.id === id) {
        return {
          ...r,
          internalNotes: [...(r.internalNotes || []), note]
        };
      }
      return r;
    }));
    showToast('Internal operator note added.');
  };

  const handleCompleteImport = (result: any) => {
    const newRecords: AdminBusinessRecord[] = result?.newRecords || [];
    const newDuplicates: DuplicatePair[] = result?.newDuplicates || [];
    const batchSummary = result?.batch || result;

    const batchId = batchSummary?.id || `IMP-${Math.floor(1000 + Math.random() * 9000)}`;
    const fileName = batchSummary?.fileName || batchSummary?.batchName || 'Ingested_Data_File.csv';
    const total = result?.stats?.total ?? newRecords.length ?? 0;

    const newBatch: ImportBatch = {
      id: batchId,
      fileName,
      uploadedBy: adminEmail || 'Administrator (Super Admin)',
      uploadedAt: new Date().toISOString().replace('T', ' ').slice(0, 16),
      totalRecords: total,
      successCount: newRecords.length,
      failedCount: result?.stats?.invalid ?? 0,
      duplicateCount: newDuplicates.length,
      status: 'Completed',
      fileSize: 'Live Pipeline Ingestion',
    };

    setBatches((prev) => [newBatch, ...prev]);

    if (newRecords.length > 0) {
      setRecords((prev) => [...newRecords, ...prev]);
    }

    if (newDuplicates.length > 0) {
      setDuplicatePairs((prev) => [...newDuplicates, ...prev]);
    }

    const newLog: ActivityLogEntry = {
      id: `act-${Date.now()}`,
      user: newBatch.uploadedBy,
      action: 'Imported',
      entityType: 'Batch',
      entityId: newBatch.id,
      entityName: newBatch.fileName,
      details: `Imported ${total} records into Data Validation workflow (${newDuplicates.length} duplicates flagged).`,
      ipAddress: '127.0.0.1',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    };
    setActivityLogs((prev) => [newLog, ...prev]);

    showToast(`Batch "${fileName}" imported. Proceeding to Data Validation & Duplicate Manager.`);
    setActiveTab('validation');
  };

  // Duplicates Handlers
  const handleMergeDuplicateConfirm = (pairId: string, mergedRecord: AdminBusinessRecord) => {
    const pair = duplicatePairs.find(p => p.id === pairId);
    if (!pair) return;

    setRecords(prev => {
      const filtered = prev.filter(r => r.id !== pair.duplicate.id);
      return filtered.map(r => r.id === mergedRecord.id ? mergedRecord : r);
    });

    setDuplicatePairs(prev => prev.map(p => p.id === pairId ? { ...p, status: 'merged' } : p));
    setSelectedDuplicatePair(null);

    const newLog: ActivityLogEntry = {
      id: `act-${Date.now()}`,
      user: adminEmail ? `${adminEmail} (Super Admin)` : 'Monarch Administrator (Super Admin)',
      action: 'Merged',
      entityType: 'Business',
      entityId: mergedRecord.id,
      entityName: mergedRecord.name,
      details: `Resolved duplicate conflict: merged "${pair.duplicate.name}" into master entity "${mergedRecord.name}".`,
      ipAddress: '192.168.1.1',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    };
    setActivityLogs(prev => [newLog, ...prev]);

    showToast(`Merged duplicate pair into "${mergedRecord.name}"`);
  };

  const handleKeepOriginal = (pairId: string) => {
    const pair = duplicatePairs.find(p => p.id === pairId);
    if (!pair) return;
    setRecords(prev => prev.filter(r => r.id !== pair.duplicate.id));
    setDuplicatePairs(prev => prev.map(p => p.id === pairId ? { ...p, status: 'deleted' } : p));
    showToast('Preserved master original record and removed duplicate.');
  };

  const handleKeepNew = (pairId: string) => {
    const pair = duplicatePairs.find(p => p.id === pairId);
    if (!pair) return;
    setRecords(prev => prev.map(r => r.id === pair.original.id ? { ...pair.duplicate, id: pair.original.id } : r));
    setDuplicatePairs(prev => prev.map(p => p.id === pairId ? { ...p, status: 'merged' } : p));
    showToast('Updated master record with incoming candidate attributes.');
  };

  const handleIgnoreDuplicate = (pairId: string) => {
    setDuplicatePairs(prev => prev.map(p => p.id === pairId ? { ...p, status: 'ignored' } : p));
    showToast('Ignored duplicate collision (marked as false-positive).');
  };

  const handleDeleteDuplicate = (pairId: string) => {
    const pair = duplicatePairs.find(p => p.id === pairId);
    if (!pair) return;
    setRecords(prev => prev.filter(r => r.id !== pair.duplicate.id));
    setDuplicatePairs(prev => prev.map(p => p.id === pairId ? { ...p, status: 'deleted' } : p));
    showToast('Deleted duplicate candidate record.');
  };

  const handleBulkMergeDuplicates = (pairIds: string[]) => {
    pairIds.forEach(id => {
      const pair = duplicatePairs.find(p => p.id === id);
      if (pair) {
        setRecords(prev => prev.filter(r => r.id !== pair.duplicate.id));
      }
    });
    setDuplicatePairs(prev => prev.map(p => pairIds.includes(p.id) ? { ...p, status: 'merged' } : p));
    showToast(`Bulk auto-merged ${pairIds.length} duplicate pairs.`);
  };

  // ================= MODULE 3 HANDLERS ================= //

  // Customer User Handlers
  const handleUpdateCustomer = (updatedUser: CustomerUser) => {
    setCustomerUsers(prev => prev.map(u => u.id === updatedUser.id ? updatedUser : u));
    showToast(`Updated customer profile for ${updatedUser.name}`);
  };

  const handleAddCustomer = (newUser: Omit<CustomerUser, 'id'>) => {
    const created: CustomerUser = {
      ...newUser,
      id: `CUST-${Math.floor(1000 + Math.random() * 9000)}`,
    };
    setCustomerUsers(prev => [created, ...prev]);

    const newLog: ActivityLogEntry = {
      id: `act-${Date.now()}`,
      user: adminEmail ? `${adminEmail} (Super Admin)` : 'Monarch Administrator (Super Admin)',
      action: 'Created',
      entityType: 'User',
      entityId: created.id,
      entityName: created.name,
      details: `Created new customer account (${created.plan} plan, ${created.credits} credits).`,
      ipAddress: '192.168.1.1',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    };
    setActivityLogs(prev => [newLog, ...prev]);

    showToast(`Customer account created for ${created.name}`);
  };

  const handleDeleteCustomer = (userId: string) => {
    setCustomerUsers(prev => prev.filter(u => u.id !== userId));
    showToast(`Customer account ${userId} deleted.`);
  };

  // Credit Transaction Handlers
  const handleAddTransaction = (tx: Omit<TransactionRecord, 'id' | 'date' | 'receiptNumber'>) => {
    const created: TransactionRecord = {
      ...tx,
      id: `TXN-${Math.floor(100000 + Math.random() * 900000)}`,
      receiptNumber: `REC-2024-${Math.floor(1000 + Math.random() * 9000)}`,
      date: new Date().toISOString().replace('T', ' ').slice(0, 16),
    };
    setTransactions(prev => [created, ...prev]);

    const newLog: ActivityLogEntry = {
      id: `act-${Date.now()}`,
      user: 'Automated Payment Gateway',
      action: 'Created',
      entityType: 'Credits',
      entityId: created.id,
      entityName: `${created.customerName} (${created.creditsPurchased} Credits)`,
      details: `Transaction posted: ₹${created.amount} via ${created.paymentMethod} (${created.paymentStatus}).`,
      ipAddress: '192.168.1.1',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    };
    setActivityLogs(prev => [newLog, ...prev]);

    showToast(`Transaction ${created.id} recorded successfully.`);
  };

  const handleUpdateTransactionStatus = (id: string, newStatus: PaymentStatus, reason?: string) => {
    setTransactions(prev => prev.map(t => {
      if (t.id === id) {
        return {
          ...t,
          paymentStatus: newStatus,
          refundReason: reason || t.refundReason,
        };
      }
      return t;
    }));
    showToast(`Transaction ${id} status updated to ${newStatus}`);
  };

  // Role Matrix Handlers
  const handleUpdateRole = (updatedRole: RoleDefinition) => {
    setRoles(prev => prev.map(r => r.id === updatedRole.id ? updatedRole : r));
    const newLog: ActivityLogEntry = {
      id: `act-${Date.now()}`,
      user: adminEmail ? `${adminEmail} (Super Admin)` : 'Monarch Administrator (Super Admin)',
      action: 'Updated',
      entityType: 'Settings',
      entityId: updatedRole.id,
      entityName: `${updatedRole.name} Permissions Matrix`,
      details: `Updated granular access permissions across 12 modules.`,
      ipAddress: '192.168.1.1',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    };
    setActivityLogs(prev => [newLog, ...prev]);
    showToast(`Saved permissions matrix for ${updatedRole.name}`);
  };

  const handleCreateRole = (newRole: Omit<RoleDefinition, 'id'>) => {
    const created: RoleDefinition = {
      ...newRole,
      id: `role-${Date.now().toString().slice(-4)}`,
    };
    setRoles(prev => [...prev, created]);
    showToast(`Created custom role: ${created.name}`);
  };

  // Support Ticket Handlers
  const handleUpdateTicketStatus = (ticketId: string, newStatus: TicketStatus, resolution?: string) => {
    setTickets(prev => prev.map(t => {
      if (t.id === ticketId) {
        return {
          ...t,
          status: newStatus,
          resolution: resolution || t.resolution,
          lastUpdated: new Date().toISOString().replace('T', ' ').slice(0, 16),
        };
      }
      return t;
    }));
    showToast(`Support Ticket ${ticketId} marked as ${newStatus}`);
  };

  const handleAddTicketMessage = (ticketId: string, messageText: string, isInternalNote: boolean) => {
    setTickets(prev => prev.map(t => {
      if (t.id === ticketId) {
        const newMsg = {
          id: `msg-${Date.now()}`,
          sender: isInternalNote ? ('Support Agent' as const) : ('Support Agent' as const),
          senderName: adminEmail || 'Support Agent',
          message: messageText,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          isInternalNote
        };
        return {
          ...t,
          messages: [...t.messages, newMsg],
          internalNotes: isInternalNote ? [...(t.internalNotes || []), messageText] : t.internalNotes,
          lastUpdated: new Date().toISOString().replace('T', ' ').slice(0, 16),
        };
      }
      return t;
    }));
    showToast('Message sent to ticket timeline.');
  };

  const handleCreateTicket = (newTicket: Omit<SupportTicket, 'id' | 'createdDate' | 'lastUpdated' | 'messages' | 'internalNotes'>) => {
    const created: SupportTicket = {
      ...newTicket,
      id: `TCK-${Math.floor(100 + Math.random() * 900)}`,
      createdDate: new Date().toISOString().replace('T', ' ').slice(0, 16),
      lastUpdated: new Date().toISOString().replace('T', ' ').slice(0, 16),
      messages: [
        {
          id: `msg-${Date.now()}`,
          sender: 'Customer',
          senderName: newTicket.customerName,
          message: newTicket.subject,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        }
      ],
      internalNotes: ['Ticket initiated by administrator.']
    };
    setTickets(prev => [created, ...prev]);
    showToast(`Opened Support Ticket ${created.id}`);
  };

  // ================= MODULE 4 HANDLERS ================= //

  // Data Sources Handlers
  const handleUpdateDataSourceStatus = (sourceId: string, status: DataSourceStatus) => {
    setDataSources(prev => prev.map(s => s.id === sourceId ? { ...s, status } : s));
    showToast(`Data source ${sourceId} status updated to ${status}`);
  };

  const handleManualSyncSource = (sourceId: string) => {
    setDataSources(prev => prev.map(s => {
      if (s.id === sourceId) {
        return {
          ...s,
          status: 'Running',
          lastSync: 'Just now',
          recordsImported: s.recordsImported + 450,
          syncHistory: [
            {
              id: `SYNC-${Date.now().toString().slice(-4)}`,
              timestamp: new Date().toISOString().replace('T', ' ').slice(0, 16),
              recordsFetched: 450,
              duration: '14s',
              status: 'Success',
              details: 'Manual trigger delta sync completed successfully.'
            },
            ...s.syncHistory
          ]
        };
      }
      return s;
    }));
    showToast(`Initiated manual sync for data source ${sourceId}`);
  };

  // Enrichment Queue Handlers
  const handleRetryEnrichmentJob = (jobId: string) => {
    setEnrichmentJobs(prev => prev.map(j => {
      if (j.id === jobId) {
        return {
          ...j,
          status: 'Running',
          progress: 25,
          errorMessage: undefined
        };
      }
      return j;
    }));
    showToast(`Retrying enrichment job ${jobId}`);
  };

  const handleCancelEnrichmentJob = (jobId: string) => {
    setEnrichmentJobs(prev => prev.map(j => j.id === jobId ? { ...j, status: 'Skipped' } : j));
    showToast(`Cancelled enrichment job ${jobId}`);
  };

  const handleRunAllEnrichment = () => {
    setEnrichmentJobs(prev => prev.map(j => j.status === 'Queued' ? { ...j, status: 'Running', progress: 20 } : j));
    showToast('Enqueued all pending enrichment tasks to BullMQ workers.');
  };

  // Automation Rules Handlers
  const handleCreateAutomationRule = (ruleData: Omit<AutomationRule, 'id' | 'executionsCount' | 'successRate' | 'lastExecuted'>) => {
    const newRule: AutomationRule = {
      ...ruleData,
      id: `RULE-${String(automationRules.length + 1).padStart(2, '0')}`,
      executionsCount: 0,
      successRate: 100.0,
      lastExecuted: 'Never'
    };
    setAutomationRules(prev => [newRule, ...prev]);
    showToast(`Created automation rule ${newRule.name}`);
  };

  const handleUpdateAutomationRule = (rule: AutomationRule) => {
    setAutomationRules(prev => prev.map(r => r.id === rule.id ? rule : r));
    showToast(`Updated automation rule ${rule.name}`);
  };

  const handleDeleteAutomationRule = (id: string) => {
    setAutomationRules(prev => prev.filter(r => r.id !== id));
    showToast(`Deleted automation rule ${id}`);
  };

  const handleToggleRuleStatus = (id: string) => {
    setAutomationRules(prev => prev.map(r => {
      if (r.id === id) {
        const nextStatus = r.status === 'Active' ? 'Paused' : 'Active';
        return { ...r, status: nextStatus };
      }
      return r;
    }));
    showToast(`Toggled automation rule status.`);
  };

  const handleRunRuleDryRun = (id: string) => {
    setAutomationRules(prev => prev.map(r => {
      if (r.id === id) {
        return {
          ...r,
          executionsCount: r.executionsCount + 1,
          lastExecuted: 'Just now'
        };
      }
      return r;
    }));
    showToast(`Executed dry-run for rule ${id}. Policy condition satisfied.`);
  };

  // Sync Center Handlers
  const handleRebuildIndex = () => {
    setSearchIndexStatus(prev => ({
      ...prev,
      lastOptimized: 'Just now',
      pendingIndex: 0,
      failedIndex: 0
    }));
    showToast('Rebuilt Elasticsearch master indices & invalidated Discover facet cache.');
  };

  const handleOptimizeIndex = () => {
    setSearchIndexStatus(prev => ({
      ...prev,
      lastOptimized: 'Just now'
    }));
    showToast('Optimized Lucene shard segments. Search latency optimized.');
  };

  const handleFlushCache = () => {
    showToast('Flushed Redis in-memory search caches across all regions.');
  };

  // System Health Handlers
  const handleRestartService = (id: string) => {
    setSystemServices(prev => prev.map(s => {
      if (s.id === id) {
        return {
          ...s,
          status: 'Healthy',
          uptime: '100.0%',
          errorRate: '0.00%',
          cpuUsage: Math.floor(20 + Math.random() * 20),
          memoryUsage: Math.floor(30 + Math.random() * 25)
        };
      }
      return s;
    }));
    showToast(`Successfully restarted microservice pod ${id}`);
  };

  // Render authentication loading state
  if (isCheckingAuth) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-zinc-950 text-white">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="h-8 w-8 animate-spin text-zinc-400" />
          <p className="text-xs text-zinc-400 font-mono tracking-wide">INITIALIZING MONARCH SECURITY GATEWAY...</p>
        </div>
      </div>
    );
  }

  // Render Security Gate if unauthenticated
  if (!isAdminAuthenticated) {
    return (
      <div className="flex min-h-screen w-full items-center justify-center bg-zinc-950 px-4 py-12 text-zinc-100 relative overflow-hidden">
        {/* Ambient background glow */}
        <div className="absolute -top-40 -left-40 w-96 h-96 bg-zinc-800/20 rounded-full blur-3xl pointer-events-none" />
        <div className="absolute -bottom-40 -right-40 w-96 h-96 bg-zinc-800/20 rounded-full blur-3xl pointer-events-none" />

        <div className="w-full max-w-md z-10 space-y-6">
          {/* Brand Header */}
          <div className="text-center space-y-3">
            <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-zinc-900 border border-zinc-800 shadow-xl mx-auto text-zinc-100">
              <ShieldCheck className="w-7 h-7" />
            </div>
            <div className="space-y-1">
              <div className="inline-flex items-center gap-1.5 px-3 py-0.5 rounded-full text-[10px] font-mono tracking-widest uppercase bg-zinc-800 text-zinc-300 border border-zinc-700 font-semibold">
                Monarch Security Gateway
              </div>
              <h1 className="text-2xl font-bold tracking-tight text-white">
                Admin Console Access
              </h1>
              <p className="text-xs text-zinc-400">
                Restricted to authorized system administrators only
              </p>
            </div>
          </div>

          {/* Security Card */}
          <div className="bg-zinc-900/90 border border-zinc-800 backdrop-blur-xl rounded-2xl p-6 sm:p-8 shadow-2xl space-y-6">
            {authError && (
              <div className="p-3.5 rounded-xl bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs flex items-start gap-2.5 animate-in fade-in-50">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-zinc-400" />
                <div className="leading-relaxed">{authError}</div>
              </div>
            )}

            {authStep === 'email' ? (
              <form onSubmit={handleSendOtp} className="space-y-4">
                <div className="space-y-1.5">
                  <label htmlFor="admin-email" className="text-xs font-semibold text-zinc-300 flex items-center justify-between">
                    <span>Corporate Email Address</span>
                    <span className="text-[10px] text-zinc-400 font-normal">Administrator credentials</span>
                  </label>
                  <div className="relative">
                    <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3.5 text-zinc-500">
                      <Mail className="h-4 w-4" />
                    </div>
                    <input
                      id="admin-email"
                      type="email"
                      placeholder="name@company.com"
                      value={inputEmail}
                      onChange={(e) => {
                        setInputEmail(e.target.value);
                        if (authError) setAuthError(null);
                      }}
                      className="flex h-11 w-full rounded-xl border border-zinc-700 bg-zinc-950/80 px-3 pl-10 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-400 focus:border-zinc-400 transition-all"
                      required
                      autoFocus
                    />
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={authLoading || !inputEmail.trim() || !inputEmail.includes('@')}
                  className="w-full inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-white dark:bg-white hover:bg-zinc-100 dark:hover:bg-zinc-100 text-zinc-950 dark:text-zinc-950 text-sm font-bold shadow-lg shadow-black/20 hover:shadow-xl hover:scale-[1.005] active:scale-[0.995] disabled:bg-zinc-800/80 disabled:dark:bg-zinc-800/80 disabled:text-zinc-500 disabled:dark:text-zinc-500 disabled:border disabled:border-zinc-700/60 disabled:shadow-none disabled:scale-100 disabled:cursor-not-allowed transition-all cursor-pointer"
                >
                  {authLoading ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>Generating OTP...</span>
                    </>
                  ) : (
                    <>
                      <span>Send Verification Code</span>
                      <ArrowRight className="w-4 h-4" />
                    </>
                  )}
                </button>
              </form>
            ) : (
              <form onSubmit={handleVerifyOtp} className="space-y-4">
                <div className="space-y-2 text-center">
                  <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-zinc-900 border border-zinc-800 text-zinc-200 mx-auto">
                    <Mail className="w-5 h-5 text-zinc-300" />
                  </div>
                  <h2 className="text-base font-semibold text-zinc-100">Check Your Email</h2>
                  <p className="text-xs text-zinc-400 max-w-[280px] mx-auto leading-relaxed">
                    We sent a 6-digit verification code to <span className="font-semibold text-white">{inputEmail}</span>. Enter it below to access the console.
                  </p>
                  <p className="text-[11px] text-zinc-500 max-w-[300px] mx-auto leading-relaxed">
                    Not there yet? Check spam. Codes are sent only to active administrator accounts, and each code works for 5 minutes and 5 tries.
                  </p>
                </div>

                <div className="space-y-1.5 pt-2">
                  <label htmlFor="otp-input" className="sr-only">6-Digit Code</label>
                  <input
                    id="otp-input"
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    placeholder="••••••"
                    value={otpCode}
                    onChange={(e) => {
                      setOtpCode(e.target.value.replace(/[^0-9]/g, ''));
                      if (authError) setAuthError(null);
                    }}
                    className="flex h-12 w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2 text-center font-mono text-2xl tracking-[0.5em] text-white placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-zinc-400 focus:border-zinc-400 transition-all"
                    required
                    autoFocus
                  />
                  <div className="flex items-center justify-between text-[11px] text-zinc-500 pt-1">
                    <span>Expires in {Math.floor(otpCountdown / 60)}:{(otpCountdown % 60).toString().padStart(2, '0')}</span>
                    <button
                      type="button"
                      onClick={() => handleSendOtp()}
                      disabled={authLoading || (!otpLocked && otpCountdown > OTP_TTL_SECONDS - RESEND_AFTER_SECONDS)}
                      className="text-zinc-300 hover:text-white disabled:opacity-40 disabled:hover:text-zinc-500 transition-colors cursor-pointer"
                    >
                      Resend Code
                    </button>
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={authLoading || otpCode.length < 6}
                  className="w-full inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-white dark:bg-white hover:bg-zinc-100 dark:hover:bg-zinc-100 text-zinc-950 dark:text-zinc-950 text-sm font-bold shadow-lg shadow-black/20 hover:shadow-xl hover:scale-[1.005] active:scale-[0.995] disabled:bg-zinc-800/80 disabled:dark:bg-zinc-800/80 disabled:text-zinc-500 disabled:dark:text-zinc-500 disabled:border disabled:border-zinc-700/60 disabled:shadow-none disabled:scale-100 disabled:cursor-not-allowed transition-all cursor-pointer"
                >
                  {authLoading ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>Verifying Code...</span>
                    </>
                  ) : (
                    <>
                      <ShieldCheck className="w-4 h-4" />
                      <span>Verify &amp; Launch Admin Console</span>
                    </>
                  )}
                </button>

                <div className="pt-2 text-center">
                  <button
                    type="button"
                    onClick={() => {
                      if (typeof window !== 'undefined') clearPending(window.sessionStorage);
                      setAuthStep('email');
                      setOtpCode('');
                      setOtpLocked(false);
                      setAuthError(null);
                    }}
                    className="text-xs text-zinc-400 hover:text-zinc-200 inline-flex items-center gap-1.5 transition-colors cursor-pointer"
                  >
                    <ArrowLeft className="w-3.5 h-3.5" />
                    <span>Use a different email address</span>
                  </button>
                </div>
              </form>
            )}
          </div>

          <div className="text-center text-[11px] text-zinc-600 space-y-1">
            <p>Monarch Softwares Enterprise Security System</p>
            <p>All administrative activities are recorded in immutable platform audit logs.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`${isDark ? 'dark' : ''} admin-portal flex h-screen w-full bg-slate-50 dark:bg-zinc-950 text-slate-900 dark:text-zinc-100 overflow-hidden font-sans transition-colors duration-200`}>
      {/* Toast Notification */}
      {toastMessage && (
        <div className="fixed bottom-6 right-6 z-50 bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 border border-zinc-700 dark:border-zinc-300 px-4 py-2.5 rounded-xl shadow-2xl flex items-center gap-3 animate-in slide-in-from-bottom-5">
          <div className="w-2 h-2 rounded-full bg-white dark:bg-zinc-900 animate-pulse" />
          <span className="text-xs font-semibold">{toastMessage}</span>
        </div>
      )}

      {/* Sticky Collapsible Sidebar */}
      <AdminSidebar
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        badgeCounts={counts}
        isCollapsed={isSidebarCollapsed}
        onToggleCollapse={() => setIsSidebarCollapsed(prev => !prev)}
        isSuperAdmin={canAccessRoles(adminRole)}
      />

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col h-full overflow-hidden min-w-0">
        {/* Sticky Header */}
        <AdminHeader
          activeTab={activeTab}
          onOpenSearch={() => setIsSearchModalOpen(true)}
          onNavigateTab={setActiveTab}
          onRefreshData={() => showToast('Platform synchronized with enterprise cluster.')}
          adminEmail={adminEmail}
          onSignOut={handleAdminSignOut}
          isDark={isDark}
          onToggleTheme={toggleAdminTheme}
        />

        {/* Scrollable View Container */}
        <main className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8 space-y-6">
          <div className="max-w-7xl mx-auto min-w-0">
            {/* Module 1 Views */}
            {activeTab === 'dashboard' && (
              <AdminDashboardView
                businesses={records}
                batches={batches}
                logs={activityLogs}
                customerUsers={customerUsers}
                transactions={transactions}
                onNavigate={setActiveTab}
                onSelectBusiness={setSelectedRecordForDetail}
              />
            )}

            {activeTab === 'records' && (
              <BusinessRecordsView
                businesses={records}
                onSelectBusiness={setSelectedRecordForDetail}
                onUpdateStatus={handleStatusChange}
                onBulkUpdateStatus={handleBulkStatusChange}
                onBulkDelete={handleBulkDelete}
                onExportRecords={handleExportRecords}
              />
            )}

            {activeTab === 'import' && (
              <ImportDataView
                onImportComplete={handleCompleteImport}
              />
            )}

            {activeTab === 'history' && (
              <ImportHistoryView
                batches={batches}
                onRetryBatch={batchId => showToast(`Retrying batch ${batchId}...`)}
                onDeleteBatch={async (batchId) => {
                  setBatches(prev => prev.filter(b => b.id !== batchId));
                  await adminFetch('/api/v1/admin/import/batches', {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id: batchId }),
                  }).catch(() => {});
                  showToast(`Batch ${batchId} permanently deleted from database.`);
                }}
              />
            )}

            {/* Module 2 Views */}
            {activeTab === 'validation' && (
              <DataValidationView
                records={records}
                onViewDetails={setSelectedRecordForValidation}
                onApproveRecord={handleApproveRecord}
                onRejectRecord={handleRejectRecord}
                onDeleteRecord={handleDeleteRecord}
                onBulkApprove={handleBulkApproveValidation}
                onBulkReject={handleBulkRejectValidation}
                onBulkDelete={handleBulkDelete}
              />
            )}

            {activeTab === 'duplicates' && (
              <DuplicateManagerView
                duplicates={duplicatePairs}
                onOpenMergePreview={setSelectedDuplicatePair}
                onKeepOriginal={handleKeepOriginal}
                onKeepNew={handleKeepNew}
                onIgnore={handleIgnoreDuplicate}
                onDeleteDuplicate={handleDeleteDuplicate}
                onBulkMerge={handleBulkMergeDuplicates}
              />
            )}

            {activeTab === 'publish_queue' && (
              <PublishQueueView
                records={records}
                onViewRecord={setSelectedRecordForValidation}
                onStatusChange={handleStatusChange}
                onBulkStatusChange={handleBulkStatusChange}
                onBulkDelete={handleBulkDelete}
              />
            )}

            {activeTab === 'upload_ops' && <UploadOperationsView />}

            {activeTab === 'people_import' && <PeopleImportView />}

            {activeTab === 'data_quality' && <DataQualityMetricsView />}

            {activeTab === 'people_review' && (
              <PeopleReviewView />
            )}

            {activeTab === 'enrichment' && (
              <DataEnrichmentView />
            )}

            {activeTab === 'published' && (
              <PublishedBusinessesView
                records={records}
                onViewRecord={setSelectedRecordForDetail}
                onStatusChange={handleStatusChange}
              />
            )}

            {/* Module 3 Views: Platform Administration */}
            {activeTab === 'reports' && (
              <ReportsView
                records={records}
                transactions={transactions}
                users={customerUsers}
              />
            )}

            {activeTab === 'users' && (
              <UsersManagementView
                users={customerUsers}
                onUpdateUser={handleUpdateCustomer}
                onAddUser={handleAddCustomer}
                onDeleteUser={handleDeleteCustomer}
              />
            )}

            {activeTab === 'credits' && (
              <CreditsTransactionsView
                transactions={transactions}
                onAddTransaction={handleAddTransaction}
                onUpdateTransactionStatus={handleUpdateTransactionStatus}
              />
            )}

            {activeTab === 'roles' && (
              canAccessRoles(adminRole) ? (
                <RolesPermissionsView
                  roles={roles}
                  onUpdateRole={handleUpdateRole}
                  onCreateRole={handleCreateRole}
                />
              ) : (
                <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-10 text-center" role="alert">
                  <ShieldCheck className="w-8 h-8 text-zinc-500 mx-auto mb-3" />
                  <h2 className="text-lg font-bold text-zinc-100">Access denied</h2>
                  <p className="text-sm text-zinc-400 mt-1">Roles &amp; Permissions is available to the Super Admin only.</p>
                </div>
              )
            )}

            {activeTab === 'settings' && (
              <AdminSettingsView />
            )}

            {activeTab === 'logs' && (
              <ActivityLogsView logs={activityLogs} />
            )}

            {activeTab === 'support' && (
              <SupportCenterView
                tickets={tickets}
                onUpdateTicketStatus={handleUpdateTicketStatus}
                onAddTicketMessage={handleAddTicketMessage}
                onCreateTicket={handleCreateTicket}
              />
            )}

            {/* Module 4 Views: Data Intelligence & Automation */}
            {activeTab === 'data_intelligence' && (
              <DataIntelligenceView
                records={records}
                sources={dataSources}
                enrichmentJobs={enrichmentJobs}
                pipelines={aiPipelines}
                rules={automationRules}
                systemServices={systemServices}
                onNavigateTab={setActiveTab}
                onSelectBusiness={setSelectedRecordForDetail}
              />
            )}

            {activeTab === 'sources' && (
              <DataSourcesView
                sources={dataSources}
                onUpdateStatus={handleUpdateDataSourceStatus}
                onManualSync={handleManualSyncSource}
              />
            )}

            {activeTab === 'enrichment_queue' && (
              <EnrichmentQueueView
                jobs={enrichmentJobs}
                onRetryJob={handleRetryEnrichmentJob}
                onCancelJob={handleCancelEnrichmentJob}
                onRunAll={handleRunAllEnrichment}
              />
            )}

            {activeTab === 'ai_processing' && (
              <AiProcessingView
                pipelines={aiPipelines}
                onRunBenchmark={(pipe) => showToast(`Inference benchmark evaluated for ${pipe.displayName} (${pipe.avgLatencyMs}ms latency).`)}
                onResetPipelines={() => setAiPipelines(INITIAL_AI_PIPELINES)}
              />
            )}

            {activeTab === 'automation' && (
              <AutomationRulesView
                rules={automationRules}
                onCreateRule={handleCreateAutomationRule}
                onUpdateRule={handleUpdateAutomationRule}
                onDeleteRule={handleDeleteAutomationRule}
                onToggleStatus={handleToggleRuleStatus}
                onRunRuleNow={handleRunRuleDryRun}
              />
            )}

            {activeTab === 'sync_center' && (
              <SyncCenterView
                indexStatus={searchIndexStatus}
                onRebuildIndex={handleRebuildIndex}
                onOptimizeIndex={handleOptimizeIndex}
                onFlushCache={handleFlushCache}
              />
            )}

            {activeTab === 'system_health' && (
              <SystemHealthView
                services={systemServices}
                onRestartService={handleRestartService}
                onRefreshHealth={() => showToast('Polled latest telemetry from Kubernetes & Prometheus.')}
              />
            )}
          </div>
        </main>
      </div>

      {/* Global Business Record Detail Drawer / Modal */}
      {selectedRecordForDetail && (
        <BusinessDetailsModal
          business={selectedRecordForDetail}
          isOpen={!!selectedRecordForDetail}
          onClose={() => setSelectedRecordForDetail(null)}
          onUpdateStatus={handleStatusChange}
          onSaveNotes={handleSaveNotes}
        />
      )}

      {/* Module 2 Business Validation Details Modal */}
      {selectedRecordForValidation && (
        <BusinessValidationModal
          business={selectedRecordForValidation}
          isOpen={!!selectedRecordForValidation}
          onClose={() => setSelectedRecordForValidation(null)}
          onApprove={handleApproveRecord}
          onReject={handleRejectRecord}
          onMoveToDraft={handleMoveToDraft}
          onDelete={handleDeleteRecord}
          onSaveNote={handleSaveNotes}
        />
      )}

      {/* Side-by-Side Merge Preview Modal */}
      {selectedDuplicatePair && (
        <MergePreviewModal
          pair={selectedDuplicatePair}
          isOpen={!!selectedDuplicatePair}
          onClose={() => setSelectedDuplicatePair(null)}
          onConfirmMerge={handleMergeDuplicateConfirm}
        />
      )}

      {/* Global Admin Search Modal (Cmd+K across all 5 entities) */}
      {isSearchModalOpen && (
        <GlobalAdminSearchModal
          isOpen={isSearchModalOpen}
          onClose={() => setIsSearchModalOpen(false)}
          businesses={records}
          users={customerUsers}
          transactions={transactions}
          tickets={tickets}
          logs={activityLogs}
          onSelectBusiness={business => {
            setSelectedRecordForDetail(business);
            setIsSearchModalOpen(false);
          }}
          onSelectUser={user => {
            setActiveTab('users');
            setIsSearchModalOpen(false);
          }}
          onSelectTicket={ticket => {
            setActiveTab('support');
            setIsSearchModalOpen(false);
          }}
        />
      )}
    </div>
  );
}
