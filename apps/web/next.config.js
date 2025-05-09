/** @type {import('next').NextConfig} */
const nextConfig = {
  // Remove output setting completely to use default build
  
  // Disable static optimization for client components
  experimental: {
    // This prevents "self is not defined" errors during build
    serverComponentsExternalPackages: ['@monaco-editor/react', 'monaco-editor'],
  },
  
  // Disable image optimization to prevent build errors
  images: {
    unoptimized: true,
  },
  
  // Configure API rewrites for development
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: 'http://localhost:3001/api/:path*', // Proxy to backend server
      },
      {
        source: '/socket.io/:path*',
        destination: 'http://localhost:3001/socket.io/:path*', // Proxy WebSocket connections
      },
    ];
  },
};

module.exports = nextConfig;
