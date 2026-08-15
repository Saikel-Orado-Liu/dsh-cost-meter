/**
 * Shared display formatting for amounts and timestamps.
 *
 * @module @gamegeek-saikel/dsh-fare-meter/client/format
 */

/**
 * Common currency symbols; unknown currencies render as a bare code.
 * @param currency - ISO 4217 code.
 * @returns the display symbol.
 */
export function currencySymbol(currency: string): string {
  switch (currency) {
    case 'CNY':
      return '¥'
    case 'USD':
      return '$'
    case 'EUR':
      return '€'
    default:
      return `${currency} `
  }
}

/**
 * Compact money: two decimals above 1, four down to 0.01, six below.
 * Costs are CNY 元 with 4-decimal display precision; zero renders as 0.00.
 * @param value - the amount.
 * @returns the fixed-width display string.
 */
export function formatMoney(value: number): string {
  if (value === 0) return '0.00'
  if (value >= 1) return value.toFixed(2)
  if (value >= 0.01) return value.toFixed(4)
  return value.toFixed(6)
}

/** Time formatting for snapshot stamps and step rows. */
export function formatTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}
