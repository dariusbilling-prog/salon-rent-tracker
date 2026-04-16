// Gmail + Chase Zelle email parser
// Fetches Chase Zelle notification emails and extracts payment details

export interface ParsedZellePayment {
  senderName: string
  amount: number
  dateReceived: string // ISO YYYY-MM-DD
  memo?: string
  messageId: string
  subject: string
  raw?: string // snippet for debugging
}

// Refresh an expired access token using the refresh token
export async function refreshAccessToken(refreshToken: string): Promise<string | null> {
  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  if (!clientId || !clientSecret) return null

  try {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    })
    if (!response.ok) return null
    const data = await response.json()
    return data.access_token || null
  } catch {
    return null
  }
}

// Decode base64url-encoded Gmail body content
function decodeBase64Url(str: string): string {
  const normalized = str.replace(/-/g, '+').replace(/_/g, '/')
  try {
    return Buffer.from(normalized, 'base64').toString('utf-8')
  } catch {
    return ''
  }
}

// Recursively extract plain text body from Gmail message payload
function extractBody(payload: any): string {
  if (!payload) return ''

  if (payload.body?.data) {
    return decodeBase64Url(payload.body.data)
  }

  if (payload.parts) {
    // Prefer text/plain, fall back to text/html
    let plainText = ''
    let htmlText = ''
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        plainText += decodeBase64Url(part.body.data)
      } else if (part.mimeType === 'text/html' && part.body?.data) {
        htmlText += decodeBase64Url(part.body.data)
      } else if (part.parts) {
        const nested = extractBody(part)
        if (nested) plainText += nested
      }
    }
    return plainText || htmlText
  }

  return ''
}

// Strip HTML tags for easier parsing
function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

// Format an ISO date from a JS Date
function toISODate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

// Parse a Chase Zelle notification email body/subject to extract payment details
// Chase email formats we handle:
//   Subject: "You received $XXX from NAME with Zelle®"
//   Subject: "NAME sent you $XXX.XX with Zelle®"
//   Body often contains: "FirstName LastName sent you $XXX.XX" or similar
export function parseChaseZelleEmail(subject: string, body: string): {
  senderName: string | null
  amount: number | null
  memo?: string
} {
  const cleanBody = stripHtml(body)
  const combined = `${subject} ${cleanBody}`

  // Try to extract amount — look for $XXX or $XXX.XX
  // Prefer amounts in the subject or near "sent you" / "received"
  let amount: number | null = null
  const amountPatterns = [
    /(?:received|sent you|you received)\s*\$([\d,]+(?:\.\d{2})?)/i,
    /\$([\d,]+(?:\.\d{2})?)\s*(?:from|has been|with Zelle)/i,
    /\$([\d,]+\.\d{2})/,
    /\$([\d,]+)/,
  ]
  for (const pattern of amountPatterns) {
    const match = combined.match(pattern)
    if (match) {
      amount = parseFloat(match[1].replace(/,/g, ''))
      if (!isNaN(amount)) break
      amount = null
    }
  }

  // Try to extract sender name from subject first (most reliable)
  let senderName: string | null = null
  const namePatterns = [
    // "NAME sent you $XXX with Zelle" (subject)
    /^(.+?)\s+sent you\s+\$[\d.,]+(?:\s+with Zelle)?/i,
    // "You received $XXX from NAME with Zelle"
    /You received\s+\$[\d.,]+\s+from\s+(.+?)(?:\s+with Zelle|$)/i,
    // "received from NAME"
    /received (?:a payment )?from\s+(.+?)(?:\s+for|\.|\s+with|\s+on|$)/i,
    // "NAME has sent you"
    /^(.+?)\s+has sent you/i,
  ]
  for (const pattern of namePatterns) {
    const match = subject.match(pattern) || cleanBody.match(pattern)
    if (match) {
      senderName = match[1].trim()
      // Clean trailing punctuation and common noise
      senderName = senderName.replace(/[.,;:!?]+$/, '').trim()
      // If it's too long it's probably a phrase, not a name
      if (senderName.length > 0 && senderName.length < 80) break
      senderName = null
    }
  }

  // Try to extract optional memo/message
  let memo: string | undefined
  const memoPatterns = [
    /(?:message|memo|note)[:\s]+["']?([^"'\n]{1,200})["']?/i,
    /sent you \$[\d.,]+ (?:for|with) (?:the )?(?:message|note)[:\s]+["']?([^"'\n]{1,200})["']?/i,
  ]
  for (const pattern of memoPatterns) {
    const match = cleanBody.match(pattern)
    if (match && match[1]) {
      memo = match[1].trim()
      if (memo.length > 2) break
      memo = undefined
    }
  }

  return { senderName, amount, memo }
}

