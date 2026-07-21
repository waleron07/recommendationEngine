# Recommendation Engine — Архитектура

> Версия документа: 0.5 (сверка с реализацией: внесён 31 пункт, накопленный за Этапы 1–4)
> Статус: **реализуется**. Этапы 0–4 закрыты (домен, ядро, пайплайн, математика); сквозной путь работает. См. [PROGRESS.md](./PROGRESS.md).
>
> С версии 0.5 документ описывает **написанный код**, а не намерение. Там, где реализация
> разошлась с проектом, правится документ, а не код: код проверяется машиной, документ —
> нет, поэтому спор между ними выигрывает тот, кого можно запустить. Каждое такое
> расхождение внесено с обоснованием — см. §23.-2.

---

## 1. Позиционирование

**Elasticsearch для рекомендаций.**

Аналогия точная, и её стоит развернуть, потому что из неё следуют все остальные решения:

| Elasticsearch | Recommendation Engine |
|---|---|
| Не знает, что такое «товар» или «статья» — знает `Document` | Не знает, что такое «трек» — знает `Item<TPayload>` |
| Пайплайн запроса фиксирован (query → rewrite → score → collect → fetch) | Пайплайн фиксирован (retrieval → features → scoring → ranking → explain) |
| Расширяемость — через **слоты**: analyzer, similarity, scoring script, aggregation | Расширяемость — через слоты: candidate provider, feature extractor, strategy, normalizer, diversifier |
| `explain: true` возвращает дерево вклада каждого терма | `explain: true` возвращает дерево вклада каждой стратегии |
| Similarity (BM25) — плагин, а не хардкод | Combiner (weighted sum) — плагин, а не хардкод |
| Доменное знание живёт в **маппинге**, а не в движке | Доменное знание живёт в **feature extractors**, а не в движке |

Ключевой вывод из аналогии: **ядро не должно содержать ни одной строчки, знающей слово «жанр», «исполнитель» или «плейлист».** Всё это — конфигурация и плагины поверх ядра.

### Что это НЕ

- Не AI, не LLM, не нейросети.
- Не ML-фреймворк. Мы не обучаем модели — мы детерминированно считаем и ранжируем.
- Не хранилище. Мы не владеем данными; данные приходят через порты.

### Что это

Детерминированная, объяснимая, расширяемая машина ранжирования произвольных объектов по пользовательскому сигналу.

---

## 2. Архитектурные принципы

1. **Domain-agnostic core.** Ядро типизировано generic-параметром `TItem`. Оно не знает семантики.
2. **Фиксированный пайплайн, расширяемые слоты.** Произвольная вставка стадий = произвольные типы = невозможность оптимизации и невозможность объяснения. Пайплайн — жёсткий контракт; расширения регистрируются в слоты.
3. **Разделение «доменное знание» / «математика».**
   - `FeatureExtractor` — знает домен, не знает математики ранжирования.
   - `ScoringStrategy` — знает математику, **не знает домена** (получает вектор чисел, а не трек).
   Это самое важное решение всего проекта. См. §11.
4. **Explainability by construction.** Объяснение не реконструируется постфактум — оно **накапливается** по ходу пайплайна. Нельзя посчитать score, не оставив след.
5. **Детерминизм.** Никаких `Math.random()` и `Date.now()` внутри. Только порты `Rng` и `Clock`. Один и тот же вход → один и тот же выход. Иначе exploration невозможно тестировать.
6. **Batch-first.** Все стадии работают с **набором** кандидатов, а не с одним. `extract(candidates[])`, а не `extract(candidate)`. Это позволяет один запрос в БД вместо N и векторизацию.
7. **Data-oriented hot path.** В горячем пути — типизированные массивы (`Float64Array`), а не объекты. Объекты — только на границах.
8. **Strict TypeScript, zero `any`.** `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`.
9. **Минимум зависимостей.** У `@recoengine/core` — **ноль** runtime-зависимостей. Цель достижима.
10. **Ports & Adapters (гексагональная).** Всё внешнее (БД, кэш, часы, логи, метрики) — порт-интерфейс в ядре, адаптер снаружи.

---

## 3. Пайплайн

Ваша схема, доведённая до исполнимого контракта:

```
                          ┌─────────────────────────────┐
   RecommendationRequest  │  user, history, context,    │
                          │  limit, config overrides    │
                          └──────────────┬──────────────┘
                                         │
  ┌──────────────────────────────────────▼──────────────────────────────────────┐
  │  0. RESOLVE      ConfigResolver + WeightProvider → ResolvedConfig            │
  │                  HistoryIndexer → HistoryIndex (O(1) доступ для всех стадий) │
  │                  RequestContext собран и заморожен                          │
  ├─────────────────────────────────────────────────────────────────────────────┤
  │  1. RETRIEVAL    CandidateProvider[]  ──parallel──▶ merge + dedup            │
  │                  budget.maxItems проталкивается в LIMIT источника (§6)       │
  │                  → CandidateSet (каждый кандидат помнит sources[])           │
  ├─────────────────────────────────────────────────────────────────────────────┤
  │  2. PREFILTER    PreFilter[]  (hard rules по payload: blacklist, уже         │
  │                  куплено, 18+, регион). Дёшево, до фичей. FAIL-CLOSED.       │
  ├─────────────────────────────────────────────────────────────────────────────┤
  │  3. FEATURE      FeatureExtractor[]  ──parallel──▶ FeatureMatrix             │
  │     EXTRACTION   UserFeatureExtractor[] ─────────▶ ProfileVector             │
  │                  (доменное знание живёт ТОЛЬКО здесь)                        │
  ├─────────────────────────────────────────────────────────────────────────────┤
  │  4. FEATURE      FeatureTransform[]  (scale, log1p, bucketize, cross,        │
  │     ENGINEERING  impute, decay). Чистая математика над матрицей.             │
  ├─────────────────────────────────────────────────────────────────────────────┤
  │ 4b. POSTFILTER   PostFilter[]  — правила, которым НУЖНЫ фичи.                │
  │                  Тот же fail-closed. До скоринга: не считаем то, что         │
  │                  всё равно не покажем.                                       │
  ├─────────────────────────────────────────────────────────────────────────────┤
  │  5. SCORING      ScoringStrategy[]  ──parallel──▶ ScoreColumn[]              │
  │                  каждая стратегия = 1 колонка сырых чисел + reasons          │
  ├─────────────────────────────────────────────────────────────────────────────┤
  │  6. NORMALIZATION ScoreNormalizer per column (minmax / zscore / rank /       │
  │                  sigmoid / none). БЕЗ этого веса не имеют смысла. См. §12.   │
  ├─────────────────────────────────────────────────────────────────────────────┤
  │  7. COMBINATION  ScoreCombiner (weighted sum | product | RRF | custom)       │
  │                  → baseScore per candidate                                   │
  ├─────────────────────────────────────────────────────────────────────────────┤
  │  8. MODIFIERS    ScoreModifier[]  (fatigue ×, novelty ×, boost +, penalty)   │
  │                  мультипликативные/аддитивные поправки поверх base           │
  ├─────────────────────────────────────────────────────────────────────────────┤
  │  9. RANKING      Ranker → top-K через heap (не full sort), tie-break         │
  ├─────────────────────────────────────────────────────────────────────────────┤
  │ 10. DIVERSIFICATION Diversifier[] (MMR | quota | greedy) + SimilarityProvider│
  ├─────────────────────────────────────────────────────────────────────────────┤
  │ 11. BLENDING     Blender — exploration/exploitation 70/20/10, ε-greedy       │
  │                  детерминированный Rng                                       │
  ├─────────────────────────────────────────────────────────────────────────────┤
  │ 12. TRUNCATE     limit + offset                                              │
  ├─────────────────────────────────────────────────────────────────────────────┤
  │ 13. EXPLANATION  Explainer — собирает ScoreTrace → Explanation               │
  │                  ReasonRenderer (i18n) — опционально, вне ядра               │
  ├─────────────────────────────────────────────────────────────────────────────┤
  │ 14. ASSEMBLE     RecommendationResult + Diagnostics (тайминги по стадиям)    │
  └─────────────────────────────────────────────────────────────────────────────┘
```

Вокруг каждой стадии — **onion middleware** (`StageMiddleware`): телеметрия, тайминг, кэш, отладка. Плагин может обернуть любую стадию, не меняя её.

### Почему стадии именно такие

- **2 до 3, 4b после 4** — ровно то же разделение, что `filter` и `post_filter` в Elasticsearch. Что можно решить по `payload` — решаем до дорогих фичей; чему нужны фичи — решаем сразу после них, но **до** скоринга: считать score объекту, который заведомо не будет показан, — чистая потеря. Два фильтра вместо одного появились в 0.3: правило безопасности вроде «трек недоступен в регионе» иногда требует фичи, а тащить сеть внутрь фильтра нельзя (§6).
- **6 отдельно от 5** — стратегия не должна знать, как её нормализуют. `PopularityStrategy` возвращает 4 200 000 прослушиваний, `RecencyStrategy` — 0.87. Без нормализации `popularityWeight` пришлось бы ставить `0.0000001`. Веса должны быть человекочитаемыми: **все стратегии после нормализации живут в `[0, 1]`**.
- **8 отдельно от 7** — fatigue и novelty **не стратегии**, они модификаторы. Стратегия говорит «насколько подходит», модификатор — «насколько уместно показать сейчас». Смешивать их в сумму неправильно: усталость должна **умножать**, а не вычитать (иначе трек с огромным score останется наверху даже после 300 прослушиваний).
- **10 после 9** — диверсификация greedy-алгоритмами (MMR) требует уже отранжированного списка.
- **11 после 10** — exploration подмешивается в уже разнообразный список, иначе новинки и разнообразие конкурируют за одни слоты.

---

## 4. Структура проекта

pnpm workspace monorepo. Обоснование: ядро с нулём зависимостей нельзя удержать в одном пакете со стратегиями и адаптерами — рано или поздно кто-то затащит `date-fns` в core. Физическая граница пакета — единственная граница, которую нельзя случайно нарушить.

```
recommendationEngine/
├── packages/
│   ├── core/                    @recoengine/core — 0 runtime deps
│   │   └── src/
│   │       ├── domain/          сущности и value objects
│   │       │   ├── ids.ts               branded ItemId/UserId/EventId/StrategyId/FeatureKey
│   │       │   ├── item.ts              Item<P>
│   │       │   ├── user.ts              User<P>
│   │       │   ├── event.ts             Event<P>, EventType
│   │       │   ├── history.ts           History, HistoryIndex
│   │       │   ├── candidate.ts         Candidate<P>, CandidateSet
│   │       │   ├── feature.ts           FeatureKey, FeatureSchema, FeatureMatrix
│   │       │   ├── score.ts             ScoreColumn, ScoreContribution, ScoreBoard
│   │       │   ├── reason.ts            Reason, ReasonCode
│   │       │   ├── explanation.ts       Explanation, ScoreTrace
│   │       │   └── recommendation.ts    Recommendation, RecommendationResult
│   │       ├── ports/           интерфейсы точек расширения
│   │       │   ├── candidate-provider.ts
│   │       │   ├── candidate-filter.ts
│   │       │   ├── feature-extractor.ts
│   │       │   ├── feature-transform.ts
│   │       │   ├── scoring-strategy.ts
│   │       │   ├── score-normalizer.ts
│   │       │   ├── score-combiner.ts
│   │       │   ├── score-modifier.ts
│   │       │   ├── ranker.ts
│   │       │   ├── diversifier.ts
│   │       │   ├── blender.ts
│   │       │   ├── similarity-provider.ts
│   │       │   ├── explainer.ts
│   │       │   ├── weight-provider.ts
│   │       │   └── infra.ts     Clock, Rng, Logger, Metrics, FeatureCache
│   │       ├── kernel/
│   │       │   ├── container.ts         минимальный DI (~150 LOC)
│   │       │   ├── token.ts             typed DI tokens
│   │       │   ├── registry.ts          Registry (пишет плагин) / ResolvedRegistry (читает пайплайн)
│   │       │   ├── plugin.ts            Plugin, asPlugin, топосорт, дедуп
│   │       │   ├── graph.ts             валидация графа фичей + порядок трансформов (§8.4)
│   │       │   ├── builder.ts           EngineBuilder implements Registry, resolve()
│   │       │   ├── config.ts            ConfigSchema, ConfigResolver, ResolvedConfig
│   │       │   └── errors.ts
│   │       ├── pipeline/
│   │       │   ├── stage.ts             STAGES (16), runStage, middleware-onion, диагностика
│   │       │   ├── policy.ts            матрица §17.2, FilterErrorBudget
│   │       │   ├── request.ts           стадия 0: RequestContext, композиция сигнала
│   │       │   ├── pipeline.ts          исполнитель: стадии прямолинейным кодом
│   │       │   └── stages/              16 стадий (0..14 плюс 4b — это шестнадцать записей)
│   │       ├── math/
│   │       │   ├── normalize.ts         minmax, zscore, rank, sigmoid, identity
│   │       │   ├── similarity.ts        cosine, jaccard, dot, weightedJaccard
│   │       │   ├── rrf.ts               reciprocal rank fusion
│   │       │   ├── decay.ts             exponential, gaussian, linear, recovery
│   │       │   ├── heap.ts              top-K
│   │       │   └── rng.ts               xoshiro128** (детерминированный, см. §23.4)
│   │       ├── platform.d.ts            AbortSignal — контракт платформы, см. §23.4
│   │       └── engine/
│   │           ├── engine.ts            createEngine(), build(), RecommendationEngine
│   │           └── defaults.ts          дефолты слотов + реестры нормализаторов и комбайнеров
│   │
│   ├── strategies/              @recoengine/strategies — доменно-нейтральные стратегии
│   │   └── src/                 History, Affinity, Popularity, Recency,
│   │                            Similarity, Novelty, Discovery, CoOccurrence
│   ├── features/                @recoengine/features — общие экстракторы/трансформы
│   │   └── src/                 EventAggregate, TimeDecay, Attribute, CoOccurrence
│   ├── modifiers/               @recoengine/modifiers — Fatigue, Novelty, Boost, Penalty
│   ├── diversity/               @recoengine/diversity — MMR, AttributeQuota, RoundRobin
│   ├── testing/                 @recoengine/testing — фикстуры, golden-раннер, property-хелперы
│   └── recoengine/              recoengine — meta-пакет (unscoped): core + дефолтная сборка
│
├── examples/                    НЕ публикуются в npm (§23.7)
│   ├── music/                   первый пример использования; здесь же domain-music
│   ├── ecommerce/               доказательство доменной независимости
│   └── articles/
├── benchmarks/
├── docs/                        typedoc + гайды
├── ARCHITECTURE.md              этот документ
├── biome.json
├── vitest.config.ts
├── tsconfig.base.json
└── pnpm-workspace.yaml
```

**Правило зависимостей** (проверяется в CI — `scripts/check-arch.mjs`): `core` ← `strategies|features|modifiers|diversity|testing` ← `recoengine` ← `examples`. Стрелки только влево. `core` не импортирует ничего. Опубликованный пакет не смеет зависеть от `examples/*` — это тоже проверяется.

Семь пакетов, а не шесть: к шести из решения §23.1 добавлен unscoped `recoengine` — meta-пакет для быстрого старта (§23.6). Доменные примеры (`domain-music`) живут в `examples/`, а не в `packages/`: пакет в `packages/` подразумевает публикацию, а публиковать музыкальный домен значит взять на себя его поддержку и снова сделать библиотеку «музыкальной» (§23.7).

---

## 5. Доменные сущности

### 5.1 Идентификаторы (branded types)

```ts
declare const brand: unique symbol
type Brand<T, B extends string> = T & { readonly [brand]: B }

export type ItemId     = Brand<string, 'ItemId'>
export type UserId     = Brand<string, 'UserId'>
export type EventId    = Brand<string, 'EventId'>
export type StrategyId = Brand<string, 'StrategyId'>
export type FeatureKey = Brand<string, 'FeatureKey'>
export type PluginName = Brand<string, 'PluginName'>
export type Timestamp  = Brand<number, 'Timestamp'>   // epoch ms, UTC
```

Зачем: `ItemId` и `UserId` — оба `string`, и их перепутывание — самый частый баг в таком движке. Брендирование делает это ошибкой компиляции при нулевой рантайм-стоимости.

### 5.2 Item / User / Event

```ts
export interface Item<P = unknown> {
  readonly id: ItemId
  readonly type: string          // 'track' | 'movie' | 'product' — открытая строка
  readonly payload: P            // доменные данные; ядро в них не заглядывает
}

export interface User<P = unknown> {
  readonly id: UserId
  readonly payload: P
}

export type EventType = string   // 'play'|'like'|'skip'|'purchase'|'view'|'rate'

export interface Event<P = unknown> {
  readonly id: EventId
  readonly userId: UserId
  readonly itemId: ItemId
  readonly type: EventType
  readonly at: Timestamp
  readonly value?: number        // рейтинг, длительность, сумма — семантика на домене
  readonly payload?: P
}
```

`EventType` — открытая строка, а не enum. Enum сделал бы ядро зависимым от домена: у музыки `skip`, у магазина `add_to_cart`. Семантику («skip — негативный сигнал весом −0.5») задаёт конфиг: `eventWeights: Record<EventType, number>`.

### 5.3 History и HistoryIndex

