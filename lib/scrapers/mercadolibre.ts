/**
 * MercadoLibre scrapers
 *
 * ML API access in MLM (Mexico):
 * - /sites/MLM/search and /items/{id} are blocked by ML's PolicyAgent for all
 *   developer accounts without formal partner certification. This is a business
 *   process, not a settings toggle.
 * - /users/{id}/items/search is restricted to the authenticated user's own items only.
 *
 * Working approach: SerpAPI (Google) + HTML parsing for seller targeting.
 */

import { db } from '../supabase'
import type { ScrapeCollectedItem, ScrapeCollectResult } from '../adminScrapeExport'
import type { ScrapeResult } from './serpapi'

export interface MLScrapeParams {
  query: string
  category?: string
  state?: string
  limit?: number
  clerkUserId?: string
}

export interface MLSellerScrapeParams {
  sellerUrl: string   // Any ML seller page: /pagina/NICKNAME, /perfil/ID, or listing URL with MLM-ID
  category?: string
  limit?: number      // default 50 (Google has ~50 results per seller)
}

interface SerpResult {
  title?: string
  link?: string
  snippet?: string
}

function slugify(text: string): string {
  return text.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48)
}

/** Fetch a page and return { title, image, priceCents, currency } from OG meta tags + title parsing. */
async function fetchOgData(url: string): Promise<{
  title: string | null
  image: string | null
  priceCents: number | null
  currency: string | null
}> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' },
      signal: AbortSignal.timeout(6000),
      cache: 'no-store',
    })
    if (!res.ok) return { title: null, image: null, priceCents: null, currency: null }
    const html = await res.text()

    const rawTitle = html.match(/property="og:title"\s+content="([^"]+)"/)?.[1]
      ?? html.match(/content="([^"]+)"\s+property="og:title"/)?.[1]
      ?? html.match(/<title>([^<]+)/)?.[1]
      ?? null

    const image = html.match(/property="og:image"\s+content="([^"]+)"/)?.[1]
      ?? html.match(/content="([^"]+)"\s+property="og:image"/)?.[1]
      ?? null

    // ML puts price in the OG title: "Volkswagen Transporter 9 PASAJEROS - $ 599,900"
    // Extract and clean
    let title = rawTitle
    let priceCents: number | null = null
    const currency: string | null = 'MXN'

    if (rawTitle) {
      const priceMatch = rawTitle.match(/[-–]\s*\$\s*([\d,]+(?:\.\d+)?)/)
      if (priceMatch) {
        const priceNum = parseFloat(priceMatch[1].replace(/,/g, ''))
        if (priceNum > 0) priceCents = Math.round(priceNum * 100)
        title = rawTitle.replace(/\s*[-–]\s*\$\s*[\d,]+(?:\.\d+)?/, '').replace(/\s*\|\s*MercadoLibre\s*$/, '').trim()
      } else {
        title = rawTitle.replace(/\s*\|\s*MercadoLibre\s*$/, '').trim()
      }
    }

    return { title, image, priceCents, currency }
  } catch {
    return { title: null, image: null, priceCents: null, currency: null }
  }
}

/** Extract seller info from an ML seller page. */
async function resolveSellerFromUrl(sellerUrl: string): Promise<{
  nickname: string
  displayName: string
  pageUrl: string
}> {
  // /pagina/NICKNAME or /perfil/NICKNAME or /tienda/NICKNAME
  const nicknameMatch = sellerUrl.match(/\/(?:pagina|perfil|tienda)\/([A-Za-z0-9_-]+)/i)
  if (nicknameMatch) {
    const nickname = nicknameMatch[1]
    const pageUrl = `https://www.mercadolibre.com.mx/pagina/${nickname}`
    try {
      const res = await fetch(pageUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' },
        signal: AbortSignal.timeout(8000),
        cache: 'no-store',
      })
      if (res.ok) {
        const html = await res.text()
        const titleMatch = html.match(/<title>([^|<]+)/)
        const displayName = titleMatch?.[1]?.trim() ?? nickname
        return { nickname, displayName, pageUrl }
      }
    } catch {}
    return { nickname, displayName: nickname, pageUrl }
  }

  // Bare MLM item ID in URL — resolve to seller via OG tags then seller page
  const mlmMatch = sellerUrl.match(/MLM[-_]?(\d+)/i)
  if (mlmMatch) {
    const { title } = await fetchOgData(sellerUrl)
    if (title) {
      // We have an item but not a seller page — use a synthesised key
      return { nickname: `mlm-item-${mlmMatch[1]}`, displayName: 'ML Seller', pageUrl: sellerUrl }
    }
  }

  throw new Error(
    `Cannot resolve seller from URL: "${sellerUrl}".\n` +
    `Supported formats:\n` +
    `• mercadolibre.com.mx/pagina/SELLER_NICKNAME  (seller store page)\n` +
    `• mercadolibre.com.mx/perfil/SELLER_NICKNAME\n` +
    `• Any ML listing URL containing MLM-XXXXXX`
  )
}

