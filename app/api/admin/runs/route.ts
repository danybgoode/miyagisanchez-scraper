import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/supabase'

function checkSecret(req: NextRequest): boolean {
  const adminSecret = process.env.ADMIN_SECRET
  const secret = req.headers.get('x-admin-secret') ?? req.nextUrl.searchParams.get('secret')
  if (!adminSecret) {
    return !secret || secret === 'undefined' || secret === 'null' || secret === ''
  }
  return secret === adminSecret
}

export async function GET(req: NextRequest) {
  if (!checkSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ runs: [], isLocalOnly: true })
  }

  try {
    const { data } = await db
      .from('marketplace_scrape_runs')
      .select('*')
      .order('started_at', { ascending: false })
      .limit(50)
    return NextResponse.json({ runs: data ?? [] })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
