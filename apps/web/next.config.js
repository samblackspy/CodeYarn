/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  // Transpile packages from the monorepo
  transpilePackages: ['@codeyarn/db', '@codeyarn/ui'],
  
  // Disable static optimization for client components
  experimental: {
    // This prevents "self is not defined" errors during build
    serverComponentsExternalPackages: ['@monaco-editor/react', 'monaco-editor'],
  },
  
  // Disable image optimization to prevent build errors
  images: {
    unoptimized: true,
  },
  
  async rewrites() {
    if (process.env.NODE_ENV === 'production') {
      // In production, Nginx handles proxying to the backend service.
      // No explicit rewrites are needed here for API/Socket.io if Next.js app
      // makes relative requests (e.g., /api/..., /socket.io/...)
      // and NEXT_PUBLIC_API_BASE_URL is set to '/' or similar if needed by client-side code.
      return [
        // Add any other production-specific, non-API/Socket.io rewrites if necessary
      ];
    } else {
      // Development rewrites: proxy to local backend server
      return [
        {
          source: '/api/:path*',
          destination: 'http://localhost:3001/api/:path*',
        },
        {
          source: '/socket.io/:path*',
          destination: 'http://localhost:3001/socket.io/:path*',
        },
      ];
    }
  },

  // Optional: If you need to expose the server's hostname/port to the client-side
  // in a way that's consistent with Docker's internal networking for SSR, but
  // also works for client-side fetches that go through Nginx.
  // publicRuntimeConfig: {
  //   apiBaseUrl: process.env.NODE_ENV === 'production' ? '/api' : 'http://localhost:3001/api',
  //   socketIoPath: process.env.NODE_ENV === 'production' ? '/socket.io' : 'http://localhost:3001/socket.io',
  // },
};

module.exports = nextConfig;
