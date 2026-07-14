// Global RPC rate limiter shared by every RPC client in the app.
//
// Both the axios-based HeliusClient and the @solana/web3.js Connection hit the
// SAME RPC endpoint + API key, so throttling has to be GLOBAL (not per-instance)
// to actually respect the provider's requests-per-second budget. Previously each
// HeliusClient kept its own `lastCall` timestamp (and a fresh client was created
// per HTTP request) while Connection traffic wasn't throttled at all, so the
// parallel fan-out in comprehensiveAnalyze burst straight past the limit and the
// provider replied 429 Too Many Requests.
//
// Tunable at runtime via env (no code change / rebuild of this logic needed):
//   RPC_MAX_RPS         - max request *starts* per second   (default 8)
//   RPC_MAX_CONCURRENT  - max in-flight requests            (default 4)
//   RPC_MAX_RETRIES     - retries on 429 / transient errors (default 4)

function envInt(name: string, def: number, min: number, max: number): number {
  const n = parseInt(process.env[name] ?? "", 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

const MAX_RPS = envInt("RPC_MAX_RPS", 8, 1, 50);
const MAX_CONCURRENT = envInt("RPC_MAX_CONCURRENT", 4, 1, 50);
const MAX_RETRIES = envInt("RPC_MAX_RETRIES", 4, 0, 10);
const MIN_INTERVAL_MS = Math.ceil(1000 / MAX_RPS);

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---- concurrency semaphore --------------------------------------------------
let active = 0;
const waiters: Array<() => void> = [];

function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    waiters.push(() => {
      active++;
      resolve();
    });
  });
}

function release(): void {
  active--;
  const next = waiters.shift();
  if (next) next(); // hands the freed slot directly to the next waiter (FIFO)
}

// ---- request pacing (spreads request *starts* evenly over time) -------------
let nextSlot = 0;

async function pace(): Promise<void> {
  const now = Date.now();
  const start = Math.max(now, nextSlot);
  nextSlot = start + MIN_INTERVAL_MS;
  const wait = start - now;
  if (wait > 0) await sleep(wait);
}

/** Run `fn` under the global concurrency cap + request pacing. */
export async function scheduleRpc<T>(fn: () => Promise<T>): Promise<T> {
  await acquire();
  try {
    await pace();
    return await fn();
  } finally {
    release();
  }
}

// ---- rate-limit / transient error handling ----------------------------------
export class RateLimitError extends Error {
  readonly rateLimited = true;
  constructor(message = "RPC rate limited (429)") {
    super(message);
    this.name = "RateLimitError";
  }
}

/** Detects a 429 / overloaded signal from an HTTP status, JSON-RPC code, or message. */
export function isRateLimit(codeOrStatus: unknown, message?: string): boolean {
  if (codeOrStatus === 429 || codeOrStatus === -32005) return true;
  const m = (message ?? "").toString().toLowerCase();
  return (
    m.includes("429") ||
    m.includes("too many requests") ||
    m.includes("rate limit") ||
    m.includes("overloaded") ||
    m.includes("try again")
  );
}

/** Whether an error is worth retrying (rate limit, timeout, transient network / 5xx). */
function isTransient(err: any): boolean {
  if (!err) return false;
  if (err.rateLimited) return true;
  const code = (err.code ?? "").toString();
  if (
    ["ECONNRESET", "ETIMEDOUT", "ECONNABORTED", "EAI_AGAIN", "ENETUNREACH", "EPIPE", "ESOCKETTIMEDOUT"].includes(code)
  ) {
    return true;
  }
  const status = err.response?.status ?? err.status;
  if (status === 429 || status === 502 || status === 503 || status === 504) return true;
  const msg = (err.message ?? "").toString().toLowerCase();
  return (
    msg.includes("timeout") ||
    msg.includes("aborted") ||
    msg.includes("socket hang up") ||
    msg.includes("network") ||
    isRateLimit(undefined, msg)
  );
}

function backoff(attempt: number, rateLimited: boolean): number {
  const base = rateLimited ? 800 : 400;
  const capped = Math.min(base * Math.pow(2, attempt), 10000);
  return capped + Math.random() * 300; // full jitter tail to de-sync concurrent retries
}

/**
 * Run `fn` under the global limiter, retrying on 429 / transient errors with
 * exponential backoff + jitter. Backoff sleeps happen OUTSIDE the concurrency
 * slot so a backing-off request doesn't block healthy ones. Non-transient
 * errors are thrown immediately.
 */
export async function callWithRetry<T>(fn: () => Promise<T>, retries: number = MAX_RETRIES): Promise<T> {
  const max = Number.isFinite(retries) ? retries : MAX_RETRIES;
  let lastErr: any;
  for (let attempt = 0; attempt <= max; attempt++) {
    try {
      return await scheduleRpc(fn);
    } catch (err: any) {
      lastErr = err;
      if (attempt < max && isTransient(err)) {
        await sleep(backoff(attempt, !!err.rateLimited));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}
