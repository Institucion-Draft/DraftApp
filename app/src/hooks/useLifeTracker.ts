import { useCallback, useEffect, useRef, useState } from 'react';
import { Animated } from 'react-native';

type Side = 'a' | 'b';

function clampLife(value: number): number {
  return Math.max(0, value);
}

type Params = {
  initialLifeA: number;
  initialLifeB: number;
  /** Called when the debounce timer fires. Screen owns the DB write and stable-state commit. */
  onFlush: (side: Side) => Promise<void>;
  /** Debounce delay in ms. Can change between calls (reads latest on each press). Default 3500. */
  delayMs?: number;
};

export function useLifeTracker({ initialLifeA, initialLifeB, onFlush, delayMs = 3500 }: Params) {
  const [stableA, setStableA] = useState(initialLifeA);
  const [stableB, setStableB] = useState(initialLifeB);
  const [pendingA, setPendingA] = useState<number | null>(null);
  const [pendingB, setPendingB] = useState<number | null>(null);

  const stableARef = useRef(initialLifeA);
  const stableBRef = useRef(initialLifeB);
  const pendingARef = useRef<number | null>(null);
  const pendingBRef = useRef<number | null>(null);
  const timerARef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const timerBRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep onFlush and delayMs as refs so the timer closure always reads the latest value.
  const onFlushRef = useRef(onFlush);
  useEffect(() => { onFlushRef.current = onFlush; });
  const delayMsRef = useRef(delayMs);
  useEffect(() => { delayMsRef.current = delayMs; });

  const diffOpacityA = useRef(new Animated.Value(0)).current;
  const diffOpacityB = useRef(new Animated.Value(0)).current;

  const lifeA = clampLife(pendingA ?? stableA);
  const lifeB = clampLife(pendingB ?? stableB);
  const deltaA = lifeA - stableA;
  const deltaB = lifeB - stableB;

  useEffect(() => {
    Animated.timing(diffOpacityA, {
      toValue: deltaA !== 0 ? 1 : 0,
      duration: 200,
      useNativeDriver: true,
    }).start();
  }, [deltaA, diffOpacityA]);

  useEffect(() => {
    Animated.timing(diffOpacityB, {
      toValue: deltaB !== 0 ? 1 : 0,
      duration: 200,
      useNativeDriver: true,
    }).start();
  }, [deltaB, diffOpacityB]);

  const clearTimers = useCallback(() => {
    if (timerARef.current) { clearTimeout(timerARef.current); timerARef.current = null; }
    if (timerBRef.current) { clearTimeout(timerBRef.current); timerBRef.current = null; }
  }, []);

  const clearPendingAdjustments = useCallback(() => {
    clearTimers();
    pendingARef.current = null;
    pendingBRef.current = null;
    setPendingA(null);
    setPendingB(null);
  }, [clearTimers]);

  const increment = useCallback((side: Side, amount: number) => {
    const stableRef = side === 'a' ? stableARef : stableBRef;
    const pendingRef = side === 'a' ? pendingARef : pendingBRef;
    const timerRef = side === 'a' ? timerARef : timerBRef;
    const setPending = side === 'a' ? setPendingA : setPendingB;

    const current = clampLife(pendingRef.current ?? stableRef.current);
    if (amount < 0 && current <= 0) return;
    const next = clampLife(current + amount);
    pendingRef.current = next;
    setPending(next);

    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      void onFlushRef.current(side);
    }, delayMsRef.current);
  }, []);

  /** Immediately flush side (cancels timer, calls onFlush now). */
  const flushAndPersist = useCallback((side: Side) => {
    const timerRef = side === 'a' ? timerARef : timerBRef;
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    return onFlushRef.current(side);
  }, []);

  const resetLife = useCallback((newLifeA: number, newLifeB: number) => {
    clearTimers();
    stableARef.current = newLifeA;
    stableBRef.current = newLifeB;
    pendingARef.current = null;
    pendingBRef.current = null;
    setStableA(newLifeA);
    setStableB(newLifeB);
    setPendingA(null);
    setPendingB(null);
  }, [clearTimers]);

  return {
    // Displayed life (computed)
    lifeA,
    lifeB,
    // State for rendering stable value (useful for undo comparisons)
    stableA,
    stableB,
    setStableA,
    setStableB,
    // Pending state
    pendingA,
    pendingB,
    setPendingA,
    setPendingB,
    // Refs for async-safe closure access
    stableARef,
    stableBRef,
    pendingARef,
    pendingBRef,
    timerARef,
    timerBRef,
    // Deltas and animations
    deltaA,
    deltaB,
    diffOpacityA,
    diffOpacityB,
    // Actions
    increment,
    flushAndPersist,
    clearTimers,
    clearPendingAdjustments,
    resetLife,
  };
}
