const REQUIRED_KEYS = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY']

export function readEnv(env = import.meta.env) {
  const supabaseUrl = env.VITE_SUPABASE_URL ?? ''
  const supabaseAnonKey = env.VITE_SUPABASE_ANON_KEY ?? ''
  const missing = REQUIRED_KEYS.filter((key) => !env[key])

  return {
    supabaseUrl,
    supabaseAnonKey,
    missing,
    isConfigured: missing.length === 0,
  }
}
