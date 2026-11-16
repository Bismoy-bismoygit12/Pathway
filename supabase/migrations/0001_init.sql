-- =====================================================================
-- Pathway backend: initial schema (Supabase / PostgreSQL)
-- Run in the Supabase SQL editor, or with `supabase db push`.
--
-- Design rules
--   * Every user-owned table has row-level security (RLS): a user can only
--     ever see or change their own rows.
--   * Anything the client must NOT be able to forge (points, plan, status,
--     streaks, payment status, prices, booking) is changed only through
--     SECURITY DEFINER functions (RPCs) or column-restricted updates.
--   * Email / phone / password live in Supabase Auth (auth.users). The
--     `profiles` table holds everything else about the person.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. Helpers
-- ---------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ---------------------------------------------------------------------
-- 1. Profiles and per-user settings
-- ---------------------------------------------------------------------
create table public.profiles (
  id                          uuid primary key references auth.users (id) on delete cascade,
  nickname                    text not null default 'Friend',
  full_name                   text,
  phone                       text,
  dob                         date,
  gender                      text check (gender in ('female', 'male', 'other', 'prefer_not_to_say')),
  city                        text,
  language                    text not null default 'en' check (language in ('en', 'bn')),
  timezone                    text not null default 'Asia/Dhaka',
  avatar                      text not null default 'avatar-sprout',
  custom_avatar_url           text,
  status                      text not null default 'active'
                              check (status in ('new', 'active', 'paused', 'locked', 'pending_deletion', 'deleted')),
  plan                        text not null default 'free' check (plan in ('free', 'premium')),
  plan_renewal_date           date,
  points                      integer not null default 0 check (points >= 0),
  streak_days                 integer not null default 0 check (streak_days >= 0),
  last_goal_date              date,
  consent_ai_help             boolean not null default false,
  consent_chatbot_memory      boolean not null default false,
  consent_share_with_doctors  boolean not null default false,
  terms_accepted_at           timestamptz,
  deletion_scheduled_for      timestamptz,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

create table public.user_preferences (
  user_id               uuid primary key references public.profiles (id) on delete cascade,
  help_with             text[] not null default '{}',
  goals                 text[] not null default '{}',
  triggers              text[] not null default '{}',
  favourite_activities  text[] not null default '{}',
  preferred_time_of_day text not null default 'evening'
                        check (preferred_time_of_day in ('morning', 'afternoon', 'evening', 'night'))
);

-- Private health notes. Never shared unless the person grants access
-- (see doctor_access) and never readable by anyone but the owner today.
create table public.health_basics (
  user_id           uuid primary key references public.profiles (id) on delete cascade,
  allergies         text not null default '',
  current_medicines text not null default '',
  past_care_notes   text not null default ''
);

create table public.trusted_contacts (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null references public.profiles (id) on delete cascade,
  name                   text not null,
  relationship           text not null default '',
  phone                  text not null,
  can_notify_on_relapse  boolean not null default false,
  created_at             timestamptz not null default now()
);
create index trusted_contacts_user_idx on public.trusted_contacts (user_id);

create table public.notification_settings (
  user_id               uuid primary key references public.profiles (id) on delete cascade,
  email_alerts          boolean not null default true,
  sms_alerts            boolean not null default false,
  browser_alerts        boolean not null default false,
  daily_goal_reminders  boolean not null default true,
  visit_reminders       boolean not null default true,
  motivational_pings    boolean not null default true,
  reward_pings          boolean not null default true,
  quiet_hours_start     time not null default '22:00',
  quiet_hours_end       time not null default '08:00'
);

-- ---------------------------------------------------------------------
-- 2. Doctors, slots and appointments
-- ---------------------------------------------------------------------
create table public.doctors (
  id                    text primary key,            -- e.g. 'dr-tanvir-ahmed' (matches the front-end data)
  name                  text not null,
  name_bn               text,
  title                 text not null,
  title_bn              text,
  qualifications        text,
  experience_years      integer,
  photo_url             text,
  gender                text check (gender in ('female', 'male')),
  languages             text[] not null default '{}',
  languages_bn          text[] not null default '{}',
  specialties           text[] not null default '{}',
  specialties_bn        text[] not null default '{}',
  fee_bdt               integer not null check (fee_bdt >= 0),
  hospital              text,
  hospital_bn           text,
  clinic_address        text,
  clinic_address_bn     text,
  city                  text,
  city_bn               text,
  consultation_modes    text[] not null default '{online}',
  about                 text,
  about_bn              text
);

create table public.doctor_slots (
  id         uuid primary key default gen_random_uuid(),
  doctor_id  text not null references public.doctors (id) on delete cascade,
  slot_date  date not null,
  slot_time  time not null,
  mode       text not null check (mode in ('online', 'in_person')),
  unique (doctor_id, slot_date, slot_time)
);
create index doctor_slots_lookup_idx on public.doctor_slots (doctor_id, slot_date);

create table public.appointments (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references public.profiles (id) on delete cascade,
  doctor_id             text not null references public.doctors (id),
  appointment_date      date not null,
  appointment_time      time not null,
  mode                  text not null check (mode in ('online', 'in_person')),
  status                text not null default 'requested'
                        check (status in ('requested', 'confirmed', 'rescheduled', 'cancelled', 'completed', 'missed')),
  fee_bdt               integer not null check (fee_bdt >= 0),
  payment_method        text not null check (payment_method in ('bkash', 'nagad', 'card', 'pay_at_clinic')),
  payment_status        text not null default 'pending' check (payment_status in ('paid', 'pending', 'refunded')),
  reason                text,
  concerns              text[] not null default '{}',
  shared_profile        boolean not null default false,
  shared_goals          boolean not null default false,
  shared_moods          boolean not null default false,
  shared_health_basics  boolean not null default false,
  shared_reports        boolean not null default false,
  rating                smallint check (rating between 1 and 5),
  feedback              text,
  doctor_note           text,
  cancellation_reason   text,
  created_at            timestamptz not null default now()
);
create index appointments_user_idx on public.appointments (user_id, appointment_date desc);

-- The database itself prevents double booking, even if two people tap at once.
create unique index appointments_doctor_slot_uq
  on public.appointments (doctor_id, appointment_date, appointment_time)
  where status in ('requested', 'confirmed', 'rescheduled');

create unique index appointments_user_slot_uq
  on public.appointments (user_id, appointment_date, appointment_time)
  where status in ('requested', 'confirmed', 'rescheduled');

-- Slots plus a "booked" flag, without exposing who booked them.
create view public.doctor_slot_availability as
select s.id, s.doctor_id, s.slot_date, s.slot_time, s.mode,
       exists (
         select 1 from public.appointments a
         where a.doctor_id = s.doctor_id
           and a.appointment_date = s.slot_date
           and a.appointment_time = s.slot_time
           and a.status in ('requested', 'confirmed', 'rescheduled')
       ) as is_booked
from public.doctor_slots s;

-- What each person lets each doctor see, and a log of what was viewed.
create table public.doctor_access (
  user_id                uuid not null references public.profiles (id) on delete cascade,
  doctor_id              text not null references public.doctors (id) on delete cascade,
  can_view_profile       boolean not null default false,
  can_view_goals         boolean not null default false,
  can_view_moods         boolean not null default false,
  can_view_health_basics boolean not null default false,
  can_view_reports       boolean not null default false,
  primary key (user_id, doctor_id)
);

create table public.access_logs (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles (id) on delete cascade,
  doctor_id    text references public.doctors (id) on delete set null,
  doctor_name  text not null,
  items_viewed text[] not null default '{}',
  viewed_at    timestamptz not null default now()
);
create index access_logs_user_idx on public.access_logs (user_id, viewed_at desc);

-- ---------------------------------------------------------------------
-- 3. Goals, check-ins, rewards
-- ---------------------------------------------------------------------
-- owner_id NULL  = shared catalogue goal visible to everyone.
-- owner_id set   = a goal assigned to one person (e.g. suggested by a doctor).
create table public.goals (
  id                   text primary key,
  owner_id             uuid references public.profiles (id) on delete cascade,
  title                text not null,
  title_bn             text,
  category             text not null check (category in
                         ('breathing', 'mindfulness', 'walk', 'journal', 'reading', 'hydration', 'sleep', 'doctor')),
  duration_minutes     integer not null default 5,
  min_duration_seconds integer not null default 15,
  points_reward        integer not null default 10 check (points_reward >= 0),
  source               text not null default 'suggested' check (source in ('suggested', 'choice', 'doctor')),
  doctor_name          text,
  description          text,
  description_bn       text,
  steps                jsonb not null default '[]'     -- [{ "text": "...", "textBn": "..." }]
);

create table public.goal_completions (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles (id) on delete cascade,
  goal_id        text not null references public.goals (id) on delete cascade,
  completed_on   date not null,
  points_awarded integer not null default 0,
  completed_at   timestamptz not null default now(),
  unique (user_id, goal_id, completed_on)               -- a goal counts once per day
);
create index goal_completions_user_idx on public.goal_completions (user_id, completed_on desc);

create table public.check_ins (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles (id) on delete cascade,
  checkin_date  date not null default ((now() at time zone 'Asia/Dhaka')::date),
  mood          text not null check (mood in ('peaceful', 'good', 'neutral', 'struggling', 'heavy')),
  craving_level smallint not null check (craving_level between 0 and 10),
  triggers      text[] not null default '{}',
  notes         text,
  created_at    timestamptz not null default now()
);
create index check_ins_user_idx on public.check_ins (user_id, checkin_date desc);

create table public.rewards (
  id             text primary key,
  type           text not null check (type in ('badge', 'perk', 'voucher', 'downloadable')),
  name           text not null,
  name_bn        text,
  points_cost    integer not null check (points_cost >= 0),
  category       text,
  category_bn    text,
  description    text,
  description_bn text,
  icon           text,
  rarity         text
);

create table public.redeemed_rewards (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles (id) on delete cascade,
  reward_id    text not null references public.rewards (id),
  points_spent integer not null,
  code         text,
  redeemed_at  timestamptz not null default now()
);
create index redeemed_rewards_user_idx on public.redeemed_rewards (user_id, redeemed_at desc);

-- ---------------------------------------------------------------------
-- 4. Medical reports, notifications, chat
-- ---------------------------------------------------------------------
create table public.medical_reports (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null references public.profiles (id) on delete cascade,
  title                  text not null,
  file_name              text not null,
  file_size_bytes        bigint,
  storage_path           text not null,                -- '<user_id>/<file>' in the private bucket below
  extracted_values       jsonb not null default '[]',
  lifestyle_tips         text[] not null default '{}',
  lifestyle_tips_bn      text[] not null default '{}',
  doctor_type_to_see     text,
  doctor_type_to_see_bn  text,
  shared_with_doctor_ids text[] not null default '{}',
  uploaded_at            timestamptz not null default now()
);
create index medical_reports_user_idx on public.medical_reports (user_id, uploaded_at desc);

create table public.notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,
  category   text not null check (category in
               ('goals', 'visits', 'subscription', 'rewards', 'motivation', 'security')),
  title      text not null,
  title_bn   text,
  body       text not null,
  body_bn    text,
  link       text,
  read       boolean not null default false,
  created_at timestamptz not null default now()
);
create index notifications_user_idx on public.notifications (user_id, created_at desc);

