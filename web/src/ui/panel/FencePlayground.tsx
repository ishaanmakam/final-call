import { MAX_ACCURACY_M } from '@final-call/rules';
import { animate, motion, useMotionValue } from 'motion/react';
import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { memberById, previewVerdict } from '../../sim';
import { useReducedMotion } from '../motion';
import { springs } from '../tokens';
import { actions, useWorld } from '../store';

/** The map shows this many metres across. */
const SPAN_M = 440;
const SIZE = 340;
const PX_PER_M = SIZE / SPAN_M;
const STEP_M = 5;
const BIG_STEP_M = 25;

const toPx = (m: number) => m * PX_PER_M;

/**
 * Your place (a circle of radius r) with a draggable GPS dot and a draggable accuracy ring. The
 * readout is the oracle's `checkinVerdict`, in words and as the inequality it checks. Both handles
 * track the pointer 1:1 and are keyboard-operable (arrows; Shift for 25 m).
 */
export function FencePlayground() {
  const w = useWorld();
  const reduced = useReducedMotion();
  const place = memberById(w, 'you').place;
  const { dx, dy, accuracyM } = w.you;
  const v = previewVerdict(w);
  const distance = Math.round(v.distanceM);
  const cx = SIZE / 2;
  const cy = SIZE / 2;

  // the dot's drawn position: follows the store, and springs home (bounce: it carried momentum)
  // when a drag is released outside the map
  const mx = useMotionValue(cx + toPx(dx));
  const my = useMotionValue(cy - toPx(dy));
  useEffect(() => {
    const tx = cx + toPx(dx);
    const ty = cy - toPx(dy);
    if (dragging.current) {
      mx.set(tx);
      my.set(ty);
      return;
    }
    const opts = reduced ? { duration: 0 } : { type: 'spring' as const, ...springs.snapBack };
    const a = animate(mx, tx, opts);
    const b = animate(my, ty, opts);
    return () => {
      a.stop();
      b.stop();
    };
  }, [dx, dy, cx, cy, mx, my, reduced]);

  const dragging = useRef<null | 'dot' | 'ring'>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const toMetres = (e: PointerEvent) => {
    const rect = svgRef.current!.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * SIZE;
    const py = ((e.clientY - rect.top) / rect.height) * SIZE;
    return { mx: (px - cx) / PX_PER_M, my: -(py - cy) / PX_PER_M };
  };

  const onDotDown = (e: PointerEvent<SVGGElement>) => {
    (e.target as Element).setPointerCapture(e.pointerId);
    dragging.current = 'dot';
  };
  const onRingDown = (e: PointerEvent<SVGGElement>) => {
    (e.target as Element).setPointerCapture(e.pointerId);
    dragging.current = 'ring';
  };
  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    if (!dragging.current) return;
    const m = toMetres(e);
    if (dragging.current === 'dot') {
      // 1:1 with the pointer; rubber-band only past the edge of the map
      const limit = SPAN_M / 2 - 8;
      actions.setGps({ dx: clampSoft(m.mx, limit), dy: clampSoft(m.my, limit) });
    } else {
      const r = Math.hypot(m.mx - dx, m.my - dy);
      actions.setGps({ accuracyM: Math.max(1, Math.min(260, r)) });
    }
  };
  const onUp = () => {
    dragging.current = null;
  };

  const onDotKey = (e: KeyboardEvent) => {
    const step = e.shiftKey ? BIG_STEP_M : STEP_M;
    const map: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    const d = map[e.key];
    if (!d) return;
    e.preventDefault();
    actions.setGps({ dx: dx + d[0], dy: dy + d[1] });
  };
  const onRingKey = (e: KeyboardEvent) => {
    const step = e.shiftKey ? BIG_STEP_M : STEP_M;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
      e.preventDefault();
      actions.setGps({ accuracyM: Math.min(260, accuracyM + step) });
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
      e.preventDefault();
      actions.setGps({ accuracyM: Math.max(1, accuracyM - step) });
    }
  };

  const verdictWord = v.verdict === 'in_fence' ? 'in fence' : v.verdict === 'out_of_fence' ? 'out of fence' : 'unjudgeable';
  const formula =
    v.verdict === 'unjudgeable'
      ? `accuracy ${accuracyM} > ${MAX_ACCURACY_M} m limit → Unverified, no money moves`
      : `${distance} − ${accuracyM} ${v.verdict === 'in_fence' ? '≤' : '>'} ${place.radiusM}`;
  const ringColor = v.verdict === 'in_fence' ? 'var(--success)' : 'var(--unverified)';

  return (
    <div className="fence">
      <svg ref={svgRef} viewBox={`0 0 ${SIZE} ${SIZE}`} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} role="group" aria-label="Fence playground map">
        <defs>
          <pattern id="grid" width={toPx(50)} height={toPx(50)} patternUnits="userSpaceOnUse" x={cx % toPx(50)} y={cy % toPx(50)}>
            <path d={`M ${toPx(50)} 0 L 0 0 0 ${toPx(50)}`} fill="none" stroke="var(--separator)" strokeWidth="0.5" />
          </pattern>
        </defs>
        <rect width={SIZE} height={SIZE} fill="url(#grid)" />
        {/* scale bar: 50 m */}
        <g transform={`translate(${SIZE - 14 - toPx(50)}, ${SIZE - 16})`} fill="var(--secondary)" fontSize="10" fontWeight="500">
          <path d={`M0 0h${toPx(50)}`} stroke="var(--secondary)" strokeWidth="1.5" />
          <path d={`M0 -3v6M${toPx(50)} -3v6`} stroke="var(--secondary)" strokeWidth="1.5" />
          <text x={toPx(50) / 2} y="-6" textAnchor="middle">
            50 m
          </text>
        </g>
        {/* your place: the fence */}
        <circle cx={cx} cy={cy} r={toPx(place.radiusM)} fill="var(--tint)" fillOpacity="0.1" stroke="var(--tint)" strokeWidth="1.5" />
        <circle cx={cx} cy={cy} r="3" fill="var(--tint)" />
        <text x={cx} y={cy - toPx(place.radiusM) - 8} textAnchor="middle" fontSize="12" fontWeight="600" fill="var(--tint)">
          {place.label} · {place.radiusM} m
        </text>
        {/* accuracy ring */}
        <motion.g style={{ x: mx, y: my }}>
          <circle r={toPx(accuracyM)} fill={ringColor} fillOpacity="0.1" stroke={ringColor} strokeWidth="1.5" strokeDasharray="4 3" />
          <line x1="0" y1="0" x2={toPx(accuracyM)} y2="0" stroke={ringColor} strokeWidth="1" strokeOpacity="0.6" />
          <g className="handle" tabIndex={0} role="slider" aria-label="GPS accuracy radius" aria-valuemin={1} aria-valuemax={260} aria-valuenow={accuracyM} aria-valuetext={`plus or minus ${accuracyM} metres`} onPointerDown={onRingDown} onKeyDown={onRingKey} transform={`translate(${toPx(accuracyM)}, 0)`}>
            <circle r="14" fill="transparent" />
            <circle className="focus-ring" r="10" fill="none" stroke="transparent" />
            <circle r="7" fill="var(--surface-elevated)" stroke={ringColor} strokeWidth="2" />
          </g>
          {/* GPS dot */}
          <g className="handle" tabIndex={0} role="application" aria-roledescription="draggable point" aria-label={`Your GPS fix, ${dx} metres east and ${dy} metres north of the centre; arrow keys move it`} onPointerDown={onDotDown} onKeyDown={onDotKey}>
            <circle r="16" fill="transparent" />
            <circle className="focus-ring" r="13" fill="none" stroke="transparent" />
            <circle r="9" fill="var(--surface-elevated)" />
            <circle r="7" fill={ringColor} />
          </g>
        </motion.g>
      </svg>
      <div className="readout" aria-live="polite">
        <span>
          distance <b className="tabular">{distance} m</b> · accuracy <b className="tabular">±{accuracyM} m</b> → <span className={`verdict ${v.verdict}`}>{verdictWord}</span>
        </span>
        <span className="formula">{formula}</span>
      </div>
      <div className="row between">
        <label className="t-footnote c-secondary" htmlFor="acc-slider">
          Accuracy ±{accuracyM} m
        </label>
        <span className="t-footnote c-secondary">
          {dx} m E · {dy} m N
        </span>
      </div>
      <input id="acc-slider" type="range" min={1} max={260} value={accuracyM} onChange={(e) => actions.setGps({ accuracyM: Number(e.target.value) })} aria-label="GPS accuracy in metres" />
      <div className="row">
        <button type="button" className="btn xsmall" onClick={() => actions.setGps({ dx: 0, dy: 0, accuracyM: 12 })}>
          At the centre, ±12 m
        </button>
        <button type="button" className="btn xsmall" onClick={() => actions.setGps({ dx: 60, dy: 40, accuracyM: 30 })}>
          Edge, ±30 m
        </button>
        <button type="button" className="btn xsmall" onClick={() => actions.setGps({ dx: 140, dy: 0, accuracyM: 12 })}>
          Across the street
        </button>
        <button type="button" className="btn xsmall" onClick={() => actions.setGps({ accuracyM: 350 })}>
          Weak GPS ±350
        </button>
      </div>
    </div>
  );
}

/** Follows the pointer inside the map; past the edge the overshoot is damped like a scroll view. */
function clampSoft(v: number, limit: number): number {
  const a = Math.abs(v);
  if (a <= limit) return v;
  const over = a - limit;
  const damped = (over * limit * 0.55) / (limit + 0.55 * over);
  return Math.sign(v) * (limit + damped);
}
