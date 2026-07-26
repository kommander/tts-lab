# tts-runtime-core

Shared Node 22+/Bun primitives for internal TTS runtime packages:

- Resumable downloads with size and SHA-256 verification.
- Subprocess-tree execution, cancellation, logging, and output capture.
- Ref-counted shared uv bootstrap.
- Persistent NDJSON runtime workers and resource events.

The package performs no work at import time.
