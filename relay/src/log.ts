/** One JSON line per event on stdout. Only primitives go in: never a header, a body or a URL. */
type Field = string | number | boolean | undefined

let sink: (line: string) => void = (l) => void process.stdout.write(l + "\n")

export function setSink(fn: (line: string) => void): void {
  sink = fn
}

export function log(event: string, fields: Record<string, Field> = {}): void {
  sink(JSON.stringify({ t: new Date().toISOString(), event, ...fields }))
}
