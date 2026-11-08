import { useReducedMotion } from 'motion/react';
import { springs } from './tokens';

export type SpringName = keyof typeof springs;

/** A Motion spring from the app's two designer parameters (critically damped unless momentum). */
export function spring(name: SpringName) {
  return { type: 'spring' as const, ...springs[name] };
}

/**
 * Enter/exit variants for a panel: opacity + 8 px rise + 0.97 scale on the `reveal` spring;
 * opacity only under Reduce Motion (the app's VerdictPanel does the same).
 */
export function useEnter(name: SpringName = 'reveal') {
  const reduced = useReducedMotion();
  return reduced
    ? {
        initial: { opacity: 0 },
        animate: { opacity: 1 },
        exit: { opacity: 0 },
        transition: { duration: 0.18 },
      }
    : {
        initial: { opacity: 0, y: 8, scale: 0.97 },
        animate: { opacity: 1, y: 0, scale: 1 },
        exit: { opacity: 0, y: 4, scale: 0.98, transition: { duration: 0.2 } },
        transition: spring(name),
      };
}

export { useReducedMotion };
