import type { Brand } from './brand.js'

/** Identifies an item being recommended. */
export type ItemId = Brand<string, 'ItemId'>

/** Identifies the user a recommendation is for. */
export type UserId = Brand<string, 'UserId'>

/** Identifies a single interaction event. */
export type EventId = Brand<string, 'EventId'>

/** Identifies a scoring strategy. Also the key its weight is configured under. */
export type StrategyId = Brand<string, 'StrategyId'>

/** Identifies a feature. Declared by an extractor, required by a strategy. */
export type FeatureKey = Brand<string, 'FeatureKey'>

/** Identifies a plugin. */
export type PluginName = Brand<string, 'PluginName'>

/**
 * Milliseconds since the Unix epoch, UTC.
 *
 * Branded because the engine mixes durations and instants constantly (`now - lastSeen`),
 * and a bare `number` lets you subtract a day-count from an instant without complaint.
 */
export type Timestamp = Brand<number, 'Timestamp'>

/**
 * These constructors are the only sanctioned way into a branded type, and they are
 * deliberately unchecked casts rather than validators.
 *
 * Ids come from the host application's database, where the notion of "valid" belongs.
 * A library-level opinion (non-empty? no colons? uuid?) would be wrong for someone,
 * and the check would run once per candidate on the hot path to enforce it. The brand
 * buys type separation, not validation — those are different jobs.
 */
export const itemId = (value: string): ItemId => value as ItemId
export const userId = (value: string): UserId => value as UserId
export const eventId = (value: string): EventId => value as EventId
export const strategyId = (value: string): StrategyId => value as StrategyId
export const featureKey = (value: string): FeatureKey => value as FeatureKey
export const pluginName = (value: string): PluginName => value as PluginName
export const timestamp = (value: number): Timestamp => value as Timestamp
