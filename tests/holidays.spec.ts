/**
 * The Chinese statutory-holiday calendar and the band it decides.
 *
 * Both official pricing pages state the holiday exclusion in words only, so the
 * dates are transcribed from the State Council notices (see `src/holidays.ts`)
 * and the band rule is pinned here: holidays are off-peak in full, the working
 * windows are untouched, the 调休 working weekends stay off-peak, and a
 * deployment's own rest days and forced workdays win over the built-in table.
 */
import { describe, expect, it } from 'vitest'
import {
  CHINA_HOLIDAYS,
  DEFAULT_HOLIDAYS,
  HOLIDAY_YEARS,
  beijingDateKey,
  isCalendarDate,
  normalizeDates,
  withHolidayCalendar,
} from '../src/holidays.ts'
import { PEAK_SCHEDULE_EN, PEAK_SCHEDULE_ZH, isPeakHour, parsePeakSchedule } from '../src/pricing.ts'

/** One Beijing wall-clock moment (Asia/Shanghai is a fixed UTC+8). */
const beijing = (date: string, hour: number): Date =>
  new Date(`${date}T${String(hour).padStart(2, '0')}:00:00+08:00`)

describe('holiday calendar', () => {
  it('transcribes the year the notice covers', () => {
    expect(HOLIDAY_YEARS).toEqual([2026])
    expect(CHINA_HOLIDAYS[2026]!.notice).toBe('国办发明电〔2025〕7号')
    expect(DEFAULT_HOLIDAYS).toEqual(CHINA_HOLIDAYS[2026]!.dates)
    expect(DEFAULT_HOLIDAYS).toHaveLength(33)
  })

  it('accepts only a real YYYY-MM-DD calendar date', () => {
    expect(isCalendarDate('2026-10-01')).toBe(true)
    expect(isCalendarDate('2026-02-31')).toBe(false)
    expect(isCalendarDate('2026-2-1')).toBe(false)
    expect(isCalendarDate('holiday')).toBe(false)
  })

  it('normalizes an override list, dropping malformed dates and duplicates', () => {
    expect(normalizeDates(['2026-12-31', 'nope', '2026-12-31', ' 2027-01-01 '])).toEqual(['2026-12-31', '2027-01-01'])
    expect(normalizeDates(undefined)).toEqual([])
  })

  it('places an instant on the Beijing calendar, not the UTC one', () => {
    expect(beijingDateKey(new Date('2026-10-01T02:00:00Z'))).toBe('2026-10-01')
    // 16:00Z is already the next day in Beijing.
    expect(beijingDateKey(new Date('2026-09-30T16:00:00Z'))).toBe('2026-10-01')
  })

  it('attaches the built-in calendar plus the deployment adjustments', () => {
    const schedule = withHolidayCalendar(
      { timezone: 'Asia/Shanghai', ranges: [[9, 12]], weekdaysOnly: true },
      { restDays: ['2026-12-31'], workdays: ['2026-10-10'] },
    )
    expect(schedule.holidays).toEqual([...DEFAULT_HOLIDAYS, '2026-12-31'])
    expect(schedule.workdays).toEqual(['2026-10-10'])
  })

  it('hands the parsed page schedule the same calendar', () => {
    const schedule = parsePeakSchedule('<p>Peak hours: 01:00-04:00 and 06:00-10:00 (UTC)</p>', 'en')
    expect(schedule?.holidays).toEqual(DEFAULT_HOLIDAYS)
    expect(schedule?.workdays).toEqual([])
  })
})

describe('isPeakHour across the Chinese statutory holidays', () => {
  it('bills a National Day weekday off-peak in full', () => {
    // 2026-10-01 is a Thursday inside the National Day holiday.
    expect(isPeakHour(beijing('2026-10-01', 10), PEAK_SCHEDULE_ZH)).toBe(false)
    // The same clock time a week later is an ordinary Thursday.
    expect(isPeakHour(beijing('2026-10-08', 10), PEAK_SCHEDULE_ZH)).toBe(true)
  })

  it('bills every transcribed holiday off-peak, whatever weekday it lands on', () => {
    for (const date of DEFAULT_HOLIDAYS) {
      expect(isPeakHour(beijing(date, 10), PEAK_SCHEDULE_ZH), date).toBe(false)
      expect(isPeakHour(beijing(date, 15), PEAK_SCHEDULE_ZH), date).toBe(false)
    }
  })

  it('leaves the working-hour windows themselves untouched', () => {
    expect(isPeakHour(beijing('2026-10-08', 9), PEAK_SCHEDULE_ZH)).toBe(true)
    expect(isPeakHour(beijing('2026-10-08', 12), PEAK_SCHEDULE_ZH)).toBe(false)
    expect(isPeakHour(beijing('2026-10-08', 14), PEAK_SCHEDULE_ZH)).toBe(true)
    expect(isPeakHour(beijing('2026-10-08', 18), PEAK_SCHEDULE_ZH)).toBe(false)
  })

  it('keeps the 调休 working weekends off-peak, as the pages state', () => {
    // 2026-10-10 and 2026-02-14 are Saturdays the notice makes working days,
    // but the pages restrict peak to Monday through Friday.
    expect(isPeakHour(beijing('2026-10-10', 10), PEAK_SCHEDULE_ZH)).toBe(false)
    expect(isPeakHour(beijing('2026-02-14', 10), PEAK_SCHEDULE_ZH)).toBe(false)
  })

  it('forces a listed workday onto the windows, holiday or weekend included', () => {
    const schedule = withHolidayCalendar(PEAK_SCHEDULE_ZH, { workdays: ['2026-10-10', '2026-10-01'] })
    expect(isPeakHour(beijing('2026-10-10', 10), schedule)).toBe(true)
    expect(isPeakHour(beijing('2026-10-01', 10), schedule)).toBe(true)
    expect(isPeakHour(beijing('2026-10-10', 12), schedule)).toBe(false)
  })

  it('adds a deployment rest day on top of the built-in calendar', () => {
    const schedule = withHolidayCalendar(PEAK_SCHEDULE_ZH, { restDays: ['2026-12-31'] })
    // 2026-12-31 is an ordinary Thursday without the override.
    expect(isPeakHour(beijing('2026-12-31', 10), PEAK_SCHEDULE_ZH)).toBe(true)
    expect(isPeakHour(beijing('2026-12-31', 10), schedule)).toBe(false)
  })

  it('judges the holiday on the Beijing date under the UTC schedule too', () => {
    // 01:00Z is 09:00 Beijing: a Wednesday, and a Thursday inside 国庆.
    expect(isPeakHour(new Date('2026-09-30T01:00:00Z'), PEAK_SCHEDULE_EN)).toBe(true)
    expect(isPeakHour(new Date('2026-10-01T01:00:00Z'), PEAK_SCHEDULE_EN)).toBe(false)
  })

  it('falls back to the weekday rule for a year no notice covers yet', () => {
    // 2027-01-01 is a Friday and absent from the table, so the page's plain
    // Monday-Friday rule applies until the next notice is transcribed.
    expect(isPeakHour(beijing('2027-01-01', 10), PEAK_SCHEDULE_ZH)).toBe(true)
    expect(isPeakHour(beijing('2027-01-02', 10), PEAK_SCHEDULE_ZH)).toBe(false)
  })
})
