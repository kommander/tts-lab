import { createCliRenderer } from "@opentui/core"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { render } from "@opentui/solid"
import { App } from "./App.js"
import { ModelManager } from "./lib/model-manager.js"

const manager = new ModelManager()
const renderer = await createCliRenderer({
  targetFps: 30,
  exitOnCtrlC: false,
  useMouse: false,
  onDestroy: () => manager.dispose(),
})
const keymap = createDefaultOpenTuiKeymap(renderer)

await render(() => <App controller={manager} keymap={keymap} />, renderer)
