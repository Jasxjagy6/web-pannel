/**
 * AiChatWorker — BullMQ worker that generates AI replies and sends them.
 *
 * Job data:
 *   { sessionId, userId, peerType, peerId, incomingMessage, recipient, config,
 *     conversationState: { messages, lastExchange }, confirmedMessageIds }
 *
 * Steps:
 *   1. Get conversation state from job data (includes unconfirmed AI msgs + new user msgs).
 *   2. Wait for the configured reply delay + jitter.
 *   3. Call the selected AI provider (CupidBot or CapitalBot) based on config.provider.
 *   4. Handle response categories (notOurTurn, ghosting, etc.).
 *   5. If response has text, send through the session's GramJS client.
 *   6. Track confirmed AI message IDs for next API call.
 *   7. Append outgoing message to memory with confirmed=false.
 *   8. Log the attempt to ai_response_logs with provider metadata.
 */

const { Worker } = require('bullmq');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Api } = require('telegram');
const cupidbotService = require('../services/cupidbotService');
const capitalbotService = require('../services/capitalbotService');
const aiMemoryService = require('../services/aiMemoryService');
const tgService = require('../services/telegramService');
const tcService = require('../services/telegramClientService');
const { pool } = require('../config/database');
const logger = require('../utils/logger');

const redisConnection = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6382', 10),
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null,
};

const CONCURRENCY = parseInt(process.env.CUPIDBOT_CONCURRENCY || process.env.CAPITALBOT_CONCURRENCY || '5', 10);
const DEFAULT_REPLY_DELAY_MS = parseInt(process.env.AI_REPLY_DELAY_MS || '3000', 10);
const DEFAULT_JITTER_MS = parseInt(process.env.AI_REPLY_JITTER_MS || '2000', 10);
const DEFAULT_MEMORY_LIMIT = parseInt(process.env.AI_MEMORY_MESSAGE_LIMIT || '100', 10);

