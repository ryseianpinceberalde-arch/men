param([string]$PostgresBin = 'C:\Program Files\PostgreSQL\18\bin')
$ErrorActionPreference = 'Stop'
$testRoot = Join-Path $env:TEMP ('pcma-network-db-' + [guid]::NewGuid().ToString('N'))
$testData = Join-Path $testRoot 'data'
$repo = Split-Path -Parent $PSScriptRoot
New-Item -ItemType Directory -Path $testRoot | Out-Null
$port = Get-Random -Minimum 20000 -Maximum 40000
$started = $false
function Invoke-TestSql([string]$path) {
    & (Join-Path $PostgresBin 'psql.exe') -X -h 127.0.0.1 -p $port -U postgres -d postgres -v ON_ERROR_STOP=1 -f $path
    if ($LASTEXITCODE -ne 0) { throw "SQL check failed: $path" }
}
try {
    & (Join-Path $PostgresBin 'initdb.exe') -D $testData -U postgres -A trust --no-locale -E UTF8
    if ($LASTEXITCODE -ne 0) { throw 'Could not initialize disposable test database.' }
    & (Join-Path $PostgresBin 'pg_ctl.exe') -D $testData -l (Join-Path $testRoot 'postgres.log') -o "-h 127.0.0.1 -p $port" -w start
    if ($LASTEXITCODE -ne 0) { throw 'Could not start disposable test database.' }
    $started = $true
    $bootstrap = Join-Path $testRoot 'bootstrap.sql'
    @'
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
grant usage on schema auth, public to anon,authenticated,service_role;
grant execute on function auth.uid() to anon,authenticated,service_role;
alter default privileges in schema public grant all on tables to authenticated,service_role;
alter default privileges in schema public grant all on sequences to authenticated,service_role;
create publication supabase_realtime;
'@ | Set-Content -LiteralPath $bootstrap
    Invoke-TestSql $bootstrap
    foreach ($migration in Get-ChildItem (Join-Path $repo 'supabase\migrations') -Filter '*.sql' | Sort-Object Name) { Invoke-TestSql $migration.FullName }
    Invoke-TestSql (Join-Path $repo 'tests\network-database.sql')
    Write-Output 'All migrations and network database checks passed in disposable PostgreSQL.'
}
finally {
    if ($started) { & (Join-Path $PostgresBin 'pg_ctl.exe') -D $testData -m fast -w stop }
    Write-Output "Disposable database logs retained at $testRoot"
}
