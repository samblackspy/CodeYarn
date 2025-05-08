// codeyarn/apps/server/src/routes/templateRoutes.ts
import express, { Router, Request, Response, NextFunction } from 'express';
import { Template } from '@codeyarn/shared-types';
import prisma from '@codeyarn/db';

const router: Router = express.Router();

/**
 * GET /api/templates
 * Retrieves all available templates
 */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  console.log('[API Templates] Request received to list all templates');
  
  try {
    const templates = await prisma.template.findMany({
      orderBy: { name: 'asc' }
    });
    
    console.log(`[API Templates] Returning ${templates.length} templates`);
    
    // If no templates exist yet in the database, return hardcoded templates for now
    if (templates.length === 0) {
      const hardcodedTemplates: Template[] = [
        {
          id: 'node-basic',
          name: 'Node.js Basic',
          description: 'A simple Node.js application with Express',
          iconUrl: '/icons/node.svg',
          dockerImage: 'codeyarn-node-basic',
          startCommand: '/bin/sh',
          defaultPort: 3000,
          tags: ['node', 'javascript', 'backend'],
          repositoryUrl: 'https://github.com/codeyarn/templates/node-basic'
        },
        {
          id: 'react-vite',
          name: 'React (Vite)',
          description: 'Modern React application with Vite',
          iconUrl: '/icons/react.svg',
          dockerImage: 'codeyarn-node-basic',
          startCommand: 'npm run dev -- --host 0.0.0.0',
          defaultPort: 5173,
          tags: ['react', 'javascript', 'frontend', 'vite'],
          repositoryUrl: 'https://github.com/codeyarn/templates/react-vite'
        },
        {
          id: 'next-js',
          name: 'Next.js',
          description: 'Full-stack React framework',
          iconUrl: '/icons/nextjs.svg',
          dockerImage: 'codeyarn-node-basic',
          startCommand: '/bin/sh',
          defaultPort: 3000,
          tags: ['react', 'nextjs', 'fullstack'],
          repositoryUrl: 'https://github.com/codeyarn/templates/nextjs'
        }
      ];
      
      console.log('[API Templates] Returning hardcoded templates as fallback');
      return res.status(200).json(hardcodedTemplates);
    }
    
    return res.status(200).json(templates);
    
  } catch (error: any) {
    console.error('[API Error] Failed to retrieve templates:', error);
    next(error);
  }
});

// Export the router
export default router;
