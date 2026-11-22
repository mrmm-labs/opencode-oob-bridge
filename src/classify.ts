import type { Question } from "./inbound.ts"

export const ONE_TAP_OPTIONS = 4
export const ONE_TAP_LABEL = 24

/**
 * A question a chat may answer with buttons: one single-select field with a
 * few short options. Anything else is answered in the app.
 */
export const oneTap = (qs: Question[]): boolean =>
  qs.length === 1 &&
  !qs[0].multiple &&
  qs[0].options.length >= 2 &&
  qs[0].options.length <= ONE_TAP_OPTIONS &&
  qs[0].options.every((o) => o.length <= ONE_TAP_LABEL)
