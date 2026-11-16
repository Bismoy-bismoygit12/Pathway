import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/** False until VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are set in .env */
export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

// createClient throws on empty values, so placeholders keep the app loading
// (and showing a clear message) when the .env file has not been filled in yet.
export const supabase = createClient(
  supabaseUrl || 'http://localhost:54321',
  supabaseAnonKey || 'missing-anon-key',
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
    },
  }
);

export const BACKEND_NOT_CONFIGURED_MESSAGE =
  'The server connection is not set up yet. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to your .env file.';
