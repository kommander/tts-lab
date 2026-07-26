import { afterEach, expect, test } from "bun:test"
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runProcess } from "kokoro-local-runtime/core"
import { supportsFluidAudio } from "kokoro-local-runtime/fluidaudio"
import {
  copyAudioExport,
  getSynthesisConfigurationKey,
  normalizeAudioExportPath,
  resolveResourcePollMs,
  supportsRuntimePlatform,
  summarizeGenerationTimes,
} from "./model-manager.js"

let directory = ""

const modulePath = join(import.meta.dir, "model-manager.ts")
const modelsPath = join(import.meta.dir, "../models.ts")

function runManager(source: string): Promise<string> {
  return runProcess(
    [process.execPath, "-e", `import { ModelManager } from ${JSON.stringify(modulePath)}; ${source}`],
    { env: { TTS_LAB_HOME: directory, TTS_LAB_RESOURCE_POLL_MS: "0" } },
  )
}

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
})

test("normalizes export paths to the generated format", () => {
  expect(normalizeAudioExportPath("voice", "wav")).toEndWith("voice.wav")
  expect(normalizeAudioExportPath("voice.mp3", "wav")).toEndWith("voice.wav")
})

test("summarizes generation timing samples", () => {
  expect(summarizeGenerationTimes([])).toBeNull()
  expect(summarizeGenerationTimes([900, 300, 500, 700])).toEqual({
    sampleCount: 4,
    averageGenerationMs: 600,
    medianGenerationMs: 600,
    minGenerationMs: 300,
    maxGenerationMs: 900,
  })
  expect(summarizeGenerationTimes([100, 300, 200])?.medianGenerationMs).toBe(200)
  expect(summarizeGenerationTimes(Array.from({ length: 60 }, (_, index) => index + 1))?.sampleCount).toBe(60)
})

test("keys timing history by normalized runtime, voice, and schema-ordered parameters", () => {
  const first = getSynthesisConfigurationKey("f5", "python-pytorch-fp32", "nature-demo", {
    removeSilence: false,
    crossFade: 0.1 + 0.05,
    seed: 42,
    nfeSteps: 32,
    speed: 1,
  })
  const reordered = getSynthesisConfigurationKey("f5", "python-pytorch-fp32", "nature-demo", {
    speed: 1,
    nfeSteps: 32,
    seed: 42,
    crossFade: 0.15,
    removeSilence: false,
  })
  expect(first).toBe(reordered)
  expect(first).not.toBe(getSynthesisConfigurationKey("f5", "python-pytorch-fp32", "other", {
    speed: 1, nfeSteps: 32, seed: 42, crossFade: 0.15, removeSilence: false,
  }))
  expect(first).not.toBe(getSynthesisConfigurationKey("f5", "python-pytorch-fp32", "nature-demo", {
    speed: 1.1, nfeSteps: 32, seed: 42, crossFade: 0.15, removeSilence: false,
  }))
})

test("resolves the resource polling interval", () => {
  expect(resolveResourcePollMs(undefined)).toBe(4000)
  expect(resolveResourcePollMs("5000")).toBe(5000)
  expect(resolveResourcePollMs("100")).toBe(250)
  expect(resolveResourcePollMs("0")).toBe(0)
  expect(resolveResourcePollMs("invalid")).toBe(4000)
})

test("gates the CoreML ANE runtime to supported macOS systems", () => {
  expect(supportsFluidAudio("darwin", "arm64", "23.0.0")).toBe(true)
  expect(supportsFluidAudio("darwin", "arm64", "22.6.0")).toBe(false)
  expect(supportsFluidAudio("darwin", "x64", "25.0.0")).toBe(false)
  expect(supportsFluidAudio("linux", "arm64", "25.0.0")).toBe(false)
})

test("applies runtime-specific macOS requirements without blocking other platforms", () => {
  const runtime = { id: "test", name: "Test", description: "Test", kind: "python" as const, darwinArch: "arm64" as const, minimumDarwinMajor: 23, parameters: [] }
  expect(supportsRuntimePlatform(runtime, "darwin", "arm64", "23.0.0")).toBe(true)
  expect(supportsRuntimePlatform(runtime, "darwin", "x64", "25.0.0")).toBe(false)
  expect(supportsRuntimePlatform(runtime, "darwin", "arm64", "22.0.0")).toBe(false)
  expect(supportsRuntimePlatform(runtime, "linux", "x64", "6.0.0")).toBe(true)
  expect(supportsRuntimePlatform({ ...runtime, platforms: ["darwin"] }, "linux", "arm64", "6.0.0")).toBe(false)
  expect(supportsRuntimePlatform({ ...runtime, minimumMemoryBytes: 16 }, "darwin", "arm64", "23.0.0", 8)).toBe(false)
})

test("copies generated audio without overwriting an existing file", async () => {
  directory = await mkdtemp(join(tmpdir(), "tts-lab-export-"))
  const source = join(directory, "source.wav")
  const requested = join(directory, "saved.mp3")
  await writeFile(source, "wave bytes")
  const destination = await copyAudioExport(source, requested, "wav")
  expect(destination).toBe(join(directory, "saved.wav"))
  expect(await readFile(destination, "utf8")).toBe("wave bytes")
  await expect(copyAudioExport(source, requested, "wav")).rejects.toThrow()
})