create table public.chat_messages (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.profiles (id) on delete cascade,
  sender           text not null check (sender in ('user', 'assistant', 'system')),
  text             text not null,
  is_reported      boolean not null default false,
  has_coping_tools boolean not null default false,
  created_at       timestamptz not null default now()
);
create index chat_messages_user_idx on public.chat_messages (user_id, created_at);

-- Things the assistant "remembers". Only allowed while the person has consented.
create table public.chat_memories (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,
  content    text not null,
  created_at timestamptz not null default now()
);
create index chat_memories_user_idx on public.chat_memories (user_id);

-- ---------------------------------------------------------------------
-- 5. New-user trigger: create the profile and default rows at sign-up
-- ---------------------------------------------------------------------
-- The front end passes these in supabase.auth.signUp({ options: { data: {...} } }):
--   nickname, language ('en' | 'bn'), consent_ai_help, consent_chatbot_memory,
--   consent_share_with_doctors  (each 'true' / 'false')
-- Plan, points, status etc. are NEVER read from client-supplied data.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
begin
  insert into public.profiles (
    id, nickname, language, phone,
    consent_ai_help, consent_chatbot_memory, consent_share_with_doctors,
    terms_accepted_at, points
  ) values (
    new.id,
    coalesce(nullif(trim(meta ->> 'nickname'), ''), 'Friend'),
    case when meta ->> 'language' = 'bn' then 'bn' else 'en' end,
    nullif(new.phone, ''),
    coalesce((meta ->> 'consent_ai_help') = 'true', false),
    coalesce((meta ->> 'consent_chatbot_memory') = 'true', false),
    coalesce((meta ->> 'consent_share_with_doctors') = 'true', false),
    now(),
    50                                  -- welcome points, as in the prototype
  );
  insert into public.user_preferences (user_id) values (new.id);
  insert into public.health_basics (user_id) values (new.id);
  insert into public.notification_settings (user_id) values (new.id);
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------
-- 6. Functions (RPCs) for everything the client must not forge
-- ---------------------------------------------------------------------

