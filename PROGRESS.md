# Точка остановы

> Обновлено: 2026-07-15
> Коммит: `f034a22` — Stage 2: kernel
> Ветка: `main`, дерево чистое, remote нет
> Состояние: **Этапы 0, 1 и 2 закрыты. Следующий — Этап 3 (pipeline).**

Этот файл — состояние работы, а не документация. Проектные решения и их обоснования живут в [ARCHITECTURE.md](./ARCHITECTURE.md) (версия 0.4); здесь только то, что нужно, чтобы продолжить с того же места.

---

## 1. Как убедиться, что всё живо

```bash
pnpm install
pnpm verify     # lint + check:arch + build + test
```

Ожидаемо: Biome без замечаний, `✓ Architecture check passed (7 packages)`, **203 теста в 11 файлах**, покрытие ядра **97.53% строк / 93.73% ветвей**.

`pnpm verify`, а **не** `pnpm ci` — `ci` зарезервирована самим pnpm, печатает `ERR_PNPM_CI_NOT_IMPLEMENTED` и выходит с кодом 0. То есть шаг в CI с таким именем молча «проходил» бы, не выполнив ничего.

---

## 2. Что построено

```
packages/core/src/
├── index.ts                публичный API
├── platform.d.ts           AbortSignal/AbortController — контракт платформы, см. §3.5
├── domain/                 ЭТАП 1 (закрыт)
│   ├── brand.ts            Brand<T,B> — номинальная типизация без рантайм-цены
│   ├── ids.ts              ItemId, UserId, EventId, StrategyId, FeatureKey, Timestamp
│   ├── entities.ts         Item, User, Event, EventType, History
│   ├── feature.ts          FeatureDescriptor, MutableFeatureSchema / FeatureSchema, FeatureSchemaBuilder
│   ├── matrix.ts           FeatureMatrix, DenseFeatureMatrix
│   ├── profile.ts          ProfileVector, MutableProfileVector, DenseProfileVector
│   ├── history.ts          HistoryIndex, MapHistoryIndex
│   ├── candidate.ts        Candidate, CandidateSet, CandidateSetBuilder
│   ├── score.ts            ScoreColumn, ScoreContribution, ScoreBoard, MutableScoreBoard, ScoreBoardBuilder
│   ├── reason.ts           Reason
│   └── explanation.ts      Explanation, ScoreTrace                        ← новое
├── ports/                  ЭТАП 2 — весь контракт расширяемости (§6)      ← новое
│   ├── context.ts          RequestContext, Criticality, RetrievalBudget, DiagnosticsSink, DiagnosticWarning
│   ├── candidate-provider.ts / candidate-filter.ts (PreFilter, PostFilter)
│   ├── feature-extractor.ts (FeatureExtractor, UserFeatureExtractor) / feature-transform.ts
│   ├── scoring-strategy.ts (ScoringView, ScoringStrategy, DomainScoringStrategy, isDomainStrategy)
│   ├── score-normalizer.ts (+ NormalizedColumn) / score-combiner.ts / score-modifier.ts
│   ├── ranker.ts / diversifier.ts (+ SimilarityProvider) / blender.ts / explainer.ts
│   ├── weight-provider.ts / middleware.ts (StageMiddleware, StageInfo) / infra.ts
│   └── index.ts
└── kernel/                 ЭТАП 2                                          ← новое
    ├── errors.ts           RecoError + коды, MissingFeatureError, FeatureCollisionError, BuilderSealedError
    ├── token.ts            Token<T> с фантомным полем, CLOCK/RNG/LOGGER/METRICS/CACHE
    ├── container.ts        Container, DefaultContainer — скоупы singleton/request, циклы, seal
    ├── config.ts           EngineConfig, ConfigSchema, ConfigResolver, ResolvedConfig, DeepPartial
    ├── registry.ts         Registry (пишет плагин) / ResolvedRegistry (читает пайплайн)
    ├── plugin.ts           Plugin, asPlugin, sortPlugins, dedupePlugins, directPlugin
    ├── graph.ts            resolveFeatureGraph — валидация графа фичей + порядок трансформов
    └── builder.ts          EngineBuilder implements Registry, createEngine(), EngineBlueprint
```

Остальные шесть пакетов (`features`, `strategies`, `modifiers`, `diversity`, `testing`, `recoengine`) — пустые каркасы с `export {}`.

