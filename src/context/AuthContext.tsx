import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Session } from '@supabase/supabase-js';
import { User } from '../types';
import {
  getCurrentUserId,
  setCurrentUserId,
  getAllUsersData,
  saveAllUsersData,
  isPublicComputerSession,
  setPublicComputerSession
} from '../services/auth';
import { updateUser, setUserCache, waitForPendingWrites } from '../services/user';
import { supabase } from '../lib/supabase';
import { fetchUser, isRealUserId } from '../services/supabaseUser';
import { signInWithPassword, signUpWithPassword, RegisterParams } from '../services/supabaseAuth';

export type { RegisterParams };

interface AuthContextType {
  currentUser: User | null;
  user: User | null;
  isAuthenticated: boolean;
  /** True while the saved login session is being checked on page load. */
  isLoading: boolean;
  isPublicComputer: boolean;
  login: (identifier: string, password?: string, isOtp?: boolean, isPublic?: boolean) => Promise<{ success: boolean; error?: string; isLocked?: boolean; lockMinutes?: number }>;
  logout: () => void;
  register: (params: RegisterParams) => Promise<{ success: boolean; error?: string; user?: User }>;
  refreshUser: () => void;
  updateCurrentUser: (updates: Partial<User>) => void;
  updateUser: (updates: Partial<User>) => void;
  switchDemoUser: (persona: 'guest' | 'free' | 'premium' | 'paused' | 'locked' | 'pending_deletion') => void;
  sessionTimeoutWarning: boolean;
  extendSession: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const navigate = useNavigate();

  // Real accounts are restored asynchronously from Supabase (see the effect below).
  // Only the old demo personas can be restored instantly from localStorage.
  const [currentUser, setCurrentUserState] = useState<User | null>(() => {
    const id = getCurrentUserId();
    if (!id || isRealUserId(id)) return null;
    const all = getAllUsersData();
    return all[id]?.user || null;
  });
  const [isLoading, setIsLoading] = useState<boolean>(true);

  const [isPublic, setIsPublic] = useState<boolean>(isPublicComputerSession());
  const [sessionTimeoutWarning, setSessionTimeoutWarning] = useState<boolean>(false);
  const timeoutTimerRef = useRef<any>(null);
  const warningTimerRef = useRef<any>(null);

  const currentUserRef = useRef<User | null>(currentUser);
  useEffect(() => {
    currentUserRef.current = currentUser;
  }, [currentUser]);

  /** Load the signed-in person's record from Supabase into the app. */
  const applySession = useCallback(async (session: Session | null): Promise<User | null> => {
    if (!session) return null;
    await waitForPendingWrites(); // never read while a save is still on its way
    const loaded = await fetchUser(session.user);
    if (!loaded) return null;
    setUserCache(loaded);
    setCurrentUserState(loaded);
    setCurrentUserId(null); // forget any demo persona
    return loaded;
  }, []);

