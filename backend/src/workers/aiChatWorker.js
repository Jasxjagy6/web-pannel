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

    if (!aiResponse.text) {
      logRow.status = 'no_reply';
      await _insertLog(logRow);
      return { sent: false, reason: 'empty_reply' };
    }

    // Send the message via Telegram.
    const doSend = () => tgService.sendMessage(
      sessionId,
      pid,
      aiResponse.text,
      { silent: false, accessHash: recipient?.accessHash || null }
    );
    let sent;
    try {
      sent = await doSend();
    } catch (sendErr) {
      // "Could not find the input entity" means this peer isn't in the
      // session's GramJS entity cache (common for a brand-new incoming DM
      // right after a restart, before any catch-up sweep warmed the
      // cache). getDialogs() repopulates the entity cache; then the retry
      // resolves. Only do this for the entity error — other send failures
      // (privacy, flood, etc.) aren't fixed by a dialog scan.
      const isEntityErr = /input entity|Could not find the input/i.test(sendErr.message || '');
      let recovered = false;
      if (isEntityErr) {
        try {
          const entry = tgService.clients.get(String(sid));
          if (entry && entry.client) {
            await entry.client.getDialogs({ limit: 200 });
            sent = await doSend();
            recovered = true;
            logger.info(`AI Worker: recovered send for session ${sid} peer ${pid} after entity-cache warm`);
          }
        } catch (retryErr) {
          logger.warn(`AI Worker: entity-warm retry failed for session ${sid} peer ${pid}: ${retryErr.message}`);
        }
      }
      if (!recovered) {
        logger.warn(
          `AI chat sendMessage failed for session ${sid} peer ${pid}: ${sendErr.message}. ` +
          `${provider} response: ${JSON.stringify(aiResponse)}`
        );
        logRow.status = 'send_failed';
        logRow.error_message = sendErr.message;
        await _insertLog(logRow);
        return { sent: false, reason: 'send_failed' };
      }
    }

    // Track the outgoing message ID for confirmation on next API call
    const outgoingMessageId = tcService._toIdNum(sent?.messageId ?? sent?.id);
    const outgoingItem = {
      id: `tg-ai-${outgoingMessageId ?? Date.now()}`,
      telegramMessageId: outgoingMessageId,
      timestamp: Date.now(),
      msg: aiResponse.text,
      isIncoming: false,
      medias: [],
      confirmed: false, // Will be marked confirmed on next successful API call
    };

    await aiMemoryService.append(
      sid,
      peerType,
      pid,
      outgoingItem,
      config.memoryMessageLimit || DEFAULT_MEMORY_LIMIT
    );

    // Mark this outgoing message as pending confirmation
    // We'll confirm it on the next successful API call
    const confirmedIds = [String(outgoingMessageId)].filter(Boolean);

    // Log success with confirmed message IDs
    logRow.status = 'sent';
    logRow.confirmed_ai_message_ids = confirmedIds;
    await _insertLog(logRow);

    // Update conversation state with last AI message sent
    await _updateConversationState(sid, peerType, pid, 'active', aiResponse.category, outgoingMessageId);

    logger.info(`AI Worker: successfully sent reply for session ${sid} peer ${pid}, msgId=${outgoingMessageId}`);
    return { sent: true, messageId: outgoingMessageId, category: aiResponse.category, didConvert: aiResponse.didConvert };
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