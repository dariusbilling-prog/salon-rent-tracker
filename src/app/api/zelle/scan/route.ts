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

    console.log('[Zelle Scan] Date range:', body.startDate, 'to', body.endDate)
    console.log('[Zelle Scan] Has access token:', !!accessToken)

    try {
      payments = await fetchZelleEmails(accessToken, startDate, endDate)
    } catch (err) {
      console.log('[Zelle Scan] Error:', (err as Error).message)
      // If the token expired mid-request, try refreshing and retry
      if (refreshToken && (err as Error).message.includes('401')) {
        const newToken = await refreshAccessToken(refreshToken)
        if (newToken) {
          payments = await fetchZelleEmails(newToken, startDate, endDate)
          // Update cookie with new access token
          const response = NextResponse.json({
            payments: payments.map(p => ({ ...p, assignedFriday: getFridayForDate(p.dateReceived) })),
            debug: { dateRange: `${body.startDate} to ${body.endDate}`, totalFound: payments.length }
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

    console.log('[Zelle Scan] Found', payments.length, 'payments')
    if (payments.length > 0) {
      console.log('[Zelle Scan] First payment:', JSON.stringify(payments[0]))
    }

    // Tag each payment with the Friday week it belongs to
    const withFridays = payments.map(p => ({
      ...p,
      assignedFriday: getFridayForDate(p.dateReceived),
    }))

    return NextResponse.json({
      payments: withFridays,
      debug: { dateRange: `${body.startDate} to ${body.endDate}`, totalFound: payments.length }
    })
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to scan Gmail: ' + (err as Error).message },
      { status: 500 }
    )
  }
}
