/** The fixed instructions behind `/qa` and `/update`, and the buttons that send them. */
const INSTRUCTIONS = {
  qa: "Run an interactive Q&A on the open decisions now. Collect them (unanswered questions you raised in this session, pending question forms, the project's open-questions file). Ask them with the question tool, never as plain text: at most 4 questions per form, 2 to 4 short options each, the recommended option first. Record every answer where that decision lives and do not act on anything not decided.",
  update:
    "Give a short progress update now: what is done, what is running, what needs me. Plain short lists, no tables, at most 12 lines.",
} as const

export type Instruction = keyof typeof INSTRUCTIONS

export const isInstruction = (name: string): name is Instruction =>
  Object.hasOwn(INSTRUCTIONS, name)

export const MAX_FOCUS = 200

/** The prompt for an instruction, with the typed topic (capped, on one line) as a focus. It is only ever text for the session. */
export function instructionText(kind: Instruction, topic = ""): string {
  const focus = topic.replace(/\s+/g, " ").trim().slice(0, MAX_FOCUS)
  return focus ? `${INSTRUCTIONS[kind]} Focus: ${focus}` : INSTRUCTIONS[kind]
}