const QUEUE_NAME = 'ai-chat-jobs';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function processGenerateReply(job) {
  const {
    sessionId,
    userId,
    peerType,
    peerId,
    incomingMessage,
    recipient,
    config,
    conversationState,
    confirmedMessageIds = [],
    botProfile = {},
  } = job.data;

  const sid = Number(sessionId);
  const pid = Number(peerId);

  const logRow = {
    session_id: sid,
    peer_type: peerType,
    peer_id: pid,
    incoming_msg_id: incomingMessage?.telegramMessageId || null,
    request_payload: job.data,
    response_payload: null,
    status: 'pending',
    error_message: null,
    cupidbot_category: null,
    cupidbot_did_convert: null,
    cupidbot_rate_limit: null,
    is_followup: false,
    confirmed_ai_message_ids: [],
  };

  // Select AI provider from config (default: cupidbot for backward compatibility)
  const provider = (config.provider || config.aiProvider || 'cupidbot').toLowerCase();
  const aiService = provider === 'capitalbot' ? capitalbotService : cupidbotService;

  try {
    // Use conversation state from aiChatService
    const lastExchange = conversationState?.lastExchange || { lastIncoming: null, lastOutgoing: null };

    // CapitalBot uses full chat history (API handles state internally)
    // CupidBot only needs unconfirmed AI msgs + new incoming msgs
    const messagesForAI = provider === 'capitalbot'
      ? (conversationState?.allRecent || conversationState?.messages || [])
      : (conversationState?.messages || []);

    // Follow-up handling differs per provider:
    // CupidBot requires explicit isFollowUp flag; CapitalBot auto-detects from chatHistory roles
    const isFollowUp = provider !== 'capitalbot' && messagesForAI.length === 0 && lastExchange.lastIncoming;

    const replyDelay = config.replyDelayMs ?? DEFAULT_REPLY_DELAY_MS;
    const jitter = config.replyDelayJitterMs ?? DEFAULT_JITTER_MS;
    await sleep(replyDelay + Math.random() * jitter);

    logger.info(`AI Worker: calling ${provider} for session ${sid} peer ${peerType}:${pid}, messages=${messagesForAI.length}, isFollowUp=${isFollowUp}`);

    const providerOverrides = provider === 'capitalbot' ? (config.capitalbot || {}) : (config.cupidbot || {});

    const aiResponse = await aiService.generateReply({
      userId,
      accountID: sessionId,
      recipient,
      messages: messagesForAI,
      overrides: providerOverrides,
      isFollowUp,
      confirmedMessageIds: provider === 'capitalbot' ? [] : confirmedMessageIds,
      botProfile,
    });

    logRow.response_payload = aiResponse;
    logRow.cupidbot_category = aiResponse.category;
    logRow.cupidbot_did_convert = aiResponse.didConvert;
    logRow.cupidbot_rate_limit = aiResponse.rateLimit;
    logRow.is_followup = isFollowUp;

    // Parse provider response category
    const categoryInfo = aiService.parseResponseCategory(aiResponse.category);

    // Handle special response categories
    if (categoryInfo.isNotOurTurn) {
      logger.info(`AI Worker: ${provider} says not our turn for session ${sid} peer ${pid}`);
      logRow.status = 'not_our_turn';
      await _insertLog(logRow);
      return { sent: false, reason: 'not_our_turn' };
    }

    if (categoryInfo.isGhosting) {
      logger.warn(`AI Worker: ${provider} ghosting for session ${sid} peer ${pid}: ${categoryInfo.reason}`);
      logRow.status = 'ghosting';
      logRow.error_message = categoryInfo.reason;
      await _insertLog(logRow);

      // Update conversation state to mark as ghosted
      await _updateConversationState(sid, peerType, pid, 'ghosted', aiResponse.category);
      return { sent: false, reason: 'ghosting', category: aiResponse.category };
    }

    // Handle rate limiting
    if (aiResponse.rateLimit) {
      logger.warn(`AI Worker: ${provider} rate limit for session ${sid}: ${JSON.stringify(aiResponse.rateLimit)}`);
    }

    // Build the ordered list of content pieces to send. CapitalBot returns
    // an ordered `content` array (text | image | video | audio items) that
    // the user should receive in sequence. Other providers only produce a
    // single text reply, which we wrap into one item so the whole send
    // pipeline (including per-item media handling) stays shared.
    const contentItems =
      provider === 'capitalbot' && Array.isArray(aiResponse.content) && aiResponse.content.length > 0
        ? aiResponse.content
        : [];
    if (contentItems.length === 0 && aiResponse.text) {
      contentItems.push({ type: 'text', content: aiResponse.text });
    }
    const sendableItems = contentItems.filter(
      (item) => item.content && String(item.content).trim()
    );

    if (sendableItems.length === 0) {
      // CapitalBot returns empty content with converted=true when the user
      // has AGREED to the CTA/conversion — the API intentionally stops
      // sending messages. That is a SUCCESS, not a failed/empty reply, so
      // log it distinctly instead of dragging down the no-reply rate.
      if (aiResponse.didConvert) {
        logRow.status = 'converted';
        await _insertLog(logRow);
        await _updateConversationState(sid, peerType, pid, 'converted', aiResponse.category);
        return { sent: false, reason: 'converted', didConvert: true };
      }
      logRow.status = 'no_reply';
      await _insertLog(logRow);
      return { sent: false, reason: 'empty_reply' };
    }

    // Send each content piece in order. Text failures are fatal (matches
    // the previous single-message behavior — an unreachable peer, privacy
    // block, flood, etc.). Media failures are best-effort: a URL that 404s
    // or times out is skipped so the rest of the reply still goes through.
    const confirmedIds = [];
    let lastOutgoingMessageId = null;
    let anySent = false;
    let sendFailure = null;

    for (const item of sendableItems) {
      if (item.type === 'text') {
        try {
          const sent = await _sendTextToPeer(sessionId, pid, String(item.content), recipient);
          const mid = tcService._toIdNum(sent?.messageId ?? sent?.id);
          lastOutgoingMessageId = mid;
          confirmedIds.push(String(mid));
          await _appendOutgoingMemory(sid, peerType, pid, item, mid, config);
          anySent = true;
        } catch (sendErr) {
          sendFailure = sendErr;
          logger.warn(
            `AI chat sendMessage failed for session ${sid} peer ${pid}: ${sendErr.message}. ` +
            `${provider} response: ${JSON.stringify(aiResponse)}`
          );
          break;
        }
      } else {
        const sent = await _sendMediaToPeer(sessionId, pid, item, recipient);
        if (sent) {
          const mid = tcService._toIdNum(sent?.id);
          lastOutgoingMessageId = mid;
          confirmedIds.push(String(mid));
          await _appendOutgoingMemory(sid, peerType, pid, item, mid, config);
          anySent = true;
        } else {
          logger.warn(`AI Worker: skipped ${item.type} item for session ${sid} peer ${pid}`);
        }
      }
    }

    if (!anySent) {
      // Distinguish an UNREACHABLE peer (stale access_hash — Telegram
      // won't let us message this stranger, nothing we can do) from a
      // genuine send failure. The AI itself worked; the peer is just not
      // messageable. Logged as `send_failed` still records the reason but
      // the error text carries PEER_ID_INVALID so dashboards can exclude
      // it from the real failure rate.
      logRow.status = 'send_failed';
      logRow.error_message = sendFailure ? sendFailure.message : 'All content items failed to send';
      await _insertLog(logRow);
      return { sent: false, reason: 'send_failed' };
    }

    if (sendFailure) {
      // A later text item failed after earlier items already went out —
      // the reply was delivered, so log the warning but keep status=sent.
      logger.warn(`AI Worker: partial send failure for session ${sid} peer ${pid}: ${sendFailure.message}`);
    }

    logRow.status = 'sent';
    logRow.confirmed_ai_message_ids = confirmedIds;
    await _insertLog(logRow);

    // Update conversation state with last AI message sent
    await _updateConversationState(sid, peerType, pid, 'active', aiResponse.category, lastOutgoingMessageId);

    logger.info(`AI Worker: successfully sent reply for session ${sid} peer ${pid}, msgId=${lastOutgoingMessageId}`);
    return { sent: true, messageId: lastOutgoingMessageId, category: aiResponse.category, didConvert: aiResponse.didConvert };
  } catch (err) {
    logRow.status = 'failed';
    logRow.error_message = err.message;
    await _insertLog(logRow);

    // Check if it's a rate limit error
    if (err.statusCode === 429) {
      logRow.status = 'rate_limited';
      await _insertLog(logRow);
    }

    logger.warn(`AI chat job failed for session ${sid}: ${err.message}`);
    throw err;
  }
}

