# Gmail Zelle Integration — Setup Guide

This walks through the one-time Google Cloud setup needed to scan your Gmail for Chase Zelle notifications. Takes about 15 minutes.

## Part 1 — Google Cloud Console Setup

### Step 1: Create a Google Cloud project

1. Go to https://console.cloud.google.com
2. Sign in with the Gmail account that receives Chase Zelle notifications
3. Click the project dropdown at the top (says "Select a project")
4. Click **"New Project"**
5. Name it: `Salon Boutique Rent Tracker`
6. Click **Create** and wait for it to finish
7. Make sure the new project is selected in the dropdown

### Step 2: Enable the Gmail API

1. In the left sidebar, click **APIs & Services → Library**
2. Search for **"Gmail API"**
3. Click the result, then click **Enable**
4. Wait for it to enable (about 10 seconds)

### Step 3: Configure the OAuth consent screen

1. In the left sidebar, click **APIs & Services → OAuth consent screen**
2. Select **External** and click **Create**
3. Fill out the basic info:
   - **App name:** `Salon Boutique Rent Tracker`
   - **User support email:** your email
   - **Developer contact email:** your email
4. Click **Save and Continue**
5. On the **Scopes** screen: click **Add or Remove Scopes**
   - Search for `gmail.readonly`
   - Check the box for `.../auth/gmail.readonly` (read-only access to Gmail)
   - Click **Update**
6. Click **Save and Continue**
7. On the **Test users** screen, click **Add Users**
   - Add your own Gmail address
   - Add any manager's Gmail that should use the app
8. Click **Save and Continue**, then **Back to Dashboard**

**Important:** Leave the app in "Testing" mode. This is fine for up to 100 users. You don't need to publish/verify.

### Step 4: Create OAuth credentials

1. In the sidebar, click **APIs & Services → Credentials**
2. Click **+ Create Credentials → OAuth client ID**
3. Application type: **Web application**
4. Name: `Salon Boutique Web`
5. Under **Authorized redirect URIs**, click **Add URI** and add:
   - `https://YOUR-VERCEL-URL.vercel.app/api/auth/google/callback`
   - (Replace `YOUR-VERCEL-URL` with your actual Vercel deployment URL)
   - If you also run the app locally, add: `http://localhost:3000/api/auth/google/callback`
6. Click **Create**
7. A popup shows your **Client ID** and **Client Secret**. Copy both — you'll need them in Part 2.

## Part 2 — Add Credentials to Vercel

1. Go to https://vercel.com and open your `salon-rent-tracker` project
2. Click **Settings → Environment Variables**
3. Add these three variables (for **Production**, **Preview**, and **Development**):

| Name | Value |
|------|-------|
| `GOOGLE_CLIENT_ID` | (paste Client ID from Step 4) |
| `GOOGLE_CLIENT_SECRET` | (paste Client Secret from Step 4) |
| `GOOGLE_REDIRECT_URI` | `https://YOUR-VERCEL-URL.vercel.app/api/auth/google/callback` |

4. Click **Save** on each one
5. Go to the **Deployments** tab, click the three dots on the latest deployment, and choose **Redeploy** so the new env vars take effect

## Part 3 — Connect Gmail in the App

1. Open your deployed app
2. You'll see a **"Connect Gmail"** button in the header
3. Click it — you'll be taken to Google's sign-in page
4. Sign in with your Gmail
5. You may see a warning screen saying "Google hasn't verified this app" — this is because your app is in testing mode. Click **Advanced → Go to Salon Boutique Rent Tracker (unsafe)** to continue. (It says "unsafe" but it's your own app — this is normal for testing-mode apps.)
6. Grant the read-only Gmail permission
7. You'll be redirected back to the app, and the button will change to **"Scan Zelle"**

## How to Use It

1. Navigate to the month you want to process
2. Click **Scan Zelle**
3. Click **Scan Now** in the modal
4. The app will find every Chase Zelle notification email from that month
5. Review the matches — most will auto-match to tenants by name
6. For anything unmatched, pick the correct tenant from the dropdown
7. Click **Apply Payments** to add them to the correct weeks

Zelle payments are smart-merged just like CSV imports — they won't overwrite manual entries, and you can re-scan anytime to pull in newer payments.

## Troubleshooting

**"Gmail connection failed: access_denied"** — You declined the permission grant. Click Connect Gmail again and approve it.

**"Gmail connection failed: invalid_client"** — The `GOOGLE_CLIENT_ID` or `GOOGLE_CLIENT_SECRET` in Vercel is wrong. Double-check them.

**"redirect_uri_mismatch"** — The redirect URI in Google Cloud Console doesn't match exactly what Vercel is using. Make sure both are identical including `https://` and `/api/auth/google/callback` at the end.

**No Zelle emails found** — The scan only looks for emails from `chase.com`, `jpmorgan.com`, or Chase alert addresses with "Zelle" in the subject. Check that your Chase Zelle notifications are in your main inbox (not archived or filtered away).

**Wrong tenant matched** — Some tenants might Zelle from their spouse's account or a different name than what's in your tenant list. Use the dropdown in the scan results to manually assign them to the correct tenant.
