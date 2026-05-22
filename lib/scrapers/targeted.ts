import type { ScrapeCollectedItem, ScrapeCollectResult } from '../adminScrapeExport'
import { TARGET_SEARCH_SITES, type TargetSearchSiteKey } from '../types'
import { summarizeCollectedItems, withQuality } from './quality'

interface SerpOrganicResult {
  title?: string
  link?: string
  snippet?: string
  displayed_link?: string
}

export interface TargetedSearchParams {
  query: string
  targetSite: TargetSearchSiteKey
  category?: string
  state?: string
  location?: string
  limit?: number
}

interface ParsedListing {
  title: string | null
  description: string | null
  priceCents: number | null
  currency: string | null
  imageUrl: string | null
  images: string[]
  canonicalUrl: string | null
  shopName: string | null
  contactPhone: string | null
  contactUrl: string | null
  attempts: string[]
  notes: string[]
}

const TARGET_SITE_MAP = Object.fromEntries(TARGET_SEARCH_SITES.map(site => [site.key, site]))

function decodeHtml(text: string | null | undefined): string | null {
  if (!text) return null
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function getAttr(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i'))
  return decodeHtml(match?.[1]) ?? null
}

function metaValues(html: string): Array<{ key: string; content: string }> {
  const values: Array<{ key: string; content: string }> = []
  const re = /<meta\b[^>]*>/gi
  for (const match of html.matchAll(re)) {
    const tag = match[0]
    const key = getAttr(tag, 'property') ?? getAttr(tag, 'name') ?? getAttr(tag, 'itemprop')
    const content = getAttr(tag, 'content')
    if (key && content) values.push({ key: key.toLowerCase(), content })
  }
  return values
}

function firstMeta(meta: Array<{ key: string; content: string }>, keys: string[]): string | null {
  const wanted = new Set(keys.map(key => key.toLowerCase()))
  return meta.find(item => wanted.has(item.key))?.content ?? null
}

function titleTag(html: string): string | null {
  return decodeHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/<[^>]+>/g, '')) ?? null
}

function canonicalUrl(html: string, pageUrl: string): string | null {
  const linkTags = html.match(/<link\b[^>]*>/gi) ?? []
  for (const tag of linkTags) {
    if ((getAttr(tag, 'rel') ?? '').toLowerCase() !== 'canonical') continue
    const href = getAttr(tag, 'href')
    if (!href) continue
    try {
      return new URL(href, pageUrl).toString()
    } catch {
      return null
    }
  }
  return null
}

function extractJsonLd(html: string): unknown[] {
  const values: unknown[] = []
  const re = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  for (const match of html.matchAll(re)) {
    const body = decodeHtml(match[1])
    if (!body) continue
    try {
      values.push(JSON.parse(body))
    } catch {
      // JSON-LD on listing sites is often malformed. Meta fallback still works.
    }
  }
  return values
}

function walkJson(value: unknown, visitor: (obj: Record<string, unknown>) => void) {
  if (Array.isArray(value)) {
    value.forEach(item => walkJson(item, visitor))
    return
  }
  if (!value || typeof value !== 'object') return
  const obj = value as Record<string, unknown>
  visitor(obj)
  Object.values(obj).forEach(child => walkJson(child, visitor))
}

function firstJsonString(json: unknown[], keys: string[]): string | null {
  for (const root of json) {
    let found: string | null = null
    walkJson(root, obj => {
      if (found) return
      for (const key of keys) {
        const value = obj[key]
        if (typeof value === 'string' && value.trim()) found = decodeHtml(value)
      }
    })
    if (found) return found
  }
  return null
}

function jsonImages(json: unknown[]): string[] {
  const images: string[] = []
  for (const root of json) {
    walkJson(root, obj => {
      const value = obj.image
      if (typeof value === 'string') images.push(value)
      if (Array.isArray(value)) {
        for (const entry of value) {
          if (typeof entry === 'string') images.push(entry)
          if (entry && typeof entry === 'object' && typeof (entry as { url?: unknown }).url === 'string') {
            images.push(String((entry as { url: string }).url))
          }
        }
      }
    })
  }
  return images
}

function jsonOfferValue(json: unknown[], key: 'price' | 'priceCurrency'): string | null {
  for (const root of json) {
    let found: string | null = null
    walkJson(root, obj => {
      if (found) return
      const offers = obj.offers
      if (offers && typeof offers === 'object') {
        const offerList = Array.isArray(offers) ? offers : [offers]
        for (const offer of offerList) {
          if (!offer || typeof offer !== 'object') continue
          const value = (offer as Record<string, unknown>)[key]
          if (typeof value === 'string' || typeof value === 'number') {
            found = String(value)
            return
          }
        }
      }
      const value = obj[key]
      if (typeof value === 'string' || typeof value === 'number') found = String(value)
    })
    if (found) return found
  }
  return null
}

