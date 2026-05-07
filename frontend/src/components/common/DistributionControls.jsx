/**
 * DistributionControls — shared Auto / Manual mode picker used by
 * the Groups and Messaging pages. Hands the parent an opaque
 * `value` object that maps 1:1 to the backend's distribution-engine
 * fields:
 *
 *   {
 *     mode: 'auto' | 'manual',
 *     perSessionBurst?: number,
 *     cooldownSecMin?: number,
 *     cooldownSecMax?: number,
 *     itemDelayMsMin?: number,
 *     itemDelayMsMax?: number,
 *   }
 *
 * Only `mode` is required. In auto mode the backend planner picks
 * burst/cooldown/delay automatically based on items / sessions; the
 * controls collapse so the operator isn't tempted to overthink it.
 * In manual mode the operator can dial every knob within the safe
 * bounds advertised by `bounds` (defaulted from
 * distributionPlanner.js).
 */

import React from 'react';
import { Sparkles, SlidersHorizontal } from 'lucide-react';

const DEFAULT_BOUNDS = {
  perSessionBurst: { min: 1, max: 500 },
  cooldownSec: { min: 0, max: 1800 },
  itemDelayMs: { min: 0, max: 600000 },
};

function NumberField({ label, value, onChange, min, max, step = 1, suffix }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-gray-400">
      <span>{label}</span>
      <div className="flex items-center gap-1">
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={value === undefined || value === null ? '' : value}
          onChange={(e) => {
            const v = e.target.value;
            if (v === '') {
              onChange(undefined);
            } else {
              onChange(Math.max(min, Math.min(max, Number(v))));
            }
          }}
          className="w-full rounded border border-white/10 bg-dark-900 px-2 py-1 text-sm text-white focus:outline-none focus:ring-1 focus:ring-primary-500"
        />
        {suffix ? <span className="text-xs text-gray-500">{suffix}</span> : null}
      </div>
    </label>
  );
}

export default function DistributionControls({
  value,
  onChange,
  workType = 'group_add',
  bounds = DEFAULT_BOUNDS,
  className = '',
}) {
  const v = value || { mode: 'auto' };
  const set = (patch) => onChange({ ...v, ...patch });
  const isManual = v.mode === 'manual';

  return (
    <div
      className={`rounded-xl border border-white/5 bg-dark-800 p-4 ${className}`}
      data-testid="distribution-controls"
    >
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white">
          Distribution mode
        </h3>
        <span className="text-[10px] uppercase tracking-wider text-gray-500">
          {workType === 'bulk_message' ? 'Bulk DM' : 'Add Members'}
        </span>
      </div>

      <div className="mb-3 grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => set({ mode: 'auto' })}
          className={`flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition ${
            !isManual
              ? 'border-primary-500/50 bg-primary-500/10 text-primary-400'
              : 'border-white/10 bg-dark-900 text-gray-400 hover:border-white/20'
          }`}
        >
          <Sparkles className="h-3.5 w-3.5" />
          Auto
        </button>
        <button
          type="button"
          onClick={() => set({ mode: 'manual' })}
          className={`flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition ${
            isManual
              ? 'border-primary-500/50 bg-primary-500/10 text-primary-400'
              : 'border-white/10 bg-dark-900 text-gray-400 hover:border-white/20'
          }`}
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
          Manual
        </button>
      </div>

      {!isManual ? (
        <p className="text-xs text-gray-400">
          The panel will choose a safe per-session burst size and
          cooldown window based on how many items you're processing
          and how many sessions are selected. Recommended unless you
          have specific Telegram limits to honour.
        </p>
      ) : (
        <div className="space-y-3">
          <NumberField
            label="Per-session burst (items per round)"
            value={v.perSessionBurst}
            onChange={(n) => set({ perSessionBurst: n })}
            min={bounds.perSessionBurst.min}
            max={bounds.perSessionBurst.max}
          />

          <div>
            <p className="mb-1 text-xs text-gray-400">
              Cooldown between rotations
            </p>
            <div className="grid grid-cols-2 gap-2">
              <NumberField
                label="Min"
                value={v.cooldownSecMin}
                onChange={(n) => {
                  const max = v.cooldownSecMax;
                  set({
                    cooldownSecMin: n,
                    cooldownSecMax: max != null && n != null && max < n ? n : max,
                  });
                }}
                min={bounds.cooldownSec.min}
                max={bounds.cooldownSec.max}
                suffix="s"
              />
              <NumberField
                label="Max"
                value={v.cooldownSecMax}
                onChange={(n) => {
                  const min = v.cooldownSecMin;
                  set({
                    cooldownSecMax: n,
                    cooldownSecMin: min != null && n != null && min > n ? n : min,
                  });
                }}
                min={bounds.cooldownSec.min}
                max={bounds.cooldownSec.max}
                suffix="s"
              />
            </div>
          </div>

          <div>
            <p className="mb-1 text-xs text-gray-400">
              Per-item delay (within a burst)
            </p>
            <div className="grid grid-cols-2 gap-2">
              <NumberField
                label="Min"
                value={v.itemDelayMsMin}
                onChange={(n) => {
                  const max = v.itemDelayMsMax;
                  set({
                    itemDelayMsMin: n,
                    itemDelayMsMax: max != null && n != null && max < n ? n : max,
                  });
                }}
                min={bounds.itemDelayMs.min}
                max={bounds.itemDelayMs.max}
                step={100}
                suffix="ms"
              />
              <NumberField
                label="Max"
                value={v.itemDelayMsMax}
                onChange={(n) => {
                  const min = v.itemDelayMsMin;
                  set({
                    itemDelayMsMax: n,
                    itemDelayMsMin: min != null && n != null && min > n ? n : min,
                  });
                }}
                min={bounds.itemDelayMs.min}
                max={bounds.itemDelayMs.max}
                step={100}
                suffix="ms"
              />
            </div>
          </div>

          <p className="text-[11px] text-gray-500">
            Values are clamped to safe bounds server-side. Cooldown
            is the pause between each full rotation across sessions.
          </p>
        </div>
      )}
    </div>
  );
}
