import { NextResponse } from 'next/server'

// Clears Gmail auth cookies
export async function POST() {
  const response = NextResponse.json({ ok: true })
  response.cookies.delete('gmail_access_token')
  response.cookies.delete('gmail_refresh_token')
  return response
}
