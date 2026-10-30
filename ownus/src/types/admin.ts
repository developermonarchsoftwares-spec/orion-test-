export type BusinessStatus = 'draft' | 'validated' | 'approved' | 'published' | 'rejected' | 'archived';

export type ValidationStatus = 'Pending' | 'Validated' | 'Warning' | 'Rejected' | 'Approved';

export type FieldValidationStatus = 'valid' | 'warning' | 'invalid' | 'missing' | 'duplicate';

export type ConfidenceTier = 'Very High' | 'High' | 'Medium' | 'Low';

export type AdminTab = 
  | 'dashboard'
  | 'records'
  | 'import'
  | 'history'
  | 'validation'
  | 'duplicates'
  | 'publish_queue'
  | 'people_review'
  | 'rights_queue'
  | 'upload_ops'
  | 'people_import'
  | 'data_quality'
  | 'enrichment'
  | 'published'
  | 'users'
  | 'credits'
  | 'roles'
  | 'reports'
  | 'settings'
  | 'logs'
  | 'support'
  | 'sources'
  | 'enrichment_queue'
  | 'ai_processing'
  | 'automation'
  | 'sync_center'
  | 'system_health'
  | 'data_intelligence';

export type AdminSection = AdminTab;

// ================= MODULE 4: DATA INTELLIGENCE & AUTOMATION ================= //

export type DataSourceStatus = 'Connected' | 'Disconnected' | 'Paused' | 'Running' | 'Failed';

export type EnrichmentQueueStatus = 'Queued' | 'Running' | 'Completed' | 'Failed' | 'Skipped';

export type EnrichmentTaskType = 
  | 'Website Detection'
  | 'Social Presence'
  | 'Google Business Detection'
  | 'Phone Verification'
  | 'Email Validation'
  | 'Category Classification'
  | 'Business Description'
  | 'Logo Detection'
  | 'AI Summary';

export interface DataSourceSyncLog {
  id: string;
  timestamp: string;
  recordsFetched: number;
  duration: string;
  status: 'Success' | 'Failed' | 'Warning';
  details: string;
}

export interface DataSourceRecord {
  id: string;
  name: string;
  category: 'Government Registry' | 'Tax Gateway' | 'Corporate Affairs' | 'Batch Ingestion' | 'REST API' | 'Web Scraper';
  status: DataSourceStatus;
  recordsImported: number;
  lastSync: string;
  nextSync: string;
  successRate: number;
  frequency: string;
  endpoint: string;
  authMethod: string;
  errorCount: number;
  lastErrorMessage?: string;
  syncHistory: DataSourceSyncLog[];
}

export interface EnrichmentJob {
  id: string;
  businessId: string;
  businessName: string;
  industry: string;
  taskType: EnrichmentTaskType;
  status: EnrichmentQueueStatus;
  progress: number;
  started: string;
  completed?: string;
  duration?: string;
  extractedData?: Record<string, string>;
  errorMessage?: string;
}

export interface AiPipelineDefinition {
  id: string;
  name: 'Classification' | 'Deduplication' | 'Scoring' | 'Business Categorization' | 'Recommendation Engine';
  displayName: string;
  description: string;
  model: string;
  version: string;
  accuracy: number;
  status: 'Active' | 'Training' | 'Idle' | 'Degraded';
  processedCount: number;
  avgLatencyMs: number;
  queueDepth: number;
}

export interface AutomationRule {
  id: string;
  name: string;
  description: string;
  trigger: 
    | 'On Record Ingested' 
    | 'On Validation Passed' 
    | 'On Validation Failed' 
    | 'On Duplicate Score > Threshold' 
    | 'On Lead Score Computed' 
    | 'Scheduled Daily';
  conditionField: string;
  conditionOperator: 'equals' | 'greater_than' | 'less_than' | 'contains' | 'is_empty' | 'is_not_empty';
  conditionValue: string;
  action: 
    | 'Auto-Publish' 
    | 'Auto-Reject' 
    | 'Assign Industry' 
    | 'Assign Category' 
    | 'Quarantine for Review' 
    | 'Trigger AI Enrichment' 
    | 'Send Alert';
  actionPayload?: string;
  priority: 'P1 Urgent' | 'P2 High' | 'P3 Normal' | 'P4 Low';
  status: 'Active' | 'Paused' | 'Draft';
  executionsCount: number;
  lastExecuted?: string;
  successRate: number;
}