```ts
export interface History {
  readonly userId: UserId
  readonly events: readonly Event[]
}

/** Строится ОДИН раз за запрос. Все стратегии читают отсюда. */
export interface HistoryIndex {
  readonly size: number
  readonly firstAt: Timestamp | undefined
  readonly lastAt: Timestamp | undefined

  eventsFor(itemId: ItemId): readonly Event[]
  countFor(itemId: ItemId, type?: EventType): number
  lastAtFor(itemId: ItemId, type?: EventType): Timestamp | undefined
  hasSeen(itemId: ItemId): boolean

  /**
   * Обобщённая агрегация: ядро ВЫПОЛНЯЕТ доменную функцию, но не СОДЕРЖИТ доменного знания.
   * Мемоизируется по memoKey в пределах запроса — 8 экстракторов, один проход.
   *   history.aggregate('artist', e => itemsById.get(e.itemId)?.artistId)
   */
  aggregate<K>(memoKey: string, keyFn: (e: Event) => K | undefined): ReadonlyMap<K, number>

  slice(from: Timestamp, to: Timestamp): HistoryIndex
  ofType(type: EventType): HistoryIndex
}
```

Это ответ на главную проблему производительности: наивно каждая стратегия делает `history.events.filter(...)` — O(S × H). С индексом — O(H) один раз + O(1) на обращение. При 8 стратегиях и истории в 50k событий разница на два порядка.

**Весь API ключуется на `ItemId` — собственном типе ядра.** Ни одной доменной строки. Прежняя версия документа предлагала `aggregateBy('artist')`, что было прямой протечкой домена в ядро: ядро не имеет права знать слово `artist`. `aggregate(memoKey, keyFn)` решает ту же задачу, принимая доменную функцию извне.

### 5.4 Candidate и CandidateSet

```ts
export interface Candidate<P = unknown> {
  readonly item: Item<P>
  readonly sources: ReadonlySet<string>   // id провайдеров, вернувших кандидата
  readonly retrievalScore: number         // score от провайдера (ANN distance и т.п.)
}

export interface CandidateSet<P = unknown> {
  readonly candidates: readonly Candidate<P>[]
  readonly size: number
  indexOf(id: ItemId): number             // строка в FeatureMatrix
}
```

`sources` — не декорация: это готовый сигнал для скоринга (кандидат, найденный тремя провайдерами, релевантнее) и для объяснения («похож на то, что вы слушали» + «популярно у похожих»).

### 5.5 Feature: схема и матрица

```ts
export type FeatureKind =
  | 'numeric'       // произвольное число
  | 'binary'        // 0 | 1
  | 'ordinal'       // порядковая шкала
  | 'categorical'   // ХЕШ категории: сравнимо на равенство, но не на порядок
  | 'embedding'     // векторная фича, arity > 1

export interface FeatureDescriptor {
  readonly key: FeatureKey
  readonly kind: FeatureKind
  readonly arity?: number               // default 1; >1 → векторная фича (эмбеддинг)
  readonly defaultValue: number         // подставляется при degrade-политике, см. §17
  readonly range?: readonly [min: number, max: number]
  readonly description: string          // → typedoc + explain
  readonly owner: string                // id экстрактора — для диагностики коллизий
  readonly ownerVersion: string         // → входит в schema.version → в ключ кэша
}
```

#### Два типа схемы вместо `freeze()`

Схема изменяема **только** во время регистрации плагинов и становится неизменяемой при `build()`. Это выражено **типами**, а не рантайм-флагом:

```ts
/** Виден только внутри Plugin.register(). Записывающий интерфейс. */
export interface MutableFeatureSchema {
  register(d: FeatureDescriptor): void  // бросает FeatureCollisionError при дубле ключа
}

/** Виден всем после build(). Читающий интерфейс. Метода register() тут НЕТ. */
export interface FeatureSchema {
  readonly size: number                 // суммарное число КОЛОНОК (с учётом arity)
  readonly version: FeatureSchemaVersion
  indexOf(key: FeatureKey): number      // бросает, если фича не объявлена
  has(key: FeatureKey): boolean
  descriptor(key: FeatureKey): FeatureDescriptor
  descriptors(): readonly FeatureDescriptor[]
}
```

`plugin.register()` после `build()` невозможен: у плагина попросту нет объекта с методом `register` — `build()` возвращает движок, а не билдер. Сценарий из ревизии (`register → recommend → register` → несовместимая матрица) не компилируется. Рантайм-проверка тоже есть (билдер помечается `sealed`), но она — второй рубеж, а не первый.

#### Версионирование схемы

```ts
export type FeatureSchemaVersion = Brand<string, 'FeatureSchemaVersion'>
// FNV-1a по отсортированным кортежам (key, kind, arity, owner, ownerVersion)
// → 'fs_9a3f21c7'
```

Версия входит в ключ кэша фичей: `${schema.version}:${extractorId}:${itemId}`. Меняется набор фичей, arity или версия экстрактора → ключ меняется → старый кэш недостижим и вытесняется по TTL. Несовместимая матрица из холодного кэша невозможна by construction. Прямой аналог версии маппинга в Elasticsearch.

`schema.version` также попадает в `Diagnostics` и в `engine.inspect()` — при разборе инцидента видно, какой схемой посчитана выдача.

#### Матрица

```ts
/**
 * Float64Array. rows = кандидаты, cols = колонки схемы.
 * ДВА layout'а под одним швом — см. ниже. column(key) и vector(key, row) оба отдают
 * непрерывный срез, и вызывающий не знает, какой из них где живёт.
 */
export interface FeatureMatrix {
  readonly rows: number
  readonly schema: FeatureSchema
  get(key: FeatureKey, row: number): number             // arity === 1
  column(key: FeatureKey): Float64Array                 // readonly view, длина = rows
  vector(key: FeatureKey, row: number): Float64Array    // arity > 1: эмбеддинг объекта
  columnMut(key: FeatureKey): Float64Array              // только для transform-стадии
  vectorMut(key: FeatureKey, row: number): Float64Array
}
```

Плоский `Float64Array`, а не array-of-objects — принципиально: `ZScoreNormalizer` нормализует колонку одним проходом по непрерывной памяти. С массивом объектов это pointer chasing по 10k объектам на каждую из 30 фич.

**ИСПРАВЛЕНО в 0.5: layout'а два, а не один.** До 0.5 здесь стояло «column-major» без оговорок, и реализация показала, что так нельзя. Два потребителя ходят по матрице **перпендикулярно**: нормализатор идёт по одной фиче через все строки (нужен column-major), а косинус — по 128 измерениям одной строки (нужен row-major). При сплошном column-major эти 128 значений лежали бы на расстоянии `rows` друг от друга, и `vector()` мог бы вернуть только копию — аллокация на каждого кандидата, на функции, которую MMR зовёт O(страница × пул) раз.

Реализовано: **скаляры column-major, эмбеддинги row-major поблочно на фичу**. Схема знает, где живёт фича; шва не видно ни в одном порте. Требование «непрерывный срез» выполнено для обоих — просто непрерывность у них по разным осям, потому что и вопросы к ним разные.

`arity > 1` закрывает эмбеддинги: `item_emb` с `arity: 128` занимает 128 колонок, `vector('item_emb', row)` отдаёт срез. Возражение «в `Float64Array` не положить эмбеддинг» снято — кладётся, и без единого объекта на кандидата.

#### Категориальные фичи вместо `AttributeStore`

`AttributeStore` из версии 0.1 **удалён**. Он был вторым каналом доменного знания в ядро помимо экстракторов — то есть дырой в главном инварианте архитектуры.

Оказалось, что всё, ради чего он вводился, выражается штатно:

| Задача | Было (0.1) | Стало (0.2) |
|---|---|---|
| Квота «не более 3 треков исполнителя» | `attributes.get(id, 'artist')` | фича `kind: 'categorical'` — хеш `artistId`; группировка = равенство значений |
| Похожесть по жанрам (Jaccard) | `attributes.get(id, 'genres')` | `SimilarityProvider` — порт, доменный **по определению** |
| Агрегат истории по исполнителю | `history.aggregateBy('artist')` | `history.aggregate('artist', keyFn)` — ядро зовёт доменную функцию |

Хеш категории (53-битное безопасное целое) сохраняет равенство — единственную операцию, которая нужна квотам. Коллизия означает, что двух исполнителей посчитали одним; при 10⁶ различных значений вероятность ≈ 10⁻⁴ и цена — чуть более строгая квота. Приемлемо.

**Доменных каналов в ядро осталось ровно два: `FeatureExtractor` (домен → числа) и `SimilarityProvider` (домен → метрика близости).** Второй неустраним: «похожесть» — доменное понятие, и честнее держать его отдельным явным портом, чем притворяться, что его нет.

### 5.6 Score и след

```ts
export type ContributionKind = 'additive' | 'multiplicative' | 'boost' | 'veto'

export interface ScoreColumn {
  readonly strategyId: StrategyId
  readonly raw: Float64Array                  // сырые значения, любая шкала
  readonly reasons: ReadonlyMap<number, readonly Reason[]>  // row → причины
}

export interface ScoreContribution {
  readonly strategyId: StrategyId
  readonly kind: ContributionKind
  readonly raw: number            // до нормализации
  readonly normalized: number     // после, [0..1]
  readonly weight: number
  readonly contribution: number   // фактический вклад в итог
  readonly reasons: readonly Reason[]
}

export interface ScoreBoard {
  readonly rows: number
  base(row: number): number
  final(row: number): number
  contributions(row: number): readonly ScoreContribution[]
}
```

`ScoreContribution` хранит **и raw, и normalized, и weight, и contribution**. Избыточно с точки зрения данных, необходимо с точки зрения объяснимости: без raw нельзя сказать «прослушано 143 раза», без contribution — «это дало +31 балл из 95».

### 5.7 Reason и Explanation

```ts
export interface Reason {
  readonly code: string                   // 'favorite_artist' — стабильный ключ
  readonly polarity: 'positive' | 'negative' | 'neutral'
  readonly strength: number               // [0..1] — для сортировки причин
  readonly params?: Readonly<Record<string, string | number>>  // { artist: 'Beatles', plays: 143 }
}

export interface Explanation {
  readonly score: number                          // итог, презентационная шкала (0..100)
  readonly baseScore: number                      // до модификаторов
  readonly contributions: readonly ScoreContribution[]   // ЕДИНСТВЕННЫЙ источник правды
  readonly reasons: readonly Reason[]             // решение Explainer'а: отбор + сортировка
  readonly trace?: ScoreTrace                     // только при explain: 'full'
}

export interface ScoreTrace {
  readonly schemaVersion: FeatureSchemaVersion
  readonly stages: readonly { stage: string; value: number; note?: string }[]
  readonly features: Readonly<Record<string, number>>
}
```

**Ревизия моделей объяснения (было 5 → стало 3).**

| Было (0.1) | Стало (0.2) | Почему |
|---|---|---|
| `Reason` | `Reason` | Оставлен |
| `ScoreContribution` | `ScoreContribution` | Оставлен |
| `Factor` | — | **Мой ляп в тексте.** «Фактор» и `ScoreContribution` — одно и то же. Убрана только терминологическая двойственность, поле называлось `factors`, тип был `ScoreContribution` |
| `Explanation.factors` | `Explanation.contributions` | Переименовано под тип. Одно имя для одной вещи |
| `Explanation.strategies` | — | **Удалено.** Чистая деривация: `contributions.map(c => c.strategyId)`. Хранить производное поле — приглашение к рассинхрону |
| `ScoreTrace` | `ScoreTrace` | Оставлен, но только под `explain: 'full'` |

`reasons` **оставлен полем, хотя выглядит деривацией из `contributions`** — и это осознанно. Это не деривация, а **политика**: какие причины показать (`minContribution`), сколько (`maxReasons`), в каком порядке (по `contribution` или по `strength`), показывать ли негативные. Решает это `Explainer` — сменный порт. Вычислять политику на стороне клиента значило бы размазать её по всем потребителям.

Правило разграничения: **производные данные — функции, политические решения — поля.** Поэтому `strategies` стал функцией, а `reasons` остался полем.

Ключевое решение: ядро возвращает **`Reason` с кодом и параметрами, а не готовый текст**. `"Любимый исполнитель"` — это `{ code: 'favorite_artist', params: { artist: 'Beatles', plays: 143 } }`. Рендер строки — вне ядра (`ReasonRenderer`), потому что i18n, A/B-тесты формулировок и разные каналы (push vs UI) — не забота движка. Захардкоженная русская строка в core убила бы библиотеку как open-source.

### 5.8 Recommendation

```ts
export interface Recommendation<P = unknown> {
  readonly item: Item<P>
  readonly rank: number                   // 1-based
  readonly score: number                  // презентационная шкала
  readonly explanation: Explanation
}

export interface RecommendationResult<P = unknown> {
  readonly recommendations: readonly Recommendation<P>[]
  readonly diagnostics: Diagnostics
}

export interface Diagnostics {
  readonly totalMs: number
  readonly stages: readonly { id: string; ms: number; in: number; out: number }[]
  readonly retrieved: number
  readonly filtered: number
  readonly warnings: readonly string[]
}
```

---

## 6. Порты (точки расширения)

Все — в `@recoengine/core/ports`. Это **весь** публичный контракт расширяемости.

