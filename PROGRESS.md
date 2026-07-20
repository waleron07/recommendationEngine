# Точка остановы

> Обновлено: 2026-07-20
> Ветка: `main`
> Remote: [waleron07/recommendationEngine](https://github.com/waleron07/recommendationEngine) (**публичный**)
> Состояние: **Этапы 0–5 закрыты. Следующий — Этап 6 (`@recoengine/modifiers`).**
> Последняя ревизия: закрыт **Этап 5** — девять стратегий §11.3 в `@recoengine/strategies` (21 golden-тест на синтетике), ARCHITECTURE.md §11.3 сведён с кодом тем же заходом.

Этот файл — состояние работы, а не документация. Проектные решения и их обоснования живут в [ARCHITECTURE.md](./ARCHITECTURE.md) (**версия 0.5, сверена с реализацией**); здесь только то, что нужно, чтобы продолжить с того же места.

**§3 этого файла расформирован.** Он был списком из 31 расхождения между кодом и документом — накопителем, который рос, пока документ не правили. Теперь всё это внесено в ARCHITECTURE.md с обоснованиями (§23.-2), и держать вторую копию значило бы завести третий источник правды. Осталось то, что списком быть и должно: долги кода — в §5.

---

## 1. Как убедиться, что всё живо

```bash
pnpm install
pnpm verify     # lint + check:arch + build + test
pnpm bench      # отдельно: измеряет, а не утверждает
```

Ожидаемо: **581 тест в 31 файле**, `✓ Architecture check passed (7 packages)`, покрытие ядра **95.4% строк / 93.26% ветвей** (пороги в `vitest.config.ts`: 90/85/90/90). Из них 21 — golden-тесты Этапа 5 в `packages/strategies/src/strategies.test.ts`.

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

Четыре пакета (`features`, `modifiers`, `diversity`, `testing`) — пустые каркасы с `export {}`. `strategies` — **закрыт Этапом 5** (девять фабрик §11.3). Шестой, `recoengine`, — фасад `export * from '@recoengine/core'`; стратегии он пока не реэкспортирует (решить при Этапе 11, когда появится, что публиковать).

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

## 4. Следующий шаг — Этап 6 (`@recoengine/modifiers`)

Критерий приёмки из §22: **кривые затухания и восстановления**. Модификаторы стадии 8: fatigue, novelty, boost (§15).

Что учесть, заходя:

1. **Модификатор пишет через `MutableScoreBoard.add`, не читает `ScoreBoard`.** Контракт `ScoreModifier` (§16, `score.ts`) даёт только write-side: fatigue читает историю и фичи и заявляет множитель, базовый score ему не нужен. `kind: 'multiplicative'` для fatigue/novelty, `'boost'`/`'veto'` для остального — §11.2 их складывает по-разному, и это принципиально (§15: умножение убирает трек, вычитание — нет).
2. **«Всё или ничего» (§17.2, 0.5).** Модификатор коммитит буфер, только дойдя до конца: утомил 50 из 5000 и упал на 51-м — не оставить половину выдачи приглушённой молча. Это отдельное требование, не следствие формулы, — закрепить тестом.
3. **Fatigue уже есть в математике.** `math/decay.ts`: `exponentialDecay` (затухание по count), `recovery` (восстановление по времени с последнего контакта, §15). Модификатор — тонкая обёртка над ними + чтение `HistoryIndex.countFor`/`lastAtFor`. `gaussianDecay`/`linearDecay` тоже готовы.
4. **Novelty — второй раз.** `noveltyStrategy` (Этап 5) даёт аддитивную колонку; модификатор novelty — мультипликативный буст (§15: `1 + saturation·weight·unfamiliarity`). Оба легитимны, различие — порядок свёртки; не дублировать логику, а переиспользовать формулу насыщения.

**Хвосты Этапа 5, оставленные сознательно:** `softmax` по-прежнему не написан (§5, никому пока не понадобился); `SimilarityProvider` без слота в `Registry` — решать на Этапе 7 (diversity), там же MMR; `recoengine`-фасад стратегии не реэкспортирует.

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
| **Дефолтного блендера нет** | `engine/defaults.ts` | §18 включает exploration, но исполнять её некому. Движок предупреждает (`quota_unfilled`), а не молчит |
| **`SimilarityProvider` без слота** | `kernel/registry.ts` | §19 даёт ему слот «many»; решено передавать его в опциях MMR. Записано только здесь |
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
