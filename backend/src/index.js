const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const { initDB } = require('./config/database');
const { connectRedis } = require('./config/redis');
const { initializeQueues, closeQueues } = require('./queues');
const { errorHandler } = require('./utils/errorHandler');
const { generalLimiter } = require('./middleware/rateLimiter');
const logger = require('./utils/logger');

// Import routes
const authRoutes = require('./routes/auth');
const sessionRoutes = require('./routes/sessions');
const scrapeRoutes = require('./routes/scrape');
const messageRoutes = require('./routes/messages');
const groupRoutes = require('./routes/groups');
const listRoutes = require('./routes/lists');
const reportRoutes = require('./routes/reports');
const dashboardRoutes = require('./routes/dashboard');
const accountSettingsRoutes = require('./routes/accountSettings');
const twoFAJobsRoutes = require('./routes/twoFAJobs');
const otpRoutes = require('./routes/otp');
const proxyRoutes = require('./routes/proxies');
const userProxyRoutes = require('./routes/userProxies');
const antiDetectRoutes = require('./routes/antiDetect');
const privacyRoutes = require('./routes/privacy');
const adminRoutes = require('./routes/admin');
const billingRoutes = require('./routes/billing');
const userCredentialsRoutes = require('./routes/userCredentials');
const otpRelayRoutes = require('./routes/otpRelays');
const telegramClientRoutes = require('./routes/telegramClient');
const sessionListRoutes = require('./routes/sessionLists');
const billingController = require('./controllers/billingController');
const { parsePlatform, resolvePlatform } = require('./middleware/platform');
const healthRoutes = require('./routes/health');
const readiness = require('./utils/readiness');

const app = express();
const server = http.createServer(app);

// Initialize Socket.IO. The ping/pong cadence is tuned for the
// 500-700 concurrent user target — short enough to detect a dead
// client within ~30s, long enough to keep idle WS traffic minimal.
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:5176',
    methods: ['GET', 'POST'],
    credentials: true,
  },
  pingInterval: parseInt(process.env.WS_PING_INTERVAL_MS || '25000', 10),
  pingTimeout:  parseInt(process.env.WS_PING_TIMEOUT_MS  || '20000', 10),
  maxHttpBufferSize: 1e6,
  perMessageDeflate: { threshold: 1024 },
});

// Middleware
app.set('trust proxy', 1); // Trust first proxy (nginx)
app.use(helmet());
// gzip / brotli compression for JSON responses. Saves a substantial
// chunk of egress on the dashboard, sessions list, and scrape job
// table at scale.
app.use(compression({
  threshold: 1024,
  // Some endpoints stream binary downloads (CSV / XLSX / session
  // files); express-router handles those separately and we'd rather
  // not double-compress them.
  filter: (req, res) => {
    if (req.headers['x-no-compression']) return false;
    const ct = String(res.getHeader('Content-Type') || '');
    if (/^application\/octet-stream/.test(ct)) return false;
    return compression.filter(req, res);
  },
}));
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5176',
  credentials: true,
}));
// OxaPay IPN webhook MUST be mounted with raw body parsing so the HMAC
// header (sha512(rawBody, merchantApiKey)) can be re-validated. We mount
// it BEFORE express.json() so the body remains a Buffer.
const apiPrefixForIpn = process.env.API_PREFIX || '/api';
app.post(
  `${apiPrefixForIpn}/billing/oxapay/ipn`,
  express.raw({ type: '*/*', limit: '1mb' }),
  billingController.oxapayIpn
);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Request logging middleware. At 500-700 concurrent users with each
// browser polling sessions / dashboard / monitor lists, naive per-
// request logging dominates I/O. We sample successful GETs to 1/N
// and always log everything else (writes, 4xx, 5xx) so anomalies stay
// visible.
const REQ_LOG_SAMPLE = Math.max(1, parseInt(process.env.REQ_LOG_SAMPLE || '20', 10));
let reqLogCounter = 0;
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    const isHotGet = req.method === 'GET' && res.statusCode < 400;
    const sampled = isHotGet && (reqLogCounter++ % REQ_LOG_SAMPLE !== 0);
    if (sampled) return;
    if (res.statusCode >= 500) {
      logger.error(`${req.method} ${req.originalUrl} ${res.statusCode} - ${duration}ms`);
    } else if (res.statusCode >= 400) {
      logger.warn(`${req.method} ${req.originalUrl} ${res.statusCode} - ${duration}ms`);
    } else {
      logger.info(`${req.method} ${req.originalUrl} ${res.statusCode} - ${duration}ms`);
    }
  });
  next();
});

