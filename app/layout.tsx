import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Miyagi Sanchez Scraper',
  description: 'Collect-only supply scraper for Miyagi Sanchez',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  )
}
