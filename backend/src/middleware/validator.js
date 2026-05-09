const Joi = require('joi');
const { AppError } = require('../utils/errorHandler');

const validate = (schema, source = 'body') => {
  return (req, res, next) => {
    const data = source === 'body' ? req.body : source === 'query' ? req.query : req.params;
    const { error } = schema.validate(data, { abortEarly: false, stripUnknown: true });

    if (error) {
      const messages = error.details.map((detail) => detail.message).join(', ');
      return next(new AppError(messages, 400, 'VALIDATION_ERROR'));
    }

    next();
  };
};

const schemas = {
  register: Joi.object({
    email: Joi.string().email().required(),
    password: Joi.string().min(8).max(128).required(),
    role: Joi.string().valid('user', 'admin').default('user'),
  }),

  login: Joi.object({
    email: Joi.string().email().required(),
    password: Joi.string().required(),
  }),

  sessionUpload: Joi.object({
    apiId: Joi.number().integer().positive(),
    apiHash: Joi.string().max(100),
  }),

  scrapeGroup: Joi.object({
    sessionId: Joi.number().integer().positive().required(),
    groupId: Joi.string().required(),
    limit: Joi.number().integer().min(1).max(100000).default(10000),
    filterBots: Joi.boolean().default(true),
    includeDetails: Joi.boolean().default(true),
    saveToList: Joi.boolean().default(false),
    listName: Joi.string().max(255),
  }),

  scrapeChannel: Joi.object({
    sessionId: Joi.number().integer().positive().required(),
    channelId: Joi.string().required(),
    limit: Joi.number().integer().min(1).max(100000).default(10000),
  }),

  sendMessage: Joi.object({
    sessionId: Joi.number().integer().positive().required(),
    targetId: Joi.alternatives().try(Joi.string(), Joi.number()).required(),
    message: Joi.string().max(4096).required(),
    messageType: Joi.string().valid('text', 'html', 'markdown').default('text'),
    mediaPath: Joi.string(),
  }),

  bulkMessage: Joi.object({
    // sessionIds is required *unless* the caller resolves sessions via a
    // sessionListId (handled in the controller). We still accept the
    // legacy required-array contract.
    sessionIds: Joi.array().items(Joi.number().integer().positive()).min(1).optional(),
    sessionListId: Joi.alternatives().try(Joi.number().integer().positive(), Joi.string()).optional(),
    targetList: Joi.array().items(
      Joi.alternatives().try(
        Joi.string(),
        Joi.number(),
        Joi.object({
          telegram_id: Joi.alternatives().try(Joi.string(), Joi.number()).allow(null, ''),
          telegramId: Joi.alternatives().try(Joi.string(), Joi.number()).allow(null, ''),
          id: Joi.alternatives().try(Joi.string(), Joi.number()).allow(null, ''),
          username: Joi.string().allow(null, ''),
          first_name: Joi.string().allow(null, ''),
          last_name: Joi.string().allow(null, ''),
          phone: Joi.string().allow(null, ''),
        }).unknown(true)
      )
    ).min(1).required(),
    message: Joi.string().max(4096).required(),
    messageType: Joi.string().valid('text', 'html', 'markdown').default('text'),
    mediaPath: Joi.string(),
    delayMin: Joi.number().min(1).max(10).default(1),
    delayMax: Joi.number().min(1).max(10).default(3),
    messagesPerSession: Joi.number().integer().min(1).default(50),
    messageOptions: Joi.alternatives().try(Joi.object().unknown(true), Joi.string()).optional(),
    async: Joi.alternatives().try(Joi.boolean(), Joi.string()).optional(),
    sourceType: Joi.string().valid('manual', 'list').default('manual'),
    sourceId: Joi.number().integer().positive().optional(),
    // Distribution-engine knobs (see distributionPlanner.js). These
    // are independent of `delayMin/delayMax` (which the legacy code
    // path uses) and are accepted in their own units: cooldown in
    // seconds, per-item delay in milliseconds.
    mode: Joi.string().valid('auto', 'manual').default('auto'),
    perSessionBurst: Joi.number().integer().min(1).max(500).optional(),
    // Hard per-session-per-burst ceiling. The redesigned add-members
    // runner clamps `perSessionBurst` to this value across all auto
    // bands so a session never gets pushed into PEER_FLOOD territory
    // in a single rotation. Defaults to 4 server-side; capped at 50
    // here so an operator override can't accidentally re-introduce
    // the old "70 invites in a row" behaviour.
    maxPerSession: Joi.number().integer().min(1).max(50).optional(),
    cooldownSecMin: Joi.number().integer().min(0).max(1800).optional(),
    cooldownSecMax: Joi.number().integer().min(0).max(1800).optional(),
    itemDelayMsMin: Joi.number().integer().min(0).max(600000).optional(),
    itemDelayMsMax: Joi.number().integer().min(0).max(600000).optional(),
  }).or('sessionIds', 'sessionListId'),

  // Single-User Mass DM
  // ---------------------------------------------------------------
  // Operator picks 1..3 target users (username / @username / numeric
  // Telegram id), a message, a per-send delay, and one or more
  // sessions. Every selected session DMs every target, with the
  // delay (in seconds) inserted BETWEEN consecutive sends. The
  // 3-target hard cap is intentional: pushing the same DM to many
  // strangers from one session is the fastest way to trigger
  // PEER_FLOOD / SPAM_BLOCK on the account.
  singleUserMassDm: Joi.object({
    sessionIds: Joi.array().items(Joi.number().integer().positive()).min(1).optional(),
    sessionListId: Joi.alternatives().try(Joi.number().integer().positive(), Joi.string()).optional(),
    // Targets: 1..3 strings (username, @username or numeric id).
    targets: Joi.array().items(Joi.string().trim().min(1).max(64)).min(1).max(3).required(),
    message: Joi.string().min(1).max(4096).required(),
    messageType: Joi.string().valid('text', 'html', 'markdown').default('text'),
    // Per-send delay in seconds. 1..120 keeps the slowest legitimate
    // composition usable while preventing 0-second runaway loops.
    delaySeconds: Joi.number().integer().min(1).max(120).default(3),
    async: Joi.alternatives().try(Joi.boolean(), Joi.string()).optional(),
  }).or('sessionIds', 'sessionListId'),

  addMembersToGroup: Joi.object({
    // New multi-session mode
    sessionIds: Joi.array().items(Joi.number().integer().positive()).min(1).optional(),
    // Old single-session mode (backward compat)
    sessionId: Joi.number().integer().positive().optional(),
    // The frontend may also resolve sessions via a saved session list.
    sessionListId: Joi.alternatives().try(Joi.number().integer().positive(), Joi.string()).optional(),
    // New multi-target mode
    targetIds: Joi.array().items(Joi.string()).min(1).optional(),
    // Old single-target mode (backward compat)
    targetGroupId: Joi.string().optional(),
    // Target type
    targetType: Joi.string().valid('group', 'channel').default('group'),
    // User list (required). Items can be a bare string/number target, or an
    // object with any combination of identifiers — telegram_id may legitimately
    // be null when the row is a handle-only entry from a scrape export.
    userList: Joi.array().items(
      Joi.alternatives().try(
        Joi.string(),
        Joi.number(),
        Joi.object({
          telegram_id: Joi.alternatives().try(Joi.string(), Joi.number()).allow(null, ''),
          telegramId: Joi.alternatives().try(Joi.string(), Joi.number()).allow(null, ''),
          id: Joi.alternatives().try(Joi.string(), Joi.number()).allow(null, ''),
          username: Joi.string().allow(null, ''),
          first_name: Joi.string().allow(null, ''),
          firstName: Joi.string().allow(null, ''),
          last_name: Joi.string().allow(null, ''),
          lastName: Joi.string().allow(null, ''),
          phone: Joi.string().allow(null, ''),
        }).unknown(true)
      )
    ).min(1).required(),
    // Delay settings (legacy contract: seconds between batches)
    delayMin: Joi.number().min(1).max(600).default(30),
    delayMax: Joi.number().min(1).max(600).default(60),
    delay: Joi.number().min(1).max(600).optional(),
    batchSize: Joi.number().integer().min(1).max(100).default(5),
    // Async mode
    async: Joi.alternatives().try(Joi.boolean(), Joi.string()).optional(),
    // Distribution-engine knobs (see distributionPlanner.js). When
    // `mode='auto'` the panel sizes burst/cooldown automatically
    // based on the items/sessions ratio. Otherwise the operator's
    // values are clamped to safe bounds and used directly.
    mode: Joi.string().valid('auto', 'manual').default('auto'),
    perSessionBurst: Joi.number().integer().min(1).max(500).optional(),
    cooldownSecMin: Joi.number().integer().min(0).max(1800).optional(),
    cooldownSecMax: Joi.number().integer().min(0).max(1800).optional(),
    itemDelayMsMin: Joi.number().integer().min(0).max(600000).optional(),
    itemDelayMsMax: Joi.number().integer().min(0).max(600000).optional(),
  })
    .or('sessionIds', 'sessionId', 'sessionListId')
    .or('targetIds', 'targetGroupId'),

  // Either sessionIds (explicit) OR sessionListId (resolved server-side
  // by `resolveSessionIdsFromRequest`) must be provided. Without the
  // `.or()` clause the panel's "Use Sessions List" picker silently
  // failed validation when no sessionIds were sent, surfacing as a
  // generic 400 in the join/leave UI.
  joinLeaveChannels: Joi.object({
    sessionIds: Joi.array().items(Joi.number().integer().positive()).min(1).optional(),
    sessionListId: Joi.alternatives(Joi.number().integer().positive(), Joi.string()).optional(),
    session_list_id: Joi.alternatives(Joi.number().integer().positive(), Joi.string()).optional(),
    targetIds: Joi.array().items(Joi.string()).min(1).required(),
    targetType: Joi.string().valid('group', 'channel').default('group'),
  }).or('sessionIds', 'sessionListId', 'session_list_id'),

  twoFACheck: Joi.object({
    sessionId: Joi.number().integer().positive().required(),
  }),

  twoFASet: Joi.object({
    sessionId: Joi.number().integer().positive().required(),
    password: Joi.string().min(1).max(128).required(),
    hint: Joi.string().max(255),
    email: Joi.string().email(),
  }),

  listImport: Joi.object({
    // The frontend posts the list name as `name` and the controller reads
    // `req.body.name`. Accept both `name` and `listName` so older clients
    // (and the merge/from-scrape flows) keep working.
    name: Joi.string().max(255),
    listName: Joi.string().max(255),
    type: Joi.string().valid('users', 'groups', 'channels').default('users'),
  })
    .or('name', 'listName')
    .unknown(true),

  reportGenerate: Joi.object({
    reportType: Joi.string().valid('channel', 'group', 'user', 'session').required(),
    targetId: Joi.string().required(),
    periodStart: Joi.date(),
    periodEnd: Joi.date(),
  }),

  pagination: Joi.object({
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(100).default(20),
    sort: Joi.string().default('created_at'),
    order: Joi.string().valid('ASC', 'DESC').default('DESC'),
  }),
};

module.exports = {
  validate,
  schemas,
};