// Health, readiness, version. Mounted BEFORE the rate limiter so an
// overloaded panel doesn't make Caddy think the new color is dead during
// a deploy. Each health endpoint is cheap (one ping per backend).
app.use('/health', healthRoutes);

app.use(generalLimiter);

// API Routes
//
// Multi-platform mounting strategy (§4.6 of INSTAGRAM_PANEL_ARCHITECTURE.md):
//
//   Per-account routers (sessions, scrape, messages, groups, lists, reports,
//   dashboard, account-settings, 2fa-jobs, otp, proxies, anti-detect, privacy)
//   are mounted THREE times:
//
//     /api/telegram/<router>   parsePlatform('telegram')   ← Telegram panel
//     /api/instagram/<router>  parsePlatform('instagram')  ← Instagram panel
//     /api/<router>            resolvePlatform              ← legacy alias kept
//                                                           for one release;
//                                                           defaults to telegram
//
//   Global routers (auth, billing, admin, user-credentials) are mounted ONCE
//   without a platform prefix; they accept ?platform= or X-Platform: <p> for
//   the few endpoints that need to know which platform the user is asking
//   about (e.g. /billing/checkout, /billing/status, /billing/invoices).
const apiPrefix = process.env.API_PREFIX || '/api';

const platformMetaRoutes = require('./routes/platformMeta');

const PLATFORM_ROUTERS = [
  ['/meta',             platformMetaRoutes],
  ['/sessions',         sessionRoutes],
  ['/scrape',           scrapeRoutes],
  ['/messages',         messageRoutes],
  ['/groups',           groupRoutes],
  ['/lists',            listRoutes],
  ['/reports',          reportRoutes],
  ['/dashboard',        dashboardRoutes],
  ['/account-settings', accountSettingsRoutes],
  ['/2fa-jobs',         twoFAJobsRoutes],
  ['/otp',              otpRoutes],
  ['/proxies',          proxyRoutes],
  ['/me/proxies',       userProxyRoutes],
  ['/me/proxy-providers', require('./routes/proxyProviders')],
  ['/anti-detect',      antiDetectRoutes],
  ['/privacy',          privacyRoutes],
  ['/session-lists',    sessionListRoutes],
];

for (const [mountPath, router] of PLATFORM_ROUTERS) {
  app.use(`${apiPrefix}/telegram${mountPath}`,  parsePlatform('telegram'),  router);
  app.use(`${apiPrefix}/instagram${mountPath}`, parsePlatform('instagram'), router);
  // Legacy alias — kept for one release cycle. resolvePlatform reads
  // X-Platform / ?platform= / body.platform so a forward-thinking client
  // can opt in by header without changing URL.
  app.use(`${apiPrefix}${mountPath}`, resolvePlatform, router);
}

// Global, platform-agnostic routers.
app.use(`${apiPrefix}/auth`, authRoutes);
app.use(`${apiPrefix}/admin`, adminRoutes);
app.use(`${apiPrefix}/billing`, resolvePlatform, billingRoutes);
app.use(`${apiPrefix}/user-credentials`, userCredentialsRoutes);

// Saved-Messages OTP Relay (Telegram-only). Mounted under both the
// Telegram namespace and a legacy alias so the existing frontend
// platform-prefix logic finds it without a special case.
app.use(`${apiPrefix}/telegram/otp-relays`, parsePlatform('telegram'), otpRelayRoutes);
app.use(`${apiPrefix}/otp-relays`, resolvePlatform, otpRelayRoutes);

