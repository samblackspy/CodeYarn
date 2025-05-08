import React, { useState, useEffect } from 'react';
import { Template } from '@codeyarn/shared-types';

interface TemplateSelectorProps {
  selectedTemplateId: string;
  onSelectTemplate: (templateId: string) => void;
}

export default function TemplateSelector({ selectedTemplateId, onSelectTemplate }: TemplateSelectorProps) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchTemplates() {
      try {
        setLoading(true);
        const response = await fetch('/api/templates');
        if (!response.ok) {
          throw new Error('Failed to fetch templates');
        }
        const data = await response.json();
        setTemplates(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'An error occurred');
        console.error('Error fetching templates:', err);
      } finally {
        setLoading(false);
      }
    }

    fetchTemplates();
  }, []);

  if (loading) {
    return <div className="flex justify-center py-6">Loading templates...</div>;
  }

  if (error) {
    return <div className="text-red-500 py-4">Error: {error}</div>;
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mt-4">
      {templates.map((template) => (
        <div
          key={template.id}
          className={`border rounded-lg p-4 cursor-pointer transition-all hover:shadow-md ${
            selectedTemplateId === template.id ? 'border-blue-500 bg-blue-50' : 'border-gray-200'
          }`}
          onClick={() => onSelectTemplate(template.id)}
        >
          <div className="flex items-center mb-2">
            {template.iconUrl && (
              <img src={template.iconUrl} alt={template.name} className="w-8 h-8 mr-2" />
            )}
            <h3 className="text-lg font-medium">{template.name}</h3>
          </div>
          {template.description && (
            <p className="text-gray-600 text-sm">{template.description}</p>
          )}
          <div className="mt-2 text-xs text-gray-500">
            {template.tags?.map((tag, index) => (
              <span key={index} className="inline-block bg-gray-100 rounded px-2 py-1 mr-1 mb-1">
                {tag}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
