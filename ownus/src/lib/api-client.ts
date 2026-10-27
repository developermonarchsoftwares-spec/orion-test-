/**
 * Orion API Client - Production Frontend Integration
 */

const getApiBaseUrl = (): string => {
  if (process.env.NEXT_PUBLIC_API_URL) {
    return process.env.NEXT_PUBLIC_API_URL;
  }
  // In the browser, use same-origin relative path /api/v1 to avoid CORS and mixed-content issues
  if (typeof window !== 'undefined') {
    return '/api/v1';
  }
  return 'http://localhost:4000/api/v1';
};

const API_BASE_URL = getApiBaseUrl();

export interface ApiResponse<T = any> {
  success: boolean;
  statusCode: number;
  message?: string;
  data: T;
  timestamp: string;
}

export class ApiClient {
  private accessToken: string | null = null;
  private refreshToken: string | null = null;

  constructor() {
    if (typeof window !== 'undefined') {
      this.accessToken = localStorage.getItem('orion_access_token');
      this.refreshToken = localStorage.getItem('orion_refresh_token');
    }
  }

  setTokens(accessToken: string, refreshToken: string) {
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
    if (typeof window !== 'undefined') {
      localStorage.setItem('orion_access_token', accessToken);
      localStorage.setItem('orion_refresh_token', refreshToken);
    }
  }

  clearTokens() {
    this.accessToken = null;
    this.refreshToken = null;
    if (typeof window !== 'undefined') {
      localStorage.removeItem('orion_access_token');
      localStorage.removeItem('orion_refresh_token');
      localStorage.removeItem('orion_user');
    }
  }

  getBaseUrl(): string {
    return getApiBaseUrl();
  }

  getAccessToken() {
    return this.accessToken;
  }

