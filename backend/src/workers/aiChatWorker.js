/**
 * AiChatWorker — BullMQ worker that generates AI replies and sends them.
 *
 * Job data:
 *   { sessionId, userId, peerType, peerId, incomingMessage, recipient, config }
 *
 * Steps:
 *   1. Read the current memory window.
 *   2. Wait for the configured reply delay + jitter.
 *   3. Call CupidBot generateChatResponse.
 *   4. Send the returned text through the session's GramJS client.
 *   5. Append the outgoing message to memory.
 *   6. Log the attempt to ai_response_logs.
 */

const { Worker } = require('bullmq');
const { Api } = require('telegram');
const { getRedisConnection } = require('../config/redis');
const cupidbotService = require('../services/cupidbotService');
const aiMemoryService = require('../services/aiMemoryService');
const tgService = require('../services/telegramService');
const tcService = require('../services/telegramClientService');
const { pool } = require('../config/database');
const logger = require('../utils/logger');

const CONCURRENCY = parseInt(process.env.CUPIDBOT_CONCURRENCY || '5', 10);
const DEFAULT_REPLY_DELAY_MS = parseInt(process.env.AI_REPLY_DELAY_MS || '3000', 10);
const DEFAULT_JITTER_MS = parseInt(process.env.AI_REPLY_JITTER_MS || '2000', 10);
const DEFAULT_MEMORY_LIMIT = parseInt(process.env.AI_MEMORY_MESSAGE_LIMIT || '50', 10);

const QUEUE_NAME = 'ai-chat-jobs';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function processGenerateReply(job) {
  const { sessionId, peerType, peerId, incomingMessage, recipient, config } = job.data;
  const logRow = {
    session_id: sessionId,
    peer_type: peerType,
    peer_id: peerId,
    incoming_msg_id: incomingMessage?.telegramMessageId || null,
    request_payload: job.data,
    response_payload: null,
    status: 'pending',
    error_message: null,
  };

  try {
    const messages = await aiMemoryService.getMessages(
      sessionId,
      peerType,
      peerId,
      config.memoryMessageLimit || DEFAULT_MEMORY_LIMIT
    );

    const replyDelay = config.replyDelayMs ?? DEFAULT_REPLY_DELAY_MS;
    const jitter = config.replyDelayJitterMs ?? DEFAULT_JITTER_MS;
    await sleep(replyDelay + Math.random() * jitter);

    const cupid = await cupidbotService.generateReply({
      accountID: sessionId,
      recipient,
      messages,
      overrides: config.cupidbot || {},
    });

    logRow.response_payload = cupid;

    if (!cupid.text) {
      logRow.status = 'no_reply';
      await _insertLog(logRow);
      return { sent: false, reason: 'empty_reply' };
    }

    const sent = await tgService.sendMessage(
      sessionId,
      peerId,
      cupid.text,
      { silent: false }
    );

    const outgoingItem = {
      id: `tg-ai-${sent?.messageId ?? Date.now()}`,
      telegramMessageId: tcService._toIdNum(sent?.messageId ?? sent?.id),
      timestamp: Date.now(),
      msg: cupid.text,
      isIncoming: false,
      medias: [],
    };
    await aiMemoryService.append(
      sessionId,
      peerType,
      peerId,
      outgoingItem,
      config.memoryMessageLimit || DEFAULT_MEMORY_LIMIT
    );

    logRow.status = 'sent';
    await _insertLog(logRow);

    return { sent: true, messageId: sent?.messageId };
  } catch (err) {
    logRow.status = 'failed';
    logRow.error_message = err.message;
    await _insertLog(logRow);
    logger.warn(`AI chat job failed for session ${sessionId}: ${err.message}`);
    throw err;
  }
}

async function _insertLog(row) {
  try {
    await pool.query(
      `INSERT INTO ai_response_logs
         (session_id, peer_type, peer_id, incoming_msg_id, request_payload, response_payload, status, error_message)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        row.session_id,
        row.peer_type,
        row.peer_id,
        row.incoming_msg_id,
        JSON.stringify(row.request_payload),
        JSON.stringify(row.response_payload),
        row.status,
        row.error_message,
      ]
    );
  } catch (err) {
    logger.warn(`ai_response_logs insert failed: ${err.message}`);
  }
}

let worker;
function start() {
  worker = new Worker(QUEUE_NAME, processGenerateReply, {
    connection: getRedisConnection(),
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
