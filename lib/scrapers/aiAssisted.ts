import type { FieldCandidate, ScrapeCollectedItem, ScrapeCollectResult } from '../adminScrapeExport'
import { TARGET_SEARCH_SITES, type TargetSearchSiteKey } from '../types'
import { summarizeCollectedItems, withQuality } from './quality'

type InputMode = 'search' | 'urls' | 'mercadolibre_seller' | 'inmuebles24_search'
type AssistMode = 'normalize' | 'enrich' | 'url_image'

export interface AiProgressEvent {
  phase: 'input' | 'serpapi' | 'cleanup' | 'enrichment' | 'gemini' | 'csv' | 'done' | 'warning'
  message: string
  percent: number
  current?: number
  total?: number
  itemLabel?: string
}

export interface AiAssistedScrapeParams {
  inputMode?: InputMode
  query?: string
  urls?: string
  targetSite?: TargetSearchSiteKey
  category?: string
  listingType?: 'product' | 'service' | 'rental' | 'digital'
  state?: string
  municipio?: string
  location?: string
  limit?: number
  serpApiKey?: string
  geminiApiKey?: string
  assistMode?: AssistMode
  imageEnrichment?: boolean
  strictItemPages?: boolean
  maxSerpRequests?: number
  maxRuntimeMs?: number
  onProgress?: (event: AiProgressEvent) => void | Promise<void>
}

interface SerpOrganicResult {
  title?: string
  link?: string
  snippet?: string
  displayed_link?: string
  position?: number
  thumbnail?: string
}

interface SerpImageResult {
  title?: string
  link?: string
  source?: string
  thumbnail?: string
  original?: string
}

interface RawCandidate {
  seed: string
  sourceUrl: string
  sourcePlatform: string
  googleTitle: string | null
  googleSnippet: string | null
  htmlTitle: string | null
  htmlDescription: string | null
  imageUrl: string | null
  priceText: string | null
  fetchStatus: 'parsed' | 'fetch_failed' | 'not_fetched'
  isItemPage: boolean
  isCollectionPage: boolean
  enrichmentNotes: string[]
  supplementalSnippets: string[]
  candidates: {
    title: FieldCandidate[]
    description: FieldCandidate[]
    priceCents: FieldCandidate[]
    imageUrl: FieldCandidate[]
  }
}

interface GeminiSupplyRow {
  source_url: string | null
  title: string | null
  description: string | null
  price: string | number | null
  shop_name: string | null
  location: string | null
  state: string | null
  municipio: string | null
  image_url: string | null
  category: string | null
  listing_type: 'product' | 'service' | 'rental' | 'digital' | null
  condition: string | null
  confidence: number | null
  evidence_summary: string | null
  missing_fields: string[] | null
  skip_reason: string | null
}

const TARGET_SITE_MAP = Object.fromEntries(TARGET_SEARCH_SITES.map(site => [site.key, site]))
const CATEGORY_KEYS = new Set(['autos', 'inmuebles', 'electronica', 'hogar', 'moda', 'deportes', 'servicios', 'mascotas', 'herramientas', 'negocios', 'otros'])
const LISTING_TYPES = new Set(['product', 'service', 'rental', 'digital'])
const CONDITIONS = new Set(['new', 'like_new', 'good', 'fair', 'parts'])

class RunBudget {
  private startedAt = Date.now()
  private serpRequests = 0

  constructor(
    private maxSerpRequests: number,
    private maxRuntimeMs: number,
  ) {}

  check() {
    if (Date.now() - this.startedAt > this.maxRuntimeMs) {
      throw new Error(`AI-assisted scrape stopped after ${Math.round(this.maxRuntimeMs / 1000)}s runtime guard`)
    }
  }

  useSerpRequest() {
    this.check()
    this.serpRequests++
    if (this.serpRequests > this.maxSerpRequests) {
      throw new Error(`AI-assisted scrape stopped after ${this.maxSerpRequests} SerpAPI request guard`)
    }
  }
}

async function progress(params: AiAssistedScrapeParams, event: AiProgressEvent) {
  await params.onProgress?.(event)
}

function cleanText(value: unknown, max = 2000): string | null {
  if (value === null || value === undefined) return null
  const text = String(value)
    .normalize('NFKC')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text ? text.slice(0, max) : null
}

function decodeHtml(text: string | null | undefined): string | null {
  if (!text) return null
  return cleanText(text
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' '))
}

function getAttr(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i'))
  return decodeHtml(match?.[1]) ?? null
}

function firstMeta(html: string, keys: string[]): string | null {
  const wanted = new Set(keys.map(key => key.toLowerCase()))
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0]
    const key = getAttr(tag, 'property') ?? getAttr(tag, 'name') ?? getAttr(tag, 'itemprop')
    const content = getAttr(tag, 'content')
    if (key && content && wanted.has(key.toLowerCase())) return content
  }
  return null
}

function titleTag(html: string): string | null {
  return decodeHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/<[^>]+>/g, '')) ?? null
}

function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
}

function allPriceTexts(text: string | null | undefined): string[] {
  if (!text) return []
  const results: string[] = []
  const re = /(?:renta|precio|desde)?\s*(?:MN|MXN|M\.N\.|\$|mx\$)\s*[\d,.]+(?:\s*mil)?(?:\/mes)?/gi
  for (const match of text.matchAll(re)) {
    const value = cleanText(match[0], 80)
    if (value && !results.includes(value)) results.push(value)
  }
  return results
}

