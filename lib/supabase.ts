import { createClient, type SupabaseClient } from '@supabase/supabase-js'

let cachedDb: SupabaseClient | null = null

function getDb(): SupabaseClient {
  if (cachedDb) return cachedDb

  const supabaseUrl = process.env.SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  }

  cachedDb = createClient(supabaseUrl, serviceRoleKey)
  return cachedDb
}

export const db = new Proxy({} as SupabaseClient, {
  get(_target, prop, receiver) {
    const client = getDb()
    const value = Reflect.get(client, prop, receiver)
    return typeof value === 'function' ? value.bind(client) : value
  },
})
