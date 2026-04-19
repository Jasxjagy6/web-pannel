const { createClient } = require('redis');
require('dotenv').config();

const redisClient = createClient({
  socket: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
  },
  password: process.env.REDIS_PASSWORD || 'your_redis_password',
});

redisClient.on('error', (err) => {
  console.error('Redis Client Error:', err.message);
});

redisClient.on('connect', () => {
  console.log('Redis client connected');
});

const connectRedis = async () => {
  try {
    await redisClient.connect();
    return redisClient;
  } catch (error) {
    console.error('Failed to connect to Redis:', error.message);
    return redisClient;
  }
};

module.exports = {
  redisClient,
  connectRedis,
};
