"use client"; // This component uses hooks, fetches data, and uses Monaco Editor

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Save, X, Code, Loader2, AlertTriangle } from 'lucide-react';
import Editor, { Monaco, OnChange, OnMount } from "@monaco-editor/react";
import { FileSystemNode } from '@codeyarn/shared-types';
import { useAppStore } from '@/lib/store'; // Import Zustand store
import { cn } from '@/lib/utils';

// Helper to map file extensions to Monaco language IDs
const getLanguageFromFilename = (filename: string = ''): string => {
    const extension = filename.split('.').pop()?.toLowerCase();
    switch (extension) {
        case 'js': case 'jsx': return 'javascript';
        case 'ts': case 'tsx': return 'typescript';
        case 'json': return 'json';
        case 'css': return 'css';
        case 'html': return 'html';
        case 'md': return 'markdown';
        case 'py': return 'python';
        case 'java': return 'java';
        case 'c': return 'c';
        case 'cpp': return 'cpp';
        case 'yaml': case 'yml': return 'yaml';
        default: return 'plaintext';
    }
};

type EditorStatus = 'idle' | 'loading' | 'saving' | 'error' | 'ready';

/**
 * EditorPanel component provides the main area for viewing and editing code
 * using the Monaco Editor. Loads/saves content via API and uses Zustand store.
 */