function parsePriceCents(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null
    return Math.round(value * 100)
  }
  const textValue = String(value)
  const match = textValue.match(/(?:MN|MXN|M\.N\.|\$|mx\$)?\s*([\d.,]+(?:\s*mil)?)/i)
  if (!match) return null
  let text = match[1].toLowerCase().replace(/\s+/g, '')
  const hasMil = text.includes('mil')
  text = text.replace(/mil/g, '')
  if (text.includes(',')) text = text.replace(/,/g, '')
  const number = Number.parseFloat(text)
  if (!Number.isFinite(number) || number <= 0) return null
  return Math.round(number * (hasMil ? 100000 : 100))
}

function splitUrls(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(/[\n,]+/)
    .map(url => url.trim())
    .filter(Boolean)
}

function hostFromUrl(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return null
  }
}

function textFromUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return decodeURIComponent(parsed.pathname)
      .replace(/\.html?$/i, '')
      .replace(/[_/.-]+/g, ' ')
      .replace(/\b(?:NoIndex|True|ITEM|CONDITION|CustId|clasificado|alclapin)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  } catch {
    return url
  }
}

function sourcePlatformFromUrl(url: string, fallback: TargetSearchSiteKey): string {
  const host = hostFromUrl(url)
  if (host?.includes('mercadolibre.com.mx')) return 'mercadolibre'
  if (host?.includes('inmuebles24.com')) return 'inmuebles24'
  return fallback
}

function isLikelyItemPage(url: string, platform: string): boolean {
  if (platform === 'inmuebles24') return /\/propiedades\/clasificado\//i.test(url)
  if (platform === 'mercadolibre') return /\/MLM[-_]?\d+/i.test(url)
  return true
}

function isLikelyCollectionPage(url: string, platform: string): boolean {
  if (platform === 'inmuebles24') return /\/(?:departamentos|inmuebles|casas|oficinas)-en-/i.test(url) && !isLikelyItemPage(url, platform)
  if (platform === 'mercadolibre') return /\/_(?:ITEM|CustId|NoIndex)|\/_DisplayType|\/_Desde_/i.test(url) && !isLikelyItemPage(url, platform)
  return false
}

function mlItemUrlFromSeed(seed: string): string | null {
  const match = seed.match(/MLM[-_]?(\d+)/i)
  return match ? `https://auto.mercadolibre.com.mx/MLM-${match[1]}-_JM` : null
}

function sellerIdFromSeed(seed: string): string | null {
  return seed.match(/_CustId_(\d+)/i)?.[1] ?? seed.match(/[?&]seller_id=(\d+)/i)?.[1] ?? null
}

function queryForSeed(seed: string, targetSite: TargetSearchSiteKey, mode: InputMode): string {
  const target = TARGET_SITE_MAP[targetSite]
  if (mode === 'mercadolibre_seller') {
    const custId = seed.match(/_CustId_(\d+)/i)?.[1]
    const sellerTerm = custId ? `seller ${custId} autos vehiculos MercadoLibre` : textFromUrl(seed)
    return `(site:auto.mercadolibre.com.mx OR site:articulo.mercadolibre.com.mx) MLM ${sellerTerm}`.trim()
  }
  if (targetSite === 'mercadolibre') {
    const text = mode === 'search' ? seed : textFromUrl(seed)
    return `site:auto.mercadolibre.com.mx/MLM ${text} MercadoLibre auto precio`.trim()
  }
  if (targetSite === 'inmuebles24') {
    const text = mode === 'search' ? seed : textFromUrl(seed)
    return `site:inmuebles24.com/propiedades/clasificado departamentos renta ${text}`.trim()
  }
  return `${target?.queryPrefix ?? ''} ${mode === 'search' ? seed : textFromUrl(seed)}`.trim()
}

function supplementalQuery(candidate: RawCandidate): string {
  const title = candidate.htmlTitle ?? candidate.googleTitle ?? textFromUrl(candidate.sourceUrl)
  if (candidate.sourcePlatform === 'inmuebles24') {
    return `site:inmuebles24.com/propiedades/clasificado "${title.replace(/"/g, '')}" MN`
  }
  if (candidate.sourcePlatform === 'mercadolibre') {
    return `site:auto.mercadolibre.com.mx/MLM "${title.replace(/"/g, '')}" precio imagen`
  }
  return `${candidate.sourceUrl} ${title}`
}

function imageQuery(candidate: RawCandidate): string {
  const title = candidate.htmlTitle ?? candidate.googleTitle ?? textFromUrl(candidate.sourceUrl)
  if (candidate.sourcePlatform === 'inmuebles24') {
    return `site:inmuebles24.com/propiedades/clasificado ${title} Inmuebles24`
  }
  if (candidate.sourcePlatform === 'mercadolibre') {
    return `site:auto.mercadolibre.com.mx/MLM ${title} MercadoLibre auto`
  }
  return `${title} ${candidate.sourceUrl}`
}