export type ServiceHealthStatus = 'Healthy' | 'Warning' | 'Offline' | 'Maintenance';

export interface SystemServiceHealth {
  id: string;
  name: string;
  category: 'Import Service' | 'Validation Service' | 'Search Index' | 'Database' | 'Queue Workers' | 'Storage' | 'AI Workers' | 'Cache';
  status: ServiceHealthStatus;
  latencyMs: number;
  uptime: string;
  errorRate: string;
  details: string;
  instances: string;
  cpuUsage: number;
  memoryUsage: number;
}

export interface SearchIndexStatus {
  indexedBusinesses: number;
  pendingIndex: number;
  failedIndex: number;
  clusterHealth: 'Green' | 'Yellow' | 'Red';
  shardsCount: number;
  indexSizeBytes: string;
  lastOptimized: string;
  avgQueryLatencyMs: number;
}

export type CustomerUserStatus = 'Active' | 'Inactive' | 'Suspended' | 'Pending Verification';

export type CustomerPlan = 'Starter' | 'Professional' | 'Growth' | 'Enterprise';

export type PaymentStatus = 'Success' | 'Pending' | 'Failed' | 'Refunded' | 'Cancelled';

export type TicketPriority = 'Low' | 'Medium' | 'High' | 'Critical';

export type TicketStatus = 'Open' | 'In Progress' | 'Waiting for Customer' | 'Resolved' | 'Closed';

export interface UnlockedBusinessRecord {
  id: string;
  name: string;
  industry: string;
  city: string;
  state: string;
  unlockedAt: string;
  creditsCost: number;
}

export interface SavedSearchQuery {
  id: string;
  name: string;
  filters: Record<string, string>;
  resultCount: number;
  savedAt: string;
}

export interface LoginHistoryEntry {
  id: string;
  ip: string;
  device: string;
  browser: string;
  location: string;
  timestamp: string;
  status: 'Success' | 'Failed';
}

export interface CustomerUser {
  id: string;
  name: string;
  company: string;
  email: string;
  phone: string;
  role: string;
  credits: number;
  status: CustomerUserStatus;
  plan: CustomerPlan;
  registeredDate: string;
  lastLogin: string;
  totalSpent: number;
  unlockedCount: number;
  unlockedBusinesses?: UnlockedBusinessRecord[];
  savedSearches?: SavedSearchQuery[];
  loginHistory?: LoginHistoryEntry[];
  activityTimeline?: { id: string; action: string; timestamp: string; details: string }[];
  billingAddress?: {
    street: string;
    city: string;
    state: string;
    pincode: string;
    gstin?: string;
  };
}

export interface TransactionRecord {
  id: string;
  customerId: string;
  customerName: string;
  customerEmail: string;
  company: string;
  plan?: CustomerPlan;
  creditsPurchased: number;
  creditsUsed: number;
  amount: number;
  paymentMethod: 'Razorpay UPI' | 'Credit Card' | 'Debit Card' | 'NetBanking' | 'Bank Wire';
  paymentStatus: PaymentStatus;
  date: string;
  invoiceUrl?: string;
  receiptNumber: string;
  refundReason?: string;
  refundedAmount?: number;
}

export type PermissionAction = 'read' | 'write' | 'delete' | 'export' | 'admin';

export interface ModulePermission {
  moduleKey: string;
  moduleName: string;
  permissions: {
    read: boolean;
    write: boolean;
    delete: boolean;
    export: boolean;
    admin: boolean;
  };
}

export interface RoleDefinition {
  id: string;
  name: string;
  description: string;
  userCount: number;
  isSystem: boolean;
  modules: ModulePermission[];
}

export interface SupportTicketMessage {
  id: string;
  sender: 'Customer' | 'Support Agent' | 'System';
  senderName: string;
  message: string;
  timestamp: string;
  attachments?: string[];
  isInternalNote?: boolean;
}

export interface SupportTicket {
  id: string;
  customerId: string;
  customerName: string;
  customerEmail: string;
  company: string;
  subject: string;
  priority: TicketPriority;
  status: TicketStatus;
  assignedTo: string;
  createdDate: string;
  lastUpdated: string;
  category: 'Billing & Credits' | 'Data Accuracy' | 'Account Access' | 'API Integration' | 'Feature Request';
  messages: SupportTicketMessage[];
  internalNotes: string[];
  resolution?: string;
  resolutionTimeMinutes?: number;
}

