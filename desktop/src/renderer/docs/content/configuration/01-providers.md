---
title: Providers and models
description: Connecting a model — hosted or running on your own machine.
order: 1
---

A provider is an endpoint plus a key plus a list of models. You can have several
and switch between them per chat.

## Hosted providers

Anthropic, DeepSeek, OpenAI and OpenRouter have presets: pick one, paste your
key, done. Keys are encrypted at rest by the operating system's own keystore
(DPAPI on Windows, Keychain on macOS) and never written to a plain file.

## Local models

A model running on your own machine works with no extra software and no key.
Ollama, LM Studio, llama.cpp's server and vLLM all speak the OpenAI-compatible
protocol Code Monet already implements.

1. Add a provider of kind **OpenAI Compatible**.
2. Set the Base URL to your server — Ollama is `http://localhost:11434/v1`,
   LM Studio `http://localhost:1234/v1`, llama-server `http://localhost:8080/v1`.
3. Leave the API key empty.
4. Press **Load models from this endpoint** to pull in what it has loaded.

> [!NOTE]
> No Authorization header is sent when the key is empty — some local servers
> reject an empty bearer token.

## Per-model settings

Each model carries its own context window, output budget, temperature, input
modalities, and optionally its own Base URL. Compaction uses the context window
you set here, so an inaccurate value shows up as premature or overdue
compaction.
