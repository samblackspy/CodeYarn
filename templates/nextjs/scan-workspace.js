// /usr/local/bin/scan-workspace.js (inside the container)

const fs = require('fs');
const path = require('path');
const workspaceDir = '/workspace';

// Define patterns for directories/files to exclude from being listed and stored in DB
const EXCLUDE_PATTERNS = [
    /^\/node_modules(\/.*)?$/,      // Matches /node_modules or /node_modules/foo/bar.js
    /^\/\.git(\/.*)?$/,           // Matches /.git or /.git/hooks/pre-commit
    /^\/\.next(\/.*)?$/,           // Matches /.next or /.next/static/chunks/main.js
    /^\/\.npm(\/.*)?$/,            // Exclude .npm cache directory in workspace
    /^\/build(\/.*)?$/,           // Example: common 'build' folder
    /^\/dist(\/.*)?$/,            // Example: common 'dist' folder
    // Add any other patterns for files/folders starting from the logical root of what you scan
];
// Common text file extensions to attempt reading content for
const TEXT_FILE_EXTENSIONS = [
    '.js', '.jsx', '.ts', '.tsx', '.json', '.html', '.htm', '.css', '.scss', '.less',
    '.md', '.txt', '.xml', '.yaml', '.yml', '.svg', '.gitignore', '.npmrc', '.editorconfig',
    '.env', '.babelrc', '.eslintrc', '.prettierrc'
    // Add more as needed
];

function isExcluded(normalizedPath) {
    return EXCLUDE_PATTERNS.some(pattern => pattern.test(normalizedPath));
}

function isTextFile(fileName) {
    const ext = path.extname(fileName).toLowerCase();
    return TEXT_FILE_EXTENSIONS.includes(ext);
}

function walk(currentDirPathRelative) {
    let results = [];
    const fullCurrentSystemPath = path.join(workspaceDir, currentDirPathRelative);

    try {
        const entries = fs.readdirSync(fullCurrentSystemPath, { withFileTypes: true });

        for (const entry of entries) {
            const entryName = entry.name;
            const entryPathInWorkspaceRelative = path.join(currentDirPathRelative, entryName);
            
            // Normalize path to always use forward slashes and start with / (relative to a conceptual workspace root)
            // For DB consistency, paths like /index.js, /src/component.js are good.
            const normalizedDbPath = ('/' + entryPathInWorkspaceRelative.replace(/\\/g, '/')).replace(/\/\//g, '/');

            if (isExcluded(normalizedDbPath)) {
                // console.log(`[Scan WS] Excluding: ${normalizedDbPath}`);
                continue; // Skip this entry and do not recurse if it's a directory
            }

            const fullEntrySystemPathOnHost = path.join(workspaceDir, entryPathInWorkspaceRelative);
            let stat;
            try {
                stat = entry.isDirectory() ? entry : fs.statSync(fullEntrySystemPathOnHost); // fs.Dirent may not have full stat
                if (!entry.isDirectory() && !entry.isFile() && !entry.isSymbolicLink()) { // Handle other types if necessary
                    stat = fs.statSync(fullEntrySystemPathOnHost); // Fallback to stat for other types if readdir didn't give enough
                }
            } catch (e) {
                // console.error(`[Scan WS] Error stating file ${fullEntrySystemPathOnHost}: ${e.message}`);
                continue; // Skip if cannot stat
            }

            const fileData = {
                name: entryName,
                path: normalizedDbPath,
                isDirectory: stat.isDirectory(),
                content: null // Default to null content
            };
            
            if (!stat.isDirectory() && stat.size < 1 * 1024 * 1024) { // 1MB limit for content
                if (isTextFile(entryName)) {
                    try {
                        fileData.content = fs.readFileSync(fullEntrySystemPathOnHost, 'utf8');
                    } catch (contentError) {
                        console.error(`[Scan WS] Error reading UTF-8 content of ${normalizedDbPath}: ${contentError.message}. Storing as null.`);
                        fileData.content = null; // Ensure it's null if read fails
                    }
                } else if (stat.size === 0) {
                    fileData.content = ""; // Empty files are fine
                } else {
                    // console.log(`[Scan WS] Skipping content for non-text/binary or large file: ${normalizedDbPath}`);
                }
            }
            results.push(fileData);

            if (stat.isDirectory()) {
                results = results.concat(walk(entryPathInWorkspaceRelative));
            }
        }
    } catch (e) {
        // console.error(`[Scan WS] Error reading directory ${fullCurrentSystemPath}: ${e.message}`);
    }
    return results;
}

try {
    let finalResults = [];
    // Add the /workspace root directory itself if it's not excluded
    if (!isExcluded('/workspace')) {
         finalResults.push({
            name: 'workspace', // The logical root name in the UI might just be the project name though
            path: '/workspace', // This path will be the parent for top-level files like /index.js
            isDirectory: true,
            content: null
        });
    }

    // Scan contents of /workspace. currentDirPathRelative starts as ''
    finalResults = finalResults.concat(walk('')); 

    // Deduplicate by path, as /workspace might be added twice if walk also returns it.
    const uniqueResults = Array.from(new Map(finalResults.map(item => [item.path, item])).values());
    
    process.stdout.write(JSON.stringify(uniqueResults));
} catch (e) {
    // process.stderr.write(`[Scan WS] Critical error: ${e.message}\n`);
    process.stdout.write("[]"); // Output empty array on critical error
}
