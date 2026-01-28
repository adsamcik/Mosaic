using Microsoft.AspNetCore.Mvc;
using Xunit;

namespace Mosaic.Backend.Tests.TestHelpers;

/// <summary>
/// Helper methods for asserting ProblemDetails responses in tests.
/// These responses are returned by the Problem() method in controllers.
/// </summary>
public static class ProblemDetailsAssertions
{
    /// <summary>
    /// Asserts that the result is a 400 Bad Request with ProblemDetails format.
    /// </summary>
    public static ObjectResult AssertBadRequest(IActionResult result)
    {
        var objectResult = Assert.IsType<ObjectResult>(result);
        Assert.Equal(400, objectResult.StatusCode);
        return objectResult;
    }

    /// <summary>
    /// Asserts that the result is a 404 Not Found with ProblemDetails format.
    /// </summary>
    public static ObjectResult AssertNotFound(IActionResult result)
    {
        var objectResult = Assert.IsType<ObjectResult>(result);
        Assert.Equal(404, objectResult.StatusCode);
        return objectResult;
    }

    /// <summary>
    /// Asserts that the result is a 409 Conflict with ProblemDetails format.
    /// </summary>
    public static ObjectResult AssertConflict(IActionResult result)
    {
        var objectResult = Assert.IsType<ObjectResult>(result);
        Assert.Equal(409, objectResult.StatusCode);
        return objectResult;
    }

    /// <summary>
    /// Asserts that the result is a 401 Unauthorized with ProblemDetails format.
    /// </summary>
    public static ObjectResult AssertUnauthorized(IActionResult result)
    {
        var objectResult = Assert.IsType<ObjectResult>(result);
        Assert.Equal(401, objectResult.StatusCode);
        return objectResult;
    }

    /// <summary>
    /// Asserts that the result is a 403 Forbidden with ProblemDetails format.
    /// </summary>
    public static ObjectResult AssertForbidden(IActionResult result)
    {
        var objectResult = Assert.IsType<ObjectResult>(result);
        Assert.Equal(403, objectResult.StatusCode);
        return objectResult;
    }

    /// <summary>
    /// Gets the detail message from a ProblemDetails ObjectResult.
    /// </summary>
    public static string? GetDetail(ObjectResult result)
    {
        if (result.Value is ProblemDetails problemDetails)
        {
            return problemDetails.Detail;
        }
        return result.Value?.ToString();
    }
}
