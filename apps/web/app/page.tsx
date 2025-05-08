import React from 'react';
import MainIdeLayout from '@/app/components/MainIdeLayout'; // Import the main layout component

/**
 * HomePage component serves as the entry point for the root route ('/').
 * It renders the main IDE layout.
 *
 * @returns {JSX.Element} The component rendering the IDE layout.
 */
export default function HomePage(): JSX.Element {
  return (
    <main className="h-screen w-screen overflow-hidden">
      {/* Render the main IDE layout component */}
      <MainIdeLayout />
    </main>
  );
}
