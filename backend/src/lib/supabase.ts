/**
 * Optional Supabase client — returns null if env vars are not set.
 */
import process from 'node:process';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

let _client: SupabaseClient | null = null;
let _checked = false;

export function getSupabase(): SupabaseClient | null {
  if (_checked) return _client;
  _checked = true;

  const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;

  if (url && key) {
    _client = createClient(url, key);
    console.log('[supabase] Client initialized');
  } else {
    console.log('[supabase] No SUPABASE_URL/SUPABASE_ANON_KEY — running in-memory mode');
    _client = null;
  }

  return _client;
}
