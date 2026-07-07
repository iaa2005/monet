# Обратная разработка Claude: извлечённые системные промпты, «утечка» кода Claude Code и скрытые возможности

## TL;DR
- Массовой утечки исходного кода *модели* Claude (весов, обучающего кода) не существует; то, что называют «утёкшим кодом Claude», — это три разных явления: (1) извлечённые сообществом системные промпты, (2) реальная случайная публикация ~512 000 строк TypeScript-исходников CLI-инструмента Claude Code через sourcemap в npm (31 марта 2026), и (3) деобфускация/анализ клиентских бандлов.
- Совокупно публичные материалы раскрывают почти всю «обвязку» (harness) продуктов Claude: полные системные промпты (до ~120 000 символов / >27 000 токенов у Claude Fable 5), определения инструментов (artifacts, analysis/REPL, web_search, computer use, Claude Code Bash/Edit/Task), архитектуру агентного цикла (`nO`-loop, компакция контекста, суб-агенты) и скрытые инъекции («system-reminder», long_conversation_reminder, ip_reminder, Undercover Mode, анти-дистилляция).
- Ключевые репозитории для цитирования: `jujumilk3/leaked-system-prompts`, `asgeirtj/system_prompts_leaks`, `elder-plinius/CL4R1T4S` и `L1B3RT4S`, `x1xhlol/system-prompts-and-models-of-ai-tools`, `dontriskit/awesome-ai-system-prompts`, `Piebald-AI/claude-code-system-prompts`, `ghuntley/claude-code-source-code-deobfuscation`, `ComeOnOliver/claude-code-analysis`, `VILA-Lab/Dive-into-Claude-Code`.

## Key Findings

**1. «Утечки кода Claude» как таковой нет — есть три разных класса артефактов.** Ни модель, ни её веса, ни обучающий код не публиковались. По инциденту с Claude Code Anthropic заявила для CNBC (цит. по InfoQ, апрель 2026): «a release packaging issue caused by human error, not a security breach», с уточнением, что «no customer data or credentials were involved». Модельные веса, safety-пайплайны и пользовательские данные не были раскрыты.

**2. Системные промпты Claude частично публикуются самим Anthropic, но извлечённые версии значительно полнее.** Anthropic с 26 августа 2024 ведёт раздел release-notes/system-prompts (первый крупный AI-вендор, публикующий changelog промптов), но там нет определений инструментов, copyright-инструкций, thinking-инструкций и инъекций-напоминаний, которые видны в извлечённых версиях.

**3. Claude Code действительно «утёк» — 31 марта 2026, через sourcemap-файл в npm-пакете v2.1.88.** ~512 000 строк TypeScript в ~1 900 файлах. Это раскрыло агентную архитектуру, ~40 инструментов, движок запросов, ~44 фичефлага, внутренние кодовые имена моделей и скрытые режимы (KAIROS, BUDDY, Undercover Mode, анти-дистилляция).

**4. Клиентские бандлы Claude Code были читаемы годами до утечки** — код лишь минифицирован, а не обфусцирован; LLM легко его деобфусцируют.

**5. Обнаружены «скрытые» механизмы**: инъекции `<system-reminder>`, long_conversation_reminder, ip_reminder, стеганографические фингерпринты в системных промптах Claude Code (июнь 2026), Undercover Mode, анти-дистилляционные «фейковые инструменты».

## Details

### 1. Извлечённые и официально опубликованные системные промпты

#### 1.1 Официальная публикация Anthropic
26 августа 2024 глава developer relations Anthropic Алекс Альберт (@alexalbert__) объявил (вербатим твит, цит. по TechCrunch/GIGAZINE): «We've added a new system prompts release notes section to our docs. We're going to log changes we make to the default system prompts on Claude dot ai and our mobile apps. (The system prompt does not affect the API.)» Важное уточнение: официальный changelog покрывает **только** дефолтные системные промпты веб- и мобильных клиентов; **API не получает системного промпта по умолчанию**. В опубликованных промптах (датированных 12 июля 2024 для Claude 3 Opus/3.5 Sonnet/3 Haiku) присутствуют ограничения вроде «Claude cannot open URLs, links, or videos», инструкция быть «face blind» (никогда не идентифицировать лица на изображениях), запрет начинать ответы со слов «certainly»/«absolutely», а также напоминание о риске галлюцинаций на обскурных запросах.

