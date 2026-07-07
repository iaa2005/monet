# Архитектурные решения

## Electron vs Tauri

> 2026-07-06 — принято

**Выбрано: Electron.** Причина: весь утекший код на TypeScript, ~300-500 файлов
можно переиспользовать напрямую. Tauri требует переписывать бэкенд на Rust.
В будущем возможна миграция.

## Автономность desktop/

> 2026-07-06 — принято

**ВСЁ внутри `desktop/`.** Никаких импортов из родительских папок, никаких
`tsconfig paths` наружу. Все нужные файлы из утекшего кода копируются
в `desktop/src/vendor/leaked/`. Папка автономна: скопировал → `npm install && npm run dev` → работает.

## Отказ от @anthropic-ai/sdk

> 2026-07-06 — принято

**Не используем `@anthropic-ai/sdk`.** Причины:
1. Лицензионные риски (проприетарный, хоть и MIT)
2. Вендор-лок (только Anthropic API)
3. Раздутый бандл (~500 КБ)
4. Блокировка форматов (Anthropic tools ≠ OpenAI tools)
5. Нет контроля над HTTP (retry, таймауты, перехват)

**Альтернативы:**
- Свой тонкий HTTP-клиент для Anthropic Messages API (для Anthropic + DeepSeek)
- `@ai-sdk/openai` (Vercel AI SDK) для OpenAI-совместимых (llama.cpp)

## Мульти-провайдер

> 2026-07-06 — принято

Провайдеры: Anthropic, DeepSeek, llama.cpp, OpenAI-совместимые.
DeepSeek работает через Anthropic-совместимый эндпоинт: `https://api.deepseek.com/anthropic`.
llama.cpp — через OpenAI-совместимый API (`localhost:8080/v1`).
Провайдеры настраиваются через UI, ключи шифруются через Electron `safeStorage`.

## shadcn/ui для интерфейса

> 2026-07-06 — принято

Используем готовые shadcn/ui компоненты: Attachment, Bubble, Message, Marker,
Message Scroller, Card, Dialog, Sheet, Tabs, Button, Input, Select, Textarea,
ScrollArea, Table, Badge. Не создаём лишних кастомных компонентов.

## Песочница (sandbox-runtime)

> 2026-07-07 — принято

Пакет `@anthropic-ai/sandbox-runtime` — открытый (Apache 2.0) но экспериментальный
(131 issue, нестабильный API). План:
- **MVP:** оставить shim из `patches/` (уже работает)
- **v1.1:** скопировать в `vendor/`, провести аудит API
- **v1.2:** адаптировать под Electron (child_process вместо spawn)
- **v1.3:** заменить shim на реальную интеграцию

## Коммиты по каждому критерию

> 2026-07-06 — принято

После каждого выполненного `[x]` критерия (118 критериев в плане) делаем git-коммит.
Сообщение: этап + описание. Перед run-командами проверяем, что не удаляется `.git/`.