function normalizedUrl(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.hash = ''
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (/^(utm_|c_|deal_|tracking|fbclid|gclid)/i.test(key)) parsed.searchParams.delete(key)
    }
    return parsed.toString()
  } catch {
    return url
  }
}

function pushCandidate(list: FieldCandidate[], value: string | number | null, source: string) {
  if (value === null || value === '') return
  if (list.some(item => item.value === value)) return
  list.push({ value, source })
}

function addPriceCandidates(candidate: RawCandidate, text: string | null | undefined, source: string) {
  for (const priceText of allPriceTexts(text)) {
    const cents = parsePriceCents(priceText)
    if (cents) {
      pushCandidate(candidate.candidates.priceCents, cents, source)
      if (!candidate.priceText) candidate.priceText = priceText
    }
  }
}

async function searchSerpApi(query: string, apiKey: string, limit: number, budget: RunBudget): Promise<SerpOrganicResult[]> {
  const results: SerpOrganicResult[] = []
  const seen = new Set<string>()
  const maxPages = Math.min(5, Math.ceil(limit / 10))

  for (let page = 0; page < maxPages && results.length < limit; page++) {
    budget.useSerpRequest()
    const url = new URL('https://serpapi.com/search.json')
    url.searchParams.set('engine', 'google')
    url.searchParams.set('q', query)
    url.searchParams.set('gl', 'mx')
    url.searchParams.set('hl', 'es')
    url.searchParams.set('num', '10')
    if (page > 0) url.searchParams.set('start', String(page * 10))
    url.searchParams.set('api_key', apiKey)

    const res = await fetch(url.toString(), {
      signal: AbortSignal.timeout(15000),
      cache: 'no-store',
    })
    if (!res.ok) throw new Error(`SerpAPI HTTP ${res.status}`)
    const data = await res.json() as { organic_results?: SerpOrganicResult[]; error?: string }
    if (data.error) break
    for (const result of data.organic_results ?? []) {
      if (!result.link) continue
      const link = normalizedUrl(result.link)
      if (seen.has(link)) continue
      seen.add(link)
      results.push({ ...result, link })
      if (results.length >= limit) break
    }
  }
  return results
}

async function searchSerpApiImages(query: string, apiKey: string, budget: RunBudget): Promise<SerpImageResult[]> {
  budget.useSerpRequest()
  const url = new URL('https://serpapi.com/search.json')
  url.searchParams.set('engine', 'google_images')
  url.searchParams.set('q', query)
  url.searchParams.set('gl', 'mx')
  url.searchParams.set('hl', 'es')
  url.searchParams.set('ijn', '0')
  url.searchParams.set('api_key', apiKey)

  const res = await fetch(url.toString(), {
    signal: AbortSignal.timeout(15000),
    cache: 'no-store',
  })
  if (!res.ok) return []
  const data = await res.json() as { images_results?: SerpImageResult[]; error?: string }
  if (data.error) return []
  return data.images_results ?? []
}

async function fetchEvidence(result: SerpOrganicResult, seed: string, targetSite: TargetSearchSiteKey): Promise<RawCandidate | null> {
  const sourceUrl = result.link
  if (!sourceUrl) return null
  const sourcePlatform = sourcePlatformFromUrl(sourceUrl, targetSite)
  const isItemPage = isLikelyItemPage(sourceUrl, sourcePlatform)
  const isCollectionPage = isLikelyCollectionPage(sourceUrl, sourcePlatform)
  const base: RawCandidate = {
    seed,
    sourceUrl,
    sourcePlatform,
    googleTitle: cleanText(result.title, 300),
    googleSnippet: cleanText(result.snippet, 1000),
    htmlTitle: null,
    htmlDescription: null,
    imageUrl: cleanText(result.thumbnail, 1000),
    priceText: null,
    fetchStatus: 'fetch_failed',
    isItemPage,
    isCollectionPage,
    enrichmentNotes: [
      isItemPage ? 'item_url_detected' : 'not_item_url',
      isCollectionPage ? 'collection_url_detected' : 'not_collection_url',
    ],
    supplementalSnippets: [],
    candidates: {
      title: [],
      description: [],
      priceCents: [],
      imageUrl: [],
    },
  }

  pushCandidate(base.candidates.title, cleanText(result.title, 300), 'google:title')
  pushCandidate(base.candidates.description, cleanText(result.snippet, 1000), 'google:snippet')
  pushCandidate(base.candidates.imageUrl, base.imageUrl, 'google:thumbnail')
  addPriceCandidates(base, result.title, 'google:title')
  addPriceCandidates(base, result.snippet, 'google:snippet')

  try {
    const res = await fetch(sourceUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)',
        'Accept-Language': 'es-MX,es;q=0.9,en;q=0.8',
      },
      signal: AbortSignal.timeout(9000),
      cache: 'no-store',
    })
    if (!res.ok) {
      base.enrichmentNotes.push(`direct_fetch_http_${res.status}`)
      return base
    }
    const html = await res.text()
    const htmlTitle = firstMeta(html, ['og:title', 'twitter:title']) ?? titleTag(html)
    const htmlDescription = firstMeta(html, ['og:description', 'twitter:description', 'description'])
    const imageUrl = firstMeta(html, ['og:image', 'twitter:image', 'image'])
    const priceText = firstMeta(html, ['product:price:amount', 'og:price:amount', 'price', 'twitter:data1']) ?? allPriceTexts(visibleText(html))[0] ?? null

    const parsed: RawCandidate = {
      ...base,
      htmlTitle,
      htmlDescription,
      imageUrl: imageUrl ?? base.imageUrl,
      priceText: priceText ?? base.priceText,
      fetchStatus: 'parsed',
    }
    pushCandidate(parsed.candidates.title, htmlTitle, 'html:title')
    pushCandidate(parsed.candidates.description, htmlDescription, 'html:description')
    pushCandidate(parsed.candidates.imageUrl, imageUrl, 'html:image')
    addPriceCandidates(parsed, priceText, 'html:price')
    addPriceCandidates(parsed, visibleText(html), 'html:visible_text')
    parsed.enrichmentNotes.push('direct_fetch_parsed')
    return parsed
  } catch {
    base.enrichmentNotes.push('direct_fetch_failed')
    return base
  }
}