/**
 * Send a text message with entity-cache recovery.
 *
 * "Could not find the input entity" means this peer isn't in the session's
 * GramJS entity cache (common for a brand-new incoming DM right after a
 * restart, before any catch-up sweep warmed the cache). getDialogs()
 * repopulates the entity cache; then the retry resolves. Only do this for
 * the entity error — other send failures (privacy, flood, etc.) aren't
 * fixed by a dialog scan. PEER_ID_INVALID is the same underlying problem,
 * so it's retried once too.
 */
async function _sendTextToPeer(sessionId, pid, text, recipient) {
  const sid = Number(sessionId);
  const doSend = () => tgService.sendMessage(
    sessionId,
    pid,
    text,
    { silent: false, accessHash: recipient?.accessHash || null }
  );
  try {
    return await doSend();
  } catch (sendErr) {
    const isEntityErr = /input entity|Could not find the input|PEER_ID_INVALID|PEER_ID/i.test(sendErr.message || '');
    if (!isEntityErr) throw sendErr;

    const entry = tgService.clients.get(String(sid));
    const client = entry && entry.client ? entry.client : null;
    if (!client) throw sendErr;

    // Strategy 1: warm the entity cache with getDialogs, then retry via
    // the normal send path.
    let sent;
    let recovered = false;
    try {
      await client.getDialogs({ limit: 200 });
      sent = await doSend();
      recovered = true;
      logger.info(`AI Worker: recovered send for session ${sid} peer ${pid} after entity-cache warm`);
    } catch (_) { /* fall through */ }

    // Strategy 2: build the InputPeerUser directly from the peer id + the
    // access_hash the catch-up captured from the dialog. This resolves
    // peers that getDialogs didn't surface (older than the top-200 window)
    // but for which we already hold a valid hash.
    if (!recovered && recipient?.accessHash) {
      try {
        const inputPeer = new Api.InputPeerUser({
          userId: BigInt(pid),
          accessHash: BigInt(String(recipient.accessHash)),
        });
        sent = await client.sendMessage(inputPeer, { message: text });
        recovered = true;
        logger.info(`AI Worker: recovered send for session ${sid} peer ${pid} via direct InputPeerUser`);
      } catch (directErr) {
        logger.warn(`AI Worker: direct-peer retry failed for session ${sid} peer ${pid}: ${directErr.message}`);
      }
    }

    if (!recovered) throw sendErr;
    return sent;
  }
}