function parsePrice(value: string | null): number | null {
  if (!value) return null
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

function visiblePrice(html: string): string | null {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
  return decodeHtml(text.match(/(?:MXN|M\.N\.|\$)\s*[\d,.]+(?:\s*mil)?/i)?.[0]) ?? null
}

function extractPhone(html: string): string | null {
  const text = html.replace(/<[^>]+>/g, ' ')
  return text.match(/(?:\+?52\s*)?(?:\(?\d{2,3}\)?[\s.-]*)?\d{3,4}[\s.-]*\d{4}/)?.[0]?.trim() ?? null
}

function normalizeUrl(url: string): string {
  const parsed = new URL(url)
  parsed.hash = ''
  return parsed.toString()
}

function isAllowedTarget(url: string, domains: readonly string[]): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '')
    return domains.some(domain => host === domain || host.endsWith(`.${domain}`))
  } catch {
    return false
  }
}

function parseHtmlListing(html: string, pageUrl: string, google: SerpOrganicResult): ParsedListing {
  const meta = metaValues(html)
  const json = extractJsonLd(html)
  const attempts = ['json_ld', 'meta_tags', 'canonical_link', 'visible_text']
  const images = [
    ...jsonImages(json),
    ...meta.filter(item => ['og:image', 'twitter:image', 'image'].includes(item.key)).map(item => item.content),
  ].filter((value, index, list) => value && list.indexOf(value) === index)

  const jsonPrice = jsonOfferValue(json, 'price')
  const metaPrice = firstMeta(meta, ['product:price:amount', 'og:price:amount', 'price', 'twitter:data1'])
  const visible = visiblePrice(html)
  const priceCents = parsePrice(jsonPrice) ?? parsePrice(metaPrice) ?? parsePrice(visible)
  const currency = jsonOfferValue(json, 'priceCurrency') ?? firstMeta(meta, ['product:price:currency', 'og:price:currency']) ?? 'MXN'
  const canonical = canonicalUrl(html, pageUrl)
  const title = firstJsonString(json, ['name', 'headline'])
    ?? firstMeta(meta, ['og:title', 'twitter:title'])
    ?? titleTag(html)
    ?? google.title
    ?? null
  const description = firstJsonString(json, ['description'])
    ?? firstMeta(meta, ['og:description', 'twitter:description', 'description'])
    ?? google.snippet
    ?? null
  const shopName = firstJsonString(json, ['brand', 'seller', 'author'])
    ?? firstMeta(meta, ['article:author', 'author'])
    ?? null
  const contactUrl = html.match(/https?:\/\/(?:wa\.me|api\.whatsapp\.com)\/[^"'\s<]+/i)?.[0] ?? null

  const notes: string[] = []
  if (!priceCents) notes.push('price_not_found')
  if (images.length === 0) notes.push('image_not_found')
  if (!description) notes.push('description_not_found')
  if (!canonical) notes.push('canonical_not_found')

  return {
    title: decodeHtml(title),
    description: decodeHtml(description),
    priceCents,
    currency,
    imageUrl: images[0] ?? null,
    images,
    canonicalUrl: canonical,
    shopName: decodeHtml(shopName),
    contactPhone: extractPhone(html),
    contactUrl,
    attempts,
    notes,
  }
}

async function fetchListing(url: string): Promise<string | null> {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)',
      'Accept-Language': 'es-MX,es;q=0.9,en;q=0.8',
    },
    signal: AbortSignal.timeout(9000),
    cache: 'no-store',
  })
  if (!res.ok) return null
  return res.text()
}