async function enrichCandidate(candidate: RawCandidate, apiKey: string, params: AiAssistedScrapeParams, budget: RunBudget): Promise<RawCandidate> {
  const enriched = { ...candidate, candidates: { ...candidate.candidates } }
  enriched.candidates.title = [...candidate.candidates.title]
  enriched.candidates.description = [...candidate.candidates.description]
  enriched.candidates.priceCents = [...candidate.candidates.priceCents]
  enriched.candidates.imageUrl = [...candidate.candidates.imageUrl]

  if (params.assistMode === 'enrich' && (!enriched.priceText || !enriched.htmlDescription || !enriched.htmlTitle)) {
    const organic = await searchSerpApi(supplementalQuery(enriched), apiKey, 3, budget)
    for (const result of organic) {
      const snippet = cleanText([result.title, result.snippet].filter(Boolean).join(' - '), 1000)
      if (!snippet) continue
      enriched.supplementalSnippets.push(snippet)
      pushCandidate(enriched.candidates.title, cleanText(result.title, 300), 'serp_enrichment:title')
      pushCandidate(enriched.candidates.description, cleanText(result.snippet, 1000), 'serp_enrichment:snippet')
      addPriceCandidates(enriched, result.title, 'serp_enrichment:title')
      addPriceCandidates(enriched, result.snippet, 'serp_enrichment:snippet')
    }
    enriched.enrichmentNotes.push(`serp_text_enrichment_${organic.length}`)
  }

  if (params.imageEnrichment !== false && !enriched.imageUrl) {
    const images = await searchSerpApiImages(imageQuery(enriched), apiKey, budget)
    const exact = images.find(image => image.link && normalizedUrl(image.link) === normalizedUrl(enriched.sourceUrl))
    const sameSource = images.find(image => image.original && /^(https?:)?\/\//i.test(image.original) && image.source?.toLowerCase().includes(enriched.sourcePlatform.toLowerCase()))
    const firstUsable = exact ?? sameSource ?? images.find(image => image.original || image.thumbnail)
    const imageUrl = cleanText(firstUsable?.original ?? firstUsable?.thumbnail, 1000)
    if (imageUrl) {
      enriched.imageUrl = imageUrl
      pushCandidate(enriched.candidates.imageUrl, imageUrl, exact ? 'serp_images:exact_link' : 'serp_images:fallback')
      enriched.enrichmentNotes.push('image_enriched')
    } else {
      enriched.enrichmentNotes.push('image_not_found_after_enrichment')
    }
  }

  return enriched
}

function missingFields(candidate: RawCandidate): string[] {
  const missing: string[] = []
  if (!candidate.sourceUrl) missing.push('source_url')
  if (!candidate.htmlTitle && !candidate.googleTitle && candidate.candidates.title.length === 0) missing.push('title')
  if (!candidate.htmlDescription && !candidate.googleSnippet && candidate.candidates.description.length === 0) missing.push('description')
  if (!candidate.priceText && candidate.candidates.priceCents.length === 0) missing.push('price')
  if (!candidate.imageUrl && candidate.candidates.imageUrl.length === 0) missing.push('image_url')
  return missing
}

function rawCandidateFromUrl(seed: string, targetSite: TargetSearchSiteKey): RawCandidate | null {
  let sourceUrl: string | null = null
  const mlItem = mlItemUrlFromSeed(seed)
  if (mlItem) sourceUrl = mlItem
  if (!sourceUrl && /^https?:\/\//i.test(seed)) sourceUrl = normalizedUrl(seed)
  if (!sourceUrl) return null

  const sourcePlatform = sourcePlatformFromUrl(sourceUrl, targetSite)
  const titleFromUrl = cleanText(textFromUrl(sourceUrl), 300)
  return {
    seed,
    sourceUrl,
    sourcePlatform,
    googleTitle: titleFromUrl,
    googleSnippet: null,
    htmlTitle: null,
    htmlDescription: null,
    imageUrl: null,
    priceText: null,
    fetchStatus: 'not_fetched',
    isItemPage: isLikelyItemPage(sourceUrl, sourcePlatform),
    isCollectionPage: isLikelyCollectionPage(sourceUrl, sourcePlatform),
    enrichmentNotes: ['direct_seed_candidate'],
    supplementalSnippets: [],
    candidates: {
      title: titleFromUrl ? [{ value: titleFromUrl, source: 'url:path' }] : [],
      description: [],
      priceCents: [],
      imageUrl: [],
    },
  }
}

function fallbackRow(candidate: RawCandidate, params: AiAssistedScrapeParams): GeminiSupplyRow {
  return {
    source_url: candidate.sourceUrl,
    title: candidate.htmlTitle ?? candidate.googleTitle ?? candidate.candidates.title[0]?.value?.toString() ?? null,
    description: candidate.htmlDescription ?? candidate.googleSnippet ?? candidate.supplementalSnippets[0] ?? null,
    price: candidate.candidates.priceCents[0] ? Number(candidate.candidates.priceCents[0].value) / 100 : candidate.priceText,
    shop_name: candidate.sourcePlatform === 'mercadolibre' ? 'Vendedor MercadoLibre' : candidate.sourcePlatform === 'inmuebles24' ? 'Inmuebles24' : null,
    location: params.location ?? null,
    state: params.state ?? null,
    municipio: params.municipio ?? null,
    image_url: candidate.imageUrl ?? candidate.candidates.imageUrl[0]?.value?.toString() ?? null,
    category: params.category ?? (candidate.sourcePlatform === 'mercadolibre' ? 'autos' : candidate.sourcePlatform === 'inmuebles24' ? 'inmuebles' : 'otros'),
    listing_type: params.listingType ?? (candidate.sourcePlatform === 'inmuebles24' ? 'rental' : 'product'),
    condition: candidate.sourcePlatform === 'mercadolibre' ? 'good' : null,
    confidence: 35,
    evidence_summary: 'Deterministic fallback from collected evidence.',
    missing_fields: missingFields(candidate),
    skip_reason: 'AI normalization failed; deterministic fallback used.',
  }
}

async function normalizeWithGemini(candidate: RawCandidate, params: AiAssistedScrapeParams, apiKey: string): Promise<GeminiSupplyRow> {
  const schema = {
    type: 'object',
    properties: {
      source_url: { type: ['string', 'null'] },
      title: { type: ['string', 'null'] },
      description: { type: ['string', 'null'] },
      price: { type: ['string', 'number', 'null'] },
      shop_name: { type: ['string', 'null'] },
      location: { type: ['string', 'null'] },
      state: { type: ['string', 'null'] },
      municipio: { type: ['string', 'null'] },
      image_url: { type: ['string', 'null'] },
      category: { type: ['string', 'null'], enum: ['autos', 'inmuebles', 'electronica', 'hogar', 'moda', 'deportes', 'servicios', 'mascotas', 'herramientas', 'negocios', 'otros', null] },
      listing_type: { type: ['string', 'null'], enum: ['product', 'service', 'rental', 'digital', null] },
      condition: { type: ['string', 'null'], enum: ['new', 'like_new', 'good', 'fair', 'parts', null] },
      confidence: { type: ['number', 'null'] },
      evidence_summary: { type: ['string', 'null'] },
      missing_fields: { type: ['array', 'null'], items: { type: 'string' } },
      skip_reason: { type: ['string', 'null'] },
    },
    required: ['source_url', 'title', 'description', 'price', 'shop_name', 'location', 'state', 'municipio', 'image_url', 'category', 'listing_type', 'condition', 'confidence', 'evidence_summary', 'missing_fields', 'skip_reason'],
  }
  const model = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash'
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`
  const prompt = [
    'You are a strict data extraction and polishing agent for a marketplace supply CSV.',
    'Your job is not just formatting: choose the best field candidates, recover price/location/detail signals from snippets, and produce a coherent import-ready row.',
    'Never turn a search/category page into a fake individual listing. If the URL is not an item page, keep source_url but set skip_reason and confidence below 50.',
    'Use only provided evidence. Do not invent exact prices, images, seller names, addresses, bedrooms, or amenities.',
    'If evidence includes an image candidate, pick the best direct image URL. If none exists, return null.',
    'Prices must be normal MXN pesos, not cents. If a price candidate is in cents, divide by 100.',
    'Description must describe this exact row. Do not borrow a description from a different supplemental result.',
    'Allowed category keys: autos, inmuebles, electronica, hogar, moda, deportes, servicios, mascotas, herramientas, negocios, otros.',
    'Allowed listing_type: product, service, rental, digital.',
    'Cars should be category autos and listing_type product. Real estate rentals should be category inmuebles and listing_type rental.',
    JSON.stringify({
      defaults: {
        category: params.category ?? null,
        listing_type: params.listingType ?? null,
        state: params.state ?? null,
        municipio: params.municipio ?? null,
        location: params.location ?? null,
      },
      expected_schema: ['source_url', 'title', 'description', 'price', 'shop_name', 'location', 'state', 'municipio', 'image_url', 'category', 'listing_type', 'condition'],
      evidence_quality: {
        is_item_page: candidate.isItemPage,
        is_collection_page: candidate.isCollectionPage,
        missing_before_ai: missingFields(candidate),
        enrichment_notes: candidate.enrichmentNotes,
      },
      evidence: candidate,
    }),
  ].join('\n')

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.05,
        responseMimeType: 'application/json',
        responseJsonSchema: schema,
      },
    }),
    signal: AbortSignal.timeout(30000),
    cache: 'no-store',
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Gemini HTTP ${res.status}: ${body.slice(0, 200)}`)
  }
  const data = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }
  const text = data.candidates?.[0]?.content?.parts?.map(part => part.text ?? '').join('') ?? ''
  if (!text.trim()) throw new Error('Gemini returned empty text')
  return JSON.parse(text) as GeminiSupplyRow
}

