export * from '../../config/schema-registry.js';

/**
 * Compatibility helper kept for older tests/callers. Field ownership is now
 * enforced by routeFieldPath(), not by requiring schema top-level disjointness.
 */
export function assertDisjointFields(): void {
  // no-op
}
