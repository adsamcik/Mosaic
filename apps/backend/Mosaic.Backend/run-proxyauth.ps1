$env:ASPNETCORE_URLS="http://localhost:5000"
$env:ASPNETCORE_ENVIRONMENT="Development"
$env:Auth__Mode="ProxyAuth"
dotnet run --project "Mosaic.Backend.csproj" --no-launch-profile