test("persists and restores the selected runtime profile", async () => {
  directory = await mkdtemp(join(tmpdir(), "tts-lab-settings-"))
  await runManager('const manager = new ModelManager(); await manager.setRuntime("kokoro", "javascript-onnx-q8"); await manager.dispose();')
  const output = await runManager("const manager = new ModelManager(); console.log(manager.snapshot().kokoro.runtimeId); await manager.dispose();")
  expect(output.trim()).toBe("javascript-onnx-q8")
})

test("loads unversioned settings without rewriting and migrates on parameter mutation", async () => {
  directory = await mkdtemp(join(tmpdir(), "tts-lab-settings-v1-"))
  const original = JSON.stringify({ runtimes: { kokoro: "javascript-onnx-q8", qwen: "invalid" } }, null, 2)
  await writeFile(join(directory, "settings.json"), original)
  const restored = await runManager("const manager = new ModelManager(); console.log(JSON.stringify(manager.snapshot().kokoro)); await manager.dispose();")
  expect(JSON.parse(restored).synthesisParameters).toEqual({ speed: 1 })
  expect(await readFile(join(directory, "settings.json"), "utf8")).toBe(original)

  await runManager('const manager = new ModelManager(); await manager.setSynthesisParameters("kokoro", "javascript-onnx-q8", { speed: 1.2 }); await manager.dispose();')
  const migrated = JSON.parse(await readFile(join(directory, "settings.json"), "utf8"))
  expect(migrated.version).toBe(2)
  expect(migrated.runtimes.kokoro).toBe("javascript-onnx-q8")
  expect(migrated.synthesisParameters.kokoro["javascript-onnx-q8"]).toEqual({ speed: 1.2 })
})

test("restores v2 parameters per runtime and recovers invalid persisted values", async () => {
  directory = await mkdtemp(join(tmpdir(), "tts-lab-settings-v2-"))
  await writeFile(join(directory, "settings.json"), JSON.stringify({
    version: 2,
    runtimes: { kokoro: "javascript-onnx-q8", qwen: "python-mlx-4bit" },
    synthesisParameters: {
      kokoro: {
        "python-pytorch-fp32": { speed: 1.4 },
        "javascript-onnx-q8": { speed: 1.2 },
      },
      qwen: {
        "python-mlx-4bit": { temperature: "expressive", seed: -1, unknown: true },
      },
    },
  }))
  const output = await runManager(`
    const manager = new ModelManager();
    const initial = manager.snapshot();
    manager.ensure = async () => {};
    await manager.setRuntime("kokoro", "python-pytorch-fp32");
    const python = manager.snapshot().kokoro.synthesisParameters;
    await manager.setRuntime("kokoro", "javascript-onnx-q8");
    const restored = manager.snapshot().kokoro.synthesisParameters;
    console.log(JSON.stringify({ initial: initial.kokoro.synthesisParameters, qwen: initial.qwen.synthesisParameters, python, restored }));
    await manager.dispose();
  `)
  expect(JSON.parse(output)).toEqual({
    initial: { speed: 1.2 },
    qwen: {
      language: "auto",
      temperature: "expressive",
      topP: 1,
      topK: 50,
      repetitionPenalty: 1.05,
      maxTokens: 2048,
      seed: 42,
    },
    python: { speed: 1.4 },
    restored: { speed: 1.2 },
  })

  await runManager('const manager = new ModelManager(); await manager.setSynthesisParameters("kokoro", "javascript-onnx-q8", { speed: 1.3 }); await manager.dispose();')
  const saved = JSON.parse(await readFile(join(directory, "settings.json"), "utf8"))
  expect(saved.synthesisParameters.kokoro["python-pytorch-fp32"]).toEqual({ speed: 1.4 })
})

test("strict parameter writes reject stale runtimes and preserve resident workers", async () => {
  directory = await mkdtemp(join(tmpdir(), "tts-lab-parameters-"))
  const output = await runManager(`
    const manager = new ModelManager();
    const worker = { generate() {}, dispose() {}, stop() {}, getResourceUsage() { return {}; } };
    manager.activeWorker = { id: "kokoro", runtimeId: "python-pytorch-fp32", worker, loadMs: 1 };
    manager.states.kokoro.resident = true;
    const errors = [];
    try { await manager.setSynthesisParameters("kokoro", "javascript-onnx-q8", { speed: 1 }); } catch (error) { errors.push(error.message); }
    try { await manager.setSynthesisParameters("kokoro", "python-pytorch-fp32", { speed: "fast" }); } catch (error) { errors.push(error.name); }
    manager.states.kokoro.phase = "generating";
    try { await manager.setSynthesisParameters("kokoro", "python-pytorch-fp32", { speed: 1.1 }); } catch (error) { errors.push(error.message); }
    manager.states.kokoro.phase = "ready";
    await manager.setSynthesisParameters("kokoro", "python-pytorch-fp32", { speed: 1.2 });
    console.log(JSON.stringify({ errors, resident: manager.activeWorker?.worker === worker, state: manager.snapshot().kokoro }));
    manager.activeWorker = undefined;
    await manager.dispose();
  `)
  const result = JSON.parse(output)
  expect(result.errors).toEqual([
    "Kokoro runtime changed before synthesis parameters could be applied",
    "SynthesisParameterError",
    "Wait for the current Kokoro synthesis to finish before changing parameters",
  ])
  expect(result.resident).toBe(true)
  expect(result.state.resident).toBe(true)
  expect(result.state.synthesisParameters).toEqual({ speed: 1.2 })
})

