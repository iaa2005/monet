---
title: Providers and models
description: Step by step — connecting a hosted provider, running a model locally, and what every per-model field does.
order: 1
---

A provider is one endpoint, one key, and a list of models. You can have as many
as you like and switch between them per chat from the composer.

## Adding a hosted provider

1. **Settings → Providers → Add provider**.
2. Pick the **kind**. This is not cosmetic — it selects the wire protocol:
   - **Anthropic** — the Messages API.
   - **DeepSeek (Anthropic compat)** — DeepSeek's Anthropic-compatible endpoint.
   - **OpenRouter** — one key, many vendors, with its own model browser.
   - **OpenAI Compatible** — the `/v1/chat/completions` shape that most servers
     speak, including every local one.
3. The **Base URL** is filled in for you. Change it only if you use a proxy or a
   regional endpoint.
4. Paste the **API key**.
5. Add at least one model, or press **Load models from this endpoint**.
6. **Save**.

The key is encrypted by the operating system's own keystore — DPAPI on Windows,
Keychain on macOS — and never written to a readable file.

### Where to get a key

| Provider | Where |
| --- | --- |
| Anthropic | console.anthropic.com → API keys |
| DeepSeek | platform.deepseek.com → API keys |
| OpenAI | platform.openai.com → API keys |
| OpenRouter | openrouter.ai/keys |

## Running a model on your own machine

A local model needs no key and no extra software beyond the server itself.

### Ollama

```shell
# install from ollama.com, then pull a model
ollama pull qwen2.5:7b
# the server runs on 11434 automatically
```

In Code Monet: **Add provider** → kind **OpenAI Compatible** → Base URL
`http://localhost:11434/v1` → leave the key **empty** → **Load models from this
endpoint**.

### LM Studio

Load a model, open the **Developer / Local Server** tab, press **Start**. Base
URL is `http://localhost:1234/v1`.

### llama.cpp

```shell
llama-server -m model.gguf --port 8080
```

Base URL `http://localhost:8080/v1`.

> [!NOTE]
> No `Authorization` header is sent when the key field is empty. Some local
> servers reject an empty bearer token, which is why this matters.

### Choosing a local model size

A 7–8B model is enough for background work — memory notes, digests, drafting a
routine. Driving the main conversation with tools well needs considerably more;
if a local model loops or ignores tool schemas, that is usually the reason
rather than a bug.

## Per-model fields

Each model row carries its own settings. They matter more than they look.

| Field | What it does | Getting it wrong |
| --- | --- | --- |
| **Name** | The id sent to the API | A typo is a 404 at request time |
| **Label** | Display name in the picker | Cosmetic |
| **Context length** | Total window, in tokens | Too high: requests fail near the limit. Too low: compaction fires early and needlessly |
| **Max output tokens** | Cap on one reply | Too low truncates long answers mid-structure |
| **Temperature** | Sampling randomness | Leave unset unless you have a reason |
| **Base URL** | Overrides the provider's, per model | For a mixed setup |
| **Modalities** | Whether it accepts images, audio, files | If unchecked, attachments of that kind are saved to the workspace instead of sent inline |

> [!WARNING]
> **Context length** is what compaction plans against. If you set 200k on a
> model that actually holds 32k, the app will happily fill the window and the
> provider will reject the request.

## Switching models mid-conversation

The composer's picker changes the model for the next turn; the conversation
continues. Moving to a model with a smaller window may trigger compaction
immediately.

## Troubleshooting

**401 / "x-api-key header is required"** — the key is missing or was saved on a
different provider row than the one in use.

**404 on the model name** — the name is the API id, not the display name.
Press **Load models from this endpoint** to get the exact ids.

**Connection refused on localhost** — the server is not running, or is on a
different port. Check the URL in a browser: `/v1/models` should return JSON.

**Empty replies from a reasoning model** — the answer was cut off before it
began. Raise **Max output tokens**; thinking is billed out of the same budget.
