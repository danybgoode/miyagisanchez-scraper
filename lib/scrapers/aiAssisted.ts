import type { FieldCandidate, ScrapeCollectedItem, ScrapeCollectResult } from '../adminScrapeExport'
import { TARGET_SEARCH_SITES, type TargetSearchSiteKey } from '../types'
import { summarizeCollectedItems, withQuality } from './quality'

type InputMode = 'search' | 'urls' | 'mercadolibre_seller' | 'inmuebles24_search'

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
}

interface SerpOrganicResult {
  title?: string
  link?: string
  snippet?: string
  displayed_link?: string
  position?: number
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
  skip_reason: string | null
}

const TARGET_SITE_MAP = Object.fromEntries(TARGET_SEARCH_SITES.map(site => [site.key, site]))
const CATEGORY_KEYS = new Set(['autos', 'inmuebles', 'electronica', 'hogar', 'moda', 'deportes', 'servicios', 'mascotas', 'herramientas', 'negocios', 'otros'])
const LISTING_TYPES = new Set(['product', 'service', 'rental', 'digital'])
const CONDITIONS = new Set(['new', 'like_new', 'good', 'fair', 'parts'])

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

function visiblePrice(html: string): string | null {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
  return cleanText(text.match(/(?:MXN|M\.N\.|\$)\s*[\d,.]+(?:\s*mil)?/i)?.[0]) ?? null
}

function parsePriceCents(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null
    return Math.round(value * 100)
  }
  const textValue = String(value)
  const match = textValue.match(/(?:MXN|M\.N\.|\$)?\s*([\d.,]+(?:\s*mil)?)/i)
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
      .replace(/\b(?:NoIndex|True|ITEM|CONDITION|CustId)\b/gi, ' ')
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

function queryForSeed(seed: string, targetSite: TargetSearchSiteKey, mode: InputMode): string {
  const target = TARGET_SITE_MAP[targetSite]
  if (mode === 'mercadolibre_seller') {
    const custId = seed.match(/_CustId_(\d+)/i)?.[1]
    const sellerTerm = custId ? `${custId} vehiculos` : textFromUrl(seed)
    return `(site:auto.mercadolibre.com.mx OR site:articulo.mercadolibre.com.mx OR site:vehiculos.mercadolibre.com.mx) ${sellerTerm}`.trim()
  }
  if (targetSite === 'mercadolibre') {
    const text = mode === 'search' ? seed : textFromUrl(seed)
    return `site:auto.mercadolibre.com.mx MLM autos ${text}`.trim()
  }
  if (targetSite === 'inmuebles24') {
    const text = mode === 'search' ? seed : textFromUrl(seed)
    return `site:inmuebles24.com ${text}`.trim()
  }
  return `${target?.queryPrefix ?? ''} ${mode === 'search' ? seed : textFromUrl(seed)}`.trim()
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

async function searchSerpApi(query: string, apiKey: string, limit: number): Promise<SerpOrganicResult[]> {
  const results: SerpOrganicResult[] = []
  const seen = new Set<string>()
  const maxPages = Math.min(5, Math.ceil(limit / 10))

  for (let page = 0; page < maxPages && results.length < limit; page++) {
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

async function fetchEvidence(result: SerpOrganicResult, seed: string, targetSite: TargetSearchSiteKey): Promise<RawCandidate | null> {
  const sourceUrl = result.link
  if (!sourceUrl) return null
  const sourcePlatform = sourcePlatformFromUrl(sourceUrl, targetSite)
  const base: RawCandidate = {
    seed,
    sourceUrl,
    sourcePlatform,
    googleTitle: cleanText(result.title, 300),
    googleSnippet: cleanText(result.snippet, 1000),
    htmlTitle: null,
    htmlDescription: null,
    imageUrl: null,
    priceText: null,
    fetchStatus: 'fetch_failed',
    candidates: {
      title: result.title ? [{ value: cleanText(result.title, 300) ?? result.title, source: 'google:title' }] : [],
      description: result.snippet ? [{ value: cleanText(result.snippet, 1000) ?? result.snippet, source: 'google:snippet' }] : [],
      priceCents: [],
      imageUrl: [],
    },
  }

  try {
    const res = await fetch(sourceUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)',
        'Accept-Language': 'es-MX,es;q=0.9,en;q=0.8',
      },
      signal: AbortSignal.timeout(9000),
      cache: 'no-store',
    })
    if (!res.ok) return base
    const html = await res.text()
    const htmlTitle = firstMeta(html, ['og:title', 'twitter:title']) ?? titleTag(html)
    const htmlDescription = firstMeta(html, ['og:description', 'twitter:description', 'description'])
    const imageUrl = firstMeta(html, ['og:image', 'twitter:image', 'image'])
    const priceText = firstMeta(html, ['product:price:amount', 'og:price:amount', 'price', 'twitter:data1']) ?? visiblePrice(html)
    const priceCents = parsePriceCents(priceText)

    return {
      ...base,
      htmlTitle,
      htmlDescription,
      imageUrl,
      priceText,
      fetchStatus: 'parsed',
      candidates: {
        title: [
          ...(htmlTitle ? [{ value: htmlTitle, source: 'html:title' }] : []),
          ...base.candidates.title,
        ],
        description: [
          ...(htmlDescription ? [{ value: htmlDescription, source: 'html:description' }] : []),
          ...base.candidates.description,
        ],
        priceCents: priceCents ? [{ value: priceCents, source: 'html:price' }] : [],
        imageUrl: imageUrl ? [{ value: imageUrl, source: 'html:image' }] : [],
      },
    }
  } catch {
    return base
  }
}

