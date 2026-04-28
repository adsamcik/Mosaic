namespace Mosaic.Backend.Extensions;

public static class PaginationHeaderExtensions
{
    public static void AddPaginationHeaders(
        this HttpResponse response,
        int skip,
        int take,
        int totalCount)
    {
        response.Headers["X-Pagination-Skip"] = skip.ToString();
        response.Headers["X-Pagination-Take"] = take.ToString();
        response.Headers["X-Pagination-Total-Count"] = totalCount.ToString();
        response.Headers["X-Pagination-Has-More"] = (skip + take < totalCount).ToString().ToLowerInvariant();
    }
}
