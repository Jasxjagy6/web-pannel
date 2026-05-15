import { useEffect, useState } from 'react';
import { Key, Save, Trash2, Eye, EyeOff, CheckCircle2 } from 'lucide-react';
import {
  listLookupKeys,
  upsertLookupKey,
  deleteLookupKey,
} from '@/api/lookup';
import { apiError } from '../../utils/apiError';
import { useToast } from '../../components/common/Toast';

const IG_GRADIENT = 'bg-gradient-to-tr from-[#f09433] via-[#dc2743] to-[#bc1888]';

const PROVIDER_LABELS = {
  dehashed:      'Dehashed (breach DB)',
  leakcheck:     'LeakCheck (breach DB)',
  snusbase:      'Snusbase (breach DB)',
  intelligencex: 'IntelligenceX (breach DB)',
  hibp:          'Have I Been Pwned',
  serpapi:       'SerpAPI (Google/Yandex reverse image)',
  pimeyes:       'PimEyes (face reverse search)',
  tineye:        'TinEye (reverse image)',
  whoisxml:      'WHOIS-XML (domain WHOIS)',
  whoxy:         'Whoxy (domain WHOIS fallback)',
  '2captcha':    '2captcha (CAPTCHA solver)',
};

export default function LookupKeys() {
  const toast = useToast();
  const [keys, setKeys] = useState([]);
  const [configured, setConfigured] = useState({});
  const [providers, setProviders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [drafts, setDrafts] = useState({});
  const [showKey, setShowKey] = useState({});

  const refresh = async () => {
    setLoading(true);
    try {
      const { data } = await listLookupKeys();
      setKeys(data.data.keys || []);
      setConfigured(data.data.configured || {});
      setProviders(data.data.providers || []);
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const onSave = async (prov) => {
    const d = drafts[prov] || {};
    if (!d.key) {
      toast.error('Key is required');
      return;
    }
    try {
      await upsertLookupKey({
        provider: prov,
        key: d.key,
        meta: d.meta ? { username: d.meta } : {},
        label: d.label || null,
      });
      toast.success(`${PROVIDER_LABELS[prov] || prov} key saved`);
      setDrafts((p) => ({ ...p, [prov]: {} }));
      await refresh();
    } catch (err) {
      toast.error(apiError(err));
    }
  };

  const onDelete = async (prov) => {
    if (!confirm(`Delete ${PROVIDER_LABELS[prov] || prov} key?`)) return;
    try {
      await deleteLookupKey(prov);
      toast.success('Key deleted');
      await refresh();
    } catch (err) {
      toast.error(apiError(err));
    }
  };

  return (
    <div className="p-6 space-y-6">
      <div className={`${IG_GRADIENT} rounded-lg p-6 text-white shadow`}>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Key className="w-6 h-6" />
          Identity-Lookup API Keys
        </h1>
        <p className="mt-2 text-sm opacity-90">
          Per-user encrypted vault for paid lookup providers (Dehashed, LeakCheck, Snusbase,
          IntelligenceX, HIBP, SerpAPI, PimEyes, TinEye, WHOIS-XML, Whoxy, 2captcha).
          Keys stored AES-256-GCM. Env vars are still used as a fallback when no per-user key is set.
        </p>
      </div>

      {loading ? (
        <div className="text-gray-500">Loading…</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {providers.map((prov) => {
            const existing = keys.find((k) => k.provider === prov);
            const isConfigured = !!configured[prov];
            const draft = drafts[prov] || {};
            return (
              <div key={prov} className="bg-white rounded-lg border p-4 shadow-sm">
                <div className="flex items-center justify-between mb-2">
                  <div className="font-medium">{PROVIDER_LABELS[prov] || prov}</div>
                  <div className="flex items-center gap-2">
                    {isConfigured && (
                      <span className="flex items-center gap-1 text-xs text-green-700">
                        <CheckCircle2 className="w-3.5 h-3.5" /> configured
                      </span>
                    )}
                  </div>
                </div>

                {existing && (
                  <div className="text-xs text-gray-600 mb-2">
                    Last updated {new Date(existing.updated_at).toLocaleString()} — used{' '}
                    {existing.last_used_at
                      ? new Date(existing.last_used_at).toLocaleString()
                      : 'never'}
                  </div>
                )}

                <div className="space-y-2">
                  {prov === 'dehashed' && (
                    <input
                      className="w-full border rounded px-2 py-1.5 text-sm"
                      placeholder="Dehashed username (email)"
                      value={draft.meta || ''}
                      onChange={(e) =>
                        setDrafts((p) => ({ ...p, [prov]: { ...draft, meta: e.target.value } }))
                      }
                    />
                  )}
                  <div className="flex gap-2">
                    <input
                      className="flex-1 border rounded px-2 py-1.5 text-sm font-mono"
                      type={showKey[prov] ? 'text' : 'password'}
                      placeholder={existing ? '••••••••• (enter new key to replace)' : 'API key'}
                      value={draft.key || ''}
                      onChange={(e) =>
                        setDrafts((p) => ({ ...p, [prov]: { ...draft, key: e.target.value } }))
                      }
                    />
                    <button
                      className="px-2 py-1.5 border rounded text-gray-600"
                      onClick={() => setShowKey((p) => ({ ...p, [prov]: !p[prov] }))}
                      title="Show/hide"
                    >
                      {showKey[prov] ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>

                  <input
                    className="w-full border rounded px-2 py-1.5 text-sm"
                    placeholder="Optional label (e.g. 'team account')"
                    value={draft.label || ''}
                    onChange={(e) =>
                      setDrafts((p) => ({ ...p, [prov]: { ...draft, label: e.target.value } }))
                    }
                  />

                  <div className="flex gap-2 pt-1">
                    <button
                      className="flex-1 px-3 py-1.5 text-sm bg-pink-600 text-white rounded flex items-center justify-center gap-1 hover:bg-pink-700"
                      onClick={() => onSave(prov)}
                    >
                      <Save className="w-4 h-4" /> Save
                    </button>
                    {existing && (
                      <button
                        className="px-3 py-1.5 text-sm border border-red-300 text-red-600 rounded flex items-center gap-1 hover:bg-red-50"
                        onClick={() => onDelete(prov)}
                      >
                        <Trash2 className="w-4 h-4" /> Delete
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
