// Check deposit slip scanner using Google Cloud Vision API (FREE tier: 1,000/month)
// Reads handwritten suite number, amount, and check number from photos of check backs

export interface ScannedCheck {
  suiteNumber: string | null
  amount: number | null
  checkNumber: string | null
  confidence: 'high' | 'medium' | 'low'
  rawText?: string // Full OCR text for debugging
}

export interface CheckScanResult {
  imageIndex: number
  fileName: string
  scanned: ScannedCheck
  error?: string
}

// Use Google Cloud Vision DOCUMENT_TEXT_DETECTION (best for handwriting)
async function ocrImage(imageBase64: string, apiKey: string): Promise<string> {
  const response = await fetch(
    `https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [
          {
            image: { content: imageBase64 },
            features: [
              { type: 'DOCUMENT_TEXT_DETECTION', maxResults: 1 },
            ],
          },
        ],
      }),
    }
  )

  if (!response.ok) {
    const errorBody = await response.text()
    throw new Error(`Google Vision API error (${response.status}): ${errorBody.slice(0, 300)}`)
  }

  const data = await response.json()
  const annotation = data.responses?.[0]

  if (annotation?.error) {
    throw new Error(`Vision API: ${annotation.error.message}`)
  }

  // fullTextAnnotation has the best structured text
  const fullText = annotation?.fullTextAnnotation?.text || ''
  // Fallback to individual text annotations
  if (!fullText) {
    const texts = annotation?.textAnnotations || []
    return texts[0]?.description || ''
  }

  return fullText
}

// Extract suite number, amount, and check number from OCR text
export function parseCheckText(rawText: string): ScannedCheck {
  const text = rawText.trim()
  if (!text) {
    return { suiteNumber: null, amount: null, checkNumber: null, confidence: 'low', rawText: text }
  }

  let suiteNumber: string | null = null
  let amount: number | null = null
  let checkNumber: string | null = null
  let matchCount = 0

  // ---- SUITE NUMBER ----
  // Look for 3-digit numbers in the 100-140 range, possibly with slash for shared suites
  const suitePatterns = [
    // Explicit: "Suite 110", "Ste 110", "STE 110", "#110"
    /(?:suite|ste|s(?:ui)?t?e?|#)\s*(\d{3}(?:\s*[\/\-]\s*\d{3})?)/i,
    // "110" or "106/108" standalone on a line (3-digit number in suite range)
    /^(\d{3}(?:\s*[\/\-]\s*\d{3})?)$/m,
    // 3-digit number in 100-140 range anywhere
    /\b(1[0-4]\d(?:\s*[\/\-]\s*1[0-4]\d)?)\b/,
  ]
  for (const pattern of suitePatterns) {
    const match = text.match(pattern)
    if (match) {
      const num = match[1].replace(/\s/g, '')
      // Verify it's in a reasonable suite range
      const firstNum = parseInt(num.split(/[\/\-]/)[0])
      if (firstNum >= 100 && firstNum <= 145) {
        suiteNumber = num
        matchCount++
        break
      }
    }
  }

  // ---- AMOUNT ----
  // Look for dollar amounts between $100-$1000
  const amountPatterns = [
    // "$220.00" or "$ 220.00"
    /\$\s*([\d,]+(?:\.\d{2})?)/,
    // "220.00" (with cents, standalone)
    /\b(\d{3}(?:\.\d{2}))\b/,
    // Amount with label: "Amount: 220", "Amt 220"
    /(?:amount|amt)[:\s]*\$?\s*([\d,]+(?:\.\d{2})?)/i,
  ]
  for (const pattern of amountPatterns) {
    const match = text.match(pattern)
    if (match) {
      const val = parseFloat(match[1].replace(/,/g, ''))
      // Reasonable rent amount range
      if (val >= 100 && val <= 2000) {
        amount = val
        matchCount++
        break
      }
    }
  }

  // If no dollar sign found, look for any number that could be an amount (150-500 range)
  if (amount === null) {
    const numbers = text.match(/\b(\d{3}(?:\.\d{2})?)\b/g) || []
    for (const numStr of numbers) {
      const val = parseFloat(numStr)
      // Skip numbers that look like suite numbers (already captured) or check numbers (4+ digits)
      if (val >= 150 && val <= 500 && numStr !== suiteNumber) {
        amount = val
        matchCount++
        break
      }
    }
  }

  // ---- CHECK NUMBER ----
  // Check numbers are typically 4-6 digit numbers, sometimes labeled
  const checkPatterns = [
    // Explicit: "Check #1234", "Chk 1234", "Check No 1234"
    /(?:check|chk|ck)[\s#.:]*(\d{3,8})/i,
    // "#1234" or "No. 1234"
    /(?:#|no\.?)\s*(\d{4,8})/i,
    // 4-6 digit number not matching suite or amount
    /\b(\d{4,8})\b/,
  ]
  for (const pattern of checkPatterns) {
    const match = text.match(pattern)
    if (match) {
      const num = match[1]
      // Make sure it's not the suite number or amount
      if (num !== suiteNumber && parseFloat(num) !== amount) {
        checkNumber = num
        matchCount++
        break
      }
    }
  }

  // If we still need a check number, look for any remaining 4+ digit number
  if (checkNumber === null) {
    const allNumbers = text.match(/\b(\d{4,8})\b/g) || []
    for (const num of allNumbers) {
      if (num !== suiteNumber && parseFloat(num) !== amount) {
        checkNumber = num
        matchCount++
        break
      }
    }
  }

  // Determine confidence
  let confidence: 'high' | 'medium' | 'low' = 'low'
  if (matchCount >= 3) confidence = 'high'
  else if (matchCount >= 2) confidence = 'medium'

  return { suiteNumber, amount, checkNumber, confidence, rawText: text }
}

// Scan a single check image
export async function scanCheckImage(
  imageBase64: string,
  _mimeType: string,
  apiKey: string
): Promise<ScannedCheck> {
  const rawText = await ocrImage(imageBase64, apiKey)
  return parseCheckText(rawText)
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