/**
 * Resolve the peer entity for a media send, with the same entity-cache
 * recovery used for text sends. Returns `{ client, entity }`.
 */
async function _resolvePeerForSend(sessionId, pid, recipient) {
  const sid = Number(sessionId);
  const entry = tgService.clients.get(String(sid));
  const client = entry && entry.client ? entry.client : null;
  const doResolve = () => tgService._resolveEntity(sessionId, pid, {
    accessHash: recipient?.accessHash || null,
  });

  try {
    return { client, entity: await doResolve() };
  } catch (resolveErr) {
    const isEntityErr = /input entity|Could not find the input|PEER_ID_INVALID|PEER_ID/i.test(resolveErr.message || '');
    if (!isEntityErr) throw resolveErr;
  }

  if (client) {
    try { await client.getDialogs({ limit: 200 }); } catch (_) { /* ignore */ }
    try {
      return { client, entity: await doResolve() };
    } catch (err) {
      const isEntityErr = /input entity|Could not find the input|PEER_ID_INVALID|PEER_ID/i.test(err.message || '');
      if (!isEntityErr) throw err;
    }
  }

  if (recipient?.accessHash) {
    return {
      client,
      entity: new Api.InputPeerUser({
        userId: BigInt(pid),
        accessHash: BigInt(String(recipient.accessHash)),
      }),
    };
  }

  throw new Error(`Could not resolve peer ${pid} for media send`);
}

/**
 * Send a media content item (image | video | audio) from CapitalBot.
 * Downloads the media URL to a temp file, then uploads it via the session
 * client's sendFile. Returns the sent message, or null on any failure so
 * the caller can skip it (best-effort).
 */
async function _sendMediaToPeer(sessionId, pid, item, recipient) {
  const sid = Number(sessionId);
  const url = String(item.content || '').trim();
  if (!/^https?:\/\//i.test(url)) {
    logger.warn(`AI Worker: invalid ${item.type} URL for session ${sid} peer ${pid}: ${url.slice(0, 80)}`);
    return null;
  }

  let tmpPath;
  try {
    tmpPath = await _downloadToTemp(url);
  } catch (err) {
    logger.warn(`AI Worker: media download failed for session ${sid} peer ${pid}: ${err.message}`);
    return null;
  }

  try {
    const { client, entity } = await _resolvePeerForSend(sessionId, pid, recipient);
    if (!client) throw new Error('Session client not loaded');
    const sendOpts = _buildMediaSendOptions(item.type, tmpPath, url);
    const result = await tgService._withFloodRetry(sessionId, async () => {
      return await client.sendFile(entity, sendOpts);
    });
    return result;
  } catch (err) {
    logger.warn(`AI Worker: media send failed for session ${sid} peer ${pid}: ${err.message}`);
    return null;
  } finally {
    try { fs.unlinkSync(tmpPath); } catch (_) { /* ignore */ }
  }
}

function _buildMediaSendOptions(type, tmpPath, url) {
  const fileName = _fileNameFromUrl(url) || _defaultFileName(type);
  if (type === 'image') {
    // No attributes → GramJS auto-detects the photo from the file's mime
    // type. A .gif is sent as an animation instead of a static photo.
    if (/\.gif$/i.test(fileName)) {
      return {
        file: tmpPath,
        forceDocument: true,
        attributes: [new Api.DocumentAttributeAnimated(), new Api.DocumentAttributeFilename({ fileName })],
      };
    }
    return { file: tmpPath };
  }
  if (type === 'video') {
    return {
      file: tmpPath,
      attributes: [
        new Api.DocumentAttributeVideo({ duration: 0, w: 0, h: 0, supportsStreaming: true }),
        new Api.DocumentAttributeFilename({ fileName }),
      ],
      fileName,
    };
  }
  // audio → voice note
  return {
    file: tmpPath,
    attributes: [
      new Api.DocumentAttributeAudio({ duration: 0, voice: true }),
      new Api.DocumentAttributeFilename({ fileName }),
    ],
    voiceNote: true,
    fileName,
  };
}

function _defaultFileName(type) {
  if (type === 'video') return 'video.mp4';
  if (type === 'audio') return 'voice.ogg';
  return 'image.jpg';
}

