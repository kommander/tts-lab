import type { ModelId } from "./types.js"

export interface ModelAsset {
  path: string
  url: string
  size: number
  sha256?: string
}

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
  kind: "python" | "javascript"
  dtype?: "q8" | "fp32"
  modelBytes?: number
  modelFile?: string
}

export interface ModelDefinition {
  id: ModelId
  name: string
  tagline: string
  footprint: string
  license: string
  python: string
  packages: string[]
  packagesNoDeps?: string[]
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

const KOKORO_REVISION = "f3ff3571791e39611d31c381e3a41a3af07b4987"
const PIPER_REVISION = "v1.0.0"
const MELO_REVISION = "bb4fb7346d566d277ba8c8c7dbfdf6786139b8ef"
const PARLER_REVISION = "fbb2dd281092c5b414ef29cf9d8895f386f1feef"
const FLAN_REVISION = "0613663d0d48ea86ba8cb3d7a44f0f65dc596a2a"
const F5_REVISION = "84e5a410d9cead4de2f847e7c9369a6440bdfaca"
const VOCOS_REVISION = "0feb3fdd929bcd6649e0e7c5a688cf7dd012ef21"
const BERT_REVISION = "86b5e0934494bd15c9632b12f734a8a67f723594"

const kokoroVoiceData: Array<[string, number, string]> = [
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
]

const kokoroVoices: VoiceDefinition[] = kokoroVoiceData.map(([id, size, sha256]) => {
  const british = id.startsWith("b")
  const feminine = id[1] === "f"
  const display = id.slice(3).replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase())
  return {
    id,
    name: `${display} (${british ? "UK" : "US"})`,
    description: `${british ? "British" : "American"} English, ${feminine ? "feminine" : "masculine"}`,
    assets:
      id === "af_heart"
        ? undefined
        : [
            {
              path: `voices/${id}.pt`,
              url: hf("hexgrad/Kokoro-82M", KOKORO_REVISION, `voices/${id}.pt`),
              size,
              sha256,
            },
          ],
  }
})

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

const pythonRuntime = (description: string): RuntimeProfile => ({
  id: "python-pytorch-fp32",
  name: "Python / PyTorch FP32",
  description,
  kind: "python",
})

export const MODELS: readonly ModelDefinition[] = [
  {
    id: "kokoro",
    name: "Kokoro",
    tagline: "Small, modern all-rounder",
    footprint: "82M parameters · ~328 MB weights",
    license: "Apache-2.0",
    python: "3.11",
    packages: ["kokoro==0.9.4", "soundfile"],
    postInstall: [["-m", "spacy", "download", "en_core_web_sm"]],
    voices: kokoroVoices,
    defaultVoiceId: "af_heart",
    runtimes: [
      pythonRuntime("Current Kokoro 0.9.4 pipeline; best parity with the reference implementation"),
      {
        id: "javascript-onnx-q8",
        name: "JavaScript / ONNX Q8",
        description: "92.4 MB quantized ONNX model; no Python runtime",
        kind: "javascript",
        dtype: "q8",
        modelBytes: 92361116,
        modelFile: "onnx/model_quantized.onnx",
      },
      {
        id: "javascript-onnx-fp32",
        name: "JavaScript / ONNX FP32",
        description: "325.5 MB full-precision ONNX model; no Python runtime",
        kind: "javascript",
        dtype: "fp32",
        modelBytes: 325532232,
        modelFile: "onnx/model.onnx",
      },
    ],
    defaultRuntimeId: "python-pytorch-fp32",
    setupVersion: "kokoro-0.9.4-v2",
    note: "The published package supports Python 3.10-3.12.",
    assets: [
      {
        path: "config.json",
        url: hf("hexgrad/Kokoro-82M", KOKORO_REVISION, "config.json"),
        size: 2351,
      },
      {
        path: "kokoro-v1_0.pth",
        url: hf("hexgrad/Kokoro-82M", KOKORO_REVISION, "kokoro-v1_0.pth"),
        size: 327212226,
        sha256: "496dba118d1a58f5f3db2efc88dbdc216e0483fc89fe6e47ee1f2c53f18ad1e4",
      },
      {
        path: "voices/af_heart.pt",
        url: hf("hexgrad/Kokoro-82M", KOKORO_REVISION, "voices/af_heart.pt"),
        size: 523425,
        sha256: "0ab5709b8ffab19bfd849cd11d98f75b60af7733253ad0d67b12382a102cb4ff",
      },
    ],
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