-- 6a. Book a visit. Fee comes from the doctor row, never from the client.
create or replace function public.book_appointment(
  p_doctor_id      text,
  p_date           date,
  p_time           time,
  p_mode           text,
  p_payment_method text,
  p_reason         text default null,
  p_concerns       text[] default '{}',
  p_shared         jsonb default '{}'::jsonb
) returns public.appointments
language plpgsql security definer set search_path = public as $$
declare
  v_uid        uuid := auth.uid();
  v_profile    public.profiles;
  v_doc        public.doctors;
  v_row        public.appointments;
  v_constraint text;
  v_share      boolean;
begin
  if v_uid is null then
    raise exception 'Please sign in first.' using errcode = '28000';
  end if;

  select * into v_profile from public.profiles where id = v_uid;
  if not found or v_profile.status <> 'active' then
    raise exception 'Your account is not active, so visits cannot be booked right now.';
  end if;

  select * into v_doc from public.doctors where id = p_doctor_id;
  if not found then
    raise exception 'Doctor not found.';
  end if;
  if not (p_mode = any (v_doc.consultation_modes)) then
    raise exception 'This doctor does not offer % visits.', p_mode;
  end if;

  if not exists (
    select 1 from public.doctor_slots s
    where s.doctor_id = p_doctor_id and s.slot_date = p_date
      and s.slot_time = p_time and s.mode = p_mode
  ) then
    raise exception 'That time is not available.';
  end if;

  if (p_date + p_time) <= (now() at time zone 'Asia/Dhaka') then
    raise exception 'That time has already passed.';
  end if;

  -- Data is only shared with a doctor if the person has given consent.
  v_share := v_profile.consent_share_with_doctors;

  begin
    insert into public.appointments (
      user_id, doctor_id, appointment_date, appointment_time, mode,
      status, fee_bdt, payment_method, payment_status, reason, concerns,
      shared_profile, shared_goals, shared_moods, shared_health_basics, shared_reports
    ) values (
      v_uid, p_doctor_id, p_date, p_time, p_mode,
      case when p_payment_method = 'pay_at_clinic' then 'confirmed' else 'requested' end,
      v_doc.fee_bdt, p_payment_method, 'pending', p_reason, coalesce(p_concerns, '{}'),
      v_share and coalesce((p_shared ->> 'profile') = 'true', false),
      v_share and coalesce((p_shared ->> 'goals') = 'true', false),
      v_share and coalesce((p_shared ->> 'moods') = 'true', false),
      v_share and coalesce((p_shared ->> 'healthBasics') = 'true', false),
      v_share and coalesce((p_shared ->> 'reports') = 'true', false)
    ) returning * into v_row;
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint = 'appointments_user_slot_uq' then
      raise exception 'You already have another appointment at this exact time.' using errcode = '23505';
    end if;
    raise exception 'This doctor slot was just taken. Please choose another time.' using errcode = '23505';
  end;

  return v_row;
