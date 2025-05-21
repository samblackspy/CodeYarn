// apps/web/app/projects/[projectId]/page.tsx
'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Project as SharedProjectType, Container as SharedContainerType } from '@codeyarn/shared-types';
import { useAppStore } from '@/lib/store';

// Import your main IDE layout component
import MainIdeLayout from '@/app/components/MainIdeLayout'; 
import { Loader2 } from 'lucide-react'; // For loading indicator

export default function ProjectIdePage() {
    const params = useParams();
    const router = useRouter();
    const projectId = params.projectId as string;

    // Get actions and relevant state from the store
    // Note: We get currentProjectId and currentContainer directly inside useEffect via get()
    // or by selecting them if we need them for the render logic outside useEffect.
    // For the effect's dependency array, we only need projectId from params and stable actions.
    const setProjectData = useAppStore(state => state.setProjectData);
    const storeCurrentProjectId = useAppStore(state => state.currentProjectId);
    const storeCurrentContainer = useAppStore(state => state.currentContainer);


    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let isMounted = true;

        if (!projectId) {
            console.log("[ProjectIdePage] No projectId in URL.");
            setError("No project ID specified in URL.");
            setProjectData(null, null); // Clear any existing project data
            setIsLoading(false);
            return;
        }

        // Access the latest store state directly for the check
        const currentStoreProjectId = useAppStore.getState().currentProjectId;
        const currentStoreContainer = useAppStore.getState().currentContainer;

        // If data for the current projectId is already loaded and consistent, don't re-fetch.
        if (currentStoreProjectId === projectId && currentStoreContainer && currentStoreContainer.projectId === projectId) {
            console.log(`[ProjectIdePage] Data already loaded and consistent for projectId: ${projectId}`);
            setIsLoading(false);
            setError(null); // Ensure no previous error is shown
            return;
        }

        console.log(`[ProjectIdePage] useEffect: Needs to load data for projectId: ${projectId}. Current in store: ${currentStoreProjectId}`);
        setIsLoading(true);
        setError(null);

        async function loadProjectAndContainer() {
            try {
                // 1. Fetch project details
                console.log(`[ProjectIdePage] Fetching project details for ${projectId}`);
                const projectRes = await fetch(`/api/projects/${projectId}`);
                if (!isMounted) return;
                if (!projectRes.ok) {
                    const errData = await projectRes.json().catch(() => ({ message: `Project not found or error (status ${projectRes.status})` }));
                    throw new Error(errData.message);
                }
                const projectData: SharedProjectType = await projectRes.json();
                console.log(`[ProjectIdePage] Fetched project data:`, projectData);

                if (!isMounted) return;

                if (!projectData.templateId) {
                    console.error("[ProjectIdePage] Project data is missing templateId!");
                    throw new Error("Project data is incomplete (missing templateId).");
                }

                // 2. Fetch or create container for the project
                console.log(`[ProjectIdePage] Fetching/creating container for project ${projectData.id} with template ${projectData.templateId}`);
                const containerResponse = await fetch('/api/containers', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        projectId: projectData.id,
                        templateId: projectData.templateId,
                    }),
                });

                if (!isMounted) return;
                if (!containerResponse.ok) {
                    const errorData = await containerResponse.json().catch(() => ({ message: 'Failed to prepare workspace.' }));
                    throw new Error(errorData.message);
                }
                const containerData: SharedContainerType = await containerResponse.json();
                console.log(`[ProjectIdePage] Fetched/created container data:`, containerData);

                if (!isMounted) return;

                // Explicitly check containerData integrity
                if (!containerData.projectId) {
                    console.error("[ProjectIdePage] Container data from API is missing projectId!");
                    throw new Error("Workspace data is incomplete (container missing project ID).");
                }
                if (containerData.projectId !== projectData.id) {
                     console.error(`[ProjectIdePage] Mismatch: projectData.id is ${projectData.id} but containerData.projectId is ${containerData.projectId}`);
                     throw new Error("Workspace data inconsistency (project ID mismatch).");
                }

                // 3. Set data in Zustand store
                console.log(`[ProjectIdePage] Setting project data in store:`, { project: projectData, container: containerData });
                setProjectData(projectData, containerData);

            } catch (err) {
                if (!isMounted) return;
                console.error('[ProjectIdePage] Error loading project/container:', err);
                setError(err instanceof Error ? err.message : 'An unknown error occurred while loading the project.');
                // Optionally clear project data in store on critical failure
                // setProjectData(null, null); 
            } finally {
                if (isMounted) {
                    setIsLoading(false);
                }
            }
        }

        loadProjectAndContainer();

        return () => {
            console.log(`[ProjectIdePage] Cleanup for projectId: ${projectId}`);
            isMounted = false;
            // Consider if project data should be cleared when navigating away.
            // If navigating to another project page, this effect will run for the new projectId.
            // If navigating completely away from any project IDE, then clearing might be desired.
            // For now, let's not clear it aggressively here.
        };
    // Dependency array:
    // - projectId: The primary trigger from the URL.
    // - setProjectData: The stable action from Zustand.
    // We read currentProjectId and currentContainer *inside* the effect using useAppStore.getState()
    // to avoid making them dependencies that would cause the effect to re-run when they are set.
    }, [projectId, setProjectData]);

    if (isLoading) {
        return (
            <div className="flex flex-col items-center justify-center h-screen bg-gray-100 dark:bg-gray-900">
                <Loader2 className="w-12 h-12 text-blue-600 dark:text-blue-400 animate-spin mb-4" />
                <p className="text-lg text-gray-700 dark:text-gray-300">Loading your workspace...</p>
                <p className="text-sm text-gray-500 dark:text-gray-400">Please wait a moment.</p>
            </div>
        );
    }

    if (error) {
        return (
            <div className="flex flex-col items-center justify-center h-screen bg-gray-100 dark:bg-gray-900 p-4">
                <h2 className="text-2xl font-semibold text-red-600 dark:text-red-400 mb-4">Oops! Something went wrong.</h2>
                <p className="text-md text-gray-700 dark:text-gray-300 mb-6 text-center">{error}</p>
                <button
                    onClick={() => router.push('/projects')}
                    className="px-6 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
                >
                    Go to My Projects
                </button>
            </div>
        );
    }

    // After loading and no error, check if the store reflects the current projectId.
    // This condition is crucial for rendering the IDE.
    // We use the reactive store values here for the render decision.
    if (storeCurrentProjectId === projectId && storeCurrentContainer && storeCurrentContainer.projectId === projectId) {
        return <MainIdeLayout />;
    }

    // Fallback if store state doesn't match URL projectId after loading attempt (e.g. error during set or redirect)
    // This might also briefly show if there's a slight delay between setProjectData and the re-render picking up storeCurrentProjectId.
    // Or if an error occurred but wasn't caught by the setError state for some reason.
    console.warn(`[ProjectIdePage] Fallback render: storeCurrentProjectId (${storeCurrentProjectId}) or storeCurrentContainer.projectId does not match URL projectId (${projectId}). This might be a transient state or indicate an issue.`);
    return (
         <div className="flex flex-col items-center justify-center h-screen bg-gray-100 dark:bg-gray-900 p-4">
            <Loader2 className="w-12 h-12 text-blue-600 dark:text-blue-400 animate-spin mb-4" />
            <p className="text-lg text-gray-700 dark:text-gray-300">Finalizing workspace setup...</p>
        </div>
    );
}
