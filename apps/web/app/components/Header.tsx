"use client"; // This component uses hooks and event handlers

import React from 'react';
import Link from 'next/link';
import { Menu, Github, User, Sun, Moon, LayoutGrid, FolderOpen } from 'lucide-react';
import { useAppStore } from '@/lib/store'; // Import the Zustand store hook
import { Project, Theme } from '@codeyarn/shared-types'; // Import shared types

// Define props for the Header component
interface HeaderProps {
  // Project data is now read from the store, but might be passed for initial load later
  currentProject?: Project | null; // Keep prop for now, but could be removed
  // Add other props if needed (e.g., onToggleSidebar)
}

/**
 * Header component displays the top navigation bar of the IDE.
 * Includes branding, project name, and action buttons.
 * Manages theme toggle via Zustand store.
 */
export default function Header({ currentProject: projectProp }: HeaderProps): JSX.Element {
  // Get state and actions from the Zustand store
  const currentTheme = useAppStore((state) => state.theme);
  const setThemeAction = useAppStore((state) => state.setTheme);
  // Get project data from store (prefer store over prop if available)
  const currentProject = useAppStore((state) => state.currentProject) ?? projectProp;

  // Function to toggle the theme using the store action
  const toggleTheme = () => {
    const newTheme: Theme = currentTheme === 'light' ? 'dark' : 'light';
    setThemeAction(newTheme); // Call the action from the store
  };

  return (
    <header className="flex h-12 flex-shrink-0 items-center justify-between border-b border-border bg-background px-4">
      {/* Left Section: Branding, Sidebar Toggle, Project Name */}
      <div className="flex items-center space-x-3">
        {/* Branding/Logo */}
        <div className="flex items-center font-semibold text-lg text-primary">
          <LayoutGrid className="mr-2 h-5 w-5" /> {/* Example Icon */}
          <span>CodeYarn</span>
        </div>

        {/* Display Current Project Name */}
        {currentProject ? (
          <>
            <span className="text-muted-foreground">/</span>
            <span className="text-sm font-medium text-foreground truncate" title={currentProject.name}>
              {currentProject.name}
            </span>
          </>
        ) : (
             <span className="text-sm text-muted-foreground">No Project Open</span>
         )}
      </div>

      {/* Right Section: Actions (Projects, Theme, GitHub, User) */}
      <div className="flex items-center space-x-2">
        {/* Projects Link */}
        <Link
          href="/projects"
          className="flex items-center p-1.5 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus:outline-none focus:ring-1 focus:ring-border"
          aria-label="Your Projects"
        >
          <FolderOpen size={18} />
          <span className="ml-1 text-sm">Projects</span>
        </Link>
        {/* Theme Toggle Button - Uses store state and action */}
        <button
          onClick={toggleTheme}
          className="p-1.5 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus:outline-none focus:ring-1 focus:ring-border"
          aria-label={`Switch to ${currentTheme === 'light' ? 'dark' : 'light'} theme`}
        >
          {currentTheme === 'light' ? <Moon size={18} /> : <Sun size={18} />}
        </button>

        {/* GitHub Link (Example) */}
        <a
          href="https://github.com" // Replace with your actual repo link
          target="_blank"
          rel="noopener noreferrer"
          className="p-1.5 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus:outline-none focus:ring-1 focus:ring-border"
          aria-label="GitHub repository"
        >
          <Github size={18} />
        </a>

        {/* User Profile Button (Placeholder) */}
        <button
          className="p-1.5 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus:outline-none focus:ring-1 focus:ring-border"
          aria-label="User profile"
        >
          {/* Replace with user avatar if available */}
          <User size={18} />
        </button>
      </div>
    </header>
  );
}
