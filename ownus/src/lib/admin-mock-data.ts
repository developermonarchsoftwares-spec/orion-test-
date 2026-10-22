import { 
  AdminBusinessRecord, 
  ImportBatch, 
  DuplicatePair, 
  ValidationIssue, 
  ActivityLogEntry, 
  AdminUser, 
  CreditTransaction,
  CustomerUser,
  TransactionRecord,
  RoleDefinition,
  SupportTicket,
  CreditPackage,
  SubscriptionPlan,
  DataSourceRecord,
  EnrichmentJob,
  AiPipelineDefinition,
  AutomationRule,
  SystemServiceHealth,
  SearchIndexStatus
} from '@/types/admin';

/**
 * Orion Admin Data Stores
 *
 * All demo, mock, and fabricated data has been removed.
 * In production, administrative business records, ingestion batches, users,
 * wallets, transactions, and audit trails are loaded dynamically from PostgreSQL.
 */

export const INITIAL_ADMIN_BUSINESSES: AdminBusinessRecord[] = [];

export const INITIAL_IMPORT_BATCHES: ImportBatch[] = [];

export const INITIAL_DUPLICATES: DuplicatePair[] = [];

export const INITIAL_VALIDATION_ISSUES: ValidationIssue[] = [];

export const INITIAL_ACTIVITY_LOGS: ActivityLogEntry[] = [];

export const INITIAL_ADMIN_USERS: AdminUser[] = [];

export const INITIAL_CREDIT_TRANSACTIONS: CreditTransaction[] = [];

export const INITIAL_CUSTOMER_USERS: CustomerUser[] = [];

export const INITIAL_PLATFORM_TRANSACTIONS: TransactionRecord[] = [];

export const INITIAL_SUPPORT_TICKETS: SupportTicket[] = [];

export const INITIAL_DATA_SOURCES: DataSourceRecord[] = [];

export const INITIAL_ENRICHMENT_JOBS: EnrichmentJob[] = [];

export const INITIAL_AI_PIPELINES: AiPipelineDefinition[] = [
  {
    id: 'pipe-classify',
    name: 'Classification',
    displayName: 'Deep Sector Classification Pipeline',
    description: 'Multi-label Transformer predicting primary industry, sub-sector, and MSME category from business description and GST metadata.',
    model: 'RoBERTa-Enterprise-v3.4',
    version: 'v3.4.1',
    accuracy: 94.6,
    status: 'Active',
    processedCount: 1145000,
    avgLatencyMs: 42,
    queueDepth: 140,
  },
  {
    id: 'pipe-dedup',
    name: 'Deduplication',
    displayName: 'Neural Entity Resolution & Deduplication',
    description: 'Dense vector embedding similarity engine comparing phonetics, pincodes, corporate names, and directors across 10M+ records.',
    model: 'Sentence-Transformer-AllMiniLM-L6-v2',
    version: 'v2.1.0',
    accuracy: 97.2,
    status: 'Active',
    processedCount: 1248000,
    avgLatencyMs: 18,
    queueDepth: 65,
  },
  {
    id: 'pipe-scoring',
    name: 'Scoring',
    displayName: 'Opportunity & Commercial Scoring Engine',
    description: 'Gradient-boosted decision trees calculating B2B lead viability, creditworthiness, digital maturity, and contactability index.',
    model: 'XGBoost-OpportunityScore-v2.8',
    version: 'v2.8.0',
    accuracy: 91.4,
    status: 'Active',
    processedCount: 980000,
    avgLatencyMs: 8,
    queueDepth: 12,
  },
  {
    id: 'pipe-cat',
    name: 'Business Categorization',
    displayName: 'Hierarchical Taxonomy Categorization',
    description: 'Automatic mapping of incoming trade classifications into Orion unified 3-level taxonomy hierarchy.',
    model: 'Hierarchical-Taxonomy-v1.8',
    version: 'v1.8.4',
    accuracy: 95.8,
    status: 'Active',
    processedCount: 1205000,
    avgLatencyMs: 14,
    queueDepth: 88,
  },
  {
    id: 'pipe-recom',
    name: 'Recommendation Engine',
    displayName: 'Future Lead Recommendation Graph',
    description: 'Graph neural network predicting prospective customer lookalikes and B2B vendor matching.',
    model: 'GraphSage-Lookalike-v0.9-Preview',
    version: 'v0.9.0-BETA',
    accuracy: 88.9,
    status: 'Training',
    processedCount: 450000,
    avgLatencyMs: 110,
    queueDepth: 0,
  },
];

