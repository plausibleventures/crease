import type { InputImage } from "@/lib/api"

const MAX_DIM = 1568 // Claude's recommended max edge; larger images are downscaled anyway
const OK_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader()
    r.onload = () => res(String(r.result))
    r.onerror = () => rej(r.error)
    r.readAsDataURL(file)
  })
}

/** File -> base64 image block payload; downscales big images and converts unsupported types to PNG. */
export async function fileToInputImage(file: File): Promise<InputImage> {
  if (!file.type.startsWith("image/")) throw new Error(`${file.name || "file"} is not an image`)
  const url = await readAsDataUrl(file)
  const img = new Image()
  await new Promise<void>((res, rej) => {
    img.onload = () => res()
    img.onerror = () => rej(new Error("could not decode image"))
    img.src = url
  })
  const scale = Math.min(1, MAX_DIM / Math.max(img.naturalWidth, img.naturalHeight))
  if (scale === 1 && OK_TYPES.has(file.type) && file.type !== "image/gif") {
    return { mediaType: file.type as InputImage["mediaType"], data: url.slice(url.indexOf(",") + 1) }
  }
  const canvas = document.createElement("canvas")
  canvas.width = Math.round(img.naturalWidth * scale)
  canvas.height = Math.round(img.naturalHeight * scale)
  canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height)
  const type = file.type === "image/jpeg" ? "image/jpeg" : "image/png"
  const out = canvas.toDataURL(type, 0.9)
  return { mediaType: type, data: out.slice(out.indexOf(",") + 1) }
}

export const inputImageSrc = (i: InputImage) => `data:${i.mediaType};base64,${i.data}`
