import type { KeyEvent, Renderable, TabSelectRenderable, TextareaRenderable } from "@opentui/core"
import type { Keymap } from "@opentui/keymap"
import { useRenderer } from "@opentui/solid"
import { createMemo, createSignal, For, onCleanup, onMount } from "solid-js"
import { MODEL_BY_ID, MODELS } from "./models.js"
import type { DemoController, ModelId, ModelState } from "./types.js"

const COLORS = {
  background: "#0b1014",
  panel: "#111a20",
  panelRaised: "#17232b",
  ink: "#d8e2df",
  muted: "#758b88",
  green: "#86d39a",
  cyan: "#73c8d4",
  amber: "#e8b86d",
  red: "#ec7f7f",
  border: "#2a3d43",
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
    <text fg={props.color ?? COLORS.cyan}>
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
  const speakKeyLabel = props.keymap.formatKey(SPEAK_BINDING).toUpperCase()
  const initial = props.controller.snapshot()
  const [states, setStates] = createSignal(initial)
  const [selected, setSelected] = createSignal<ModelId>("kokoro")
  const [focus, setFocus] = createSignal<"models" | "editor">("models")
  const [text, setText] = createSignal("Local speech should be simple, private, and a little bit delightful.")
  const [notice, setNotice] = createSignal("Select a model; setup starts automatically.")
  const [tick, setTick] = createSignal(0)
  let editor: TextareaRenderable | undefined
  let tabs: TabSelectRenderable | undefined

  const state = createMemo(() => states()[selected()])
  const definition = createMemo(() => MODEL_BY_ID[selected()])
  const latencyItems = createMemo(() => getLatencyItems(state()))
  const busy = createMemo(() => !["idle", "ready", "playing", "error"].includes(state().phase))
  const synthesisActive = createMemo(() =>
    MODELS.some(({ id }) => ["generating", "playing"].includes(states()[id].phase)),
  )
  const canSpeak = createMemo(() => state().installed && !busy() && !synthesisActive() && text().trim().length > 0)
  const options = createMemo(() =>
    MODELS.map((model) => ({
      name: `${states()[model.id].installed ? "+" : states()[model.id].phase === "error" ? "!" : " "} ${model.name}`,
      description: model.tagline,
      value: model.id,
    })),
  )

  const choose = (id: ModelId) => {
    setSelected(id)
    setNotice(`${MODEL_BY_ID[id].name} selected`)
    void props.controller.ensure(id).catch((error) => setNotice(error instanceof Error ? error.message : String(error)))
  }

  const speak = () => {
    if (!canSpeak()) {
      if (synthesisActive()) {
        setNotice("Another synthesis is already running.")
        return
      }
      if (!state().installed) void props.controller.ensure(selected())
      setNotice(state().installed ? "Enter text before speaking." : "Model setup is still running.")
      return
    }
    setNotice(`Generating with ${definition().name}...`)
    void props.controller
      .speak(selected(), text())
      .then(() => setNotice("Audio is playing through OpenTUI."))
      .catch((error) => setNotice(error instanceof Error ? error.message : String(error)))
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
          setFocus((current) => (current === "models" ? "editor" : "models"))
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
      { key: "shift+tab", cmd: "app.focus-next" },
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
    <box width="100%" height="100%" flexDirection="column" backgroundColor={COLORS.background} padding={1} gap={1}>
      <box height={3} flexDirection="row" alignItems="center" justifyContent="space-between" paddingX={1}>
        <box flexDirection="column">
          <text fg={COLORS.green}>LOCAL / TTS LAB</text>
          <text fg={COLORS.muted}>five engines, one quiet terminal</text>
        </box>
        <text fg={COLORS.muted} truncate> TAB focus  {speakKeyLabel} speak  CTRL+R retry  ESC quit</text>
      </box>

      <box
        height={5}
        border={["top", "bottom"]}
        borderColor={focus() === "models" ? COLORS.cyan : COLORS.border}
        backgroundColor={COLORS.panel}
        paddingX={1}
        flexDirection="column"
      >
        <text fg={COLORS.muted}>MODEL RACK</text>
        <tab_select
          ref={(value) => (tabs = value)}
          focused={focus() === "models"}
          options={options()}
          tabWidth={15}
          onChange={(_, option) => option?.value && choose(option.value as ModelId)}
          onSelect={(_, option) => option?.value && choose(option.value as ModelId)}
        />
      </box>

      <box flexGrow={1} minHeight={14} flexDirection="row" gap={1}>
        <box
          width="67%"
          flexDirection="column"
          border
          borderStyle="rounded"
          borderColor={focus() === "editor" ? COLORS.green : COLORS.border}
          title={` SPEAK WITH ${definition().name.toUpperCase()} `}
          titleColor={COLORS.green}
          padding={1}
          gap={1}
        >
          <textarea
            ref={(value) => (editor = value)}
            focused={focus() === "editor"}
            initialValue={text()}
            onContentChange={() => editor && setText(editor.plainText)}
            wrapMode="word"
            placeholder="Type something worth saying..."
            flexGrow={1}
            minHeight={7}
            backgroundColor={COLORS.panelRaised}
            textColor={COLORS.ink}
            focusedBackgroundColor={COLORS.panelRaised}
            cursorColor={COLORS.green}
          />
          <box height={1} flexDirection="row" justifyContent="space-between">
            <text fg={COLORS.muted}>{text().length} characters</text>
            <text fg={canSpeak() ? COLORS.green : COLORS.muted}>
              {canSpeak()
                ? `${speakKeyLabel}  SAY IT`
                : synthesisActive()
                  ? "SYNTHESIS IN PROGRESS..."
                  : busy()
                    ? "SETTING UP MODEL..."
                    : "MODEL NOT READY"}
            </text>
          </box>
        </box>

        <box
          flexGrow={1}
          flexDirection="column"
          border
          borderStyle="rounded"
          borderColor={COLORS.border}
          title=" SIGNAL "
          titleColor={COLORS.amber}
          padding={1}
          gap={1}
        >
          <text fg={COLORS.ink}>{definition().tagline}</text>
          <text fg={COLORS.muted}>{definition().footprint}</text>
          <text fg={COLORS.muted}>{definition().license}</text>
          <text fg={COLORS.cyan}>Voice: {definition().voice}</text>
          <box height={1} />
          <text fg={statusColor(state())}>{state().phase.toUpperCase()} / {state().detail}</text>
          <text fg={state().resident ? COLORS.green : COLORS.muted}>
            Worker: {state().resident ? "HOT / model resident" : "COLD / starts on first use"}
          </text>
          <For each={latencyItems()}>
            {(latency) => (
              <text fg={COLORS.cyan} wrapMode="word">
                Last {latency.warm ? "warm" : "cold"}: load {latency.warm ? "cached" : shortDuration(latency.loadMs)} | synth {shortDuration(latency.generationMs)} | audio {shortDuration(latency.playbackMs)}
              </text>
            )}
          </For>

          <text fg={COLORS.muted}>Environment</text>
          <ProgressBar value={state().setupProgress} tick={tick()} color={COLORS.amber} />

          <text fg={COLORS.muted}>
            Pinned model assets {humanBytes(state().downloadedBytes)} / {humanBytes(state().totalBytes)}
          </text>
          <ProgressBar
            value={state().totalBytes ? state().downloadedBytes / state().totalBytes : 0}
            tick={tick()}
            color={COLORS.cyan}
          />

          {state().phase === "generating" ? (
            <>
              <text fg={COLORS.muted}>Synthesis</text>
              <ProgressBar value={state().generationProgress} tick={tick()} color={COLORS.green} />
            </>
          ) : null}

          <box flexGrow={1} />
          <text fg={COLORS.muted}>Log: .tts-lab/logs/{selected()}.log</text>
          <text fg={COLORS.muted} wrapMode="word">{definition().note}</text>
        </box>
      </box>

      <box height={2} paddingX={1} flexDirection="row" justifyContent="space-between" alignItems="center">
        <text fg={state().phase === "error" ? COLORS.red : COLORS.muted}>{notice()}</text>
        <text fg={COLORS.muted}>data: .tts-lab/</text>
      </box>
    </box>
  )
}
