// Stable item identity shared by the item store and the Reminders marker.
import { createHash } from 'node:crypto'

/**
 * Digest identifying one item across runs and days. Changing the inputs or
 * the digest breaks deduplication of reminders already written.
 * @param kind - todo or schedule.
 * @param title - item title.
 * @param at - due (todo) or start (schedule), ISO 8601, or null.
 * @param sourceName - source name, or null.
 * @param sourceRef - source reference, or null.
 * @returns 12 lowercase hex characters.
 */
export function itemIdOf(kind: 'todo' | 'schedule', title: string, at: string | null, sourceName: string | null, sourceRef: string | null): string {
  return createHash('sha1').update(JSON.stringify([kind, title, at, sourceName, sourceRef])).digest('hex').slice(0, 12)
}
