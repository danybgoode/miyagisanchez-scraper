import type { FieldCandidate, ScrapeCollectedItem, ScrapeCollectResult } from '../adminScrapeExport'
import { TARGET_SEARCH_SITES, type TargetSearchSiteKey } from '../types'
import { summarizeCollectedItems, withQuality } from './quality'

export const APIFY_ACTORS = {
  inmuebles24: {
    actorId: 'agEsf5Dts9ELt36j9',
    parserName: 'apify_inmuebles24_actor',
  },
  mercadolibre: {
    actorId: 'q0PB9Xd1hjynYAEhi',
    parserName: 'apify_mercadolibre_actor',
  },
} as const

type ApifyTargetSiteKey = keyof typeof APIFY_ACTORS

export interface ApifyTargetedSearchParams {
  targetSite: TargetSearchSiteKey
  query?: string
  category?: string
  state?: string
  location?: string
  limit?: number
  apiKey?: string

  apifyMode?: 'urls' | 'filters'
  urls?: string
  ignoreUrlFailures?: boolean
  propertyType?: string
  operationType?: string
  publishedDate?: string
  sortBy?: string
  page?: number
  maxRetries?: number

  searchCategory?: string
  domainCode?: string
  fastMode?: boolean
  vehicleYear?: number
}

const TARGET_SITE_MAP = Object.fromEntries(TARGET_SEARCH_SITES.map(site => [site.key, site]))

function isApifyTargetSite(site: TargetSearchSiteKey): site is ApifyTargetSiteKey {
  return site === 'inmuebles24' || site === 'mercadolibre'
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => {
      if (entry === null || entry === undefined) return false
      if (typeof entry === 'string' && entry.trim() === '') return false
      if (Array.isArray(entry) && entry.length === 0) return false
      return true
    }),
  ) as T
}

function splitUrls(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(/[\n,]+/)
    .map(url => url.trim())
    .filter(Boolean)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function readPath(record: Record<string, unknown>, path: string): unknown {
  let current: unknown = record
  for (const part of path.split('.')) {
    const obj = asRecord(current)
    if (!obj || !(part in obj)) return undefined
    current = obj[part]
  }
  return current
}

function firstString(record: Record<string, unknown>, paths: string[]): string | null {
  for (const path of paths) {
    const value = readPath(record, path)
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return null
}

function firstBoolean(record: Record<string, unknown>, paths: string[]): boolean | null {
  for (const path of paths) {
    const value = readPath(record, path)
    if (typeof value === 'boolean') return value
  }
  return null
}

function firstNumberLike(record: Record<string, unknown>, paths: string[]): string | number | null {
  for (const path of paths) {
    const value = readPath(record, path)
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim()) return value.trim()
    const obj = asRecord(value)
    if (obj) {
      const nested = firstNumberLike(obj, ['amount', 'value', 'price', 'current', 'fraction'])
      if (nested !== null) return nested
    }
  }
  return null
}

function parsePriceCents(value: string | number | null): number | null {
  if (value === null) return null
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null
    return Math.round(value * 100)
  }

  const match = value.match(/(?:MXN|M\.N\.|\$)?\s*([\d.,]+(?:\s*mil)?)/i)
  if (!match) return null
  let text = match[1].toLowerCase().replace(/\s+/g, '')
  const hasMil = text.includes('mil')
  text = text.replace(/mil/g, '')
  if (text.includes(',') && text.includes('.')) {
    text = text.replace(/,/g, '')
  } else if (text.includes(',')) {
    text = text.replace(/,/g, '')
  }
  const number = Number.parseFloat(text)
  if (!Number.isFinite(number) || number <= 0) return null
  return Math.round(number * (hasMil ? 100000 : 100))
}

function normalizeCurrency(value: string | null): string {
  if (!value) return 'MXN'
  const upper = value.toUpperCase()
  if (upper === '$' || upper === 'MN' || upper === 'M.N.') return 'MXN'
  return upper
}

