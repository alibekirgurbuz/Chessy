require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const connectDB = require('./config/database');
const healthRoutes = require('./routes/health');
const webhookRoutes = require('./routes/webhooks');
const authRoutes = require('./routes/auth');
const gameRoutes = require('./routes/games');
const matchmakingRoutes = require('./routes/matchmaking');
const errorHandler = require('./middleware/errorHandler');
const setupSocket = require('./socket');

// Connect to database
connectDB();

// Initialize Express app
const app = express();

// Create HTTP server
const server = http.createServer(app);

// Setup Socket.io
const io = setupSocket(server);

// Middleware
app.use(helmet({
  contentSecurityPolicy: false, // Webhook'lar için gerekli
}));
app.use(cors());

// Webhook route için raw body gerekiyor (svix imza doğrulaması için)
app.use('/api/webhooks/clerk', express.raw({ type: 'application/json' }));
// Diğer route'lar için JSON parser
app.use(express.json());

// Routes
app.use('/api/health', healthRoutes);
app.use('/api/webhooks', webhookRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/games', gameRoutes);
app.use('/api/matchmaking', matchmakingRoutes);

// Error handler (must be last)
app.use(errorHandler);

// Start server
const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 WebSocket server ready`);
});
