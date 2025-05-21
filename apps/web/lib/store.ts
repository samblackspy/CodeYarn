// apps/web/lib/store.ts
import { create } from 'zustand';
import { devtools } from 'zustand/middleware'; // Optional: for Redux DevTools integration
import {
    PanelState,
    Theme,
    FileSystemNode,
    Project,
    Container,
    ContainerStatus,
} from '@codeyarn/shared-types';

// --- State Interface ---
// Defines the structure of our global state
interface AppState {
    // Project/Container Info
    currentProjectId: string | null;
    currentProject: Project | null; // Full project details
    currentContainer: Container | null; // Details of the active container

    // UI State
    panelState: PanelState;
    theme: Theme;

    // Editor/File State
    // Store only the ID of the currently selected/active file in the editor
    activeFileId: string | null;
    // We can keep the actual file tree map local to FileExplorer for now,
    // or move it here if needed by many components. Let's keep it local for now.
    // fileMap: Map<string, FileSystemNode>;
    // expandedFolders: Set<string>;

    // Add other global states as needed: user info, loading states, errors etc.
    // globalError: string | null;
    // isGlobalLoading: boolean;
}

// --- Actions Interface ---
// Defines the functions that can modify the state
interface AppActions {
    // Project/Container Actions
    setProjectData: (project: Project | null, container: Container | null) => void;
    clearProjectData: () => void;
    updateContainerStatus: (status: ContainerStatus) => void;

    // UI Actions
    togglePanel: (panel: keyof PanelState) => void;
    setPanelState: (panel: keyof PanelState, isOpen: boolean) => void;
    setTheme: (theme: Theme) => void;

    // Editor/File Actions
    setActiveFileId: (fileId: string | null) => void;

    // Add other actions as needed
    // setGlobalError: (error: string | null) => void;
    // setGlobalLoading: (isLoading: boolean) => void;
}

// --- Initial State ---
const initialState: AppState = {
    currentProjectId: null,
    currentProject: null,
    currentContainer: null,
    panelState: {
        explorer: true,
        terminal: true,
        preview: true,
    },
    theme: 'dark', // Default theme
    activeFileId: null,
    // globalError: null,
    // isGlobalLoading: false,
};

// --- Create Store ---
// Combines state and actions, optionally includes middleware like devtools
export const useAppStore = create<AppState & AppActions>()(
    devtools( // Optional: Wrap with devtools for Redux DevTools extension support
        (set, get) => ({
            ...initialState,

            // --- Implement Actions ---

            setProjectData: (project, container) => set(state => {
                console.log("[Store] Setting project data:", { project, container });
                return {
                    currentProject: project,
                    currentProjectId: project?.id ?? null,
                    currentContainer: container,
                    // Reset file state when project changes
                    activeFileId: null,
                };
            }, false, 'setProjectData'), // Action name for devtools

            clearProjectData: () => set(state => {
                 console.log("[Store] Clearing project data");
                 return {
                    currentProject: null,
                    currentProjectId: null,
                    currentContainer: null,
                    activeFileId: null,
                 }
            }, false, 'clearProjectData'),

            updateContainerStatus: (status) => set(state => {
                if (state.currentContainer?.status === status) return {}; // No change
                console.log(`[Store] Updating container status to: ${status}`);
                return {
                    currentContainer: state.currentContainer
                        ? { ...state.currentContainer, status }
                        : null,
                };
            }, false, 'updateContainerStatus'),

            togglePanel: (panel) => set(state => {
                console.log(`[Store] Toggling panel: ${panel}`);
                return {
                    panelState: {
                        ...state.panelState,
                        [panel]: !state.panelState[panel],
                    }
                };
            }, false, 'togglePanel'),

            setPanelState: (panel, isOpen) => set(state => {
                 if (state.panelState[panel] === isOpen) return {}; // No change
                 console.log(`[Store] Setting panel ${panel} to ${isOpen}`);
                 return {
                     panelState: {
                         ...state.panelState,
                         [panel]: isOpen,
                     }
                 };
            }, false, 'setPanelState'),

            setTheme: (theme) => set(state => {
                // Add logic here to apply theme class to documentElement if needed
                console.log(`[Store] Setting theme to: ${theme}`);
                // Example: document.documentElement.classList.toggle('dark', theme === 'dark');
                return { theme };
            }, false, 'setTheme'),

            setActiveFileId: (fileId) => set(state => {
                if (state.activeFileId === fileId) return {}; // No change
                console.log(`[Store] Setting active file ID: ${fileId}`);
                return { activeFileId: fileId };
            }, false, 'setActiveFileId'),

            // Implement other actions here
        }),
        {
            name: 'CodeYarnAppStore', // Name for Redux DevTools
        }
    )
);

// Optional: Selector hooks for convenience
// export const useCurrentProject = () => useAppStore((state) => state.currentProject);
// export const usePanelState = () => useAppStore((state) => state.panelState);
