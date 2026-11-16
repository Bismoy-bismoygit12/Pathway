import type { Session } from '@supabase/supabase-js';
import { supabase, isSupabaseConfigured, BACKEND_NOT_CONFIGURED_MESSAGE } from '../lib/supabase';
import type { User } from '../types';

export interface RegisterParams {
  identifier: string; // email or phone
  password: string;
  nickname?: string;
  language?: 'en' | 'bn';
  consents?: Partial<User['consents']>;
  preferences?: Partial<User['preferences']>;
}

type Credential = { email: string } | { phone: string };

/** Turn what the person typed into an email or an international phone number (+880...). */
export function toCredential(identifier: string): Credential {
  const trimmed = identifier.trim();
  if (trimmed.includes('@')) return { email: trimmed.toLowerCase() };

  const digits = trimmed.replace(/[^0-9]/g, '');
  if (trimmed.startsWith('+') || digits.startsWith('880')) return { phone: `+${digits}` };
  if (digits.startsWith('0')) return { phone: `+880${digits.slice(1)}` };
  return { phone: `+880${digits}` };
}

interface AuthErrorLike {
  message: string;
  status?: number;
}

function friendlyError(err: AuthErrorLike): { error: string; isLocked?: boolean } {
  const msg = err.message.toLowerCase();
  if (err.status === 429 || msg.includes('rate limit') || msg.includes('too many')) {
    return {
      error: 'Too many attempts. For your privacy and safety, please wait a minute and try again.',
      isLocked: true,
    };
  }
  if (msg.includes('invalid login credentials')) {
    return { error: 'Incorrect email, phone or password.' };
  }
  if (msg.includes('email not confirmed')) {
    return { error: 'Please confirm your email first. Check your inbox for the link.' };
  }
  if (msg.includes('already registered') || msg.includes('already been registered')) {
    return { error: 'An account with this email or phone already exists. Please log in.' };
  }
  return { error: err.message };
}

export type SignInResult =
  | { ok: true; session: Session }
  | { ok: false; error: string; isLocked?: boolean };

export async function signInWithPassword(identifier: string, password: string): Promise<SignInResult> {
  if (!isSupabaseConfigured) return { ok: false, error: BACKEND_NOT_CONFIGURED_MESSAGE };

  const cred = toCredential(identifier);
  const { data, error } =
    'email' in cred
      ? await supabase.auth.signInWithPassword({ email: cred.email, password })
      : await supabase.auth.signInWithPassword({ phone: cred.phone, password });

  if (error || !data.session) {
    return { ok: false, ...friendlyError(error ?? { message: 'Could not sign in.' }) };
  }
  return { ok: true, session: data.session };
}

export type SignUpResult =
  | { ok: true; session: Session | null }
  | { ok: false; error: string };

/**
 * Create the account. The database trigger creates the profile from the
 * metadata below. `session` is null when the project requires email
 * confirmation first.
 */
export async function signUpWithPassword(p: RegisterParams): Promise<SignUpResult> {
  if (!isSupabaseConfigured) return { ok: false, error: BACKEND_NOT_CONFIGURED_MESSAGE };

  const cred = toCredential(p.identifier);
  const metadata = {
    nickname: p.nickname?.trim() || 'Friend',
    language: p.language === 'bn' ? 'bn' : 'en',
    consent_ai_help: String(!!p.consents?.aiHelp),
    consent_chatbot_memory: String(!!p.consents?.chatbotMemory),
    consent_share_with_doctors: String(!!p.consents?.shareWithDoctors),
  };

  const { data, error } =
    'email' in cred
      ? await supabase.auth.signUp({ email: cred.email, password: p.password, options: { data: metadata } })
      : await supabase.auth.signUp({ phone: cred.phone, password: p.password, options: { data: metadata } });

  if (error) return { ok: false, ...friendlyError(error) };

  // With email confirmation on, an existing address comes back as a user with no identities.
  if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
    return { ok: false, error: 'An account with this email or phone already exists. Please log in.' };
  }

  // Save the recovery preferences chosen during sign-up (needs a live session).
  if (data.session && data.user && p.preferences) {
    const pr = p.preferences;
    const row: Record<string, unknown> = {};
    if (pr.helpWith) row.help_with = pr.helpWith;
    if (pr.goals) row.goals = pr.goals;
    if (pr.triggers) row.triggers = pr.triggers;
    if (pr.favouriteActivities) row.favourite_activities = pr.favouriteActivities;
    if (pr.preferredTimeOfDay) row.preferred_time_of_day = pr.preferredTimeOfDay;
    if (Object.keys(row).length > 0) {
      const { error: prefError } = await supabase.from('user_preferences').update(row).eq('user_id', data.user.id);
      if (prefError) console.error('Pathway: could not save sign-up preferences', prefError);
    }
  }

  return { ok: true, session: data.session };
}

/** Check the current password first, then set the new one. */
export async function changePasswordWithCurrent(
  currentPw: string,
  newPw: string
): Promise<{ success: boolean; error?: string }> {
  const { data: userData } = await supabase.auth.getUser();
  const authUser = userData.user;
  if (!authUser) return { success: false, error: 'Please log in again.' };

  const check = authUser.email
    ? await supabase.auth.signInWithPassword({ email: authUser.email, password: currentPw })
    : await supabase.auth.signInWithPassword({ phone: authUser.phone ?? '', password: currentPw });
  if (check.error) return { success: false, error: 'Current password did not match.' };

  const { error } = await supabase.auth.updateUser({ password: newPw });
  if (error) return { success: false, error: error.message };
  return { success: true };
}

/** Sign out every other device but keep this one. */
export async function signOutOtherDevices(): Promise<void> {
  const { error } = await supabase.auth.signOut({ scope: 'others' });
  if (error) throw new Error(`Could not sign out other devices: ${error.message}`);
}
