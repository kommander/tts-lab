import type { KeyEvent, Renderable, TabSelectRenderable, TextareaRenderable } from "@opentui/core"
import type { Keymap } from "@opentui/keymap"
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal, For, onCleanup, onMount } from "solid-js"
import { MODEL_BY_ID, MODELS } from "./models.js"
import type { DemoController, ModelId, ModelState } from "./types.js"

const COLORS = {
  background: "#0B0D0C",
  panel: "#121713",
  panelRaised: "#19211B",
  panelBright: "#243028",
  editor: "#151B17",
  header: "#0E1210",
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

export const SPEAK_BINDING = "ctrl+g"

export function App(props: { controller: DemoController; keymap: Keymap<Renderable, KeyEvent> }) {
  const renderer = useRenderer()
  const dimensions = useTerminalDimensions()
  const speakKeyLabel = props.keymap.formatKey(SPEAK_BINDING).toUpperCase()
  const initial = props.controller.snapshot()
  const [states, setStates] = createSignal(initial)
  const [selected, setSelected] = createSignal<ModelId>("kokoro")
  const [focus, setFocus] = createSignal<"models" | "voices" | "editor">("models")
  const [text, setText] = createSignal("Local speech should be simple, private, and a little bit delightful.")
  const [tick, setTick] = createSignal(0)
  let editor: TextareaRenderable | undefined
  let tabs: TabSelectRenderable | undefined

  const state = createMemo(() => states()[selected()])
  const definition = createMemo(() => MODEL_BY_ID[selected()])
  const selectedVoice = createMemo(
    () => definition().voices.find((voice) => voice.id === state().voiceId) ?? definition().voices[0]!,
  )
  const voiceOptions = createMemo(() =>
    definition().voices.map((voice) => ({ name: voice.name, description: voice.description, value: voice.id })),
  )
  const voiceIndex = createMemo(() => Math.max(0, definition().voices.findIndex((voice) => voice.id === state().voiceId)))
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
  const keyHints = createMemo(() =>
    veryNarrow()
      ? `TAB focus  ${speakKeyLabel} speak`
      : `TAB focus  ${speakKeyLabel} speak  CTRL+R retry  ESC quit`,
  )
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
    const targets: Array<"models" | "voices" | "editor"> =
      definition().voices.length > 1 ? ["models", "voices", "editor"] : ["models", "editor"]
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

  const disposeBindings = props.keymap.registerLayer({
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
    ],
    bindings: [
      { key: "escape", cmd: "app.quit" },
      { key: "ctrl+c", cmd: "app.quit" },
      { key: "tab", cmd: "app.focus-next" },
      { key: "shift+tab", cmd: "app.focus-previous" },
      { key: SPEAK_BINDING, cmd: "tts.speak" },
      { key: "ctrl+r", cmd: "model.retry" },
    ],
  })
  onCleanup(disposeBindings)

  onMount(() => {
    const unsubscribe = props.controller.subscribe((next) => {
      setStates((current) => ({ ...current, [next.id]: next }))
    })
    const timer = setInterval(() => setTick((value) => value + 1), 120)
    onCleanup(() => {
      unsubscribe()
      clearInterval(timer)
    })
    choose("kokoro")
  })

  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={COLORS.background}>
      <box
        height={3}
        flexShrink={0}
        flexDirection="row"
        columnGap={1}
        alignItems="center"
        justifyContent="space-between"
        paddingX={1}
        backgroundColor={COLORS.header}
      >
        <box flexDirection="column" flexShrink={0}>
          <text fg={COLORS.cyan}>TTS LAB / LOCAL VOICE CONSOLE</text>
          <text fg={COLORS.muted}>five engines · private inference · native playback</text>
        </box>
        <text fg={COLORS.violet} truncate>{keyHints()}</text>
      </box>

      <box
        height={4}
        flexShrink={0}
        backgroundColor={COLORS.panel}
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
          backgroundColor={COLORS.panel}
          textColor={COLORS.muted}
          focusedBackgroundColor={COLORS.panel}
          focusedTextColor={COLORS.ink}
          selectedBackgroundColor={COLORS.panel}
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
          border
          borderStyle="single"
          borderColor={COLORS.border}
          backgroundColor={COLORS.panel}
        >
          <box
            height={2}
            flexShrink={0}
            flexDirection="row"
            alignItems="center"
            justifyContent="space-between"
            paddingX={1}
            backgroundColor={COLORS.panelBright}
          >
            <text fg={COLORS.cyan}>COMPOSE / {definition().name.toUpperCase()}</text>
            <text fg={COLORS.muted} truncate>{selectedVoice().name}</text>
          </box>

          <box
            height={compact() ? 6 : 7}
            flexShrink={0}
            flexDirection="column"
            paddingX={1}
            backgroundColor={COLORS.panel}
            border
            borderStyle="single"
            borderColor={focus() === "voices" ? COLORS.violet : COLORS.border}
          >
            <text fg={focus() === "voices" ? COLORS.violet : COLORS.muted}>VOICE BANK</text>
            <select
              focused={focus() === "voices" && definition().voices.length > 1}
              options={voiceOptions()}
              selectedIndex={voiceIndex()}
              height={compact() ? 3 : 4}
              backgroundColor={COLORS.panel}
              focusedBackgroundColor={COLORS.panel}
              focusedTextColor={COLORS.ink}
              textColor={COLORS.ink}
              selectedBackgroundColor={COLORS.panel}
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
            backgroundColor={COLORS.editor}
            overflow="hidden"
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
              backgroundColor={COLORS.editor}
              textColor={COLORS.ink}
              focusedBackgroundColor={COLORS.editor}
              cursorColor={COLORS.pink}
            />
          </box>

          <box
            height={1}
            flexShrink={0}
            flexDirection="row"
            justifyContent="space-between"
            paddingX={1}
            backgroundColor={COLORS.panelBright}
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

        <box
          width={stacked() ? "100%" : undefined}
          flexGrow={1}
          flexDirection="column"
          border
          borderStyle="single"
          borderColor={COLORS.border}
          backgroundColor={COLORS.panel}
          overflow="hidden"
        >
          <box
            height={2}
            flexShrink={0}
            flexDirection="row"
            alignItems="center"
            justifyContent="space-between"
            paddingX={1}
            backgroundColor={COLORS.panelBright}
          >
            <text fg={COLORS.amber}>RUNTIME SIGNAL</text>
            <text fg={state().resident ? COLORS.green : COLORS.muted}>
              {state().resident ? "● HOT" : "○ COLD"}
            </text>
          </box>

          <box flexGrow={1} flexDirection="column" paddingX={1} paddingTop={1} overflow="hidden">
            <text fg={COLORS.ink} flexShrink={0}>{definition().tagline}</text>
            <text fg={COLORS.muted} flexShrink={0}>{definition().footprint} · {definition().license}</text>
            <text fg={COLORS.violet} flexShrink={0}>VOICE / {selectedVoice().name}</text>
            <For each={compact() ? [] : [selectedVoice()]}>
              {(voice) => <text fg={COLORS.muted} wrapMode="word" flexShrink={0}>{voice.description}</text>}
            </For>

            <For each={compact() ? [] : [true]}>{() => <box height={1} flexShrink={0} />}</For>
            <text fg={statusColor(state())} bg={COLORS.panelBright} wrapMode="word" flexShrink={0}>
              {state().phase.toUpperCase()} / {state().detail}
            </text>
            <For each={compact() ? [] : [state()]}>
              {(current) => (
                <text fg={current.resident ? COLORS.green : COLORS.muted} flexShrink={0}>
                  Worker {current.resident ? "resident · warm requests enabled" : "lazy · starts on first request"}
                </text>
              )}
            </For>
            <For each={compact() ? [] : latencyItems()}>
              {(latency) => (
                <text fg={COLORS.cyan} wrapMode="word" flexShrink={0}>
                  {latency.warm ? "WARM" : "COLD"} · load {latency.warm ? "cached" : shortDuration(latency.loadMs)} · synth {shortDuration(latency.generationMs)} · audio {shortDuration(latency.playbackMs)}
                </text>
              )}
            </For>

            <For each={compact() ? [] : [true]}>{() => <box height={1} flexShrink={0} />}</For>
            <text fg={COLORS.amber} flexShrink={0}>ENVIRONMENT</text>
            <ProgressBar
              value={state().setupProgress}
              width={progressWidth()}
              tick={tick()}
              color={COLORS.amber}
            />
            <text fg={COLORS.muted} truncate flexShrink={0}>
              Assets {humanBytes(state().downloadedBytes)} / {humanBytes(state().totalBytes)}
            </text>
            <ProgressBar
              value={state().totalBytes ? state().downloadedBytes / state().totalBytes : 0}
              width={progressWidth()}
              tick={tick()}
              color={COLORS.cyan}
            />

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

            <box flexGrow={1} />
            <For each={compact() ? [] : [definition()]}>
              {(model) => (
                <>
                  <text fg={COLORS.muted} wrapMode="word" flexShrink={0}>{model.note}</text>
                </>
              )}
            </For>
          </box>
        </box>
      </box>

    </box>
  )
}
