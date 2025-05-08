// (Place this in your Docker runner image, e.g., at /usr/local/bin/scan-workspace.js)
// Make sure it's executable: chmod +x /usr/local/bin/scan-workspace.js

const fs = require('fs');
const path = require('path');
const workspaceDir = '/workspace';

function walk(currentDirPathRelative, currentPathForOutput = '') {
    let results = [];
    const fullCurrentSystemPath = path.join(workspaceDir, currentDirPathRelative);

    try {
        const list = fs.readdirSync(fullCurrentSystemPath);
        list.forEach(entryName => {
            const entryPathInWorkspaceRelative = path.join(currentDirPathRelative, entryName);
            const fullEntrySystemPath = path.join(workspaceDir, entryPathInWorkspaceRelative);
            let stat;
            try {
                stat = fs.statSync(fullEntrySystemPath);
            } catch (e) {
                // console.error(`Error stating file ${fullEntrySystemPath}: ${e.message}`);
                return; // Skip if cannot stat (e.g. broken symlink)
            }

            // Normalize path to always use forward slashes and start with /
            const normalizedOutputPath = ('/' + entryPathInWorkspaceRelative.replace(/\\/g, '/')).replace(/\/\//g, '/');

            const fileData = {
                name: entryName,
                path: normalizedOutputPath, // Path relative to /workspace, starting with /
                isDirectory: stat.isDirectory(),
            };
            
            // Read content for non-directory files that are not too large
            if (!stat.isDirectory() && stat.size < 1024 * 1024) { // Skip files larger than 1MB
                try {
                    fileData.content = fs.readFileSync(fullEntrySystemPath, 'utf8');
                } catch (contentError) {
                    console.error(`Error reading content of ${normalizedOutputPath}: ${contentError.message}`);
                    // Still include the file, just without content
                }
            }
            results.push(fileData);

            if (stat.isDirectory()) {
                results = results.concat(walk(entryPathInWorkspaceRelative, normalizedOutputPath));
            }
        });
    } catch (e) {
        // console.error(`Error reading directory ${fullCurrentSystemPath}: ${e.message}`);
        // If readdir fails, it means the directory might not exist or is inaccessible.
    }
    return results;
}

try {
    // Start scanning from the root of the workspace.
    // Add the /workspace root itself if it exists and is a directory.
    let finalResults = [];
    try {
        const rootStat = fs.statSync(workspaceDir);
        if (rootStat.isDirectory()) {
            finalResults.push({
                name: 'workspace', // Or derive from path.basename(workspaceDir)
                path: '/workspace',
                isDirectory: true,
            });
        }
    } catch (e) {
        // workspaceDir itself might not exist in an empty volume before population
    }

    finalResults = finalResults.concat(walk('', '/workspace')); // Start scan from inside /workspace

    // Remove duplicates by path (e.g. if /workspace was added manually and also found by walk)
    const uniqueResults = Array.from(new Map(finalResults.map(item => [item.path, item])).values());

    process.stdout.write(JSON.stringify(uniqueResults));
} catch (e) {
    // process.stderr.write(`Error generating file structure: ${e.message}`);
    process.stdout.write("[]"); // Output empty array on critical error
}