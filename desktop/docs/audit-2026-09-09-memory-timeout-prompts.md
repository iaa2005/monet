# Аудит Code Monet: память, таймаут стрима, размер промптов

Дата: 2026-09-09. Ветка `monet-local-provider` (`516a1b78`). Аудит без правок кода.
Все числа ниже **измерены**, не прочитаны из комментариев: сборкой реального
промпта и тулсета (скрипт из `scripts/measure-prompt.mjs`, починенный копией в
scratchpad — сам скрипт в репозитории сломан, см. §4.6), файлами из настоящей
папки данных пользователя (`C:\Users\alexivanov\.monet`, см. `monet-bootstrap.json`)
и живыми запросами к llama.cpp (Qwen3.8-27B Q4_K_M на CPU этой машины).

Токены здесь — `chars/4`, как считает сам счётчик контекста в приложении
(`computeContextBreakdown`). Для русского текста это занижает примерно вдвое.

---

## 0. Главное

Три жалобы — одна причина.

| Факт | Число |
|---|---|
| Контекст ДО первого слова пользователя, Code, конфигурация пользователя | **≈ 20 500 ток.** (33 инструмента 15 274 + вендорный промпт 3 205 + блоки приложения ≈ 2 000) |
| То же, Home | ≈ 12 700 ток. |
| Скорость обработки промпта (prefill) локальной 27B на этой машине | **≈ 10 ток/с** (16 потоков; 7 ток/с на 8 потоках; размер батча не влияет: 9,9 при `b=32`, 10,2 при `b=512`) |
| Первый ход в Code до первого токена ответа | 20 500 / 10 ≈ **34 минуты** |
| Сторож стрима (`STREAM_TIMEOUT_MS`) | **300 с**, зашит в код, взводится до первого байта |
| Что llama.cpp шлёт во время prefill | **ничего** (заголовки через 0,1 с, потом тишина до первого токена) |

Следствие: на локальной модели сторож срабатывает на первом ходе **любого** чата
по построению. После срабатывания цикл агента видит «пустой ответ» и посылает
**тот же самый запрос ещё раз** с «.» (nudge) — это и есть пара сообщений
«Stream timed out after 300s of silence» + «The model answered with nothing —
nudged it to continue (1/2)». Второй запрос упирается в те же 300 с.

Порядок работ (см. §5): (1) таймаут — маленькая правка, снимает боль сразу;
(2) диета промптов — уменьшает первый ход с 34 до ~12 минут; (3) память —
выпилить проход после хода и журналы, одно место управления, убрать мёртвый
вендорный слой, стабильный префикс.

---

## 1. Как собирается контекст запроса

Точка сборки: `src/main/agent/index.ts` → `runAgent` → `buildSystemPrompt()` +
`buildDirectives()` + `getVendorApiTools()`.

```
system =  buildDirectives()                      // agent/index.ts:518
            home-directive (только Home)          183
            modeDirective (Plan/Concise…)          0–?
            chart-widget  (ОБА пространства)      513
            deferredToolsDirective (ToolSearch)     0 без MCP
            browserDirective (browser.json on)    ~40–120, меняется каждые 60 с
        + vendor getSystemPrompt()                // engine/constants/prompts.ts:441
            intro 209 · System 407 · Doing tasks 831 · Executing actions 708
            Using your tools 406 · Tone 177 · Output efficiency 183
            boundary 9 · Session guidance 33 · Environment 202 · summarize 40
                                                 = 3 205
        + withUserMemory()                        // agent/index.ts:~320
            identity 103 + строка модели
            # User profile (profile.json)         ~30
            buildMemoryPrompt()                   0 сейчас; потолок 10 000 симв. тел + индекс до 25 КБ
            buildVaultPrompt() (vault-rules)      563 + список хранилищ
            buildLessonsPrompt() (Code, flag)     0 сейчас
            method 251 · discipline 513 · design (off) · system-append (пусто) · caveman (off)
tools   =  33 инструмента: описания 9 651 + схемы 5 623 = 15 274
```

Замер тулсета (Code, как у пользователя: ToolSearch on, LSP on, vault on, коннекторов нет):

| tool | desc | schema |   | tool | desc | schema |
|---|---:|---:|---|---|---:|---:|
| Bash | 2 398 | 336 | | UpdateGoal | 191 | 131 |
| PowerShell | 1 658 | 159 | | UpdatePlan | 118 | 185 |
| TodoWrite | 822 | 98 | | LSP | 105 | 161 |
| Routine | 207 | **653** | | TeamList | 167 | 90 |
| Grep | 217 | **589** | | Write | 155 | 66 |
| Read | 420 | 164 | | ObsidianEdit | 80 | 135 |
| ObsidianAttach | 270 | 253 | | Glob | 93 | 114 |
| CreateSkill | 241 | 238 | | ObsidianMove | 88 | 111 |
| AgentSwarm | 301 | 167 | | SendMessage | 118 | 80 |
| Task | 235 | 195 | | ObsidianSearch | 86 | 97 |
| ReadMediaFile | 227 | 197 | | ObsidianRead | 83 | 70 |
| Edit | 274 | 117 | | Skill | 65 | 61 |
| ExitPlanMode | 220 | 159 | | EnterPlanMode | 95 | 31 |
| ObsidianWrite | 155 | 213 | | WebFetch | 44 | 57 |
| Remember | 190 | 178 | | SearchPastChats | 50 | 49 |
| NotebookEdit | 129 | 214 | | WebSearch | 35 | 29 |
| AskUserQuestion | 114 | 226 | | | | |

