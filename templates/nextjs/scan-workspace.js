// (Place this in your Docker runner image, e.g., at /usr/local/bin/scan-workspace.js)
// Make sure it's executable: chmod +x /usr/local/bin/scan-workspace.js

// Import Node.js built-in modules for file system and path operations.
const fs = require('fs');
const path = require('path');

// Define the root directory within the container to scan.
const workspaceDir = '/workspace';

/**
 * Recursively walks a directory to gather information about files and subdirectories.
 * @param {string} currentDirPathRelative - The current directory path relative to workspaceDir.
 * @param {string} currentPathForOutput - (Not directly used in this version's logic for path construction, but was likely intended for building output paths).
 * @returns {Array<Object>} An array of objects, each representing a file or directory.
 */
function walk(currentDirPathRelative, currentPathForOutput = '') {
    // Initialize an array to store results for the current directory level.
    let results = [];
    // Construct the full absolute system path for the current directory being scanned.
    const fullCurrentSystemPath = path.join(workspaceDir, currentDirPathRelative);

    try {
        // Read all entries (files and directories) in the current system path.
        const list = fs.readdirSync(fullCurrentSystemPath);
        // Iterate over each entry.
        list.forEach(entryName => {
            // Construct the path of the entry relative to workspaceDir.
            const entryPathInWorkspaceRelative = path.join(currentDirPathRelative, entryName);
            // Construct the full absolute system path for the current entry.
            const fullEntrySystemPath = path.join(workspaceDir, entryPathInWorkspaceRelative);
            let stat; // Variable to store file statistics.

            try {
                // Get file statistics (like type, size) for the current entry.
                stat = fs.statSync(fullEntrySystemPath);
            } catch (e) {
                // If stating the file fails (e.g., broken symlink), log an error (commented out) and skip this entry.
                // console.error(`Error stating file ${fullEntrySystemPath}: ${e.message}`);
                return;
            }

            // Normalize the output path to always use forward slashes, start with a leading '/', and remove duplicate slashes.
            const normalizedOutputPath = ('/' + entryPathInWorkspaceRelative.replace(/\\/g, '/')).replace(/\/\//g, '/');

            // Construct the data object for the current file/directory entry.
            const fileData = {
                name: entryName, // Name of the file or directory.
                path: normalizedOutputPath, // Normalized path relative to /workspace, starting with /.
                isDirectory: stat.isDirectory(), // Boolean indicating if it's a directory.
            };

            // If it's a file and not too large (under 1MB), attempt to read its content.
            if (!stat.isDirectory() && stat.size < 1024 * 1024) { // 1MB limit
                try {
                    // Read file content as a UTF-8 string.
                    fileData.content = fs.readFileSync(fullEntrySystemPath, 'utf8');
                } catch (contentError) {
                    // If reading content fails, log an error (actual error, not commented out) and proceed without content.
                    console.error(`Error reading content of ${normalizedOutputPath}: ${contentError.message}`);
                    // The file entry will still be included in results, just without the 'content' property.
                }
            }
            // Add the processed file/directory data to the results array.
            results.push(fileData);

            // If the current entry is a directory, recursively call walk for this subdirectory.
            if (stat.isDirectory()) {
                // Concatenate the results from the recursive call to the current results.
                results = results.concat(walk(entryPathInWorkspaceRelative, normalizedOutputPath));
            }
        });
    } catch (e) {
        // If reading the directory itself fails (e.g., doesn't exist, permissions issue), log error (commented out).
        // console.error(`Error reading directory ${fullCurrentSystemPath}: ${e.message}`);
        // The function will return the (likely empty) results array up to this point.
    }
    // Return the accumulated results for this directory level and its children.
    return results;
}

// Main execution block for the script.
try {
    // Initialize the array for final results.
    let finalResults = [];
    // Attempt to add the /workspace root directory itself to the results.
    try {
        const rootStat = fs.statSync(workspaceDir); // Get stats for the main workspace directory.
        if (rootStat.isDirectory()) {
            // If /workspace is a directory, add it as the top-level entry.
            finalResults.push({
                name: 'workspace', // Or derive from path.basename(workspaceDir) for flexibility.
                path: '/workspace', // Standardized path for the root.
                isDirectory: true,  // It is a directory.
            });
        }
    } catch (e) {
        // If /workspace itself cannot be stated (e.g., empty volume before files are copied), this block is skipped.
        // This is expected if the volume is initially empty.
    }

    // Perform the recursive walk starting from the base of workspaceDir (represented by an empty relative path).
    // Concatenate the walked results with any initial results (like the /workspace entry).
    finalResults = finalResults.concat(walk('', '/workspace'));

    // Remove duplicate entries by path. This can happen if /workspace was added manually
    // and also implicitly included or re-added by the walk function logic.
    // It creates a Map using 'path' as the key, which naturally de-duplicates, then converts values back to an array.
    const uniqueResults = Array.from(new Map(finalResults.map(item => [item.path, item])).values());

    // Write the final, unique list of file/directory objects as a JSON string to standard output.
    process.stdout.write(JSON.stringify(uniqueResults));
} catch (e) {
    // If any critical error occurs during the main execution block, log it to stderr (commented out).
    // process.stderr.write(`Error generating file structure: ${e.message}`);
    // Output an empty JSON array to stdout to indicate failure but provide valid JSON.
    process.stdout.write("[]");
}