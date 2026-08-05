import { NextRequest, NextResponse } from 'next/server'

// Reports whether the user is currently connected to Gmail
export async function GET(request: NextRequest) {
  const accessToken = request.cookies.get('gmail_access_token')?.value
  const refreshToken = request.cookies.get('gmail_refresh_token')?.value

  return NextResponse.json({
    connected: !!(accessToken || refreshToken),
    hasRefresh: !!refreshToken,
  })
}