export default function EditorPanel(): JSX.Element {
    const activeFileId = useAppStore((state) => state.activeFileId);
    const setActiveFileIdAction = useAppStore((state) => state.setActiveFileId);

    const [activeFileNode, setActiveFileNode] = useState<FileSystemNode | null>(null);
    const [editorContent, setEditorContent] = useState<string>('');
    React.useEffect(() => {
        console.log('[Editor] editorContent:', editorContent);
    }, [editorContent]);
    const [isDirty, setIsDirty] = useState<boolean>(false);
    const [status, setStatus] = useState<EditorStatus>('idle');
    const [errorMessage, setErrorMessage] = useState<string | null>(null);

    const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
    const monacoRef = useRef<Monaco | null>(null);
    const isLoadingContent = useRef<boolean>(false);

    // --- Fetch File Details & Content Effect ---
    useEffect(() => {
        const fetchFile = async (fileId: string) => {
            console.log(`[Editor] Loading file ID: ${fileId}`);
            setStatus('loading');
            setErrorMessage(null);
            setActiveFileNode(null);
            setEditorContent('');
            isLoadingContent.current = true;

            try {
                // Fetch details and content in parallel
                const [detailsResponse, contentResponse] = await Promise.all([
                    fetch(`/api/files/${fileId}/details`),
                    fetch(`/api/files/${fileId}/content`)
                ]);

                // Check details response
                if (!detailsResponse.ok) {
                    let errorMsg = `Details Error: ${detailsResponse.status}`;
                    try { const data = await detailsResponse.json(); errorMsg = data.message || errorMsg; } catch (e) {}
                    throw new Error(errorMsg);
                }
                const nodeDetails: FileSystemNode = await detailsResponse.json();

                 // Check content response
                 if (!contentResponse.ok) {
                    let errorMsg = `Content Error: ${contentResponse.status}`;
                     try { const data = await contentResponse.json(); errorMsg = data.message || errorMsg; } catch (e) {}
                    throw new Error(errorMsg);
                }
                const content = await contentResponse.text();
                console.log(`[Editor] RAW CONTENT from API for ${nodeDetails.path}:`, content);

                // Update state with fetched data
                setActiveFileNode(nodeDetails); // Set the full node details
                setEditorContent(content);
                setIsDirty(false);
                setStatus('ready');
                console.log(`[Editor] Details & Content loaded for: ${nodeDetails.path}`);

                editorRef.current?.focus();

            } catch (error: any) {
                console.error(`[Editor] Error loading file ${fileId}:`, error);
                setErrorMessage(error.message || 'Failed to load file.');
                setStatus('error');
                setActiveFileNode(null);
                setEditorContent('');
            } finally {
                 setTimeout(() => { isLoadingContent.current = false; }, 50);
            }
        };

        if (activeFileId) {
            fetchFile(activeFileId);
        } else {
            setActiveFileNode(null);
            setEditorContent('');
            setIsDirty(false);
            setStatus('idle');
            setErrorMessage(null);
        }
    }, [activeFileId]);

    // --- Editor Handlers ---
    const handleEditorChange: OnChange = (value) => {
        if (!isLoadingContent.current) {
            setEditorContent(value || '');
            if (!isDirty) setIsDirty(true);
        }
    };

    const handleEditorDidMount: OnMount = (editor, monaco) => {
        console.log("[Editor] Monaco Editor Mounted");
        editorRef.current = editor;
        monacoRef.current = monaco;
        setStatus(prev => (prev === 'loading' ? 'ready' : prev));

        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, handleSaveFile);

        if (activeFileNode) editor.focus();
    };

    // --- Action Handlers ---
    const handleCloseFile = useCallback(() => {
        if (activeFileNode) {
            if (isDirty) {
                if (!window.confirm("You have unsaved changes. Are you sure you want to close?")) {
                    return;
                }
            }
            console.log('Closing file:', activeFileNode.path);
            setActiveFileIdAction(null);
        }
    }, [activeFileNode, setActiveFileIdAction, isDirty]);

    const handleSaveFile = useCallback(async () => {
        if (activeFileNode && isDirty && (status === 'ready' || status === 'error')) { // Allow saving even if previous save failed
            console.log('Saving file:', activeFileNode.path);
            setStatus('saving'); // Use 'saving' status
            setErrorMessage(null);

            try {
                const response = await fetch(`/api/files/${activeFileNode.id}/content`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'text/plain' },
                    body: editorContent,
                });

                if (!response.ok) {
                    let errorMsg = `Save Error: ${response.status}`;
                     try { const data = await response.json(); errorMsg = data.message || errorMsg; } catch (e) {}
                    throw new Error(errorMsg);
                }

                const result = await response.json(); // Get updated data (like updatedAt)

                setIsDirty(false);
                setStatus('ready');
                console.log('File saved successfully:', activeFileNode.path);
                // Update timestamp on the node from response
                setActiveFileNode(prev => prev ? {...prev, updatedAt: result.updatedAt } : null);

            } catch (error: any) {
                console.error(`[Editor] Error saving file ${activeFileNode.path}:`, error);
                setErrorMessage(error.message || 'Failed to save file.');
                setStatus('error');
            }
        } else if (!isDirty) {
            console.log('No changes to save.');
        }
    }, [activeFileNode, editorContent, isDirty, status]);

    const language = activeFileNode ? getLanguageFromFilename(activeFileNode.name) : 'plaintext';

    // --- Render ---
    return (
        <div className="flex h-full flex-col bg-background">
            {/* Tabs Section */}
            <div className="flex h-10 flex-shrink-0 items-center border-b border-border bg-muted/50">
                {activeFileNode ? (
                    <div className={cn(
                        "flex h-full items-center border-r border-border bg-background px-4 py-2 text-sm font-medium text-foreground relative",
                        isDirty ? "italic" : ""
                    )}>
                        <Code size={14} className="mr-2 text-primary flex-shrink-0" />
                        <span className="truncate" title={activeFileNode.path}>{activeFileNode.name}</span>
                        {isDirty && <span className="ml-1 text-muted-foreground" title="Unsaved changes">*</span>}
                        <button onClick={handleCloseFile} className="ml-2 p-0.5 rounded hover:bg-muted absolute right-1 top-1/2 -translate-y-1/2" aria-label={`Close ${activeFileNode.name}`}>
                            <X size={14} />
                        </button>
                    </div>
                ) : ( <div className="flex items-center px-4 py-2 text-sm text-muted-foreground"> No file open </div> )}
                 <button
                    onClick={handleSaveFile}
                    disabled={!activeFileNode || !isDirty || status === 'loading' || status === 'saving'}
                    className="ml-auto mr-2 my-auto p-1.5 rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50 disabled:pointer-events-none focus:outline-none focus:ring-1 focus:ring-border"
                    aria-label="Save current file" title="Save File (Ctrl+S)"
                 >
                    {status === 'saving' ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
                 </button>
            </div>

            {/* Editor Content Area */}
            <div className="flex-grow overflow-hidden relative bg-gray-900">
                {/* Loading State */}
                {status === 'loading' && (
                     <div className="absolute inset-0 z-10 flex items-center justify-center bg-gray-900/80">
                        <Loader2 className="h-8 w-8 animate-spin text-primary" />
                     </div>
                )}
                 {/* Error State */}
                {status === 'error' && (
                     <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-gray-900/90 p-4 text-center">
                         <AlertTriangle className="h-8 w-8 text-red-500 mb-3" />
                         <p className="text-red-500 font-medium mb-1">Error</p>
                         <p className="text-sm text-gray-300">{errorMessage || 'Could not load or save file.'}</p>
                         {/* Allow saving even if there was a load error */}
                         <button onClick={handleSaveFile} disabled={!isDirty} className="mt-4 inline-flex items-center rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted focus:outline-none focus:ring-1 focus:ring-border disabled:opacity-50">
                            <Save size={14} className="mr-2"/> Save Anyway
                         </button>
                     </div>
                 )}

                {/* Editor or Idle Message */}
                {activeFileId ? (
                    // Render editor only when a file ID is active (even if loading/error)
                    <Editor
                        height="100%"
                        language={language} // Use language from activeFileNode if available
                        value={editorContent}
                        theme="vs-dark"
                        onChange={handleEditorChange}
                        onMount={handleEditorDidMount}
                        loading={<div className="h-full w-full flex items-center justify-center text-muted-foreground">Loading Editor...</div>}
                        options={{
                            minimap: { enabled: true }, fontSize: 13, wordWrap: 'on',
                            automaticLayout: true, scrollBeyondLastLine: false,
                            readOnly: status === 'loading' || status === 'saving', // Readonly during load/save
                        }}
                        key={activeFileId} // Force remount on file change
                    />
                ) : (
                    // Placeholder when no file is active
                    status === 'idle' && (
                         <div className="flex h-full flex-col items-center justify-center text-center text-muted-foreground">
                             <Code size={48} className="mb-4 opacity-30" />
                             <p className="text-lg">No File Selected</p>
                             <p className="text-sm mt-1">Select a file from the explorer to start editing.</p>
                         </div>
                    )
                )}
            </div>
        </div>
    );
}