  async request<T = any>(
    endpoint: string,
    options: RequestInit = {},
  ): Promise<T> {
    const baseUrl = this.getBaseUrl();
    const url = `${baseUrl}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;
    const headers = new Headers(options.headers || {});

    if (!headers.has('Content-Type') && !(options.body instanceof FormData)) {
      headers.set('Content-Type', 'application/json');
    }

    const isAdminEndpoint = endpoint.includes('/admin');
    const adminToken = typeof window !== 'undefined' ? localStorage.getItem('orion_admin_token') : null;
    const customerToken = this.accessToken || (typeof window !== 'undefined' ? localStorage.getItem('orion_access_token') : null);

    const effectiveToken = isAdminEndpoint
      ? (adminToken || customerToken)
      : (customerToken || adminToken);

    if (effectiveToken && !this.accessToken && !isAdminEndpoint) {
      this.accessToken = effectiveToken;
    }

    if (effectiveToken && !headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${effectiveToken}`);
    }

    try {
      const response = await fetch(url, {
        ...options,
        headers,
      });

      // Handle 401 Unauthorized with automatic Token Refresh. Refresh tokens are single-use (a replay revokes the whole
      // session), so every request that fails at the same time must share ONE refresh, never start its own.
      if (response.status === 401 && !endpoint.includes('/auth/') && (this.refreshToken || this.readStoredRefreshToken())) {
        const sentAuth = headers.get('Authorization');
        // another request already refreshed while this one was in flight: just retry with the new access token
        const alreadyRefreshed = !!this.accessToken && sentAuth !== `Bearer ${this.accessToken}`;
        const refreshed = alreadyRefreshed || (await this.tryRefreshToken());
        if (refreshed) {
          headers.set('Authorization', `Bearer ${this.accessToken}`);
          const retryResponse = await fetch(url, { ...options, headers });
          return this.parseResponse<T>(retryResponse);
        }
      }

      return this.parseResponse<T>(response);
    } catch (error: any) {
      console.error(`API Error on [${options.method || 'GET'}] ${endpoint}:`, error);
      if (error?.message === 'Failed to fetch' || error?.name === 'TypeError') {
        const enhancedError = new Error(
          'Unable to connect to the authentication service. Please check your internet connection or try again shortly.'
        );
        (enhancedError as any).statusCode = 503;
        throw enhancedError;
      }
      throw error;
    }
  }

  private refreshInFlight: Promise<boolean> | null = null;

  /** The refresh token another tab may have rotated since this page loaded. */
  private readStoredRefreshToken(): string | null {
    if (typeof window === 'undefined') return null;
    try {
      return localStorage.getItem('orion_refresh_token');
    } catch {
      return null;
    }
  }

  /** One refresh at a time: concurrent callers await the same request. */
  private tryRefreshToken(): Promise<boolean> {
    if (!this.refreshInFlight) {
      this.refreshInFlight = this.doRefreshToken().finally(() => {
        this.refreshInFlight = null;
      });
    }
    return this.refreshInFlight;
  }

  private async doRefreshToken(): Promise<boolean> {
    this.refreshToken = this.readStoredRefreshToken() || this.refreshToken;
    if (!this.refreshToken) return false;
    try {
      const baseUrl = this.getBaseUrl();
      const res = await fetch(`${baseUrl}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: this.refreshToken }),
      });

      if (!res.ok) {
        this.clearTokens();
        return false;
      }

      const payload = await res.json();
      const tokenData = payload.data || payload;
      const accessToken = tokenData?.accessToken || tokenData?.tokens?.accessToken;
      const refreshToken = tokenData?.refreshToken || tokenData?.tokens?.refreshToken || this.refreshToken;
      
      if (accessToken && refreshToken) {
        this.setTokens(accessToken, refreshToken);
        return true;
      }
      this.clearTokens();
      return false;
    } catch {
      this.clearTokens();
      return false;
    }
  }

  private async parseResponse<T>(response: Response): Promise<T> {
    const contentType = response.headers.get('content-type');
    let body: any = null;

    if (contentType && contentType.includes('application/json')) {
      body = await response.json();
    } else {
      body = await response.text();
    }

    if (!response.ok) {
      const errorMsg = body?.message || body?.error || `HTTP ${response.status} - Request failed`;
      const errorCode = body?.code || body?.details?.code;
      const isSessionSuperseded = response.status === 401 && (
        errorCode === 'SESSION_SUPERSEDED' ||
        String(errorMsg).toLowerCase().includes('another device') ||
        String(errorMsg).includes('SESSION_SUPERSEDED')
      );

      if (isSessionSuperseded) {
        this.clearTokens();
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('session_superseded', { detail: { message: errorMsg } }));
        }
      }

      const error = new Error(Array.isArray(errorMsg) ? errorMsg.join(', ') : errorMsg);
      (error as any).statusCode = response.status;
      (error as any).code = errorCode;
      (error as any).details = body;
      throw error;
    }

    // Unwrap standardized TransformInterceptor format if present
    if (body && typeof body === 'object' && 'data' in body && 'success' in body) {
      return body.data as T;
    }

    return body as T;
  }

  // --- API Modules ---

  auth = {
    getMe: () => this.request('/auth/me'),
    /** Sign-up e-mail verification: ask for a code (also used to resend), then exchange it for a one-time proof that `register` must carry. */
    sendOtp: (email: string, captchaToken?: string | null) => this.request('/auth/send-otp', { method: 'POST', body: JSON.stringify({ email, purpose: 'REGISTER', ...(captchaToken ? { captchaToken } : {}) }) }),
    verifyOtp: (email: string, otp: string) => this.request('/auth/verify-otp', { method: 'POST', body: JSON.stringify({ email, otp, purpose: 'REGISTER' }) }),
    register: (dto: any) => this.request('/auth/register', { method: 'POST', body: JSON.stringify(dto) }),
    login: (dto: any) => this.request('/auth/login', { method: 'POST', body: JSON.stringify(dto) }),
    refresh: (refreshToken: string) => this.request('/auth/refresh', { method: 'POST', body: JSON.stringify({ refreshToken }) }),
    logout: (refreshToken?: string) => this.request('/auth/logout', { method: 'POST', body: JSON.stringify({ refreshToken }) }),
    changePassword: (dto: any) => this.request('/auth/change-password', { method: 'POST', body: JSON.stringify(dto) }),
    forgotPassword: (email: string) => this.request('/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email }) }),
    resetPassword: (dto: any) => this.request('/auth/reset-password', { method: 'POST', body: JSON.stringify(dto) }),
    getGoogleUrl: (prompt?: string) => `${this.getBaseUrl()}/auth/google${prompt ? `?prompt=${prompt}` : ''}`,
    getMicrosoftUrl: (prompt?: string) => `${this.getBaseUrl()}/auth/microsoft${prompt ? `?prompt=${prompt}` : ''}`,
    getLinkGoogleUrl: () => `${this.getBaseUrl()}/auth/google?link=true`,
    getLinkMicrosoftUrl: () => `${this.getBaseUrl()}/auth/microsoft?link=true`,
    exchangeOAuthToken: (dto: { code: string; state?: string }) =>
      this.request('/auth/oauth/token', { method: 'POST', body: JSON.stringify(dto) }),
    linkProvider: (dto: { provider: 'google' | 'microsoft'; code: string; state?: string }) =>
      this.request('/auth/link-provider', { method: 'POST', body: JSON.stringify(dto) }),
    unlinkProvider: (dto: { provider: 'google' | 'microsoft' }) =>
      this.request('/auth/unlink-provider', { method: 'POST', body: JSON.stringify(dto) }),
  };

  user = {
    getProfile: () => this.request('/user/profile'),
    updateProfile: (dto: any) => this.request('/user/profile', { method: 'PATCH', body: JSON.stringify(dto) }),
    uploadAvatar: async (file: File | string) => {
      if (typeof file === 'string') {
        return this.request('/user/avatar', { method: 'POST', body: JSON.stringify({ image: file }) });
      }
      return new Promise<any>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = async () => {
          try {
            const base64Data = reader.result as string;
            const res = await this.request('/user/avatar', {
              method: 'POST',
              body: JSON.stringify({ image: base64Data, mimeType: file.type, fileName: file.name }),
            });
            resolve(res);
          } catch (err) {
            reject(err);
          }
        };
        reader.onerror = () => reject(new Error('Failed to read image file'));
        reader.readAsDataURL(file);
      });
    },
    changePassword: (dto: any) => this.request('/user/change-password', { method: 'POST', body: JSON.stringify(dto) }),
    updateSettings: (dto: any) => this.request('/user/settings', { method: 'PATCH', body: JSON.stringify(dto) }),
  };

  discover = {
    search: (params: Record<string, any> = {}) => {
      const queryStr = new URLSearchParams();
      Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined && v !== null && v !== '') {
          queryStr.append(k, String(v));
        }
      });
      return this.request(`/discover/search?${queryStr.toString()}`);
    },
    getBusinessBySlug: (slug: string) => this.request(`/discover/businesses/${slug}`),
    getRelated: (slug: string, limit = 4) => this.request(`/discover/businesses/${slug}/related?limit=${limit}`),
    getSuggestions: (q?: string) => this.request(`/discover/suggestions${q ? `?q=${encodeURIComponent(q)}` : ''}`),
    exportUnlockedLeads: (params: { ids?: string[]; format?: 'csv' | 'json' } = {}) => {
      const queryStr = new URLSearchParams();
      if (params.ids && params.ids.length > 0) queryStr.append('ids', params.ids.join(','));
      if (params.format) queryStr.append('format', params.format);
      return this.request(`/discover/export?${queryStr.toString()}`);
    },
  };

  /** People / Decision Maker layer. Contact values only arrive for people the user has unlocked. */
  people = {
    taxonomy: () => this.request('/people/taxonomy'),
    listForCompany: (businessId: string, params: Record<string, string> = {}) =>
      this.request(`/companies/${businessId}/people?${new URLSearchParams(params).toString()}`),
    get: (personId: string) => this.request(`/people/${personId}`),
    unlock: (personId: string) => this.request(`/people/${personId}/unlock`, { method: 'POST', body: '{}' }),
    listUnlocked: (page = 1, limit = 20) => this.request(`/people/unlocked?page=${page}&limit=${limit}`),
    /** CSV of the caller's unlocked people (server-enforced). Resolves to the CSV text. */
    exportUnlocked: (personIds?: string[]) =>
      this.request<string>('/people/export', { method: 'POST', body: JSON.stringify(personIds?.length ? { personIds } : {}) }),
  };

  businesses = {
    getById: (id: string) => this.request(`/businesses/${id}`),
    getRelated: (id: string, limit = 4) => this.request(`/businesses/${id}/related?limit=${limit}`),
  };

  savedLeads = {
    list: (params: Record<string, any> = {}) => {
      const queryStr = new URLSearchParams();
      Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined && v !== null && v !== '') queryStr.append(k, String(v));
      });
      return this.request(`/saved-leads?${queryStr.toString()}`);
    },
    save: (dto: any) => this.request('/saved-leads', { method: 'POST', body: JSON.stringify(dto) }),
    update: (id: string, dto: any) => this.request(`/saved-leads/${id}`, { method: 'PATCH', body: JSON.stringify(dto) }),
    remove: (id: string) => this.request(`/saved-leads/${id}`, { method: 'DELETE' }),
    bulkSave: (dto: any) => this.request('/saved-leads/bulk-save', { method: 'POST', body: JSON.stringify(dto) }),
    bulkDelete: (dto: any) => this.request('/saved-leads/bulk-delete', { method: 'POST', body: JSON.stringify(dto) }),
  };

  savedSearches = {
    list: () => this.request('/saved-searches'),
    get: (id: string) => this.request(`/saved-searches/${id}`),
    create: (dto: any) => this.request('/saved-searches', { method: 'POST', body: JSON.stringify(dto) }),
    update: (id: string, dto: any) => this.request(`/saved-searches/${id}`, { method: 'PATCH', body: JSON.stringify(dto) }),
    delete: (id: string) => this.request(`/saved-searches/${id}`, { method: 'DELETE' }),
    run: (id: string) => this.request(`/saved-searches/${id}/run`, { method: 'POST' }),
  };

  credit = {
    getWallet: () => this.request('/credit/wallet'),
    getTransactions: (page = 1, limit = 20) => this.request(`/credit/transactions?page=${page}&limit=${limit}`),
    getPackages: () => this.request('/credit/packages'),
    getConfig: () => this.request('/credit/config'),
    admin: {
      getPackages: () => this.request('/credit/admin/packages'),
      createPackage: (dto: any) => this.request('/credit/admin/packages', { method: 'POST', body: JSON.stringify(dto) }),
      updatePackage: (id: string, dto: any) => this.request(`/credit/admin/packages/${id}`, { method: 'PUT', body: JSON.stringify(dto) }),
      deletePackage: (id: string) => this.request(`/credit/admin/packages/${id}`, { method: 'DELETE' }),
      updateConfig: (dto: { key: string; value: any; description?: string }) => this.request('/credit/admin/config', { method: 'PUT', body: JSON.stringify(dto) }),
      adjustCredits: (dto: { userId: string; dailyDelta: number; purchasedDelta: number; reason: string }) => this.request('/credit/admin/adjust', { method: 'POST', body: JSON.stringify(dto) }),
    },
  };

  unlock = {
    unlockBusiness: (businessId: string) => this.request('/unlock/business', { method: 'POST', body: JSON.stringify({ businessId }) }),
    getHistory: (page = 1, limit = 20) => this.request(`/unlock/history?page=${page}&limit=${limit}`),
    checkStatus: (businessId: string) => this.request(`/unlock/status/${businessId}`),
  };

  payments = {
    createOrder: (dto: any) => this.request('/payments/create-order', { method: 'POST', body: JSON.stringify(dto) }),
    verify: (dto: any) => this.request('/payments/verify', { method: 'POST', body: JSON.stringify(dto) }),
    getHistory: () => this.request('/payments/history'),
    /** The signed-in customer's real invoices (issued by the server when a payment is credited). */
    listInvoices: () => this.request('/billing/invoices'),
    /**
     * Downloads one real invoice as a PDF file. The invoice comes from the server (GET /billing/invoices/:id, the user's own record) and the PDF
     * is drawn from it in the browser, so nothing on it is typed in by the page. The PDF library is loaded only when this is clicked.
     */
    downloadInvoicePdf: async (invoiceId: string, invoiceNumber: string) => {
      let invoice: any;
      try {
        invoice = await this.request(`/billing/invoices/${encodeURIComponent(invoiceId)}`);
      } catch (err: any) {
        throw new Error(err?.message || 'The invoice could not be loaded, so no PDF was created.');
      }
      if (!invoice || typeof invoice !== 'object' || !invoice.invoiceNumber) {
        throw new Error('The invoice could not be loaded, so no PDF was created.');
      }
      try {
        const { buildInvoicePdf, invoicePdfFileName } = await import('./invoice-pdf');
        buildInvoicePdf(invoice).save(invoicePdfFileName(invoice.invoiceNumber || invoiceNumber));
      } catch {
        throw new Error('The PDF could not be created. Please try again.');
      }
      return true;
    },
    downloadInvoice: async (tx: any) => {
      const baseUrl = getApiBaseUrl();
      const params = new URLSearchParams({
        id: tx.id || 'TXN-999',
        receiptNumber: tx.receiptNumber || tx.receipt || `RCP-${(tx.id || '999').slice(0, 6)}`,
        customerName: tx.customerName || 'Valued Customer',
        customerEmail: tx.customerEmail || 'customer@example.com',
        company: tx.company || 'N/A',
        plan: tx.plan || 'Starter',
        amount: String(tx.amount || 0),
        creditsPurchased: String(tx.creditsPurchased || tx.credits || 100),
        paymentMethod: tx.paymentMethod || 'Razorpay UPI',
        date: tx.date || new Date().toISOString().split('T')[0],
      });

      const adminToken = typeof window !== 'undefined' ? localStorage.getItem('orion_admin_token') : null;
      const effectiveToken = adminToken || this.getAccessToken();

      const url = `${baseUrl}/invoices/download?${params.toString()}`;
      const response = await fetch(url, {
        headers: {
          'Accept': 'application/pdf',
          ...(effectiveToken ? { 'Authorization': `Bearer ${effectiveToken}` } : {}),
        },
      });

      const contentType = response.headers.get('content-type') || '';
      if (!response.ok || contentType.includes('application/json')) {
        let errorMsg = 'Failed to download invoice PDF';
        try {
          const json = await response.json();
          errorMsg = json.message || json.error || errorMsg;
        } catch {
          // Ignore
        }
        throw new Error(errorMsg);
      }

      const blob = await response.blob();
      const pdfBlob = new Blob([blob], { type: 'application/pdf' });
      const blobUrl = URL.createObjectURL(pdfBlob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = `Invoice_${tx.receiptNumber || tx.receipt || tx.id || 'RECEIPT'}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
      return true;
    },
  };

  dashboard = {
    getSummary: () => this.request('/dashboard/summary'),
  };

  settings = {
    getSettings: () => this.request('/settings'),
    updateCompany: (dto: any) => this.request('/settings/company', { method: 'PATCH', body: JSON.stringify(dto) }),
    updateNotifications: (dto: any) => this.request('/settings/notifications', { method: 'PATCH', body: JSON.stringify(dto) }),
    updatePreferences: (dto: any) => this.request('/settings/preferences', { method: 'PATCH', body: JSON.stringify(dto) }),
    updateBilling: (dto: any) => this.request('/settings/billing', { method: 'PATCH', body: JSON.stringify(dto) }),
  };
}

export const apiClient = new ApiClient();