test("forwards captured parameters and keeps timing histories configuration-specific", async () => {
  directory = await mkdtemp(join(tmpdir(), "tts-lab-generation-"))
  const output = await runManager(`
    const manager = new ModelManager();
    const requests = [];
    let generationMs = 10;
    const worker = {
      async generate(text, output, voice, parameters) {
        requests.push({ text, voice, parameters: { ...parameters } });
        return { output, generationMs: generationMs++ };
      },
      dispose() {}, async stop() {}, getResourceUsage() { return { rssBytes: 100, peakRssBytes: 120 }; },
    };
    manager.ensure = async () => {};
    manager.ensureVoice = async () => {};
    manager.getWorker = async id => ({ id, runtimeId: manager.snapshot()[id].runtimeId, worker, loadMs: 5 });
    manager.audio.play = async () => {};
    manager.audio.dispose = () => {};

    await manager.speak("kokoro", "first");
    await manager.setSynthesisParameters("kokoro", "python-pytorch-fp32", { speed: 1.2 });
    const cleared = manager.snapshot().kokoro.runtimeStats;
    await manager.speak("kokoro", "second");
    const secondStats = manager.snapshot().kokoro.runtimeStats;
    await manager.setSynthesisParameters("kokoro", "python-pytorch-fp32", { speed: 1 });
    const restored = manager.snapshot().kokoro.runtimeStats;
    await manager.setVoice("kokoro", "af_bella");
    const voiceCleared = manager.snapshot().kokoro.runtimeStats;
    await manager.speak("kokoro", "third");
    console.log(JSON.stringify({
      requests, cleared, secondStats, restored, voiceCleared,
      histories: manager.generationHistory.size,
    }));
    await manager.dispose();
  `)
  const result = JSON.parse(output)
  expect(result.requests).toEqual([
    { text: "first", voice: "af_heart", parameters: { speed: 1 } },
    { text: "second", voice: "af_heart", parameters: { speed: 1.2 } },
    { text: "third", voice: "af_bella", parameters: { speed: 1 } },
  ])
  expect(result.cleared).toBeUndefined()
  expect(result.secondStats.sampleCount).toBe(1)
  expect(result.secondStats.averageGenerationMs).toBe(11)
  expect(result.restored.sampleCount).toBe(1)
  expect(result.restored.averageGenerationMs).toBe(10)
  expect(result.voiceCleared).toBeUndefined()
  expect(result.histories).toBe(3)
})

test("serializes rapid parameter writes atomically with the last value winning", async () => {
  directory = await mkdtemp(join(tmpdir(), "tts-lab-settings-race-"))
  await runManager(`
    const manager = new ModelManager();
    const writes = [0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5].map(
      speed => manager.setSynthesisParameters("kokoro", "python-pytorch-fp32", { speed }),
    );
    await Promise.all(writes);
    await manager.dispose();
  `)
  const settings = JSON.parse(await readFile(join(directory, "settings.json"), "utf8"))
  expect(settings.synthesisParameters.kokoro["python-pytorch-fp32"]).toEqual({ speed: 1.5 })
  await expect(access(join(directory, "settings.json.tmp"))).rejects.toThrow()
})

test("serializes simultaneous runtime persistence across models", async () => {
  directory = await mkdtemp(join(tmpdir(), "tts-lab-settings-model-race-"))
  await runManager(`
    const { MODEL_BY_ID } = await import(${JSON.stringify(modelsPath)});
    MODEL_BY_ID.qwen.runtimes.push({
      ...MODEL_BY_ID.qwen.runtimes[0],
      id: "test-mlx-runtime",
      name: "Test MLX runtime",
    });
    const manager = new ModelManager();
    manager.ensure = async () => {};
    await Promise.all([
      manager.setRuntime("kokoro", "javascript-onnx-q8"),
      manager.setRuntime("qwen", "test-mlx-runtime"),
    ]);
    await manager.dispose();
  `)
  const settings = JSON.parse(await readFile(join(directory, "settings.json"), "utf8"))
  expect(settings.runtimes.kokoro).toBe("javascript-onnx-q8")
  expect(settings.runtimes.qwen).toBe("test-mlx-runtime")
})

