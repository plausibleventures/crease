// Minimal ZIP writer/reader for build packs (no dependency): deflate or store, no ZIP64, no encryption.
// The reader treats the archive as untrusted: entry names are validated (no absolute paths, "..", backslashes, drive
// letters or control characters), sizes and counts are capped, and every entry is read through the central directory.
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib"

export interface ZipEntry {
  path: string
  data: Buffer
}

const DOS_EPOCH = (d: Date) => {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2)
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  return { time, date }
}

/** Build a zip of the given files (in order). Text-like files are deflated; already-compressed ones are stored. */
export function writeZip(entries: ZipEntry[], when = new Date()): Buffer {
  const { time, date } = DOS_EPOCH(when)
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(assertSafeName(e.path), "utf8")
    const crc = crc32(e.data) >>> 0
    const deflated = /\.(png|jpe?g|zip|3mf|gz)$/i.test(e.path) ? null : deflateRawSync(e.data, { level: 9 })
    const useDeflate = deflated !== null && deflated.length < e.data.length
    const body = useDeflate ? deflated! : e.data
    if (offset + body.length > 0xfffffff0 || e.data.length > 0xfffffff0) throw new Error("build pack too large (over 4 GB)")
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0x0800, 6) // UTF-8 names
    local.writeUInt16LE(useDeflate ? 8 : 0, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(e.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(0x031e, 4) // made by: unix, 3.0
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(useDeflate ? 8 : 0, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(e.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38) // regular file, rw-r--r--
    central.writeUInt32LE(offset, 42)
    locals.push(local, name, body)
    centrals.push(central, name)
    offset += local.length + name.length + body.length
  }
  const cd = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, end])
}

export class ZipError extends Error {}

/** A relative, forward-slash path with no "..", no leading "/", no drive letter and no control characters. */
export function assertSafeName(name: string): string {
  if (
    !name ||
    name.length > 400 ||
    name.startsWith("/") ||
    name.includes("\\") ||
    /^[A-Za-z]:/.test(name) ||
    [...name].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f) ||
    name.split("/").some((seg) => seg === ".." || seg === "." || seg === "")
  )
    throw new ZipError(`unsafe path in pack: ${JSON.stringify(name.slice(0, 80))}`)
  return name
}

export interface ReadZipLimits {
  maxEntries?: number
  maxTotalBytes?: number // uncompressed
  maxEntryBytes?: number
}

/** Read every file entry (directories skipped). Throws ZipError for anything malformed or unsafe. */
export function readZip(buf: Buffer, limits: ReadZipLimits = {}): ZipEntry[] {
  const maxEntries = limits.maxEntries ?? 5000
  const maxTotal = limits.maxTotalBytes ?? 1024 * 1024 * 1024
  const maxEntry = limits.maxEntryBytes ?? 512 * 1024 * 1024
  // End of central directory: last 22..(22+65535) bytes.
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new ZipError("not a zip file")
  const count = buf.readUInt16LE(eocd + 10)
  const cdSize = buf.readUInt32LE(eocd + 12)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  if (count > maxEntries) throw new ZipError(`too many files in pack (${count})`)
  if (cdOffset + cdSize > eocd) throw new ZipError("zip central directory is damaged")
  const out: ZipEntry[] = []
  const seen = new Set<string>()
  let total = 0
  let p = cdOffset
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new ZipError("zip central directory is damaged")
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const crc = buf.readUInt32LE(p + 16)
    const csize = buf.readUInt32LE(p + 20)
    const usize = buf.readUInt32LE(p + 24)
    const nlen = buf.readUInt16LE(p + 28)
    const xlen = buf.readUInt16LE(p + 30)
    const clen = buf.readUInt16LE(p + 32)
    const attrs = buf.readUInt32LE(p + 38)
    const lho = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nlen).toString("utf8")
    p += 46 + nlen + xlen + clen
    if (name.endsWith("/")) continue // directory
    if (flags & 0x1) throw new ZipError("encrypted packs are not supported")
    const mode = (attrs >>> 16) & 0o170000
    if (mode === 0o120000) throw new ZipError(`links are not allowed in packs: ${name}`)
    assertSafeName(name)
    if (seen.has(name.toLowerCase())) throw new ZipError(`duplicate file in pack: ${name}`)
    seen.add(name.toLowerCase())
    if (usize > maxEntry) throw new ZipError(`file too large in pack: ${name}`)
    total += usize
    if (total > maxTotal) throw new ZipError("pack is too large when unpacked")
    if (lho + 30 > buf.length || buf.readUInt32LE(lho) !== 0x04034b50) throw new ZipError(`zip entry is damaged: ${name}`)
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28)
    if (start + csize > buf.length) throw new ZipError(`zip entry is truncated: ${name}`)
    const raw = buf.subarray(start, start + csize)
    let data: Buffer
    if (method === 0) data = Buffer.from(raw)
    else if (method === 8) {
      try {
        data = inflateRawSync(raw, { maxOutputLength: Math.max(usize, 1) })
      } catch {
        throw new ZipError(`zip entry is damaged: ${name}`)
      }
    } else throw new ZipError(`unsupported compression in pack: ${name}`)
    if (data.length !== usize || (crc32(data) >>> 0) !== crc) throw new ZipError(`zip entry is damaged: ${name}`)
    out.push({ path: name, data })
  }
  return out
}
