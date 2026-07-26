import type { Asset } from "tts-runtime-core"

export const KOKORO_REVISION = "f3ff3571791e39611d31c381e3a41a3af07b4987" as const
export const KOKORO_SETUP_VERSION = "kokoro-0.9.4-v2" as const
export const KOKORO_DEFAULT_VOICE_ID = "af_heart" as const
export const KOKORO_DEFAULT_RUNTIME_ID = "python-pytorch-fp32" as const

export const KOKORO_RUNTIME_IDS = [
  "python-pytorch-fp32",
  "javascript-onnx-q8",
  "javascript-onnx-fp32",
  "javascript-webgpu-fp32",
  "native-coreml-ane",
] as const

export type KokoroRuntimeId = (typeof KOKORO_RUNTIME_IDS)[number]
export type KokoroRuntimeKind = "python" | "javascript" | "native"
export type KokoroVoiceId = (typeof voiceData)[number][0]

export interface KokoroVoiceDefinition {
  id: KokoroVoiceId
  name: string
  description: string
  assets?: Asset[]
}

export interface KokoroRuntimeDescriptor {
  id: KokoroRuntimeId
  name: string
  description: string
  kind: KokoroRuntimeKind
  dtype?: "q8" | "fp32"
  device?: "cpu" | "webgpu"
  lowMemory?: boolean
  modelBytes?: number
  modelFile?: string
  voiceIds?: readonly KokoroVoiceId[]
  nativeBackend?: "kokoro"
}

const hf = (path: string) =>
  `https://huggingface.co/hexgrad/Kokoro-82M/resolve/${KOKORO_REVISION}/${path}?download=true`

const voiceData = [
  ["af_alloy", 523425, "6d877149dd8b348fbad12e5845b7e43d975390e9f3b68a811d1d86168bef5aa3"],
  ["af_aoede", 523425, "c03bd1a4c3716c2d8eaa3d50022f62d5c31cfbd6e15933a00b17fefe13841cc4"],
  ["af_bella", 523425, "8cb64e02fcc8de0327a8e13817e49c76c945ecf0052ceac97d3081480e8e48d6"],
  ["af_heart", 523425, "0ab5709b8ffab19bfd849cd11d98f75b60af7733253ad0d67b12382a102cb4ff"],
  ["af_jessica", 523435, "cdfdccb8cc975aa34ee6b89642963b0064237675de0e41a30ae64cc958dd4e87"],
  ["af_kore", 523420, "8bfbc512321c3db49dff984ac675fa5ac7eaed5a96cc31104d3a9080e179d69d"],
  ["af_nicole", 523430, "c5561808bcf5250fe8c5f5de32caf2d94f27e57e95befdb098c5c85991d4c5da"],
  ["af_nova", 523420, "e0233676ddc21908c37a1f102f6b88a59e4e5c1bd764983616eb9eda629dbcd2"],
  ["af_river", 523425, "e149459bd9c084416b74756b9bd3418256a8b839088abb07d463730c369dab8f"],
  ["af_sarah", 523425, "49bd364ea3be9eb3e9685e8f9a15448c4883112a7c0ff7ab139fa4088b08cef9"],
  ["af_sky", 523351, "c799548aed06e0cb0d655a85a01b48e7f10484d71663f9a3045a5b9362e8512c"],
  ["am_adam", 523420, "ced7e284aba12472891be1da3ab34db84cc05cc02b5889535796dbf2d8b0cb34"],
  ["am_echo", 523420, "8bcfdc852bc985fb45c396c561e571ffb9183930071f962f1b50df5c97b161e8"],
  ["am_eric", 523420, "ada66f0eefff34ec921b1d7474d7ac8bec00cd863c170f1c534916e9b8212aae"],
  ["am_fenrir", 523430, "98e507eca1db08230ae3b6232d59c10aec9630022d19accac4f5d12fcec3c37a"],
  ["am_liam", 523420, "c82550757ddb31308b97f30040dda8c2d609a9e2de6135848d0a948368138518"],
  ["am_michael", 523435, "9a443b79a4b22489a5b0ab7c651a0bcd1a30bef675c28333f06971abbd47bd37"],
  ["am_onyx", 523420, "e8452be16cd0f6da7b4579eaf7b1e4506e92524882053d86d72b96b9a7fed584"],
  ["am_puck", 523420, "dd1d8973f4ce4b7d8ae407c77a435f485dabc052081b80ea75c4f30b84f36223"],
  ["am_santa", 523425, "7f2f7582fa2b1f160e90aafe6d0b442a685e773608b6667e545d743b073e97a7"],
  ["bf_alice", 523425, "d292651b6af6c0d81705c2580dcb4463fccc0ff7b8d618a471dbb4e45655b3f3"],
  ["bf_emma", 523420, "d0a423deabf4a52b4f49318c51742c54e21bb89bbbe9a12141e7758ddb5da701"],
  ["bf_isabella", 523440, "cdd4c37003805104d1d08fb1e05855c8fb2c68de24ca6e71f264a30aaa59eefd"],
  ["bf_lily", 523420, "6e09c2e481e2d53004d7e5ae7d3a325369e130a6f45c35a6002de75084be9285"],
  ["bm_daniel", 523430, "fc3fce4e9c12ed4dbc8fa9680cfe51ee190a96444ce7c3ad647549a30823fc5d"],
  ["bm_fable", 523425, "d44935f3135257a9064df99f007fc1342ff1aa767552b4a4fa4c3b2e6e59079c"],
  ["bm_george", 523430, "f1bc812213dc59774769e5c80004b13eeb79bd78130b11b2d7f934542dab811b"],
  ["bm_lewis", 523425, "b5204750dcba01029d2ac9cec17aec3b20a6d64073c579d694a23cb40effbd0e"],
] as const