```ts
/** Общее для всех портов: как движок ведёт себя при падении этого расширения. См. §17. */
export interface Criticality {
  readonly criticality?: 'required' | 'optional'   // default: 'required'
}

/**
 * Бюджет ПРОТАЛКИВАЕТСЯ в провайдер, а не применяется после него.
 * Обрезать 1M строк после SELECT — это не защита от DOS, это её маскировка:
 * база уже отработала, память уже выделена. Провайдер ОБЯЗАН перевести
 * budget.maxItems в LIMIT своего источника. Движок обрезает сверху — как
 * второй рубеж, с warning'ом, а не как основной механизм.
 */
export interface RetrievalBudget {
  readonly maxItems: number
  readonly deadline: Timestamp
}

export interface CandidateProvider<P = unknown> extends Criticality {
  readonly id: string
  readonly version: string
  provide(ctx: RequestContext, budget: RetrievalBudget): Promise<readonly Item<P>[]>
}

/**
 * FAIL-CLOSED ПО КОНТРАКТУ, а не по настройке.
 * Фильтр — последняя линия защиты (возраст, лицензии, GDPR, blacklist).
 * Гарантия выражена ЧЕТЫРЬМЯ структурными свойствами, а не абзацем в документе:
 *
 *  1. НЕТ поля criticality. Сама возможность выбора политики была бы ошибкой.
 *  2. approve() СИНХРОНЕН. Нельзя сходить в сеть за решением — значит, не бывает
 *     «сервис лицензий не ответил, пропускаем». Данные для решения обязаны быть
 *     уже получены: в Item.payload (retrieval) или в фиче от экстрактора
 *     с criticality: 'required'. Лицензионный сервис лёг → запрос падает ГРОМКО
 *     на стадии 3, а не тихо открывает фильтр на стадии 2.
 *  3. Функция ТОТАЛЬНА: ровно два исхода. Исключение — не третий исход:
 *     движок трактует throw как отказ. Кандидат, не одобренный ЯВНО, не проходит.
 *  4. Имя метода задаёт полярность: не «проверь», а «одобри».
 */
export interface PreFilter<P = unknown> {
  readonly id: string
  readonly failClosed: true         // литерал; опустить нельзя — потребует компилятор
  /** Стадия 2. Только Item.payload и ctx — до дорогих фичей. true = ОДОБРИТЬ. */
  approve(candidate: Candidate<P>, ctx: RequestContext): boolean
}

export interface PostFilter {
  readonly id: string
  readonly failClosed: true
  readonly requires: readonly FeatureKey[]   // валидируется при build()
  /** Стадия 4b. Правила, которым нужны фичи. true = ОДОБРИТЬ. */
  approve(row: number, view: ScoringView): boolean
}

export interface FeatureExtractor<P = unknown> extends Criticality {
  readonly id: string
  readonly version: string                        // → schema.version → ключ кэша
  readonly provides: readonly FeatureDescriptor[]
  /** BATCH. Пишет в матрицу, читает домен. Один из двух доменных каналов. */
  extract(set: CandidateSet<P>, out: FeatureMatrix, ctx: RequestContext): Promise<void>
  readonly cache?: { readonly ttlMs: number; key(id: ItemId, ctx: RequestContext): string }
}

/**
 * НОВОЕ в 0.2. Фичи УРОВНЯ ПОЛЬЗОВАТЕЛЯ, а не кандидата: центроид вкуса,
 * эмбеддинг сессии, насыщение профиля, seed-вектор PPR.
 * Ответ на пробел «стратегия видит кандидатов, но не видит историю в векторном виде».
 */
export interface UserFeatureExtractor<UP = unknown> extends Criticality {
  readonly id: string
  readonly version: string
  /**
   * ВНЕСЕНО в 0.5. Литеральный маркер, обязателен.
   * `use()` диспетчеризует структурно (§8.2), а этот порт структурно совпадает с
   * `FeatureExtractor`: оба — `{ id, version, provides, extract }`. Различать их по
   * `extract.length` — догадка, которую молча ломает параметр по умолчанию. Маркер в том
   * же духе, что `failClosed: true` и `domain: true`: инвариант охраняется типом.
   */
  readonly scope: 'user'
  readonly provides: readonly FeatureDescriptor[]
  extract(out: MutableProfileVector, ctx: RequestContext<UP>): Promise<void>
}

export interface ProfileVector {
  readonly schema: FeatureSchema
  get(key: FeatureKey): number
  vector(key: FeatureKey): Float64Array           // arity > 1: эмбеддинг сессии/профиля
}

/** Пишущий вид на ProfileVector. Виден только внутри UserFeatureExtractor.extract(). */
export interface MutableProfileVector extends ProfileVector {
  set(key: FeatureKey, value: number): void
  setVector(key: FeatureKey, value: Float64Array): void
}

/** Куда порты пишут предупреждения. Не console: диагностика — часть ответа (§17.2). */
export interface DiagnosticsSink {
  warn(w: DiagnosticWarning): void
}

/** Одна колонка после нормализации — вход комбайнера. */
export interface NormalizedColumn {
  readonly strategyId: StrategyId
  readonly normalized: Float64Array               // [0..1]
  readonly raw: Float64Array                      // сохраняется ради explain
  readonly weight: number
  readonly reasons: ReadonlyMap<number, readonly Reason[]>
}

export interface FeatureTransform {
  readonly id: string
  readonly version: string
  readonly requires: readonly FeatureKey[]
  readonly provides: readonly FeatureDescriptor[]
  apply(matrix: FeatureMatrix, ctx: RequestContext): void
}

/**
 * Всё, что видит стратегия. Расширяемо БЕЗ смены сигнатуры — это и есть FeatureView.
 * Обратите внимание: ctx входит сюда, а в ctx есть HistoryIndex.
 * Стратегия НИКОГДА не была ограничена одним Float64Array.
 */
export interface ScoringView {
  readonly items: FeatureMatrix       // rows = кандидаты
  readonly profile: ProfileVector     // фичи пользователя/сессии
  readonly ctx: RequestContext        // history, signals, config, rng, now, signal
}

export interface ScoringStrategy {
  readonly id: StrategyId
  readonly requires: readonly FeatureKey[]           // валидируется при build()
  readonly requiresProfile?: readonly FeatureKey[]   // валидируется при build()
  readonly normalizer?: ScoreNormalizer              // стратегия знает свою шкалу
  /**
   * Применима ли стратегия к ЭТОМУ запросу (cold start: история < 50 событий).
   * Раз на запрос, не на объект. false → колонка не считается,
   * вес автоматически перераспределяется нормировкой на Σweights. См. §17.3.
   */
  applicable?(ctx: RequestContext): boolean
  /** Домена не знает. Работает с числами. */
  score(view: ScoringView): ScoreColumn
}

/**
 * ESCAPE HATCH. Стратегия с доступом к доменным объектам.
 * Не запрещена — но привязана к домену НА УРОВНЕ ТИПОВ:
 * DomainScoringStrategy<Track> не зарегистрируется в createEngine<Movie>().
 * Цена видна в сигнатуре, компилятор её взимает. См. §11.1.
 */
export interface DomainScoringStrategy<P> {
  readonly id: StrategyId
  readonly requires: readonly FeatureKey[]
  readonly domain: true                              // маркер → engine.inspect() → docs
  readonly normalizer?: ScoreNormalizer
  applicable?(ctx: RequestContext): boolean
  score(view: ScoringView, set: CandidateSet<P>): ScoreColumn
}

export interface ScoreNormalizer {
  readonly id: string
  normalize(raw: Float64Array): Float64Array      // → [0..1]
}

export interface ScoreCombiner {
  readonly id: string
  combine(columns: readonly NormalizedColumn[], ctx: RequestContext): ScoreBoard
}

/**
 * ВНЕСЕНО в 0.5. Модификатор получает ПИШУЩИЙ вид доски.
 * В 0.4 здесь стояло `board: ScoreBoard` с возвратом `void` — сочетание, при котором
 * модификатор не может сделать ничего: доска read-only, возвращать некуда. Реализация
 * это обнаружила сразу же. MutableScoreBoard — это `rows` + `add()`, то есть модификатор
 * ДОПИСЫВАЕТ вклад, а не переписывает score: объяснимость остаётся структурной.
 */
export interface MutableScoreBoard {
  readonly rows: number
  add(row: number, contribution: ScoreContribution): void
}

export interface ScoreModifier {
  readonly id: string
  readonly kind: ContributionKind
  apply(board: MutableScoreBoard, set: CandidateSet, ctx: RequestContext): void
}

export interface Ranker {
  readonly id: string
  rank(board: ScoreBoard, set: CandidateSet, ctx: RequestContext): readonly number[]  // row indices
}

export interface Diversifier<P = unknown> {
  readonly id: string
  diversify(ranked: readonly number[], set: CandidateSet<P>, board: ScoreBoard, ctx: RequestContext): readonly number[]
}

export interface SimilarityProvider<P = unknown> {
  readonly id: string
  similarity(a: number, b: number, set: CandidateSet<P>, matrix: FeatureMatrix): number  // [0..1]
}

export interface Blender {
  readonly id: string
  blend(ranked: readonly number[], board: ScoreBoard, ctx: RequestContext): readonly number[]
}

export interface Explainer<P = unknown> {
  readonly id: string
  explain(row: number, board: ScoreBoard, set: CandidateSet<P>, ctx: RequestContext): Explanation
}

export interface WeightProvider {
  readonly id: string
  /** Позволяет A/B, персональные веса, веса из бандита — БЕЗ изменения ядра. */
  weights(ctx: RequestContext): ReadonlyMap<StrategyId, number>
}

// Инфраструктурные порты
export interface Clock { now(): Timestamp }
export interface Rng { next(): number; int(maxExclusive: number): number; fork(seed: string): Rng }
export interface Logger { debug(m: string, d?: object): void; warn(m: string, d?: object): void }
export interface Metrics { timing(k: string, ms: number): void; count(k: string, n?: number): void }
export interface FeatureCache { get(k: string): Float64Array | undefined; set(k: string, v: Float64Array, ttlMs: number): void }
```

### RequestContext

```ts
export interface RequestContext<UP = unknown> {
  readonly user: User<UP>
  readonly history: HistoryIndex
  readonly now: Timestamp
  readonly limit: number
  readonly offset: number
  readonly explain: 'none' | 'reasons' | 'full'
  readonly signals: ReadonlyMap<string, unknown>   // время суток, устройство, настроение
  readonly config: ResolvedConfig
  readonly rng: Rng
  readonly logger: Logger
  readonly diagnostics: DiagnosticsSink            // warnings пишутся сюда, не в console
  readonly signal: AbortSignal                     // НЕ опционален, см. §17
}
```

`attributes: AttributeStore` из версии 0.1 удалён — см. §5.5.

`signals` — намеренно нетипизированная сумка. Это единственная уступка: контекст принципиально доменный («идёт дождь», «пользователь в спортзале»). Типизируется на уровне домена через declaration merging.

---

## 7. UML (текстом)

### 7.1 Слои

```
┌────────────────────────────────────────────────────────────────────────┐
│  APPLICATION          examples/music, examples/ecommerce               │
│                       НЕ публикуются (§23.7)                           │
├────────────────────────────────────────────────────────────────────────┤
│  DOMAIN PLUGINS       examples/music/domain                            │
│                       ArtistAffinityExtractor, GenreAffinityExtractor  │
├────────────────────────────────────────────────────────────────────────┤
│  META                 recoengine — core + дефолтная сборка             │
├────────────────────────────────────────────────────────────────────────┤
│  GENERIC PLUGINS      @recoengine/strategies   @recoengine/features    │
│                       @recoengine/modifiers    @recoengine/diversity   │
├────────────────────────────────────────────────────────────────────────┤
│  PORTS                CandidateProvider, PreFilter, PostFilter,        │
│  @recoengine/core     FeatureExtractor, UserFeatureExtractor,          │
│                       ScoringStrategy, Ranker, Diversifier, ...        │
├────────────────────────────────────────────────────────────────────────┤
│  ENGINE + PIPELINE    RecommendationEngine, Pipeline, Stages           │
├────────────────────────────────────────────────────────────────────────┤
│  KERNEL               Container, EngineBuilder(=Registry), PluginHost, │
│                       Config, FeatureSchema                            │
├────────────────────────────────────────────────────────────────────────┤
│  DOMAIN MODEL         Item, User, Event, FeatureMatrix, ProfileVector, │
│                       ScoreBoard, HistoryIndex                         │
│  MATH                 normalize, similarity, mmr, rrf, decay, heap, rng│
└────────────────────────────────────────────────────────────────────────┘
        Зависимости строго вниз. Ядро не знает о верхних слоях.
```

### 7.2 Классы (ключевые)

```
┌────────────────────────────────┐
│ RecommendationEngine<P>        │
├────────────────────────────────┤
│ - pipeline: Pipeline           │
│ - container: Container         │
│ - registry: Registry           │
├────────────────────────────────┤
│ + recommend(req): Result<P>    │
│ + explain(itemId, req): Expl   │
│ + inspect(): EngineInfo        │
└───────────┬────────────────────┘
            │ owns
            ▼
┌────────────────────────────────┐        ┌──────────────────────┐
│ Pipeline                       │◇──────▶│ Stage<In, Out>       │
├────────────────────────────────┤  1..*  ├──────────────────────┤
│ - stages: Stage[]              │        │ + id                 │
│ - middleware: Middleware[]     │        │ + execute(in, ctx)   │
├────────────────────────────────┤        └──────────┬───────────┘
│ + run(ctx): Result             │                   │ implements
└────────────────────────────────┘                   │
                                     ┌───────────────┼──────────────┬─────────────┐
                                     ▼               ▼              ▼             ▼
                              RetrievalStage  ExtractionStage  ScoringStage  RankingStage
                                     │               │              │             │
                                     │ uses slot     │ uses slot    │ uses slot   │ uses slot
                                     ▼               ▼              ▼             ▼
                            CandidateProvider  FeatureExtractor ScoringStrategy  Ranker
                                    ▲                ▲                ▲            ▲
                        ┌───────────┴──┐    ┌────────┴────────┐  ┌────┴─────┐  ┌───┴────┐
                    UserLibrary  SimilarANN  EventAggregate  Genre  History  Genre  TopK
                     Provider     Provider     Extractor    Extr.  Strategy  Strat. Ranker
```

```
┌──────────────────────┐  register(Registry)  ┌──────────────────────────────┐
│ Plugin               │─────────────────────▶│ «interface» Registry         │
├──────────────────────┤                      │  (что видит ПЛАГИН — запись) │
│ + name: PluginName   │                      ├──────────────────────────────┤
│ + version: string    │                      │ + schema: MutableFeatureSchema│
│ + dependsOn?: []     │                      │ + addProvider/addExtractor/  │
│ + register(reg, c)   │                      │   addStrategy/addModifier... │
└──────────────────────┘                      │ + setCombiner/setRanker...   │
         ▲                                    └──────────────┬───────────────┘
         │ implements                                        │ implements
   ┌─────┴────────┬────────────┐                             │
 MusicPlugin  FatiguePlugin  MMRPlugin        ┌──────────────▼───────────────┐
                                              │ EngineBuilder<P>             │
                                              │  (что видит ВЫЗЫВАЮЩИЙ КОД)  │
                                              │  ОДИН объект, две роли       │
                                              ├──────────────────────────────┤
                                              │ + use(...): this             │
                                              │ + configure(...): this       │
                                              │ + build(): Engine<P>         │
                                              └──────────────┬───────────────┘
                                                             │ build() = ГРАНИЦА
                                                             │ МУТАБЕЛЬНОСТИ
                                              ┌──────────────▼───────────────┐
                                              │ ResolvedRegistry (frozen)    │
                                              │ + schema: FeatureSchema      │
                                              │   (register() больше НЕТ)    │
                                              │ + providers/extractors/...   │
                                              └──────────────────────────────┘
```

### 7.3 Sequence — один вызов `recommend()`

```
Client      Engine      Pipeline   Retrieval  Extraction  Scoring   Ranking  Explainer
  │           │            │           │          │          │         │         │
  ├─recommend▶│            │           │          │          │         │         │
  │           ├─ resolve config (overrides > WeightProvider > user > engine)      │
  │           ├─ build HistoryIndex — ОДИН раз, дальше все читают отсюда (§5.3)   │
  │           ├─ signal = any(request.signal, timeout(limits.timeoutMs))  (§17.1) │
  │           ├─ limit > maxLimit ? → REQUEST_LIMIT_EXCEEDED               (§23.3)│
  │           ├─run(ctx)──▶│           │          │          │         │         │
  │           │            │           │          │          │         │         │
  │           │  [1]       ├─execute──▶│          │          │         │         │
  │           │            │  budget = maxCandidates / providers → LIMIT в SQL    │
  │           │            │           ├provider1─┤(parallel)│         │         │
  │           │            │           ├provider2─┤          │         │         │
  │           │            │◀─CandSet──┤ merge + dedup, sources[] сохранены       │
  │           │  [2]       ├─preFilter─┤ по payload. throw ⇒ drop      (§17.2)    │
  │           │            │           │          │          │         │         │
  │           │  [3]       ├─execute──────────────▶│         │         │         │
  │           │            │           │          ├extract1──┤(parallel)         │
  │           │            │           │          ├extract2──┤ → FeatureMatrix    │
  │           │            │           │          ├userExtr──┤ → ProfileVector    │
  │           │            │◀─matrix + profile────┤          │         │         │
  │           │  [4]       ├─transforms───────────┤ топологический порядок        │
  │           │  [4b]      ├─postFilter───────────┤ по фичам. throw ⇒ drop        │
  │           │            │           │          │          │         │         │
  │           │  [5]       ├─execute─────────────────────────▶│        │         │
  │           │            │  applicable(ctx)? нет ⇒ пропуск, вес уходит в Σ      │
  │           │            │           │          │          ├strat1───┤(parallel)│
  │           │            │           │          │          ├strat2───┤         │
  │           │  [6]       │           │          │          ├normalize│ per column
  │           │  [7]       │           │          │          ├combine  │ Σwᵢnᵢ/Σw
  │           │  [8]       │           │          │          ├modifiers│ fatigue ×
  │           │            │◀─ScoreBoard─────────────────────┤        │         │
  │           │            │           │          │          │         │         │
  │           │  [9]       ├─execute────────────────────────────────────▶│       │
  │           │            │           │          │          │        ├topK heap │
  │           │  [10]      │           │          │          │        ├diversify │
  │           │  [11]      │           │          │          │        ├blend 70/20/10
  │           │  [12]      │           │          │          │        ├truncate  │
  │           │            │◀─rankedRows────────────────────────────────┤        │
  │           │  [13]      ├─execute──────────────────────────────────────────────▶│
  │           │            │◀─Explanation[]───────────────────────────────────────┤
  │           │  [14]      ├─ assemble Result + Diagnostics (тайминги, warnings)  │
  │           │◀─Result────┤           │          │          │         │         │
  │◀─Result───┤            │           │          │          │         │         │

  ctx.signal проверяется на КАЖДОЙ границе [n] — 15 точек, бесплатно (§17.1).
```

---

## 8. Plugin System

### 8.0 Ревизия: Builder И ЕСТЬ Registry

В версии 0.1 было пять уровней с пересекающейся ответственностью:

```
Plugin → Registry → Builder → Pipeline → Engine
         ↑______________|         Builder знает Registry,
                                  Registry знает Plugins,
                                  Plugins знают Registry — цикл в описании
```

Замечание справедливо: `Registry` и `Builder` — **не два объекта, а две роли одного объекта**. Разделять их незачем, но и сливать в один интерфейс нельзя: плагину не следует видеть `build()`.

Решение — один класс, два интерфейса (ISP), плюс явная граница мутабельности:

```
Plugin ──register(Registry)──▶ EngineBuilder ──build()──▶ Engine
                               (implements Registry)         │
                               МУТАБЕЛЬНАЯ ФАЗА              ├── ResolvedRegistry (frozen)
                                                             ├── FeatureSchema (frozen)
                                                             └── Pipeline
```

