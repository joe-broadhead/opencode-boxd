/**
 * A stored transcript's own marks, read by streaming the file: its session id, its parent, `info.time.updated`, the
 * message count and the last message's id. These are what drop compares with the guest (design §3.9). The file is
 * scanned in chunks and never parsed whole, so a large
 * transcript never sits on the server's thread (design §4.3, F8).
 */
import { createReadStream } from "node:fs"
import { boxdError } from "../errors.js"

export interface TranscriptMarks {
  readonly id: string
  readonly parentId: string | null
  readonly updated: number
  readonly messages: number
  readonly lastMessageId: string | null
}

interface Frame {
  readonly kind: "obj" | "arr"
  key: string | null
  expectKey: boolean
}

/** The longest string the scanner keeps; ids are far shorter, and longer strings are only skipped. */
const KEEP = 256

export async function readMarks(path: string): Promise<TranscriptMarks> {
  const frames: Frame[] = []
  let infoId: string | null = null
  let parentId: string | null = null
  let updated = 0
  let count = 0
  let current: { id: string | null; infoId: string | null } | null = null
  let last: { id: string | null; infoId: string | null } | null = null
  let sawMessages = false
  let done = false

  // Token state across chunks.
  let inString = false
  let escape = false
  let text = ""
  let textLong = false
  let literal = ""

  const inMessages = () => frames.length === 2 && frames[0]!.key === "messages" && frames[1]!.kind === "arr"
  const elementStarts = () => {
    if (inMessages()) {
      count += 1
      if (current) last = current
      current = { id: null, infoId: null }
    }
  }
  const primitive = (value: string | number | boolean | null) => {
    const top = frames[frames.length - 1]
    if (!top) return
    const depth = frames.length
    if (top.kind === "arr") elementStarts()
    const key = top.key
    if (depth === 2 && frames[0]!.key === "info" && top.kind === "obj") {
      if (key === "id" && typeof value === "string") infoId = value
      if (key === "parentID" && typeof value === "string") parentId = value
    }
    if (depth === 3 && frames[0]!.key === "info" && frames[1]!.key === "time" && key === "updated" && typeof value === "number") updated = value
    if (depth === 3 && frames[0]!.key === "messages" && top.kind === "obj" && key === "id" && typeof value === "string" && current) current.id = value
    if (depth === 4 && frames[0]!.key === "messages" && frames[2]!.key === "info" && key === "id" && typeof value === "string" && current) current.infoId = value
    if (top.kind === "obj") top.expectKey = false
  }
  const flushLiteral = () => {
    if (!literal) return
    const word = literal
    literal = ""
    if (word === "true") primitive(true)
    else if (word === "false") primitive(false)
    else if (word === "null") primitive(null)
    else {
      const number = Number(word)
      if (!Number.isFinite(number)) invalid(path)
      primitive(number)
    }
  }
  const open = (kind: Frame["kind"]) => {
    const top = frames[frames.length - 1]
    if (top?.kind === "arr") elementStarts()
    if (top?.kind === "obj") top.expectKey = false
    if (frames.length === 1 && top?.key === "messages" && kind === "arr") sawMessages = true
    frames.push({ kind, key: null, expectKey: kind === "obj" })
  }

  for await (const chunk of createReadStream(path, { encoding: "utf8", highWaterMark: 256 * 1024 })) {
    const body = chunk as string
    for (let index = 0; index < body.length; index++) {
      const char = body[index]!
      if (inString) {
        if (escape) {
          escape = false
          if (!textLong) text += char === "n" ? "\n" : char
        } else if (char === "\\") escape = true
        else if (char === '"') {
          inString = false
          const top = frames[frames.length - 1]
          const value = textLong ? "" : text
          if (top?.kind === "obj" && top.expectKey) {
            top.key = value
            top.expectKey = false
          } else primitive(value)
        } else if (!textLong) {
          text += char
          if (text.length > KEEP) {
            textLong = true
            text = ""
          }
        }
        continue
      }
      if (done) {
        if (!/\s/.test(char)) invalid(path)
        continue
      }
      switch (char) {
        case '"':
          flushLiteral()
          inString = true
          text = ""
          textLong = false
          break
        case "{":
          flushLiteral()
          open("obj")
          break
        case "[":
          flushLiteral()
          open("arr")
          break
        case "}":
        case "]": {
          flushLiteral()
          const frame = frames.pop()
          if (!frame || (char === "}") !== (frame.kind === "obj")) invalid(path)
          if (frames.length === 1 && frames[0]!.key === "messages" && current) {
            last = current
            current = null
          }
          if (frames.length === 0) done = true
          break
        }
        case ",": {
          flushLiteral()
          const top = frames[frames.length - 1]
          if (top?.kind === "obj") top.expectKey = true
          break
        }
        case ":":
          flushLiteral()
          break
        default:
          if (/\s/.test(char)) flushLiteral()
          else literal += char
      }
    }
  }
  // The closures above assign these; TypeScript cannot see that, so they are read back through their declared types.
  const id = infoId as string | null
  const final = last as { id: string | null; infoId: string | null } | null
  if (!done || inString || id === null || !sawMessages) return invalid(path)
  return { id, parentId: parentId as string | null, updated: updated as number, messages: count, lastMessageId: final ? (final.id ?? final.infoId) : null }
}

const invalid = (path: string): never => {
  throw boxdError("EXPORT_INVALID", `The stored transcript ${path.split("/").pop()} is not an OpenCode export with info and messages.`)
}
