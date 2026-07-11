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
//
// Actual Chase forwarded email format (from screenshots):
//   Subject: "Fwd: You received money with Zelle®"
//   Body (HTML after stripping): "... KELLI TANNER sent you money Here are the details:
//     Amount $235.00 Sent on Apr 21, 2026 Transaction number 28911496529
//     Memo Suite 133 kelli tanner ..."
//
// Key insight: the name and amount are SEPARATE in Chase emails.
// "KELLI TANNER sent you money" is the heading, "Amount $235.00" is in a table row below.
export function parseChaseZelleEmail(subject: string, body: string): {
  senderName: string | null
  amount: number | null
  memo?: string
  originalDate?: string
} {
  const cleanBody = stripHtml(body)
  const cleanSubject = subject.replace(/^Fwd:\s*/i, '').trim()
  const combined = `${cleanSubject} ${cleanBody}`

  // ---- AMOUNT ----
  // Chase format: "Amount $235.00" in a table row (most reliable)
  let amount: number | null = null
  const amountPatterns = [
    // Chase table format: "Amount $235.00" or "Amount: $235.00"
    /Amount[:\s]+\$([\d,]+(?:\.\d{2})?)/i,
    // "sent you $250.00" or "received $250.00"
    /(?:received|sent you|you received)\s*\$([\d,]+(?:\.\d{2})?)/i,
    // "$250.00 from NAME" or "$250.00 with Zelle"
    /\$([\d,]+(?:\.\d{2})?)\s*(?:from|has been|with Zelle)/i,
    // Any dollar amount with cents (but skip small amounts like $1.00 from footer links)
    /\$([\d,]+\.\d{2})/,
  ]
  for (const pattern of amountPatterns) {
    const match = combined.match(pattern)
    if (match) {
      const val = parseFloat(match[1].replace(/,/g, ''))
      // Skip tiny amounts that are likely from footer/links, not actual payments
      if (!isNaN(val) && val >= 50) {
        amount = val
        break
      }
    }
  }

  // ---- SENDER NAME ----
  // Chase format: "KELLI TANNER sent you money" (no dollar amount after "sent you")
  let senderName: string | null = null
  const namePatterns = [
    // Chase heading: "NAME sent you money" (the actual format!)
    /([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)+)\s+sent you money/,
    // "NAME sent you money" case-insensitive
    /(.+?)\s+sent you money/i,
    // "NAME sent you $XXX"
    /(.+?)\s+sent you\s+\$/i,
    // "You received $XXX from NAME"
    /You received\s+\$[\d.,]+\s+from\s+(.+?)(?:\s+with|\s*\.|\s*$)/i,
    // "received money from NAME"
    /received (?:money |a payment )?from\s+(.+?)(?:\s+for|\s*\.|\s+with|\s+on|\s*$)/i,
    // "NAME has sent you"
    /(.+?)\s+has sent you/i,
  ]

  for (const pattern of namePatterns) {
    const match = cleanBody.match(pattern) || cleanSubject.match(pattern)
    if (match) {
      let name = match[1].trim()
      name = name.replace(/^(?:Fwd|Re|FW):\s*/i, '').trim()
      name = name.replace(/[.,;:!?]+$/, '').trim()
      // Skip noise words and too-long/too-short matches
      if (name.length > 1 && name.length < 80 &&
          !name.toLowerCase().includes('zelle') &&
          !name.toLowerCase().includes('chase') &&
          !name.toLowerCase().includes('begin forwarded')) {
        senderName = name
        break
      }
    }
  }

  // ---- DATE ----
  // Chase format: "Sent on Apr 21, 2026" or "Date: April 21, 2026 at 9:42:58 AM"
  let originalDate: string | undefined
  const datePatterns = [
    // Chase table: "Sent on Apr 21, 2026"
    /Sent on\s+([A-Z][a-z]+\.?\s+\d{1,2},?\s+\d{4})/i,
    // Forwarded header: "Date: April 21, 2026 at ..."
    /Date:\s*([A-Z][a-z]+\.?\s+\d{1,2},?\s+\d{4})/i,
    // "April 21, 2026 at 3:45 PM"
    /([A-Z][a-z]+\.?\s+\d{1,2},?\s+\d{4})\s+at\s+\d/i,
    // Numeric: MM/DD/YYYY
    /(\d{1,2}\/\d{1,2}\/\d{4})/,
  ]
  for (const pattern of datePatterns) {
    const match = cleanBody.match(pattern)
    if (match) {
      try {
        const parsed = new Date(match[1])
        if (!isNaN(parsed.getTime()) && parsed.getFullYear() >= 2024) {
          originalDate = toISODate(parsed)
          break
        }
      } catch { /* ignore */ }
    }
  }

  // ---- MEMO ----
  // Chase format: "Memo Suite 133 kelli tanner" (contains suite info!)
  let memo: string | undefined
  const memoPatterns = [
    // Chase table: "Memo XXXX" or "Memo: XXXX"
    /Memo[:\s]+([^\n]{1,200}?)(?:\s+[A-Z]{2,}|\s*$)/i,
    /Memo[:\s]+(.+?)(?:\s{2,}|$)/i,
    /(?:message|note)[:\s]+["']?([^"'\n]{1,200})["']?/i,
  ]
  for (const pattern of memoPatterns) {
    const match = cleanBody.match(pattern)
    if (match && match[1]) {
      const m = match[1].trim()
      if (m.length > 1 && !m.toLowerCase().includes('registered with') && !m.toLowerCase().includes('member bank')) {
        memo = m
        break
      }
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
