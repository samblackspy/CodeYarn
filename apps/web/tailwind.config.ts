import type { Config } from 'tailwindcss';

const config: Config = {
  // Enable dark mode based on the 'class' strategy
  darkMode: ['class'],
  content: [
    // Scan files within the 'app' directory for App Router
    './app/pages/**/*.{js,ts,jsx,tsx,mdx}', // Include if using pages alongside app router (less common)
    './app/components/**/*.{js,ts,jsx,tsx,mdx}', // Scan components directory within app
    './app/layouts/**/*.{js,ts,jsx,tsx,mdx}', // Scan layouts directory within app (if used)
    './app/**/*.{js,ts,jsx,tsx,mdx}', // Scan root app directory for pages, layouts, etc.

    // Include content from shared UI packages if applicable
    // Example: '../../packages/ui/src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      // --- Customizations (same as before) ---
      colors: {
        'primary': {
          light: '#3b82f6', // Blue-500
          DEFAULT: '#2563eb', // Blue-600
          dark: '#1d4ed8',  // Blue-700
        },
        'secondary': {
          light: '#a855f7', // Purple-500
          DEFAULT: '#9333ea', // Purple-600
          dark: '#7e22ce',  // Purple-700
        },
        'background': {
          light: '#ffffff', // White
          DEFAULT: '#ffffff',
          dark: '#111827', // Gray-900
        },
        'foreground': {
          light: '#1f2937', // Gray-800
          DEFAULT: '#1f2937',
          dark: '#f9fafb', // Gray-50
        },
        'muted': {
          light: '#f3f4f6', // Gray-100
          DEFAULT: '#f3f4f6',
          dark: '#374151', // Gray-700
        },
        'muted-foreground': {
          light: '#6b7280', // Gray-500
          DEFAULT: '#6b7280',
          dark: '#9ca3af', // Gray-400
        },
        'border': {
            light: '#e5e7eb', // Gray-200
            DEFAULT: '#e5e7eb',
            dark: '#374151', // Gray-700
        },
      },
      fontFamily: {
        // sans: ['Inter', 'sans-serif'],
        // mono: ['Fira Code', 'monospace'],
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
      },
      borderRadius: {
        lg: `var(--radius)`,
        md: `calc(var(--radius) - 2px)`,
        sm: "calc(var(--radius) - 4px)",
      },
    },
  },
  plugins: [
    require('tailwindcss-animate'),
  ],
};

export default config;
