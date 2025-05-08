import { PrismaClient } from '@prisma/client';

// Declare a global variable to hold the Prisma Client instance.
// This helps prevent creating multiple instances during hot-reloading in development.
declare global {
  // eslint-disable-next-line no-var
  var prisma: PrismaClient | undefined;
}

// Initialize Prisma Client
// Use the global instance if it exists, otherwise create a new one.
export const prisma = global.prisma || new PrismaClient({
  // Optional: Add logging configuration
  // log: ['query', 'info', 'warn', 'error'],
});

// In development environments, assign the created instance to the global variable.
if (process.env.NODE_ENV !== 'production') {
  global.prisma = prisma;
}

// Export the Prisma Client instance for use in other packages (like apps/server)
export default prisma;

// Optionally re-export types if needed elsewhere, though direct import from @prisma/client is common
// export * from '@prisma/client';
