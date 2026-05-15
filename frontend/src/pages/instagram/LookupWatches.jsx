import { useEffect, useState } from 'react';
import { Eye, Plus, Trash2, Play, RefreshCw, Clock } from 'lucide-react';
import {
  listLookupWatches,
  createLookupWatch,
  deleteLookupWatch,
  runLookupWatchNow,
} from '@/api/lookup';
import { apiError } from '../../utils/apiError';
import { useToast } from '../../components/common/Toast';

const IG_GRADIENT = 'bg-gradient-to-tr from-[#f09433] via-[#dc2743] to-[#bc1888]';

export default function LookupWatches() {
  const toast = useToast();
  const [watches, setWatches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState({});
  const [newUsername, setNewUsername] = useState('');
  const [newCadence, setNewCadence] = useState('24');

  const refresh = async () => {
    setLoading(true);
    try {
      const { data } = await listLookupWatches();
      setWatches(data.data.watches || []);
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const onCreate = async () => {
    const u = newUsername.trim();
    if (!u) {
      toast.error('Username is required');
      return;
    }
    try {
      await createLookupWatch({ username: u, cadenceHours: Number(newCadence) || 24 });
      setNewUsername('');
      toast.success(`Watching @${u}`);
      await refresh();
    } catch (err) {
      toast.error(apiError(err));
    }
  };

  const onDelete = async (id) => {
    if (!confirm('Stop watching this username?')) return;
    try {
      await deleteLookupWatch(id);
      await refresh();
    } catch (err) {
      toast.error(apiError(err));
    }
  };

  const onRunNow = async (id) => {
    setRunning((p) => ({ ...p, [id]: true }));
    try {
      const { data } = await runLookupWatchNow(id);
      const diff = data?.data?.diff;
      if (diff && (diff.changed || diff.changed === undefined)) {
        toast.success(`Snapshot captured — ${diff.summary || 'first snapshot'}`);
      } else {
        toast.success('Snapshot captured');
      }
      await refresh();
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setRunning((p) => ({ ...p, [id]: false }));
    }
  };

  return (
    <div className="p-6 space-y-6">
      <div className={`${IG_GRADIENT} rounded-lg p-6 text-white shadow`}>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Eye className="w-6 h-6" />
          Watched Usernames
        </h1>
        <p className="mt-2 text-sm opacity-90">
          Longitudinal monitoring (Oracle 5). A background worker runs the recovery oracle
          on each watched username on a fixed cadence and surfaces a diff (new email/phone
          masks, recovery methods toggled, account-state changes) as findings.
        </p>
      </div>

      <div className="bg-white rounded-lg border p-4 shadow-sm">
        <div className="text-sm font-medium mb-2">Add a watch</div>
        <div className="flex flex-wrap gap-2 items-end">
          <div className="flex-1 min-w-[200px]">
            <label className="block text-xs text-gray-600 mb-1">Instagram username</label>
            <input
              className="w-full border rounded px-2 py-1.5 text-sm"
              placeholder="e.g. xjashan_"
              value={newUsername}
              onChange={(e) => setNewUsername(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-xs text-gray-600 mb-1">Cadence (hours)</label>
            <input
              type="number"
              min="1"
              max="168"
              className="border rounded px-2 py-1.5 text-sm w-24"
              value={newCadence}
              onChange={(e) => setNewCadence(e.target.value)}
            />
          </div>
          <button
            className="px-3 py-2 bg-pink-600 text-white rounded text-sm flex items-center gap-1 hover:bg-pink-700"
            onClick={onCreate}
          >
            <Plus className="w-4 h-4" /> Watch
          </button>
        </div>
      </div>

      <div className="bg-white rounded-lg border shadow-sm overflow-hidden">
        <div className="px-4 py-2 border-b flex items-center justify-between bg-gray-50 text-sm">
          <span className="font-medium">Active watches</span>
          <button
            className="text-gray-600 hover:text-gray-900 flex items-center gap-1"
            onClick={refresh}
          >
            <RefreshCw className="w-3.5 h-3.5" /> Refresh
          </button>
        </div>
        {loading ? (
          <div className="p-6 text-gray-500">Loading…</div>
        ) : watches.length === 0 ? (
          <div className="p-6 text-gray-500 text-sm">No watches yet.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-600">
              <tr>
                <th className="text-left px-3 py-2">Username</th>
                <th className="text-left px-3 py-2">Cadence</th>
                <th className="text-left px-3 py-2">Last run</th>
                <th className="text-left px-3 py-2">Next run</th>
                <th className="text-left px-3 py-2">Last findings</th>
                <th className="text-left px-3 py-2">Status</th>
                <th className="text-left px-3 py-2 w-32">Actions</th>
              </tr>
            </thead>
            <tbody>
              {watches.map((w) => (
                <tr key={w.id} className="border-t">
                  <td className="px-3 py-2 font-mono">@{w.username}</td>
                  <td className="px-3 py-2">{w.cadence_hours}h</td>
                  <td className="px-3 py-2 text-gray-600">
                    {w.last_run_at ? new Date(w.last_run_at).toLocaleString() : '—'}
                  </td>
                  <td className="px-3 py-2 text-gray-600">
                    <span className="inline-flex items-center gap-1">
                      <Clock className="w-3.5 h-3.5" />
                      {w.next_run_at ? new Date(w.next_run_at).toLocaleString() : 'queued'}
                    </span>
                  </td>
                  <td className="px-3 py-2">{w.last_findings_count || 0}</td>
                  <td className="px-3 py-2">
                    {w.cooldown_until && new Date(w.cooldown_until) > new Date()
                      ? <span className="text-amber-700">cooldown</span>
                      : w.active
                        ? <span className="text-green-700">active</span>
                        : <span className="text-gray-500">inactive</span>}
                  </td>
                  <td className="px-3 py-2 flex gap-2">
                    <button
                      className="px-2 py-1 text-xs border rounded flex items-center gap-1 hover:bg-gray-50 disabled:opacity-50"
                      onClick={() => onRunNow(w.id)}
                      disabled={!!running[w.id]}
                    >
                      <Play className="w-3 h-3" /> Run
                    </button>
                    <button
                      className="px-2 py-1 text-xs border border-red-300 text-red-600 rounded flex items-center gap-1 hover:bg-red-50"
                      onClick={() => onDelete(w.id)}
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