Это **уже** с «Lean tool descriptions» (включено по умолчанию). Сырые промпты:
Bash 21,5 КБ (≈5,4k ток.), PowerShell 10 КБ (2,5k), TodoWrite 9,7 КБ (2,4k).
`stripExamples()` режет `<example>` и разделы «Examples», а основной объём Bash —
не примеры, а протоколы «как коммитить» и «как делать PR» (`BashTool/prompt.ts:74–160`),
которые остаются целиком.

Home: 22 инструмента, 4 495 + 2 882 = 7 377; вендорный промпт тот же 3 205.

---

## 2. Память — как устроена на самом деле

### 2.1 Хранилище
`<dataDir>/claude/memory/` (`memory/store.ts`):
`profile.md` (раздел You), `topics/<slug>.md`, `areas/<slug>.md`, индекс `MEMORY.md`
(≤200 строк / 25 КБ), журналы `logs/YYYY/MM/YYYY-MM-DD.md`, уроки проектов
`projects/<slug>.md` + `.history/`. Конфиг `memory-config.json`
`{searchChats, generateMemory, extractEveryMinutes}`.

На этой машине: `generateMemory: false`, `searchChats: true`, `extractEveryMinutes: 0`,
папка памяти **пуста** (ни одного файла, ни журналов, ни индекса), консолидация не
запускалась ни разу, `lessons-state.json`: «No workspace had enough signal», runs 0.
То есть функция включена в UI наполовину и не произвела ничего.

### 2.2 Четыре канала записи

| канал | файл | кто вызывает | модель | как пишет |
|---|---|---|---|---|
| `Remember` tool | `agent/remember-tool.ts` | сам агент во время хода | — | **append** в файл, id из имени |
| Поле «My plant is named Gerald» на странице Memory | `memory/extract.ts:addMemoryNote → runExtraction` | IPC `memory:addNote` | **активный чат-провайдер** (`getProviderManager().getActive()`), не фоновый | модель отдаёт **полную замену** до 3 файлов; при ошибке — verbatim в profile |
| Пост-ходовой проход | `extract.ts:maybeExtractMemory → runLogPass` | `ipc/chat.ts:695` после каждого хода | фоновая (`resolveBackgroundModel`) | append-only буллеты в дневной журнал; гейты `generateMemory && extractEveryMinutes>0`; по умолчанию **0 = никогда** |
| Ночная консолидация | `memory/consolidate.ts:runConsolidation` | `memory/nightly.ts` (03–05 ч, MIN_HOURS 20, catch-up 36 ч) | фоновая | JSON-план: upserts (полная замена), deletes, index; гейты `generateMemory`, ≥3 буллетов; `force` с кнопки обходит все гейты |
| Уроки проектов | `memory/lessons.ts:runLessonsDream` | тот же таймер | фоновая | по workspace, полная замена, история 5 версий, rollback |

### 2.3 Три канала чтения
- `buildMemoryPrompt()` — в системный промпт **каждого** хода: индекс целиком
  (до 25 КБ ≈ 6k ток. — **не входит** в `TOTAL_CAP`, он считает только тела) +
  тела файлов до 2 500 символов каждое, суммарно 10 000.
- `buildLessonsPrompt()` — только Code, только при `features.lessons`.
- `SearchPastChats` — ищет **только по заголовкам** чатов (`getSessionStore().search`).
- Плюс `memoryIndexHint()` внутри описания инструмента `Remember` — список файлов
  памяти живёт в описании тула, а описание кэшируется по набору имён тулов
  (`apiToolsCache`), т.е. отстаёт до `resetVendorTools()`.

### 2.4 Что не так

1. **Два пульта.** Settings → Memory: `generateMemory`, интервал экстракции,
   «Consolidate now», «Learn now», список уроков. Settings → Advanced → «Between
   runs»: `lessons` («Learn from failures»), `runNotes`. Уроки **генерируются** под
   гейтом `memory.generateMemory` (`lessons.ts:479`), а **инжектятся** под гейтом
   `features.lessons` (`index.ts:~340`). У пользователя сейчас
   `generateMemory=false`, `features.lessons=true`: Advanced говорит «включено»,
   Memory показывает «Learn now», ночью не происходит ничего. Ни один экран
   этого не объясняет.
