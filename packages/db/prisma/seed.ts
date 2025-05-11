// prisma/seed.ts
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log(`Start seeding ...`);
  await prisma.project.deleteMany({});

await prisma.template.deleteMany({});
  console.log(`Cleared existing templates.`);
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
    update: {
        startCommand: '/bin/sh',
        sourceHostPath: null // <--- ADD THIS LINE TO THE UPDATE BLOCK
    },
    create: {
      id: 'node-basic',
      name: 'Node.js Basic',
      description: 'A simple Node.js application with Express',
      iconUrl: '/icons/node.svg', // Ensure these icons exist in your frontend's public dir
      dockerImage: 'codeyarn-node-basic:latest', // Use your custom runner image
      sourceHostPath: null, // Path relative to the seed script location
      startCommand: '/bin/sh',
      defaultPort: 3000,
      tags: ['node', 'javascript', 'backend'],
      repositoryUrl: null, // Or actual URL
    },
  });
  console.log(`Upserted template: node-basic`);

  await prisma.template.upsert({
    where: { id: 'react-vite' },
    update: {
        startCommand: '/bin/sh',
        sourceHostPath: null // <--- ADD THIS LINE TO THE UPDATE BLOCK
    },
    create: {
      id: 'react-vite',
      name: 'React (Vite)',
      description: 'Modern React application with Vite',
      iconUrl: '/icons/react.svg',
      dockerImage: 'codeyarn-react-vite:latest',
      sourceHostPath: null, // <<< ADD ACTUAL PATH
      startCommand: 'npm run dev -- --host 0.0.0.0',
      defaultPort: 5173,
      tags: ['react', 'javascript', 'frontend', 'vite'],
      repositoryUrl: null,
    },
  });
   console.log(`Upserted template: react-vite`);

await prisma.template.upsert({
    where: { id: 'nextjs-app' }, // Or whatever ID you chose (e.g., 'nextjs')
    update: { // Ensure all fields are correct if the template ID already existed
        name: 'Next.js App (App Router)',
        description: 'A Next.js template with App Router, TypeScript, and Tailwind CSS.', // Adjust description
        iconUrl: '/icons/nextjs.svg', // Ensure you have an icon
        tags: ['nextjs', 'react', 'app-router', 'typescript', 'tailwindcss'], // Adjust tags
        dockerImage: 'codeyarn-nextjs:latest', // The image you just built
        sourceHostPath: null,                 // Important: use baked-in workspace
        startCommand: '/bin/sh',          // Matches CMD in your Dockerfile
        defaultPort: 3000,                  // Matches EXPOSE in your Dockerfile
    },
    create: {
        id: 'nextjs-app', // Or whatever ID you chose
        name: 'Next.js App (App Router)',
        description: 'A Next.js template with App Router, TypeScript, and Tailwind CSS.',
        iconUrl: '/icons/nextjs.svg',
        tags: ['nextjs', 'react', 'app-router', 'typescript', 'tailwindcss'],
        dockerImage: 'codeyarn-nextjs:latest',
        sourceHostPath: null, // Important
        repositoryUrl: null, // Optional
        startCommand: '/bin/sh',
        defaultPort: 3000,
    },
});
console.log(`Upserted template: nextjs-app`); 
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
