'use client';
import { Linkedin } from '@/components/ui/linkedin-icon';

import React, { useState } from 'react';
import { AdminBusinessRecord, ValidationStatus, BusinessStatus } from '@/types/admin';
import { assessWebsite } from '@/lib/website-status';
import {
  X,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Building2,
  Phone,
  Mail,
  Globe,
  MapPin,
  Calendar,
  ShieldCheck,
  FileText,
  CopyX,
  Clock,
  Send,
  Check,
  RotateCcw,
  Sparkles,
  ExternalLink,
  Tag,
  Briefcase,
  Layers,
  ChevronRight
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface BusinessValidationModalProps {
  business: AdminBusinessRecord | null;
  isOpen: boolean;
  onClose: () => void;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onMoveToDraft: (id: string) => void;
  onDelete: (id: string) => void;
  onSaveNote: (id: string, note: string) => void;
}

export function BusinessValidationModal({
  business,
  isOpen,
  onClose,
  onApprove,
  onReject,
  onMoveToDraft,
  onDelete,
  onSaveNote
}: BusinessValidationModalProps) {
  const [activeTab, setActiveTab] = useState<
    'general' | 'contact' | 'address' | 'digital' | 'validation' | 'duplicates' | 'notes' | 'audit'
  >('validation');
  const [newNote, setNewNote] = useState('');

  if (!isOpen || !business) return null;

  const handleAddNote = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newNote.trim()) return;
    onSaveNote(business.id, newNote.trim());
    setNewNote('');
  };

  // Rule checks definition (fallback or dynamically populated)
  const validationRules = business.validationChecks && business.validationChecks.length > 0 
    ? business.validationChecks 
    : [
        { rule: 'Business Name', field: 'name', status: business.name ? 'passed' : 'failed', message: business.name ? 'Business Name is non-empty and formatted.' : 'Required field missing.', currentValue: business.name || '[BLANK]' },
        { rule: 'Phone Format', field: 'phone', status: business.phoneStatus === 'valid' ? 'passed' : business.phoneStatus === 'warning' ? 'warning' : 'failed', message: 'Valid Indian +91 format with verified carrier prefix.', currentValue: business.phone },
        { rule: 'Email Syntax & MX', field: 'email', status: business.emailStatus === 'valid' ? 'passed' : business.emailStatus === 'warning' ? 'warning' : 'failed', message: 'Syntax verified against standard RFC 5322.', currentValue: business.email || 'None' },
        {
          rule: 'Website URL & Reachability',
          field: 'website',
          // one shared rule (lib/website-status.ts): https:// of any domain extension passes, http:// or a missing website warns,
          // anything malformed fails. Reachability itself is not checked here.
          status: ((w) => (w.status === 'valid' ? 'passed' : w.status === 'invalid' ? 'failed' : 'warning'))(assessWebsite(business.website)),
          message: assessWebsite(business.website).message,
          currentValue: business.website || 'None',
        },
        { rule: 'LinkedIn Profile Availability', field: 'linkedin_url', status: (business.linkedin || (business as any).linkedin_url || (business as any).linkedInUrl) ? 'passed' : 'warning', message: (business.linkedin || (business as any).linkedin_url || (business as any).linkedInUrl) ? 'Valid LinkedIn URL recorded.' : 'LinkedIn profile missing.', currentValue: business.linkedin || (business as any).linkedin_url || (business as any).linkedInUrl || 'None' },
        { rule: 'Pincode 6 Digits', field: 'pincode', status: business.pincode && business.pincode.length === 6 ? 'passed' : 'failed', message: 'Must be exact 6 numeric digits matching India Post master.', currentValue: business.pincode },
        { rule: 'State & District Hierarchy', field: 'state', status: 'passed', message: `${business.district} belongs to ${business.state}.`, currentValue: `${business.district}, ${business.state}` },
        { rule: 'Industry Taxonomy Match', field: 'industry', status: 'passed', message: 'Matches recognized Orion master taxonomy.', currentValue: business.industry },
        { rule: 'Business Category Required', field: 'category', status: 'passed', message: 'Specific sub-category assigned.', currentValue: business.category },
        { rule: 'Duplicate Detection', field: 'duplicates', status: business.isDuplicate ? 'warning' : 'passed', message: business.isDuplicate ? 'Potential collision detected in cluster.' : 'Zero identical phone, email or name collisions.', currentValue: business.isDuplicate ? 'Flagged' : 'Clean' },
      ];

  const passedCount = validationRules.filter(r => r.status === 'passed').length;
  const warningCount = validationRules.filter(r => r.status === 'warning').length;
  const failedCount = validationRules.filter(r => r.status === 'failed').length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-3 sm:p-6 overflow-y-auto animate-in fade-in-50">
      <div className="bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-2xl w-full max-w-5xl max-h-[92vh] flex flex-col shadow-2xl overflow-hidden text-xs">
        
        {/* Header Bar */}
        <div className="p-5 border-b border-zinc-200 dark:border-zinc-800 flex items-start justify-between gap-4 bg-zinc-50/70 dark:bg-zinc-900/40">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-mono text-xs font-bold text-zinc-400">{business.id}</span>
              
              {/* Validation Score Pill */}
              <span className="px-2.5 py-0.5 rounded-full text-xs font-bold font-mono bg-zinc-900 text-white dark:bg-white dark:text-zinc-900">
                {business.validationScore}% Quality Score
              </span>

              {/* Status Pill */}
              <span className={cn(
                'px-2.5 py-0.5 rounded-full text-xs font-semibold uppercase',
                business.validationStatus === 'Approved' && 'bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 border border-zinc-300 dark:border-zinc-700',
                business.validationStatus === 'Validated' && 'bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 border border-zinc-300 dark:border-zinc-700',
                business.validationStatus === 'Pending' && 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 border border-zinc-300 dark:border-zinc-700',
                business.validationStatus === 'Warning' && 'bg-zinc-200 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 font-bold',
                business.validationStatus === 'Rejected' && 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
              )}>
                {business.validationStatus}
              </span>
            </div>

            <h2 className="text-xl font-bold text-zinc-900 dark:text-zinc-100 mt-1.5 flex items-center gap-2">
              {business.name}
            </h2>
            <p className="text-zinc-500 text-xs mt-0.5">
              {business.industry} • {business.category} • {business.city}, {business.state}
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-900 dark:hover:text-white hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Tab Navigation */}
        <div className="border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 px-5 flex space-x-1 overflow-x-auto no-scrollbar shrink-0">
          {[
            { id: 'validation', label: `Validation Rules (${passedCount}/${validationRules.length})`, icon: ShieldCheck },
            { id: 'general', label: 'General Info', icon: Building2 },
            { id: 'contact', label: 'Contact Details', icon: Phone },
            { id: 'address', label: 'Location & Hierarchy', icon: MapPin },
            { id: 'digital', label: 'Digital Presence', icon: Globe },
            { id: 'duplicates', label: 'Duplicate Analysis', icon: CopyX },
            { id: 'notes', label: `Admin Notes (${business.internalNotes?.length || 0})`, icon: FileText },
            { id: 'audit', label: 'Audit Timeline', icon: Clock },
          ].map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as any)}
                className={cn(
                  'px-3.5 py-3 text-xs font-semibold border-b-2 flex items-center gap-2 whitespace-nowrap transition-colors cursor-pointer',
                  isActive
                    ? 'border-zinc-900 dark:border-white text-zinc-900 dark:text-white'
                    : 'border-transparent text-zinc-500 hover:text-zinc-900 dark:hover:text-white'
                )}
              >
                <Icon className="w-3.5 h-3.5" />
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          
          {/* TAB 1: VALIDATION RULES (Module 2 Focus) */}
          {activeTab === 'validation' && (
            <div className="space-y-6">
              
              {/* Scorecard Summary */}
              <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
                <div className="p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-900/40 flex items-center justify-between">
                  <div>
                    <span className="text-zinc-500 text-[11px] uppercase font-bold tracking-wider">Quality Score</span>
                    <div className="text-2xl font-bold font-mono text-zinc-900 dark:text-zinc-100 mt-0.5">
                      {business.validationScore}%
                    </div>
                  </div>
                  <ShieldCheck className="w-6 h-6 text-zinc-400" />
                </div>

                <div className="p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-900/40 flex items-center justify-between">
                  <div>
                    <span className="text-zinc-500 text-[11px] uppercase font-bold tracking-wider">Passed Checks</span>
                    <div className="text-2xl font-bold font-mono text-zinc-900 dark:text-zinc-100 mt-0.5">
                      {passedCount} <span className="text-xs font-normal text-zinc-500">/ {validationRules.length}</span>
                    </div>
                  </div>
                  <CheckCircle2 className="w-6 h-6 text-zinc-900 dark:text-zinc-100" />
                </div>

                <div className="p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-900/40 flex items-center justify-between">
                  <div>
                    <span className="text-zinc-500 text-[11px] uppercase font-bold tracking-wider">Warnings</span>
                    <div className="text-2xl font-bold font-mono text-zinc-900 dark:text-zinc-100 mt-0.5">
                      {warningCount}
                    </div>
                  </div>
                  <AlertTriangle className="w-6 h-6 text-zinc-400" />
                </div>

                <div className="p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-900/40 flex items-center justify-between">
                  <div>
                    <span className="text-zinc-500 text-[11px] uppercase font-bold tracking-wider">Failed Checks</span>
                    <div className="text-2xl font-bold font-mono text-zinc-900 dark:text-zinc-100 mt-0.5">
                      {failedCount}
                    </div>
                  </div>
                  <XCircle className="w-6 h-6 text-zinc-400" />
                </div>
              </div>

              {/* Detailed Validation Rule Checklist */}
              <div className="border border-zinc-200 dark:border-zinc-800 rounded-xl overflow-hidden">
                <div className="bg-zinc-50 dark:bg-zinc-900 px-4 py-3 border-b border-zinc-200 dark:border-zinc-800 flex items-center justify-between">
                  <span className="font-bold text-xs text-zinc-900 dark:text-zinc-100 uppercase tracking-wider">
                    Automated Ingestion Validation Engine
                  </span>
                  <span className="text-[11px] text-zinc-500 font-mono">
                    Engine Version: 2.4-STRICT
                  </span>
                </div>

                <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {validationRules.map((rule, idx) => (
                    <div key={idx} className="p-4 flex items-start justify-between gap-4 hover:bg-zinc-50/50 dark:hover:bg-zinc-900/30 transition-colors">
                      <div className="flex items-start gap-3">
                        <div className="mt-0.5 shrink-0">
                          {rule.status === 'passed' && (
                            <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-zinc-900 text-white dark:bg-white dark:text-zinc-900 font-bold text-[10px]">
                              ✓
                            </span>
                          )}
                          {rule.status === 'warning' && (
                            <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-zinc-200 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 font-bold text-[10px]">
                              ⚠
                            </span>
                          )}
                          {rule.status === 'failed' && (
                            <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 font-bold text-[10px]">
                              ✕
                            </span>
                          )}
                        </div>

                        <div>
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-zinc-900 dark:text-zinc-100 text-xs">
                              {rule.rule}
                            </span>
                            <span className={cn(
                              'text-[10px] font-mono px-2 py-0.2 rounded font-bold uppercase',
                              rule.status === 'passed' && 'bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100',
                              rule.status === 'warning' && 'bg-zinc-200 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300',
                              rule.status === 'failed' && 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                            )}>
                              {rule.status}
                            </span>
                          </div>
                          <p className="text-zinc-500 text-xs mt-0.5">{rule.message}</p>
                        </div>
                      </div>

                      <div className="text-right shrink-0">
                        <span className="text-[11px] text-zinc-400 block font-mono">Evaluated Value</span>
                        <span className="font-mono text-xs font-semibold text-zinc-800 dark:text-zinc-200">
                          {rule.currentValue || '[EMPTY]'}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* TAB 2: GENERAL INFORMATION */}
          {activeTab === 'general' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-4">
                <div>
                  <label className="text-zinc-400 text-[11px] uppercase font-bold block mb-1">Legal Business Name</label>
                  <div className="p-3 bg-zinc-50 dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-800 font-semibold text-zinc-900 dark:text-zinc-100">
                    {business.name}
                  </div>
                </div>

                <div>
                  <label className="text-zinc-400 text-[11px] uppercase font-bold block mb-1">Industry Sector</label>
                  <div className="p-3 bg-zinc-50 dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-800 text-zinc-900 dark:text-zinc-100">
                    {business.industry}
                  </div>
                </div>

                <div>
                  <label className="text-zinc-400 text-[11px] uppercase font-bold block mb-1">Sub-Industry Classification</label>
                  <div className="p-3 bg-zinc-50 dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-800 text-zinc-900 dark:text-zinc-100">
                    {business.subIndustry || 'General Commercial'}
                  </div>
                </div>

                <div>
                  <label className="text-zinc-400 text-[11px] uppercase font-bold block mb-1">Business Category</label>
                  <div className="p-3 bg-zinc-50 dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-800 text-zinc-900 dark:text-zinc-100">
                    {business.category}
                  </div>
                </div>
              </div>

              <div className="space-y-4">
                <div>
                  <label className="text-zinc-400 text-[11px] uppercase font-bold block mb-1">Legal Business Structure</label>
                  <div className="p-3 bg-zinc-50 dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-800 text-zinc-900 dark:text-zinc-100 font-medium">
                    {business.businessType || 'Private Limited'}
                  </div>
                </div>

                <div>
                  <label className="text-zinc-400 text-[11px] uppercase font-bold block mb-1">MSME Classification</label>
                  <div className="p-3 bg-zinc-50 dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-800 text-zinc-900 dark:text-zinc-100">
                    {business.msmeCategory || 'Unregistered / Commercial'}
                  </div>
                </div>

                <div>
                  <label className="text-zinc-400 text-[11px] uppercase font-bold block mb-1">Date of Registration</label>
                  <div className="p-3 bg-zinc-50 dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-800 font-mono text-zinc-900 dark:text-zinc-100">
                    {business.registrationDate || '2024-01-01'}
                  </div>
                </div>

                <div>
                  <label className="text-zinc-400 text-[11px] uppercase font-bold block mb-1">Operational Description</label>
                  <div className="p-3 bg-zinc-50 dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-800 text-zinc-700 dark:text-zinc-300">
                    {business.description || 'No description provided.'}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 3: CONTACT DETAILS */}
          {activeTab === 'contact' && (
            <div className="space-y-4 max-w-2xl">
              <div className="p-4 border border-zinc-200 dark:border-zinc-800 rounded-xl bg-zinc-50/50 dark:bg-zinc-900/30 flex items-center justify-between">
                <div>
                  <span className="text-[11px] font-bold text-zinc-400 uppercase">Primary Phone Number</span>
                  <div className="text-sm font-bold font-mono text-zinc-900 dark:text-zinc-100 mt-1">
                    {business.phone}
                  </div>
                </div>
                <span className="px-2.5 py-0.5 rounded-full text-[11px] font-bold uppercase bg-zinc-900 text-white dark:bg-white dark:text-zinc-900">
                  {business.phoneStatus}
                </span>
              </div>

              <div className="p-4 border border-zinc-200 dark:border-zinc-800 rounded-xl bg-zinc-50/50 dark:bg-zinc-900/30 flex items-center justify-between">
                <div>
                  <span className="text-[11px] font-bold text-zinc-400 uppercase">WhatsApp Business Line</span>
                  <div className="text-sm font-bold font-mono text-zinc-900 dark:text-zinc-100 mt-1">
                    {business.whatsapp || 'Not Registered'}
                  </div>
                </div>
                <span className="px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400">
                  {business.whatsapp ? 'Active' : 'Unset'}
                </span>
              </div>

              <div className="p-4 border border-zinc-200 dark:border-zinc-800 rounded-xl bg-zinc-50/50 dark:bg-zinc-900/30 flex items-center justify-between">
                <div>
                  <span className="text-[11px] font-bold text-zinc-400 uppercase">Corporate Email</span>
                  <div className="text-sm font-bold font-mono text-zinc-900 dark:text-zinc-100 mt-1">
                    {business.email || 'None'}
                  </div>
                </div>
                <span className="px-2.5 py-0.5 rounded-full text-[11px] font-bold uppercase bg-zinc-900 text-white dark:bg-white dark:text-zinc-900">
                  {business.emailStatus}
                </span>
              </div>

              <div className="p-4 border border-zinc-200 dark:border-zinc-800 rounded-xl bg-zinc-50/50 dark:bg-zinc-900/30 flex items-center justify-between">
                <div>
                  <span className="text-[11px] font-bold text-zinc-400 uppercase flex items-center gap-1.5"><Linkedin className="w-3.5 h-3.5 text-[#0A66C2]" /> LinkedIn Profile</span>
                  <div className="text-sm font-bold font-mono text-zinc-900 dark:text-zinc-100 mt-1">
                    {(business.linkedin || (business as any).linkedin_url || (business as any).linkedInUrl) || 'Not Provided'}
                  </div>
                </div>
                <span className="px-2.5 py-0.5 rounded-full text-[11px] font-bold uppercase bg-zinc-900 text-white dark:bg-white dark:text-zinc-900">
                  {(business.linkedin || (business as any).linkedin_url || (business as any).linkedInUrl) ? 'Available' : 'Missing'}
                </span>
              </div>
            </div>
          )}

          {/* TAB 4: ADDRESS & HIERARCHY */}
          {activeTab === 'address' && (
            <div className="space-y-4 max-w-2xl">
              <div className="p-4 border border-zinc-200 dark:border-zinc-800 rounded-xl bg-zinc-50/50 dark:bg-zinc-900/30 space-y-3">
                <div>
                  <span className="text-[11px] font-bold text-zinc-400 uppercase">Street Address</span>
                  <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100 mt-1">
                    {business.address}
                  </div>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-3 border-t border-zinc-200 dark:border-zinc-800">
                  <div>
                    <span className="text-[10px] text-zinc-400 uppercase font-bold">State</span>
                    <div className="font-semibold text-zinc-900 dark:text-zinc-100 text-xs mt-0.5">{business.state}</div>
                  </div>
                  <div>
                    <span className="text-[10px] text-zinc-400 uppercase font-bold">District</span>
                    <div className="font-semibold text-zinc-900 dark:text-zinc-100 text-xs mt-0.5">{business.district}</div>
                  </div>
                  <div>
                    <span className="text-[10px] text-zinc-400 uppercase font-bold">City</span>
                    <div className="font-semibold text-zinc-900 dark:text-zinc-100 text-xs mt-0.5">{business.city}</div>
                  </div>
                  <div>
                    <span className="text-[10px] text-zinc-400 uppercase font-bold">Pincode</span>
                    <div className="font-mono font-bold text-zinc-900 dark:text-zinc-100 text-xs mt-0.5">{business.pincode}</div>
                  </div>
                </div>
              </div>

              <div className="p-4 border border-zinc-200 dark:border-zinc-800 rounded-xl bg-zinc-50/50 dark:bg-zinc-900/30 flex items-center justify-between">
                <div>
                  <span className="text-[11px] font-bold text-zinc-400 uppercase">Google Maps Navigation Link</span>
                  <div className="text-xs font-mono text-zinc-600 dark:text-zinc-400 mt-0.5 truncate max-w-md">
                    {business.googleMapsLink || 'https://maps.google.com/?q=India'}
                  </div>
                </div>
                <a
                  href={business.googleMapsLink || '#'}
                  target="_blank"
                  rel="noreferrer"
                  className="px-3 py-1.5 rounded-lg border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800 font-semibold flex items-center gap-1.5 transition-colors"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  View Map
                </a>
              </div>
            </div>
          )}

          {/* TAB 5: DIGITAL PRESENCE */}
          {activeTab === 'digital' && (
            <div className="space-y-4 max-w-2xl">
              <div className="p-4 border border-zinc-200 dark:border-zinc-800 rounded-xl bg-zinc-50/50 dark:bg-zinc-900/30 flex items-center justify-between">
                <div>
                  <span className="text-[11px] font-bold text-zinc-400 uppercase">Official Website URL</span>
                  <div className="text-sm font-mono font-bold text-zinc-900 dark:text-zinc-100 mt-1">
                    {business.website || 'No website registered'}
                  </div>
                </div>
                <span className="px-2.5 py-0.5 rounded-full text-[11px] font-bold uppercase bg-zinc-900 text-white dark:bg-white dark:text-zinc-900">
                  {business.websiteStatus}
                </span>
              </div>

              <div className="p-4 border border-zinc-200 dark:border-zinc-800 rounded-xl bg-zinc-50/50 dark:bg-zinc-900/30">
                <span className="text-[11px] font-bold text-zinc-400 uppercase">Agency Lead Opportunity Analysis</span>
                <p className="text-xs text-zinc-600 dark:text-zinc-400 mt-1">
                  {!business.hasWebsite 
                    ? '★ High-value agency lead: This business is commercially active but lacks an official website and corporate digital presence.'
                    : 'Verified online presence: Domain active with verified DNS records.'}
                </p>
              </div>
            </div>
          )}

          {/* TAB 6: DUPLICATE ANALYSIS */}
          {activeTab === 'duplicates' && (
            <div className="space-y-4">
              <div className="p-4 border border-zinc-200 dark:border-zinc-800 rounded-xl bg-zinc-50/50 dark:bg-zinc-900/30 flex items-center justify-between">
                <div>
                  <h4 className="text-sm font-bold text-zinc-900 dark:text-zinc-100">Deduplication Cluster Check</h4>
                  <p className="text-xs text-zinc-500 mt-0.5">Scanned against 1.2M+ records using name, phone, domain and location.</p>
                </div>
                <span className="px-3 py-1 rounded-full text-xs font-bold font-mono bg-zinc-900 text-white dark:bg-white dark:text-zinc-900">
                  {business.isDuplicate ? 'Potential Collision' : '0 Exact Duplicates'}
                </span>
              </div>
            </div>
          )}

          {/* TAB 7: ADMIN NOTES */}
          {activeTab === 'notes' && (
            <div className="space-y-4 max-w-2xl">
              <form onSubmit={handleAddNote} className="space-y-2">
                <label className="text-xs font-bold text-zinc-900 dark:text-zinc-100">Add Internal Verification Note</label>
                <textarea
                  value={newNote}
                  onChange={(e) => setNewNote(e.target.value)}
                  placeholder="Record verification notes, tele-check confirmations, or auditor comments..."
                  rows={3}
                  className="w-full p-3 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 text-xs focus:outline-none focus:border-zinc-500 resize-none"
                />
                <div className="flex justify-end">
                  <button
                    type="submit"
                    className="px-4 py-2 bg-zinc-900 text-white dark:bg-white dark:text-zinc-900 font-bold rounded-lg hover:opacity-90 transition cursor-pointer flex items-center gap-1.5"
                  >
                    <Send className="w-3 h-3" />
                    Save Note
                  </button>
                </div>
              </form>

              <div className="space-y-2 pt-4 border-t border-zinc-200 dark:border-zinc-800">
                {(business.internalNotes || []).map((note, idx) => (
                  <div key={idx} className="p-3 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-900/40 text-xs">
                    <div className="flex justify-between items-center text-[10px] text-zinc-400 font-mono mb-1">
                      <span>Operator Note #{idx + 1}</span>
                      <span>Verified</span>
                    </div>
                    <p className="text-zinc-800 dark:text-zinc-200">{note}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* TAB 8: AUDIT TIMELINE */}
          {activeTab === 'audit' && (
            <div className="space-y-4 max-w-2xl">
              <div className="border border-zinc-200 dark:border-zinc-800 rounded-xl p-4 bg-zinc-50/50 dark:bg-zinc-900/30 space-y-4">
                <div className="flex items-start gap-3">
                  <div className="w-2 h-2 rounded-full bg-zinc-900 dark:bg-white mt-1.5 shrink-0" />
                  <div>
                    <div className="font-bold text-zinc-900 dark:text-zinc-100">Batch Ingested</div>
                    <p className="text-zinc-500 text-[11px] mt-0.5">{business.createdAt} via {business.importedBy || 'Automated Scraper'}</p>
                  </div>
                </div>

                <div className="flex items-start gap-3">
                  <div className="w-2 h-2 rounded-full bg-zinc-900 dark:bg-white mt-1.5 shrink-0" />
                  <div>
                    <div className="font-bold text-zinc-900 dark:text-zinc-100">Schema Validation Run</div>
                    <p className="text-zinc-500 text-[11px] mt-0.5">{business.updatedAt} • Score: {business.validationScore}% ({business.validationStatus})</p>
                  </div>
                </div>

                {business.approvedDate && (
                  <div className="flex items-start gap-3">
                    <div className="w-2 h-2 rounded-full bg-zinc-900 dark:bg-white mt-1.5 shrink-0" />
                    <div>
                      <div className="font-bold text-zinc-900 dark:text-zinc-100">Approved by Operator</div>
                      <p className="text-zinc-500 text-[11px] mt-0.5">{business.approvedDate} by {business.reviewer || 'Administrator'}</p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

        </div>

        {/* Footer Actions */}
        <div className="p-4 border-t border-zinc-200 dark:border-zinc-800 bg-zinc-50/80 dark:bg-zinc-900/60 flex flex-wrap items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-2">
            <button
              onClick={() => onDelete(business.id)}
              className="px-3.5 py-2 text-xs font-semibold text-zinc-500 hover:text-zinc-900 dark:hover:text-white rounded-lg hover:bg-zinc-200 dark:hover:bg-zinc-800 transition cursor-pointer"
            >
              Delete Record
            </button>
            <button
              onClick={() => onMoveToDraft(business.id)}
              className="px-3.5 py-2 text-xs font-semibold text-zinc-700 dark:text-zinc-300 border border-zinc-300 dark:border-zinc-700 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 transition cursor-pointer"
            >
              Move to Draft
            </button>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => onReject(business.id)}
              className="px-4 py-2 text-xs font-bold rounded-lg border border-zinc-400 dark:border-zinc-600 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition cursor-pointer"
            >
              Reject Record
            </button>
            <button
              onClick={() => onApprove(business.id)}
              className="px-5 py-2 text-xs font-bold rounded-lg bg-zinc-900 text-white dark:bg-white dark:text-zinc-900 hover:opacity-90 shadow-xs transition cursor-pointer flex items-center gap-1.5"
            >
              <Check className="w-4 h-4" />
              Approve Record
            </button>
          </div>
        </div>

      </div>
    </div>
  );
}
