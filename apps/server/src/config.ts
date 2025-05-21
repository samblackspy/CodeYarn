// src/config.ts
export const PORT = process.env.PORT || 3001;
export const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:3000';
export const MAX_SCROLLBACK_LINES = 200; // max lines for scrollback buffer

console.log(`[Config] PORT: ${PORT}, CORS_ORIGIN: ${CORS_ORIGIN}`);