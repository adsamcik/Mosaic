namespace Mosaic.Backend.Models;

public sealed record PagedResult<T>(IReadOnlyList<T> Items, int? NextSkip);

public static class PagedResult
{
    public static PagedResult<T> Create<T>(IReadOnlyList<T> items, int skip, int take)
    {
        return new PagedResult<T>(items, items.Count == take ? skip + take : null);
    }

    public static PagedResult<T> Create<T>(IReadOnlyList<T> items, int skip, int take, int totalCount)
    {
        return new PagedResult<T>(items, skip + items.Count < totalCount ? skip + items.Count : null);
    }
}
