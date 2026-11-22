/**
 * The direct link that opens the Mini App on the enrolment screen with the code filled in. Telegram
 * allows [A-Za-z0-9_-] and 64 characters in a start parameter, so anything else gets no link and
 * the code is typed. The link is shown at the Mac only: it carries the code.
 */
export function enrolLink(
  base: string | undefined,
  code: string,
): string | undefined {
  const start = "enrol_" + code
  if (!base || !/^[A-Za-z0-9_-]{1,64}$/.test(start)) return undefined
  return `${base}?startapp=${start}`
}
