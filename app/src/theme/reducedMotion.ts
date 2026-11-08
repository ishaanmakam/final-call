/**
 * Reduced motion keeps changes that explain state (opacity, color) and drops movement
 * (translate, scale, rotate, overshoot). Pure, so the mapping is unit-tested.
 */

export type TransformPart = { [key: string]: number | string | undefined };

export interface MotionStyle {
  opacity?: number;
  transform?: TransformPart[];
  [key: string]: unknown;
}

const MOVEMENT_KEYS = new Set([
  'translateX',
  'translateY',
  'scale',
  'scaleX',
  'scaleY',
  'rotate',
  'rotateX',
  'rotateY',
  'rotateZ',
  'skewX',
  'skewY',
  'perspective',
]);

/**
 * Given the style an animation would reach when motion is allowed, return the style to use
 * under reduced motion: opacity and non-transform properties survive, movement is removed.
 * `transform` disappears entirely when nothing is left, so callers can spread the result.
 */
export function reduceMotionStyle<S extends MotionStyle>(style: S): S {
  const { transform, ...rest } = style;
  if (!transform) return style;
  const kept = transform.filter((part) => !Object.keys(part).some((k) => MOVEMENT_KEYS.has(k)));
  return (kept.length > 0 ? { ...rest, transform: kept } : rest) as S;
}

/** Springs lose overshoot under reduced motion: damping ratio is forced to 1. */
export function reduceMotionSpring<T extends { dampingRatio: number }>(config: T): T {
  return config.dampingRatio === 1 ? config : { ...config, dampingRatio: 1 };
}
