import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Smile, Sticker, Film, Search, Loader2, X } from 'lucide-react';
import {
  getStickerSets,
  getRecentStickers,
  getFavoriteStickers,
  searchStickers,
  getSavedGifs,
  searchGifs,
  getClientMedia,
} from '../../api/telegramClient';

// ---------- D11 emoji catalogue ------------------------------------------
// Curated tab-by-tab list keeps the picker dependency-free and small.
// Add more rows over time; this covers the most-used Telegram emojis.
const EMOJI_TABS = [
  {
    label: 'Smileys',
    emojis: '😀 😃 😄 😁 😆 😅 😂 🤣 🥲 ☺️ 😊 😇 🙂 🙃 😉 😌 😍 🥰 😘 😗 😙 😚 😋 😛 😝 😜 🤪 🤨 🧐 🤓 😎 🤩 🥳 😏 😒 😞 😔 😟 😕 🙁 ☹️ 😣 😖 😫 😩 🥺 😢 😭 😤 😠 😡 🤬 🤯 😳 🥵 🥶 😱 😨 😰 😥 😓 🤗 🤔 🤭 🤫 🤥 😶 😐 😑 😬 🙄 😯 😦 😧 😮 😲 🥱 😴 🤤 😪 😵 🤐 🥴 🤢 🤮 🤧 😷 🤒 🤕 🤑 🤠 😈 👿 👹 👺 🤡 💩 👻 💀 ☠️ 👽 👾 🤖 🎃 😺 😸 😹 😻 😼 😽 🙀 😿 😾'.split(' '),
  },
  {
    label: 'Gestures',
    emojis: '👋 🤚 🖐️ ✋ 🖖 👌 🤌 🤏 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 🖕 👇 ☝️ 👍 👎 ✊ 👊 🤛 🤜 👏 🙌 👐 🤲 🤝 🙏 ✍️ 💅 🤳 💪 🦵 🦶 👂 🦻 👃 🧠 🫀 🫁 🦷 🦴 👀 👁️ 👅 👄 💋 🩸'.split(' '),
  },
  {
    label: 'Hearts',
    emojis: '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💟 ☮️ ✝️ ☪️ 🕉️ ☸️ ✡️ 🔯 🕎 ☯️ ☦️ 🛐 ⛎ ♈ ♉ ♊ ♋ ♌ ♍ ♎ ♏ ♐ ♑ ♒ ♓'.split(' '),
  },
  {
    label: 'Animals',
    emojis: '🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐻‍❄️ 🐨 🐯 🦁 🐮 🐷 🐽 🐸 🐵 🙈 🙉 🙊 🐒 🐔 🐧 🐦 🐤 🐣 🐥 🦆 🦅 🦉 🦇 🐺 🐗 🐴 🦄 🐝 🪱 🐛 🦋 🐌 🐞 🐜 🪰 🪲 🪳 🦟 🦗 🕷️ 🕸️ 🦂 🐢 🐍 🦎 🦖 🦕 🐙 🦑 🦐 🦞 🦀 🐡 🐠 🐟 🐬 🐳 🐋 🦈'.split(' '),
  },
  {
    label: 'Food',
    emojis: '🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🫐 🍈 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🍆 🥑 🥦 🥬 🥒 🌶️ 🫑 🌽 🥕 🫒 🧄 🧅 🥔 🍠 🥐 🥯 🍞 🥖 🥨 🧀 🥚 🍳 🧈 🥞 🧇 🥓 🥩 🍗 🍖 🌭 🍔 🍟 🍕 🌮 🌯 🫔 🥙 🧆 🥘 🍝 🍜 🍲 🍛 🍣 🍱 🍤 🍙 🍚 🍘 🍥 🥮 🥟 🍢 🍡 🍧 🍨 🍦 🥧 🧁 🍰 🎂 🍮 🍭 🍬 🍫 🍿 🍩 🍪 🌰 🥜 🍯 🥛 🍼 ☕ 🫖 🍵 🧃 🥤 🍶 🍺 🍻 🥂 🍷 🥃 🍸 🍹 🧉 🍾 🧊'.split(' '),
  },
  {
    label: 'Activity',
    emojis: '⚽ 🏀 🏈 ⚾ 🥎 🎾 🏐 🏉 🥏 🎱 🪀 🏓 🏸 🏒 🏑 🥍 🏏 🪃 🥅 ⛳ 🪁 🏹 🎣 🤿 🥊 🥋 🎽 🛹 🛼 🛷 ⛸️ 🥌 🎿 ⛷️ 🏂 🪂 🏋️ 🤼 🤸 ⛹️ 🤺 🤾 🏌️ 🏇 🧘 🏄 🏊 🤽 🚣 🧗 🚵 🚴 🏆 🥇 🥈 🥉 🏅 🎖️ 🏵️ 🎗️ 🎫 🎟️ 🎪 🤹 🎭 🩰 🎨 🎬 🎤 🎧 🎼 🎹 🥁 🪘 🎷 🎺 🪗 🎸 🪕 🎻 🎲 ♟️ 🎯 🎳 🎮 🎰 🧩'.split(' '),
  },
  {
    label: 'Travel',
    emojis: '🚗 🚕 🚙 🚌 🚎 🏎️ 🚓 🚑 🚒 🚐 🛻 🚚 🚛 🚜 🦯 🦽 🦼 🛴 🚲 🛵 🏍️ 🛺 🚨 🚔 🚍 🚘 🚖 🚡 🚠 🚟 🚃 🚋 🚞 🚝 🚄 🚅 🚈 🚂 🚆 🚇 🚊 🚉 ✈️ 🛫 🛬 🛩️ 💺 🛰️ 🚀 🛸 🚁 🛶 ⛵ 🚤 🛥️ 🛳️ ⛴️ 🚢 ⚓ ⛽ 🚧 🚦 🚥 🗺️ 🗿 🗽 🗼 🏰 🏯 🏟️ 🎡 🎢 🎠 ⛲ ⛱️ 🏖️ 🏝️ 🏜️ 🌋 ⛰️ 🏔️ 🗻 🏕️ ⛺ 🏠 🏡 🏘️ 🏚️ 🏗️ 🏭 🏢 🏬 🏣 🏤 🏥 🏦 🏨 🏪 🏫 🏩 💒 🏛️ ⛪ 🕌 🕍 🛕 🕋 ⛩️ 🛤️ 🛣️ 🗾 🎑 🏞️ 🌅 🌄 🌠 🎇 🎆 🌇 🌆 🏙️ 🌃 🌌 🌉 🌁'.split(' '),
  },
  {
    label: 'Objects',
    emojis: '⌚ 📱 📲 💻 ⌨️ 🖥️ 🖨️ 🖱️ 🖲️ 🕹️ 🗜️ 💽 💾 💿 📀 📼 📷 📸 📹 🎥 📽️ 🎞️ 📞 ☎️ 📟 📠 📺 📻 🎙️ 🎚️ 🎛️ 🧭 ⏱️ ⏲️ ⏰ 🕰️ ⌛ ⏳ 📡 🔋 🔌 💡 🔦 🕯️ 🪔 🧯 🛢️ 💸 💵 💴 💶 💷 💰 💳 💎 ⚖️ 🪜 🧰 🔧 🔨 ⚒️ 🛠️ ⛏️ 🪚 🔩 ⚙️ 🪤 🧱 ⛓️ 🧲 🔫 💣 🧨 🪓 🔪 🗡️ ⚔️ 🛡️ 🚬 ⚰️ 🪦 ⚱️ 🏺 🔮 📿 🧿 💈 ⚗️ 🔭 🔬 🕳️ 🩹 🩺 💊 💉 🩸 🧬 🦠 🧫 🧪 🌡️ 🧹 🪠 🧺 🧻 🚽 🚰 🚿 🛁 🛀 🧼 🪥 🪒 🧽 🪣 🧴 🛎️ 🔑 🗝️ 🚪 🪑 🛋️ 🛏️ 🛌 🧸 🪆 🖼️ 🪞 🪟 🛍️ 🛒 🎁 🎈 🎏 🎀 🪄 🪅 🎊 🎉 🎎 🏮 🎐 🧧 ✉️ 📩 📨 📧 💌 📥 📤 📦 🏷️ 🪧 📪 📫 📬 📭 📮 📯 📜 📃 📄 📑 🧾 📊 📈 📉 🗒️ 🗓️ 📆 📅 🗑️ 📇 🗃️ 🗳️ 🗄️ 📋 📁 📂 🗂️ 🗞️ 📰 📓 📔 📒 📕 📗 📘 📙 📚 📖 🔖 🧷 🔗 📎 🖇️ 📐 📏 🧮 📌 📍 ✂️ 🖊️ 🖋️ ✒️ 🖌️ 🖍️ 📝 ✏️ 🔍 🔎 🔏 🔐 🔒 🔓'.split(' '),
  },
  {
    label: 'Symbols',
    emojis: '⏏️ ⏯️ ⏹️ ⏺️ ⏭️ ⏮️ ⏩ ⏪ ⏫ ⏬ ▶️ ◀️ 🔼 🔽 ➡️ ⬅️ ⬆️ ⬇️ ↗️ ↘️ ↙️ ↖️ ↕️ ↔️ ↪️ ↩️ ⤴️ ⤵️ 🔀 🔁 🔂 🔄 🔃 🎵 🎶 ➕ ➖ ➗ ✖️ 💲 💱 ™️ ©️ ®️ 〰️ ➰ ➿ 🔚 🔙 🔛 🔝 🔜 ✔️ ☑️ 🔘 🔴 🟠 🟡 🟢 🔵 🟣 ⚫ ⚪ 🟤 🔺 🔻 🔸 🔹 🔶 🔷 🔳 🔲 ▪️ ▫️ ◾ ◽ ◼️ ◻️ 🟥 🟧 🟨 🟩 🟦 🟪 ⬛ ⬜ 🟫 🔈 🔇 🔉 🔊 🔔 🔕 📣 📢 👁‍🗨 💬 💭 🗯️ ♠️ ♣️ ♥️ ♦️ 🃏 🎴 🀄'.split(' '),
  },
];