### Стражи архитектуры

`scripts/check-arch.mjs` — не формальность, все четыре правила проверены намеренной поломкой:

| Нарушение | Кто ловит |
|---|---|
| `import 'node:fs'` в ядре | check-arch |
| любая зависимость у `core` | check-arch |
| зависимость вправо (`core → strategies`) | check-arch |
| `process.env` в ядре | **компилятор**, `error TS2591` |

Последнее — следствие `"types": []` и `lib` без DOM в `packages/core/tsconfig.json`. Изоморфность здесь не обещание в README, а ошибка сборки. Цена этого выяснилась на Этапе 2 — см. §3.5.

---

## 3. Решения, принятые в коде и НЕ описанные в ARCHITECTURE.md

Код осознанно разошёлся с документом. Документ пока не переписан — при следующей ревизии эти пункты надо внести (§5, §6, §8, §10).

### Этап 1

**3.1 Матрица использует два layout'а** (`matrix.ts`). §5.5 требует column-major «везде». Не работает: нормализатор идёт по одной фиче через все строки (column-major), косинус — по 128 измерениям одной строки (row-major). Реализовано: скаляры column-major, эмбеддинги row-major поблочно. Схема знает, где живёт фича; вызывающий шва не видит.

**3.2 Версия схемы не зависит от порядка регистрации** (`feature.ts`). Хеш от **отсортированного** отпечатка. Иначе перестановка в цепочке `use()` обнуляла бы весь кэш фичей, не изменив ничего по существу.

**3.3 `contributionOf` не делит на Σweights** (`score.ts`). Делит `ScoreBoardBuilder.build()` — только доска знает, какие стратегии реально отработали. Отсюда бесплатный cold start.

**3.4 Мелочи:** `CandidateSetBuilder.add()` при дубле берёт max (косинус и BM25 несравнимы); `filter()` перенумеровывает строки; `FeatureSchemaBuilder` отвергает нефинитный `defaultValue`; `HistoryIndex` сортирует события при построении.

### Этап 2 — новое

**3.5 `platform.d.ts`: AbortSignal объявлен вручную.** `lib: ["ES2022"]` + `types: []` означают, что в ядре нет ни DOM, ни Node-типов — на этом и держится машинная проверка изоморфности. `AbortSignal` — настоящий кросс-платформенный стандарт (Node 20+, Deno, Bun, браузеры), но TypeScript поставляет его декларацию внутри `lib.dom.d.ts`, в одном пакете с `window`, `fetch` и `localStorage`. Затащить DOM ради одного типа значило бы отдать ядру `fetch` и снять сторожа: первый случайный `fetch()` в экстракторе скомпилировался бы. Вместо этого объявлена ровно та поверхность, на которую ядро опирается. Файл не попадает в `dist` — потребитель резолвит `AbortSignal` из своей библиотеки.

**3.6 Две схемы фичей, а не одна.** §8.0 даёт `Registry.schema` в единственном числе. Реализовано `schema` (кандидаты) + `profileSchema` (пользователь/сессия). Причина: `affinity_genre` — законное имя и для item-фичи («насколько трек подходит пользователю»), и для profile-фичи («какая доля вкуса — этот жанр»). Один namespace назвал бы эту пару коллизией и заставил переименовывать, чтобы сказать то же самое. Это разные векторные пространства. Следствие: `requires` проверяется по item-схеме, `requiresProfile` — по profile-схеме, и item-фича не может подменить profile-фичу (тест на это есть).

**3.7 `ScoreModifier.apply` получает `MutableScoreBoard`.** §6 типизировал `board: ScoreBoard` и возврат `void` — так модификатор не может сделать ничего: доска read-only. Добавлен write-вид (`rows` + `add`), который `ScoreBoardBuilder` уже удовлетворяет структурно. Модификатор пишет вклад, а не перезаписывает score, — объяснимость остаётся структурной.

**3.8 Конфиг валидируется ПОСЛЕ `register()`.** §8.3 ставит валидацию шагом 2, до регистрации. Так нельзя: `weights` проверяются против зарегистрированных стратегий, а до `register()` их нет. Порядок в коде: топосорт → merge configSchema плагинов → register() → граф фичей → валидация конфига → freeze. Все проблемы конфига собираются в один `INVALID_CONFIG` списком, а не по одной за перезапуск.