function rowToItem(row: GeminiSupplyRow, candidate: RawCandidate, params: AiAssistedScrapeParams, parserNotes: string[]): ScrapeCollectedItem {
  const category = cleanText(row.category) ?? params.category ?? (candidate.sourcePlatform === 'mercadolibre' ? 'autos' : candidate.sourcePlatform === 'inmuebles24' ? 'inmuebles' : 'otros')
  const listingType = cleanText(row.listing_type) ?? params.listingType ?? (candidate.sourcePlatform === 'inmuebles24' ? 'rental' : 'product')
  const condition = cleanText(row.condition)
  const priceCents = parsePriceCents(row.price)
  const sourceUrl = cleanText(row.source_url, 1000) ?? candidate.sourceUrl
  const imageUrl = cleanText(row.image_url, 1000) ?? candidate.imageUrl ?? candidate.candidates.imageUrl[0]?.value?.toString() ?? null

  return withQuality({
    source_platform: `ai_${candidate.sourcePlatform}`,
    source_url: sourceUrl,
    shop_name: cleanText(row.shop_name, 200),
    shop_source_url: candidate.sourcePlatform === 'mercadolibre' ? 'https://www.mercadolibre.com.mx' : candidate.sourcePlatform === 'inmuebles24' ? 'https://www.inmuebles24.com' : null,
    listing_title: cleanText(row.title, 200),
    listing_description: cleanText(row.description, 2000),
    price_cents: priceCents,
    currency: 'MXN',
    condition: condition && CONDITIONS.has(condition) ? condition : null,
    listing_type: LISTING_TYPES.has(listingType) ? listingType as ScrapeCollectedItem['listing_type'] : 'product',
    category: CATEGORY_KEYS.has(category) ? category : 'otros',
    state: cleanText(row.state, 120) ?? params.state ?? null,
    municipio: cleanText(row.municipio, 120) ?? params.municipio ?? null,
    location: cleanText(row.location, 240) ?? params.location ?? null,
    image_url: imageUrl,
    raw_data: {
      ai_confidence: typeof row.confidence === 'number' ? row.confidence : null,
      ai_skip_reason: cleanText(row.skip_reason, 500),
      ai_evidence_summary: cleanText(row.evidence_summary, 1000),
      ai_missing_fields: row.missing_fields ?? missingFields(candidate),
      ai_raw_row: row as unknown as Record<string, unknown>,
      raw_candidate: candidate as unknown as Record<string, unknown>,
      canonical_url: sourceUrl,
      original_link_valid: /^https?:\/\//i.test(sourceUrl),
      item_page_detected: candidate.isItemPage,
      collection_page_detected: candidate.isCollectionPage,
      enrichment_notes: candidate.enrichmentNotes,
      candidates: candidate.candidates,
    },
  }, {
    parserName: 'ai_assisted_gemini',
    parserStatus: parserNotes.length > 0 ? 'ai_fallback' : 'ai_normalized',
    parserAttempts: ['serpapi_google_search', candidate.fetchStatus, 'serpapi_missing_field_enrichment', 'serpapi_image_enrichment', 'gemini_structured_output'],
    parserNotes,
  })
}

