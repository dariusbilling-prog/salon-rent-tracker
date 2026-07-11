# Salon Rent Tracker — Setup Guide

## Quick Start (Local Development)

### 1. Install dependencies
```bash
cd salon-rent-tracker
npm install
```

### 2. Run the dev server
```bash
npm run dev
```

Open http://localhost:3000 — you'll see the weekly report with your tenant data pre-loaded.

**That's it for Phase 1 testing.** The app works with local data first. No database needed yet.

---

## Deploy to Vercel (When Ready)

### 1. Create a GitHub repo
```bash
cd salon-rent-tracker
git init
git add .
git commit -m "Initial commit — salon rent tracker Phase 1"
git remote add origin https://github.com/YOUR-USERNAME/salon-rent-tracker.git
git push -u origin main
```

### 2. Connect to Vercel
1. Go to https://vercel.com and sign in with GitHub
2. Click "Add New Project"
3. Select your `salon-rent-tracker` repo
4. Click "Deploy" — Vercel auto-detects Next.js
5. Your app is live at `salon-rent-tracker.vercel.app`

### 3. Add custom domain (optional)
1. In Vercel → Project Settings → Domains
2. Add `salon.dariusshojaei.com`
3. Add the DNS record Vercel gives you to your domain registrar
4. Done — HTTPS is automatic

---

## Connect Supabase (Phase 2)

### 1. Create Supabase project
1. Go to https://supabase.com → New Project
2. Name: `salon-rent-tracker`
3. Set a database password (save it!)
4. Region: US East (or closest)

### 2. Get credentials
Go to Project Settings → API. Copy:
- Project URL → `NEXT_PUBLIC_SUPABASE_URL`
- anon/public key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- Connection string → `DATABASE_URL`

### 3. Create `.env.local`
```bash
cp .env.local.example .env.local
# Fill in your Supabase credentials
```

### 4. Push database schema
```bash
npx prisma db push
```

### 5. Seed with your tenant data
```bash
npm run db:seed
```

---

## Project Structure

```
salon-rent-tracker/
├── prisma/schema.prisma       # Database schema (for Supabase)
├── src/
│   ├── app/
│   │   ├── page.tsx           # Main weekly report page
│   │   ├── layout.tsx         # App layout
│   │   └── globals.css        # Tailwind styles
│   ├── components/            # Reusable UI components
│   ├── lib/
│   │   ├── tenant-data.ts     # Local tenant data (pre-database)
│   │   ├── csv-parser.ts      # TenantCloud CSV import + matching
│   │   ├── pdf-generator.ts   # PDF report generation
│   │   └── utils.ts           # Helpers
│   └── types/index.ts         # TypeScript types
├── package.json
└── SETUP.md                   # This file
```
