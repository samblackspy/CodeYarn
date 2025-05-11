"use client"; // This component uses hooks, refs, and interacts with browser APIs

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Maximize, Minimize, X, Trash2, Copy } from 'lucide-react';
import { Terminal as XtermTerminal } from 'xterm'; // Import Xterm core
import { FitAddon } from 'xterm-addon-fit'; // Import Fit addon
import { WebLinksAddon } from 'xterm-addon-web-links'; // Import WebLinks addon
import 'xterm/css/xterm.css'; // Import Xterm's base CSS
import { io, Socket } from 'socket.io-client'; // Import socket.io client
import { cn } from '@/lib/utils';

// Define props (e.g., containerId is crucial for connecting)
interface TerminalProps {
  containerId: string | null; // ID of the container to connect to
  // Add theme prop later if needed
}

// Define the WebSocket connection URL (should match backend)
// Use environment variables for flexibility
const SOCKET_SERVER_URL = process.env.NEXT_PUBLIC_SOCKET_SERVER_URL || '';

/**
 * Terminal component provides an interface for interacting with the container's shell
 * using Xterm.js and WebSocket communication.
 */
export default function Terminal({ containerId }: TerminalProps): JSX.Element {
  const terminalRef = useRef<HTMLDivElement>(null); // Ref for the div where xterm mounts
  const xtermInstanceRef = useRef<XtermTerminal | null>(null); // Ref to store the xterm instance
  const fitAddonRef = useRef<FitAddon | null>(null); // Ref for the fit addon
  const socketRef = useRef<Socket | null>(null); // Ref for the WebSocket connection
  const resizeObserverRef = useRef<ResizeObserver | null>(null);  // State and refs for the terminal and its connection status
  const [isConnected, setIsConnected] = useState(false);
  const [isTerminalReady, setIsTerminalReady] = useState(false);
  
  // Use refs to track state that needs to be accessed in event handlers
  const isConnectedRef = useRef(false);
  const isTerminalReadyRef = useRef(false); // Track if backend confirmed terminal ready

  // --- Resize Handling ---
  const handleResize = useCallback(() => {
    // Use requestAnimationFrame to debounce resize events slightly
    requestAnimationFrame(() => {
      if (fitAddonRef.current && xtermInstanceRef.current) {
        try {
            const dims = fitAddonRef.current.proposeDimensions();
            if (dims && dims.cols && dims.rows) {
                fitAddonRef.current.fit(); // Fit the terminal to container size
                // Send resize event to backend PTY
                socketRef.current?.emit('terminal-resize', { cols: dims.cols, rows: dims.rows });
                // console.log(`Terminal resized to: ${dims.cols}x${dims.rows}`);
            }
        } catch (e) {
            console.error("Error fitting terminal:", e);
        }
      }
    });
  }, []); // Empty dependency array, relies on refs

  // --- Initialization Effect ---
  useEffect(() => {
    if (!terminalRef.current || !containerId) {
        console.log("Terminal init skipped: No containerId or terminalRef");
        return; // Don't initialize if ref or containerId isn't ready
    }
    if (xtermInstanceRef.current) {
        console.log("Terminal init skipped: Instance already exists");
        return; // Avoid re-initializing
    }

    console.log(`Initializing terminal for container: ${containerId}`);

    // Create and configure Xterm instance
    const term = new XtermTerminal({
      cursorBlink: true,
      convertEol: true, // Convert line endings for cross-platform compatibility
      fontFamily: 'Menlo, Monaco, "Courier New", monospace', // Monospaced font stack
      fontSize: 13,
      rows: 20, // Initial rows (will be adjusted by fit addon)
      theme: { // Basic dark theme (customize as needed)
        background: '#000000', // Black background
        foreground: '#E0E0E0', // Light gray foreground
        cursor: '#FFFFFF',     // White cursor
        selectionBackground: '#555555', // Gray selection
        black: '#000000',
        red: '#CD3131',
        green: '#0DBC79',
        yellow: '#E5E510',
        blue: '#2472C8',
        magenta: '#BC3FBC',
        cyan: '#11A8CD',
        white: '#E5E5E5',
        brightBlack: '#666666',
        brightRed: '#F14C4C',
        brightGreen: '#23D18B',
        brightYellow: '#F5F543',
        brightBlue: '#3B8EEA',
        brightMagenta: '#D670D6',
        brightCyan: '#29B8DB',
        brightWhite: '#E5E5E5'
      }
      // Add other options: scrollback, etc.
    });
    xtermInstanceRef.current = term;

    // Load addons
    const fitAddon = new FitAddon();
    fitAddonRef.current = fitAddon;
    const webLinksAddon = new WebLinksAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);

    // Mount terminal to the DOM element
    term.open(terminalRef.current);
    term.writeln('🚀 Welcome to CodeYarn Terminal!');

    // --- WebSocket Connection ---
    term.writeln(`🔌 Connecting to container ${containerId}...`);
    
       const socket = io(SOCKET_SERVER_URL, {
        path: '/socket.io/',
        transports: ['websocket', 'polling'],
        reconnectionAttempts: 5,
        reconnectionDelay: 1000,
        timeout: 20000,
        forceNew: false,
        withCredentials: true
    });
    socketRef.current = socket;
    
    
    
    socket.on('connect', () => {
        console.log(`[Socket.IO] Connected to server: ${socket.id}`);
        setIsConnected(true);
        isConnectedRef.current = true; // Update ref as well
        // Register interest in the specific container terminal
        socket.emit('register-container', containerId);
    });

    socket.on('registered', (data: { containerId: string }) => {
        console.log(`[Socket.IO] Registered for container: ${data.containerId}`);
        term.writeln(`✅ Registered for container ${data.containerId}. Waiting for terminal session...`);
        // Backend should now attempt to start the PTY session via startTerminalSession
    });

    socket.on('terminal-ready', (data: { containerId: string }) => {
        console.log(`[Socket.IO] Terminal session ready for: ${data.containerId}`);
        
        // Write to terminal before state change
        term.writeln(`✅ Terminal session ready.`);
        
        // Fit terminal and focus immediately
        handleResize();
        term.focus();
        
        // CRITICAL: Update the ref immediately for onData handler to use
        isTerminalReadyRef.current = true;
        console.log('[Socket.IO] Terminal ready ref activated immediately');
        
        // Also update React state (used for UI rendering)
        setIsTerminalReady(true);
    });

    socket.on('terminal-output', (data: { output: string }) => {
        // Write data received from backend PTY to the xterm instance
        term.write(data.output);
    });

    socket.on('terminal-error', (data: { message: string }) => {
        console.error(`[Socket.IO] Terminal Error: ${data.message}`);
        term.writeln(`\r\n❌ Error: ${data.message}\r\n`);
        setIsTerminalReady(false); // Mark terminal as not ready on error
        isTerminalReadyRef.current = false; // Update ref too
    });

    socket.on('disconnect', (reason: string) => {
        console.log(`[Socket.IO] Disconnected: ${reason}`);
        term.writeln(`\r\n🔌 Disconnected: ${reason}\r\n`);
        setIsConnected(false);
        setIsTerminalReady(false);
        isConnectedRef.current = false;
        isTerminalReadyRef.current = false;
    });

    socket.on('connect_error', (err) => {
      console.error(`[Socket.IO] Connection Error: ${err.message}`);
      term.writeln(`\r\n❌ Connection Error: ${err.message}\r\n`);
      setIsConnected(false);
      setIsTerminalReady(false);
    });

    // --- Xterm Data Handling (User Input) ---
    const onDataDisposable = term.onData((data) => {
      // Send user input data to the backend via WebSocket - USE REFS, not state
      if (isConnectedRef.current && isTerminalReadyRef.current) {
        socket.emit('terminal-input', { input: data });
      } else {
          console.warn("Socket not connected or terminal not ready, input ignored.", 
            { connected: isConnectedRef.current, ready: isTerminalReadyRef.current });
      }
    });

    // --- Initial Fit and Resize Observer ---
    // Use ResizeObserver to automatically refit terminal when container size changes
    if (terminalRef.current.parentElement) {
        resizeObserverRef.current = new ResizeObserver(handleResize);
        resizeObserverRef.current.observe(terminalRef.current.parentElement);
        // Initial fit after a short delay to allow layout stabilization
        setTimeout(handleResize, 100);
    } else {
         console.warn("Terminal parent element not found for ResizeObserver.");
         setTimeout(handleResize, 100); // Still attempt initial fit
    }


    // --- Cleanup Effect ---
    return () => {
      console.log(`Cleaning up terminal for container: ${containerId}`);
      // Dispose xterm instance and addons
      onDataDisposable.dispose(); // Dispose data listener
      term.dispose();
      xtermInstanceRef.current = null;
      fitAddonRef.current = null;

      // Disconnect WebSocket
      socket.disconnect();
      socketRef.current = null;
      setIsConnected(false);
      setIsTerminalReady(false);

      // Disconnect ResizeObserver
      if (resizeObserverRef.current) {
          resizeObserverRef.current.disconnect();
          resizeObserverRef.current = null;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerId]); // Re-run effect if containerId changes


 // --- Additional UI Handlers ---
  const handleClearTerminal = () => {
      xtermInstanceRef.current?.clear(); // Use xterm's clear method
  };

  const handleCopyToClipboard = async () => {
      if (xtermInstanceRef.current?.hasSelection()) {
          try {
              const selection = xtermInstanceRef.current.getSelection();
              await navigator.clipboard.writeText(selection);
              console.log("Copied selection to clipboard.");
              // Optional: Show feedback to user
          } catch (err) {
              console.error("Failed to copy text: ", err);
              // Optional: Show error feedback
          }
      }
  };

  // Add handler to refocus terminal when terminal container is clicked
  const handleTerminalContainerClick = useCallback(() => {
    console.log('Terminal container clicked, refocusing...');
    
    if (!isConnected || !isTerminalReady) {
      // If terminal isn't ready, provide visual feedback
      if (xtermInstanceRef.current) {
        xtermInstanceRef.current.writeln('\r\nWaiting for terminal connection...');
      }
      return;
    }
    
    if (xtermInstanceRef.current) {
      xtermInstanceRef.current.focus();
    }
  }, [isConnected, isTerminalReady]);

  return (
    <div className="flex h-full flex-col bg-black text-gray-200">
      {/* Terminal Header */}
      <div className="flex h-8 flex-shrink-0 items-center justify-between border-b border-gray-700 bg-gray-800 px-3 py-1">
        <span className="text-xs font-medium uppercase tracking-wide text-gray-400">
          Terminal {containerId ? `(${containerId.substring(0, 8)}...)` : ''}
          <span className={cn("ml-2 inline-block h-2 w-2 rounded-full", isConnected && isTerminalReady ? 'bg-green-500' : isConnected ? 'bg-yellow-500' : 'bg-red-500')} title={isConnected && isTerminalReady ? 'Connected & Ready' : isConnected ? 'Connected (Waiting for Session)' : 'Disconnected'}></span>
        </span>
        <div className="flex items-center space-x-1">
           <button
            onClick={handleCopyToClipboard}
            className="p-1 rounded text-gray-400 hover:bg-gray-700 hover:text-gray-100 focus:outline-none"
            aria-label="Copy Selection"
            title="Copy Selection"
          >
            <Copy size={14} />
          </button>
           <button
            onClick={handleClearTerminal}
            className="p-1 rounded text-gray-400 hover:bg-gray-700 hover:text-gray-100 focus:outline-none"
            aria-label="Clear Terminal"
            title="Clear Terminal"
          >
            <Trash2 size={14} />
          </button>
          {/* Add Maximize/Close later if needed */}
        </div>
      </div>

      {/* Xterm Mount Point */}
      {/* The div needs to have dimensions for FitAddon to work */}
      <div 
        ref={terminalRef} 
        className="flex-grow overflow-hidden p-1" 
        id="xterm-container"
        onClick={handleTerminalContainerClick}
      ></div>

      {/* Input form is removed - Xterm handles input directly */}
    </div>
  );
}