```ts
/** Что видит ПЛАГИН. Только запись. build() тут нет — вызвать нельзя. */
export interface Registry {
  /** Фичи КАНДИДАТОВ. */
  readonly schema: MutableFeatureSchema
  /**
   * ВНЕСЕНО в 0.5. Фичи ПОЛЬЗОВАТЕЛЯ — отдельное пространство, а не раздел первого.
   *
   * В 0.4 схема была одна. Реализация показала, почему так нельзя: `affinity_genre` —
   * законное имя и для item-фичи («насколько трек подходит пользователю»), и для
   * profile-фичи («какая доля вкуса — этот жанр»). Оба смысла настоящие, оба естественно
   * называются так, и один namespace объявил бы эту пару коллизией, заставив
   * переименовывать, чтобы сказать то же самое. Это разные векторные пространства, и
   * теперь движок это знает: `requires` проверяется по первой схеме, `requiresProfile` —
   * по второй, и item-фича не может подменить profile-фичу.
   */
  readonly profileSchema: MutableFeatureSchema
  addProvider<P>(p: CandidateProvider<P>): void
  addPreFilter<P>(f: PreFilter<P>): void
  addPostFilter(f: PostFilter): void
  addExtractor<P>(e: FeatureExtractor<P>): void
  addUserExtractor(e: UserFeatureExtractor): void
  addTransform(t: FeatureTransform): void
  addStrategy(s: ScoringStrategy): void
  addModifier(m: ScoreModifier): void
  addDiversifier<P>(d: Diversifier<P>): void
  addMiddleware(m: StageMiddleware): void
  setCombiner(c: ScoreCombiner, opts?: { override: boolean }): void
  setRanker(r: Ranker, opts?: { override: boolean }): void
  setExplainer(e: Explainer, opts?: { override: boolean }): void
  setBlender(b: Blender, opts?: { override: boolean }): void
  /** ВНЕСЕНО в 0.5. §10 требует WeightProvider в цепочке разрешения — слота не было. */
  setWeightProvider(w: WeightProvider, opts?: { override: boolean }): void
}

/**
 * Что видит ВЫЗЫВАЮЩИЙ КОД. Тот же объект.
 *
 * ВНЕСЕНО в 0.5: шов между `resolve()` и `build()`. Ядро собирает и валидирует реестр —
 * и на этом останавливается: оно не выдумывает ранкер, `combiner`/`ranker`/`explainer` в
 * блюпринте остаются `undefined`. Заполняет пустые слоты дефолтами и оборачивает
 * результат `build()` из `engine/`, где математика уже известна. Две работы — два места;
 * именно это позволяет ядру честно не знать математики, а пустому движку — работать.
 */
export class EngineBuilder<P> implements Registry {
  use(p: Plugin | ScoringStrategy | FeatureExtractor<P> | /* ... */): this
  configure(c: DeepPartial<EngineConfig>): this
  /** ВНЕСЕНО в 0.5. Без него контейнер доступен только плагинам, и хост не подставит свой Clock. */
  provide<T>(token: Token<T>, value: T): this
  resolve(): EngineBlueprint<P>        // ядро: реестр + конфиг + контейнер, билдер запечатан
}

/** `engine/`: тот же билдер, но знающий дефолты. Это и есть `createEngine()`. */
export class DefaultingEngineBuilder<P> extends EngineBuilder<P> {
  addNormalizer(n: ScoreNormalizer): this
  addCombiner(c: ScoreCombiner): this
  build(): RecommendationEngine<P>     // resolve() + дефолты в пустые слоты
}

/** Что видит PIPELINE. Иммутабельный результат resolve(). */
export interface ResolvedRegistry {
  readonly schema: FeatureSchema                       // frozen
  readonly profileSchema: FeatureSchema                // frozen, см. Registry
  readonly providers: readonly CandidateProvider[]
  readonly extractors: readonly FeatureExtractor[]     // в топологическом порядке
  readonly strategies: readonly ScoringStrategy[]
  // ... остальные слоты, все readonly
}
```

Уровней стало четыре, и у каждого одна причина существовать:

| Уровень | Ответственность | Мутабельность |
|---|---|---|
| `Plugin` | Знает, ЧТО зарегистрировать | — |
| `EngineBuilder` (= `Registry`) | Собирает и валидирует | **мутабельный** |
| `ResolvedRegistry` + `Pipeline` | Исполняет | **frozen** |
| `Engine` | Публичный фасад, request-scope | frozen |

Цикла «Plugin ↔ Registry» нет: плагин **вызывается** билдером и **пишет** в интерфейс `Registry`. Направление одно. То, что в версии 0.1 читалось как цикл, было следствием того, что я описал один объект двумя именами.

Граница мутабельности проходит ровно по `build()` — и она же решает проблему с `FeatureSchema` (§5.5). Это одна граница, а не две.

### 8.1 Контракт

```ts
export interface Plugin {
  readonly name: PluginName
  readonly version: string
  readonly dependsOn?: readonly PluginName[]
  readonly configSchema?: ConfigSchema
  register(registry: Registry, container: Container): void
  dispose?(): Promise<void>
}
```

### 8.2 Два уровня API

```ts
// Низкоуровневый — полный плагин
engine.use(musicPlugin)

// Высокоуровневый — стратегия/экстрактор напрямую (авто-обёртка в плагин)
engine.use(new GenreStrategy())
engine.use(new FatigueModifier({ threshold: 50 }))
```

`use()` определяет тип через structural check (`'register' in x`), а не через `instanceof` — это позволяет плагинам быть простыми объектными литералами и переживать дублирование пакета в `node_modules`.

### 8.3 Жизненный цикл

```
use(plugin)            → в очередь, никаких сайд-эффектов
   ↓
resolve()              → 0. ЗАПЕЧАТЫВАНИЕ: билдер закрыт для внешней записи сразу,
                            до любой работы (см. ниже, почему в начале, а не в конце)
                         1. дедуп именованных плагинов + топосорт по dependsOn (цикл → ошибка)
                         2. merge configSchema плагинов
                         3. register() каждого плагина в порядке сортировки
                            (плагин пишет через Registry в обе MutableFeatureSchema)
                         4. ВАЛИДАЦИЯ ГРАФА ФИЧЕЙ (см. ниже)
                         5. ВАЛИДАЦИЯ КОНФИГА — после register(), а не до
                         6. вычисление schema.version (FNV-1a)
                         7. ЗАМОРОЗКА: MutableFeatureSchema → FeatureSchema,
                                       EngineBuilder → ResolvedRegistry,
                                       контейнер → sealed
   ↓
build()                → resolve() + дефолты в незанятые слоты (engine/)
   ↓
recommend()            → реестр и схема immutable, гонок нет,
                         матрица всегда соответствует schema.version
   ↓
dispose()              → в обратном порядке
```

**Порядок шагов 2 и 5 изменён в 0.5, и это не перестановка ради красоты.** В 0.4 конфиг валидировался до `register()`. Так нельзя: `weights` проверяются против зарегистрированных стратегий, а до `register()` их не существует. Валидировать в два прохода — сообщить об опциях плагина сейчас, а об опечатке в весе потом — значит вернуть ровно тот опыт «одна ошибка за перезапуск», ради устранения которого резолвер собирает issues списком.

**Запечатывание перенесено в начало (0.5).** Регистрация мутирует схему и слоты по ходу, поэтому прогон, упавший на середине, оставляет билдер полузаполненным. Повторный `resolve()` проиграл бы все записи поверх этих обломков и сообщил бы о **повторе** («две стратегии с id artist»), а не о причине. Неудачный build — это неудачный старт приложения: чинить причину и строить новый билдер. Одноразовость при любом исходе — это и есть смысл шага 0.

Повторный `resolve()` бросает `BuilderSealedError`. Повторный `use()` после него — тоже. Компилятор эту ошибку не поймает (ссылка на билдер могла быть сохранена, а плагин держит её по определению), поэтому рантайм-проверка обязательна как второй рубеж.

**Прямой `add*/set*` на билдере ставится в ту же очередь, что и `use()` (0.5).** `use()` не может регистрировать сразу — топосорту нужны сперва все плагины. Из-за этого было два пути записи с обратным порядком: `.use(defaultRanker).setRanker(mine, { override: true })` падал, сообщая о претендентах задом наперёд. Теперь прямой вызов означает ровно то же, что `use()`, и записи происходят в порядке написания.

### 8.4 Валидация графа фичей — на этапе `build()`

Каждый экстрактор объявляет `provides`, каждая стратегия — `requires`. При `build()` строится граф и проверяется:

- Каждая `requires` кем-то `provides` — иначе `MissingFeatureError` **на старте**, а не `NaN` в проде.
- Нет циклов в `transform`-цепочках.
- Нет коллизий ключей между разными экстракторами (два плагина объявили `popularity` с разной семантикой).
- Порядок transform'ов выводится топологической сортировкой, а не задаётся руками.

Это ровно то, что делает маппинг в Elasticsearch: ошибка схемы ловится при индексации, а не при поиске. Ни у одной известной мне JS-библиотеки рекомендаций этого нет — там `undefined` тихо становится `NaN`, и score всей выдачи схлопывается.

### 8.5 Изоляция

Плагин не имеет доступа к другим плагинам напрямую — только к `Registry` (запись) и `Container` (чтение сервисов по токену). Плагин не может подменить чужую стратегию. Слоты `Single<T>` (combiner, ranker, explainer) — только замена целиком и с явным `override: true`, иначе `SlotConflictError`.

---

## 9. Dependency Injection

Свой контейнер (~150 LOC), без `inversify`/`tsyringe` — они тянут `reflect-metadata` и декораторы, что ломает обещание нуля зависимостей и ESM-чистоту.

```ts
export interface Token<T> { readonly key: symbol; readonly description: string }
export function token<T>(description: string): Token<T>

export const CLOCK   = token<Clock>('Clock')
export const RNG     = token<Rng>('Rng')
export const LOGGER  = token<Logger>('Logger')
export const METRICS = token<Metrics>('Metrics')
export const CACHE   = token<FeatureCache>('FeatureCache')

export interface Container {
  bind<T>(t: Token<T>): { toValue(v: T): void; toFactory(f: (c: Container) => T): void }
  get<T>(t: Token<T>): T
  tryGet<T>(t: Token<T>): T | undefined
  child(): Container       // request-scoped
}
```

Инъекция — **через конструктор**, явно. Никаких декораторов, никакого магического автовайринга:

```ts
class FatigueModifier implements ScoreModifier {
  constructor(private readonly opts: FatigueOptions) {}
  // Clock/Rng приходят в ctx, а не через поля — стратегия остаётся stateless
}
```

Принципиально: **стратегии и экстракторы stateless**. Всё изменчивое — в `RequestContext`. Поэтому один инстанс движка безопасно обслуживает конкурентные запросы, а тестирование стратегии — это вызов чистой функции без моков контейнера.

Скоупы: `singleton` (движок) и `request` (`container.child()` на каждый `recommend()`).

---

## 10. Конфигурация

```ts
export interface EngineConfig {
  readonly weights: Readonly<Record<string, number>>   // ключ = StrategyId
  readonly normalization: { readonly default: NormalizerId; readonly perStrategy?: Record<string, NormalizerId> }
  readonly combiner: { readonly id: string; readonly options?: object }
  readonly exploration: {
    readonly enabled: boolean
    readonly buckets: readonly { readonly id: string; readonly share: number; readonly filter?: string }[]
    readonly epsilon: number
    readonly seed?: string
  }
  readonly novelty:   { readonly enabled: boolean; readonly halfLifeDays: number; readonly saturationThreshold: number }
  readonly fatigue:   { readonly enabled: boolean; readonly threshold: number; readonly decay: 'exponential'|'linear'|'sigmoid'; readonly floor: number; readonly recoveryDays: number }
  readonly diversity: { readonly enabled: boolean; readonly lambda: number; readonly quotas?: Record<string, number> }
  // ВНЕСЕНО в 0.5: описаны в §17.2, но в этот интерфейс не попадали.
  readonly errorPolicy: 'strict' | 'degrade'
  readonly filterErrorBudget: number
  // ИНВАРИАНТ ДВИЖКА, а не рекомендация. Все три поля обязательны — без дефолтов.
  // Отсутствие → ошибка при build(). Автор обязан назвать цифры осознанно.
  // 0.5: и при request.overrides тоже — см. ниже.
  readonly limits: {
    readonly maxCandidates: number    // потолок retrieval; распределяется по провайдерам как budget
    readonly maxLimit: number         // потолок request.limit; limit > maxLimit → ошибка запроса
    readonly timeoutMs: number        // → AbortSignal.timeout, см. §17.1
  }
  readonly plugins:   Readonly<Record<string, unknown>>   // namespace на плагин
}
```

**`combiner.id` резолвится через реестр встроенных комбайнеров (0.5).** Документ объявлял ключ, но не говорил, как он превращается в объект, — и в реализации он не превращался никак: пайплайн брал комбайнер из слота и в конфиг не заглядывал. Любой движок складывал взвешенной суммой, что бы ему ни сказали. Приоритет: слот (`setCombiner`) > `config.combiner.id` > дефолт `weighted-sum`; слот выигрывает, потому что это более конкретное утверждение — `use()` передаёт объект, а `id` называет один из наших. Опечатка в `id` отвергается в любом случае, иначе ключ снова значил бы ничего.

**`request.overrides` валидируется тем же кодом, что и `configure()` (0.5).** Иначе инвариант из §23.3 — рекомендательный для всякого, кто может написать `overrides`: запрос поднимал себе `maxCandidates` до миллиарда и отдавал это retrieval как бюджет базы, а `timeoutMs: -1` возвращался сырым `RangeError` из `AbortSignal.timeout` — мимо §17, без кода. Потолок, который снимает тот, кого он ограничивает, — не потолок.

### Разрешение конфига (приоритет сверху вниз)

```
1. request.overrides         — этот вызов
2. WeightProvider            — A/B, персонализация, обученные веса
3. user profile config       — настройки пользователя
4. engine config             — при build()
5. plugin defaults           — из configSchema
6. core defaults
```

`WeightProvider` как порт — это точка, куда позже подключается онлайн-обучение весов (бандит), **не меняя ядро**. Библиотека остаётся не-AI; но она не закрывает дверь тому, кто захочет учить веса снаружи. Это принципиальная разница между «алгоритмической» и «примитивной».

### Пример

```ts
weights: {
  history: 1.0,
  artist: 0.9,
  genre: 0.6,
  playlist: 0.5,
  popularity: 0.3,
  recency: 0.4,
  novelty: 0.2,
  discovery: 0.15,
}
```

Все веса — в одной шкале и сравнимы **только потому, что колонки нормализованы** (§12). Это делает конфиг понятным человеку: `artist: 0.9` против `popularity: 0.3` читается как «исполнитель в три раза важнее популярности», и это правда.

---

## 11. Scoring System

### 11.1 Главное решение: стратегия не видит `Item.payload`

```ts
score(view: ScoringView): ScoreColumn
// ScoringView = { items: FeatureMatrix, profile: ProfileVector, ctx: RequestContext }
```

Стратегия получает **числа**, а не `Item[]`. Это выглядит ограничением, а является фундаментом:

1. **Доменная независимость реальна, а не декларативна.** `AffinityStrategy` не может залезть в `item.payload.artist` — компилятор не даст. Значит, она работает и для музыки, и для товаров.
2. **Стратегия тестируется без домена**: подал `Float64Array`, проверил `Float64Array`. Ни моков, ни фикстур треков.
3. **Переиспользование.** «Любимый исполнитель» и «любимый бренд» — **одна** стратегия `AffinityStrategy` на фиче `affinity_score`. Разница только в том, какой экстрактор её посчитал. Без этого разделения мы бы писали `ArtistStrategy`, `BrandStrategy`, `AuthorStrategy`, `DirectorStrategy` — четыре копии одного кода.
4. **Производительность.** Векторные операции над непрерывной памятью.
5. **Кэшируемость.** Фичи кэшируются по `itemId`; скоринг — чистая функция от матрицы.

Доменное знание сосредоточено **в одном слое** — экстракторах. Хотите рекомендовать фильмы? Пишете `DirectorAffinityExtractor` — стратегии, нормализаторы, комбайнер, ранкер, диверсификатор, объяснялка переиспользуются целиком.

Именно это отделение (домен → фичи, математика → стратегии) — то, что превращает библиотеку из «движка для музыки, который можно приспособить» в «Elasticsearch для рекомендаций».

### 11.1.1 Ревизия: а как же graph / session / sequence / PPR / ANN?

Возражение из ревизии: «ограничение великолепно, пока стратегии линейные; графовым и сессионным моделям нужен доступ к самому графу». Разберу по частям, потому что случаи разные, и часть из них — не контрпримеры.

**ANN reranking — не контрпример.** ANN — это стадия 1 (retrieval), а не 5 (scoring). Провайдер делает поиск по вектору, дистанция возвращается в `Candidate.retrievalScore` и становится фичей. Стратегия потребляет число.

**Personalized PageRank — не контрпример, а хорошая иллюстрация.** PPR обходит граф и выдаёт **одно число на кандидата**. Обход графа — это `FeatureExtractor` (он знает граф, это его домен), выход — фича `ppr_score`, потребитель — обычная `AffinityStrategy`. Ровно то разделение, ради которого всё затевалось.

**Session / sequence — здесь возражение попало в цель.** Проблема не в том, что стратегия не видит граф. Проблема в асимметрии, которую я не заметил в 0.1: **стратегия видела фичи кандидатов, но не видела историю в векторном виде**. Sequence-модели нужно сравнить кандидата с эмбеддингом сессии — а эмбеддинга сессии в матрице кандидатов нет и быть не может, там строки — кандидаты.

Пробел настоящий. Но лечится он не выдачей стратегии доменного объекта, а **восстановлением симметрии**:

```ts
// UserFeatureExtractor (домен: знает, как свернуть сессию в вектор)
provides: [{ key: 'session_emb', kind: 'embedding', arity: 128, ... }]

// SessionStrategy (математика: не знает, что такое сессия)
score(view: ScoringView): ScoreColumn {
  const session = view.profile.vector(SESSION_EMB)      // 128 чисел
  const out = new Float64Array(view.items.rows)
  for (let i = 0; i < out.length; i++) {
    out[i] = cosine(view.items.vector(ITEM_EMB, i), session)
  }
  return { strategyId: this.id, raw: out, reasons: ... }
}
```

Sequence-модель написана. Домена в ней нет. `ProfileVector`, `UserFeatureExtractor` и векторные фичи (`arity`) добавлены в 0.2 именно из-за этого замечания — это его прямое следствие.

