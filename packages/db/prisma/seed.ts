// prisma/seed.ts
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log(`Start seeding ...`);

  // Create placeholder user for development
  await prisma.user.upsert({
    where: { id: 'clerk-user-placeholder' },
    update: {}, // No updates if exists
    create: {
      id: 'clerk-user-placeholder',
      email: 'dev@codeyarn.dev',
      name: 'Development User',
      createdAt: new Date(),
      updatedAt: new Date()
    }
  });
  console.log(`Upserted placeholder user: clerk-user-placeholder`);

  // Use upsert to avoid errors if templates already exist (e.g., if seeding runs multiple times)
  // but ensures required fields are present.

  await prisma.template.upsert({
    where: { id: 'node-basic' },
    update: { startCommand: '/bin/sh' }, // Update startCommand for existing records
    create: {
      id: 'node-basic',
      name: 'Node.js Basic',
      description: 'A simple Node.js application with Express',
      iconUrl: '/icons/node.svg', // Ensure these icons exist in your frontend's public dir
      dockerImage: 'codeyarn-node-basic:latest', // Use your custom runner image
      sourceHostPath: '../../templates/nodebasic', // Path relative to the seed script location
      startCommand: '/bin/sh',
      defaultPort: 3000,
      tags: ['node', 'javascript', 'backend'],
      repositoryUrl: null, // Or actual URL
    },
  });
  console.log(`Upserted template: node-basic`);

  await prisma.template.upsert({
    where: { id: 'react-vite' },
    update: {},
    create: {
      id: 'react-vite',
      name: 'React (Vite)',
      description: 'Modern React application with Vite',
      iconUrl: '/icons/react.svg',
      dockerImage: 'codeyarn-react-vite:latest',
      sourceHostPath: '../../templates/react-vite', // <<< ADD ACTUAL PATH
      startCommand: 'npm run dev -- --host 0.0.0.0',
      defaultPort: 5173,
      tags: ['react', 'javascript', 'frontend', 'vite'],
      repositoryUrl: null,
    },
  });
   console.log(`Upserted template: react-vite`);

  await prisma.template.upsert({
    where: { id: 'next-js' },
    update: {},
    create: {
        id: 'next-js',
        name: 'Next.js',
        description: 'Full-stack React framework',
        iconUrl: '/icons/nextjs.svg',
        dockerImage: 'codeyarn-next-js:latest',
        sourceHostPath: '../../templates/next-js', // <<< ADD ACTUAL PATH
        startCommand: 'npm run dev',
        defaultPort: 3000, // Make sure this is optional in schema if desired
        tags: ['react', 'nextjs', 'fullstack'],
        repositoryUrl: null,
    }
  });
   console.log(`Upserted template: next-js`);

  // Add upserts for any other templates...

  console.log(`Seeding finished.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });