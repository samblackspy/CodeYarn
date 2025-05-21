// src/socket/ioServer.ts
import { Server as SocketIOServer } from 'socket.io';
import http from 'http';
import { CORS_ORIGIN } from '../config';

let io: SocketIOServer;

export function initializeSocketIO(httpServer: http.Server): SocketIOServer {
    io = new SocketIOServer(httpServer, {
        cors: {
            origin: CORS_ORIGIN,  
            methods: ['GET', 'POST'],
            credentials: true
        },
        path: '/socket.io/',
        pingTimeout: 120000,    //  pong
        pingInterval: 30000,    //ping 
        transports: ['websocket'],
        cookie: {
            name: 'io',
            httpOnly: false,
            secure: process.env.NODE_ENV === 'production'
        },
        connectTimeout: 45000   // handshake timeout
    });

    console.log(`[Socket.IO] Initialized with CORS origin: ${CORS_ORIGIN}`);
    return io;
}

export { io }; // Export the instance for use in other modules