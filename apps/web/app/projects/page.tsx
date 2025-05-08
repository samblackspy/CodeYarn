'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import NewProjectModal from '@/app/components/NewProjectModal';
import { Project } from '@codeyarn/shared-types';

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isNewProjectModalOpen, setIsNewProjectModalOpen] = useState(false);
  const router = useRouter();

  useEffect(() => {
    async function fetchProjects() {
      try {
        setLoading(true);
        const response = await fetch('/api/projects');
        if (!response.ok) {
          throw new Error('Failed to fetch projects');
        }
        const data = await response.json();
        setProjects(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'An error occurred');
        console.error('Error fetching projects:', err);
      } finally {
        setLoading(false);
      }
    }

    fetchProjects();
  }, []);

  const handleProjectCreated = (newProject: Project) => {
    setProjects((prev) => [newProject, ...prev]);
    setIsNewProjectModalOpen(false);
    // Optionally redirect to the newly created project
    // router.push(`/projects/${newProject.id}`);
  };

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">Your Projects</h1>
        <button
          onClick={() => setIsNewProjectModalOpen(true)}
          className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-md"
        >
          New Project
        </button>
      </div>

      {loading ? (
        <div className="text-center py-8">Loading projects...</div>
      ) : error ? (
        <div className="text-red-500 py-4">Error: {error}</div>
      ) : projects.length === 0 ? (
        <div className="text-center py-8">
          <p className="text-gray-600 mb-4">You don't have any projects yet.</p>
          <button
            onClick={() => setIsNewProjectModalOpen(true)}
            className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-md"
          >
            Create Your First Project
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {projects.map((project) => (
            <Link href={`/projects/${project.id}`} key={project.id}>
              <div className="border border-gray-200 rounded-lg p-5 hover:shadow-md transition-shadow">
                <h2 className="text-xl font-semibold mb-2">{project.name}</h2>
                {project.description && (
                  <p className="text-gray-600 mb-3">{project.description}</p>
                )}
                <div className="flex justify-between text-sm text-gray-500">
                  <span>Created: {new Date(project.createdAt).toLocaleDateString()}</span>
                  {project.lastAccessedAt && (
                    <span>Last accessed: {new Date(project.lastAccessedAt).toLocaleDateString()}</span>
                  )}
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}

      {isNewProjectModalOpen && (
        <NewProjectModal
          isOpen={isNewProjectModalOpen}
          onClose={() => setIsNewProjectModalOpen(false)}
          onProjectCreated={handleProjectCreated}
        />
      )}
    </div>
  );
}
