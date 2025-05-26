// codeyarn/apps/server/src/index.ts
import { app, httpServer, setupBaseRoutes, startServer } from './core/serverSetup';
import { setupCoreMiddleware, setupErrorHandlers } from './core/middleware';
import { initializeSocketIO } from './socket/ioServer';
import { initializeConnectionHandlers } from './socket/connectionHandler';
import { internalFSRouter } from './api/internalFSRouter';

// Import your existing route handlers
import containerRoutes from './routes/containerRoutes';
import fileRoutes from './routes/fileRoutes';
import projectRoutes from './routes/projectRoutes';
import templateRoutes from './routes/templateRoutes';

// 1. Setup Core Middleware
setupCoreMiddleware(app);

// 2. Initialize Socket.IO
const io = initializeSocketIO(httpServer);

// 3. Setup Base Routes (like /api/health)
setupBaseRoutes(app);

// 4. Mount API Routes
app.use('/api/containers', containerRoutes);
app.use('/api/files', fileRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/templates', templateRoutes);
app.use('/api', internalFSRouter); // Mount internal FS router, e.g. /api/internal/filesystem-event

// 5. Initialize Socket.IO Connection Handlers
initializeConnectionHandlers(io);

// 6. Setup Error Handling Middleware (should be last)
setupErrorHandlers(app);

// 7. Start the Server
startServer(io); // Pass io for graceful shutdown handling