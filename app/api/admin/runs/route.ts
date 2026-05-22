import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/supabase'

export async function GET(req: NextRequest) {
  const secret = req.headers.get('x-admin-secret') ?? req.nextUrl.searchParams.get('secret')
  if (secret !== process.env.ADMIN_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const { data } = await db
    .from('marketplace_scrape_runs')
    .select('*')
    .order('started_at', { ascending: false })
    .limit(50)
  return NextResponse.json({ runs: data ?? [] })
}
