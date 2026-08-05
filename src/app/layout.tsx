import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Salon Boutique — Rent Tracker',
  description: 'Weekly rent tracking and reporting for salon suite management',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