**3.9 `build()` одноразовый при любом исходе.** Регистрация мутирует схему и слоты по ходу; повторный `build()` после неудачного проиграл бы все записи поверх полуразрушенного состояния и сообщил бы о **повторе** («две стратегии с id artist»), а не о причине. Билдер запечатывается в начале `build()`. Неудачный build — это неудачный старт приложения: чинить причину и строить новый билдер.

**3.10 Прямой `add*/set*` на билдере ставится в ту же очередь, что и `use()`.** `use()` не может регистрировать сразу — топосорт требует сперва собрать все плагины. Из-за этого было два пути записи с обратным порядком: `.use(defaultRanker).setRanker(mine, {override:true})` падал, сообщая о двух претендентах задом наперёд. Теперь прямой вызов означает ровно то же, что `use()`. Один метод ведёт себя по-разному в зависимости от того, кто зовёт (флаг `registering`), — читается странно, но даёт единственный ожидаемый результат: записи происходят в порядке написания.

**3.11 Дедуп только для именованных плагинов.** Анонимные (обёрнутый порт, прямая запись) отслеживаются в `WeakSet` и не дедуплицируются: их имена производные (`auto:mmr`), поэтому две `AffinityStrategy` с одним id выглядели бы как один плагин дважды и молча слились бы — хотя это две стратегии, дерущиеся за один ключ веса. Ошибку про это выдаёт `addStrategy`, точно и в терминах порта.

**3.12 Добавлено в `EngineConfig` сверх §10:** `errorPolicy` и `filterErrorBudget` (описаны в §17.2, но в интерфейс §10 не внесены).

**3.13 `EngineBuilder.provide(token, value)`** — в §8.0 нет. Без него контейнер доступен только плагинам, и хост-приложение не может подставить свой `Clock` — то единственное, что делает движок тестируемым.

**3.14 `setWeightProvider`** добавлен в `Registry`: §10 требует `WeightProvider` в цепочке разрешения конфига, а слота для него в §8.0 не было.

**3.15 `UserFeatureExtractor.scope: 'user'`** — литеральный маркер, в §6 его нет. `use()` диспетчеризует структурно, а этот порт структурно совпадает с `FeatureExtractor` (`{id, version, provides, extract}`). Различать по `extract.length` — догадка, которую молча ломает параметр по умолчанию. Маркер в том же духе, что уже принятые `failClosed: true` и `domain: true`.

**3.16 `build()` пока возвращает `EngineBlueprint`**, а не движок: `{registry, config, container, plugins}`. Этап 3 сделает `build(): RecommendationEngine`, а это станет внутренним шагом. Границы запечатывания при этом не меняются.

---

## 4. Следующий шаг — Этап 3 (pipeline)

Критерий приёмки из §22: **пустой движок отдаёт пустой результат с таймингами**; прерванный сигнал даёт `AbortError` на каждой стадии.

Что писать, в `packages/core/src/pipeline/`:

1. **`stage.ts`** — `Stage`, исполнение onion-middleware (`StageMiddleware.intercept` уже объявлен в `ports/middleware.ts`).
2. **`pipeline.ts`** — исполнитель: 15 стадий (0..14, включая 4b), проверка `ctx.signal` на всех границах (§17.1), тайминги в `Diagnostics`.
3. **`stages/`** — реализации. Стадия 0 (RESOLVE) собирает `RequestContext`: `ConfigResolver.override()` уже готов, `WeightProvider` в блюпринте есть, остаётся сложить слои по §10.
4. **`engine/engine.ts` + `engine/defaults.ts`** — `RecommendationEngine`, дефолтная сборка пустых слотов (`combiner`, `ranker`, `explainer`, `blender` в блюпринте `undefined` — ядро сознательно не выдумывает ранкер), `dispose()` в обратном порядке `blueprint.plugins`.
5. **Error policy (§17.2)** — матрица деградации; `DiagnosticWarning` уже объявлен.
6. **`domain/recommendation.ts`** — `Recommendation`, `RecommendationResult`, `Diagnostics` (§5.8, ещё не написаны).