test("uses independent atomic temp files across concurrent managers", async () => {
  directory = await mkdtemp(join(tmpdir(), "tts-lab-settings-cross-manager-"))
  await runManager(`
    const first = new ModelManager();
    const second = new ModelManager();
    first.refresh = async () => {};
    second.refresh = async () => {};
    const firstWrites = [0.6, 0.7, 0.8, 0.9].map(speed =>
      first.setSynthesisParameters("kokoro", "python-pytorch-fp32", { speed }));
    const secondWrites = [1.2, 1.3, 1.4, 1.5].map(speed =>
      second.setSynthesisParameters("kokoro", "python-pytorch-fp32", { speed }));
    await Promise.all([...firstWrites, ...secondWrites]);
    await Promise.all([first.dispose(), second.dispose()]);
  `)
  const settings = JSON.parse(await readFile(join(directory, "settings.json"), "utf8"))
  expect([0.9, 1.5]).toContain(settings.synthesisParameters.kokoro["python-pytorch-fp32"].speed)
  expect((await readdir(directory)).filter((name) => name.includes("settings.json.") && name.endsWith(".tmp"))).toEqual([])
})

test("rejects synthesis for the full lifetime of a voice mutation", async () => {
  directory = await mkdtemp(join(tmpdir(), "tts-lab-voice-race-"))
  const output = await runManager(`
    const manager = new ModelManager();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    manager.ensure = async () => { await gate; };
    manager.ensureVoice = async () => {};
    const mutation = manager.setVoice("kokoro", "af_bella");
    await Promise.resolve();
    await Promise.resolve();
    let error;
    try { await manager.speak("kokoro", "race"); } catch (caught) { error = caught.message; }
    release();
    await mutation;
    console.log(JSON.stringify({ error, voiceId: manager.snapshot().kokoro.voiceId }));
    await manager.dispose();
  `)
  expect(JSON.parse(output)).toEqual({
    error: "Wait for the current Kokoro configuration change to finish before synthesizing",
    voiceId: "af_bella",
  })
})

test("configuration activity only blocks synthesis for the affected model", async () => {
  directory = await mkdtemp(join(tmpdir(), "tts-lab-model-activity-"))
  const output = await runManager(`
    const manager = new ModelManager();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let stopStarted = false;
    const worker = {
      generate() {}, dispose() {},
      async stop() { stopStarted = true; await gate; },
      getResourceUsage() { return {}; },
    };
    manager.activeWorker = { id: "kokoro", runtimeId: "python-pytorch-fp32", worker, loadMs: 1 };
    manager.ensure = async () => {};
    manager.synthesize = async id => { manager.spokenModel = id; };
    const mutation = manager.setRuntime("kokoro", "javascript-onnx-q8");
    while (!stopStarted) await Bun.sleep(1);
    await manager.speak("qwen", "not blocked");
    release();
    await mutation;
    console.log(manager.spokenModel);
    await manager.dispose();
  `)
  expect(output.trim()).toBe("qwen")
})

test("preserves voice selection across rapid native runtime changes", async () => {
  directory = await mkdtemp(join(tmpdir(), "tts-lab-runtime-voice-race-"))
  const output = await runManager(`
    const manager = new ModelManager();
    manager.ensure = async () => {};
    manager.ensureVoice = async () => {};
    const runtimeThenVoice = await Promise.allSettled([
      manager.setRuntime("kokoro", "native-coreml-ane"),
      manager.setVoice("kokoro", "af_bella"),
    ]);
    const afterRuntimeThenVoice = manager.snapshot().kokoro;
    await manager.setRuntime("kokoro", "python-pytorch-fp32");
    const voiceThenRuntime = await Promise.allSettled([
      manager.setVoice("kokoro", "af_bella"),
      manager.setRuntime("kokoro", "native-coreml-ane"),
    ]);
    const afterVoiceThenRuntime = manager.snapshot().kokoro;
    console.log(JSON.stringify({
      runtimeThenVoice: runtimeThenVoice.map(result => result.status === "fulfilled" ? "fulfilled" : result.reason.message),
      afterRuntimeThenVoice: [afterRuntimeThenVoice.runtimeId, afterRuntimeThenVoice.voiceId],
      voiceThenRuntime: voiceThenRuntime.map(result => result.status),
      afterVoiceThenRuntime: [afterVoiceThenRuntime.runtimeId, afterVoiceThenRuntime.voiceId],
    }));
    await manager.dispose();
  `)
  expect(JSON.parse(output)).toEqual({
    runtimeThenVoice: ["fulfilled", "fulfilled"],
    afterRuntimeThenVoice: ["native-coreml-ane", "af_bella"],
    voiceThenRuntime: ["fulfilled", "fulfilled"],
    afterVoiceThenRuntime: ["native-coreml-ane", "af_bella"],
  })
})

test("uses bundled native Kokoro voices without Python voice downloads", async () => {
  directory = await mkdtemp(join(tmpdir(), "tts-lab-native-voice-"))
  const output = await runManager(`
    const manager = new ModelManager();
    manager.patch("kokoro", { runtimeId: "native-coreml-ane", voiceId: "af_bella" });
    let downloads = 0;
    manager.kokoro.ensureVoice = async () => { downloads += 1; };
    await manager.ensureVoice("kokoro", "af_bella");
    console.log(downloads);
    await manager.dispose();
  `)
  expect(output.trim()).toBe("0")
})

