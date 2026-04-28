using System.Reflection;
using Microsoft.AspNetCore.Mvc;
using Mosaic.Backend.Controllers;
using Xunit;

namespace Mosaic.Backend.Tests.Controllers;

public class ExpirationRouteContractTests
{
    [Fact]
    public void AlbumExpirationRoute_UsesOwnerScopedPatchContract()
    {
        var method = typeof(AlbumsController).GetMethod(nameof(AlbumsController.UpdateExpiration));

        Assert.NotNull(method);
        var patch = method!.GetCustomAttribute<HttpPatchAttribute>();
        Assert.NotNull(patch);
        Assert.Equal("{albumId:guid}/expiration", patch!.Template);
    }

    [Fact]
    public void PhotoExpirationRoute_UsesAlbumScopedPatchContract()
    {
        var routes = typeof(AlbumsController).Assembly.GetTypes()
            .Where(t => !t.IsAbstract && typeof(ControllerBase).IsAssignableFrom(t))
            .SelectMany(GetPatchRoutes)
            .ToArray();

        Assert.Contains("api/albums/{albumId:guid}/photos/{photoId:guid}/expiration", routes);
    }

    private static IEnumerable<string> GetPatchRoutes(Type controllerType)
    {
        var controllerRoute = controllerType.GetCustomAttribute<RouteAttribute>()?.Template?.Trim('/') ?? string.Empty;

        foreach (var method in controllerType.GetMethods(BindingFlags.Instance | BindingFlags.Public))
        {
            foreach (var patch in method.GetCustomAttributes<HttpPatchAttribute>())
            {
                var methodRoute = patch.Template?.Trim('/') ?? string.Empty;
                yield return string.IsNullOrEmpty(controllerRoute)
                    ? methodRoute
                    : string.IsNullOrEmpty(methodRoute)
                        ? controllerRoute
                        : $"{controllerRoute}/{methodRoute}";
            }
        }
    }
}