function urlFromValue(value: unknown): string | null {
  if (typeof value === 'string' && /^https?:\/\//i.test(value.trim())) return value.trim()
  const obj = asRecord(value)
  if (obj) return firstString(obj, ['url', 'src', 'link', 'secure_url'])
  return null
}

function firstUrl(record: Record<string, unknown>, paths: string[]): string | null {
  for (const path of paths) {
    const value = readPath(record, path)
    if (Array.isArray(value)) {
      for (const entry of value) {
        const url = urlFromValue(entry)
        if (url) return url
      }
    }
    const url = urlFromValue(value)
    if (url) return url
  }
  return null
}

function allImageUrls(record: Record<string, unknown>): string[] {
  const paths = [
    'images',
    'imageUrls',
    'pictures',
    'photos',
    'media',
    'gallery',
    'image',
    'imageUrl',
    'thumbnail',
    'thumbnailUrl',
    'picture',
  ]
  const urls: string[] = []
  for (const path of paths) {
    const value = readPath(record, path)
    if (Array.isArray(value)) {
      for (const entry of value) {
        const url = urlFromValue(entry)
        if (url && !urls.includes(url)) urls.push(url)
      }
      continue
    }
    const url = urlFromValue(value)
    if (url && !urls.includes(url)) urls.push(url)
  }
  return urls
}

function candidates<T extends string | number>(value: T | null, source: string): FieldCandidate[] {
  return value === null || value === '' ? [] : [{ value, source }]
}

function mapApifyItem(
  raw: Record<string, unknown>,
  targetSite: ApifyTargetSiteKey,
  params: ApifyTargetedSearchParams,
): ScrapeCollectedItem {
  const target = TARGET_SITE_MAP[targetSite]
  const images = allImageUrls(raw)
  const sourceUrl = firstUrl(raw, [
    'url',
    'link',
    'href',
    'permalink',
    'productUrl',
    'product_url',
    'itemUrl',
    'item_url',
    'listingUrl',
    'listing_url',
    'propertyUrl',
    'property_url',
    'canonicalUrl',
    'canonical_url',
  ])
  const title = firstString(raw, [
    'title',
    'name',
    'headline',
    'productTitle',
    'product_title',
    'listingTitle',
    'listing_title',
    'propertyTitle',
    'property_title',
  ])
  const description = firstString(raw, [
    'description',
    'shortDescription',
    'short_description',
    'listingDescription',
    'listing_description',
    'propertyDescription',
    'property_description',
    'summary',
  ])
  const priceValue = firstNumberLike(raw, [
    'price',
    'priceValue',
    'price_value',
    'priceAmount',
    'price_amount',
    'currentPrice',
    'current_price',
    'salePrice',
    'sale_price',
    'amount',
    'price.amount',
    'price.value',
    'price.current',
  ])
  const priceCents = parsePriceCents(priceValue)
  const currency = normalizeCurrency(firstString(raw, [
    'currency',
    'currencyId',
    'currency_id',
    'priceCurrency',
    'price_currency',
    'price.currency',
  ]))
  const shopName = firstString(raw, [
    'shopName',
    'shop_name',
    'sellerName',
    'seller_name',
    'seller.nickname',
    'seller.name',
    'seller',
    'publisher.name',
    'publisherName',
    'publisher_name',
    'advertiser.name',
    'agency.name',
  ])
  const state = params.state || firstString(raw, [
    'state',
    'location.state',
    'address.state',
    'address.region',
    'region',
  ])
  const municipio = firstString(raw, [
    'municipio',
    'municipality',
    'location.municipality',
    'address.municipality',
    'city',
    'location.city',
    'address.city',
  ])
  const location = params.location || firstString(raw, [
    'location',
    'address',
    'location.address',
    'address.full',
    'neighborhood',
    'location.neighborhood',
  ])
  const condition = firstString(raw, [
    'condition',
    'itemCondition',
    'item_condition',
    'status',
  ])
  const sourceId = firstString(raw, [
    'id',
    'itemId',
    'item_id',
    'listingId',
    'listing_id',
    'propertyId',
    'property_id',
    'externalId',
    'external_id',
  ])
  const contactPhone = firstString(raw, ['phone', 'contactPhone', 'contact_phone', 'publisher.phone', 'seller.phone'])
  const contactUrl = firstUrl(raw, ['contactUrl', 'contact_url', 'whatsappUrl', 'whatsapp_url'])
  const originalLinkValid = sourceUrl ? target.domains.some(domain => {
    try {
      const host = new URL(sourceUrl).hostname.toLowerCase().replace(/^www\./, '')
      return host === domain || host.endsWith(`.${domain}`)
    } catch {
      return false
    }
  }) : false

  return withQuality({
    source_platform: `apify_${targetSite}`,
    source_url: sourceUrl,
    source_id: sourceId,
    shop_name: shopName ?? target.label,
    shop_source_url: target.homeUrl,
    listing_title: title,
    listing_description: description,
    price_cents: priceCents,
    currency,
    condition,
    listing_type: target.defaultListingType,
    category: params.category ?? target.defaultCategory,
    state,
    municipio,
    location,
    image_url: images[0] ?? null,
    raw_data: {
      apify_actor_id: APIFY_ACTORS[targetSite].actorId,
      apify_target_site: targetSite,
      apify_raw: raw,
      canonical_url: sourceUrl,
      all_image_urls: images,
      contact_phone: contactPhone,
      contact_url: contactUrl,
      original_link_valid: originalLinkValid,
      candidates: {
        title: candidates(title, 'apify:title'),
        description: candidates(description, 'apify:description'),
        priceCents: candidates(priceCents, 'apify:price'),
        imageUrl: candidates(images[0] ?? null, 'apify:image'),
      },
    },
  }, {
    parserName: APIFY_ACTORS[targetSite].parserName,
    parserStatus: 'parsed',
    parserAttempts: ['apify_dataset_item'],
    parserNotes: [],
  })
}

function buildInmuebles24Input(params: ApifyTargetedSearchParams): Record<string, unknown> {
  const urls = splitUrls(params.urls)
  const mode = params.apifyMode ?? (urls.length > 0 ? 'urls' : 'filters')
  return compact({
    ...(mode === 'urls' ? { urls } : {}),
    ...(mode === 'filters' ? {
      keyword: params.query?.trim(),
      property_type: params.propertyType,
      operation_type: params.operationType,
      published_date: params.publishedDate,
      sort_by: params.sortBy,
      page: params.page ?? 1,
    } : {}),
    ignore_url_failures: params.ignoreUrlFailures ?? true,
    max_items_per_url: Math.max(1, Math.min(100, params.limit ?? 20)),
    max_retries_per_url: Math.max(0, Math.min(5, params.maxRetries ?? 2)),
    proxy: {
      useApifyProxy: true,
      apifyProxyGroups: ['RESIDENTIAL'],
      apifyProxyCountry: 'MX',
    },
  })
}

function buildMercadoLibreInput(params: ApifyTargetedSearchParams): Record<string, unknown> {
  return compact({
    search: params.query?.trim(),
    searchCategory: params.searchCategory || 'all',
    sortBy: params.sortBy || 'relevance',
    domainCode: params.domainCode || 'MX',
    maxItemCount: Math.max(1, Math.min(100, params.limit ?? 20)),
    fastMode: params.fastMode ?? true,
    vehicleYear: params.vehicleYear,
    proxy: {
      useApifyProxy: true,
      apifyProxyGroups: ['RESIDENTIAL'],
    },
  })
}

async function runApifyActorSync(actorId: string, input: Record<string, unknown>, apiKey: string, limit: number): Promise<Record<string, unknown>[]> {
  const url = new URL(`https://api.apify.com/v2/acts/${actorId}/run-sync-get-dataset-items`)
  url.searchParams.set('format', 'json')
  url.searchParams.set('clean', 'true')
  url.searchParams.set('limit', String(Math.max(1, Math.min(100, limit))))

  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(310000),
    cache: 'no-store',
  })

  if (!res.ok) {
    const errBody = await res.text().catch(() => '')
    const hint = res.status === 408 ? ' The synchronous Apify endpoint timed out; lower the limit or switch this actor to async polling later.' : ''
    throw new Error(`Apify HTTP ${res.status}: ${errBody.slice(0, 300)}${hint}`)
  }

  const data = await res.json() as unknown
  if (!Array.isArray(data)) throw new Error('Apify returned a non-array dataset response')
  return data.map(item => asRecord(item)).filter((item): item is Record<string, unknown> => item !== null)
}

