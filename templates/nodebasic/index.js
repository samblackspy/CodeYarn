// To enable automatic server reload on file changes during development, run:
//    npm run dev
// (Requires nodemon, which is included in package.json)

const http = require('http');

const PORT = process.env.PORT || 3000;

// Create a server that can be referenced globally
let server;

// Function to create and start the server
function startServer() {
  // Close existing server if it exists
  if (server) {
    try {
      server.close();
      console.log('Stopping previous server instance');
    } catch (err) {
      console.error('Error stopping previous server:', err);
    }
  }

  // Create a new server
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>CodeYarn Node Basic</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 40px; line-height: 1.6; }
          h1 { color: #333; }
          .container { max-width: 800px; margin: 0 auto; }
          .info { background: #f4f4f4; padding: 20px; border-radius: 5px; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>Hello from CodeYarn Node Basic!</h1>
          <div class="info">
            <p>Server is running successfully.</p>
            <p>Last updated: ${new Date().toLocaleString()}</p>
          </div>
        </div>
      </body>
      </html>
    `);
  });

  // Start listening on the specified port
  server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}/`);
    console.log(`Server started at: ${new Date().toLocaleString()}`);
  });

  // Handle server errors
  server.on('error', (err) => {
    console.error('Server error:', err);
  });
}

// Start the server initially
startServer();

// Export the startServer function so it can be called from the terminal
module.exports = { startServer };