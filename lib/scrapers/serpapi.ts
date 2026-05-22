import { db } from '../supabase'
import type { ScrapeCollectedItem, ScrapeCollectResult } from '../adminScrapeExport'

export interface SerpApiScrapeParams {
  query: string       // e.g. "taller mecánico"
  location: string    // e.g. "Ciudad de México, Mexico"
  state: string       // for DB field: e.g. "Ciudad de México"
  category?: string   // defaults to 'servicios'
  limit?: number      // default 20
}

export interface ScrapeResult {
  inserted: number
  skipped: number
  errors: number
}

interface SerpLocalResult {
  position: number
  title: string
  place_id?: string
  address?: string
  phone?: string
  rating?: number
  reviews?: number
  type?: string
  thumbnail?: string
  website?: string
  gps_coordinates?: { latitude: number; longitude: number }
}

function slugify(text: string): string {
  return text.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48)
}

/** Quality score 0–4 for a Google Local result. Min 2 required for insertion. */
function qualityScore(r: SerpLocalResult): number {
  let score = 0
  if (r.title && r.title.length >= 5) score++           // has a real name
  if (r.address) score++                                 // has an address
  if (r.phone || r.website) score++                     // has contact info
  if (r.thumbnail) score++                               // has photo
  return score
}

export async function scrapeSerpApiLocal(params: SerpApiScrapeParams): Promise<ScrapeResult> {
  const collected = await collectSerpApiLocal(params)
  const { query, location, state, category = 'servicios' } = params

  let inserted = 0, skipped = collected.skipped, errors = collected.errors

  for (const item of collected.items) {
    try {
      if (!item.source_url || !item.listing_title) { skipped++; continue }

      const { data: existing } = await db
        .from('marketplace_shops')
        .select('id')
        .eq('source_url', item.source_url)
        .maybeSingle()

      if (existing) { skipped++; continue }

      const raw = item.raw_data as Partial<SerpLocalResult> | undefined
      const shopMetadata: Record<string, unknown> = {}
      if (raw?.phone) shopMetadata.phone = raw.phone
      if (raw?.website) shopMetadata.website = raw.website
      if (raw?.rating) shopMetadata.rating = raw.rating
      if (raw?.reviews) shopMetadata.reviews = raw.reviews

      const slug = slugify(item.listing_title) + '-' + Math.random().toString(36).slice(2, 6)
      const { data: shop, error: shopErr } = await db
        .from('marketplace_shops')
        .insert({
          slug,
          name: item.listing_title,
          location: item.location ?? location,
          source: 'scraped',
          source_url: item.source_url,
          verified: false,
          metadata: shopMetadata,
        })
        .select('id')
        .single()

      if (shopErr || !shop) { errors++; continue }

      const { error: listErr } = await db
        .from('marketplace_listings')
        .insert({
          shop_id: shop.id,
          title: item.listing_title,
          description: item.listing_description,
          listing_type: 'service',
          location: item.location ?? location,
          state: item.state ?? state,
          category: item.category ?? category,
          source: 'scraped',
          source_platform: 'google_local',
          source_url: item.source_url,
          images: item.image_url ? [{ url: item.image_url, alt: item.listing_title }] : [],
          status: 'active',
          metadata: {
            phone: raw?.phone ?? null,
            rating: raw?.rating ?? null,
            reviews: raw?.reviews ?? null,
            business_type: raw?.type ?? null,
            lat: raw?.gps_coordinates?.latitude ?? null,
            lng: raw?.gps_coordinates?.longitude ?? null,
            place_id: raw?.place_id ?? null,
            query,
          },
        })

      if (listErr) { errors++; continue }
      inserted++
    } catch {
      errors++
    }
  }

  return { inserted, skipped, errors }
}

export async function collectSerpApiLocal(params: SerpApiScrapeParams): Promise<ScrapeCollectResult> {
  const { query, location, state, category = 'servicios', limit = 20 } = params

  const url = new URL('https://serpapi.com/search.json')
  url.searchParams.set('engine', 'google_local')
  url.searchParams.set('q', query)
  url.searchParams.set('location', location)
  url.searchParams.set('hl', 'es')
  url.searchParams.set('gl', 'mx')
  url.searchParams.set('api_key', process.env.SERPAPI_KEY!)

  const res = await fetch(url.toString(), { cache: 'no-store' })
  if (!res.ok) throw new Error(`SerpAPI HTTP ${res.status}`)
  const data = await res.json() as {
    error?: string
    local_results?: SerpLocalResult[]
  }

  if (data.error) throw new Error(`SerpAPI error: ${data.error}`)
  const results: SerpLocalResult[] = (data.local_results ?? []).slice(0, limit)

  let skipped = 0, errors = 0
  const items: ScrapeCollectedItem[] = []

  for (const r of results) {
    try {
      // Quality gate - min score 2 to collect
      if (qualityScore(r) < 2) { skipped++; continue }

      const sourceUrl = r.place_id
        ? `https://maps.google.com/?cid=${r.place_id}`
        : `serpapi://local/${encodeURIComponent(r.title + '|' + (r.address ?? location))}`

      items.push({
        source_platform: 'google_local',
        source_url: sourceUrl,
        source_id: r.place_id ?? null,
        shop_name: r.title,
        shop_source_url: sourceUrl,
        listing_title: r.title,
        listing_description: [r.type, r.address].filter(Boolean).join(' - '),
        currency: 'MXN',
        listing_type: 'service',
        category,
        state,
        location: r.address ?? location,
        image_url: r.thumbnail ?? null,
        raw_data: { ...r, query, location },
      })
    } catch {
      errors++
    }
  }

  return { items, skipped, errors }
}
