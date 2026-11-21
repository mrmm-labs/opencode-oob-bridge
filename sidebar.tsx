/** @jsxImportSource @opentui/solid */
/**
 * Draws the "OOB - Remote access" block of the session sidebar. What it shows and what
 * a click does is decided in src/sidebar.ts; this file only turns that into
 * elements. It is loaded by the TUI host as source, like tui.tsx.
 */
import { createMemo, createSignal, For, onCleanup } from "solid-js"

import type { Part, Row, SidebarView, Tone } from "./src/sidebar.ts"

const LABEL_WIDTH = 10

function Block(p: Parameters<SidebarView>[0]) {
  const [tick, setTick] = createSignal(0)
  onCleanup(p.subscribe(() => setTick((n) => n + 1)))
  const model = createMemo(() => {
    tick()
    return p.model()
  })
  const color = (tone: Tone) => p.colors()[tone] as string | undefined
  const full = () => {
    const m = model()
    return m.mode === "full" ? m : undefined
  }
  const compact = () => {
    const m = model()
    return m.mode === "compact" ? m : undefined
  }
  return (
    <>
      {full() && (
        <box flexDirection="column" flexShrink={0} paddingBottom={1}>
          <box flexDirection="row">
            <text flexShrink={0} fg={color("normal")} wrapMode="none">
              <b>{full()!.title}</b>
            </text>
            <text
              flexGrow={1}
              flexShrink={1}
              fg={color("muted")}
              wrapMode="none"
              truncate
              textAlign="right"
            >
              {full()!.channel}
            </text>
          </box>
          {full()!.warning && (
            <text fg={color("warn")} wrapMode="none" truncate>
              {full()!.warning}
            </text>
          )}
          <For each={full()!.rows}>
            {(row: Row) => (
              <box
                flexDirection="row"
                paddingLeft={2}
                onMouseUp={() => p.open(row.id)}
              >
                <text
                  width={LABEL_WIDTH}
                  flexShrink={0}
                  fg={color("muted")}
                  wrapMode="none"
                >
                  {row.label}
                </text>
                <text
                  flexGrow={1}
                  flexShrink={1}
                  fg={color(row.tone)}
                  wrapMode="none"
                  truncate
                >
                  {row.value}
                </text>
                <text flexShrink={0} fg={color("muted")} wrapMode="none">
                  {" ▾"}
                </text>
              </box>
            )}
          </For>
        </box>
      )}
      {compact() && (
        <box flexShrink={0} paddingBottom={1} onMouseUp={() => p.openMenu()}>
          <text wrapMode="none" truncate fg={color("normal")}>
            <For each={compact()!.parts}>
              {(part: Part) => (
                <span style={{ fg: color(part.tone) }}>{part.text}</span>
              )}
            </For>
          </text>
        </box>
      )}
    </>
  )
}

export const sidebar: SidebarView = (p) => <Block {...p} />
