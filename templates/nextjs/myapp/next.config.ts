import type { NextConfig } from "next";
const assetPrefix = process.env.ASSET_PREFIX || undefined;

const nextConfig = {
  reactStrictMode: true,
  assetPrefix: process.env.ASSET_PREFIX || undefined, // Keep your existing assetPrefix setting

  // Add this block for allowedDevOrigins
  devIndicators: {
    allowedDevOrigins: [
      'https://codeyarn.xyz', // Your main domain
    ],
  },
};
export default nextConfig;
