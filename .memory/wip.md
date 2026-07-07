# Что в работе

## Активный план: desktop-agent

> 2026-07-07 — `.plans/desktop-agent.md` v4, **ЗАВЕРШЁН** ✅

**4 этапа, 118 критериев готовности — выполнено.**

### Этап 0: Подготовка (7 критериев) ✅
- [x] 0.1 Восстановление `types/message.ts` (~38 типов, 478 строк)
- [x] 0.2 Копирование vendor-файлов (1294 файла)
- [x] 0.3 Полный shim `bootstrap/state.ts` (~30 экспортов)
- [x] 0.4 Аудит инструментов: 147 bun:bundle, 16 Bun.*, 80 require() — всё fixable

### Этап 1: Проект и провайдеры (30 критериев) ✅
- [x] 1.1 Инициализация Electron + React + Vite + shadcn/ui (11/11)
- [x] 1.2 Shim-пакеты (bun-bundle, bootstrap-state, crypto) (4/4)
- [x] 1.3 Провайдеры: модель + safeStorage (4/4)
- [x] 1.4 LLM-адаптер (Anthropic HTTP + @ai-sdk/openai) (5/5)
- [x] 1.5 UI провайдеров (Zustand + ProviderSettings/Form) (6/6)

### Этап 2: Чат и агент (46 критериев) ✅
- [x] 2.1 QueryEngine адаптирован (агент-враппер)
- [x] 2.2 Промпты адаптированы (inline system prompt)
- [x] 2.3 IPC-обработчики (7 модулей, 25+ каналов)
- [x] 2.4 Чат-интерфейс (ChatView, MessageInput, MarkdownViewer, ToolCallBubble, PermissionDialog)
- [x] 2.5 Агент: TAOR-цикл + 7 инструментов (read, write, edit, grep, glob, run_command, todo_write)

### Этап 3: Десктопные фичи (35 критериев) ✅
- [x] 3.1 Diff Viewer (unified diff, accept/reject)
- [x] 3.2 История сессий (JSON store, SessionList sidebar)
- [x] 3.3 Терминал (xterm.js + IPC shell) + FileTree
- [x] 3.4 Навыки (7 встроенных, панель выбора)
- [x] 3.5 Системный трей (minimize, show/hide, quit)
- [x] 3.6 Workspace picker + CLAUDE.md автозагрузка + window title
- [x] 3.7 Сборка (electron-builder.yml, npm run build — чисто)

## Результат

- **Сборка:** `npm run build` — чисто, 1416 модулей, 0 ошибок
- **Файлы:** 34 новых + 1294 vendor = 1328 в desktop/src/
- **Коммиты:** 15
- **Отклонения:** JSON вместо SQLite, IPC-shell вместо node-pty
- **На будущее (v1.1):** полная vendor-интеграция (QueryEngine + 40 инструментов)