// Telegram only encrypts/protects the contents of the file when fetched
// via getMedia, so we run sticker thumbs through the in-panel media
// proxy. Store the resulting blob URLs in a small in-memory LRU so we
// don't refetch the same sticker thumbs repeatedly.
const STICKER_THUMB_CACHE = new Map();
const STICKER_THUMB_CACHE_MAX = 200;

function _cacheGet(key) {
  if (!STICKER_THUMB_CACHE.has(key)) return null;
  const v = STICKER_THUMB_CACHE.get(key);
  // Refresh LRU position.
  STICKER_THUMB_CACHE.delete(key);
  STICKER_THUMB_CACHE.set(key, v);
  return v;
}

function _cacheSet(key, url) {
  STICKER_THUMB_CACHE.set(key, url);
  while (STICKER_THUMB_CACHE.size > STICKER_THUMB_CACHE_MAX) {
    const first = STICKER_THUMB_CACHE.keys().next().value;
    const stale = STICKER_THUMB_CACHE.get(first);
    STICKER_THUMB_CACHE.delete(first);
    try { URL.revokeObjectURL(stale); } catch (_) { /* ignore */ }
  }
}

function StickerThumb({ sessionId, doc, alt }) {
  // We render the lower-resolution thumbnail returned by the backend.
  // The backend exposes a media-proxy endpoint that handles the
  // GramJS download + Range. We keep this dependency-free by hitting
  // it directly with fetch and turning the response into a blob URL.
  const [src, setSrc] = useState(() => _cacheGet(`${doc.id}`));
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    if (src) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const url = await getClientMedia(sessionId, {
          documentId: doc.id,
          accessHash: doc.accessHash,
          fileReference: doc.fileReference,
          thumb: true,
        });
        if (cancelled) return;
        if (url) {
          _cacheSet(`${doc.id}`, url);
          setSrc(url);
        } else {
          setErrored(true);
        }
      } catch (_) {
        if (!cancelled) setErrored(true);
      }
    })();
    return () => { cancelled = true; };
  }, [sessionId, doc.id, doc.accessHash, doc.fileReference, src]);

  if (errored || !src) {
    return (
      <div className="flex h-16 w-16 items-center justify-center rounded bg-dark-700 text-[10px] text-gray-500">
        {alt || '...'}
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={alt || ''}
      className="h-16 w-16 rounded object-contain"
      loading="lazy"
    />
  );
}

