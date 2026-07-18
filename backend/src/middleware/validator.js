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

  // Sequential-failover bulk send.
  // Same target/session shape as bulkMessage, but with failover-specific
  // knobs. delayMin/delayMax are in MILLISECONDS here (gap between sends on
  // the same session), so the bounds are wider than bulkMessage's seconds.
  failoverMessage: Joi.object({
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
          access_hash: Joi.alternatives().try(Joi.string(), Joi.number()).allow(null, ''),
          accessHash: Joi.alternatives().try(Joi.string(), Joi.number()).allow(null, ''),
        }).unknown(true)
      )
    ).min(1).required(),
    message: Joi.string().max(4096).required(),
    messageType: Joi.string().valid('text', 'html', 'markdown').default('text'),
    delayMin: Joi.number().integer().min(0).max(600000).optional(),
    delayMax: Joi.number().integer().min(0).max(600000).optional(),
    messageOptions: Joi.alternatives().try(Joi.object().unknown(true), Joi.string()).optional(),
    sourceType: Joi.string().valid('manual', 'list').default('manual'),
    sourceId: Joi.number().integer().positive().optional(),
    trackReplies: Joi.alternatives().try(Joi.boolean(), Joi.string()).optional(),
    replyWindowHours: Joi.number().integer().min(1).max(168).optional(),
    async: Joi.alternatives().try(Joi.boolean(), Joi.string()).optional(),
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
    // Hard per-session-per-burst ceiling. The redesigned add-members
    // runner clamps `perSessionBurst` to this value across all auto
    // bands. Defaults to 4 server-side; capped at 50 here.
    maxPerSession: Joi.number().integer().min(1).max(50).optional(),
    // Source channel identifiers for session-correct access_hash
    // resolution via channels.GetParticipant. Accepts numeric IDs,
    // @usernames, or t.me URLs. The V2 runner uses these to resolve
    // scraped numeric-id rows that would otherwise fail with
    // "Could not find the input entity" on fresh sessions.
    sourceChannelIds: Joi.array().items(Joi.string().trim().max(128)).max(10).optional(),
    sourceChannelId: Joi.string().trim().max(128).optional(),
    // Optional list_id (for persisting status back into list_items).
    listId: Joi.alternatives().try(Joi.number().integer().positive(), Joi.string()).optional(),
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
    type: Joi.string().valid('users', 'groups', 'channels', 'profile').default('users'),
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

  // ---------------------------------------------------------------------
  // Tracking module (Telegram account inventory/CRM)
  // ---------------------------------------------------------------------
  trackingAccountCreate: Joi.object({
    phoneNumber: Joi.string().max(30).allow(null, ''),
    country: Joi.string().max(100).allow(null, ''),
    countryCode: Joi.string().max(8).allow(null, ''),
    telegramUserId: Joi.number().integer().allow(null),
    username: Joi.string().max(100).allow(null, ''),
    displayName: Joi.string().max(200).allow(null, ''),
    bio: Joi.string().allow(null, ''),
    isPremium: Joi.boolean(),
    isVerified: Joi.boolean(),
    isScam: Joi.boolean(),
    isFake: Joi.boolean(),
    lastSeenAt: Joi.date().allow(null),
    estimatedValue: Joi.number().min(0).allow(null),
    status: Joi.string().valid('available', 'reserved', 'sold', 'dead', 'banned', 'deleted', 'lost_access'),
  }).unknown(false),

  trackingAccountUpdate: Joi.object({
    phoneNumber: Joi.string().max(30).allow(null, ''),
    country: Joi.string().max(100).allow(null, ''),
    countryCode: Joi.string().max(8).allow(null, ''),
    telegramUserId: Joi.number().integer().allow(null),
    username: Joi.string().max(100).allow(null, ''),
    displayName: Joi.string().max(200).allow(null, ''),
    bio: Joi.string().allow(null, ''),
    isPremium: Joi.boolean(),
    isVerified: Joi.boolean(),
    isScam: Joi.boolean(),
    isFake: Joi.boolean(),
    lastSeenAt: Joi.date().allow(null),
    estimatedValue: Joi.number().min(0).allow(null),
  }).unknown(false),

  trackingStatusChange: Joi.object({
    status: Joi.string()
      .valid('available', 'reserved', 'sold', 'dead', 'banned', 'deleted', 'lost_access')
      .required(),
    reservedUntil: Joi.date().allow(null),
  }),

  trackingSessionUpdate: Joi.object({
    sessionName: Joi.string().max(255).allow(null, ''),
    sessionVersion: Joi.string().max(50).allow(null, ''),
    encryptionStatus: Joi.string().valid('none', 'encrypted', 'unknown'),
    // Client/device fingerprint — usually auto-populated by the session
    // ZIP import, but editable here like any other session field.
    appId: Joi.number().integer().allow(null),
    appHash: Joi.string().max(64).allow(null, ''),
    deviceModel: Joi.string().max(100).allow(null, ''),
    systemVersion: Joi.string().max(100).allow(null, ''),
    clientAppVersion: Joi.string().max(50).allow(null, ''),
    langPack: Joi.string().max(30).allow(null, ''),
    systemLangPack: Joi.string().max(30).allow(null, ''),
    appConfigHash: Joi.string().max(100).allow(null, ''),
    sessionCreatedAt: Joi.date().allow(null),
  }),

  trackingSimUpdate: Joi.object({
    phoneNumber: Joi.string().max(30).allow(null, ''),
    simProvider: Joi.string().max(100).allow(null, ''),
    simCountry: Joi.string().max(100).allow(null, ''),
    simType: Joi.string().valid('physical', 'esim'),
    twoFaEnabled: Joi.boolean(),
    recoveryStatus: Joi.string().valid('unknown', 'verified', 'unverified', 'locked'),
    simStatus: Joi.string().valid('active', 'inactive', 'lost', 'blocked'),
    notes: Joi.string().allow(null, ''),
  }),

  trackingSecurityUpdate: Joi.object({
    twoFaPassword: Joi.string().max(500).allow(null, ''),
    twoFaHint: Joi.string().max(500).allow(null, ''),
    recoveryEmail: Joi.string().email().max(255).allow(null, ''),
    securityNotes: Joi.string().allow(null, ''),
    passwordChangedAt: Joi.date().allow(null),
  }),

  trackingPurchaseUpdate: Joi.object({
    source: Joi.string().max(100).allow(null, ''),
    supplierName: Joi.string().max(200).allow(null, ''),
    supplierContact: Joi.string().max(200).allow(null, ''),
    purchasePrice: Joi.number().min(0).allow(null),
    purchaseDate: Joi.date().allow(null),
    orderId: Joi.string().max(100).allow(null, ''),
    notes: Joi.string().allow(null, ''),
  }),

  trackingSaleCreate: Joi.object({
    buyerName: Joi.string().max(200).allow(null, ''),
    buyerTelegramUsername: Joi.string().max(100).allow(null, ''),
    buyerTelegramId: Joi.number().integer().allow(null),
    buyerContact: Joi.string().max(200).allow(null, ''),
    saleDate: Joi.date(),
    salePrice: Joi.number().min(0).required(),
    paymentMethod: Joi.string().valid('crypto', 'bank_transfer', 'paypal', 'cash', 'other'),
    paymentStatus: Joi.string().valid('pending', 'paid', 'partial', 'refunded', 'disputed'),
    invoiceNumber: Joi.string().max(100).allow(null, ''),
    notes: Joi.string().allow(null, ''),
  }),

  trackingSaleUpdate: Joi.object({
    buyerName: Joi.string().max(200).allow(null, ''),
    buyerTelegramUsername: Joi.string().max(100).allow(null, ''),
    buyerTelegramId: Joi.number().integer().allow(null),
    buyerContact: Joi.string().max(200).allow(null, ''),
    saleDate: Joi.date(),
    salePrice: Joi.number().min(0),
    paymentMethod: Joi.string().valid('crypto', 'bank_transfer', 'paypal', 'cash', 'other'),
    paymentStatus: Joi.string().valid('pending', 'paid', 'partial', 'refunded', 'disputed'),
    invoiceNumber: Joi.string().max(100).allow(null, ''),
    notes: Joi.string().allow(null, ''),
  }),

  trackingAssignmentCreate: Joi.object({
    assignedToUserId: Joi.number().integer().allow(null),
    assignedToName: Joi.string().max(200).allow(null, ''),
    reason: Joi.string().allow(null, ''),
  }).or('assignedToUserId', 'assignedToName'),

  trackingNoteCreate: Joi.object({
    note: Joi.string().min(1).required(),
  }),

  trackingAccountTagsSet: Joi.object({
    tagIds: Joi.array().items(Joi.number().integer()).min(1).required(),
  }),

  trackingTagCreate: Joi.object({
    name: Joi.string().min(1).max(50).required(),
    color: Joi.string().max(20).allow(null, ''),
  }),

  trackingTagUpdate: Joi.object({
    name: Joi.string().min(1).max(50),
    color: Joi.string().max(20).allow(null, ''),
  }),

  trackingBulkIds: Joi.object({
    ids: Joi.array().items(Joi.number().integer()).min(1).required(),
  }),

  trackingBulkStatus: Joi.object({
    ids: Joi.array().items(Joi.number().integer()).min(1).required(),
    status: Joi.string()
      .valid('available', 'reserved', 'sold', 'dead', 'banned', 'deleted', 'lost_access')
      .required(),
    reservedUntil: Joi.date().allow(null),
  }),

  trackingBulkAssign: Joi.object({
    ids: Joi.array().items(Joi.number().integer()).min(1).required(),
    assignedToUserId: Joi.number().integer().allow(null),
    assignedToName: Joi.string().max(200).allow(null, ''),
    reason: Joi.string().allow(null, ''),
  }).or('assignedToUserId', 'assignedToName'),

  trackingBulkTag: Joi.object({
    ids: Joi.array().items(Joi.number().integer()).min(1).required(),
    tagIds: Joi.array().items(Joi.number().integer()).min(1).required(),
  }),

  trackingTeamMemberAdd: Joi.object({
    userId: Joi.number().integer().required(),
    role: Joi.string().valid('owner', 'admin', 'staff', 'viewer').required(),
    permissions: Joi.object().unknown(true),
  }),

  trackingTeamMemberUpdate: Joi.object({
    role: Joi.string().valid('owner', 'admin', 'staff', 'viewer'),
    permissions: Joi.object().unknown(true),
  }),
};

module.exports = {
  validate,
  schemas,
};