function urlImageItem(candidate: RawCandidate, params: AiAssistedScrapeParams): ScrapeCollectedItem {
  const imageUrl = candidate.imageUrl ?? candidate.candidates.imageUrl[0]?.value?.toString() ?? null
  const hasValidShape = candidate.isItemPage && /^https?:\/\//i.test(candidate.sourceUrl)
  const notes = [
    ...candidate.enrichmentNotes,
    hasValidShape ? 'url_shape_valid' : 'url_shape_needs_manual_validation',
    imageUrl ? 'image_present' : 'image_missing',
  ]
  return withQuality({
    source_platform: `ai_${candidate.sourcePlatform}`,
    source_url: candidate.sourceUrl,
    shop_name: candidate.sourcePlatform === 'mercadolibre' ? 'Vendedor MercadoLibre' : candidate.sourcePlatform === 'inmuebles24' ? 'Inmuebles24' : null,
    shop_source_url: candidate.sourcePlatform === 'mercadolibre' ? 'https://www.mercadolibre.com.mx' : candidate.sourcePlatform === 'inmuebles24' ? 'https://www.inmuebles24.com' : null,
    listing_title: candidate.htmlTitle ?? candidate.googleTitle ?? candidate.candidates.title[0]?.value?.toString() ?? 'Pendiente de revisar',
    listing_description: candidate.htmlDescription ?? candidate.googleSnippet ?? null,
    price_cents: candidate.candidates.priceCents[0] ? Number(candidate.candidates.priceCents[0].value) : null,
    currency: 'MXN',
    condition: null,
    listing_type: params.listingType ?? (candidate.sourcePlatform === 'inmuebles24' ? 'rental' : 'product'),
    category: params.category ?? (candidate.sourcePlatform === 'mercadolibre' ? 'autos' : candidate.sourcePlatform === 'inmuebles24' ? 'inmuebles' : 'otros'),
    state: params.state ?? null,
    municipio: params.municipio ?? null,
    location: params.location ?? null,
    image_url: imageUrl,
    raw_data: {
      ai_confidence: hasValidShape && imageUrl ? 55 : 35,
      ai_skip_reason: hasValidShape ? null : 'URL/image mode kept this row for manual validation; URL shape may be unavailable or a collection page.',
      ai_evidence_summary: 'URL/image extraction mode: operator should validate details manually from source URL and image.',
      ai_missing_fields: missingFields(candidate),
      raw_candidate: candidate as unknown as Record<string, unknown>,
      canonical_url: candidate.sourceUrl,
      original_link_valid: hasValidShape,
      item_page_detected: candidate.isItemPage,
      collection_page_detected: candidate.isCollectionPage,
      enrichment_notes: notes,
      candidates: candidate.candidates,
    },
  }, {
    parserName: 'ai_assisted_url_image',
    parserStatus: hasValidShape && imageUrl ? 'url_image_ready' : 'manual_validation_needed',
    parserAttempts: ['serpapi_google_search', candidate.fetchStatus, 'serpapi_image_enrichment', 'url_shape_validation'],
    parserNotes: notes,
  })
}

