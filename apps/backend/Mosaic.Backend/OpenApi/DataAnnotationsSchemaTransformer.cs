using System.ComponentModel.DataAnnotations;
using System.Reflection;
using System.Text.Json.Serialization.Metadata;
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

namespace Mosaic.Backend.OpenApi;

/// <summary>
/// Translates <see cref="System.ComponentModel.DataAnnotations"/> on DTO
/// properties into matching OpenAPI Schema constraints.
///
/// <para>
/// v1.0.2 openapi-newaccountsalt-shape: the .NET 10
/// <c>Microsoft.AspNetCore.OpenApi</c> generator currently emits
/// <c>{"type":"string"}</c> for properties decorated with <c>[MinLength]</c>,
/// <c>[MaxLength]</c>, <c>[StringLength]</c>, <c>[RegularExpression]</c>, or
/// <c>[Base64String]</c>. Generated clients and contract tests therefore
/// cannot detect malformed payloads (e.g. a <c>newAccountSalt</c> that is not
/// a 24-char base64 token) before they hit the controller runtime validation.
/// </para>
///
/// <para>
/// This transformer walks <see cref="OpenApiSchemaTransformerContext.JsonTypeInfo"/>
/// looking up the matching <see cref="JsonPropertyInfo"/> for each property
/// the framework has already emitted into <see cref="OpenApiSchema.Properties"/>,
/// then pulls DataAnnotations off its <see cref="JsonPropertyInfo.AttributeProvider"/>.
/// Constraints are mapped 1:1 to OpenAPI Schema fields:
/// </para>
///
/// <list type="bullet">
///   <item><description><c>[MinLength(n)]</c> → <c>minLength: n</c> (string) or <c>minItems: n</c> (array).</description></item>
///   <item><description><c>[MaxLength(n)]</c> → <c>maxLength: n</c> (string) or <c>maxItems: n</c> (array).</description></item>
///   <item><description><c>[StringLength(max, MinimumLength = min)]</c> → <c>minLength</c>/<c>maxLength</c>.</description></item>
///   <item><description><c>[RegularExpression(p)]</c> → <c>pattern: p</c>.</description></item>
///   <item><description><c>[Range(min, max)]</c> → <c>minimum</c>/<c>maximum</c>.</description></item>
///   <item><description><c>[Base64StringAttribute]</c> → <c>format: byte</c>.</description></item>
/// </list>
///
/// <para>
/// The transformer is conservative: it never overwrites a value that has
/// already been set (e.g. by a framework-supplied schema transformer or by
/// an explicit attribute), so it composes cleanly with future transformers.
/// </para>
///
/// <para>
/// Positional record parameters get their DataAnnotations attached to the
/// constructor parameter (not the synthesized property) unless the source
/// explicitly uses the <c>property:</c> target. The transformer walks the
/// declaring type's constructor parameters as a fallback so attributes on
/// <c>record Foo([Required] string Bar);</c> are still honored.
/// </para>
/// </summary>
public sealed class DataAnnotationsSchemaTransformer : IOpenApiSchemaTransformer
{
    public Task TransformAsync(
        OpenApiSchema schema,
        OpenApiSchemaTransformerContext context,
        CancellationToken cancellationToken)
    {
        if (schema is null || context.JsonTypeInfo is null)
        {
            return Task.CompletedTask;
        }

        if (schema.Properties is { Count: > 0 })
        {
            foreach (var jsonProperty in context.JsonTypeInfo.Properties)
            {
                if (!schema.Properties.TryGetValue(jsonProperty.Name, out var propertySchema)
                    || propertySchema is not OpenApiSchema concreteSchema)
                {
                    continue;
                }
                ApplyDataAnnotations(concreteSchema, jsonProperty.AttributeProvider);

                // Positional record parameters get their DataAnnotations attached
                // to the *constructor parameter* (not the synthesized property)
                // unless the source explicitly uses the `property:` target. Walk
                // the declaring type's constructor params so transformers don't
                // miss attributes on `record Foo([Required] string Bar);`.
                var declaringType = context.JsonTypeInfo.Type;
                ApplyConstructorParameterAnnotations(concreteSchema, declaringType, jsonProperty.Name);
            }
        }

        return Task.CompletedTask;
    }

