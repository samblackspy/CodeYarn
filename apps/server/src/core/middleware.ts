// src/core/middleware.ts
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { CORS_ORIGIN } from '../config';

export function setupCoreMiddleware(app: express.Express) {
    app.set('trust proxy', 1); // Trust the proxy for secure cookies

    app.use(cors({
        origin: CORS_ORIGIN,
        methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        credentials: true
    }));

    // Use raw text parser specifically for the file content update route first
    // process the request body as text regardless of the Content-Type header
    app.use('/api/files/:fileId/content', express.text({
        type: '*/*' // any type and subtype
    }));

    // Use JSON parser for other routes
    app.use(express.json());

    // Simple request logger
    app.use((req: Request, res: Response, next: NextFunction) => {
        console.log(`
            [${new Date().toISOString()}] 
            ${req.method} 
            ${req.url}
        `);
        next();
    });
}

export function setupErrorHandlers(app: express.Express) {
    // 404 Handler
    app.use((req: Request, res: Response) => {
        res.status(404).json({
            message: 'Not Found'
        });
    });

    // Global Error Handler
    app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
        console.error(`
            [Error Handler] 
            ${err.stack}
        `);
        const errorMessage = process.env.NODE_ENV === 'production' ? 'Internal Server Error' : err.message;
        res.status(500).json({
            message: 'Internal Server Error',
            error: errorMessage
        });
    });
}