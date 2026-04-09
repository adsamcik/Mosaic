using System;
using System.Reflection;
using tusdotnet.Models.Configuration;

var t = typeof(BeforeCreateContext);
foreach (var p in t.GetProperties(BindingFlags.Public | BindingFlags.Instance | BindingFlags.NonPublic))
{
    Console.WriteLine($"{p.Name}: CanRead={p.CanRead}, CanWrite={p.CanWrite}, DeclaringType={p.DeclaringType?.Name}");
}
