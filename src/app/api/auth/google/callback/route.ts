import { NextRequest, NextResponse } from 'next/server'

// Handles the OAuth callback from Google.
// Exchanges the authorization code for an access token + refresh token,
// then stores them in httpOnly cookies and redirects back to the app.
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code')
  const error = request.nextUrl.searchParams.get('error')

  if (error) {
    return NextResponse.redirect(`${request.nextUrl.origin}/?gmail_auth=error&reason=${encodeURIComponent(error)}`)
  }

  if (!code) {
    return NextResponse.redirect(`${request.nextUrl.origin}/?gmail_auth=error&reason=no_code`)
  }

  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || `${request.nextUrl.origin}/api/auth/google/callback`

  if (!clientId || !clientSecret) {
    return NextResponse.redirect(`${request.nextUrl.origin}/?gmail_auth=error&reason=not_configured`)
  }

  try {
    // Exchange code for tokens
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    })

    const tokens = await tokenResponse.json()

    if (!tokenResponse.ok) {
      console.error('Token exchange failed:', tokens)
      return NextResponse.redirect(`${request.nextUrl.origin}/?gmail_auth=error&reason=${encodeURIComponent(tokens.error || 'token_exchange_failed')}`)
    }

    // Set cookies with tokens. access_token expires in 1hr, refresh_token is long-lived.
    const response = NextResponse.redirect(`${request.nextUrl.origin}/?gmail_auth=success`)

    response.cookies.set('gmail_access_token', tokens.access_token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: tokens.expires_in || 3600,
      path: '/',
    })

    if (tokens.refresh_token) {
      response.cookies.set('gmail_refresh_token', tokens.refresh_token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 60 * 60 * 24 * 180, // 180 days
        path: '/',
      })
    }

    return response
  } catch (err) {
    console.error('OAuth callback error:', err)
    return NextResponse.redirect(`${request.nextUrl.origin}/?gmail_auth=error&reason=callback_exception`)
  }
}
