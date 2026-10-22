'use client';
import { Linkedin } from '@/components/ui/linkedin-icon';

import React, { useState, useMemo } from 'react';
import { 
  AdminBusinessRecord, 
  ValidationIssue, 
  ValidationStatus, 
  FieldValidationStatus 
} from '@/types/admin';
import {
  ShieldAlert,
  Search,
  Filter,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Clock,
  Download,
  Eye,
  Edit3,
  Check,
  X,
  Trash2,
  ArrowUpDown,
  RotateCcw,
  SlidersHorizontal,
  ChevronLeft,
  ChevronRight,
  Sparkles,
  Phone,
  Mail,
  Globe,
  Building2,
  MapPin
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface DataValidationViewProps {
  records: AdminBusinessRecord[];
  onViewDetails: (record: AdminBusinessRecord) => void;
  onApproveRecord: (id: string) => void;
  onRejectRecord: (id: string) => void;
  onDeleteRecord: (id: string) => void;
  onBulkApprove: (ids: string[]) => void;
  onBulkReject: (ids: string[]) => void;
  onBulkDelete: (ids: string[]) => void;
}

export function DataValidationView({
  records,
  onViewDetails,
  onApproveRecord,
  onRejectRecord,
  onDeleteRecord,
  onBulkApprove,
  onBulkReject,
  onBulkDelete,
}: DataValidationViewProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedStatus, setSelectedStatus] = useState<string>('all');
  const [selectedState, setSelectedState] = useState<string>('all');
  const [selectedIndustry, setSelectedIndustry] = useState<string>('all');
  const [filterOnlyErrors, setFilterOnlyErrors] = useState(false);
  const [filterOnlyWarnings, setFilterOnlyWarnings] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [currentPage, setCurrentPage] = useState(1);
  const pageSize = 8;

  // Compute Summary Metrics
  const summary = useMemo(() => {
    const total = records.length;
    const passed = records.filter(r => r.validationScore >= 80 && r.validationStatus !== 'Rejected').length;
    const warnings = records.filter(r => r.validationStatus === 'Warning' || (r.validationScore >= 50 && r.validationScore < 80)).length;
    const errors = records.filter(r => r.validationScore < 50 || r.validationStatus === 'Rejected').length;
    const pending = records.filter(r => r.validationStatus === 'Pending').length;
    const rejected = records.filter(r => r.validationStatus === 'Rejected').length;
    return { total, passed, warnings, errors, pending, rejected };
  }, [records]);

  // Extract filter sets
  const states = useMemo(() => Array.from(new Set(records.map(r => r.state))).sort(), [records]);
  const industries = useMemo(() => Array.from(new Set(records.map(r => r.industry))).sort(), [records]);

  // Filtered List
  const filteredRecords = useMemo(() => {
    return records.filter(r => {
      const q = searchQuery.toLowerCase().trim();
      const matchesSearch = !q || (
        r.name.toLowerCase().includes(q) ||
        r.phone.includes(q) ||
        r.email.toLowerCase().includes(q) ||
        r.city.toLowerCase().includes(q) ||
        r.industry.toLowerCase().includes(q) ||
        r.id.toLowerCase().includes(q)
      );

      const matchesStatus = selectedStatus === 'all' || r.validationStatus === selectedStatus;
      const matchesState = selectedState === 'all' || r.state === selectedState;
      const matchesIndustry = selectedIndustry === 'all' || r.industry === selectedIndustry;
      const matchesErrorToggle = !filterOnlyErrors || r.validationScore < 60 || r.validationStatus === 'Rejected';
      const matchesWarningToggle = !filterOnlyWarnings || r.validationStatus === 'Warning' || r.phoneStatus === 'warning' || r.websiteStatus === 'missing' || r.websiteStatus === 'warning';

      return matchesSearch && matchesStatus && matchesState && matchesIndustry && matchesErrorToggle && matchesWarningToggle;
    });
  }, [records, searchQuery, selectedStatus, selectedState, selectedIndustry, filterOnlyErrors, filterOnlyWarnings]);

  // Pagination
  const totalPages = Math.ceil(filteredRecords.length / pageSize) || 1;
  const paginatedRecords = filteredRecords.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  const handleSelectAll = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.checked) {
      setSelectedIds(paginatedRecords.map(r => r.id));
    } else {
      setSelectedIds([]);
    }
  };

  const handleToggleSelect = (id: string) => {
    setSelectedIds(prev => prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]);
  };

  const renderFieldPill = (status: FieldValidationStatus, label: string) => {
    switch (status) {
      case 'valid':
        return (
          <span className="inline-flex items-center gap-1 text-[10px] font-bold font-mono px-2 py-0.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200 border border-zinc-200 dark:border-zinc-700">
            ✓ Valid
          </span>
        );
      case 'warning':
        return (
          <span className="inline-flex items-center gap-1 text-[10px] font-bold font-mono px-2 py-0.5 rounded-full bg-zinc-200 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100">
            ⚠ Warning
          </span>
        );
      case 'invalid':
        return (
          <span className="inline-flex items-center gap-1 text-[10px] font-bold font-mono px-2 py-0.5 rounded-full bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900">
            ✕ Invalid
          </span>
        );
      case 'missing':
        return (
          <span className="inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500">
            Missing
          </span>
        );
      case 'duplicate':
        return (
          <span className="inline-flex items-center gap-1 text-[10px] font-bold font-mono px-2 py-0.5 rounded-full bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900">
            Duplicate
          </span>
        );
      default:
        return null;
    }
  };

  const renderValidationStatusBadge = (status: ValidationStatus) => {
    return (
      <span className={cn(
        'px-2.5 py-0.5 rounded-full text-xs font-semibold uppercase tracking-wider',
        status === 'Approved' && 'bg-zinc-900 text-white dark:bg-white dark:text-zinc-900',
        status === 'Validated' && 'bg-zinc-100 dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200 border border-zinc-300 dark:border-zinc-700',
        status === 'Pending' && 'bg-zinc-100 dark:bg-zinc-800 text-zinc-500 border border-zinc-200 dark:border-zinc-700',
        status === 'Warning' && 'bg-zinc-200 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 font-bold',
        status === 'Rejected' && 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 font-bold'
      )}>
        {status}
      </span>
    );
  };

  const handleExportValidationReport = () => {
    const headers = ['Record ID', 'Business Name', 'Industry', 'State', 'City', 'Phone Status', 'Email Status', 'Website Status', 'Score', 'Validation Status', 'Import Date'];
    const rows = filteredRecords.map(r => [
      r.id,
      `"${r.name.replace(/"/g, '""')}"`,
      `"${r.industry}"`,
      `"${r.state}"`,
      `"${r.city}"`,
      r.phoneStatus,
      r.emailStatus,
      r.websiteStatus,
      r.validationScore,
      r.validationStatus,
      r.createdAt
    ]);
    const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map(e => e.join(','))].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `orion_data_validation_report_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="space-y-6 pb-12 text-zinc-900 dark:text-zinc-100 text-xs">
      
      {/* Top Banner & Export */}
      <div className="bg-white dark:bg-zinc-950 p-5 rounded-2xl border border-zinc-200 dark:border-zinc-800 shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
              <ShieldAlert className="w-5 h-5 text-zinc-900 dark:text-zinc-100" />
              Data Validation & Quality Assurance
            </h1>
            <span className="px-2.5 py-0.5 text-[11px] font-bold rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200 border border-zinc-200 dark:border-zinc-700">
              Module 2
            </span>
          </div>
          <p className="text-xs text-zinc-500 mt-1">
            Enforce strict schema rules, evaluate phone/email/URL formats, detect identity collisions, and verify data before publication.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={handleExportValidationReport}
            className="flex items-center gap-2 px-3.5 py-2 text-xs font-semibold rounded-lg border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-900 transition cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            Export Validation CSV
          </button>
        </div>
      </div>

      {/* Validation Summary Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <div className="p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 shadow-xs">
          <span className="text-[10px] text-zinc-400 font-bold uppercase tracking-wider block">Total Ingested</span>
          <div className="text-2xl font-bold font-mono text-zinc-900 dark:text-zinc-100 mt-1">
            {summary.total.toLocaleString()}
          </div>
          <span className="text-[10px] text-zinc-500 mt-0.5 block">100% evaluated</span>
        </div>

        <div className="p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 shadow-xs">
          <span className="text-[10px] text-zinc-400 font-bold uppercase tracking-wider block">Passed Schema</span>
          <div className="text-2xl font-bold font-mono text-zinc-900 dark:text-zinc-100 mt-1">
            {summary.passed.toLocaleString()}
          </div>
          <span className="text-[10px] text-zinc-500 mt-0.5 block">Score ≥ 80%</span>
        </div>

        <div className="p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 shadow-xs">
          <span className="text-[10px] text-zinc-400 font-bold uppercase tracking-wider block">Warnings</span>
          <div className="text-2xl font-bold font-mono text-zinc-900 dark:text-zinc-100 mt-1">
            {summary.warnings.toLocaleString()}
          </div>
          <span className="text-[10px] text-zinc-500 mt-0.5 block">Requires inspection</span>
        </div>

        <div className="p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 shadow-xs">
          <span className="text-[10px] text-zinc-400 font-bold uppercase tracking-wider block">Errors / Failed</span>
          <div className="text-2xl font-bold font-mono text-zinc-900 dark:text-zinc-100 mt-1">
            {summary.errors.toLocaleString()}
          </div>
          <span className="text-[10px] text-zinc-500 mt-0.5 block">Violations flagged</span>
        </div>

        <div className="p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 shadow-xs">
          <span className="text-[10px] text-zinc-400 font-bold uppercase tracking-wider block">Pending Review</span>
          <div className="text-2xl font-bold font-mono text-zinc-900 dark:text-zinc-100 mt-1">
            {summary.pending.toLocaleString()}
          </div>
          <span className="text-[10px] text-zinc-500 mt-0.5 block">In queue</span>
        </div>

        <div className="p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 shadow-xs">
          <span className="text-[10px] text-zinc-400 font-bold uppercase tracking-wider block">Rejected</span>
          <div className="text-2xl font-bold font-mono text-zinc-900 dark:text-zinc-100 mt-1">
            {summary.rejected.toLocaleString()}
          </div>
          <span className="text-[10px] text-zinc-500 mt-0.5 block">Quarantined</span>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="bg-white dark:bg-zinc-950 p-4 rounded-2xl border border-zinc-200 dark:border-zinc-800 shadow-xs space-y-3">
        <div className="flex flex-col md:flex-row items-center justify-between gap-3">
          
          {/* Search Input */}
          <div className="relative w-full md:w-80">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
            <input
              type="text"
              placeholder="Search by name, phone, email, city, ID..."
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setCurrentPage(1);
              }}
              className="w-full bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg pl-9 pr-3 py-2 text-xs text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 focus:outline-none focus:border-zinc-500 transition"
            />
          </div>

          {/* Filter Dropdowns */}
          <div className="flex flex-wrap items-center gap-2.5 w-full md:w-auto">
            <select
              value={selectedStatus}
              onChange={(e) => {
                setSelectedStatus(e.target.value);
                setCurrentPage(1);
              }}
              className="bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg px-3 py-2 text-xs text-zinc-900 dark:text-zinc-100 focus:outline-none"
            >
              <option value="all">All Validation Statuses</option>
              <option value="Pending">Pending</option>
              <option value="Validated">Validated</option>
              <option value="Warning">Warning</option>
              <option value="Approved">Approved</option>
              <option value="Rejected">Rejected</option>
            </select>

            <select
              value={selectedState}
              onChange={(e) => {
                setSelectedState(e.target.value);
                setCurrentPage(1);
              }}
              className="bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg px-3 py-2 text-xs text-zinc-900 dark:text-zinc-100 focus:outline-none"
            >
              <option value="all">All States ({states.length})</option>
              {states.map(s => <option key={s} value={s}>{s}</option>)}
            </select>

            <select
              value={selectedIndustry}
              onChange={(e) => {
                setSelectedIndustry(e.target.value);
                setCurrentPage(1);
              }}
              className="bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg px-3 py-2 text-xs text-zinc-900 dark:text-zinc-100 focus:outline-none max-w-[180px]"
            >
              <option value="all">All Industries ({industries.length})</option>
              {industries.map(i => <option key={i} value={i}>{i}</option>)}
            </select>
          </div>
        </div>

        {/* Quick Toggles */}
        <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-zinc-100 dark:border-zinc-800">
          <button
            onClick={() => {
              setFilterOnlyWarnings(!filterOnlyWarnings);
              setCurrentPage(1);
            }}
            className={cn(
              'px-3 py-1 rounded-md text-xs font-medium border transition cursor-pointer',
              filterOnlyWarnings
                ? 'bg-zinc-900 text-white dark:bg-white dark:text-zinc-900 border-transparent font-bold'
                : 'border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-900'
            )}
          >
            Warnings Only
          </button>

          <button
            onClick={() => {
              setFilterOnlyErrors(!filterOnlyErrors);
              setCurrentPage(1);
            }}
            className={cn(
              'px-3 py-1 rounded-md text-xs font-medium border transition cursor-pointer',
              filterOnlyErrors
                ? 'bg-zinc-900 text-white dark:bg-white dark:text-zinc-900 border-transparent font-bold'
                : 'border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-900'
            )}
          >
            Errors & Violations Only
          </button>

          {(filterOnlyWarnings || filterOnlyErrors || selectedStatus !== 'all' || selectedState !== 'all' || selectedIndustry !== 'all' || searchQuery) && (
            <button
              onClick={() => {
                setFilterOnlyWarnings(false);
                setFilterOnlyErrors(false);
                setSelectedStatus('all');
                setSelectedState('all');
                setSelectedIndustry('all');
                setSearchQuery('');
                setCurrentPage(1);
              }}
              className="px-2.5 py-1 text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-white flex items-center gap-1 cursor-pointer"
            >
              <RotateCcw className="w-3 h-3" />
              Reset Filters
            </button>
          )}
        </div>
      </div>

      {/* Bulk Action Bar */}
      {selectedIds.length > 0 && (
        <div className="bg-zinc-900 text-white dark:bg-white dark:text-zinc-900 px-5 py-3 rounded-xl shadow-lg flex items-center justify-between animate-in slide-in-from-top-2">
          <div className="flex items-center gap-2 font-semibold">
            <span className="px-2 py-0.5 rounded-full bg-zinc-800 dark:bg-zinc-200 text-xs font-mono">
              {selectedIds.length} Selected
            </span>
            <span>Perform bulk validation action:</span>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                onBulkApprove(selectedIds);
                setSelectedIds([]);
              }}
              className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 dark:bg-zinc-200 dark:hover:bg-zinc-300 text-xs font-bold rounded-lg transition cursor-pointer"
            >
              Approve Selected
            </button>
            <button
              onClick={() => {
                onBulkReject(selectedIds);
                setSelectedIds([]);
              }}
              className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 dark:bg-zinc-200 dark:hover:bg-zinc-300 text-xs font-bold rounded-lg transition cursor-pointer"
            >
              Reject Selected
            </button>
            <button
              onClick={() => {
                onBulkDelete(selectedIds);
                setSelectedIds([]);
              }}
              className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 dark:bg-zinc-200 dark:hover:bg-zinc-300 text-xs font-bold rounded-lg transition cursor-pointer"
            >
              Delete Selected
            </button>
          </div>
        </div>
      )}

      {/* Data Validation Master Table */}
      <div className="bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-2xl shadow-xs overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs whitespace-nowrap">
            <thead className="bg-zinc-50 dark:bg-zinc-900/80 text-zinc-500 uppercase text-[10px] font-bold border-b border-zinc-200 dark:border-zinc-800">
              <tr>
                <th className="px-4 py-3.5 w-10 text-center">
                  <input
                    type="checkbox"
                    onChange={handleSelectAll}
                    checked={paginatedRecords.length > 0 && selectedIds.length === paginatedRecords.length}
                    className="w-4 h-4 rounded accent-zinc-900 cursor-pointer"
                  />
                </th>
                <th className="px-4 py-3.5">Business Name & ID</th>
                <th className="px-4 py-3.5">Industry Sector</th>
                <th className="px-4 py-3.5">Location Hierarchy</th>
                <th className="px-4 py-3.5 text-center">Phone Status</th>
                <th className="px-4 py-3.5 text-center">Email Status</th>
                <th className="px-4 py-3.5 text-center">Website Status</th>
                <th className="px-4 py-3.5 text-center">LinkedIn Status</th>
                <th className="px-4 py-3.5 text-center">Validation Score</th>
                <th className="px-4 py-3.5 text-center">Validation Status</th>
                <th className="px-4 py-3.5">Imported Date</th>
                <th className="px-4 py-3.5 text-right">Row Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800 font-sans">
              {paginatedRecords.length === 0 ? (
                <tr>
                  <td colSpan={12} className="py-12 text-center text-zinc-500">
                    <ShieldAlert className="w-8 h-8 mx-auto mb-2 text-zinc-400" />
                    No business records match the current validation criteria.
                  </td>
                </tr>
              ) : (
                paginatedRecords.map((record) => {
                  const isSelected = selectedIds.includes(record.id);
                  return (
                    <tr
                      key={record.id}
                      className={cn(
                        'hover:bg-zinc-50/60 dark:hover:bg-zinc-900/40 transition-colors',
                        isSelected && 'bg-zinc-50 dark:bg-zinc-900/60'
                      )}
                    >
                      <td className="px-4 py-3 text-center">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => handleToggleSelect(record.id)}
                          className="w-4 h-4 rounded accent-zinc-900 cursor-pointer"
                        />
                      </td>

                      <td className="px-4 py-3">
                        <div className="font-bold text-zinc-900 dark:text-zinc-100 text-xs flex items-center gap-1.5">
                          {record.name}
                          {record.isDuplicate && (
                            <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-zinc-200 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300">
                              DUP
                            </span>
                          )}
                        </div>
                        <span className="text-[10px] text-zinc-400 font-mono">{record.id}</span>
                      </td>

                      <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">
                        <div className="font-medium text-zinc-800 dark:text-zinc-200">{record.industry}</div>
                        <div className="text-[10px] text-zinc-500">{record.category}</div>
                      </td>

                      <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">
                        <div className="font-medium text-zinc-800 dark:text-zinc-200 flex items-center gap-1">
                          <MapPin className="w-3 h-3 text-zinc-400" />
                          {record.city}, {record.state}
                        </div>
                        <div className="text-[10px] text-zinc-500 font-mono">Pin: {record.pincode} • {record.district}</div>
                      </td>

                      <td className="px-4 py-3 text-center">
                        {renderFieldPill(record.phoneStatus, record.phone)}
                      </td>

                      <td className="px-4 py-3 text-center">
                        {renderFieldPill(record.emailStatus, record.email)}
                      </td>

                      <td className="px-4 py-3 text-center">
                        {renderFieldPill(record.websiteStatus, record.website)}
                      </td>

                      <td className="px-4 py-3 text-center">
                        {renderFieldPill((record.linkedin || (record as any).linkedin_url || (record as any).linkedInUrl) ? 'valid' : 'missing', record.linkedin || (record as any).linkedin_url || (record as any).linkedInUrl)}
                      </td>

                      <td className="px-4 py-3 text-center">
                        <span className="inline-flex items-center justify-center px-2 py-0.5 rounded-full text-xs font-bold font-mono bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 border border-zinc-200 dark:border-zinc-700">
                          {record.validationScore}%
                        </span>
                      </td>

                      <td className="px-4 py-3 text-center">
                        {renderValidationStatusBadge(record.validationStatus)}
                      </td>

                      <td className="px-4 py-3 text-zinc-500 font-mono text-[11px]">
                        {record.createdAt}
                      </td>

                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            onClick={() => onViewDetails(record)}
                            title="Inspect Validation Details"
                            className="p-1.5 rounded-lg text-zinc-600 dark:text-zinc-400 hover:text-zinc-950 dark:hover:text-white hover:bg-zinc-100 dark:hover:bg-zinc-800 transition cursor-pointer"
                          >
                            <Eye className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => onApproveRecord(record.id)}
                            title="Approve Record"
                            className="p-1.5 rounded-lg text-zinc-700 dark:text-zinc-300 hover:text-zinc-950 dark:hover:text-white hover:bg-zinc-100 dark:hover:bg-zinc-800 transition cursor-pointer"
                          >
                            <Check className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => onRejectRecord(record.id)}
                            title="Reject Record"
                            className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-950 dark:hover:text-white hover:bg-zinc-100 dark:hover:bg-zinc-800 transition cursor-pointer"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => onDeleteRecord(record.id)}
                            title="Delete Record"
                            className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-950 dark:hover:text-white hover:bg-zinc-100 dark:hover:bg-zinc-800 transition cursor-pointer"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination Footer */}
        <div className="px-5 py-3 border-t border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-900/30 flex items-center justify-between text-xs text-zinc-500">
          <div>
            Showing <span className="font-bold text-zinc-900 dark:text-zinc-100">{(currentPage - 1) * pageSize + 1}</span> to{' '}
            <span className="font-bold text-zinc-900 dark:text-zinc-100">
              {Math.min(currentPage * pageSize, filteredRecords.length)}
            </span>{' '}
            of <span className="font-bold text-zinc-900 dark:text-zinc-100">{filteredRecords.length}</span> records
          </div>

          <div className="flex items-center gap-1">
            <button
              onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
              disabled={currentPage === 1}
              className="p-1.5 rounded-md border border-zinc-200 dark:border-zinc-800 disabled:opacity-30 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition cursor-pointer"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>
            <span className="px-3 font-mono font-bold text-zinc-900 dark:text-zinc-100">
              Page {currentPage} of {totalPages}
            </span>
            <button
              onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
              disabled={currentPage === totalPages}
              className="p-1.5 rounded-md border border-zinc-200 dark:border-zinc-800 disabled:opacity-30 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition cursor-pointer"
            >
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

    </div>
  );
}