/**
 * Scrape a seller's active listings using SerpAPI Google search + OG-tag HTML parsing.
 * Works without ML API certification (bypasses PolicyAgent entirely).
 *
 * Strategy:
 *  1. Resolve seller nickname + display name from the URL
 *  2. Search Google for site:auto.mercadolibre.com.mx OR site:articulo.mercadolibre.com.mx {nickname}
 *  3. For each result, fetch the item HTML page to get og:image
 *  4. Insert listings into marketplace_listings
 */
export async function scrapeMLSeller(params: MLSellerScrapeParams): Promise<ScrapeResult & { sellerNickname?: string }> {
  const collected = await collectMLSeller(params)
  const firstItem = collected.items[0]
  if (!firstItem) {
    return { inserted: 0, skipped: collected.skipped, errors: collected.errors, sellerNickname: collected.sellerNickname }
  }
  const sellerPageUrl = firstItem?.shop_source_url ?? params.sellerUrl
  const displayName = firstItem?.shop_name ?? collected.sellerNickname ?? 'ML Seller'
  const nickname = String(firstItem?.raw_data?.seller_nickname ?? collected.sellerNickname ?? displayName)

  // Ensure/create the shop record once
  let shopId: string
  const { data: existingShop } = await db
    .from('marketplace_shops')
    .select('id')
    .eq('source_url', sellerPageUrl)
    .maybeSingle()

  if (existingShop) {
    shopId = existingShop.id
  } else {
    const slug = slugify(displayName || nickname) + '-' + Math.random().toString(36).slice(2, 6)
    const { data: newShop, error: shopErr } = await db
      .from('marketplace_shops')
      .insert({
        slug,
        name: displayName || nickname,
        source: 'scraped',
        source_url: sellerPageUrl,
        verified: false,
      })
      .select('id')
      .single()
    if (shopErr || !newShop) {
      throw new Error(`Failed to create shop: ${shopErr?.message}`)
    }
    shopId = newShop.id
  }

  let inserted = 0, skipped = collected.skipped, errors = collected.errors

  for (const item of collected.items) {
    try {
      if (!item.source_url || !item.listing_title) { skipped++; continue }

      const { data: existing } = await db
        .from('marketplace_listings')
        .select('id')
        .eq('source_url', item.source_url)
        .maybeSingle()

      if (existing) { skipped++; continue }

      const { error: listErr } = await db
        .from('marketplace_listings')
        .insert({
          shop_id: shopId,
          title: item.listing_title.slice(0, 200),
          price_cents: item.price_cents ?? null,
          currency: item.currency ?? 'MXN',
          listing_type: 'product',
          category: item.category ?? null,
          source: 'scraped',
          source_platform: 'mercadolibre',
          source_url: item.source_url,
          images: item.image_url ? [{ url: item.image_url, alt: item.listing_title }] : [],
          status: 'active',
          metadata: { ml_item_id: item.source_id, seller_nickname: nickname },
        })

      if (listErr) { errors++; continue }
      inserted++
    } catch {
      errors++
    }
  }

  return { inserted, skipped, errors, sellerNickname: collected.sellerNickname }
}