export async function collectApifyTargetedSearch(params: ApifyTargetedSearchParams): Promise<ScrapeCollectResult> {
  const { targetSite, limit = 20 } = params
  if (!isApifyTargetSite(targetSite)) {
    throw new Error(`Apify integration is not configured for target site: ${targetSite}`)
  }

  const apiKey = params.apiKey || process.env.APIFY_TOKEN
  if (!apiKey) throw new Error('APIFY_TOKEN is not set')

  const actor = APIFY_ACTORS[targetSite]
  const input = targetSite === 'inmuebles24'
    ? buildInmuebles24Input(params)
    : buildMercadoLibreInput(params)

  const rawItems = await runApifyActorSync(actor.actorId, input, apiKey, limit)
  const seenUrls = new Set<string>()
  let duplicates = 0
  const items: ScrapeCollectedItem[] = []

  for (const raw of rawItems) {
    const item = mapApifyItem(raw, targetSite, params)
    if (item.source_url) {
      if (seenUrls.has(item.source_url)) {
        duplicates++
        continue
      }
      seenUrls.add(item.source_url)
    }
    items.push(item)
  }

  return {
    items,
    skipped: duplicates,
    errors: 0,
    stats: summarizeCollectedItems(items, {
      fetched: rawItems.length,
      parsed: items.length,
      failed: 0,
      duplicates,
      invalid: 0,
      autoSkipped: duplicates,
    }),
  }
}
