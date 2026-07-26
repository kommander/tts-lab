import type { Asset } from "kokoro-local-runtime/core"
import { KOKORO_MODEL } from "kokoro-local-runtime"
import type { ModelId } from "./types.js"

export type ModelAsset = Asset

export interface VoiceDefinition {
  id: string
  name: string
  description: string
  assets?: ModelAsset[]
}

export interface RuntimeProfile {
  id: string
  name: string
  description: string
  kind: "python" | "javascript" | "native"
  dtype?: "q8" | "fp32"
  device?: "cpu" | "webgpu"
  lowMemory?: boolean
  modelBytes?: number
  modelFile?: string
  voiceIds?: readonly string[]
  nativeBackend?: "kokoro" | "pocket"
  assets?: readonly ModelAsset[]
  darwinArch?: "arm64"
  minimumDarwinMajor?: number
}

export interface ModelDefinition {
  id: ModelId
  name: string
  tagline: string
  footprint: string
  license: string
  python?: string
  packages?: string[]
  packagesNoDeps?: string[]
  noBuildIsolation?: boolean
  postInstall?: string[][]
  assets: ModelAsset[]
  voices: VoiceDefinition[]
  defaultVoiceId: string
  runtimes: RuntimeProfile[]
  defaultRuntimeId: string
  setupVersion: string
  note: string
  requiresFfmpeg?: boolean
}

const hf = (repo: string, revision: string, path: string) =>
  `https://huggingface.co/${repo}/resolve/${revision}/${path}?download=true`

const PIPER_REVISION = "v1.0.0"
const MELO_REVISION = "bb4fb7346d566d277ba8c8c7dbfdf6786139b8ef"
const PARLER_REVISION = "fbb2dd281092c5b414ef29cf9d8895f386f1feef"
const FLAN_REVISION = "0613663d0d48ea86ba8cb3d7a44f0f65dc596a2a"
const F5_REVISION = "84e5a410d9cead4de2f847e7c9369a6440bdfaca"
const VOCOS_REVISION = "0feb3fdd929bcd6649e0e7c5a688cf7dd012ef21"
const BERT_REVISION = "86b5e0934494bd15c9632b12f734a8a67f723594"
const KITTEN_CODE_REVISION = "9f3e0d8b6600b56ebe1b4d7b6d8e1e020077d1f2"
const KITTEN_MODEL_REVISION = "84781d74e29ee25217551556398b42f80593a813"
const POCKET_COREML_REVISION = "1bd207828251accf30f09a965c84856cd874e9f4"

const parlerSpeakerNames = [
  "Jon", "Lea", "Gary", "Jenna", "Mike", "Laura", "Lauren", "Eileen", "Alisa", "Karen", "Barbara",
  "Carol", "Emily", "Rose", "Will", "Patrick", "Eric", "Rick", "Anna", "Tina", "Brenda", "David",
  "Jordan", "Yann", "Joy", "James", "Jason", "Aaron", "Naomie", "Jerry", "Bill", "Tom", "Rebecca", "Bruce",
]

const parlerVoices: VoiceDefinition[] = parlerSpeakerNames.map((name, index) => ({
  id: name,
  name,
  description: index < 20 ? "Official Mini similarity-ranked speaker" : "Official trained speaker",
}))

