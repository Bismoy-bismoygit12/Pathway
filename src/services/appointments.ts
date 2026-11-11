import { Appointment, AppointmentStatus, Goal } from '../types';
import { markSlotAsBooked, markSlotAsFree } from './doctors';

const APPOINTMENTS_KEY = 'pathway_user_appointments';

function getSeedAppointments(): Appointment[] {
  return [
    {
      id: 'apt-seed-1',
      userId: 'user-shanto',
      doctorId: 'dr-tanvir-ahmed',
      doctorName: 'Prof. Dr. Tanvir Ahmed',
      doctorNameBn: 'অধ্যাপক ডাঃ তানভীর আহমেদ',
      doctorTitle: 'Senior Consultant Psychiatrist',
      doctorHospital: 'National Institute of Mental Health',
      doctorPhoto: 'https://images.unsplash.com/photo-1622253692010-333f2da6031d?w=300&h=300&fit=crop&crop=face',
      date: '2026-11-12',
      time: '04:30 PM',
      mode: 'online',
      status: 'confirmed',
      feeBDT: 2000,
      paymentMethod: 'bkash',
      paymentStatus: 'paid',
      reason: 'General check-in & review of sleep pattern',
      concernsList: ['Sleep problems', 'Cravings in evening'],
      sharedData: {
        profile: true,
        goals: true,
        moods: true,
        healthBasics: false,
        reports: true
      },
      createdAt: '2026-11-09T14:20:00Z'
    },
    {
      id: 'apt-seed-2',
      userId: 'user-shanto',
      doctorId: 'dr-nusrat-jahan',
      doctorName: 'Dr. Nusrat Jahan',
      doctorNameBn: 'ডাঃ নুসরত জাহান',
      doctorTitle: 'Associate Professor & Addiction Specialist',
      doctorHospital: 'Dhaka Medical College Hospital',
      doctorPhoto: 'https://images.unsplash.com/photo-1594824813575-573516428e24?w=300&h=300&fit=crop&crop=face',
      date: '2026-10-28',
      time: '07:00 PM',
      mode: 'online',
      status: 'completed',
      feeBDT: 1800,
      paymentMethod: 'bkash',
      paymentStatus: 'paid',
      reason: 'Initial consultation',
      sharedData: {
        profile: true,
        goals: false,
        moods: false,
        healthBasics: false,
        reports: false
      },
      rating: 5,
      feedback: 'Very kind, calm and non-judgmental discussion. Felt relieved.',
      doctorNote: 'Patient is demonstrating excellent insight. Suggested maintaining routine evening hydration and progressive muscle relaxation.',
      createdAt: '2026-10-24T10:00:00Z'
    }
  ];
}

export function getAllStoredAppointments(): Appointment[] {
  const raw = localStorage.getItem(APPOINTMENTS_KEY);
  if (!raw) {
    const seeds = getSeedAppointments();
    localStorage.setItem(APPOINTMENTS_KEY, JSON.stringify(seeds));
    return seeds;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return getSeedAppointments();
  }
}

export function saveAllAppointments(list: Appointment[]) {
  localStorage.setItem(APPOINTMENTS_KEY, JSON.stringify(list));
}

export function getUserAppointments(userId: string): Appointment[] {
  const all = getAllStoredAppointments();
  return all.filter((a) => a.userId === userId);
}

export function createAppointment(data: Omit<Appointment, 'id' | 'createdAt'>): { success: boolean; error?: string; appointment?: Appointment } {
  const all = getAllStoredAppointments();

  // Check double booking for doctor slot
  const isDoctorSlotTaken = all.some(
    (a) =>
      a.doctorId === data.doctorId &&
      a.date === data.date &&
      a.time === data.time &&
      (a.status === 'requested' || a.status === 'confirmed')
  );

  if (isDoctorSlotTaken) {
    return {
      success: false,
      error: 'This doctor slot was just taken. Please choose another comfortable time.'
    };
  }

  // Check overlapping appointment for current user
  const isUserDoubleBooked = all.some(
    (a) =>
      a.userId === data.userId &&
      a.date === data.date &&
      a.time === data.time &&
      (a.status === 'requested' || a.status === 'confirmed')
  );

  if (isUserDoubleBooked) {
    return {
      success: false,
      error: 'You already have another appointment scheduled at this exact time.'
    };
  }

  const newAppointment: Appointment = {
    ...data,
    id: `apt-${Date.now()}`,
    createdAt: new Date().toISOString()
  };

  all.unshift(newAppointment);
  saveAllAppointments(all);
  markSlotAsBooked(data.doctorId, data.date, data.time);

  return { success: true, appointment: newAppointment };
}