function fallbackRow(candidate: RawCandidate, params: AiAssistedScrapeParams): GeminiSupplyRow {
  return {
    source_url: candidate.sourceUrl,
    title: candidate.htmlTitle ?? candidate.googleTitle,
    description: candidate.htmlDescription ?? candidate.googleSnippet,
    price: candidate.priceText,
    shop_name: candidate.sourcePlatform === 'mercadolibre' ? 'Vendedor MercadoLibre' : candidate.sourcePlatform === 'inmuebles24' ? 'Inmuebles24' : null,
    location: params.location ?? null,
    state: params.state ?? null,
    municipio: params.municipio ?? null,
    image_url: candidate.imageUrl,
    category: params.category ?? (candidate.sourcePlatform === 'mercadolibre' ? 'autos' : candidate.sourcePlatform === 'inmuebles24' ? 'inmuebles' : 'otros'),
    listing_type: params.listingType ?? (candidate.sourcePlatform === 'inmuebles24' ? 'rental' : 'product'),
    condition: candidate.sourcePlatform === 'mercadolibre' ? 'good' : null,
    confidence: 35,
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
      skip_reason: { type: ['string', 'null'] },
    },
    required: ['source_url', 'title', 'description', 'price', 'shop_name', 'location', 'state', 'municipio', 'image_url', 'category', 'listing_type', 'condition', 'confidence', 'skip_reason'],
  }
  const model = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash'
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`
  const prompt = [
    'Normalize this marketplace evidence into the Miyagi Sanchez supply CSV schema.',
    'Use only evidence provided. Do not invent a seller name except generic marketplace fallback when the source clearly hides the seller.',
    'Prices must be MXN pesos, not cents. If unknown, return null.',
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
        temperature: 0.1,
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

  return withQuality({
    source_platform: `ai_${candidate.sourcePlatform}`,
    source_url: cleanText(row.source_url, 1000) ?? candidate.sourceUrl,
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
    image_url: cleanText(row.image_url, 1000) ?? candidate.imageUrl,
    raw_data: {
      ai_confidence: typeof row.confidence === 'number' ? row.confidence : null,
      ai_skip_reason: cleanText(row.skip_reason, 500),
      ai_raw_row: row as unknown as Record<string, unknown>,
      raw_candidate: candidate as unknown as Record<string, unknown>,
      canonical_url: cleanText(row.source_url, 1000) ?? candidate.sourceUrl,
      original_link_valid: /^https?:\/\//i.test(cleanText(row.source_url, 1000) ?? candidate.sourceUrl),
      candidates: candidate.candidates,
    },
  }, {
    parserName: 'ai_assisted_gemini',
    parserStatus: parserNotes.length > 0 ? 'ai_fallback' : 'ai_normalized',
    parserAttempts: ['serpapi_google_search', candidate.fetchStatus, 'gemini_structured_output'],
    parserNotes,
  })
}

export async function collectAiAssistedScrape(params: AiAssistedScrapeParams): Promise<ScrapeCollectResult> {
  const serpApiKey = params.serpApiKey || process.env.SERPAPI_KEY
  const geminiApiKey = params.geminiApiKey || process.env.GEMINI_API_KEY
  if (!serpApiKey) throw new Error('SERPAPI_KEY is not set')
  if (!geminiApiKey) throw new Error('Gemini API key is required for AI-assisted scrape')

  const limit = Math.max(1, Math.min(50, params.limit ?? 20))
  const inputMode = params.inputMode ?? 'search'
  const targetSite = params.targetSite ?? 'mercadolibre'
  const seeds = inputMode === 'search'
    ? [params.query?.trim()].filter((value): value is string => !!value)
    : splitUrls(params.urls || params.query)

  if (seeds.length === 0) throw new Error('Add a search query or at least one seed URL')

  const rawResults: SerpOrganicResult[] = []
  const seenLinks = new Set<string>()

  for (const seed of seeds) {
    const query = queryForSeed(seed, targetSite, inputMode)
    const perSeedLimit = Math.max(1, Math.ceil(limit / seeds.length))
    const results = await searchSerpApi(query, serpApiKey, perSeedLimit)
    for (const result of results) {
      if (!result.link || seenLinks.has(result.link)) continue
      seenLinks.add(result.link)
      rawResults.push(result)
      if (rawResults.length >= limit) break
    }
    if (rawResults.length >= limit) break
  }

  let failed = 0
  const candidates: RawCandidate[] = []
  for (let i = 0; i < rawResults.length; i += 4) {
    const batch = rawResults.slice(i, i + 4)
    const batchCandidates = await Promise.all(batch.map(result => fetchEvidence(result, seeds[0] ?? '', targetSite)))
    candidates.push(...batchCandidates.filter((item): item is RawCandidate => item !== null))
  }

  const items: ScrapeCollectedItem[] = []
  for (const candidate of candidates) {
    const notes: string[] = []
    let row: GeminiSupplyRow
    try {
      row = await normalizeWithGemini(candidate, params, geminiApiKey)
    } catch (error) {
      failed++
      notes.push(String(error).slice(0, 160))
      row = fallbackRow(candidate, params)
    }
    items.push(rowToItem(row, candidate, params, notes))
  }

  return {
    items,
    skipped: 0,
    errors: failed,
    stats: summarizeCollectedItems(items, {
      fetched: rawResults.length,
      parsed: items.length,
      failed,
      duplicates: Math.max(0, rawResults.length - candidates.length),
      invalid: 0,
      autoSkipped: 0,
    }),
  }
}
