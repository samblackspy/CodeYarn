// src/routes/projectRoutes.ts
import express, { Router } from 'express';
import {
    getProjectFilesHandler,
    createProjectHandler,
    listProjectsHandler,
    getProjectDetailsHandler,
    deleteProjectHandler
} from './projectHandlers';

const router: Router = express.Router();

// GET /api/projects/:projectId/files - Fetches file tree for a project
router.get('/:projectId/files', getProjectFilesHandler);

// POST /api/projects - Creates a new project
router.post('/', createProjectHandler);

// GET /api/projects - Lists projects
router.get('/', listProjectsHandler);

// GET /api/projects/:projectId - Gets details for a specific project
router.get('/:projectId', getProjectDetailsHandler);

// DELETE /api/projects/:projectId - Deletes a specific project
router.delete('/:projectId', deleteProjectHandler);

export default router;