"use client"; // This component manages state, connects to sockets, and has interactions

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
    FilePlus, FolderPlus, MoreVertical, ChevronDown, ChevronRight, File, Folder, RefreshCcw, Loader2, Check, X, Edit, Trash2, AlertCircle
} from 'lucide-react';
import { FileSystemNode, FileSystemUpdatePayload } from '@codeyarn/shared-types';
import { io, Socket } from 'socket.io-client';
import { useAppStore } from '@/lib/store';
import { cn } from '@/lib/utils';
import path from 'path-browserify'; // Use browser-compatible path library

// Define props (likely none needed due to store)
interface FileExplorerProps {
    // Props can be added later if specific overrides or configurations are needed
}

// Define the WebSocket connection URL
const SOCKET_SERVER_URL = process.env.NEXT_PUBLIC_SOCKET_SERVER_URL || '';

// Type for the initial payload structure received from backend
interface InitialFileStructureNode extends FileSystemNode {
    children?: InitialFileStructureNode[];
}

// Type for context menu state
interface ContextMenuState {
    x: number;
    y: number;
    node: FileSystemNode;
}

// Type for rename state
interface RenameState {
    id: string; // ID of the node being renamed
    parentId: string | null;
    parentPath: string;
    currentName: string;
    itemType: 'file' | 'directory';
    level: number; // Visual level of the item being renamed
}

// --- Helper: File Tree Node Component ---
interface FileTreeNodeProps {
  node: FileSystemNode;
  level: number;
  isExpanded: boolean;
  isSelected: boolean; // Selection within the explorer
  isActiveFile: boolean; // Is this the file active in the editor?
  onToggleExpand: (path: string) => void;
  onNodeSelect: (node: FileSystemNode) => void; // For explorer selection
  onFileActivate: (node: FileSystemNode) => void; // For activating file in editor
  onContextMenu: (event: React.MouseEvent, node: FileSystemNode) => void; // Handler for right-click
}

const FileTreeNode: React.FC<FileTreeNodeProps> = React.memo(({
    node, level, isExpanded, isSelected, isActiveFile, onToggleExpand, onNodeSelect, onFileActivate, onContextMenu
}) => {
    const handleNodeClick = (e: React.MouseEvent) => {
        e.stopPropagation();
        onNodeSelect(node); // Select the node
        // Single click on a file also activates it for the editor
        if (!node.isDirectory) {
            onFileActivate(node);
        }
        // For directories, expansion is handled by dedicated chevron button or double-click
    };

    const handleDoubleClick = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (node.isDirectory) {
            onToggleExpand(node.path); // Toggle folder on double click
        } else {
            onFileActivate(node); // Ensure file activates on double click too
        }
    };

    const indentStyle = { paddingLeft: `${level * 1}rem` };

    return (
        <div
            key={node.path}
            className={cn(
                "flex items-center cursor-pointer group hover:bg-muted rounded px-2 py-1 text-sm select-none", // Prevent text selection on click
                isSelected ? "bg-muted" : "",
                isActiveFile ? "bg-primary/10 text-primary font-medium" : "",
            )}
            style={indentStyle}
            onClick={handleNodeClick}
            onDoubleClick={handleDoubleClick}
            onContextMenu={(e) => onContextMenu(e, node)} // Attach context menu handler
        >
            {/* Toggle & Icon */}
            <span className="mr-1 w-4 flex-shrink-0 flex items-center justify-center">
                {node.isDirectory ? (
                    <button
                        onClick={(e) => { e.stopPropagation(); onToggleExpand(node.path); }}
                        className="-ml-1 inline-flex items-center justify-center h-full w-full text-muted-foreground hover:text-foreground rounded-sm focus:outline-none focus:ring-1 focus:ring-primary"
                        aria-label={isExpanded ? 'Collapse folder' : 'Expand folder'}
                    >
                        {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </button>
                ) : (
                    <span className="w-3.5 inline-block"></span> // Placeholder for alignment
                )}
            </span>
            <span className="mr-1.5 flex-shrink-0">
                {node.isDirectory ? (
                    <Folder size={15} className={cn("text-yellow-500", isExpanded ? "text-yellow-400" : "")} />
                ) : (
                    <File size={15} className={cn(isActiveFile ? "text-primary" : "text-blue-500")} />
                )}
            </span>
            <span className="truncate flex-grow" title={node.name}>
                {node.name}
            </span>
            {/* Context Menu Trigger Button (optional, right-click is primary) */}
            {/* <button className="ml-auto p-0.5 opacity-0 group-hover:opacity-100 rounded hover:bg-background focus:outline-none"
                onClick={(e) => { e.stopPropagation(); onContextMenu(e, node); }}>
                <MoreVertical size={14} className="text-muted-foreground" />
            </button> */}
        </div>
    );
});
FileTreeNode.displayName = 'FileTreeNode';

