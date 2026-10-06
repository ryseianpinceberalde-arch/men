using System.Globalization;
using Microsoft.Win32;
using PCMaintenance.Agent.Models;

namespace PCMaintenance.Agent.Collectors;

public sealed class SoftwareInventoryService
{
    private const string UninstallKey = @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall";

    public IReadOnlyList<SoftwareRow> Collect(int maximumRows)
    {
        var results = new Dictionary<string, SoftwareRow>(StringComparer.OrdinalIgnoreCase);
        var views = Environment.Is64BitOperatingSystem
            ? new[] { RegistryView.Registry64, RegistryView.Registry32 }
            : new[] { RegistryView.Registry32 };
        foreach (var view in views)
        {
            try
            {
                using var baseKey = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, view);
                using var uninstall = baseKey.OpenSubKey(UninstallKey);
                if (uninstall is null) continue;
                foreach (var subKeyName in uninstall.GetSubKeyNames())
                {
                    try
                    {
                        using var entry = uninstall.OpenSubKey(subKeyName);
                        var name = entry?.GetValue("DisplayName")?.ToString()?.Trim();
                        if (string.IsNullOrWhiteSpace(name) || name.Length > 300) continue;
                        var version = entry?.GetValue("DisplayVersion")?.ToString()?.Trim();
                        var publisher = entry?.GetValue("Publisher")?.ToString()?.Trim();
                        var installDate = ParseDate(entry?.GetValue("InstallDate")?.ToString());
                        var row = new SoftwareRow(name, EmptyToNull(version), EmptyToNull(publisher), installDate);
                        results[$"{name}\n{version}"] = row;
                        if (results.Count >= maximumRows) return results.Values.ToArray();
                    }
                    catch (Exception) { /* An invalid uninstall entry must not interrupt the rest of the inventory. */ }
                }
            }
            catch (Exception) { /* HKLM can be restricted on managed endpoints; continue with the other registry view. */ }
        }
        return results.Values.OrderBy(item => item.SoftwareName, StringComparer.OrdinalIgnoreCase).ToArray();
    }

    private static string? ParseDate(string? value) =>
        DateTime.TryParseExact(value, "yyyyMMdd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var date)
            ? date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture)
            : null;

    private static string? EmptyToNull(string? value) => string.IsNullOrWhiteSpace(value) ? null : value;
}
