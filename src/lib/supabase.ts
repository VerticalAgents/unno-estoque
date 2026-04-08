import { createClient } from '@supabase/supabase-js'

const supabaseUrl = 'https://outunfdtwgsmdqtphzgf.supabase.co'
const supabaseAnonKey = 'sb_publishable_unYJStw46kJ_rHD0VFKfkw_08T0P0oU'

export const supabase = createClient(supabaseUrl, supabaseAnonKey)