2. **Кнопки на Memory обходят выключатель.** «Consolidate now» и «Learn now» идут
   с `force:true` и работают при `generateMemory=false`; автоматика при этом
   молчит. Карточки «Nightly consolidation» и «Project lessons» показаны всегда,
   без слова о том, что автозапуск выключен.
3. **Поле заметки переписывает файлы.** `addMemoryNote` → `runExtraction` —
   единственный оставшийся путь «полной замены» из чата, вопреки заголовку
   `daily-log.ts` («Nothing rewrites a memory file mid-conversation any more»).
   Одна заметка = модель переписывает до 3 файлов целиком. И делает это
   **активная модель чата** (у пользователя — локальная 27B), а не фоновая:
   один проход = ещё один многоминутный prefill, без таймаута.
4. **Ни у одного фонового вызова нет таймаута.** `adapter.complete()` (12 мест:
   consolidate, lessons, extract, clarify, judge, review, reflect, routines,
   sessions-title, compaction) — `fetch` без `AbortSignal.timeout`. На локальной
   модели «Consolidating…» может висеть полчаса и больше, молча.
5. **Мёртвый вендорный слой памяти остался в сборке.** `memory/dir/*` (memdir,
   findRelevantMemories, memoryScan…), `engine/services/extractMemories`,
   `autoDream`, `SessionMemory`, `settings/types.ts:autoDreamEnabled`.
   Ничего из этого не работает: `applyLeanEnv()` ставит
   `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` в `main/index.ts:52`, и `loadMemoryPrompt()`
   вызывается при каждой сборке промпта, чтобы вернуть `null`. Ловушка: переменную
   надо выставить **до** первой сборки — вендор мемоизирует секцию.
6. **Четыре источника «кто пользователь»** в одном промпте: `identity.md`,
   `# User profile` из `profile.json` (about до 2 000 симв.), `# User memory` →
   `## You` из `profile.md`, плюс Obsidian `vault-rules` (563 ток.) как четвёртая
   база знаний. Для модели это три разных места с потенциально разными ответами.
7. **Всё динамическое сидит в системном промпте** и ломает префиксный кэш
   llama.cpp: индекс памяти, уроки, `browserDirective` (обновляется каждые 60 с,
   список dev-серверов и вкладок), `deferredToolsDirective`, дата в Environment,
   `memoryIndexHint` в описании тула. Любое изменение = префикс не совпал =
   **полный prefill заново** (34 минуты на этой машине). У вендора для этого есть
   `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` — идея правильная, но наши блоки идут после
   него без разбора.
8. `SearchPastChats` по заголовкам — почти бесполезен как «память о прошлых
   чатах», но стоит 99 ток. в каждом ходе.
9. Заголовок `remember-tool.ts` утверждает, что фоновой консолидации нет
   («no nightly consolidation runs») — устарел, она есть. Мелочь, но это
   документация, на которую будут опираться.

---

## 3. Таймаут стрима

### 3.1 Как сейчас (проверено по коду и живым запросом)
- `STREAM_TIMEOUT_MS = 300_000` — константа в `llm/anthropic-client.ts:177` и
  `llm/openai-compat-client.ts:292`. Взводится **до первого `read()`**
  (`armWatchdog()` перед циклом: `anthropic-client.ts:334`, `openai-compat-client.ts:389`),
  сбрасывается на каждом чанке. По срабатыванию: `onEvent({type:"error"})`,
  `reader.cancel()`.
- После `cancel()` цикл `read()` заканчивается **штатно**. В `runAgent`
  (`index.ts:1933–2036`) `streamError` присваивается на событии `error`, но
  **нигде не читается** (4 вхождения: объявление, два присваивания, эмит).
  Дальше `assistantText === ""`, `toolCalls.length === 0` →
  `isEmptyReply()` → `shouldNudge()` → `appendUserText(".")` → `continue` →
  **тот же запрос**. Лимит `MAX_NUDGES = 2`, т.е. до трёх запросов по 300 с.
- В UI (`chatStore.ts:909`) `error` гасит `isStreaming` и рисует красный баннер,
  затем `harness`-строка «nudged», затем следующий `text_delta` снова включает
  стриминг. Пользователь видит ошибку и продолжение одновременно.
- llama.cpp при обрыве соединения задачу **отменяет** (лог: `stop: cancel task`),
  роутер живёт; обработанный кусок промпта остаётся в кэше
  (`n_prompt_tokens_cache`), так что повторный запрос продолжает с места обрыва —
  но снова под потолком 300 с.
- `complete()` — вообще без таймаута (см. §2.4 п.4).