export async function collectMLSeller(params: MLSellerScrapeParams): Promise<ScrapeCollectResult> {
  const { sellerUrl, category, limit = 50 } = params

  if (!process.env.SERPAPI_KEY) {
    throw new Error('SERPAPI_KEY is not set - required for ML seller scraping')
  }

  const { nickname, displayName, pageUrl: sellerPageUrl } = await resolveSellerFromUrl(sellerUrl)
  const collectedItems: { url: string; googleTitle: string }[] = []
  const seenUrls = new Set<string>()
  const maxPages = Math.min(5, Math.ceil(limit / 10))

  for (let page = 0; page < maxPages && collectedItems.length < limit; page++) {
    const searchUrl = new URL('https://serpapi.com/search.json')
    searchUrl.searchParams.set('engine', 'google')
    searchUrl.searchParams.set('q', `(site:auto.mercadolibre.com.mx OR site:articulo.mercadolibre.com.mx) ${nickname}`)
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

    const data = await res.json() as { organic_results?: SerpResult[]; error?: string }
    if (data.error) throw new Error(`SerpAPI error: ${data.error}`)
    const results = data.organic_results ?? []
    if (results.length === 0) break

    for (const r of results) {
      if (!r.link) continue
      if (!/MLM[-_]?\d+/i.test(r.link)) continue
      if (seenUrls.has(r.link)) continue
      seenUrls.add(r.link)
      collectedItems.push({ url: r.link, googleTitle: r.title ?? '' })
      if (collectedItems.length >= limit) break
    }
  }

  let skipped = 0, errors = 0
  const items: ScrapeCollectedItem[] = []
  const CONCURRENCY = 5

  for (let i = 0; i < collectedItems.length; i += CONCURRENCY) {
    const batch = collectedItems.slice(i, i + CONCURRENCY)
    const batchItems = await Promise.all(batch.map(async ({ url: itemUrl, googleTitle }) => {
      try {
        const itemIdMatch = itemUrl.match(/MLM[-_]?(\d+)/i)
        const mlItemId = itemIdMatch ? `MLM${itemIdMatch[1]}` : null
        const { title: ogTitle, image: ogImage, priceCents, currency } = await fetchOgData(itemUrl)
        const title = ogTitle ?? googleTitle
        if (!title || title.length < 5) { skipped++; return null }

        return {
          source_platform: 'mercadolibre',
          source_url: itemUrl,
          source_id: mlItemId,
          shop_name: displayName || nickname,
          shop_source_url: sellerPageUrl,
          listing_title: title.slice(0, 200),
          price_cents: priceCents,
          currency: currency ?? 'MXN',
          listing_type: 'product',
          category: category ?? null,
          image_url: ogImage,
          raw_data: { google_title: googleTitle, seller_nickname: nickname },
        } satisfies ScrapeCollectedItem
      } catch {
        errors++
        return null
      }
    }))
    items.push(...batchItems.filter(item => item !== null))
  }

  return { items, skipped, errors, sellerNickname: displayName }
}

/**
 * Keyword-based ML catalog search.
 * NOTE: Currently blocked by ML's PolicyAgent in MLM (Mexico) region.
 * ML requires formal developer certification to use /sites/MLM/search.
 * This will throw a descriptive error explaining the restriction.
 *
 * To get this working:
 * 1. Submit your app for ML developer certification at developers.mercadolibre.com
 * 2. Or use scrapeMLSeller() which works via SerpAPI Google instead.
 */
