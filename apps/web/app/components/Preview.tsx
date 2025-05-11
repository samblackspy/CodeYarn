"use client"; // This component uses hooks, refs, and fetches data

import React, { useState, useRef, useEffect } from 'react';
import { RefreshCw, ExternalLink, X, Loader2, AlertTriangle, ServerCrash } from 'lucide-react';
import { ContainerStatus } from '@codeyarn/shared-types'; // Import status type
import { cn } from '@/lib/utils';
import { io, Socket } from 'socket.io-client'; // Import socket.io client

// Define the WebSocket connection URL (should match backend)
const SOCKET_SERVER_URL = process.env.NEXT_PUBLIC_SOCKET_SERVER_URL || '';

// Define props (containerId is essential)
interface PreviewProps {
  containerId: string | null; // ID of the container whose preview to display
  // Add theme prop later if needed
}

// Define the expected structure of the API response
interface PreviewDetailsResponse {
    containerId: string;
    status: ContainerStatus;
    hostPort: number;
    internalPort: number;
    previewUrl: string; // The crucial URL for the iframe
}

// Define possible states for the preview panel
type PreviewState =
    | { status: 'idle' } // Not yet loaded or no container ID
    | { status: 'loading' } // Fetching URL
    | { status: 'error'; message: string } // Error fetching URL or container not running
    | { status: 'loaded'; url: string } // URL loaded successfully
    | { status: 'iframe_loading'; url: string } // Iframe content is loading

/**
 * Preview component displays the running application output within an iframe,
 * fetching the correct URL from the backend.
 */
