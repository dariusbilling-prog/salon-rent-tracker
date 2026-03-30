import { NextRequest, NextResponse } from 'next/server'
import { sendSMS, formatPhoneForSMS, buildReminderMessage } from '@/lib/sms'

interface ReminderRequest {
  tenants: Array<{
    tenantName: string
    suiteNumber: string
    phone: string
  }>
}

export async function POST(request: NextRequest) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID
  const authToken = process.env.TWILIO_AUTH_TOKEN
  const fromNumber = process.env.TWILIO_PHONE_NUMBER

  if (!accountSid || !authToken || !fromNumber) {
    return NextResponse.json(
      { error: 'Twilio is not configured. Add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER to your environment variables.' },
      { status: 500 }
    )
  }

  try {
    const body: ReminderRequest = await request.json()

    if (!body.tenants || body.tenants.length === 0) {
      return NextResponse.json({ error: 'No tenants provided' }, { status: 400 })
    }

    const results = []

    for (const tenant of body.tenants) {
      const formattedPhone = formatPhoneForSMS(tenant.phone)

      if (!formattedPhone) {
        results.push({
          tenantName: tenant.tenantName,
          suiteNumber: tenant.suiteNumber,
          phone: tenant.phone,
          success: false,
          error: 'Invalid phone number',
        })
        continue
      }

      const message = buildReminderMessage(tenant.tenantName)
      const result = await sendSMS(formattedPhone, message, accountSid, authToken, fromNumber)

      results.push({
        tenantName: tenant.tenantName,
        suiteNumber: tenant.suiteNumber,
        phone: formattedPhone,
        success: result.success,
        messageSid: result.messageSid,
        error: result.error,
      })

      // Small delay between messages
      await new Promise(resolve => setTimeout(resolve, 200))
    }

    const sent = results.filter(r => r.success).length
    const failed = results.filter(r => !r.success).length

    return NextResponse.json({
      message: `Sent ${sent} reminder(s)${failed > 0 ? `, ${failed} failed` : ''}`,
      results,
      sentAt: new Date().toISOString(),
    })
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to send reminders: ' + (err as Error).message },
      { status: 500 }
    )
  }
}
