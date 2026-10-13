$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
function Invoke-Checked {
    param([string]$Program, [string[]]$Arguments)
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Program failed; upload stopped." }
}
if ((Split-Path $PSScriptRoot -Leaf) -ne 'Aivantis-public-snapshot') { throw 'Run only in the separate snapshot.' }
if (Test-Path -LiteralPath '.git') { throw 'Git metadata exists. Inspect before retrying.' }
if (Test-Path -LiteralPath 'apps/api/.env') { throw 'Real env file found; stop.' }
Invoke-Checked gh @('auth', 'status')
$visibility = & gh repo view ZidoVC/aivantis- --json visibility --jq '.visibility'
if ($LASTEXITCODE -ne 0 -or $visibility.Trim() -ne 'PRIVATE') { throw 'Cannot confirm original is private.' }
$env:BOOKING_PROVIDER = 'mock'
Remove-Item Env:OPTIMA_LIVE -ErrorAction SilentlyContinue
Remove-Item Env:OPTIMA_WRITE -ErrorAction SilentlyContinue
Invoke-Checked pnpm @('install', '--frozen-lockfile')
Invoke-Checked pnpm @('--filter', '@aivantis/booking-provider', 'test')
Invoke-Checked pnpm @('--filter', 'api', 'test')
Invoke-Checked pnpm @('exec', 'turbo', 'build', '--force')
Invoke-Checked git @('init', '-b', 'main')
Invoke-Checked git @('add', '--', 'apps', 'packages', 'supabase', 'scripts', '.gitignore', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'turbo.json', 'README.md', 'PUBLIC_RELEASE.md', 'DEVOPS_HANDOFF_HE.md', 'GITHUB_UPLOAD_HE.md', 'UPLOAD_PUBLIC.ps1')
$staged = & git diff --cached --name-only
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect stage.' }
if ($staged | Where-Object { $_ -match '(^|/)(node_modules|dist|\.git|\.turbo)(/|$)|(^|/)\.env($|\.(?!example$))|\.docx$|optima-client\.gen|optima-openapi' }) { throw 'Forbidden file staged; nothing uploaded.' }
Invoke-Checked git @('diff', '--cached', '--stat')
if ((Read-Host 'Review staged files. Type PUBLIC to publish') -cne 'PUBLIC') { throw 'Cancelled; no remote created.' }
Invoke-Checked git @('commit', '-m', 'Release sanitized Mock-only WhatsApp agent snapshot')
Invoke-Checked gh @('repo', 'create', 'ZidoVC/aivantis-whatsapp-agent', '--public', '--source', '.', '--remote', 'origin', '--push')
Invoke-Checked gh @('repo', 'view', 'ZidoVC/aivantis-whatsapp-agent', '--json', 'url,visibility')
Invoke-Checked gh @('repo', 'view', 'ZidoVC/aivantis-', '--json', 'url,visibility')
