# Точка остановы

> Обновлено: 2026-07-20
> Ветка: `main`
> Remote: [waleron07/recommendationEngine](https://github.com/waleron07/recommendationEngine) (**публичный**)
> Состояние: **Этапы 0–7 закрыты. Следующий — Этап 8 (explainability + `engine.explain()`).**
> Последняя ревизия: закрыт **Этап 7** — `@recoengine/diversity` (MMR, quota, cosine/jaccard, bucketBlender; 17 тестов, MMR(λ=1)≡ranking). Закрыты два долга §5 (слот `SimilarityProvider`, дефолтный блендер) и одна правка ядра (порт `Diversifier` получил `FeatureMatrix`). ARCHITECTURE.md §14.1 сведён тем же заходом.

Этот файл — состояние работы, а не документация. Проектные решения и их обоснования живут в [ARCHITECTURE.md](./ARCHITECTURE.md) (**версия 0.5, сверена с реализацией**); здесь только то, что нужно, чтобы продолжить с того же места.

**§3 этого файла расформирован.** Он был списком из 31 расхождения между кодом и документом — накопителем, который рос, пока документ не правили. Теперь всё это внесено в ARCHITECTURE.md с обоснованиями (§23.-2), и держать вторую копию значило бы завести третий источник правды. Осталось то, что списком быть и должно: долги кода — в §5.

---

## 1. Как убедиться, что всё живо

```bash
pnpm install
pnpm verify     # lint + check:arch + build + test
pnpm bench      # отдельно: измеряет, а не утверждает
```

Ожидаемо: **634 теста в 34 файлах**, `✓ Architecture check passed (7 packages)`, покрытие ядра **95.4% строк / 93.26% ветвей** (пороги в `vitest.config.ts`: 90/85/90/90). Из них 30 — Этап 5 (`strategies.test.ts`), 19 — Этап 6 (`modifiers.test.ts`), 10 — Этап 6а (`testing.test.ts`), 17 — Этап 7 (`diversity.test.ts`).

Biome даёт **4 предупреждения** (0 ошибок, `verify` зелёный). Они настоящие, не косметика: неиспользуемый параметр типа `P` в `RecommendationRequest` — фантом, обещающий типобезопасность, которой нет; неиспользуемый `policy` в `normalize()`. Чинить при следующем заходе.

`pnpm verify`, а **не** `pnpm ci` — `ci` зарезервирована самим pnpm, печатает `ERR_PNPM_CI_NOT_IMPLEMENTED` и выходит с кодом 0. Шаг в CI с таким именем молча «проходил» бы, не выполнив ничего.

**CI зелёный, матрица подтверждена на практике:** Node 20/22/24, Bun, Deno плюс отдельная джоба lint/arch/build/test, на каждый push в `main`. Оговорка: джобы рантаймов гоняют `scripts/smoke.mjs` (34 строки), а не весь набор — то есть матрица доказывает «пакет грузится и работает везде», но не «560 тестов зелены везде».

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

Один пакет (`features`) — пустой каркас с `export {}`. `strategies` (Этап 5), `modifiers` (Этап 6), `testing` (Этап 6а) и `diversity` (Этап 7) закрыты. Шестой, `recoengine`, — фасад `export * from '@recoengine/core'`; готовые пакеты он пока не реэкспортирует (решить при Этапе 11, когда появится, что публиковать).

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

**Грабли Этапа 5.** (1) `FeatureDescriptor.owner` обязан называть свой экстрактор — иначе `build()` падает про инвалидацию кэша. (2) Дефолтный `sortRanker` тай-брейкает по **индексу строки** (порядку retrieval), а не по `ItemId`; §13 обещал `ItemId` — ревизией 0.5 **сведён документ** (индекс дешевле и так же детерминирован, раз порядок retrieval детерминирован), это не долг кода. (3) Презентационная шкала не округляется (PROGRESS §5), поэтому golden-тесты округляют score в ассерте.

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

## 4. Следующий шаг — Этап 8 (explainability + `engine.explain()`)

Критерий приёмки из §22: **объяснение сходится, Σ contributions = baseScore** (§16). Это работа в **ядре**, не в новом пакете: `explanation.ts` уже строит `Explanation`, но три вещи не доделаны (долги §5).

Что учесть, заходя:

1. **`ScoreTrace` не заполняется (долг §5).** `explain: 'full'` сейчас = `'reasons'` — полный след (все фичи, все стадии) не собирается. `domain/explanation.ts` объявляет `ScoreTrace`, стадия 13 его игнорирует. `'full'` нужен для `/explain`-эндпоинта и отладки.
2. **`engine.explain(itemId, request)` не существует (долг §5).** §16 обещает «почему этого трека **нет** в выдаче»: прогон пайплайна для одного объекта в режиме `full`, показ, где он потерялся — отфильтрован (стадия 2), задавлен fatigue (стадия 8), вытеснен MMR (стадия 10). Прямой аналог `_explain` в Elasticsearch. Метода на `RecommendationEngine` нет.
3. **Презентационная шкала не округляется (долг §5).** §11.2 требует `round(final × 100)`, код отдаёт `96.55172…`. golden-тесты Этапов 5–7 уже округляют в ассертах — почин закроет это на уровне ядра, и округления в тестах можно снять.
4. **Golden «Σ contributions = baseScore».** §16 приводит числовой пример (89 = 0.315+0.307+0.182+0.086); §21 требует, чтобы он проходил тестом. Свести пример документа с кодом и закрепить.
5. **Contract-kit пополнить.** У `@recoengine/testing` нет контракта на объяснимость; добавить `assertExplanationSums` (Σ вкладов = base) и прогнать по стратегиям — это гигиена того же рода, что детерминизм.

**Хвосты, оставленные сознательно:** `softmax` не написан (§5, никому пока не понадобился); `recoengine`-фасад готовые пакеты не реэкспортирует (решить на Этапе 11); `recovery()` из `decay.ts` не используется (восстановление выражено затуханием счётчика) — остаётся для линейной формы. `@recoengine/features` (Этап 8а) и доменные примеры (9–10) — после explainability.

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
| **Презентационная шкала не округляется** | `pipeline/stages/explanation.ts` | §11.2 требует `round(final × 100)`; отдаём `96.55172413793103` |
| **`ScoreTrace` не заполняется** | `domain/explanation.ts` | `explain: 'full'` = `'reasons'`. Этап 8 |
| **`engine.explain(itemId, request)`** | `engine/engine.ts` | §16 обещает «почему трека нет в выдаче». Этап 8 |
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
