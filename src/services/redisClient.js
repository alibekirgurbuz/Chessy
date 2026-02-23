const Redis = require('ioredis');

const getRedisUrl = () => process.env.REDIS_URL || 'redis://localhost:6379';

// Factory pattern for creating new clean clients
const createClient = () => {
    return new Redis(getRedisUrl());
};

// Singleton connection for general purpose app caching / KV store
const redis = createClient();

redis.on('connect', () => {
    console.log('✅ Redis connected successfully');
});

redis.on('error', (err) => {
    console.error('❌ Redis connection error:', err);
});

// Custom prefix for manual key namespacing
redis.appPrefix = process.env.NODE_ENV === 'development' ? 'dev:' : '';

module.exports = redis;
module.exports.createClient = createClient;
