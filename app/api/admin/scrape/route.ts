import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/supabase'
import { collectSerpApiLocal, scrapeSerpApiLocal } from '@/lib/scrapers/serpapi'
import { collectMLSeller, scrapeMercadoLibre, scrapeMLSeller } from '@/lib/scrapers/mercadolibre'
import { collectTargetedWebsiteSearch } from '@/lib/scrapers/targeted'
import { collectApifyTargetedSearch } from '@/lib/scrapers/apify'
import { collectAiAssistedScrape } from '@/lib/scrapers/aiAssisted'
import { saveScrapeRunItems, scrapeItemsToCsv, supplyItemsToCsv, type ScrapeCollectResult } from '@/lib/adminScrapeExport'
import type { TargetSearchSiteKey } from '@/lib/types'

function checkSecret(req: NextRequest): boolean {
  const adminSecret = process.env.ADMIN_SECRET
  const secret = req.headers.get('x-admin-secret') ?? req.nextUrl.searchParams.get('secret')
  if (!adminSecret) {
    return !secret || secret === 'undefined' || secret === 'null' || secret === ''
  }
  return secret === adminSecret
}

export async function POST(req: NextRequest) {
  if (!checkSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json() as {
    source: 'serpapi_google_local' | 'mercadolibre_public' | 'mercadolibre_seller' | 'targeted_website_search' | 'targeted_apify_actor' | 'ai_assisted_scrape'
    mode?: 'collect_only' | 'direct_import'
    params: Record<string, unknown>
    apiKey?: string
    apifyApiKey?: string
    geminiApiKey?: string
  }
  const { source, params, apiKey, apifyApiKey, geminiApiKey } = body
  const mode = body.mode ?? 'collect_only'

  const hasDb = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
  const runId = hasDb ? crypto.randomUUID() : `local-${Date.now()}`
  let dbRunId: string | null = null

  if (hasDb) {
    const { data: run, error: runErr } = await db
      .from('marketplace_scrape_runs')
      .insert({ id: runId, source, params, status: 'running' })
      .select('id')
      .single()

    if (runErr || !run) {
      return NextResponse.json({ error: 'Failed to create run record' }, { status: 500 })
    }
    dbRunId = run.id
  }

  try {
    if (mode === 'direct_import' && hasDb) {
      let result: { inserted: number; skipped: number; errors: number; sellerNickname?: string }

      if (source === 'serpapi_google_local') {
        result = await scrapeSerpApiLocal({
          query: String(params.query ?? ''),
          location: String(params.location ?? 'Ciudad de México, Mexico'),
          state: String(params.state ?? 'Ciudad de México'),
          category: String(params.category ?? 'servicios'),
          limit: Number(params.limit ?? 20),
          apiKey,
        })
      } else if (source === 'mercadolibre_public') {
        result = await scrapeMercadoLibre({
          query: String(params.query ?? ''),
          category: params.category ? String(params.category) : undefined,
          state: params.state ? String(params.state) : undefined,
          limit: Number(params.limit ?? 20),
          clerkUserId: params.clerkUserId ? String(params.clerkUserId) : undefined,
        })
      } else if (source === 'mercadolibre_seller') {
        result = await scrapeMLSeller({
          sellerUrl: String(params.sellerUrl ?? ''),
          category: params.category ? String(params.category) : undefined,
          limit: Number(params.limit ?? 50),
        })
      } else {
        throw new Error(`Unknown source: ${source}`)
      }

      await db.from('marketplace_scrape_runs').update({
        status: 'completed',
        count_inserted: result.inserted,
        count_skipped: result.skipped,
        count_errors: result.errors,
        completed_at: new Date().toISOString(),
      }).eq('id', dbRunId)

      return NextResponse.json({ runId: dbRunId, mode, ...result })
    }

    let result: ScrapeCollectResult

    if (source === 'serpapi_google_local') {
      result = await collectSerpApiLocal({
        query: String(params.query ?? ''),
        location: String(params.location ?? 'Ciudad de México, Mexico'),
        state: String(params.state ?? 'Ciudad de México'),
        category: String(params.category ?? 'servicios'),
        limit: Number(params.limit ?? 20),
        apiKey,
      })
    } else if (source === 'mercadolibre_seller') {
      result = await collectMLSeller({
        sellerUrl: String(params.sellerUrl ?? ''),
        category: params.category ? String(params.category) : undefined,
        limit: Number(params.limit ?? 50),
      })
    } else if (source === 'targeted_website_search') {
      result = await collectTargetedWebsiteSearch({
        query: String(params.query ?? ''),
        targetSite: String(params.targetSite ?? 'mercadolibre') as TargetSearchSiteKey,
        category: params.category ? String(params.category) : undefined,
        state: params.state ? String(params.state) : undefined,
        location: params.location ? String(params.location) : undefined,
        limit: Number(params.limit ?? 20),
        apiKey,
      })
    } else if (source === 'targeted_apify_actor') {
      result = await collectApifyTargetedSearch({
        query: params.query ? String(params.query) : undefined,
        targetSite: String(params.targetSite ?? 'mercadolibre') as TargetSearchSiteKey,
        category: params.category ? String(params.category) : undefined,
        state: params.state ? String(params.state) : undefined,
        location: params.location ? String(params.location) : undefined,
        limit: Number(params.limit ?? 20),
        apiKey: apifyApiKey,
        apifyMode: params.apifyMode === 'urls' ? 'urls' : 'filters',
        urls: params.urls ? String(params.urls) : undefined,
        ignoreUrlFailures: params.ignoreUrlFailures !== false,
        propertyType: params.propertyType ? String(params.propertyType) : undefined,
        operationType: params.operationType ? String(params.operationType) : undefined,
        publishedDate: params.publishedDate ? String(params.publishedDate) : undefined,
        sortBy: params.sortBy ? String(params.sortBy) : undefined,
        page: params.page ? Number(params.page) : undefined,
        maxRetries: params.maxRetries ? Number(params.maxRetries) : undefined,
        searchCategory: params.searchCategory ? String(params.searchCategory) : undefined,
        domainCode: params.domainCode ? String(params.domainCode) : undefined,
        fastMode: params.fastMode !== false,
        vehicleYear: params.vehicleYear ? Number(params.vehicleYear) : undefined,
      })
    } else if (source === 'ai_assisted_scrape') {
      result = await collectAiAssistedScrape({
        inputMode: params.inputMode === 'urls' || params.inputMode === 'mercadolibre_seller' || params.inputMode === 'inmuebles24_search'
          ? params.inputMode
          : 'search',
        query: params.query ? String(params.query) : undefined,
        urls: params.urls ? String(params.urls) : undefined,
        targetSite: String(params.targetSite ?? 'mercadolibre') as TargetSearchSiteKey,
        category: params.category ? String(params.category) : undefined,
        listingType: params.listingType === 'service' || params.listingType === 'rental' || params.listingType === 'digital'
          ? params.listingType
          : 'product',
        state: params.state ? String(params.state) : undefined,
        municipio: params.municipio ? String(params.municipio) : undefined,
        location: params.location ? String(params.location) : undefined,
        limit: Number(params.limit ?? 20),
        serpApiKey: apiKey,
        geminiApiKey,
        assistMode: params.assistMode === 'normalize' ? 'normalize' : 'enrich',
        imageEnrichment: params.imageEnrichment !== false,
        strictItemPages: params.strictItemPages !== false,
      })
    } else if (source === 'mercadolibre_public') {
      throw new Error('ML keyword search remains blocked for Mexico. Use Seller Targeting or the new /supply CSV workflow.')
    } else {
      throw new Error(`Unknown source: ${source}`)
    }

    if (hasDb && dbRunId) {
      await saveScrapeRunItems(dbRunId, result.items)

      await db.from('marketplace_scrape_runs').update({
        status: 'completed',
        count_inserted: result.items.length,
        count_skipped: result.skipped,
        count_errors: result.errors,
        completed_at: new Date().toISOString(),
      }).eq('id', dbRunId)
    }

    const csvData = source === 'ai_assisted_scrape'
      ? supplyItemsToCsv(result.items)
      : !hasDb ? scrapeItemsToCsv(result.items) : undefined

    return NextResponse.json({
      runId: dbRunId ?? runId,
      mode,
      inserted: result.items.length,
      collected: result.items.length,
      skipped: result.skipped,
      errors: result.errors,
      sellerNickname: result.sellerNickname,
      stats: result.stats,
      csvData,
      items: result.items,
    })
  } catch (e) {
    if (hasDb && dbRunId) {
      await db.from('marketplace_scrape_runs').update({
        status: 'failed',
        error_message: String(e),
        completed_at: new Date().toISOString(),
      }).eq('id', dbRunId)
    }
    return NextResponse.json({ error: String(e), runId: dbRunId ?? runId }, { status: 500 })
  }
}
