import { NextRequest } from 'next/server'
import { collectAiAssistedScrape, type AiProgressEvent } from '@/lib/scrapers/aiAssisted'
import { supplyItemsToCsv } from '@/lib/adminScrapeExport'
import type { ScrapeCollectedItem } from '@/lib/adminScrapeExport'
import type { TargetSearchSiteKey } from '@/lib/types'

export const maxDuration = 300
export const dynamic = 'force-dynamic'

function checkSecret(req: NextRequest): boolean {
  const adminSecret = process.env.ADMIN_SECRET
  const secret = req.headers.get('x-admin-secret') ?? req.nextUrl.searchParams.get('secret')
  if (!adminSecret) {
    return !secret || secret === 'undefined' || secret === 'null' || secret === ''
  }
  return secret === adminSecret
}

function send(controller: ReadableStreamDefaultController<Uint8Array>, event: string, data: unknown) {
  try {
    controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ event, data })}\n`))
  } catch {
    // Client intentionally paused/cancelled the stream.
  }
}

export async function POST(req: NextRequest) {
  if (!checkSecret(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
  }

  const body = await req.json() as {
    params: Record<string, unknown>
    apiKey?: string
    geminiApiKey?: string
  }
  const { params, apiKey, geminiApiKey } = body

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const result = await collectAiAssistedScrape({
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
          assistMode: params.assistMode === 'normalize' || params.assistMode === 'url_image' ? params.assistMode : 'enrich',
          imageEnrichment: params.imageEnrichment !== false,
          strictItemPages: params.strictItemPages !== false,
          maxSerpRequests: params.maxSerpRequests ? Number(params.maxSerpRequests) : undefined,
          maxRuntimeMs: params.maxRuntimeMs ? Number(params.maxRuntimeMs) : undefined,
          excludeUrls: Array.isArray(params.excludeUrls) ? params.excludeUrls.map(String).slice(0, 500) : undefined,
          onProgress: async (event: AiProgressEvent) => {
            send(controller, 'progress', event)
          },
          onItem: async (item: ScrapeCollectedItem, index: number, total: number) => {
            send(controller, 'item', { item, index, total })
          },
        })

        send(controller, 'result', {
          runId: `local-${Date.now()}`,
          mode: 'collect_only',
          inserted: result.items.length,
          collected: result.items.length,
          skipped: result.skipped,
          errors: result.errors,
          stats: result.stats,
          csvData: supplyItemsToCsv(result.items),
          items: result.items,
        })
      } catch (error) {
        send(controller, 'error', { error: String(error) })
      } finally {
        try {
          controller.close()
        } catch {}
      }
    },
  })

  return new Response(stream, {
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}
