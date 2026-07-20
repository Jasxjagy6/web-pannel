/**
 * MessageSessionBreakdown — per-session send breakdown for a finished job.
 *
 * Shows how many sessions were used (sent ≥1 successful DM) out of total
 * provided, and how many successful DMs each session sent.
 * Data comes from GET /messages/jobs/:id/session-breakdown.
 */

import React, { useEffect, useState } from 'react';
import {
  Loader2, CheckCircle2, Send, RefreshCcw, AlertTriangle, Users,
} from 'lucide-react';
import { getJobSessionBreakdown } from '../api/messages';

export default function MessageSessionBreakdown({ jobId }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getJobSessionBreakdown(jobId);
      setData(res.data?.data || null);
    } catch (err) {
      setError(err?.response?.data?.error?.message || err?.response?.data?.error || err?.message || 'Failed to load session breakdown');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 px-4 py-6 text-sm text-gray-400">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading session breakdown…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 px-4 py-4 text-sm text-red-300">
        <AlertTriangle className="h-4 w-4" /> {error}
      </div>
    );
  }

  if (!data) return null;

  const { sessionsUsed, sessionsProvided, sessions } = data;

  return (
    <div className="rounded-lg border border-white/5 bg-dark-900/60 p-4">
      {/* Summary bar */}
      <div className="mb-3 flex flex-wrap items-center gap-3 text-xs">
        <span className="flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-emerald-300">
          <Users className="h-3.5 w-3.5" />
          {sessionsUsed} / {sessionsProvided} sessions used
        </span>
        <button
          type="button"
          onClick={load}
          className="ml-auto flex items-center gap-1 rounded-md border border-white/10 px-2 py-1 text-gray-300 hover:bg-white/5"
        >
          <RefreshCcw className="h-3.5 w-3.5" /> Refresh
        </button>
      </div>

      {sessions.length === 0 ? (
        <p className="px-1 py-3 text-sm text-gray-500">
          No sessions sent any messages for this job.
        </p>
      ) : (
        <div className="max-h-80 overflow-auto rounded-md border border-white/5">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-dark-800 text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Session</th>
                <th className="px-3 py-2 text-right font-medium">Successful DMs</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s, idx) => (
                <tr key={`${s.sessionId}-${idx}`} className="border-t border-white/5 hover:bg-white/[0.02]">
                  <td className="px-3 py-2 text-gray-200">
                    <span className="font-medium">{s.sessionLabel}</span>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <span className="inline-flex items-center gap-1.5 rounded border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-sky-200">
                      <Send className="h-3 w-3" />
                      {s.sentCount}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
