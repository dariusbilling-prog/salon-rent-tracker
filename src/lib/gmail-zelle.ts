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
// Handles BOTH direct Chase emails AND forwarded Chase emails from accountant
// Chase email formats:
//   Subject: "You received $XXX from NAME with Zelle®"
//   Subject: "NAME sent you $XXX.XX with Zelle®"
//   Subject: "Fwd: You received money with Zelle®"  (forwarded — details in body)
//   Body: "FirstName LastName sent you $XXX.XX" or similar
//   Body (forwarded): Contains original Chase notification with sender/amount
export function parseChaseZelleEmail(subject: string, body: string): {
  senderName: string | null
  amount: number | null
  memo?: string
  originalDate?: string // ISO date extracted from forwarded email content
} {
  const cleanBody = stripHtml(body)
  // Strip "Fwd:" or "Fwd: " prefix from subject for cleaner matching
  const cleanSubject = subject.replace(/^Fwd:\s*/i, '').trim()
  const combined = `${cleanSubject} ${cleanBody}`

  // Try to extract amount — look for $XXX or $XXX.XX
  let amount: number | null = null
  const amountPatterns = [
    // "sent you $250.00" or "received $250.00"
    /(?:received|sent you|you received)\s*\$([\d,]+(?:\.\d{2})?)/i,
    // "$250.00 from NAME" or "$250.00 with Zelle"
    /\$([\d,]+(?:\.\d{2})?)\s*(?:from|has been|with Zelle)/i,
    // Any dollar amount with cents
    /\$([\d,]+\.\d{2})/,
    // Any dollar amount
    /\$([\d,]+)/,
  ]
  for (const pattern of amountPatterns) {
    const match = combined.match(pattern)
    if (match) {
      amount = parseFloat(match[1].replace(/,/g, ''))
      if (!isNaN(amount) && amount > 0) break
      amount = null
    }
  }

  // Try to extract sender name — check both subject and body
  let senderName: string | null = null
  const namePatterns = [
    // "NAME sent you $XXX with Zelle"
    /(.+?)\s+sent you\s+\$[\d.,]+/i,
    // "You received $XXX from NAME with Zelle"
    /You received\s+\$[\d.,]+\s+from\s+(.+?)(?:\s+with Zelle|\s*\.|\s*$)/i,
    // "received money from NAME"
    /received (?:money |a payment )?from\s+(.+?)(?:\s+for|\s*\.|\s+with|\s+on|\s*$)/i,
    // "NAME has sent you"
    /(.+?)\s+has sent you/i,
    // Just "from NAME" near Zelle context
    /from\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)(?:\s|\.|\,|$)/,
  ]

  // Try subject first (most reliable), then body
  for (const pattern of namePatterns) {
    const match = cleanSubject.match(pattern) || cleanBody.match(pattern)
    if (match) {
      let name = match[1].trim()
      // Clean trailing punctuation, "Fwd:", and common noise
      name = name.replace(/^(?:Fwd|Re|FW):\s*/i, '').trim()
      name = name.replace(/[.,;:!?]+$/, '').trim()
      // Skip if too long (probably a phrase) or too short
      if (name.length > 1 && name.length < 80 && !name.toLowerCase().includes('zelle')) {
        senderName = name
        break
      }
    }
  }

  // Try to extract original date from forwarded email content
  // Look for patterns like "Date: April 10, 2026" or "April 10, 2026 at 3:45 PM"
  let originalDate: string | undefined
  const datePatterns = [
    /Date:\s*([A-Z][a-z]+\s+\d{1,2},?\s+\d{4})/i,
    /(?:on|dated?)\s+([A-Z][a-z]+\s+\d{1,2},?\s+\d{4})/i,
    /(\d{1,2}\/\d{1,2}\/\d{4})/,
    /([A-Z][a-z]+\s+\d{1,2},?\s+\d{4})\s+at\s+\d/i,
  ]
  for (const pattern of datePatterns) {
    const match = cleanBody.match(pattern)
    if (match) {
      try {
        const parsed = new Date(match[1])
        if (!isNaN(parsed.getTime())) {
          originalDate = toISODate(parsed)
          break
        }
      } catch { /* ignore parse failures */ }
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

  return { senderName, amount, memo, originalDate }
}

// Fetch Chase Zelle emails from Gmail in a given date range
export async function fetchZelleEmails(
  accessToken: string,
  startDate: Date,
  endDate: Date,
): Promise<ParsedZellePayment[]> {
  // Gmail search query: Chase Zelle emails between the dates
  const afterStr = `${startDate.getFullYear()}/${startDate.getMonth() + 1}/${startDate.getDate()}`
  const beforeEnd = new Date(endDate)
  beforeEnd.setDate(beforeEnd.getDate() + 1) // include the end date
  const beforeStr = `${beforeEnd.getFullYear()}/${beforeEnd.getMonth() + 1}/${beforeEnd.getDate()}`

  const dateFilter = `after:${afterStr} before:${beforeStr}`

  // Try multiple search queries — different approaches to find forwarded Zelle emails
  const queries = [
    `Zelle ${dateFilter}`,
    `"received money" ${dateFilter}`,
    `subject:Zelle ${dateFilter}`,
    `"sent you money" ${dateFilter}`,
    `from:chase ${dateFilter}`,
    `subject:"received money" ${dateFilter}`,
  ]

  let messageIds: string[] = []
  let successfulQuery = ''
  const queryResults: Record<string, number> = {}

  for (const query of queries) {
    try {
      const listUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=100`
      const listResponse = await fetch(listUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })

      if (!listResponse.ok) continue

      const listData = await listResponse.json()
      const ids: string[] = (listData.messages || []).map((m: any) => m.id)
      queryResults[query] = ids.length

      if (ids.length > 0 && messageIds.length === 0) {
        messageIds = ids
        successfulQuery = query
      }
    } catch {
      queryResults[query] = -1 // error
    }
  }

  // If still nothing, try one last very broad search to verify API works at all
  if (messageIds.length === 0) {
    try {
      const broadUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(dateFilter)}&maxResults=5`
      const broadResponse = await fetch(broadUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      if (broadResponse.ok) {
        const broadData = await broadResponse.json()
        queryResults[`[BROAD] ${dateFilter}`] = (broadData.messages || []).length
      }
    } catch { /* ignore */ }
  }

  console.log(`[Zelle] Query results:`, JSON.stringify(queryResults))
  console.log(`[Zelle] Using query: "${successfulQuery}" → ${messageIds.length} messages`)

  // Store query debug info on the results (will be picked up by the API route)
  ;(fetchZelleEmails as any).__lastDebug = { queryResults, successfulQuery, messageCount: messageIds.length }

  if (messageIds.length === 0) return []

  // Step 2: fetch each message and parse
  const payments: ParsedZellePayment[] = []
  const skipped: Array<{ id: string; subject: string; reason: string }> = []

  for (const id of messageIds) {
    try {
      const msgResponse = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      )
      if (!msgResponse.ok) {
        skipped.push({ id, subject: '(fetch failed)', reason: `HTTP ${msgResponse.status}` })
        continue
      }

      const msg = await msgResponse.json()
      const headers = msg.payload?.headers || []
      const subject = headers.find((h: any) => h.name === 'Subject')?.value || ''
      const dateHeader = headers.find((h: any) => h.name === 'Date')?.value || ''

      const body = extractBody(msg.payload)

      // Include if subject or body relates to receiving Zelle — handle forwarded emails too
      // Forwarded subjects look like: "Fwd: You received money with Zelle®"
      const subjectLower = subject.toLowerCase()
      const bodyLower = body.toLowerCase()
      const combined = `${subjectLower} ${bodyLower}`
      const isReceivedZelle =
        combined.includes('zelle') &&
        (combined.includes('received') ||
          combined.includes('sent you') ||
          combined.includes('deposited'))

      if (!isReceivedZelle) {
        skipped.push({ id, subject, reason: 'not a received Zelle email' })
        continue
      }

      const parsed = parseChaseZelleEmail(subject, body)

      if (!parsed.senderName || !parsed.amount) {
        skipped.push({ id, subject, reason: `parse failed: name=${parsed.senderName}, amount=${parsed.amount}` })
        continue
      }

      const dateObj = dateHeader ? new Date(dateHeader) : new Date()
      // For forwarded emails, prefer the original Chase email date over the forwarded date
      const effectiveDate = parsed.originalDate || toISODate(dateObj)

      payments.push({
        senderName: parsed.senderName,
        amount: parsed.amount,
        dateReceived: effectiveDate,
        memo: parsed.memo,
        messageId: id,
        subject,
        raw: msg.snippet,
      })
    } catch (err) {
      skipped.push({ id, subject: '(error)', reason: (err as Error).message })
    }
  }

  console.log(`[Zelle] Parsed ${payments.length} payments, skipped ${skipped.length}`)
  if (skipped.length > 0) {
    console.log(`[Zelle] Skipped:`, JSON.stringify(skipped.slice(0, 5)))
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