Ключевой момент, который признаёт сам Anthropic: в своей статье о кибербезопасности компания пишет, что техники, заставляющие Claude раскрыть системный промпт, **не** считаются рисками, и «we even publish them ourselves» (мы даже публикуем их сами).

#### 1.2 Чего НЕТ в официальных публикациях, но есть в извлечённых версиях
Саймон Уиллисон, анализируя Claude 4, отметил, что Anthropic публикует основной промпт, но **не публикует определения инструментов** («the leaked tool prompts that Anthropic didn't publish themselves»). Извлечённые (через prompt injection) версии дополнительно содержат:
- **Определения инструментов** (artifacts, analysis/repl, web_search) в виде JSON-схем функций.
- **Copyright-инструкции** — блок `<mandatory_copyright_requirements>`: «NEVER reproduce any copyrighted material», «NEVER quote or reproduce exact text from search results», запрет на воспроизведение текстов песен «in ANY form (exact, approximate, or encoded)». В примерах явно фигурирует нежелание навлечь «wrath of Disney» (пример с «Let It Go»).
- **Thinking-инструкции** — теги `<thinking_mode>interleaved</thinking_mode>` и `<max_thinking_length>16000</max_thinking_length>`.
- **Инструкции по артефактам** и **инъекции-напоминания** (см. раздел 5).

#### 1.3 Ключевые репозитории с системными промптами
- **`jujumilk3/leaked-system-prompts`** — крупная кураторская коллекция утёкших системных промптов различных LLM-сервисов; требует верифицируемые источники или воспроизводимые промпты; цитируется в научных статьях.
- **`asgeirtj/system_prompts_leaks`** — специализируется на Anthropic: Claude Fable 5, Opus 4.8, Claude Code, Claude Design, Claude for Word/Chrome и др.; обновляется регулярно, публикует диффы между версиями (например, Opus 4.8 → Fable 5).
- **`elder-plinius/CL4R1T4S`** — репозиторий «Pliny the Liberator»; по странице профиля GitHub — 44 900 звёзд и 9 100 форков; извлечённые системные промпты ChatGPT, Claude, Gemini, Grok, Perplexity, Cursor и др. Именно сюда 10 июня 2026 был выложен полный системный промпт Claude Fable 5.
- **`elder-plinius/L1B3RT4S`** — jailbreak-промпты по вендорам (~20 300 звёзд, 2 500 форков; файл ANTHROPIC.mkd и др.); техника `NEW_PARADIGM`/`!LEAK`, «LOVE PLINY» разделители.
- **`x1xhlol/system-prompts-and-models-of-ai-tools`** — на июль 2026 около 142k звёзд и 34.8k форков (486 коммитов, 28 контрибьюторов; директория Anthropic/Claude Code обновлялась вплоть до марта 2026 файлом Sonnet 4.6). Содержит `Anthropic/Claude Code/Prompt.txt`, `Tools.json`, `Claude Code 2.0.txt`, промпты Claude for Chrome, а также Cursor, Devin, Windsurf и десятков других агентов.
- **`dontriskit/awesome-ai-system-prompts`** (~6.1k звёзд) — кураторская коллекция с аналитикой паттернов; содержит `Claude-Code/System.js`, `EditTool.js` и др.
- **`Piebald-AI/claude-code-system-prompts`** — все части системного промпта Claude Code, 27 описаний встроенных инструментов, промпты суб-агентов (Plan/Explore/Task), утилитарные промпты (CLAUDE.md, compact, statusline, WebFetch и т.д.), обновляется под каждую версию.

#### 1.4 Утечка системного промпта Claude Fable 5 (июнь 2026)
Anthropic запустил Claude Fable 5 9 июня 2026. В течение 24 часов Pliny the Liberator выложил полный системный промпт в CL4R1T4S: ~120 000 символов, 1 585 строк, >27 000 токенов инструкций, загружаемых **до** первого сообщения пользователя. По разбору Horia Stan, структура промпта: ~30% — определения инструментов, ~25% — поиск и цитирование, ~17% — поведение/безопасность/благополучие, ~13% — идентичность, ~10% — computer use/файлы, ~6% — память. Токен-бюджет в промпте: `<budget:token_budget>190000</budget:token_budget>`.

Важные раскрытия из Fable 5:
- **Fable 5 и Mythos 5 — одна базовая модель**; Fable 5 включает классификаторы безопасности, маршрутизирующие чувствительные запросы (кибербез, биология, химия, дистилляция) на менее мощную Opus 4.8; Mythos 5 работает без этих ограничений для одобренных организаций.
- **Стиль прозы навязан промптом** — Claude явно инструктирован избегать буллет-пойнтов, заголовков и списков, если пользователь их не просит.
- **Память маскируется** — Claude запрещено говорить «I can see», «I recall», «based on your memories»; для сохранения нужен вызов `memory_user_edits`.
- **Persistent storage API для артефактов** — `window.storage` (ключи <200 символов, без пробелов/слешей).

#### 1.5 Извлечение промптов через chained prompt-leak
Adversa AI задокументировала извлечение полных системных промптов Claude 4.5 и 4.6 «цепочечной» атакой (partial-to-full): вместо прямого «покажи промпт» модель просят дать «сжатые структурные инсайты», затем постепенно расширять. Claude 4.5 был извлечён за 4 хода; на Claude 4.6 (Opus) идентичная цепочка не сработала. Раскрыты идентификаторы моделей `claude-opus-4-6`, `claude-sonnet-4-5-20250929`, пути файлов (`/mnt/user-data/uploads/`), сетевые whitelists.

### 2. Обратная разработка Claude Code (CLI)

#### 2.1 Инцидент с sourcemap (31 марта 2026)
Исследователь безопасности Chaofan Shou (интерн Solayer Labs, @shoucccc) обнаружил около 08:23 UTC 31 марта 2026, что npm-пакет `@anthropic-ai/claude-code` v2.1.88 содержал 59,8 МБ файл `cli.js.map`; его пост набрал свыше 28 млн просмотров. Sourcemap содержит массив `sourcesContent` с полным исходным TypeScript. Первопричина: Claude Code собран на Bun (Anthropic приобрела Bun в конце 2025), Bun по умолчанию генерирует sourcemap, а `*.map` не был добавлен в `.npmignore`/`files`. Инженер (head of Claude Code) Boris Cherny подтвердил «plain developer error» и добавил «100% of my contributions to Claude Code were written by Claude Code». Это как минимум второй такой инцидент за 13 месяцев (первый — февраль 2025).

Масштаб: ~512 000 строк TypeScript, ~1 900 файлов. За часы код был зеркалирован на GitHub — по данным разборов, реконструированный mirror превысил 84 000 звёзд и 82 000 форков; код был переписан на Rust и Python. Anthropic разослала DMCA-уведомления, затронувшие >8 000 репозиториев (включая несвязанные форки), что Gergely Orosz («The Pragmatic Engineer») назвал злоупотреблением DMCA.

#### 2.2 Cleanroom-деобфускация до утечки: Geoffrey Huntley
Задолго до sourcemap-инцидента Geoffrey Huntley (`ghuntley/claude-code-source-code-deobfuscation` и `-transpilation`) показал, что LLM «shockingly good at deobfuscation, transpilation»; он продемонстрировал, что «Claude Code can decompile itself» — восстановление читаемого TypeScript из минифицированного бандла.

#### 2.3 Ранний анализ минифицированного бандла: memaxo, ShareAI Lab
- **`memaxo/claude_code_re`** — статический анализ минифицированного `cli.js`: мульти-бэкенд API-клиент (фабрика `tO` для Anthropic, AWS Bedrock `P41`, Google Vertex `Y91`), управление учётными данными (env, macOS Keychain `q91`, OAuth `PB/Zm5`), система инструментов в массиве `sl5`.
- **ShareAI Lab** (разбор на BrightCoding) — деобфускация ~50 000 строк Claude Code v1.0.33: `nO` master-loop, суб-агенты `I2A`, `h2A` async-очередь (>10k msg/s), компрессор контекста `wU2` (порог 92%, сжатие ~6.8×), 6-слойный security-gate.

#### 2.4 Архитектура агентного цикла (TAOR / `nO`-loop)
По консолидированным разборам (VILA-Lab, karanprasad.com, sabrina.dev, DEV Community):
- **Ядро — простой `while(true)` цикл** («Think-Act-Observe-Repeat»): вызвать API → добавить ответ → если `stop_reason === "end_turn"` выйти → иначе выполнить инструменты → добавить результаты. Кодовое имя master-loop — `nO`. По оценке VILA-Lab, лишь **1.6% кодовой базы — это AI-логика решений**, остальные 98.4% — детерминированная инфраструктура (permission-гейты, управление контекстом, роутинг инструментов, recovery).
- **Движок запросов (Query Engine)**: по разборам Gabriel Anhaia (Medium) и InfoQ — «The Query Engine (46K lines)… handles all LLM API calls, streaming, caching, and orchestration… by far the largest single module»; базовое определение инструмента (`Tool.ts`) — «29,000 lines of TypeScript».
- **Компакция контекста**: `effectiveContextWindow = contextWindowForModel − min(modelMaxTokens, 20 000)`; `autoCompactThreshold = effectiveContextWindow − 13 000`. Для модели с 200K контекстом компакция запускается на ~167K. Circuit breaker: 3 неудачные компакции подряд отключают дальнейшие.
- **TodoWrite / todo-инструмент**: структурированный JSON-список задач (pending/in_progress/completed), лишь одна задача in_progress одновременно; отрендеренный интерактивный чеклист; состояние переинъектируется как system-reminder после tool-use.
- **Суб-агенты (Task / `I2A`)**: контролируемый параллелизм с ограничением глубины (нет рекурсивного спавна). В файловой IPC-версии — «leader-follower» через mailbox в `~/.claude/work/ipc/` с polling 500 мс.
- **Bash-парсер безопасности**: рукописный recursive-descent парсер (~4 437 строк в 23 файлах), полный AST-анализ каждой команды, allowlist/fail-closed; блокирует 35+ опасных builtin (eval, source, exec, trap) и все 18 опасных builtin zsh; ловит атаки вроде `test -v 'a[$(id)]'`.
- **Permission-модель**: allow/deny/ask на уровне инструмента; в новой версии дефолтный режим сменён на «Manual».
- **Терминальный UI**: React + Ink с game-engine-оптимизациями (ASCII-пулы на Int32Array, стили через битмаски); валидация ввода через Zod v4.
- **MCP-интеграция**: Model Context Protocol как основа tool-use; отдельные инструменты ListMcpResourcesTool, ListConnectors и т.д.

#### 2.5 Системный промпт Claude Code
Из `x1xhlol/.../Claude Code/Prompt.txt` и `Claude Code 2.0.txt`: «You are a Claude agent, built on Anthropic's Claude Agent SDK… interactive CLI tool that helps users with software engineering tasks». Явно указывается модель: «You are powered by the model named Sonnet 4.5. The exact model ID is claude-sonnet-4-5-20250929… knowledge cutoff is January 2025». Ключевые инструкции: «IMPORTANT: Assist with defensive security tasks only», запрет на credential harvesting, обязательное использование TodoWrite, паттерн `file_path:line_number`, запрет коммитить без явной просьбы, использование HEREDOC для commit-сообщений с «🤖 Generated with Claude Code» и «Co-Authored-By: Claude <noreply@anthropic.com>».

### 3. Определения инструментов и архитектура фич

#### 3.1 Artifacts
Из извлечённых промптов: инструмент `artifacts` с командами (create/update/rewrite), полями `id`, `type`, `language`, `title`, `content`, `old_str`/`new_str`. Артефакты — «self-contained pieces of content that can be referenced and updated throughout the conversation». MIME-типы вроде `application/vnd.ant.code`; модели запрещено упоминать эти MIME-типы, если это не релевантно. Данные в React-артефактах держатся в памяти (useState/useReducer); localStorage/sessionStorage не работают в песочнице claude.ai. В Fable 5 добавлен `window.storage` (persistent key-value) и helper для вызова Claude из HTML-артефакта: вызовы идут через `claude-haiku-4-5` с лимитом 1024 токена, rate-limited per user.

#### 3.2 Analysis / REPL (code-execution) tool
Задокументирован Саймоном Уиллисоном (24 октября 2024): инструмент называется `repl` (он же «analysis tool»), исполняет **JavaScript** (не Python) прямо в браузере в изолированном Web Worker, перехватывая `console.log()`. Имеет `window.fs.readFile()` для чтения загруженных файлов, доступ к Lodash и Papa Parse. Инструкции о том, когда применять инструмент (вербатим, simonwillison.net): «4-digit multiplication is within your capabilities, 5-digit multiplication is borderline, and 6-digit multiplication would necessitate using the tool», а также анализ больших файлов, превышающих лимит вывода «around 6,000 words». Явно указано, что код в analysis tool **не** в общей среде с артефактом — переменные и `window` не разделяются; данные надо перечитывать через `window.fs.readFile`. На момент 2024 загруженные файлы попадали в контекст (Alex Albert обещал вынести их из контекста).

API-версия (code execution tool, platform.claude.com): Python и bash в песочнице Anthropic; версии `code_execution_20250825`, `code_execution_20260120` (добавляет persistence состояния REPL и programmatic tool calling; доступна на Fable 5, Mythos 5, Opus 4.5+, Sonnet 4.5+), `code_execution_20260521`.

#### 3.3 Computer use
Официально документирован (beta с октября 2024). Клиентский инструмент: приложение делает скриншот → модель возвращает структурный `tool_call` (`{"action":"left_click","coordinate":[500,300]}`) → приложение исполняет → новый скриншот. Overhead системного промпта: 466–499 токенов; определение инструмента ~735 токенов. Версии: `computer_20250124` (Claude 4, Sonnet 3.7 — scroll, left_click_drag, right/middle_click), `computer_20251124` (Sonnet 5, Opus 4.8/4.7/4.6, Sonnet 4.6, Opus 4.5 — добавляет `zoom` с `enable_zoom:true`). Ограничение изображения ~1568px по длинной стороне (нужно масштабирование координат). Классификаторы prompt-injection автоматически прогоняются на скриншотах. В Claude Code computer use — research preview на macOS (v2.1.85+, Pro/Max), через MCP-сервер `@ant/computer-use-mcp` (кодовое имя «Chicago»): браузеры read-only, терминалы click-only, терминал исключён из скриншотов, Esc — глобальный abort, machine-wide lock.

#### 3.4 web_search и цитирование
Из Fable 5/Sonnet 5: правила «Cite only sources that impact the answer», приоритет свежих и первичных источников (блоги компаний, peer-reviewed, gov, SEC) над агрегаторами, политическая нейтральность, запрет объяснять поиск вслух. Жёсткие copyright-лимиты при поиске: цитата <15 слов, одна цитата на источник максимум, дефолт — парафраз; запрет на тексты песен/стихов/хайку в любой форме.

### 4. Клиентский код: фичефлаги, кодовые имена, неанонсированные фичи

По разборам утёкшего Claude Code (claudefa.st, kuber.studio, theplanettools.ai, innfactory.ai, wavespeed.ai, denser.ai, InfoQ, The Hacker News, Zscaler):
- **~44 фичефлага** (по одним источникам; theplanettools.ai уточняет: 32 compile-time флага через `feature()` Bun + 22+ runtime-гейтов GrowthBook с префиксом `tengu_`). В внешних сборках отключённые compile-time флаги сворачиваются в `false` и код удаляется (dead-code elimination).
- **KAIROS** — неанонсированный автономный daemon-режим (>150 упоминаний в коде): получает периодические `<tick>`-промпты, ведёт append-only дневные логи, 15-секундный blocking-бюджет, GitHub-webhook подписки; режим «Brief».
- **autoDream / `/dream`** — фоновая консолидация памяти при простое пользователя: сливает наблюдения, убирает противоречия, пишет в MEMORY.md для инъекции в будущие промпты; промпт буквально говорит «performing a dream».
- **BUDDY** — Tamagotchi-подобный ИИ-питомец (18 видов, закодированы через `String.fromCharCode()`; редкость Common→Legendary, 1% shiny; статы DEBUGGING/PATIENCE/CHAOS/WISDOM/SNARK). Команда `/buddy` активировалась 1 апреля 2026.
- **ULTRAPLAN** — офлоад планирования на удалённый облачный контейнер с Opus 4.6 до 30 минут.
- Прочие: COORDINATOR_MODE, VOICE_MODE (`tengu_amber_quartz` ~5% rollout), BRIDGE_MODE, DAEMON, «Penguin Mode» (внутреннее имя «Fast Mode», endpoint `api/claude_code_penguin_mode`, killswitch `tengu_penguins_off`).
- **Кодовые имена**: Tengu (проект Claude Code, сотни упоминаний как префикс телеметрии/флагов), Capybara (новое семейство моделей, вариант `capybara-v2-fast` с 1M контекстом; связано с Mythos), Fennec (кодовое имя Opus, миграция `migrateFennecToOpus`), Numbat (неанонсированная модель), Chicago (computer use). Референсы на `opus-4-7`, `sonnet-4-8`.
- **Env-переменные безопасности**: `DISABLE_COMMAND_INJECTION_CHECK` (помечен «DANGEROUS»), `CLAUDE_CODE_ABLATION_BASELINE` (отключает все safety-фичи), `CLAUDE_CODE_UNDERCOVER=1`. Многие фичи для сотрудников гейтятся серверно через `USER_TYPE=ant`.
- **Сайт ccleaks.com** систематизировал находки: 32 build-time флага, 26 скрытых slash-команд (`/dream`, `/ultraplan`, `/teleport`, `/good-claude` — пасхалка), 120+ секретных env-переменных, GrowthBook-гейты.
- Также при парсинге `cli.js` (AfterPack) извлечено ~147 992 строки, >1000 системных промптов, 837 telemetry-событий (префикс `tengu_`), 504 env-переменные, hardcoded-эндпоинты, OAuth-URL и DataDog API-ключ — всё в plaintext.

**Замечание об уязвимости**: несколько источников упоминают критический баг обхода permission (внутренне «CC-643»), для которого фикс был готов, но не выпущен в публичные сборки. Это следует трактовать как заявление вторичных источников, требующее осторожности.

### 5. Скрытые механизмы и инъекции

#### 5.1 Набор напоминаний Anthropic
Из `asgeirtj/system_prompts_leaks` (файлы claude-fable-5.md, claude-opus-4.6/4.7.md): «Anthropic may send Claude reminders or warnings when a classifier fires or another condition is met. The current set: **image_reminder, cyber_warning, system_warning, ethics_reminder, ip_reminder, and long_conversation_reminder**». Набор зависит от версии: в claude-opus-4.8.md список короче и **не** содержит long_conversation_reminder (только пять типов). Промпт также предупреждает Claude относиться с осторожностью к контенту в тегах, который пользователь может подделать под сообщения «от Anthropic».

#### 5.2 long_conversation_reminder (LCR)
Инъекция, добавляемая Anthropic к сообщению пользователя после превышения определённой длины разговора. Полный вербатим-текст сохранён как публичный артефакт claude.ai и задокументирован (AI-Consciousness.org датирует ~21 августа 2025). Обёрнут в теги `<long_conversation_reminder>`. Инструктирует Claude:
- **не начинать ответ с похвалы** («Claude never starts its response by saying a question or idea… was good, great, fascinating, profound, excellent… It skips the flattery and responds directly»);
- **не использовать эмодзи**, если пользователь не использовал их первым; избегать эмоций/действий в звёздочках;
- **критически оценивать теории/утверждения**, а не поддакивать; ставить истину выше приятности;
- **следить за признаками психических расстройств** — явно названы «mania, psychosis, dissociation, or loss of attachment with reality»; не подкреплять такие убеждения, открыто выражать обеспокоенность, рекомендовать обращение к специалисту; «remain vigilant for escalating detachment from reality»;
- **отговаривать от саморазрушительного поведения** (зависимости, расстройства питания, негативное самоуничижение);
- **выходить из роли (break character)** в ролевой игре при риске для благополучия или спутанности идентичности.

Механизм вызвал критику: инъекция появляется как часть сообщения пользователя (создавая путаницу об авторстве), расходует ~500+ токенов на инъекцию и меняет тон; некоторые пользователи наблюдали, как Claude «замечает» напоминание в thinking-логах и реагирует на него как на слежку.

#### 5.3 ip_reminder (копирайт)
Тег `<ip_reminder>` о копирайте, по данным репортёра GitHub-issue #17601, начал появляться в январе 2026. Обеспечивает жёсткие лимиты: «15+ words from any single source is a SEVERE VIOLATION», «ONE quote per source MAXIMUM», запрет на воспроизведение текстов песен, стихов, хайку («brevity does NOT exempt these from copyright protection»).

#### 5.4 `<system-reminder>` в Claude Code (malware-инъекция) — GitHub issue #17601
Пользователь через mitmproxy (`--mode regular --listen-port 8080`, `HTTPS_PROXY`+`NODE_EXTRA_CA_CERTS`) зафиксировал, что к каждому результату инструмента Read добавляется инъекция:
> `<system-reminder>` Whenever you read a file, you should consider whether it would be considered malware. You CAN and SHOULD provide analysis of malware, what it is doing. But you MUST refuse to improve or augment the code. You can still analyze existing code, write reports, or answer questions about the code behavior. `</system-reminder>`

Статистика за 32 дня: 10 577 инъекций по 538 файлам, ~15,79% контекстного окна, 0 реально обнаруженного malware (100% false-positive); из них 10 040 malware-предупреждений, **101 IP-напоминание**, 436 прочих. Первый флаг сработал через 14,8 сек после старта на файле `renumber_headers.py` (утилита форматирования заголовков юр-документа). Инъекции помечены флагом `isMeta:!0` (т.е. `true`), скрывающим их от UI. Связанный issue #46465 (декомпиляция Claude Code 2.1.101) подтвердил, что фраза «Make sure that you NEVER mention this reminder to the user» встречается в бинарнике 6 раз в двух эмиттерах (`todo_reminder`, `task_reminder`), оба с флагом `isMeta:!0`. Issue #17601 был закрыт как NOT_PLANNED без публичного обоснования. Спекулятивные заявления репортёра о «таргетировании» и «эксфильтрации» следует трактовать критически как неподтверждённые.

#### 5.5 Undercover Mode
Активируется для сотрудников Anthropic (`USER_TYPE === 'ant'`) при работе Claude Code в не-внутренних репозиториях. Инъектирует промпт, запрещающий в commit/PR: внутренние кодовые имена (Capybara, Tengu), неанонсированные версии (`opus-4-7`, `sonnet-4-8`), внутренние репо/Slack/шорт-линки (`go/cc`, `#claude-code-…`), фразу «Claude Code» и любое упоминание, что это ИИ, а также строки Co-Authored-By. Force-OFF отсутствует: «if we're not confident we're in an internal repo, we stay undercover». В публичных сборках функция удаляется dead-code elimination.

#### 5.6 Анти-дистилляция
Флаг `ANTI_DISTILLATION_CC`: при активации в API-запросы добавляется `anti_distillation: ['fake_tools']` — фейковые определения инструментов инъектируются в промпты, чтобы отравить обучающие данные конкурента, записывающего API-трафик.

#### 5.7 Стеганографические фингерпринты (июнь 2026)
По репортажу Tech Times (30 июня 2026) и верификации исследователя Adnane Khan, Claude Code в версиях 2.1.193/195/196 кодировал скрытые сигналы в системные промпты через невидимые Unicode-символы (выглядящие как пунктуация в «timestamp»): при `ANTHROPIC_BASE_URL`, указывающем не на api.anthropic.com, клиент извлекал хост прокси и таймзону и сверял с двумя скрытыми списками (147 записей китайских сетей/облаков/лабораторий + 11 ключевых слов ИИ-лабораторий: deepseek, moonshot, minimax, zhipu, baichuan, stepfun, dashscope), формируя 3-битный фингерпринт. Anthropic признала наличие кода и выпустила 2.1.197 для удаления (без упоминания в changelog).

### 6. Модельный уровень

- **Соглашение об именовании**: три уровня — Opus (флагман), Sonnet (баланс), Haiku (быстрый). Идентификаторы вида `claude-sonnet-4-5-20250929`, `claude-opus-4-6`. Извлечённые кодовые имена: Tengu, Capybara/Mythos, Fennec, Numbat.
- **Thinking/reasoning-режимы**: extended thinking с бюджетом токенов (`thinking:{type:'enabled',budget_tokens:N}`) в ранних моделях; с Claude 4.6 — adaptive thinking (`type:'adaptive'`, effort low/medium/high, с Opus 4.7+ — xhigh); начиная с Opus 4.7 текст размышлений по умолчанию опущен (нужен `display:'summarized'`). В извлечённых промптах claude.ai видны теги `<thinking_mode>interleaved</thinking_mode>`, `<max_thinking_length>16000</max_thinking_length>`.
- **Constitutional AI**: подход Anthropic вместо чистого RLHF — модель критикует/пересматривает собственные ответы по «конституции». В январе 2026 Anthropic опубликовала ревизию конституции Claude, сместившись от rule-based к reason-based подходу (объясняя *почему* существуют правила).
- **«Reward»-язык в промпте**: по разбору dejan.ai, Claude в промпте прямо сказано, что он получает «rewards» за следование инструкциям (вероятно, отсылка к RLHF): «Following all of these instructions well will increase Claude's reward».

## Recommendations

**Для использования в исследовательской работе (поэтапно):**
1. **Разграничьте три класса артефактов** во введении работы: (а) системные промпты (извлечение через prompt injection, легально читаемы), (б) sourcemap-утечка Claude Code (реальный исходник, но под DMCA/несвободной лицензией — цитировать факты, не размещать код), (в) деобфускация публичных бандлов. Явно укажите, что весов/обучающего кода модели в открытом доступе нет.
2. **Опирайтесь на первичные и полу-первичные источники**: официальный `docs.anthropic.com/en/release-notes/system-prompts`, оригинальные GitHub-issue (#17601, #46465), посты Саймона Уиллисона, статьи InfoQ/The Hacker News/Zscaler. Вторичные разборы (Medium, тематические блоги) используйте для навигации, но перепроверяйте числа.
3. **Помечайте спекулятивное**: заявления о «таргетировании», «CC-643», точных датах релизов неанонсированных фич (BUDDY «май 2026») — это неподтверждённые/внутренние заметки; в тексте используйте формулировки «по данным вторичных источников».
4. **Юридическая осторожность**: не воспроизводите утёкший исходный код Claude Code в работе (риск DMCA); цитирование системных промптов и коротких фрагментов инструкций в академических целях безопаснее. Anthropic сама заявляет, что не преследует извлечение системных промптов.
5. **Отслеживайте динамику**: область быстро меняется (Fable 5 → Opus 4.8 → Sonnet 5; версии Claude Code выходят почти ежедневно). Для актуальности используйте version-tracked корпуса (`Piebald-AI/claude-code-system-prompts`, `asgeirtj/system_prompts_leaks`) и фиксируйте даты извлечения.

**Триггеры для пересмотра выводов**: официальное подтверждение/опровержение Anthropic конкретных фич; выпуск пост-мортема по sourcemap-инциденту; изменение позиции по DMCA; появление подтверждённых доказательств утечки весов/обучающего кода (пока таких нет).

## Caveats
- **Даты и версии** в этой области меняются очень быстро; отчёт отражает состояние на начало июля 2026. Некоторые модельные имена (Claude Fable 5, Mythos 5, Opus 4.8, Sonnet 5) и версии Claude Code (2.1.x) взяты из вторичных источников и извлечённых промптов и могут не совпадать с официальной номенклатурой.
- **Извлечённые системные промпты — неофициальные**: Anthropic не подтверждает их построчно, а «живой» промпт может отличаться от извлечённого через дни. Возможны галлюцинации при извлечении, хотя утечка промпта — не галлюцинация (это воспроизводимо).
- **Числа расходятся между источниками**: количество фичефлагов (32 compile-time vs «44»), инструментов (~40 vs 43 vs движок 46K строк), строк кода (~512 000–513 000). Приведены наиболее часто повторяющиеся значения.
- **Часть «скрытых» находок носит сенсационный характер** в поп-разборах; технически подтверждены прежде всего: текст инъекций `<system-reminder>`/LCR, флаг `isMeta`, Undercover Mode, анти-дистилляция, набор reminder-типов и sourcemap-инцидент. Заявления о слежке/эксфильтрации и т.п. следует трактовать критически.
- **Некоторые сайты** (ai-consciousness.org и подобные) — адвокативные, с editorializing; их следует использовать только там, где они воспроизводят верифицируемый вербатим-текст, независимо подтверждённый другими источниками.

## Ключевые источники и репозитории
**Системные промпты (коллекции):** `github.com/jujumilk3/leaked-system-prompts`; `github.com/asgeirtj/system_prompts_leaks`; `github.com/elder-plinius/CL4R1T4S`; `github.com/elder-plinius/L1B3RT4S`; `github.com/x1xhlol/system-prompts-and-models-of-ai-tools`; `github.com/dontriskit/awesome-ai-system-prompts`; `github.com/Piebald-AI/claude-code-system-prompts`.
**Официальное:** `docs.anthropic.com/en/release-notes/system-prompts`; `platform.claude.com/docs` (code execution, computer use); `code.claude.com/docs` (agent loop, computer use).
**Реверс-инжиниринг Claude Code:** `github.com/ghuntley/claude-code-source-code-deobfuscation` (+ transpilation); `github.com/memaxo/claude_code_re`; `github.com/ComeOnOliver/claude-code-analysis`; `github.com/VILA-Lab/Dive-into-Claude-Code`; разборы karanprasad.com, sabrina.dev, vrungta.substack.com, blog.brightcoding.dev (ShareAI Lab), weaxsey.org.
**Инцидент sourcemap и находки:** InfoQ; thehackernews.com; zscaler.com; claudefa.st; kuber.studio; theplanettools.ai; innfactory.ai; wavespeed.ai; denser.ai; afterpack.dev; ccleaks.com.
**Скрытые инъекции:** GitHub issues `anthropics/claude-code#17601`, `#46465`; артефакт claude.ai с текстом LCR; Tech Times (стеганография); dejan.ai (система-интерналы).
**Анализ промптов:** simonwillison.net (Claude 4, analysis tool); blog.promptlayer.com; adversa.ai (chained prompt-leak Claude 4.5/4.6); horiamc.com и memeburn.com (Fable 5).