const pocketAssetData: Array<[string, number, string]> = [
  ["v2.1/english/cond_prefill_ane.mlmodelc/coremldata.bin", 1388, "39d79bbbf366dca5fb7339c461952d79484e12da2b3642e45881afd4ddf82e7b"],
  ["v2.1/english/cond_prefill_ane.mlmodelc/model.mil", 136093, "6013f10e803c50b3819610edc218662b9ad768d3f1c86a20ec37230c3c49a553"],
  ["v2.1/english/cond_prefill_ane.mlmodelc/weights/weight.bin", 132187392, "b8bbefa5799ee581561d7a28a21a42f9ea9b7e73ca7bc1339330ea4cff24806d"],
  ["v2.1/english/flowlm_step_ane.mlmodelc/coremldata.bin", 1414, "18e49a8e73db70da25caddcaac36bc77245d6bea30754a23df3b10c27fa4de73"],
  ["v2.1/english/flowlm_step_ane.mlmodelc/model.mil", 156945, "6880224e71de99e394323ec706fbbe28af9fb2b5eb8d8698d43ecaec33a6ff38"],
  ["v2.1/english/flowlm_step_ane.mlmodelc/weights/weight.bin", 151136960, "fdd40be8edecea51035dfa91beada8e74de2634eab266b85f329bf85b344d271"],
  ["v2.1/english/flow_decoder_fused.mlmodelc/coremldata.bin", 413, "69ff9affa07e38b1a511ac8d71c594eeeb236389ddbe74f4fabdfa45db4edf7a"],
  ["v2.1/english/flow_decoder_fused.mlmodelc/model.mil", 333331, "0257898b9a6ce06c961959aae993bb27c558f509fbea7407d094b879f872ec3f"],
  ["v2.1/english/flow_decoder_fused.mlmodelc/weights/weight.bin", 19012608, "f28a1bd0af940a195802e9d702c9e050f3e69d265e582f3d0fdf4001709eb30c"],
  ["v2.1/english/mimi_decoder.mlmodelc/coremldata.bin", 1777, "9d8644e2caad1513153ac28f1ba8090fcd2facdbd5d2621bf8016186fa932bf8"],
  ["v2.1/english/mimi_decoder.mlmodelc/model.mil", 107403, "f7176b3b3d800de308ac01cb83d1f3e9b555e70b44d299efd4a21c9c27eecc16"],
  ["v2.1/english/mimi_decoder.mlmodelc/weights/weight.bin", 41768256, "c93d182f9ad8c1042ec8302093aabb4e310d76616932dd12720e03b5d07f7c64"],
  ["v2.1/english/constants_bin/alba.safetensors", 6194424, "69c32db63ca56843d994f81f343f62e0bf2d73f7e4c9bc73e44bb1110b1d8845"],
  ["v2.1/english/constants_bin/bos_before_voice.bin", 4096, "6ac530a104e3f3d2b2ff15f3fad63540f2619b31db78b159c0595a108f142caf"],
  ["v2.1/english/constants_bin/bos_emb.bin", 128, "52f1a157fa35fc100213e6e0fafa74703be99db8faa42de3e99feda607ac7b63"],
  ["v2.1/english/constants_bin/text_embed_table.bin", 16388096, "2512f9edd82ab0c68bb42a5fcd329a371eaf63ee6fb5275dfb1bc9536592bb0e"],
  ["v2.1/english/constants_bin/tokenizer.model", 59339, "d461765ae179566678c93091c5fa6f2984c31bbe990bf1aa62d92c64d91bc3f6"],
]

const pocketAsset = (path: string, size: number, sha256: string): ModelAsset => ({
  path: `Models/pocket-tts/${path}`,
  url: hf("FluidInference/pocket-tts-coreml", POCKET_COREML_REVISION, path),
  size,
  sha256,
})

const pocketAssets = pocketAssetData.map(([path, size, sha256]) => pocketAsset(path, size, sha256))

const pocketVoiceData: Array<[string, string, string, number, string]> = [
  ["alba", "Alba", "English; CC BY 4.0", 6194424, "69c32db63ca56843d994f81f343f62e0bf2d73f7e4c9bc73e44bb1110b1d8845"],
  ["estelle", "Estelle", "English; CC0 Kyutai/Unmute recording", 8258808, "ccebef7f51762c7fc08870f5ecf268e8713551ae2c9f7984ddaec0c1e1c77153"],
  ["marius", "Marius", "English; CC0 voice donation", 6194424, "04f84efcb77a0547ba582c058db496f7ff4920891d49d37b9950d128422582a8"],
  ["javert", "Javert", "English; CC0 voice donation", 6194424, "0ae88e03ca4e76a0e16cbf321a807428febda9d9e9bc0358c02e7f9c9e2c263b"],
  ["bill_boerst", "Bill Boerst", "English; CC0 Voice-Zero recording", 6735096, "75610127d44e0b05b442154f80f89f993df235aecc6cad7070f11000d006c188"],
  ["caro_davy", "Caro Davy", "English; CC0 Voice-Zero recording", 5260536, "a5961b63a2e7a5cfd7edc383aa9042fb70fd14a9dee6310cdc633881a7f2449a"],
  ["peter_yearsley", "Peter Yearsley", "English; CC0 Voice-Zero recording", 3736816, "dd977a6e15591e347c9a23fa7cc09e35a65b462917f5eeb162baff6dc9e3f685"],
  ["stuart_bell", "Stuart Bell", "English; CC0 Voice-Zero recording", 5260536, "5a49da7ca5df05d02587ec4a0981c0d318e045f68e24423c4203ce474d9b33dc"],
]

