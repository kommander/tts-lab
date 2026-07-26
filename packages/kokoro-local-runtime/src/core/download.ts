import { createHash } from "node:crypto"
import { createReadStream, createWriteStream } from "node:fs"
import { mkdir, rename, rm, stat } from "node:fs/promises"
import { dirname } from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"

export interface Asset {
  path: string
  url: string
  size: number
  sha256?: string
}

export interface DownloadProgress<T extends Asset = Asset> {
  asset: T
  assetBytes: number
  completedBytes: number
  totalBytes: number
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

async function sha256(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(path)) {
    signal?.throwIfAborted()
    hash.update(chunk)
  }
  return hash.digest("hex")
}

export async function downloadAssets<T extends Asset>(
  assets: readonly T[],
  root: string,
  onProgress: (progress: DownloadProgress<T>) => void,
  signal?: AbortSignal,
): Promise<void> {
  const totalBytes = assets.reduce((sum, asset) => sum + asset.size, 0)
  let completedBytes = 0

  for (const asset of assets) {
    signal?.throwIfAborted()
    const destination = `${root}/${asset.path}`
    const partial = `${destination}.part`
    await mkdir(dirname(destination), { recursive: true })

    let completeSize = await fileSize(destination)
    if (completeSize === asset.size) {
      if (!asset.sha256 || (await sha256(destination, signal)) === asset.sha256) {
        completedBytes += asset.size
        onProgress({ asset, assetBytes: asset.size, completedBytes, totalBytes })
        continue
      }
      await rm(destination, { force: true })
      completeSize = 0
    }
    if (completeSize > 0) await rm(destination, { force: true })

    let offset = await fileSize(partial)
    if (offset > asset.size) {
      await rm(partial, { force: true })
      offset = 0
    }

    if (offset === asset.size) {
      if (!asset.sha256 || (await sha256(partial, signal)) === asset.sha256) {
        signal?.throwIfAborted()
        await rename(partial, destination)
        completedBytes += asset.size
        onProgress({ asset, assetBytes: asset.size, completedBytes, totalBytes })
        continue
      }
      await rm(partial, { force: true })
      offset = 0
    }

    const headers = offset ? { Range: `bytes=${offset}-` } : undefined
    let response = await fetch(asset.url, { headers, signal })
    if (offset && response.status !== 206) {
      await rm(partial, { force: true })
      offset = 0
      response = await fetch(asset.url, { signal })
    }
    if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}): ${asset.path}`)

    let current = offset
    const meter = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        current += chunk.byteLength
        onProgress({
          asset,
          assetBytes: current,
          completedBytes: completedBytes + current,
          totalBytes,
        })
        controller.enqueue(chunk)
      },
    })
    const body = response.body.pipeThrough(meter)
    await pipeline(Readable.fromWeb(body as never), createWriteStream(partial, { flags: offset ? "a" : "w" }))

    if ((await fileSize(partial)) !== asset.size) throw new Error(`Size check failed for ${asset.path}`)
    if (asset.sha256 && (await sha256(partial, signal)) !== asset.sha256) {
      await rm(partial, { force: true })
      throw new Error(`SHA-256 check failed for ${asset.path}`)
    }
    signal?.throwIfAborted()
    await rename(partial, destination)
    completedBytes += asset.size
    onProgress({ asset, assetBytes: asset.size, completedBytes, totalBytes })
  }
}
