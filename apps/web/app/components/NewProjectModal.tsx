// apps/web/app/components/NewProjectModal.tsx
'use client';

import React, { useState, useEffect } from 'react';
// Import Container type from shared-types
import { Template, Project as SharedProjectType, Container } from '@codeyarn/shared-types';
import TemplateSelector from './TemplateSelector'; // Assuming this is the correct path
import { useAppStore } from '@/lib/store'; // For setting current project/container
// import { useRouter } from 'next/navigation'; // Uncomment if you plan to use router here

interface NewProjectModalProps {
    isOpen: boolean;
    onClose: () => void;
    onProjectCreated: (newProject: SharedProjectType) => void;
}

export default function NewProjectModal({ isOpen, onClose, onProjectCreated }: NewProjectModalProps) {
    const [selectedTemplateId, setSelectedTemplateId] = useState<string>('');
    const [projectName, setProjectName] = useState('');
    const [projectDescription, setProjectDescription] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const setProjectData = useAppStore((state) => state.setProjectData);
    // const router = useRouter(); // If you want to redirect after creation from here

    // Reset form when modal is opened/closed or template changes
    useEffect(() => {
        if (isOpen) {
            setSelectedTemplateId(''); // Reset template selection when modal opens
            setProjectName('');
            setProjectDescription('');
            setError(null);
        }
    }, [isOpen]);

    const handleTemplateSelect = (templateId: string) => {
        setSelectedTemplateId(templateId);
        setError(null); // Clear previous errors
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!selectedTemplateId) {
            setError('Please select a template.');
            return;
        }
        if (!projectName.trim()) {
            setError('Please enter a project name.');
            return;
        }

        setIsLoading(true);
        setError(null);

        try {
            // 1. Create the project
            const projectResponse = await fetch('/api/projects', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: projectName.trim(),
                    templateId: selectedTemplateId,
                    description: projectDescription.trim(),
                }),
            });

            if (!projectResponse.ok) {
                const errorData = await projectResponse.json().catch(() => ({ message: 'Failed to create project.' }));
                throw new Error(errorData.message || `Project creation failed with status ${projectResponse.status}`);
            }
            const newProject: SharedProjectType = await projectResponse.json();
            console.log('Project created:', newProject);

            // 2. Create the container for the project
            const containerResponse = await fetch('/api/containers', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    projectId: newProject.id,
                    templateId: selectedTemplateId, // Or newProject.templateId if available and preferred
                }),
            });

            if (!containerResponse.ok) {
                const errorData = await containerResponse.json().catch(() => ({ message: 'Failed to create container.' }));
                // Optionally: attempt to delete the project if container creation fails, or let user retry.
                console.error(`Container creation failed for project ${newProject.id}: ${errorData.message}`);
                throw new Error(errorData.message || `Container creation failed with status ${containerResponse.status}`);
            }
            // Use the imported Container type
            const newContainer: Container = await containerResponse.json();
            console.log('Container created:', newContainer);

            // 3. Update global state (Zustand)
            setProjectData(newProject, newContainer); // Use the correct action

            // 4. Notify parent and close modal
            onProjectCreated(newProject);
            onClose();

            // 5. Optional: Redirect to the new project's IDE view
            // This might be better handled by the ProjectsPage or a global effect watching currentProject
            // router.push(`/ide/${newProject.id}`); // Example redirect

        } catch (err: any) {
            console.error('Error in new project flow:', err);
            setError(err.message || 'An unexpected error occurred.');
        } finally {
            setIsLoading(false);
        }
    };

    if (!isOpen) {
        return null;
    }

    return (
        <div className="fixed inset-0 bg-black bg-opacity-50 z-40 flex justify-center items-center p-4">
            <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col">
                <div className="flex justify-between items-center mb-4">
                    <h2 className="text-xl font-semibold">Create New Project</h2>
                    <button 
                        onClick={onClose} 
                        className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 p-1 rounded-full focus:outline-none focus:ring-2 focus:ring-gray-400"
                        aria-label="Close modal"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                        </svg>
                    </button>
                </div>

                <div className="overflow-y-auto flex-grow pr-2"> {/* Added pr-2 for scrollbar spacing */}
                    <form onSubmit={handleSubmit}>
                        <div className="mb-6">
                            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                                Select a Template
                            </label>
                            <TemplateSelector
                                selectedTemplateId={selectedTemplateId}
                                onSelectTemplate={handleTemplateSelect}
                            />
                        </div>

                        {selectedTemplateId && (
                            <>
                                <div className="mb-4">
                                    <label htmlFor="projectName" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                                        Project Name <span className="text-red-500">*</span>
                                    </label>
                                    <input
                                        type="text"
                                        id="projectName"
                                        value={projectName}
                                        onChange={(e) => setProjectName(e.target.value)}
                                        className="mt-1 block w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm dark:bg-gray-700"
                                        required
                                        placeholder="My Awesome Project"
                                    />
                                </div>

                                <div className="mb-6">
                                    <label htmlFor="projectDescription" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                                        Description (Optional)
                                    </label>
                                    <textarea
                                        id="projectDescription"
                                        value={projectDescription}
                                        onChange={(e) => setProjectDescription(e.target.value)}
                                        rows={3}
                                        className="mt-1 block w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm dark:bg-gray-700"
                                        placeholder="A brief description of your project."
                                    />
                                </div>
                            </>
                        )}

                        {error && <p className="text-red-500 text-sm mb-4">{error}</p>}
                    </form>
                </div>
                <div className="flex-shrink-0 pt-4 border-t border-gray-200 dark:border-gray-700 flex justify-end space-x-3">
                    <button
                        type="button"
                        onClick={onClose}
                        className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                    >
                        Cancel
                    </button>
                    <button
                        type="submit" // Will trigger form onSubmit via the onClick below
                        onClick={handleSubmit} // Also directly calling for clarity, form onSubmit is primary
                        disabled={!selectedTemplateId || !projectName.trim() || isLoading}
                        className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-md disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                    >
                        {isLoading ? 'Creating...' : 'Create Project'}
                    </button>
                </div>
            </div>
        </div>
    );
}