export async function collectAiAssistedScrape(params: AiAssistedScrapeParams): Promise<ScrapeCollectResult> {
  const serpApiKey = params.serpApiKey || process.env.SERPAPI_KEY
  const geminiApiKey = params.geminiApiKey || process.env.GEMINI_API_KEY
  if (!serpApiKey) throw new Error('SERPAPI_KEY is not set')
  if (params.assistMode !== 'url_image' && !geminiApiKey) throw new Error('Gemini API key is required for AI-assisted scrape')

  const limit = Math.max(1, Math.min(50, params.limit ?? 20))
  const inputMode = params.inputMode ?? 'search'
  const targetSite = params.targetSite ?? 'mercadolibre'
  const strictItemPages = params.strictItemPages !== false
  const budget = new RunBudget(params.maxSerpRequests ?? Math.min(80, Math.max(12, limit * 4)), params.maxRuntimeMs ?? 180000)
  const stageLog: string[] = [
    `Input prepared: ${inputMode} / ${targetSite} / limit ${limit}.`,
    'SerpAPI discovery started with item-page-biased queries.',
  ]
  await progress(params, { phase: 'input', message: stageLog[0], percent: 3 })
  const seeds = inputMode === 'search'
    ? [params.query?.trim()].filter((value): value is string => !!value)
    : splitUrls(params.urls || params.query)

  if (seeds.length === 0) throw new Error('Add a search query or at least one seed URL')

  const rawResults: SerpOrganicResult[] = []
  const seenLinks = new Set<string>()
  const directSeedCandidates: RawCandidate[] = []

  for (let seedIndex = 0; seedIndex < seeds.length; seedIndex++) {
    const seed = seeds[seedIndex]
    const direct = rawCandidateFromUrl(seed, targetSite)
    if (direct?.isItemPage) directSeedCandidates.push(direct)
    if (inputMode === 'mercadolibre_seller' && sellerIdFromSeed(seed)) {
      const warning = `MercadoLibre seller ID ${sellerIdFromSeed(seed)} cannot be expanded through public ML API or Google index reliably; using SerpAPI fallback query only.`
      stageLog.push(warning)
      await progress(params, { phase: 'warning', message: warning, percent: 8 })
    }
    const query = queryForSeed(seed, targetSite, inputMode)
    const perSeedLimit = Math.max(1, Math.ceil(limit / seeds.length) * (strictItemPages ? 2 : 1))
    await progress(params, { phase: 'serpapi', message: `Fetching candidates with SerpAPI (${seedIndex + 1}/${seeds.length})`, percent: 8 + Math.round((seedIndex / seeds.length) * 18), current: seedIndex + 1, total: seeds.length, itemLabel: seed.slice(0, 80) })
    const results = await searchSerpApi(query, serpApiKey, perSeedLimit, budget)
    stageLog.push(`SerpAPI query returned ${results.length} candidates: ${query}`)
    for (const result of results) {
      if (!result.link || seenLinks.has(result.link)) continue
      seenLinks.add(result.link)
      rawResults.push(result)
      if (rawResults.length >= limit * 2) break
    }
    if (rawResults.length >= limit * 2) break
  }

  stageLog.push(`Fetched ${rawResults.length} discovery candidates; extracting page evidence next.`)
  await progress(params, { phase: 'cleanup', message: `Extracting evidence from ${rawResults.length + directSeedCandidates.length} candidates`, percent: 28 })
  let failed = 0
  const fetchedCandidates: RawCandidate[] = [...directSeedCandidates]
  for (let i = 0; i < rawResults.length; i += 4) {
    budget.check()
    const batch = rawResults.slice(i, i + 4)
    const batchCandidates = await Promise.all(batch.map(result => fetchEvidence(result, seeds[0] ?? '', targetSite)))
    fetchedCandidates.push(...batchCandidates.filter((item): item is RawCandidate => item !== null))
    await progress(params, { phase: 'cleanup', message: `Parsed evidence batch ${Math.floor(i / 4) + 1}/${Math.ceil(rawResults.length / 4) || 1}`, percent: 30 + Math.round((i / Math.max(1, rawResults.length)) * 15) })
  }

  const dedupedCandidates = fetchedCandidates.filter((candidate, index, list) =>
    list.findIndex(item => normalizedUrl(item.sourceUrl) === normalizedUrl(candidate.sourceUrl)) === index
  )
  const itemCandidates = strictItemPages
    ? dedupedCandidates.filter(candidate => candidate.isItemPage)
    : dedupedCandidates.filter(candidate => !candidate.isCollectionPage)
  const candidatesToEnrich = itemCandidates.slice(0, limit)
  const skippedCollectionPages = dedupedCandidates.length - candidatesToEnrich.length
  stageLog.push(`Evidence cleanup kept ${candidatesToEnrich.length} item-level rows and filtered ${Math.max(0, skippedCollectionPages)} weak/search pages.`)
  await progress(params, { phase: 'cleanup', message: `Kept ${candidatesToEnrich.length} item-level rows; filtered ${Math.max(0, skippedCollectionPages)} weak/search pages`, percent: 45 })

  const enrichedCandidates: RawCandidate[] = []
  for (let index = 0; index < candidatesToEnrich.length; index++) {
    budget.check()
    const candidate = candidatesToEnrich[index]
    const before = missingFields(candidate)
    await progress(params, { phase: 'enrichment', message: `Enriching missing price/image evidence (${index + 1}/${candidatesToEnrich.length})`, percent: 45 + Math.round((index / Math.max(1, candidatesToEnrich.length)) * 25), current: index + 1, total: candidatesToEnrich.length, itemLabel: candidate.googleTitle ?? candidate.sourceUrl })
    const enriched = await enrichCandidate(candidate, serpApiKey, params, budget)
    const after = missingFields(enriched)
    enriched.enrichmentNotes.push(`missing_before:${before.join('|') || 'none'}`)
    enriched.enrichmentNotes.push(`missing_after:${after.join('|') || 'none'}`)
    enrichedCandidates.push(enriched)
  }
  const imageCount = enrichedCandidates.filter(candidate => candidate.imageUrl || candidate.candidates.imageUrl.length > 0).length
  const priceCount = enrichedCandidates.filter(candidate => candidate.priceText || candidate.candidates.priceCents.length > 0).length
  stageLog.push(`Missing-field enrichment complete: ${priceCount}/${enrichedCandidates.length} have price evidence, ${imageCount}/${enrichedCandidates.length} have image evidence.`)
  stageLog.push(params.assistMode === 'url_image' ? 'URL/image mode selected; skipping Gemini field polishing.' : 'Gemini validation and schema polishing started item by item.')
  await progress(params, { phase: 'enrichment', message: `Enrichment complete: ${priceCount}/${enrichedCandidates.length} price, ${imageCount}/${enrichedCandidates.length} image`, percent: 70 })

  const items: ScrapeCollectedItem[] = []
  for (let index = 0; index < enrichedCandidates.length; index++) {
    budget.check()
    const candidate = enrichedCandidates[index]
    if (params.assistMode === 'url_image') {
      await progress(params, { phase: 'csv', message: `Preparing URL/image row (${index + 1}/${enrichedCandidates.length})`, percent: 72 + Math.round((index / Math.max(1, enrichedCandidates.length)) * 23), current: index + 1, total: enrichedCandidates.length, itemLabel: candidate.googleTitle ?? candidate.sourceUrl })
      items.push(urlImageItem(candidate, params))
      continue
    }
    const notes: string[] = []
    let row: GeminiSupplyRow
    try {
      await progress(params, { phase: 'gemini', message: `${params.assistMode === 'normalize' ? 'Normalizing' : 'Validating and polishing'} with Gemini (${index + 1}/${enrichedCandidates.length})`, percent: 72 + Math.round((index / Math.max(1, enrichedCandidates.length)) * 23), current: index + 1, total: enrichedCandidates.length, itemLabel: candidate.googleTitle ?? candidate.sourceUrl })
      row = await normalizeWithGemini(candidate, params, geminiApiKey!)
    } catch (error) {
      failed++
      notes.push(String(error).slice(0, 160))
      row = fallbackRow(candidate, params)
    }
    items.push(rowToItem(row, candidate, params, notes))
  }

  stageLog.push(`Gemini output cleanup finished: ${items.length} rows ready for review/export, ${failed} AI fallback rows.`)
  await progress(params, { phase: 'done', message: `Output cleanup finished: ${items.length} rows ready`, percent: 100, current: items.length, total: items.length })
  const stats = summarizeCollectedItems(items, {
    fetched: rawResults.length,
    parsed: items.length,
    failed,
    duplicates: Math.max(0, rawResults.length - fetchedCandidates.length),
    invalid: Math.max(0, skippedCollectionPages),
    autoSkipped: Math.max(0, skippedCollectionPages),
  })

  return {
    items,
    skipped: Math.max(0, skippedCollectionPages),
    errors: failed,
    stats: {
      ...stats,
      stageLog,
    },
  }
}
