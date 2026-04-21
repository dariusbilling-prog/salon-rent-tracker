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
  let tokenRefreshed = false

  // If no access token, try to refresh
  if (!accessToken && refreshToken) {
    const newToken = await refreshAccessToken(refreshToken)
    if (newToken) {
      accessToken = newToken
      tokenRefreshed = true
    }
  }

  if (!accessToken) {
    return NextResponse.json(
      { error: 'Not connected to Gmail. Please connect your Google account first.' },
      { status: 401 }
    )
  }

  const debug: Record<string, unknown> = {
    dateRange: `${body.startDate} to ${body.endDate}`,
    hadAccessToken: !tokenRefreshed,
    tokenRefreshed,
    hasRefreshToken: !!refreshToken,
  }

  try {
    const startDate = new Date(body.startDate + 'T00:00:00')
    const endDate = new Date(body.endDate + 'T23:59:59')

    let payments: ParsedZellePayment[] = []

    try {
      payments = await fetchZelleEmails(accessToken, startDate, endDate)
    } catch (err) {
      const errMsg = (err as Error).message
      debug.firstAttemptError = errMsg

      // If the token expired mid-request, try refreshing and retry
      if (refreshToken && errMsg.includes('401')) {
        const newToken = await refreshAccessToken(refreshToken)
        if (newToken) {
          debug.retryWithNewToken = true
          payments = await fetchZelleEmails(newToken, startDate, endDate)
          // Update cookie with new access token
          const response = NextResponse.json({
            payments: payments.map(p => ({ ...p, assignedFriday: getFridayForDate(p.dateReceived) })),
            debug: { ...debug, totalFound: payments.length }
          })
          response.cookies.set('gmail_access_token', newToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            maxAge: 3600,
            path: '/',
          })
          return response
        } else {
          debug.refreshFailed = true
        }
      }
      throw err
    }

    debug.totalFound = payments.length
    // Grab query-level debug info from fetchZelleEmails
    const queryDebug = (fetchZelleEmails as any).__lastDebug
    if (queryDebug) {
      debug.queryResults = queryDebug.queryResults
      debug.successfulQuery = queryDebug.successfulQuery
    }
    if (payments.length > 0) {
      debug.firstPayment = { sender: payments[0].senderName, amount: payments[0].amount, date: payments[0].dateReceived }
    }

    // Tag each payment with the Friday week it belongs to
    const withFridays = payments.map(p => ({
      ...p,
      assignedFriday: getFridayForDate(p.dateReceived),
    }))

    const response = NextResponse.json({ payments: withFridays, debug })

    // If we used a refreshed token, update the cookie
    if (tokenRefreshed && accessToken) {
      response.cookies.set('gmail_access_token', accessToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 3600,
        path: '/',
      })
    }

    return response
  } catch (err) {
    debug.error = (err as Error).message
    return NextResponse.json(
      { error: 'Failed to scan Gmail: ' + (err as Error).message, debug },
      { status: 500 }
    )
  }
}
