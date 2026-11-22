// The questions of one form, answered on one screen. The choices live in a draft until Send.
// A draft has one entry per question: the options chosen and the typed "Other" answer.

const RECOMMENDED = /\s*\(recommended\)\s*/i

export const isRecommended = (option) => RECOMMENDED.test(option)

/** The label to show: the "(Recommended)" suffix becomes a tag. */
export const plain = (option) => option.replace(RECOMMENDED, " ").trim()

const clean = (t) => t.replace(/\s+/g, " ").trim()

/** Every recommended option is chosen; a single-select question keeps the first. */
export const newDraft = (items) =>
  items.map((q) => {
    const chosen = q.options.filter(isRecommended)
    return { chosen: q.multiple ? chosen : chosen.slice(0, 1), other: "" }
  })

/** A draft read back from the phone, or undefined when it no longer fits the questions. */
export function restore(raw, items) {
  if (!Array.isArray(raw) || raw.length !== items.length) return undefined
  const fits = raw.every(
    (d, i) =>
      d &&
      Array.isArray(d.chosen) &&
      typeof d.other === "string" &&
      d.chosen.every((c) => items[i].options.includes(c)) &&
      (!d.other || items[i].custom),
  )
  return fits ? raw : undefined
}

const at = (draft, i, fn) => draft.map((d, j) => (j === i ? fn(d) : d))

/** Picks an option; a single-select question replaces its answer, a multi-select one toggles. */
export function pick(draft, i, q, option) {
  if (!q.options.includes(option)) return draft
  return at(draft, i, (d) =>
    !q.multiple
      ? { chosen: [option], other: "" }
      : {
          ...d,
          chosen: d.chosen.includes(option)
            ? d.chosen.filter((o) => o !== option)
            : [...d.chosen, option],
        },
  )
}

/** The typed answer of a question that allows one; empty text takes it back. */
export function other(draft, i, q, text) {
  if (!q.custom) return draft
  const other = clean(text)
  return at(draft, i, (d) =>
    q.multiple ? { ...d, other } : { chosen: [], other },
  )
}

export const values = (d) => [...d.chosen, ...(d.other ? [d.other] : [])]

/** Whether every question has an answer. */
export const ready = (items, draft) =>
  items.length > 0 && items.every((_, i) => values(draft[i]).length > 0)

/** The body of the answer action: one value per question, so nothing is guessed from numbers or separators. */
export function body(prompt, items, draft) {
  const answers = {}
  items.forEach((q, i) => {
    const v = values(draft[i])
    answers[q.key] = q.multiple ? v : v[0]
  })
  return { prompt, answers }
}
