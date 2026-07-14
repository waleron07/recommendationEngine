declare const brand: unique symbol

/**
 * Nominal typing helper with zero runtime cost.
 *
 * `ItemId` and `UserId` are both strings, and mixing them up is the most common
 * bug in a recommendation engine. Branding turns that into a compile error while
 * emitting nothing at runtime.
 *
 * @example
 * ```ts
 * type ItemId = Brand<string, 'ItemId'>
 * type UserId = Brand<string, 'UserId'>
 *
 * declare const u: UserId
 * const i: ItemId = u // Error: 'UserId' is not assignable to 'ItemId'
 * ```
 */
export type Brand<T, B extends string> = T & { readonly [brand]: B }
