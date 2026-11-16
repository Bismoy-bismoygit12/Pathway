import type { User as AuthUser } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import type { AccessLog, DoctorAccess, Session, TrustedContact, User } from '../types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Real (Supabase) accounts have UUID ids; the old demo personas use ids like "user-shanto". */
export function isRealUserId(id: string): boolean {
  return UUID_RE.test(id);
}

function calcAge(dob?: string | null): number | undefined {
  if (!dob) return undefined;
  const born = new Date(dob);
  if (Number.isNaN(born.getTime())) return undefined;
  const now = new Date();
  let age = now.getFullYear() - born.getFullYear();
  const hadBirthday =
    now.getMonth() > born.getMonth() ||
    (now.getMonth() === born.getMonth() && now.getDate() >= born.getDate());
  if (!hadBirthday) age -= 1;
  return age >= 0 ? age : undefined;
}

function currentDeviceSession(city?: string | null): Session {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const browser = ua.includes('Edg')
    ? 'Edge'
    : ua.includes('Firefox')
      ? 'Firefox'
      : ua.includes('Chrome')
        ? 'Chrome'
        : ua.includes('Safari')
          ? 'Safari'
          : 'Browser';
  return {
    id: 'current-device',
    device: 'This device',
    browser,
    city: city || 'Bangladesh',
    lastActive: 'Active now',
    isCurrent: true,
  };
}

/** Load a signed-in person's full record and shape it like the front end's User type. */
export async function fetchUser(authUser: AuthUser): Promise<User | null> {
  const uid = authUser.id;

  const [profileRes, prefsRes, healthRes, contactsRes, accessRes, logsRes] = await Promise.all([
    supabase.from('profiles').select('*').eq('id', uid).maybeSingle(),
    supabase.from('user_preferences').select('*').eq('user_id', uid).maybeSingle(),
    supabase.from('health_basics').select('*').eq('user_id', uid).maybeSingle(),
    supabase.from('trusted_contacts').select('*').eq('user_id', uid).order('created_at', { ascending: true }),
    supabase.from('doctor_access').select('*, doctors(name)').eq('user_id', uid),
    supabase.from('access_logs').select('*').eq('user_id', uid).order('viewed_at', { ascending: false }).limit(20),
  ]);

  if (profileRes.error) {
    console.error('Pathway: could not load profile', profileRes.error);
    return null;
  }
  const p = profileRes.data;
  if (!p) {
    console.error('Pathway: signed in, but no profile row exists. Did you run supabase/migrations/0001_init.sql?');
    return null;
  }

  const prefs = prefsRes.data;
  const health = healthRes.data;

  const trustedContacts: TrustedContact[] = (contactsRes.data ?? []).map((c: any) => ({
    id: c.id,
    name: c.name,
    relationship: c.relationship ?? '',
    phone: c.phone,
    canNotifyOnRelapse: !!c.can_notify_on_relapse,
  }));

  const doctorAccessList: DoctorAccess[] = (accessRes.data ?? []).map((a: any) => ({
    doctorId: a.doctor_id,
    doctorName: a.doctors?.name ?? 'Doctor',
    canViewProfile: !!a.can_view_profile,
    canViewGoals: !!a.can_view_goals,
    canViewMoods: !!a.can_view_moods,
    canViewHealthBasics: !!a.can_view_health_basics,
    canViewReports: !!a.can_view_reports,
  }));

  const accessLogs: AccessLog[] = (logsRes.data ?? []).map((l: any) => ({
    id: l.id,
    doctorName: l.doctor_name,
    date: new Date(l.viewed_at).toLocaleString(),
    itemsViewed: l.items_viewed ?? [],
  }));

  return {
    id: uid,
    nickname: p.nickname,
    name: p.full_name ?? undefined,
    email: authUser.email ?? undefined,
    phone: p.phone ?? authUser.phone ?? undefined,
    emailVerified: !!authUser.email_confirmed_at,
    phoneVerified: !!authUser.phone_confirmed_at,
    dob: p.dob ?? undefined,
    age: calcAge(p.dob),
    gender: p.gender ?? undefined,
    city: p.city ?? undefined,
    language: p.language,
    timezone: p.timezone,
    avatar: p.avatar,
    customAvatarUrl: p.custom_avatar_url ?? undefined,
    status: p.status,
    plan: p.plan,
    planRenewalDate: p.plan_renewal_date ?? undefined,
    consents: {
      terms: !!p.terms_accepted_at,
      aiHelp: !!p.consent_ai_help,
      chatbotMemory: !!p.consent_chatbot_memory,
      shareWithDoctors: !!p.consent_share_with_doctors,
    },
    preferences: {
      helpWith: prefs?.help_with ?? [],
      goals: prefs?.goals ?? [],
      triggers: prefs?.triggers ?? [],
      favouriteActivities: prefs?.favourite_activities ?? [],
      preferredTimeOfDay: prefs?.preferred_time_of_day ?? 'evening',
    },
    healthBasics: {
      allergies: health?.allergies ?? '',
      currentMedicines: health?.current_medicines ?? '',
      pastCareNotes: health?.past_care_notes ?? '',
    },
    trustedContacts,
    doctorAccessList,
    accessLogs,
    // Supabase does not list other devices to the browser, so only this device is shown.
    sessions: [currentDeviceSession(p.city)],
    streakDays: p.streak_days ?? 0,
    points: p.points ?? 0,
    quickLockPin: '',
    createdAt: String(p.created_at).split('T')[0],
    deletionRequestedAt: p.deletion_scheduled_for ?? undefined,
  };
}

