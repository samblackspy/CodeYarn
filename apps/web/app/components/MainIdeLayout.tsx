"use client"; // This component uses hooks and interactivity, mark as client component

import React from 'react'; // Removed useState
import {
    Panel,
    PanelGroup,
    PanelResizeHandle,
} from "react-resizable-panels";
import { useAppStore } from '@/lib/store'; // Import the Zustand store hook
import { cn } from '@/lib/utils';

// Import placeholder components
import Header from './Header';
import Sidebar from './Sidebar';
import FileExplorer from './FileExplorer';
import EditorPanel from './Editor'; // Use the renamed EditorPanel component
import Terminal from './Terminal';
import Preview from './Preview';
// PanelState type is no longer needed here directly as it's managed in the store

/**
 * MainIdeLayout component orchestrates the primary user interface structure
 * of the CodeYarn IDE, including resizable panels.
 * Reads panel visibility state from the Zustand store.
 */
export default function MainIdeLayout(): JSX.Element {
    // Get panel state directly from the Zustand store
    const panelState = useAppStore((state) => state.panelState);
    // Get project/container data from store (will be used later)
    const currentProject = useAppStore((state) => state.currentProject);
    const currentContainer = useAppStore((state) => state.currentContainer);
    // Get active file ID from store (will be used later)
    const activeFileId = useAppStore((state) => state.activeFileId);


    // togglePanel function is removed - Sidebar will call the store action directly

    // CSS classes for the resize handles
    const resizeHandleClasses = "bg-border hover:bg-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 data-[resize-handle-active]:bg-primary";

    return (
        <div className="flex flex-col h-screen w-screen overflow-hidden bg-background text-foreground">
            {/* Header Component - Pass project data from store */}
            <Header currentProject={currentProject} />

            <div className="flex flex-1 overflow-hidden">
                {/* Sidebar Component - No longer needs panelState or onTogglePanel props */}
                <Sidebar />

                {/* Main Content Area with Resizable Panels */}
                <PanelGroup direction="vertical" className="flex-1" id="main-vertical-group">
                    {/* Top Section: Explorer, Editor, Preview */}
                    <Panel defaultSize={75} minSize={30} id="top-panel" order={1}>
                        <PanelGroup direction="horizontal" className="h-full" id="top-horizontal-group">
                            {/* File Explorer Panel (Conditionally Rendered based on store state) */}
                            {panelState.explorer && (
                                <>
                                    <Panel
                                        defaultSize={20} minSize={15} maxSize={40}
                                        collapsible={true} collapsedSize={0}
                                        id="file-explorer" order={1}
                                        className="flex flex-col h-full" // Ensure panel takes full height
                                    >
                                        {/* Pass containerId from store */}
                                        <FileExplorer />
                                    </Panel>
                                    <PanelResizeHandle className={cn("w-1 transition-colors", resizeHandleClasses)} />
                                </>
                            )}

                            {/* Editor & Preview Split Panel */}
                            <Panel id="editor-preview-panel" order={2}>
                                <PanelGroup direction="horizontal" id="editor-preview-group">
                                    {/* Editor Panel */}
                                    <Panel
                                        // Adjust size dynamically based on whether preview is shown
                                        defaultSize={panelState.preview ? 60 : 100}
                                        minSize={30} id="editor" order={1}
                                        className="flex flex-col h-full"
                                    >
                                        {/* Pass activeFileId or related props from store later */}
                                        <EditorPanel />
                                    </Panel>

                                    {/* Preview Panel (Conditionally Rendered based on store state) */}
                                    {panelState.preview && (
                                        <>
                                            <PanelResizeHandle className={cn("w-1 transition-colors", resizeHandleClasses)} />
                                            <Panel
                                                defaultSize={40} minSize={20}
                                                collapsible={true} collapsedSize={0}
                                                id="preview" order={2}
                                                className="flex flex-col h-full"
                                            >
                                                 {/* Pass containerId from store */}
                                                <Preview containerId={currentContainer?.id || null}/>
                                            </Panel>
                                        </>
                                    )}
                                </PanelGroup>
                            </Panel>
                        </PanelGroup>
                    </Panel>

                    {/* Bottom Section: Terminal Panel (Conditionally Rendered based on store state) */}
                    {panelState.terminal && (
                        <>
                            <PanelResizeHandle className={cn("h-1 transition-colors", resizeHandleClasses)} />
                            <Panel
                                defaultSize={25} minSize={10} maxSize={50}
                                collapsible={true} collapsedSize={0}
                                id="terminal" order={2}
                                className="flex flex-col h-full" // Ensure panel takes full height
                            >
                                 {/* Pass containerId from store */}
                                <Terminal containerId={currentContainer?.id || null}/>
                            </Panel>
                        </>
                    )}
                </PanelGroup>
            </div>
        </div>
    );
}
