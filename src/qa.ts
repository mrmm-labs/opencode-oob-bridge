/** The fixed instruction behind `/qa` and the QA button of a turn card. */
const QA_INSTRUCTION =
  "Run an interactive Q&A on the open decisions now. Collect them (unanswered questions you raised in this session, pending question forms, the project's open-questions file). Ask them with the question tool, never as plain text: at most 4 questions per form, 2 to 4 short options each, the recommended option first. Record every answer where that decision lives and do not act on anything not decided."

export const MAX_QA_TOPIC = 200

/** The prompt for a Q&A, with the typed topic (capped, on one line) as a focus. It is only ever text for the session. */
export function qaText(topic = ""): string {
  const focus = topic.replace(/\s+/g, " ").trim().slice(0, MAX_QA_TOPIC)
  return focus ? `${QA_INSTRUCTION} Focus: ${focus}` : QA_INSTRUCTION
}
