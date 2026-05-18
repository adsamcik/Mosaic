using System.Threading.Tasks;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.Extensions.Localization;

namespace Mosaic.Backend.Localization;

/// <summary>
/// Result filter that rewrites <see cref="ProblemDetails.Title"/> and
/// <see cref="ProblemDetails.Detail"/> on any <see cref="ObjectResult"/>
/// whose value is a <see cref="ProblemDetails"/> (including
/// <see cref="ValidationProblemDetails"/>), translating them through
/// <see cref="IStringLocalizer{ProblemDetailsMessages}"/>.
///
/// The original English string is used as the resource key. If the active
/// culture has no translation for a given key the value is left unchanged,
/// preserving backwards compatibility with existing clients and tests that
/// inspect <c>Problem(detail: "...")</c> output directly.
///
/// For <see cref="ValidationProblemDetails.Errors"/> the field-level error
/// messages are likewise looked up; this allows DataAnnotations
/// <c>ErrorMessage</c> strings (e.g. <c>"AccessTier must be 1, 2, or 3"</c>)
/// to be translated alongside controller-emitted details.
/// </summary>
public sealed class ProblemDetailsLocalizationFilter : IAsyncResultFilter
{
    private readonly IStringLocalizer<ProblemDetailsMessages> _localizer;

    public ProblemDetailsLocalizationFilter(IStringLocalizer<ProblemDetailsMessages> localizer)
    {
        _localizer = localizer;
    }

    public Task OnResultExecutionAsync(ResultExecutingContext context, ResultExecutionDelegate next)
    {
        if (context.Result is ObjectResult { Value: ProblemDetails problem } objectResult)
        {
            Localize(problem);

            if (problem is ValidationProblemDetails validation)
            {
                LocalizeErrors(validation);
            }

            // Keep ContentTypes accurate — ASP.NET sets this to
            // application/problem+json when ProblemDetails is the value, so
            // we don't override it here.
            _ = objectResult;
        }

        return next();
    }

    private void Localize(ProblemDetails problem)
    {
        if (!string.IsNullOrEmpty(problem.Title))
        {
            var translated = _localizer[problem.Title];
            if (!translated.ResourceNotFound)
            {
                problem.Title = translated.Value;
            }
        }

        if (!string.IsNullOrEmpty(problem.Detail))
        {
            var translated = _localizer[problem.Detail];
            if (!translated.ResourceNotFound)
            {
                problem.Detail = translated.Value;
            }
        }
    }

    private void LocalizeErrors(ValidationProblemDetails validation)
    {
        if (validation.Errors.Count == 0)
        {
            return;
        }

        // Replace each message in-place. Avoid allocating a new dictionary
        // so existing references (e.g. test assertions) remain valid.
        foreach (var (field, messages) in validation.Errors)
        {
            for (var i = 0; i < messages.Length; i++)
            {
                var msg = messages[i];
                if (string.IsNullOrEmpty(msg))
                {
                    continue;
                }
                var translated = _localizer[msg];
                if (!translated.ResourceNotFound)
                {
                    messages[i] = translated.Value;
                }
            }
            validation.Errors[field] = messages;
        }
    }
}