export function rescheduleAppointment(appointmentId: string, newDate: string, newTime: string): { success: boolean; error?: string; appointment?: Appointment } {
  const all = getAllStoredAppointments();
  const index = all.findIndex((a) => a.id === appointmentId);
  if (index === -1) return { success: false, error: 'Appointment not found' };

  const apt = all[index];
  markSlotAsFree(apt.doctorId, apt.date, apt.time);

  apt.date = newDate;
  apt.time = newTime;
  apt.status = 'rescheduled';

  markSlotAsBooked(apt.doctorId, newDate, newTime);
  all[index] = apt;
  saveAllAppointments(all);

  return { success: true, appointment: apt };
}

export function cancelAppointment(appointmentId: string, reason?: string): { success: boolean; appointment?: Appointment } {
  const all = getAllStoredAppointments();
  const index = all.findIndex((a) => a.id === appointmentId);
  if (index === -1) return { success: false };

  const apt = all[index];
  markSlotAsFree(apt.doctorId, apt.date, apt.time);

  apt.status = 'cancelled';
  if (apt.paymentStatus === 'paid') {
    apt.paymentStatus = 'refunded';
  }

  all[index] = apt;
  saveAllAppointments(all);

  return { success: true, appointment: apt };
}

export function updateAppointment(appointmentId: string, updates: Partial<Appointment>): Appointment | null {
  const all = getAllStoredAppointments();
  const index = all.findIndex((a) => a.id === appointmentId);
  if (index === -1) return null;

  all[index] = { ...all[index], ...updates };
  saveAllAppointments(all);
  return all[index];
}

// Generate valid iCalendar (.ics) and trigger browser download
export function downloadAppointmentIcs(appointment: Appointment) {
  const [year, month, day] = appointment.date.split('-').map(Number);
  // Parse time e.g. "04:30 PM"
  const parts = appointment.time.split(' ');
  const [hoursStr, minutesStr] = parts[0].split(':');
  let hours = Number(hoursStr);
  const minutes = Number(minutesStr);
  if (parts[1] === 'PM' && hours < 12) hours += 12;
  if (parts[1] === 'AM' && hours === 12) hours = 0;

  // Format to YYYYMMDDTHHmmSS
  const pad = (n: number) => String(n).padStart(2, '0');
  const startStr = `${year}${pad(month)}${pad(day)}T${pad(hours)}${pad(minutes)}00`;
  const endHours = (hours + 1) % 24;
  const endStr = `${year}${pad(month)}${pad(day)}T${pad(endHours)}${pad(minutes)}00`;

  const icsContent = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Pathway//Recovery Support Visit//EN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${appointment.id}@pathway.app`,
    `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').split('.')[0]}Z`,
    `DTSTART:${startStr}`,
    `DTEND:${endStr}`,
    `SUMMARY:Pathway Consultation with ${appointment.doctorName}`,
    `DESCRIPTION:Pathway Consultation (${appointment.mode === 'online' ? 'Online Video/Audio' : 'In Person Clinic Visit'}). Visit ID: ${appointment.id}. Pathway supports your recovery.`,
    `LOCATION:${appointment.mode === 'online' ? 'Pathway Online Video Room' : appointment.doctorHospital}`,
    'STATUS:CONFIRMED',
    'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n');

  const blob = new Blob([icsContent], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `pathway-visit-${appointment.date}.ics`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