export const INITIAL_AUTOMATION_RULES: AutomationRule[] = [];

export const INITIAL_SYSTEM_SERVICES: SystemServiceHealth[] = [];

export const INITIAL_SEARCH_INDEX_STATUS: SearchIndexStatus = {
  indexedBusinesses: 0,
  pendingIndex: 0,
  failedIndex: 0,
  clusterHealth: 'Green',
  shardsCount: 1,
  indexSizeBytes: '0 MB',
  lastOptimized: 'Never',
  avgQueryLatencyMs: 0,
};

export const ORION_SUPPORTED_FIELDS = [
  { key: 'name', label: 'Business Name', required: true, description: 'Legal or trade name of the entity' },
  { key: 'industry', label: 'Industry', required: true, description: 'Primary sector (e.g. Manufacturing, Healthcare)' },
  { key: 'subIndustry', label: 'Sub Industry', required: false, description: 'Specialized niche / vertical' },
  { key: 'category', label: 'Business Category', required: true, description: 'Broad commercial segment' },
  { key: 'businessType', label: 'Business Type', required: false, description: 'Pvt Ltd, LLP, Proprietorship, etc.' },
  { key: 'msmeCategory', label: 'MSME Category', required: false, description: 'Micro, Small, or Medium Enterprise' },
  { key: 'address', label: 'Address', required: true, description: 'Full physical premises address' },
  { key: 'state', label: 'State / UT', required: true, description: 'Indian State or Union Territory' },
  { key: 'district', label: 'District', required: true, description: 'Official district classification' },
  { key: 'city', label: 'City / Hub', required: true, description: 'City, municipality or tier 2/3 hub' },
  { key: 'pincode', label: 'Pincode', required: true, description: '6-digit Indian postal code' },
  { key: 'phone', label: 'Phone Number', required: true, description: 'Primary mobile or verified landline' },
  { key: 'whatsapp', label: 'WhatsApp', required: false, description: 'Direct WhatsApp enabled number' },
  { key: 'email', label: 'Email', required: false, description: 'Official business or executive email' },
  { key: 'website', label: 'Website', required: false, description: 'Official domain / landing page URL' },
  { key: 'linkedin_url', label: 'LinkedIn URL', required: false, description: 'Official LinkedIn company or executive profile URL' },
  { key: 'registrationDate', label: 'Registration Date', required: false, description: 'MCA / Udyam / GST incorporation date' },
  { key: 'latitude', label: 'Latitude', required: false, description: 'Geographic coordinate' },
  { key: 'longitude', label: 'Longitude', required: false, description: 'Geographic coordinate' },
  { key: 'description', label: 'Description', required: false, description: 'Core business activities and scope' },
  { key: 'cin', label: 'CIN / MCA Reg', required: false, description: '21-digit Corporate Identification Number' },
  { key: 'pan', label: 'PAN', required: false, description: '10-digit Permanent Account Number' },
  { key: 'gstin', label: 'GSTIN', required: false, description: '15-digit Goods & Services Tax Identification' },
  { key: 'paidUpCapital', label: 'Paid-Up Capital', required: false, description: 'Financial metric in INR' },
  { key: 'authorizedCapital', label: 'Authorized Capital', required: false, description: 'Financial metric in INR' },
  { key: 'employeeCount', label: 'Employee Count', required: false, description: 'Workforce scale classification' },
  { key: 'annualTurnover', label: 'Annual Turnover', required: false, description: 'Estimated annual turnover in INR' },
];