/** Fields the server decides. Changing them from the browser is ignored (and refused by the database). */
const SERVER_CONTROLLED: (keyof User)[] = ['points', 'streakDays', 'plan', 'planRenewalDate'];

function failIfError(error: { message: string } | null, what: string) {
  if (error) throw new Error(`${what}: ${error.message}`);
}

/** Save the parts of a User update that the database allows the person to change. */
export async function saveUserUpdates(userId: string, u: Partial<User>): Promise<void> {
  const touched = SERVER_CONTROLLED.filter((k) => u[k] !== undefined);
  if (touched.length > 0) {
    console.warn(
      `Pathway: ${touched.join(', ')} are controlled by the server and were not saved. ` +
        'They change through goals, rewards and subscription actions.'
    );
  }

  // 1) Simple profile columns
  const profile: Record<string, unknown> = {};
  if (u.nickname !== undefined) profile.nickname = u.nickname;
  if (u.name !== undefined) profile.full_name = u.name || null;
  if (u.phone !== undefined) profile.phone = u.phone || null;
  if (u.dob !== undefined) profile.dob = u.dob || null;
  if (u.gender !== undefined) profile.gender = u.gender || null;
  if (u.city !== undefined) profile.city = u.city || null;
  if (u.language !== undefined) profile.language = u.language;
  if (u.timezone !== undefined) profile.timezone = u.timezone;
  if (u.avatar !== undefined) profile.avatar = u.avatar;
  if (u.customAvatarUrl !== undefined) profile.custom_avatar_url = u.customAvatarUrl || null;
  if (u.consents) {
    if (u.consents.aiHelp !== undefined) profile.consent_ai_help = u.consents.aiHelp;
    if (u.consents.chatbotMemory !== undefined) profile.consent_chatbot_memory = u.consents.chatbotMemory;
    if (u.consents.shareWithDoctors !== undefined) profile.consent_share_with_doctors = u.consents.shareWithDoctors;
  }
  if (Object.keys(profile).length > 0) {
    const { error } = await supabase.from('profiles').update(profile).eq('id', userId);
    failIfError(error, 'Could not save your profile');
  }

  // 2) Recovery preferences
  if (u.preferences) {
    const p = u.preferences;
    const row: Record<string, unknown> = {};
    if (p.helpWith !== undefined) row.help_with = p.helpWith;
    if (p.goals !== undefined) row.goals = p.goals;
    if (p.triggers !== undefined) row.triggers = p.triggers;
    if (p.favouriteActivities !== undefined) row.favourite_activities = p.favouriteActivities;
    if (p.preferredTimeOfDay !== undefined) row.preferred_time_of_day = p.preferredTimeOfDay;
    if (Object.keys(row).length > 0) {
      const { error } = await supabase.from('user_preferences').update(row).eq('user_id', userId);
      failIfError(error, 'Could not save your preferences');
    }
  }

  // 3) Private health notes
  if (u.healthBasics) {
    const h = u.healthBasics;
    const row: Record<string, unknown> = {};
    if (h.allergies !== undefined) row.allergies = h.allergies;
    if (h.currentMedicines !== undefined) row.current_medicines = h.currentMedicines;
    if (h.pastCareNotes !== undefined) row.past_care_notes = h.pastCareNotes;
    if (Object.keys(row).length > 0) {
      const { error } = await supabase.from('health_basics').update(row).eq('user_id', userId);
      failIfError(error, 'Could not save your health notes');
    }
  }

  // 4) Email lives in Supabase Auth; changing it sends a confirmation link to the new address.
  if (u.email !== undefined) {
    const { data } = await supabase.auth.getUser();
    if (data.user && data.user.email !== u.email) {
      const { error } = await supabase.auth.updateUser({ email: u.email });
      failIfError(error, 'Could not change your email');
    }
  }

  // 5) Account status changes go through checked server functions
  if (u.status === 'paused') {
    const { error } = await supabase.rpc('pause_account');
    failIfError(error, 'Could not pause your account');
  } else if (u.status === 'active') {
    const resume = await supabase.rpc('resume_account');
    failIfError(resume.error, 'Could not resume your account');
    const cancel = await supabase.rpc('cancel_account_deletion');
    failIfError(cancel.error, 'Could not cancel the deletion request');
  } else if (u.status === 'pending_deletion') {
    const { error } = await supabase.rpc('request_account_deletion');
    failIfError(error, 'Could not request account deletion');
  }
}

export async function insertTrustedContact(userId: string, c: TrustedContact): Promise<void> {
  const { error } = await supabase.from('trusted_contacts').insert({
    id: c.id,
    user_id: userId,
    name: c.name,
    relationship: c.relationship,
    phone: c.phone,
    can_notify_on_relapse: c.canNotifyOnRelapse,
  });
  failIfError(error, 'Could not save the trusted contact');
}

export async function deleteTrustedContact(userId: string, contactId: string): Promise<void> {
  const { error } = await supabase.from('trusted_contacts').delete().eq('id', contactId).eq('user_id', userId);
  failIfError(error, 'Could not remove the trusted contact');
}

export async function upsertDoctorAccess(userId: string, a: DoctorAccess): Promise<void> {
  const { error } = await supabase.from('doctor_access').upsert(
    {
      user_id: userId,
      doctor_id: a.doctorId,
      can_view_profile: a.canViewProfile,
      can_view_goals: a.canViewGoals,
      can_view_moods: a.canViewMoods,
      can_view_health_basics: a.canViewHealthBasics,
      can_view_reports: a.canViewReports,
    },
    { onConflict: 'user_id,doctor_id' }
  );
  failIfError(error, 'Could not save doctor sharing settings');
}