export async function scrapeMercadoLibre(params: MLScrapeParams): Promise<ScrapeResult> {
  const { query, category, state, limit = 20, clerkUserId } = params

  // Attempt the ML API — it will likely 403 in MLM, but we try and give a clear error
  let accessToken: string | null = null

  if (clerkUserId) {
    try {
      const { decrypt } = await import('../encryption')
      const { data } = await db
        .from('commerce_ml_connections')
        .select('access_token, refresh_token, expires_at, ml_user_id')
        .eq('clerk_user_id', clerkUserId)
        .eq('is_active', true)
        .maybeSingle()

      if (data) {
        const expiresAt = new Date(data.expires_at)
        if (expiresAt.getTime() - Date.now() < 5 * 60 * 1000) {
          const { encrypt } = await import('../encryption')
          const decryptedRefresh = decrypt(data.refresh_token)
          const tokRes = await fetch('https://api.mercadolibre.com/oauth/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              grant_type: 'refresh_token',
              client_id: process.env.ML_APP_ID!,
              client_secret: process.env.ML_APP_SECRET!,
              refresh_token: decryptedRefresh,
            }),
          })
          const tok = await tokRes.json()
          if (tokRes.ok && tok.access_token) {
            await db.from('commerce_ml_connections').update({
              access_token: encrypt(tok.access_token),
              refresh_token: encrypt(tok.refresh_token),
              expires_at: new Date(Date.now() + (tok.expires_in ?? 21600) * 1000).toISOString(),
              updated_at: new Date().toISOString(),
            }).eq('clerk_user_id', clerkUserId).eq('ml_user_id', data.ml_user_id)
            accessToken = tok.access_token
          }
        } else {
          accessToken = decrypt(data.access_token)
        }
      }
    } catch { /* fall through */ }
  }

  const url = new URL('https://api.mercadolibre.com/sites/MLM/search')
  url.searchParams.set('q', query)
  url.searchParams.set('limit', String(Math.min(limit, 50)))

  const headers: Record<string, string> = { 'User-Agent': 'miyagisanchez/1.0' }
  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`
  } else if (process.env.ML_APP_ID) {
    url.searchParams.set('app_id', process.env.ML_APP_ID)
  }

  const res = await fetch(url.toString(), { headers })

  if (res.status === 403) {
    throw new Error(
      `ML keyword search is blocked (403 PolicyAgent) for MLM (Mexico) region.\n\n` +
      `This is an ML developer certification requirement — not fixable via OAuth scopes\n` +
      `or any setting in the developer portal. Options:\n\n` +
      `1. Use "ML Seller Targeting" instead — paste a seller URL and we scrape via Google (works now)\n` +
      `2. Apply for ML developer catalog access at developers.mercadolibre.com (takes weeks)\n\n` +
      `Token used: ${accessToken ? 'user OAuth' : process.env.ML_APP_ID ? 'app_id param' : 'none'}`
    )
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(`ML API HTTP ${res.status}: ${JSON.stringify(body)}`)
  }

  const data = await res.json() as { results?: Array<{
    id: string; title: string; price: number; currency_id: string;
    condition: string; thumbnail: string; permalink: string;
    seller: { id: number; nickname: string };
    address?: { state_name?: string; city_name?: string }
  }> }

  const items = data.results ?? []
  let inserted = 0, skipped = 0, errors = 0

  for (const item of items.slice(0, limit)) {
    try {
      const sourceUrl = item.permalink
      const { data: existing } = await db.from('marketplace_listings').select('id').eq('source_url', sourceUrl).maybeSingle()
      if (existing) { skipped++; continue }

      const sellerSourceUrl = `https://www.mercadolibre.com.mx/pagina/${item.seller.id}`
      let shopId: string
      const { data: existingShop } = await db.from('marketplace_shops').select('id').eq('source_url', sellerSourceUrl).maybeSingle()

      if (existingShop) {
        shopId = existingShop.id
      } else {
        const slug = slugify(item.seller.nickname || `ml-seller-${item.seller.id}`) + '-' + Math.random().toString(36).slice(2, 6)
        const { data: newShop, error: shopErr } = await db.from('marketplace_shops')
          .insert({ slug, name: item.seller.nickname || `Vendedor ${item.seller.id}`, source: 'scraped', source_url: sellerSourceUrl, verified: false })
          .select('id').single()
        if (shopErr || !newShop) { errors++; continue }
        shopId = newShop.id
      }

      const conditionMap: Record<string, string> = { new: 'new', used: 'good' }
      const { error: listErr } = await db.from('marketplace_listings').insert({
        shop_id: shopId, title: item.title,
        price_cents: item.price > 0 ? Math.round(item.price * 100) : null,
        currency: item.currency_id,
        condition: (conditionMap[item.condition] ?? 'good') as 'new' | 'like_new' | 'good' | 'fair' | 'parts',
        listing_type: 'product', category: category ?? null,
        location: item.address?.city_name ?? item.address?.state_name ?? null,
        state: state ?? item.address?.state_name ?? null,
        source: 'scraped', source_platform: 'mercadolibre', source_url: sourceUrl,
        images: item.thumbnail ? [{ url: item.thumbnail, alt: item.title }] : [],
        status: 'active', metadata: { ml_item_id: item.id },
      })
      if (listErr) { errors++; continue }
      inserted++
    } catch { errors++ }
  }

  return { inserted, skipped, errors }
}