### 3.2 Что даёт llama.cpp (проверено)
`"return_progress": true` в теле `/v1/chat/completions` при `stream: true`:
сервер шлёт чанки `{"prompt_progress": {"total": 6040, "cache": 0, "processed": 554,
"time_ms": 54305}, "choices":[{"delta":{"role":"assistant"}}]}` на каждом батче —
раз в ~3 с при `b=32`, раз в ~50 с при `b=512`. Это одновременно **живость** для
сторожа и **честный прогресс-бар** «читает промпт 554 / 6 040».

### 3.3 План

1. **Настройка таймаута.** Модель данных: `ProviderModel.streamTimeoutSec?: number`
   (`provider/types.ts`) → `ActiveModel.streamTimeoutSec` через `resolveModelOn()`
   → `LLMRequest.timeoutMs` → оба клиента вместо константы. Дефолт по виду:
   `anthropic/openai/openrouter/deepseek` 300 с; `monet-local` и любой baseURL на
   `localhost/127.0.0.1` — **1800 с**, а лучше 0 = «без сторожа, пока есть
   прогресс». UI: в `ProviderSettings.tsx` рядом с «Max Output Tokens»
   (`NumField`, строка ~577) поле «Silence timeout, s»; в Advanced — новая
   секция «Timeouts» с глобальным дефолтом (файл `<dataDir>/timeouts.json` по
   образцу `caveman.json`, IPC в `ipc/tuning.ts`). Это то, что пользователь
   назвал «сделать в Advanced настройку дополнительную».
2. **Прогресс вместо тишины.** В `OpenAICompatClient.buildBody` добавлять
   `return_progress: true`, когда `provider.kind === "monet-local"` или baseURL
   локальный (`/props` роутера отвечает `role: "router"` — можно и по нему).
   В `processLine` читать `chunk.prompt_progress` → новое событие
   `LLMEvent {type:"prompt_progress", processed, total, cache}` → `chatStore`
   рисует «Обработка промпта N / M» в той же полоске, где сейчас крутится
   спиннер. Сторож при этом сбрасывается сам (чанк = байты).
3. **Не нуджить таймаут.** В `runAgent` после стрима: `if (streamError)` → не
   `isEmptyReply`, а завершение хода с `message_stop {stop_reason:"error"}` и,
   лучше, кнопка «Повторить» в баннере. Nudge остаётся только для честно
   пустого ответа. Обрывать запрос через `AbortController`, а не только
   `reader.cancel()`, чтобы llama.cpp отменил задачу сразу.
4. **Таймаут для `complete()`.** Один helper `withTimeout(signal, ms)` в
   `llm/adapter.ts`, применить во всех 12 вызовах; для локальных — большой.
   Фоновые задачи на локальной модели должны и в UI говорить «это займёт минуты».
5. **Замечание про «Advanced»-фичи на медленной модели.** У пользователя включены
   `recon, clarify, verify, smoke, review, judge` (всё, кроме `design`). Каждая —
   ещё один-два полных запроса: `clarify` = `complete()` на первом сообщении,
   `review` = суб-агент со своим стримом, `judge` до 2 отказов. На 10 ток/с это
   часы. Предложение: пресет «Local / slow» (авто-off для clarify/review/smoke,
   когда активный провайдер локальный) с явным словом на карточке.

Побочно измерено: на этой машине prefill быстрее на 16 потоках (10 ток/с), чем
на 8 (7 ток/с) — вопреки подсказке в реестре флагов Monet Local про
«физические ядра». Для генерации может быть иначе; стоит измерить отдельно.

---

## 4. Промпты — где 20 тысяч и как их убрать

### 4.1 Что дублируется
«Читай файл перед правкой», «проверь перед тем, как сказать „готово"», «не коммить
без просьбы», «не делай лишнего» встречаются по 3–4 раза: вендорные «Doing tasks»
(831) + «Executing actions» (708) + наш `method` (251) + `discipline` (513) +
протоколы внутри Bash (2 398). Это 4 700 ток. на одну и ту же дисциплину.

### 4.2 Вендорный промпт нельзя править из «Prompts»
Секция Advanced → Prompts обещает «The system prompt … editable Markdown files».
Неправда для главного: реальный промпт строит `engine/constants/prompts.ts`
(0 вызовов `tunablePrompt`), а ключи `system-intro`, `system-doing-tasks`… живут в
`agent/prompts-vendor.ts` — это **fallback**, который вызывается только если
вендорный билдер упал (в папке пользователя этих файлов нет — значит, ни разу).
Правятся только блоки приложения (29 файлов).

### 4.3 План диеты (оценка экономии в Code)