export default function Preview({ containerId }: PreviewProps): JSX.Element {
  const [previewState, setPreviewState] = useState<PreviewState>({ status: 'idle' });
  const [key, setKey] = useState(0); // Key to force iframe reload
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const currentUrlRef = useRef<string>('about:blank'); // Store the current valid URL
  const socketRef = useRef<Socket | null>(null); // Ref for WebSocket connection

  // Fetch preview details when containerId changes or on explicit refresh
  const fetchPreviewDetails = async () => {
    if (!containerId) {
        setPreviewState({ status: 'idle' });
        currentUrlRef.current = 'about:blank';
        setKey(prev => prev + 1); // Reset iframe
        return;
    }

    console.log(`[Preview] Fetching details for container: ${containerId}`);
    setPreviewState({ status: 'loading' });
    currentUrlRef.current = 'about:blank'; // Clear previous URL while loading

    try {
        const apiUrl = `/api/containers/${containerId}/preview-details`; // Use relative path
        const response = await fetch(apiUrl);

        if (!response.ok) {
            let errorMessage = `HTTP error! status: ${response.status}`;
            try {
                const errorData = await response.json();
                errorMessage = errorData.message || errorMessage;
            } catch (e) { /* Ignore JSON parsing error */ }
            console.error(`[Preview] Failed to fetch details: ${errorMessage}`);
            setPreviewState({ status: 'error', message: errorMessage });
            return;
        }

        const data: PreviewDetailsResponse = await response.json();

        if (data.status !== 'RUNNING') {
             console.warn(`[Preview] Container ${containerId} status is ${data.status}. Preview unavailable.`);
             setPreviewState({ status: 'error', message: `Container is not running (status: ${data.status}). Start it via terminal.` });
             return;
        }

        if (!data.previewUrl) {
            console.error(`[Preview] Backend did not provide a previewUrl for ${containerId}.`);
            setPreviewState({ status: 'error', message: 'Preview URL not available from backend.' });
            return;
        }

        console.log(`[Preview] Received URL: ${data.previewUrl}`);
        currentUrlRef.current = data.previewUrl;
        // Set state to iframe_loading, the handleIframeLoad will set it to 'loaded'
        setPreviewState({ status: 'iframe_loading', url: data.previewUrl });
        setKey(prev => prev + 1); // Force iframe reload with the new URL

    } catch (error: any) {
        console.error(`[Preview] Error fetching preview details:`, error);
        setPreviewState({ status: 'error', message: error.message || 'Failed to fetch preview details.' });
    }
  };

  // Effect to fetch details when containerId changes
  useEffect(() => {
    fetchPreviewDetails();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerId]);

  // Set up WebSocket connection to listen for file changes
  useEffect(() => {
    if (!containerId) {
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
      }
      return;
    }



    // Create socket connection if it doesn't exist
      if (!socketRef.current) {
      console.log(`[Preview] Creating socket connection for container: ${containerId}`);
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
    
    
      // Connect to the container
    
    
      socket.on('connect', () => {
        console.log(`[Preview] Socket connected: ${socket.id}`);
        socket.emit('register-container', containerId);
      });

      // Handle file change events
      socket.on('file-changed', (data) => {
        if (data.containerId === containerId) {
          console.log(`[Preview] Detected file change: ${data.path}`);
          handleRefresh();
        }
      });

      socket.on('disconnect', (reason) => {
        console.log(`[Preview] Socket disconnected: ${reason}`);
      });

      socket.on('connect_error', (err) => {
        console.error(`[Preview] Socket connection error: ${err.message}`);
      });
    }

    // Cleanup function
    return () => {
      if (socketRef.current) {
        console.log(`[Preview] Disconnecting socket for container: ${containerId}`);
        socketRef.current.disconnect();
        socketRef.current = null;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerId]);

  // Function to handle iframe loading completion
  const handleIframeLoad = () => {
    // Only transition to 'loaded' if we were expecting it ('iframe_loading')
    if (previewState.status === 'iframe_loading') {
        console.log("[Preview] Iframe finished loading.");
        setPreviewState({ status: 'loaded', url: previewState.url });
    }
  };

   // Function to handle iframe loading error
   const handleIframeError = () => {
        console.error("[Preview] Iframe failed to load.");
        if (previewState.status === 'iframe_loading' || previewState.status === 'loaded') {
            setPreviewState({ status: 'error', message: 'Preview content failed to load. Check the container logs.' });
        }
   }

  // Function to refresh the preview (refetch details and reload iframe)
  const handleRefresh = () => {
    if (containerId) {
        fetchPreviewDetails(); // Refetch details and trigger reload via key change
    }
  };

  // Function to open the preview URL in a new tab
  const openExternal = () => {
    if ((previewState.status === 'loaded' || previewState.status === 'iframe_loading') && previewState.url !== 'about:blank') {
      window.open(previewState.url, '_blank', 'noopener,noreferrer');
    }
  };

  // Determine button disabled states
  const isLoading = previewState.status === 'loading' || previewState.status === 'iframe_loading';
  const canInteract = (previewState.status === 'loaded' || previewState.status === 'iframe_loading') && currentUrlRef.current !== 'about:blank';

  return (
    <div className="flex h-full flex-col border-l border-border bg-background">
      {/* Preview Header */}
      <div className="flex h-10 flex-shrink-0 items-center justify-between border-b border-border px-3 py-2">
        <span className="text-sm font-medium uppercase tracking-wide text-foreground">
          Preview
        </span>
        <div className="flex items-center space-x-1">
          <button
            onClick={handleRefresh}
            disabled={isLoading || !containerId}
            className="p-1 rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50 disabled:pointer-events-none focus:outline-none focus:ring-1 focus:ring-border"
            aria-label="Refresh Preview"
            title="Refresh Preview"
          >
            {isLoading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
          </button>
          <button
            onClick={openExternal}
            disabled={!canInteract}
            className="p-1 rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50 disabled:pointer-events-none focus:outline-none focus:ring-1 focus:ring-border"
            aria-label="Open Preview in New Tab"
            title="Open in New Tab"
          >
            <ExternalLink size={16} />
          </button>
          {/* Close button placeholder */}
        </div>
      </div>

      {/* Iframe Content Area */}
      <div className="flex-grow overflow-hidden relative bg-white dark:bg-gray-800">
        {/* Loading Overlay */}
        {previewState.status === 'loading' && (
           <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-background/80 backdrop-blur-sm text-muted-foreground">
             <Loader2 className="h-6 w-6 animate-spin text-primary mb-2" />
             <span>Loading preview details...</span>
           </div>
        )}
         {previewState.status === 'iframe_loading' && (
           <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-background/80 backdrop-blur-sm text-muted-foreground">
             <Loader2 className="h-6 w-6 animate-spin text-primary mb-2" />
             <span>Loading preview content...</span>
           </div>
        )}
         {/* Error Overlay */}
         {previewState.status === 'error' && (
             <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-background/90 p-4 text-center">
                 <AlertTriangle className="h-8 w-8 text-red-500 mb-3" />
                 <p className="text-red-500 font-medium mb-1">Preview Error</p>
                 <p className="text-sm text-muted-foreground">{previewState.message}</p>
                 <button
                    onClick={handleRefresh}
                    className="mt-4 inline-flex items-center rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted focus:outline-none focus:ring-1 focus:ring-border"
                  >
                    <RefreshCw size={14} className="mr-2"/> Retry
                 </button>
             </div>
         )}
          {/* Idle/No Container Overlay */}
         {previewState.status === 'idle' && (
             <div className="absolute inset-0 flex flex-col items-center justify-center bg-background text-muted-foreground p-4 text-center">
                 <ServerCrash className="h-8 w-8 mb-3 opacity-50" />
                 <p className="text-sm">Preview unavailable.</p>
                 <p className="text-xs mt-1">{containerId ? 'Start the dev server via terminal.' : 'No active container.'}</p>
             </div>
         )}

        {/* Iframe - Render only when we have a URL */}
        {(previewState.status === 'loaded' || previewState.status === 'iframe_loading') && (
            <iframe
              key={key} // Use key to force re-render on refresh/URL change
              ref={iframeRef}
              src={previewState.url}
              className="h-full w-full border-0"
              title="Application Preview"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
              onLoad={handleIframeLoad}
              onError={handleIframeError}
            />
        )}
      </div>
    </div>
  );
}