end $$;

-- 6b. Move a visit to another slot.
create or replace function public.reschedule_appointment(
  p_id uuid, p_date date, p_time time
) returns public.appointments
language plpgsql security definer set search_path = public as $$
declare
  v_uid        uuid := auth.uid();
  v_apt        public.appointments;
  v_constraint text;
begin
  if v_uid is null then
    raise exception 'Please sign in first.' using errcode = '28000';
  end if;

  select * into v_apt from public.appointments
   where id = p_id and user_id = v_uid for update;
  if not found then
    raise exception 'Appointment not found.';
  end if;
  if v_apt.status not in ('requested', 'confirmed', 'rescheduled') then
    raise exception 'This appointment can no longer be rescheduled.';
  end if;

  if not exists (
    select 1 from public.doctor_slots s
    where s.doctor_id = v_apt.doctor_id and s.slot_date = p_date
      and s.slot_time = p_time and s.mode = v_apt.mode
  ) then
    raise exception 'That time is not available.';
  end if;
  if (p_date + p_time) <= (now() at time zone 'Asia/Dhaka') then
    raise exception 'That time has already passed.';
  end if;

  begin
    update public.appointments
       set appointment_date = p_date, appointment_time = p_time, status = 'rescheduled'
     where id = p_id
     returning * into v_apt;
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint = 'appointments_user_slot_uq' then
      raise exception 'You already have another appointment at this exact time.' using errcode = '23505';
    end if;
    raise exception 'This doctor slot was just taken. Please choose another time.' using errcode = '23505';
  end;

  return v_apt;
