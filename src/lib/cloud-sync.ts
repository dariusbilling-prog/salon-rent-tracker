// Best-effort cloud mirror of the app's localStorage state to Postgres.
//
// DESIGN PRINCIPLE: this is PURELY ADDITIVE. localStorage stays the working
// store in the browser. Every network call here is wrapped so that if the
// database is unreachable, the app keeps functioning exactly as before.

const KEY_PREFIX = 'salon-'

// Writes are gated until the initial sync decides hydrate-vs-migrate, so we
// never push empty/default state up before real data is loaded.
let pushEnabled = false

/** Mirror a single key/value to the cloud (fire-and-forget). */
export function pushKey(key: string, value: unknown): void {
  if (!pushEnabled || typeof window === 'undefined') return
  void fetch('/api/state', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key, value }),
  }).catch(() => {
    /* offline / DB down — localStorage still holds the data */
  })
}

function localSalonKeys(): string[] {
  const keys: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (k && k.startsWith(KEY_PREFIX)) keys.push(k)
  }
  return keys
}

async function pushAllLocal(): Promise<void> {
  for (const k of localSalonKeys()) {
    const raw = localStorage.getItem(k)
    if (raw == null) continue
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      value = raw
    }
    try {
      await fetch('/api/state', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: k, value }),
      })
    } catch {
      /* ignore individual failures */
    }
  }
}

export type SyncResult = 'hydrated' | 'migrated' | 'offline'

/**
 * Run once on app mount.
 * - If the cloud already has data -> hydrate localStorage from it (cloud wins).
 * - If the cloud is empty but this browser has data -> migrate it up.
 * - If the cloud is unreachable -> stay fully local (offline).
 */
export async function initCloudSync(): Promise<SyncResult> {
  if (typeof window === 'undefined') return 'offline'

  let server: Record<string, unknown> = {}
  try {
    const res = await fetch('/api/state', { cache: 'no-store' })
    if (!res.ok) return 'offline'
    server = await res.json()
  } catch {
    return 'offline'
  }

  const serverHasData = server && server['salon-tenants']

  if (serverHasData) {
    for (const [k, v] of Object.entries(server)) {
      try {
        localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v))
      } catch {
        /* ignore */
      }
    }
    pushEnabled = true
    return 'hydrated'
  }

  // Cloud empty — enable pushing and migrate this browser's data (if any).
  pushEnabled = true
  if (localStorage.getItem('salon-tenants')) {
    await pushAllLocal()
    return 'migrated'
  }
  return 'hydrated'
}
