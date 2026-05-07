/**
 * DistributionPreview — visualises the rotation/cooldown plan
 * returned by the backend distributionPlanner. Pure presentation;
 * the parent passes in either a `plan` object or a function that
 * fetches one (debounced) when the inputs change.
 *
 * Renders:
 *   - headline KPIs (total items, sessions, rounds, est. duration)
 *   - per-session burst, cooldown range, per-item delay range
 *   - explanation text and warnings (e.g. "burst clamped",
 *     "0 sessions — nothing will run")
 */

import React from 'react';
import { BarChart3, Clock, Layers, Loader2, Users } from 'lucide-react';

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm ? `${h}h ${mm}m` : `${h}h`;
}

function Stat({ icon: Icon, label, value, sub }) {
  return (
    <div className="rounded-lg border border-white/5 bg-dark-900 p-3">
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-gray-500">
        {Icon ? <Icon className="h-3.5 w-3.5" /> : null}
        {label}
      </div>
      <div className="mt-1 text-lg font-semibold text-white">{value}</div>
      {sub ? <div className="mt-0.5 text-[11px] text-gray-500">{sub}</div> : null}
    </div>
  );
}

export default function DistributionPreview({
  plan,
  loading = false,
  error = null,
  emptyHint = 'Pick sessions and a target list to see how the work will be distributed.',
  className = '',
}) {
  if (error) {
    return (
      <div
        className={`rounded-xl border border-red-500/20 bg-red-500/5 p-4 text-sm text-red-300 ${className}`}
        data-testid="distribution-preview"
      >
        Could not compute the distribution plan: {error}
      </div>
    );
  }

  if (loading && !plan) {
    return (
      <div
        className={`rounded-xl border border-white/5 bg-dark-800 p-5 text-sm text-gray-400 ${className}`}
        data-testid="distribution-preview"
      >
        <div className="flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" />
          Computing distribution plan&hellip;
        </div>
      </div>
    );
  }

  if (!plan) {
    return (
      <div
        className={`rounded-xl border border-white/5 bg-dark-800 p-5 ${className}`}
        data-testid="distribution-preview"
      >
        <h3 className="mb-3 text-sm font-semibold text-white flex items-center gap-2">
          <BarChart3 className="h-4 w-4 text-primary-500" />
          Distribution Preview
        </h3>
        <p className="text-sm text-gray-500">{emptyHint}</p>
      </div>
    );
  }

  const totalItems = plan.totalItems || 0;
  const sessionCount = plan.sessionCount || 0;
  const rounds = plan.rounds ?? plan.totalRounds ?? 0;
  const burst = plan.perSessionBurst || 0;
  const cdMin = plan.cooldownSecMin ?? 0;
  const cdMax = plan.cooldownSecMax ?? 0;
  const idMin = plan.itemDelayMsMin ?? 0;
  const idMax = plan.itemDelayMsMax ?? 0;
  // Planner returns `estimatedMs: { min, max }`. Show the average
  // (mid-point) as the headline number, with both bounds in the sub.
  let eta = 0;
  let etaSub = null;
  if (plan.estimatedMs && plan.estimatedMs.max != null) {
    const lo = plan.estimatedMs.min || 0;
    const hi = plan.estimatedMs.max || 0;
    eta = Math.round((lo + hi) / 2);
    etaSub = lo === hi ? null : `${fmtDuration(lo)} – ${fmtDuration(hi)}`;
  } else if (plan.estimatedDurationMs) {
    eta = plan.estimatedDurationMs;
  }

  return (
    <div
      className={`rounded-xl border border-white/5 bg-dark-800 p-5 ${className}`}
      data-testid="distribution-preview"
    >
      <div className="mb-3 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-white">
          <BarChart3 className="h-4 w-4 text-primary-500" />
          Distribution Preview
        </h3>
        <span className="rounded-full border border-primary-500/30 bg-primary-500/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-primary-400">
          {plan.mode === 'manual' ? 'Manual' : 'Auto'}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Stat
          icon={Users}
          label="Items"
          value={totalItems.toLocaleString()}
        />
        <Stat
          icon={Layers}
          label="Sessions"
          value={sessionCount.toLocaleString()}
        />
        <Stat
          icon={BarChart3}
          label="Rounds"
          value={rounds.toLocaleString()}
          sub={burst ? `${burst}/session per round` : null}
        />
        <Stat
          icon={Clock}
          label="Est. duration"
          value={fmtDuration(eta)}
          sub={etaSub}
        />
      </div>

      <div className="mt-4 space-y-2 text-xs text-gray-300">
        <div className="flex justify-between border-t border-white/5 pt-2">
          <span className="text-gray-500">Per-session burst</span>
          <span className="font-mono">{burst}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-500">Cooldown between rotations</span>
          <span className="font-mono">
            {cdMin === cdMax ? `${cdMin}s` : `${cdMin}–${cdMax}s`}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-500">Per-item delay (in burst)</span>
          <span className="font-mono">
            {idMin === idMax ? `${idMin}ms` : `${idMin}–${idMax}ms`}
          </span>
        </div>
      </div>

      {Array.isArray(plan.notes) && plan.notes.length > 0 ? (
        <ul className="mt-3 space-y-1 text-[11px] text-amber-300">
          {plan.notes.map((note, i) => (
            <li key={i}>• {note}</li>
          ))}
        </ul>
      ) : null}

      {plan.explanation ? (
        <p className="mt-3 text-[11px] text-gray-500">{plan.explanation}</p>
      ) : null}
    </div>
  );
}
