/** The command list a chat shows after "/": which commands, in what order. */
import { createHash } from "node:crypto"

export type MenuCommand = { command: string; description: string }

/** What decides which commands are offered. */
export type Features = {
  undo: boolean
  resume: boolean
  digest: boolean
  night?: boolean
}

const NAME_RE = /^[a-z0-9_]{1,32}$/
const MAX_DESCRIPTION = 256

const ALL: Array<MenuCommand & { needs?: keyof Features }> = [
  { command: "status", description: "Refresh and pin the status card" },
  { command: "stop", description: "Stop the running turn" },
  { command: "model", description: "Pick the model of this session" },
  { command: "agent", description: "Pick the agent of this session" },
  { command: "compact", description: "Compact this session" },
  { command: "undo", description: "Revert the last turn", needs: "undo" },
  {
    command: "resume",
    description: "Wake a stuck session",
    needs: "resume",
  },
  {
    command: "afk",
    description: "Count me as away for a while (/afk 3h, /afk status)",
  },
  { command: "back", description: "Count me as here for a while (/back 1h)" },
  { command: "auto", description: "Put every session back on auto routing" },
  { command: "digest", description: "Send the digest now", needs: "digest" },
  {
    command: "night",
    description: "Show the overnight plan, or end it",
    needs: "night",
  },
  {
    command: "interrupt",
    description: "Interrupt the running turn (asks first)",
  },
  { command: "topics", description: "Tidy topics: dry run, or /topics apply" },
  { command: "new", description: "Start a session in a listed project" },
  { command: "sessions", description: "Sessions mirrored here, with links" },
  { command: "projects", description: "Projects a new session can use" },
  { command: "variant", description: "Pick the model's effort variant" },
  { command: "steer", description: "Inject a message into the running turn" },
  { command: "qa", description: "Run a Q&A on the open decisions" },
  { command: "update", description: "Ask for a short progress update" },
  { command: "rename", description: "Rename this session" },
  { command: "chat", description: "/chat off stops chatting with it" },
  { command: "version", description: "Plugin version installed and running" },
  { command: "trace", description: "Last updates and sends, with their path" },
  { command: "help", description: "What the commands do here" },
]

/** The list in its fixed order, without the commands whose feature is off. */
export function buildMenu(f: Features): MenuCommand[] {
  return ALL.filter((c) => !c.needs || f[c.needs]).map(
    ({ command, description }) => ({ command, description }),
  )
}

/** The commands Telegram would accept, and a reason for each it would refuse. */
export function validMenu(list: MenuCommand[]): {
  ok: MenuCommand[]
  problems: string[]
} {
  const ok: MenuCommand[] = []
  const problems: string[] = []
  for (const c of list) {
    if (!NAME_RE.test(c.command))
      problems.push(`/${c.command}: the name must match [a-z0-9_]{1,32}`)
    else if (c.description.length < 1 || c.description.length > MAX_DESCRIPTION)
      problems.push(
        `/${c.command}: the description must be 1 to ${MAX_DESCRIPTION} characters`,
      )
    else ok.push(c)
  }
  return { ok, problems }
}

/** A short digest of a list and its scope, to tell whether it changed. */
export const menuHash = (scope: string, list: MenuCommand[]): string =>
  createHash("sha256")
    .update(scope + "\n" + JSON.stringify(list))
    .digest("hex")
    .slice(0, 16)
