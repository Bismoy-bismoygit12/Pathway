import { User, TrustedContact, DoctorAccess } from '../types';
import { getAllUsersData, saveAllUsersData, mockHashPassword } from './auth';
import {
  isRealUserId,
  saveUserUpdates,
  insertTrustedContact,
  deleteTrustedContact,
  upsertDoctorAccess,
} from './supabaseUser';
import { changePasswordWithCurrent, signOutOtherDevices } from './supabaseAuth';

/*
 * Two kinds of accounts live side by side:
 *   - real accounts (UUID ids) are stored in Supabase;
 *   - the old demo personas (ids like "user-shanto") stay in localStorage so the
 *     demo drawer keeps working.
 * Every function below keeps its original signature, so pages did not need to change.
 * For real accounts the change is applied to an in-memory copy right away (the screen
 * updates instantly) and saved to Supabase in the background.
 */

let cachedUser: User | null = null;

/** AuthContext keeps this in step with the signed-in person. */
export function setUserCache(user: User | null) {
  cachedUser = user;
}

const pendingWrites = new Set<Promise<void>>();

function track(task: Promise<unknown>, what: string) {
  const done: Promise<void> = task
    .then(
      () => undefined,
      (err) => {
        console.error(`Pathway: could not save ${what}`, err);
      }
    )
    .then(() => {
      pendingWrites.delete(done);
    });
  pendingWrites.add(done);
}

/** Wait until background saves finish (so a refresh never reads stale data). */
export async function waitForPendingWrites(): Promise<void> {
  while (pendingWrites.size > 0) {
    await Promise.all([...pendingWrites]);
  }
}

function cachedFor(userId: string): User | null {
  return cachedUser && cachedUser.id === userId ? cachedUser : null;
}

export function getUserById(userId: string): User | null {
  if (isRealUserId(userId)) return cachedFor(userId);
  const all = getAllUsersData();
  return all[userId]?.user || null;
}

export function updateUser(userId: string, updates: Partial<User>): User | null {
  if (isRealUserId(userId)) {
    const current = cachedFor(userId);
    if (!current) return null;
    cachedUser = { ...current, ...updates };
    track(saveUserUpdates(userId, updates), 'your changes');
    return cachedUser;
  }

  const all = getAllUsersData();
  if (!all[userId]) return null;

  all[userId].user = {
    ...all[userId].user,
    ...updates
  };
  saveAllUsersData(all);
  return all[userId].user;
}

export async function changeUserPassword(
  userId: string,
  currentPw: string,
  newPw: string
): Promise<{ success: boolean; error?: string }> {
  if (isRealUserId(userId)) {
    return changePasswordWithCurrent(currentPw, newPw);
  }

  const all = getAllUsersData();
  if (!all[userId]) return { success: false, error: 'User not found' };

  if (all[userId].passwordHash !== mockHashPassword(currentPw)) {
    return { success: false, error: 'Current password did not match.' };
  }

  all[userId].passwordHash = mockHashPassword(newPw);
  saveAllUsersData(all);
  return { success: true };
}

// Trusted contacts management
export function addTrustedContact(userId: string, contact: Omit<TrustedContact, 'id'>): User | null {
  const user = getUserById(userId);
  if (!user) return null;

  if (isRealUserId(userId)) {
    const newContact: TrustedContact = { ...contact, id: crypto.randomUUID() };
    cachedUser = { ...user, trustedContacts: [...user.trustedContacts, newContact] };
    track(insertTrustedContact(userId, newContact), 'your trusted contact');
    return cachedUser;
  }

  const newContact: TrustedContact = {
    ...contact,
    id: `tc-${Date.now()}`
  };

  const updatedContacts = [...user.trustedContacts, newContact];
  return updateUser(userId, { trustedContacts: updatedContacts });
}

export function removeTrustedContact(userId: string, contactId: string): User | null {
  const user = getUserById(userId);
  if (!user) return null;
  const filtered = user.trustedContacts.filter((c) => c.id !== contactId);

  if (isRealUserId(userId)) {
    cachedUser = { ...user, trustedContacts: filtered };
    track(deleteTrustedContact(userId, contactId), 'the removal of your trusted contact');
    return cachedUser;
  }

  return updateUser(userId, { trustedContacts: filtered });
}

// Doctor sharing control
export function updateDoctorAccess(userId: string, doctorAccess: DoctorAccess): User | null {
  const user = getUserById(userId);
  if (!user) return null;

  const existingIndex = user.doctorAccessList.findIndex((d) => d.doctorId === doctorAccess.doctorId);
  let updatedList = [...user.doctorAccessList];

  if (existingIndex >= 0) {
    updatedList[existingIndex] = doctorAccess;
  } else {
    updatedList.push(doctorAccess);
  }

  if (isRealUserId(userId)) {
    cachedUser = { ...user, doctorAccessList: updatedList };
    track(upsertDoctorAccess(userId, doctorAccess), 'your doctor sharing settings');
    return cachedUser;
  }

  return updateUser(userId, { doctorAccessList: updatedList });
}

