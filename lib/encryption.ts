import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'

const ALGORITHM = 'aes-256-cbc'

function getKey(): Buffer {
  const secret = process.env.ENCRYPTION_SECRET ?? process.env.ENCRYPTION_KEY
  if (!secret) throw new Error('ENCRYPTION_SECRET is not set')
  return Buffer.from(secret.padEnd(32, '0').slice(0, 32), 'utf8')
}

export function encrypt(text: string): string {
  try {
    const iv = randomBytes(16)
    const cipher = createCipheriv(ALGORITHM, getKey(), iv)
    const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
    return Buffer.concat([iv, encrypted]).toString('base64')
  } catch {
    return ''
  }
}

export function decrypt(encrypted: string): string {
  try {
    const buf = Buffer.from(encrypted, 'base64')
    const iv = buf.subarray(0, 16)
    const data = buf.subarray(16)
    const decipher = createDecipheriv(ALGORITHM, getKey(), iv)
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
  } catch (err) {
    console.error('[encryption] decrypt failed:', err instanceof Error ? err.message : err)
    return ''
  }
}
