// SMS Service using Twilio
// To set up: Create a Twilio account, get a phone number, and add these env vars:
//   TWILIO_ACCOUNT_SID=your_account_sid
//   TWILIO_AUTH_TOKEN=your_auth_token
//   TWILIO_PHONE_NUMBER=+1XXXXXXXXXX (your Twilio number)

export interface SMSMessage {
  to: string        // tenant phone number
  tenantName: string
  suiteNumber: string
  message: string
}

export interface SMSResult {
  tenantName: string
  suiteNumber: string
  phone: string
  success: boolean
  error?: string
  messageSid?: string
}

// Format phone number to E.164 (+1XXXXXXXXXX)
export function formatPhoneForSMS(phone: string): string | null {
  // Strip everything except digits
  const digits = phone.replace(/\D/g, '')

  // Handle US numbers
  if (digits.length === 10) {
    return `+1${digits}`
  }
  if (digits.length === 11 && digits.startsWith('1')) {
    return `+${digits}`
  }

  return null // Invalid
}

// Build the late reminder message with tenant name personalization
export function buildReminderMessage(tenantName: string): string {
  // Use just the first name for a personal touch
  const firstName = tenantName.split(/[,/&\s]+/)[0].trim()
  return `Hi ${firstName}, I wanted to follow up regarding your rent from this past Friday. Will you be able to catch that up today? Thank you!`
}

// Send SMS via Twilio REST API (no SDK needed — just fetch)
export async function sendSMS(
  to: string,
  body: string,
  accountSid: string,
  authToken: string,
  fromNumber: string,
): Promise<{ success: boolean; messageSid?: string; error?: string }> {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`

  const params = new URLSearchParams({
    To: to,
    From: fromNumber,
    Body: body,
  })

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    })

    const data = await response.json()

    if (response.ok) {
      return { success: true, messageSid: data.sid }
    } else {
      return { success: false, error: data.message || 'Failed to send' }
    }
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}

// Send reminders to multiple tenants
export async function sendBulkReminders(
  messages: SMSMessage[],
  accountSid: string,
  authToken: string,
  fromNumber: string,
): Promise<SMSResult[]> {
  const results: SMSResult[] = []

  for (const msg of messages) {
    const formattedPhone = formatPhoneForSMS(msg.to)

    if (!formattedPhone) {
      results.push({
        tenantName: msg.tenantName,
        suiteNumber: msg.suiteNumber,
        phone: msg.to,
        success: false,
        error: 'Invalid phone number format',
      })
      continue
    }

    const result = await sendSMS(msg.message, formattedPhone, accountSid, authToken, fromNumber)

    results.push({
      tenantName: msg.tenantName,
      suiteNumber: msg.suiteNumber,
      phone: formattedPhone,
      success: result.success,
      messageSid: result.messageSid,
      error: result.error,
    })

    // Small delay between messages to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 200))
  }

  return results
}
