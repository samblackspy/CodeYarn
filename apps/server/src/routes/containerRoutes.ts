// src/routes/containerRoutes.ts
import express, { Router } from 'express';
import {
    createOrRetrieveContainerHandler,
    startContainerHandler,
    stopContainerHandler,
    deleteContainerHandler,
    getContainerStatusHandler,
    getPreviewDetailsHandler,
    getFileStatusHandler
} from './containerHandlers'; // Adjusted import path

const router: Router = express.Router();

// POST /api/containers - Creates or retrieves an existing container
router.post('/', createOrRetrieveContainerHandler);

// POST /api/containers/:id/start - Starts an existing stopped container
router.post('/:id/start', startContainerHandler);

// POST /api/containers/:id/stop - Stops a running container
router.post('/:id/stop', stopContainerHandler);

// DELETE /api/containers/:id - Stops (if needed) and removes a container
router.delete('/:id', deleteContainerHandler);

// GET /api/containers/:id/status - Gets the current status of a container
router.get('/:id/status', getContainerStatusHandler);

// GET /api/containers/:id/preview-details - Gets details for preview URL
router.get('/:id/preview-details', getPreviewDetailsHandler);

// GET /api/containers/:id/file-status - Checks file status within a container
router.get('/:id/file-status', getFileStatusHandler);

export default router;