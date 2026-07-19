/**
 * AiChat — management page for the Telegram AI auto-responder.
 *
 * Lists every Telegram session for the current user with a master AI
 * toggle.  Expanded session cards show every dialog for that session
 * with a per-chat AI toggle and memory-clear action, plus recent AI
 * response logs.
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
  Loader2,
  RefreshCcw,
  Bot,
  MessageSquare,
  Trash2,
  ChevronDown,
  ChevronUp,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Clock,
  Users,
  Megaphone,
  User as UserIcon,
  Database,
  Activity,
  Power,
  PowerOff,
} from 'lucide-react';
import { listClientSessions, getClientDialogs } from '../api/telegramClient';
import {
  getAiSessionSettings,
  updateAiSessionSettings,
  getAiChatSettings,
  updateAiChatSettings,
  clearAiChatMemory,
  getAiLogs,
  getCupidbotKey,
  setCupidbotKey,
  deleteCupidbotKey,
  getCapitalbotKey,
  setCapitalbotKey,
  updateCapitalbotModelPreset,
  fetchCapitalbotModels,
  getMyCapitalbotModels,
  deleteCapitalbotKey,
  seedAiChatMemory,
  bulkToggleAiSessions,
} from '../api/aiChat';
import { usePlatform } from '../context/PlatformContext';
import { useToast } from '../components/common/Toast';
import Avatar from '../components/telegramClient/Avatar';
import AiChatTracking from './AiChatTracking';

const PEER_LABEL = { user: 'User', chat: 'Group', channel: 'Channel' };

const AI_PROVIDERS = [
  { id: 'cupidbot', label: 'CupidBot', desc: 'OFM-focused AI chat automation.' },
  { id: 'capitalbot', label: 'CapitalBot', desc: 'Multi-platform AI chat automation.' },
];

function _statusPill(status) {
  if (status === 'sent')
    return { label: 'Sent', tone: 'emerald', Icon: CheckCircle2 };
  if (status === 'failed')
    return { label: 'Failed', tone: 'red', Icon: XCircle };
  if (status === 'no_reply')
    return { label: 'No reply', tone: 'gray', Icon: MessageSquare };
  return { label: status, tone: 'gray', Icon: Clock };
}

const TONE_CLASSES = {
  emerald: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30',
  red:     'bg-red-500/10 text-red-300 border-red-500/30',
  gray:    'bg-white/5 text-gray-300 border-white/10',
};

function _peerKey(peerType, peerId) {
  return `${peerType}:${peerId}`;
}

function _formatPreview(msg) {
  if (!msg) return '';
  if (msg.text) return msg.text;
  if (msg.hasMedia) return '[media]';
  return '';
}

export default function AiChat() {
  const { platform } = usePlatform();
  const toast = useToast();
  const isTelegram = platform === 'telegram';

  const [activeTab, setActiveTab] = useState('manage');

  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [settingsMap, setSettingsMap] = useState({});
  const [dialogsMap, setDialogsMap] = useState({});
  const [chatSettingsMap, setChatSettingsMap] = useState({});
  const [logsMap, setLogsMap] = useState({});
  const [togglingId, setTogglingId] = useState(null);
  const [bulkToggling, setBulkToggling] = useState(false);
  const [chatToggling, setChatToggling] = useState(null);
  const [clearing, setClearing] = useState(null);
  const [seeding, setSeeding] = useState(null);
  const [dialogsLoading, setDialogsLoading] = useState(null);
  const [keyStatusByProvider, setKeyStatusByProvider] = useState({
    cupidbot: null,
    capitalbot: null,
  });
  const [keyDraft, setKeyDraft] = useState('');
  const [keySaving, setKeySaving] = useState(false);
  const [keyError, setKeyError] = useState(null);
  const [activeKeyProvider, setActiveKeyProvider] = useState('cupidbot');
  const [modelIdDraft, setModelIdDraft] = useState('');
  const [presetIdDraft, setPresetIdDraft] = useState('');
  const [availableModels, setAvailableModels] = useState([]);
  const [availablePresets, setAvailablePresets] = useState([]);
  const [showModelPresetForm, setShowModelPresetForm] = useState(false);
  const [modelPresetSaving, setModelPresetSaving] = useState(false);
  const [modelCustomMode, setModelCustomMode] = useState(false);

  const loadSessions = async () => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await listClientSessions();
      const list = data?.data?.sessions || [];
      setSessions(list);
      const settings = {};
      await Promise.all(
        list.map(async (s) => {
          try {
            const { data: st } = await getAiSessionSettings(s.id);
            settings[s.id] = st?.data || { enabled: false, config: {} };
          } catch {
            settings[s.id] = { enabled: false, config: {} };
          }
        })
      );
      setSettingsMap(settings);
    } catch (err) {
      setError(err?.response?.data?.error || err?.message || 'Failed to load sessions');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!isTelegram) return;
    loadSessions();
    Promise.all([
      getCupidbotKey().then((res) => res?.data?.data || null).catch(() => ({ hasKey: false, isValid: false, isAdmin: false })),
      getCapitalbotKey().then((res) => res?.data?.data || null).catch(() => ({ hasKey: false, isValid: false, isAdmin: false })),
    ]).then(([cupidbotStatus, capitalbotStatus]) => {
      setKeyStatusByProvider({
        cupidbot: cupidbotStatus,
        capitalbot: capitalbotStatus,
      });
      if (capitalbotStatus?.isValid && (!capitalbotStatus.modelId || !capitalbotStatus.presetId)) {
        getMyCapitalbotModels().then((res) => {
          const body = res?.data;
          if (body?.success && body?.data?.data) {
            const d = body.data.data;
            if (Array.isArray(d.models)) setAvailableModels(d.models);
            if (Array.isArray(d.presets)) setAvailablePresets(d.presets);
            setModelCustomMode(!d.models?.length);
          }
        }).catch(() => {});
        setModelIdDraft(String(capitalbotStatus.modelId || ''));
        setPresetIdDraft(String(capitalbotStatus.presetId || ''));
        setShowModelPresetForm(true);
        setActiveKeyProvider('capitalbot');
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTelegram]);

  // Enable/disable AI for EVERY Telegram session at once. On enable the
  // backend resolves the provider from whichever key the user has
  // validated (CapitalBot preferred, else CupidBot) and stamps it into
  // each session's config, then re-fetches all settings so the per-row
  // toggles reflect the new state.
  const handleBulkToggle = async (enabled) => {
    // Guard: on enable, make sure at least one provider key is valid so we
    // can give a precise error instead of a generic backend refusal.
    if (enabled) {
      const cupidOk = keyStatusByProvider.cupidbot?.isValid;
      const capitalOk = keyStatusByProvider.capitalbot?.isValid;
      if (!cupidOk && !capitalOk) {
        toast.error('Add and validate a CupidBot or CapitalBot API key before enabling AI for all sessions.');
        return;
      }
    }
    setBulkToggling(true);
    try {
      const { data } = await bulkToggleAiSessions(enabled);
      const d = data?.data || {};
      const providerLabel = d.provider === 'capitalbot' ? 'CapitalBot' : d.provider === 'cupidbot' ? 'CupidBot' : '';
      if (enabled) {
        const parts = [`AI enabled on ${d.changed} session${d.changed === 1 ? '' : 's'}`];
        if (providerLabel) parts.push(`via ${providerLabel}`);
        if (d.skipped) parts.push(`· ${d.skipped} skipped (not logged in)`);
        if (d.failed) parts.push(`· ${d.failed} failed`);
        toast.success(parts.join(' '));
      } else {
        const parts = [`AI disabled on ${d.changed} session${d.changed === 1 ? '' : 's'}`];
        if (d.failed) parts.push(`· ${d.failed} failed`);
        toast.success(parts.join(' '));
      }
      await loadSessions();
    } catch (err) {
      toast.error(
        err?.response?.data?.error?.message ||
        err?.response?.data?.error ||
        'Failed to bulk-update AI settings'
      );
    } finally {
      setBulkToggling(false);
    }
  };

  const toggleSession = async (sessionId) => {
    const current = settingsMap[sessionId] || { enabled: false, config: {} };
    const provider = current.config?.provider || 'cupidbot';
    const keyStatus = keyStatusByProvider[provider];
    if (!keyStatus?.isValid) {
      toast.error(`Add and validate your ${provider === 'cupidbot' ? 'CupidBot' : 'CapitalBot'} API key before enabling AI.`);
      return;
    }
    const nextEnabled = !current.enabled;
    setTogglingId(sessionId);
    try {
      const { data } = await updateAiSessionSettings(sessionId, {
        enabled: nextEnabled,
        config: current.config,
      });
      setSettingsMap((prev) => ({
        ...prev,
        [sessionId]: {
          enabled: data?.data?.enabled ?? nextEnabled,
          config: data?.data?.config || current.config,
        },
      }));
      toast.success(nextEnabled ? 'AI enabled for this session' : 'AI disabled for this session');
    } catch (err) {
      toast.error(
        err?.response?.data?.error?.message ||
        err?.response?.data?.error ||
        'Failed to update AI setting'
      );
    } finally {
      setTogglingId(null);
    }
  };

  const saveActiveProviderKey = async () => {
    const providerLabel = activeKeyProvider === 'cupidbot' ? 'CupidBot' : 'CapitalBot';
    if (!keyDraft.trim()) {
      setKeyError(`Please paste your ${providerLabel} API key.`);
      return;
    }
    setKeySaving(true);
    setKeyError(null);
    try {
      if (activeKeyProvider === 'cupidbot') {
        await setCupidbotKey(keyDraft.trim());
        const res = await getCupidbotKey();
        setKeyStatusByProvider((prev) => ({ ...prev, cupidbot: res?.data?.data || null }));
        setKeyDraft('');
        toast.success(`CupidBot API key validated and saved.`);
      } else {
        const saveRes = await setCapitalbotKey(keyDraft.trim());
        const saveData = saveRes?.data?.data || {};
        setKeyStatusByProvider((prev) => ({
          ...prev,
          capitalbot: {
            hasKey: true,
            isValid: true,
            isAdmin: prev.capitalbot?.isAdmin || false,
            modelId: saveData.modelId,
            presetId: saveData.presetId,
          },
        }));
        setKeyDraft('');
        toast.success(`CapitalBot license key validated and saved.`);
        const fetchedModels = saveData.models || [];
        const fetchedPresets = saveData.presets || [];
        setAvailableModels(fetchedModels);
        setAvailablePresets(fetchedPresets);
        setModelCustomMode(fetchedModels.length === 0);
        if (fetchedModels.length > 0 && !saveData.modelId) {
          setModelIdDraft(String(fetchedModels[0].modelId));
        } else {
          setModelIdDraft(String(saveData.modelId || ''));
        }
        if (fetchedPresets.length > 0 && !saveData.presetId) {
          setPresetIdDraft(String(fetchedPresets[0].id));
        } else {
          setPresetIdDraft(String(saveData.presetId || ''));
        }
        setShowModelPresetForm(true);
      }
    } catch (err) {
      const msg = err?.response?.data?.error?.message || `Invalid ${providerLabel} API key.`;
      setKeyError(msg);
      toast.error(msg);
    } finally {
      setKeySaving(false);
    }
  };

  const saveModelPreset = async () => {
    const mid = parseInt(modelIdDraft, 10);
    const pid = parseInt(presetIdDraft, 10);
    if (!Number.isFinite(mid) || !Number.isFinite(pid)) {
      toast.error('Please enter valid numeric Model ID and Preset ID.');
      return;
    }
    setModelPresetSaving(true);
    try {
      await updateCapitalbotModelPreset(mid, pid);
      setKeyStatusByProvider((prev) => ({
        ...prev,
        capitalbot: { ...prev.capitalbot, modelId: mid, presetId: pid },
      }));
      setShowModelPresetForm(false);
      toast.success(`CapitalBot model (${mid}) and preset (${pid}) saved.`);
    } catch (err) {
      toast.error(err?.response?.data?.error?.message || 'Failed to save model/preset');
    } finally {
      setModelPresetSaving(false);
    }
  };

  const removeCupidbotKey = async () => {
    setKeySaving(true);
    setKeyError(null);
    try {
      await deleteCupidbotKey();
      setKeyStatusByProvider((prev) => ({
        ...prev,
        cupidbot: { hasKey: false, isValid: false, isAdmin: prev.cupidbot?.isAdmin || false },
      }));
      toast.success('CupidBot API key removed.');
    } catch (err) {
      toast.error(err?.response?.data?.error?.message || 'Failed to remove API key');
    } finally {
      setKeySaving(false);
    }
  };

  const removeCapitalbotKey = async () => {
    setKeySaving(true);
    setKeyError(null);
    try {
      await deleteCapitalbotKey();
      setKeyStatusByProvider((prev) => ({
        ...prev,
        capitalbot: { hasKey: false, isValid: false, isAdmin: prev.capitalbot?.isAdmin || false },
      }));
      setShowModelPresetForm(false);
      setModelCustomMode(false);
      toast.success('CapitalBot license key removed.');
    } catch (err) {
      toast.error(err?.response?.data?.error?.message || 'Failed to remove license key');
    } finally {
      setKeySaving(false);
    }
  };

  const expandSession = async (sessionId) => {
    if (expandedId === sessionId) {
      setExpandedId(null);
      return;
    }
    setExpandedId(sessionId);

    if (dialogsMap[sessionId]) {
      await _refreshChatData(sessionId);
      return;
    }

    setDialogsLoading(sessionId);
    try {
      const [{ data: dlgData }, { data: cs }, { data: ls }] = await Promise.all([
        getClientDialogs(sessionId, { limit: 200, includeAllPeerTypes: true }),
        getAiChatSettings(sessionId, { limit: 500 }),
        getAiLogs(sessionId, { limit: 50 }),
      ]);
      const dialogs = dlgData?.data?.dialogs || [];
      const settingsRows = cs?.data?.rows || [];
      const settingsByKey = {};
      for (const row of settingsRows) {
        settingsByKey[_peerKey(row.peer_type, row.peer_id)] = row;
      }
      setDialogsMap((prev) => ({ ...prev, [sessionId]: dialogs }));
      setChatSettingsMap((prev) => ({ ...prev, [sessionId]: settingsByKey }));
      setLogsMap((prev) => ({ ...prev, [sessionId]: ls?.data?.rows || [] }));
    } catch (err) {
      toast.error('Failed to load chats or AI logs');
    } finally {
      setDialogsLoading(null);
    }
  };

  const _refreshChatData = async (sessionId) => {
    try {
      const [{ data: cs }, { data: ls }] = await Promise.all([
        getAiChatSettings(sessionId, { limit: 500 }),
        getAiLogs(sessionId, { limit: 50 }),
      ]);
      const settingsRows = cs?.data?.rows || [];
      const settingsByKey = {};
      for (const row of settingsRows) {
        settingsByKey[_peerKey(row.peer_type, row.peer_id)] = row;
      }
      setChatSettingsMap((prev) => ({ ...prev, [sessionId]: settingsByKey }));
      setLogsMap((prev) => ({ ...prev, [sessionId]: ls?.data?.rows || [] }));
    } catch (err) {
      toast.error('Failed to refresh chat settings');
    }
  };

  const isAiEnabledForChat = (sessionId, peerType, peerId) => {
    const settings = chatSettingsMap[sessionId] || {};
    const key = _peerKey(peerType, peerId);
    if (settings[key]) return settings[key].enabled;
    return settingsMap[sessionId]?.enabled ?? false;
  };

  const toggleChat = async (sessionId, peerType, peerId) => {
    const current = isAiEnabledForChat(sessionId, peerType, peerId);
    const next = !current;
    setChatToggling(`${sessionId}:${peerType}:${peerId}`);
    try {
      await updateAiChatSettings(sessionId, peerType, peerId, { enabled: next });
      setChatSettingsMap((prev) => {
        const map = { ...prev[sessionId] };
        map[_peerKey(peerType, peerId)] = { enabled: next };
        return { ...prev, [sessionId]: map };
      });
      toast.success(next ? 'AI enabled for this chat' : 'AI disabled for this chat');
    } catch (err) {
      toast.error(err?.response?.data?.error?.message || 'Failed to update chat setting');
    } finally {
      setChatToggling(null);
    }
  };

  const clearMemory = async (sessionId, peerType, peerId) => {
    setClearing(`${sessionId}:${peerType}:${peerId}`);
    try {
      await clearAiChatMemory(sessionId, peerType, peerId);
      toast.success('Chat memory cleared');
    } catch (err) {
      toast.error(err?.response?.data?.error?.message || 'Failed to clear memory');
    } finally {
      setClearing(null);
    }
  };

  const seedMemory = async (sessionId, peerType, peerId) => {
    setSeeding(`${sessionId}:${peerType}:${peerId}`);
    try {
      await seedAiChatMemory(sessionId, peerType, peerId);
      toast.success('Chat memory seeded from recent history');
    } catch (err) {
      toast.error(err?.response?.data?.error?.message || 'Failed to seed memory');
    } finally {
      setSeeding(null);
    }
  };

  const filteredSessions = useMemo(() => {
    return sessions.filter((s) => s.platform === 'telegram' || !s.platform);
  }, [sessions]);

  if (!isTelegram) {
    return (
      <div className="flex min-h-screen items-center justify-center p-8 text-center text-gray-400">
        <div>
          <Bot className="mx-auto mb-4 h-12 w-12 text-gray-500" />
          <p>AI Chat is only available for Telegram.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-dark-950 p-6 text-gray-100">
      <div className="mx-auto max-w-5xl">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold">
              <Bot className="h-7 w-7 text-sky-400" />
              AI Auto-Responder
            </h1>
            <p className="mt-1 text-sm text-gray-400">
              Enable AI per Telegram session and control which chats it handles.
            </p>
          </div>
          <button
            type="button"
            onClick={loadSessions}
            disabled={loading}
            className="flex items-center gap-2 rounded-md bg-dark-800 px-3 py-2 text-sm hover:bg-dark-700 disabled:opacity-50"
          >
            <RefreshCcw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>

        {/* Tabs: Manage (toggles/keys) vs Tracking (activity analytics) */}
        <div className="mb-5 flex gap-1 border-b border-white/10">
          <button
            type="button"
            onClick={() => setActiveTab('manage')}
            className={`flex items-center gap-2 border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
              activeTab === 'manage'
                ? 'border-sky-500 text-sky-300'
                : 'border-transparent text-gray-400 hover:text-gray-200'
            }`}
          >
            <Bot className="h-4 w-4" />
            Manage
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('tracking')}
            className={`flex items-center gap-2 border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
              activeTab === 'tracking'
                ? 'border-sky-500 text-sky-300'
                : 'border-transparent text-gray-400 hover:text-gray-200'
            }`}
          >
            <Activity className="h-4 w-4" />
            Tracking
          </button>
        </div>

        {activeTab === 'tracking' && <AiChatTracking />}

        {activeTab === 'manage' && (
        <div>
        <div className="mb-4 flex gap-2">
          {AI_PROVIDERS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => { setActiveKeyProvider(p.id); setKeyDraft(''); setKeyError(null); setShowModelPresetForm(false); setModelCustomMode(false); }}
              className={`flex-1 rounded-lg border px-4 py-2 text-left transition-colors ${
                activeKeyProvider === p.id
                  ? 'border-sky-500/50 bg-sky-500/10 text-sky-200'
                  : 'border-white/5 bg-dark-900 text-gray-400 hover:border-white/10 hover:text-gray-200'
              }`}
            >
              <span className="text-sm font-semibold">{p.label}</span>
              <span className="block text-xs opacity-70">{p.desc}</span>
            </button>
          ))}
        </div>

        {(() => {
          const ks = keyStatusByProvider[activeKeyProvider];
          const providerLabel = activeKeyProvider === 'cupidbot' ? 'CupidBot' : 'CapitalBot';
          return ks && (
            <div
              className={`mb-4 rounded-lg border p-4 ${
                ks.isValid
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
                  : 'border-amber-500/30 bg-amber-500/10 text-amber-100'
              }`}
            >
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-semibold">
                    {ks.isValid
                      ? `${providerLabel} API key is active.`
                      : `${providerLabel} API key required.`}
                  </p>
                  <p className="text-xs opacity-80">
                    {ks.hasKey
                      ? 'Your saved key failed validation. Please re-enter a valid key.'
                      : `Paste your ${providerLabel} API key below to unlock the AI auto-responder.`}
                  </p>
                  {ks.isValid && activeKeyProvider === 'capitalbot' && ks.modelId != null && ks.presetId != null && (
                    <p className="mt-1 text-xs text-emerald-300/70">
                      Model: {ks.modelId} &middot; Preset: {ks.presetId}
                    </p>
                  )}
                </div>
                {ks.isValid && activeKeyProvider === 'capitalbot' && ks.modelId != null && ks.presetId != null && (
                  <button
                    type="button"
                    onClick={async () => {
                      setModelIdDraft(String(ks.modelId));
                      setPresetIdDraft(String(ks.presetId));
                      try {
                        const modelsRes = await getMyCapitalbotModels();
                        const body = modelsRes?.data;
                        if (body?.success && body?.data?.data) {
                          const d = body.data.data;
                          if (Array.isArray(d.models)) setAvailableModels(d.models);
                          if (Array.isArray(d.presets)) setAvailablePresets(d.presets);
                          setModelCustomMode(!d.models?.length);
                        }
                      } catch (_) {}
                      setShowModelPresetForm(true);
                    }}
                    className="rounded-md border border-white/10 px-3 py-1.5 text-xs hover:bg-white/5"
                  >
                    Change Config
                  </button>
                )}
              </div>

              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <input
                  type="password"
                  value={keyDraft}
                  onChange={(e) => setKeyDraft(e.target.value)}
                  placeholder={`Paste your ${providerLabel} API key`}
                  className="flex-1 rounded-md border border-white/10 bg-dark-900 px-3 py-2 text-sm placeholder:text-gray-500 focus:border-sky-500 focus:outline-none"
                  disabled={keySaving}
                />
                <button
                  type="button"
                  onClick={saveActiveProviderKey}
                  disabled={keySaving || !keyDraft.trim()}
                  className="rounded-md bg-sky-500 px-3 py-2 text-sm font-medium text-white hover:bg-sky-400 disabled:opacity-50"
                >
                  {keySaving ? 'Validating…' : 'Save & Validate'}
                </button>
                {ks.hasKey && (
                  <button
                    type="button"
                    onClick={activeKeyProvider === 'cupidbot' ? removeCupidbotKey : removeCapitalbotKey}
                    disabled={keySaving}
                    className="rounded-md border border-white/10 px-3 py-2 text-sm hover:bg-white/5 disabled:opacity-50"
                  >
                    Remove
                  </button>
                )}
              </div>
              {keyError && (
                <p className="mt-2 text-xs text-red-300">{keyError}</p>
              )}

              {activeKeyProvider === 'capitalbot' && showModelPresetForm && (
                <div className="mt-4 border-t border-white/10 pt-4">
                  <p className="mb-2 text-sm font-semibold text-gray-200">
                    Select Model & Preset
                  </p>
                  <p className="mb-3 text-xs text-gray-400">
                    Choose the AI model and conversation preset for your license key.
                  </p>
                  <div className="flex flex-col gap-3 sm:flex-row">
                    {modelCustomMode ? (
                      <input
                        type="text"
                        value={modelIdDraft}
                        onChange={(e) => setModelIdDraft(e.target.value)}
                        placeholder="Enter Model ID manually"
                        className="flex-1 rounded-md border border-white/10 bg-dark-900 px-3 py-2 text-sm placeholder:text-gray-500 focus:border-sky-500 focus:outline-none"
                        disabled={modelPresetSaving}
                      />
                    ) : (
                      <select
                        value={modelIdDraft}
                        onChange={(e) => {
                          if (e.target.value === '__custom__') {
                            setModelCustomMode(true);
                            setModelIdDraft('');
                          } else {
                            setModelIdDraft(e.target.value);
                          }
                        }}
                        className="flex-1 rounded-md border border-white/10 bg-dark-900 px-3 py-2 text-sm text-gray-200 focus:border-sky-500 focus:outline-none"
                        disabled={modelPresetSaving}
                      >
                        {availableModels.length === 0 ? (
                          <option value="">No models from API</option>
                        ) : (
                          availableModels.map((m) => (
                            <option key={m.modelId} value={String(m.modelId)}>
                              {m.name} (ID: {m.modelId})
                            </option>
                          ))
                        )}
                        <option value="__custom__">Custom…</option>
                      </select>
                    )}
                    <select
                      value={presetIdDraft}
                      onChange={(e) => setPresetIdDraft(e.target.value)}
                      className="flex-1 rounded-md border border-white/10 bg-dark-900 px-3 py-2 text-sm text-gray-200 focus:border-sky-500 focus:outline-none"
                      disabled={modelPresetSaving || availablePresets.length === 0}
                    >
                      {availablePresets.length === 0 ? (
                        <option value="">No presets available</option>
                      ) : (
                        availablePresets.map((p) => (
                          <option key={p.id} value={String(p.id)}>
                            {p.name} (ID: {p.id})
                          </option>
                        ))
                      )}
                    </select>
                    <button
                      type="button"
                      onClick={saveModelPreset}
                      disabled={modelPresetSaving || !modelIdDraft || !presetIdDraft}
                      className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
                    >
                      {modelPresetSaving ? 'Saving…' : 'Save Config'}
                    </button>
                  </div>
                  {modelCustomMode && (
                    <button
                      type="button"
                      onClick={() => { setModelCustomMode(false); setModelIdDraft(availableModels.length > 0 ? String(availableModels[0].modelId) : ''); }}
                      className="mt-2 text-xs text-sky-400 hover:text-sky-300"
                    >
                      Back to dropdown
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })()}

        {/* Bulk on/off for EVERY Telegram session at once. On enable the
            backend routes to whichever provider key the user has validated
            (CapitalBot preferred, else CupidBot). */}
        <div className="mb-4 flex flex-col gap-3 rounded-lg border border-white/5 bg-dark-900 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-semibold text-gray-200">All sessions</p>
            <p className="text-xs text-gray-500">
              Turn the AI auto-responder on or off for every Telegram session
              in one click. Enabling uses your active key
              {keyStatusByProvider.capitalbot?.isValid
                ? ' (CapitalBot)'
                : keyStatusByProvider.cupidbot?.isValid
                ? ' (CupidBot)'
                : ''}
              .
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => handleBulkToggle(true)}
              disabled={bulkToggling}
              className="flex items-center gap-2 rounded-md bg-emerald-500/15 border border-emerald-500/30 px-3 py-2 text-sm font-medium text-emerald-300 hover:bg-emerald-500/25 disabled:opacity-50"
            >
              {bulkToggling ? <Loader2 className="h-4 w-4 animate-spin" /> : <Power className="h-4 w-4" />}
              Enable All
            </button>
            <button
              type="button"
              onClick={() => handleBulkToggle(false)}
              disabled={bulkToggling}
              className="flex items-center gap-2 rounded-md bg-amber-500/15 border border-amber-500/30 px-3 py-2 text-sm font-medium text-amber-300 hover:bg-amber-500/25 disabled:opacity-50"
            >
              {bulkToggling ? <Loader2 className="h-4 w-4 animate-spin" /> : <PowerOff className="h-4 w-4" />}
              Disable All
            </button>
          </div>
        </div>

        {error && (
          <div className="mb-4 flex items-center gap-2 rounded-md border border-red-500/30 bg-red-500/10 p-4 text-red-300">
            <AlertTriangle className="h-5 w-5" />
            {error}
          </div>
        )}

        {loading && !sessions.length ? (
          <div className="flex items-center justify-center py-20 text-gray-400">
            <Loader2 className="mr-2 h-6 w-6 animate-spin" />
            Loading sessions…
          </div>
        ) : filteredSessions.length === 0 ? (
          <div className="rounded-lg border border-white/5 bg-dark-900 p-8 text-center text-gray-400">
            No Telegram sessions found. Upload or create a session first.
          </div>
        ) : (
          <div className="space-y-3">
            {filteredSessions.map((s) => {
              const settings = settingsMap[s.id] || { enabled: false, config: {} };
              const expanded = expandedId === s.id;
              return (
                <div
                  key={s.id}
                  className="rounded-lg border border-white/5 bg-dark-900 p-4"
                >
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-lg font-semibold">
                          {s.displayName || `Session #${s.id}`}
                        </span>
                        {s.username && (
                          <span className="text-sm text-gray-500">@{s.username}</span>
                        )}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-500">
                        <span>#{s.id}</span>
                        <span>·</span>
                        <span>{s.phone || 'no phone'}</span>
                        <span>·</span>
                        <span className={s.isLoggedIn ? 'text-emerald-400' : 'text-amber-400'}>
                          {s.isLoggedIn ? 'logged in' : 'not logged in'}
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() => toggleSession(s.id)}
                        disabled={togglingId === s.id || !s.isLoggedIn}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-sky-500 focus:ring-offset-2 focus:ring-offset-dark-900 disabled:opacity-50 ${
                          settings.enabled ? 'bg-sky-500' : 'bg-gray-600'
                        }`}
                      >
                        <span
                          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                            settings.enabled ? 'translate-x-6' : 'translate-x-1'
                          }`}
                        />
                      </button>
                      <span className="text-sm font-medium">
                        {settings.enabled ? 'AI ON' : 'AI OFF'}
                      </span>
                      <select
                        value={settings.config?.provider || 'cupidbot'}
                        onChange={async (e) => {
                          const newProvider = e.target.value;
                          const newConfig = { ...settings.config, provider: newProvider };
                          setSettingsMap((prev) => ({
                            ...prev,
                            [s.id]: { ...prev[s.id], config: newConfig },
                          }));
                          if (settings.enabled) {
                            try {
                              const { data: resData } = await updateAiSessionSettings(s.id, {
                                enabled: true,
                                config: newConfig,
                              });
                              if (resData?.data?.config) {
                                setSettingsMap((prev) => ({
                                  ...prev,
                                  [s.id]: { ...prev[s.id], config: resData.data.config },
                                }));
                              }
                              toast.success(`Switched to ${newProvider === 'cupidbot' ? 'CupidBot' : 'CapitalBot'} for this session`);
                            } catch (err) {
                              toast.error('Failed to update provider');
                            }
                          }
                        }}
                        className="rounded-md border border-white/10 bg-dark-900 px-2 py-1 text-xs text-gray-300 focus:border-sky-500 focus:outline-none"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <option value="cupidbot">CupidBot</option>
                        <option value="capitalbot">CapitalBot</option>
                      </select>
                      <button
                        type="button"
                        onClick={() => expandSession(s.id)}
                        className="rounded-md p-1 hover:bg-white/5"
                      >
                        {expanded ? (
                          <ChevronUp className="h-5 w-5 text-gray-400" />
                        ) : (
                          <ChevronDown className="h-5 w-5 text-gray-400" />
                        )}
                      </button>
                    </div>
                  </div>

                  {expanded && (
                    <div className="mt-4 border-t border-white/5 pt-4">
                      <h3 className="mb-2 text-sm font-semibold text-gray-300">
                        Chats for this session
                      </h3>

                      {dialogsLoading === s.id ? (
                        <div className="flex items-center py-6 text-gray-400">
                          <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                          Loading chats…
                        </div>
                      ) : (
                        <>
                          <div className="mb-4 max-h-96 overflow-auto rounded-md border border-white/5">
                            {(() => {
                              const dialogs = dialogsMap[s.id] || [];
                              if (!dialogs.length) {
                                return (
                                  <p className="p-4 text-sm text-gray-500">
                                    No chats found. Open the Telegram client for this session first.
                                  </p>
                                );
                              }
                              return dialogs.map((d) => {
                                const enabled = isAiEnabledForChat(s.id, d.peerType, d.peerId);
                                const icon =
                                  d.peerType === 'user' ? UserIcon
                                  : d.peerType === 'channel' ? Megaphone
                                  : Users;
                                const busy = chatToggling === `${s.id}:${d.peerType}:${d.peerId}`;
                                const clearBusy = clearing === `${s.id}:${d.peerType}:${d.peerId}`;
                                const seedBusy = seeding === `${s.id}:${d.peerType}:${d.peerId}`;
                                return (
                                  <div
                                    key={_peerKey(d.peerType, d.peerId)}
                                    className="flex items-center justify-between border-b border-white/5 px-3 py-2 last:border-0 hover:bg-white/[0.02]"
                                  >
                                    <div className="flex min-w-0 items-center gap-3">
                                      <Avatar
                                        sessionId={s.id}
                                        peerType={d.peerType}
                                        peerId={d.peerId}
                                        label={d.title}
                                        size="sm"
                                      />
                                      <div className="min-w-0">
                                        <div className="flex items-center gap-1.5 text-sm font-medium">
                                          <icon className="h-3.5 w-3.5 text-gray-500" />
                                          <span className="truncate">{d.title || 'Unknown'}</span>
                                          {d.username && (
                                            <span className="text-xs text-gray-500">@{d.username}</span>
                                          )}
                                        </div>
                                        <div className="truncate text-xs text-gray-500">
                                          {_formatPreview(d.lastMessage)}
                                        </div>
                                      </div>
                                    </div>

                                    <div className="flex items-center gap-2 pl-3">
                                      <button
                                        type="button"
                                        onClick={() => toggleChat(s.id, d.peerType, d.peerId)}
                                        disabled={busy || !settings.enabled}
                                        title={settings.enabled ? (enabled ? 'Disable AI for this chat' : 'Enable AI for this chat') : 'Enable session AI first'}
                                        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors disabled:opacity-50 ${
                                          enabled ? 'bg-sky-500' : 'bg-gray-600'
                                        }`}
                                      >
                                        <span
                                          className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${
                                            enabled ? 'translate-x-5' : 'translate-x-1'
                                          }`}
                                        />
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => seedMemory(s.id, d.peerType, d.peerId)}
                                        disabled={seedBusy || !settings.enabled}
                                        title="Seed memory from recent history"
                                        className="rounded-md p-1.5 text-gray-400 hover:bg-sky-500/10 hover:text-sky-300 disabled:opacity-50"
                                      >
                                        <Database className="h-4 w-4" />
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => clearMemory(s.id, d.peerType, d.peerId)}
                                        disabled={clearBusy}
                                        title="Clear memory"
                                        className="rounded-md p-1.5 text-gray-400 hover:bg-red-500/10 hover:text-red-300 disabled:opacity-50"
                                      >
                                        <Trash2 className="h-4 w-4" />
                                      </button>
                                    </div>
                                  </div>
                                );
                              });
                            })()}
                          </div>

                          <h3 className="mb-2 text-sm font-semibold text-gray-300">
                            Recent AI logs
                          </h3>
                          {(() => {
                            const logs = logsMap[s.id] || [];
                            if (!logs.length) {
                              return (
                                <p className="text-sm text-gray-500">No AI response logs yet.</p>
                              );
                            }
                            return (
                              <div className="max-h-64 overflow-auto rounded-md bg-dark-800/30">
                                {logs.map((log) => {
                                  const pill = _statusPill(log.status);
                                  return (
                                    <div
                                      key={log.id}
                                      className="flex items-center justify-between border-b border-white/5 px-3 py-2 text-sm last:border-0"
                                    >
                                      <div className="flex items-center gap-2">
                                        <span
                                          className={`flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs ${TONE_CLASSES[pill.tone]}`}
                                        >
                                          <pill.Icon className="h-3 w-3" />
                                          {pill.label}
                                        </span>
                                        <span className="text-gray-400">
                                          {PEER_LABEL[log.peer_type]} {log.peer_id}
                                        </span>
                                        {log.error_message && (
                                          <span className="truncate max-w-[200px] text-xs text-red-300" title={log.error_message}>
                                            {log.error_message}
                                          </span>
                                        )}
                                      </div>
                                      <span className="text-xs text-gray-600">
                                        {new Date(log.created_at).toLocaleString()}
                                      </span>
                                    </div>
                                  );
                                })}
                              </div>
                            );
                          })()}
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        </div>
        )}
      </div>
    </div>
  );
}
