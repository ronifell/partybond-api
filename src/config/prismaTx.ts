/**
 * Default options for prisma.$transaction(async (tx) => ...).
 *
 * The defaults are tuned for environments with high RTT to the database
 * (e.g. running locally against a Supabase project in a distant region,
 * or behind a VPN). Each individual query can take ~1s of round-trip,
 * and a queue/match-making transaction may run 5+ queries.
 *
 * - maxWait:  how long Prisma waits for a free connection from the pool.
 * - timeout:  how long the transaction may run before Prisma aborts it.
 */
export const TX_OPTIONS = {
  maxWait: 15_000,
  timeout: 30_000,
} as const;
