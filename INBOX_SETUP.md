# Tenant Inbox — setup

Tenant texts → iPhone Shortcut → `/api/inbox/inbound` → Supabase → `/inbox` page.
Your Mac never has to be on.

## 1. Vercel environment variables (one time)

Vercel → salon-rent-tracker → Settings → Environment Variables, add:

| Name | Value |
|---|---|
| `INBOX_SECRET` | Any long random password. You'll type it once in the Shortcut and once on the /inbox page. |
| `ANTHROPIC_API_KEY` | From console.anthropic.com → API Keys. Drafts cost well under a cent each. |
| `ANTHROPIC_MODEL` | Optional. Defaults to `claude-sonnet-4-5`. |

Redeploy after adding them. The database table creates itself on first use.

If Vercel **Deployment Protection** is on for production, the iPhone can't reach the
API. Either turn it off for Production, or add a "Protection Bypass for Automation"
secret and send it as an `x-vercel-protection-bypass` header in both Shortcuts.

## 2. iPhone — capture tenant texts

Shortcuts app → **Automation** → **+** → **Message**
- **Sender:** pick your tenants (you can add more later). Leave "Message Contains" empty.
- Choose **Run Immediately** (turn off "Notify When Run").
- Next → **New Blank Automation** → add **Get Contents of URL**:
  - URL: `https://salon-rent-tracker.vercel.app/api/inbox/inbound`
  - Method: **POST**
  - Headers: `x-inbox-key` = your INBOX_SECRET
  - Request Body: **JSON**
    - `sender` → tap, choose **Shortcut Input**, then pick **Sender**
    - `body` → **Shortcut Input** → **Content**

Text yourself from a tenant contact (or ask a friend saved as a test contact) to try it.

## 3. iPhone — check-ins through the day

Shortcuts → Automation → **+** → **Time of Day** (make one each for 10am, 12pm, 2pm, 4pm, 6pm, 8pm),
Run Immediately, then:
1. **Get Contents of URL** — `https://salon-rent-tracker.vercel.app/api/inbox/summary`,
   Method GET, Header `x-inbox-key` = your INBOX_SECRET
2. **If** *Contents of URL* **has any value** → **Show Notification** with *Contents of URL*

Nothing waiting = no notification.

## 4. Use it

Open `https://salon-rent-tracker.vercel.app/inbox` on your phone → Share → **Add to Home Screen**.
- **Draft reply** writes a reply in your voice (house rules live in `src/app/api/inbox/draft/route.ts`).
- Type a hint ("approve it", "say no politely") and tap **Rewrite** to steer it.
- **Reply in Messages** opens Messages with the text filled in and marks the thread done.
- **Make task** adds it to the to-do list at the bottom.

## Limits
- Only texts *to* you are captured; if you reply straight from Messages, tap **Mark done**.
- Photo-only texts (payment screenshots) may arrive with little or no text.
