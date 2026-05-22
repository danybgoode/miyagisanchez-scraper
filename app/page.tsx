import { redirect } from 'next/navigation'
import AdminScrapeClient from './admin/AdminScrapeClient'

export default async function HomePage({ searchParams }: { searchParams: Promise<{ secret?: string }> }) {
  const { secret } = await searchParams
  if (secret !== process.env.ADMIN_SECRET) {
    redirect('/admin')
  }
  return <AdminScrapeClient secret={secret!} />
}
