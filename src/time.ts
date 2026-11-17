// Deterministic time helpers: IANA time-zone arithmetic, ISO 8601 parsing, and
// formatting. Interpreting natural-language time expressions is the model's job.

/** A calendar date without a time zone. */
export interface Civil { y: number, m: number, d: number }

/** Wall-clock fields of an instant in some time zone. */
export interface ZonedParts extends Civil { h: number, mi: number, s: number }

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone)
  if (f === undefined) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
    formatters.set(timeZone, f)
  }
  return f
}

/**
 * Validate an IANA time-zone name.
 * @param timeZone - candidate name.
 * @returns true when the runtime knows the zone.
 */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone)
    return true
  } catch (error) {
    if (error instanceof RangeError) return false
    throw error
  }
}

/**
 * Wall-clock fields of an instant.
 * @param ms - epoch milliseconds.
 * @param timeZone - IANA zone name.
 * @returns fields as seen in the zone.
 */
export function zonedParts(ms: number, timeZone: string): ZonedParts {
  const parts = formatter(timeZone).formatToParts(new Date(ms))
  const get = (type: string): number => Number(parts.find(p => p.type === type)?.value)
  return { y: get('year'), m: get('month'), d: get('day'), h: get('hour'), mi: get('minute'), s: get('second') }
}

function offsetMinutes(ms: number, timeZone: string): number {
  const p = zonedParts(ms, timeZone)
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s)
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000)
}

/**
 * Convert a wall-clock time in a zone to an instant. Hours may be 24.
 * @param c - calendar date.
 * @param h - hour.
 * @param mi - minute.
 * @param s - second.
 * @param timeZone - IANA zone name.
 * @returns epoch milliseconds.
 */
export function zonedToInstant(c: Civil, h: number, mi: number, s: number, timeZone: string): number {
  const wall = Date.UTC(c.y, c.m - 1, c.d, h, mi, s)
  const first = wall - offsetMinutes(wall, timeZone) * 60000
  return wall - offsetMinutes(first, timeZone) * 60000
}

const pad = (n: number, len = 2): string => String(n).padStart(len, '0')

/**
 * Format an instant as ISO 8601 with the zone's numeric offset.
 * @param ms - epoch milliseconds.
 * @param timeZone - IANA zone name.
 * @returns e.g. `2025-06-03T15:00:00+08:00`.
 */
export function formatIso(ms: number, timeZone: string): string {
  const p = zonedParts(ms, timeZone)
  const off = offsetMinutes(ms, timeZone)
  const sign = off < 0 ? '-' : '+'
  const abs = Math.abs(off)
  return `${pad(p.y, 4)}-${pad(p.m)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

/**
 * Parse an ISO 8601 date-time. Text without an offset is read as wall-clock
 * time in `timeZone`, not in the machine's zone. A date without a time is rejected.
 * @param text - ISO 8601 text, e.g. `2025-06-05T23:59:59+08:00`.
 * @param timeZone - zone for offset-less text.
 * @returns epoch milliseconds, or null when unparsable.
 */
export function parseInstant(text: string, timeZone: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(text.trim())
  if (m === null) return null
  const [, y, mo, d, h, mi, s, off] = m
  if (+mo! < 1 || +mo! > 12 || +d! < 1 || +d! > 31 || +h! > 23 || +mi! > 59 || +(s ?? 0) > 59) return null
  if (off === undefined) return zonedToInstant({ y: +y!, m: +mo!, d: +d! }, +h!, +mi!, +(s ?? 0), timeZone)
  const ms = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s ?? '00'}${off.length === 5 && off !== 'Z' ? `${off.slice(0, 3)}:${off.slice(3)}` : off}`)
  return Number.isNaN(ms) ? null : ms
}

const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/**
 * Chinese weekday name of an instant in a zone.
 * @param ms - epoch milliseconds.
 * @param timeZone - IANA zone name.
 * @returns `周一` ... `周日`.
 */
export function weekdayName(ms: number, timeZone: string): string {
  const p = zonedParts(ms, timeZone)
  return WEEKDAY_NAMES[new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay()]!
}

/**
 * Local calendar date of an instant in a zone.
 * @param ms - epoch milliseconds.
 * @param timeZone - IANA zone name.
 * @returns the date.
 */
export function civilOf(ms: number, timeZone: string): Civil {
  const p = zonedParts(ms, timeZone)
  return { y: p.y, m: p.m, d: p.d }
}