const pocketVoices: VoiceDefinition[] = pocketVoiceData.map(([id, name, description, size, sha256]) => ({
  id,
  name,
  description,
  assets: id === "alba"
    ? undefined
    : [pocketAsset(`v2.1/english/constants_bin/${id}.safetensors`, size, sha256)],
}))

const pythonRuntime = (description: string): RuntimeProfile => ({
  id: "python-pytorch-fp32",
  name: "Python / PyTorch FP32",
  description,
  kind: "python",
})

export const MODELS: readonly ModelDefinition[] = [
  KOKORO_MODEL,
  {
    id: "kitten",
    name: "KittenTTS",
    tagline: "Tiny quantized CPU speech",
    footprint: "15M parameters · 26.4 MiB assets",
    license: "Apache-2.0 model/code; GPL-3.0+ phonemizer/eSpeak runtime",
    python: "3.12",
    packages: [
      "attrs==26.1.0",
      "babel==2.18.0",
      "cffi==2.1.0",
      "csvw==4.1.0",
      "dlinfo==2.0.0",
      "espeakng-loader==0.2.4",
      "flatbuffers==25.12.19",
      "isodate==0.7.2",
      "joblib==1.5.3",
      "jsonschema==4.26.0",
      "jsonschema-specifications==2025.9.1",
      "language-tags==1.3.1",
      "phonemizer==3.3.0",
      "onnxruntime==1.28.0",
      "soundfile==0.14.0",
      "numpy==2.5.1",
      "packaging==26.2",
      "protobuf==7.35.1",
      "pycparser==3.0",
      "pyparsing==3.3.2",
      "python-dateutil==2.9.0.post0",
      "rdflib==7.6.0",
      "referencing==0.37.0",
      "regex==2026.7.19",
      "rfc3986==1.5.0",
      "rpds-py==2026.6.3",
      "segments==2.4.0",
      "setuptools==83.0.0",
      "six==1.17.0",
      "termcolor==3.3.0",
      "typing-extensions==4.16.0",
      "uritemplate==4.2.0",
      "wheel==0.47.0",
    ],
    packagesNoDeps: [`git+https://github.com/KittenML/KittenTTS.git@${KITTEN_CODE_REVISION}`],
    noBuildIsolation: true,
    voices: [
      ["Bella", "feminine"], ["Jasper", "masculine"], ["Luna", "feminine"], ["Bruno", "masculine"],
      ["Rosie", "feminine"], ["Hugo", "masculine"], ["Kiki", "feminine"], ["Leo", "masculine"],
    ].map(([id, character]) => ({ id, name: id, description: `American English, ${character}` })),
    defaultVoiceId: "Jasper",
    runtimes: [{
      id: "python-onnx-int8",
      name: "Python / ONNX INT8",
      description: "Pinned 15M Nano model; compact CPU-only runtime",
      kind: "python",
      dtype: "q8",
      device: "cpu",
      darwinArch: "arm64",
      minimumDarwinMajor: 23,
    }],
    defaultRuntimeId: "python-onnx-int8",
    setupVersion: "kitten-9f3e0d8-nano-int8-v2",
    note: "English developer preview. Built-in voice provenance is not published separately from the model repository.",
    assets: [
      {
        path: "config.json",
        url: hf("KittenML/kitten-tts-nano-0.8-int8", KITTEN_MODEL_REVISION, "config.json"),
        size: 688,
        sha256: "b66006ccbeccd4de5fc3c9272059c47f5725df7215fd889785c03602652fab64",
      },
      {
        path: "kitten_tts_nano_v0_8.onnx",
        url: hf("KittenML/kitten-tts-nano-0.8-int8", KITTEN_MODEL_REVISION, "kitten_tts_nano_v0_8.onnx"),
        size: 24369971,
        sha256: "f7b0afcbee92870b32b8e0276d855b954dc25470c9f051b376ac7eee537c76fc",
      },
      {
        path: "voices.npz",
        url: hf("KittenML/kitten-tts-nano-0.8-int8", KITTEN_MODEL_REVISION, "voices.npz"),
        size: 3278902,
        sha256: "8aa7cee235abb0739cb51e6559685f65a4dacd95568833d05699b1633f519b3f",
      },
    ],
  },
  {
    id: "pocket",
    name: "Pocket TTS",
    tagline: "Low-latency native streaming model",
    footprint: "~100M parameters · 350.5 MiB pinned ANE assets",
    license: "Apache-2.0 runtime / CC BY 4.0 model; CC0 or CC BY voices",
    voices: pocketVoices,
    defaultVoiceId: "alba",
    runtimes: [{
      id: "native-coreml-ane-fp16",
      name: "Native / CoreML ANE FP16",
      description: "FluidAudio 0.15.5; pinned English model for Apple Silicon",
      kind: "native",
      nativeBackend: "pocket",
      assets: pocketAssets,
    }],
    defaultRuntimeId: "native-coreml-ane-fp16",
    setupVersion: "pocket-fluid-0.15.5-ane-v1",
    note: "Fixed licensed voices only. Voice cloning and mutable upstream downloads are intentionally disabled.",
    assets: [],
  },
  {
    id: "piper",
    name: "Piper",
    tagline: "Tiny and CPU-first",
    footprint: "~63 MB voice",
    license: "GPL-3.0+ runtime; Lessac voice is research-only",
    python: "3.12",
    packages: ["piper-tts==1.6.0"],
    voices: [
      {
        id: "en_US-lessac-medium",
        name: "Lessac",
        description: "US English medium; research-only source terms",
      },
      {
        id: "en_US-hfc_female-medium",
        name: "HFC Female",
        description: "US English medium; CC BY-NC-SA source terms",
        assets: [
          {
            path: "voices/en_US-hfc_female-medium/en_US-hfc_female-medium.onnx",
            url: hf(
              "rhasspy/piper-voices",
              PIPER_REVISION,
              "en/en_US/hfc_female/medium/en_US-hfc_female-medium.onnx",
            ),
            size: 63201294,
            sha256: "914c473788fc1fa8b63ace1cdcdb44588f4ae523d3ab37df1536616835a140b7",
          },
          {
            path: "voices/en_US-hfc_female-medium/en_US-hfc_female-medium.onnx.json",
            url: hf(
              "rhasspy/piper-voices",
              PIPER_REVISION,
              "en/en_US/hfc_female/medium/en_US-hfc_female-medium.onnx.json",
            ),
            size: 5033,
            sha256: "03f1fa0622b80463283592d97aca9f6e89aec345a5c56b7257723e0093c58b6c",
          },
        ],
      },
      {
        id: "en_US-hfc_male-medium",
        name: "HFC Male",
        description: "US English medium; CC BY-NC-SA source terms",
        assets: [
          {
            path: "voices/en_US-hfc_male-medium/en_US-hfc_male-medium.onnx",
            url: hf(
              "rhasspy/piper-voices",
              PIPER_REVISION,
              "en/en_US/hfc_male/medium/en_US-hfc_male-medium.onnx",
            ),
            size: 63201294,
            sha256: "d11e403a02bdf5a670c877b3dc56e0e1c8cece6fb30289586314dffdc0a78cb0",
          },
          {
            path: "voices/en_US-hfc_male-medium/en_US-hfc_male-medium.onnx.json",
            url: hf(
              "rhasspy/piper-voices",
              PIPER_REVISION,
              "en/en_US/hfc_male/medium/en_US-hfc_male-medium.onnx.json",
            ),
            size: 5033,
            sha256: "f66847424aed0bf99ecbb5d7cfde47c0a906f426a0daf7c46f305e7d21afd886",
          },
        ],
      },
    ],
    defaultVoiceId: "en_US-lessac-medium",
    runtimes: [pythonRuntime("Piper 1.6.0 native ONNX wheel")],
    defaultRuntimeId: "python-pytorch-fp32",
    setupVersion: "piper-1.6.0-v2",
    note: "Uses the current Open Home Foundation successor, not the archived runtime.",
    assets: [
      {
        path: "en_US-lessac-medium.onnx",
        url: hf(
          "rhasspy/piper-voices",
          PIPER_REVISION,
          "en/en_US/lessac/medium/en_US-lessac-medium.onnx",
        ),
        size: 63201294,
        sha256: "5efe09e69902187827af646e1a6e9d269dee769f9877d17b16b1b46eeaaf019f",
      },
      {
        path: "en_US-lessac-medium.onnx.json",
        url: hf(
          "rhasspy/piper-voices",
          PIPER_REVISION,
          "en/en_US/lessac/medium/en_US-lessac-medium.onnx.json",
        ),
        size: 4885,
      },
    ],
  },
  {
    id: "melo",
    name: "MeloTTS",
    tagline: "Multilingual and multi-accent",
    footprint: "~208 MB voice + BERT",
    license: "MIT",
    python: "3.9",
    packages: [
      "setuptools==80.9.0",
      "torch==2.5.1",
      "torchaudio==2.5.1",
      "git+https://github.com/myshell-ai/MeloTTS.git@209145371cff8fc3bd60d7be902ea69cbdb7965a",
    ],
    postInstall: [
      [
        "-m",
        "nltk.downloader",
        "averaged_perceptron_tagger",
        "averaged_perceptron_tagger_eng",
        "cmudict",
      ],
    ],
    voices: [
      { id: "EN-US", name: "American", description: "American English" },
      { id: "EN-BR", name: "British", description: "British English" },
      { id: "EN_INDIA", name: "Indian", description: "Indian English" },
      { id: "EN-AU", name: "Australian", description: "Australian English" },
      { id: "EN-Default", name: "Default", description: "Default English accent" },
    ],
    defaultVoiceId: "EN-US",
    runtimes: [pythonRuntime("MeloTTS 0.1.2 with the pinned English checkpoint")],
    defaultRuntimeId: "python-pytorch-fp32",
    setupVersion: "melotts-2091453-v5",
    note: "Officially documented on Python 3.9. The acoustic model runs on CPU; BERT may use MPS on macOS.",
    assets: [
      {
        path: "config.json",
        url: hf("myshell-ai/MeloTTS-English", MELO_REVISION, "config.json"),
        size: 3488,
      },
      {
        path: "checkpoint.pth",
        url: hf("myshell-ai/MeloTTS-English", MELO_REVISION, "checkpoint.pth"),
        size: 207860748,
        sha256: "acd278040eaf9536908e2b965273df5a731c44d8f0da66cc5fed7972772ed23c",
      },
      ...[
        ["config.json", 570],
        ["tokenizer.json", 466062],
        ["tokenizer_config.json", 48],
        ["vocab.txt", 231508],
      ].map(([path, size]) => ({
        path: `bert-base-uncased/${path}`,
        url: hf("google-bert/bert-base-uncased", BERT_REVISION, String(path)),
        size: Number(size),
      })),
      {
        path: "bert-base-uncased/pytorch_model.bin",
        url: hf("google-bert/bert-base-uncased", BERT_REVISION, "pytorch_model.bin"),
        size: 440473133,
        sha256: "097417381d6c7230bd9e3557456d726de6e83245ec8b24f529f60198a67b203a",
      },
    ],
  },
  {
    id: "parler",
    name: "Parler-TTS",
    tagline: "Promptable voice direction",
    footprint: "~3.76 GB weights",
    license: "Apache-2.0",
    python: "3.11",
    packages: [
      "soundfile",
      "huggingface-hub==0.36.2",
      "transformers==4.46.1",
      "torch==2.5.1",
      "torchaudio==2.5.1",
      "numpy==1.26.4",
      "sentencepiece",
      "descript-audio-codec",
      "protobuf>=4.0.0",
      "descript-audiotools @ git+https://github.com/descriptinc/audiotools.git@348ebf2034ce24e2a91a553e3171cb00c0c71678",
    ],
    packagesNoDeps: [
      "git+https://github.com/huggingface/parler-tts.git@d108732cd57788ec86bc857d99a6cabd66663d68",
    ],
    voices: parlerVoices,
    defaultVoiceId: "Jon",
    runtimes: [pythonRuntime("Parler-TTS 0.2.2 with Mini v1.1")],
    defaultRuntimeId: "python-pytorch-fp32",
    setupVersion: "parler-0.2.2-v4",
    note: "0.9B FP32 model. On Apple Silicon, generation uses MPS and DAC decoding uses CPU for compatibility.",
    assets: [
      ...[
        ["config.json", 7311],
        ["generation_config.json", 223],
        ["preprocessor_config.json", 206],
        ["special_tokens_map.json", 552],
        ["tokenizer.json", 10272460],
        ["tokenizer.model", 1795391],
        ["tokenizer_config.json", 990],
      ].map(([path, size]) => ({
        path: `model/${path}`,
        url: hf("parler-tts/parler-tts-mini-v1.1", PARLER_REVISION, String(path)),
        size: Number(size),
      })),
      {
        path: "model/model.safetensors",
        url: hf("parler-tts/parler-tts-mini-v1.1", PARLER_REVISION, "model.safetensors"),
        size: 3751321772,
        sha256: "f85ed0a4953b28f0bd9d3cec9f0e035df2936ba97646f315f54b42bf6ba6d0f9",
      },
      ...[
        ["special_tokens_map.json", 2201],
        ["spiece.model", 791656],
        ["tokenizer.json", 2424064],
        ["tokenizer_config.json", 2539],
      ].map(([path, size]) => ({
        path: `description-tokenizer/${path}`,
        url: hf("google/flan-t5-large", FLAN_REVISION, String(path)),
        size: Number(size),
      })),
    ],
  },
  {
    id: "f5",
    name: "F5-TTS",
    tagline: "Reference-conditioned high quality",
    footprint: "~1.40 GB weights",
    license: "MIT code / CC-BY-NC-4.0 weights",
    python: "3.11",
    packages: ["torch==2.8.0", "torchaudio==2.8.0", "f5-tts==1.1.22"],
    voices: [
      {
        id: "nature-demo",
        name: "Nature Demo",
        description: "Packaged F5 reference audio",
      },
    ],
    defaultVoiceId: "nature-demo",
    runtimes: [pythonRuntime("F5-TTS 1.1.22 with the v1 Base checkpoint")],
    defaultRuntimeId: "python-pytorch-fp32",
    setupVersion: "f5-tts-1.1.22-v3",
    note: "Not text-only TTS: this demo uses F5's bundled reference WAV and exact transcript.",
    requiresFfmpeg: true,
    assets: [
      {
        path: "F5TTS_v1_Base/model_1250000.safetensors",
        url: hf("SWivid/F5-TTS", F5_REVISION, "F5TTS_v1_Base/model_1250000.safetensors"),
        size: 1348435761,
        sha256: "670900fd14e6c458b95da6e9ed317cdb20dbaf7a1c02ac06a05475a9d32b6a38",
      },
      {
        path: "vocos/config.yaml",
        url: hf("charactr/vocos-mel-24khz", VOCOS_REVISION, "config.yaml"),
        size: 461,
      },
      {
        path: "vocos/pytorch_model.bin",
        url: hf("charactr/vocos-mel-24khz", VOCOS_REVISION, "pytorch_model.bin"),
        size: 54365991,
        sha256: "97ec976ad1fd67a33ab2682d29c0ac7df85234fae875aefcc5fb215681a91b2a",
      },
    ],
  },
] as const

export const MODEL_BY_ID = Object.fromEntries(MODELS.map((model) => [model.id, model])) as Record<
  ModelId,
  ModelDefinition
>