export async function collectTargetedWebsiteSearch(params: TargetedSearchParams): Promise<ScrapeCollectResult> {
  const { query, targetSite, category, state, location, limit = 20 } = params
  const target = TARGET_SITE_MAP[targetSite]
  if (!target) throw new Error(`Unknown targeted search site: ${targetSite}`)
  if (!process.env.SERPAPI_KEY) throw new Error('SERPAPI_KEY is not set')

  const collected: SerpOrganicResult[] = []
  const seenUrls = new Set<string>()
  const maxPages = Math.min(5, Math.ceil(limit / 10))
  let duplicates = 0
  let invalid = 0

  for (let page = 0; page < maxPages && collected.length < limit; page++) {
    const searchUrl = new URL('https://serpapi.com/search.json')
    searchUrl.searchParams.set('engine', 'google')
    searchUrl.searchParams.set('q', `${target.queryPrefix} ${query}`.trim())
    searchUrl.searchParams.set('gl', 'mx')
    searchUrl.searchParams.set('hl', 'es')
    searchUrl.searchParams.set('num', '10')
    if (page > 0) searchUrl.searchParams.set('start', String(page * 10))
    searchUrl.searchParams.set('api_key', process.env.SERPAPI_KEY)

    const res = await fetch(searchUrl.toString(), {
      signal: AbortSignal.timeout(15000),
      cache: 'no-store',
    })
    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      throw new Error(`SerpAPI HTTP ${res.status}: ${errBody.slice(0, 200)}`)
    }

    const data = await res.json() as { organic_results?: SerpOrganicResult[]; error?: string }
    if (data.error) throw new Error(`SerpAPI error: ${data.error}`)
    const results = data.organic_results ?? []
    if (results.length === 0) break

    for (const result of results) {
      if (!result.link) {
        invalid++
        continue
      }
      if (!isAllowedTarget(result.link, target.domains)) {
        invalid++
        continue
      }
      const normalized = normalizeUrl(result.link)
      if (seenUrls.has(normalized)) {
        duplicates++
        continue
      }
      seenUrls.add(normalized)
      collected.push({ ...result, link: normalized })
      if (collected.length >= limit) break
    }
  }

  let failed = 0
  const items: ScrapeCollectedItem[] = []
  const CONCURRENCY = 4

  for (let i = 0; i < collected.length; i += CONCURRENCY) {
    const batch = collected.slice(i, i + CONCURRENCY)
    const parsedBatch = await Promise.all(batch.map(async result => {
      const sourceUrl = result.link ?? null
      if (!sourceUrl) return null
      try {
        const html = await fetchListing(sourceUrl)
        if (!html) {
          failed++
          return withQuality({
            source_platform: `targeted_${target.key}`,
            source_url: sourceUrl,
            shop_name: null,
            listing_title: result.title ?? null,
            listing_description: result.snippet ?? null,
            currency: 'MXN',
            listing_type: target.defaultListingType,
            category: category ?? target.defaultCategory,
            state: state ?? null,
            location: location ?? null,
            raw_data: {
              google_title: result.title ?? null,
              google_snippet: result.snippet ?? null,
              target_site: target.key,
              original_link_valid: true,
            },
          }, {
            parserName: target.parserName,
            parserStatus: 'fetch_failed',
            parserAttempts: ['serpapi_result'],
            parserNotes: ['fetch_failed'],
          })
        }

        const parsed = parseHtmlListing(html, sourceUrl, result)
        const canonical = parsed.canonicalUrl ?? sourceUrl
        const item: ScrapeCollectedItem = {
          source_platform: `targeted_${target.key}`,
          source_url: canonical,
          shop_name: parsed.shopName ?? target.label,
          shop_source_url: target.homeUrl,
          listing_title: parsed.title,
          listing_description: parsed.description,
          price_cents: parsed.priceCents,
          currency: parsed.currency ?? 'MXN',
          listing_type: target.defaultListingType,
          category: category ?? target.defaultCategory,
          state: state ?? null,
          location: location ?? null,
          image_url: parsed.imageUrl,
          raw_data: {
            google_title: result.title ?? null,
            google_snippet: result.snippet ?? null,
            target_site: target.key,
            target_label: target.label,
            serpapi_link: sourceUrl,
            canonical_url: canonical,
            all_image_urls: parsed.images,
            contact_phone: parsed.contactPhone,
            contact_url: parsed.contactUrl,
            original_link_valid: isAllowedTarget(canonical, target.domains),
          },
        }
        return withQuality(item, {
          parserName: target.parserName,
          parserStatus: 'parsed',
          parserAttempts: parsed.attempts,
          parserNotes: parsed.notes,
        })
      } catch (error) {
        failed++
        return withQuality({
          source_platform: `targeted_${target.key}`,
          source_url: sourceUrl,
          shop_name: null,
          listing_title: result.title ?? null,
          listing_description: result.snippet ?? null,
          currency: 'MXN',
          listing_type: target.defaultListingType,
          category: category ?? target.defaultCategory,
          state: state ?? null,
          location: location ?? null,
          raw_data: {
            google_title: result.title ?? null,
            google_snippet: result.snippet ?? null,
            target_site: target.key,
            original_link_valid: true,
          },
        }, {
          parserName: target.parserName,
          parserStatus: 'parse_error',
          parserAttempts: ['serpapi_result'],
          parserNotes: [String(error).slice(0, 120)],
        })
      }
    }))
    items.push(...parsedBatch.filter(item => item !== null))
  }

  return {
    items,
    skipped: 0,
    errors: failed,
    stats: summarizeCollectedItems(items, {
      fetched: collected.length,
      parsed: items.length,
      failed,
      duplicates,
      invalid,
      autoSkipped: 0,
    }),
  }
}