// Fetch Chase Zelle emails from Gmail in a given date range
export async function fetchZelleEmails(
  accessToken: string,
  startDate: Date,
  endDate: Date
): Promise<ParsedZellePayment[]> {
  // Gmail search query: Chase Zelle emails between the dates
  const afterStr = `${startDate.getFullYear()}/${startDate.getMonth() + 1}/${startDate.getDate()}`
  const beforeEnd = new Date(endDate)
  beforeEnd.setDate(beforeEnd.getDate() + 1) // include the end date
  const beforeStr = `${beforeEnd.getFullYear()}/${beforeEnd.getMonth() + 1}/${beforeEnd.getDate()}`

  // Broad query that catches various Chase Zelle notification formats
  const query = `from:(chase.com OR jpmorgan.com OR no.reply.alerts@chase.com) (Zelle OR "sent you" OR "received") after:${afterStr} before:${beforeStr}`

  // Step 1: list messages matching the query
  const listUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=100`
  const listResponse = await fetch(listUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })

  if (!listResponse.ok) {
    const errorBody = await listResponse.text()
    throw new Error(`Gmail list failed: ${listResponse.status} ${errorBody}`)
  }

  const listData = await listResponse.json()
  const messageIds: string[] = (listData.messages || []).map((m: any) => m.id)

  if (messageIds.length === 0) return []

  // Step 2: fetch each message and parse
  const payments: ParsedZellePayment[] = []

  for (const id of messageIds) {
    try {
      const msgResponse = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      )
      if (!msgResponse.ok) continue

      const msg = await msgResponse.json()
      const headers = msg.payload?.headers || []
      const subject = headers.find((h: any) => h.name === 'Subject')?.value || ''
      const dateHeader = headers.find((h: any) => h.name === 'Date')?.value || ''

      // Only include if subject clearly relates to receiving Zelle
      // (exclude emails about sending Zelle, declined, etc.)
      const subjectLower = subject.toLowerCase()
      const isReceivedZelle =
        subjectLower.includes('zelle') &&
        (subjectLower.includes('received') ||
          subjectLower.includes('sent you') ||
          subjectLower.includes('deposited'))

      if (!isReceivedZelle) continue

      const body = extractBody(msg.payload)
      const parsed = parseChaseZelleEmail(subject, body)

      if (!parsed.senderName || !parsed.amount) continue

      const dateObj = dateHeader ? new Date(dateHeader) : new Date()

      payments.push({
        senderName: parsed.senderName,
        amount: parsed.amount,
        dateReceived: toISODate(dateObj),
        memo: parsed.memo,
        messageId: id,
        subject,
        raw: msg.snippet,
      })
    } catch (err) {
      console.error(`Failed to fetch/parse message ${id}:`, err)
    }
  }

  return payments
}

// Determine which Friday an email date belongs to (the Friday of that rent week)
// Rent week: Saturday through Friday. So payments on Sat-Fri map to that Friday.
export function getFridayForDate(dateISO: string): string {
  const [y, m, d] = dateISO.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  const day = date.getDay() // 0=Sun ... 5=Fri, 6=Sat

  // If it's Friday, it IS the Friday
  if (day === 5) return dateISO

  // If Sat(6), Friday is 6 days ahead
  // If Sun(0) through Thu(4), Friday is (5-day) days ahead
  const daysToFriday = day === 6 ? 6 : 5 - day
  const friday = new Date(date)
  friday.setDate(friday.getDate() + daysToFriday)
  return toISODate(friday)
}
