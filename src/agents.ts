/** A primary agent a chat may pick: `id` is what OpenCode takes, `label` is only shown. */
export type AgentOption = { id: string; label: string }

/** The id of the agent named by id or, ignoring case, by label; undefined when the list has none such. */
export function resolveAgent(
  list: readonly AgentOption[],
  value: string,
): string | undefined {
  const v = value.toLowerCase()
  return (
    list.find((a) => a.id === value) ??
    list.find((a) => a.id.toLowerCase() === v) ??
    list.find((a) => a.label.toLowerCase() === v)
  )?.id
}
