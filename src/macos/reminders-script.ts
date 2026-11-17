// JavaScript for Automation (JXA) script that writes macOS Reminders. JXA is
// Apple's JavaScript dialect of AppleScript (same Open Scripting Architecture
// and the same Automation permission); it takes real `Date` objects, so no
// locale-dependent date strings are involved.

/** One reminder to create, already mapped to the Reminders fields. */
export interface ReminderWrite {
  /** Unique text embedded in the body; an existing reminder containing it is left untouched. */
  marker: string
  name: string
  body: string
  /** Reminders priority: 0 none, 1 high, 5 medium, 9 low. */
  priority: 0 | 1 | 5 | 9
  /** Due date-time, ISO 8601 with offset. */
  dueAt: string | null
  /** Alert date-time, ISO 8601 with offset. */
  remindAt: string | null
  completed: boolean
}

export interface ReminderWriteResult {
  marker: string
  status: 'created' | 'exists'
}

const SCRIPT = `
function run(argv) {
  var req = JSON.parse(argv[0]);
  var app = Application('Reminders');
  var found = app.lists.whose({ name: req.list })();
  var list;
  if (found.length > 0) {
    list = found[0];
  } else {
    list = app.List({ name: req.list });
    app.lists.push(list);
  }
  var bodies = list.reminders.body();
  var out = [];
  req.items.forEach(function (item) {
    var exists = bodies.some(function (b) { return typeof b === 'string' && b.indexOf(item.marker) >= 0; });
    if (exists) { out.push({ marker: item.marker, status: 'exists' }); return; }
    var props = { name: item.name, body: item.body, priority: item.priority };
    if (item.dueAt) props.dueDate = new Date(item.dueAt);
    if (item.remindAt) props.remindMeDate = new Date(item.remindAt);
    if (item.completed) props.completed = true;
    list.reminders.push(app.Reminder(props));
    bodies.push(item.body);
    out.push({ marker: item.marker, status: 'created' });
  });
  return JSON.stringify(out);
}
`

/**
 * Build the `osascript` argument list that writes reminders into a list,
 * creating the list when missing.
 * @param list - Reminders list name.
 * @param items - reminders to write.
 * @returns argv including the program.
 */
export function buildOsascriptArgv(list: string, items: readonly ReminderWrite[]): string[] {
  return ['/usr/bin/osascript', '-l', 'JavaScript', '-e', SCRIPT, JSON.stringify({ list, items })]
}

/**
 * Parse the script's stdout.
 * @param stdout - text printed by `osascript`.
 * @returns per-item outcomes, in request order.
 */
export function parseWriteResults(stdout: string): ReminderWriteResult[] {
  const parsed: unknown = JSON.parse(stdout.trim())
  if (!Array.isArray(parsed)) throw new Error('osascript did not return a JSON array')
  return parsed as ReminderWriteResult[]
}

/**
 * Whether stderr reports a missing Automation permission (error -1743).
 * @param stderr - text printed by `osascript` on failure.
 * @returns true when macOS refused to let this process control Reminders.
 */
export function isNotAuthorized(stderr: string): boolean {
  return stderr.includes('-1743') || /not authorized/i.test(stderr)
}