Замечу отдельно: `ctx` **был** в сигнатуре с самого начала, а в `ctx` есть `HistoryIndex`. Стратегия никогда не была заперта в `Float64Array` — она всегда могла читать сырую историю. Отсутствовал именно векторный доступ к профилю.

**Что делать с остатком — escape hatch.** Инстинкт «когда-нибудь понадобится сырой доступ» правильный, и запрещать его — самообман: автор всё равно обойдёт ограничение, просто уродливо (протащит домен через `signals` или замыкание). Поэтому лазейка есть, но она **явная и типизированная**:

```ts
export interface DomainScoringStrategy<P> {
  readonly domain: true
  score(view: ScoringView, set: CandidateSet<P>): ScoreColumn
}
```

Почему это не разрушает архитектуру:

- **Цена видна в типе.** `DomainScoringStrategy<Track>` невозможно зарегистрировать в `createEngine<Movie>()` — компилятор откажет. Автор сразу видит, что теряет переносимость. Не запрет, а ценник.
- **Она отслеживаема.** Маркер `domain: true` попадает в `engine.inspect()` и в документацию. «Сколько у нас доменных стратегий» — вопрос с машинным ответом; рост этого числа виден в ревью.
- **Дефолт остаётся правильным.** Обычная `ScoringStrategy` короче и переносима. Лазейкой пользуются, когда действительно нужно, а не по умолчанию.

Это `unsafe` из Rust: не «нельзя», а «назови это вслух».

### 11.2 Формула

```
Этап 5:  rawᵢⱼ            = strategyⱼ.score(view)[i]        view = {items, profile, ctx}
Этап 6:  normᵢⱼ           = normalizerⱼ(raw·ⱼ)[i]                    ∈ [0,1]
Этап 7:  baseᵢ            = Σⱼ (weightⱼ × normᵢⱼ) / Σⱼ weightⱼ        ∈ [0,1]
Этап 8:  finalᵢ           = clamp(baseᵢ × Πₘ multₘ(i) + Σₖ addₖ(i), 0, 1)
Этап 13: presentedᵢ       = round(finalᵢ × 100)
```

Веса нормируются на сумму — иначе добавление девятой стратегии тихо меняет масштаб всех score, и настроенные пороги (`score > 80 → push`) ломаются.

### 11.3 Стандартные стратегии (`@recoengine/strategies`)

Все доменно-нейтральны.

| Стратегия | Требует фичи | Что делает |
|---|---|---|
| `HistoryStrategy` | `interaction_count`, `interaction_recency` | Прямое взаимодействие с объектом |
| `AffinityStrategy` | `affinity_*` (параметризуется) | Близость к предпочтениям по любому измерению — **закрывает artist/genre/brand/author** |
| `PopularityStrategy` | `popularity_global`, `popularity_cohort` | Популярность, глобальная и в когорте |
| `RecencyStrategy` | `item_age` | Свежесть объекта |
| `SimilarityStrategy` | `sim_to_recent`, `sim_to_profile` | Похожесть на профиль/последние действия |
| `CoOccurrenceStrategy` | `cooc_score` | «Кто взял X, брал и Y» — item-to-item CF |
| `NoveltyStrategy` | `profile_saturation`, `item_familiarity` | Бонус новому при насыщении профиля |
| `DiscoveryStrategy` | `distance_from_profile` | Контролируемый выход за пределы вкуса |
| `ContextStrategy` | `context_match` | Соответствие сигналам (время суток и т.п.) |

Обратите внимание: `ArtistStrategy`, `GenreStrategy`, `PlaylistStrategy` из исходного ТЗ **исчезли** — они схлопнулись в `AffinityStrategy` с разными экстракторами. Это не потеря функциональности, это устранение тройного дублирования. Музыкальный пример регистрирует:

```ts
engine
  .use(new ArtistAffinityExtractor())     // домен: payload.artistId → affinity_artist
  .use(new GenreAffinityExtractor())      // домен: payload.genres  → affinity_genre
  .use(new PlaylistAffinityExtractor())   // домен: payload.playlists → affinity_playlist
  .use(affinityStrategy({ id: 'artist',   feature: 'affinity_artist'   }))
  .use(affinityStrategy({ id: 'genre',    feature: 'affinity_genre'    }))
  .use(affinityStrategy({ id: 'playlist', feature: 'affinity_playlist' }))
```

Три строки конфига вместо трёх классов.

**Реализованы как фабрики-функции, а не классы (внесено при Этапе 5).** Каждая стратегия — `affinityStrategy(...)`, `popularityStrategy(...)` и т.д., возвращающая `ScoringStrategy`. Это согласовано с функциональным экспортом ядра (`weightedSum`, `sortRanker`) и со структурной диспетчеризацией плагинов, которая узнаёт стратегию по методу `score`, а не по `instanceof` (§8.5, `plugin.ts` прямо предостерегает от `instanceof`). Документ до 0.5 писал `new AffinityStrategy(...)`; правится документ, а не код (§23.-2). Конфигурируемые поля — `id` (он же ключ веса), фичи и `normalizer`; двум стратегиям одного вида нужны разные `id`, иначе они дерутся за один вес, и `addStrategy` это ловит.

**Нормализаторы по умолчанию — по шкале стратегии (§12).** `historyStrategy` → `rank` (тяжёлый хвост счётчиков); `popularityStrategy` блендит **перцентили** глобальной и когортной колонок (у них разные шкалы, сырой блендинг раздавил бы меньшую) и потому нормируется `identity`; `affinity`/`similarity`/`recency`/`novelty`/`context`/`discovery`(с `target`) уже дают [0..1] → `identity`; `cooccurrence` и `discovery`(без `target`) → `minmax`. `noveltyStrategy` — единственная из девяти, кто использует `requiresProfile` (`profile_saturation` из `ProfileVector`): без `UserFeatureExtractor`, дающего эту фичу, `build()` отклонит движок. `applicable`-гейт на историю несут `history`/`affinity`/`similarity`/`cooccurrence`/`discovery` (нет истории — колонка отброшена, вес перетёк, §17.3); `context` гейтит на `ctx.signals`; `popularity` и `recency` гейта не несут — они и есть cold-start-фолбэк.

### 11.3.1 Кто поставляет фичи (`@recoengine/features`, Этап 8а)

Стратегии читают фичи с фиксированными именами; кто-то должен их произвести. Часть входов **доменно-нейтральна** — считается из истории взаимодействий, а не из `Item.payload`, — и такие производители живут в `@recoengine/features`, а не в доменном экстракторе хоста:

- `interactionCountExtractor` → `interaction_count` = `ctx.history.countFor(item.id, eventType?)`;
- `interactionRecencyExtractor` → `interaction_recency` = `exponentialDecay((now − lastAt)/timeScale, halfLife)`, непрослушанное → 0.

Оба — ровно то, что по умолчанию требует `historyStrategy`: хост получает repeat-interaction-скоринг, не написав ни строки доменного кода. Ключ — они читают `ctx.history` и `ctx.now`, но **никогда** payload: счёт событий по `ItemId` (тип ядра) одинаков для треков и товаров.

Плюс два **трансформа** (стадия 4a, чистая математика над колонками, доменно-нейтральны by construction): `logTransform` (`log1p(x)/log1p(max)` — компрессия тяжёлого хвоста, §12 как трансформ, а не как приватный выбор стратегии) и `decayTransform` (кривая затухания над колонкой возрастов — общая форма того, что `recencyStrategy` делает внутри, вынесенная в переиспользуемую фичу).

Фичи, которым **нужен** payload — собственный возраст объекта, категория, предрассчитанный co-occurrence, — остаются в доменных экстракторах хоста: только хост знает, где в payload они лежат. `@recoengine/features` — это та часть, которой payload не нужен.

**Уточнение kit (Этап 8а).** `assertScoringStrategy` по умолчанию сам добавляет `payloadExtractor` для требуемых фич; когда фичи поставляет настоящий экстрактор/трансформ (как здесь), это коллизия объявлений. Добавлен флаг `featuresFromPlugins: true` — пропустить авто-payloadExtractor, фичи даёт `extraPlugins`.

---

## 12. Normalization

Отдельная стадия, потому что без неё **веса — ложь**.

`PopularityStrategy` вернёт `4_200_000`. `RecencyStrategy` — `0.87`. Взвешенная сумма с `popularityWeight: 0.3` и `recencyWeight: 0.4` даст `1_260_000.348` — recency не влияет вообще. Это самая частая и самая незаметная ошибка в самодельных движках: конфиг выглядит осмысленно, а работает одна стратегия из восьми.

| Нормализатор | Формула | Когда |
|---|---|---|
| `MinMaxNormalizer` | `(x − min) / (max − min)` | Дефолт. Выбросы ломают шкалу |
| `ZScoreNormalizer` | `σ((x − μ) / σ)` | Нормальное распределение |
| `RankNormalizer` | `1 − rank / n` | **Тяжёлые хвосты — популярность, просмотры.** Устойчив к выбросам |
| `LogNormalizer` | `log1p(x) / log1p(max)` | Экспоненциальные величины |
| `SigmoidNormalizer` | `1 / (1 + e^(−k(x−x₀)))` | Мягкое насыщение вокруг порога |
| `IdentityNormalizer` | `clamp(x, 0, 1)` | Стратегия уже вернула [0..1] |

Стратегия объявляет свой нормализатор по умолчанию (`readonly normalizer?`) — она лучше всех знает свою шкалу. Конфиг может переопределить.

Вырожденные случаи: если `max === min` (все кандидаты одинаковы), `MinMax` даёт `0/0`. Контракт: возвращать `0.5` для всех и писать warning в диагностику. Молчаливый `NaN` здесь — катастрофа, он отравляет всю сумму.

---

## 13. Ranking

```ts
rank(board, set, ctx): readonly number[]
```

- **Top-K через min-heap**, а не `sort()`: `O(n log k)` вместо `O(n log n)`. При 100k кандидатов и `limit: 20` — разница в 15 раз.
- **Детерминированный tie-break — по индексу строки (порядку retrieval), не по `ItemId` (сверено с кодом, 0.5).** Документ до этой ревизии обещал `ItemId`; и `sortRanker`, и `topK`-куча (`heap.ts`, `tieBreak = row => row`) на деле разрывают равенство порядком кандидата. Это законно, потому что сам порядок retrieval детерминирован: провайдеры выполняются в порядке регистрации, дедуп в `CandidateSetBuilder` оставляет первое вхождение. Исходная тревога §13 («порядок из `Map` не гарантирован») снята не сортировкой по `ItemId`, а тем, что набор кандидатов — массив, а не `Map`; индекс дешевле строкового сравнения и так же стабилен. Единственное следствие: равные по score объекты держатся в порядке извлечения, а не лексикографически, — рассеиванием кластеров ведает диверсификация (§14), не ранкер.
- Реализации в коде: `sortRanker` — **дефолт**, «ранжируем всё» (`limit` — не его решение, §13.1); `topKRanker(pool)` — фабрика, ограничивающая пул. `ThresholdRanker` (`score > x`) и `StratifiedRanker` (top-K внутри страт) в §ТЗ намечены, но **не написаны** — появятся, когда понадобятся.

---

## 14. Diversification

Проблема: чистое ранжирование даёт 20 треков одного исполнителя. Формально идеально, практически ужасно.

### MMR (Maximal Marginal Relevance) — дефолт

```
MMR(i) = λ × score(i) − (1 − λ) × max sim(i, j)
                                   j ∈ selected
```

`λ = 1` → чистая релевантность. `λ = 0` → максимальное разнообразие. Дефолт `0.7`.

Жадный, `O(k × n)` — приемлемо, так как применяется к top-N (N ≈ 200), а не ко всем кандидатам.

### AttributeQuotaDiversifier

«Не более 3 треков одного исполнителя», «не более 40% одного жанра». Работает через **категориальную фичу** (`kind: 'categorical'` — хеш `artistId`): группировка = равенство значений в колонке. Измерение задаётся конфигом (`quotas: { affinity_artist_group: 3 }`), доменное знание остаётся в экстракторе. В версии 0.1 здесь был `AttributeStore` — удалён как второй доменный канал (§5.5).

### SimilarityProvider

MMR нужна метрика близости. Порт:
- `CosineSimilarity` — по подпространству фичей (конфигурируемый список ключей).
- `JaccardSimilarity` — по множествам (жанры, теги). Множество нельзя уложить в одно число, поэтому его держит сам провайдер — он доменный по определению, и это законно.
- Доменная — плагином (например, аудио-эмбеддинги).

Порт нужен именно потому, что «похожесть» — единственное место, где диверсификации требуется доменное знание. Изолируем его в один порт вместо протечки в весь слой.

### 14.1 Как это легло в код (`@recoengine/diversity`, Этап 7)

Четыре фабрики: `mmrDiversifier`, `attributeQuotaDiversifier`, `cosineSimilarity`/`jaccardSimilarity` (провайдеры близости), `bucketBlender` (стадия 11). Реализация закрыла два долга §5 и потребовала одной правки ядра.

**Правка ядра: `Diversifier.diversify` теперь получает `FeatureMatrix`.** Порт `SimilarityProvider.similarity(a, b, set, matrix)` спроектирован под матрицу, но стадия 10 её не передавала — `diversify(ranked, set, board, ctx)` физически не давал MMR посчитать близость по фичам. Это был незамеченный пробел: порт готов, а канал к нему оборван. Добавлен пятый параметр `matrix` (она уже в области видимости пайплайна на этой стадии). Тест-даблы `diversify: () => []` не сломались — лишний аргумент просто игнорируется. `AttributeQuotaDiversifier` тоже читает матрицу: группировка — равенство значений в **категориальной** колонке (§14), домен хеширует `artistId` в число, диверсификатор сравнивает `===`.

**Долг §5: `SimilarityProvider` без слота в `Registry` — решён передачей в опции MMR.** В §5 было записано «решено передавать его в опциях MMR» — так и сделано: `mmrDiversifier({ similarity: cosineSimilarity({ features: [...] }) })`. Слот в реестре не заводился: близость нужна ровно одному потребителю (диверсификатору), и глобальный слot «many» (§19) означал бы разрешение регистрировать метрики, которые никто не спросит. Провайдер — обычный объект, переданный в фабрику; ядро о нём не знает, и это правильно.

**Долг §5: дефолтного блендера нет — теперь есть `bucketBlender`.** §18 включал exploration, а исполнять квоты было некому (движок предупреждал `quota_unfilled`). `bucketBlender` раскладывает ранжированный список по бакетам (предикат читает `board`/`ctx` — матрицы у блендера нет, §11) и набирает выдачу по долям через largest-remainder округление; недобор бакета отдаётся соседям и пишет `quota_unfilled`. Детерминизм — из `ctx.rng` (сеется, §15), не `Math.random()`; тай-брейк долей — тоже через rng, чтобы прогон не всегда favorил первый бакет.

**MMR(λ=1)≡ranking закреплён и коротким замыканием, и тестом (§22).** При `λ ≥ 1` фабрика возвращает вход байт-в-байт, не полагаясь на точное округление арифметики; golden-тест сверяет это против настоящего пайплайна. `window` (дефолт 200) ограничивает `O(k²)`-переупорядочивание верхушкой — разнообразие за пределами видимой страницы ничего не покупает; хвост держит порядок ранжирования. Внутри окна `throwIfAborted()` на каждом шаге (§17.1).

---

## 15. Novelty, Fatigue, Discovery — почему они разные

Исходное ТЗ ставит их в один ряд. На самом деле это три разных механизма на трёх разных уровнях, и смешение — источник багов.

### Fatigue — модификатор (стадия 8), мультипликативный

«Трек прослушан 300 раз → score падает».

```
fatigue(i) = floor + (1 − floor) × exp(−max(0, count(i) − threshold) / τ)
```

**Мультипликативный, а не аддитивный.** Аддитивный штраф (`score − 0.3`) не спасает трек с базовым score 0.98 — он всё равно первый. Умножение на `0.1` убирает его из выдачи, сохраняя порядок среди остальных.

**Восстановление**: усталость затухает со временем с момента последнего контакта — `recoveryDays`. Иначе трек, залюбленный год назад, забанен навсегда.

```
effectiveCount(i) = count(i) × exp(−daysSince(lastSeen(i)) / recoveryDays)
```

### Novelty — модификатор (стадия 8), зависит от состояния профиля

«Пользователь долго слушает одно и то же → подмешиваем новое».

Ключ — **фича насыщения профиля**, а не свойство объекта:

```
saturation = 1 − entropy(profileDistribution) / log(uniqueCount)   ∈ [0,1]
noveltyBoost(i) = 1 + saturation × noveltyWeight × unfamiliarity(i)
```

Насыщенный профиль (энтропия низкая, слушает трёх исполнителей) → сила буста растёт **автоматически**. Разнообразный профиль → буст ≈ 0, он не нужен. Система саморегулируется, не требуя ручного тюнинга под каждого пользователя.

### Discovery — blender (стадия 11), квоты слотов

«70% любимое / 20% похожее / 10% новинки».

Это **не score**. Это распределение слотов в финальной выдаче. Пытаться выразить квоту через веса невозможно: вес влияет на порядок, но не гарантирует, что в top-10 попадёт ровно 1 новинка.