export interface CreditPackage {
  id: string;
  name: string;
  credits: number;
  price: number;
  discountPercentage: number;
  isPopular?: boolean;
  features: string[];
}

export interface SubscriptionPlan {
  id: string;
  name: CustomerPlan;
  monthlyPrice: number;
  annualPrice: number;
  creditsPerMonth: number;
  exportLimitMonthly: number;
  activeSubscribers: number;
  features: string[];
}

export interface ValidationCheckResult {
  rule: string;
  field: string;
  status: 'passed' | 'warning' | 'failed';
  message: string;
  currentValue?: string;
  expectedFormat?: string;
}

export interface AdminBusinessRecord {
  id: string;
  name: string;
  industry: string;
  subIndustry?: string;
  category: string;
  businessType: string;
  msmeCategory?: string;
  address: string;
  state: string;
  district: string;
  city: string;
  pincode: string;
  phone: string;
  whatsapp?: string;
  email: string;
  website: string;
  linkedin?: string;
  linkedin_url?: string;
  linkedInUrl?: string;
  hasLinkedIn?: boolean;
  instagram?: string;
  registrationDate?: string;
  latitude?: number;
  longitude?: number;
  googleMapsLink?: string;
  description?: string;
  status: BusinessStatus;
  validationStatus: ValidationStatus;
  phoneStatus: FieldValidationStatus;
  emailStatus: FieldValidationStatus;
  websiteStatus: FieldValidationStatus;
  validationScore: number;
  opportunityScore: number;
  dataQualityScore: number;
  hasWebsite: boolean;
  isDuplicate?: boolean;
  duplicateOfId?: string;
  missingFields: string[];
  validationErrors: string[];
  validationChecks?: ValidationCheckResult[];
  reviewer?: string;
  approvedDate?: string;
  createdAt: string;
  updatedAt: string;
  importedBy?: string;
  internalNotes?: string[];
  tags?: string[];
}

export interface ImportBatch {
  id: string;
  fileName: string;
  uploadedBy: string;
  uploadedAt: string;
  totalRecords: number;
  successCount: number;
  failedCount: number;
  duplicateCount: number;
  status: 'Completed' | 'Processing' | 'Failed' | 'Warning' | 'Validating';
  fileSize: string;
  errorLogUrl?: string;
}

export interface DuplicatePair {
  id: string;
  confidenceScore: number;
  confidenceTier: ConfidenceTier;
  matchingFields: string[];
  matchReasons: string[];
  original: AdminBusinessRecord;
  duplicate: AdminBusinessRecord;
  status: 'pending' | 'merged' | 'ignored' | 'deleted';
}

export interface ValidationIssue {
  id: string;
  recordId: string;
  businessName: string;
  issueType: 'missing_name' | 'invalid_email' | 'invalid_phone' | 'invalid_website' | 'invalid_pincode' | 'invalid_state' | 'duplicate_phone' | 'duplicate_email';
  severity: 'error' | 'warning';
  currentValue: string;
  suggestedFix?: string;
  createdAt: string;
}

export interface ActivityLogEntry {
  id: string;
  user: string;
  action: 'Created' | 'Updated' | 'Deleted' | 'Imported' | 'Published' | 'Merged' | 'Rejected' | 'Exported' | 'Archived' | 'Approved' | 'Unpublished';
  entityType: 'Business' | 'Batch' | 'User' | 'Settings' | 'Credits';
  entityId: string;
  entityName: string;
  details: string;
  ipAddress: string;
  timestamp: string;
}

export interface AdminUser {
  id: string;
  name: string;
  email: string;
  role: 'Super Admin' | 'Data Operator' | 'Reviewer' | 'Auditor';
  status: 'Active' | 'Inactive' | 'Suspended';
  creditsBalance: number;
  lastActive: string;
  recordsReviewed: number;
}

export interface CreditTransaction {
  id: string;
  userId: string;
  userName: string;
  type: 'allocation' | 'purchase' | 'deduction' | 'refund' | 'adjustment';
  amount: number;
  balanceAfter: number;
  description: string;
  adminBy?: string;
  timestamp: string;
}