// In-panel Telegram client (per-session login → real chat UI). Mounted
// ONLY under the Telegram namespace so the Instagram surface never
// exposes it. Backed by `services/telegramClientService.js` and the
// per-session GramJS clients already maintained by telegramService.
app.use(
  `${apiPrefix}/telegram/client`,
  parsePlatform('telegram'),
  telegramClientRoutes
);

// Instagram-only per-account 2FA (TOTP enable/disable/status). Telegram
// has its own bulk-job model under /2fa-jobs which doesn't apply here.
const instagramTwoFactorRoutes = require('./routes/instagramTwoFactor');
app.use(
  `${apiPrefix}/instagram/two-factor`,
  parsePlatform('instagram'),
  instagramTwoFactorRoutes
);

// Instagram-only per-account settings (username, full_name, bio, pfp).
// Mounted independently of /account-settings so the IG payload shape
// doesn't have to fit the TG bulk-update model.
const instagramAccountRoutes = require('./routes/instagramAccount');
app.use(
  `${apiPrefix}/instagram/account`,
  parsePlatform('instagram'),
  instagramAccountRoutes
);

// Instagram-only per-account identity / device fingerprint surface.
const instagramIdentityRoutes = require('./routes/instagramIdentity');
app.use(
  `${apiPrefix}/instagram/identity`,
  parsePlatform('instagram'),
  instagramIdentityRoutes
);

// Instagram-only identity-lookup module — multi-method OSINT against
// a public IG username (profile info, recovery masks, cross-platform
// probes, geo from public posts, google dorks). Independent surface
// from /scrape because the workload, rate-limit profile, and audit
// model are all different. See instagram_upgrade.txt §4.3 and §6.4.
const instagramLookupRoutes = require('./routes/instagramLookup');
app.use(
  `${apiPrefix}/instagram/lookup`,
  parsePlatform('instagram'),
  instagramLookupRoutes
);

// Burner-cookie pool admin (PR #4 §6.3) — the pool feeds the
// email/phone enumeration probes in `lookupService`. Independent
// surface because cookie ingestion is a per-row admin action,
// separate from job submission.
const instagramBurnersRoutes = require('./routes/instagramBurners');
app.use(
  `${apiPrefix}/instagram/burners`,
  parsePlatform('instagram'),
  instagramBurnersRoutes
);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ success: false, error: { message: 'Route not found', code: 'NOT_FOUND' } });
});

// Error handler
app.use(errorHandler);

// WebSocket authentication and connection handling
io.use((socket, next) => {
  try {
    const token = socket.handshake.auth.token || socket.handshake.query.token;
    if (!token) {
      return next(new Error('Authentication required'));
    }
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    socket.userId = decoded.userId;
    socket.userEmail = decoded.email;
    next();
  } catch (error) {
    next(new Error('Invalid token'));
  }
});

const VALID_PLATFORMS = new Set(['telegram', 'instagram']);

