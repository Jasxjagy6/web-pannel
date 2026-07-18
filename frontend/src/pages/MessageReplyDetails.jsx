/**
 * MessageReplyDetails — expandable per-recipient reply breakdown for a
 * finished send job.
 *
 * Shows, for every user the job messaged: which session sent to them,
 * when, and whether they have replied yet within the 24h tracking window.
 * Data comes from GET /messages/jobs/:id/replies (backed by
 * message_reply_tracking + the 24h reply scanner).
 */

import React, { useEffect, useState } from 'react';
import {
  Loader2, CheckCircle2, Clock, MessageSquare, Send, RefreshCcw, AlertTriangle,
} from 'lucide-react';
import { getJobReplyDetails } from '../api/messages';

function fmt(v) {
  if (!v) return '—';
  const d = new Date(v);
  return isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

export default function MessageReplyDetails({ jobId }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getJobReplyDetails(jobId);
      setData(res.data?.data || null);
    } catch (err) {
      setError(err?.response?.data?.error?.message || err?.response?.data?.error || err?.message || 'Failed to load reply details');
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
        <Loader2 className="h-4 w-4 animate-spin" /> Loading reply tracking…
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

  const { job, recipients } = data;
  const repliedCount = recipients.filter((r) => r.replied).length;
  const windowOpen = job.replyTrackingStatus === 'scanning';

  return (
    <div className="rounded-lg border border-white/5 bg-dark-900/60 p-4">
      {/* Summary bar */}
      <div className="mb-3 flex flex-wrap items-center gap-3 text-xs">
        <span className="flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-emerald-300">
          <CheckCircle2 className="h-3.5 w-3.5" />
          {repliedCount} replied
        </span>
        <span className="flex items-center gap-1.5 rounded-md border border-white/10 bg-white/5 px-2 py-1 text-gray-300">
          <MessageSquare className="h-3.5 w-3.5" />
          {recipients.length} messaged
        </span>
        <span className="flex items-center gap-1.5 rounded-md border border-sky-500/30 bg-sky-500/10 px-2 py-1 text-sky-200">
          <Send className="h-3.5 w-3.5" />
          {job.sentCount} sent
        </span>
        {windowOpen ? (
          <span className="flex items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-amber-200">
            <Clock className="h-3.5 w-3.5" />
            Tracking until {fmt(job.replyTrackingUntil)}
          </span>
        ) : (
          <span className="flex items-center gap-1.5 rounded-md border border-white/10 bg-white/5 px-2 py-1 text-gray-400">
            <Clock className="h-3.5 w-3.5" />
            {job.replyTrackingStatus ? `Tracking ${job.replyTrackingStatus}` : 'No reply tracking'}
          </span>
        )}
        <button
          type="button"
          onClick={load}
          className="ml-auto flex items-center gap-1 rounded-md border border-white/10 px-2 py-1 text-gray-300 hover:bg-white/5"
        >
          <RefreshCcw className="h-3.5 w-3.5" /> Refresh
        </button>
      </div>

      {recipients.length === 0 ? (
        <p className="px-1 py-3 text-sm text-gray-500">
          No recipients tracked for this job yet.
        </p>
      ) : (
        <div className="max-h-80 overflow-auto rounded-md border border-white/5">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-dark-800 text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-3 py-2 text-left font-medium">User</th>
                <th className="px-3 py-2 text-left font-medium">Sent by session</th>
                <th className="px-3 py-2 text-left font-medium">Sent at</th>
                <th className="px-3 py-2 text-left font-medium">Reply status</th>
              </tr>
            </thead>
            <tbody>
              {recipients.map((r, idx) => (
                <tr key={`${r.targetId}-${idx}`} className="border-t border-white/5 hover:bg-white/[0.02]">
                  <td className="px-3 py-2 text-gray-200">
                    <span className="font-medium">{r.label}</span>
                    {r.label !== r.targetId && (
                      <span className="ml-1 text-xs text-gray-600">({r.targetId})</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-gray-400">{r.sessionLabel}</td>
                  <td className="px-3 py-2 text-gray-500">{fmt(r.sentAt)}</td>
                  <td className="px-3 py-2">
                    {r.replied ? (
                      <span className="inline-flex items-center gap-1 rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-xs text-emerald-300">
                        <CheckCircle2 className="h-3 w-3" />
                        Replied {r.repliedAt ? `· ${fmt(r.repliedAt)}` : ''}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded border border-white/10 bg-white/5 px-1.5 py-0.5 text-xs text-gray-400">
                        <Clock className="h-3 w-3" />
                        Not replied yet
                      </span>
                    )}
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
