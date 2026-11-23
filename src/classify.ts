import type { Question } from "./inbound.ts"

export const ONE_TAP_OPTIONS = 4
export const ONE_TAP_LABEL = 48

const RECOMMENDED = /\s*\(recommended\)\s*/i

/** An option as a person reads it: without the "(Recommended)" suffix. */
export const plainLabel = (option: string): string =>
  option.replace(RECOMMENDED, " ").trim()

/**
 * A question a chat may answer with buttons: one single-select field with a
 * few options of a readable length, the "(Recommended)" suffix not counted.
 * Anything else is answered in the app.
 */
export const oneTap = (qs: Question[]): boolean =>
  qs.length === 1 &&
  !qs[0].multiple &&
  qs[0].options.length >= 2 &&
  qs[0].options.length <= ONE_TAP_OPTIONS &&
  qs[0].options.every((o) => plainLabel(o).length <= ONE_TAP_LABEL)