export const KOKORO_VOICE_IDS = voiceData.map(([id]) => id)

export const KOKORO_VOICES: KokoroVoiceDefinition[] = voiceData.map(([id, size, sha256]) => {
  const british = id.startsWith("b")
  const feminine = id[1] === "f"
  const display = id.slice(3).replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase())
  return {
    id,
    name: `${display} (${british ? "UK" : "US"})`,
    description: `${british ? "British" : "American"} English, ${feminine ? "feminine" : "masculine"}`,
    assets: id === KOKORO_DEFAULT_VOICE_ID
      ? undefined
      : [{ path: `voices/${id}.pt`, url: hf(`voices/${id}.pt`), size, sha256 }],
  }
})

export const KOKORO_ASSETS: Asset[] = [
  { path: "config.json", url: hf("config.json"), size: 2351 },
  {
    path: "kokoro-v1_0.pth",
    url: hf("kokoro-v1_0.pth"),
    size: 327212226,
    sha256: "496dba118d1a58f5f3db2efc88dbdc216e0483fc89fe6e47ee1f2c53f18ad1e4",
  },
  {
    path: "voices/af_heart.pt",
    url: hf("voices/af_heart.pt"),
    size: 523425,
    sha256: "0ab5709b8ffab19bfd849cd11d98f75b60af7733253ad0d67b12382a102cb4ff",
  },
]

export const KOKORO_RUNTIMES: KokoroRuntimeDescriptor[] = [
  {
    id: "python-pytorch-fp32",
    name: "Python / PyTorch FP32",
    description: "Current Kokoro 0.9.4 pipeline; best parity with the reference implementation",
    kind: "python",
  },
  {
    id: "javascript-onnx-q8",
    name: "JavaScript / ONNX Q8 Compact",
    description: "92.4 MB low-download ONNX model; trades speed for a smaller footprint",
    kind: "javascript",
    dtype: "q8",
    device: "cpu",
    modelBytes: 92361116,
    modelFile: "onnx/model_quantized.onnx",
  },
  {
    id: "javascript-onnx-fp32",
    name: "JavaScript / ONNX FP32",
    description: "325.5 MB full-precision ONNX model; no Python runtime",
    kind: "javascript",
    dtype: "fp32",
    device: "cpu",
    lowMemory: true,
    modelBytes: 325532232,
    modelFile: "onnx/model.onnx",
  },
  {
    id: "javascript-webgpu-fp32",
    name: "JavaScript / WebGPU FP32",
    description: "Experimental native WebGPU execution through Transformers.js 4",
    kind: "javascript",
    dtype: "fp32",
    device: "webgpu",
    modelBytes: 325532232,
    modelFile: "onnx/model.onnx",
  },
  {
    id: "native-coreml-ane",
    name: "Native / CoreML ANE",
    description: "Experimental Apple Silicon backend; macOS 14+ and Heart voice only",
    kind: "native",
    nativeBackend: "kokoro",
    voiceIds: [KOKORO_DEFAULT_VOICE_ID],
  },
]

export const KOKORO_MODEL = {
  id: "kokoro" as const,
  name: "Kokoro",
  tagline: "Small, modern all-rounder",
  footprint: "82M parameters · ~328 MB weights",
  license: "Apache-2.0",
  python: "3.11",
  packages: ["kokoro==0.9.4", "soundfile"],
  postInstall: [["-m", "spacy", "download", "en_core_web_sm"]],
  assets: KOKORO_ASSETS,
  voices: KOKORO_VOICES,
  defaultVoiceId: KOKORO_DEFAULT_VOICE_ID,
  runtimes: KOKORO_RUNTIMES,
  defaultRuntimeId: KOKORO_DEFAULT_RUNTIME_ID,
  setupVersion: KOKORO_SETUP_VERSION,
  note: "The published package supports Python 3.10-3.12.",
}