end $$;

-- 6c. Cancel a visit. (Marks a paid visit as refunded; the real money
--     movement still has to be done through the payment provider.)
create or replace function public.cancel_appointment(
  p_id uuid, p_reason text default null
) returns public.appointments
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_apt public.appointments;
begin
  if v_uid is null then
    raise exception 'Please sign in first.' using errcode = '28000';
  end if;

  update public.appointments
     set status = 'cancelled',
         cancellation_reason = p_reason,
         payment_status = case when payment_status = 'paid' then 'refunded' else payment_status end
   where id = p_id and user_id = v_uid
     and status in ('requested', 'confirmed', 'rescheduled')
   returning * into v_apt;

  if not found then
    raise exception 'Appointment not found or already closed.';
  end if;
  return v_apt;
end $$;

-- 6d. Complete a goal: once per day, awards points, keeps the streak honest.
create or replace function public.complete_goal(p_goal_id text)
returns table (points_earned integer, total_points integer, streak_days integer)
language plpgsql security definer set search_path = public as $$
declare
  v_uid   uuid := auth.uid();
  v_goal  public.goals;
  v_today date := (now() at time zone 'Asia/Dhaka')::date;
  v_rows  integer;
  v_prof  public.profiles;
  v_streak integer;
begin
  if v_uid is null then
    raise exception 'Please sign in first.' using errcode = '28000';
  end if;

  select * into v_goal from public.goals
   where id = p_goal_id and (owner_id is null or owner_id = v_uid);
  if not found then
    raise exception 'Goal not found.';
  end if;

  select * into v_prof from public.profiles where id = v_uid for update;
  if not found or v_prof.status <> 'active' then
    raise exception 'Your account is not active.';
  end if;

  insert into public.goal_completions (user_id, goal_id, completed_on, points_awarded)
  values (v_uid, p_goal_id, v_today, v_goal.points_reward)
  on conflict (user_id, goal_id, completed_on) do nothing;
  get diagnostics v_rows = row_count;

  if v_rows = 0 then                       -- already done today: no extra points
    return query select 0, v_prof.points, v_prof.streak_days;
    return;
  end if;

  v_streak := case
    when v_prof.last_goal_date = v_today then v_prof.streak_days
    when v_prof.last_goal_date = v_today - 1 then v_prof.streak_days + 1
    else 1
  end;

  update public.profiles
     set points = points + v_goal.points_reward,
         streak_days = v_streak,
         last_goal_date = v_today
   where id = v_uid;

  return query select v_goal.points_reward, v_prof.points + v_goal.points_reward, v_streak;
end $$;

-- 6e. Redeem a reward with points.
create or replace function public.redeem_reward(p_reward_id text)
returns public.redeemed_rewards
language plpgsql security definer set search_path = public as $$
declare
  v_uid    uuid := auth.uid();
  v_reward public.rewards;
  v_points integer;
  v_row    public.redeemed_rewards;
