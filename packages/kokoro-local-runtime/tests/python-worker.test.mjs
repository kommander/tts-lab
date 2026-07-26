import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { test } from "node:test"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"

const exec = promisify(execFile)
const workerPath = fileURLToPath(new URL("../resources/kokoro_worker.py", import.meta.url))

test("strictly parses and forwards Python Kokoro speed", async () => {
  const script = String.raw`
import importlib.util
import sys
import types
from pathlib import Path

spec = importlib.util.spec_from_file_location("kokoro_worker", sys.argv[1])
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)

assert worker.parse_parameters() == 1.0
assert worker.parse_parameters({}) == 1.0
assert worker.parse_parameters({"speed": 1.4}) == 1.4
for invalid in (None, [], {"pitch": 1}, {"speed": True}, {"speed": "1"}, {"speed": 0.4}, {"speed": 1.05}):
    try:
        worker.parse_parameters(invalid)
    except ValueError:
        pass
    else:
        raise AssertionError(f"accepted invalid parameters: {invalid!r}")

calls = []

class Availability:
    @staticmethod
    def is_available():
        return False

class Model:
    def __init__(self, **kwargs):
        pass
    def to(self, device):
        return self
    def eval(self):
        return self

class Audio:
    def numpy(self):
        return [0.0]

class Result:
    audio = Audio()

class Pipeline:
    def __init__(self, **kwargs):
        pass
    def load_voice(self, path):
        pass
    def __call__(self, text, **kwargs):
        calls.append(kwargs)
        return [Result()]

torch = types.ModuleType("torch")
torch.cuda = Availability()
torch.backends = types.SimpleNamespace(mps=Availability())
kokoro = types.ModuleType("kokoro")
kokoro.KModel = Model
kokoro.KPipeline = Pipeline
numpy = types.ModuleType("numpy")
numpy.concatenate = lambda chunks: chunks[0]
soundfile = types.ModuleType("soundfile")
soundfile.write = lambda *args: None
sys.modules.update(torch=torch, kokoro=kokoro, numpy=numpy, soundfile=soundfile)

synthesize = worker.load_kokoro(Path("/unused"))
synthesize("hello", Path("/unused/output.wav"), speed=1.4)
assert calls == [{"voice": "/unused/voices/af_heart.pt", "speed": 1.4}]
`
  const result = await exec("python3", ["-c", script, workerPath])
  assert.equal(result.stderr, "")
})
