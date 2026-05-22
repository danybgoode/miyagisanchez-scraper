import { redirect } from 'next/navigation'
import AdminScrapeClient from './AdminScrapeClient'

export default async function AdminPage({ searchParams }: { searchParams: Promise<{ secret?: string }> }) {
  const { secret } = await searchParams
  if (secret !== process.env.ADMIN_SECRET) {
    redirect('/')
  }
  return <AdminScrapeClient secret={secret!} />
}