test("superseded voice selection stops after teardown without obsolete setup", async () => {
  directory = await mkdtemp(join(tmpdir(), "tts-lab-latest-voice-"))
  const output = await runManager(`
    const manager = new ModelManager();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const controller = new AbortController();
    manager.voiceDownloads.set("kokoro:af_heart", { promise: gate, controller });
    const ensured = [];
    const voices = [];
    manager.ensure = async id => { ensured.push(manager.snapshot()[id].voiceId); };
    manager.ensureVoice = async (id, voiceId) => { voices.push(voiceId); };
    const obsolete = manager.setVoice("kokoro", "af_bella");
    while (!controller.signal.aborted) await Bun.sleep(1);
    const latest = manager.setVoice("kokoro", "af_nicole");
    release();
    await Promise.all([obsolete, latest]);
    console.log(JSON.stringify({ state: manager.snapshot().kokoro, ensured, voices }));
    manager.voiceDownloads.clear();
    await manager.dispose();
  `)
  const result = JSON.parse(output)
  expect(result.state.voiceId).toBe("af_nicole")
  expect(result.ensured).toEqual(["af_nicole"])
  expect(result.voices).toEqual(["af_nicole"])
})

test("superseded runtime selection clears a stopped worker without obsolete persistence or setup", async () => {
  directory = await mkdtemp(join(tmpdir(), "tts-lab-latest-runtime-"))
  const output = await runManager(`
    const manager = new ModelManager();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let stopStarted = false;
    const worker = {
      generate() {}, dispose() {},
      async stop() { stopStarted = true; await gate; },
      getResourceUsage() { return {}; },
    };
    manager.activeWorker = { id: "kokoro", runtimeId: "python-pytorch-fp32", worker, loadMs: 1 };
    manager.patch("kokoro", {
      resident: true,
      runtimeStats: { sampleCount: 1, averageGenerationMs: 1, medianGenerationMs: 1, minGenerationMs: 1, maxGenerationMs: 1, appRssBytes: 10, appHeapUsedBytes: 5, workerRssBytes: 20 },
    });
    const persisted = [];
    const ensured = [];
    manager.saveSettings = async () => { persisted.push(manager.snapshot().kokoro.runtimeId); };
    manager.ensure = async id => { ensured.push(manager.snapshot()[id].runtimeId); };
    const obsolete = manager.setRuntime("kokoro", "native-coreml-ane");
    while (!stopStarted) await Bun.sleep(1);
    const latest = manager.setRuntime("kokoro", "javascript-onnx-q8");
    release();
    await Promise.all([obsolete, latest]);
    console.log(JSON.stringify({
      state: manager.snapshot().kokoro,
      persisted,
      ensured,
      workerCleared: manager.activeWorker === undefined,
    }));
    await manager.dispose();
  `)
  const result = JSON.parse(output)
  expect(result.state.runtimeId).toBe("javascript-onnx-q8")
  expect(result.state.resident).toBe(false)
  expect(result.state.runtimeStats?.workerRssBytes).toBeUndefined()
  expect(result.persisted).toEqual(["javascript-onnx-q8"])
  expect(result.ensured).toEqual(["javascript-onnx-q8"])
  expect(result.workerCleared).toBe(true)
})

test("rolls back failed parameter persistence before accepting the next mutation", async () => {
  directory = await mkdtemp(join(tmpdir(), "tts-lab-parameter-rollback-"))
  const output = await runManager(`
    const manager = new ModelManager();
    await manager.setSynthesisParameters("kokoro", "python-pytorch-fp32", { speed: 1.1 });
    const saveSettings = manager.saveSettings.bind(manager);
    manager.saveSettings = async () => { throw new Error("simulated write failure"); };
    let error;
    try { await manager.setSynthesisParameters("kokoro", "python-pytorch-fp32", { speed: 1.2 }); }
    catch (caught) { error = caught.message; }
    const afterFailure = manager.snapshot().kokoro.synthesisParameters;
    const diskAfterFailure = JSON.parse(await Bun.file(${JSON.stringify(join(directory, "settings.json"))}).text());
    manager.saveSettings = saveSettings;
    await manager.setSynthesisParameters("kokoro", "python-pytorch-fp32", { speed: 1.3 });
    console.log(JSON.stringify({ error, afterFailure, diskAfterFailure: diskAfterFailure.synthesisParameters.kokoro["python-pytorch-fp32"], afterSuccess: manager.snapshot().kokoro.synthesisParameters }));
    await manager.dispose();
  `)
  expect(JSON.parse(output)).toEqual({
    error: "simulated write failure",
    afterFailure: { speed: 1.1 },
    diskAfterFailure: { speed: 1.1 },
    afterSuccess: { speed: 1.3 },
  })
  const settings = JSON.parse(await readFile(join(directory, "settings.json"), "utf8"))
  expect(settings.synthesisParameters.kokoro["python-pytorch-fp32"]).toEqual({ speed: 1.3 })
})