| # | Что | Было | Станет | Как |
|---|---|---:|---:|---|
| 1 | Bash: протоколы commit/PR → отдельный блок, подгружаемый когда пользователь просит коммит (по образцу `skillsSection` в самом вендоре) | 2 398 | ~700 | `BashTool/prompt.ts` + `lean-context.ts` |
| 2 | Один шелл на Windows: Bash **или** PowerShell (настройка, дефолт — один) | 1 817 | 0 | `vendor-tools.ts:getVendorTools` |
| 3 | TodoWrite → 150 ток. (правила уже в «Task management») | 920 | 150 | `TodoWriteTool/prompt.ts` |
| 4 | Схемы: сократить `.describe()` у Routine (18 шт.), Grep (14), NotebookEdit (14), AskUserQuestion, CreateSkill, ObsidianAttach | ~2 200 | ~900 | соответствующие `inputSchema` |
| 5 | Отложить (ToolSearch) первопартийные тулы, нужные редко: Obsidian×6, Routine, CreateSkill, AgentSwarm, TeamList/SendMessage, ReadMediaFile, UpdateGoal, Enter/Exit/UpdatePlan, LSP | ~5 500 | ~300 (строка-инвентарь) | `deferred-inventory.ts` уже умеет это для MCP; расширить на `ALL_TOOLS` с признаком `deferrable` |
| 6 | Вендорные «Doing tasks»+«Executing actions»+`method`+`discipline` → один блок «Working rules» | 2 303 | ~600 | сделать `prompts-vendor.ts` **основным** путём (он и так тюнится), с компактными дефолтами; вендорный — fallback |
| 7 | `chart-widget` (513) — только по запросу/в Home; `vault-rules` 563 → 150 | 1 076 | ~200 | `index.ts:buildDirectives`, `obsidian/prompt.ts` |
| 8 | Суб-агенты: тот же объединённый блок вместо method+discipline (760 на каждого) | 760 | 600 | `subagent.ts:106` |

Итого Code: ≈ 20 500 → **≈ 8–9 000**; Home ≈ 12 700 → ≈ 6 000. Первый ход на
локальной модели: 34 мин → ~14 мин; дальше при стабильном префиксе (§4.5)
платится только дельта.

Порядок: 5 → 2 → 1 → 6 → 4 → 3 → 7 → 8 (по токенам за час работы). Пункт 6
самый спорный: это переписывание «конституции» — делать отдельным коммитом с
прогоном `scripts/eval` / dev-api на 3–5 сценариях до и после.

### 4.4 Что НЕ трогать
`Read`/`Edit`/`Write`/`Glob`/`Grep` описания (кроме схемы Grep), `identity`,
`Session guidance`, `Environment`. Правила безопасности из «Executing actions»
перенести дословно, не пересказывать.

### 4.5 Стабильный префикс (для локальных моделей это важнее размера)
Всё, что меняется между ходами, — в **хвост** запроса (последнее user-сообщение
или `<system-reminder>` после него), а не в system: browser directive, deferred
directive, memory index, lessons, дата (вендор её и так пишет в Environment —
достаточно даты без времени). Проверка: два хода подряд → `n_prompt_tokens_cache`
в `/slots` должен покрывать весь system + tools.

### 4.6 Инструмент измерения
`scripts/measure-prompt.mjs` не собирается (нет алиаса `@shared`; `better-sqlite3`
после `postinstall` собран под Electron и не грузится в Node). Починить: алиас
`@shared`, стаб `better-sqlite3` через `-r`-хук, вывод **по инструментам и по
секциям** (как в этом аудите), запуск для обоих пространств. Без этого диету
не измерить, а неизмеренная диета — это как «0,7 threshold» в compaction.
Для локальных моделей точный счёт даёт `POST /tokenize` llama.cpp — можно
использовать в счётчике контекста вместо `chars/4` (проверить, что эндпоинт
проксируется роутером с `?model=`, как `/slots`).

---

## 5. План для Опуса

### Этап 1 — таймаут (½ дня)
Файлы: `provider/types.ts`, `llm/adapter.ts`, `llm/anthropic-client.ts`,
`llm/openai-compat-client.ts`, `agent/index.ts` (участок 1933–2160),
`renderer/components/providers/ProviderSettings.tsx`,
`renderer/components/settings/AdvancedSettings.tsx`, `ipc/tuning.ts`, `chatStore.ts`.
1. `streamTimeoutSec` в модели/провайдере + глобальный дефолт в Advanced; дефолт
   по виду провайдера (локальные — 1800 или ∞ при прогрессе).
2. `return_progress` + событие `prompt_progress` + индикация в чате.
3. `streamError` → конец хода без nudge; `AbortController` при срабатывании.
4. `withTimeout` для всех `complete()`.
Проверка: `scripts/empty-turn-probe.ts` (расширить кейсом «ошибка стрима не
нуджится»), живой прогон через dev-api на Monet Local с промптом ≥ 5k токенов:
ни одного «timed out», в чате виден прогресс, Stop отменяет задачу в `/slots`
за ≤ 2 с.

