// Check deposit slip scanner using Claude Vision API
// Reads handwritten suite number, amount, and check number from photos of check backs

export interface ScannedCheck {
  suiteNumber: string | null
  amount: number | null
  checkNumber: string | null
  confidence: 'high' | 'medium' | 'low'
  rawText?: string // Full text Claude extracted for debugging
}

export interface CheckScanResult {
  imageIndex: number
  fileName: string
  scanned: ScannedCheck
  error?: string
}

// Build the prompt for Claude Vision to extract check info
const EXTRACTION_PROMPT = `You are analyzing a photo of the back of a check deposit slip from a salon suite rental business.

The person who wrote on this check has handwritten the following information:
- Suite number (e.g., "101", "135", "106/108")
- Dollar amount (e.g., "$250.00", "220", "$425")
- Check number (usually a 3-6 digit number, sometimes printed, sometimes handwritten)

Please extract these three pieces of information from the image. Look carefully at the handwriting.

IMPORTANT RULES:
- Suite numbers are typically 3 digits (100-140 range) and may include slashes for shared suites (e.g., "106/108")
- Amounts are typically between $150 and $500 for weekly rent
- Check numbers are usually 3-6 digits
- If you can't read something clearly, provide your best guess and note low confidence
- The check number might be printed (not handwritten) — look in corners or along edges

Respond in this EXACT JSON format (no markdown, no code blocks, just raw JSON):
{"suiteNumber": "110", "amount": 220.00, "checkNumber": "1234", "confidence": "high", "rawText": "Suite 110 $220.00 Check #1234"}

If you cannot read a field, use null for that field and set confidence to "low".`

// Send a single image to Claude Vision API for analysis
export async function scanCheckImage(
  imageBase64: string,
  mimeType: string,
  apiKey: string
): Promise<ScannedCheck> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mimeType,
                data: imageBase64,
              },
            },
            {
              type: 'text',
              text: EXTRACTION_PROMPT,
            },
          ],
        },
      ],
    }),
  })

  if (!response.ok) {
    const errorBody = await response.text()
    throw new Error(`Claude API error (${response.status}): ${errorBody.slice(0, 300)}`)
  }

  const data = await response.json()
  const textContent = data.content?.find((c: any) => c.type === 'text')?.text || ''

  // Parse the JSON response from Claude
  try {
    // Try to extract JSON from the response (handle cases where Claude wraps in markdown)
    let jsonStr = textContent.trim()
    // Strip markdown code blocks if present
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
    }

    const parsed = JSON.parse(jsonStr)

    return {
      suiteNumber: parsed.suiteNumber || null,
      amount: parsed.amount ? parseFloat(String(parsed.amount).replace(/[$,]/g, '')) : null,
      checkNumber: parsed.checkNumber || null,
      confidence: parsed.confidence || 'medium',
      rawText: parsed.rawText || textContent,
    }
  } catch {
    // If JSON parsing fails, try to extract fields with regex
    const suiteMatch = textContent.match(/suite\s*#?\s*(\d{3}(?:\/\d{3})?)/i)
    const amountMatch = textContent.match(/\$?([\d,]+(?:\.\d{2})?)/i)
    const checkMatch = textContent.match(/check\s*#?\s*(\d{3,6})/i)

    return {
      suiteNumber: suiteMatch?.[1] || null,
      amount: amountMatch ? parseFloat(amountMatch[1].replace(/,/g, '')) : null,
      checkNumber: checkMatch?.[1] || null,
      confidence: 'low',
      rawText: textContent,
    }
  }
}

// Scan multiple check images in sequence
export async function scanCheckImages(
  images: Array<{ base64: string; mimeType: string; fileName: string }>,
  apiKey: string
): Promise<CheckScanResult[]> {
  const results: CheckScanResult[] = []

  for (let i = 0; i < images.length; i++) {
    const img = images[i]
    try {
      const scanned = await scanCheckImage(img.base64, img.mimeType, apiKey)
      results.push({
        imageIndex: i,
        fileName: img.fileName,
        scanned,
      })
    } catch (err) {
      results.push({
        imageIndex: i,
        fileName: img.fileName,
        scanned: {
          suiteNumber: null,
          amount: null,
          checkNumber: null,
          confidence: 'low',
        },
        error: (err as Error).message,
      })
    }
  }

  return results
}
