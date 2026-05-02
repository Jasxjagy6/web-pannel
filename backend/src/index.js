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
const antiDetectRoutes = require('./routes/antiDetect');
const privacyRoutes = require('./routes/privacy');
const adminRoutes = require('./routes/admin');
const billingRoutes = require('./routes/billing');
const userCredentialsRoutes = require('./routes/userCredentials');
const billingController = require('./controllers/billingController');
const { parsePlatform, resolvePlatform } = require('./middleware/platform');

const app = express();
const server = http.createServer(app);

// Initialize Socket.IO. The ping/pong cadence is tuned for the
// 500-700 concurrent user target — short enough to detect a dead
// client within ~30s, long enough to keep idle WS traffic minimal.
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
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
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
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

app.use(generalLimiter);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

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
  ['/anti-detect',      antiDetectRoutes],
  ['/privacy',          privacyRoutes],
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

io.on('connection', (socket) => {
  logger.info(`User connected: ${socket.userId}`);

  // Join user-specific room
  socket.join(`user:${socket.userId}`);

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

  socket.on('disconnect', () => {
    logger.info(`User disconnected: ${socket.userId}`);
  });
});

// Make io accessible globally for services
global.io = io;

// Initialize and start server
const PORT = process.env.PORT || 3000;

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
    try {
      const sessionService = require('./services/sessionService');
      await sessionService.restoreAllLoggedInSessions();
      const heartbeatMs = parseInt(process.env.SESSION_HEARTBEAT_INTERVAL_MS || '60000', 10);
      setInterval(
        () => sessionService.heartbeatLoggedInSessions().catch((e) =>
          logger.error(`heartbeat error: ${e.message}`)
        ),
        heartbeatMs
      );
      logger.info(`Session heartbeat scheduled every ${heartbeatMs}ms`);
    } catch (err) {
      logger.error(`Session restore/heartbeat init failed: ${err.message}`);
    }

    // 2. Resume any in-flight OTP scan jobs whose 5-minute window is open.
    try {
      const otpService = require('./services/otpService');
      await otpService.resumeActiveScans();
    } catch (err) {
      logger.warn(`otpService.resumeActiveScans failed: ${err.message}`);
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

start();

module.exports = { app, server, io };
