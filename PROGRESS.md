# Точка остановы

> Обновлено: 2026-07-15
> Коммит: `ebd7f64` — Stage 1 (part 2): ScoreBoard, Candidate, Reason
> Ветка: `main`, дерево чистое, remote нет
> Состояние: **Этапы 0 и 1 закрыты. Следующий — Этап 2 (kernel).**

Этот файл — состояние работы, а не документация. Проектные решения и их обоснования живут в [ARCHITECTURE.md](./ARCHITECTURE.md) (версия 0.4); здесь только то, что нужно, чтобы продолжить с того же места.

---

## 1. Как убедиться, что всё живо

```bash
pnpm install
pnpm verify     # lint + check:arch + build + test
```

Ожидаемо: Biome без замечаний, `✓ Architecture check passed (7 packages)`, **67 тестов в 6 файлах**, покрытие ядра **95.98% строк / 91.07% ветвей**.

`pnpm verify`, а **не** `pnpm ci` — `ci` зарезервирована самим pnpm, печатает `ERR_PNPM_CI_NOT_IMPLEMENTED` и выходит с кодом 0. То есть шаг в CI с таким именем молча «проходил» бы, не выполнив ничего.

---

## 2. Что построено

```
packages/core/src/
├── index.ts                публичный API
├── domain/
│   ├── brand.ts            Brand<T,B> — номинальная типизация без рантайм-цены
│   ├── ids.ts              ItemId, UserId, EventId, StrategyId, FeatureKey, Timestamp + конструкторы
│   ├── entities.ts         Item, User, Event, EventType, History
│   ├── feature.ts          FeatureDescriptor, MutableFeatureSchema / FeatureSchema, FeatureSchemaBuilder
│   ├── matrix.ts           FeatureMatrix, DenseFeatureMatrix
│   ├── profile.ts          ProfileVector, MutableProfileVector, DenseProfileVector
│   ├── history.ts          HistoryIndex, MapHistoryIndex
│   ├── candidate.ts        Candidate, CandidateSet, CandidateSetBuilder
│   ├── score.ts            ScoreColumn, ScoreContribution, ScoreBoard, ScoreBoardBuilder, contributionOf
│   └── reason.ts           Reason
└── kernel/
    └── errors.ts           RecoError + коды, MissingFeatureError, FeatureCollisionError, BuilderSealedError
```

Остальные шесть пакетов (`features`, `strategies`, `modifiers`, `diversity`, `testing`, `recoengine`) — пустые каркасы с `export {}`. Собираются, но ничего не содержат.

### Стражи архитектуры

`scripts/check-arch.mjs` — не формальность, все четыре правила проверены намеренной поломкой:

| Нарушение | Кто ловит |
|---|---|
| `import 'node:fs'` в ядре | check-arch |
| любая зависимость у `core` | check-arch |
| зависимость вправо (`core → strategies`) | check-arch |
| `process.env` в ядре | **компилятор**, `error TS2591` |

Последнее — следствие `"types": []` и `lib` без DOM в `packages/core/tsconfig.json`. Изоморфность здесь не обещание в README, а ошибка сборки.

---

## 3. Решения, принятые в коде и НЕ описанные в ARCHITECTURE.md

Самое важное для того, кто продолжит: код в трёх местах разошёлся с документом осознанно. Документ пока не переписан — при следующей ревизии эти пункты надо внести в §5.

### 3.1 Матрица использует два layout'а, а не один (`matrix.ts`)

§5.5 требует column-major «везде». Это не работает: нормализатор идёт по одной фиче через все строки (нужен column-major), косинус идёт по 128 измерениям одной строки (нужен row-major). При column-major эти 128 значений лежат на расстоянии `rows`, и `vector()` мог бы вернуть только копию — аллокация на каждого кандидата.

Реализовано: **скаляры column-major, эмбеддинги row-major поблочно на фичу**. Схема знает, где живёт фича, вызывающий шва не видит.

### 3.2 Версия схемы не зависит от порядка регистрации (`feature.ts`)

Хеш берётся от **отсортированного** отпечатка `(key, kind, arity, owner@version)`. Иначе перестановка в цепочке `use()` обнуляла бы весь кэш фичей, не изменив ничего по существу. Зафиксировано property-тестом.

### 3.3 `contributionOf` не делит на Σweights (`score.ts`)

Делит `ScoreBoardBuilder.build()`, потому что **только доска знает, какие стратегии реально отработали**. Отсюда бесплатный cold start: `applicable() === false` → вклада нет → вес уходит из обоих сумм → остальные перевзвешиваются сами.

### 3.4 Мелочи, тоже осознанные

- `CandidateSetBuilder.add()` при дубле берёт **max** retrievalScore, а не сумму: косинус и BM25 — несравнимые шкалы, складывать их бессмысленно.
- `CandidateSetBuilder.filter()` **перенумеровывает** строки. Устаревший индекс пришил бы фичи одного кандидата к score другого.
- `FeatureSchemaBuilder` отвергает нефинитный `defaultValue`: он подставляется при деградации, `NaN` отравил бы каждый score, который его читает.
- `HistoryIndex` сортирует события по времени при построении, чтобы ни одна стратегия не сортировала защитно.

