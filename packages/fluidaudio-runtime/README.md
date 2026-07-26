# fluidaudio-runtime

Internal FluidAudio 0.15.5 sidecar builder and launcher shared by Kokoro and Pocket TTS.

The package ships pinned Swift source and `Package.resolved`, but no generated binary or model data. `FluidAudioBuilder.build()` explicitly compiles into `<homeDir>/tools/fluidaudio-0.15.5-v2`, serializes concurrent callers, and reuses an existing executable. Import and package installation do not invoke Swift or download models.
