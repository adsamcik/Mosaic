namespace Mosaic.Backend.Extensions;

/// <summary>
/// Helper methods for base64url encoding/decoding used by share link controllers.
/// </summary>
internal static class Base64UrlHelper
{
    /// <summary>
    /// Convert bytes to base64url string
    /// </summary>
    public static string ToBase64Url(byte[] bytes)
    {
        return Convert.ToBase64String(bytes)
            .Replace('+', '-')
            .Replace('/', '_')
            .TrimEnd('=');
    }

    /// <summary>
    /// Convert base64url string to bytes
    /// </summary>
    public static byte[]? FromBase64Url(string base64Url)
    {
        try
        {
            // Restore base64 padding
            var base64 = base64Url
                .Replace('-', '+')
                .Replace('_', '/');

            switch (base64.Length % 4)
            {
                case 2: base64 += "=="; break;
                case 3: base64 += "="; break;
            }

            return Convert.FromBase64String(base64);
        }
        catch
        {
            return null;
        }
    }
}
