// src/routes/fileRoutes.ts
import express, { Router } from 'express';
import {
    getFileDetailsHandler,
    getFileContentHandler,
    updateFileContentHandler,
    createFileOrDirectoryHandler,
    deleteFileOrDirectoryHandler,
    renameFileOrDirectoryHandler
} from './fileHandlers';

const router: Router = express.Router();

// GET /api/files/:fileId/details - Fetches file/folder details
router.get('/:fileId/details', getFileDetailsHandler);

// GET /api/files/:fileId/content - Fetches file content
router.get('/:fileId/content', getFileContentHandler);

// PUT /api/files/:fileId/content - Updates file content
router.put('/:fileId/content', updateFileContentHandler);

// POST /api/files - Creates a new file or directory
router.post('/', createFileOrDirectoryHandler);

// DELETE /api/files/:fileId - Deletes a file or directory
router.delete('/:fileId', deleteFileOrDirectoryHandler);

// PUT /api/files/:fileId/rename - Renames a file or directory
router.put('/:fileId/rename', renameFileOrDirectoryHandler);

export default router;