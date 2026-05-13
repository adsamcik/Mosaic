using Mosaic.Backend.Models;
using Xunit;

namespace Mosaic.Backend.Tests.Models;

public class PagedResultTests
{
    [Fact]
    public void Create_WithKnownTotalCount_StopsAtTotalCount()
    {
        var result = PagedResult.Create([1, 2], skip: 0, take: 2, totalCount: 2);

        Assert.Null(result.NextSkip);
    }

    [Fact]
    public void Create_WithKnownTotalCount_UsesReturnedCountForNextSkip()
    {
        var result = PagedResult.Create([1, 2], skip: 2, take: 10, totalCount: 5);

        Assert.Equal(4, result.NextSkip);
    }

    [Fact]
    public void Create_WithoutKnownTotalCount_KeepsPageSizeHeuristic()
    {
        var result = PagedResult.Create([1, 2], skip: 0, take: 2);

        Assert.Equal(2, result.NextSkip);
    }
}
