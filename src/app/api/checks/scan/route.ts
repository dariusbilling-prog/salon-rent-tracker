import { NextRequest, NextResponse } from 'next/server'
import { scanCheckImages, CheckScanResult } from '@/lib/check-scanner'

export async function POST(request: NextRequest) {
  const apiKey = process.env.ANTHROPIC_API_KEY

  if (!apiKey) {
    return NextResponse.json(
      { error: 'Check scanning is not configured. Add ANTHROPIC_API_KEY to environment variables.' },
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

    const results: CheckScanResult[] = await scanCheckImages(images, apiKey)

    return NextResponse.json({
      results,
      summary: {
        total: results.length,
        successful: results.filter(r => r.scanned.suiteNumber && r.scanned.amount).length,
        needsReview: results.filter(r => r.scanned.confidence !== 'high').length,
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