---

## 4. Следующий шаг — Этап 2 (kernel)

Критерий приёмки из §22: **плагин с недостающей фичей падает на `build()`**; `use()` после `build()` бросает.

Что писать, в `packages/core/src/kernel/`:

1. **`token.ts` + `container.ts`** — типизированные токены, ~150 строк, без `reflect-metadata` и декораторов (§9). Скоупы: singleton и request (`container.child()`).
2. **`registry.ts`** — интерфейс `Registry`: то, что видит плагин. Только запись, без `build()`.
3. **`builder.ts`** — `EngineBuilder implements Registry`. Один объект, две роли (§8.0). `build()` — единственная граница мутабельности.
4. **`plugin.ts`** — `Plugin`, топологическая сортировка по `dependsOn`, цикл → `DEPENDENCY_CYCLE`.
5. **`config.ts`** — `ConfigSchema`, `ConfigResolver`, `ResolvedConfig`. `limits.maxCandidates` / `maxLimit` / `timeoutMs` **обязательны без дефолтов** (§23.3), отсутствие → `INVALID_CONFIG` на `build()`.
6. **Валидация графа фичей** (§8.4) — сердце этапа: каждая `requires` кем-то `provides`, иначе `MissingFeatureError` на старте; коллизии ключей; топологический порядок трансформов.

Все нужные коды ошибок уже объявлены в `kernel/errors.ts` — `MISSING_FEATURE`, `FEATURE_COLLISION`, `BUILDER_SEALED`, `DEPENDENCY_CYCLE`, `INVALID_CONFIG`, `SLOT_CONFLICT`, `REQUEST_LIMIT_EXCEEDED`, `PORT_FAILED`.

Дальше по плану §22: Этап 3 — pipeline (+ cancellation и error policy), Этап 4 — math.

---

## 5. Открытые хвосты

| Что | Состояние |
|---|---|
| **git remote** | Нет. Репозиторий чисто локальный |
| **CI** | `.github/workflows/ci.yml` написан, но **ни разу не запускался** — GitHub его не видел. Матрица Node 20/22/24 + Bun + Deno не подтверждена на практике |
| **Браузерный прогон** | В §23.5 заявлен, в CI пока не настроен (нужен `@vitest/browser` + playwright). Отложен до появления кода, который есть смысл гонять в браузере |
| **`profile.ts`** | Тестов своего файла нет, покрыт через `matrix.test.ts`. Работает, но при росте стоит вынести |
| **`ids.ts`** | Функции покрыты на 71% — `pluginName`, `strategyId` пока никем не вызываются. Само по себе не проблема |
| **ARCHITECTURE.md** | Не содержит решений из §3 этого файла. Внести при следующей ревизии |

### npm

Готово: организация **`recoengine` создана**, `npm org ls recoengine` → `waleron - owner`. 2FA включён на уровне `auth-and-writes`.

Не сделано и не нужно до Этапа 11: публикации нет. Учесть заранее — при `auth-and-writes` публикация из CI по обычному токену **работать не будет**, нужен granular access token либо Trusted Publishing через OIDC из GitHub Actions (предпочтительно: без долгоживущих секретов).

---

## 6. Грабли, на которые уже наступили

Чтобы не наступить второй раз:

- **`pnpm ci` ≠ `pnpm run ci`.** `ci` зарезервирована pnpm; вызов печатает ошибку и **возвращает 0**. Скрипт называется `verify`.
- **TypeScript 7.0 уже вышел, но взят 5.9.3.** У typedoc peer-диапазон кончается на `6.0.x`. Документация важнее скорости компилятора; вернуться к вопросу, когда typedoc догонит.
- **`npm org create` не существует.** У `npm org` только `set`/`rm`/`ls`; организация создаётся исключительно через веб (npmjs.com/org/create).
- **Включение 2FA отзывает действующие CLI-токены.** После этого `npm whoami` отвечает `401`, лечится повторным `npm login`.
- **`npm login` интерактивен** и умирает без stdin. Из фона не работает даже с `--auth-type=web`: печатает ссылку и всё равно спрашивает `Username`. Запускать в обычном терминале.
- **Biome 2.5:** `linter.rules.recommended` устарел в пользу `preset`; для папок нужен `!**/dist`, а не `!**/dist/**`.

---

## 7. Хронология

| Коммит | Что |
|---|---|
| `5808802` | Этап 0: каркас монорепо + машинные проверки архитектуры |
| `61f0f7f` | Переименование `ci` → `verify` (см. грабли) |
| `57d331c` | Аудит документа: 9 расхождений за три ревизии, включая пример, который не сходился |
| `4c3a408` | Этап 1 (1/2): ids, entities, схема, матрица, профиль, индекс истории |
| `ebd7f64` | Этап 1 (2/2): ScoreBoard, Candidate, Reason — доменный слой закрыт |