begin
  if v_uid is null then
    raise exception 'Please sign in first.' using errcode = '28000';
  end if;

  select * into v_reward from public.rewards where id = p_reward_id;
  if not found then
    raise exception 'Reward not found.';
  end if;

  select points into v_points from public.profiles where id = v_uid for update;
  if v_points < v_reward.points_cost then
    raise exception 'Not enough points yet.';
  end if;

  if v_reward.type = 'badge' and exists (
    select 1 from public.redeemed_rewards where user_id = v_uid and reward_id = p_reward_id
  ) then
    raise exception 'You already have this badge.';
  end if;

  update public.profiles set points = points - v_reward.points_cost where id = v_uid;

  insert into public.redeemed_rewards (user_id, reward_id, points_spent, code)
  values (
    v_uid, p_reward_id, v_reward.points_cost,
    case when v_reward.type in ('voucher', 'perk')
         then upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)) end
  )
  returning * into v_row;

  return v_row;
end $$;

-- 6f. Account actions (status is not directly editable by the client).
create or replace function public.pause_account()
returns void language sql security definer set search_path = public as $$
  update public.profiles set status = 'paused'
   where id = auth.uid() and status = 'active';
$$;

create or replace function public.resume_account()
returns void language sql security definer set search_path = public as $$
  update public.profiles set status = 'active'
   where id = auth.uid() and status = 'paused';
$$;

-- 7-day grace period, as in the prototype. A scheduled job must do the final purge (see notes below).
create or replace function public.request_account_deletion()
returns void language sql security definer set search_path = public as $$
  update public.profiles
     set status = 'pending_deletion',
         deletion_scheduled_for = now() + interval '7 days'
   where id = auth.uid() and status in ('active', 'paused');
$$;

create or replace function public.cancel_account_deletion()
returns void language sql security definer set search_path = public as $$
  update public.profiles
     set status = 'active', deletion_scheduled_for = null
   where id = auth.uid() and status = 'pending_deletion';
$$;

-- Only signed-in users may call these (the default is "everyone").
revoke execute on function
  public.book_appointment(text, date, time, text, text, text, text[], jsonb),
  public.reschedule_appointment(uuid, date, time),
  public.cancel_appointment(uuid, text),
  public.complete_goal(text),
  public.redeem_reward(text),
  public.pause_account(),
  public.resume_account(),
  public.request_account_deletion(),
  public.cancel_account_deletion()
from public, anon;

grant execute on function
  public.book_appointment(text, date, time, text, text, text, text[], jsonb),
  public.reschedule_appointment(uuid, date, time),
  public.cancel_appointment(uuid, text),
  public.complete_goal(text),
  public.redeem_reward(text),
  public.pause_account(),
  public.resume_account(),
  public.request_account_deletion(),
  public.cancel_account_deletion()
to authenticated;

-- ---------------------------------------------------------------------
-- 7. Table privileges (what each role may even attempt)
-- ---------------------------------------------------------------------
revoke all on all tables in schema public from anon, authenticated;

-- Public catalogue (the signed-out site can list doctors and open slots).
grant select on public.doctors, public.doctor_slot_availability to anon, authenticated;
grant select on public.doctor_slots to authenticated;
grant select on public.rewards to authenticated;
grant select on public.goals to authenticated;

-- Profile: read all own columns, edit only the harmless ones.
-- (points, plan, status, streak and consents-of-record are server-controlled.)
grant select on public.profiles to authenticated;
grant update (nickname, full_name, phone, dob, gender, city, language, timezone, avatar,
              custom_avatar_url, consent_ai_help, consent_chatbot_memory,
              consent_share_with_doctors)
  on public.profiles to authenticated;

grant select, update on public.user_preferences, public.health_basics,
                        public.notification_settings to authenticated;
grant select, insert, update, delete on public.trusted_contacts to authenticated;
grant select, insert, update, delete on public.doctor_access to authenticated;
grant select on public.access_logs to authenticated;

-- Appointments are created/changed only through the RPCs above;
-- the person may rate a finished visit.
grant select on public.appointments to authenticated;
grant update (rating, feedback) on public.appointments to authenticated;

grant select on public.goal_completions, public.redeemed_rewards to authenticated;
grant select, insert, update, delete on public.check_ins, public.medical_reports to authenticated;

grant select, delete on public.notifications to authenticated;
grant update (read) on public.notifications to authenticated;

grant select, insert, delete on public.chat_messages to authenticated;
grant update (is_reported) on public.chat_messages to authenticated;
grant select, insert, delete on public.chat_memories to authenticated;

