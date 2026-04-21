// Check deposit slip scanner using Google Cloud Vision API (FREE tier: 1,000/month)
// Reads deposit slips with MULTIPLE check entries per slip
// Deposit slip format: CHECK# (left column) | DOLLAR AMOUNT (middle grid) | SUITE# (right column)

export interface ScannedCheckEntry {
  suiteNumber: string | null
  amount: number | null
  checkNumber: string | null
  confidence: 'high' | 'medium' | 'low'
}

export interface DepositSlipResult {
  imageIndex: number
  fileName: string
  entries: ScannedCheckEntry[]
  rawText?: string
  error?: string
}

// Word with bounding box position from Vision API
interface WordBox {
  text: string
  centerX: number
  centerY: number
  minX: number
  maxX: number
  minY: number
  maxY: number
}

// Call Google Cloud Vision API and get word-level annotations with bounding positions
async function ocrImageWithPositions(
  imageBase64: string,
  apiKey: string
): Promise<{ fullText: string; words: WordBox[] }> {
  const response = await fetch(
    `https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [
          {
            image: { content: imageBase64 },
            features: [{ type: 'DOCUMENT_TEXT_DETECTION', maxResults: 1 }],
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

  const fullText = annotation?.fullTextAnnotation?.text || ''
  const textAnnotations = annotation?.textAnnotations || []

  // First annotation is the full text description; remaining are individual words with bounding boxes
  const words: WordBox[] = textAnnotations.slice(1).map((a: any) => {
    const vertices = a.boundingPoly?.vertices || []
    const xs = vertices.map((v: any) => v.x || 0)
    const ys = vertices.map((v: any) => v.y || 0)
    return {
      text: a.description || '',
      centerX: (Math.min(...xs) + Math.max(...xs)) / 2,
      centerY: (Math.min(...ys) + Math.max(...ys)) / 2,
      minX: Math.min(...xs),
      maxX: Math.max(...xs),
      minY: Math.min(...ys),
      maxY: Math.max(...ys),
    }
  })

  return { fullText, words }
}

// Group words into rows based on Y-coordinate proximity
function groupIntoRows(words: WordBox[]): WordBox[][] {
  if (words.length === 0) return []

  const sorted = [...words].sort((a, b) => a.centerY - b.centerY)

  // Determine row threshold from typical word height
  const heights = sorted.map(w => w.maxY - w.minY).filter(h => h > 5)
  const medianHeight = heights.length > 0
    ? heights.sort((a, b) => a - b)[Math.floor(heights.length / 2)]
    : 30
  // Words in the same row should be within ~80% of a word height vertically
  const rowThreshold = Math.max(15, Math.min(60, medianHeight * 0.8))

  const rows: WordBox[][] = []
  let currentRow: WordBox[] = [sorted[0]]
  let rowBaseY = sorted[0].centerY

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].centerY - rowBaseY <= rowThreshold) {
      currentRow.push(sorted[i])
    } else {
      rows.push(currentRow.sort((a, b) => a.centerX - b.centerX))
      currentRow = [sorted[i]]
      rowBaseY = sorted[i].centerY
    }
  }
  if (currentRow.length > 0) {
    rows.push(currentRow.sort((a, b) => a.centerX - b.centerX))
  }

  return rows
}

// Noise words from deposit slip headers/footers to ignore
const NOISE_WORDS = new Set([
  'space', 'below', 'for', 'additional', 'checks',
  'check', 'check(s)', 'dollars', 'cents', 'total',
  'please', 'list', 'and', 'include', 'this', 'amount', 'on', 'front',
  'unit', 'un', 'oo', 'o', 's', '$',
])

// Normalize OCR text: replace common misreads (O->0, l->1, etc.)
function normalizeDigits(text: string): string {
  return text
    .replace(/[oO]/g, '0')
    .replace(/[lI]/g, '1')
}

// Check if a word is purely numeric (after normalization)
function isNumeric(text: string): boolean {
  const normalized = normalizeDigits(text.trim())
  return /^\d+$/.test(normalized)
}

// Get the numeric value of a word (with OCR normalization)
function getDigits(text: string): string {
  return normalizeDigits(text.trim()).replace(/[^\d]/g, '')
}

// Check if a row is a data row (has enough numeric tokens)
function isDataRow(row: WordBox[]): boolean {
  const numericCount = row.filter(w => isNumeric(w.text)).length
  return numericCount >= 2
}

// Parse deposit slip entries from word-level OCR data with bounding boxes
export function parseDepositSlip(words: WordBox[]): ScannedCheckEntry[] {
  // Filter out noise/header words
  const filtered = words.filter(w => {
    const text = w.text.trim()
    if (text.length === 0) return false
    if (NOISE_WORDS.has(text.toLowerCase())) return false
    return true
  })

  const rows = groupIntoRows(filtered)
  const entries: ScannedCheckEntry[] = []

  for (const row of rows) {
    if (!isDataRow(row)) continue

    // Get numeric words in this row, sorted left-to-right
    const numericWords = row
      .filter(w => isNumeric(w.text))
      .sort((a, b) => a.centerX - b.centerX)

    if (numericWords.length < 2) continue

    // Strategy: find the two LARGEST horizontal gaps between consecutive words
    // These gaps separate the 3 columns: CHECK# | AMOUNT | SUITE#
    const gaps: Array<{ index: number; gap: number }> = []
    for (let i = 0; i < numericWords.length - 1; i++) {
      gaps.push({
        index: i,
        gap: numericWords[i + 1].minX - numericWords[i].maxX,
      })
    }

    let checkNumber: string | null = null
    let amount: number | null = null
    let suiteNumber: string | null = null

    if (gaps.length >= 2) {
      // Find two largest gaps to split into 3 column groups
      const sortedGaps = [...gaps].sort((a, b) => b.gap - a.gap)
      const splitIndices = sortedGaps.slice(0, 2).map(g => g.index).sort((a, b) => a - b)

      const leftGroup = numericWords.slice(0, splitIndices[0] + 1)
      const middleGroup = numericWords.slice(splitIndices[0] + 1, splitIndices[1] + 1)
      const rightGroup = numericWords.slice(splitIndices[1] + 1)

      // Check number: left column
      checkNumber = leftGroup.map(w => getDigits(w.text)).join('') || null

      // Suite number: right column
      suiteNumber = rightGroup.map(w => getDigits(w.text)).join('') || null

      // Amount: middle column — combine digits, handle DOLLARS+CENTS grid
      const amountDigits = middleGroup.map(w => getDigits(w.text)).join('')
      amount = parseAmountFromDigits(amountDigits)

    } else if (numericWords.length === 3) {
      // Exactly 3 numbers — assume check#, amount, suite#
      checkNumber = getDigits(numericWords[0].text) || null
      amount = parseAmountFromDigits(getDigits(numericWords[1].text))
      suiteNumber = getDigits(numericWords[2].text) || null

    } else if (numericWords.length === 2) {
      // Only 2 numbers — try to identify by value range
      const left = getDigits(numericWords[0].text)
      const right = getDigits(numericWords[1].text)
      const leftVal = parseInt(left)
      const rightVal = parseInt(right)

      // If right number is in suite range (100-145), left is probably amount or check#
      if (rightVal >= 100 && rightVal <= 145) {
        suiteNumber = right
        if (leftVal >= 100 && leftVal <= 2000) {
          amount = leftVal
        } else {
          checkNumber = left
        }
      } else {
        checkNumber = left
        amount = parseAmountFromDigits(right)
      }
    }

    // Validate: skip if we got nothing useful
    if (!checkNumber && amount === null && !suiteNumber) continue

    // Validate suite number is in expected range (100-145)
    const suiteVal = suiteNumber ? parseInt(suiteNumber) : 0
    const validSuite = suiteVal >= 100 && suiteVal <= 145

    // Determine confidence
    let matchCount = 0
    if (checkNumber && checkNumber.length >= 2) matchCount++
    if (amount !== null && amount >= 100 && amount <= 2000) matchCount++
    if (validSuite) matchCount++

    const confidence: 'high' | 'medium' | 'low' =
      matchCount >= 3 ? 'high' : matchCount >= 2 ? 'medium' : 'low'

    entries.push({
      checkNumber,
      amount,
      suiteNumber: suiteNumber || null,
      confidence,
    })
  }

  return entries
}

// Parse a dollar amount from combined digit string
// Deposit slips have DOLLARS and CENTS boxes: "650" + "00" = "65000" -> $650.00
function parseAmountFromDigits(digits: string): number | null {
  if (!digits || digits.length === 0) return null
  const rawNum = parseInt(digits)
  if (isNaN(rawNum)) return null

  // If 5+ digits ending in "00", likely includes cents: 65000 -> $650.00
  if (digits.length >= 5 && digits.endsWith('00')) {
    const dollarAmount = rawNum / 100
    if (dollarAmount >= 50 && dollarAmount <= 2000) return dollarAmount
  }

  // If 4 digits ending in "0", could be partial cents: 2350 -> $235
  if (digits.length === 4 && digits.endsWith('0')) {
    const dollarAmount = rawNum / 10
    if (dollarAmount >= 50 && dollarAmount <= 2000) return dollarAmount
  }

  // If already a reasonable dollar amount (50-2000)
  if (rawNum >= 50 && rawNum <= 2000) return rawNum

  // If very large, try dividing by 100
  if (rawNum > 2000) {
    const divided = rawNum / 100
    if (divided >= 50 && divided <= 2000) return divided
  }

  return rawNum > 0 ? rawNum : null
}

// Scan a single deposit slip image -> returns multiple entries
export async function scanDepositSlip(
  imageBase64: string,
  _mimeType: string,
  apiKey: string
): Promise<{ entries: ScannedCheckEntry[]; rawText: string }> {
  const { fullText, words } = await ocrImageWithPositions(imageBase64, apiKey)
  const entries = parseDepositSlip(words)
  return { entries, rawText: fullText }
}

// Scan multiple deposit slip images
export async function scanDepositSlips(
  images: Array<{ base64: string; mimeType: string; fileName: string }>,
  apiKey: string
): Promise<DepositSlipResult[]> {
  const results: DepositSlipResult[] = []

  for (let i = 0; i < images.length; i++) {
    const img = images[i]
    try {
      const { entries, rawText } = await scanDepositSlip(img.base64, img.mimeType, apiKey)
      results.push({
        imageIndex: i,
        fileName: img.fileName,
        entries,
        rawText,
      })
    } catch (err) {
      results.push({
        imageIndex: i,
        fileName: img.fileName,
        entries: [],
        error: (err as Error).message,
      })
    }
  }

  return results
}
