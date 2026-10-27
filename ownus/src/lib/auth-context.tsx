'use client';

import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import { apiClient } from './api-client';
import { toast } from 'sonner';

export interface User {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  name?: string;
  displayName?: string;
  avatarUrl?: string | null;
  role: string;
  status: string;
  organizationName?: string | null;
  companyName?: string | null;
  jobTitle?: string | null;
  phone?: string | null;
  phoneNumber?: string | null;
  isEmailVerified: boolean;
  provider?: string;
  googleLinked?: boolean;
  microsoftLinked?: boolean;
  hasPassword?: boolean;
}

export interface Wallet {
  dailyCredits: number;
  purchasedCredits: number;
  balance: number;
  lifetimePurchased: number;
  lifetimeUsed: number;
  lastDailyCreditDate?: string | null;
}

interface AuthContextType {
  user: User | null;
  wallet: Wallet | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (email: string, password: string, captchaToken?: string | null) => Promise<void>;
  register: (data: any) => Promise<void>;
  logout: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  handleOAuthTokens: (accessToken: string, refreshToken: string) => Promise<void>;
  setWalletBalance: (balance: number, dailyCredits?: number, purchasedCredits?: number) => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [wallet, setWallet] = useState<Wallet | null>(() => {
    if (typeof window !== 'undefined') {
      try {
        const cached = localStorage.getItem('orion_wallet');
        if (cached) {
          const parsed = JSON.parse(cached);
          if (typeof parsed?.balance === 'number') return parsed;
        }
      } catch {}
    }
    return {
      dailyCredits: 5,
      purchasedCredits: 0,
      balance: 5,
      lifetimePurchased: 0,
      lifetimeUsed: 0,
    };
  });
  const [isLoading, setIsLoading] = useState(true);

  const refreshProfile = useCallback(async () => {
    try {
      if (!apiClient.getAccessToken()) {
        setIsLoading(false);
        return;
      }
      const profile = await apiClient.user.getProfile();
      if (profile) {
        setUser({
          id: profile.id,
          email: profile.email,
          firstName: profile.firstName,
          lastName: profile.lastName,
          name: profile.name || profile.displayName || (profile.firstName ? `${profile.firstName} ${profile.lastName || ''}`.trim() : undefined),
          displayName: profile.displayName || (profile.firstName ? `${profile.firstName} ${profile.lastName || ''}`.trim() : undefined),
          avatarUrl: profile.avatarUrl || null,
          role: profile.role,
          status: profile.status,
          organizationName: profile.organizationName || profile.companyName || null,
          companyName: profile.companyName || profile.organizationName || null,
          jobTitle: profile.jobTitle || (profile.metadata as any)?.jobTitle || null,
          phone: profile.phone || profile.phoneNumber || null,
          phoneNumber: profile.phoneNumber || profile.phone || null,
          isEmailVerified: profile.isEmailVerified,
          provider: profile.provider,
          googleLinked: profile.googleLinked,
          microsoftLinked: profile.microsoftLinked,
          hasPassword: profile.hasPassword,
        });

        let updatedWallet: Wallet | null = null;

        if (profile.wallet && typeof profile.wallet.balance === 'number') {
          updatedWallet = {
            dailyCredits: profile.wallet.dailyCredits ?? 5,
            purchasedCredits: profile.wallet.purchasedCredits ?? 0,
            balance: profile.wallet.balance,
            lifetimePurchased: profile.wallet.lifetimePurchased ?? 0,
            lifetimeUsed: profile.wallet.lifetimeUsed ?? 0,
            lastDailyCreditDate: profile.wallet.lastDailyCreditDate,
          };
        } else {
          // Secondary fallback to /credit/wallet directly
          try {
            const walletData = await apiClient.credit.getWallet();
            if (walletData && typeof walletData.balance === 'number') {
              updatedWallet = {
                dailyCredits: walletData.dailyCredits ?? 5,
                purchasedCredits: walletData.purchasedCredits ?? 0,
                balance: walletData.balance,
                lifetimePurchased: walletData.lifetimePurchased ?? 0,
                lifetimeUsed: walletData.lifetimeUsed ?? 0,
                lastDailyCreditDate: walletData.lastDailyCreditDate,
              };
            }
          } catch {}
        }

        if (updatedWallet) {
          setWallet(updatedWallet);
          if (typeof window !== 'undefined') {
            localStorage.setItem('orion_wallet', JSON.stringify(updatedWallet));
          }
        }
      }
    } catch {
      // Token might be invalid
      apiClient.clearTokens();
      if (typeof window !== 'undefined') {
        localStorage.removeItem('orion_wallet');
      }
      setUser(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshProfile();

    const handleSessionSuperseded = (e: Event) => {
      const customEvent = e as CustomEvent;
      const message = customEvent?.detail?.message || 'Your session was ended because your account was logged in on another device.';
      
      setUser(null);
      setWallet(null);
      apiClient.clearTokens();
      if (typeof window !== 'undefined') {
        localStorage.removeItem('orion_wallet');
        toast.error(message, { duration: 6000 });
        window.location.href = '/login?reason=session_superseded';
      }
    };

    if (typeof window !== 'undefined') {
      window.addEventListener('session_superseded', handleSessionSuperseded);
    }

    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('session_superseded', handleSessionSuperseded);
      }
    };
  }, [refreshProfile]);

