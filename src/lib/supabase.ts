import { createClient } from '@supabase/supabase-js'

const supabaseUrl = 'https://axwepvqpzsrfhrigryqt.supabase.co'
const supabaseAnonKey = 'sb_publishable_dB4g4UP9O3i5zd4K8ZrFdA_xP6yyw4_'

export const supabase = createClient(supabaseUrl, supabaseAnonKey)
