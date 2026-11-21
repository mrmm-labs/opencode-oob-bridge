import { promisify } from "node:util"
import { deflate } from "node:zlib"

const deflateAsync = promisify(deflate)

const TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(...parts: Uint8Array[]): number {
  let c = 0xffffffff
  for (const p of parts)
    for (const b of p) c = TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, "latin1")
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(crc32(head.subarray(4), data), 0)
  return Buffer.concat([head, data, tail])
}

export type Rgb = [number, number, number]

/** An 8-bit indexed PNG: `pixels` holds one palette index a pixel, row by row. */
export async function encodePng(
  width: number,
  height: number,
  pixels: Uint8Array,
  palette: Rgb[],
): Promise<Uint8Array> {
  if (pixels.length !== width * height) throw new Error("pixel count mismatch")
  if (palette.length < 1 || palette.length > 256)
    throw new Error("palette must hold 1 to 256 colours")
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 3
  const raw = Buffer.alloc((width + 1) * height)
  for (let y = 0; y < height; y++)
    raw.set(pixels.subarray(y * width, (y + 1) * width), y * (width + 1) + 1)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("PLTE", Buffer.from(palette.flat())),
    chunk("IDAT", await deflateAsync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ])
}
