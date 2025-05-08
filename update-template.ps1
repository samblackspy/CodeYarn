# Update seed.ts
$seedPath = "packages\db\prisma\seed.ts"
$seedContent = Get-Content $seedPath -Raw
$updatedSeedContent = $seedContent -replace "startCommand: 'npm run dev',", "startCommand: '/bin/sh',"
Set-Content -Path $seedPath -Value $updatedSeedContent

# Update templateRoutes.ts
$routesPath = "apps\server\src\routes\templateRoutes.ts"
$routesContent = Get-Content $routesPath -Raw
$updatedRoutesContent = $routesContent -replace "startCommand: 'npm run dev',", "startCommand: '/bin/sh',"
Set-Content -Path $routesPath -Value $updatedRoutesContent

Write-Host "Updated template configurations to use /bin/sh"