### Этап 2 — диета промптов (1–2 дня)
Сначала §4.6 (измеритель), затем §4.3 по порядку 5 → 2 → 1 → 6 → 4 → 3 → 7 → 8,
каждый пункт — отдельный коммит с числами «до/после» в сообщении. Критерий:
Code ≤ 9 000, Home ≤ 6 000 при конфигурации пользователя; ни одна строка с
NEVER/IMPORTANT/CRITICAL из вендорных правил безопасности не потеряна
(проверка есть в `measure-prompt-probe.ts`: `RULES LOST`). Затем §4.5 и
проверка кэша по `/slots`.

### Этап 3 — память (1–1,5 дня)

Решение (принято 2026-09-09): **проход после хода (`extractEveryMinutes`) выпиливается
целиком**, вместе с дневными журналами. Память пополняют два явных действия —
`Remember` из чата и заметка на странице Memory — и один ночной проход, который
приводит файлы в порядок. Ничего не происходит «само по себе» после каждого
сообщения, и ничего не стоит вызова модели, кроме ночи.

#### 3.1 Что удалить (найдено grep'ом, полный список)
| файл | что |
|---|---|
| `memory/extract.ts` | `runLogPass`, `LOG_SYSTEM`, `parseBullets`, `maybeExtractMemory`, `lastRun`. Остаётся только `addMemoryNote` — и тот переписывается (3.3) |
| `memory/daily-log.ts` | файл целиком (`appendDailyLog`, `readLogsSince`, `pendingBulletCount`, `logsRoot`, `dailyLogPath`) |
| `memory/store.ts:45,83,92,100` | поле `extractEveryMinutes` из `MemoryConfig`, `DEFAULT_EXTRACT_MINUTES`, чтение/кламп в `getMemoryConfig` |
| `ipc/chat.ts:695–697` | хук после хода (`getConversationText` + `maybeExtractMemory`) |
| `agent/index.ts:407` | `getConversationText` — единственный потребитель был тот хук |
| `ipc/memory.ts:18,46` | импорт `pendingBulletCount`, поле `pending` в `memory:consolidationState` |
| `preload/index.ts:682–688`, `renderer/types/electron.d.ts:848–853` | типы конфига |
| `renderer/…/MemorySettings.tsx:177,309–325` | карточка «Memory extraction» и `extractEveryMinutes` в стейте |
| `memory/dir/memdir.ts:319,427` | вендорный код журналов — уходит вместе с п.3.6 |
| папка `<dataDir>/claude/memory/logs/` | не читать; при миграции просто удалить (у пользователя пуста) |

#### 3.2 Ночной проход без журналов
`consolidate.ts` сейчас построен вокруг журнала: гейт `pendingBulletCount ≥ 3`,
промпт «turn the raw logs into memory», сводка «Consolidated N log entries».
Без журнала он не запустится никогда. Переписать:
- **Гейт** — «есть файлы, изменённые после `lastConsolidatedAt`» (mtime по
  `listMemoryFiles()`), а не число буллетов. Ноль изменённых — не просыпаться.
- **Вход** — только `CURRENT MEMORY` (все файлы, как сейчас, потолок 14 000 симв.)
  + `RECENT SESSIONS` (заголовки). Промпт: «файлы пополнялись append'ом, слей
  дубликаты, разведи по topics/areas, убери противоречия, перепиши индекс».
  Формат ответа (upserts/deletes/index) не меняется.
- **Сводка** — «Обновлено N файлов, индекс переписан».
- `MIN_HOURS 20`, окно 03–05, catch-up 36 ч, `force` с кнопки — как есть.
- Уроки проектов (`lessons.ts`) журнал не используют — не трогать, кроме гейта (3.4).

#### 3.3 Поле заметки → append
`addMemoryNote` перестаёт вызывать модель. Заметка дописывается в `profile.md`
тем же кодом, что `Remember` (`writeMemoryFile` с append, как в
`remember-tool.ts:~110`). Раскладка по topics/areas — работа ночного прохода.
Это убирает последний путь полной перезаписи из интерактива и единственный
вызов **активной** модели чата из памяти.

#### 3.4 Одна страница, один гейт на уровень
`generateMemory` переименовать по смыслу: он теперь гейтит только ночь.
Страница Memory, сверху вниз:
1. **Использовать память в чатах** — один тумблер: `buildMemoryPrompt`,
   `buildLessonsPrompt`, `SearchPastChats`, реклама `Remember`. Заменяет
   `features.lessons` (инжект) и `searchChats`.
2. **Пополнение** — три строки с ценой словами:
   - «Агент запоминает сам» (`Remember`) — бесплатно;
   - «Заметка вручную» — поле ввода, бесплатно;
   - «Ночью приводить в порядок» — один тумблер на консолидацию **и** уроки
     (сейчас два гейта: `memory.generateMemory` для генерации и `features.lessons`
     для инжекта — и на этой машине они расходятся), «один вызов фоновой модели за
     ночь». Кнопки «Consolidate now» / «Learn now» рядом; при выключенном
     тумблере подпись «автозапуск выключен».
