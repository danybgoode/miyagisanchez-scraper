import type { ScrapeCollectedItem, ScrapeCollectStats } from '../adminScrapeExport'

export interface ListingQualityReport {
  score: number
  status: 'strong' | 'partial' | 'weak'
  present: string[]
  missing: string[]
}

function hasText(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

function rawValue(item: ScrapeCollectedItem, key: string): unknown {
  return item.raw_data?.[key]
}

export function getListingQuality(item: ScrapeCollectedItem): ListingQualityReport {
  const present: string[] = []
  const missing: string[] = []
  let score = 0

  const add = (label: string, ok: boolean, points: number) => {
    if (ok) {
      present.push(label)
      score += points
    } else {
      missing.push(label)
    }
  }

  add('source_url', hasText(item.source_url), 15)
  add('title', hasText(item.listing_title), 20)
  add('price', typeof item.price_cents === 'number' && item.price_cents > 0, 15)
  add('image', hasText(item.image_url), 15)
  add('description', hasText(item.listing_description), 15)
  add('seller_or_contact', hasText(item.shop_name) || hasText(rawValue(item, 'contact_phone')) || hasText(rawValue(item, 'contact_url')), 10)
  add('validated_link', rawValue(item, 'original_link_valid') === true || hasText(rawValue(item, 'canonical_url')), 10)

  return {
    score,
    status: score >= 75 ? 'strong' : score >= 45 ? 'partial' : 'weak',
    present,
    missing,
  }
}

export function withQuality(
  item: ScrapeCollectedItem,
  parser: {
    parserName: string
    parserStatus?: string
    parserAttempts?: string[]
    parserNotes?: string[]
  }
): ScrapeCollectedItem {
  const quality = getListingQuality(item)
  return {
    ...item,
    raw_data: {
      ...(item.raw_data ?? {}),
      parser_name: parser.parserName,
      parser_status: parser.parserStatus ?? quality.status,
      parser_attempts: parser.parserAttempts ?? [],
      parser_notes: parser.parserNotes ?? [],
      quality_score: quality.score,
      quality_status: quality.status,
      quality_present: quality.present,
      quality_missing: quality.missing,
    },
  }
}

export function summarizeCollectedItems(
  items: ScrapeCollectedItem[],
  counters: Partial<ScrapeCollectStats> = {}
): ScrapeCollectStats {
  const scores = items.map(item => Number(item.raw_data?.quality_score ?? getListingQuality(item).score))
  const avgQuality = scores.length > 0
    ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length)
    : 0

  return {
    fetched: counters.fetched ?? items.length,
    parsed: counters.parsed ?? items.length,
    strong: counters.strong ?? items.filter(item => item.raw_data?.quality_status === 'strong').length,
    partial: counters.partial ?? items.filter(item => item.raw_data?.quality_status === 'partial').length,
    weak: counters.weak ?? items.filter(item => item.raw_data?.quality_status === 'weak').length,
    failed: counters.failed ?? 0,
    duplicates: counters.duplicates ?? 0,
    invalid: counters.invalid ?? 0,
    autoSkipped: counters.autoSkipped ?? 0,
    avgQuality,
  }
}