test("rolls back runtime state without stale residency after persistence fails following worker stop", async () => {
  directory = await mkdtemp(join(tmpdir(), "tts-lab-runtime-rollback-"))
  const output = await runManager(`
    const manager = new ModelManager();
    manager.ensure = async () => {};
    manager.ensureVoice = async () => {};
    await manager.setVoice("kokoro", "af_bella");
    await manager.setSynthesisParameters("kokoro", "python-pytorch-fp32", { speed: 1.2 });
    manager.patch("kokoro", {
      installed: true, phase: "ready", detail: "Old status", setupProgress: 1, resident: true,
      runtimeStats: { sampleCount: 1, averageGenerationMs: 2, medianGenerationMs: 2, minGenerationMs: 2, maxGenerationMs: 2, appRssBytes: 10, appHeapUsedBytes: 5, workerRssBytes: 20, workerPeakRssBytes: 25 },
    });
    let stops = 0;
    const worker = { generate() {}, dispose() {}, async stop() { stops += 1; }, getResourceUsage() { return {}; } };
    manager.activeWorker = { id: "kokoro", runtimeId: "python-pytorch-fp32", worker, loadMs: 1 };
    const before = manager.snapshot().kokoro;
    const saveSettings = manager.saveSettings.bind(manager);
    manager.saveSettings = async () => { throw new Error("simulated write failure"); };
    let error;
    try { await manager.setRuntime("kokoro", "native-coreml-ane"); }
    catch (caught) { error = caught.message; }
    const afterFailure = manager.snapshot().kokoro;
    const diskAfterFailure = JSON.parse(await Bun.file(${JSON.stringify(join(directory, "settings.json"))}).text());
    const stopsAfterFailure = stops;
    manager.saveSettings = saveSettings;
    await manager.setRuntime("kokoro", "javascript-onnx-q8");
    console.log(JSON.stringify({ error, before, afterFailure, diskRuntime: diskAfterFailure.runtimes.kokoro, stopsAfterFailure, activeAfterFailure: manager.activeWorker, afterSuccess: manager.snapshot().kokoro, stopsAfterSuccess: stops }));
    await manager.dispose();
  `)
  const result = JSON.parse(output)
  expect(result.error).toBe("simulated write failure")
  expect(result.afterFailure).toEqual({
    ...result.before,
    resident: false,
    runtimeStats: { ...result.before.runtimeStats, workerRssBytes: undefined },
  })
  expect(result.diskRuntime).toBe("python-pytorch-fp32")
  expect(result.stopsAfterFailure).toBe(1)
  expect(result.activeAfterFailure).toBeUndefined()
  expect(result.afterSuccess.runtimeId).toBe("javascript-onnx-q8")
  expect(result.afterSuccess.voiceId).toBe("af_bella")
  expect(result.stopsAfterSuccess).toBe(1)
  const settings = JSON.parse(await readFile(join(directory, "settings.json"), "utf8"))
  expect(settings.runtimes.kokoro).toBe("javascript-onnx-q8")
})

test("rejects and rolls back a failing runtime save before persisting a queued duplicate request", async () => {
  directory = await mkdtemp(join(tmpdir(), "tts-lab-runtime-duplicate-save-race-"))
  const output = await runManager(`
    const manager = new ModelManager();
    manager.ensure = async () => {};
    await manager.setSynthesisParameters("kokoro", "python-pytorch-fp32", { speed: 1.1 });
    const saveSettings = manager.saveSettings.bind(manager);
    let saveStarted;
    const started = new Promise(resolve => { saveStarted = resolve; });
    let releaseSave;
    const saveGate = new Promise(resolve => { releaseSave = resolve; });
    let saves = 0;
    manager.saveSettings = async () => {
      saves += 1;
      if (saves === 1) {
        saveStarted();
        await saveGate;
        throw new Error("simulated write failure");
      }
      await saveSettings();
    };
    const first = manager.setRuntime("kokoro", "javascript-onnx-q8");
    await started;
    const second = manager.setRuntime("kokoro", "javascript-onnx-q8");
    releaseSave();
    const results = await Promise.allSettled([first, second]);
    const disk = JSON.parse(await Bun.file(${JSON.stringify(join(directory, "settings.json"))}).text());
    console.log(JSON.stringify({
      results: results.map(result => result.status === "fulfilled" ? "fulfilled" : result.reason.message),
      saves,
      memoryRuntime: manager.snapshot().kokoro.runtimeId,
      diskRuntime: disk.runtimes.kokoro,
    }));
    await manager.dispose();
  `)
  expect(JSON.parse(output)).toEqual({
    results: ["simulated write failure", "fulfilled"],
    saves: 2,
    memoryRuntime: "javascript-onnx-q8",
    diskRuntime: "javascript-onnx-q8",
  })
})