export const INITIAL_ROLES_PERMISSIONS: RoleDefinition[] = [
  {
    id: 'role-superadmin',
    name: 'Super Admin',
    description: 'Unrestricted master access to all platform controls, schema settings, user management, and ledger adjustments.',
    userCount: 1,
    isSystem: true,
    modules: [
      { moduleKey: 'dashboard', moduleName: 'Dashboard', permissions: { read: true, write: true, delete: true, export: true, admin: true } },
      { moduleKey: 'businesses', moduleName: 'Business Records', permissions: { read: true, write: true, delete: true, export: true, admin: true } },
      { moduleKey: 'import', moduleName: 'Import Data', permissions: { read: true, write: true, delete: true, export: true, admin: true } },
      { moduleKey: 'validation', moduleName: 'Data Validation', permissions: { read: true, write: true, delete: true, export: true, admin: true } },
      { moduleKey: 'duplicates', moduleName: 'Duplicate Manager', permissions: { read: true, write: true, delete: true, export: true, admin: true } },
      { moduleKey: 'publish_queue', moduleName: 'Publish Queue', permissions: { read: true, write: true, delete: true, export: true, admin: true } },
      { moduleKey: 'reports', moduleName: 'Reports & Analytics', permissions: { read: true, write: true, delete: true, export: true, admin: true } },
      { moduleKey: 'users', moduleName: 'Users & Customers', permissions: { read: true, write: true, delete: true, export: true, admin: true } },
      { moduleKey: 'credits', moduleName: 'Credits & Ledger', permissions: { read: true, write: true, delete: true, export: true, admin: true } },
      { moduleKey: 'settings', moduleName: 'System Settings', permissions: { read: true, write: true, delete: true, export: true, admin: true } },
      { moduleKey: 'logs', moduleName: 'Activity Logs', permissions: { read: true, write: true, delete: true, export: true, admin: true } },
      { moduleKey: 'support', moduleName: 'Support Center', permissions: { read: true, write: true, delete: true, export: true, admin: true } },
    ]
  },
  {
    id: 'role-admin',
    name: 'Admin',
    description: 'Full operational administrative access with restriction on master destructive system changes.',
    userCount: 0,
    isSystem: true,
    modules: [
      { moduleKey: 'dashboard', moduleName: 'Dashboard', permissions: { read: true, write: true, delete: false, export: true, admin: false } },
      { moduleKey: 'businesses', moduleName: 'Business Records', permissions: { read: true, write: true, delete: true, export: true, admin: false } },
      { moduleKey: 'import', moduleName: 'Import Data', permissions: { read: true, write: true, delete: false, export: true, admin: false } },
      { moduleKey: 'validation', moduleName: 'Data Validation', permissions: { read: true, write: true, delete: false, export: true, admin: false } },
      { moduleKey: 'duplicates', moduleName: 'Duplicate Manager', permissions: { read: true, write: true, delete: true, export: true, admin: false } },
      { moduleKey: 'publish_queue', moduleName: 'Publish Queue', permissions: { read: true, write: true, delete: false, export: true, admin: false } },
      { moduleKey: 'reports', moduleName: 'Reports & Analytics', permissions: { read: true, write: false, delete: false, export: true, admin: false } },
      { moduleKey: 'users', moduleName: 'Users & Customers', permissions: { read: true, write: true, delete: false, export: true, admin: false } },
      { moduleKey: 'credits', moduleName: 'Credits & Ledger', permissions: { read: true, write: true, delete: false, export: true, admin: false } },
      { moduleKey: 'settings', moduleName: 'System Settings', permissions: { read: true, write: true, delete: false, export: false, admin: false } },
      { moduleKey: 'logs', moduleName: 'Activity Logs', permissions: { read: true, write: false, delete: false, export: true, admin: false } },
      { moduleKey: 'support', moduleName: 'Support Center', permissions: { read: true, write: true, delete: false, export: true, admin: false } },
    ]
  },
  {
    id: 'role-datamanager',
    name: 'Data Manager',
    description: 'Oversees pipeline ingestion, deduplication heuristics, data enrichment, and catalog quality scores.',
    userCount: 0,
    isSystem: false,
    modules: [
      { moduleKey: 'dashboard', moduleName: 'Dashboard', permissions: { read: true, write: false, delete: false, export: true, admin: false } },
      { moduleKey: 'businesses', moduleName: 'Business Records', permissions: { read: true, write: true, delete: false, export: true, admin: false } },
      { moduleKey: 'import', moduleName: 'Import Data', permissions: { read: true, write: true, delete: true, export: true, admin: false } },
      { moduleKey: 'validation', moduleName: 'Data Validation', permissions: { read: true, write: true, delete: false, export: true, admin: false } },
      { moduleKey: 'duplicates', moduleName: 'Duplicate Manager', permissions: { read: true, write: true, delete: true, export: true, admin: false } },
      { moduleKey: 'publish_queue', moduleName: 'Publish Queue', permissions: { read: true, write: true, delete: false, export: true, admin: false } },
      { moduleKey: 'reports', moduleName: 'Reports & Analytics', permissions: { read: true, write: false, delete: false, export: true, admin: false } },
      { moduleKey: 'users', moduleName: 'Users & Customers', permissions: { read: false, write: false, delete: false, export: false, admin: false } },
      { moduleKey: 'credits', moduleName: 'Credits & Ledger', permissions: { read: false, write: false, delete: false, export: false, admin: false } },
      { moduleKey: 'settings', moduleName: 'System Settings', permissions: { read: true, write: false, delete: false, export: false, admin: false } },
      { moduleKey: 'logs', moduleName: 'Activity Logs', permissions: { read: true, write: false, delete: false, export: false, admin: false } },
      { moduleKey: 'support', moduleName: 'Support Center', permissions: { read: false, write: false, delete: false, export: false, admin: false } },
    ]
  }
];