3. **Содержимое** — You / Topics / Areas, как сейчас, плюс секции **Lessons**
   (переезжает сюда целиком) и **Между запусками** (`runNotes` — тоже память
   проекта, пишет её goal-режим).
Из Advanced уходит вся группа «Between runs». Граница: Advanced — что агент
делает на ходу; Memory — что он помнит. `agent-features.json` теряет ключи
`lessons`, `runNotes` (миграция: если были `true` — включить п.1/п.2 памяти).

#### 3.5 «Кто пользователь» — один блок
`profile.json` (имя, работа, «о себе») показывать первым файлом в секции You и
инжектить одним блоком `# About the user` вместе с `profile.md`. `identity`
остаётся отдельно (это про агента). Vault — отдельный короткий блок (§4.3 п.7).

#### 3.6 Мёртвый вендорный слой
Удалить `memory/dir/*` (единственный живой импорт —
`plugins/loadPluginAgents.ts:3 isAutoMemoryEnabled`, заменить на `false`),
`engine/services/extractMemories|autoDream|SessionMemory`, `autoDreamEnabled` в
`settings/types.ts:950`, вызов `loadMemoryPrompt` в `engine/constants/prompts.ts:473,492`.
После этого `applyLeanEnv()` и его «строго до первой сборки» не нужны.

#### 3.7 Остальное
- `TOTAL_CAP` в `buildMemoryPrompt` считать вместе с индексом; блок памяти и
  уроки — в хвост запроса (§4.5), не в system.
- Таймауты всем `complete()` — из этапа 1.
- `remember-tool.ts`, `daily-log.ts` (удаляется), `consolidate.ts` — заголовки
  под реальное поведение.
- `ipc/transfer.ts` экспортирует `buildMemoryPrompt()` как текст — после
  переезда профиля проверить, что экспорт/импорт несут те же файлы.

Проверка этапа: (а) `npm run typecheck` без упоминаний `extractEveryMinutes`,
`daily-log`, `getConversationText`; (б) `Remember` + заметка → файлы appended;
(в) «Consolidate now» с двумя дописанными файлами → индекс переписан, файлы
слиты, сводка «Обновлено N файлов»; (г) при выключенной ночи кнопка работает и
подписана; (д) Advanced не содержит «Between runs».

### Что ещё всплыло, вне трёх тем
- `providers.json` пользователя: OpenRouter-модель `deepseek-v4-flash` с
  `maxOutputTokens: 943718`. `sanitizeMaxTokens` (`llm/adapter.ts:86`) только
  подставляет 16000 вместо пустого и не клампит сверху — `max_tokens: 943718`
  улетает в API как есть. Клампить по `contextLength − input`.
- `computeContextBreakdown` считает `chars/4`; для русского — ×2. Счётчик врёт в
  меньшую сторону ровно тем, кому он нужнее.

---

## 6. Что сделано (2026-09-09, по этому плану)

| коммит | что |
|---|---|
| `166f313c` | Этап 1 целиком: таймаут-настройка, `return_progress` + прогресс в чате, срыв стрима не нуджится, дедлайн у `complete()` |
| `7a983284` | §4.6: измеритель починен, стал сторожем правил |
| `97d4b098` | §4.3 п.5: откладываются и свои инструменты, не только MCP |
| `dfd20b77` | §4.3 п.2: один шелл на Windows |
| `55665e60` | §4.3 п.1: git-рецепт в `/commit`, правила остались дословно |
| `6e3667eb` | §4.3 п.3 и часть п.7: TodoWrite переписан, формат графиков в `/chart` |
| `82b3ad7b` | сторож графиков переехал следом за форматом |
| `ba9d35ea` | Этап 3: память |

Контекст до первого слова, одна и та же конфигурация (хранилище + LSP):

| | Code | Home |
|---|---:|---:|
| было | 20 444 | 14 370 |
| стало | **12 035** | **9 295** |

Цель §4.3 (9 000 / 6 000) не достигнута: не делались пункты 6 (слияние
вендорных «Doing tasks» + «Executing actions» с `method`/`discipline`),
4 (схемы — крупнейшая оставшаяся, Grep 589), 8 (суб-агенты) и §4.5
(стабильный префикс). Пункт 6 — самый рискованный в плане и остался
последним намеренно.

### Отклонения от плана, с причинами

**§3.6 не сделан, и не должен быть.** План считал `memory/dir` и вендорные
`autoDream`/`extractMemories`/`SessionMemory` мёртвым параллельным слоем.
Проверено: 33 ссылки в 20+ файлах, и `isAutoMemoryEnabled()` определяет, как
**файловые инструменты**, загрузчик агентов и swarm опознают файл памяти. Это
общая механика, а не остатки второго хранилища. Мёртв только путь —
`loadMemoryPrompt()` в системном промпте, — и его держит мёртвым переменная
окружения в `applyLeanEnv()`. Комментарий там теперь это и говорит.

