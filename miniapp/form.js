// A question form answered one field at a time, with a review before anything is sent.
// The choices stay here until Submit. The rules are those of the chat stepper.

/** One tap answers a single field with options; everything else needs Send. */
export const oneTap = (qs) =>
  qs.length === 1 && !qs[0].multiple && qs[0].options.length > 0

export const newForm = (questions) => ({
  questions,
  at: 0,
  chosen: questions.map(() => []),
})

export const reviewing = (f) => f.at >= f.questions.length

const clean = (t) => t.replace(/[|,]/g, " ").replace(/\s+/g, " ").trim()

const edit = (f, patch) => ({ ...f, ...patch })

/** Picks an option of the current field; a single-select field moves on. */
export function pick(f, option) {
  const q = f.questions[f.at]
  if (!q?.options.includes(option)) return f
  const chosen = f.chosen.map((c) => [...c])
  const cur = chosen[f.at]
  if (q.multiple)
    chosen[f.at] = cur.includes(option)
      ? cur.filter((o) => o !== option)
      : [...cur, option]
  else chosen[f.at] = [option]
  return edit(f, { chosen, at: q.multiple ? f.at : f.at + 1 })
}

/** A typed answer, for a field that allows one. */
export function type(f, text) {
  const q = f.questions[f.at]
  const t = clean(text)
  if (!q?.custom || !t) return f
  const chosen = f.chosen.map((c) => [...c])
  chosen[f.at] = q.multiple ? [...chosen[f.at], t] : [t]
  return edit(f, { chosen, at: q.multiple ? f.at : f.at + 1 })
}

/** Done on a multi-select field: needs at least one choice. */
export function next(f) {
  return f.chosen[f.at]?.length ? edit(f, { at: f.at + 1 }) : f
}

export const back = (f) => edit(f, { at: Math.max(0, f.at - 1) })

/** Edit from the review: back to the first field, with the choices kept. */
export const restart = (f) => edit(f, { at: 0 })

/** Whether the form can be sent: every field has an answer. */
export const complete = (f) => f.chosen.every((c) => c.length > 0)

/** The body of the answer action: one value per field, so nothing is guessed from numbers or separators. */
export function body(f, prompt) {
  const answers = {}
  f.questions.forEach((q, i) => {
    answers[q.key] = q.multiple ? f.chosen[i] : f.chosen[i][0]
  })
  return { prompt, answers }
}