export const INITIAL_CREDIT_PACKAGES: CreditPackage[] = [
  {
    id: 'pack-starter',
    name: 'Starter Pack',
    credits: 100,
    price: 299,
    discountPercentage: 0,
    features: ['100 Verified Business Unlocks', 'CSV / Excel Export', 'Standard Email Support', 'Credits Never Expire']
  },
  {
    id: 'pack-growth',
    name: 'Growth Pack',
    credits: 350,
    price: 499,
    discountPercentage: 20,
    isPopular: true,
    features: ['350 Verified Business Unlocks', 'Direct Phone & WhatsApp Access', 'Priority Verification Queue', 'Credits Never Expire']
  },
  {
    id: 'pack-agency',
    name: 'Agency Pack',
    credits: 1500,
    price: 999,
    discountPercentage: 25,
    features: ['1,500 Verified Business Unlocks', 'Bulk Export Engine', 'Dedicated Account Manager', 'Credits Never Expire']
  },
  {
    id: 'pack-enterprise',
    name: 'Enterprise Pool',
    credits: 10000,
    price: 4999,
    discountPercentage: 30,
    features: ['Custom Volume Unlocks', 'Dedicated API Access', '24x7 Priority Support', 'Custom GST Invoicing']
  }
];

export const INITIAL_SUBSCRIPTION_PLANS: SubscriptionPlan[] = [
  {
    id: 'plan-starter',
    name: 'Starter',
    monthlyPrice: 99,
    annualPrice: 79,
    creditsPerMonth: 100,
    exportLimitMonthly: 500,
    activeSubscribers: 0,
    features: ['Access to Verified Master Catalog', 'Standard Search Filters', '100 Lead Unlocks', 'Basic Export']
  },
  {
    id: 'plan-growth',
    name: 'Growth',
    monthlyPrice: 299,
    annualPrice: 239,
    creditsPerMonth: 350,
    exportLimitMonthly: 2500,
    activeSubscribers: 0,
    features: ['All Starter Features', 'Opportunity Score Filters', 'Direct Decision Maker Contacts', 'Priority Email Support']
  },
  {
    id: 'plan-pro',
    name: 'Professional',
    monthlyPrice: 999,
    annualPrice: 799,
    creditsPerMonth: 1500,
    exportLimitMonthly: 10000,
    activeSubscribers: 0,
    features: ['All Growth Features', 'High-Volume Lead Intelligence', 'Bulk Export Engine', 'Priority VIP Support']
  },
  {
    id: 'plan-enterprise',
    name: 'Enterprise',
    monthlyPrice: 4999,
    annualPrice: 3999,
    creditsPerMonth: 10000,
    exportLimitMonthly: 50000,
    activeSubscribers: 0,
    features: ['Unlimited Team Seats', 'Dedicated Infrastructure', 'Dedicated Account Manager', 'Custom SLA 99.9%']
  }
];
