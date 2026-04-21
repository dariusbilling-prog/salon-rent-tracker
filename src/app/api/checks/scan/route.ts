import { NextRequest, NextResponse } from 'next/server'
import { scanDepositSlips, DepositSlipResult } from '@/lib/check-scanner'

export async function POST(request: NextRequest) {
  const apiKey = process.env.GOOGLE_VISION_API_KEY || process.env.GOOGLE_API_KEY

  if (!apiKey) {
    return NextResponse.json(
      { error: 'Check scanning is not configured. Add GOOGLE_VISION_API_KEY to Vercel environment variables.' },
      { status: 500 }
    )
  }

  try {
    const body = await request.json()
    const images: Array<{ base64: string; mimeType: string; fileName: string }> = body.images

    if (!images || images.length === 0) {
      return NextResponse.json(
        { error: 'No images provided' },
        { status: 400 }
      )
    }

    if (images.length > 15) {
      return NextResponse.json(
        { error: 'Maximum 15 images per batch' },
        { status: 400 }
      )
    }

    const results: DepositSlipResult[] = await scanDepositSlips(images, apiKey)

    const totalEntries = results.reduce((sum, r) => sum + r.entries.length, 0)
    const successfulEntries = results.reduce((sum, r) =>
      sum + r.entries.filter(e => e.suiteNumber && e.amount).length, 0)

    return NextResponse.json({
      results,
      summary: {
        totalImages: results.length,
        totalEntries,
        successful: successfulEntries,
        needsReview: results.reduce((sum, r) =>
          sum + r.entries.filter(e => e.confidence !== 'high').length, 0),
        failed: results.filter(r => r.error).length,
      },
    })
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to scan checks: ' + (err as Error).message },
      { status: 500 }
    )
  }
}