// --- Helper: Input field for New Item / Rename ---
interface ItemInputProps {
    itemType: 'file' | 'directory';
    parentId: string | null; // For create: parentId of new item. For rename: parentId of item being renamed.
    parentPath: string; // For create: path of parent dir. For rename: path of parent dir of item being renamed.
    onSubmit: (name: string) => void;
    onCancel: () => void;
    level: number; // Visual indentation level for the input itself
    existingNames: Set<string>; // Names in the same directory, EXCLUDING current name if renaming
    initialValue?: string; // For renaming, the current name
    inputPurpose?: 'create' | 'rename';
}

const ItemInput: React.FC<ItemInputProps> = ({
    itemType, parentPath, onSubmit, onCancel, level, existingNames, initialValue = '', inputPurpose = 'create'
}) => {
    const [name, setName] = useState(initialValue);
    const [error, setError] = useState<string | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const hasSubmitted = useRef(false);


    useEffect(() => {
        inputRef.current?.focus();
        if (inputPurpose === 'rename' && inputRef.current) {
            // Select all text except the extension for files
            const dotIndex = initialValue.lastIndexOf('.');
            if (! (itemType === 'directory') && dotIndex > 0) {
                inputRef.current.setSelectionRange(0, dotIndex);
            } else {
                inputRef.current.select();
            }
        }
    }, [initialValue, inputPurpose, itemType]);

    const validateName = useCallback((currentVal: string): string | null => {
        const trimmed = currentVal.trim();
        if (!trimmed) return "Name cannot be empty.";
        if (trimmed.includes('/') || trimmed.includes('\\')) return "Name cannot contain slashes.";
        // If renaming and name hasn't changed, it's valid (allows "submit" to cancel)
        if (inputPurpose === 'rename' && trimmed === initialValue.trim()) return null;
        if (existingNames.has(trimmed)) return `"${trimmed}" already exists.`;
        return null;
    }, [existingNames, initialValue, inputPurpose]);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        setName(value);
        setError(validateName(value));
    };

    const handleSubmitLogic = useCallback(() => {
        if (hasSubmitted.current) return; // Prevent double submission

        const validationError = validateName(name);
        if (!validationError) {
            if (inputPurpose === 'rename' && name.trim() === initialValue.trim()) {
                onCancel(); // If name hasn't changed during rename, just cancel
                return;
            }
            hasSubmitted.current = true;
            onSubmit(name.trim());
        } else {
            setError(validationError);
            inputRef.current?.focus();
        }
    }, [name, validateName, inputPurpose, initialValue, onSubmit, onCancel]);


    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Escape') {
            onCancel();
        } else if (e.key === 'Enter') {
            e.preventDefault(); // Prevent form submission if nested elsewhere
            handleSubmitLogic();
        }
    };
    
    const handleBlur = () => {
        // Timeout to allow click on a potential submit button or Enter keydown to register
        setTimeout(() => {
            if (hasSubmitted.current) return;

            const validationError = validateName(name);
             if (inputPurpose === 'rename' && name.trim() === initialValue.trim()) {
                onCancel();
            } else if (validationError) {
                onCancel(); // If invalid name on blur, cancel
            } else {
                handleSubmitLogic(); // If valid and blurred, submit
            }
        }, 150); // Adjust delay as needed
    };


    // Input field's own content is visually at 'level', its icon is at 'level', padding pushes text further.
    // So, the container for the input should be at `level`. The icon inside it will be aligned with FileTreeNode icons.
    const indentStyle = { paddingLeft: `${level * 1}rem` };

    return (
        <div className="py-0.5"> {/* Minimal vertical padding for the input row */}
            <form onSubmit={(e) => {e.preventDefault(); handleSubmitLogic();}} className="flex items-center px-2 text-sm" style={indentStyle}>
                <span className="mr-1 w-4 flex-shrink-0 flex items-center justify-center">
                     {/* Placeholder for chevron alignment */}
                </span>
                <span className="mr-1.5 flex-shrink-0">
                    {itemType === 'directory' ? (
                        <Folder size={15} className="text-yellow-500" />
                    ) : (
                        <File size={15} className="text-blue-500" />
                    )}
                </span>
                <input
                    ref={inputRef}
                    type="text"
                    value={name}
                    onChange={handleChange}
                    onKeyDown={handleKeyDown}
                    onBlur={handleBlur}
                    className={cn(
                        "flex-grow bg-background text-foreground outline-none focus:ring-1 rounded-sm px-1 py-0.5 text-sm border",
                        error ? "border-red-500 focus:ring-red-500" : "border-primary focus:ring-primary"
                    )}
                    placeholder={inputPurpose === 'create' ? `New ${itemType}...` : `Rename to...`}
                    spellCheck="false"
                    autoComplete="off"
                    aria-invalid={!!error}
                    aria-describedby={error ? "item-input-error" : undefined}
                />
            </form>
            {error && (
                <div style={indentStyle} className="pl-1"> {/* Align error with input text start */}
                     <p id="item-input-error" className="ml-[calc(1rem+15px+0.375rem)] text-xs text-red-500 mt-0.5">{error}</p>
                </div>
            )}
        </div>
    );
};