function _extFromUrl(url) {
  try {
    const m = /\.[a-z0-9]{2,5}$/i.exec(new URL(url).pathname);
    return m ? m[0].toLowerCase() : '';
  } catch {
    return '';
  }
}

function _fileNameFromUrl(url) {
  try {
    const base = String(new URL(url).pathname).split('/').pop();
    return base && /\.[a-z0-9]{2,5}$/i.test(base) ? decodeURIComponent(base) : null;
  } catch {
    return null;
  }
}

function _downloadToTemp(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const reqOpts = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (TelegramPanelAI/1.0)',
        Accept: '*/*',
      },
      timeout: 60000,
    };
    const req = https.request(reqOpts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(_downloadToTemp(new URL(res.headers.location, url).toString()));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const tmpPath = path.join(
        os.tmpdir(),
        `ai-media-${Date.now()}-${Math.round(Math.random() * 1e9)}${_extFromUrl(url)}`
      );
      const ws = fs.createWriteStream(tmpPath);
      res.pipe(ws);
      ws.on('finish', () => resolve(tmpPath));
      ws.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Media download timed out'));
    });
    req.end();
  });
}

/**
 * Append one memory item for a sent content piece so the AI's chat history
 * stays in sync (text pieces as text, media pieces as a marker + medias).
 */
async function _appendOutgoingMemory(sid, peerType, pid, item, mid, config) {
  const isMedia = item.type !== 'text';
  const outgoingItem = {
    id: `tg-ai-${mid ?? Date.now()}`,
    telegramMessageId: mid,
    timestamp: Date.now(),
    msg: isMedia ? '' : String(item.content),
    isIncoming: false,
    medias: isMedia ? [{ kind: item.type, hasMedia: true }] : [],
    confirmed: false, // Will be marked confirmed on next successful API call
  };
  await aiMemoryService.append(
    sid,
    peerType,
    pid,
    outgoingItem,
    config.memoryMessageLimit || DEFAULT_MEMORY_LIMIT
  );
}

/**
 * Update conversation state in ai_chat_memories after a response.
 */
async function _updateConversationState(sessionId, peerType, peerId, state, category, lastAiMessageId = null) {
  try {
    await pool.query(
      `UPDATE ai_chat_memories
       SET ai_conversation_state = $4,
           last_ai_category = $5,
           last_ai_response = $6,
           updated_at = NOW()
       WHERE session_id = $1 AND peer_type = $2 AND peer_id = $3`,
      [
        sessionId,
        peerType,
        peerId,
        state,
        category,
        JSON.stringify({ lastAiMessageId, updatedAt: new Date().toISOString() }),
      ]
    );
  } catch (err) {
    logger.warn(`Failed to update conversation state: ${err.message}`);
  }
}

async function _insertLog(row) {
  try {
    await pool.query(
      `INSERT INTO ai_response_logs
         (session_id, peer_type, peer_id, incoming_msg_id, request_payload, response_payload, status, error_message,
          cupidbot_category, cupidbot_did_convert, cupidbot_rate_limit, is_followup, confirmed_ai_message_ids)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        row.session_id,
        row.peer_type,
        row.peer_id,
        row.incoming_msg_id,
        JSON.stringify(row.request_payload),
        JSON.stringify(row.response_payload),
        row.status,
        row.error_message,
        row.cupidbot_category,
        row.cupidbot_did_convert,
        JSON.stringify(row.cupidbot_rate_limit),
        row.is_followup,
        row.confirmed_ai_message_ids,
      ]
    );
  } catch (err) {
    logger.warn(`ai_response_logs insert failed: ${err.message}`);
  }
}

let worker;
function start() {
  worker = new Worker(QUEUE_NAME, processGenerateReply, {
    connection: redisConnection,
    concurrency: CONCURRENCY,
  });

  worker.on('completed', (job) => {
    logger.debug(`AI chat job ${job.id} completed`, { result: job.returnvalue });
  });

  worker.on('failed', (job, err) => {
    logger.warn(`AI chat job ${job?.id} failed: ${err.message}`);
  });

  logger.info(`AI chat worker started (concurrency=${CONCURRENCY})`);
}

async function stop() {
  if (worker) {
    await worker.close();
    worker = null;
  }
}

module.exports = { start, stop, _processGenerateReply: processGenerateReply };