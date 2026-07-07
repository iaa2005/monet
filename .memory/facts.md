# Факты и цифры

## Утекший код

> 2026-07-06 — из аудита

- **1884** TypeScript/React файла в оригинальной утечке
- **1** реально отсутствующий файл: `types/message.ts`
- **8** ключевых инструментов — все на месте: BashTool.tsx, FileReadTool.ts, FileWriteTool.ts, FileEditTool.ts, GlobTool.ts, GrepTool.ts, WebFetchTool.ts, WebSearchTool.ts
- **API-слой**: services/api/claude.ts, client.ts, errors.ts, logging.ts — все на месте
- **renepardon/claude-code** — идентичное зеркало (1884 файла), дополнительных нет
- Аудит на 4066 импортов: 2109 ложных срабатываний (искали `.js`, не учли `.ts`/`.tsx`)

## Ключевые ссылки

> 2026-07-06

- План: `.plans/desktop-agent.md` (v4, 118 критериев)
- Структура проекта: `STRUCTURE.md` (1079 строк)
- Утекший код: `C:\Users\alexivanov\.agents\claude-code\`
- sandbox-runtime: https://github.com/anthropic-experimental/sandbox-runtime (Apache 2.0, 4600⭐)
- Зеркало renepardon: https://github.com/renepardon/claude-code

## API-эндпоинты

> 2026-07-06

- DeepSeek (Anthropic-совместимый): `POST https://api.deepseek.com/anthropic/v1/messages`
- Anthropic: `POST https://api.anthropic.com/v1/messages`
- llama.cpp (OpenAI-совместимый): `POST localhost:8080/v1/chat/completions`

## Настройки пользователя

> 2026-07-06

- `~/.claude/settings.json` — содержит `env: { ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL, ANTHROPIC_MODEL }`
- Модель: `deepseek-v4-pro`
- API ключ DeepSeek: в `settings.json` → `env.ANTHROPIC_AUTH_TOKEN`

## Предыдущие попытки запуска

> 2026-07-06

- `.\claude.bat --version` → `1.0.0-leaked (Claude Code)` ✅
- `.\claude.bat --help` → полный вывод с 50+ опциями ✅
- Интерактивный режим `.\claude.bat` → не запустился (TTY/rendering)
- Правка `client.ts` (ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN) закоммичена (79fbabc)
- `init()` зависал → добавлен таймаут 5 секунд (fdf447e)
- Созданы shim-ы для `@ant/*`, `@anthropic-ai/*`, `@growthbook/*`, `color-diff-napi`
- Созданы shim-файлы: `types/connectorText.ts`, `tools/TungstenTool/`, `tools/WorkflowTool/`, `utils/filePersistence/types.ts`
- Пропатчены `.md` импорты в `claudeApiContent.ts`, `verifyContent.ts`
