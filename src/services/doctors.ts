import { Doctor, DoctorSlot } from '../types';
import doctorsData from '../data/psychiatrists.json';
import availabilityData from '../data/availability.json';

const STORAGE_KEY = 'pathway_custom_doctors';

export function getCustomDoctors(): Doctor[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.error('Failed to load custom doctors from storage', e);
    return [];
  }
}

export function saveCustomDoctors(doctors: Doctor[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(doctors));
  } catch (e) {
    console.error('Failed to save custom doctors to storage', e);
  }
}

export function getAllDoctors(): Doctor[] {
  const custom = getCustomDoctors();
  return [...custom, ...(doctorsData as Doctor[])];
}

export function getDoctorById(id: string): Doctor | undefined {
  return getAllDoctors().find((d) => d.id === id);
}

export function addDoctor(doctorData: Omit<Doctor, 'id'> & { id?: string }): Doctor {
  const custom = getCustomDoctors();
  const id = doctorData.id || `dr-custom-${Date.now()}`;
  const newDoctor: Doctor = {
    ...doctorData,
    id,
  };
  custom.unshift(newDoctor);
  saveCustomDoctors(custom);
  return newDoctor;
}

export function deleteDoctor(id: string): boolean {
  const custom = getCustomDoctors();
  const filtered = custom.filter((d) => d.id !== id);
  if (filtered.length !== custom.length) {
    saveCustomDoctors(filtered);
    return true;
  }
  return false;
}

export function getDoctorSlots(doctorId: string): DoctorSlot[] {
  const allSlots = availabilityData.slots as DoctorSlot[];
  // Merge with locally booked slots stored in localStorage if any
  const bookedSlotsRaw = localStorage.getItem('pathway_booked_slots');
  const bookedSlots: string[] = bookedSlotsRaw ? JSON.parse(bookedSlotsRaw) : [];

  // If this doctor has predefined slots, use them
  const existing = allSlots
    .filter((s) => s.doctorId === doctorId)
    .map((s) => ({
      ...s,
      isBooked: s.isBooked || bookedSlots.includes(`${s.doctorId}_${s.date}_${s.time}`)
    }));

  if (existing.length > 0) {
    return existing;
  }

  // Generate realistic default slots for custom-added doctors
  const today = new Date();
  const formatIso = (d: Date) => d.toISOString().split('T')[0];
  const d1 = formatIso(today);
  const d2 = formatIso(new Date(today.getTime() + 86400000));
  const d3 = formatIso(new Date(today.getTime() + 86400000 * 2));

  const autoSlots: DoctorSlot[] = [
    { doctorId, date: d1, time: '04:00 PM', mode: 'online', isBooked: bookedSlots.includes(`${doctorId}_${d1}_04:00 PM`) },
    { doctorId, date: d1, time: '05:30 PM', mode: 'in_person', isBooked: bookedSlots.includes(`${doctorId}_${d1}_05:30 PM`) },
    { doctorId, date: d2, time: '03:00 PM', mode: 'online', isBooked: bookedSlots.includes(`${doctorId}_${d2}_03:00 PM`) },
    { doctorId, date: d2, time: '06:00 PM', mode: 'online', isBooked: bookedSlots.includes(`${doctorId}_${d2}_06:00 PM`) },
    { doctorId, date: d3, time: '11:00 AM', mode: 'online', isBooked: bookedSlots.includes(`${doctorId}_${d3}_11:00 AM`) },
    { doctorId, date: d3, time: '05:00 PM', mode: 'in_person', isBooked: bookedSlots.includes(`${doctorId}_${d3}_05:00 PM`) },
  ];

  return autoSlots;
}

export function markSlotAsBooked(doctorId: string, date: string, time: string) {
  const bookedSlotsRaw = localStorage.getItem('pathway_booked_slots');
  const bookedSlots: string[] = bookedSlotsRaw ? JSON.parse(bookedSlotsRaw) : [];
  const key = `${doctorId}_${date}_${time}`;
  if (!bookedSlots.includes(key)) {
    bookedSlots.push(key);
    localStorage.setItem('pathway_booked_slots', JSON.stringify(bookedSlots));
  }
}

export function markSlotAsFree(doctorId: string, date: string, time: string) {
  const bookedSlotsRaw = localStorage.getItem('pathway_booked_slots');
  if (!bookedSlotsRaw) return;
  const bookedSlots: string[] = JSON.parse(bookedSlotsRaw);
  const key = `${doctorId}_${date}_${time}`;
  const updated = bookedSlots.filter((k) => k !== key);
  localStorage.setItem('pathway_booked_slots', JSON.stringify(updated));
}

export interface DoctorFilterOptions {
  searchQuery?: string;
  specialty?: string;
  language?: string;
  mode?: 'all' | 'online' | 'in_person';
  maxFee?: number;
  gender?: 'all' | 'female' | 'male';
  sortBy?: 'earliest' | 'lowestFee' | 'experience';
}

export function filterAndSortDoctors(options: DoctorFilterOptions): Doctor[] {
  let list = getAllDoctors();

  if (options.searchQuery?.trim()) {
    const q = options.searchQuery.toLowerCase();
    list = list.filter(
      (d) =>
        d.name.toLowerCase().includes(q) ||
        d.nameBn.includes(q) ||
        d.hospital.toLowerCase().includes(q) ||
        d.hospitalBn.includes(q) ||
        d.specialties.some((s) => s.toLowerCase().includes(q))
    );
  }

  if (options.specialty && options.specialty !== 'all') {
    list = list.filter((d) => d.specialties.includes(options.specialty!));
  }

  if (options.language && options.language !== 'all') {
    list = list.filter((d) => d.languages.includes(options.language!));
  }

  if (options.mode && options.mode !== 'all') {
    list = list.filter((d) => d.consultationModes.includes(options.mode as any));
  }

  if (options.gender && options.gender !== 'all') {
    list = list.filter((d) => d.gender === options.gender);
  }

  if (options.maxFee) {
    list = list.filter((d) => d.feeBDT <= options.maxFee!);
  }

  // Sorting
  if (options.sortBy === 'lowestFee') {
    list.sort((a, b) => a.feeBDT - b.feeBDT);
  } else if (options.sortBy === 'experience') {
    list.sort((a, b) => b.experienceYears - a.experienceYears);
  }
  // 'earliest' keeps natural slot priority

  return list;
}

// 3-Question Helper recommendation
export function recommendDoctors(quiz: {
  concern: string; // e.g. "cravings", "sleep", "depression", "family"
  mode: 'online' | 'in_person' | 'any';
  genderPref: 'female' | 'male' | 'any';
}): Doctor[] {
  const all = getAllDoctors();

  const scored = all.map((doc) => {
    let score = 0;
    if (quiz.concern === 'cravings' && doc.specialties.includes('Substance & Alcohol Recovery')) score += 5;
    if (quiz.concern === 'sleep' && doc.specialties.includes('Sleep & Insomnia')) score += 5;
    if (quiz.concern === 'depression' && doc.specialties.includes('Depression & Mood Care')) score += 5;
    if (quiz.concern === 'family' && doc.specialties.includes('Family & Caregiver Support')) score += 5;

    if (quiz.mode !== 'any' && doc.consultationModes.includes(quiz.mode as any)) score += 3;
    if (quiz.genderPref !== 'any' && doc.gender === quiz.genderPref) score += 2;

    return { doc, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 3).map((item) => item.doc);
}