  // Restore the session on page load and follow sign-in / sign-out events.
  useEffect(() => {
    let cancelled = false;

    supabase.auth
      .getSession()
      .then(async ({ data }) => {
        if (data.session) await applySession(data.session);
      })
      .catch((err) => console.error('Pathway: could not restore the session', err))
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    const { data: listener } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT') {
        setUserCache(null);
        setCurrentUserState((prev) => (prev && isRealUserId(prev.id) ? null : prev));
        return;
      }
      if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') {
        // Do not call Supabase from inside this callback directly; hand off to the next tick.
        setTimeout(() => {
          void applySession(session);
        }, 0);
      }
    });

    return () => {
      cancelled = true;
      listener.subscription.unsubscribe();
    };
  }, [applySession]);

  const refreshUser = useCallback(() => {
    const current = currentUserRef.current;

    if (current && isRealUserId(current.id)) {
      void (async () => {
        const { data } = await supabase.auth.getSession();
        await applySession(data.session);
      })();
      return;
    }

    // Demo personas live in localStorage
    const id = getCurrentUserId();
    if (!id) {
      setCurrentUserState(null);
      return;
    }
    const all = getAllUsersData();
    if (all[id]) {
      setCurrentUserState(all[id].user);
    } else {
      setCurrentUserState(null);
    }
  }, [applySession]);

  const updateCurrentUser = useCallback((updates: Partial<User>) => {
    if (!currentUser) return;
    const updated = updateUser(currentUser.id, updates);
    if (updated) {
      setCurrentUserState(updated);
    }
  }, [currentUser]);

  const logout = useCallback(() => {
    void supabase.auth.signOut(); // ends the server-side session
    setUserCache(null);
    setCurrentUserId(null);
    setPublicComputerSession(false);
    setIsPublic(false);
    setCurrentUserState(null);
    setSessionTimeoutWarning(false);
    if (timeoutTimerRef.current) clearTimeout(timeoutTimerRef.current);
    if (warningTimerRef.current) clearTimeout(warningTimerRef.current);
    // Automatically redirect back to the all-user home interface
    navigate('/', { replace: true });
  }, [navigate]);

  const resetActivityTimers = useCallback(() => {
    if (timeoutTimerRef.current) clearTimeout(timeoutTimerRef.current);
    if (warningTimerRef.current) clearTimeout(warningTimerRef.current);

    if (!currentUser) return;

    // Public computer: 2 minute inactivity timeout with 30s warning
    // Regular computer: 15 minute inactivity timeout with 60s warning
    const warningMs = isPublic ? 90 * 1000 : 14 * 60 * 1000;
    const logoutMs = isPublic ? 120 * 1000 : 15 * 60 * 1000;

    warningTimerRef.current = setTimeout(() => {
      setSessionTimeoutWarning(true);
    }, warningMs);

    timeoutTimerRef.current = setTimeout(() => {
      logout();
    }, logoutMs);
  }, [currentUser, isPublic, logout]);

  const extendSession = () => {
    setSessionTimeoutWarning(false);
    resetActivityTimers();
  };

  useEffect(() => {
    const onActivity = () => {
      if (!sessionTimeoutWarning) {
        resetActivityTimers();
      }
    };

    window.addEventListener('mousemove', onActivity);
    window.addEventListener('keydown', onActivity);
    window.addEventListener('click', onActivity);

    resetActivityTimers();

    return () => {
      window.removeEventListener('mousemove', onActivity);
      window.removeEventListener('keydown', onActivity);
      window.removeEventListener('click', onActivity);
      if (timeoutTimerRef.current) clearTimeout(timeoutTimerRef.current);
      if (warningTimerRef.current) clearTimeout(warningTimerRef.current);
    };
  }, [resetActivityTimers, sessionTimeoutWarning]);

  const login = async (
    identifier: string,
    password?: string,
    isOtp: boolean = false,
    isPublicComp: boolean = false
  ) => {
    if (isOtp) {
      return {
        success: false,
        error: 'Login with a one-time code is not connected yet. Please log in with your password.'
      };
    }

    const res = await signInWithPassword(identifier, password || '');
    if (!res.ok) {
      return {
        success: false,
        error: res.error,
        isLocked: res.isLocked,
        lockMinutes: res.isLocked ? 1 : undefined
      };
    }

    const loaded = await applySession(res.session);
    if (!loaded) {
      return {
        success: false,
        error: 'You are signed in, but your profile could not be loaded. Please try again.'
      };
    }

    setIsPublic(isPublicComp);
    setPublicComputerSession(isPublicComp);
    return { success: true };
  };

  const register = async (params: RegisterParams) => {
    const res = await signUpWithPassword(params);
    if (!res.ok) {
      return { success: false, error: res.error };
    }

    if (!res.session) {
      // The Supabase project asks people to confirm their email before first login.
      return {
        success: false,
        error: 'Your account is created. Please confirm your email using the link we sent, then log in.'
      };
    }

    const loaded = await applySession(res.session);
    if (!loaded) {
      return {
        success: false,
        error: 'Your account is created, but your profile could not be loaded. Please log in.'
      };
    }
    return { success: true, user: loaded };
  };

  // Demo personas use the old localStorage data and have no server session.
  const switchDemoUser = (persona: 'guest' | 'free' | 'premium' | 'paused' | 'locked' | 'pending_deletion') => {
    if (persona === 'guest') {
      logout();
      return;
    }

    const all = getAllUsersData();
    let targetUser: User | null = null;

    if (persona === 'free') {
      targetUser = all['user-shanto']?.user || null;
      if (targetUser) {
        targetUser.status = 'active';
        targetUser.plan = 'free';
      }
    } else if (persona === 'premium') {
      targetUser = all['user-nabila']?.user || null;
      if (targetUser) {
        targetUser.status = 'active';
        targetUser.plan = 'premium';
      }
    } else if (persona === 'paused') {
      targetUser = all['user-shanto']?.user || null;
      if (targetUser) {
        targetUser.status = 'paused';
      }
    } else if (persona === 'locked') {
      targetUser = all['user-shanto']?.user || null;
      if (targetUser) {
        targetUser.status = 'locked';
        targetUser.lockedUntil = new Date(Date.now() + 5 * 60000).toISOString();
      }
    } else if (persona === 'pending_deletion') {
      targetUser = all['user-shanto']?.user || null;
      if (targetUser) {
        targetUser.status = 'pending_deletion';
        targetUser.deletionRequestedAt = new Date(Date.now() + 7 * 86400000).toISOString();
      }
    }

    if (targetUser) {
      setUserCache(null);
      setCurrentUserId(targetUser.id);
      setCurrentUserState({ ...targetUser });
      saveAllUsersData(all);
    }
  };

  return (
    <AuthContext.Provider
      value={{
        currentUser,
        user: currentUser,
        isAuthenticated: !!currentUser,
        isLoading,
        isPublicComputer: isPublic,
        login,
        logout,
        register,
        refreshUser,
        updateCurrentUser,
        updateUser: updateCurrentUser,
        switchDemoUser,
        sessionTimeoutWarning,
        extendSession
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
