'use client'

import { useState, useEffect, useCallback } from 'react'
import { CATEGORIES } from '@/lib/types'

interface ScrapeRun {
  id: string
  source: string
  params: Record<string, unknown>
  status: 'running' | 'completed' | 'failed'
  count_inserted: number
  count_skipped: number
  count_errors: number
  error_message: string | null
  started_at: string
  completed_at: string | null
}

interface RunResult {
  inserted?: number
  collected?: number
  skipped?: number
  errors?: number
  error?: string
  runId?: string
  sellerNickname?: string
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { bg: string; color: string }> = {
    running:   { bg: '#fef08a', color: '#713f12' },
    completed: { bg: '#bbf7d0', color: '#14532d' },
    failed:    { bg: '#fecaca', color: '#7f1d1d' },
  }
  const { bg, color } = map[status] ?? { bg: '#e5e7eb', color: '#374151' }
  return (
    <span style={{ backgroundColor: bg, color, padding: '2px 8px', borderRadius: 4, fontSize: 12, fontWeight: 600 }}>
      {status}
    </span>
  )
}

function ResultBanner({ result, loading, secret }: { result: RunResult | null; loading: boolean; secret: string }) {
  if (loading) return (
    <div style={{ marginTop: 14, padding: '10px 14px', borderRadius: 6, backgroundColor: '#f0f9ff', border: '1px solid #bae6fd', fontSize: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
      <Spinner color="#0369a1" />
      <span style={{ color: '#0369a1' }}>Scraping in progress…</span>
    </div>
  )
  if (!result) return null
  return (
    <div style={{ marginTop: 14, padding: '12px 14px', borderRadius: 6, backgroundColor: result.error ? '#fef2f2' : '#f0fdf4', border: `1px solid ${result.error ? '#fca5a5' : '#86efac'}`, fontSize: 14 }}>
      {result.error ? (
        <div>
          <span style={{ color: '#dc2626', fontWeight: 600 }}>Error</span>
          <pre style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap', fontSize: 12, color: '#991b1b', fontFamily: 'monospace' }}>{result.error}</pre>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
          {result.sellerNickname && <span style={{ color: '#166534' }}>Seller: <strong>{result.sellerNickname}</strong></span>}
          <span style={{ color: '#166534' }}>✓ <strong>{result.collected ?? result.inserted}</strong> collected</span>
          <span style={{ color: '#6b7280' }}>⟳ <strong>{result.skipped}</strong> skipped</span>
          {(result.errors ?? 0) > 0 && <span style={{ color: '#dc2626' }}>✗ <strong>{result.errors}</strong> errors</span>}
          {result.runId && (
            <a href={`/api/admin/runs/${result.runId}/csv?secret=${encodeURIComponent(secret)}`} style={{ color: '#166534', fontWeight: 600 }}>
              Download CSV
            </a>
          )}
        </div>
      )}
    </div>
  )
}

interface SerpApiFormState {
  query: string
  location: string
  state: string
  category: string
  limit: string
}

interface MLFormState {
  query: string
  category: string
  limit: string
  clerkUserId: string
}

interface MLSellerFormState {
  sellerUrl: string
  category: string
  limit: string
}

export default function AdminScrapeClient({ secret }: { secret: string }) {
  const [runs, setRuns] = useState<ScrapeRun[]>([])
  const [serpForm, setSerpForm] = useState<SerpApiFormState>({
    query: '',
    location: 'Ciudad de México, Mexico',
    state: 'Ciudad de México',
    category: 'servicios',
    limit: '20',
  })
  const [mlForm, setMlForm] = useState<MLFormState>({
    query: '',
    category: 'electronica',
    limit: '20',
    clerkUserId: '',
  })
  const [mlSellerForm, setMlSellerForm] = useState<MLSellerFormState>({
    sellerUrl: '',
    category: 'electronica',
    limit: '50',
  })

  const [serpLoading, setSerpLoading] = useState(false)
  const [mlLoading, setMlLoading] = useState(false)
  const [mlSellerLoading, setMlSellerLoading] = useState(false)
  const [serpResult, setSerpResult] = useState<RunResult | null>(null)
  const [mlResult, setMlResult] = useState<RunResult | null>(null)
  const [mlSellerResult, setMlSellerResult] = useState<RunResult | null>(null)

  const fetchRuns = useCallback(async () => {
    const res = await fetch(`/api/admin/runs?secret=${encodeURIComponent(secret)}`)
    if (res.ok) {
      const json = await res.json() as { runs: ScrapeRun[] }
      setRuns(json.runs)
    }
  }, [secret])

  useEffect(() => {
    const timer = window.setTimeout(() => { void fetchRuns() }, 0)
    return () => window.clearTimeout(timer)
  }, [fetchRuns])

  async function runSerpApi(e: React.FormEvent) {
    e.preventDefault()
    setSerpLoading(true)
    setSerpResult(null)
    try {
      const res = await fetch('/api/admin/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-secret': secret },
        body: JSON.stringify({
          source: 'serpapi_google_local',
          mode: 'collect_only',
          params: {
            query: serpForm.query,
            location: serpForm.location,
            state: serpForm.state,
            category: serpForm.category,
            limit: Number(serpForm.limit),
          },
        }),
      })
      const json = await res.json() as RunResult
      setSerpResult(json)
      await fetchRuns()
    } catch (err) {
      setSerpResult({ error: String(err) })
    } finally {
      setSerpLoading(false)
    }
  }

  async function runML(e: React.FormEvent) {
    e.preventDefault()
    setMlLoading(true)
    setMlResult(null)
    try {
      const res = await fetch('/api/admin/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-secret': secret },
        body: JSON.stringify({
          source: 'mercadolibre_public',
          mode: 'collect_only',
          params: {
            query: mlForm.query,
            category: mlForm.category,
            limit: Number(mlForm.limit),
            ...(mlForm.clerkUserId ? { clerkUserId: mlForm.clerkUserId } : {}),
          },
        }),
      })
      const json = await res.json() as RunResult
      setMlResult(json)
      await fetchRuns()
    } catch (err) {
      setMlResult({ error: String(err) })
    } finally {
      setMlLoading(false)
    }
  }

  async function runMLSeller(e: React.FormEvent) {
    e.preventDefault()
    setMlSellerLoading(true)
    setMlSellerResult(null)
    try {
      const res = await fetch('/api/admin/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-secret': secret },
        body: JSON.stringify({
          source: 'mercadolibre_seller',
          mode: 'collect_only',
          params: {
            sellerUrl: mlSellerForm.sellerUrl,
            category: mlSellerForm.category,
            limit: Number(mlSellerForm.limit),
          },
        }),
      })
      const json = await res.json() as RunResult
      setMlSellerResult(json)
      await fetchRuns()
    } catch (err) {
      setMlSellerResult({ error: String(err) })
    } finally {
      setMlSellerLoading(false)
    }
  }

  const input: React.CSSProperties = {
    width: '100%', padding: '8px 10px',
    border: '1px solid #d1d5db', borderRadius: 6,
    fontSize: 14, boxSizing: 'border-box', backgroundColor: '#fff',
  }
  const label: React.CSSProperties = {
    display: 'block', fontSize: 13, fontWeight: 600,
    marginBottom: 4, color: '#374151',
  }
  const field: React.CSSProperties = { marginBottom: 14 }
  const btn = (loading: boolean): React.CSSProperties => ({
    backgroundColor: loading ? '#6b7280' : '#3a8a7a',
    color: '#fff', border: 'none', borderRadius: 6,
    padding: '9px 22px', fontSize: 14, fontWeight: 600,
    cursor: loading ? 'not-allowed' : 'pointer',
    display: 'flex', alignItems: 'center', gap: 8,
    transition: 'background-color 0.15s',
  })
  const card: React.CSSProperties = {
    backgroundColor: '#fff', border: '1px solid #e5e7eb',
    borderRadius: 10, padding: 24, marginBottom: 24,
  }
  const sectionTitle: React.CSSProperties = {
    margin: '0 0 4px', fontSize: 16, fontWeight: 700, color: '#111827',
  }
  const sectionSub: React.CSSProperties = {
    margin: '0 0 18px', fontSize: 13, color: '#6b7280',
  }
  const hint: React.CSSProperties = {
    fontSize: 11, color: '#9ca3af', marginTop: 3,
  }

  return (
    <div style={{ minHeight: '100vh', backgroundColor: '#f3f4f6', fontFamily: 'system-ui, -apple-system, sans-serif' }}>
      {/* Nav */}
      <div style={{ backgroundColor: '#111827', color: '#fff', padding: '14px 28px', display: 'flex', alignItems: 'center', gap: 12, borderBottom: '1px solid #1f2937' }}>
        <span style={{ fontWeight: 800, fontSize: 18, letterSpacing: '-0.5px' }}>miyagisanchez</span>
        <span style={{ backgroundColor: '#374151', color: '#d1d5db', fontSize: 12, fontWeight: 600, padding: '2px 8px', borderRadius: 4 }}>ADMIN</span>
        <span style={{ marginLeft: 'auto', color: '#6b7280', fontSize: 13 }}>Scrape Panel</span>
      </div>

      <div style={{ maxWidth: 900, margin: '0 auto', padding: '32px 24px' }}>

        {/* ── SerpAPI ─────────────────────────────── */}
        <div style={card}>
          <h2 style={sectionTitle}>🔍 SerpAPI — Google Local</h2>
          <p style={sectionSub}>Collect local businesses from Google Maps and save a CSV for review in /supply. Good for services (talleres, restaurantes, clínicas).</p>
          <form onSubmit={(e) => { void runSerpApi(e) }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <div style={field}>
                <label style={label}>Query</label>
                <input style={input} value={serpForm.query} onChange={e => setSerpForm(f => ({ ...f, query: e.target.value }))} placeholder="taller mecánico" required />
              </div>
              <div style={field}>
                <label style={label}>Location</label>
                <input style={input} value={serpForm.location} onChange={e => setSerpForm(f => ({ ...f, location: e.target.value }))} placeholder="Ciudad de México, Mexico" />
              </div>
              <div style={field}>
                <label style={label}>State (DB field)</label>
                <input style={input} value={serpForm.state} onChange={e => setSerpForm(f => ({ ...f, state: e.target.value }))} placeholder="Ciudad de México" />
              </div>
              <div style={field}>
                <label style={label}>Category</label>
                <select style={input} value={serpForm.category} onChange={e => setSerpForm(f => ({ ...f, category: e.target.value }))}>
                  {CATEGORIES.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
                </select>
              </div>
              <div style={field}>
                <label style={label}>Limit</label>
                <input style={input} type="number" min={1} max={50} value={serpForm.limit} onChange={e => setSerpForm(f => ({ ...f, limit: e.target.value }))} />
              </div>
            </div>
            <button type="submit" style={btn(serpLoading)} disabled={serpLoading}>
              {serpLoading && <Spinner />}
              {serpLoading ? 'Collecting…' : 'Collect CSV Rows'}
            </button>
          </form>
          <ResultBanner result={serpResult} loading={serpLoading} secret={secret} />
        </div>

        {/* ── ML Keyword ──────────────────────────── */}
        <div style={card}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
            <h2 style={{ ...sectionTitle, margin: 0 }}>🛒 MercadoLibre — Keyword Search</h2>
            <span style={{ backgroundColor: '#fef2f2', color: '#dc2626', fontSize: 12, fontWeight: 600, padding: '2px 8px', borderRadius: 20, border: '1px solid #fca5a5' }}>Blocked in MX</span>
          </div>
          <p style={sectionSub}>MercadoLibre PolicyAgent blocks /sites/MLM/search for non-certified developer apps. This remains disabled for collection; use Seller Targeting below instead.</p>
          <form onSubmit={(e) => { void runML(e) }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <div style={field}>
                <label style={label}>Query</label>
                <input style={input} value={mlForm.query} onChange={e => setMlForm(f => ({ ...f, query: e.target.value }))} placeholder="laptop, iPhone, silla..." required />
              </div>
              <div style={field}>
                <label style={label}>Category</label>
                <select style={input} value={mlForm.category} onChange={e => setMlForm(f => ({ ...f, category: e.target.value }))}>
                  {CATEGORIES.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
                </select>
              </div>
              <div style={field}>
                <label style={label}>Limit</label>
                <input style={input} type="number" min={1} max={50} value={mlForm.limit} onChange={e => setMlForm(f => ({ ...f, limit: e.target.value }))} />
              </div>
              <div style={field}>
                <label style={label}>Clerk User ID <span style={{ fontWeight: 400, color: '#9ca3af' }}>(optional)</span></label>
                <input style={input} value={mlForm.clerkUserId} onChange={e => setMlForm(f => ({ ...f, clerkUserId: e.target.value }))} placeholder="user_XXXXXXXXXXXX" />
                <p style={hint}>Uses your connected ML account token — recommended to avoid rate limits.</p>
              </div>
            </div>
            <button type="submit" style={btn(mlLoading)} disabled={mlLoading}>
              {mlLoading && <Spinner />}
              {mlLoading ? 'Checking…' : 'Check Availability'}
            </button>
          </form>
          <ResultBanner result={mlResult} loading={mlLoading} secret={secret} />
        </div>

        {/* ── ML Seller targeting ─────────────────── */}
        <div style={{ ...card, border: '2px solid #3a8a7a' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
            <h2 style={{ ...sectionTitle, margin: 0 }}>🎯 MercadoLibre — Seller Targeting</h2>
            <span style={{ backgroundColor: '#f0fdf4', color: '#166534', fontSize: 12, fontWeight: 600, padding: '2px 8px', borderRadius: 20, border: '1px solid #86efac' }}>Works via Google</span>
          </div>
          <p style={sectionSub}>
            Paste any ML seller page URL → collects their listings via Google search + HTML parsing.
            No ML API access needed. Download the CSV from Recent Runs and process it through /supply.
          </p>
          <form onSubmit={(e) => { void runMLSeller(e) }}>
            <div style={field}>
              <label style={label}>ML Seller Page URL</label>
              <input
                style={{ ...input, fontSize: 13 }}
                value={mlSellerForm.sellerUrl}
                onChange={e => setMlSellerForm(f => ({ ...f, sellerUrl: e.target.value }))}
                placeholder="https://www.mercadolibre.com.mx/pagina/automotrizgtrcoyoacn"
                required
              />
              <p style={hint}>
                Formats: mercadolibre.com.mx/pagina/NICKNAME · /perfil/NICKNAME · any listing URL with MLM-XXXXXX
              </p>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <div style={field}>
                <label style={label}>Category</label>
                <select style={input} value={mlSellerForm.category} onChange={e => setMlSellerForm(f => ({ ...f, category: e.target.value }))}>
                  {CATEGORIES.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
                </select>
              </div>
              <div style={field}>
                <label style={label}>Limit (Google returns ~10/page, max 50)</label>
                <input style={input} type="number" min={1} max={50} value={mlSellerForm.limit} onChange={e => setMlSellerForm(f => ({ ...f, limit: e.target.value }))} />
              </div>
            </div>
            <button type="submit" style={btn(mlSellerLoading)} disabled={mlSellerLoading}>
              {mlSellerLoading && <Spinner />}
              {mlSellerLoading ? 'Collecting seller…' : '🎯 Collect Seller Listings'}
            </button>
          </form>
          <ResultBanner result={mlSellerResult} loading={mlSellerLoading} secret={secret} />
        </div>

        {/* ── Runs history ───────────────────────── */}
        <div style={card}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Recent Runs</h2>
            <button onClick={() => { void fetchRuns() }} style={{ ...btn(false), padding: '6px 14px', fontSize: 13 }}>↻ Refresh</button>
          </div>
          {runs.length === 0 ? (
            <p style={{ color: '#9ca3af', fontSize: 14 }}>No runs yet.</p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: '2px solid #e5e7eb' }}>
                    {['Source', 'Params', 'Status', 'Rows', '⟳', '✗', 'CSV', 'Started'].map(h => (
                      <th key={h} style={{ textAlign: 'left', padding: '6px 10px', color: '#6b7280', fontWeight: 600 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {runs.map(run => (
                    <tr key={run.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                      <td style={{ padding: '8px 10px', fontWeight: 500, whiteSpace: 'nowrap' }}>
                        {run.source === 'serpapi_google_local' ? '🔍 Google Local'
                          : run.source === 'mercadolibre_seller' ? '🎯 ML Seller'
                          : '🛒 ML Keyword'}
                      </td>
                      <td style={{ padding: '8px 10px', color: '#6b7280', maxWidth: 200 }}>
                        <span title={JSON.stringify(run.params)} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block', fontSize: 12 }}>
                          {run.params.sellerUrl
                            ? String(run.params.sellerUrl).slice(0, 40) + '…'
                            : run.params.query ? `"${run.params.query}"` : JSON.stringify(run.params)}
                        </span>
                      </td>
                      <td style={{ padding: '8px 10px' }}><StatusBadge status={run.status} /></td>
                      <td style={{ padding: '8px 10px', textAlign: 'center', color: '#16a34a', fontWeight: 600 }}>{run.count_inserted ?? 0}</td>
                      <td style={{ padding: '8px 10px', textAlign: 'center', color: '#6b7280' }}>{run.count_skipped ?? 0}</td>
                      <td style={{ padding: '8px 10px', textAlign: 'center', color: run.count_errors > 0 ? '#dc2626' : '#6b7280' }}>{run.count_errors ?? 0}</td>
                      <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>
                        {run.status === 'completed' && (run.count_inserted ?? 0) > 0 ? (
                          <a href={`/api/admin/runs/${run.id}/csv?secret=${encodeURIComponent(secret)}`} style={{ color: '#2563eb', fontWeight: 600 }}>Download</a>
                        ) : (
                          <span style={{ color: '#9ca3af' }}>-</span>
                        )}
                      </td>
                      <td style={{ padding: '8px 10px', color: '#9ca3af', whiteSpace: 'nowrap' }}>{timeAgo(run.started_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {runs.some(r => r.status === 'failed') && (
            <div style={{ marginTop: 12 }}>
              {runs.filter(r => r.status === 'failed').slice(0, 3).map(r => r.error_message && (
                <details key={r.id} style={{ marginBottom: 6 }}>
                  <summary style={{ fontSize: 12, color: '#dc2626', cursor: 'pointer' }}>
                    Error in run {r.id.slice(0, 8)}… ({timeAgo(r.started_at)})
                  </summary>
                  <pre style={{ margin: '4px 0 0', fontSize: 11, color: '#991b1b', whiteSpace: 'pre-wrap', backgroundColor: '#fef2f2', padding: 8, borderRadius: 4 }}>
                    {r.error_message}
                  </pre>
                </details>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function Spinner({ color = '#fff' }: { color?: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" style={{ animation: 'spin 0.8s linear infinite', flexShrink: 0 }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
      <circle cx="8" cy="8" r="6" fill="none" stroke={color === '#fff' ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.1)'} strokeWidth="2" />
      <path d="M8 2 A6 6 0 0 1 14 8" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}
