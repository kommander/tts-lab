import { randomUUID } from "node:crypto"
import { join } from "node:path"
import type {
  InputRenderable,
  KeyEvent,
  Renderable,
  ScrollBoxRenderable,
  SelectRenderable,
  TabSelectRenderable,
  TextareaRenderable,
} from "@opentui/core"
import type { Keymap } from "@opentui/keymap"
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal, For, onCleanup, onMount } from "solid-js"
import { MODEL_BY_ID, MODELS } from "./models.js"
import type { DemoController, ModelId, ModelState } from "./types.js"

const COLORS = {
  background: "#18201B",
  header: "#2A3B31",
  ink: "#F3F6E8",
  muted: "#AAB9A8",
  green: "#B8F56A",
  cyan: "#58E1C1",
  violet: "#79B8FF",
  pink: "#FF8C69",
  amber: "#FFD166",
  red: "#FF667A",
  border: "#5F7668",
}

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

function ProgressBar(props: { value: number | null; width?: number; tick: number; color?: string }) {
  const width = () => props.width ?? 18
  const normalized = () => Math.max(0, Math.min(1, props.value ?? 0))
  const filled = () => Math.round(normalized() * width())
  const bar = () => {
    if (props.value !== null) return "#".repeat(filled()) + "-".repeat(width() - filled())
    const position = props.tick % Math.max(1, width() - 4)
    return "-".repeat(position) + "####" + "-".repeat(Math.max(0, width() - position - 4))
  }
  return (
    <text fg={props.color ?? COLORS.cyan} flexShrink={0}>
      [{bar()}] {props.value === null ? " working" : `${Math.round(normalized() * 100)}%`}
    </text>
  )
}

function statusColor(state: ModelState): string {
  if (state.phase === "error") return COLORS.red
  if (state.phase === "ready" || state.phase === "playing") return COLORS.green
  if (state.phase === "idle") return COLORS.muted
  return COLORS.amber
}

function shortDuration(milliseconds: number): string {
  return milliseconds < 1000 ? `${Math.round(milliseconds)}ms` : `${(milliseconds / 1000).toFixed(2)}s`
}

export function getLatencyItems(state: ModelState): NonNullable<ModelState["lastLatency"]>[] {
  return state.lastLatency ? [state.lastLatency] : []
}

export function buildSpectrumRows(levels: readonly number[], barCount: number, rowCount: number): string[] {
  const sampled = Array.from({ length: barCount }, (_, bar) => {
    const first = Math.floor((bar * levels.length) / barCount)
    const last = Math.max(first + 1, Math.floor(((bar + 1) * levels.length) / barCount))
    let level = 0
    for (let index = first; index < last; index += 1) level = Math.max(level, levels[index] ?? 0)
    return level
  })
  return Array.from({ length: rowCount }, (_, row) => {
    const threshold = (rowCount - row) / rowCount
    return sampled.map((level) => (level >= threshold ? "█" : "·")).join(" ")
  })
}

function Spectrum(props: { levels: number[]; rowCount: number }) {
  const rows = createMemo(() => buildSpectrumRows(props.levels, 12, props.rowCount))
  const active = createMemo(() => props.levels.some((level) => level > 0.03))
  const colors = [COLORS.pink, COLORS.amber, COLORS.green, COLORS.cyan, COLORS.cyan]
  return (
    <box
      height={props.rowCount + 2}
      flexShrink={0}
      flexDirection="column"
      border
      borderStyle="single"
      borderColor={active() ? COLORS.cyan : COLORS.border}
      title=" SPECTRUM "
      titleColor={active() ? COLORS.cyan : COLORS.muted}
      paddingX={1}
      backgroundColor="transparent"
    >
      <For each={rows()}>
        {(row, index) => <text fg={colors[index()] ?? COLORS.cyan} flexShrink={0}>{row}</text>}
      </For>
    </box>
  )
}

export const SPEAK_BINDING = "ctrl+g"

