/**
 * The process clock tests run on (#379). A suite that started at the real time and moved its
 * clock hours ahead crossed midnight whenever CI ran late in the day, and saw the daily digest,
 * fresh daily counters and a new budget day. The factory test env (`factory-env.ts`) runs `Date`
 * from `TEST_START` instead; `AGENT_RISHI_TEST_CLOCK` (`clock-setup.ts`) starts it at a chosen time
 * of day, to check that a suite doesn't depend on when it runs.
 */

/**
 * Where the factory test env's clock starts: mid-morning, local time, so a test can move it
 * hours ahead (or back) without crossing a day. Day-boundary tests start near midnight on purpose.
 */
export const TEST_START = new Date(2026, 0, 15, 9, 0, 0);

const RealDate = globalThis.Date;
let offsetMs = 0;

/**
 * `Date` running `offsetMs` ahead of the real clock. It is the real constructor behind a proxy
 * (same prototype, same statics), so `instanceof Date` and dates made before it still work.
 */
const ShiftedDate: DateConstructor = new Proxy(RealDate, {
  construct: (target, args, newTarget) =>
    Reflect.construct(target, args.length === 0 ? [RealDate.now() + offsetMs] : args, newTarget),
  apply: () => new RealDate(RealDate.now() + offsetMs).toString(),
  get: (target, key, receiver) =>
    key === "now" ? () => RealDate.now() + offsetMs : Reflect.get(target, key, receiver),
});

/**
 * Run `Date` from `start`, on in real time (timers are left alone, so waits behave as usual).
 * Returns a function that puts back the clock that ran before.
 */
export function runClockFrom(start: Date | number): () => void {
  const previous = { date: globalThis.Date, offsetMs };
  offsetMs = start.valueOf() - RealDate.now();
  globalThis.Date = ShiftedDate;
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    globalThis.Date = previous.date;
    offsetMs = previous.offsetMs;
  };
}

/** `hh:mm` local time, today by the clock running now. */
export function todayAt(hhmm: string): Date {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!match) throw new Error(`expected a time of day as hh:mm, got "${hhmm}"`);
  const at = new Date();
  at.setHours(Number(match[1]), Number(match[2]), 0, 0);
  return at;
}