**§3.4 «один гейт на уровень» — с оговоркой по миграции.** `useInChats`
наследуется от `searchChats`, `nightly` от `generateMemory`, `runNotes` — из
`agent-features.json`. Старый `lessons` (инжект уроков) отдельного наследника
не получил: он сливается в `useInChats`. Кто выключал его при включённом
`searchChats`, получит уроки обратно; карточка прямо перечисляет, что
покрывает переключатель.

**§4.3 п.1 дал 1 456, а не ~700.** Разница — блок правил безопасности,
перенесённый дословно (§4.4), а не пересказанный.

**Найдено попутно:** в `smoke:agent` четыре проверки давно красные — они
адресуют инструмент `CreateRoutine`, переименованный в `Routine`. Вынесено
отдельной задачей. Красная навсегда проверка — это место, где прячется
настоящая регрессия: моя правка графиков сломала девять проверок в том же
пробнике, и заметить это удалось только сравнив счёт с базовым.

---

## 7. Кэш префикса: что измерено (2026-09-09)

§4.5 был догадкой; вот измерения. Qwen3.8-27B через роутер, `return_progress`
даёт поле `cache` — сколько токенов промпта **не** пришлось читать.

### Где стоит изменчивый блок

Промпт 1 763 токена, меняется одна строка:

| где | переиспользовано | перечитано |
|---|---:|---:|
| в начале системного промпта (как делал `buildDirectives`) | 23 / 1763 | **99 %** |
| в конце системного промпта | 1732 / 1763 | 2 % |
| в хвосте сообщений (как теперь) | 1740 / 1767 | 2 % |

На реальных 11 660 токенах при 10 ток/с 99 % — это **девятнадцать минут
перечитывания на каждый ход**, потому что скан dev-серверов вернул другой
ответ. Исправлено (`e8ec44fa`).

### Где стоят схемы инструментов

Шаблон Qwen кладёт блок инструментов **отдельным системным сообщением перед**
пользовательским. Измерено:

| что изменилось | переиспользовано | перечитано |
|---|---:|---:|
| системный промпт | 1234 / 1272 | 3 % |
| один раскрытый инструмент | 23 / 1336 | **98 %** |

Два следствия.

1. Изменение системного промпта **не** обесценивает схемы — они раньше. Это
   снимает часть тревоги: блоки приложения в конце `system` дёшевы.
2. **Раскрытие отложенного инструмента обесценивает весь запрос.** Это
   настоящая цена §4.3 п.5, и её надо называть: экономия 4 727 токенов на
   каждом ходе против полного перечитывания на том ходе, где ToolSearch
   что-то загрузил. Точка безубыточности — примерно один раскрытый инструмент
   на 2,5 хода; на практике большинство чатов не трогает ни хранилище, ни
   рутины, ни ноутбуки, и не раскрывает ничего.

### Что это значит для пункта 6

После §4.5 сокращение **стабильной** части оплачивается один раз за
разговор, а не каждый ход. Пункт 6 (слияние вендорных «Doing tasks» и
«Executing actions» с `method`/`discipline`, ~1 700 токенов) — самый
рискованный в плане: это переписывание правил, в том числе о необратимых
действиях, а §4.4 требует переносить их дословно. Его выигрыш упал на
порядок, а риск нет.

Рекомендация: **не делать вслепую.** Если делать — то отдельным коммитом и с
прогоном 3–5 сценариев через dev-api до и после, как и написано в §4.3. То же
про пункт 8 (суб-агенты): он не влияет на стоимость основного хода вообще.

### Найдено, но НЕ сделано: у Anthropic кэш надо просить

Локальный сервер кэширует префикс сам. У Anthropic — нет: кэширование
включается пометками `cache_control: {"type": "ephemeral"}` в теле запроса.
В `llm/anthropic-client.ts` таких пометок нет ни одной (`grep cache_control`
— пусто), хотя ответ приложение читает: `cache_read_input_tokens` и
`cache_creation_input_tokens` разбираются и показываются в счётчике. То есть
метрика есть, а причины для неё — нет: каждый ход платится полностью.

Что нужно, коротко:

- `system` перевести из строки в массив блоков и пометить последний;
- пометить последний элемент `tools`;
- обе пометки — только когда `kind === "anthropic"` и хост
  `api.anthropic.com`. Тем же клиентом ходит DeepSeek (anthropic-совместимый
  эндпоинт), и он может не принять ни массив, ни поле.

Почему не сделано сейчас: через этот клиент идёт **весь** трафик Anthropic и
DeepSeek, а проверить форму тела можно пробником, ответ API — нет. Ошибка в
форме означает 400 на каждом запросе к основному провайдеру. Это ровно тот
класс правки, который нельзя делать вслепую; нужен один живой запрос и взгляд
на `cache_read_input_tokens` в ответе.

Порядок блоков для этого уже правильный: стабильное впереди, изменчивое в
хвосте (§7). Пометки лягут на готовое.
