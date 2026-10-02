/**
 * The Chinese statutory-holiday calendar the peak/off-peak band subtracts.
 *
 * Both official pricing pages state the rule in words only — "北京时间周一至
 * 周五（不含中国法定节假日）9:00 - 12:00、14:00 - 18:00 为高峰时段；其余时段，
 * 包括周末及中国法定节假日全天均为空闲时段" (zh) and "Peak hours are 01:00 -
 * 04:00 and 06:00 - 10:00 UTC, Monday through Friday, excluding Chinese public
 * holidays" (en) — so the dates themselves have to come from the State Council's
 * annual notice.
 *
 * The table below transcribes 国办发明电〔2025〕7号 (published 2025-11-04) for
 * 2026. Only dates from the peak rollout (2026-08-17) onward can change a price,
 * so earlier years are deliberately absent. **Add each new year's notice here**
 * when it is published; until then a year outside the table falls back to the
 * page's plain Monday-Friday rule, and a deployment can patch the gap from the
 * settings page through {@link HolidayOverrides}.
 *
 * Holiday membership is always judged on the Beijing calendar date of the
 * instant, whichever timezone the schedule states its windows in: the holidays
 * are Chinese public holidays, and the English page's UTC windows are the same
 * Beijing hours spelled in UTC.
 *
 * @module @gamegeek-saikel/dsh-cost-meter/holidays
 */

import type { PeakSchedule } from './types.ts'

/** Timezone the holiday calendar is expressed in. */
export const HOLIDAY_TIMEZONE = 'Asia/Shanghai'

/** One year's statutory holidays, as Beijing-calendar `YYYY-MM-DD` dates. */
export interface HolidayYear {
  /** The State Council notice these dates were transcribed from. */
  notice: string
  /** Every day billed off-peak all day, in ascending date order. */
  dates: readonly string[]
}

/**
 * Statutory holidays by year. Every day listed here is off-peak in full,
 * whatever its weekday and whatever the time.
 *
 * 2026, per 国办发明电〔2025〕7号: 元旦 01-01..01-03; 春节 02-15..02-23;
 * 清明节 04-04..04-06; 劳动节 05-01..05-05; 端午节 06-19..06-21;
 * 中秋节 09-25..09-27; 国庆节 10-01..10-07.
 *
 * The notice also names 调休 working days (2026: 01-04, 02-14, 02-28, 05-09,
 * 09-20, 10-10). They are intentionally NOT in this table: the pages restrict
 * peak to Monday through Friday, and those dates are weekend days, so they stay
 * off-peak. A deployment that reads "工作日" more broadly can list them in
 * {@link HolidayOverrides.workdays}.
 */
export const CHINA_HOLIDAYS: Readonly<Record<number, HolidayYear>> = {
  2026: {
    notice: '国办发明电〔2025〕7号',
    dates: [
      '2026-01-01', '2026-01-02', '2026-01-03',
      '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
      '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
      '2026-04-04', '2026-04-05', '2026-04-06',
      '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
      '2026-06-19', '2026-06-20', '2026-06-21',
      '2026-09-25', '2026-09-26', '2026-09-27',
      '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05',
      '2026-10-06', '2026-10-07',
    ],
  },
}

/** Every transcribed holiday, flattened (the built-in calendar). */
export const DEFAULT_HOLIDAYS: readonly string[] = Object.values(CHINA_HOLIDAYS)
  .flatMap(year => year.dates)

/** The years {@link CHINA_HOLIDAYS} covers, ascending — the ones needing no patch. */
export const HOLIDAY_YEARS: readonly number[] = Object.keys(CHINA_HOLIDAYS)
  .map(Number)
  .sort((left, right) => left - right)

/** A deployment's adjustments to the built-in calendar. */
export interface HolidayOverrides {
  /** Extra days billed off-peak in full (e.g. a bridge day or a company holiday). */
  restDays?: readonly string[]
  /** Days forced onto the working-day rule, peak windows included (e.g. 调休). */
  workdays?: readonly string[]
}

/** `YYYY-MM-DD`, the only spelling a calendar date is accepted in. */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/**
 * Whether one string is a real calendar date in `YYYY-MM-DD` form (the shape
 * alone would also accept `2026-02-31`).
 * @param value - the candidate date.
 * @returns true for an existing calendar date.
 */
export function isCalendarDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

/**
 * Keep the valid dates, in the order given, without duplicates.
 * @param values - candidate dates from configuration.
 * @returns the normalized dates.
 */
export function normalizeDates(values: readonly string[] | undefined): string[] {
  if (values === undefined) return []
  const seen = new Set<string>()
  for (const value of values) {
    if (typeof value === 'string' && isCalendarDate(value.trim())) seen.add(value.trim())
  }
  return [...seen]
}

/**
 * The Beijing-calendar date of one instant as `YYYY-MM-DD`.
 * @param instant - the moment to place on the Beijing calendar.
 * @returns the date key.
 */
export function beijingDateKey(instant: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: HOLIDAY_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant)
  const pick = (type: string): string => parts.find(part => part.type === type)?.value ?? ''
  return `${pick('year')}-${pick('month')}-${pick('day')}`
}

/** Rest-day and workday lookup sets, memoized per schedule object. */
const CALENDARS = new WeakMap<PeakSchedule, { rest: ReadonlySet<string>; work: ReadonlySet<string> }>()

/**
 * The schedule's calendars as lookup sets. The schedule travels over the wire
 * and through storage as plain arrays, so the sets are derived here instead of
 * being carried.
 * @param schedule - the schedule to read.
 * @returns the rest-day and forced-workday sets.
 */
export function calendarsOf(schedule: PeakSchedule): { rest: ReadonlySet<string>; work: ReadonlySet<string> } {
  const cached = CALENDARS.get(schedule)
  if (cached !== undefined) return cached
  const calendars = {
    rest: new Set(schedule.holidays ?? DEFAULT_HOLIDAYS),
    work: new Set(schedule.workdays ?? []),
  }
  CALENDARS.set(schedule, calendars)
  return calendars
}

/**
 * Attach the built-in calendar, plus a deployment's adjustments, to one page
 * schedule. Every schedule the plugin serves or classifies against is composed
 * here, so an override and the page's own windows always travel together.
 * @param schedule - the schedule as parsed from the page (or the fallback).
 * @param overrides - the deployment's extra rest days and forced workdays.
 * @returns the schedule carrying its effective calendars.
 */
export function withHolidayCalendar(schedule: PeakSchedule, overrides: HolidayOverrides = {}): PeakSchedule {
  return {
    ...schedule,
    holidays: [...DEFAULT_HOLIDAYS, ...normalizeDates(overrides.restDays)],
    workdays: normalizeDates(overrides.workdays),
  }
}
