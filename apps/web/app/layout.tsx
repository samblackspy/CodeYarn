import type { Metadata } from "next";
import { Inter } from "next/font/google"; // Example font import
import "./globals.css"; // Import the global styles (including Tailwind)
import { cn } from "@/lib/utils"; // Assuming a utility function for class names exists or will be created

// Load the Inter font (or any other font you prefer)
const inter = Inter({ subsets: ["latin"], variable: "--font-sans" }); // Define CSS variable for font

// Define metadata for the application (SEO and browser tab)
export const metadata: Metadata = {
  title: "CodeYarn - Online IDE", // Application title
  description: "A browser-based IDE for instant development playgrounds.", // Application description
  // Add more metadata as needed (icons, open graph, etc.)
};

/**
 * RootLayout component defines the main HTML structure for the entire application.
 * It wraps all pages and nested layouts.
 * @param {object} props - Component props.
 * @param {React.ReactNode} props.children - The nested layouts or pages to render.
 * @returns {JSX.Element} The root layout structure.
 */
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>): JSX.Element {
  return (
    <html lang="en" suppressHydrationWarning>
       {/*
         The suppressHydrationWarning attribute is added to <html> because we'll likely
         use a theme provider later which might cause a mismatch between server and client render
         for the 'class' attribute (light/dark).
       */}
      <body
        className={cn(
          "min-h-screen bg-background font-sans antialiased", // Base body styles using Tailwind classes and font variable
          inter.variable // Apply the font variable to the body
        )}
      >
        {/*
          We will wrap 'children' with providers later, e.g.,
          <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
            <AppStateProvider>  // Your global state provider
              {children}
            </AppStateProvider>
          </ThemeProvider>
        */}
        {children}
      </body>
    </html>
  );
}
