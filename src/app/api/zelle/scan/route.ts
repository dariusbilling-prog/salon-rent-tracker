import { NextRequest, NextResponse } from 'next/server'
import { fetchZelleEmails, refreshAccessToken, getFridayForDate, ParsedZellePayment } from '@/lib/gmail-zelle'

interface ScanRequest {
  startDate: string // ISO YYYY-MM-DD
  endDate: string   // ISO YYYY-MM-DD
}

export async function POST(request: NextRequest) {
  const body: ScanRequest = await request.json()

  let accessToken = request.cookies.get('gmail_access_token')?.value
  const refreshToken = request.cookies.get('gmail_refresh_token')?.value

  // If no access token, try to refresh
  if (!accessToken && refreshToken) {
    const newToken = await refreshAccessToken(refreshToken)
    if (newToken) accessToken = newToken
  }

  if (!accessToken) {
    return NextResponse.json(
      { error: 'Not connected to Gmail. Please connect your Google account first.' },
      { status: 401 }
    )
  }

  try {
    const startDate = new Date(body.startDate + 'T00:00:00')
    const endDate = new Date(body.endDate + 'T23:59:59')

    let payments: ParsedZellePayment[] = []

    try {
      payments = await fetchZelleEmails(accessToken, startDate, endDate)
    } catch (err) {
      // If the token expired mid-request, try refreshing and retry
      if (refreshToken && (err as Error).message.includes('401')) {
        const newToken = await refreshAccessToken(refreshToken)
        if (newToken) {
          payments = await fetchZelleEmails(newToken, startDate, endDate)
          // Update cookie with new access token
          const response = NextResponse.json({
            payments: payments.map(p => ({ ...p, assignedFriday: getFridayForDate(p.dateReceived) })),
          })
          response.cookies.set('gmail_access_token', newToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            maxAge: 3600,
            path: '/',
          })
          return response
        }
      }
      throw err
    }

    // Tag each payment with the Friday week it belongs to
    const withFridays = payments.map(p => ({
      ...p,
      assignedFriday: getFridayForDate(p.dateReceived),
    }))

    return NextResponse.json({ payments: withFridays })
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to scan Gmail: ' + (err as Error).message },
      { status: 500 }
    )
  }
}
