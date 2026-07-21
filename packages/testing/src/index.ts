/**
 * `@recoengine/testing` — fixtures and reusable port contracts for engines built on
 * `@recoengine/core`.
 *
 * Two halves. **Fixtures** are the synthetic parts every test hand-rolled until now — a
 * provider, a payload-copying extractor, a fixed clock, a request builder, an engine
 * assembler — collected so a test says what it means and nothing more. **Contracts** are
 * the reusable conformance checks of §20–§21: cancellation (§17.1) and error policy
 * (§17.2) are mandatory, determinism and well-formed scores are hygiene. Each contract is
 * a framework-agnostic async function that throws on violation, so it is one line inside
 * any test runner and pulls in no runner as a dependency.
 *
 * @packageDocumentation
 */

export {
  assertDeterministic,
  assertExplanationSums,
  assertExtractorErrorPolicy,
  assertHonoursCancellation,
  assertScoreModifier,
  assertScoresWellFormed,
  assertScoringStrategy,
  type ExtractorErrorPolicyOptions,
  type ModifierContractOptions,
  type StrategyContractOptions,
} from './contracts.js'
export {
  catalogueOf,
  constantStrategy,
  type EngineSpec,
  events,
  type FeatureRow,
  fixedClock,
  historyOf,
  itemsOf,
  passthroughStrategy,
  payloadExtractor,
  profileExtractor,
  RecoError,
  rankedIds,
  request,
  scoreById,
  TEST_LIMITS,
  testEngine,
  throwingExtractor,
} from './fixtures.js'
