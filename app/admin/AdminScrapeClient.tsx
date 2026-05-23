'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { CATEGORIES, TARGET_SEARCH_SITES } from '@/lib/types'

/* ── Types ───────────────────────────────────────────── */

interface FieldCandidate {
  value: string | number
  source: string
}

interface RawDataWithCandidates extends Record<string, unknown> {
  candidates?: {
    title?: FieldCandidate[]
    description?: FieldCandidate[]
    priceCents?: FieldCandidate[]
    imageUrl?: FieldCandidate[]
  }
}

interface ScrapeItem {
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
  raw_data?: RawDataWithCandidates
}

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
  csvData?: string
  isLocal?: boolean
}

interface RunResult {
  inserted?: number
  collected?: number
  skipped?: number
  errors?: number
  error?: string
  runId?: string
  sellerNickname?: string
  csvData?: string
  items?: ScrapeItem[]
  stats?: {
    fetched: number
    parsed: number
    strong: number
    partial: number
    weak: number
    failed: number
    duplicates: number
    invalid: number
    autoSkipped: number
    avgQuality: number
    stageLog?: string[]
  }
}

interface AiProgressState {
  phase: string
  message: string
  percent: number
  current?: number
  total?: number
  itemLabel?: string
  log: string[]
}

interface AiStreamItemEvent {
  item: ScrapeItem
  index: number
  total: number
}

/* ── Editable row for validation ────────────────────── */

interface EditableItem {
  _idx: number
  _included: boolean
  source_url: string
  title: string
  description: string
  price: string
  shop_name: string
  location: string
  state: string
  municipio: string
  image_url: string
  category: string
  listing_type: string
  condition: string
  ai_confidence: string
  ai_summary: string
  ai_missing_fields: string
  parser_status: string
  candidates: {
    title: FieldCandidate[]
    description: FieldCandidate[]
    priceCents: FieldCandidate[]
    imageUrl: FieldCandidate[]
  }
}

/* ── Helpers ──────────────────────────────────────────── */

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

function priceFromCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return ''
  return (cents / 100).toFixed(2)
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value)
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`
  return text
}

function editableItemsToCsv(items: EditableItem[]): string {
  const headers = ['source_url', 'title', 'description', 'price', 'shop_name', 'location', 'state', 'municipio', 'image_url', 'category', 'listing_type', 'condition']
  const lines = [
    headers.join(','),
    ...items.filter(i => i._included).map(item => [
      item.source_url,
      item.title,
      item.description,
      item.price,
      item.shop_name,
      item.location,
      item.state,
      item.municipio,
      item.image_url,
      item.category,
      item.listing_type,
      item.condition,
    ].map(csvCell).join(',')),
  ]
  return `${lines.join('\n')}\n`
}

function scrapeItemToEditable(item: ScrapeItem, idx: number): EditableItem {
  const cands = item.raw_data?.candidates
  return {
    _idx: idx,
    _included: true,
    source_url: item.source_url ?? '',
    title: item.listing_title ?? '',
    description: item.listing_description ?? '',
    price: priceFromCents(item.price_cents),
    shop_name: item.shop_name ?? '',
    location: item.location ?? '',
    state: item.state ?? '',
    municipio: item.municipio ?? '',
    image_url: item.image_url ?? '',
    category: item.category ?? '',
    listing_type: item.listing_type ?? '',
    condition: item.condition ?? '',
    ai_confidence: item.raw_data?.ai_confidence === null || item.raw_data?.ai_confidence === undefined ? '' : String(item.raw_data.ai_confidence),
    ai_summary: typeof item.raw_data?.ai_evidence_summary === 'string' ? item.raw_data.ai_evidence_summary : '',
    ai_missing_fields: Array.isArray(item.raw_data?.ai_missing_fields) ? item.raw_data.ai_missing_fields.join(', ') : '',
    parser_status: typeof item.raw_data?.parser_status === 'string' ? item.raw_data.parser_status : '',
    candidates: {
      title: cands?.title ?? [],
      description: cands?.description ?? [],
      priceCents: cands?.priceCents ?? [],
      imageUrl: cands?.imageUrl ?? [],
    },
  }
}

function downloadCsv(csvData: string, filename: string) {
  const blob = new Blob([csvData], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

async function clipboardImageOrText(): Promise<string | null> {
  try {
    const text = await navigator.clipboard.readText()
    if (/^(https?:|data:image\/)/i.test(text.trim())) return text.trim()
  } catch {}

  try {
    const items = await navigator.clipboard.read()
    for (const item of items) {
      const imageType = item.types.find(type => type.startsWith('image/'))
      if (!imageType) continue
      const blob = await item.getType(imageType)
      return await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result ?? ''))
        reader.onerror = () => reject(reader.error)
        reader.readAsDataURL(blob)
      })
    }
  } catch {}

  return null
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
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

function sourceLabel(source: string): string {
  if (source === 'ai_assisted_scrape') return 'AI Assisted'
  if (source === 'serpapi_google_local') return 'Google Local'
  if (source === 'mercadolibre_seller') return 'ML Seller'
  if (source === 'targeted_website_search') return 'Targeted Search'
  if (source === 'targeted_apify_actor') return 'Apify Targeted'
  return 'ML Keyword'
}

type TargetedSource = 'serpapi' | 'apify'

const APIFY_SITE_KEYS = new Set(['inmuebles24', 'mercadolibre'])

const INMUEBLES_PROPERTY_TYPES = [
  { value: '', label: 'Any' },
  { value: 'Departamento', label: 'Departamento' },
  { value: 'Casa', label: 'Casa' },
  { value: 'Terreno', label: 'Terreno' },
  { value: 'Oficina comercial', label: 'Oficina comercial' },
  { value: 'Local comercial', label: 'Local comercial' },
  { value: 'Bodega comercial', label: 'Bodega comercial' },
  { value: 'Quinta Vacacional', label: 'Quinta vacacional' },
]

const INMUEBLES_OPERATION_TYPES = [
  { value: '', label: 'Any' },
  { value: 'Venta', label: 'Venta' },
  { value: 'Renta', label: 'Renta' },
  { value: 'Renta temporal', label: 'Renta temporal' },
]

const INMUEBLES_PUBLISHED_DATES = [
  { value: '', label: 'Any' },
  { value: 'Hoy', label: 'Hoy' },
  { value: 'Ayer', label: 'Ayer' },
  { value: 'Última semana', label: 'Última semana' },
  { value: 'Últimos 15 días', label: 'Últimos 15 días' },
  { value: 'Último mes', label: 'Último mes' },
]

const APIFY_SORT_OPTIONS = [
  { value: '', label: 'Relevance' },
  { value: 'relevance', label: 'Relevance' },
  { value: 'price_asc', label: 'Price low to high' },
  { value: 'price_desc', label: 'Price high to low' },
  { value: 'newest', label: 'Newest' },
]

const ML_SEARCH_CATEGORIES = [
  { value: 'all', label: 'All categories' },
  { value: 'vehicles', label: 'Vehicles' },
  { value: 'real_estate', label: 'Real estate' },
  { value: 'services', label: 'Services' },
  { value: 'electronics', label: 'Electronics' },
  { value: 'home', label: 'Home' },
]

const LOCATION_OPTIONS = [
  { location: 'Ciudad de México, Mexico', state: 'Ciudad de México', municipios: ['Cuauhtémoc', 'Miguel Hidalgo', 'Benito Juárez', 'Coyoacán', 'Álvaro Obregón', 'Tlalpan', 'Venustiano Carranza', 'Azcapotzalco', 'Iztacalco', 'Iztapalapa'] },
  { location: 'Estado de México, Mexico', state: 'Estado de México', municipios: ['Naucalpan de Juárez', 'Tlalnepantla de Baz', 'Huixquilucan', 'Atizapán de Zaragoza', 'Ecatepec de Morelos', 'Metepec', 'Toluca'] },
  { location: 'Jalisco, Mexico', state: 'Jalisco', municipios: ['Guadalajara', 'Zapopan', 'Tlaquepaque', 'Tlajomulco de Zúñiga'] },
  { location: 'Nuevo León, Mexico', state: 'Nuevo León', municipios: ['Monterrey', 'San Pedro Garza García', 'San Nicolás de los Garza', 'Guadalupe', 'Santa Catarina'] },
  { location: 'Querétaro, Mexico', state: 'Querétaro', municipios: ['Querétaro', 'El Marqués', 'Corregidora'] },
  { location: 'Puebla, Mexico', state: 'Puebla', municipios: ['Puebla', 'San Andrés Cholula', 'San Pedro Cholula'] },
]

/* ── Candidate Picker Component ──────────────────────── */

function CandidatePicker({
  field,
  currentValue,
  candidates,
  onSelect,
  formatValue,
}: {
  field: string
  currentValue: string
  candidates: FieldCandidate[]
  onSelect: (value: string) => void
  formatValue?: (v: string | number) => string
}) {
  const [isOpen, setIsOpen] = useState(false)
  const fmt = formatValue ?? ((v: string | number) => String(v))

  if (candidates.length === 0) return null

  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        style={{
          background: 'none', border: 'none', cursor: 'pointer',
          color: '#6366f1', fontSize: 11, fontWeight: 600,
          padding: '2px 4px', borderRadius: 4,
          display: 'flex', alignItems: 'center', gap: 3,
        }}
        title={`${candidates.length} candidate${candidates.length > 1 ? 's' : ''} for ${field}`}
      >
        <span style={{ fontSize: 13 }}>⬡</span>
        {candidates.length}
      </button>
      {isOpen && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, zIndex: 100,
          backgroundColor: '#fff', border: '1px solid #e5e7eb',
          borderRadius: 8, boxShadow: '0 8px 30px rgba(0,0,0,0.15)',
          minWidth: 320, maxWidth: 450, maxHeight: 300, overflowY: 'auto',
          padding: 6,
        }}>
          <div style={{ fontSize: 11, color: '#6b7280', padding: '4px 8px', fontWeight: 600, borderBottom: '1px solid #f3f4f6', marginBottom: 4 }}>
            Candidates for {field}
          </div>
          {candidates.map((c, i) => {
            const display = fmt(c.value)
            const isSelected = display === currentValue || String(c.value) === currentValue
            return (
              <button
                key={i}
                type="button"
                onClick={() => { onSelect(display); setIsOpen(false) }}
                style={{
                  display: 'block', width: '100%', textAlign: 'left',
                  padding: '6px 8px', borderRadius: 4, fontSize: 12,
                  border: 'none', cursor: 'pointer',
                  backgroundColor: isSelected ? '#eef2ff' : 'transparent',
                  color: '#111827',
                  lineHeight: 1.4,
                }}
                onMouseEnter={e => { (e.target as HTMLButtonElement).style.backgroundColor = isSelected ? '#eef2ff' : '#f9fafb' }}
                onMouseLeave={e => { (e.target as HTMLButtonElement).style.backgroundColor = isSelected ? '#eef2ff' : 'transparent' }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                  <span style={{
                    overflow: 'hidden', textOverflow: 'ellipsis',
                    display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                    flex: 1, wordBreak: 'break-word',
                  }}>
                    {isSelected && <span style={{ color: '#4f46e5', marginRight: 4 }}>✓</span>}
                    {display || <em style={{ color: '#9ca3af' }}>(empty)</em>}
                  </span>
                  <span style={{
                    flexShrink: 0, fontSize: 10, fontWeight: 600,
                    backgroundColor: '#f3f4f6', color: '#6b7280',
                    padding: '1px 6px', borderRadius: 10,
                    whiteSpace: 'nowrap',
                  }}>
                    {c.source}
                  </span>
                </div>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function ImageEditor({
  value,
  candidates,
  onChange,
}: {
  value: string
  candidates: FieldCandidate[]
  onChange: (value: string) => void
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  async function pasteImage() {
    const next = await clipboardImageOrText()
    if (next) onChange(next)
  }

  async function uploadImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    onChange(await fileToDataUrl(file))
    e.target.value = ''
  }

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div style={{ display: 'grid', gridTemplateColumns: value ? '180px 1fr' : '1fr', gap: 12, alignItems: 'start' }}>
        {value && (
          <a href={value} target="_blank" rel="noopener noreferrer" title="Open image in a new tab">
            <img
              src={value}
              alt="preview"
              style={{ width: 180, height: 120, borderRadius: 6, border: '1px solid #e5e7eb', objectFit: 'cover', backgroundColor: '#f8fafc' }}
              onError={e => { (e.target as HTMLImageElement).style.opacity = '0.35' }}
            />
          </a>
        )}
        <div style={{ display: 'grid', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: '#6b7280' }}>Image URL</span>
            <CandidatePicker
              field="Image"
              currentValue={value}
              candidates={candidates}
              onSelect={onChange}
            />
          </div>
          <input
            type="text"
            value={value}
            onChange={e => onChange(e.target.value)}
            placeholder="https://..."
            style={{
              width: '100%', padding: '4px 6px', border: '1px solid #e5e7eb',
              borderRadius: 4, fontSize: 12, boxSizing: 'border-box',
              backgroundColor: '#fff', fontFamily: 'inherit',
            }}
          />
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" onClick={() => { void pasteImage() }} style={{ padding: '5px 9px', borderRadius: 5, border: '1px solid #d1d5db', backgroundColor: '#fff', cursor: 'pointer', fontSize: 12 }}>Paste</button>
            <button type="button" onClick={() => fileInputRef.current?.click()} style={{ padding: '5px 9px', borderRadius: 5, border: '1px solid #d1d5db', backgroundColor: '#fff', cursor: 'pointer', fontSize: 12 }}>Upload</button>
            <input ref={fileInputRef} type="file" accept="image/*" onChange={e => { void uploadImage(e) }} style={{ display: 'none' }} />
            <button type="button" onClick={() => onChange('')} style={{ padding: '5px 9px', borderRadius: 5, border: '1px solid #fecaca', backgroundColor: '#fff', color: '#b91c1c', cursor: 'pointer', fontSize: 12 }}>Remove</button>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ── Validation Table Component ──────────────────────── */

function ValidationTable({
  items,
  onUpdate,
  onExport,
  onCancel,
  sourceName,
  progress,
  isRunning = false,
  isPaused = false,
  onPause,
  onResume,
  onStop,
}: {
  items: EditableItem[]
  onUpdate: (idx: number, field: keyof EditableItem, value: string | boolean) => void
  onExport: () => void
  onCancel: () => void
  sourceName: string
  progress?: AiProgressState | null
  isRunning?: boolean
  isPaused?: boolean
  onPause?: () => void
  onResume?: () => void
  onStop?: () => void
}) {
  const [expandedRow, setExpandedRow] = useState<number | null>(null)
  const includedCount = items.filter(i => i._included).length
  const showLiveControls = Boolean(progress || isRunning || isPaused || onPause || onResume || onStop)

  const editableFields: Array<{ key: keyof EditableItem; label: string; candidateKey?: keyof EditableItem['candidates']; long?: boolean }> = [
    { key: 'source_url', label: 'Source URL', long: true },
    { key: 'title', label: 'Title', candidateKey: 'title' },
    { key: 'description', label: 'Description', candidateKey: 'description' },
    { key: 'price', label: 'Price', candidateKey: 'priceCents' },
    { key: 'shop_name', label: 'Shop' },
    { key: 'location', label: 'Location' },
    { key: 'state', label: 'State' },
    { key: 'municipio', label: 'Municipio' },
    { key: 'category', label: 'Category' },
    { key: 'listing_type', label: 'Listing Type' },
    { key: 'condition', label: 'Condition' },
  ]

  const cellInput: React.CSSProperties = {
    width: '100%', padding: '4px 6px', border: '1px solid #e5e7eb',
    borderRadius: 4, fontSize: 12, boxSizing: 'border-box',
    backgroundColor: '#fff', fontFamily: 'inherit',
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      backgroundColor: 'rgba(0,0,0,0.5)',
      display: 'flex', flexDirection: 'column',
    }}>
      <div style={{
        backgroundColor: '#fff', flex: 1,
        display: 'flex', flexDirection: 'column',
        margin: '20px', borderRadius: 12,
        boxShadow: '0 25px 50px rgba(0,0,0,0.25)',
        overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{
          padding: '16px 24px', borderBottom: '1px solid #e5e7eb',
          display: 'grid', gap: 12,
          background: 'linear-gradient(to right, #f8fafc, #eef2ff)',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 18 }}>
            <div>
              <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: '#111827' }}>
                📋 Validate Scraped Data
              </h2>
              <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280' }}>
                {includedCount} of {items.length} items included · {sourceName}
                {' · '}Click <span style={{ color: '#6366f1', fontWeight: 600 }}>⬡</span> to see alternative candidates from different parsers
              </p>
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              {isRunning && onPause && (
                <button type="button" onClick={onPause} style={{
                  padding: '8px 14px', borderRadius: 6, border: '1px solid #f59e0b',
                  backgroundColor: '#fffbeb', color: '#92400e', fontSize: 13,
                  fontWeight: 700, cursor: 'pointer',
                }}>Pause</button>
              )}
              {isPaused && onResume && (
                <button type="button" onClick={onResume} style={{
                  padding: '8px 14px', borderRadius: 6, border: '1px solid #0d9488',
                  backgroundColor: '#f0fdfa', color: '#0f766e', fontSize: 13,
                  fontWeight: 700, cursor: 'pointer',
                }}>Resume</button>
              )}
              {(isRunning || isPaused) && onStop && (
                <button type="button" onClick={onStop} style={{
                  padding: '8px 14px', borderRadius: 6, border: '1px solid #fecaca',
                  backgroundColor: '#fff', color: '#b91c1c', fontSize: 13,
                  fontWeight: 700, cursor: 'pointer',
                }}>Cancel Run</button>
              )}
              <button type="button" onClick={() => {
                if (window.confirm('Discard these scraped results? Export or keep reviewing if you still need them.')) onCancel()
              }} style={{
                padding: '8px 18px', borderRadius: 6, border: '1px solid #d1d5db',
                backgroundColor: '#fff', color: '#374151', fontSize: 13,
                fontWeight: 600, cursor: 'pointer',
              }}>Discard</button>
              <button type="button" onClick={onExport} style={{
                padding: '8px 22px', borderRadius: 6, border: 'none',
                background: 'linear-gradient(135deg, #4f46e5, #6366f1)',
                color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer',
                boxShadow: '0 2px 8px rgba(99,102,241,0.35)',
              }}>
                ✦ Export CSV ({includedCount} rows)
              </button>
            </div>
          </div>

          {showLiveControls && (
            <div style={{ display: 'grid', gap: 6, padding: 10, borderRadius: 8, backgroundColor: '#fff', border: '1px solid #e5e7eb' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, color: '#475569', flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 700, color: isPaused ? '#92400e' : isRunning ? '#0369a1' : '#334155' }}>
                  {isPaused ? 'Paused' : isRunning ? 'Scraping live' : 'Review ready'}
                </span>
                {progress && <span>{Math.round(progress.percent)}% · {progress.message}</span>}
                {progress?.current && progress?.total && <span>Item {progress.current}/{progress.total}</span>}
              </div>
              <div style={{ height: 8, backgroundColor: '#e2e8f0', borderRadius: 999, overflow: 'hidden' }}>
                <div style={{ width: `${Math.max(1, Math.min(100, progress?.percent ?? (items.length ? 100 : 2)))}%`, height: '100%', backgroundColor: isPaused ? '#f59e0b' : '#0ea5e9', transition: 'width 0.2s ease' }} />
              </div>
              {progress?.itemLabel && <div style={{ fontSize: 12, color: '#64748b', wordBreak: 'break-word' }}>Working on: {progress.itemLabel}</div>}
              {progress?.log?.length ? (
                <div style={{ display: 'grid', gap: 2, fontSize: 11, color: '#64748b' }}>
                  {progress.log.slice(-4).map((entry, index) => <span key={`${index}-${entry}`}>{entry}</span>)}
                </div>
              ) : null}
            </div>
          )}
        </div>

        {/* Table body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '0 8px' }}>
          {items.length === 0 && (
            <div style={{ margin: 16, padding: 18, border: '1px dashed #cbd5e1', borderRadius: 8, backgroundColor: '#f8fafc', color: '#475569', fontSize: 13 }}>
              Rows will appear here as soon as the scraper validates each listing. You can pause or cancel the run and keep anything already captured.
            </div>
          )}
          {items.map((item, idx) => {
            const isExpanded = expandedRow === idx
            const hasAnyCandidates = Object.values(item.candidates).some(c => c.length > 0)

            return (
              <div
                key={idx}
                style={{
                  margin: '8px 0',
                  border: `1px solid ${item._included ? '#e5e7eb' : '#fecaca'}`,
                  borderRadius: 8,
                  backgroundColor: item._included ? '#fff' : '#fef2f2',
                  opacity: item._included ? 1 : 0.6,
                  transition: 'all 0.15s ease',
                }}
              >
                {/* Row summary bar */}
                <div
                  style={{
                    padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10,
                    cursor: 'pointer', userSelect: 'none',
                    borderBottom: isExpanded ? '1px solid #f3f4f6' : 'none',
                  }}
                  onClick={() => setExpandedRow(isExpanded ? null : idx)}
                >
                  <input
                    type="checkbox"
                    checked={item._included}
                    onChange={e => { e.stopPropagation(); onUpdate(idx, '_included', e.target.checked) }}
                    onClick={e => e.stopPropagation()}
                    style={{ width: 16, height: 16, accentColor: '#4f46e5', cursor: 'pointer' }}
                  />
                  <span style={{ fontSize: 13, fontWeight: 600, color: '#111827', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {item.title || <em style={{ color: '#9ca3af' }}>No title</em>}
                  </span>
                  {item.price && (
                    <span style={{ fontSize: 12, fontWeight: 700, color: '#059669', backgroundColor: '#ecfdf5', padding: '2px 8px', borderRadius: 10 }}>
                      ${item.price}
                    </span>
                  )}
                  {!item.price && (
                    <span style={{ fontSize: 11, color: '#dc2626', backgroundColor: '#fef2f2', padding: '2px 6px', borderRadius: 10 }}>no price</span>
                  )}
                  {item.image_url && (
                    <span style={{ fontSize: 11, color: '#059669' }}>📷</span>
                  )}
                  {!item.image_url && (
                    <span style={{ fontSize: 11, color: '#dc2626' }}>no img</span>
                  )}
                  {hasAnyCandidates && (
                    <span style={{ fontSize: 10, color: '#6366f1', backgroundColor: '#eef2ff', padding: '2px 6px', borderRadius: 10, fontWeight: 600 }}>
                      has candidates
                    </span>
                  )}
                  {item.ai_confidence && (
                    <span style={{ fontSize: 10, color: '#0369a1', backgroundColor: '#e0f2fe', padding: '2px 6px', borderRadius: 10, fontWeight: 600 }}>
                      AI {item.ai_confidence}
                    </span>
                  )}
                  <span style={{ fontSize: 18, color: '#9ca3af', transform: isExpanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}>▾</span>
                </div>

                {/* Expanded editor */}
                {isExpanded && (
                  <div style={{ padding: '12px 14px' }}>
                    {/* Source URL (read only) */}
                    <div style={{ marginBottom: 10 }}>
                      <div style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', marginBottom: 2 }}>Source URL</div>
                      <a href={item.source_url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, color: '#2563eb', wordBreak: 'break-all' }}>
                        {item.source_url}
                      </a>
                    </div>

                    {(item.ai_summary || item.ai_missing_fields || item.parser_status) && (
                      <div style={{ marginBottom: 10, padding: 10, borderRadius: 6, backgroundColor: '#f8fafc', border: '1px solid #e2e8f0', fontSize: 12, color: '#475569', display: 'grid', gap: 4 }}>
                        {item.parser_status && <span><strong>Parser:</strong> {item.parser_status}</span>}
                        {item.ai_summary && <span><strong>AI work:</strong> {item.ai_summary}</span>}
                        {item.ai_missing_fields && <span><strong>Still missing:</strong> {item.ai_missing_fields}</span>}
                      </div>
                    )}

                    <div style={{ marginBottom: 12 }}>
                      <ImageEditor
                        value={item.image_url}
                        candidates={item.candidates.imageUrl}
                        onChange={value => onUpdate(idx, 'image_url', value)}
                      />
                    </div>

                    {/* Editable fields grid */}
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 16px' }}>
                      {editableFields.map(({ key, label, candidateKey, long }) => {
                        const candidates = candidateKey ? item.candidates[candidateKey] : []
                        const value = String(item[key] ?? '')
                        const isLongField = long || key === 'description'

                        return (
                          <div key={key} style={isLongField ? { gridColumn: '1 / -1' } : {}}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2 }}>
                              <span style={{ fontSize: 11, fontWeight: 600, color: '#6b7280' }}>{label}</span>
                              {candidates.length > 0 && (
                                <CandidatePicker
                                  field={label}
                                  currentValue={value}
                                  candidates={candidates}
                                  onSelect={v => onUpdate(idx, key, v)}
                                  formatValue={candidateKey === 'priceCents' ? (v) => (Number(v) / 100).toFixed(2) : undefined}
                                />
                              )}
                            </div>
                            {isLongField ? (
                              <textarea
                                value={value}
                                onChange={e => onUpdate(idx, key, e.target.value)}
                                rows={3}
                                style={{ ...cellInput, resize: 'vertical' }}
                              />
                            ) : (
                              <input
                                type="text"
                                value={value}
                                onChange={e => onUpdate(idx, key, e.target.value)}
                                style={cellInput}
                              />
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

/* ── Result Banner ───────────────────────────────────── */

function ResultBanner({ result, loading, secret, sourceLabelStr, aiProgress }: { result: RunResult | null; loading: boolean; secret: string; sourceLabelStr: string; aiProgress?: AiProgressState | null }) {
  if (loading) return (
    <div style={{ marginTop: 14, padding: '10px 14px', borderRadius: 6, backgroundColor: '#f0f9ff', border: '1px solid #bae6fd', fontSize: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Spinner color="#0369a1" />
        <span style={{ color: '#0369a1' }}>{aiProgress?.message ?? 'Scraping in progress…'}</span>
      </div>
      {sourceLabelStr === 'ai_assisted' && aiProgress && (
        <div style={{ marginTop: 8, display: 'grid', gap: 3, color: '#075985', fontSize: 12 }}>
          <div style={{ height: 8, backgroundColor: '#bae6fd', borderRadius: 999, overflow: 'hidden' }}>
            <div style={{ width: `${Math.max(1, Math.min(100, aiProgress.percent))}%`, height: '100%', backgroundColor: '#0284c7', transition: 'width 0.2s ease' }} />
          </div>
          <span>{Math.round(aiProgress.percent)}% · {aiProgress.phase}{aiProgress.current && aiProgress.total ? ` · item ${aiProgress.current}/${aiProgress.total}` : ''}</span>
          {aiProgress.itemLabel && <span style={{ wordBreak: 'break-word' }}>Working on: {aiProgress.itemLabel}</span>}
          {aiProgress.log.slice(-5).map((entry, index) => <span key={`${index}-${entry}`}>{entry}</span>)}
        </div>
      )}
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
        <div>
          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'center' }}>
            {result.sellerNickname && <span style={{ color: '#166534' }}>Seller: <strong>{result.sellerNickname}</strong></span>}
            <span style={{ color: '#166534' }}>Collected <strong>{result.collected ?? result.inserted}</strong></span>
            <span style={{ color: '#475569' }}>Auto-skipped <strong>{result.stats?.autoSkipped ?? result.skipped ?? 0}</strong></span>
            {(result.errors ?? 0) > 0 && <span style={{ color: '#dc2626' }}>Errors <strong>{result.errors}</strong></span>}
            {result.csvData && (
              <button
                onClick={() => downloadCsv(result.csvData!, `scrape_${sourceLabelStr}_${Date.now()}.csv`)}
                style={{ color: '#166534', fontWeight: 600, background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontSize: 14 }}
              >
                Download CSV
              </button>
            )}
            {result.runId && !result.csvData && (
              <a href={`/api/admin/runs/${result.runId}/csv?secret=${encodeURIComponent(secret)}`} style={{ color: '#166534', fontWeight: 600 }}>
                Download CSV (DB)
              </a>
            )}
          </div>
          {result.stats && (
            <div style={{ marginTop: 8, display: 'flex', gap: 12, flexWrap: 'wrap', color: '#475569', fontSize: 12 }}>
              <span>Fetched {result.stats.fetched}</span>
              <span>Parsed {result.stats.parsed}</span>
              <span>Quality {result.stats.avgQuality}/100</span>
              <span>Strong {result.stats.strong}</span>
              <span>Partial {result.stats.partial}</span>
              <span>Weak {result.stats.weak}</span>
              {(result.stats.duplicates > 0 || result.stats.invalid > 0) && (
                <span>Filtered links {result.stats.duplicates + result.stats.invalid}</span>
              )}
            </div>
          )}
          {result.stats?.stageLog && result.stats.stageLog.length > 0 && (
            <details open style={{ marginTop: 10 }}>
              <summary style={{ cursor: 'pointer', color: '#166534', fontSize: 12, fontWeight: 700 }}>Run details</summary>
              <div style={{ marginTop: 6, display: 'grid', gap: 4, color: '#475569', fontSize: 12 }}>
                {result.stats.stageLog.map((entry, index) => (
                  <span key={`${index}-${entry}`}>{entry}</span>
                ))}
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  )
}

/* ── Form State Interfaces ───────────────────────────── */

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

interface TargetedFormState {
  source: TargetedSource
  query: string
  targetSite: string
  category: string
  location: string
  state: string
  limit: string
  apifyMode: 'urls' | 'filters'
  urls: string
  ignoreUrlFailures: boolean
  propertyType: string
  operationType: string
  publishedDate: string
  sortBy: string
  page: string
  maxRetries: string
  searchCategory: string
  domainCode: string
  fastMode: boolean
  vehicleYear: string
}

interface AiAssistedFormState {
  inputMode: 'search' | 'urls' | 'mercadolibre_seller' | 'inmuebles24_search'
  query: string
  urls: string
  targetSite: string
  category: string
  listingType: 'product' | 'service' | 'rental' | 'digital'
  assistMode: 'normalize' | 'enrich' | 'url_image'
  imageEnrichment: boolean
  strictItemPages: boolean
  maxSerpRequests: string
  maxRuntimeSeconds: string
  location: string
  state: string
  municipio: string
  limit: string
}

/* ── Main Component ──────────────────────────────────── */

export default function AdminScrapeClient({ secret }: { secret: string }) {
  const [apiKey, setApiKey] = useState('')
  const [apifyApiKey, setApifyApiKey] = useState('')
  const [geminiApiKey, setGeminiApiKey] = useState('')
  const [validationMode, setValidationMode] = useState(true)
  const [runs, setRuns] = useState<ScrapeRun[]>([])

  // Validation state
  const [validatingItems, setValidatingItems] = useState<EditableItem[] | null>(null)
  const [validationSource, setValidationSource] = useState('')
  const aiAbortRef = useRef<AbortController | null>(null)
  const aiAbortReasonRef = useRef<'pause' | 'cancel' | null>(null)
  const [aiPaused, setAiPaused] = useState(false)
  const [lastAiParams, setLastAiParams] = useState<Record<string, unknown> | null>(null)

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
  const [targetedForm, setTargetedForm] = useState<TargetedFormState>({
    source: 'serpapi',
    query: '',
    targetSite: 'mercadolibre',
    category: 'autos',
    location: 'Ciudad de México, Mexico',
    state: 'Ciudad de México',
    limit: '20',
    apifyMode: 'filters',
    urls: '',
    ignoreUrlFailures: true,
    propertyType: '',
    operationType: '',
    publishedDate: '',
    sortBy: '',
    page: '1',
    maxRetries: '2',
    searchCategory: 'all',
    domainCode: 'MX',
    fastMode: true,
    vehicleYear: '',
  })
  const [aiForm, setAiForm] = useState<AiAssistedFormState>({
    inputMode: 'search',
    query: '',
    urls: '',
    targetSite: 'mercadolibre',
    category: 'autos',
    listingType: 'product',
    assistMode: 'enrich',
    imageEnrichment: true,
    strictItemPages: true,
    maxSerpRequests: '40',
    maxRuntimeSeconds: '180',
    location: 'Ciudad de México, Mexico',
    state: 'Ciudad de México',
    municipio: '',
    limit: '20',
  })

  const [aiLoading, setAiLoading] = useState(false)
  const [serpLoading, setSerpLoading] = useState(false)
  const [mlLoading, setMlLoading] = useState(false)
  const [mlSellerLoading, setMlSellerLoading] = useState(false)
  const [targetedLoading, setTargetedLoading] = useState(false)
  const [aiResult, setAiResult] = useState<RunResult | null>(null)
  const [aiProgress, setAiProgress] = useState<AiProgressState | null>(null)
  const [serpResult, setSerpResult] = useState<RunResult | null>(null)
  const [mlResult, setMlResult] = useState<RunResult | null>(null)
  const [mlSellerResult, setMlSellerResult] = useState<RunResult | null>(null)
  const [targetedResult, setTargetedResult] = useState<RunResult | null>(null)

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const savedKey = localStorage.getItem('miyagi_serpapi_key')
      if (savedKey) setApiKey(savedKey)
      const savedApifyKey = localStorage.getItem('miyagi_apify_key')
      if (savedApifyKey) setApifyApiKey(savedApifyKey)
      const savedGeminiKey = localStorage.getItem('miyagi_gemini_key')
      if (savedGeminiKey) setGeminiApiKey(savedGeminiKey)
      const savedMode = localStorage.getItem('miyagi_validation_mode')
      if (savedMode !== null) setValidationMode(savedMode === 'true')
    }, 0)
    return () => window.clearTimeout(timer)
  }, [])

  const handleApiKeyChange = (val: string) => {
    setApiKey(val)
    localStorage.setItem('miyagi_serpapi_key', val)
  }

  const handleApifyApiKeyChange = (val: string) => {
    setApifyApiKey(val)
    localStorage.setItem('miyagi_apify_key', val)
  }

  const handleGeminiApiKeyChange = (val: string) => {
    setGeminiApiKey(val)
    localStorage.setItem('miyagi_gemini_key', val)
  }

  const handleValidationToggle = (val: boolean) => {
    setValidationMode(val)
    localStorage.setItem('miyagi_validation_mode', String(val))
  }

  const getLocalRuns = useCallback((): ScrapeRun[] => {
    try {
      const stored = localStorage.getItem('miyagi_local_runs')
      if (stored) return JSON.parse(stored) as ScrapeRun[]
    } catch (e) {
      console.error('Failed to parse local runs', e)
    }
    return []
  }, [])

  const saveLocalRun = useCallback((run: ScrapeRun) => {
    const runs = getLocalRuns()
    runs.unshift(run)
    if (runs.length > 20) runs.length = 20
    localStorage.setItem('miyagi_local_runs', JSON.stringify(runs))
  }, [getLocalRuns])

  const fetchRuns = useCallback(async () => {
    let serverRuns: ScrapeRun[] = []
    try {
      const res = await fetch(`/api/admin/runs?secret=${encodeURIComponent(secret)}`)
      if (res.ok) {
        const json = await res.json() as { runs: ScrapeRun[], isLocalOnly?: boolean }
        serverRuns = json.runs || []
      }
    } catch (e) {
      console.error(e)
    }

    const localRuns = getLocalRuns()
    const merged = [...localRuns, ...serverRuns]
    const unique = Array.from(new Map(merged.map(r => [r.id, r])).values())
    unique.sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime())
    setRuns(unique)
  }, [secret, getLocalRuns])

  useEffect(() => {
    const timer = window.setTimeout(() => { void fetchRuns() }, 0)
    return () => window.clearTimeout(timer)
  }, [fetchRuns])

  /* Handle scrape response – either open validation or auto-download */
  function handleScrapeResult(json: RunResult, source: string, params: Record<string, unknown>) {
    if (json.error) return

    // If validation mode is ON and we have items, open the validation UI
    if (validationMode && json.items && json.items.length > 0) {
      const editables = json.items.map((item, i) => scrapeItemToEditable(item, i))
      setValidatingItems(editables)
      setValidationSource(source)
      return
    }

    // Otherwise auto-download CSV (legacy behavior)
    if (json.csvData) {
      downloadCsv(json.csvData, `scrape_${source}_${Date.now()}.csv`)
      saveLocalRun({
        id: json.runId || `local-${Date.now()}`,
        source,
        params,
        status: 'completed',
        count_inserted: json.inserted || json.collected || 0,
        count_skipped: json.skipped || 0,
        count_errors: json.errors || 0,
        error_message: null,
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        csvData: json.csvData,
        isLocal: true,
      })
    }
  }

  function handleValidationUpdate(idx: number, field: keyof EditableItem, value: string | boolean) {
    setValidatingItems(prev => {
      if (!prev) return prev
      const updated = [...prev]
      const item = { ...updated[idx] }
      if (field === '_included') {
        item._included = value as boolean
      } else {
        (item as Record<string, unknown>)[field] = value as string
      }
      updated[idx] = item
      return updated
    })
  }

  function appendAiWorkbenchItem(item: ScrapeItem) {
    setValidationSource('ai_assisted_scrape')
    setValidatingItems(prev => {
      const existing = prev ?? []
      const incomingUrl = (item.source_url ?? '').trim().toLowerCase()
      const incomingFallback = `${item.listing_title ?? ''}|${item.image_url ?? ''}`.trim().toLowerCase()
      const alreadyExists = existing.some(row => {
        const rowUrl = row.source_url.trim().toLowerCase()
        if (incomingUrl && rowUrl === incomingUrl) return true
        return !incomingUrl && incomingFallback && `${row.title}|${row.image_url}`.trim().toLowerCase() === incomingFallback
      })
      if (alreadyExists) return existing
      return [...existing, scrapeItemToEditable(item, existing.length)]
    })
  }

  function handleValidationExport() {
    if (!validatingItems) return
    const csv = editableItemsToCsv(validatingItems)
    downloadCsv(csv, `scrape_${validationSource}_${Date.now()}.csv`)
    const included = validatingItems.filter(i => i._included).length
    saveLocalRun({
      id: `local-${Date.now()}`,
      source: validationSource,
      params: {},
      status: 'completed',
      count_inserted: included,
      count_skipped: validatingItems.length - included,
      count_errors: 0,
      error_message: null,
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      csvData: csv,
      isLocal: true,
    })
    void fetchRuns()
  }

  /* ── Scrape handlers ─────────────────────────────── */

  function updateAiProgress(message: string, phase: string, percent?: number) {
    setAiProgress(prev => {
      const next = {
        phase,
        message,
        percent: percent ?? prev?.percent ?? 1,
        current: prev?.current,
        total: prev?.total,
        itemLabel: prev?.itemLabel,
        log: [...(prev?.log ?? []), message].slice(-12),
      }
      return next
    })
  }

  async function runAiAssistedStream(params: Record<string, unknown>, resetWorkbench: boolean) {
    setAiLoading(true)
    setAiPaused(false)
    setAiResult(null)
    aiAbortReasonRef.current = null
    const controller = new AbortController()
    aiAbortRef.current = controller

    if (resetWorkbench) {
      setValidationSource('ai_assisted_scrape')
      setValidatingItems([])
      setLastAiParams(params)
      setAiProgress({ phase: 'input', message: 'Preparing AI-assisted scrape', percent: 1, log: ['Preparing AI-assisted scrape'] })
    } else {
      updateAiProgress('Resuming AI-assisted scrape; existing rows stay in the workbench', 'input', 1)
    }

    try {
      const res = await fetch('/api/admin/scrape/ai/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-secret': secret },
        signal: controller.signal,
        body: JSON.stringify({
          params,
          apiKey,
          geminiApiKey,
        }),
      })
      if (!res.ok || !res.body) {
        const json = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as RunResult
        setAiResult(json)
        return
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let finalResult: RunResult | null = null

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          const packet = JSON.parse(line) as { event: string; data: AiProgressState | RunResult | AiStreamItemEvent }
          if (packet.event === 'progress') {
            const event = packet.data as AiProgressState
            setAiProgress(prev => ({
              ...event,
              log: [...(prev?.log ?? []), event.message].slice(-12),
            }))
          } else if (packet.event === 'item') {
            const event = packet.data as AiStreamItemEvent
            appendAiWorkbenchItem(event.item)
          } else if (packet.event === 'result') {
            finalResult = packet.data as RunResult
            setAiResult(finalResult)
          } else if (packet.event === 'error') {
            finalResult = packet.data as RunResult
            setAiResult(finalResult)
          }
        }
      }

      if (finalResult) {
        finalResult.items?.forEach(item => appendAiWorkbenchItem(item))
        if (!finalResult.error && finalResult.csvData) {
          saveLocalRun({
            id: finalResult.runId || `local-${Date.now()}`,
            source: 'ai_assisted_scrape',
            params,
            status: 'completed',
            count_inserted: finalResult.inserted || finalResult.collected || 0,
            count_skipped: finalResult.skipped || 0,
            count_errors: finalResult.errors || 0,
            error_message: null,
            started_at: new Date().toISOString(),
            completed_at: new Date().toISOString(),
            csvData: finalResult.csvData,
            isLocal: true,
          })
        }
      }
      await fetchRuns()
    } catch (err) {
      const isAbort = err instanceof DOMException && err.name === 'AbortError'
      if (isAbort && aiAbortReasonRef.current === 'pause') {
        setAiPaused(true)
        updateAiProgress('Paused; rows already captured are kept in the workbench', 'paused')
      } else if (isAbort && aiAbortReasonRef.current === 'cancel') {
        setAiPaused(false)
        updateAiProgress('Cancelled; captured rows are still available for review/export', 'cancelled')
      } else {
        setAiResult({ error: String(err) })
        updateAiProgress('Scrape stopped with an error; captured rows are still available', 'warning')
      }
    } finally {
      if (aiAbortRef.current === controller) aiAbortRef.current = null
      setAiLoading(false)
    }
  }

  async function runAiAssisted(e: React.FormEvent) {
    e.preventDefault()
    const params = {
      inputMode: aiForm.inputMode,
      query: aiForm.query,
      urls: aiForm.urls,
      targetSite: aiForm.targetSite,
      category: aiForm.category,
      listingType: aiForm.listingType,
      assistMode: aiForm.assistMode,
      imageEnrichment: aiForm.imageEnrichment,
      strictItemPages: aiForm.strictItemPages,
      maxSerpRequests: Number(aiForm.maxSerpRequests),
      maxRuntimeMs: Number(aiForm.maxRuntimeSeconds) * 1000,
      location: aiForm.location,
      state: aiForm.state,
      municipio: aiForm.municipio,
      limit: Number(aiForm.limit),
    }
    await runAiAssistedStream(params, true)
  }

  function pauseAiAssisted() {
    if (!aiAbortRef.current) return
    aiAbortReasonRef.current = 'pause'
    aiAbortRef.current.abort()
  }

  function cancelAiAssisted() {
    if (!aiAbortRef.current) {
      setAiPaused(false)
      updateAiProgress('Cancelled; captured rows are still available for review/export', 'cancelled')
      return
    }
    aiAbortReasonRef.current = 'cancel'
    aiAbortRef.current.abort()
  }

  async function resumeAiAssisted() {
    if (!lastAiParams || aiLoading) return
    await runAiAssistedStream(lastAiParams, false)
  }

  async function runSerpApi(e: React.FormEvent) {
    e.preventDefault()
    setSerpLoading(true)
    setSerpResult(null)
    const params = {
      query: serpForm.query,
      location: serpForm.location,
      state: serpForm.state,
      category: serpForm.category,
      limit: Number(serpForm.limit),
    }
    try {
      const res = await fetch('/api/admin/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-secret': secret },
        body: JSON.stringify({ source: 'serpapi_google_local', mode: 'collect_only', params, apiKey }),
      })
      const json = await res.json() as RunResult
      setSerpResult(json)
      handleScrapeResult(json, 'serpapi_google_local', params)
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
    const params = {
      query: mlForm.query,
      category: mlForm.category,
      limit: Number(mlForm.limit),
      ...(mlForm.clerkUserId ? { clerkUserId: mlForm.clerkUserId } : {}),
    }
    try {
      const res = await fetch('/api/admin/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-secret': secret },
        body: JSON.stringify({ source: 'mercadolibre_public', mode: 'collect_only', params, apiKey }),
      })
      const json = await res.json() as RunResult
      setMlResult(json)
      handleScrapeResult(json, 'mercadolibre_public', params)
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
    const params = {
      sellerUrl: mlSellerForm.sellerUrl,
      category: mlSellerForm.category,
      limit: Number(mlSellerForm.limit),
    }
    try {
      const res = await fetch('/api/admin/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-secret': secret },
        body: JSON.stringify({ source: 'mercadolibre_seller', mode: 'collect_only', params, apiKey }),
      })
      const json = await res.json() as RunResult
      setMlSellerResult(json)
      handleScrapeResult(json, 'mercadolibre_seller', params)
      await fetchRuns()
    } catch (err) {
      setMlSellerResult({ error: String(err) })
    } finally {
      setMlSellerLoading(false)
    }
  }

  async function runTargeted(e: React.FormEvent) {
    e.preventDefault()
    setTargetedLoading(true)
    setTargetedResult(null)
    const params: Record<string, string | number | boolean> = {
      query: targetedForm.query,
      targetSite: targetedForm.targetSite,
      category: targetedForm.category,
      location: targetedForm.location,
      state: targetedForm.state,
      limit: Number(targetedForm.limit),
    }
    if (targetedForm.source === 'apify') {
      Object.assign(params, {
        apifyMode: targetedForm.apifyMode,
        urls: targetedForm.urls,
        ignoreUrlFailures: targetedForm.ignoreUrlFailures,
        propertyType: targetedForm.propertyType,
        operationType: targetedForm.operationType,
        publishedDate: targetedForm.publishedDate,
        sortBy: targetedForm.sortBy,
        page: Number(targetedForm.page || 1),
        maxRetries: Number(targetedForm.maxRetries || 2),
        searchCategory: targetedForm.searchCategory,
        domainCode: targetedForm.domainCode,
        fastMode: targetedForm.fastMode,
        ...(targetedForm.vehicleYear ? { vehicleYear: Number(targetedForm.vehicleYear) } : {}),
      })
    }
    const source = targetedForm.source === 'apify' ? 'targeted_apify_actor' : 'targeted_website_search'
    try {
      const res = await fetch('/api/admin/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-secret': secret },
        body: JSON.stringify({
          source,
          mode: 'collect_only',
          params,
          apiKey,
          apifyApiKey,
        }),
      })
      const json = await res.json() as RunResult
      setTargetedResult(json)
      handleScrapeResult(json, source, params)
      await fetchRuns()
    } catch (err) {
      setTargetedResult({ error: String(err) })
    } finally {
      setTargetedLoading(false)
    }
  }

  /* ── Styles ──────────────────────────────────────── */

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
  const aiNeedsUrls = aiForm.inputMode !== 'search'
  const aiMissingInput = aiNeedsUrls ? !aiForm.urls.trim() : !aiForm.query.trim()

  return (
    <div style={{ minHeight: '100vh', backgroundColor: '#f3f4f6', fontFamily: 'system-ui, -apple-system, sans-serif' }}>
      {/* Validation overlay */}
      {validatingItems && (
        <ValidationTable
          items={validatingItems}
          onUpdate={handleValidationUpdate}
          onExport={handleValidationExport}
          onCancel={() => setValidatingItems(null)}
          sourceName={sourceLabel(validationSource)}
          progress={validationSource === 'ai_assisted_scrape' ? aiProgress : null}
          isRunning={validationSource === 'ai_assisted_scrape' && aiLoading}
          isPaused={validationSource === 'ai_assisted_scrape' && aiPaused}
          onPause={validationSource === 'ai_assisted_scrape' ? pauseAiAssisted : undefined}
          onResume={validationSource === 'ai_assisted_scrape' ? () => { void resumeAiAssisted() } : undefined}
          onStop={validationSource === 'ai_assisted_scrape' ? cancelAiAssisted : undefined}
        />
      )}

      {/* Nav */}
      <div style={{ backgroundColor: '#111827', color: '#fff', padding: '14px 28px', display: 'flex', alignItems: 'center', gap: 12, borderBottom: '1px solid #1f2937' }}>
        <span style={{ fontWeight: 800, fontSize: 18, letterSpacing: '-0.5px' }}>miyagisanchez</span>
        <span style={{ backgroundColor: '#374151', color: '#d1d5db', fontSize: 12, fontWeight: 600, padding: '2px 8px', borderRadius: 4 }}>ADMIN</span>
        <span style={{ marginLeft: 'auto', color: '#6b7280', fontSize: 13 }}>Scrape Panel</span>
      </div>

      <div style={{ maxWidth: 900, margin: '0 auto', padding: '32px 24px' }}>

        {/* Global Settings */}
        <div style={card}>
          <h2 style={sectionTitle}>⚙️ Local Settings</h2>
          <p style={sectionSub}>Configure your local API keys and export mode.</p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }}>
            <div style={field}>
              <label style={label}>SerpAPI Key</label>
              <input
                style={input}
                type="password"
                value={apiKey}
                onChange={e => handleApiKeyChange(e.target.value)}
                placeholder="Paste your SerpAPI key here (saved locally)"
              />
              <p style={hint}>Required for Google Local and Targeted Website Search.</p>
            </div>
            <div style={field}>
              <label style={label}>Apify API Token</label>
              <input
                style={input}
                type="password"
                value={apifyApiKey}
                onChange={e => handleApifyApiKeyChange(e.target.value)}
                placeholder="Paste your Apify token here (saved locally)"
              />
              <p style={hint}>Required for Apify-powered Inmuebles24 and MercadoLibre.</p>
            </div>
            <div style={field}>
              <label style={label}>Export Mode</label>
              <div style={{
                display: 'flex', borderRadius: 8, border: '1px solid #d1d5db',
                overflow: 'hidden', marginTop: 2,
              }}>
                <button
                  type="button"
                  onClick={() => handleValidationToggle(true)}
                  style={{
                    flex: 1, padding: '8px 12px', border: 'none', cursor: 'pointer',
                    fontSize: 13, fontWeight: 600,
                    backgroundColor: validationMode ? '#4f46e5' : '#fff',
                    color: validationMode ? '#fff' : '#6b7280',
                    transition: 'all 0.15s',
                  }}
                >
                  📋 Validation Mode
                </button>
                <button
                  type="button"
                  onClick={() => handleValidationToggle(false)}
                  style={{
                    flex: 1, padding: '8px 12px', border: 'none', cursor: 'pointer',
                    fontSize: 13, fontWeight: 600,
                    backgroundColor: !validationMode ? '#4f46e5' : '#fff',
                    color: !validationMode ? '#fff' : '#6b7280',
                    borderLeft: '1px solid #d1d5db',
                    transition: 'all 0.15s',
                  }}
                >
                  ⚡ Quick CSV
                </button>
              </div>
              <p style={hint}>
                {validationMode
                  ? 'Review & pick candidates before CSV export.'
                  : 'Auto-download CSV immediately after scrape.'}
              </p>
            </div>
          </div>
        </div>

        {/* AI assisted scrape */}
        <div style={{ ...card, border: '2px solid #0f766e' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
            <h2 style={{ ...sectionTitle, margin: 0 }}>AI Assisted Scrape</h2>
            <span style={{ backgroundColor: '#ecfdf5', color: '#047857', fontSize: 12, fontWeight: 600, padding: '2px 8px', borderRadius: 20, border: '1px solid #99f6e4' }}>SerpAPI + Gemini</span>
          </div>
          <p style={sectionSub}>
            Discover marketplace rows with SerpAPI, normalize each item with Gemini, then review and export the supply CSV schema.
          </p>
          <form onSubmit={(e) => { void runAiAssisted(e) }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <div style={field}>
                <label style={label}>Gemini API Key</label>
                <input
                  style={input}
                  type="password"
                  value={geminiApiKey}
                  onChange={e => handleGeminiApiKeyChange(e.target.value)}
                  placeholder="Paste your Gemini API key here (saved locally)"
                />
                <p style={hint}>Required only for this AI-assisted card.</p>
              </div>
              <div style={field}>
                <label style={label}>Input Type</label>
                <select
                  style={input}
                  value={aiForm.inputMode}
                  onChange={e => {
                    const inputMode = e.target.value as AiAssistedFormState['inputMode']
                    setAiForm(f => ({
                      ...f,
                      inputMode,
                      targetSite: inputMode === 'inmuebles24_search' ? 'inmuebles24' : inputMode === 'mercadolibre_seller' ? 'mercadolibre' : f.targetSite,
                      category: inputMode === 'inmuebles24_search' ? 'inmuebles' : inputMode === 'mercadolibre_seller' ? 'autos' : f.category,
                      listingType: inputMode === 'inmuebles24_search' ? 'rental' : inputMode === 'mercadolibre_seller' ? 'product' : f.listingType,
                    }))
                  }}
                >
                  <option value="search">Search terms</option>
                  <option value="urls">Search/result or item URLs</option>
                  <option value="mercadolibre_seller">MercadoLibre seller profile URL</option>
                  <option value="inmuebles24_search">Inmuebles24 search URL</option>
                </select>
              </div>
              <div style={field}>
                <label style={label}>Marketplace</label>
                <select
                  style={input}
                  value={aiForm.targetSite}
                  onChange={e => {
                    const targetSite = e.target.value
                    setAiForm(f => ({
                      ...f,
                      targetSite,
                      category: targetSite === 'mercadolibre' ? 'autos' : 'inmuebles',
                      listingType: targetSite === 'mercadolibre' ? 'product' : 'rental',
                    }))
                  }}
                >
                  <option value="mercadolibre">MercadoLibre Autos</option>
                  <option value="inmuebles24">Inmuebles24</option>
                </select>
              </div>
              <div style={field}>
                <label style={label}>Limit</label>
                <input style={input} type="number" min={1} max={50} value={aiForm.limit} onChange={e => setAiForm(f => ({ ...f, limit: e.target.value }))} />
              </div>
              {aiNeedsUrls ? (
                <div style={{ ...field, gridColumn: '1 / -1' }}>
                  <label style={label}>{aiForm.inputMode === 'mercadolibre_seller' ? 'MercadoLibre Seller URL' : aiForm.inputMode === 'inmuebles24_search' ? 'Inmuebles24 Search URL' : 'URLs'}</label>
                  <textarea
                    style={{ ...input, minHeight: 86, resize: 'vertical', fontSize: 13 }}
                    value={aiForm.urls}
                    onChange={e => setAiForm(f => ({ ...f, urls: e.target.value }))}
                    placeholder={aiForm.inputMode === 'mercadolibre_seller'
                      ? 'https://vehiculos.mercadolibre.com.mx/_CustId_3155163584'
                      : aiForm.inputMode === 'inmuebles24_search'
                      ? 'https://www.inmuebles24.com/departamentos-en-renta-en-roma-norte-ciudad-de-cuauhtemoc.html'
                      : 'One URL per line'}
                    required
                  />
                </div>
              ) : (
                <div style={{ ...field, gridColumn: '1 / -1' }}>
                  <label style={label}>Search Terms</label>
                  <input
                    style={input}
                    value={aiForm.query}
                    onChange={e => setAiForm(f => ({ ...f, query: e.target.value }))}
                    placeholder={aiForm.targetSite === 'mercadolibre' ? 'honda civic cdmx usado' : 'departamento roma norte renta'}
                    required
                  />
                </div>
              )}
              <div style={field}>
                <label style={label}>Category</label>
                <select style={input} value={aiForm.category} onChange={e => setAiForm(f => ({ ...f, category: e.target.value }))}>
                  {CATEGORIES.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
                </select>
              </div>
              <div style={field}>
                <label style={label}>Listing Type</label>
                <select style={input} value={aiForm.listingType} onChange={e => setAiForm(f => ({ ...f, listingType: e.target.value as AiAssistedFormState['listingType'] }))}>
                  <option value="product">product</option>
                  <option value="rental">rental</option>
                  <option value="service">service</option>
                  <option value="digital">digital</option>
                </select>
              </div>
              <div style={field}>
                <label style={label}>Gemini Assist Mode</label>
                <select style={input} value={aiForm.assistMode} onChange={e => setAiForm(f => ({ ...f, assistMode: e.target.value as AiAssistedFormState['assistMode'] }))}>
                  <option value="enrich">Enrich missing fields</option>
                  <option value="normalize">Normalize only</option>
                  <option value="url_image">URL + image only</option>
                </select>
                <p style={hint}>{aiForm.assistMode === 'url_image' ? 'Skips Gemini and prepares rows for manual operator review.' : 'Enrich uses extra SerpAPI lookups before Gemini validation.'}</p>
              </div>
              <div style={{ ...field, display: 'grid', gap: 8, alignContent: 'start' }}>
                <label style={label}>AI Evidence Controls</label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#374151' }}>
                  <input
                    type="checkbox"
                    checked={aiForm.imageEnrichment}
                    onChange={e => setAiForm(f => ({ ...f, imageEnrichment: e.target.checked }))}
                  />
                  Recover missing images with SerpAPI Images
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#374151' }}>
                  <input
                    type="checkbox"
                    checked={aiForm.strictItemPages}
                    onChange={e => setAiForm(f => ({ ...f, strictItemPages: e.target.checked }))}
                  />
                  Keep only item-level pages
                </label>
              </div>
              <div style={field}>
                <label style={label}>Location</label>
                <select
                  style={input}
                  value={aiForm.location}
                  onChange={e => {
                    const selected = LOCATION_OPTIONS.find(option => option.location === e.target.value)
                    setAiForm(f => ({
                      ...f,
                      location: e.target.value,
                      state: selected?.state ?? f.state,
                      municipio: '',
                    }))
                  }}
                >
                  {LOCATION_OPTIONS.map(option => <option key={option.location} value={option.location}>{option.location}</option>)}
                </select>
              </div>
              <div style={field}>
                <label style={label}>State</label>
                <select
                  style={input}
                  value={aiForm.state}
                  onChange={e => {
                    const selected = LOCATION_OPTIONS.find(option => option.state === e.target.value)
                    setAiForm(f => ({
                      ...f,
                      state: e.target.value,
                      location: selected?.location ?? f.location,
                      municipio: '',
                    }))
                  }}
                >
                  {LOCATION_OPTIONS.map(option => <option key={option.state} value={option.state}>{option.state}</option>)}
                </select>
              </div>
              <div style={field}>
                <label style={label}>Municipio</label>
                <select style={input} value={aiForm.municipio} onChange={e => setAiForm(f => ({ ...f, municipio: e.target.value }))}>
                  <option value="">Any / batch default</option>
                  {(LOCATION_OPTIONS.find(option => option.state === aiForm.state)?.municipios ?? []).map(municipio => (
                    <option key={municipio} value={municipio}>{municipio}</option>
                  ))}
                </select>
              </div>
              <div style={field}>
                <label style={label}>Max SerpAPI Requests</label>
                <input style={input} type="number" min={5} max={80} value={aiForm.maxSerpRequests} onChange={e => setAiForm(f => ({ ...f, maxSerpRequests: e.target.value }))} />
                <p style={hint}>Stops the run before runaway search spend.</p>
              </div>
              <div style={field}>
                <label style={label}>Timeout Seconds</label>
                <input style={input} type="number" min={30} max={300} value={aiForm.maxRuntimeSeconds} onChange={e => setAiForm(f => ({ ...f, maxRuntimeSeconds: e.target.value }))} />
              </div>
            </div>
            <button type="submit" style={btn(aiLoading)} disabled={aiLoading || !apiKey || (aiForm.assistMode !== 'url_image' && !geminiApiKey) || aiMissingInput}>
              {aiLoading && <Spinner />}
              {aiLoading ? 'Collecting with AI...' : 'Collect AI-Assisted Rows'}
            </button>
            {!apiKey && <p style={{ color: '#dc2626', fontSize: 12, marginTop: 8 }}>SerpAPI key required.</p>}
            {aiForm.assistMode !== 'url_image' && !geminiApiKey && <p style={{ color: '#dc2626', fontSize: 12, marginTop: 8 }}>Gemini key required.</p>}
          </form>
          <ResultBanner result={aiResult} loading={aiLoading} secret={secret} sourceLabelStr="ai_assisted" aiProgress={aiProgress} />
        </div>

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
            <button type="submit" style={btn(serpLoading)} disabled={serpLoading || !apiKey}>
              {serpLoading && <Spinner />}
              {serpLoading ? 'Collecting…' : 'Collect CSV Rows'}
            </button>
            {!apiKey && <p style={{ color: '#dc2626', fontSize: 12, marginTop: 8 }}>API Key required.</p>}
          </form>
          <ResultBanner result={serpResult} loading={serpLoading} secret={secret} sourceLabelStr="google_local" />
        </div>

        {/* Targeted website search */}
        <div style={{ ...card, border: '2px solid #2563eb' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
            <h2 style={{ ...sectionTitle, margin: 0 }}>Targeted Website Search</h2>
            <span style={{ backgroundColor: '#eff6ff', color: '#1d4ed8', fontSize: 12, fontWeight: 600, padding: '2px 8px', borderRadius: 20, border: '1px solid #bfdbfe' }}>Quality gate disabled</span>
          </div>
          <p style={sectionSub}>
            Choose the website and collection source first. The fields below only show inputs that the selected source can actually support.
          </p>
          <form onSubmit={(e) => { void runTargeted(e) }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <div style={field}>
                <label style={label}>Source</label>
                <select
                  style={input}
                  value={targetedForm.source}
                  onChange={e => {
                    const source = e.target.value as TargetedSource
                    setTargetedForm(f => {
                      const nextSite = source === 'apify' && !APIFY_SITE_KEYS.has(f.targetSite) ? 'inmuebles24' : f.targetSite
                      const site = TARGET_SEARCH_SITES.find(item => item.key === nextSite)
                      return {
                        ...f,
                        source,
                        targetSite: nextSite,
                        category: site?.defaultCategory ?? f.category,
                      }
                    })
                  }}
                >
                  <option value="serpapi">SerpAPI Google</option>
                  <option value="apify">Apify Actor</option>
                </select>
                <p style={hint}>{targetedForm.source === 'apify' ? 'Site-specific actor fields.' : 'Google query with site: filtering.'}</p>
              </div>
              <div style={field}>
                <label style={label}>Website</label>
                <select
                  style={input}
                  value={targetedForm.targetSite}
                  onChange={e => {
                    const site = TARGET_SEARCH_SITES.find(item => item.key === e.target.value)
                    setTargetedForm(f => ({
                      ...f,
                      targetSite: e.target.value,
                      category: site?.defaultCategory ?? f.category,
                    }))
                  }}
                >
                  {TARGET_SEARCH_SITES
                    .filter(site => targetedForm.source === 'serpapi' || APIFY_SITE_KEYS.has(site.key))
                    .map(site => <option key={site.key} value={site.key}>{site.label}</option>)}
                </select>
                <p style={hint}>
                  {targetedForm.source === 'apify'
                    ? targetedForm.targetSite === 'inmuebles24' ? 'Actor: Inmuebles24 Property Listings Scraper' : 'Actor: Mercado Libre Scraper'
                    : TARGET_SEARCH_SITES.find(site => site.key === targetedForm.targetSite)?.queryPrefix}
                </p>
              </div>

              {targetedForm.source === 'serpapi' && (
                <>
                  <div style={field}>
                    <label style={label}>Query</label>
                    <input style={input} value={targetedForm.query} onChange={e => setTargetedForm(f => ({ ...f, query: e.target.value }))} placeholder="honda civic cdmx, departamento roma..." required />
                  </div>
                  <div style={field}>
                    <label style={label}>Category</label>
                    <select style={input} value={targetedForm.category} onChange={e => setTargetedForm(f => ({ ...f, category: e.target.value }))}>
                      {CATEGORIES.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
                    </select>
                  </div>
                  <div style={field}>
                    <label style={label}>Limit</label>
                    <input style={input} type="number" min={1} max={50} value={targetedForm.limit} onChange={e => setTargetedForm(f => ({ ...f, limit: e.target.value }))} />
                  </div>
                  <div style={field}>
                    <label style={label}>Location</label>
                    <input style={input} value={targetedForm.location} onChange={e => setTargetedForm(f => ({ ...f, location: e.target.value }))} placeholder="Ciudad de México, Mexico" />
                  </div>
                  <div style={field}>
                    <label style={label}>State (DB field)</label>
                    <input style={input} value={targetedForm.state} onChange={e => setTargetedForm(f => ({ ...f, state: e.target.value }))} placeholder="Ciudad de México" />
                  </div>
                </>
              )}

              {targetedForm.source === 'apify' && targetedForm.targetSite === 'inmuebles24' && (
                <>
                  <div style={field}>
                    <label style={label}>Search Mode</label>
                    <select style={input} value={targetedForm.apifyMode} onChange={e => setTargetedForm(f => ({ ...f, apifyMode: e.target.value as 'urls' | 'filters' }))}>
                      <option value="filters">Search filters</option>
                      <option value="urls">Search URLs</option>
                    </select>
                    <p style={hint}>URL mode uses Inmuebles24 result/list pages directly.</p>
                  </div>
                  {targetedForm.apifyMode === 'urls' ? (
                    <div style={{ ...field, gridColumn: '1 / -1' }}>
                      <label style={label}>Inmuebles24 URLs</label>
                      <textarea
                        style={{ ...input, minHeight: 82, resize: 'vertical' }}
                        value={targetedForm.urls}
                        onChange={e => setTargetedForm(f => ({ ...f, urls: e.target.value }))}
                        placeholder="https://www.inmuebles24.com/inmuebles-en-venta-en-edo.-de-mexico.html"
                        required
                      />
                      <p style={hint}>One URL per line. Keep test runs tiny first.</p>
                    </div>
                  ) : (
                    <>
                      <div style={field}>
                        <label style={label}>Keyword</label>
                        <input style={input} value={targetedForm.query} onChange={e => setTargetedForm(f => ({ ...f, query: e.target.value }))} placeholder="roma norte, satelite, oficina..." />
                      </div>
                      <div style={field}>
                        <label style={label}>Property Type</label>
                        <select style={input} value={targetedForm.propertyType} onChange={e => setTargetedForm(f => ({ ...f, propertyType: e.target.value }))}>
                          {INMUEBLES_PROPERTY_TYPES.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                        </select>
                      </div>
                      <div style={field}>
                        <label style={label}>Operation Type</label>
                        <select style={input} value={targetedForm.operationType} onChange={e => setTargetedForm(f => ({ ...f, operationType: e.target.value }))}>
                          {INMUEBLES_OPERATION_TYPES.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                        </select>
                      </div>
                      <div style={field}>
                        <label style={label}>Published Date</label>
                        <select style={input} value={targetedForm.publishedDate} onChange={e => setTargetedForm(f => ({ ...f, publishedDate: e.target.value }))}>
                          {INMUEBLES_PUBLISHED_DATES.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                        </select>
                      </div>
                    </>
                  )}
                  <div style={field}>
                    <label style={label}>Sort Items By</label>
                    <select style={input} value={targetedForm.sortBy} onChange={e => setTargetedForm(f => ({ ...f, sortBy: e.target.value }))}>
                      {APIFY_SORT_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
                  </div>
                  <div style={field}>
                    <label style={label}>Page</label>
                    <input style={input} type="number" min={1} max={50} value={targetedForm.page} onChange={e => setTargetedForm(f => ({ ...f, page: e.target.value }))} />
                  </div>
                </>
              )}

              {targetedForm.source === 'apify' && targetedForm.targetSite === 'mercadolibre' && (
                <>
                  <div style={field}>
                    <label style={label}>Search</label>
                    <input style={input} value={targetedForm.query} onChange={e => setTargetedForm(f => ({ ...f, query: e.target.value }))} placeholder="nissan march 2020, laptop, silla..." required />
                  </div>
                  <div style={field}>
                    <label style={label}>Search Category</label>
                    <select style={input} value={targetedForm.searchCategory} onChange={e => setTargetedForm(f => ({ ...f, searchCategory: e.target.value }))}>
                      {ML_SEARCH_CATEGORIES.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
                  </div>
                  <div style={field}>
                    <label style={label}>Sort Items By</label>
                    <select style={input} value={targetedForm.sortBy} onChange={e => setTargetedForm(f => ({ ...f, sortBy: e.target.value }))}>
                      {APIFY_SORT_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
                  </div>
                  <div style={field}>
                    <label style={label}>Domain</label>
                    <select style={input} value={targetedForm.domainCode} onChange={e => setTargetedForm(f => ({ ...f, domainCode: e.target.value }))}>
                      <option value="MX">Mexico</option>
                      <option value="AR">Argentina</option>
                      <option value="CO">Colombia</option>
                      <option value="CL">Chile</option>
                      <option value="BR">Brazil</option>
                    </select>
                  </div>
                  <div style={field}>
                    <label style={label}>Vehicle Year <span style={{ fontWeight: 400, color: '#9ca3af' }}>(optional)</span></label>
                    <input style={input} type="number" min={1900} max={2100} value={targetedForm.vehicleYear} onChange={e => setTargetedForm(f => ({ ...f, vehicleYear: e.target.value }))} placeholder="2020" />
                  </div>
                  <div style={{ ...field, display: 'flex', alignItems: 'center', gap: 8, marginTop: 24 }}>
                    <input
                      id="apify-fast-mode"
                      type="checkbox"
                      checked={targetedForm.fastMode}
                      onChange={e => setTargetedForm(f => ({ ...f, fastMode: e.target.checked }))}
                    />
                    <label htmlFor="apify-fast-mode" style={{ ...label, marginBottom: 0 }}>Fast mode</label>
                  </div>
                </>
              )}

              {targetedForm.source === 'apify' && (
                <>
                  <div style={field}>
                    <label style={label}>Category</label>
                    <select style={input} value={targetedForm.category} onChange={e => setTargetedForm(f => ({ ...f, category: e.target.value }))}>
                      {CATEGORIES.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
                    </select>
                  </div>
                  <div style={field}>
                    <label style={label}>{targetedForm.targetSite === 'mercadolibre' ? 'Max Item Count' : 'Max Items Per URL'}</label>
                    <input style={input} type="number" min={1} max={100} value={targetedForm.limit} onChange={e => setTargetedForm(f => ({ ...f, limit: e.target.value }))} />
                  </div>
                  <div style={field}>
                    <label style={label}>Location (DB field)</label>
                    <input style={input} value={targetedForm.location} onChange={e => setTargetedForm(f => ({ ...f, location: e.target.value }))} placeholder="Ciudad de México, Mexico" />
                  </div>
                  <div style={field}>
                    <label style={label}>State (DB field)</label>
                    <input style={input} value={targetedForm.state} onChange={e => setTargetedForm(f => ({ ...f, state: e.target.value }))} placeholder="Ciudad de México" />
                  </div>
                  {targetedForm.targetSite === 'inmuebles24' && (
                    <>
                      <div style={field}>
                        <label style={label}>Max Retries Per URL</label>
                        <input style={input} type="number" min={0} max={5} value={targetedForm.maxRetries} onChange={e => setTargetedForm(f => ({ ...f, maxRetries: e.target.value }))} />
                      </div>
                      <div style={{ ...field, display: 'flex', alignItems: 'center', gap: 8, marginTop: 24 }}>
                        <input
                          id="apify-ignore-url-failures"
                          type="checkbox"
                          checked={targetedForm.ignoreUrlFailures}
                          onChange={e => setTargetedForm(f => ({ ...f, ignoreUrlFailures: e.target.checked }))}
                        />
                        <label htmlFor="apify-ignore-url-failures" style={{ ...label, marginBottom: 0 }}>Ignore URL failures</label>
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
            <button type="submit" style={btn(targetedLoading)} disabled={targetedLoading || (targetedForm.source === 'serpapi' ? !apiKey : !apifyApiKey)}>
              {targetedLoading && <Spinner />}
              {targetedLoading ? 'Collecting targeted rows...' : 'Collect Targeted Rows'}
            </button>
            {targetedForm.source === 'serpapi' && !apiKey && <p style={{ color: '#dc2626', fontSize: 12, marginTop: 8 }}>SerpAPI key required.</p>}
            {targetedForm.source === 'apify' && !apifyApiKey && <p style={{ color: '#dc2626', fontSize: 12, marginTop: 8 }}>Apify token required.</p>}
          </form>
          <ResultBanner result={targetedResult} loading={targetedLoading} secret={secret} sourceLabelStr="targeted" />
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
          <ResultBanner result={mlResult} loading={mlLoading} secret={secret} sourceLabelStr="ml_public" />
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
            <button type="submit" style={btn(mlSellerLoading)} disabled={mlSellerLoading || !apiKey}>
              {mlSellerLoading && <Spinner />}
              {mlSellerLoading ? 'Collecting seller…' : '🎯 Collect Seller Listings'}
            </button>
            {!apiKey && <p style={{ color: '#dc2626', fontSize: 12, marginTop: 8 }}>API Key required.</p>}
          </form>
          <ResultBanner result={mlSellerResult} loading={mlSellerLoading} secret={secret} sourceLabelStr="ml_seller" />
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
                    {['Source', 'Params', 'Status', 'Rows', 'Auto-skip', 'Errors', 'CSV', 'Started'].map(h => (
                      <th key={h} style={{ textAlign: 'left', padding: '6px 10px', color: '#6b7280', fontWeight: 600 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {runs.map(run => (
                    <tr key={run.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                      <td style={{ padding: '8px 10px', fontWeight: 500, whiteSpace: 'nowrap' }}>
                        {sourceLabel(run.source)}
                        {run.isLocal && <span style={{ marginLeft: 6, fontSize: 10, color: '#3b82f6', background: '#dbeafe', padding: '2px 4px', borderRadius: 4 }}>Local</span>}
                      </td>
                      <td style={{ padding: '8px 10px', color: '#6b7280', maxWidth: 200 }}>
                        <span title={JSON.stringify(run.params)} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block', fontSize: 12 }}>
                          {run.params.targetSite
                            ? `${String(run.params.targetSite)}: "${String(run.params.query ?? '')}"`
                            : run.params.sellerUrl
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
                          run.csvData ? (
                            <button onClick={() => downloadCsv(run.csvData!, `scrape_${run.id}.csv`)} style={{ color: '#2563eb', fontWeight: 600, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>Download</button>
                          ) : (
                            <a href={`/api/admin/runs/${run.id}/csv?secret=${encodeURIComponent(secret)}`} style={{ color: '#2563eb', fontWeight: 600 }}>Download (DB)</a>
                          )
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