/**
 * FileExplorer component displays the project's file and folder structure.
 */
export default function FileExplorer({ }: FileExplorerProps): JSX.Element {
    // Global State
    const containerId = useAppStore((state) => state.currentContainer?.id ?? null);
    const projectId = useAppStore((state) => state.currentProjectId);
    const activeFileId = useAppStore((state) => state.activeFileId);
    const setActiveFileIdAction = useAppStore((state) => state.setActiveFileId);

    // Local State
    const [fileMap, setFileMap] = useState<Map<string, FileSystemNode>>(new Map());
    const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set(['/workspace']));
    const [selectedNodePath, setSelectedNodePath] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [isConnected, setIsConnected] = useState(false);

    const [isCreating, setIsCreating] = useState(false);
    const [newItemType, setNewItemType] = useState<'file' | 'directory'>('file');
    const [newItemParentId, setNewItemParentId] = useState<string | null>(null);
    const [newItemParentPath, setNewItemParentPath] = useState<string>('/workspace');
    const [newItemLevel, setNewItemLevel] = useState<number>(0);

    const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
    const [renameState, setRenameState] = useState<RenameState | null>(null);

    const socketRef = useRef<Socket | null>(null);
    const contextMenuRef = useRef<HTMLDivElement>(null);

    // --- WebSocket Connection and Event Handling ---
    useEffect(() => {
        setFileMap(new Map());
        setExpandedFolders(new Set(['/workspace']));
        setSelectedNodePath(null);
        setIsCreating(false);
        setContextMenu(null);
        setRenameState(null);
        setIsLoading(true);
        setIsConnected(false);

        if (!containerId) {
            setIsLoading(false);
            if (socketRef.current) { socketRef.current.disconnect(); socketRef.current = null; }
            return;
        }
        if (socketRef.current && socketRef.current.connected) { socketRef.current.disconnect(); }

        console.log(`[FileExplorer] Initializing for container: ${containerId}`);
        

	  const socket = io('', {
            path: '/socket.io/',
            transports: ['websocket', 'polling'],
            reconnectionAttempts: 5,
            reconnectionDelay: 1000,
            timeout: 20000,
            forceNew: false,
            withCredentials: true
        });
        socketRef.current = socket;
	
	
	
	
	
	
	socket.on('connect', () => { console.log(`[FileExplorer] Socket connected: ${socket.id}`); setIsConnected(true); socket.emit('register-container', containerId); socket.emit('get-initial-fs', containerId); });
        socket.on('disconnect', (reason: string) => { console.log(`[FileExplorer] Socket disconnected: ${reason}`); setIsConnected(false); setIsLoading(false); });
        socket.on('connect_error', (err) => { console.error(`[FileExplorer] Socket connection error: ${err.message}`); setIsConnected(false); setIsLoading(false); });

        socket.on('initial-fs', (data: { containerId: string; fileStructure: InitialFileStructureNode | null }) => {
            if (data.containerId === containerId) {
                const initialMap = new Map<string, FileSystemNode>();
                if (data.fileStructure) {
                    console.log("[FileExplorer] Received initial file structure");
                    const buildMap = (node: InitialFileStructureNode) => {
                        const { children, ...nodeData } = node; // Separate children
                        initialMap.set(nodeData.path, nodeData);
                        if (nodeData.isDirectory && children && Array.isArray(children)) {
                            children.forEach(buildMap);
                        }
                    };
                    buildMap(data.fileStructure);
                } else {
                    console.log("[FileExplorer] Received empty initial file structure");
                }
                setFileMap(initialMap);
                setIsLoading(false);
            }
        });

        socket.on('fs-update', (data: FileSystemUpdatePayload) => {
            if (data.containerId !== containerId) return;

            console.log("[FileExplorer] Received fs-update:", data);
            setFileMap(currentMap => {
                const newMap = new Map(currentMap);
                const receivedNode = data.node;

                switch (data.event) {
                    case 'create':
                        if (receivedNode) {
                            newMap.set(receivedNode.path, receivedNode);
                            if (receivedNode.parentId) {
                                const parentNode = Array.from(newMap.values()).find(n => n.id === receivedNode.parentId);
                                if (parentNode) {
                                    setExpandedFolders(prev => new Set(prev).add(parentNode.path));
                                }
                            }
                            // Optionally select after creation
                            // setSelectedNodePath(receivedNode.path);
                            // if (!receivedNode.isDirectory) setActiveFileIdAction(receivedNode.id);
                        } else {
                            console.warn(`[FileExplorer] 'create' event for path '${data.path}' missing 'data.node'.`);
                        }
                        break;

                    case 'delete':
                        const pathsToDelete = Array.from(newMap.keys()).filter(p => p === data.path || p.startsWith(data.path + '/'));
                        let deletedNodeId: string | null = null;
                        const nodeBeingDeleted = currentMap.get(data.path);
                        if (nodeBeingDeleted) deletedNodeId = nodeBeingDeleted.id;

                        pathsToDelete.forEach(p => newMap.delete(p));
                        setExpandedFolders(prev => {
                            const newExpanded = new Set(prev);
                            pathsToDelete.forEach(p => newExpanded.delete(p));
                            return newExpanded;
                        });

                        if (deletedNodeId && deletedNodeId === useAppStore.getState().activeFileId) {
                            setActiveFileIdAction(null);
                        }
                        if (selectedNodePath && pathsToDelete.includes(selectedNodePath)) {
                            setSelectedNodePath(null);
                        }
                        if (renameState && renameState.id === deletedNodeId) {
                            setRenameState(null);
                        }
                        break;

                    case 'modify': // Needs to handle path changes for renames robustly
                        if (receivedNode) {
                            // Attempt to find the old node by ID, as its path might have changed
                            let oldPath: string | undefined;
                            currentMap.forEach((node, pathKey) => {
                                if (node.id === receivedNode.id) {
                                    oldPath = pathKey;
                                }
                            });

                            if (oldPath && oldPath !== receivedNode.path) {
                                newMap.delete(oldPath); // Remove old entry if path changed
                                // If a folder was renamed, its children's paths in the map are now stale.
                                // This requires a recursive update of children paths in newMap.
                                // This is complex and often requires a specific backend event strategy.
                                // For now, we'll just update/add the node at its new path.
                                // A full refresh might be needed for UI consistency on folder renames if children are not also updated.
                                console.warn(`[FileExplorer] Node '${receivedNode.id}' path changed from '${oldPath}' to '${receivedNode.path}'. Children paths may be stale.`);
                                 if (selectedNodePath === oldPath) setSelectedNodePath(receivedNode.path);

                                 // Update expanded folders if an expanded folder was renamed
                                 if(expandedFolders.has(oldPath)){
                                     setExpandedFolders(prev => {
                                         const newSet = new Set(prev);
                                         newSet.delete(oldPath!);
                                         newSet.add(receivedNode.path);
                                         return newSet;
                                     });
                                 }
                            }
                            newMap.set(receivedNode.path, receivedNode);


                        } else {
                            console.warn(`[FileExplorer] 'modify' event for path '${data.path}' missing 'data.node'.`);
                        }
                        break;
                }
                return newMap;
            });
        });

        socket.on('fs-error', (data: { containerId: string; error: string }) => {
            if (data.containerId === containerId) {
                console.error(`[FileExplorer] Filesystem Error: ${data.error}`);
                setIsLoading(false);  
            }
        });

        return () => {
            if (socketRef.current) { console.log(`[FileExplorer] Cleaning up socket for container: ${containerId}`); socketRef.current.disconnect(); socketRef.current = null; }
        };
    }, [containerId, setActiveFileIdAction]); // setActiveFileIdAction for fs-update -> delete case

    // --- Event Handlers ---
    const handleToggleExpand = useCallback((path: string) => { setExpandedFolders(prev => { const n = new Set(prev); if (n.has(path)) n.delete(path); else n.add(path); return n; }); }, []);
    const handleNodeSelect = useCallback((node: FileSystemNode) => { setSelectedNodePath(node.path); setIsCreating(false); setRenameState(null); setContextMenu(null); }, []);
    const handleFileActivate = useCallback((node: FileSystemNode) => { if (!node.isDirectory) setActiveFileIdAction(node.id); }, [setActiveFileIdAction]);
    const handleRefresh = () => { if (socketRef.current && containerId && isConnected) { setIsLoading(true); setFileMap(new Map()); setExpandedFolders(new Set(['/workspace'])); setSelectedNodePath(null); setIsCreating(false); setRenameState(null); setContextMenu(null); socketRef.current.emit('get-initial-fs', containerId); } };

    // --- Create Item Handlers ---
    const initiateCreateItem = (type: 'file' | 'directory') => {
        let parentIdToSet: string | null = null;
        let parentPathToSet = '/workspace';
        let levelToSet = 0;
        const selectedNode = selectedNodePath ? fileMap.get(selectedNodePath) : null;

        if (selectedNode) {
            if (selectedNode.isDirectory) { // Create inside selected folder
                parentIdToSet = selectedNode.id;
                parentPathToSet = selectedNode.path;
                setExpandedFolders(prev => new Set(prev).add(selectedNode.path));
            } else { // Create alongside selected file (in its parent)
                parentIdToSet = selectedNode.parentId;
                parentPathToSet = selectedNode.parentId ? (Array.from(fileMap.values()).find(n => n.id === selectedNode.parentId)?.path ?? '/workspace') : '/workspace';
            }
        }
        // Calculate level based on parent path
        const segments = parentPathToSet.split('/').filter(p => p && p !== 'workspace');
        levelToSet = segments.length;


        setNewItemType(type);
        setNewItemParentId(parentIdToSet);
        setNewItemParentPath(parentPathToSet);
        setNewItemLevel(levelToSet);
        setIsCreating(true);
        setContextMenu(null);
        setRenameState(null);
    };
    const handleNewFileClick = () => initiateCreateItem('file');
    const handleNewFolderClick = () => initiateCreateItem('directory');
    const handleCancelCreateOrRename = () => { setIsCreating(false); setRenameState(null); };

    const handleCreateItem = async (name: string) => {
        if (!projectId) { console.error("Missing Project ID"); setIsCreating(false); return; }
        console.log(`[FileExplorer] Creating ${newItemType}: ${path.join(newItemParentPath, name)}`);
        setIsCreating(false);
        try {
            const response = await fetch('/api/files', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId, parentId: newItemParentId, name, isDirectory: newItemType === 'directory' }) });
            if (!response.ok) { const data = await response.json().catch(() => ({ message: `HTTP error ${response.status}` })); throw new Error(data.message || 'Failed to create'); }
            console.log(`[FileExplorer] Create request successful. Waiting for WS update.`);
        } catch (error: any) { console.error(`[FileExplorer] Failed to create ${newItemType}:`, error.message); }
    };

    // --- Context Menu Handlers ---
    const handleContextMenuAction = useCallback((event: React.MouseEvent, node: FileSystemNode) => {
        event.preventDefault(); event.stopPropagation();
        setSelectedNodePath(node.path); setIsCreating(false); setRenameState(null);
        setContextMenu({ x: event.clientX, y: event.clientY, node });
    }, []);
    const closeContextMenu = useCallback(() => { setContextMenu(null); }, []);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (contextMenuRef.current && !contextMenuRef.current.contains(event.target as Node)) closeContextMenu();
        };
        if (contextMenu) { document.addEventListener('mousedown', handleClickOutside); }
        return () => { document.removeEventListener('mousedown', handleClickOutside); };
    }, [contextMenu, closeContextMenu]);

    // --- Delete Handler ---
    const handleDelete = async () => {
        if (!contextMenu) return;
        const nodeToDelete = contextMenu.node;
        closeContextMenu();
        if (!window.confirm(`Are you sure you want to delete "${nodeToDelete.name}"?${nodeToDelete.isDirectory ? ' This will delete all its contents.' : ''}`)) return;
        console.log(`[FileExplorer] Deleting: ${nodeToDelete.path}`);
        try {
            const response = await fetch(`/api/files/${nodeToDelete.id}`, { method: 'DELETE' });
            if (!response.ok) { const data = await response.json().catch(() => ({ message: `HTTP error ${response.status}` })); throw new Error(data.message || 'Failed to delete'); }
            console.log(`[FileExplorer] Delete request successful for ${nodeToDelete.path}. Waiting for WS update.`);
        } catch (error: any) { console.error(`[FileExplorer] Failed to delete ${nodeToDelete.path}:`, error.message);  }
    };

    // --- Rename Handlers ---
    const startRename = () => {
        if (contextMenu) {
            const node = contextMenu.node;
            // Determine parent path and level for the ItemInput
            const parentNode = node.parentId ? Array.from(fileMap.values()).find(n => n.id === node.parentId) : null;
            const parentPathForRename = parentNode ? parentNode.path : '/workspace';
            const segments = node.path.split('/').filter(p => p && p !== 'workspace');
            const itemLevel = segments.length -1;


            setRenameState({
                id: node.id,
                parentId: node.parentId,
                parentPath: parentPathForRename,
                currentName: node.name,
                itemType: node.isDirectory ? 'directory' : 'file',
                level: Math.max(0, itemLevel) // Level of the item itself being renamed
            });
            closeContextMenu();
        }
    };
    const handleRename = async (newName: string) => {
        if (!renameState) return;
        const nodeToRename = Array.from(fileMap.values()).find(n => n.id === renameState.id);
        if (!nodeToRename) { console.error("Node to rename not found"); setRenameState(null); return; }

        console.log(`[FileExplorer] Renaming ${nodeToRename.path} to ${newName}`);
        const oldPath = nodeToRename.path;
        setRenameState(null);
        try {
            const response = await fetch(`/api/files/${nodeToRename.id}/rename`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ newName }) });
            if (!response.ok) { const data = await response.json().catch(() => ({ message: `HTTP error ${response.status}` })); throw new Error(data.message || 'Failed to rename'); }
            console.log(`[FileExplorer] Rename successful for ${oldPath}. Waiting for WS update.`);
        } catch (error: any) { console.error(`[FileExplorer] Failed to rename ${oldPath}:`, error.message); }
    };

    // --- Recursive Rendering Logic ---
    const renderTree = (currentParentIdForRender: string | null, currentLevel: number): (JSX.Element | null)[] => {
        const children: FileSystemNode[] = [];
        const existingNamesInCurrentLevel = new Set<string>();
        fileMap.forEach(node => {
            if (node.parentId === currentParentIdForRender) {
                children.push(node);
                existingNamesInCurrentLevel.add(node.name);
            }
        });
        children.sort((a, b) => { if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1; return a.name.localeCompare(b.name); });

        const renderedElements = children.map(node => {
            if (renameState?.id === node.id) {
                return (
                    <ItemInput
                        key={`${node.id}-rename`}
                        itemType={renameState.itemType}
                        parentId={renameState.parentId}
                        parentPath={renameState.parentPath}
                        onSubmit={handleRename}
                        onCancel={handleCancelCreateOrRename}
                        level={currentLevel} // The item being renamed is at currentLevel
                        existingNames={new Set(Array.from(existingNamesInCurrentLevel).filter(name => name !== renameState.currentName))}
                        initialValue={renameState.currentName}
                        inputPurpose="rename"
                    />
                );
            }

            const isCreatingUnderThisNode = isCreating && newItemParentId === node.id && node.isDirectory && expandedFolders.has(node.path);
            let existingNamesForNewSubItem: Set<string> = new Set();
            if (isCreatingUnderThisNode) {
                fileMap.forEach(childNode => { if (childNode.parentId === node.id) existingNamesForNewSubItem.add(childNode.name); });
            }

            return (
                <React.Fragment key={node.path}>
                    <FileTreeNode
                        node={node} level={currentLevel}
                        isExpanded={expandedFolders.has(node.path)}
                        isSelected={selectedNodePath === node.path}
                        isActiveFile={!node.isDirectory && node.id === activeFileId}
                        onToggleExpand={handleToggleExpand} onNodeSelect={handleNodeSelect}
                        onFileActivate={handleFileActivate} onContextMenu={handleContextMenuAction}
                    />
                    {isCreatingUnderThisNode && (
                        <ItemInput
                            itemType={newItemType} parentId={node.id} parentPath={node.path}
                            onSubmit={handleCreateItem} onCancel={handleCancelCreateOrRename}
                            level={currentLevel + 1} // New item input is visually one level deeper
                            existingNames={existingNamesForNewSubItem} inputPurpose="create"
                        />
                    )}
                    {node.isDirectory && expandedFolders.has(node.path) && renderTree(node.id, currentLevel + 1)}
                </React.Fragment>
            );
        });

        if (isCreating && newItemParentId === null && currentParentIdForRender === null) {
            return [
                <ItemInput
                    key="new-item-root-input" itemType={newItemType} parentId={null} parentPath={newItemParentPath}
                    onSubmit={handleCreateItem} onCancel={handleCancelCreateOrRename}
                    level={0} // Input at root is level 0
                    existingNames={existingNamesInCurrentLevel} inputPurpose="create"
                />,
                ...renderedElements
            ];
        }
        return renderedElements;
    };

    // --- Render Component ---
    return (
        <div className="flex h-full flex-col border-r border-border bg-background">
            <div className="flex h-10 flex-shrink-0 items-center justify-between border-b border-border px-3 py-2">
                <h3 className="text-sm font-medium uppercase tracking-wide text-foreground">Explorer</h3>
                <div className="flex items-center space-x-1">
                    <button onClick={handleRefresh} disabled={isLoading || !isConnected || isCreating || !!renameState} className="p-1 rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50 disabled:pointer-events-none focus:outline-none focus:ring-1 focus:ring-border" aria-label="Refresh File Tree" title="Refresh">
                        {(isLoading && isConnected) ? <Loader2 size={16} className="animate-spin" /> : <RefreshCcw size={16} />}
                    </button>
                    <button onClick={handleNewFileClick} disabled={!isConnected || isCreating || !!renameState || !containerId} className="p-1 rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50 disabled:pointer-events-none focus:outline-none focus:ring-1 focus:ring-border" aria-label="New File" title="New File"> <FilePlus size={16} /> </button>
                    <button onClick={handleNewFolderClick} disabled={!isConnected || isCreating || !!renameState || !containerId} className="p-1 rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50 disabled:pointer-events-none focus:outline-none focus:ring-1 focus:ring-border" aria-label="New Folder" title="New Folder"> <FolderPlus size={16} /> </button>
                </div>
            </div>

            <div className="flex-grow overflow-y-auto py-1 pr-1" onClickCapture={() => { if (contextMenu) closeContextMenu(); /* Clicking in empty space doesn't cancel rename/create input to allow text selection/interaction */ }}>
                {isLoading && !isConnected && containerId && (<div className="p-4 text-center text-sm text-muted-foreground flex items-center justify-center h-full"> Connecting... </div>)}
                {isLoading && isConnected && (<div className="p-4 text-center text-sm text-muted-foreground flex items-center justify-center h-full"> <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading files... </div>)}
                {!isLoading && !isConnected && containerId && (<div className="p-4 text-center text-sm text-muted-foreground flex items-center justify-center h-full"> Disconnected. <button onClick={handleRefresh} className="ml-2 text-xs text-primary hover:underline">Retry?</button> </div>)}
                {!isLoading && isConnected && fileMap.size === 0 && !isCreating && !renameState && (<div className="p-4 text-center text-sm text-muted-foreground flex items-center justify-center h-full"> Workspace empty. Create an item. </div>)}
                {!containerId && !isLoading && !isCreating && !renameState && (<div className="p-4 text-center text-sm text-muted-foreground flex items-center justify-center h-full"> No container active. </div>)}

                {isConnected && (fileMap.size > 0 || isCreating || !!renameState) && ( <div> {renderTree(null, 0)} </div> )}
            </div>

            {contextMenu && (
                <div ref={contextMenuRef} className="fixed z-50 min-w-[160px] rounded-md border bg-background p-1 shadow-lg animate-in fade-in-0 zoom-in-95" style={{ top: `${contextMenu.y}px`, left: `${contextMenu.x}px` }}>
                    <button onClick={startRename} disabled={!contextMenu.node || contextMenu.node.path === '/workspace'} className="relative flex w-full cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none transition-colors hover:bg-muted focus:bg-accent focus:text-accent-foreground disabled:opacity-50 disabled:pointer-events-none"> <Edit size={14} className="mr-2" /> Rename </button>
                    <button onClick={handleDelete} disabled={!contextMenu.node || contextMenu.node.path === '/workspace'} className="relative flex w-full cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm text-red-600 outline-none transition-colors hover:bg-muted focus:bg-accent focus:text-accent-foreground dark:text-red-500 disabled:opacity-50 disabled:pointer-events-none"> <Trash2 size={14} className="mr-2" /> Delete </button>
                </div>
            )}
        </div>
    );
}
