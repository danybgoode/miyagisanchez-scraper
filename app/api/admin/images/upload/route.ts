import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/supabase'

const DEFAULT_BUCKET = 'supply-images'
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])

function checkSecret(req: NextRequest): boolean {
  const adminSecret = process.env.ADMIN_SECRET
  const secret = req.headers.get('x-admin-secret') ?? req.nextUrl.searchParams.get('secret')
  if (!adminSecret) {
    return !secret || secret === 'undefined' || secret === 'null' || secret === ''
  }
  return secret === adminSecret
}

function extensionFor(file: File): string {
  if (file.type === 'image/jpeg') return 'jpg'
  if (file.type === 'image/png') return 'png'
  if (file.type === 'image/webp') return 'webp'
  if (file.type === 'image/gif') return 'gif'
  const ext = file.name.split('.').pop()?.toLowerCase().replace(/[^a-z0-9]/g, '')
  return ext || 'jpg'
}

async function ensurePublicBucket(bucket: string) {
  const { data: buckets, error: listError } = await db.storage.listBuckets()
  if (listError) throw new Error(`Could not list Supabase storage buckets: ${listError.message}`)
  if (buckets?.some(item => item.name === bucket)) return

  const { error } = await db.storage.createBucket(bucket, { public: true })
  if (error && !/already exists/i.test(error.message)) {
    throw new Error(`Could not create Supabase storage bucket "${bucket}": ${error.message}`)
  }
}

export async function POST(req: NextRequest) {
  if (!checkSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({
      error: 'Supabase storage is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the deployment environment.',
    }, { status: 503 })
  }

  try {
    const form = await req.formData()
    const file = form.get('file')
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'Image file is required' }, { status: 400 })
    }
    if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
      return NextResponse.json({ error: 'Only JPEG, PNG, WebP, and GIF images are supported' }, { status: 400 })
    }
    if (file.size > MAX_IMAGE_BYTES) {
      return NextResponse.json({ error: 'Image must be 8 MB or smaller' }, { status: 400 })
    }

    const bucket = process.env.SUPABASE_STORAGE_BUCKET || DEFAULT_BUCKET
    await ensurePublicBucket(bucket)

    const today = new Date().toISOString().slice(0, 10)
    const path = `operator/${today}/${crypto.randomUUID()}.${extensionFor(file)}`
    const { error: uploadError } = await db.storage
      .from(bucket)
      .upload(path, file, {
        cacheControl: '31536000',
        contentType: file.type,
        upsert: false,
      })

    if (uploadError) throw new Error(uploadError.message)

    const { data } = db.storage.from(bucket).getPublicUrl(path)
    return NextResponse.json({
      url: data.publicUrl,
      bucket,
      path,
    })
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 })
  }
}
