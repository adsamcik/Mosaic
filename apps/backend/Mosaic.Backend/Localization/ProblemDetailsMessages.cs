namespace Mosaic.Backend.Localization;

/// <summary>
/// Marker type used by <c>IStringLocalizer&lt;ProblemDetailsMessages&gt;</c> to
/// resolve localized titles and details for RFC 7807 <c>ProblemDetails</c>
/// responses returned by controllers, middleware, and the global rate limiter.
///
/// Resource files live under <c>Resources/Localization/</c> and are keyed by
/// the original English string (e.g. <c>"Album not found"</c>). The English
/// resource file (<c>.en.resx</c>) is identity-mapped so the fallback culture
/// always returns the original text; additional cultures (e.g. <c>cs</c>)
/// provide translated values.
///
/// Translation is applied transparently by
/// <see cref="ProblemDetailsLocalizationFilter"/>; controllers continue to call
/// <c>Problem(detail: "...")</c> using the canonical English string and the
/// filter rewrites <c>Title</c>/<c>Detail</c> based on the request's
/// <c>Accept-Language</c> header.
/// </summary>
public sealed class ProblemDetailsMessages
{
}