test("rejects and rolls back a failing runtime save before applying a different queued runtime", async () => {
  directory = await mkdtemp(join(tmpdir(), "tts-lab-runtime-different-save-race-"))
  const output = await runManager(`
    const manager = new ModelManager();
    manager.ensure = async () => {};
    await manager.setSynthesisParameters("kokoro", "python-pytorch-fp32", { speed: 1.1 });
    const saveSettings = manager.saveSettings.bind(manager);
    let saveStarted;
    const started = new Promise(resolve => { saveStarted = resolve; });
    let releaseSave;
    const saveGate = new Promise(resolve => { releaseSave = resolve; });
    let saves = 0;
    manager.saveSettings = async () => {
      saves += 1;
      if (saves === 1) {
        saveStarted();
        await saveGate;
        throw new Error("simulated write failure");
      }
      await saveSettings();
    };
    const first = manager.setRuntime("kokoro", "javascript-onnx-q8");
    await started;
    const second = manager.setRuntime("kokoro", "native-coreml-ane");
    releaseSave();
    const results = await Promise.allSettled([first, second]);
    const disk = JSON.parse(await Bun.file(${JSON.stringify(join(directory, "settings.json"))}).text());
    console.log(JSON.stringify({
      results: results.map(result => result.status === "fulfilled" ? "fulfilled" : result.reason.message),
      saves,
      memoryRuntime: manager.snapshot().kokoro.runtimeId,
      diskRuntime: disk.runtimes.kokoro,
    }));
    await manager.dispose();
  `)
  expect(JSON.parse(output)).toEqual({
    results: ["simulated write failure", "fulfilled"],
    saves: 2,
    memoryRuntime: "native-coreml-ane",
    diskRuntime: "native-coreml-ane",
  })
})

test("keeps runtime state and disk unchanged when worker stop fails", async () => {
  directory = await mkdtemp(join(tmpdir(), "tts-lab-runtime-stop-rollback-"))
  const output = await runManager(`
    const manager = new ModelManager();
    manager.ensure = async () => {};
    await manager.setSynthesisParameters("kokoro", "python-pytorch-fp32", { speed: 1.1 });
    manager.patch("kokoro", {
      installed: true, phase: "ready", detail: "Old status", resident: true,
      runtimeStats: { sampleCount: 1, averageGenerationMs: 2, medianGenerationMs: 2, minGenerationMs: 2, maxGenerationMs: 2, appRssBytes: 10, appHeapUsedBytes: 5, workerRssBytes: 20 },
    });
    let stops = 0;
    const worker = {
      generate() {}, dispose() {},
      async stop() { stops += 1; if (stops === 1) throw new Error("simulated stop failure"); },
      getResourceUsage() { return {}; },
    };
    manager.activeWorker = { id: "kokoro", runtimeId: "python-pytorch-fp32", worker, loadMs: 1 };
    const before = manager.snapshot().kokoro;
    let error;
    try { await manager.setRuntime("kokoro", "javascript-onnx-q8"); }
    catch (caught) { error = caught.message; }
    const afterFailure = manager.snapshot().kokoro;
    const diskAfterFailure = JSON.parse(await Bun.file(${JSON.stringify(join(directory, "settings.json"))}).text());
    const activeAfterFailure = manager.activeWorker?.worker === worker;
    await manager.setRuntime("kokoro", "javascript-onnx-q8");
    console.log(JSON.stringify({
      error, before, afterFailure, diskRuntime: diskAfterFailure.runtimes.kokoro,
      activeAfterFailure,
      afterSuccess: manager.snapshot().kokoro.runtimeId, stops,
    }));
    await manager.dispose();
  `)
  const result = JSON.parse(output)
  expect(result.error).toBe("simulated stop failure")
  expect(result.afterFailure).toEqual(result.before)
  expect(result.diskRuntime).toBe("python-pytorch-fp32")
  expect(result.activeAfterFailure).toBe(true)
  expect(result.afterSuccess).toBe("javascript-onnx-q8")
  expect(result.stops).toBe(2)
})

test("keeps a successfully persisted runtime selected when setup fails", async () => {
  directory = await mkdtemp(join(tmpdir(), "tts-lab-runtime-setup-failure-"))
  const output = await runManager(`
    const manager = new ModelManager();
    manager.ensure = async id => {
      manager.patch(id, { phase: "error", detail: "simulated setup failure", error: "simulated setup failure" });
      throw new Error("simulated setup failure");
    };
    let error;
    try { await manager.setRuntime("kokoro", "javascript-onnx-q8"); }
    catch (caught) { error = caught.message; }
    const disk = JSON.parse(await Bun.file(${JSON.stringify(join(directory, "settings.json"))}).text());
    console.log(JSON.stringify({ error, state: manager.snapshot().kokoro, diskRuntime: disk.runtimes.kokoro }));
    await manager.dispose();
  `)
  const result = JSON.parse(output)
  expect(result.error).toBe("simulated setup failure")
  expect(result.state.runtimeId).toBe("javascript-onnx-q8")
  expect(result.state.phase).toBe("error")
  expect(result.diskRuntime).toBe("javascript-onnx-q8")
})