io.on('connection', (socket) => {
  logger.info(`User connected: ${socket.userId}`);

  // Join user-specific room (cross-platform notifications still flow here).
  socket.join(`user:${socket.userId}`);

  // Per-user "Delete chats" job feed. Every panel window receives
  // progress updates so the History tab on the Login page renders in
  // real time without an extra opt-in roundtrip.
  socket.join(`tg-client:u${socket.userId}:jobs`);

  // Per-platform rooms — services emit to `platform:<userId>:<platform>`
  // for events that should be scoped to a single panel (e.g. IG warmup
  // throttle decisions, TG group-invite progress). The frontend asks
  // for the room it cares about via 'platform:subscribe' and will
  // re-subscribe whenever the user toggles platforms.
  const _joinPlatform = (platform) => {
    if (!VALID_PLATFORMS.has(platform)) return;
    socket.join(`platform:${socket.userId}:${platform}`);
  };
  const _leavePlatform = (platform) => {
    if (!VALID_PLATFORMS.has(platform)) return;
    socket.leave(`platform:${socket.userId}:${platform}`);
  };

  // Handshake-time platform (sent in io({ query: { platform } })). We
  // join the room immediately so the very first event after connect is
  // routed correctly.
  const handshakePlatform = socket.handshake?.query?.platform;
  if (handshakePlatform && VALID_PLATFORMS.has(handshakePlatform)) {
    _joinPlatform(handshakePlatform);
  }

  socket.on('platform:subscribe', (data) => {
    _joinPlatform(data?.platform);
  });
  socket.on('platform:unsubscribe', (data) => {
    _leavePlatform(data?.platform);
  });

  // Handle client events
  socket.on('scrape:cancel', async (data) => {
    socket.emit('notification', { type: 'info', message: 'Cancel request received' });
  });

  socket.on('message:cancel', async (data) => {
    socket.emit('notification', { type: 'info', message: 'Cancel request received' });
  });

  socket.on('session:disconnect', async (data) => {
    socket.emit('notification', { type: 'info', message: 'Disconnect request received' });
  });

  // ------------------------------------------------------------------
  // In-panel Telegram client live-update subscription.
  //
  // The browser-side TG client window calls `tg-client:subscribe` after
  // it connects (ack-style). The handler authorizes the session against
  // the panel JWT's userId, joins the per-session room, and ensures the
  // GramJS event handlers are attached on the backend client (via
  // `telegramClientStream`). On disconnect we tear the subscription
  // back down with refcount semantics so multiple windows for the same
  // session share one set of handlers.
  // ------------------------------------------------------------------
  const tgClientStream = require('./services/telegramClientStream');
  /** @type {Set<string>} sessionIds this socket is subscribed to */
  const tgClientSubs = new Set();

  socket.on('tg-client:subscribe', async (data, ack) => {
    try {
      const sessionId = data?.sessionId != null ? String(data.sessionId) : null;
      if (!sessionId) {
        const err = { ok: false, error: 'sessionId is required' };
        if (typeof ack === 'function') ack(err);
        return;
      }
      const result = await tgClientStream.attach(socket, sessionId, socket.userId);
      tgClientSubs.add(sessionId);
      if (typeof ack === 'function') ack({ ok: true, ...result });
    } catch (err) {
      logger.warn(`tg-client:subscribe failed: ${err.message}`);
      if (typeof ack === 'function') ack({ ok: false, error: err.message });
    }
  });

  socket.on('tg-client:unsubscribe', async (data, ack) => {
    try {
      const sessionId = data?.sessionId != null ? String(data.sessionId) : null;
      if (!sessionId) {
        if (typeof ack === 'function') ack({ ok: false, error: 'sessionId is required' });
        return;
      }
      const result = await tgClientStream.detach(socket, sessionId, socket.userId);
      tgClientSubs.delete(sessionId);
      if (typeof ack === 'function') ack({ ok: true, ...result });
    } catch (err) {
      logger.warn(`tg-client:unsubscribe failed: ${err.message}`);
      if (typeof ack === 'function') ack({ ok: false, error: err.message });
    }
  });

  socket.on('disconnect', () => {
    // Tear down any tg-client subscriptions this socket left behind so
    // GramJS event handlers aren't kept alive for an account no one is
    // looking at anymore.
    if (tgClientSubs.size > 0) {
      const ids = Array.from(tgClientSubs);
      tgClientSubs.clear();
      Promise.all(
        ids.map((sid) => tgClientStream.detach(socket, sid, socket.userId).catch(() => {}))
      ).catch(() => {});
    }
    logger.info(`User disconnected: ${socket.userId}`);
  });
});

// Make io accessible globally for services
global.io = io;

// Initialize and start server
const PORT = process.env.PORT || 3005;

