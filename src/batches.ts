// In-memory store of distilled batches, shared by the distiller and the
// reminders plugin so the model passes a short batch id instead of the data.
import { randomUUID } from 'node:crypto'
import type { DistillOutput } from './distill.ts'

const MAX_BATCHES = 50
const batches = new Map<string, DistillOutput>()

/**
 * Keep a batch, evicting the oldest beyond the limit.
 * @param batch - distilled result.
 * @returns the new batch id.
 */
export function saveBatch(batch: DistillOutput): string {
  const id = `b-${randomUUID().slice(0, 8)}`
  batches.set(id, batch)
  while (batches.size > MAX_BATCHES) batches.delete(batches.keys().next().value!)
  return id
}

/**
 * Look up a batch.
 * @param id - id returned by {@link saveBatch}.
 * @returns the batch, or undefined when unknown or evicted (also after a restart).
 */
export function getBatch(id: string): DistillOutput | undefined {
  return batches.get(id)
}