export function App(props: { controller: DemoController; keymap: Keymap<Renderable, KeyEvent> }) {
  const renderer = useRenderer()
  const dimensions = useTerminalDimensions()
  const speakKeyLabel = props.keymap.formatKey(SPEAK_BINDING).toUpperCase()
  const initial = props.controller.snapshot()
  const [states, setStates] = createSignal(initial)
  const [selected, setSelected] = createSignal<ModelId>("kokoro")
  const [focus, setFocus] = createSignal<"models" | "voices" | "editor" | "runtime">("models")
  const [text, setText] = createSignal("Local speech should be simple, private, and a little bit delightful.")
  const [spectrum, setSpectrum] = createSignal(props.controller.getSpectrum())
  const [tick, setTick] = createSignal(0)
  let editor: TextareaRenderable | undefined
  let tabs: TabSelectRenderable | undefined
  let runtimeScroll: ScrollBoxRenderable | undefined

  const state = createMemo(() => states()[selected()])
  const definition = createMemo(() => MODEL_BY_ID[selected()])
  const selectedVoice = createMemo(
    () => definition().voices.find((voice) => voice.id === state().voiceId) ?? definition().voices[0]!,
  )
  const selectedRuntime = createMemo(
    () => definition().runtimes.find((runtime) => runtime.id === state().runtimeId) ?? definition().runtimes[0]!,
  )
  const availableVoices = createMemo(() => {
    const voiceIds = selectedRuntime().voiceIds
    return voiceIds ? definition().voices.filter((voice) => voiceIds.includes(voice.id)) : definition().voices
  })
  const runtimeOptions = createMemo(() =>
    definition().runtimes.map((runtime) => ({
      name: runtime.name,
      description: runtime.description,
      value: runtime.id,
    })),
  )
  const runtimeIndex = createMemo(() =>
    Math.max(0, definition().runtimes.findIndex((runtime) => runtime.id === state().runtimeId)),
  )
  const voiceOptions = createMemo(() =>
    availableVoices().map((voice) => ({ name: voice.name, description: voice.description, value: voice.id })),
  )
  const voiceIndex = createMemo(() => Math.max(0, availableVoices().findIndex((voice) => voice.id === state().voiceId)))
  const latencyItems = createMemo(() => getLatencyItems(state()))
  const busy = createMemo(() => !["idle", "ready", "playing", "error"].includes(state().phase))
  const synthesisActive = createMemo(() =>
    MODELS.some(({ id }) => ["generating", "playing"].includes(states()[id].phase)),
  )
  const canSpeak = createMemo(() => state().installed && !busy() && !synthesisActive() && text().trim().length > 0)
  const stacked = createMemo(() => dimensions().width < 86 && dimensions().height >= 34)
  const compact = createMemo(() => dimensions().width < 108 || dimensions().height < 36)
  const veryNarrow = createMemo(() => dimensions().width < 76)
  const tabWidth = createMemo(() => Math.max(8, Math.floor((dimensions().width - 2) / MODELS.length)))
  const composerWidth = createMemo(() => (stacked() ? "100%" : dimensions().width < 118 ? "62%" : "68%"))
  const progressWidth = createMemo(() => {
    const panelWidth = stacked() ? dimensions().width : dimensions().width * (dimensions().width < 118 ? 0.38 : 0.32)
    return Math.max(10, Math.min(28, Math.floor(panelWidth - 12)))
  })
  const spectrumRowCount = createMemo(() => {
    if (stacked()) return 5
    if (dimensions().height < 24) return 3
    if (dimensions().height < 30) return 5
    return 7
  })
  const keyHints = createMemo(() =>
    veryNarrow()
      ? `${speakKeyLabel} speak  F2 save  F3 runtime`
      : `TAB focus  ${speakKeyLabel} speak  F2 save  F3 runtime  CTRL+R retry  ESC quit`,
  )
  const dialogWidth = createMemo(() => Math.max(24, Math.min(76, dimensions().width - 4)))
  const [saveDialogOpen, setSaveDialogOpen] = createSignal(false)
  const [savePath, setSavePath] = createSignal("")
  const [saveError, setSaveError] = createSignal("")
  const [saving, setSaving] = createSignal(false)
  const [runtimeDialogOpen, setRuntimeDialogOpen] = createSignal(false)
  let saveInput: InputRenderable | undefined
  let runtimeSelect: SelectRenderable | undefined
  const options = createMemo(() =>
    MODELS.map((model) => ({
      name: `${states()[model.id].installed ? "+" : states()[model.id].phase === "error" ? "!" : " "} ${model.name}`,
      description: model.tagline,
      value: model.id,
    })),
  )

  const choose = (id: ModelId) => {
    setSelected(id)
    void props.controller.ensure(id).catch(() => undefined)
  }

  const chooseVoice = (voiceId: string) => {
    const voice = definition().voices.find((candidate) => candidate.id === voiceId)
    if (!voice) return
    const modelId = selected()
    void props.controller.setVoice(modelId, voiceId).catch(() => undefined)
  }

  const moveFocus = (direction: 1 | -1) => {
    const targets: Array<"models" | "voices" | "editor" | "runtime"> =
      availableVoices().length > 1 ? ["models", "voices", "editor", "runtime"] : ["models", "editor", "runtime"]
    const current = Math.max(0, targets.indexOf(focus()))
    setFocus(targets[(current + direction + targets.length) % targets.length]!)
  }

  const speak = () => {
    if (!canSpeak()) {
      if (synthesisActive()) return
      if (!state().installed) void props.controller.ensure(selected())
      return
    }
    void props.controller.speak(selected(), text()).catch(() => undefined)
  }

  const openSaveDialog = () => {
    const latest = props.controller.getLatestAudio()
    const format = latest?.format ?? "wav"
    const model = latest?.model ?? selected()
    setSavePath(join(process.cwd(), `tts-${model}-${randomUUID().slice(0, 8)}.${format}`))
    setSaveError(latest ? "" : "Generate audio before saving it")
    setSaveDialogOpen(true)
    queueMicrotask(() => saveInput?.focus())
  }

  const openRuntimeDialog = () => {
    setSaveDialogOpen(false)
    setRuntimeDialogOpen(true)
    queueMicrotask(() => runtimeSelect?.focus())
  }

  const closeSaveDialog = () => {
    setSaveDialogOpen(false)
    setSaveError("")
    setSaving(false)
    setFocus("editor")
    queueMicrotask(() => editor?.focus())
  }

  const saveAudio = () => {
    if (saving()) return
    setSaving(true)
    setSaveError("")
    void props.controller
      .saveLatestAudio(savePath())
      .then(() => closeSaveDialog())
      .catch((error) => setSaveError(error instanceof Error ? error.message : String(error)))
      .finally(() => setSaving(false))
  }

  const closeRuntimeDialog = () => {
    setRuntimeDialogOpen(false)
    setFocus("editor")
    queueMicrotask(() => editor?.focus())
  }

  const chooseRuntime = (runtimeId: string) => {
    const modelId = selected()
    closeRuntimeDialog()
    void props.controller.setRuntime(modelId, runtimeId).catch(() => undefined)
  }

  const disposeBindings = props.keymap.registerLayer({
    enabled: () => !saveDialogOpen() && !runtimeDialogOpen(),
    commands: [
      {
        name: "app.quit",
        desc: "Quit Local TTS Lab",
        run() {
          renderer.destroy()
        },
      },
      {
        name: "app.focus-next",
        desc: "Move focus",
        run() {
          moveFocus(1)
        },
      },
      {
        name: "app.focus-previous",
        desc: "Move focus backward",
        run() {
          moveFocus(-1)
        },
      },
      {
        name: "tts.speak",
        desc: "Generate and play speech",
        run() {
          speak()
        },
      },
      {
        name: "model.retry",
        desc: "Retry selected model setup",
        run() {
          void props.controller.retry(selected()).catch(() => undefined)
        },
      },
      {
        name: "audio.save.open",
        desc: "Save the latest generated audio",
        run() {
          openSaveDialog()
        },
      },
      {
        name: "runtime.select.open",
        desc: "Choose the selected model runtime",
        run() {
          openRuntimeDialog()
        },
      },
    ],
    bindings: [
      { key: "escape", cmd: "app.quit" },
      { key: "ctrl+c", cmd: "app.quit" },
      { key: "tab", cmd: "app.focus-next" },
      { key: "shift+tab", cmd: "app.focus-previous" },
      { key: SPEAK_BINDING, cmd: "tts.speak" },
      { key: { name: "f2" }, cmd: "audio.save.open" },
      { key: { name: "f3" }, cmd: "runtime.select.open" },
      { key: "ctrl+r", cmd: "model.retry" },
    ],
  })
  const disposeSaveBindings = props.keymap.registerLayer({
    enabled: () => saveDialogOpen(),
    priority: 100,
    commands: [
      {
        name: "audio.save.close",
        run() {
          closeSaveDialog()
        },
      },
      {
        name: "audio.save.submit",
        run() {
          saveAudio()
        },
      },
    ],
    bindings: [
      { key: "escape", cmd: "audio.save.close" },
      { key: "return", cmd: "audio.save.submit" },
    ],
  })
  const disposeRuntimeBindings = props.keymap.registerLayer({
    enabled: () => runtimeDialogOpen(),
    priority: 100,
    commands: [
      {
        name: "runtime.select.close",
        run() {
          closeRuntimeDialog()
        },
      },
    ],
    bindings: [{ key: "escape", cmd: "runtime.select.close" }],
  })
  const disposeRuntimeScrollBindings = props.keymap.registerLayer({
    enabled: () => focus() === "runtime" && !saveDialogOpen() && !runtimeDialogOpen(),
    priority: 50,
    commands: [
      { name: "runtime.scroll.up", run: () => runtimeScroll?.scrollBy(-1, "step") },
      { name: "runtime.scroll.down", run: () => runtimeScroll?.scrollBy(1, "step") },
      { name: "runtime.scroll.page-up", run: () => runtimeScroll?.scrollBy(-1, "viewport") },
      { name: "runtime.scroll.page-down", run: () => runtimeScroll?.scrollBy(1, "viewport") },
      { name: "runtime.scroll.home", run: () => runtimeScroll?.scrollTo(0) },
      { name: "runtime.scroll.end", run: () => runtimeScroll?.scrollTo(Number.MAX_SAFE_INTEGER) },
    ],
    bindings: [
      { key: "up", cmd: "runtime.scroll.up" },
      { key: "down", cmd: "runtime.scroll.down" },
      { key: "pageup", cmd: "runtime.scroll.page-up" },
      { key: "pagedown", cmd: "runtime.scroll.page-down" },
      { key: "home", cmd: "runtime.scroll.home" },
      { key: "end", cmd: "runtime.scroll.end" },
    ],
  })
  onCleanup(() => {
    disposeBindings()
    disposeSaveBindings()
    disposeRuntimeBindings()
    disposeRuntimeScrollBindings()
  })

  onMount(() => {
    const unsubscribe = props.controller.subscribe((next) => {
      setStates((current) => ({ ...current, [next.id]: next }))
    })
    const unsubscribeSpectrum = props.controller.subscribeSpectrum(setSpectrum)
    const timer = setInterval(() => setTick((value) => value + 1), 120)
    onCleanup(() => {
      unsubscribe()
      unsubscribeSpectrum()
      clearInterval(timer)
    })
    choose("kokoro")
  })

  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={COLORS.background}>
      <box
        height={1}
        flexShrink={0}
        flexDirection="row"
        columnGap={1}
        alignItems="center"
        justifyContent="space-between"
        paddingX={1}
        backgroundColor={COLORS.header}
      >
        <text fg={COLORS.cyan} flexShrink={0}>TTS LAB / LOCAL VOICE CONSOLE</text>
        <text fg={COLORS.violet} truncate>{keyHints()}</text>
      </box>

      <box
        height={4}
        flexShrink={0}
        backgroundColor="transparent"
        border
        borderStyle="single"
        borderColor={focus() === "models" ? COLORS.cyan : COLORS.border}
        title=" MODELS "
        titleColor={focus() === "models" ? COLORS.cyan : COLORS.muted}
        titleAlignment="left"
      >
        <tab_select
          ref={(value) => (tabs = value)}
          focused={focus() === "models"}
          width="100%"
          height={2}
          options={options()}
          tabWidth={tabWidth()}
          backgroundColor="transparent"
          textColor={COLORS.muted}
          focusedBackgroundColor="transparent"
          focusedTextColor={COLORS.ink}
          selectedBackgroundColor="transparent"
          selectedTextColor={COLORS.cyan}
          selectedDescriptionColor={COLORS.cyan}
          showDescription={false}
          showUnderline
          showScrollArrows
          wrapSelection
          onChange={(_, option) => option?.value && choose(option.value as ModelId)}
          onSelect={(_, option) => option?.value && choose(option.value as ModelId)}
        />
      </box>

      <box flexGrow={1} flexDirection={stacked() ? "column" : "row"} overflow="hidden">
        <box
          width={composerWidth()}
          height={stacked() ? "56%" : "100%"}
          flexShrink={stacked() ? 1 : 0}
          flexDirection="column"
          backgroundColor="transparent"
        >
          <box
            height={compact() ? 5 : 6}
            flexShrink={0}
            flexDirection="column"
            paddingX={1}
            backgroundColor="transparent"
            border
            borderStyle="single"
            borderColor={focus() === "voices" ? COLORS.violet : COLORS.border}
            title={` VOICE BANK / ${selectedVoice().name} `}
            titleColor={focus() === "voices" ? COLORS.violet : COLORS.muted}
            titleAlignment="left"
          >
            <select
              focused={focus() === "voices" && availableVoices().length > 1}
              options={voiceOptions()}
              selectedIndex={voiceIndex()}
              height={compact() ? 3 : 4}
              backgroundColor="transparent"
              focusedBackgroundColor="transparent"
              focusedTextColor={COLORS.ink}
              textColor={COLORS.ink}
              selectedBackgroundColor="transparent"
              selectedTextColor={COLORS.violet}
              descriptionColor={COLORS.muted}
              selectedDescriptionColor={COLORS.violet}
              showDescription={!compact()}
              showSelectionIndicator
              showScrollIndicator
              wrapSelection
              onSelect={(_, option) => option?.value && chooseVoice(option.value as string)}
            />
          </box>

          <box
            flexGrow={1}
            flexDirection="column"
            border
            borderStyle="single"
            borderColor={focus() === "editor" ? COLORS.pink : COLORS.border}
            backgroundColor="transparent"
            overflow="hidden"
            title=" SCRIPT "
            titleColor={focus() === "editor" ? COLORS.pink : COLORS.muted}
            titleAlignment="left"
          >
            <textarea
              ref={(value) => (editor = value)}
              focused={focus() === "editor"}
              initialValue={text()}
              onContentChange={() => editor && setText(editor.plainText)}
              wrapMode="word"
              placeholder="Type something worth saying..."
              flexGrow={1}
              marginRight={1}
              padding={1}
              backgroundColor={COLORS.background}
              textColor={COLORS.ink}
              focusedBackgroundColor={COLORS.background}
              cursorColor={COLORS.pink}
            />
            <box
              height={1}
              flexShrink={0}
              flexDirection="row"
              justifyContent="space-between"
              paddingX={1}
              backgroundColor="transparent"
            >
              <text fg={COLORS.muted}>{text().length} chars</text>
              <text fg={canSpeak() ? COLORS.green : COLORS.muted} truncate>
                {canSpeak()
                  ? `${speakKeyLabel}  GENERATE + PLAY`
                  : synthesisActive()
                    ? "SYNTHESIS IN PROGRESS"
                    : busy()
                      ? "SETTING UP MODEL"
                      : "MODEL NOT READY"}
              </text>
            </box>
          </box>
        </box>

        <box
          width={stacked() ? "100%" : undefined}
          flexGrow={1}
          flexDirection="column"
          overflow="hidden"
        >
          <box
            flexGrow={1}
            flexDirection="column"
            border
            borderStyle="single"
            borderColor={focus() === "runtime" ? COLORS.cyan : COLORS.border}
            backgroundColor="transparent"
            overflow="hidden"
            title={` RUNTIME SIGNAL / ${state().resident ? "HOT" : "COLD"} `}
            titleColor={focus() === "runtime" ? COLORS.cyan : state().resident ? COLORS.green : COLORS.amber}
            titleAlignment="left"
          >
            <scrollbox
              ref={(value) => (runtimeScroll = value)}
              focused={focus() === "runtime"}
              flexGrow={1}
              scrollY
              scrollX={false}
              viewportCulling
              backgroundColor="transparent"
              contentOptions={{ flexDirection: "column", paddingX: 1, paddingTop: 1, paddingRight: 1 }}
              verticalScrollbarOptions={{
                visible: true,
                trackOptions: { backgroundColor: "transparent", foregroundColor: COLORS.border },
              }}
              horizontalScrollbarOptions={{ visible: false }}
            >
              <text fg={COLORS.ink} flexShrink={0}>{definition().tagline}</text>
              <text fg={COLORS.muted} flexShrink={0}>{definition().footprint} · {definition().license}</text>
              <text fg={COLORS.violet} flexShrink={0}>VOICE / {selectedVoice().name}</text>
              <text fg={COLORS.cyan} flexShrink={0}>RUNTIME / {selectedRuntime().name}</text>
              <text fg={COLORS.muted} wrapMode="word" flexShrink={0}>{selectedVoice().description}</text>

              <box height={1} flexShrink={0} />
              <text fg={statusColor(state())} wrapMode="word" flexShrink={0}>
                {state().phase.toUpperCase()} / {state().detail}
              </text>
              <text fg={state().resident ? COLORS.green : COLORS.muted} flexShrink={0}>
                Worker {state().resident ? "resident · warm requests enabled" : "lazy · starts on first request"}
              </text>
              <For each={latencyItems()}>
                {(latency) => (
                  <text fg={COLORS.cyan} wrapMode="word" flexShrink={0}>
                    {latency.warm ? "WARM" : "COLD"} · load {latency.warm ? "cached" : shortDuration(latency.loadMs)} · synth {shortDuration(latency.generationMs)} · audio {shortDuration(latency.playbackMs)}
                  </text>
                )}
              </For>

              <box height={1} flexShrink={0} />
              <text fg={COLORS.green} flexShrink={0}>PERFORMANCE</text>
              <For each={state().runtimeStats ? [state().runtimeStats!] : []}>
                {(stats) => (
                  <>
                    <text fg={COLORS.ink} flexShrink={0}>Samples {stats.sampleCount}</text>
                    <text fg={COLORS.cyan} flexShrink={0}>
                      Generation avg {stats.sampleCount ? shortDuration(stats.averageGenerationMs) : "-"} · median {stats.sampleCount ? shortDuration(stats.medianGenerationMs) : "-"}
                    </text>
                    <text fg={COLORS.muted} flexShrink={0}>
                      Range {stats.sampleCount ? `${shortDuration(stats.minGenerationMs)} - ${shortDuration(stats.maxGenerationMs)}` : "-"}
                    </text>
                  </>
                )}
              </For>
              <For each={state().runtimeStats ? [] : [true]}>
                {() => <text fg={COLORS.muted} flexShrink={0}>No generation samples yet</text>}
              </For>

              <box height={1} flexShrink={0} />
              <text fg={COLORS.violet} flexShrink={0}>RESOURCES</text>
              <For each={state().runtimeStats ? [state().runtimeStats!] : []}>
                {(stats) => (
                  <>
                    <text fg={COLORS.ink} flexShrink={0}>App RSS {humanBytes(stats.appRssBytes)}</text>
                    <text fg={COLORS.muted} flexShrink={0}>JS heap {humanBytes(stats.appHeapUsedBytes)}</text>
                    <For each={stats.workerRssBytes ? [stats.workerRssBytes] : []}>
                      {(rss) => <text fg={COLORS.ink} flexShrink={0}>Worker RSS {humanBytes(rss)}</text>}
                    </For>
                    <For each={stats.workerPeakRssBytes ? [stats.workerPeakRssBytes] : []}>
                      {(rss) => <text fg={COLORS.muted} flexShrink={0}>Worker peak RSS {humanBytes(rss)}</text>}
                    </For>
                    <text fg={COLORS.muted} wrapMode="word" flexShrink={0}>Process-level memory; model-only allocation is not exposed.</text>
                  </>
                )}
              </For>
              <For each={state().runtimeStats ? [] : [true]}>
                {() => <text fg={COLORS.muted} flexShrink={0}>Available after the runtime starts</text>}
              </For>

              <box height={1} flexShrink={0} />
              <text fg={COLORS.amber} flexShrink={0}>ENVIRONMENT</text>
              <ProgressBar
                value={state().setupProgress}
                width={progressWidth()}
                tick={tick()}
                color={COLORS.amber}
              />
              <For each={state().totalBytes ? [state()] : []}>
                {() => (
                  <>
                    <text fg={COLORS.muted} truncate flexShrink={0}>
                      Assets {humanBytes(state().downloadedBytes)} / {humanBytes(state().totalBytes)}
                    </text>
                    <ProgressBar
                      value={state().downloadedBytes / state().totalBytes}
                      width={progressWidth()}
                      tick={tick()}
                      color={COLORS.cyan}
                    />
                  </>
                )}
              </For>

              <For each={state().phase === "generating" ? [state()] : []}>
                {() => (
                  <>
                    <text fg={COLORS.pink} flexShrink={0}>SYNTHESIS</text>
                  <ProgressBar
                    value={state().generationProgress}
                    width={progressWidth()}
                    tick={tick()}
                    color={COLORS.pink}
                  />
                  </>
                )}
              </For>

            </scrollbox>
            <box
              height={1}
              flexShrink={0}
              flexDirection="row"
              justifyContent="flex-end"
              paddingX={1}
              backgroundColor="transparent"
            >
              <text fg={focus() === "runtime" ? COLORS.cyan : COLORS.muted} truncate>
                SCROLL · ↑↓ · PGUP/PGDN · HOME/END
              </text>
            </box>
          </box>
          <Spectrum levels={spectrum()} rowCount={spectrumRowCount()} />
        </box>
      </box>

      <box
        position="absolute"
        left="50%"
        top="50%"
        width={dialogWidth()}
        height={7}
        marginLeft={-Math.floor(dialogWidth() / 2)}
        marginTop={-3}
        zIndex={100}
        visible={saveDialogOpen()}
        flexDirection="column"
        border
        borderStyle="single"
        borderColor={saveError() ? COLORS.red : COLORS.cyan}
        title=" SAVE AUDIO "
        titleColor={saveError() ? COLORS.red : COLORS.cyan}
        titleAlignment="center"
        paddingX={1}
        backgroundColor={COLORS.background}
      >
        <text fg={COLORS.muted} flexShrink={0}>Enter save · Esc cancel</text>
        <input
          ref={(value) => (saveInput = value)}
          focused={saveDialogOpen()}
          value={savePath()}
          onInput={setSavePath}
          onSubmit={saveAudio}
          width="100%"
          backgroundColor={COLORS.background}
          focusedBackgroundColor={COLORS.background}
          textColor={COLORS.ink}
          focusedTextColor={COLORS.ink}
          cursorColor={COLORS.pink}
          placeholder="/path/to/audio.wav"
        />
        <text fg={saveError() ? COLORS.red : COLORS.muted} wrapMode="word" flexShrink={0}>
          {saveError() || (saving() ? "Saving..." : "Existing files are not overwritten")}
        </text>
      </box>

      <box
        position="absolute"
        left="50%"
        top="50%"
        width={dialogWidth()}
        height={Math.min(10, definition().runtimes.length * 2 + 4)}
        marginLeft={-Math.floor(dialogWidth() / 2)}
        marginTop={-Math.min(5, Math.floor((definition().runtimes.length * 2 + 4) / 2))}
        zIndex={100}
        visible={runtimeDialogOpen()}
        flexDirection="column"
        border
        borderStyle="single"
        borderColor={COLORS.cyan}
        title={` ${definition().name.toUpperCase()} RUNTIME `}
        titleColor={COLORS.cyan}
        titleAlignment="center"
        paddingX={1}
        backgroundColor={COLORS.background}
      >
        <text fg={COLORS.muted} flexShrink={0}>Up/down choose · Enter select · Esc cancel</text>
        <select
          ref={(value) => (runtimeSelect = value)}
          focused={runtimeDialogOpen()}
          options={runtimeOptions()}
          selectedIndex={runtimeIndex()}
          flexGrow={1}
          backgroundColor="transparent"
          focusedBackgroundColor="transparent"
          textColor={COLORS.ink}
          focusedTextColor={COLORS.ink}
          selectedBackgroundColor="transparent"
          selectedTextColor={COLORS.cyan}
          descriptionColor={COLORS.muted}
          selectedDescriptionColor={COLORS.cyan}
          showDescription
          showSelectionIndicator
          wrapSelection
          onSelect={(_, option) => option?.value && chooseRuntime(option.value as string)}
        />
      </box>

    </box>
  )
}
