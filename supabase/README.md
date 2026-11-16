# Pathway backend (Supabase)

## One-time setup

1. Create a free project at https://supabase.com.
2. Open **SQL Editor**, paste `migrations/0001_init.sql`, and run it once.
3. Open **Project Settings -> API** and copy the *Project URL* and the *anon public* key.
4. Copy `.env.example` to `.env` and fill in:
   ```
   VITE_SUPABASE_URL="https://YOUR-PROJECT-ID.supabase.co"
   VITE_SUPABASE_ANON_KEY="YOUR_SUPABASE_ANON_KEY"
   ```
   Never put the `service_role` key in the front end.
5. For development, open **Authentication -> Providers -> Email** and turn off
   **Confirm email**. With it on, new people must click an emailed link before
   they can log in (the app shows a message explaining this).
6. Install and run:
   ```
   bun install      # or: npm install
   npm run lint     # type-check
   npm run dev
   ```

## What works against the server now

- Sign-up (email), log-in with password, log-out, and restoring the login after a refresh
- Profile, recovery preferences, private health notes, consents
- Trusted contacts and doctor-sharing settings
- Pause account / 7-day deletion request / cancel
- Change password

## Still using the old local demo data (next steps)

- Goals, rewards, points and streaks (the database functions exist: `complete_goal`, `redeem_reward`)
- Doctors, slots and appointments (`book_appointment`, `reschedule_appointment`, `cancel_appointment`)
- Subscription / payments, medical reports, notifications, chat history
- Forgot-password (needs Supabase's emailed reset link) and one-time-code login
- Phone sign-up/login needs an SMS provider connected in Supabase

Doctors, rewards and the goal catalogue also need to be copied into their tables
before those screens can use the server.