async function start() {
  try {
    // Connect to database
    await initDB();
    logger.info('Database initialized');

    // Connect to Redis
    await connectRedis();
    logger.info('Redis connected');

    // Initialize queues
    await initializeQueues();
    // Initialize new queues for upgrades 2 (change-2FA jobs).
    try {
      const twoFAQueue = require('./queues/twoFAQueue');
      await twoFAQueue.initialize();
    } catch (err) {
      logger.warn(`twoFAQueue init failed: ${err.message}`);
    }
    logger.info('Queues initialized');
    readiness.markReady('queues');

    // Start server
    server.listen(PORT, () => {
      logger.info(`Server running on port ${PORT}`);
      logger.info(`API available at ${apiPrefix}`);
    });

    // ---------------------------------------------------------------------
    // Background workers (Upgrade 1, 3, 4)
    // ---------------------------------------------------------------------
    // 1. Restore previously logged-in sessions and start the heartbeat that
    //    keeps each Telegram client alive until manually logged out.
    //
    //    IMPORTANT: we do NOT await `restoreAllLoggedInSessions()`. With
    //    Phase 4 enabled the loop does multiple Telegram round-trips per
    //    session (DC pin probe, announceOnline, getMe, ChangeAuthSettings,
    //    SetAccountTTL). A single session in a bad state (e.g.
    //    AUTH_KEY_DUPLICATED, FloodWait) can take 30+ seconds to fail, so
    //    awaiting the whole loop easily exceeds the orchestrator's
    //    /health/ready timeout (default 120s) on accounts with several
    //    sessions. Instead we kick the loop off as a background promise
    //    and flip `markReady('sessions')` immediately — the panel can
    //    serve admin/auth/HTTP traffic while sessions trickle in, and the
    //    heartbeat below retries any session that isn't up yet on its
    //    next tick.
    try {
      const sessionService = require('./services/sessionService');
      const heartbeatMs = parseInt(process.env.SESSION_HEARTBEAT_INTERVAL_MS || '60000', 10);
      setInterval(
        () => sessionService.heartbeatLoggedInSessions().catch((e) =>
          logger.error(`heartbeat error: ${e.message}`)
        ),
        heartbeatMs
      );
      logger.info(`Session heartbeat scheduled every ${heartbeatMs}ms`);
      // Background restore — never awaited.
      sessionService.restoreAllLoggedInSessions()
        .then((r) => logger.info(
          `Background restore complete: total=${r && r.total} ` +
          `restored=${r && r.restored} failed=${r && r.failed}`
        ))
        .catch((e) => logger.error(`Background restore failed: ${e.message}`));
      readiness.markReady('sessions');
    } catch (err) {
      logger.error(`Session heartbeat init failed: ${err.message}`);
      // Even if the heartbeat scheduling failed we mark sessions ready
      // so the readiness probe doesn't stall the orchestrator. Restore
      // and recovery still work via the per-request lazy connect path.
      readiness.markReady('sessions');
    }

    // 2. Resume any in-flight OTP scan jobs whose 5-minute window is open.
    try {
      const otpService = require('./services/otpService');
      await otpService.resumeActiveScans();
    } catch (err) {
      logger.warn(`otpService.resumeActiveScans failed: ${err.message}`);
    }

    // 2b. Boot the OTP-Relay listeners. Any tg_otp_relays row whose
    //     watch_session_id is already connected (the restoreAll loop
    //     just finished) gets a NewMessage handler attached so 777000
    //     DMs are forwarded to the relay account's Saved Messages.
    //     Sessions that come up later are wired in via the
    //     `onSessionConnected` hook called from sessionService.
    try {
      const otpRelayService = require('./services/otpRelayService');
      await otpRelayService.start();
      // Daily prune of the audit ledger.
      const PRUNE_MS = 24 * 60 * 60 * 1000;
      setInterval(
        () => otpRelayService.pruneOldEvents().catch((e) =>
          logger.debug(`otpRelay prune error: ${e.message}`)
        ),
        PRUNE_MS
      );
    } catch (err) {
      logger.warn(`otpRelayService.start failed: ${err.message}`);
    }

    // 3. Boot the proxy pool background scheduler (10-minute revalidation).
    try {
      const proxyService = require('./services/proxyService');
      proxyService.startBackground();
    } catch (err) {
      logger.warn(`proxyService.startBackground failed: ${err.message}`);
    }

    // 4. Start the Anti-Detect behavior simulator. It performs a small
    //    randomized batch of read-only actions (mark-as-read, set-typing,
    //    occasional reactions) every BEHAVIOR_TICK_INTERVAL_MS so dormant
    //    sessions don't look like idle bot farms to Telegram's spam filter.
    try {
      const behaviorService = require('./services/behaviorService');
      const enabled = String(process.env.BEHAVIOR_ENABLED ?? 'true').toLowerCase() !== 'false';
      if (enabled) {
        behaviorService.start();
      } else {
        logger.info('BehaviorService disabled via BEHAVIOR_ENABLED=false');
      }
    } catch (err) {
      logger.warn(`behaviorService.start failed: ${err.message}`);
    }

    // 5. Boot the Privacy job worker. Drains queued privacy_jobs and
    //    applies account.SetPrivacy across the chosen sessions in
    //    bounded-concurrency batches with jittered cooldown.
    try {
      const privacyJobWorker = require('./services/privacyJobWorker');
      privacyJobWorker.startPrivacyJobWorker();
    } catch (err) {
      logger.warn(`privacyJobWorker.start failed: ${err.message}`);
    }

    // 6. Boot the Instagram session warm-up scheduler. Every minute it
    //    picks one IG session whose last_warmup_at is older than the
    //    25-35 min jittered stale window and runs a single cheap probe
    //    (web account-edit endpoint) through the session's bound proxy.
    //    This is what keeps cookie-uploaded sessions alive against IG's
    //    age-decay + IP-rotation risk model.
    try {
      const igHealthEnabled =
        String(process.env.IG_WARMUP_ENABLED ?? 'true').toLowerCase() !== 'false';
      if (igHealthEnabled) {
        const sessionHealth = require('./providers/instagram/sessionHealth');
        sessionHealth.startWarmupScheduler();
      } else {
        logger.info('IG warmup scheduler disabled via IG_WARMUP_ENABLED=false');
      }
    } catch (err) {
      logger.warn(`IG sessionHealth scheduler.start failed: ${err.message}`);
    }

    // 6. Re-attach NewMessage listeners for monitor jobs that were running
    //    when the process restarted and whose window hasn't expired yet.
    try {
      const scrapeMonitorService = require('./services/scrapeMonitorService');
      await scrapeMonitorService.resumeActiveJobs();
    } catch (err) {
      logger.warn(`scrapeMonitorService.resumeActiveJobs failed: ${err.message}`);
    }

    // 7. Sweep expired monitor jobs every minute. resumeActiveJobs above
    //    rolls already-expired jobs to completed at boot; this loop catches
    //    any job whose timer was missed (e.g. very long shutdown).
    try {
      const scrapeMonitorService = require('./services/scrapeMonitorService');
      setInterval(
        () => scrapeMonitorService.resumeActiveJobs().catch((e) =>
          logger.warn(`monitor sweep error: ${e.message}`)
        ),
        60_000
      );
    } catch (err) {
      logger.warn(`monitor sweep init failed: ${err.message}`);
    }

    // 7a. Boot the V2 cohort-scheduler orchestrator (monitor V2).
    //     This is the long-running scheduler that fan-outs one job
    //     across multiple chats and rotates a cohort of sessions on
    //     each chat to keep behavioural fingerprints under threshold.
    //     Legacy v6 jobs continue through scrapeMonitorService above.
    try {
      const monitorOrchestrator = require('./services/monitor/monitorOrchestrator');
      await monitorOrchestrator.start();
    } catch (err) {
      logger.warn(`monitorOrchestrator.start failed: ${err.message}`);
    }

    // 7b. Boot the message-schedule tick loop. Polls
    //     `message_schedules` for rows that are due for another run
    //     (last dispatched job is in a terminal state AND
    //     completed_at + interval_minutes is in the past) and kicks
    //     off a new bulk-groups job for each. Multiple schedules run
    //     concurrently; a thrown error inside one never stops the
    //     others.
    try {
      const messageScheduleService = require('./services/messageScheduleService');
      messageScheduleService.start();
    } catch (err) {
      logger.warn(`messageScheduleService.start failed: ${err.message}`);
    }

    // 7c. Boot the IG lookup-watch worker (PR #7) + retention sweeper
    //     (PR #8). The worker polls `lookup_watches` for due rows and
    //     invokes `resetOracleWatch.run()` on each; the retention
    //     sweeper hard-deletes jobs whose retained_until is past.
    try {
      const enabled = String(process.env.LOOKUP_WATCH_ENABLED ?? 'true').toLowerCase() !== 'false';
      if (enabled) {
        const lookupWatchWorker = require('./services/lookupWatchWorker');
        lookupWatchWorker.start();
      } else {
        logger.info('IG lookup-watch worker disabled via LOOKUP_WATCH_ENABLED=false');
      }
    } catch (err) {
      logger.warn(`lookupWatchWorker.start failed: ${err.message}`);
    }

    // 8. Subscription / trial expiry sweep. Runs every minute so a paid
    //    user whose monthly window just elapsed gets gated out of the app
    //    on their very next request. Trial expiry happens implicitly via
    //    the entitlement check, so we only need to flip subscription_status
    //    here.
    try {
      const subscriptionService = require('./services/subscriptionService');
      // Run once on boot too so cold starts catch up to wall time.
      subscriptionService.sweepExpired().catch((e) =>
        logger.warn(`subscription sweep (boot) error: ${e.message}`)
      );
      setInterval(
        () => subscriptionService.sweepExpired().catch((e) =>
          logger.warn(`subscription sweep error: ${e.message}`)
        ),
        60_000
      );
    } catch (err) {
      logger.warn(`subscription sweep init failed: ${err.message}`);
    }

    // All background workers have been launched (or have failed
    // soft and logged). Flip the readiness flag so the upgrade
    // orchestrator can proceed with the cutover.
    readiness.markReady('workers');
    logger.info(
      `Boot complete — color=${process.env.DEPLOY_COLOR || 'unknown'} ` +
      `git_sha=${process.env.GIT_SHA || 'unknown'}`
    );
  } catch (error) {
    logger.error('Failed to start server', error);
    process.exit(1);
  }
}