export default function StickerGifPicker({
  sessionId,
  onPickEmoji,
  onPickSticker,
  onPickGif,
  onClose,
}) {
  const [tab, setTab] = useState('emoji'); // 'emoji' | 'sticker' | 'gif'
  const [emojiTab, setEmojiTab] = useState(0);

  // Sticker tab state
  const [stickerSearch, setStickerSearch] = useState('');
  const [stickerLoading, setStickerLoading] = useState(false);
  const [stickerError, setStickerError] = useState(null);
  const [recentStickers, setRecentStickers] = useState([]);
  const [favStickers, setFavStickers] = useState([]);
  const [stickerSets, setStickerSets] = useState([]);
  const [stickerSearchResults, setStickerSearchResults] = useState(null);

  // GIF tab state
  const [gifSearch, setGifSearch] = useState('');
  const [gifLoading, setGifLoading] = useState(false);
  const [gifError, setGifError] = useState(null);
  const [savedGifs, setSavedGifs] = useState([]);
  const [gifResults, setGifResults] = useState(null);

  const stickerSearchTimerRef = useRef(null);
  const gifSearchTimerRef = useRef(null);
  const containerRef = useRef(null);

  useEffect(() => {
    const onDoc = (e) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target)) onClose?.();
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [onClose]);

  // Sticker initial fetch.
  useEffect(() => {
    if (tab !== 'sticker') return undefined;
    if (recentStickers.length || favStickers.length || stickerSets.length) return undefined;
    let cancelled = false;
    setStickerLoading(true);
    setStickerError(null);
    (async () => {
      try {
        const [r, f, s] = await Promise.all([
          getRecentStickers(sessionId).catch(() => null),
          getFavoriteStickers(sessionId).catch(() => null),
          getStickerSets(sessionId).catch(() => null),
        ]);
        if (cancelled) return;
        setRecentStickers(r?.data?.data?.stickers || []);
        setFavStickers(f?.data?.data?.stickers || []);
        setStickerSets(s?.data?.data?.sets || []);
      } catch (err) {
        if (!cancelled) setStickerError(err?.message || 'Failed to load stickers');
      } finally {
        if (!cancelled) setStickerLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [tab, sessionId, recentStickers.length, favStickers.length, stickerSets.length]);

  // Sticker search debounced.
  useEffect(() => {
    if (tab !== 'sticker') return undefined;
    if (stickerSearchTimerRef.current) clearTimeout(stickerSearchTimerRef.current);
    if (!stickerSearch.trim()) {
      setStickerSearchResults(null);
      return undefined;
    }
    stickerSearchTimerRef.current = setTimeout(async () => {
      try {
        const { data } = await searchStickers(sessionId, stickerSearch.trim());
        setStickerSearchResults(data?.data?.sets || []);
      } catch (err) {
        setStickerSearchResults([]);
      }
    }, 300);
    return () => {
      if (stickerSearchTimerRef.current) clearTimeout(stickerSearchTimerRef.current);
    };
  }, [stickerSearch, tab, sessionId]);

  // GIF initial fetch.
  useEffect(() => {
    if (tab !== 'gif') return undefined;
    if (savedGifs.length) return undefined;
    let cancelled = false;
    setGifLoading(true);
    setGifError(null);
    (async () => {
      try {
        const { data } = await getSavedGifs(sessionId);
        if (cancelled) return;
        setSavedGifs(data?.data?.gifs || []);
      } catch (err) {
        if (!cancelled) setGifError(err?.message || 'Failed to load GIFs');
      } finally {
        if (!cancelled) setGifLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [tab, sessionId, savedGifs.length]);

  // GIF search debounced.
  useEffect(() => {
    if (tab !== 'gif') return undefined;
    if (gifSearchTimerRef.current) clearTimeout(gifSearchTimerRef.current);
    if (!gifSearch.trim()) {
      setGifResults(null);
      return undefined;
    }
    gifSearchTimerRef.current = setTimeout(async () => {
      try {
        const { data } = await searchGifs(sessionId, gifSearch.trim());
        setGifResults(data?.data?.gifs || []);
      } catch (err) {
        setGifResults([]);
      }
    }, 350);
    return () => {
      if (gifSearchTimerRef.current) clearTimeout(gifSearchTimerRef.current);
    };
  }, [gifSearch, tab, sessionId]);

  const allStickerSetItems = useMemo(() => {
    if (stickerSearchResults) return stickerSearchResults;
    return stickerSets;
  }, [stickerSearchResults, stickerSets]);

  return (
    <div
      ref={containerRef}
      className="absolute bottom-12 left-0 z-30 w-[360px] overflow-hidden rounded-lg border border-white/10 bg-dark-900 shadow-2xl"
    >
      <div className="flex items-stretch border-b border-white/10">
        <TabButton icon={Smile} label="Emoji" active={tab === 'emoji'} onClick={() => setTab('emoji')} />
        <TabButton icon={Sticker} label="Stickers" active={tab === 'sticker'} onClick={() => setTab('sticker')} />
        <TabButton icon={Film} label="GIFs" active={tab === 'gif'} onClick={() => setTab('gif')} />
        <button
          type="button"
          onClick={onClose}
          className="ml-auto px-2 text-gray-400 hover:bg-white/5 hover:text-gray-200"
          aria-label="Close picker"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {tab === 'emoji' && (
        <div className="flex max-h-[300px] flex-col">
          <div className="flex items-center gap-1 overflow-x-auto border-b border-white/5 px-2 py-1">
            {EMOJI_TABS.map((t, idx) => (
              <button
                key={t.label}
                type="button"
                onClick={() => setEmojiTab(idx)}
                className={`shrink-0 rounded px-2 py-1 text-[11px] ${
                  emojiTab === idx
                    ? 'bg-white/10 text-gray-100'
                    : 'text-gray-400 hover:bg-white/5 hover:text-gray-200'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="grid flex-1 grid-cols-8 gap-1 overflow-y-auto p-2">
            {EMOJI_TABS[emojiTab].emojis.map((e, i) => (
              <button
                key={`${e}-${i}`}
                type="button"
                onClick={() => onPickEmoji?.(e)}
                className="h-8 w-8 rounded text-xl hover:bg-white/5"
                title={e}
              >
                {e}
              </button>
            ))}
          </div>
        </div>
      )}

      {tab === 'sticker' && (
        <div className="flex max-h-[360px] flex-col">
          <div className="flex items-center gap-2 border-b border-white/5 px-2 py-1.5">
            <Search className="h-3.5 w-3.5 text-gray-500" />
            <input
              type="text"
              value={stickerSearch}
              onChange={(e) => setStickerSearch(e.target.value)}
              placeholder="Search sticker sets…"
              className="flex-1 bg-transparent text-xs text-gray-100 placeholder:text-gray-500 focus:outline-none"
            />
          </div>
          <div className="flex-1 overflow-y-auto p-2">
            {stickerLoading ? (
              <div className="flex items-center justify-center py-6 text-xs text-gray-500">
                <Loader2 className="mr-2 h-3 w-3 animate-spin" /> Loading…
              </div>
            ) : stickerError ? (
              <div className="px-2 py-3 text-xs text-red-300">{stickerError}</div>
            ) : (
              <>
                {!stickerSearchResults && favStickers.length > 0 && (
                  <StickerRow
                    title="Favourites"
                    items={favStickers}
                    sessionId={sessionId}
                    onPick={onPickSticker}
                  />
                )}
                {!stickerSearchResults && recentStickers.length > 0 && (
                  <StickerRow
                    title="Recently used"
                    items={recentStickers}
                    sessionId={sessionId}
                    onPick={onPickSticker}
                  />
                )}
                {(allStickerSetItems || []).map((set) => (
                  <StickerRow
                    key={set.id}
                    title={set.title || set.shortName}
                    items={set.stickers || []}
                    sessionId={sessionId}
                    onPick={onPickSticker}
                  />
                ))}
                {stickerSearchResults && allStickerSetItems.length === 0 && (
                  <div className="py-6 text-center text-xs text-gray-500">
                    No stickers found.
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {tab === 'gif' && (
        <div className="flex max-h-[360px] flex-col">
          <div className="flex items-center gap-2 border-b border-white/5 px-2 py-1.5">
            <Search className="h-3.5 w-3.5 text-gray-500" />
            <input
              type="text"
              value={gifSearch}
              onChange={(e) => setGifSearch(e.target.value)}
              placeholder="Search GIFs…"
              className="flex-1 bg-transparent text-xs text-gray-100 placeholder:text-gray-500 focus:outline-none"
            />
          </div>
          <div className="flex-1 overflow-y-auto p-2">
            {gifLoading ? (
              <div className="flex items-center justify-center py-6 text-xs text-gray-500">
                <Loader2 className="mr-2 h-3 w-3 animate-spin" /> Loading…
              </div>
            ) : gifError ? (
              <div className="px-2 py-3 text-xs text-red-300">{gifError}</div>
            ) : (
              <div className="grid grid-cols-3 gap-1">
                {(gifResults ?? savedGifs).map((g) => (
                  <button
                    key={`${g.id}`}
                    type="button"
                    onClick={() => onPickGif?.(g)}
                    className="overflow-hidden rounded bg-dark-800 hover:ring-1 hover:ring-blue-400/40"
                  >
                    <StickerThumb sessionId={sessionId} doc={g} alt="GIF" />
                  </button>
                ))}
                {(gifResults ?? savedGifs).length === 0 && (
                  <div className="col-span-3 py-6 text-center text-xs text-gray-500">
                    {gifSearch.trim() ? 'No GIFs found.' : 'No saved GIFs.'}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function TabButton({ icon: Icon, label, active, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1 px-3 py-2 text-xs font-medium ${
        active ? 'bg-white/5 text-gray-100' : 'text-gray-400 hover:bg-white/5 hover:text-gray-200'
      }`}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}

function StickerRow({ title, items, sessionId, onPick }) {
  if (!items || items.length === 0) return null;
  return (
    <div className="mb-3">
      <div className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-wider text-gray-500">
        {title}
      </div>
      <div className="grid grid-cols-4 gap-1">
        {items.map((s) => (
          <button
            key={`${s.id}`}
            type="button"
            onClick={() => onPick?.(s)}
            className="overflow-hidden rounded bg-dark-800 hover:ring-1 hover:ring-blue-400/40"
            title={s.alt || ''}
          >
            <StickerThumb sessionId={sessionId} doc={s} alt={s.alt} />
          </button>
        ))}
      </div>
    </div>
  );
}
