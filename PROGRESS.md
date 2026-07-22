# Точка остановы

> Обновлено: 2026-07-22
> Ветка: `main`
> Remote: [waleron07/recommendationEngine](https://github.com/waleron07/recommendationEngine) (**публичный**)
> Состояние: **Этапы 0–10 закрыты; Этап 11 подготовлен — остаётся сама публикация в npm (ждёт auth).**
> Последняя ревизия: **Этап 11 подготовлен** — версии `0.1.0` + CHANGELOG (changesets), фасад `recoengine` реэкспортит все батареи, 0 предупреждений биома (убраны фантомные `P`/`policy`), runbook [RELEASING.md](./RELEASING.md). Публикация `npm publish` — единственный оставшийся шаг, требует npm-токена/OIDC.

Этот файл — состояние работы, а не документация. Проектные решения и их обоснования живут в [ARCHITECTURE.md](./ARCHITECTURE.md) (**версия 0.5, сверена с реализацией**); здесь только то, что нужно, чтобы продолжить с того же места.

**§3 этого файла расформирован.** Он был списком из 31 расхождения между кодом и документом — накопителем, который рос, пока документ не правили. Теперь всё это внесено в ARCHITECTURE.md с обоснованиями (§23.-2), и держать вторую копию значило бы завести третий источник правды. Осталось то, что списком быть и должно: долги кода — в §5.

---

## 1. Как убедиться, что всё живо

```bash
pnpm install
pnpm verify     # lint + check:arch + build + test
pnpm bench      # отдельно: измеряет, а не утверждает
```

Ожидаемо: **672 теста в 39 файлах**, `✓ Architecture check passed (7 packages)`, покрытие ядра **95.4% строк / 93.26% ветвей** (пороги в `vitest.config.ts`: 90/85/90/90). По этапам: 30 — Этап 5, 19 — Этап 6, 11 — Этап 6а, 17 — Этап 7, 12 — Этап 8, 10 — Этап 8а, 7 — Этап 9, 7 — Этап 10, 2 — Этап 11 (`packages/recoengine/src/facade.test.ts` — фасад реэкспортит батареи). `vitest` ловит и `examples/*/src/**/*.test.ts`.

Biome даёт **0 предупреждений** (чисто, с Этапа 11). Убраны все четыре: фантомный тип-параметр `P` в `RecommendationRequest` (payload приходит через provider, не request — теперь `RecommendationRequest<UP>`); неиспользуемый `policy` в `normalize()` (нормализатор не деградируем, §17.2); две comma-operator-идиомы в тест-шпионах.

`pnpm verify`, а **не** `pnpm ci` — `ci` зарезервирована самим pnpm, печатает `ERR_PNPM_CI_NOT_IMPLEMENTED` и выходит с кодом 0. Шаг в CI с таким именем молча «проходил» бы, не выполнив ничего.

**CI зелёный, матрица подтверждена на практике:** Node 20/22/24, Bun, Deno плюс отдельная джоба lint/arch/build/test, на каждый push в `main`. Оговорка: джобы рантаймов гоняют `scripts/smoke.mjs` (34 строки), а не весь набор — то есть матрица доказывает «пакет грузится и работает везде», но не «663 теста зелены везде».

---

## 2. Что построено

Сквозной путь работает:

```ts
const engine = createEngine<Track>()
  .provide(CLOCK, clock)
  .configure({ limits: { maxCandidates: 5_000, maxLimit: 100, timeoutMs: 200 } })
  .use(new LibraryProvider(db))
  .use(new PopularityExtractor())
  .use(new PopularityStrategy())
  .build()

const { recommendations, diagnostics } = await engine.recommend({ user, history, limit: 10 })
```

```
packages/core/src/
├── index.ts                публичный API
├── platform.d.ts           AbortSignal/AbortController — контракт платформы, ARCHITECTURE §23.4
├── domain/                 ЭТАП 1
│   ├── brand.ts ids.ts entities.ts feature.ts matrix.ts profile.ts history.ts candidate.ts
│   ├── score.ts            ScoreColumn, ScoreContribution, ScoreBoard, MutableScoreBoard, ScoreBoardBuilder
│   ├── reason.ts explanation.ts
│   └── recommendation.ts   Recommendation, RecommendationResult, Diagnostics, DiagnosticWarning, StageTiming
├── ports/                  ЭТАП 2 — весь контракт расширяемости (§6); 16 портов + index.ts
├── kernel/                 ЭТАП 2
│   ├── errors.ts token.ts container.ts config.ts registry.ts plugin.ts graph.ts
│   └── builder.ts          EngineBuilder implements Registry, resolve(), createRegistry(), EngineBlueprint
├── pipeline/               ЭТАП 3
│   ├── stage.ts            STAGES (16 шт.), runStage, DiagnosticsCollector, middleware-onion
│   ├── policy.ts           матрица §17.2, isAbort, FilterErrorBudget
│   ├── request.ts          стадия 0: RequestContext, композиция сигнала, WeightProvider
│   ├── pipeline.ts         исполнитель: все стадии прямолинейным кодом
│   └── stages/             retrieval, prefilter, extraction, engineering, postfilter,
│                           scoring, normalization, combination(+modifiers), ranking(+blend/truncate), explanation
├── math/                   ЭТАП 4
│   ├── rng.ts              Xoshiro128 — сеется, fork() чист от состояния
│   ├── normalize.ts        minmax, zscore, rank, sigmoid, sigmoidScaled, identity, NORMALIZERS
│   ├── heap.ts             topK — сверен с полной сортировкой
│   ├── similarity.ts       dot, norm, cosine, jaccard, weightedJaccard
│   ├── decay.ts            exponentialDecay, linearDecay, gaussianDecay, recovery
│   └── rrf.ts              reciprocalRankScores, reciprocalRankNormalized, RRF_K
└── engine/                 ЭТАП 3–4
    ├── defaults.ts         weightedSum, rrfCombiner, sortRanker, topKRanker, defaultExplainer,
    │                       DEFAULT_NORMALIZERS, DEFAULT_COMBINERS, combinerFor, fillSlot
    └── engine.ts           createEngine(), build(): RecommendationEngine, inspect(), dispose()

benchmarks/math.bench.ts    вне verify: меряет на 5000 кандидатов
```

Все пять plugin-пакетов построены: `strategies` (Этап 5), `modifiers` (Этап 6), `testing` (Этап 6а), `diversity` (Этап 7), `features` (Этап 8а). Пустых каркасов больше нет. Шестой, `recoengine`, — фасад `export * from '@recoengine/core'`; готовые пакеты он пока не реэкспортирует (решить при Этапе 11, когда появится, что публиковать). Два доменных примера: `examples/music` (Этап 9) и `examples/ecommerce` (Этап 10). Примеры ничего в `packages/` не добавляют. Оба доказали приёмочный критерий: `git status packages/core/` пуст.

### Этап 5 — `@recoengine/strategies` (закрыт)

Девять доменно-нейтральных стратегий §11.3, каждая — фабрика-функция, возвращающая `ScoringStrategy` (не класс: согласовано с функциональным экспортом ядра и структурной диспетчеризацией плагинов, которая узнаёт стратегию по методу `score`, а не по `instanceof`; ARCHITECTURE.md §11.3 сведён на `affinityStrategy(...)`).

```
packages/strategies/src/
├── internal.ts        FeatureRef/toKey/toId, StrategyOptions, clamp01, percentiles (тай-группы), sparseReasons
├── history.ts         count × recency; normalizer rank; applicable: history.size ≥ minHistory
├── affinity.ts        параметризуется feature; identity; два инстанса ⇒ разные id (иначе дерутся за вес)
├── popularity.ts      блендит ПЕРЦЕНТИЛИ global/cohort (разные шкалы!); identity; cohortFeature:null отключает когорту; без гейта (cold-start фолбэк)
├── recency.ts         exponentialDecay(age, halfLife); identity; без гейта; age<0 → 1 («ещё не»)
├── similarity.ts      recentWeight·sim_recent + (1−w)·sim_profile; identity; гейт на историю
├── cooccurrence.ts    cooc_score; minmax; гейт на историю; причина по перцентилю
├── novelty.ts         saturation·(1−familiarity); ЕДИНСТВЕННАЯ с requiresProfile (profile_saturation из ProfileVector)
├── discovery.ts       без target — reward расстояния (minmax); с target — гаусс-полоса вокруг него (identity); гейт на историю
├── context.ts         context_match; identity; гейт на ctx.signals.size ≥ 1
└── strategies.test.ts 21 golden-тест через реальный createEngine (доказывает и ранжирование, и что правило core ← strategies держится на практике)
```

**Что проверено на числах.** Перцентильный бленд популярности: c(900) и d(50) остаются различимы (67 vs 33) рядом с b(5000) — ровно то, ради чего §12. Cold-start reflow: у нового пользователя `history`/`affinity`/… отбрасываются, вес перетекает, `popularity` решает одна; движок с кандидатами, но нулём применимых стратегий, отдаёт кандидатов с base=0 в порядке retrieval, а не пустоту (§17.3). Novelty саморегулируется: saturation=0 → буста нет.

**Грабли Этапа 5.** (1) `FeatureDescriptor.owner` обязан называть свой экстрактор — иначе `build()` падает про инвалидацию кэша. (2) Дефолтный `sortRanker` тай-брейкает по **индексу строки** (порядку retrieval), а не по `ItemId`; §13 обещал `ItemId` — ревизией 0.5 **сведён документ** (индекс дешевле и так же детерминирован, раз порядок retrieval детерминирован), это не долг кода. (3) На момент Этапа 5 презентационная шкала не округлялась, поэтому golden-тесты округляли score в ассерте; с Этапа 8 округление в ядре, ассерты можно упростить (не трогал, работают).

### Этап 6 — `@recoengine/modifiers` (закрыт)

Три модификатора стадии 8 (§15), каждый — фабрика, возвращающая `ScoreModifier`.

```
packages/modifiers/src/
├── internal.ts        saturationOf — «неравномерность» истории по ItemId (1 − H/ln(unique)), доменно-нейтральная
├── fatigue.ts         мультипликативный; count из истории, recovery по времени; обе кривые — exponentialDecay (half-life)
├── novelty.ts         мультипликативный буст 1 + saturation·weight·unfamiliarity; всё из истории, не из профиля
├── boost.ts           аддитивный (kind:'boost'); по items/select; amount<0 = штраф; НЕ фильтр
└── modifiers.test.ts  16 тестов: saturationOf напрямую + три модификатора через реальный createEngine с фиксированным CLOCK
```

**Ключевое решение (сведено в §15.1).** Порт `ScoreModifier.apply(board, set, ctx)` не даёт ни `FeatureMatrix`, ни `ProfileVector` — только историю и контекст. Поэтому «фича насыщения профиля» из §15 **считается из истории на месте** (`saturationOf`), а `unfamiliarity` — из `history.countFor`. Кривые — через `math/decay.ts` (база 2, человеко-читаемый half-life), а не сырой `exp`. Novelty теперь в двух видах: `noveltyStrategy` (аддитивная колонка, Этап 5) и `noveltyModifier` (мультипликативный, здесь) — намеренно, различие в порядке свёртки.

**Что проверено на числах.** Fatigue: `heavy`(100 прослушиваний) → 5, `light`(0) → 50, монотонно углубляется по счётчику, floor держит снизу. Восстановление: те же 100 прослушиваний 400 дней назад → эффективный счётчик ушёл под порог → 50 (полностью восстановился). Novelty: насыщенный профиль → `fresh` 75 против `seen`; ровный профиль → буста нет (50/50). Boost: пин +0.3 → 80, штраф −0.3 → 20 (объект остаётся).

**Грабли Этапа 6.** Тест насыщения `saturationOf` при `unique ≤ 1` возвращает 1 (все прослушивания на одном объекте = максимум), иначе `ln(unique)` даёт деление на ноль. Мультипликативный буст novelty на базе, уже равной 1, невидим (клампится в 1) — тесты держат базу 0.5, чтобы эффект был виден.

### Этап 6а — `@recoengine/testing` (закрыт)

Две половины: фикстуры и framework-agnostic contract-kit (§21.1).

```
packages/testing/src/
├── platform.d.ts   локальный ambient AbortSignal/AbortController (как в ядре) — kit изоморфен
├── fixtures.ts     catalogueOf, itemsOf, payloadExtractor, profileExtractor, throwingExtractor,
│                   constantStrategy, passthroughStrategy, fixedClock, events, request, historyOf,
│                   testEngine, rankedIds, scoreById, TEST_LIMITS
├── contracts.ts    assertHonoursCancellation (§17.1), assertExtractorErrorPolicy (§17.2, обе политики),
│                   assertDeterministic, assertScoresWellFormed, assertScoringStrategy, assertScoreModifier
└── testing.test.ts 10 dogfood-тестов: контракты проходят на исправных портах и БРОСАЮТ на сломанных
```

**Долг погашен.** `strategies.test.ts` и `modifiers.test.ts` переведены на фикстуры kit (тонкие алиасы `provider`/`itemFeatures`/`listen`/… → импорты) и получили блок `port-contract conformance`: каждая из девяти стратегий и трёх модификаторов прогоняется через `assertScoringStrategy`/`assertScoreModifier` (отмена + детерминизм + корректность score) — «одна строка на порт» из §21.

**Ключевое решение.** Контракты — не готовые `describe/it`, а функции, бросающие `Error`; пакет не тянет `vitest` в зависимости (иначе публикуемый kit навязывал бы всем один раннер). Подключается в любом раннере: `it('cancels', () => assertHonoursCancellation(engine))`.

**Грабли Этапа 6а.** (1) `check-arch` смотрит только runtime `dependencies` — `@recoengine/testing` у strategies/modifiers лежит в `devDependencies`, поэтому правило `core ← siblings` не нарушается. (2) `identity`-нормализатор (id `none`) НЕ клампит — это чистый passthrough; `passthroughStrategy` поэтому нормирует `minmax`, иначе сырое значение >1 валит стадию нормализации. (3) `exactOptionalPropertyTypes` запрещает явный `undefined` в опциональных полях — spec/request строятся условным спредом (`...(x === undefined ? {} : { x })`).

### Этап 7 — `@recoengine/diversity` (закрыт)

Диверсификация (стадия 10) и блендинг (стадия 11), §14–§15. Четыре фабрики.

```
packages/diversity/src/
├── internal.ts        subspaceVector (свежий Float64Array, не view), clampSimilarity, toKey
├── similarity.ts      cosineSimilarity (подпространство фичей / embedding), jaccardSimilarity (weightedJaccard)
├── mmr.ts             mmrDiversifier: λ·score − (1−λ)·max sim; λ=1 → короткое замыкание = вход; window=200; O(depth²)
├── quota.ts           attributeQuotaDiversifier: ≤max на категориальную группу (равенство хеша в колонке)
├── blender.ts         bucketBlender: слот-квоты по долям (largest-remainder), недобор → quota_unfilled + rng-тай-брейк
└── diversity.test.ts  17 тестов; несущий — MMR(λ=1)≡ranking через настоящий движок (критерий §22)
```

**Правка ядра (одна).** Порт `Diversifier.diversify` получил пятый параметр `FeatureMatrix` — без него `SimilarityProvider.similarity(a,b,set,matrix)` нечем было кормить, MMR не мог считать близость по фичам. Матрица уже в области видимости пайплайна на стадии 10; тест-даблы `diversify: () => []` игнорируют новый аргумент. Ядро осталось зелёным (617 своих тестов).

**Два долга §5 закрыты.** (1) `SimilarityProvider` без слота в `Registry` — передаётся в опции `mmrDiversifier({ similarity })`, как и было решено; слот не заводился (близость нужна ровно одному потребителю). (2) Дефолтного блендера не было — `bucketBlender` исполняет квоты §18, движок больше не только предупреждает `quota_unfilled`, а умеет их набрать.

**Что проверено на числах.** MMR(λ=1) байт-в-байт равен чистому ранжированию (кластеры a/b/c vs x/y/z по косинусу); λ<1 поднимает представителя другого кластера на 2-е место; выход — всегда перестановка входа. Quota: 3 трека группы 1 → оставляет 2, r1(группа 2) на месте. Blender: 50/50 поднимает novel в топ-4; сухой бакет → `quota_unfilled`; детерминизм по seed.

**Грабли Этапа 7.** (1) `minmax` кладёт минимум колонки в 0.0 — тест на «сухой бакет» сначала полагался на `score≥0.5`, но нижний элемент падал в novel-бакет; переписан на предикат `accepts: () => false`. (2) `pnpm install` в этой среде зависает (реестр недоступен) — devDep-симлинк `@recoengine/testing` создан вручную (`ln -sfn ../../../testing`), как у strategies/modifiers; на CI обычный `pnpm install` отработает. (3) Провайдер близости возвращает свежий массив, не `subarray` матрицы: близость — read-only, а view заалиасил бы хранилище.

### Этап 8 — explainability (закрыт)

Работа в **ядре**, не в новом пакете. Три долга §5 закрыты (§16.1).

```
Изменённые файлы ядра:
├── pipeline/stages/explanation.ts   toPresentation = Math.round(·×100); traceFor() строит ScoreTrace;
│                                     explanationForRow() — переиспользуемая точка для explain()
├── pipeline/pipeline.ts             PipelineProbe — опциональный out-параметр, собирает выживших по стадиям
├── engine/engine.ts                 explain(itemId, request); interpretProbe() восстанавливает судьбу; depsFor()
├── domain/explanation.ts            ItemExplanation (status/lostAt/rank/explanation/diagnostics)
└── engine/explainability.test.ts    12 тестов: округление, ScoreTrace, Σ=base, все статусы explain()
@recoengine/testing:                 assertExplanationSums — контракт «Σ вкладов = baseScore»
```

**Три решения (сведены в §16.1).** (1) Округление — в одном месте (`toPresentation`), `score` и `baseScore` не расходятся. (2) `ScoreTrace` строит **пайплайн**, а не explainer: порт `Explainer` не получает матрицу/схему (владеет политикой причин, не данными), поэтому трейс прикрепляется в стадии 13 поверх любого explainer'а. Содержимое — фолд §11.2 по строкам (base → мультипликативные/boost → final) + скалярные фичи + версия схемы. (3) `engine.explain()` — через `PipelineProbe`: тот же пайплайн (форсирует `full`), probe собирает выживших, `interpretProbe` возвращает статус на **первой** пропавшей стадии (`lostAt` — самое раннее объяснение).

**Что проверено на числах.** Округление: score/baseScore — целые, `0.8947…→89`, не `89.47`. Трейс: есть под `full`, нет под `reasons`; несёт schemaVersion, features, base→final. Σ: свёрнутые аддитивные вклады = `baseScore`. `explain()`: `recommended`(rank 1), `not_retrieved`(lostAt retrieval, item undefined), `filtered`(lostAt prefilter, item известен), `truncated`(rank 5 при limit 2), `diversified_out`(диверсификатор выкинул). Дошедший до скоринга объект несёт полный `Explanation` — «задавлен» отличимо от «вытеснен».

**Грабли Этапа 8.** (1) Ядро НЕ может зависеть от `@recoengine/testing` (был бы цикл) — тесты Этапа 8 самодостаточны, фикстуры локальные. (2) `exactOptionalPropertyTypes`: `probe.explainRow?.(row)` даёт `T|undefined`, а optional-поле не принимает явный `undefined`; на пути после скоринга `explainRow` всегда задан (инвариант с `scored`), приведён `as`. (3) Неиспользованный импорт `FeatureMatrix` в pipeline.ts (probe матрицу не хранит) — 5-е предупреждение биома, убрано.

### Этап 8а — `@recoengine/features` (закрыт)

Доменно-нейтральные экстракторы и трансформы; последний пустой каркас построен (§11.3.1).

```
packages/features/src/
├── internal.ts       toKey, numericFeature (дескриптор с owner = id порта)
├── interaction.ts    interactionCountExtractor → interaction_count (ctx.history.countFor);
│                     interactionRecencyExtractor → interaction_recency (exponentialDecay, непрослушанное → 0)
├── transforms.ts     logTransform (log1p(x)/log1p(max)); decayTransform (exp/linear/gaussian кривая над колонкой)
└── features.test.ts  10 тестов через реальный движок + контракты
```

**Ключевое решение (§11.3.1).** Доменно-нейтрально то, что считается из `ctx.history`/`ctx.now`, а НЕ из payload: счёт событий по `ItemId` и затухание их давности одинаковы для треков и товаров. Оба экстрактора кормят `historyStrategy` по умолчанию — хост получает repeat-interaction-скоринг без доменного кода. Что требует payload (собственный возраст объекта, категория, co-occurrence) — остаётся в доменных экстракторах хоста. Трансформы — чистая математика над колонками, доменно-нейтральны by construction.

**Правка kit.** `assertScoringStrategy` по умолчанию сам добавляет `payloadExtractor` для требуемых фич — коллизия, когда фичу даёт настоящий экстрактор/трансформ. Добавлен флаг `featuresFromPlugins: true` (пропустить авто-payloadExtractor).

**Грабли Этапа 8а.** (1) `identity`-нормализатор (id `none`) НЕ клампит — probe-стратегия `surface` использует `minmax`, иначе сырой счётчик >1 валит нормализацию (та же грабля, что на 6а). (2) `minmax` при 2 элементах растягивает середину в 1.0 — тесты с якорем (age=0 → freshness 1), чтобы серединное значение осталось на 0.5. (3) lockfile обновлён `--lockfile-only --offline` СРАЗУ после правки package.json — не повторяя баг Этапа 7.

### Этап 9 — `examples/music` (закрыт)

Первый доменный пример. Музыкальный домен собран **целиком из готовых пакетов**, `core` не тронут (§22, домен схлопнут в пример).

```
examples/music/src/
├── catalogue.ts     датасет: 8 треков, 3 артиста, 3 жанра, история из 7 прослушиваний; NOW фиксирован
├── extractors.ts    ЕДИНСТВЕННЫЙ код, читающий payload: popularity/item_age/affinity_artist/
│                    affinity_genre (из истории через aggregate + byId)/artist_group (категориальный хеш)
├── engine.ts        buildMusicEngine(): provider + 5 доменных экстракторов + 2 из @recoengine/features +
│                    5 стратегий + fatigueModifier + attributeQuotaDiversifier(max 2/артист)
├── env.d.ts         локальный ambient console/process (пример изоморфен, types:[], как пакеты)
├── demo.ts          runnable: печатает выдачу с причинами + engine.explain()
└── music.test.ts    7 e2e-тестов
```

**Что доказано на числах.** Beatles-треки наверху (artist affinity + недавняя история); квота ограничивает Beatles двумя из трёх; `t8` (новый, 500 прослушиваний) всплывает по свежести; `engine.explain('t3')` → `diversified_out` (третий Beatles выкинут квотой), несёт полный `Explanation` с трейсом; `explain('несуществующий')` → `not_retrieved`; детерминизм; ноль warnings. `demo.js` печатает связную ленту.

**Ключевое: `git status packages/core/` пуст.** Абстракция не протекла — новый домен обслужен написанием плагинов.

**Грабли Этапа 9.** (1) `examples/` не было — создан; добавлен в `vitest` include (иначе тесты примера не гоняются) и в корневой `tsconfig` references. (2) `console`/`process` недоступны при `types:[]`+`lib:ES2022` — объявлены локально в `env.d.ts` (как ядро с `AbortSignal`), а не через `@types/node` (в репо только старый `@12`). (3) affinity_genre мультизначен — `aggregate` (один ключ на событие) не годится; жанры суммируются вручную из `aggregate('item')`. (4) devDep-симлинки примера + lockfile обновлены офлайн сразу.

### Этап 10 — `examples/ecommerce` (закрыт)

Второй доменный пример — приёмочный тест архитектуры. Собран из тех же готовых пакетов, что и music; отличаются **только** доменные экстракторы и один prefilter.

```
examples/ecommerce/src/
├── catalogue.ts     8 товаров, 3 бренда, 3 категории; события view/add_to_cart/purchase;
│                    INTENT_WEIGHT (purchase 5, cart 3, view 1)
├── extractors.ts    popularity(salesCount)/item_age(addedAt)/affinity_brand+category
│                    (ВЗВЕШЕННЫЕ по типу события через eventsFor)/brand_group (категориальный)
├── engine.ts        buildShopEngine(): + prefilter «не куплено» (fail-closed);
│                    те же affinityStrategy/popularityStrategy/…/attributeQuotaDiversifier
├── env.d.ts, demo.ts, ecommerce.test.ts (7 тестов)
```

**Чем содержательно отличается от music (не переименование).** (1) Взвешивание интента: покупка ≫ корзина ≫ просмотр — считается внутри доменного экстрактора через `history.eventsFor(itemId)` + тип события; стратегия об этом не знает. (2) Prefilter «уже куплено» (`countFor(id, 'purchase') === 0`, fail-closed) — музыка, наоборот, рекомендовала повторы. (3) Импорты из `@recoengine/*` **побайтно те же**, что в music.

**Что доказано на числах.** Volt-товары наверху (brand affinity от недавних cart/view); купленный `p1` не в выдаче, `explain('p1')` → `filtered`/`prefilter` (item известен, `explanation` undefined — не скорился); квота ≤2 на бренд (Volt из 3 → 2); закрытый корзиной `p4` выше нетронутого `p5` (вес корзины); ноль warnings. **`git status packages/core/` пуст.**

**Грабли Этапа 10.** Грабли Этапа 9 уже сняты (инфра `examples/*` в vitest/tsconfig распространилась). Новых нет — зеркало music прошло гладко, что само по себе и есть подтверждение абстракции. devDep-симлинки + lockfile офлайн сразу.

### Этап 11 — релиз `v0.1.0` (подготовлен, публикация ждёт auth)

Всё, что можно сделать без npm-токена, сделано; runbook — [RELEASING.md](../RELEASING.md).

- **Фасад `recoengine` реэкспортит все батареи** (§18 «с батарейками»). Был `export * from '@recoengine/core'` при docstring, обещавшем плагины — рассинхрон. Теперь явные реэкспорты core + 9 стратегий + 3 модификатора + diversity + features. Явные, а не `export *`: `FeatureRef` экспортируют три пакета — при `export *` неоднозначное имя молча выпадает; реэкспортирую один раз осознанно. `facade.test.ts` строит движок из кусочков всех пакетов через фасад — доказывает достижимость.
- **Версии `0.1.0` + CHANGELOG** через changesets (`.changeset/config.json`: linked, все версионируются вместе). `changeset version` поднял 7 публикуемых пакетов; `examples/*` (private) не публикуются. internal-deps остаются `workspace:*` — pnpm заменит на `0.1.0` при `pack`.
- **0 предупреждений биома.** Убраны фантомы `P` (публичный тип `RecommendationRequest<P, UP>` → `<UP>`; ripple по engine/pipeline) и `policy` в `normalize()`, плюс две comma-operator-идиомы в тестах.
- **root-скрипты**: `pnpm changeset`/`version`/`release` (`release` = `verify` + `changeset publish`).

**Что осталось (шаг пользователя).** `npm publish` требует токена/OIDC — 2FA org `recoengine` на `auth-and-writes`, обычный токен из CI не сработает (§5, npm-раздел). Trusted Publishing (OIDC) или granular token — в RELEASING.md. Плюс после публикации: тег `v0.1.0`, README `Install` → `npm i recoengine`.

**Грабли Этапа 11.** (1) `RecommendationRequest<P, UP>` — `P` фантом (ни одно поле не ссылается; payload-тип у provider). Убран → `<UP>`; правка ядерного публичного типа, ripple по engine.ts (4) + pipeline.ts + resolveRequest. (2) `normalize()` не деградируем (§17.2) — `policy` не нужен; убран параметр + импорт `PolicyContext` + вызов в pipeline; тесты передают лишний арг, но JS его игнорирует (тесты не типизируются). (3) `changeset version` поднял и `examples/*` до 0.1.0 — безвредно (private).

### Бенчмарки (на 5000 кандидатов — столько стоит в `maxCandidates` во всех примерах §10)

| Что | Итог |
|---|---|
| `topK` против полной сортировки, 5000 → 20 | **75× быстрее** |
| `cosine` по 128 измерениям | ~8.9 млн/с |
| `minmax` на колонке 5000 | ~36 тыс/с |
| `rank` и `rrf` (обе сортируют) | ~1.1 тыс/с — в 30 раз дороже `minmax` |

### Стражи архитектуры

`scripts/check-arch.mjs` — все четыре правила проверены намеренной поломкой:

| Нарушение | Кто ловит |
|---|---|
| `import 'node:fs'` в ядре | check-arch |
| любая зависимость у `core` | check-arch |
| зависимость вправо (`core → strategies`) | check-arch |
| `process.env` в ядре | **компилятор**, `error TS2591` |

---

## 3. Расхождения с ARCHITECTURE.md — внесены в документ

Пусто, и это результат работы, а не отсутствие её.

Здесь копился список решений, где код разошёлся с проектом: к концу Этапа 4 их стало 31. Список рос ровно потому, что документ не правили — каждое «внести при следующей ревизии» откладывало сверку и удорожало её. Ревизия 0.5 внесла все 31 в ARCHITECTURE.md с обоснованиями; разбор — в §23.-2 документа.

Девять из них оказались содержательными: документ **учил неправильному**. `ScoreModifier.apply(board: ScoreBoard): void` не позволял модификатору сделать ничего; column-major «везде» не собирался; порядок шагов §8.3 был неисполним. Все девять пережили три ревизии «на глаз» и умерли за один заход, как только появился код, с которым можно сверить.

**Правило, по которому это делалось, стоит сохранить:** правится документ, а не код — не потому что код авторитетнее, а потому что код проверяется машиной, а документ нет. Там, где они спорят, ошибается тот, кого никто не запускал. Обратное направление тоже есть: четыре пункта, где прав документ, а виноват код, остались в §5 как долги.

**Для следующего этапа:** не заводить этот раздел заново. Разошлось с документом — вносить в документ тем же коммитом. Накопитель расхождений — это отложенная ревизия, а ревизия дорожает быстрее, чем кажется.

---

## 4. Следующий шаг — публикация `v0.1.0` в npm (шаг пользователя)

Всё построено, проверено и подготовлено к релизу (Этап 11). Остался **один шаг, требующий npm-credentials** — сама публикация. Runbook: [RELEASING.md](../RELEASING.md).

Как публиковать:

1. **Auth (разово).** 2FA org `recoengine` на `auth-and-writes` — обычный токен из CI НЕ сработает. Либо Trusted Publishing (OIDC, рекомендуется — npm доверяет workflow этого репо, токена в CI нет), либо granular access token в секрет `NPM_TOKEN`. Org создана, `waleron` — owner.
2. **Публикация.** `pnpm release` (= `pnpm verify` + `changeset publish`). Публикует только пакеты, чьей версии ещё нет в npm; `workspace:*` заменяется на `0.1.0` при `pack`. Вручную: `pnpm -r --filter='./packages/*' publish --access public`.
3. **После.** Тег `git tag v0.1.0 && git push --tags`; README `Install` → `npm i recoengine`.

Что уже сделано (Этап 11): версии `0.1.0` + CHANGELOG, фасад «с батарейками», 0 предупреждений биома, `RELEASING.md`, root-скрипты. Дальнейшая разработка после 0.1.0 начинается с нового changeset (`pnpm changeset`).

**Опционально к релизу (не блокирует):** `typedoc` — проверить генерацию по всем пакетам (`pnpm docs`); бенчмарки 1k/10k/100k + регрессия перфа в CI (§22, сейчас только `math.bench.ts` на 5000); браузерный прогон (§23.5) в CI не заведён.

**Хвосты, оставленные сознательно:** `softmax` не написан (§5, никому пока не понадобился); `recovery()` из `decay.ts` не используется. Остаточные долги §5 (`container.child()`, приоритет §10, product-комбайнер, underflow `cosine`) — не блокируют `v0.1.0`, перечислены в CHANGELOG как известные ограничения.

**Ревизия плана (0.5) — заведены пропущенные стадии.** Аудит показал, что §22 не строил два из шести пакетов: `@recoengine/testing` (contract-test kit, §21 называет его обязательным) и `@recoengine/features` (общие экстракторы). Оба были в раскладке пакетов и в `check-arch`, но без стадии — то есть до релиза остались бы пустыми `export {}`. Добавлены как **Этап 6а** (testing, сразу после modifiers — чтобы дальнейшие плагины проверялись контрактом) и **Этап 8а** (features, перед доменными примерами). До 6а тесты, включая golden-набор Этапа 5, катают фикстуры руками; общего раннера пока нет — это осознанный временный дубль, а не решение.

---

## 5. Открытые хвосты

### Найдено ревизией Этапов 2–4 и **исправлено**

Аудит четырьмя проходами (математика, пайплайн, ядро, сверка документа) нашёл 10 багов. Все были молчаливыми: движок уверенно возвращал неверный ответ, и все тесты проходили.

| Баг | Чем грозил |
|---|---|
| Число строк доски бралось из `columns[0]` | Движок с кандидатами, но без применимых стратегий, отдавал **пустую выдачу** вместо кандидатов с base=0. Это и есть cold start §17.3, приходящий к неверному ответу |
| Длина колонки стратегии не проверялась | Колонка из 2 значений на 5 кандидатов → выдача из 2, молча; остальные числятся retrieved |
| `request.overrides` не валидировался | Потолок §23.3 был **рекомендательным**: запрос мог поднять себе `maxCandidates` до миллиарда и отдать это базе как бюджет |
| `overrides: { limits: { timeoutMs: -1 } }` | Сырой `RangeError` из `AbortSignal.timeout` — без кода, мимо §17 |
| `overrides` принимал NaN-вес | Ровно то, ради предотвращения чего написан kernel |
| `rank` игнорировал `offset` | Каждая страница возвращала ранги 1..N: сшив две страницы, получаешь пять «первых» |
| Стадия 0 вне контракта отмены | На уже отменённом запросе индексировалась вся история и вызывался `WeightProvider` хоста |
| `combinerFor` врал приведением типа | Per-request `combiner.id` с опечаткой → `TypeError` из чужого catch |
| `addNormalizer` обходил печать | Вызов после `build()` менял **живой** движок; `build()` отдавал map по ссылке |
| `zscore` при переполнении σ | Колонка с реальным разбросом молча становилась «все средние» (0.5) и проходила проверку стадии 6 |
| `cosine`: `sqrt(a*b)` переполнялся | Два одинаковых вектора возвращали 0 — «не связаны». Починено гибридом: точность в обычном случае, корректность в экстремальном |

Каждый закреплён регресс-тестом (`engine.test.ts`, describe «regressions found by auditing stages 2-4»).

### Долги, оставленные видимыми в коде

| Что | Где | Состояние |
|---|---|---|
| **`ranking.ts` — 34.78% покрытия** | `pipeline/stages/ranking.ts` | Худшее место в кодовой базе. `assertRows`/`assertSubsetOf` — страховка от дублей строк — **сами не покрыты**. Чинить первым |
| **`FeatureCache` не подключён** | `ports/infra.ts`, токен `CACHE` | Порт объявлен, токен есть, пайплайн его не вызывает **ни разу** |
| **Ключ кэша решён, не реализован** | — | Скоуп экстрактора (`id@version:key`), а не `schema.version`: иначе апдейт любого плагина обнуляет весь кэш. Приписывать должно ядро |
| **`cache` у `UserFeatureExtractor`** | `ports/feature-extractor.ts` | Объявлял решённым и **не сделал**. Асимметрия §6 сохраняется |
| **`retrievalScore` всегда 0** | `domain/candidate.ts` | `provide()` возвращает голые `Item[]` — источника нет, логика max() при дубле мертва |
| **`softmax` не написан** | `math/normalize.ts` | Единственный незакрытый пункт Этапа 4 |
| **`container.child()` мёртв** | `engine/engine.ts` | §9 обещает request-скоуп; `.child()` не вызывается нигде. Комментарий в `recommend()` описывает то, чего хост сделать не может |
| **§10: приоритет инвертирован** | `pipeline/request.ts` | §10 ставит `request.overrides` **выше** `WeightProvider`; код применяет их в этом порядке, поэтому побеждает нижний слой — вес из провайдера затирает override вызывающего |
| **`graph.ts`: id экстрактора = id трансформа** | `kernel/graph.ts` | Ищет продюсера по id в мапе трансформов. Экстрактор `popularity` + трансформ `popularity` → выдуманный `DEPENDENCY_CYCLE`. Ложных пропусков нет, только ложные срабатывания |
| **`merge()` считает `null` значением** | `kernel/config.ts` | YAML `fatigue:` (пустое тело) → `null` → `TypeError` вместо списка issues |
| ~~Презентационная шкала не округляется~~ | — | **Закрыто (Этап 8):** `toPresentation = Math.round(·×100)` |
| ~~`ScoreTrace` не заполняется~~ | — | **Закрыто (Этап 8):** строится в стадии 13 при `explain: 'full'` |
| ~~`engine.explain(itemId, request)`~~ | — | **Закрыто (Этап 8):** через `PipelineProbe`, все статусы покрыты |
| ~~Дефолтного блендера нет~~ | — | **Закрыто (Этап 7):** `bucketBlender` в `@recoengine/diversity` исполняет квоты §18 |
| ~~`SimilarityProvider` без слота~~ | — | **Закрыто (Этап 7):** передаётся в опции `mmrDiversifier({ similarity })`; слот в реестре не заводился (один потребитель) |
| **Product-комбайнер** | `pipeline/stages/combination.ts` | Следствие варианта (а): своя свёртка теряется при переоткрытии доски. Weighted-sum и RRF выражаются |
| **`cosine` при underflow** | `math/similarity.ts` | Компоненты < 1.5e-162 → 0 вместо 1. Недостижимо для реальных данных; лечится масштабированием ценой третьего прохода по горячей функции |

### Инфраструктура

| Что | Состояние |
|---|---|
| **CI** | ✅ Зелёный: Node 20/22/24, Bun, Deno. Оговорка — рантаймы гоняют smoke, а не весь набор |
| **Remote** | ✅ `waleron07/recommendationEngine`, публичный |
| **Браузерный прогон** | В §23.5 заявлен, в CI нет (нужен `@vitest/browser` + playwright) |
| **Тесты не типизируются** | `tsconfig` исключает `*.test.ts`; ошибка типов в тесте не упадёт в `verify` |
| **ARCHITECTURE.md** | Отстал на 31 расхождение. Чем дальше, тем дороже сверять |
| **Biome** | 4 предупреждения, см. §1 |

### npm

Организация **`recoengine` создана**, `npm org ls recoengine` → `waleron - owner`. 2FA `auth-and-writes`. Публикации нет до Этапа 11. Учесть: публикация из CI по обычному токену **не сработает** — нужен granular access token либо Trusted Publishing через OIDC.

---

## 6. Грабли, на которые уже наступили

- **`pnpm ci` ≠ `pnpm run ci`.** `ci` зарезервирована pnpm; печатает ошибку и **возвращает 0**. Скрипт называется `verify`.
- **История переписывалась `filter-branch`** (менялся e-mail автора), и старые хеши стали сиротами: они резолвятся локально из reflog, но не являются предками HEAD, а на свежем клоне не существуют вовсе. Пять хешей в §7 этого файла были неверны **три ревизии подряд**, потому что их никто не проверял `git merge-base --is-ancestor`. Исправлены.
- **TypeScript 7.0 вышел, но взят 5.9.3** — у typedoc peer-диапазон кончается на `6.0.x`.
- **`npm org create` не существует** — организация создаётся только через веб.
- **Включение 2FA отзывает CLI-токены.** `npm whoami` → `401`, лечится повторным `npm login`.
- **Biome `useLiteralKeys` против TS `noPropertyAccessFromIndexSignature`.** Лечится отказом от индексной сигнатуры: `{ id?: unknown }` вместо `Record<string, unknown>`.
- **`erasableSyntaxOnly` запрещает parameter properties** — `constructor(private readonly x: T)` не компилируется.
- **v8-покрытие и отложенные замыкания.** `builder.ts` показывал 44% функций при 99% строк: замыкание в `defer()` создаётся всегда, вызывается только на прямом пути.
- **GitHub Actions на Node 20 устарели** — подняты до v5.
- **Апостроф в названии теста ломает парсер:** `it('...operator's ceiling')` → oxc падает с `',' or ')' expected`.
- **Бюджет фильтров — доля, и на малых наборах места в ней нет.** 1 отказ из 2 = 50% > 5%, запрос падает. Это правильно, но тесты писать на наборах ≥ 20.
- **Фиксированный `sleep` в тесте — гонка с планировщиком.** Тест на композицию сигнала держался локально 8 раз из 8 и проиграл на нагруженном раннере CI. Ждать **событие**, а не спать.
- **`sqrt(a)*sqrt(b)` не бесплатная замена `sqrt(a*b)`:** она не переполняется, но округляет дважды, и `cosine(v, v)` перестаёт быть ровно 1. Нужен гибрид.
- **Агенты-аудиторы пишут пробные файлы прямо в репозиторий**, даже когда просишь `/tmp`. Проверять `git status` после.
- **Ручной симлинк devDep маскирует рассинхрон lockfile.** На Этапе 7 `pnpm install` завис (реестр недоступен), и `@recoengine/testing` был подлинкован к `diversity` вручную — тесты локально зелены, но `pnpm-lock.yaml` не узнал о новом devDep, и CI с `--frozen-lockfile` упал бы. Лечится `pnpm install --lockfile-only --offline` (workspace-зависимости сети не требуют, отрабатывает за полсекунды). Аудитом Этапа 8 найдено и починено. **Правило: после правки любого `package.json` — обновить lockfile, а не только node_modules.**

---

## 7. Хронология

Хеши проверены `git merge-base --is-ancestor` — все являются предками HEAD.

| Коммит | Что |
|---|---|
| `58d020d` | Этап 0: каркас монорепо + машинные проверки архитектуры |
| `e0ac6d4` | Переименование `ci` → `verify` (см. грабли) |
| `da3add3` | Аудит документа: 9 расхождений за три ревизии |
| `5b4cd82` | Этап 1 (1/2): ids, entities, схема, матрица, профиль, индекс истории |
| `5500bf0` | Этап 1 (2/2): ScoreBoard, Candidate, Reason — доменный слой закрыт |
| `99c1020` | PROGRESS.md: точка остановы после Этапа 1 |
| `f034a22` | Этап 2: kernel — контейнер, builder(=registry), plugin host, конфиг, граф фичей + слой портов |
| `a697cab` | PROGRESS.md: точка остановы после Этапа 2 |
| `d9b7b51` | Этап 3 (1/4): фундамент — исполнитель стадий, политика ошибок, стадия 0 |
| `6804ce8` | Этап 3 (2/4): retrieval, prefilter; экшены CI до v5 |
| `e611578` | Этап 3 (3/4): extraction, engineering, postfilter |
| `f94944e` | Этап 3 (4/4): scoring, normalization, combination, modifiers |
| `41f4177` | Этап 3 закрыт: ranking, blending, explanation, фасад движка |
| `5470e1c` | PROGRESS.md: точка остановы после Этапа 3 |
| `92cb692` | Починен тест, зависевший от таймингов, — поймал CI |
| `3c02035` | Этап 4 (1/2): rng, куча top-K, нормализаторы |
| `ffbe210` | Этап 4 закрыт: similarity, decay, RRF, бенчмарки |
| `49878ba` | Этап 5 закрыт: девять стратегий §11.3, 21 golden-тест, ARCHITECTURE §11.3 сведён |
| `94689ab` | Ревизия плана 0.5: аудит §13, заведены пропущенные стадии 6а/8а |
| `00ddc1c` | Этап 6 закрыт: три модификатора §15, 16 тестов, ARCHITECTURE §15.1 сведён |
| `e31a91f` | Этап 6а закрыт: `@recoengine/testing` (фикстуры + contract-kit), долг ручных фикстур погашен, ARCHITECTURE §21.1 сведён |
| `d15750f` | Этап 7 закрыт: `@recoengine/diversity` (MMR/quota/similarity/blender), 2 долга §5 + правка порта Diversifier, ARCHITECTURE §14.1 сведён |
| `2f46bbb` | Этап 8 закрыт: explainability в ядре (округление, ScoreTrace, engine.explain), 3 долга §5, ARCHITECTURE §16.1 сведён |
| `a1d856e` | Аудит после Этапа 8: починен рассинхрон lockfile, актуализированы README/PROGRESS |
| `de604ff` | Этап 8а закрыт: `@recoengine/features` (2 экстрактора + 2 трансформа), флаг `featuresFromPlugins` в kit, ARCHITECTURE §11.3.1 сведён |
| `ec24e13` | Этап 9 закрыт: `examples/music` (5 экстракторов + датасет + движок), 7 e2e-тестов, 0 изменений в core, ARCHITECTURE §22 сведён |
| `2fa93cc` | Этап 10 закрыт: `examples/ecommerce` (взвешивание интента + prefilter «куплено»), 7 e2e-тестов, приёмочный тест пройден (0 изменений в core) |
| `cce741b` | Этап 11 подготовлен: фасад «с батарейками», версии 0.1.0 + CHANGELOG, 0 предупреждений биома, RELEASING.md — публикация ждёт auth |