```ts
exploration: {
  buckets: [
    { id: 'exploit',   share: 0.7, filter: 'familiar'   },
    { id: 'explore',   share: 0.2, filter: 'adjacent'   },
    { id: 'discover',  share: 0.1, filter: 'novel'      },
  ],
  epsilon: 0.1,
  seed: 'user-42-2026-07-14',   // детерминированный на пользователя/день
}
```

Реализация: `BucketBlender` раскладывает ранжированный список по бакетам (предикат из фичей), затем набирает выдачу по квотам. Недобор бакета — добираем из соседнего, warning в диагностику.

`seed` из userId + даты: выдача **стабильна в течение дня** (пользователь не видит перетасовку при рефреше) и **воспроизводима в тестах**. `Math.random()` не дал бы ни того, ни другого.

### 15.1 Как это легло в код (`@recoengine/modifiers`, Этап 6)

Три модификатора — `fatigueModifier`, `noveltyModifier`, `boostModifier`, — каждый фабрика, возвращающая `ScoreModifier` (как и стратегии). Реализация уточнила три вещи, которые документ до 0.5 описывал неточно:

**Модификатор не видит ни фичи, ни профиль — только `CandidateSet` и `RequestContext`.** Порт `ScoreModifier.apply(board, set, ctx)` (§16) не передаёт `FeatureMatrix`/`ProfileVector`. Поэтому «фича насыщения профиля» из формулы novelty **вычисляется из истории на месте**, а не читается из профиля: `saturationOf` берёт распределение событий по `ItemId` и возвращает `1 − H/ln(unique)` — доменно-нейтральную «неравномерность» вкуса, ту же величину, что описывал §15, но без доменной группировки и без экстрактора. `unfamiliarity(i)` — из `history.countFor(i)`, не из `item_familiarity`. Это не обеднение: модификатор по определению работает поверх готового score, и данные истории у него есть, а фич — нет, и это правильно (иначе он дублировал бы стадию скоринга).

**Кривые — через `math/decay.ts` (база 2, человеко-читаемый half-life), а не «сырой» `exp`.** §15 писал `exp(−…/τ)`; код использует `exponentialDecay` (`2^(−age/halfLife)`), потому что параметр тогда — утверждение, с которым можно спорить («усталость слабеет вдвое за 30 дней»), а не константа `λ`. Восстановление — тем же затуханием эффективного счётчика по времени с последнего контакта (`effectiveCount = count × 2^(−daysSince/recoveryHalfLife)`), а не отдельной `recovery()`; `recovery()` в `decay.ts` остаётся для тех, кому нужна линейная форма.

**Novelty живёт в двух местах, и это намеренно.** `noveltyStrategy` (§11.3, Этап 5) даёт **аддитивную колонку**, за которую конкурируют веса; `noveltyModifier` (здесь) **мультипликативно** переписывает готовый score (`1 + saturation·weight·unfamiliarity`). Один замысел, разный порядок свёртки — выбор по тому, должна ли новизна бороться за вес или переформировать результат. Fatigue и novelty — мультипликативные, boost — аддитивный (`kind` объявляет это, а фолд `ScoreBoardBuilder` (§11.2) складывает по-разному). `boostModifier` — не фильтр: оштрафованный объект остаётся в выдаче ниже, удаление — дело `PreFilter`/`PostFilter`.

---

## 16. Explainability

### Механика

`ScoreBoard` накапливает `ScoreContribution[]` **по ходу пайплайна** — нельзя посчитать score, не оставив след. `Explainer` на стадии 13 только переводит след в `Explanation`, сортируя по `contribution` и отсекая шум (`minContribution`, `maxReasons`).

Три уровня (`ctx.explain`) — объяснение не бесплатно:
- `'none'` — только score. Продакшен-хот-путь.
- `'reasons'` — топ-N причин. Дефолт для UI.
- `'full'` — весь trace, все фичи, все стадии. Отладка и `/explain` эндпоинт.

### Результат

```ts
{
  item: { id: 'track:123', type: 'track', payload: { title: 'Come Together' } },
  rank: 1,
  score: 95,
  explanation: {
    score: 95,
    baseScore: 89,
    // Отсортированы по contribution. strength = normalized: «насколько сильна сама
    // причина», отдельно от того, сколько она дала в итог при своём весе.
    reasons: [
      { code: 'favorite_artist',   polarity: 'positive', strength: 0.98, params: { artist: 'The Beatles', plays: 143 } },
      { code: 'listened_before',   polarity: 'positive', strength: 0.86, params: { plays: 12 } },
      { code: 'favorite_genre',    polarity: 'positive', strength: 0.85, params: { genre: 'Rock' } },
      { code: 'popular_in_cohort', polarity: 'positive', strength: 0.80, params: { percentile: 92 } },
    ],
    contributions: [
      { strategyId: 'artist',     kind: 'additive', raw: 143,   normalized: 0.98, weight: 0.9, contribution: 0.315, reasons: [...] },
      { strategyId: 'history',    kind: 'additive', raw: 12,    normalized: 0.86, weight: 1.0, contribution: 0.307, reasons: [...] },
      { strategyId: 'genre',      kind: 'additive', raw: 0.85,  normalized: 0.85, weight: 0.6, contribution: 0.182, reasons: [...] },
      { strategyId: 'popularity', kind: 'additive', raw: 4.2e6, normalized: 0.80, weight: 0.3, contribution: 0.086, reasons: [...] },
      { strategyId: 'novelty',    kind: 'multiplicative', raw: 1.07, normalized: 1.07, weight: 1, contribution: 1.07, reasons: [] },
    ],
  }
}
```

Числа здесь сходятся, и это не педантизм — §21 требует golden-тест «Σ contributions = baseScore». Пример в документе обязан этот тест проходить, иначе он учит неправильному:

```
Σ weights            = 0.9 + 1.0 + 0.6 + 0.3            = 2.8
Σ (weight × norm)    = 0.882 + 0.86 + 0.51 + 0.24       = 2.492
baseScore            = 2.492 / 2.8 = 0.89               → 89
final                = 0.89 × 1.07 (novelty)  = 0.9523  → 95
Σ contributions      = 0.315 + 0.307 + 0.182 + 0.086    = 0.89  ✓
```

Обратите внимание на `popularity`: сырое значение 4 200 000, нормализованное 0.80, а вклад — всего 0.086 из 0.89. Ровно то, ради чего существует §12: без нормализации это число раздавило бы все остальные.

Рендер (вне ядра, `@recoengine/explain-ru`):

```
95  Come Together — The Beatles
    ✓ Любимый исполнитель (The Beatles, 143 прослушивания)
    ✓ Любимый жанр (Rock)
    ✓ Похоже на последние прослушивания
    ✓ Популярен среди похожих пользователей
```

### `engine.explain(itemId, request)`

Отдельный метод: «почему этого трека **нет** в выдаче?». Прогоняет пайплайн для одного объекта в режиме `full` и показывает, где он потерялся — отфильтрован на стадии 2, задавлен fatigue на стадии 8, вытеснен MMR на стадии 10. Прямой аналог `_explain` в Elasticsearch. Это то, что превращает движок из чёрного ящика в инструмент.

### 16.1 Как это легло в код (Этап 8)

Три долга §5 закрыты — все в ядре, нового пакета нет.

**Презентационная шкала округляется.** `toPresentation = Math.round(score × 100)` в одном месте (`stages/explanation.ts`), так что `score` и `baseScore` округляются одинаково и не спорят. До этого отдавалось `96.55172413793103` — не число, которое читает человек, и не порог, с которым сравнивает правило `score > 80`. golden-тесты Этапов 5–7 округляли в ассертах вручную; теперь это лишнее.

**`ScoreTrace` заполняется при `explain: 'full'` — и это делает пайплайн, а не explainer.** Порт `Explainer` намеренно не получает ни `FeatureMatrix`, ни схему (он владеет политикой причин, а не данными), поэтому трейс собирается в стадии 13, где матрица в области видимости, и прикрепляется поверх любого explainer'а — дефолтного или пользовательского. Содержимое — не новый источник правды, а фолд §11.2, разложенный по строкам: `base`, затем каждый мультипликативный/boost-вклад отдельной строкой, `final`; плюс все скалярные фичи строки и версия схемы (по ней видно, что трейс устарел).

**`engine.explain(itemId, request)` реализован через probe.** Пайплайн получил опциональный out-параметр `PipelineProbe`: при `recommend()` он `undefined` и не стоит ничего, при `explain()` — собирает выживших на каждой стадии. Метод прогоняет тот же пайплайн (форсируя `full`) и по probe восстанавливает судьбу объекта: `not_retrieved` → `filtered` (стадия 2 или 4b) → `diversified_out`/`blended_out` → `truncated` → `recommended`. Возвращается на первой стадии, где объект пропал, так что `lostAt` — самое раннее объяснение, а не поздний симптом. Дойдя до скоринга, объект несёт полный `Explanation` — поэтому «задавлен fatigue» (score 0, но на странице) отличимо от «вытеснен» (высокий score, ниже среза) и от «срезан квотой» (высокий score, выкинут диверсификатором). Один пайплайн, две точки входа — `recommend` и `explain` не расходятся, потому что общий код один.

**Σ contributions = baseScore — golden и контракт.** §16 приводит числовой пример (89 = 0.315+0.307+0.182+0.086); он закреплён тестом в ядре, а `@recoengine/testing` получил переиспользуемый `assertExplanationSums` — сворачивает аддитивные вклады и сверяет с `baseScore`. Это гигиена того же рода, что детерминизм: объяснение не должно расходиться с числом, которое объясняет.

---

## 17. Отказоустойчивость: cancellation, error policy, applicability

Раздел добавлен в 0.2 — в 0.1 это были три дыры: `AbortSignal` лежал в контексте, но контракт его проверки нигде не описан; поведение при падении экстрактора не определено вовсе.

### 17.1 Cancellation — контракт

`ctx.signal` **не опционален**. Движок всегда создаёт сигнал, даже если вызывающий его не передал:

```ts
ctx.signal = AbortSignal.any([
  request.signal ?? neverAbort,
  AbortSignal.timeout(config.limits.timeoutMs),
])
```

Контракт для авторов портов — три правила:

1. **Ядро проверяет сигнал на всех 16 границах стадий.** Бесплатно, гарантированно. Порт, который не сделал ничего, всё равно не задержит отмену дольше, чем на одну стадию. Это бесплатная гарантия для каждого автора, который контракт не читал, — а такие будут.
2. **Порт с I/O ОБЯЗАН пробрасывать `ctx.signal` вниз** — в `fetch`, в драйвер БД, в HTTP-клиент. `CandidateProvider` и `FeatureExtractor` — единственные места с сетью; без проброса отмена не освободит соединение, и таймаут запроса не спасёт от исчерпания пула.
3. **Порт с длинным CPU-циклом обязан проверять `ctx.signal.throwIfAborted()` каждые N итераций** (рекомендация: N = 1024). Касается обхода графа в PPR-экстракторе и MMR на больших выборках. Однопоточный JS не прервёшь снаружи — кооперативность обязательна.

Отмена — это `AbortError`, она **не** превращается в degrade-политику и не пишется в `warnings`: отменённый запрос не должен вернуть половинчатую выдачу, выглядящую как настоящая. Она пробрасывается наружу.

Проверка правила 3 — в contract-тестах порта (§20): тест подаёт уже прерванный сигнал и требует `AbortError` за отведённое время.

### 17.2 Error policy — матрица

Главный принцип: **тихая деградация запрещена**. Упавший экстрактор, чьи фичи молча стали нулями, — это ровно та «незаметная катастрофа», против которой написан §12 про нормализацию: score всей выдачи поедет, а всё выглядит рабочим.

Поэтому дефолт — `criticality: 'required'`, то есть **падаем громко**. Деградация возможна, но она — осознанный выбор автора порта (`criticality: 'optional'`) плюс осознанный выбор эксплуатации (`errorPolicy`).

```ts
errorPolicy: 'strict' | 'degrade'   // dev/CI: strict. prod: обычно degrade
```

| Что упало | `strict` | `degrade` |
|---|---|---|
| `CandidateProvider`, `required` (дефолт) | ошибка запроса | ошибка запроса — **уточнено в 0.5** |
| `CandidateProvider`, `optional` | ошибка запроса | продолжаем на оставшихся + warning |
| `CandidateProvider`, все | ошибка запроса | ошибка запроса (рекомендовать не из чего) |
| `PreFilter` / `PostFilter`, единичный отказ | **кандидат удалён** | **кандидат удалён** — см. ниже |
| `PreFilter` / `PostFilter`, отказов > `filterErrorBudget` | ошибка запроса | ошибка запроса |
| `FeatureExtractor`, `required` | ошибка запроса | ошибка запроса |
| `FeatureExtractor`, `optional` | ошибка запроса | фичи ← `descriptor.defaultValue` + warning |
| `UserFeatureExtractor`, `optional` | ошибка запроса | фича помечена недоступной + warning; стратегии с `requiresProfile` отключаются |
| `FeatureTransform` | ошибка запроса | ошибка запроса (цепочка фичей нарушена) |
| `ScoreNormalizer` | ошибка запроса | ошибка запроса — **внесено в 0.5** |
| `ScoringStrategy` | ошибка запроса | колонка отброшена, вес перераспределён + warning |
| `ScoreModifier` | ошибка запроса | вклада нет (нейтраль) + warning; **всё или ничего, 0.5** |
| `Diversifier` / `Blender` | ошибка запроса | пропускаем, отдаём чистое ранжирование + warning |
| `Explainer` | ошибка запроса | пустое объяснение + warning, score сохраняется |
| `Ranker`, `ScoreCombiner` | ошибка запроса | ошибка запроса (незаменимы) |

**Провайдер уважает `criticality` (0.5).** В 0.4 строка гласила «degrade: продолжаем на оставшихся» безусловно — но `CandidateProvider extends Criticality`, а дефолт `criticality` — `required`. То есть при буквальном чтении поле на этом порту было декорацией: его значение ни на что не влияло. Источник, который единственный держит лицензированные треки, — это не «меньше кандидатов», когда он умирает. Чтобы получить поведение прежней строки, провайдер помечается `optional` — явно.

**Нормализатор не деградируем (0.5).** Строки не было вовсе. Подстановка сырой колонки вместо нормализованной положила бы 4 200 000 в сумму чисел из [0..1] и похоронила бы все остальные стратегии: «деградация», которая молча переписывает ранжирование, хуже упавшего запроса. Нормализатор, вернувший NaN, значение вне [0..1] или колонку другой длины, отвергается там же — один NaN в сумме делает все сравнения с ним ложными, и ранжирование схлопывается в порядок вставки, притом каждый score выглядит числом.

**Модификатор — всё или ничего (0.5).** Он пишет в буфер, который коммитится, только если он дошёл до конца. Иначе модификатор, утомивший 50 кандидатов из 5000 и упавший на 51-м, оставил бы половину выдачи приглушённой, а половину нет — молча, под политикой с названием «degrade». Это ровно та тихая деградация, против которой написан весь раздел.

**Профильная фича не подставляется дефолтом (0.5).** Строка §17.2 говорила «то же», то есть `фичи ← defaultValue`. Но центроид вкуса, заполненный нулями, — не деградировавший вектор вкуса, а **неверный**: стратегия уверенно посчитает близость к точке, которой нет. Поэтому фича помечается недоступной, и стратегии, которым она нужна, отключаются — как при `applicable: false`, с тем же перераспределением веса.

Три места, где решение неочевидно и потому объяснено явно:

**Фильтр падает → удаляется КАНДИДАТ, а не запрос.** В версии 0.2 здесь было «ошибка запроса», и это было хуже. Инвариант безопасности звучит так: *объект, не одобренный явно, не показывается.* Он одинаково соблюдается обоими вариантами, но удаление кандидата дополнительно сохраняет выдачу: если лицензия не проверилась для одного трека — выпадает один трек, а не весь фид. Формулировка из ревизии («filter error → candidate removed, без вариантов») строго сильнее моей. Принято.

**Но у fail-closed есть ловушка, которой нет у fail-open: массовый отказ выглядит как пустота, а не как поломка.** Если сервис лицензий лёг целиком, поканди­датное удаление вычистит всех — и пользователь увидит «рекомендаций нет», эксплуатация увидит успешный ответ с пустым телом, а инцидент будет обнаружен через сутки по проседанию метрик. Пустая выдача безопасна, но она **лжёт о причине**. Поэтому:

```ts
filterErrorBudget: 0.05   // доля кандидатов, отвалившихся с исключением
```

Превышение доли → запрос падает громко. Единичный сбой — деградация; систематический — поломка, и называть её надо поломкой. Порог, а не бинарный выбор, потому что это единственный способ получить оба свойства сразу.

У фильтров нет поля `criticality`: выбор политики был бы ошибкой (§6).

**`defaultValue` наконец окупается.** Поле объявлено в `FeatureDescriptor` с версии 0.1 и до этого раздела выглядело декоративным. Именно оно даёт `optional`-экстрактору осмысленную деградацию: автор фичи **сам** решает, что значит её отсутствие (для `popularity` — 0, для `affinity` — 0, для `item_age_days` — медиана, а не 0, иначе всё станет «свежим»).

