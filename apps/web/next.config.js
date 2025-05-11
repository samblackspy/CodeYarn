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
      return [
        {
          source: '/api/:path*',
          destination: `${process.env.NEXT_PUBLIC_API_BASE_URL}/api/:path*`,
        },
        {
          source: '/socket.io/:path*',
          destination: `${process.env.NEXT_PUBLIC_API_BASE_URL}/socket.io/:path*`,
        },
      ];
    } else {
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

  publicRuntimeConfig: {
    apiBaseUrl: process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:3001',
  },
};

module.exports = nextConfig;

