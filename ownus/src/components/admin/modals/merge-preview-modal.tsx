'use client';

import React, { useState } from 'react';
import { DuplicatePair, AdminBusinessRecord } from '@/types/admin';
import { X, Check, Merge, ArrowRight, CheckCircle2, ShieldCheck, CopyX, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';

interface MergePreviewModalProps {
  pair: DuplicatePair | null;
  isOpen: boolean;
  onClose: () => void;
  onConfirmMerge: (pairId: string, mergedRecord: AdminBusinessRecord) => void;
}

export function MergePreviewModal({ pair, isOpen, ...rest }: MergePreviewModalProps) {
  if (!isOpen || !pair) return null;
  return <MergePreviewBody pair={pair} {...rest} />;
}

function MergePreviewBody({
  pair,
  onClose,
  onConfirmMerge
}: Omit<MergePreviewModalProps, 'pair' | 'isOpen'> & { pair: DuplicatePair }) {
  const { original, duplicate, confidenceScore, matchReasons, matchingFields } = pair;

  // Selected source for each field ('original' | 'duplicate')
  const [selectedFields, setSelectedFields] = useState<Record<string, 'original' | 'duplicate'>>({
    name: 'original',
    phone: 'original',
    email: original.email ? 'original' : 'duplicate',
    website: original.website ? 'original' : 'duplicate',
    address: 'original',
    state: 'original',
    district: 'original',
    city: 'original',
    pincode: 'original',
    category: 'original',
    industry: 'original',
    description: original.description ? 'original' : 'duplicate',
  });

  const handleToggleSource = (field: string, source: 'original' | 'duplicate') => {
    setSelectedFields(prev => ({ ...prev, [field]: source }));
  };

  const constructMergedRecord = (): AdminBusinessRecord => {
    return {
      ...original,
      name: selectedFields.name === 'original' ? original.name : duplicate.name,
      phone: selectedFields.phone === 'original' ? original.phone : duplicate.phone,
      email: selectedFields.email === 'original' ? original.email : duplicate.email,
      website: selectedFields.website === 'original' ? original.website : duplicate.website,
      address: selectedFields.address === 'original' ? original.address : duplicate.address,
      state: selectedFields.state === 'original' ? original.state : duplicate.state,
      district: selectedFields.district === 'original' ? original.district : duplicate.district,
      city: selectedFields.city === 'original' ? original.city : duplicate.city,
      pincode: selectedFields.pincode === 'original' ? original.pincode : duplicate.pincode,
      category: selectedFields.category === 'original' ? original.category : duplicate.category,
      industry: selectedFields.industry === 'original' ? original.industry : duplicate.industry,
      description: selectedFields.description === 'original' ? original.description : duplicate.description,
      dataQualityScore: Math.max(original.dataQualityScore, duplicate.dataQualityScore),
      validationScore: Math.max(original.validationScore, duplicate.validationScore),
      validationStatus: 'Validated',
      isDuplicate: false,
      updatedAt: new Date().toISOString(),
    };
  };

  const handleConfirm = () => {
    const merged = constructMergedRecord();
    onConfirmMerge(pair.id, merged);
  };

  const fieldList = [
    { key: 'name', label: 'Business Name', orig: original.name, dup: duplicate.name },
    { key: 'phone', label: 'Phone Number', orig: original.phone, dup: duplicate.phone },
    { key: 'email', label: 'Corporate Email', orig: original.email, dup: duplicate.email },
    { key: 'website', label: 'Website URL', orig: original.website, dup: duplicate.website },
    { key: 'address', label: 'Street Address', orig: original.address, dup: duplicate.address },
    { key: 'city', label: 'City & Location', orig: `${original.city}, ${original.state}`, dup: `${duplicate.city}, ${duplicate.state}` },
    { key: 'pincode', label: 'Pincode', orig: original.pincode, dup: duplicate.pincode },
    { key: 'category', label: 'Business Category', orig: original.category, dup: duplicate.category },
    { key: 'description', label: 'Description / Notes', orig: original.description || 'None', dup: duplicate.description || 'None' },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-3 sm:p-6 overflow-y-auto animate-in fade-in-50">
      <div className="bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-2xl w-full max-w-4xl max-h-[92vh] flex flex-col shadow-2xl overflow-hidden text-xs">
        
        {/* Header */}
        <div className="p-5 border-b border-zinc-200 dark:border-zinc-800 flex items-start justify-between gap-4 bg-zinc-50/70 dark:bg-zinc-900/40">
          <div>
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs font-bold text-zinc-400">{pair.id}</span>
              <span className="px-2.5 py-0.5 rounded-full text-xs font-mono font-bold bg-zinc-900 text-white dark:bg-white dark:text-zinc-900">
                {confidenceScore}% Match ({pair.confidenceTier || 'Very High'})
              </span>
            </div>
            <h2 className="text-xl font-bold text-zinc-900 dark:text-zinc-100 mt-1 flex items-center gap-2">
              Side-by-Side Merge Preview
            </h2>
            <p className="text-zinc-500 text-xs mt-0.5">
              Select which attributes to preserve from the master record versus incoming imported data.
            </p>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-900 dark:hover:text-white hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Comparison Header Labels */}
        <div className="grid grid-cols-12 px-6 py-2.5 bg-zinc-100 dark:bg-zinc-900 border-b border-zinc-200 dark:border-zinc-800 font-bold text-[11px] uppercase tracking-wider text-zinc-500">
          <div className="col-span-3">Field</div>
          <div className="col-span-4">Original Record (Master)</div>
          <div className="col-span-1 text-center">Source</div>
          <div className="col-span-4">Imported Candidate</div>
        </div>

        {/* Comparison Rows */}
        <div className="flex-1 overflow-y-auto p-6 space-y-3 divide-y divide-zinc-100 dark:divide-zinc-800">
          {fieldList.map((item) => {
            const isOrigSelected = selectedFields[item.key] === 'original';
            const isIdentical = item.orig === item.dup;

            return (
              <div key={item.key} className="grid grid-cols-12 gap-3 pt-3 items-center">
                {/* Field Name */}
                <div className="col-span-3 font-semibold text-zinc-900 dark:text-zinc-100">
                  {item.label}
                  {isIdentical && (
                    <span className="block text-[10px] text-zinc-400 font-normal font-mono">Exact Match</span>
                  )}
                </div>

                {/* Original Value Option */}
                <div
                  onClick={() => handleToggleSource(item.key, 'original')}
                  className={cn(
                    'col-span-4 p-2.5 rounded-xl border transition-all cursor-pointer text-xs',
                    isOrigSelected
                      ? 'border-zinc-900 dark:border-white bg-zinc-50 dark:bg-zinc-900 font-bold text-zinc-900 dark:text-zinc-100 shadow-xs'
                      : 'border-zinc-200 dark:border-zinc-800 text-zinc-500 hover:border-zinc-400'
                  )}
                >
                  <div className="flex items-center justify-between">
                    <span className="truncate">{item.orig || '[EMPTY]'}</span>
                    {isOrigSelected && <Check className="w-3.5 h-3.5 shrink-0 text-zinc-900 dark:text-white" />}
                  </div>
                </div>

                {/* Source Arrow Indicator */}
                <div className="col-span-1 text-center text-zinc-400 font-mono text-[10px]">
                  {isOrigSelected ? '← KEEP' : 'KEEP →'}
                </div>

                {/* Duplicate Value Option */}
                <div
                  onClick={() => handleToggleSource(item.key, 'duplicate')}
                  className={cn(
                    'col-span-4 p-2.5 rounded-xl border transition-all cursor-pointer text-xs',
                    !isOrigSelected
                      ? 'border-zinc-900 dark:border-white bg-zinc-50 dark:bg-zinc-900 font-bold text-zinc-900 dark:text-zinc-100 shadow-xs'
                      : 'border-zinc-200 dark:border-zinc-800 text-zinc-500 hover:border-zinc-400'
                  )}
                >
                  <div className="flex items-center justify-between">
                    <span className="truncate">{item.dup || '[EMPTY]'}</span>
                    {!isOrigSelected && <Check className="w-3.5 h-3.5 shrink-0 text-zinc-900 dark:text-white" />}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer Actions */}
        <div className="p-4 border-t border-zinc-200 dark:border-zinc-800 bg-zinc-50/80 dark:bg-zinc-900/60 flex items-center justify-between shrink-0">
          <button
            onClick={onClose}
            className="px-4 py-2 text-xs font-semibold rounded-lg text-zinc-600 dark:text-zinc-400 hover:text-zinc-950 dark:hover:text-white transition cursor-pointer"
          >
            Cancel
          </button>

          <button
            onClick={handleConfirm}
            className="px-5 py-2 text-xs font-bold rounded-lg bg-zinc-900 text-white dark:bg-white dark:text-zinc-900 hover:opacity-90 transition shadow-xs flex items-center gap-1.5 cursor-pointer"
          >
            <Merge className="w-4 h-4" />
            Apply Merged Entity
          </button>
        </div>

      </div>
    </div>
  );
}