**Отброшенная стратегия ничего не ломает в шкале.** Итог нормируется на `Σ weights` (§11.2), поэтому исчезновение колонки автоматически перевзвешивает остальные. Порог `score > 80 → push` продолжает значить то же самое. Это тот же механизм, что и у `applicable: false`, — и хорошо, что механизм один.

Все warning'и структурированы и попадают в `Diagnostics.warnings`:

```ts
export interface DiagnosticWarning {
  readonly stage: string
  readonly port: string
  readonly code: 'port_failed' | 'not_applicable' | 'degraded' | 'quota_unfilled' | 'schema_default'
  readonly message: string
  readonly cause?: unknown
}
```

`degrade` без метрики на `warnings` — это медленная деградация качества, которую никто не заметит. Поэтому `Metrics.count('reco.degraded', ...)` вызывается ядром автоматически, а не оставляется на совесть эксплуатации.

### 17.3 Applicability вместо capability negotiation

Из ревизии: «`requires`/`provides` есть, но нет `supports()`/`canHandle()`».

Здесь я **возражаю в предложенной форме и принимаю по существу**.

Возражение: `supports()` / `canHandle()` — переговоры **о возможностях** в рантайме. Они уносят ошибку конфигурации из `build()` в обработку запроса, а весь §8.4 построен на обратном: несовместимость должна падать при старте приложения. Если стратегия в рантайме говорит «не поддерживаю такую схему» — значит, `build()` не доделал работу. Динамические переговоры здесь лечили бы симптом.

Но за замечанием стоит реальный сценарий, которого в 0.1 не было: **cold start**. «Стратегия истории бессмысленна для пользователя с 3 событиями», «когортная популярность требует, чтобы когорта была определена». Это **не** свойство схемы — это свойство **запроса**. Разные вещи, и называть их надо по-разному:

```ts
applicable?(ctx: RequestContext): boolean   // раз на запрос, не на объект
```

| | Проверяет | Когда | При провале |
|---|---|---|---|
| `requires` / `provides` | совместимость схемы | `build()` | приложение не стартует |
| `applicable(ctx)` | применимость к запросу | раз на запрос | стратегия отключается, вес перераспределяется, warning `not_applicable` |

Разделение сохраняет главное свойство (несовместимость ловится на старте) и закрывает реальный пробел. Cold start после этого выражается декларативно:

```ts
class HistoryStrategy implements ScoringStrategy {
  applicable = (ctx: RequestContext) => ctx.history.size >= 20
}
```

Пользователь с пустой историей автоматически получает выдачу по популярности и новизне — потому что остальные стратегии отключились, а не потому, что кто-то написал `if (isNewUser)` в ядре.

**Проверено на коде, и не с первого раза (0.5).** Реализация этого обещания не выполняла: доска брала число строк из первой колонки, поэтому движок, у которого **все** стратегии отключились, отдавал пустую выдачу — при тысячах извлечённых кандидатов. Cold start приходил к худшему из возможных ответов. Формула §11.2 при этом уже говорила верное: `Σweights` равна нулю, `base` равен нулю у всех, выдача стоит и ранжируется по единственному, что осталось, — порядку retrieval. Граница «ноль колонок ≠ ноль кандидатов» теперь закреплена регресс-тестом: это не следствие формулы, а отдельное утверждение, и держать его должна машина.

## 18. Публичный API

```ts
import { createEngine } from '@recoengine/core'
import { HistoryStrategy, AffinityStrategy, PopularityStrategy, RecencyStrategy } from '@recoengine/strategies'
import { FatigueModifier, NoveltyModifier } from '@recoengine/modifiers'
import { MMRDiversifier } from '@recoengine/diversity'
import { ArtistAffinityExtractor, GenreAffinityExtractor } from '@recoengine/domain-music'

interface Track { readonly title: string; readonly artistId: string; readonly genres: readonly string[] }

const engine = createEngine<Track>()
  .use(new LibraryCandidateProvider(db))
  .use(new ArtistAffinityExtractor())
  .use(new GenreAffinityExtractor())
  .use(new HistoryStrategy())
  .use(new AffinityStrategy({ id: 'artist', feature: 'affinity_artist' }))
  .use(new AffinityStrategy({ id: 'genre',  feature: 'affinity_genre'  }))
  .use(new PopularityStrategy())
  .use(new RecencyStrategy())
  .use(new FatigueModifier({ threshold: 50, recoveryDays: 30 }))
  .use(new NoveltyModifier())
  .use(new MMRDiversifier({ lambda: 0.7 }))
  .configure({
    weights: { history: 1.0, artist: 0.9, genre: 0.6, popularity: 0.3, recency: 0.4 },
    // Обязательны, без дефолтов (§23.3). Пропустить нельзя: build() бросит INVALID_CONFIG.
    limits: { maxCandidates: 5_000, maxLimit: 100, timeoutMs: 200 },
    // 0.5: exploration включён, но исполнять его пока некому — дефолтного Blender'а ядро
    // не поставляет (Этап 7). Движок не молчит: пишет warning `quota_unfilled` — «сказано
    // исследовать, исследовать нечем». Настройка, которая ничего не делает, обязана
    // сказать об этом вслух.
    exploration: { enabled: true, buckets: [
      { id: 'exploit', share: 0.7 }, { id: 'explore', share: 0.2 }, { id: 'discover', share: 0.1 },
    ]},
  })
  .build()   // ← здесь падает, если фича не найдена, лимиты не заданы или веса не сходятся

const result = await engine.recommend({
  user,
  history,
  limit: 20,
  explain: 'reasons',
  signals: new Map([['timeOfDay', 'evening']]),
})
```

`build()` возвращает **immutable** движок. Ошибки конфигурации — на старте приложения, не в 3 часа ночи в проде.

---

## 19. Точки расширения — сводка

| # | Порт | Слот | Зачем | Доменный? |
|---|---|---|---|---|
| 1 | `CandidateProvider` | many | Откуда берутся кандидаты | да |
| 2 | `PreFilter` | many | Отсев по payload, стадия 2 (fail-closed) | да |
| 2b | `PostFilter` | many | Отсев по фичам, стадия 4b (fail-closed) | **нет** |
| 3 | `FeatureExtractor` | many | **Доменное знание → числа** | **да** |
| 4 | `UserFeatureExtractor` | many | **Профиль/сессия → вектор** (0.2) | **да** |
| 5 | `FeatureTransform` | many | Инженерия фичей | нет |
| 6 | `ScoringStrategy` | many | Математика оценки | **нет** |
| 7 | `DomainScoringStrategy<P>` | many | Escape hatch, типизированный (0.2) | **да, явно** |
| 8 | `ScoreNormalizer` | many | Приведение шкал | нет |
| 9 | `ScoreCombiner` | single | Как складывать | нет |
| 10 | `ScoreModifier` | many | Fatigue, novelty, boost | нет |
| 11 | `Ranker` | single | Как ранжировать | нет |
| 12 | `Diversifier` | many | Разнообразие | нет |
| 13 | `SimilarityProvider` | **не слот** | Метрика близости | да |
| 14 | `Blender` | single | Exploration/exploitation | нет |
| 15 | `Explainer` | single | Сборка объяснения | нет |
| 16 | `WeightProvider` | single | A/B, персональные веса | нет |
| 17 | `StageMiddleware` | many | Телеметрия, кэш, отладка | нет |
| 18 | `Clock` / `Rng` / `Logger` / `Metrics` / `FeatureCache` | single | Инфраструктура | нет |

**Доменных портов — 6 из 19:** `CandidateProvider`, `PreFilter`, `FeatureExtractor`, `UserFeatureExtractor`, `DomainScoringStrategy`, `SimilarityProvider`. Чтобы завести новый домен, реализуется 1–2 порта (провайдер + экстракторы), остальные переиспользуются как есть.

**`SimilarityProvider` — не слот реестра (уточнено в 0.5).** В таблице он значился «many», но `Registry` его не принимает, и это осознанно: его единственный потребитель — диверсификатор, и метрика близости передаётся ему в опциях (`new MMRDiversifier({ similarity })`). Слот в реестре означал бы «движок знает про близость» — а движок про неё не знает и знать не должен: он не вызывает её ни на одной из 16 стадий. Порт остаётся портом; регистрирует его тот, кому он нужен.

`PostFilter` в этом списке **отсутствует**, и это не оплошность, а следствие его сигнатуры: он получает `(row, view)` и читает только фичи — доменных объектов он не видит. То есть правило «недоступно в регионе» превращается в фичу `is_available` силами экстрактора, а сам фильтр остаётся чистой арифметикой над числом. Разделение «домен → фичи, математика → всё остальное» действует и здесь; `PreFilter` доменный лишь потому, что работает до экстракции и вынужден смотреть в `payload`.

`DomainScoringStrategy` — единственный порт, помеченный «доменный **явно**»: его использование добровольно, видно в `engine.inspect()` и означает сознательный отказ от переносимости в обмен на прямой доступ. Остальные доменные порты доменны по необходимости.

---

## 20. Почему такая архитектура масштабируется

### 20.1 Масштабируемость по доменам

Добавить фильмы = написать `MovieCandidateProvider` + `DirectorAffinityExtractor`. Стратегии, нормализация, комбайнер, ранкер, MMR, blender, объяснялка, конфиг — **ноль строк**. Это следствие ровно одного решения: стратегия принимает `FeatureMatrix`, а не `Item`. Альтернатива (стратегия видит item) даёт `ArtistStrategy`/`DirectorStrategy`/`BrandStrategy` — N доменов × M стратегий классов вместо N + M.

### 20.2 Масштабируемость по функциональности

Пайплайн фиксирован, слоты открыты. Новая идея («учитывать погоду») = новый экстрактор + строчка конфига. Ядро не меняется. Open/Closed соблюдён не декларативно, а структурно: **у ядра нет места, куда можно было бы вписать доменную логику** — типы не позволяют.

### 20.3 Масштабируемость по нагрузке

- Batch API → 1 запрос в БД вместо N.
- Column-major `Float64Array` → векторные проходы, отсутствие GC-давления на 100k кандидатов.
- Top-K heap → `O(n log k)`.
- Параллелизм внутри стадий (провайдеры, экстракторы, стратегии независимы по контракту).
- `FeatureCache` по `itemId` → фичи объекта считаются раз, не на каждого пользователя.
- Ранний prefilter → дорогие стадии видят меньше кандидатов.
- Stateless-стратегии → горизонтальное масштабирование бесплатно.

### 20.4 Масштабируемость по команде

Физические границы пакетов + правило зависимостей в CI. Команда «музыка» пишет `domain-music`, команда «ядро» — `core`. Конфликт merge невозможен: разные пакеты. Плагин третьей стороны не может сломать ядро — контракт узкий и типизированный.

### 20.5 Масштабируемость по отладке

`explain: 'full'` + `engine.explain(itemId)` + `Diagnostics` с таймингами по стадиям. Вопрос «почему этот трек на первом месте» имеет машинный ответ. Это то, чего нет ни в одной JS-библиотеке рекомендаций, и то, из-за чего самописные движки становятся неподдерживаемыми через полгода: никто не помнит, почему коэффициент 0.37.

### 20.6 Масштабируемость по времени

`WeightProvider` — точка, где веса когда-нибудь начнут подбираться автоматически (бандит, оффлайн-подбор по метрикам). Ядро остаётся не-AI и детерминированным. Дверь открыта, но не обязательна к использованию.

### 20.7 Что мы сознательно НЕ делаем

- **Произвольная вставка стадий.** Даёт гибкость, убивает типизацию, оптимизацию и объяснимость. ES тоже не даёт вставить фазу в поиск.
- **Обучение внутри.** Не наша задача. Порты открыты.
- **Хранилище.** Мы не владеем данными.
- **Распределённость.** Библиотека, а не сервис. Кластеризация — слой выше.
- **Enum для EventType/ItemType.** Открытые строки, семантика — в конфиге.

---

## 21. Тестирование

- **Unit**: стратегии — чистые функции `Float64Array → Float64Array`. Без моков.
- **Property-based** (`fast-check`, только devDependency):
  - нормализаторы всегда возвращают `[0..1]`, никогда `NaN`;
  - MMR при `λ = 1` эквивалентна чистому ранжированию;
  - fatigue монотонно убывает по count;
  - выдача детерминирована при фиксированном seed;
  - веса не меняют масштаб итогового score.
- **Golden-тесты**: зафиксированный вход → зафиксированная выдача. Ловит регрессии ранжирования — самый ценный тип теста здесь, так как «стало хуже» иначе не поймать.
- **Contract-тесты**: каждый порт имеет переиспользуемый набор — сторонний плагин проверяет соответствие контракту одной строкой. Обязательно входят: реакция на прерванный `ctx.signal` (§17.1) и поведение при брошенном исключении под обеими `errorPolicy` (§17.2).
- **Benchmarks**: 1k / 10k / 100k кандидатов, регрессия перфа в CI.
- Цель покрытия ядра: 95%+.

### 21.1 Как это легло в код (`@recoengine/testing`, Этап 6а)

Пакет — две половины. **Фикстуры** (`catalogueOf`, `payloadExtractor`, `profileExtractor`, `constantStrategy`, `fixedClock`, `events`, `request`, `testEngine`, `rankedIds`, `scoreById`) — синтетические части движка, которые до этого каждый тест катал руками; golden-наборы Этапов 5 и 6 переведены на них тем же заходом (долг из PROGRESS §4 погашен). **Контракты** — переиспользуемые проверки §20: `assertHonoursCancellation` (§17.1), `assertExtractorErrorPolicy` (§17.2, обе политики) — обязательные; `assertDeterministic`, `assertScoresWellFormed` — гигиена; `assertScoringStrategy`/`assertScoreModifier` — обёртки, прогоняющие порт через настоящий движок и применяющие всё перечисленное.

**Контракты не зависят от раннера (уточнение §20–§21).** ТЗ говорило «набор, подключаемый одной строкой», подразумевая готовые `describe/it`. Реализация вместо этого — **framework-agnostic функции, бросающие `Error` при нарушении**: `it('cancels', () => assertHonoursCancellation(engine))` — одна строка в любом раннере, а сам пакет не тянет `vitest` в зависимости (иначе публикуемый `@recoengine/testing` навязывал бы всем один тест-фреймворк). `AbortSignal`/`AbortController` объявлены локальным `platform.d.ts`, как и в ядре (§23.4), — kit тоже изоморфен. Контракты проверены самопроверкой: они проходят на исправных портах и **бросают** на нарочно сломанных (движок, игнорирующий сигнал; недетерминированный движок).

---

## 22. План реализации

| Этап | Содержание | Критерий готовности |
|---|---|---|
| ✅ 0 | Каркас: workspace, tsconfig, biome, vitest, typedoc, CI, dep-rule, changesets | `pnpm build && pnpm test` зелёные |
| ✅ 1 | `domain/` — сущности, ids, FeatureMatrix (+arity), ProfileVector, ScoreBoard, HistoryIndex | 100% покрытие, property-тесты |
| ✅ 2 | `kernel/` — container, EngineBuilder(=Registry), plugin host, config, валидация графа фичей, freeze + schema.version | Плагин с недостающей фичей падает на `build()`; `use()` после `build()` бросает |
| ✅ 3 | `pipeline/` — стадии, middleware, диагностика, **cancellation + error policy** | Пустой движок отдаёт пустой результат с таймингами; прерванный сигнал даёт `AbortError` на каждой стадии |
| ✅ 4 | `math/` — нормализаторы, similarity, rrf, decay, heap, rng | Property-тесты, бенчмарки. **`softmax` и `mmr` перенесены**: первый пока никому не понадобился, второй принадлежит Этапу 7 |
| ✅ 5 | `@recoengine/strategies` — 9 стратегий | Golden-тесты на синтетике |
| ✅ 6 | `@recoengine/modifiers` — fatigue, novelty, boost | Кривые затухания и восстановления |
| ✅ 6а | `@recoengine/testing` — фикстуры, golden-раннер, contract-test kit | Порт проверяется на контракт одной строкой; входят прерванный сигнал (§17.1) и обе `errorPolicy` (§17.2) |
| ✅ 7 | `@recoengine/diversity` — MMR, quota, similarity providers | MMR(λ=1) ≡ ranking |
| ✅ 8 | Explainability — explainer, trace, `engine.explain()` | Объяснение сходится: Σ contributions = score |
| ✅ 8а | `@recoengine/features` — общие экстракторы/трансформы | Доменно-нейтральные фичи (из истории/времени) переиспользуются music и ecommerce |
| 9 | `@recoengine/domain-music` + `examples/music` | Работает на реальном датасете |
| 10 | `examples/ecommerce` | **Доказательство: 0 изменений в core** |
| 11 | Docs, typedoc, README, бенчмарки, `v0.1.0` | Публикация в npm |

Этап 10 — не демо, а **приёмочный тест архитектуры**. Если для e-commerce потребуется тронуть `core`, значит абстракция протекла и её надо чинить до релиза.

**Этапы 6а и 8а добавлены ревизией плана (0.5).** Пакеты `@recoengine/testing` и `@recoengine/features` были в раскладке (§8, дерево пакетов) и в правиле зависимостей `check-arch`, но ни одна стадия их не строила — план молча оставлял два из шести пакетов пустыми до самого релиза. `testing` особенно: §21 называет contract-тесты **обязательными**, а до его появления каждый тест (включая golden-набор Этапа 5) катает фикстуры руками — общего kit, о котором говорит §20, ещё нет. Он поставлен сразу после `modifiers`, чтобы диверсификаторы и доменные плагины проверялись контрактом, а не переоткрытым каждый раз мок-движком. `features` — перед доменными примерами, как их общая база. Номера с буквами (а не сдвиг 7→8→…) — чтобы не переписывать ссылки на «Этап 8 = explainability», разбросанные по документу.