// Graceful shutdown. v8: hardened for the 500-700 concurrent user
// target — we stop accepting new connections, then wait up to
// SHUTDOWN_GRACE_MS for in-flight requests / WS clients to finish,
// and only then close queues + DB pool. If the grace window expires
// we still exit cleanly so the orchestrator doesn't have to SIGKILL.
const SHUTDOWN_GRACE_MS = parseInt(process.env.SHUTDOWN_GRACE_MS || '20000', 10);
let shuttingDown = false;
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received, shutting down gracefully (${SHUTDOWN_GRACE_MS}ms grace)`);
  const forceTimer = setTimeout(() => {
    logger.warn('graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, SHUTDOWN_GRACE_MS);
  forceTimer.unref();
  try {
    // Stop accepting new HTTP connections and WS upgrades.
    server.close();
    try { io.close(); } catch (_) {}
    // Drain queues so in-flight jobs commit cleanly.
    await closeQueues();
    // Close DB pool last so anything that tried to log a final query
    // still sees an open connection.
    try {
      const { pool } = require('./config/database');
      await pool.end();
    } catch (err) {
      logger.warn(`pool.end failed: ${err.message}`);
    }
    logger.info('Server closed cleanly');
    clearTimeout(forceTimer);
    process.exit(0);
  } catch (err) {
    logger.error('graceful shutdown error', err);
    clearTimeout(forceTimer);
    process.exit(1);
  }
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

// Defense in depth: a single thrown error inside a third-party update
// loop (notably GramJS's _updateLoop) used to crash the whole process
// and take every other in-flight job with it. Log and keep going. The
// caller-specific handlers (e.g. scrapeMonitorService._onEvent) already
// catch their own errors; this is a backstop for everything below them.
process.on('uncaughtException', (err) => {
  logger.error(`uncaughtException: ${err && err.message}`, {
    stack: err && err.stack,
  });
});
process.on('unhandledRejection', (reason) => {
  logger.error(`unhandledRejection: ${reason && reason.message ? reason.message : reason}`, {
    stack: reason && reason.stack,
  });
});

start();

module.exports = { app, server, io };