-- ---------------------------------------------------------------------
-- 8. Row-level security
-- ---------------------------------------------------------------------
alter table public.profiles              enable row level security;
alter table public.user_preferences      enable row level security;
alter table public.health_basics         enable row level security;
alter table public.trusted_contacts      enable row level security;
alter table public.notification_settings enable row level security;
alter table public.doctors               enable row level security;
alter table public.doctor_slots          enable row level security;
alter table public.appointments          enable row level security;
alter table public.doctor_access         enable row level security;
alter table public.access_logs           enable row level security;
alter table public.goals                 enable row level security;
alter table public.goal_completions      enable row level security;
alter table public.check_ins             enable row level security;
alter table public.rewards               enable row level security;
alter table public.redeemed_rewards      enable row level security;
alter table public.medical_reports       enable row level security;
alter table public.notifications         enable row level security;
alter table public.chat_messages         enable row level security;
alter table public.chat_memories         enable row level security;

-- Public catalogues
create policy "doctors are public"       on public.doctors      for select to anon, authenticated using (true);
create policy "slots readable"           on public.doctor_slots for select to authenticated using (true);
create policy "rewards readable"         on public.rewards      for select to authenticated using (true);
create policy "catalogue and own goals"  on public.goals        for select to authenticated
  using (owner_id is null or owner_id = (select auth.uid()));

-- Own-row policies
create policy "own profile read"   on public.profiles for select to authenticated using (id = (select auth.uid()));
create policy "own profile update" on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy "own preferences"  on public.user_preferences      for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own health notes" on public.health_basics         for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own notif settings" on public.notification_settings for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own trusted contacts" on public.trusted_contacts  for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own doctor access" on public.doctor_access        for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own access log"   on public.access_logs           for select to authenticated
  using (user_id = (select auth.uid()));

create policy "own appointments read" on public.appointments for select to authenticated
  using (user_id = (select auth.uid()));
create policy "rate own finished visit" on public.appointments for update to authenticated
  using (user_id = (select auth.uid()) and status = 'completed')
  with check (user_id = (select auth.uid()));

create policy "own goal history"   on public.goal_completions for select to authenticated
  using (user_id = (select auth.uid()));
create policy "own check-ins"      on public.check_ins         for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own redemptions"    on public.redeemed_rewards  for select to authenticated
  using (user_id = (select auth.uid()));
create policy "own reports"        on public.medical_reports   for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy "own notifications read"   on public.notifications for select to authenticated
  using (user_id = (select auth.uid()));
create policy "own notifications update" on public.notifications for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own notifications delete" on public.notifications for delete to authenticated
  using (user_id = (select auth.uid()));

create policy "own chat read"   on public.chat_messages for select to authenticated using (user_id = (select auth.uid()));
create policy "own chat write"  on public.chat_messages for insert to authenticated
  with check (user_id = (select auth.uid()) and sender = 'user');
create policy "own chat report" on public.chat_messages for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own chat delete" on public.chat_messages for delete to authenticated
  using (user_id = (select auth.uid()));

create policy "own memories read"   on public.chat_memories for select to authenticated using (user_id = (select auth.uid()));
create policy "own memories delete" on public.chat_memories for delete to authenticated using (user_id = (select auth.uid()));
create policy "memories need consent" on public.chat_memories for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.profiles p
                where p.id = (select auth.uid()) and p.consent_chatbot_memory)
  );

-- ---------------------------------------------------------------------
-- 9. Private file storage for medical reports
-- ---------------------------------------------------------------------
-- Files are stored under '<user id>/<file name>'; only that user can touch them.
insert into storage.buckets (id, name, public)
values ('medical-reports', 'medical-reports', false)
on conflict (id) do nothing;

create policy "own report files read" on storage.objects for select to authenticated
  using (bucket_id = 'medical-reports' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "own report files upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'medical-reports' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "own report files delete" on storage.objects for delete to authenticated
  using (bucket_id = 'medical-reports' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- ---------------------------------------------------------------------
-- NOTES for later steps (not enabled here)
--   * Final account purge: schedule a daily job (pg_cron) that deletes
--     auth users whose profiles.deletion_scheduled_for has passed.
--   * Payments: payment_status should only be flipped to 'paid' by a
--     server-side webhook (Supabase Edge Function with the service-role key).
--   * Doctor-facing reads of shared data need their own policies once
--     doctors have accounts (the prototype has no doctor login).
-- ---------------------------------------------------------------------