Этапы 0–8а закрыты (все восемь пакетов построены): 656 тестов, покрытие ядра 95.4%, CI зелёный на Node 20/22/24, Bun и Deno. Текущее состояние работы, открытые долги и точка входа для продолжения — в [PROGRESS.md](./PROGRESS.md); этот документ описывает архитектуру, а не прогресс.

---

## 23. Открытые вопросы на утверждение

1. ~~**Monorepo (6 пакетов) или один пакет с subpath exports?**~~ **РЕШЕНО: monorepo** (pnpm workspace, 7 пакетов — шесть библиотечных плюс unscoped meta). Ноль зависимостей у `core` иначе не удержать. Цена — сложнее релиз: нужен changesets + правило зависимостей в CI.
2. ~~**Async-стратегии?**~~ **РЕШЕНО: `score()` синхронный, навсегда.** Это не оптимизация, а **охрана главного разделения**: I/O → Extraction → Math. `async score()` — это открытая дверь, в которую немедленно войдут «сходить в Redis за одним значением» и «дёрнуть сервис». Синхронная сигнатура делает нарушение невозможным, а не порицаемым. Тот же приём, что с фильтрами (§6): инвариант охраняется типом, а не дисциплиной.
3. ~~**Ограничение на стадии 1?**~~ **РЕШЕНО: инвариант движка.** `limits.maxCandidates`, `limits.maxLimit`, `limits.timeoutMs` — обязательны, без дефолтов, отсутствие → ошибка `build()`. Плюс главное: бюджет **проталкивается** в провайдер (`RetrievalBudget`), а не применяется после (§6). Обрезка 1M строк после `SELECT` защищает выдачу, но не базу — то есть маскирует DOS, а не предотвращает.
4. ~~**Node-only или изоморфность?**~~ **РЕШЕНО: изоморфно.** `@recoengine/core` не импортирует Node API вообще (проверяется в CI). Следствия, зафиксированные как контракт:
   - RNG — собственный, не `node:crypto`. **Уточнено в 0.5: `xoshiro128**`, а не `xoroshiro128+`.** Тот 64-битный, а в JavaScript нет 64-битных целых: понадобился бы BigInt (аллокации, порядок медленнее — на пути, который исполняется для каждого кандидата) либо ручная арифметика по 32-битным лимбам, которой пришлось бы доверять без референсных векторов для сверки. Та же семья, те же авторы, спроектирован под 32 бита — и он даёт ровно то, ради чего требование написано: сеется, воспроизводим, быстр, не трогает окружение. Требование было к свойству, а не к имени алгоритма.
   - `fork(seed)` — чистая функция от seed'ов, а не от состояния родителя. Иначе поток, который достался пользователю, зависел бы от того, сколько запросов прошло до него, и воспроизводимость стала бы функцией трафика — то есть исчезла бы.
   - Параллелизм внутри стадий — только `Promise.all`, без `worker_threads`. Реальный параллелизм — забота адаптера снаружи.
   - Всё I/O (БД, кэш, сеть) — исключительно за портами; адаптеры живут в отдельных пакетах.
   - Тесты ядра гоняются в двух окружениях vitest: `node` и `jsdom`/`browser`.
5. ~~**Версия TS / целевой Node?**~~ **РЕШЕНО: TS 5.9+, Node 20+, ESM-only, без CJS.** Ключевое — «`@recoengine/core` не использует Node API вообще» проверяется машиной, а не обещанием в README:
   - lint-правило `noRestrictedImports` на `node:*`, `fs`, `path`, `crypto`, `worker_threads` в `packages/core/**` — ошибка сборки;
   - CI-матрица: **Node 20, Node 22, Bun, Deno, браузер** (vitest browser mode). Пакет, случайно затащивший Node API, красит матрицу;
   - `package.json`: `"type": "module"`, `"exports"` без `require`-ветки, `"sideEffects": false`, `"engines": { "node": ">=20" }`.
   Bun и Deno при этом — не заявленная поддержка «на словах», а строки в CI. Только так это утверждение остаётся правдой через год.
6. ~~**Scope в npm?**~~ **РЕШЕНО: `@recoengine/*`.**
   - Шесть пакетов: `@recoengine/core` (0 зависимостей), `/strategies`, `/features`, `/modifiers`, `/diversity`, `/testing`.
   - Unscoped `recoengine` (проверено — свободен) занимаем под **meta-пакет**: реэкспорт `core` + `strategies` + дефолтная сборка для быстрого старта. Две задачи одним ходом: `npm i recoengine` работает «из коробки», и имя защищено от squatting.
   - `@recoengine/domain-music` **не публикуется** — живёт в `examples/`, см. п. 7.
   - **Занято и подтверждено** (Этап 0): организация `recoengine` создана, `npm org ls recoengine` → `waleron - owner`. Имя закреплено до того, как попало в код, — ровно как и требовалось.
   - Организация создаётся **только через веб** (npmjs.com/org/create); у `npm org` есть лишь `set`/`rm`/`ls`, команды `create` не существует.
   - На аккаунте включён 2FA `auth-and-writes`. Следствие для Этапа 11: публикация из CI по обычному токену работать не будет — нужен granular access token либо, что предпочтительнее, Trusted Publishing через OIDC из GitHub Actions вообще без долгоживущих секретов.
7. **Что делать с `@recoengine/domain-music`?** Он в репозитории как пример, но публиковать его в npm — значит взять на себя поддержку музыкального домена. Предлагаю **не публиковать**: оставить в `examples/`, а не в `packages/`. Иначе библиотека снова начнёт выглядеть «музыкальной».

### 23.-2 Ревизия 0.5 — сверка документа с реализацией

Первая ревизия, где у документа появился оппонент, которого можно запустить. Ревизия 0.4 сверяла документ **с самим собой**; эта сверяет его с кодом Этапов 0–4 и с четырьмя проходами аудита по нему.

Правило, по которому разрешались споры: **правится документ, а не код**. Не потому, что код авторитетнее, а потому, что код проверяется машиной, а документ — нет. Там, где они расходятся, ошибается тот, кого никто не запускал.

Из 31 внесённого пункта девять — содержательные: документ **учил неправильному**, и это ровно тот класс, который ревизия 0.4 назвала худшим («их копируют»).

| # | Что было не так | Тип |
|---|---|---|
| 1 | **`ScoreModifier.apply(board: ScoreBoard): void`** — сочетание, при котором модификатор не может сделать ничего: доска read-only, возвращать некуда. Любой, кто написал бы модификатор по документу, получил бы нерабочий код | **содержательное** |
| 2 | **§5.5 требовал column-major «везде»** — не работает: нормализатор и косинус ходят по матрице перпендикулярно, и `vector()` мог бы вернуть только копию, аллокацию на кандидата | **содержательное** |
| 3 | **Схема фичей была одна** — а `affinity_genre` законно значит разное для кандидата и для профиля; один namespace объявлял бы эту пару коллизией | **содержательное** |
| 4 | **§8.3 валидировал конфиг до `register()`** — неисполнимо: веса проверяются против стратегий, которых ещё нет | **содержательное** |
| 5 | **`UserFeatureExtractor` без маркера `scope`** — структурно неотличим от `FeatureExtractor`, плагин по документу зарегистрировался бы не туда | **содержательное** |
| 6 | **§17.2: провайдер игнорировал `criticality`** — при буквальном чтении поле на этом порту было декорацией | **содержательное** |
| 7 | **§17.2: не было строки про нормализатор**, а «деградация» к сырой колонке молча переписывает ранжирование | **содержательное** |
| 8 | **§17.2: профильная фича «← defaultValue»** — центроид из нулей не деградировавший вектор вкуса, а неверный | **содержательное** |
| 9 | **§23.4 обещал `xoroshiro128+`** — 64-битный алгоритм в языке без 64-битных целых. Требование было к свойству (сеется, воспроизводим, быстр), а не к имени | **содержательное** |
| 10 | `Registry` без `profileSchema`, `setWeightProvider`; `EngineBuilder` без `provide()` | пробел |
| 11 | `build()` в ядре — на деле шов `resolve()` (ядро) / `build()` (движок): ядро не выдумывает ранкер | рассинхрон |
| 12 | `EngineConfig` без `errorPolicy` и `filterErrorBudget` — описаны в §17.2, в интерфейс не внесены | пробел |
| 13 | `combiner.id` объявлен, но механизм резолва не описан — и в коде его не было: ключ молча не работал | **содержательное** |
| 14 | `request.overrides` не описан как валидируемый — а без этого §23.3 рекомендателен | **содержательное** |
| 15 | «15 стадий» и «15 границ» при шестнадцати перечисленных (0..14 плюс 4b) | арифметика |
| 16 | §19: `SimilarityProvider` со слотом «many», которого нет и не должно быть | рассинхрон |
| 17 | Статус «проектирование, код не пишется» при закрытых Этапах 0–4 | рассинхрон |
| 18–31 | Мелочи: `vectorMut` в интерфейсе матрицы, `MutableScoreBoard` как тип, дедуп плагинов, очередь прямых записей, одноразовость `resolve()`, буфер модификатора, валидация порядка от ранкера, `select()` у матрицы, `DiagnosticWarning` в домене, деление бюджета retrieval, `inspect()` с пометкой доменных стратегий, `softmax`/`mmr` в плане, отметки закрытых этапов | рассинхрон |

**Чего эта ревизия НЕ сделала.** Часть расхождений — не ошибки документа, а долги кода: `container.child()` объявлен в §9 и не вызывается; §10 задаёт приоритет `request.overrides` выше `WeightProvider`, а код применяет наоборот; §11.2 требует `round(final × 100)`, а код не округляет; §16 обещает `engine.explain(itemId, request)`, которого нет. Здесь документ прав, а код — нет, поэтому они остались как есть и записаны в PROGRESS §5. Разница принципиальная: документ описывает то, что должно быть, и правится он только там, где «должно быть» оказалось невозможным или неверным.

_Обновление (Этап 8): из этого списка два долга закрыты — округление §11.2 и `engine.explain()` (см. §16.1). Остаются `container.child()` и приоритет §10 — они в PROGRESS §5._

**Вывод, тот же что и в 0.4, но подтверждённый.** Девять содержательных ошибок пережили три ревизии на глаз и умерли за один заход, как только появился код: `ScoreModifier` не компилировался бы, column-major не собирался, порядок §8.3 не исполнялся. Документ, который никто не запускает, гниёт молча — и §21 не зря требует извлекать примеры из этого файла в компилируемый тест на Этапе 11. До тех пор единственная защита — сверять его с кодом на каждом закрытом этапе, а не «когда накопится».

### 23.-1 Ревизия 0.4 — сверка документа с самим собой

Три круга точечных правок оставили хвосты. Аудит на консистентность нашёл девять расхождений; все исправлены. Два из них — содержательные, остальные — рассинхрон текста с принятыми решениями.

| # | Что было не так | Тип |
|---|---|---|
| 1 | **Арифметика примера объяснения не сходилась**: Σ contributions = 0.80 при `baseScore: 89`. Документ об объяснимости нарушал собственный критерий приёмки из §21 («Σ contributions = score») | **содержательное** |
| 2 | **`PostFilter` помечен доменным портом**, хотя получает `(row, view)` и видит только фичи. Счёт «5 из 18» тоже был неверен | **содержательное** |
| 3 | §4: отсутствовал meta-пакет `recoengine`; `domain-music` лежал в `packages/`, что прямо противоречило §23.7 | рассинхрон |
| 4 | §16: пример показывал удалённое поле `strategies` и старое имя `factors` | рассинхрон |
| 5 | §11.2: формула ссылалась на `score(matrix)` вместо `score(view)` | рассинхрон |
| 6 | «14 стадий» в двух местах после добавления 4b | рассинхрон |
| 7 | `MutableProfileVector`, `DiagnosticsSink`, `NormalizedColumn` использовались, но не были определены | пробел |
| 8 | §18: флагманский пример API не задавал обязательные `limits` — то есть падал бы на `build()` с `INVALID_CONFIG` | рассинхрон |
| 9 | §7.1 и §7.3: диаграммы не пережили ревизий — не было prefilter/postfilter, профиля, бюджета, точек отмены | рассинхрон |

Расхождения 1 и 8 стоит отметить особо: это ровно те места, где документ **учил неправильному**. Пример, который не сходится, и пример, который не запустится, — хуже отсутствия примера, потому что их копируют.

Вывод на будущее: и то и другое обязано проверяться машиной, а не глазами. §21 уже требует golden-тест «Σ contributions = baseScore»; к нему добавляется извлечение примеров из `ARCHITECTURE.md` в компилируемый тест на Этапе 11. Пока библиотека не собрана, документ — единственный носитель правды, и он должен быть верен буквально.

### 23.0 Ревизия 0.3 — второй круг

| Замечание | Вердикт | Раздел |
|---|---|---|
| Fail-closed должен быть в **контракте интерфейса**, а не в тексте | **Принято.** `PreFilter`/`PostFilter`: нет `criticality`, `approve()` синхронен, функция тотальна, `failClosed: true` обязателен литералом, имя метода задаёт полярность | §6 |
| `filter error → candidate removed, без вариантов` | **Принято, моя версия была хуже.** Было «ошибка запроса» — теперь удаление кандидата. Инвариант тот же, доступность выше. Добавлен `filterErrorBudget` от ловушки массового отказа | §17.2 |
| `score()` оставить синхронным | **Принято и закрыто навсегда.** Инвариант I/O → Extraction → Math охраняется сигнатурой | §23.2 |
| `maxCandidates` — инвариант, а не настройка | **Принято и усилено.** Обязателен без дефолта + бюджет проталкивается в провайдер | §6, §10 |
| Явно написать, что core не использует Node API | **Принято, но машиной.** Lint-правило + CI-матрица Node/Bun/Deno/браузер | §23.5 |
| Scope `@recoengine/*` слишком общий | **Принято.** Единственный открытый вопрос | §23.6 |

Побочный эффект второго круга: **фильтр разделился на `PreFilter` (стадия 2, по payload) и `PostFilter` (стадия 4b, по фичам)**. Причина — требование «фильтр синхронен». Если фильтру нужны данные, за которыми надо идти в сеть (лицензия, доступность в регионе), то путь один: экстрактор с `criticality: 'required'` кладёт их в фичу, а фильтр её читает. Но фильтры стояли до экстракции — значит, нужна вторая точка фильтрации после неё. Запрет на I/O внутри фильтра оказался тем, что вскрыло недостающую стадию.

### 23.1 Ревизия 0.2 — что изменено по итогам первого разбора

| # | Замечание | Вердикт | Раздел |
|---|---|---|---|
| 4 | Registry / Plugin / Builder — лишний уровень | **Принято.** `EngineBuilder implements Registry` — один объект, две роли. Уровней 5 → 4 | §8.0 |
| 5 | `FeatureSchema` mutable → нужен freeze | **Принято и усилено.** Не `freeze()`, а два типа: `MutableFeatureSchema` / `FeatureSchema`. Ошибка компиляции, не рантайма | §5.5 |
| 6 | Explain знает слишком много (5 моделей) | **Принято.** 5 → 3. `Factor` = `ScoreContribution` (терминологический дубль), `strategies[]` удалён как деривация | §5.7 |
| 7 | `AttributeStore` — протечка домена | **Принято полностью.** Удалён. Квоты → категориальные фичи, похожесть → `SimilarityProvider`, агрегаты → `aggregate(keyFn)` | §5.5 |
| — | Strategy ограничена `FeatureMatrix` — сломается на graph/session | **Пробел принят, лечение — другое.** ANN/PPR не контрпримеры (их выход = фича). Реальный пробел — нет векторного доступа к профилю → добавлены `ProfileVector`, `UserFeatureExtractor`, `arity`. Плюс типизированный escape hatch `DomainScoringStrategy<P>` | §11.1.1 |
| +1 | Версионирование `FeatureSchema` | **Принято.** `schema.version` = FNV-1a по дескрипторам → в ключ кэша | §5.5 |
| +2 | Capability negotiation `supports()` | **Принято по существу, отклонено в форме.** `supports()` уносит ошибку из `build()` в рантайм. Реальный сценарий — cold start → `applicable(ctx)`, раз на запрос | §17.3 |
| +3 | Cancellation — контракт не описан | **Принято.** Дыра. Три правила, `signal` больше не опционален | §17.1 |
| +4 | Error policy не определена | **Принято.** Дыра. Матрица политик, дефолт `required`, фильтры — всегда fail-closed | §17.2 |

---

## 24. Резюме одним абзацем

Движок построен вокруг одного решения: **доменное знание превращается в числа в экстракторах, а вся математика ранжирования работает только с числами**. Из этого следует всё остальное — переиспользование стратегий между доменами, векторная производительность, тестируемость без моков, объяснимость по построению и фиксированный пайплайн с открытыми слотами. Это ровно та же декомпозиция, которая позволила Elasticsearch быть поисковиком «для чего угодно»: маппинг знает домен, скоринг знает математику, и они не пересекаются.
