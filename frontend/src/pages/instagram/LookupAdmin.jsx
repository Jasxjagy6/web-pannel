import { useEffect, useState } from 'react';
import { Activity, DollarSign, BarChart3, AlertTriangle, RefreshCw } from 'lucide-react';
import {
  getLookupRiskDashboard,
  getLookupBudget,
  setLookupBudget,
  getLookupUsage,
} from '@/api/lookup';
import { apiError } from '../../utils/apiError';
import { useToast } from '../../components/common/Toast';

const IG_GRADIENT = 'bg-gradient-to-tr from-[#f09433] via-[#dc2743] to-[#bc1888]';

function Card({ title, icon: Icon, children }) {
  return (
    <div className="bg-white rounded-lg border shadow-sm">
      <div className="px-4 py-2 border-b flex items-center gap-2 bg-gray-50">
        {Icon && <Icon className="w-4 h-4 text-gray-500" />}
        <span className="font-medium text-sm">{title}</span>
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

function fmtMs(v) {
  if (v == null) return '—';
  if (v >= 1000) return `${(v / 1000).toFixed(2)}s`;
  return `${Math.round(v)}ms`;
}

export default function LookupAdmin() {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [risk, setRisk] = useState(null);
  const [slo, setSlo] = useState(null);
  const [recentJobs, setRecentJobs] = useState([]);
  const [usage, setUsage] = useState(null);
  const [budget, setBudget] = useState(null);
  const [draftCap, setDraftCap] = useState('');

  const refresh = async () => {
    setLoading(true);
    try {
      const [{ data: dash }, { data: u }, { data: b }] = await Promise.all([
        getLookupRiskDashboard().catch(() => ({ data: { data: {} } })),
        getLookupUsage({ days: 7 }),
        getLookupBudget(),
      ]);
      setRisk(dash?.data?.risk || null);
      setSlo(dash?.data?.slo || null);
      setRecentJobs(dash?.data?.recentJobs || []);
      setUsage(u?.data?.rollup || null);
      setBudget(b?.data?.budget || null);
      if (b?.data?.budget?.cap_usd != null) setDraftCap(String(b.data.budget.cap_usd));
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const onSaveBudget = async () => {
    const cap = Number(draftCap);
    if (!Number.isFinite(cap) || cap < 0) {
      toast.error('Invalid budget cap');
      return;
    }
    try {
      const { data } = await setLookupBudget({ capUsd: cap });
      setBudget(data.data.budget);
      toast.success('Budget cap saved');
    } catch (err) {
      toast.error(apiError(err));
    }
  };

  return (
    <div className="p-6 space-y-6">
      <div className={`${IG_GRADIENT} rounded-lg p-6 text-white shadow`}>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <BarChart3 className="w-6 h-6" />
          Identity-Lookup Dashboard
        </h1>
        <p className="mt-2 text-sm opacity-90">
          Risk-score cohorts, latency SLOs, retention, and per-user budget. Admin-only.
        </p>
      </div>

      <div className="flex justify-end">
        <button
          className="text-gray-600 hover:text-gray-900 flex items-center gap-1 text-sm"
          onClick={refresh}
        >
          <RefreshCw className="w-3.5 h-3.5" /> Refresh
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card title="My budget (this month)" icon={DollarSign}>
          {loading ? 'Loading…' : (
            <>
              <div className="mb-2 text-sm">
                Cap: <strong>${budget?.cap_usd ?? '—'}</strong> &nbsp;|&nbsp;
                Spent: <strong>${budget?.spent_usd ?? 0}</strong>
              </div>
              <div className="flex gap-2">
                <input
                  type="number"
                  step="0.01"
                  className="border rounded px-2 py-1.5 text-sm w-32"
                  value={draftCap}
                  onChange={(e) => setDraftCap(e.target.value)}
                />
                <button
                  className="px-3 py-1.5 bg-pink-600 text-white rounded text-sm hover:bg-pink-700"
                  onClick={onSaveBudget}
                >
                  Save cap
                </button>
              </div>
              {budget?.warn_at_pct != null && (
                <div className="text-xs text-gray-500 mt-2">
                  Warn at {budget.warn_at_pct}% / hard-block at {budget.hard_block_at_pct ?? 100}%.
                </div>
              )}
            </>
          )}
        </Card>

        <Card title="Usage (last 7 days)" icon={Activity}>
          {loading || !usage ? 'Loading…' : (
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>Total jobs: <strong>{usage.total_jobs ?? 0}</strong></div>
              <div>Findings: <strong>{usage.total_findings ?? 0}</strong></div>
              <div>USD spent: <strong>${usage.total_usd_spent ?? '0'}</strong></div>
              <div>Avg findings/job: <strong>{usage.avg_findings_per_job ?? 0}</strong></div>
            </div>
          )}
        </Card>
      </div>

      <Card title="Latency SLO (p50 / p95 in ms)" icon={Activity}>
        {loading || !slo ? 'Loading…' : (
          <table className="w-full text-sm">
            <thead className="text-xs text-gray-500">
              <tr><th className="text-left">Stage</th><th className="text-left">p50</th><th className="text-left">p95</th><th className="text-left">n</th></tr>
            </thead>
            <tbody>
              {Object.entries(slo.stages || {}).map(([stage, v]) => (
                <tr key={stage} className="border-t">
                  <td className="py-1">stage {stage}</td>
                  <td>{fmtMs(v.p50)}</td>
                  <td>{fmtMs(v.p95)}</td>
                  <td>{v.n}</td>
                </tr>
              ))}
              <tr className="border-t font-medium">
                <td className="py-1">total</td>
                <td>{fmtMs(slo.total?.p50)}</td>
                <td>{fmtMs(slo.total?.p95)}</td>
                <td>{slo.total?.n}</td>
              </tr>
            </tbody>
          </table>
        )}
      </Card>

      <Card title="Burner risk cohorts" icon={AlertTriangle}>
        {loading || !risk ? 'Loading…' : (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            <div>Alive burners: <strong>{risk.burners_alive ?? 0}</strong></div>
            <div>Soft-blocked: <strong>{risk.burners_soft_blocked ?? 0}</strong></div>
            <div>Checkpoints (24h): <strong>{risk.checkpoints_last_24h ?? 0}</strong></div>
            <div>Recovered (24h): <strong>{risk.recovered_last_24h ?? 0}</strong></div>
          </div>
        )}
      </Card>

      <Card title="Recent jobs">
        {loading ? 'Loading…' : (
          <table className="w-full text-sm">
            <thead className="text-xs text-gray-500">
              <tr>
                <th className="text-left">#</th>
                <th className="text-left">User</th>
                <th className="text-left">Target</th>
                <th className="text-left">Status</th>
                <th className="text-left">Spent</th>
                <th className="text-left">Findings</th>
                <th className="text-left">Created</th>
              </tr>
            </thead>
            <tbody>
              {recentJobs.map((j) => (
                <tr key={j.id} className="border-t">
                  <td className="py-1 font-mono">{j.id}</td>
                  <td>{j.user_id}</td>
                  <td className="font-mono">@{j.username}</td>
                  <td>{j.status}</td>
                  <td>${j.budget_usd_spent}</td>
                  <td>{j.total_findings}</td>
                  <td className="text-xs text-gray-500">{new Date(j.created_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
