import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { join } from "path"
import consola from "consola"
import { getDataDir } from "~/lib/data-dir"

const KEYS_FILE = join(getDataDir(), "api-keys.json")

export interface ApiKeyEntry {
    key: string
    label: string
    createdAt: string
    lastUsed?: string
    requestCount: number
}

interface KeyStore {
    adminKey: string  // Master key from ANTI_API_SECRET env
    keys: ApiKeyEntry[]
}

let store: KeyStore = {
    adminKey: process.env.ANTI_API_SECRET || "",
    keys: [],
}

function generateKey(): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    let key = "ak-"
    for (let i = 0; i < 40; i++) {
        key += chars.charAt(Math.floor(Math.random() * chars.length))
    }
    return key
}

export function loadKeys(): void {
    try {
        if (existsSync(KEYS_FILE)) {
            const data = JSON.parse(readFileSync(KEYS_FILE, "utf-8"))
            store.keys = Array.isArray(data.keys) ? data.keys : []
        }
    } catch (e) {
        consola.warn("Failed to load API keys:", e)
    }
    store.adminKey = process.env.ANTI_API_SECRET || ""
}

function saveKeys(): void {
    try {
        const dir = getDataDir()
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
        writeFileSync(KEYS_FILE, JSON.stringify({ keys: store.keys }, null, 2))
    } catch (e) {
        consola.warn("Failed to save API keys:", e)
    }
}

/** Check if a key is valid (admin key or any generated key) */
export function isValidKey(key: string): boolean {
    if (!key) return false
    if (store.adminKey && key === store.adminKey) return true
    return store.keys.some(k => k.key === key)
}

/** Record a key usage (bump count + lastUsed) */
export function recordKeyUsage(key: string): void {
    const entry = store.keys.find(k => k.key === key)
    if (entry) {
        entry.requestCount++
        entry.lastUsed = new Date().toISOString()
        // Debounced save
        if (entry.requestCount % 10 === 0) saveKeys()
    }
}

/** Create a new API key */
export function createKey(label: string): ApiKeyEntry {
    const entry: ApiKeyEntry = {
        key: generateKey(),
        label: label || "Untitled",
        createdAt: new Date().toISOString(),
        requestCount: 0,
    }
    store.keys.push(entry)
    saveKeys()
    return entry
}

/** Delete an API key */
export function deleteKey(key: string): boolean {
    const idx = store.keys.findIndex(k => k.key === key)
    if (idx < 0) return false
    store.keys.splice(idx, 1)
    saveKeys()
    return true
}

/** List all keys (masks the key value for display) */
export function listKeys(): Array<ApiKeyEntry & { maskedKey: string }> {
    return store.keys.map(k => ({
        ...k,
        maskedKey: k.key.slice(0, 6) + "..." + k.key.slice(-4),
    }))
}

/** Get the label for a key (for usage tracking display) */
export function getKeyLabel(key: string): string | null {
    if (store.adminKey && key === store.adminKey) return "admin"
    const entry = store.keys.find(k => k.key === key)
    return entry?.label || null
}

/** Check if a key is the admin key (ANTI_API_SECRET) — grants direct model access */
export function isAdminKey(key: string): boolean {
    return !!key && !!store.adminKey && key === store.adminKey
}

/** Get a valid API key for internal use (admin key or first generated key) */
export function getInternalKey(): string | null {
    if (store.adminKey) return store.adminKey
    if (store.keys.length > 0) return store.keys[0].key
    return null
}

// Initialize on module load
loadKeys()