  const handleOAuthTokens = useCallback(async (accessToken: string, refreshToken: string) => {
    setIsLoading(true);
    try {
      apiClient.setTokens(accessToken, refreshToken);
      await refreshProfile();
    } finally {
      setIsLoading(false);
    }
  }, [refreshProfile]);

  const login = useCallback(async (email: string, password: string, captchaToken?: string | null) => {
    setIsLoading(true);
    try {
      const res: any = await apiClient.auth.login({ email, password, ...(captchaToken ? { captchaToken } : {}) });
      const accessToken = res?.accessToken || res?.tokens?.accessToken || res?.data?.accessToken || res?.data?.tokens?.accessToken;
      const refreshToken = res?.refreshToken || res?.tokens?.refreshToken || res?.data?.refreshToken || res?.data?.tokens?.refreshToken;
      
      if (accessToken && refreshToken) {
        apiClient.setTokens(accessToken, refreshToken);
      } else {
        console.warn('[AuthContext] Login payload missing accessToken or refreshToken:', res);
      }

      const userData = res?.user || res?.data?.user;
      if (userData) {
        setUser(userData);
      }
      await refreshProfile();
    } finally {
      setIsLoading(false);
    }
  }, [refreshProfile]);

  const register = useCallback(async (data: any) => {
    setIsLoading(true);
    try {
      const res: any = await apiClient.auth.register(data);
      const accessToken = res?.accessToken || res?.tokens?.accessToken || res?.data?.accessToken || res?.data?.tokens?.accessToken;
      const refreshToken = res?.refreshToken || res?.tokens?.refreshToken || res?.data?.refreshToken || res?.data?.tokens?.refreshToken;
      
      if (accessToken && refreshToken) {
        apiClient.setTokens(accessToken, refreshToken);
      } else {
        console.warn('[AuthContext] Register payload missing accessToken or refreshToken:', res);
      }

      const userData = res?.user || res?.data?.user;
      if (userData) {
        setUser(userData);
      }
      await refreshProfile();
    } finally {
      setIsLoading(false);
    }
  }, [refreshProfile]);

  const logout = useCallback(async () => {
    try {
      await apiClient.auth.logout();
    } catch {
      // Ignore
    } finally {
      apiClient.clearTokens();
      if (typeof window !== 'undefined') {
        localStorage.removeItem('orion_wallet');
      }
      setUser(null);
      setWallet(null);
    }
  }, []);

  const setWalletBalance = useCallback((newBalance: number, dailyCredits?: number, purchasedCredits?: number) => {
    setWallet((prev) => {
      let finalDaily = dailyCredits;
      let finalPurchased = purchasedCredits;

      if (finalDaily === undefined || finalPurchased === undefined) {
        const prevDaily = prev?.dailyCredits ?? 5;
        const prevPurchased = prev?.purchasedCredits ?? 0;
        const prevBalance = prev?.balance ?? (prevDaily + prevPurchased);

        if (newBalance <= prevBalance) {
          // Deduction hierarchy: daily credits first, then purchased credits
          const diff = prevBalance - newBalance;
          finalDaily = Math.max(0, prevDaily - diff);
          const remainingDiff = diff - (prevDaily - finalDaily);
          finalPurchased = Math.max(0, prevPurchased - remainingDiff);
        } else {
          // Addition: add to purchased credits
          const diff = newBalance - prevBalance;
          finalDaily = prevDaily;
          finalPurchased = prevPurchased + diff;
        }
      }

      const updated: Wallet = {
        dailyCredits: finalDaily,
        purchasedCredits: finalPurchased,
        balance: newBalance,
        lifetimePurchased: prev?.lifetimePurchased ?? 0,
        lifetimeUsed: prev?.lifetimeUsed ?? 0,
        lastDailyCreditDate: prev?.lastDailyCreditDate,
      };

      if (typeof window !== 'undefined') {
        localStorage.setItem('orion_wallet', JSON.stringify(updated));
      }

      return updated;
    });
  }, []);

  const value = useMemo(
    () => ({
      user,
      wallet,
      isAuthenticated: !!user,
      isLoading,
      login,
      register,
      logout,
      refreshProfile,
      handleOAuthTokens,
      setWalletBalance,
    }),
    [user, wallet, isLoading, login, register, logout, refreshProfile, handleOAuthTokens, setWalletBalance]
  );

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