    private static void ApplyConstructorParameterAnnotations(OpenApiSchema schema, Type declaringType, string jsonPropertyName)
    {
        // Match by case-insensitive name; JSON property names are camelCase
        // while constructor parameters are typically PascalCase.
        foreach (var ctor in declaringType.GetConstructors())
        {
            foreach (var parameter in ctor.GetParameters())
            {
                if (parameter.Name is null)
                {
                    continue;
                }
                if (string.Equals(parameter.Name, jsonPropertyName, StringComparison.OrdinalIgnoreCase))
                {
                    ApplyDataAnnotations(schema, parameter);
                    return;
                }
            }
        }
    }

    private static void ApplyDataAnnotations(OpenApiSchema schema, ICustomAttributeProvider? attributeProvider)
    {
        if (attributeProvider is null)
        {
            return;
        }

        var attributes = attributeProvider.GetCustomAttributes(inherit: true);
        var isArrayLike = schema.Type.HasValue && (schema.Type.Value & JsonSchemaType.Array) != 0;
        var isStringLike = schema.Type.HasValue && (schema.Type.Value & JsonSchemaType.String) != 0;

        foreach (var attribute in attributes)
        {
            switch (attribute)
            {
                case MinLengthAttribute min:
                    if (isArrayLike)
                    {
                        schema.MinItems ??= min.Length;
                    }
                    else
                    {
                        schema.MinLength ??= min.Length;
                    }
                    break;

                case MaxLengthAttribute max:
                    if (isArrayLike)
                    {
                        schema.MaxItems ??= max.Length;
                    }
                    else
                    {
                        schema.MaxLength ??= max.Length;
                    }
                    break;

                case StringLengthAttribute stringLength:
                    if (stringLength.MinimumLength > 0)
                    {
                        schema.MinLength ??= stringLength.MinimumLength;
                    }
                    if (stringLength.MaximumLength > 0)
                    {
                        schema.MaxLength ??= stringLength.MaximumLength;
                    }
                    break;

                case RegularExpressionAttribute regex:
                    if (string.IsNullOrEmpty(schema.Pattern))
                    {
                        schema.Pattern = regex.Pattern;
                    }
                    break;

                case RangeAttribute range:
                    ApplyRange(schema, range);
                    break;

                default:
                    if (IsBase64StringAttribute(attribute))
                    {
                        if (string.IsNullOrEmpty(schema.Format) && isStringLike)
                        {
                            schema.Format = "byte";
                        }
                    }
                    break;
            }
        }
    }

    private static void ApplyRange(OpenApiSchema schema, RangeAttribute range)
    {
        if (range.Minimum is IConvertible minConvertible && string.IsNullOrEmpty(schema.Minimum))
        {
            try
            {
                schema.Minimum = Convert.ToDecimal(minConvertible, System.Globalization.CultureInfo.InvariantCulture)
                    .ToString(System.Globalization.CultureInfo.InvariantCulture);
            }
            catch (FormatException) { }
            catch (InvalidCastException) { }
            catch (OverflowException) { }
        }
        if (range.Maximum is IConvertible maxConvertible && string.IsNullOrEmpty(schema.Maximum))
        {
            try
            {
                schema.Maximum = Convert.ToDecimal(maxConvertible, System.Globalization.CultureInfo.InvariantCulture)
                    .ToString(System.Globalization.CultureInfo.InvariantCulture);
            }
            catch (FormatException) { }
            catch (InvalidCastException) { }
            catch (OverflowException) { }
        }
    }

    private static bool IsBase64StringAttribute(object attribute)
    {
        var type = attribute.GetType();
        return string.Equals(type.FullName, "System.ComponentModel.DataAnnotations.Base64StringAttribute", StringComparison.Ordinal)
            || string.Equals(type.Name, "Base64StringAttribute", StringComparison.Ordinal);
    }
}
