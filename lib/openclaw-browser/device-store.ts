/**
 * This browser's pairing with the user's OpenClaw gateway, in IndexedDB.
 *
 * One record per dsul account on this browser, keyed by the account's id, so a
 * second person signing in here never borrows the first one's pairing. A record
 * holds:
 *   - the gateway's address,
 *   - the device key: an Ed25519 pair whose private half is NON-EXTRACTABLE.
 *     IndexedDB stores the CryptoKey object itself, so the key can sign on this
 *     origin but its bytes can never be read out, by dsul or by anything else
 *     running on the page,
 *   - the device token the gateway issued once the pairing was approved.
 *
 * Never the gateway's shared token. That is typed once during setup, held in
 * memory until the gateway answers (lib/openclaw-browser/link.ts), and dropped.
 * Nothing here is ever sent to dsul's servers.
 */

export interface DeviceToken {
  token: string;
  scopes: string[];
}

export interface BrowserDeviceRecord {
  userId: string;
  /** The gateway, as the browser reaches it: ws:// or wss://. */
  url: string;
  keys: CryptoKeyPair;
  /** Issued on the first approved connect; null until then. */
  deviceToken: DeviceToken | null;
  /** When the gateway first let this browser in. Null while setup is still waiting. */
  pairedAt: number | null;
}

const DB_NAME = 'dsul-openclaw';
const STORE = 'devices';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('no indexedDB'));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'userId' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
  });
}

async function run<T>(mode: IDBTransactionMode, body: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await open();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = body(tx.objectStore(STORE));
      let value: T | undefined;
      if (req) req.onsuccess = () => (value = req.result);
      tx.oncomplete = () => resolve(value);
      tx.onerror = () => reject(tx.error ?? new Error('indexedDB transaction failed'));
      tx.onabort = () => reject(tx.error ?? new Error('indexedDB transaction aborted'));
    });
  } finally {
    db.close();
  }
}

const isRecord = (v: unknown): v is BrowserDeviceRecord =>
  !!v &&
  typeof v === 'object' &&
  typeof (v as BrowserDeviceRecord).userId === 'string' &&
  typeof (v as BrowserDeviceRecord).url === 'string' &&
  !!(v as BrowserDeviceRecord).keys?.privateKey &&
  !!(v as BrowserDeviceRecord).keys?.publicKey;

export async function readDevice(userId: string): Promise<BrowserDeviceRecord | null> {
  const v = await run<unknown>('readonly', (s) => s.get(userId));
  return isRecord(v) ? v : null;
}

export async function writeDevice(record: BrowserDeviceRecord): Promise<void> {
  await run('readwrite', (s) => s.put(record));
}

/** Read, change, write, in one transaction, so two tabs can't interleave a token write. */
export async function updateDevice(
  userId: string,
  change: (record: BrowserDeviceRecord) => BrowserDeviceRecord | null
): Promise<BrowserDeviceRecord | null> {
  const db = await open();
  try {
    return await new Promise<BrowserDeviceRecord | null>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      let next: BrowserDeviceRecord | null = null;
      const get = store.get(userId);
      get.onsuccess = () => {
        if (!isRecord(get.result)) return;
        next = change(get.result);
        if (next) store.put(next);
      };
      tx.oncomplete = () => resolve(next);
      tx.onerror = () => reject(tx.error ?? new Error('indexedDB transaction failed'));
      tx.onabort = () => reject(tx.error ?? new Error('indexedDB transaction aborted'));
    });
  } finally {
    db.close();
  }
}

/** Forget this browser: the key, the token and the address go together. */
export async function deleteDevice(userId: string): Promise<void> {
  await run('readwrite', (s) => s.delete(userId));
}

/**
 * Every pairing on this browser, gone: the sign-out and account-switch clear
 * (lib/local-state.ts RAW_CLEARERS). A device token is a credential for the
 * person's own agent, so it does not outlive their session on a shared
 * machine. Never throws; a blocked delete finishes when the other tab closes.
 */
export function clearBrowserPairings(): void {
  try {
    if (typeof indexedDB !== 'undefined') indexedDB.deleteDatabase(DB_NAME);
  } catch {
    // Storage blocked: nothing was written either.
  }
}

/** A fresh device key. The private half can sign here and can never be exported. */
export async function generateDeviceKeys(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify'])) as CryptoKeyPair;
}

/** Can this browser hold a device key at all (Ed25519 in WebCrypto, IndexedDB)? */
export async function browserCanPair(): Promise<boolean> {
  if (typeof indexedDB === 'undefined' || typeof crypto === 'undefined' || !crypto.subtle) return false;
  try {
    await generateDeviceKeys();
    return true;
  } catch {
    return false;
  }
}
