import { db } from './supabase'

export interface ScrapeCollectedItem {
  source_platform: string
  source_url: string | null
  source_id?: string | null
  shop_name: string | null
  shop_source_url?: string | null
  listing_title: string | null
  listing_description?: string | null
  price_cents?: number | null
  currency?: string | null
  condition?: string | null
  listing_type: 'product' | 'service' | 'rental' | 'digital'
  category?: string | null
  state?: string | null
  municipio?: string | null
  location?: string | null
  image_url?: string | null
  raw_data?: Record<string, unknown>
}

export interface ScrapeCollectResult {
  items: ScrapeCollectedItem[]
  skipped: number
  errors: number
  sellerNickname?: string
}

export const SCRAPE_CSV_HEADERS = [
  'source_url',
  'title',
  'description',
  'price',
  'shop_name',
  'location',
  'state',
  'municipio',
  'image_url',
  'category',
  'listing_type',
  'condition',
] as const

export function priceFromCents(priceCents: number | null | undefined): string {
  if (priceCents === null || priceCents === undefined) return ''
  return (priceCents / 100).toFixed(2)
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value)
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`
  return text
}

export function scrapeItemsToCsv(items: ScrapeCollectedItem[]): string {
  const lines = [
    SCRAPE_CSV_HEADERS.join(','),
    ...items.map(item => [
      item.source_url ?? '',
      item.listing_title ?? '',
      item.listing_description ?? '',
      priceFromCents(item.price_cents),
      item.shop_name ?? '',
      item.location ?? '',
      item.state ?? '',
      item.municipio ?? '',
      item.image_url ?? '',
      item.category ?? '',
      item.listing_type,
      item.condition ?? '',
    ].map(csvCell).join(',')),
  ]
  return `${lines.join('\n')}\n`
}

export async function saveScrapeRunItems(runId: string, items: ScrapeCollectedItem[]) {
  if (items.length === 0) return
  const seenSourceUrls = new Set<string>()
  const deduped = items.filter(item => {
    if (!item.source_url) return true
    if (seenSourceUrls.has(item.source_url)) return false
    seenSourceUrls.add(item.source_url)
    return true
  })
  const rows = deduped.map(item => ({
    run_id: runId,
    source_platform: item.source_platform,
    source_url: item.source_url,
    source_id: item.source_id ?? null,
    shop_name: item.shop_name,
    shop_source_url: item.shop_source_url ?? null,
    listing_title: item.listing_title,
    listing_description: item.listing_description ?? null,
    price_cents: item.price_cents ?? null,
    currency: item.currency ?? 'MXN',
    condition: item.condition ?? null,
    listing_type: item.listing_type,
    category: item.category ?? null,
    state: item.state ?? null,
    municipio: item.municipio ?? null,
    location: item.location ?? null,
    image_url: item.image_url ?? null,
    raw_data: item.raw_data ?? {},
    status: 'collected',
  }))

  const { error } = await db
    .from('marketplace_scrape_run_items')
    .insert(rows)

  if (error) throw new Error(`Failed to save scrape items: ${error.message}`)
}

export async function getScrapeRunItems(runId: string): Promise<ScrapeCollectedItem[]> {
  const { data, error } = await db
    .from('marketplace_scrape_run_items')
    .select('source_platform, source_url, source_id, shop_name, shop_source_url, listing_title, listing_description, price_cents, currency, condition, listing_type, category, state, municipio, location, image_url, raw_data')
    .eq('run_id', runId)
    .order('created_at', { ascending: true })

  if (error) throw new Error(`Failed to load scrape items: ${error.message}`)
  return (data ?? []).map(row => ({
    source_platform: String(row.source_platform),
    source_url: row.source_url,
    source_id: row.source_id,
    shop_name: row.shop_name,
    shop_source_url: row.shop_source_url,
    listing_title: row.listing_title,
    listing_description: row.listing_description,
    price_cents: row.price_cents,
    currency: row.currency,
    condition: row.condition,
    listing_type: row.listing_type,
    category: row.category,
    state: row.state,
    municipio: row.municipio,
    location: row.location,
    image_url: row.image_url,
    raw_data: row.raw_data,
  })) as ScrapeCollectedItem[]
}
