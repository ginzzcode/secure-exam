import { createClient } from '@supabase/supabase-js'
import { readEnv } from './env.js'

const { supabaseUrl, supabaseAnonKey, isConfigured } = readEnv()

export const supabase = isConfigured
  ? createClient(supabaseUrl, supabaseAnonKey)
  : null