test("an active synthesis blocks later runtime mutation and uses its captured runtime", async () => {
  directory = await mkdtemp(join(tmpdir(), "tts-lab-synthesis-race-"))
  const output = await runManager(`
    const manager = new ModelManager();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let expectedRuntime;
    let stops = 0;
    const worker = {
      async generate(text, output) { await gate; return { output, generationMs: 1 }; },
      dispose() {}, async stop() { stops += 1; }, getResourceUsage() { return {}; },
    };
    manager.ensure = async () => {};
    manager.ensureVoice = async () => {};
    manager.getWorker = async (id, runtime) => { expectedRuntime = runtime.id; return { id, runtimeId: runtime.id, worker, loadMs: 1 }; };
    manager.audio.play = async () => {};
    manager.audio.dispose = () => {};
    const synthesis = manager.speak("kokoro", "race");
    while (!expectedRuntime) await Bun.sleep(1);
    let error;
    try { await manager.setRuntime("kokoro", "javascript-onnx-q8"); } catch (caught) { error = caught.message; }
    release();
    await synthesis;
    console.log(JSON.stringify({ error, expectedRuntime, runtimeId: manager.snapshot().kokoro.runtimeId, stops }));
    await manager.dispose();
  `)
  expect(JSON.parse(output)).toEqual({
    error: "Wait for the current Kokoro synthesis to finish before changing runtime",
    expectedRuntime: "python-pytorch-fp32",
    runtimeId: "python-pytorch-fp32",
    stops: 0,
  })
})

test("dispose joins configuration mutations and prevents their post-await work", async () => {
  directory = await mkdtemp(join(tmpdir(), "tts-lab-dispose-race-"))
  const output = await runManager(`
    const manager = new ModelManager();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let voiceEnsures = 0;
    manager.ensure = async () => { await gate; };
    manager.ensureVoice = async () => { voiceEnsures += 1; };
    const mutation = manager.setVoice("kokoro", "af_bella");
    await Promise.resolve();
    await Promise.resolve();
    let disposed = false;
    const disposal = manager.dispose().then(() => { disposed = true; });
    await Promise.resolve();
    const joinedBeforeRelease = !disposed;
    release();
    const mutationResult = await mutation.then(() => "resolved", error => error.message);
    await disposal;
    delete manager.ensure;
    delete manager.ensureVoice;
    const rejected = [];
    for (const operation of [
      () => manager.ensure("kokoro"),
      () => manager.setVoice("kokoro", "af_heart"),
      () => manager.setRuntime("kokoro", "javascript-onnx-q8"),
      () => manager.setSynthesisParameters("kokoro", "python-pytorch-fp32", { speed: 1 }),
      () => manager.speak("kokoro", "after disposal"),
    ]) {
      try { await operation(); } catch (error) { rejected.push(error.message); }
    }
    console.log(JSON.stringify({ joinedBeforeRelease, mutationResult, voiceEnsures, rejected }));
  `)
  const result = JSON.parse(output)
  expect(result.joinedBeforeRelease).toBe(true)
  expect(result.mutationResult).toBe("Model manager is disposed")
  expect(result.voiceEnsures).toBe(0)
  expect(result.rejected).toEqual(Array(5).fill("Model manager is disposed"))
})

test("dispose joins runtime mutations before they can patch the selected runtime", async () => {
  directory = await mkdtemp(join(tmpdir(), "tts-lab-dispose-runtime-race-"))
  const output = await runManager(`
    const manager = new ModelManager();
    await manager.setSynthesisParameters("kokoro", "python-pytorch-fp32", { speed: 1.1 });
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let stopStarted = false;
    const worker = {
      async generate() { throw new Error("unused"); },
      dispose() {},
      async stop() { stopStarted = true; await gate; },
      getResourceUsage() { return {}; },
    };
    manager.activeWorker = { id: "kokoro", runtimeId: "python-pytorch-fp32", worker, loadMs: 1 };
    const mutation = manager.setRuntime("kokoro", "javascript-onnx-q8");
    while (!stopStarted) await Bun.sleep(1);
    let disposed = false;
    const disposal = manager.dispose().then(() => { disposed = true; });
    await Promise.resolve();
    const joinedBeforeRelease = !disposed;
    release();
    const mutationResult = await mutation.then(() => "resolved", error => error.message);
    await disposal;
    const disk = JSON.parse(await Bun.file(${JSON.stringify(join(directory, "settings.json"))}).text());
    console.log(JSON.stringify({
      joinedBeforeRelease,
      mutationResult,
      runtimeId: manager.snapshot().kokoro.runtimeId,
      diskRuntime: disk.runtimes.kokoro,
    }));
  `)
  expect(JSON.parse(output)).toEqual({
    joinedBeforeRelease: true,
    mutationResult: "Model manager is disposed",
    runtimeId: "python-pytorch-fp32",
    diskRuntime: "python-pytorch-fp32",
  })
})

test("linking a local controller after manager abort aborts it immediately", async () => {
  directory = await mkdtemp(join(tmpdir(), "tts-lab-abort-link-"))
  const output = await runManager(`
    const manager = new ModelManager();
    manager.controller.abort();
    const local = new AbortController();
    manager.linkController(local);
    console.log(String(local.signal.aborted));
    await manager.dispose();
  `)
  expect(output.trim()).toBe("true")
})
