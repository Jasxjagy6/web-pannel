const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
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

const app = express();
const server = http.createServer(app);

// Initialize Socket.IO
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

// Middleware
app.set('trust proxy', 1); // Trust first proxy (nginx)
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Request logging middleware for debugging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.info(`${req.method} ${req.originalUrl} ${res.statusCode} - ${duration}ms`);
  });
  next();
});

app.use(generalLimiter);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API Routes
const apiPrefix = process.env.API_PREFIX || '/api';
app.use(`${apiPrefix}/auth`, authRoutes);
app.use(`${apiPrefix}/sessions`, sessionRoutes);
app.use(`${apiPrefix}/scrape`, scrapeRoutes);
app.use(`${apiPrefix}/messages`, messageRoutes);
app.use(`${apiPrefix}/groups`, groupRoutes);
app.use(`${apiPrefix}/lists`, listRoutes);
app.use(`${apiPrefix}/reports`, reportRoutes);
app.use(`${apiPrefix}/dashboard`, dashboardRoutes);
app.use(`${apiPrefix}/account-settings`, accountSettingsRoutes);
app.use(`${apiPrefix}/2fa-jobs`, twoFAJobsRoutes);
app.use(`${apiPrefix}/otp`, otpRoutes);
app.use(`${apiPrefix}/proxies`, proxyRoutes);

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
  } catch (error) {
    logger.error('Failed to start server', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully');
  server.close(async () => {
    await closeQueues();
    logger.info('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down gracefully');
  server.close(async () => {
    await closeQueues();
    logger.info('Server closed');
    process.exit(0);
  });
});

start();

module.exports = { app, server, io };
