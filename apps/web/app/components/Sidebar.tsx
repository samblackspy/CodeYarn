"use client"; // This component interacts with the Zustand store

import React from 'react';
import { FolderOpen, Terminal, Play, Settings, Plus } from 'lucide-react';
import { useAppStore } from '@/lib/store'; // Import the Zustand store hook
import { PanelState } from '@codeyarn/shared-types'; // Still useful for typing the key
import { cn } from "@/lib/utils";

// No props needed anymore for panel state/toggling

/**
 * Sidebar component provides primary navigation and panel toggling controls.
 * Reads panel state and calls toggle actions from the Zustand store.
 */
export default function Sidebar(): JSX.Element {
    // Get state and actions from the Zustand store
    const panelState = useAppStore((state) => state.panelState);
    const togglePanelAction = useAppStore((state) => state.togglePanel);

    // Helper function to generate button classes based on active state from store
    const getButtonClasses = (isActive: boolean): string => {
        return cn(
          "flex h-10 w-10 items-center justify-center rounded-md p-2 transition-colors duration-150 ease-in-out focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:ring-offset-background",
          isActive
            ? "bg-primary/10 text-primary hover:bg-primary/20" // Active state styles
            : "text-muted-foreground hover:bg-muted hover:text-foreground" // Inactive state styles
        );
    };

    return (
        <div className="flex h-full w-14 flex-shrink-0 flex-col items-center border-r border-border bg-background py-4">
            {/* Panel Toggle Buttons */}
            <nav className="flex flex-col items-center space-y-3">
                {/* File Explorer Toggle - Calls store action */}
                <button
                    onClick={() => togglePanelAction('explorer')}
                    className={getButtonClasses(panelState.explorer)}
                    aria-label="Toggle File Explorer"
                    title="File Explorer"
                >
                    <FolderOpen size={20} />
                </button>

                {/* Terminal Toggle - Calls store action */}
                <button
                    onClick={() => togglePanelAction('terminal')}
                    className={getButtonClasses(panelState.terminal)}
                    aria-label="Toggle Terminal"
                    title="Terminal"
                >
                    <Terminal size={20} />
                </button>

                {/* Preview Toggle - Calls store action */}
                <button
                    onClick={() => togglePanelAction('preview')}
                    className={getButtonClasses(panelState.preview)}
                    aria-label="Toggle Preview"
                    title="Preview"
                >
                    <Play size={20} />
                </button>
            </nav>

            {/* Spacer */}
            <div className="mt-auto flex flex-col items-center space-y-3">
                {/* New Project Button (Placeholder Action) */}
                <button
                    // onClick={handleNewProjectClick} // Add handler later
                    className={getButtonClasses(false)}
                    aria-label="Create New Project"
                    title="New Project"
                >
                    <Plus size={20} />
                </button>

                {/* Settings Button (Placeholder Action) */}
                <button
                    // onClick={handleSettingsClick} // Add handler later
                    className={getButtonClasses(false)}
                    aria-label="Settings"
                    title="Settings"
                >
                    <Settings size={20} />
                </button>
            </div>
        </div>
    );
}