Открытый вопрос, который придётся решить именно здесь: **стадии 7–8 и мутабельность доски**. `ScoreCombiner.combine()` возвращает готовый `ScoreBoard`, а модификаторы пишут в `MutableScoreBoard` (§3.7). Рабочая схема: стадия 8 открывает новый `ScoreBoardBuilder`, переливает в него `board.contributions(row)` и складывает после модификаторов. Цена: комбайнер со своей нестандартной сверткой (product) при переливании её потеряет — свёртка `ScoreBoardBuilder` зафиксирована §11.2. Для `weighted-sum` и RRF это не проблема (RRF выражается аддитивными вкладами, знаменатель одинаков для всех строк и порядок не меняет).

Дальше по плану §22: Этап 4 — math.

---

## 5. Открытые хвосты

| Что | Состояние |
|---|---|
| **git remote** | Нет. Репозиторий чисто локальный |
| **CI** | `.github/workflows/ci.yml` написан, но **ни разу не запускался** — GitHub его не видел. Матрица Node 20/22/24 + Bun + Deno не подтверждена на практике |
| **Браузерный прогон** | В §23.5 заявлен, в CI пока не настроен (нужен `@vitest/browser` + playwright) |
| **`profile.ts`** | Тестов своего файла нет, покрыт через `matrix.test.ts` |
| **`ports/`** | Почти целиком типы; единственный рантайм — `isDomainStrategy`, покрыт |
| **ARCHITECTURE.md** | Не содержит решений из §3 этого файла. Внести при следующей ревизии — их накопилось 16 |

### npm

Готово: организация **`recoengine` создана**, `npm org ls recoengine` → `waleron - owner`. 2FA включён на уровне `auth-and-writes`.

Не сделано и не нужно до Этапа 11: публикации нет. Учесть заранее — при `auth-and-writes` публикация из CI по обычному токену **работать не будет**, нужен granular access token либо Trusted Publishing через OIDC из GitHub Actions (предпочтительно: без долгоживущих секретов).

---

## 6. Грабли, на которые уже наступили

- **`pnpm ci` ≠ `pnpm run ci`.** `ci` зарезервирована pnpm; вызов печатает ошибку и **возвращает 0**. Скрипт называется `verify`.
- **TypeScript 7.0 уже вышел, но взят 5.9.3.** У typedoc peer-диапазон кончается на `6.0.x`. Вернуться к вопросу, когда typedoc догонит.
- **`npm org create` не существует.** У `npm org` только `set`/`rm`/`ls`; организация создаётся исключительно через веб.
- **Включение 2FA отзывает действующие CLI-токены.** После этого `npm whoami` отвечает `401`, лечится повторным `npm login`.
- **`npm login` интерактивен** и умирает без stdin. Запускать в обычном терминале.
- **Biome 2.5:** `linter.rules.recommended` устарел в пользу `preset`; для папок нужен `!**/dist`, а не `!**/dist/**`.
- **Biome `useLiteralKeys` против TS `noPropertyAccessFromIndexSignature`.** Прямой конфликт: TS требует `x['id']` для индексной сигнатуры, Biome требует `x.id`. Лечится не подавлением правила, а отказом от индексной сигнатуры: `{ id?: unknown; version?: unknown }` вместо `Record<string, unknown>` (см. `asPlugin`).
- **Тесты не типизируются `tsc`** — `packages/core/tsconfig.json` исключает `src/**/*.test.ts`, vitest гоняет их через esbuild. Ошибка типов в тесте не упадёт в `pnpm verify`.
- **v8-покрытие и отложенные замыкания.** `builder.ts` показывал 44% функций при 99% строк: замыкание `(r) => r.addX(x)` в `defer()` создаётся всегда, но вызывается только на прямом пути записи. Лечится тестом на прямой путь, а не понижением порога.

---

## 7. Хронология

| Коммит | Что |
|---|---|
| `5808802` | Этап 0: каркас монорепо + машинные проверки архитектуры |
| `61f0f7f` | Переименование `ci` → `verify` (см. грабли) |
| `57d331c` | Аудит документа: 9 расхождений за три ревизии |
| `4c3a408` | Этап 1 (1/2): ids, entities, схема, матрица, профиль, индекс истории |
| `ebd7f64` | Этап 1 (2/2): ScoreBoard, Candidate, Reason — доменный слой закрыт |
| `99c1020` | PROGRESS.md: точка остановы после Этапа 1 |
| `f034a22` | Этап 2: kernel — контейнер, builder(=registry), plugin host, конфиг, граф фичей + весь слой портов |
