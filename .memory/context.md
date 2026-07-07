# Контекст проекта

## Что это

Десктопный AI-агент на базе утекшего кода Claude Code (Anthropic).
Утекший код — ~1884 TypeScript/React файлов, извлечённых из sourcemap
npm-пакета `@anthropic-ai/claude-code` v2.1.88 (31 марта 2026).

## Технологический стек (планируемый)

- **Runtime:** Electron 33 (доступ к Node.js + Chromium)
- **Frontend:** React 19 + TypeScript + shadcn/ui (Tailwind)
- **UI Kit:** shadcn/ui: Attachment, Bubble, Message, Marker, Message Scroller, Card, Dialog, Sheet, Tabs, Button, Input, Select, Textarea, ScrollArea, Table, Badge
- **State:** Zustand
- **База:** better-sqlite3 (история сессий)
- **LLM-клиенты:** Свой HTTP-клиент для Anthropic API + `@ai-sdk/openai` для OpenAI-совместимых (llama.cpp)
- **Бандлер:** Vite (electron-vite)
- **Сборка:** electron-builder (.exe/.dmg/.AppImage)
- **Шифрование:** Electron safeStorage (DPAPI/Keychain/libsecret)
- **Терминал:** node-pty + xterm.js
- **Песочница:** @anthropic-ai/sandbox-runtime (экспериментальный, shim в MVP)

## Архитектура

Все нужные файлы из утекшего кода (~300-500) копируются в `desktop/src/vendor/leaked/`.
Папка `desktop/` полностью автономна — скопировал → `npm install && npm run dev` → работает.

## Ключевые модули из утекшего кода

- `tools/` (45 папок) — все инструменты: BashTool, FileRead/Write/Edit, Glob, Grep, WebFetch, WebSearch, Agent, Task, MCP...
- `constants/prompts.ts` (54 КБ) — системные промпты
- `memdir/` (8 файлов) — память и CLAUDE.md
- `skills/bundled/` (17 файлов) — встроенные навыки
- `services/mcp/` (24 файла) — MCP интеграция
- `services/api/claude.ts`, `client.ts`, `errors.ts`, `logging.ts` — API-слой
- `utils/bash/parser.ts` (~4.4 КБ строк) — безопасный парсер bash
- `utils/permissions/` (25 файлов) — система разрешений
- `utils/git.ts` + `gitDiff.ts` (~46 КБ) — Git
- `QueryEngine.ts`, `query.ts`, `cost-tracker.ts`, `Tool.ts`, `Task.ts`, `commands.ts`

## Что НЕ существует

- `types/message.ts` — **единственный отсутствующий файл** (163 импорта). Нужно создать с нуля (~30 типов, ~500-1000 строк). Отсутствует во ВСЕХ источниках — и в оригинальном архиве, и в renepardon/claude-code зеркале. Похоже, такого файла никогда не было — типы были распределены или генерировались.

## Что НЕ берём

- `ink/` (~50 файлов) — терминальный React-рендерер
- `components/` (~200 файлов) — UI для терминала
- `cli/`, `commands/` — CLI-интерфейс
- `bridge/` (~20 файлов) — удалённые сессии
- `buddy/` — тамагочи
- `entrypoints/` — точки входа CLI
- `bootstrap/` — глобальное состояние (shim)
- `hooks/` (~80 файлов) — React-хуки для терминала
- `coordinator/` — координатор агентов (не в MVP)

## Ссылки

- План: `.plans/desktop-agent.md`
- Структура: `STRUCTURE.md`
- sandbox-runtime: https://github.com/anthropic-experimental/sandbox-runtime (Apache 2.0)
- renepardon зеркало: https://github.com/renepardon/claude-code (идентично оригиналу)
- DeepSeek endpoint: https://api.deepseek.com/anthropic (Anthropic-совместимый)
- shadcn/ui компоненты: https://ui.shadcn.com/docs/components
