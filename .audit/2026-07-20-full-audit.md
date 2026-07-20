# Code Monet — полный аудит (desktop / Electron)

Дата: 2026-07-20
Область: `desktop/` (Electron-приложение — main/preload/renderer)
Метод: 4 параллельных агента-аудитора (perf & fault-tolerance, Yandex Mail, Routines, chat modes & prompts) + ручной разбор точек интеграции для caveman/onboarding.

Все пути ниже — относительно `desktop/src/`, если не указано иное.

---

## 1. Отказоустойчивость / краши (High)

- **Нет глобальных обработчиков в main-процессе.** Ни `uncaughtException`, ни `unhandledRejection` в [main/index.ts](../desktop/src/main/index.ts) — единственные живут в `vendor/leaked` (это CLI, не приложение). Любая необработанная ошибка в IPC/scheduler/trigger-server кладёт всё приложение без лога.
  → Фикс: добавить глобальные хендлеры (лог + не падать).
- **Нет `render-process-gone` / `child-process-gone`.** Если рендерер упадёт (реально при OOM на большом файле — см. §2), окно белеет без перезагрузки.
  → Фикс: слушать `webContents.on("render-process-gone")` и перезагружать/уведомлять.
- **Один корневой ErrorBoundary** в [renderer/main.tsx:7](../desktop/src/renderer/main.tsx#L7) — ошибка рендера в FileViewer/DiffView/MarkdownViewer роняет весь UI в «App Crashed» без кнопки восстановления.
  → Фикс: отдельные boundary на панель просмотра/дифф + reset.
- **`files:*` IPC без try/catch** в [main/ipc/files.ts](../desktop/src/main/ipc/files.ts) (`write`, `list`, `stat`, `pick-directory`). `files:stat` ([main/ipc/files.ts:67](../desktop/src/main/ipc/files.ts#L67)) вызывает `statSync` без `normPath()` (несогласованно с соседями).
  → Замечание: sandbox/agent-путь чтения ([main/agent/sandbox-file-tools.ts](../desktop/src/main/agent/sandbox-file-tools.ts)) уже хорошо защищён — слабое место именно viewer-IPC.

## 2. Производительность больших файлов (High)

Просмотрщик тормозит/фризит, корень — чтение целиком + синхронность + подсветка без виртуализации:

- **[main/ipc/files.ts:28](../desktop/src/main/ipc/files.ts#L28) `files:read`** — `readFileSync` всего файла без cap; truncation до 400 КБ происходит только в рендерере ([renderer/components/FileViewer.tsx:252](../desktop/src/renderer/components/FileViewer.tsx#L252)) уже ПОСЛЕ передачи.
  → Фикс: cap по `statSync` в main.
- **[main/ipc/files.ts:79](../desktop/src/main/ipc/files.ts#L79) `files:readBytes`** — проверка `> 40MB` стоит ПОСЛЕ `readFileSync` → многогиговый файл грузится в память до отказа.
  → Фикс: `statSync().size` до чтения.
- **Все fs-вызовы синхронные** ([main/ipc/files.ts:33, 39, 46, 67, 80, 109](../desktop/src/main/ipc/files.ts#L33)) внутри `async` хендлеров → блокируют event-loop main-процесса (фриз всех окон).
  → Фикс: `fs/promises`.
- **[renderer/components/chat/highlight.tsx:142](../desktop/src/renderer/components/chat/highlight.tsx#L142) `HighlightedCode`** — токенизирует весь файл (до 400 КБ, 10k+ строк) синхронно в `useMemo`, по `<span>` на строку, без виртуализации; guard'ы `CodeBlock` (30k символов / 300 строк) в обход.
  → Фикс: маршрутизировать через `CodeBlock` или добавить окно/лимит.
- **[renderer/components/FileViewer.tsx:529-531](../desktop/src/renderer/components/FileViewer.tsx#L529) → MarkdownViewer** — большой `.md` целиком в `ReactMarkdown` с `remarkGfm`+`remarkMath`+`rehypeKatex`, без truncation/виртуализации.
  → Фикс: рендерить как код выше порога.
- **Дифф:** [renderer/components/chat/diff-core.ts:56](../desktop/src/renderer/components/chat/diff-core.ts#L56) `computeRows` использует `diffArrays` (jsdiff LCS, O(n·m)) без cap; [renderer/components/diff/DiffViewer.tsx:33](../desktop/src/renderer/components/diff/DiffViewer.tsx#L33) считает `computeRows` дважды (в `diffStats()` и в `DiffView`).
  → Фикс: size-guard перед `computeRows`; считать один раз.
- **[renderer/components/FileViewer.tsx:185-190](../desktop/src/renderer/components/FileViewer.tsx#L185) `b64ToBytes`** — до 40 МБ передаётся как ~53 МБ base64-строка + `charCodeAt`-цикл на рендерер-потоке.
  → Фикс: transferable `ArrayBuffer`/`Buffer` вместо base64.
- **[renderer/components/FileViewer.tsx:340-352](../desktop/src/renderer/components/FileViewer.tsx#L340)** xlsx — рендерит до 8 листов через `sheet_to_html` без лимита строк, `dangerouslySetInnerHTML`.
  → Фикс: cap строк на лист.
- **[renderer/components/FileViewer.tsx:361-363](../desktop/src/renderer/components/FileViewer.tsx#L361)** — rich "text"-путь не обрезает файл перед `CodeBlock` (в отличие от plain-пути на line 252).
  → Фикс: тот же slice до 400 КБ.

## 3. Yandex Mail — найдена настоящая причина

**Действий не не хватает.** Yandex и Gmail — обёртки над общим `makeMailOps`:
- [main/connectors/services/yandex/mail/index.ts:13,46](../desktop/src/main/connectors/services/yandex/mail/index.ts#L13)
- [main/connectors/services/google/gmail/index.ts:14,42](../desktop/src/main/connectors/services/google/gmail/index.ts#L14)

Оба экспонируют идентичные 5 действий (`folders`, `search`, `read`, `download_attachment`, `send`), определённые в [main/connectors/services/types.ts:106-117](../desktop/src/main/connectors/services/types.ts#L106) и диспетчеризуемые единым тулом Mail в [main/agent/connector-tools.ts:156-269](../desktop/src/main/agent/connector-tools.ts#L156).

Проблема — в самописном MIME-парсере [main/connectors/lib/protocols/mail.ts](../desktop/src/main/connectors/lib/protocols/mail.ts), который бьёт по Yandex сильнее (кириллица/HTML):

1. **HTML-only письма** ([mail.ts:209-218](../desktop/src/main/connectors/lib/protocols/mail.ts#L209)) — извлекается только `text/plain`; если письмо HTML-only (частый случай на Yandex), возвращается сырой multipart-мусор.
2. **Не декодируется transfer-encoding** ([mail.ts:205-226](../desktop/src/main/connectors/lib/protocols/mail.ts#L205)) — `quoted-printable`/`base64` возвращаются как есть (`=D0=BF…` / стена base64), кириллица нечитаема.
3. **Не учитывается charset** ([mail.ts:205](../desktop/src/main/connectors/lib/protocols/mail.ts#L205)) — тело форсится как UTF-8; `koi8-r`/`windows-1251` части → мойибейк.
4. **Наивный split по одной MIME-границе** ([mail.ts:209-218](../desktop/src/main/connectors/lib/protocols/mail.ts#L209)) — вложенный `multipart/mixed > multipart/alternative` (типичная структура Yandex-писем) не обходится.
   → Фикс всех четырёх: добавить `mailparser` (сейчас не в зависимостях) и заменить ручной парсинг на `simpleParser(msg.source)` — даёт decoded `.text`/`.html` + charset «из коробки».
5. **Слабый поиск на Yandex** ([mail.ts:141-147](../desktop/src/main/connectors/lib/protocols/mail.ts#L141)) — Gmail получает богатый `X-GM-EXT-1`/`gmraw`, Yandex падает на `{or:[{subject},{body},{from}]}` без `has:attachment`, дат, скоупинга по папке.
   → Фикс: маппинг общих токенов на IMAP SEARCH keys (SINCE/BEFORE/HEADER) для не-Gmail пути.
6. **Кириллический поиск может не находить** ([mail.ts:149](../desktop/src/main/connectors/lib/protocols/mail.ts#L149)) — `c.search()` вызывается без явного `CHARSET UTF-8`.
7. **Обрезка тела в 8 КБ** ([mail.ts:20,226,240](../desktop/src/main/connectors/lib/protocols/mail.ts#L20)) — `MAX_BODY = 8_000`, в сочетании с п.1-3 агент часто видит обрезанный недекодированный фрагмент.
8. **Нет `promptHint` для Yandex** — у Gmail он есть ([main/connectors/services/google/gmail/index.ts:44-45](../desktop/src/main/connectors/services/google/gmail/index.ts#L44)), у Yandex — нет ([main/connectors/services/yandex/mail/index.ts](../desktop/src/main/connectors/services/yandex/mail/index.ts)).
   → Фикс: добавить hint про базовый substring-поиск и русскоязычные названия папок («Входящие»/«Отправленные»).

Отдельно (не регрессия Yandex, общее ограничение обоих коннекторов): нет thread view, drafts, list-labels beyond `folders` — это net-new работа в `MailOps` ([main/connectors/services/types.ts:179-207](../desktop/src/main/connectors/services/types.ts#L179)) + схеме тула Mail ([main/agent/connector-tools.ts:118-153](../desktop/src/main/agent/connector-tools.ts#L118)).

## 4. Routines

- **Драфт-подсказка слепа к коннекторам.** `routines:draft` ([main/ipc/routines.ts:112-162](../desktop/src/main/ipc/routines.ts#L112), системный промпт на [routines.ts:129-132](../desktop/src/main/ipc/routines.ts#L129)) просит у модели только `{name, prompt, cron}` — коннекторы/их capabilities не передаются вовсе. UI-проводка: [renderer/components/settings/RoutinesSettings.tsx:109-120, 195-203](../desktop/src/renderer/components/settings/RoutinesSettings.tsx#L109).
  При этом agent-tool `CreateRoutineTool` уже инжектит `Connectors available: …` через `knownConnectors()`/`label()` ([main/agent/routine-tool.ts:43-51, 169](../desktop/src/main/agent/routine-tool.ts#L43)).
  Драфт также не возвращает connectors/output/grants — тип `{name, prompt, cron, space}` ([routines.ts:118-121](../desktop/src/main/ipc/routines.ts#L118)), а фронт использует только эти поля ([RoutinesSettings.tsx:115](../desktop/src/renderer/components/settings/RoutinesSettings.tsx#L115)).
  Метаданные для фикса уже есть: `ConnectorService` ([main/connectors/services/types.ts:308-348](../desktop/src/main/connectors/services/types.ts#L308)) с `name`/`description`/`capabilities`, `actionsForService()` ([types.ts:157](../desktop/src/main/connectors/services/types.ts#L157)).
  → Фикс: скормить `listAccounts()` + `actionsForService()` в системный промпт драфта, аналогично `routine-tool.ts:169`.
- **Output-коннектор — это просто дописанный текст, не структурное действие.** [main/routines/scheduler.ts:77-79](../desktop/src/main/routines/scheduler.ts#L77) при `kind==="connector"` буквально добавляет фразу «post a concise summary … to the `<connector>` connector using its tools». Данные хранятся как `output: { kind, connector? }` ([main/routines/store.ts:38, 54, 207, 231](../desktop/src/main/routines/store.ts#L38)); UI — сегмент-контрол + select ([RoutinesSettings.tsx:588-628](../desktop/src/renderer/components/settings/RoutinesSettings.tsx#L588)).
  Интуиция пользователя («убрать коннектор из output») обоснована — задача рутины может выразить то же самое. НО поле сейчас делает ещё 2 вещи: (1) авто-добавляет тулы коннектора в тулсет ([scheduler.ts:144-151](../desktop/src/main/routines/scheduler.ts#L144)), (2) валидирует существование коннектора ([main/agent/routine-tool.ts:227-245](../desktop/src/main/agent/routine-tool.ts#L227)). При удалении поля это нужно сохранить иначе.
- **Grants не редактируются в UI.** Unattended-действия (send message/mail/upload) требуют grant ([routine-tool.ts:109-114](../desktop/src/main/agent/routine-tool.ts#L109), [scheduler.ts:140-141](../desktop/src/main/routines/scheduler.ts#L140)) — только agent-tool может их выставить, UI-редактор — нет. Пользователь, создавший «post to Slack» рутину в модалке, получит молчаливый отказ на выполнении.
- **Output=connector можно сохранить с пустым connector`""`** — UI не валидирует ([RoutinesSettings.tsx:612](../desktop/src/renderer/components/settings/RoutinesSettings.tsx#L612)), `scheduler.ts:78` тихо ничего не постит.
- **Output connector не всегда попадает в scope коннекторов** — `scheduler.ts:144-151` компенсирует только при непустом списке коннекторов; несостыковка UI multi-select "Connectors" vs отдельного select "Output".
- **Устаревшая копия в UI**: "webhook & connector events coming" ([RoutinesSettings.tsx:155-157](../desktop/src/renderer/components/settings/RoutinesSettings.tsx#L155)) — обе фичи уже реализованы (trigger-server + event polling).
- **Условие/событие держатся на точном emit `SKIP`** от модели ([scheduler.ts:39-47, 85-98, 170](../desktop/src/main/routines/scheduler.ts#L39)) — хрупко, без объяснения пользователю при "never runs".
- **Нет preview драфта перед сохранением**, при ошибке молча падает на raw text ([RoutinesSettings.tsx:116](../desktop/src/renderer/components/settings/RoutinesSettings.tsx#L116)).

## 5. Режимы чата — Normal / Thinking / Verbose / Summary

*(На момент аудита — до реализации; см. §7 «Что реализовано» ниже.)*

- Thinking и Verbose были идентичны — только `summary`/`normal` имели отдельные ветки в [renderer/components/chat/ToolCallBubble.tsx:745-750](../desktop/src/renderer/components/chat/ToolCallBubble.tsx#L745) (`ToolCallBubbleImpl`), комментарий на line 749 так и гласил "Verbose / Thinking: legacy individual items".
- Reasoning не было в модели данных вовсе: `ChatMessage` ([renderer/types/chat.ts:19-30](../desktop/src/renderer/types/chat.ts#L19)) и `LLMEvent` ([chat.ts:54-77](../desktop/src/renderer/types/chat.ts#L54)) без reasoning-полей. Anthropic-клиент включал extended thinking ([main/llm/anthropic-client.ts:41](../desktop/src/main/llm/anthropic-client.ts#L41)), но стрим отдавал только `text_delta` ([anthropic-client.ts:285-288](../desktop/src/main/llm/anthropic-client.ts#L285)) — thinking-дельты терялись.
- Verbose не раскрывал все параметры: `ToolDetail` ([ToolCallBubble.tsx:246-279](../desktop/src/renderer/components/chat/ToolCallBubble.tsx#L246)) предпочитал output, полный raw input показывал только при отсутствии output; по умолчанию свёрнут (`open` init `false`, line 474).
- Summary не собирал изменённые файлы: `TurnSummary` ([renderer/components/chat/ChatView.tsx:440-451](../desktop/src/renderer/components/chat/ChatView.tsx#L440)) отслеживал только `toolNames`/`stepCount`/`answer`.

## 6. Промпты для «тупых» моделей (git / pre-commit)

*(До реализации; см. §7.)*

- **`main/agent/prompts.ts` — мёртвый код.** Ничего не импортирует его — только самоссылки. Живой путь загрузки промпта — [main/agent/index.ts:81](../desktop/src/main/agent/index.ts#L81) (`@vendor/constants/prompts.js`) с фолбэком в [main/agent/prompts-vendor.ts](../desktop/src/main/agent/prompts-vendor.ts). Правки в `prompts.ts` не влияли ни на что.
- Секции git-workflow не было нигде — только общий `getActionsSection` ([prompts-vendor.ts:138-152](../desktop/src/main/agent/prompts-vendor.ts#L138)).
- Единственное pre-commit-правило было привязано к "reporting complete", не к коммиту ([prompts-vendor.ts:125](../desktop/src/main/agent/prompts-vendor.ts#L125)) — слишком мягко для слабой модели.
- Git-safety была общей ([prompts-vendor.ts:146-151](../desktop/src/main/agent/prompts-vendor.ts#L146)) — без явных позитивных "NEVER"-правил (force-push, `reset --hard`, `--no-verify`, amend published).
- Read-before-edit и точный `old_string` выживали только в мёртвом `prompts.ts:81-86` (`TOOLS` block) — никогда не доходили до модели.
- Custom tool descriptions (`RunCommand` [main/agent/podman-command-tool.ts:34-45](../desktop/src/main/agent/podman-command-tool.ts#L34), `RunPython` [main/agent/sandbox-tool.ts:132-160](../desktop/src/main/agent/sandbox-tool.ts#L132)) не несли дисциплины про тестирование перед коммитом.
- Sub-agent промпт голый ([prompts-vendor.ts:264-269](../desktop/src/main/agent/prompts-vendor.ts#L264), `getSubAgentPrompt`, ключ `subagent-system`) — делегированная работа не наследовала verify/git-правила.
- Лучший рычаг для тюнинга без правки vendor-файлов: `system-append` tunable ([main/agent/index.ts:118](../desktop/src/main/agent/index.ts#L118) на момент аудита), применяется и к vendor-, и к fallback-промпту через `withUserMemory`.

---

## 7. Что реализовано в этой сессии

По явному запросу пользователя реализованы только фичи из технического задания — **не** багфиксы из §1-4 (perf/reliability/Yandex Mail/Routines остаются как отчёт для отдельного захода).

### 7.1 Промпты — git/pre-commit гейт + read-before-edit

Новый always-on блок `DISCIPLINE_DEFAULT` в [main/agent/index.ts](../desktop/src/main/agent/index.ts), подключён в `withUserMemory()` (там же), применяется к обоим путям построения системного промпта (vendor + fallback). Редактируется пользователем через `<dataDir>/prompts/discipline.md` (тот же механизм, что `system-append`).

Содержит:
- read-before-edit + точный `old_string`, никаких drive-by рефакторов;
- verify-before-done (реально прогнать тесты/build/lint/smoke, сказать, если не смог);
- жёсткий git-гейт: **никогда `git commit` без прогона тестов/build/lint/smoke в этой сессии**; `git status`/`git diff` перед стейджем; не `git add -A` вслепую; ветка от default перед коммитом; список NEVER (force-push, `reset --hard`/`checkout --` на грязном дереве, `--no-verify`/`--no-gpg-sign`, amend запушенного);
- приоритет sandbox/RunCommand-тулов для прогона проверок перед отчётом об успехе.

Сидируется в `seedTunablePrompts()` ([main/agent/index.ts](../desktop/src/main/agent/index.ts)) вместе с остальными tunable-промптами.

### 7.2 Caveman-режим

Новый модуль [main/agent/caveman.ts](../desktop/src/main/agent/caveman.ts):
- `getCavemanConfig()`/`setCavemanConfig()` — персист в `<dataDir>/caveman.json`, тот же паттерн, что `toolsearch-config.ts`;
- `cavemanDirective()` — терсный директив (телеграфный output, минимальный thinking, код/пути/команды НЕ сокращаются), tunable через `prompts/caveman-directive.md`;
- `CAVEMAN_COMPACT_HINT` — доп. инструкция для компакции («держи только load-bearing факты, фрагменты вместо прозы»).

Интеграция:
- [main/agent/index.ts](../desktop/src/main/agent/index.ts) `withUserMemory()` — добавляет `cavemanDirective()` в конец промпта, когда включено;
- [main/agent/index.ts](../desktop/src/main/agent/index.ts) агентский цикл — порог автокомпакции снижен до 60% от обычного (`compactionThreshold * 0.6`) при caveman;
- [main/agent/compaction.ts](../desktop/src/main/agent/compaction.ts) `compactMessages()` — новый опциональный параметр `terseHint`, добавляется к `getCompactPrompt()`;
- IPC: `caveman:get`/`caveman:set` в [main/ipc/tuning.ts](../desktop/src/main/ipc/tuning.ts);
- preload: `tuning.cavemanGet`/`cavemanSet` в [preload/index.ts](../desktop/src/preload/index.ts);
- типы: [renderer/types/electron.d.ts](../desktop/src/renderer/types/electron.d.ts);
- UI-тумблер «Caveman mode (terse)» в **Settings → Advanced** — [renderer/components/settings/AdvancedSettings.tsx](../desktop/src/renderer/components/settings/AdvancedSettings.tsx).

### 7.3 Режимы чата (Claude-Code-style)

**Thinking показывает reasoning end-to-end, display-only:**
- Новый тип события `reasoning_delta` в [main/llm/adapter.ts](../desktop/src/main/llm/adapter.ts) и [renderer/types/chat.ts](../desktop/src/renderer/types/chat.ts);
- Anthropic: обработка `thinking_delta` в SSE-стриме ([main/llm/anthropic-client.ts](../desktop/src/main/llm/anthropic-client.ts) — добавлено поле `thinking` в тип delta, новая ветка `case`);
- OpenAI-совместимые (DeepSeek/OpenRouter): поля `reasoning`/`reasoning_content` в delta ([main/llm/openai-compat-client.ts](../desktop/src/main/llm/openai-compat-client.ts));
- Поле `reasoning?: string` на `ChatMessage` ([renderer/types/chat.ts](../desktop/src/renderer/types/chat.ts));
- Батчинг в сторе — отдельный `pendingReasoning` буфер, флашится ПЕРЕД текстом для сохранения порядка ([renderer/stores/chatStore.ts](../desktop/src/renderer/stores/chatStore.ts));
- Reducer-кейс `reasoning_delta` — создаёт/дополняет стримящееся assistant-сообщение;
- Рендер — новый компонент `ReasoningBlock` (свёртываемый `<details>`, открыт пока стримится) в [renderer/components/chat/ChatView.tsx](../desktop/src/renderer/components/chat/ChatView.tsx), показывается только при `mode === "thinking"`.
- **Важно:** reasoning НЕ добавляется в `messages`, которые уходят обратно в модель — агентский цикл ([main/agent/index.ts](../desktop/src/main/agent/index.ts)) продолжает копить только `text_delta` в `assistantText`; reasoning идёт напрямую в `onEvent` для UI и никак не влияет на контекст.

**Verbose раскрывает все параметры тулзов:**
- `ToolCallItem` в [renderer/components/chat/ToolCallBubble.tsx](../desktop/src/renderer/components/chat/ToolCallBubble.tsx) получил проп `verbose` — в этом режиме карточка развёрнута по умолчанию и показывает блок **Parameters** (полный `JSON.stringify(input, null, 2)`) вдобавок к семантической детали и output;
- Роутинг режимов там же: `normal`/`thinking` → компактный `SingleToolRow`; `verbose` → `ToolCallItem verbose`.

**Summary добавляет изменённые файлы:**
- `TurnSummary` в [renderer/components/chat/ChatView.tsx](../desktop/src/renderer/components/chat/ChatView.tsx) получил поле `filesChanged: string[]`;
- `summarizeTurns()` собирает `input.file_path` из тулов `Edit`/`Write`/`MultiEdit`;
- `SummaryTurnCard` рендерит список файлов (basename, с `title` на полный путь) под шагами/tools.

### 7.4 Onboarding-интро первого запуска

Новый компонент [renderer/components/OnboardingIntro.tsx](../desktop/src/renderer/components/OnboardingIntro.tsx) — полноэкранный wizard из 3 шагов:
1. **welcome** — логотип «Code Monet» шрифтом Copernicus + 4 карточки преимуществ (мульти-провайдерность, сэндбоксированные тулы, коннекторы/Routines, локальность/приватность);
2. **profile** — имя + «о себе» (пишутся в тот же профиль, что Settings → Profile);
3. **avatar** — выбор аватарки из галереи Monet-картин (переиспользован существующий `profile.gallery()` IPC).

На финише пишет профиль через `api().profile.set()` / `setAvatarUrl()` (тот же путь, что ручная правка в Settings), ставит флаг `localStorage["monet-onboarded"]`. «Skip» на первом шаге тоже ставит флаг без записи профиля.

Подключение: [renderer/App.tsx](../desktop/src/renderer/App.tsx) — состояние `showOnboarding` инициализируется из localStorage, оверлей рендерится первым внутри корневого div, `onDone` снимает флаг из state.

### 7.5 Проверка

- `node scripts/typecheck.mjs` → **`typecheck OK: desktop code clean`** (после всех правок).
- `scripts/smoke-agent.mjs` — **не удалось запустить**: в рабочей копии отсутствует `node_modules` (`Cannot find package 'vite'`). Нужен `npm install` в `desktop/`, затем `npm run smoke:agent` и ручная проверка в браузере/Electron (особенно: reasoning реально приходит и не просачивается в контекст; onboarding на чистом профиле; caveman-тумблер).

---

## 8. Не реализовано (осталось как отчёт)

Отказоустойчивость (§1), производительность больших файлов (§2), Yandex Mail MIME-парсер (§3) и Routines (§4) — по явной просьбе пользователя это НЕ багфикс-сессия, только реализация запрошенных фич (§7). Дополнительно зафиксирована проблема ранней автокомпрессии контекста в desktop-agent.

### 8.1 Автокомпрессия desktop-agent срабатывает слишком рано (High)

Наблюдение: при фактически доступном контекстном окне порядка **1M токенов** история иногда сжимается уже при отображаемом использовании около **30%**. Это нужно подтвердить по конкретному провайдеру, модели и фактическому `usage`, но текущая реализация desktop имеет подозрительно низкий абсолютный порог:

- [main/agent/compaction.ts:18](../desktop/src/main/agent/compaction.ts#L18) задаёт `DEFAULT_THRESHOLD = 150_000` токенов (`MONET_COMPACT_TOKENS` может его переопределить);
- [main/agent/compaction.ts:52-56](../desktop/src/main/agent/compaction.ts#L52) считает `min(budget * 0.7, DEFAULT_THRESHOLD)`, поэтому даже при `budget = 1_000_000` порог остаётся 150K;
- [main/agent/index.ts:854-858](../desktop/src/main/agent/index.ts#L854) применяет этот порог в каждом проходе агентского цикла, а в Caveman mode дополнительно снижает его до 60% (`threshold * 0.6`);
- [main/agent/compaction.ts:24-39](../desktop/src/main/agent/compaction.ts#L24) оценивает токены эвристикой `chars / 4`, включая tool-use/tool-result и фиксированную оценку изображения, поэтому оценка может расходиться с реальным API usage;
- desktop-компакция не использует подтверждённый `usage` API как основной источник текущего размера контекста, а просто оценивает накопленный `messages[]`.

Возможная причина — рассинхронизация между реальным 1M-лимитом провайдера и локальным абсолютным потолком 150K, усиленная грубой оценкой `chars / 4`. Нельзя автоматически считать причиной только поддержку 1M: сначала нужно проверить, какое значение реально передаётся в `provider.inputLimit ?? provider.contextLimit`, как оно вычисляется для выбранной модели и что именно показывает UI.

План проверки/фикса:

1. Логировать для одного запроса: provider/model, `inputLimit`, `contextLimit`, вычисленный threshold, `estimateTokens(messages)` и API usage — до и после компакции.
2. Проверить, действительно ли выбранная модель и endpoint имеют 1M context, а не только UI-индикатор или capability-флаг.
3. Убрать или пересмотреть абсолютный потолок 150K для моделей с подтверждённым большим окном; порог должен зависеть от реального лимита модели и оставлять резерв на output/ошибку переполнения.
4. Сравнить `chars / 4` с токенизацией/usage конкретного провайдера и отдельно проверить вклад JSON tool-use, tool-result и изображений.
5. Не смешивать исправление порога с изменением semantics кэш-токенов: сначала установить, не завышает ли именно desktop-оценка размер контекста.

До проверки это остаётся диагностированной проблемой, а не готовым утверждением о единственной причине. Caveman mode также следует учитывать отдельно: он намеренно запускает компрессию раньше.

Рекомендуемый порядок при следующем заходе:

1. Отказоустойчивость (§1) — дёшево, снимает краши.
2. Автокомпрессия desktop-agent (§8.1) — влияет на доступный контекст и качество длинных сессий.
3. Yandex Mail (§3) — точечный фикс (`mailparser`), закрывает конкретную жалобу пользователя.
4. Perf больших файлов (§2) — самый заметный эффект для пользователя, но больше кода.
5. Routines UX (§4) — connector-aware draft + grants в UI, больше работы (данные + UI).