// Sessions management
export function revokeSession(userId: string, sessionId: string): User | null {
  const user = getUserById(userId);
  if (!user) return null;
  const filtered = user.sessions.filter((s) => s.id !== sessionId);
  // Supabase cannot end one named device from the browser, so real accounts only
  // ever list "this device"; the bulk action below ends all the others.
  if (isRealUserId(userId)) {
    cachedUser = { ...user, sessions: filtered };
    return cachedUser;
  }
  return updateUser(userId, { sessions: filtered });
}

export function revokeAllOtherSessions(userId: string): User | null {
  const user = getUserById(userId);
  if (!user) return null;
  const kept = user.sessions.filter((s) => s.isCurrent);

  if (isRealUserId(userId)) {
    cachedUser = { ...user, sessions: kept };
    track(signOutOtherDevices(), 'the sign-out of your other devices');
    return cachedUser;
  }

  return updateUser(userId, { sessions: kept });
}

// Account actions: Pause (real accounts call the matching server functions via updateUser)
export function pauseAccount(userId: string): User | null {
  return updateUser(userId, { status: 'paused' });
}

export function unpauseAccount(userId: string): User | null {
  return updateUser(userId, { status: 'active' });
}

// Account actions: Delete with 7-day grace period
export function requestAccountDeletion(userId: string, reason?: string): User | null {
  const deletionDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  return updateUser(userId, {
    status: 'pending_deletion',
    deletionRequestedAt: deletionDate
  });
}

export function cancelAccountDeletion(userId: string): User | null {
  return updateUser(userId, {
    status: 'active',
    deletionRequestedAt: undefined
  });
}

// Export user data
export function exportUserData(user: User): { jsonString: string; printableHtml: string } {
  const sanitized = {
    profile: {
      nickname: user.nickname,
      name: user.name,
      email: user.email,
      phone: user.phone,
      memberSince: user.createdAt,
      plan: user.plan,
      streakDays: user.streakDays,
      points: user.points
    },
    recoveryPreferences: user.preferences,
    healthBasics: user.healthBasics,
    consents: user.consents,
    trustedContacts: user.trustedContacts
  };

  const jsonString = JSON.stringify(sanitized, null, 2);

  const printableHtml = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Pathway Personal Summary - ${user.nickname}</title>
        <style>
          body { font-family: sans-serif; padding: 2rem; color: #333; line-height: 1.6; }
          h1 { color: #1d4ed8; }
          h2 { border-bottom: 1px solid #ddd; padding-bottom: 0.5rem; margin-top: 1.5rem; }
          .badge { display: inline-block; padding: 4px 8px; background: #dbeafe; color: #1e40af; border-radius: 4px; font-weight: bold; }
          table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
          th, td { text-align: left; padding: 8px; border-bottom: 1px solid #eee; }
        </style>
      </head>
      <body>
        <h1>Pathway Personal Record</h1>
        <p>Personal archive generated on ${new Date().toLocaleDateString('en-US', { dateStyle: 'long' })}</p>
        <p><span class="badge">Member: ${user.nickname}</span> &bull; Plan: ${user.plan} &bull; Streak: ${user.streakDays} days</p>

        <h2>Recovery Focus</h2>
        <p><strong>Areas:</strong> ${user.preferences.helpWith.join(', ') || 'None recorded'}</p>
        <p><strong>Goals:</strong> ${user.preferences.goals.join(', ') || 'None'}</p>
        <p><strong>Known Triggers:</strong> ${user.preferences.triggers.join(', ') || 'None'}</p>

        <h2>Health Notes (Private)</h2>
        <p><strong>Allergies:</strong> ${user.healthBasics.allergies || 'None declared'}</p>
        <p><strong>Medicines:</strong> ${user.healthBasics.currentMedicines || 'None'}</p>
        <p><strong>Care Notes:</strong> ${user.healthBasics.pastCareNotes || 'None'}</p>

        <h2>Trusted Emergency Contacts</h2>
        ${user.trustedContacts.length > 0 ? `
          <ul>
            ${user.trustedContacts.map((c) => `<li>${c.name} (${c.relationship}): ${c.phone}</li>`).join('')}
          </ul>
        ` : '<p>No trusted contacts added.</p>'}

        <hr style="margin-top: 2rem;" />
        <p style="font-size: 12px; color: #777;">Pathway supports your recovery. It does not replace medical advice or emergency services.</p>
      </body>
    </html>
  `;

  return { jsonString, printableHtml };
}
