import type { ModelId } from "./types.js"

export interface ModelAsset {
  path: string
  url: string
  size: number
  sha256?: string
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
  setupVersion: string
  voice: string
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

export const MODELS: readonly ModelDefinition[] = [
  {
    id: "kokoro",
    name: "Kokoro",
    tagline: "Small, modern all-rounder",
    footprint: "~328 MB weights",
    license: "Apache-2.0",
    python: "3.11",
    packages: ["kokoro==0.9.4", "soundfile"],
    postInstall: [["-m", "spacy", "download", "en_core_web_sm"]],
    setupVersion: "kokoro-0.9.4-v2",
    voice: "af_heart / American English",
    note: "82M parameters. The published package supports Python 3.10-3.12.",
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
    setupVersion: "piper-1.6.0-v2",
    voice: "en_US-lessac-medium",
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
    setupVersion: "melotts-2091453-v5",
    voice: "EN-US",
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
    setupVersion: "parler-0.2.2-v4",
    voice: "Jon / clean, close recording",
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
    setupVersion: "f5-tts-1.1.22-v3",
    voice: "Packaged Nature demo reference",
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
