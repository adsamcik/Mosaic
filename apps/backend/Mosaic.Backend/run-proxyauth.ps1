$env:ASPNETCORE_URLS="http://localhost:5000"
$env:ASPNETCORE_ENVIRONMENT="Development"
$env:Auth__LocalAuthEnabled="false"
$env:Auth__ProxyAuthEnabled="true"
dotnet run --project "Mosaic.Backend.csproj" --no-launch-profile
